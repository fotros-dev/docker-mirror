import { constants } from 'node:fs';

const levels = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export class Telemetry {
  constructor(store, level) {
    this.store = store;
    this.level = level;
    this.counters = {};
    this.accounts = {};
    this.tasks = new Set();
  }

  async initialize() {
    const saved = await this.store.get('system', 'metrics');
    this.counters = saved?.counters ?? {};
    this.logHandle = await this.store.open(this.store.path('logs', 'registry.jsonl'), constants.O_APPEND | constants.O_WRONLY | constants.O_CREAT);
    this.timer = setInterval(() => this.track(this.flush()), 30000);
    this.timer.unref();
  }

  track(task) {
    this.tasks.add(task);
    task.catch(() => { this.persistenceFailed = true; }).finally(() => this.tasks.delete(task));
  }

  count(name, amount = 1) { this.counters[name] = (this.counters[name] ?? 0) + amount; }

  log(level, event, fields = {}) {
    const allowed = {};
    for (const key of ['status', 'code', 'reason', 'provider', 'method', 'durationMs', 'job', 'state', 'count', 'command', 'digest', 'cache', 'queueWaitMs', 'upstreamTtfbMs', 'bytes', 'retryCount', 'clientDisconnect', 'downloadDurationMs']) if (fields[key] !== undefined) allowed[key] = fields[key];
    const line = `${JSON.stringify({ time: new Date().toISOString(), level, event, ...allowed })}\n`;
    if (levels[level] >= levels[this.level]) process.stderr.write(line);
    if (this.logHandle) this.track(this.logHandle.write(line));
  }

  async flush() {
    await this.store.set('system', 'metrics', { counters: this.counters, updatedAt: new Date().toISOString() });
    if (this.logHandle) await this.logHandle.sync();
  }

  snapshot() {
    const hits = this.counters.cacheHits ?? 0;
    const misses = this.counters.cacheMisses ?? 0;
    return { counters: { ...this.counters }, cacheHitRatio: hits + misses ? hits / (hits + misses) : 0, accounts: this.accounts, upstreams: this.upstreams ?? {}, persistenceFailed: !!this.persistenceFailed };
  }

  async close() {
    clearInterval(this.timer);
    await Promise.allSettled([...this.tasks]);
    await this.flush();
    await this.logHandle?.close();
    this.logHandle = null;
  }
}
