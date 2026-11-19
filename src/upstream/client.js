import { RegistryError, networkError } from '../core/errors.js';
import { SingleFlight } from '../core/concurrency.js';
import { readResponse } from '../network/transport.js';
import { setTimeout as delay } from 'node:timers/promises';

export const manifestAccept = 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json';

function quotaHeader(value) {
  return typeof value === 'string' && /^\d{1,16}(?:;w=\d{1,10})?$/.test(value) ? value : undefined;
}

export function parseChallenge(value) {
  if (typeof value !== 'string' || !/^Bearer /i.test(value) || value.length > 8192) throw new RegistryError(502, 'UPSTREAM_UNAVAILABLE', 'Unsupported upstream authentication challenge.');
  const fields = {};
  const text = value.slice(7);
  const pattern = /([a-zA-Z_]+)="([^"\r\n]*)"(?:,\s*|$)/g;
  let match;
  let end = 0;
  while ((match = pattern.exec(text))) {
    if (match.index !== end || Object.hasOwn(fields, match[1])) throw new RegistryError(502, 'UPSTREAM_UNAVAILABLE', 'Malformed upstream authentication challenge.');
    fields[match[1]] = match[2];
    end = pattern.lastIndex;
  }
  if (end !== text.length || !fields.realm) throw new RegistryError(502, 'UPSTREAM_UNAVAILABLE', 'Malformed upstream authentication challenge.');
  return fields;
}

export function retryDelay(value, now = Date.now()) {
  if (typeof value === 'string' && /^\d+$/.test(value)) return Math.min(Number(value) * 1000, 7 * 86400000);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(1000, Math.min(parsed - now, 7 * 86400000)) : 60000;
}

export class UpstreamClient {
  constructor(config, transport, telemetry, store) {
    this.config = config;
    this.transport = transport;
    this.telemetry = telemetry;
    this.store = store;
    this.tokens = new Map();
    this.flight = new SingleFlight();
    this.profiles = config.accounts.map(account => ({ ...account, cooldownUntil: 0, authentication: 'unverified' }));
    this.anonymousCooldown = new Map();
  }

  async initialize() {
    this.providerState = await this.store.get('system', 'upstreams') ?? {};
    for (const [provider, state] of Object.entries(this.providerState)) if (state.cooldownUntil) this.anonymousCooldown.set(provider, state.cooldownUntil);
    const saved = await this.store.get('system', 'accounts');
    for (const profile of this.profiles) {
      const previous = saved?.find(value => value.username === profile.username);
      if (previous) Object.assign(profile, previous, { token: profile.token, authentication: 'unverified' });
    }
    this.publishAccounts();
  }

  publishAccounts() {
    this.telemetry.accounts = Object.fromEntries(this.profiles.map(({ token, ...value }) => [value.username, value]));
    this.telemetry.upstreams = this.providerState;
  }

  async persistAccounts() {
    this.publishAccounts();
    await this.store.set('system', 'accounts', this.profiles.map(({ token, ...value }) => value));
  }

  selectAccount() {
    const eligible = profile => profile.authentication !== 'invalid' && profile.cooldownUntil <= Date.now();
    if (this.config.accountFailover) return this.profiles.find(eligible);
    return this.profiles[0] && eligible(this.profiles[0]) ? this.profiles[0] : undefined;
  }

