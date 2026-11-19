import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { RegistryError, networkError } from '../core/errors.js';

function ipv6Number(address) {
  let text = address.toLowerCase();
  if (text.includes('.')) {
    const last = text.lastIndexOf(':');
    const octets = text.slice(last + 1).split('.').map(Number);
    text = `${text.slice(0, last)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const [left, right] = text.split('::');
  const first = left ? left.split(':') : [];
  const second = right ? right.split(':') : [];
  const words = text.includes('::') ? [...first, ...Array(8 - first.length - second.length).fill('0'), ...second] : first;
  return words.reduce((value, word) => (value << 16n) | BigInt(`0x${word}`), 0n);
}

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const p = address.split('.').map(Number);
    if ([0, 10, 127].includes(p[0]) || p[0] >= 224) return false;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return false;
    if (p[0] === 169 && p[1] === 254 || p[0] === 172 && p[1] >= 16 && p[1] <= 31 || p[0] === 192 && p[1] === 168) return false;
    if (p[0] === 192 && (p[1] === 0 || p[1] === 2) || p[0] === 198 && [18, 19, 51].includes(p[1]) || p[0] === 203 && p[1] === 0 && p[2] === 113) return false;
    return true;
  }
  if (family === 6) {
    const value = ipv6Number(address);
    if (value >> 125n !== 1n) return false;
    if (value >> 96n === 0x20010db8n || value >> 112n === 0x2002n || value >> 96n === 0x20010000n || value >> 112n === 0x3fffn) return false;
    if (value >> 105n === 0x1000800n || value >> 112n === 0x2001n && value >> 96n < 0x20010200n) return false;
    return true;
  }
  return false;
}

export function hostAllowed(hostname, entries) {
  return entries.some(entry => entry.startsWith('.') ? hostname.endsWith(entry) && hostname.length > entry.length : hostname === entry);
}

export class SafeTransport {
  constructor({ timeout = 120000, lookup = dnsLookup, allowPrivate = false } = {}) {
    this.timeout = timeout;
    this.lookup = lookup;
    this.allowPrivate = allowPrivate;
    this.requests = new Set();
    this.closed = false;
  }

  async destination(input, allowedHosts, timeout = Math.min(this.timeout, 10000)) {
    let url;
    try { url = new URL(input); }
    catch { throw new RegistryError(502, 'UPSTREAM_UNAVAILABLE', 'Invalid upstream URL.'); }
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if ((!this.allowPrivate && (url.protocol !== 'https:' || url.port && url.port !== '443')) || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || !hostAllowed(hostname, allowedHosts)) throw new RegistryError(502, 'UPSTREAM_UNAVAILABLE', 'Upstream destination rejected by security policy.', { reason: 'DESTINATION_REJECTED' });
    let timer;
    let addresses;
    try {
      addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await Promise.race([
        this.lookup(hostname, { all: true, verbatim: true }),
        new Promise((resolve, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('DNS timeout'), { code: 'ETIMEDOUT' })), timeout); timer.unref(); })
      ]);
    } finally { clearTimeout(timer); }
    if (!addresses.length || !this.allowPrivate && addresses.some(item => !isPublicAddress(item.address))) throw new RegistryError(502, 'UPSTREAM_UNAVAILABLE', 'Upstream DNS destination rejected by security policy.', { reason: 'DESTINATION_REJECTED' });
    return { url, addresses };
  }

  async request(input, { method = 'GET', headers = {}, allowedHosts, redirectHosts = [], redirects = 5, timeout = this.timeout, connectTimeout = timeout, headerTimeout = timeout, idleTimeout = timeout, deadline = Date.now() + connectTimeout + headerTimeout, signal } = {}) {
    if (this.closed) throw new RegistryError(503, 'UPSTREAM_UNAVAILABLE', 'Server is shutting down.');
    let destination;
    const started = Date.now();
    if (deadline <= started) throw networkError({ code: 'ETIMEDOUT' });
    try { destination = await this.destination(input, allowedHosts, Math.min(connectTimeout, deadline - started)); }
    catch (error) { throw networkError(error); }
    const { url, addresses } = destination;
    if (signal?.aborted || deadline <= Date.now()) throw networkError({ code: 'ETIMEDOUT' });
    const response = await new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).request(url, {
        method, signal, headers: { 'user-agent': 'Fotros-Docker-Mirror/1.0.0', 'accept-encoding': 'identity', ...headers },
        agent: false, maxHeaderSize: 16384,
        lookup: (name, options, callback) => options.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family)
      });
      this.requests.add(request);
      const timedOut = () => request.destroy(Object.assign(new Error('Upstream timeout'), { code: 'ETIMEDOUT' }));
      let headerTimer;
      const connectTimer = setTimeout(timedOut, Math.max(1, Math.min(connectTimeout - (Date.now() - started), deadline - Date.now())));
      connectTimer.unref();
      request.once('socket', socket => {
        socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
          clearTimeout(connectTimer);
          headerTimer = setTimeout(timedOut, Math.max(1, Math.min(headerTimeout, deadline - Date.now())));
          headerTimer.unref();
        });
      });
      const cleanup = () => { clearTimeout(connectTimer); clearTimeout(headerTimer); this.requests.delete(request); };
      request.once('error', error => { cleanup(); reject(networkError(error)); });
      request.once('response', incoming => {
        clearTimeout(connectTimer);
        clearTimeout(headerTimer);
        request.setTimeout(idleTimeout, timedOut);
        incoming.upstreamTtfbMs = Date.now() - started;
        incoming.once('close', cleanup);
        incoming.once('error', () => {});
        resolve(incoming);
      });
      request.end();
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const location = response.headers.location;
      response.destroy();
      if (!location || redirects <= 0) throw new RegistryError(502, 'UPSTREAM_UNAVAILABLE', 'Upstream redirect limit or invalid redirect.');
      let next;
      try { next = new URL(location, url); }
      catch { throw new RegistryError(502, 'UPSTREAM_UNAVAILABLE', 'Invalid upstream redirect.'); }
      const sameOrigin = next.origin === url.origin;
      const nextHeaders = { ...headers };
      if (!sameOrigin) {
        for (const key of Object.keys(nextHeaders)) if (['authorization', 'cookie', 'proxy-authorization'].includes(key.toLowerCase())) delete nextHeaders[key];
      }
      return this.request(next, { method, headers: nextHeaders, allowedHosts: [...allowedHosts, ...redirectHosts], redirectHosts, redirects: redirects - 1, timeout, connectTimeout, headerTimeout, idleTimeout, deadline, signal });
    }
    if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
      response.destroy();
      throw new RegistryError(502, 'UPSTREAM_UNAVAILABLE', 'Encoded upstream content cannot be verified safely.');
    }
    return response;
  }

  close() {
    this.closed = true;
    for (const request of this.requests) request.destroy();
  }
}

export async function readResponse(response, limit) {
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of response) {
      bytes += chunk.length;
      if (bytes > limit) throw new RegistryError(413, 'SIZE_INVALID', 'Response exceeds the configured size limit.');
      chunks.push(chunk);
    }
  } catch (error) { response.destroy(); throw networkError(error); }
  return Buffer.concat(chunks);
}
