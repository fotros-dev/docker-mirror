import { publicError } from '../core/errors.js';
import { tagEntry } from '../storage/repositories.js';

export class Synchronizer {
  constructor(config, store, repositories, mirror, upstream, archives, telemetry) {
    Object.assign(this, { config, store, repositories, mirror, upstream, archives, telemetry });
  }

  start() {
    if (!this.config.syncEnabled) return;
    const scheduled = () => this.run().catch(error => this.telemetry.log('error', 'synchronization_failure', { code: publicError(error).code }));
    this.timer = setInterval(scheduled, this.config.syncIntervalMs);
    this.timer.unref();
    this.startupTimer = setTimeout(scheduled, 1000);
    this.startupTimer.unref();
  }

  run() {
    if (this.active) return this.active;
    this.active = this.synchronize().finally(() => { this.active = null; });
    return this.active;
  }

  async synchronize() {
    const results = [];
    for (const record of await this.store.list('repos')) {
      if (record.provider === 'local' || !this.config.providers[record.provider]?.enabled || this.stopping) continue;
      const route = { name: record.name, provider: record.provider, remote: record.remote };
      for (const [tag, previous] of Object.entries(record.tags)) {
        if (this.stopping) break;
        const key = `${route.name}:${tag}`;
        const saved = await this.store.get('sync', key);
        if (saved?.retryAt > Date.now()) continue;
        let result = { key, checkedAt: new Date().toISOString() };
        try {
          let advertised;
          try {
            const head = await this.upstream.request(route, 'manifests', tag, { method: 'HEAD' });
            advertised = head.headers['docker-content-digest'];
            head.destroy();
          } catch (error) { if (![405, 501].includes(error.detail?.upstreamStatus)) throw error; }
          if (advertised && advertised === previous.current) result.state = 'unchanged';
          else {
            const image = await this.mirror.manifest(route, tag, { refresh: true });
            if (image.digest === previous.current) result.state = 'unchanged';
            else {
              await this.repositories.update(route, value => {
                if (!tagEntry(value, tag)) Object.defineProperty(value.tags, tag, { value: { current: null, history: [] }, enumerable: true, writable: true, configurable: true });
                value.tags[tag].candidate = image.digest;
                return value;
              });
              await this.archives.enqueue(route, image.digest, tag);
              result = { ...result, state: 'scheduled', digest: image.digest };
            }
          }
          this.telemetry.count('syncChecks');
        } catch (error) {
          const failure = publicError(error);
          const failures = (saved?.failures ?? 0) + 1;
          result = { ...result, state: 'failed', failures, code: failure.code, reason: failure.detail?.reason, retryAt: Date.now() + Math.max(Number(failure.headers?.['retry-after'] ?? 0) * 1000, Math.min(this.config.syncIntervalMs, 60000 * 2 ** Math.min(failures, 8))) };
          this.telemetry.count('syncErrors');
        }
        await this.store.set('sync', key, result);
        results.push(result);
      }
    }
    return results;
  }

  async close() {
    this.stopping = true;
    clearInterval(this.timer);
    clearTimeout(this.startupTimer);
    await this.active?.catch(() => {});
  }
}
