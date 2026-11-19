import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { RegistryError, networkError } from '../core/errors.js';
import { SingleFlight, DownloadScheduler } from '../core/concurrency.js';
import { sha256 } from './validation.js';
import { parseManifest } from './manifests.js';
import { readResponse } from '../network/transport.js';
import { tagEntry } from '../storage/repositories.js';

export class Mirror {
  constructor(config, store, repositories, upstream, telemetry) {
    Object.assign(this, { config, store, repositories, upstream, telemetry });
    this.flight = new SingleFlight();
    this.downloads = new DownloadScheduler(config.downloadConcurrency, config.foregroundDownloads);
    this.transfers = new Map();
    this.manifestWork = new DownloadScheduler(config.downloadConcurrency, config.foregroundDownloads, 128);
    this.manifestPriority = new Set();
  }

  async corrupted(route, value) {
    this.telemetry.count('corruptedContent');
    await this.onCorruption?.(route, value);
  }

  async manifest(route, ref, { refresh = false, expectedSize, expectedType, inline, foreground = false } = {}) {
    const key = `manifest:${route.name}:${ref}:${refresh}`;
    if (foreground) { this.manifestPriority.add(key); this.manifestWork.promote(key); }
    return this.flight.run(key, () => this.manifestWork.run(key, async () => {
      const record = await this.repositories.get(route);
      const resolved = ref.startsWith('sha256:') ? ref : tagEntry(record, ref)?.current ?? tagEntry(record, ref)?.pending;
      if (!refresh && resolved && record.manifests[resolved]) {
        try {
          const bytes = await this.store.contentBytes(resolved, this.config.maxManifestBytes);
          if (expectedSize !== undefined && bytes.length !== expectedSize) throw new RegistryError(502, 'SIZE_INVALID', 'Manifest size does not match its descriptor.');
          const parsed = parseManifest(bytes, record.manifests[resolved].mediaType, this.config);
          if (expectedType && parsed.mediaType !== expectedType) throw new RegistryError(502, 'MANIFEST_INVALID', 'Manifest media type does not match its descriptor.');
          this.telemetry.count('cacheHits');
          return { digest: resolved, bytes, parsed };
        } catch (error) {
          if (!['CONTENT_CORRUPTED'].includes(error.detail?.reason) && error.code !== 'MANIFEST_UNKNOWN') throw error;
          await this.corrupted(route, resolved);
          if (route.provider === 'local') throw error;
        }
      }
      if (route.provider === 'local') throw new RegistryError(404, 'MANIFEST_UNKNOWN', 'Manifest is not present in this repository.');
      this.telemetry.count('cacheMisses');
      let bytes;
      let type;
      let advertised;
      if (inline !== undefined) { bytes = Buffer.from(inline, 'base64'); type = expectedType; }
      else {
        const response = await this.upstream.request(route, 'manifests', ref);
        if (response.statusCode !== 200) { response.destroy(); throw new RegistryError(502, 'UPSTREAM_UNAVAILABLE', 'Unexpected manifest response.'); }
        type = response.headers['content-type'];
        advertised = response.publicDigest ?? response.headers['docker-content-digest'];
        bytes = await readResponse(response, this.config.maxManifestBytes);
      }
      const contentDigest = sha256(bytes);
      if (ref.startsWith('sha256:') && ref !== contentDigest || advertised && advertised !== contentDigest) throw new RegistryError(502, 'DIGEST_INVALID', 'Upstream manifest digest mismatch.');
      if (expectedSize !== undefined && bytes.length !== expectedSize) throw new RegistryError(502, 'SIZE_INVALID', 'Manifest size does not match its descriptor.');
      let parsed;
      try { parsed = parseManifest(bytes, type, this.config); }
      catch (error) { if (error instanceof RegistryError) error.status = 502; throw error; }
      if (expectedType && parsed.mediaType !== expectedType) throw new RegistryError(502, 'MANIFEST_INVALID', 'Manifest media type does not match its descriptor.');
      await this.store.put(bytes, contentDigest);
      await this.repositories.manifest(route, contentDigest, parsed, bytes.length);
      return { digest: contentDigest, bytes, parsed };
    }, this.manifestPriority.has(key))).finally(() => this.manifestPriority.delete(key));
  }