  async raw(route, path, method, headers, account, challenged = false, deadline, signal) {
    const provider = this.config.providers[route.provider];
    const tokenKey = `${route.provider}:${route.remote}:${account?.username ?? 'anonymous'}`;
    const cached = this.tokens.get(tokenKey);
    const requestHeaders = { ...headers };
    if (cached && cached.expires > Date.now()) requestHeaders.authorization = `Bearer ${cached.value}`;
    this.telemetry.count('upstreamRequests');
    this.telemetry.count(`upstream_${route.provider}`);
    let response;
    try {
      response = await this.transport.request(new URL(path, provider.origin), {
        method, headers: requestHeaders,
        ...this.timeouts(deadline, signal),
        allowedHosts: [new URL(provider.origin).hostname],
        redirectHosts: path.includes('/blobs/') ? provider.cdnHosts : []
      });
    } catch (error) {
      this.telemetry.count('upstreamErrors');
      if (account) { account.lastError = error.detail?.reason ?? 'UPSTREAM_UNAVAILABLE'; await this.persistAccounts(); }
      throw error;
    }
    if (response.statusCode === 401 && !challenged) {
      const challengeHeader = response.headers['www-authenticate'];
      response.destroy();
      this.tokens.delete(tokenKey);
      const challenge = parseChallenge(challengeHeader);
      let realm;
      try { realm = new URL(challenge.realm); }
      catch { throw new RegistryError(502, 'UPSTREAM_UNAVAILABLE', 'Untrusted upstream authentication endpoint.'); }
      if (!provider.authOrigins.includes(realm.origin) || realm.username || realm.password || realm.hash || !['/token', '/v2/auth'].includes(realm.pathname)) throw new RegistryError(502, 'UPSTREAM_UNAVAILABLE', 'Untrusted upstream authentication endpoint.');
      await this.flight.run(tokenKey, async () => {
        realm.search = '';
        if (challenge.service) realm.searchParams.set('service', challenge.service);
        realm.searchParams.set('scope', `repository:${route.remote}:pull`);
        const tokenHeaders = {};
        if (account) tokenHeaders.authorization = `Basic ${Buffer.from(`${account.username}:${account.token}`).toString('base64')}`;
        this.telemetry.count('upstreamRequests');
        this.telemetry.count(`upstream_${route.provider}`);
        const tokenResponse = await this.transport.request(realm, { headers: tokenHeaders, allowedHosts: [realm.hostname], redirects: 0, ...this.timeouts(deadline, signal) });
        if (tokenResponse.statusCode !== 200) {
          const status = tokenResponse.statusCode;
          const retry = tokenResponse.headers['retry-after'];
          tokenResponse.destroy();
          if (account && [401, 403].includes(status)) { account.authentication = 'invalid'; account.lastError = 'AUTHENTICATION_FAILED'; await this.persistAccounts(); }
          if (status === 429) throw this.rateLimited(route, retry, account);
          throw new RegistryError(status >= 500 ? 503 : 502, 'UPSTREAM_UNAVAILABLE', 'Upstream authorization failed.', { reason: [401, 403].includes(status) ? 'AUTHENTICATION_FAILED' : 'UPSTREAM_HTTP_ERROR', upstreamStatus: status });
        }
        let body;
        try { body = JSON.parse(await readResponse(tokenResponse, 1024 * 1024)); }
        catch (error) { if (error instanceof RegistryError) throw error; throw new RegistryError(502, 'UPSTREAM_UNAVAILABLE', 'Invalid upstream token response.'); }
        const value = body.token ?? body.access_token;
        if (typeof value !== 'string' || !value || value.length > 65536 || /[\r\n]/.test(value)) throw new RegistryError(502, 'UPSTREAM_UNAVAILABLE', 'Invalid upstream token response.');
        const seconds = Number.isFinite(body.expires_in) ? Math.max(1, Math.min(body.expires_in, 3600)) : 60;
        const issued = Date.parse(body.issued_at);
        const expires = Math.min(Date.now() + seconds * 1000, Number.isFinite(issued) ? issued + seconds * 1000 : Infinity);
        if (expires <= Date.now()) throw new RegistryError(502, 'UPSTREAM_UNAVAILABLE', 'Upstream returned an expired authentication token.', { reason: 'AUTHENTICATION_FAILED' });
        this.tokens.set(tokenKey, { value, expires: Math.max(Date.now(), expires - 5000) });
        if (this.tokens.size > 4096) this.tokens.delete(this.tokens.keys().next().value);
        if (account) { account.authentication = 'valid'; account.tokenExpiresAt = new Date(expires).toISOString(); await this.persistAccounts(); }
      });
      return this.raw(route, path, method, headers, account, true, deadline, signal);
    }
    if (account) {
      account.limit = quotaHeader(response.headers['ratelimit-limit']) ?? account.limit;
      account.remaining = quotaHeader(response.headers['ratelimit-remaining']) ?? account.remaining;
      if (response.statusCode < 400) account.lastSuccess = new Date().toISOString();
      await this.persistAccounts();
    } else {
      const previous = this.providerState[route.provider] ?? {};
      const next = { ...previous, limit: quotaHeader(response.headers['ratelimit-limit']) ?? previous.limit, remaining: quotaHeader(response.headers['ratelimit-remaining']) ?? previous.remaining, lastStatus: response.statusCode, checkedAt: new Date().toISOString() };
      this.providerState[route.provider] = next;
      this.telemetry.upstreams = this.providerState;
      await this.store.set('system', 'upstreams', this.providerState);
    }
    if (response.statusCode === 429) {
      const retry = response.headers['retry-after'];
      response.destroy();
      throw this.rateLimited(route, retry, account);
    }
    if (response.statusCode >= 400) {
      const status = response.statusCode;
      response.destroy();
      this.telemetry.count('upstreamErrors');
      if (status === 404) throw new RegistryError(404, path.includes('/manifests/') ? 'MANIFEST_UNKNOWN' : 'BLOB_UNKNOWN', 'Content was not found in the upstream repository.');
      throw new RegistryError(status >= 500 ? 503 : 502, 'UPSTREAM_UNAVAILABLE', 'The upstream registry rejected the request.', { reason: [401, 403].includes(status) ? 'AUTHENTICATION_FAILED' : 'UPSTREAM_HTTP_ERROR', upstreamStatus: status });
    }
    return response;
  }

