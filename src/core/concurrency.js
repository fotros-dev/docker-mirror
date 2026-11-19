export class KeyedMutex {
  queues = new Map();

  async run(key, operation) {
    const before = this.queues.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    this.queues.set(key, gate);
    await before;
    try {
      return await operation();
    } finally {
      release();
      if (this.queues.get(key) === gate) this.queues.delete(key);
    }
  }
}

export class Semaphore {
  constructor(limit, maxQueue = 1024) {
    this.limit = limit;
    this.maxQueue = maxQueue;
    this.active = 0;
    this.queue = [];
  }

  async run(operation) {
    if (this.active >= this.limit) {
      if (this.queue.length >= this.maxQueue) throw Object.assign(new Error('Capacity reached'), { code: 'EBUSY' });
      await new Promise(resolve => this.queue.push(resolve));
    } else this.active++;
    try {
      return await operation();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }
}

export class SingleFlight {
  pending = new Map();

  run(key, operation) {
    if (this.pending.has(key)) return this.pending.get(key);
    const work = Promise.resolve().then(operation).finally(() => this.pending.delete(key));
    this.pending.set(key, work);
    return work;
  }
}

export async function abortable(work, signal) {
  if (signal.aborted) { work.catch(() => {}); throw signal.reason; }
  let abort;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}

// Background work cannot consume the capacity reserved for interactive pulls.
export class DownloadScheduler {
  constructor(backgroundLimit, reserved = 2, maxQueue = 1024) {
    Object.assign(this, { backgroundLimit, reserved, maxQueue });
    this.active = 0;
    this.background = 0;
    this.queue = [];
  }

  run(key, operation, foreground = false) {
    if (this.queue.filter(entry => entry.foreground === foreground).length >= this.maxQueue) return Promise.reject(Object.assign(new Error('Capacity reached'), { code: 'EBUSY' }));
    return new Promise((resolve, reject) => {
      this.queue.push({ key, operation, foreground, resolve, reject });
      this.drain();
    });
  }

  promote(key) {
    const entry = this.queue.find(entry => entry.key === key);
    if (entry) { entry.foreground = true; this.drain(); }
  }

  drain() {
    while (this.active < this.backgroundLimit + this.reserved) {
      let index = this.queue.findIndex(entry => entry.foreground);
      if (index < 0 && this.background < this.backgroundLimit) index = this.queue.findIndex(entry => !entry.foreground);
      if (index < 0) return;
      const entry = this.queue.splice(index, 1)[0];
      this.active++;
      if (!entry.foreground) this.background++;
      Promise.resolve().then(entry.operation).then(entry.resolve, entry.reject).finally(() => {
        this.active--;
        if (!entry.foreground) this.background--;
        this.drain();
      });
    }
  }
}