  validateBlobResponse(response, value, expected, offset = 0, head = false) {
    const invalid = (code, message) => { response.destroy(); throw new RegistryError(502, code, message); };
    if (response.statusCode !== 200 && !(response.statusCode === 206 && offset > 0 && !head)) invalid('UPSTREAM_UNAVAILABLE', 'Unexpected upstream blob response.');
    const advertised = response.headers['docker-content-digest'];
    if (advertised && advertised !== value) invalid('DIGEST_INVALID', 'Upstream blob digest header mismatch.');
    let start = 0;
    if (response.statusCode === 206) {
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers['content-range'] ?? '');
      if (!match || Number(match[1]) !== offset || Number(match[2]) !== expected.size - 1 || Number(match[3]) !== expected.size) invalid('SIZE_INVALID', 'Invalid upstream resume range.');
      start = offset;
    } else if (response.headers['content-range']) invalid('SIZE_INVALID', 'Unexpected upstream content range.');
    const length = response.headers['content-length'];
    // Chunked upstreams are safe: the verified descriptor supplies the downstream length.
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) !== expected.size - start)) invalid('SIZE_INVALID', 'Upstream blob length does not match its descriptor.');
    return start;
  }

  async blob(route, value, descriptor) {
    const content = await this.openBlob(route, value, { descriptor });
    return content.task ? content.completion : content;
  }

  async openBlob(route, value, { descriptor, foreground = false, head = false } = {}) {
    if (foreground) this.downloads.promote(value);
    // HEAD has its own short flight; it never waits for a body download.
    return this.flight.run(`blob-open:${route.name}:${value}:${head}:${foreground}`, async () => {
      const record = await this.repositories.get(route);
      const accessible = record.blobs[value];
      const expected = descriptor ?? record.descriptors[value] ?? accessible;
      if (accessible) {
        try {
          const cached = await this.store.content(value, expected?.size ?? accessible.size);
          if (cached) { this.telemetry.count('cacheHits'); return { ...cached, cache: 'hit' }; }
          await this.corrupted(route, value);
        } catch (error) {
          if (error.detail?.reason !== 'CONTENT_CORRUPTED') throw error;
          await this.corrupted(route, value);
          if (route.provider === 'local') throw error;
        }
      }
      if (route.provider === 'local') throw new RegistryError(404, 'BLOB_UNKNOWN', 'Blob is not present in this repository.');
      if (!expected) throw new RegistryError(404, 'BLOB_UNKNOWN', 'Fetch a repository manifest before requesting its blobs.');
      if (expected.size > this.config.maxBlobBytes) throw new RegistryError(413, 'SIZE_INVALID', 'Blob exceeds MAX_BLOB_BYTES.');
      this.telemetry.count('cacheMisses');
      if (expected.data !== undefined) {
        await this.store.put(Buffer.from(expected.data, 'base64'), value);
        const content = await this.store.content(value, expected.size);
        await this.repositories.blob(route, value, content.size);
        return { ...content, cache: 'miss' };
      }
      if (head) {
        const proof = await this.upstream.request(route, 'blobs', value, { method: 'HEAD' });
        this.validateBlobResponse(proof, value, expected, 0, true);
        proof.destroy();
        return { size: expected.size, cache: 'miss', upstreamTtfbMs: proof.upstreamTtfbMs, retryCount: proof.retryCount };
      }
      const publicContent = await this.store.get('public', value);
      const existing = publicContent && await this.store.content(value, expected.size).catch(error => {
        if (error.detail?.reason === 'CONTENT_CORRUPTED') return null;
        throw error;
      });
      if (existing) {
        const proof = await this.upstream.request(route, 'blobs', value, { method: 'HEAD' });
        this.validateBlobResponse(proof, value, expected, 0, true);
        proof.destroy();
        await this.repositories.blob(route, value, existing.size);
        return { ...existing, cache: 'miss' };
      }
      let task = this.transfers.get(value);
      if (task && task.size !== expected.size) throw new RegistryError(502, 'SIZE_INVALID', 'Conflicting blob descriptors.');
      if (task && task.route.name !== route.name) {
        const proof = await this.upstream.request(route, 'blobs', value, { method: 'HEAD' });
        this.validateBlobResponse(proof, value, expected, 0, true);
        proof.destroy();
      }
      // Recheck after authorization: another request may have created the flight.
      task = this.transfers.get(value) ?? this.startDownload(route, value, expected, foreground);
      if (task.size !== expected.size) throw new RegistryError(502, 'SIZE_INVALID', 'Conflicting blob descriptors.');
      if (foreground) this.downloads.promote(value);
      if (foreground) {
        let timer;
        try {
          await Promise.race([task.ready.promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new RegistryError(503, 'UPSTREAM_UNAVAILABLE', 'Blob is still waiting for upstream capacity or headers.', { reason: 'BLOB_HEADER_TIMEOUT' }, { 'retry-after': '2' })), this.config.headerBudgetMs);
            timer.unref();
          })]);
        } finally { clearTimeout(timer); }
      } else await task.ready.promise;
      if (task.error) throw task.error;
      const completion = this.flight.run(`blob-grant:${route.name}:${value}`, async () => {
        const content = await task.completion;
        await this.repositories.blob(route, value, content.size);
        return content;
      });
      completion.catch(() => {});
      return { size: expected.size, cache: 'miss', task, completion, queueWaitMs: task.queueWaitMs, upstreamTtfbMs: task.upstreamTtfbMs, retryCount: task.retryCount };
    });
  }

  notify(task) {
    const changed = task.changed;
    task.changed = Promise.withResolvers();
    changed.resolve();
  }

  startDownload(route, value, expected, foreground) {
    const task = { route, size: expected.size, value, path: this.store.path('downloads', `${value.slice(7)}.part`), position: 0, ready: Promise.withResolvers(), changed: Promise.withResolvers(), started: Date.now() };
    task.ready.promise.catch(() => {});
    this.transfers.set(value, task);
    task.completion = this.downloads.run(value, async () => {
      task.queueWaitMs = Date.now() - task.started;
      return this.download(task, expected);
    }, foreground).then(async content => {
      await this.store.set('public', value, { digest: value, verifiedAt: new Date().toISOString() });
      await this.repositories.blob(route, value, content.size);
      task.done = true;
      task.ready.resolve();
      this.notify(task);
      return content;
    }).catch(error => {
      task.retryCount ??= error.retryCount;
      task.upstreamTtfbMs ??= error.upstreamTtfbMs;
      task.error = error;
      task.ready.reject(error);
      this.notify(task);
      throw error;
    }).finally(() => {
      this.transfers.delete(value);
      this.telemetry.count('blobDownloadBytes', task.bytes ?? 0);
      this.telemetry.log(task.error ? 'warn' : 'info', 'blob_download', { provider: route.provider, digest: value, cache: 'miss', queueWaitMs: task.queueWaitMs, upstreamTtfbMs: task.upstreamTtfbMs, bytes: task.bytes ?? 0, durationMs: Date.now() - task.started, downloadDurationMs: Date.now() - task.started - (task.queueWaitMs ?? 0), retryCount: task.retryCount ?? 0, code: task.error?.code, reason: task.error?.detail?.reason });
    });
    task.completion.catch(() => {});
    return task;
  }

  async download(task, expected) {
    const { route, value, path } = task;
    let file = await this.store.open(path, constants.O_RDWR | constants.O_CREAT);
    let response;
    try {
      let offset = (await file.stat()).size;
      if (offset > expected.size) { await file.truncate(0); offset = 0; }
      if (offset > 0) {
        const previous = await this.store.get('downloads', value);
        if (previous?.provider !== route.provider || previous?.remote !== route.remote) {
          const proof = await this.upstream.request(route, 'blobs', value, { method: 'HEAD' });
          this.validateBlobResponse(proof, value, expected, 0, true);
          proof.destroy();
        }
      }
      if (offset > 0 && offset === expected.size) {
        await file.close(); file = null;
        try {
          const content = await this.store.commitFile(path, value, expected.size);
          task.position = expected.size;
          return content;
        } catch (error) {
          if (error.code !== 'DIGEST_INVALID') throw error;
          await fs.unlink(path);
          file = await this.store.open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL);
          offset = 0;
        }
      }
      response = await this.upstream.request(route, 'blobs', value, { headers: offset ? { range: `bytes=${offset}-` } : {} });
      offset = this.validateBlobResponse(response, value, expected, offset);
      if (!offset) await file.truncate(0);
      task.position = offset;
      task.upstreamTtfbMs = response.upstreamTtfbMs;
      task.retryCount = response.retryCount;
      await this.store.set('downloads', value, { digest: value, provider: route.provider, remote: route.remote, size: expected.size, state: 'downloading' });
      task.ready.resolve();
      for await (const chunk of response) {
        if (task.position + chunk.length > expected.size) throw new RegistryError(502, 'SIZE_INVALID', 'Blob is larger than its descriptor.');
        let written = 0;
        while (written < chunk.length) {
          const result = await file.write(chunk, written, chunk.length - written, task.position);
          if (!result.bytesWritten) throw new Error('Blob write made no progress.');
          task.position += result.bytesWritten;
          task.bytes = (task.bytes ?? 0) + result.bytesWritten;
          written += result.bytesWritten;
        }
        this.notify(task);
      }
      if (task.position !== expected.size) throw new RegistryError(503, 'UPSTREAM_UNAVAILABLE', 'Upstream blob transfer was interrupted.', { reason: 'INCOMPLETE_DOWNLOAD' });
      await file.sync();
      await file.close(); file = null;
      const content = await this.store.commitFile(path, value, expected.size);
      await this.store.set('downloads', value, { digest: value, provider: route.provider, remote: route.remote, size: expected.size, state: 'complete' });
      return content;
    } catch (error) {
      response?.destroy();
      if (file) await file.close();
      if (['DIGEST_INVALID', 'SIZE_INVALID'].includes(error.code)) await fs.unlink(path).catch(() => {});
      if (error.code === 'DIGEST_INVALID') error.status = 502;
      throw ['ECONNRESET', 'ETIMEDOUT', 'ERR_STREAM_PREMATURE_CLOSE', 'ABORT_ERR', 'EPIPE'].includes(error.code) ? networkError(error) : error;
    }
  }

  async *streamBlob(content, range, signal) {
    const task = content.task;
    let handle;
    try {
      try { handle = await this.store.open(task.path); }
      catch (error) { if (error.code !== 'ENOENT') throw error; handle = await this.store.open(this.store.contentPath(task.value)); }
      let position = range?.start ?? 0;
      const end = range?.end ?? task.size - 1;
      while (position <= end) {
        signal.throwIfAborted();
        if (task.error) throw task.error;
        // Withhold the last byte of EVERY response, including ranges, until commit.
        const available = Math.min(task.position, task.done ? end + 1 : end);
        if (position < available) {
          const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, available - position));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
          if (!bytesRead) throw new Error('Temporary blob read made no progress.');
          position += bytesRead;
          yield buffer.subarray(0, bytesRead);
        } else {
          await new Promise((resolve, reject) => {
            const abort = () => { cleanup(); reject(signal.reason); };
            const cleanup = () => signal.removeEventListener('abort', abort);
            signal.addEventListener('abort', abort, { once: true });
            task.changed.promise.then(() => { cleanup(); resolve(); });
            if (signal.aborted) abort();
          });
        }
      }
      await content.completion;
    } finally { await handle?.close(); }
  }

  async close() {
    while (this.transfers.size || this.flight.pending.size) {
      await Promise.allSettled([...this.transfers.values()].map(task => task.completion).concat([...this.flight.pending.values()]));
    }
  }
}
