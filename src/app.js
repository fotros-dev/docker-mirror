import { Store } from './storage/store.js';
import { Repositories } from './storage/repositories.js';
import { SafeTransport } from './network/transport.js';
import { Connectivity } from './network/connectivity.js';
import { UpstreamClient } from './upstream/client.js';
import { Mirror } from './registry/mirror.js';
import { Uploads } from './registry/uploads.js';
import { ArchiveManager } from './archive/manager.js';
import { Synchronizer } from './archive/synchronizer.js';
import { Authentication } from './auth/auth.js';
import { Telemetry } from './observability/telemetry.js';
import { createServer } from './server/http.js';
import { publicError } from './core/errors.js';

export class Application {
  constructor(config, { transport } = {}) {
    this.config = config;
    this.store = new Store(config.dataDir);
    this.repositories = new Repositories(this.store);
    this.telemetry = new Telemetry(this.store, config.logLevel);
    this.transport = transport ?? new SafeTransport({ timeout: config.requestTimeoutMs });
    this.upstream = new UpstreamClient(config, this.transport, this.telemetry, this.store);
    this.mirror = new Mirror(config, this.store, this.repositories, this.upstream, this.telemetry);
    this.auth = new Authentication(config, this.store, this.telemetry);
    this.uploads = new Uploads(config, this.store, this.repositories, this.telemetry);
    this.archives = new ArchiveManager(config, this.store, this.repositories, this.mirror, this.telemetry);
    this.mirror.onCorruption = (route, digest) => this.archives.invalidate(route, digest);
    this.sync = new Synchronizer(config, this.store, this.repositories, this.mirror, this.upstream, this.archives, this.telemetry);
    this.connectivity = new Connectivity(config, this.transport, this.telemetry);
  }

  async initialize() {
    await this.store.initialize();
    try {
      await this.auth.initialize();
      await this.telemetry.initialize();
      await this.upstream.initialize();
      await this.uploads.recover();
      await this.archives.initialize();
      this.connectivity.result = await this.store.get('system', 'connectivity') ?? this.connectivity.result;
      this.initialized = true;
    } catch (error) { await this.telemetry.close().catch(() => {}); await this.store.close(); throw error; }
    return this;
  }

  async listen() {
    this.server = createServer(this);
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.port, this.config.host, resolve);
    });
    this.archives.start();
    this.sync.start();
    return this.server.address();
  }

  async status() {
    const jobs = await this.store.list('jobs');
    const repositories = await this.store.list('repos');
    return {
      version: '1.0.0', pushEnabled: this.config.pushEnabled, synchronization: { enabled: this.config.syncEnabled, intervalMinutes: this.config.syncIntervalMs / 60000 },
      storage: await this.store.usage(), metrics: this.telemetry.snapshot(), connectivity: this.connectivity.result,
      archives: Object.fromEntries(['pending', 'downloading', 'partial', 'complete', 'failed', 'corrupted'].map(state => [state, jobs.filter(job => job.state === state).length])),
      jobs, repositories: repositories.map(record => ({ name: record.name, provider: record.provider, tags: record.tags, manifestCount: Object.keys(record.manifests).length, blobCount: Object.keys(record.blobs).length })),
      synchronizationHistory: await this.store.list('sync'), metadataRecoveries: this.store.recoveries
    };
  }

  async verify() {
    const failures = [];
    this.store.verified.clear();
    for (const record of await this.store.list('repos')) {
      for (const [digest, descriptor] of Object.entries({ ...record.blobs, ...record.manifests })) {
        try { if (!await this.store.content(digest, descriptor.size)) throw new Error('Missing content'); }
        catch (error) { failures.push({ repository: record.name, digest, code: publicError(error).code }); }
      }
    }
    for (const job of await this.store.list('jobs')) {
      const corrupt = failures.some(failure => failure.repository === job.route.name && job.verified.includes(failure.digest));
      if (corrupt) {
        job.state = 'corrupted';
        job.error = { code: 'DIGEST_INVALID', reason: 'CONTENT_CORRUPTED' };
        await this.store.set('jobs', job.id, job);
        this.archives.jobs.set(job.id, job);
      }
    }
    return { ok: failures.length === 0, failures };
  }

  async close() {
    if (this.closing) return this.closing;
    this.closing = this.shutdown();
    return this.closing;
  }

  async shutdown() {
    const serverClose = this.server ? new Promise(resolve => this.server.close(resolve)) : Promise.resolve();
    this.server?.closeIdleConnections();
    this.sync.stopping = true;
    this.archives.stopping = true;
    this.transport.close();
    await this.sync.close();
    await this.archives.close();
    await this.mirror.close();
    this.server?.closeAllConnections();
    await serverClose;
    await Promise.allSettled([...(this.httpWork ?? [])]);
    await this.telemetry.close();
    await this.store.close();
  }
}
