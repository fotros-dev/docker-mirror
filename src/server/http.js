import http from 'node:http';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { RegistryError, publicError } from '../core/errors.js';
import { abortable } from '../core/concurrency.js';
import { routeRepository, digest, reference, sha256 } from '../registry/validation.js';
import { parseManifest, acceptsManifest, isManifestType } from '../registry/manifests.js';

export async function readBody(request, limit) {
  const parts = [];
  let size = 0;
  for await (const part of request) {
    size += part.length;
    if (size > limit) throw new RegistryError(413, 'SIZE_INVALID', 'Request body exceeds the configured size limit.');
    parts.push(part);
  }
  return Buffer.concat(parts);
}

export function parseRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  const invalid = () => { throw new RegistryError(416, 'SIZE_INVALID', 'Requested byte range is not satisfiable.', undefined, { 'content-range': `bytes */${size}` }); };
  if (!match || !match[1] && !match[2] || size === 0) return invalid();
  let start;
  let end;
  if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) return invalid(); start = Math.max(0, size - suffix); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return invalid();
  return { start, end: Math.min(size - 1, end) };
}

export function json(response, status, value, method = 'GET', headers = {}) {
  const bytes = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': String(bytes.length), ...headers });
  response.end(method === 'HEAD' ? undefined : bytes);
}

function finish(response, status, headers = {}) {
  response.writeHead(status, { 'content-length': '0', ...headers });
  response.end();
}

async function validatePublication(app, route, parsed) {
  const record = await app.repositories.get(route);
  let count = 0;
  const visited = new Set();
  const visit = async (manifest, depth) => {
    if (depth > app.config.maxDepth) throw new RegistryError(400, 'MANIFEST_INVALID', 'Manifest graph exceeds the recursion limit.');
    for (const descriptor of manifest.descriptors) {
      if (++count > app.config.maxDescriptors) throw new RegistryError(400, 'MANIFEST_INVALID', 'Manifest graph contains too many descriptors.');
      const association = manifest.index ? record.manifests[descriptor.digest] : record.blobs[descriptor.digest];
      if (!association || !await app.store.content(descriptor.digest, descriptor.size)) throw new RegistryError(400, 'MANIFEST_BLOB_UNKNOWN', 'Referenced content is not available in this repository.', { digest: descriptor.digest });
      if (manifest.index) {
        if (!isManifestType(descriptor.mediaType) || association.mediaType !== descriptor.mediaType) throw new RegistryError(400, 'MANIFEST_INVALID', 'Unsupported child manifest type.');
        if (visited.has(descriptor.digest)) continue;
        visited.add(descriptor.digest);
        await visit(parseManifest(await app.store.contentBytes(descriptor.digest, app.config.maxManifestBytes), association.mediaType, app.config), depth + 1);
      }
    }
  };
  await visit(parsed, 0);
}