  rateLimited(route, retry, account) {
    const delay = retryDelay(retry);
    const until = Date.now() + delay;
    if (account) {
      account.cooldownUntil = until;
      account.lastRateLimit = new Date().toISOString();
      account.lastError = 'RATE_LIMITED';
      this.telemetry.track(this.persistAccounts());
    } else {
      this.anonymousCooldown.set(route.provider, until);
      this.providerState[route.provider] = { ...this.providerState[route.provider], cooldownUntil: until, lastRateLimit: new Date().toISOString() };
      this.telemetry.track(this.store.set('system', 'upstreams', this.providerState));
    }
    this.telemetry.count('upstreamErrors');
    return new RegistryError(429, 'TOOMANYREQUESTS', 'Upstream rate limit reached; cached content remains available.', { reason: 'RATE_LIMITED' }, { 'retry-after': String(Math.ceil(delay / 1000)) });
  }

  timeouts(deadline, signal) {
    return { connectTimeout: this.config.connectTimeoutMs, headerTimeout: this.config.headerTimeoutMs, idleTimeout: this.config.idleTimeoutMs, deadline, signal };
  }

  async request(route, kind, reference, options = {}) {
    const started = Date.now();
    const deadline = started + this.config.headerBudgetMs;
    for (let retry = 0; ; retry++) {
      const controller = new AbortController();
      let timer;
      try {
        const response = await Promise.race([
          this.requestOnce(route, kind, reference, { ...options, deadline, signal: controller.signal }).then(response => {
            if (controller.signal.aborted) { response.destroy(); throw networkError({ code: 'ETIMEDOUT' }); }
            return response;
          }),
          new Promise((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(networkError({ code: 'ETIMEDOUT' })); }, Math.max(1, deadline - Date.now()));
            timer.unref();
          })
        ]);
        clearTimeout(timer);
        response.retryCount = retry;
        response.upstreamTtfbMs = Date.now() - started;
        return response;
      } catch (error) {
        clearTimeout(timer);
        controller.abort();
        error.retryCount = retry;
        error.upstreamTtfbMs = Date.now() - started;
        const transient = ['DNS_FAILURE', 'CONNECTION_FAILURE', 'CONNECTION_TIMEOUT'].includes(error.detail?.reason) || error.detail?.reason === 'UPSTREAM_HTTP_ERROR' && [500, 502, 503, 504].includes(error.detail.upstreamStatus);
        const backoff = Math.min(2000, this.config.retryBackoffMs * 2 ** retry);
        if (!transient || retry >= this.config.upstreamRetries || Date.now() + backoff >= deadline || this.transport.closed) throw error;
        this.telemetry.count('upstreamRetries');
        await delay(backoff);
      }
    }
  }

  async requestOnce(route, kind, reference, { method = 'GET', headers = {}, deadline, signal } = {}) {
    const cooldown = this.anonymousCooldown.get(route.provider) ?? 0;
    if (cooldown > Date.now()) throw new RegistryError(429, 'TOOMANYREQUESTS', 'Upstream request is deferred until its rate limit resets.', { reason: 'RATE_LIMITED' }, { 'retry-after': String(Math.ceil((cooldown - Date.now()) / 1000)) });
    const path = `/v2/${route.remote}/${kind}/${reference}`;
    const requestHeaders = { ...(kind === 'manifests' ? { accept: manifestAccept } : {}), ...headers };
    const account = route.provider === 'dockerhub' ? this.selectAccount() : undefined;
    if (!account) return this.raw(route, path, method, requestHeaders, undefined, false, deadline, signal);
    const proof = await this.raw(route, path, 'HEAD', kind === 'manifests' ? { accept: manifestAccept } : {}, undefined, false, deadline, signal);
    if (method === 'HEAD') return proof;
    const publicDigest = proof.headers['docker-content-digest'];
    proof.destroy();
    if (kind === 'manifests' && (!publicDigest || !/^sha256:[a-f0-9]{64}$/.test(publicDigest))) return this.raw(route, path, method, requestHeaders, undefined, false, deadline, signal);
    const safePath = kind === 'manifests' ? `/v2/${route.remote}/manifests/${publicDigest}` : path;
    const result = await this.raw(route, safePath, method, requestHeaders, account, false, deadline, signal);
    if (kind === 'manifests') result.publicDigest = publicDigest;
    return result;
  }
}
