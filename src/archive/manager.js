import { setTimeout as delay } from 'node:timers/promises';
import { isManifestType } from '../registry/manifests.js';
import { keyHash } from '../registry/validation.js';
import { publicError, RegistryError } from '../core/errors.js';
import { tagEntry } from '../storage/repositories.js';

export class ArchiveManager {
  constructor(config, store, repositories, mirror, telemetry) {
    Object.assign(this, { config, store, repositories, mirror, telemetry });
    this.jobs = new Map();
    this.active = new Set();
    this.stopping = false;
  }

  async initialize() {
    for (const job of await this.store.list('jobs')) {
      if (job.state === 'downloading') { job.state = 'pending'; job.nextAttempt = 0; await this.store.set('jobs', job.id, job); }
      this.jobs.set(job.id, job);
    }
    for (const job of this.jobs.values()) if (job.state === 'complete') for (const tag of job.tags) await this.publish(job, tag);
    for (const record of await this.store.list('repos')) {
      if (record.provider === 'local') continue;
      const route = { name: record.name, remote: record.remote, provider: record.provider };
      for (const [tag, entry] of Object.entries(record.tags)) {
        const candidate = entry.candidate ?? entry.pending;
        if (candidate) await this.enqueue(route, candidate, tag);
      }
    }
  }

  start() {
    this.started = true;
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
    this.tick();
  }

  async enqueue(route, digest, tag, retry = false) {
    const id = keyHash(`${route.name}@${digest}`);
    const existing = this.jobs.get(id);
    if (existing && !retry && (!tag || existing.tags.includes(tag))) {
      if (existing.state === 'complete' && tag) await this.publish(existing, tag);
      return existing;
    }
    const job = await this.store.update('jobs', id, previous => {
      const value = previous ?? { id, route, digest, tags: [], state: 'pending', attempts: 0, nextAttempt: 0, verified: [], platforms: [], limitations: [], createdAt: new Date().toISOString() };
      if (tag && !value.tags.includes(tag)) value.tags.push(tag);
      if (retry && ['failed', 'partial', 'corrupted'].includes(value.state)) { value.state = 'pending'; value.attempts = 0; value.nextAttempt = 0; }
      return value;
    });
    this.jobs.set(id, job);
    if (job.state === 'complete' && tag) await this.publish(job, tag);
    this.tick();
    return job;
  }

  tick() {
    if (this.stopping || !this.started) return;
    for (const job of this.jobs.values()) {
      if (this.active.size >= this.config.archiveConcurrency) break;
      if (this.active.has(job.id) || !['pending', 'partial', 'failed', 'corrupted'].includes(job.state) || job.attempts >= 6 || job.nextAttempt > Date.now()) continue;
      const task = this.run(job.id);
      this.active.add(job.id);
      this.work ??= new Set();
      this.work.add(task);
      task.catch(error => {
        const previous = this.jobs.get(job.id) ?? job;
        this.jobs.set(job.id, { ...previous, state: 'failed', attempts: previous.attempts + 1, nextAttempt: Date.now() + 60000 * 2 ** Math.min(previous.attempts, 6) });
        this.telemetry.log('error', 'archive_persistence_failure', { code: publicError(error).code });
      }).finally(() => { this.active.delete(job.id); this.work.delete(task); });
    }
  }

  async patch(id, operation) {
    const job = await this.store.update('jobs', id, operation);
    this.jobs.set(id, job);
    return job;
  }

  async invalidate(route, digest) {
    for (const job of this.jobs.values()) {
      if (job.route.name === route.name && (job.digest === digest || job.verified.includes(digest))) await this.patch(job.id, value => ({ ...value, state: 'corrupted', attempts: value.state === 'complete' ? 0 : value.attempts, nextAttempt: value.state === 'complete' ? 0 : value.nextAttempt, error: { code: 'DIGEST_INVALID', reason: 'CONTENT_CORRUPTED' } }));
    }
  }

  async publish(job, tag) {
    const previous = tagEntry(await this.repositories.get(job.route), tag);
    if (!previous || previous.current === job.digest && !previous.candidate && !previous.pending) return;
    await this.repositories.update(job.route, record => {
      const entry = tagEntry(record, tag);
      if (!entry || (entry.candidate ?? entry.pending ?? entry.current) !== job.digest) return record;
      if (!entry.history.some(value => value.digest === job.digest)) entry.history.push({ digest: job.digest, archivedAt: new Date().toISOString() });
      entry.current = job.digest;
      delete entry.pending;
      delete entry.candidate;
      return record;
    });
  }