async function dispatch(app, request, response) {
  const { method } = request;
  const raw = request.url;
  if (!raw || raw.length > 8192 || !raw.startsWith('/') || raw.startsWith('//') || /[\\\x00-\x20\x7f]/.test(raw)) throw new RegistryError(400, 'NAME_INVALID', 'Invalid request target.');
  const rawPath = raw.split('?')[0];
  if (rawPath.includes('%') || rawPath.includes('//') || rawPath.split('/').some(part => part === '.' || part === '..')) throw new RegistryError(400, 'NAME_INVALID', 'Invalid request path.');
  const url = new URL(raw, 'http://registry.invalid');
  const path = url.pathname;
  if (path === '/healthz' && ['GET', 'HEAD'].includes(method)) return json(response, 200, { status: 'ok', service: 'fotros-docker-mirror' }, method);
  if (['/admin/status', '/admin/metrics', '/admin/doctor'].includes(path) && ['GET', 'HEAD'].includes(method)) {
    await app.auth.admin(request);
    if (path === '/admin/doctor') return json(response, 200, await app.connectivity.check(true), method);
    const status = await app.status();
    return json(response, 200, path === '/admin/metrics' ? status.metrics : status, method);
  }
  if (path === '/v2/' || path === '/v2') {
    if (!['GET', 'HEAD'].includes(method)) throw new RegistryError(405, 'UNSUPPORTED', 'Method is unsupported.', undefined, { allow: 'GET, HEAD' });
    await app.auth.authenticate(request);
    return json(response, 200, {}, method);
  }
  const match = /^\/v2\/(.+)\/(manifests|blobs|tags|referrers)\/(.*)$/.exec(path);
  if (!match) throw new RegistryError(404, 'NAME_UNKNOWN', 'Unknown registry API endpoint.');
  const route = routeRepository(match[1], app.config.providers);
  const [, , resource, value] = match;
  const modifying = !['GET', 'HEAD'].includes(method);
  const uploadRequest = resource === 'blobs' && (value === 'uploads' || value.startsWith('uploads/'));
  let user;
  if (modifying) {
    if (!app.config.pushEnabled) throw new RegistryError(405, 'UNSUPPORTED', 'Push is disabled.');
    if (route.provider !== 'local') throw new RegistryError(403, 'DENIED', 'Push is restricted to the local/ namespace.');
    user = await app.auth.authorize(request, route.name, 'push');
  } else if (route.provider === 'local' && !uploadRequest) user = await app.auth.authorize(request, route.name, 'pull');
  if (uploadRequest) {
    if (!app.config.pushEnabled) throw new RegistryError(405, 'UNSUPPORTED', 'Push is disabled.');
    if (route.provider !== 'local') throw new RegistryError(403, 'DENIED', 'Uploads are restricted to local repositories.');
    user = await app.auth.authorize(request, route.name, 'push');
    const id = value.startsWith('uploads/') ? value.slice(8) : '';
    if (method === 'POST' && !id) {
      const mount = url.searchParams.get('mount');
      const from = url.searchParams.get('from');
      if (mount) digest(mount);
      if (mount && from) {
        const source = routeRepository(from, app.config.providers);
        if (source.provider === 'local') {
          await app.auth.authorize(request, source.name, 'pull');
          const record = await app.repositories.get(source);
          if (record.blobs[mount] && await app.store.content(mount, record.blobs[mount].size)) {
            await app.repositories.blob(route, mount, record.blobs[mount].size);
            request.resume();
            return finish(response, 201, { location: `/v2/${route.name}/blobs/${mount}`, 'docker-content-digest': mount });
          }
        }
      }
      const algorithm = url.searchParams.get('digest-algorithm');
      if (algorithm && algorithm !== 'sha256') throw new RegistryError(400, 'DIGEST_INVALID', 'Only sha256 uploads are supported.');
      const completeDigest = url.searchParams.get('digest');
      if (completeDigest) digest(completeDigest);
      let session = await app.uploads.start(route, user);
      if (completeDigest) {
        session = await app.uploads.append(route, session.id, user, request, completeDigest);
        return finish(response, 201, { location: `/v2/${route.name}/blobs/${session.digest}`, 'docker-content-digest': session.digest });
      }
      request.resume();
      return finish(response, 202, app.uploads.headers(route, session));
    }
    if (!id) throw new RegistryError(405, 'UNSUPPORTED', 'Method is unsupported for uploads.');
    if (['GET', 'HEAD'].includes(method)) return finish(response, 204, app.uploads.headers(route, await app.uploads.status(route, id, user)));
    if (method === 'DELETE') { await app.uploads.cancel(route, id, user); return finish(response, 204); }
    if (['PATCH', 'PUT'].includes(method)) {
      const completeDigest = method === 'PUT' ? url.searchParams.get('digest') : undefined;
      if (method === 'PUT' && !completeDigest) throw new RegistryError(400, 'DIGEST_INVALID', 'Upload completion requires a digest.');
      const session = await app.uploads.append(route, id, user, request, completeDigest);
      return method === 'PUT' ? finish(response, 201, { location: `/v2/${route.name}/blobs/${session.digest}`, 'docker-content-digest': session.digest }) : finish(response, 202, app.uploads.headers(route, session));
    }
    throw new RegistryError(405, 'UNSUPPORTED', 'Method is unsupported for uploads.');
  }
  if (resource === 'manifests') {
    reference(value);
    if (method === 'PUT') {
      const bytes = await readBody(request, app.config.maxManifestBytes);
      const parsed = parseManifest(bytes, request.headers['content-type'], app.config);
      const hash = sha256(bytes);
      if (value.startsWith('sha256:') && value !== hash) throw new RegistryError(400, 'DIGEST_INVALID', 'Published manifest digest mismatch.');
      await validatePublication(app, route, parsed);
      await app.store.put(bytes, hash);
      await app.repositories.manifest(route, hash, parsed, bytes.length);
      if (!value.startsWith('sha256:')) await app.repositories.publish(route, value, hash);
      app.telemetry.count('publishedManifests');
      return finish(response, 201, { location: `/v2/${route.name}/manifests/${hash}`, 'docker-content-digest': hash });
    }
    if (!['GET', 'HEAD'].includes(method)) throw new RegistryError(405, 'UNSUPPORTED', 'Archived manifests cannot be deleted.');
    app.telemetry.count('pullRequests');
    const manifest = await app.mirror.manifest(route, value, { foreground: true });
    if (route.provider !== 'local') {
      if (!value.startsWith('sha256:')) await app.repositories.track(route, value, manifest.digest);
      await app.archives.enqueue(route, manifest.digest, value.startsWith('sha256:') ? undefined : value);
    }
    if (!acceptsManifest(request.headers.accept, manifest.parsed.mediaType)) throw new RegistryError(406, 'MANIFEST_UNKNOWN', 'The requested manifest media type is not accepted.');
    response.writeHead(200, { 'content-type': manifest.parsed.mediaType, 'content-length': String(manifest.bytes.length), 'docker-content-digest': manifest.digest, etag: `"${manifest.digest}"` });
    return response.end(method === 'HEAD' ? undefined : manifest.bytes);
  }
  if (resource === 'blobs') {
    digest(value);
    if (!['GET', 'HEAD'].includes(method)) throw new RegistryError(405, 'UNSUPPORTED', 'Archived blobs cannot be deleted.');
    app.telemetry.count('pullRequests');
    const started = Date.now();
    const controller = new AbortController();
    let disconnected = false;
    let streamFailed = false;
    let failure;
    let bytes = 0;
    let content;
    const close = () => {
      if (!response.writableFinished) { disconnected = !streamFailed && !content?.task?.error; controller.abort(); }
    };
    response.once('close', close);
    try {
      content = await abortable(app.mirror.openBlob(route, value, { foreground: true, head: method === 'HEAD' }), controller.signal);
      controller.signal.throwIfAborted();
      let range = null;
      if (method === 'GET' && (!request.headers['if-range'] || request.headers['if-range'] === `"${value}"`)) range = parseRange(request.headers.range, content.size);
      const headers = { 'content-type': 'application/octet-stream', 'content-length': String(range ? range.end - range.start + 1 : content.size), 'docker-content-digest': value, 'accept-ranges': 'bytes', etag: `"${value}"` };
      if (range) headers['content-range'] = `bytes ${range.start}-${range.end}/${content.size}`;
      if (method === 'HEAD') return finish(response, 200, headers);
      if (content.task && content.size === 0) await content.completion;
      const stream = content.task ? Readable.from(app.mirror.streamBlob(content, range, controller.signal), { objectMode: false, highWaterMark: 64 * 1024 }) : (await app.store.open(content.path)).createReadStream(range ? { start: range.start, end: range.end } : {});
      stream.on('data', chunk => { bytes += chunk.length; });
      stream.once('error', () => { streamFailed = true; });
      response.writeHead(range ? 206 : 200, headers);
      response.flushHeaders();
      await pipeline(stream, response, { signal: controller.signal });
    } catch (error) {
      failure = publicError(error);
      throw error;
    } finally {
      response.removeListener('close', close);
      if (disconnected) app.telemetry.count('blobClientDisconnects');
      app.telemetry.count('blobClientBytes', bytes);
      app.telemetry.log('info', 'blob_request', { provider: route.provider, digest: value, method, status: response.headersSent ? response.statusCode : failure?.status, code: failure?.code, cache: content?.cache, queueWaitMs: content?.queueWaitMs ?? 0, upstreamTtfbMs: content?.upstreamTtfbMs, retryCount: content?.retryCount ?? 0, bytes, clientDisconnect: disconnected, durationMs: Date.now() - started });
    }
    return;
  }
  if (resource === 'tags' && value === 'list' && ['GET', 'HEAD'].includes(method)) {
    const record = await app.repositories.get(route);
    const rawLimit = url.searchParams.get('n');
    const limit = rawLimit === null ? 1000 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RegistryError(400, 'UNSUPPORTED', 'Tag page size must be between 1 and 1000.');
    const last = url.searchParams.get('last') ?? '';
    const tags = Object.keys(record.tags).filter(tag => record.tags[tag].current && tag > last).sort();
    const page = tags.slice(0, limit);
    const headers = {};
    if (tags.length > limit) headers.link = `</v2/${route.name}/tags/list?n=${limit}&last=${encodeURIComponent(page.at(-1))}>; rel="next"`;
    return json(response, 200, { name: route.name, tags: page }, method, headers);
  }
  if (resource === 'referrers' && ['GET', 'HEAD'].includes(method)) {
    digest(value);
    throw new RegistryError(404, 'UNSUPPORTED', 'Referrers discovery is unsupported.');
  }
  throw new RegistryError(405, 'UNSUPPORTED', 'This optional registry operation is unsupported.');
}

