import http from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Application } from '../../src/app.js';
import { loadConfig } from '../../src/config/config.js';
import { SafeTransport } from '../../src/network/transport.js';
import { mediaTypes } from '../../src/registry/manifests.js';
import { sha256 } from '../../src/registry/validation.js';

export const blobType = 'application/vnd.oci.image.layer.v1.tar+gzip';
export const configType = 'application/vnd.oci.image.config.v1+json';
const resources = new Map();

export function trackStorage(path, resource) {
  resources.get(path)?.add(resource);
  return resource;
}

export function imageFixture({ label = 'one', architecture = 'amd64', docker = false, shared } = {}) {
  const config = Buffer.from(JSON.stringify({ architecture, os: 'linux', rootfs: { type: 'layers', diff_ids: [] } }));
  const layer = shared ?? Buffer.from(`opaque layer data ${label}`);
  const blobs = new Map([[sha256(config), config], [sha256(layer), layer]]);
  const value = { schemaVersion: 2, mediaType: docker ? mediaTypes.dockerManifest : mediaTypes.ociManifest, config: { mediaType: docker ? 'application/vnd.docker.container.image.v1+json' : configType, digest: sha256(config), size: config.length }, layers: [{ mediaType: docker ? 'application/vnd.docker.image.rootfs.diff.tar.gzip' : blobType, digest: sha256(layer), size: layer.length }] };
  const bytes = Buffer.from(JSON.stringify(value));
  return { bytes, digest: sha256(bytes), value, blobs, config, layer, layerDigest: sha256(layer) };
}

export function indexFixture(children, docker = false) {
  const value = { schemaVersion: 2, mediaType: docker ? mediaTypes.dockerIndex : mediaTypes.ociIndex, manifests: children.map((image, index) => ({ mediaType: image.value.mediaType, size: image.bytes.length, digest: image.digest, platform: { architecture: index ? 'arm64' : 'amd64', os: 'linux' } })) };
  const bytes = Buffer.from(JSON.stringify(value));
  return { value, bytes, digest: sha256(bytes) };
}

export async function mockRegistry(t) {
  const manifests = new Map();
  const blobs = new Map();
  const tags = new Map();
  const requests = [];
  const failures = new Map();
  const state = { manifests, blobs, tags, requests, failures, quotaHeaders: {}, headOverrides: new Set(), requireBearer: false, offline: false, interrupt: new Set(), slowStreaming: new Set(), delayMs: 0, maliciousRealm: null };
  const server = http.createServer(async (request, response) => {
    requests.push({ method: request.method, url: request.url, headers: { ...request.headers } });
    for (const [name, value] of Object.entries(state.quotaHeaders)) response.setHeader(name, value);
    const url = new URL(request.url, 'http://fixture');
    if (url.pathname === '/token') {
      if (await state.tokenHandler?.({ request, response })) return;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ token: 'fixture-bearer-token', expires_in: 300 }));
      return;
    }
    if (state.offline) { response.writeHead(503); response.end(); return; }
    if (state.requireBearer && request.headers.authorization !== 'Bearer fixture-bearer-token') {
      response.writeHead(401, { 'www-authenticate': `Bearer realm="${state.maliciousRealm ?? `${state.origin}/token`}",service="fixture",scope="repository:untrusted:push"` });
      response.end();
      return;
    }
    const failed = failures.get(url.pathname);
    if (failed) { response.writeHead(failed.status ?? failed, failed.headers ?? {}); response.end(); return; }
    if (request.method === 'HEAD' && state.headOverrides.has(url.pathname)) { response.writeHead(200); response.end(); return; }
    const match = /^\/v2\/(.+)\/(manifests|blobs)\/(.+)$/.exec(url.pathname);
    if (!match) { response.writeHead(404); response.end(); return; }
    const [, name, kind, reference] = match;
    const digest = kind === 'manifests' ? tags.get(`${name}:${reference}`) ?? reference : reference;
    const bytes = (kind === 'manifests' ? manifests : blobs).get(`${name}@${digest}`);
    if (!bytes) { response.writeHead(404); response.end(); return; }
    if (kind === 'blobs' && await state.blobHandler?.({ request, response, bytes, digest, name })) return;
    response.setHeader('docker-content-digest', digest);
    let contentType = 'application/octet-stream';
    if (kind === 'manifests') {
      try { contentType = JSON.parse(bytes).mediaType; }
      catch { contentType = mediaTypes.ociManifest; }
    }
    response.setHeader('content-type', contentType);
    let offset = 0;
    if (request.headers.range) {
      offset = Number(/^bytes=(\d+)-$/.exec(request.headers.range)?.[1]);
      if (!Number.isFinite(offset) || offset >= bytes.length) { response.writeHead(416); response.end(); return; }
      response.statusCode = 206;
      response.setHeader('content-range', `bytes ${offset}-${bytes.length - 1}/${bytes.length}`);
    }
    response.setHeader('content-length', bytes.length - offset);
    if (request.method === 'HEAD') { response.end(); return; }
    if (state.interrupt.has(digest)) {
      state.interrupt.delete(digest);
      response.write(bytes.subarray(offset, offset + Math.max(1, Math.floor((bytes.length - offset) / 2))));
      setTimeout(() => response.destroy(), 500);
    } else if (state.slowStreaming.has(digest)) {
      const middle = offset + Math.max(1, Math.floor((bytes.length - offset) / 2));
      response.write(bytes.subarray(offset, middle));
      const timer = setTimeout(() => response.end(bytes.subarray(middle)), 3000);
      response.once('close', () => clearTimeout(timer));
    } else if (state.delayMs) setTimeout(() => response.end(bytes.subarray(offset)), state.delayMs);
    else response.end(bytes.subarray(offset));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  state.origin = `http://127.0.0.1:${server.address().port}`;
  state.add = (name, tag, image) => {
    manifests.set(`${name}@${image.digest}`, image.bytes);
    if (tag) tags.set(`${name}:${tag}`, image.digest);
    for (const [digest, bytes] of image.blobs ?? []) blobs.set(`${name}@${digest}`, bytes);
  };
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return state;
}

export async function dataDirectory(t) {
  const path = await mkdtemp(join(await realpath(tmpdir()), 'fotros-mirror-test-'));
  resources.set(path, new Set());
  t.after(async () => {
    const results = await Promise.allSettled([...resources.get(path)].map(async resource => resource.close()));
    try { await rm(path, { recursive: true, force: true }); }
    finally { resources.delete(path); }
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Test fixture resources failed to close.');
  });
  return path;
}

export async function testApp(t, upstream, overrides = {}, storage) {
  const dataDir = storage ?? await dataDirectory(t);
  const config = { ...loadConfig({ PORT: '0', SYNC_ENABLED: 'false', CONNECTIVITY_CHECK_ENABLED: 'false', LOG_LEVEL: 'silent' }), dataDir, ...overrides };
  if (upstream) {
    config.providers = Object.fromEntries(Object.entries(config.providers).map(([name, provider]) => [name, { ...provider, origin: upstream.origin, authOrigins: [upstream.origin], cdnHosts: [] }]));
  }
  const app = await new Application(config, { transport: new SafeTransport({ allowPrivate: true, timeout: 5000 }) }).initialize();
  trackStorage(dataDir, app);
  await app.listen();
  app.origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(() => app.close());
  return app;
}

export function basic(username, password) { return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`; }

export async function request(app, path, options = {}) {
  const response = await fetch(`${app.origin}${path}`, options);
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, bytes, json: () => JSON.parse(bytes) };
}