  async run(id) {
    let job = await this.patch(id, value => ({ ...value, state: 'downloading', attempts: value.attempts + 1, startedAt: new Date().toISOString(), limitations: [], platforms: [] }));
    this.telemetry.count('archiveAttempts');
    const visited = new Map();
    const limitations = [];
    const platforms = [];
    let count = 0;
    const checkpoint = async digest => {
      job = await this.patch(id, value => {
        if (!value.verified.includes(digest)) value.verified.push(digest);
        return value;
      });
    };
    const visit = async (digest, depth, descriptor) => {
      if (this.stopping) throw new RegistryError(503, 'UPSTREAM_UNAVAILABLE', 'Archive interrupted by shutdown.');
      if (depth > this.config.maxDepth || ++count > this.config.maxDescriptors) throw new RegistryError(502, 'MANIFEST_INVALID', 'Archive descriptor depth or count exceeds the safety limit.');
      if (visited.has(digest)) {
        if (descriptor && (visited.get(digest).size !== descriptor.size || visited.get(digest).mediaType !== descriptor.mediaType)) throw new RegistryError(502, 'SIZE_INVALID', 'Conflicting recursive descriptors.');
        return;
      }
      const result = await this.mirror.manifest(job.route, digest, { expectedSize: descriptor?.size, expectedType: descriptor?.mediaType, inline: descriptor?.data });
      visited.set(digest, { size: result.bytes.length, mediaType: result.parsed.mediaType });
      if (descriptor?.platform) platforms.push({ digest, ...descriptor.platform, kind: result.parsed.artifact || descriptor.platform.os === 'unknown' || descriptor.platform.architecture === 'unknown' ? 'artifact' : 'image' });
      await checkpoint(digest);
      for (const child of result.parsed.descriptors) {
        if (result.parsed.index) {
          if (isManifestType(child.mediaType)) await visit(child.digest, depth + 1, child);
          else limitations.push({ digest: child.digest, reason: 'UNSUPPORTED_DESCRIPTOR', mediaType: child.mediaType });
        } else {
          if (++count > this.config.maxDescriptors) throw new RegistryError(502, 'MANIFEST_INVALID', 'Archive contains too many descriptors.');
          try { await this.mirror.blob(job.route, child.digest, child); await checkpoint(child.digest); }
          catch (error) {
            if (child.urls?.length && error.status === 404) limitations.push({ digest: child.digest, reason: 'EXTERNAL_CONTENT_UNAVAILABLE' });
            else throw error;
          }
        }
      }
    };
    try {
      await visit(job.digest, 0);
      job = await this.patch(id, value => ({ ...value, state: limitations.length ? 'partial' : 'complete', limitations, platforms, completedAt: new Date().toISOString(), nextAttempt: limitations.length ? Date.now() + 3600000 : 0, error: null }));
      if (job.state === 'complete') {
        for (const tag of job.tags) await this.publish(job, tag);
        this.telemetry.count('completedArchives');
      } else this.telemetry.count('partialArchives');
    } catch (error) {
      const failure = publicError(error);
      const backoff = Math.max(Number(error.headers?.['retry-after'] ?? 0) * 1000, Math.min(3600000, 5000 * 2 ** Math.min(job.attempts, 9)) + Math.floor(Math.random() * 3000));
      job = await this.patch(id, value => ({ ...value, state: failure.detail?.reason === 'CONTENT_CORRUPTED' ? 'corrupted' : value.verified.length ? 'partial' : 'failed', nextAttempt: Date.now() + backoff, limitations, platforms, error: { code: failure.code, reason: failure.detail?.reason, status: failure.status }, updatedAt: new Date().toISOString() }));
      this.telemetry.count('failedArchives');
    }
    this.telemetry.log(job.state === 'complete' ? 'info' : 'warn', 'archive_result', { job: id, state: job.state });
  }

  async waitForIdle(timeout = 30000) {
    this.started = true;
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      this.tick();
      if (!this.active.size && ![...this.jobs.values()].some(job => job.state === 'pending')) return;
      await delay(20);
    }
    throw new Error('Archive wait timed out.');
  }

  async close() {
    this.stopping = true;
    clearInterval(this.timer);
    await Promise.allSettled([...(this.work ?? [])]);
  }
}