export function createServer(app) {
  const server = http.createServer({ maxHeaderSize: 16384, requestTimeout: 300000, headersTimeout: 15000, keepAliveTimeout: 5000, requireHostHeader: true, rejectNonStandardBodyWrites: true }, async (request, response) => {
    let finishRequest;
    const work = new Promise(resolve => { finishRequest = resolve; });
    app.httpWork ??= new Set();
    app.httpWork.add(work);
    const started = Date.now();
    response.setHeader('docker-distribution-api-version', 'registry/2.0');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('cache-control', 'no-store');
    try { await dispatch(app, request, response); }
    catch (error) {
      let failure = publicError(error);
      if (!response.headersSent && !response.destroyed && failure.status === 503 && failure.detail && ['DNS_FAILURE', 'CONNECTION_FAILURE', 'CONNECTION_TIMEOUT'].includes(failure.detail.reason)) {
        const diagnosis = await app.connectivity.check().catch(() => ({ state: 'unknown' }));
        if (diagnosis.state === 'suspected_disruption') failure = new RegistryError(503, 'UPSTREAM_UNAVAILABLE', 'International internet connectivity appears unavailable.', { reason: 'INTERNATIONAL_CONNECTIVITY_DISRUPTION' });
      }
      app.telemetry.count('clientErrors');
      app.telemetry.log(failure.status >= 500 ? 'error' : 'warn', 'request_failed', { method: request.method, status: failure.status, code: failure.code, reason: failure.detail?.reason });
      if (response.headersSent || response.destroyed) response.destroy();
      else {
        if (!request.complete) response.setHeader('connection', 'close');
        json(response, failure.status, { errors: [{ code: failure.code, message: failure.message, ...(failure.detail === undefined ? {} : { detail: failure.detail }) }] }, request.method, failure.headers);
      }
    } finally {
      app.telemetry.count('clientRequests');
      app.telemetry.log('debug', 'request_finished', { method: request.method, status: response.statusCode, durationMs: Date.now() - started });
      app.httpWork.delete(work);
      finishRequest();
    }
  });
  server.maxRequestsPerSocket = 1000;
  server.maxConnections = 256;
  server.setTimeout(300000, socket => socket.destroy());
  server.on('clientError', (error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  return server;
}
