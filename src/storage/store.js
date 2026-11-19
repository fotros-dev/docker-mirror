import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { resolve, dirname, join, relative } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { KeyedMutex } from '../core/concurrency.js';
import { digest, sha256, keyHash } from '../registry/validation.js';
import { RegistryError } from '../core/errors.js';

const noFollow = constants.O_NOFOLLOW;

export class Store {
  constructor(root) {
    this.root = resolve(root);
    this.mutex = new KeyedMutex();
    this.documents = new Map();
    this.verified = new Map();
    this.recoveries = [];
    this.owner = randomUUID();
  }

  async directory(path) {
    const absolute = resolve(path);
    const parts = absolute.split('/').filter(Boolean);
    let current = '/';
    for (const part of parts) {
      current = join(current, part);
      try { await fs.mkdir(current, { mode: 0o700 }); await this.syncDirectory(dirname(current)); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Storage directory contains a symlink or non-directory.');
    }
    if (absolute === this.root || absolute.startsWith(`${this.root}/`)) await fs.chmod(absolute, 0o700);
  }

  path(...parts) {
    const path = resolve(this.root, ...parts);
    if (relative(this.root, path).startsWith('..') || path === this.root) throw new Error('Unsafe storage path.');
    return path;
  }

  async open(path, flags = constants.O_RDONLY, mode = 0o600) {
    if (!resolve(path).startsWith(`${this.root}/`)) throw new Error('Unsafe storage path.');
    let parent = dirname(path);
    while (parent.startsWith(this.root)) {
      const stat = await fs.lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe storage directory.');
      if (parent === this.root) break;
      parent = dirname(parent);
    }
    const handle = await fs.open(path, flags | noFollow, mode);
    if (!(await handle.stat()).isFile()) {
      await handle.close();
      throw new Error('Unsafe storage file.');
    }
    return handle;
  }

  async syncDirectory(path) {
    const handle = await fs.open(path, constants.O_RDONLY | noFollow | constants.O_DIRECTORY);
    try { await handle.sync(); } finally { await handle.close(); }
  }

  async read(path, limit = 64 * 1024 ** 2) {
    const handle = await this.open(path);
    try {
      if ((await handle.stat()).size > limit) throw new Error('Storage metadata exceeds its safety limit.');
      return await handle.readFile();
    } finally { await handle.close(); }
  }

  async immutable(path, bytes) {
    await this.directory(dirname(path));
    const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
    const handle = await this.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    try { await fs.link(temporary, path); await this.syncDirectory(dirname(path)); }
    finally { await fs.unlink(temporary); }
  }

  async initialize() {
    await this.directory(this.root);
    for (const name of ['state', 'content/sha256', 'downloads', 'uploads', 'quarantine', 'logs']) await this.directory(this.path(name));
    await this.acquireLock();
    try {
      const schema = await this.get('system', 'schema');
      if (schema && schema.version !== 1) throw new Error('Unsupported storage schema version.');
      if (!schema) await this.set('system', 'schema', { version: 1 });
    } catch (error) { await this.close(); throw error; }
  }

  async acquireLock() {
    const lock = this.path('owner.json');
    const claim = async () => {
      const handle = await this.open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), owner: this.owner })); await handle.sync(); }
      finally { await handle.close(); }
      await this.syncDirectory(this.root);
      this.locked = true;
    };
    try { await claim(); return; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const recovery = this.path('owner-recovery');
    try { await fs.mkdir(recovery, { mode: 0o700 }); }
    catch { throw new Error('Storage is already owned or lock recovery is active.'); }
    try {
      let owner;
      try { owner = JSON.parse(await this.read(lock, 4096)); }
      catch { throw new Error('Storage lock is invalid. Inspect owner.json while all servers are stopped.'); }
      if (owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error('Storage is owned by another host or has an invalid lock.');
      let alive = true;
      try { process.kill(owner.pid, 0); }
      catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('Storage is already in use by a running process.');
      await fs.unlink(lock);
      await claim();
    } finally { await fs.rmdir(recovery); }
  }

  documentDirectory(kind, key) {
    if (!/^[a-z]+$/.test(kind)) throw new Error('Invalid metadata kind.');
    return this.path('state', kind, keyHash(key));
  }

  revisionNames(entries) {
    return [...new Set(entries.filter(name => /^\d{16}-[a-f0-9]{64}\.json(?:\.copy)?$/.test(name)).map(name => name.replace(/\.copy$/, '')))].sort().reverse();
  }

  async readRevision(directory, name) {
    let failure;
    for (const suffix of ['', '.copy']) {
      try {
        const bytes = await this.read(join(directory, `${name}${suffix}`));
        if (sha256(bytes).slice(7) !== name.slice(17, 81)) throw new Error('Metadata checksum mismatch.');
        if (suffix) this.recoveries.push({ kind: 'replica', revision: Number(name.slice(0, 16)) });
        return bytes;
      } catch (error) {
        if (error.code === 'ELOOP') throw error;
        failure = error;
      }
    }
    throw failure;
  }

  async load(kind, key) {
    const id = `${kind}:${key}`;
    if (this.documents.has(id)) return this.documents.get(id);
    const directory = this.documentDirectory(kind, key);
    let entries;
    try { entries = await fs.readdir(directory); }
    catch (error) { if (error.code === 'ENOENT') return { revision: 0, value: null }; throw error; }
    const revisions = this.revisionNames(entries);
    let maximum = 0;
    for (const name of revisions) {
      maximum = Math.max(maximum, Number(name.slice(0, 16)));
      try {
        const bytes = await this.readRevision(directory, name);
        const record = JSON.parse(bytes);
        if (record.kind !== kind || record.key !== key || record.revision !== Number(name.slice(0, 16))) throw new Error('Metadata identity mismatch.');
        const loaded = { revision: maximum, value: record.value };
        this.documents.set(id, loaded);
        return loaded;
      } catch (error) {
        if (error.code === 'ELOOP') throw error;
        this.recoveries.push({ kind, key, revision: Number(name.slice(0, 16)) });
        if (kind === 'system' && key === 'users') throw new Error('User metadata is corrupted. Restore it from a trusted backup before enabling authentication.');
      }
    }
    if (revisions.length) throw new Error('No valid metadata revision remains; restore from backup.');
    return { revision: 0, value: null };
  }

  async get(kind, key) {
    return structuredClone((await this.load(kind, key)).value);
  }

  async update(kind, key, operation) {
    return this.mutex.run(`${kind}:${key}`, async () => {
      const previous = await this.load(kind, key);
      const value = await operation(structuredClone(previous.value));
      const revision = previous.revision + 1;
      const bytes = Buffer.from(JSON.stringify({ kind, key, revision, value }));
      if (bytes.length > 64 * 1024 ** 2) throw new Error('Metadata record exceeds its safety limit.');
      const filename = `${String(revision).padStart(16, '0')}-${sha256(bytes).slice(7)}.json`;
      try {
        await this.immutable(join(this.documentDirectory(kind, key), `${filename}.copy`), bytes);
        await this.immutable(join(this.documentDirectory(kind, key), filename), bytes);
      } catch (error) {
        this.documents.delete(`${kind}:${key}`);
        throw error;
      }
      this.documents.set(`${kind}:${key}`, { revision, value: structuredClone(value) });
      return structuredClone(value);
    });
  }

  set(kind, key, value) { return this.update(kind, key, () => value); }

  async list(kind) {
    const base = this.path('state', kind);
    let entries;
    try { entries = await fs.readdir(base); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const values = [];
    for (const entry of entries) {
      if (!/^[a-f0-9]{64}$/.test(entry)) continue;
      const directory = join(base, entry);
      if (!(await fs.lstat(directory)).isDirectory()) throw new Error('Unsafe metadata directory.');
      const files = this.revisionNames(await fs.readdir(directory));
      let key;
      for (const file of files) {
        try {
          const bytes = await this.readRevision(directory, file);
          const record = JSON.parse(bytes);
          if (record.kind === kind && typeof record.key === 'string' && keyHash(record.key) === entry) { key = record.key; break; }
        } catch (error) { if (error.code === 'ELOOP') throw error; }
      }
      if (key === undefined && files.length) throw new Error('Metadata directory is unrecoverable.');
      if (key !== undefined) {
        const value = await this.get(kind, key);
        if (value !== null) values.push(value);
      }
    }
    return values;
  }

  contentPath(value) {
    return this.path('content', 'sha256', digest(value).slice(7));
  }

  async hashFile(handle) {
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk);
    return `sha256:${hash.digest('hex')}`;
  }

  async content(value, expectedSize) {
    const path = this.contentPath(value);
    let handle;
    try { handle = await this.open(path); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    try {
      const stat = await handle.stat({ bigint: true });
      const signature = `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      if (this.verified.get(value) !== signature) {
        if (await this.hashFile(handle) !== value) throw new RegistryError(503, 'BLOB_UNKNOWN', 'Stored content failed digest verification.', { reason: 'CONTENT_CORRUPTED', digest: value });
        this.verified.set(value, signature);
      }
      if (expectedSize !== undefined && BigInt(expectedSize) !== stat.size) throw new RegistryError(502, 'SIZE_INVALID', 'Content size does not match its descriptor.');
      return { path, size: Number(stat.size) };
    } finally { await handle.close(); }
  }

  async commitFile(path, value, expectedSize) {
    const handle = await this.open(path);
    try {
      if (await this.hashFile(handle) !== digest(value)) throw new RegistryError(400, 'DIGEST_INVALID', 'Content digest verification failed.');
      if (expectedSize !== undefined && (await handle.stat()).size !== expectedSize) throw new RegistryError(502, 'SIZE_INVALID', 'Content size does not match its descriptor.');
      await handle.sync();
      await handle.chmod(0o400);
    } finally { await handle.close(); }
    const target = this.contentPath(value);
    try { await fs.link(path, target); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { await this.content(value, expectedSize); }
      catch (failure) {
        if (failure.detail?.reason !== 'CONTENT_CORRUPTED') throw failure;
        await fs.rename(target, this.path('quarantine', `${value.slice(7)}-${randomUUID()}`));
        this.verified.delete(value);
        await fs.link(path, target);
      }
    }
    await this.syncDirectory(dirname(target));
    await fs.unlink(path);
    return this.content(value, expectedSize);
  }

  async put(bytes, expected = sha256(bytes)) {
    if (sha256(bytes) !== digest(expected)) throw new RegistryError(502, 'DIGEST_INVALID', 'Upstream manifest digest mismatch.');
    const path = this.path('downloads', `${randomUUID()}.tmp`);
    const handle = await this.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
    try { await this.commitFile(path, expected, bytes.length); }
    catch (error) { await fs.unlink(path).catch(() => {}); throw error; }
    return expected;
  }

  async contentBytes(value, limit) {
    const content = await this.content(value);
    if (!content) throw new RegistryError(503, 'MANIFEST_UNKNOWN', 'Archived content is missing.');
    return this.read(content.path, limit);
  }

  async usage() {
    let bytes = 0;
    let objects = 0;
    for (const file of await fs.readdir(this.path('content', 'sha256'))) {
      if (!/^[a-f0-9]{64}$/.test(file)) continue;
      const stat = await fs.lstat(this.path('content', 'sha256', file));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe content file.');
      bytes += stat.size;
      objects++;
    }
    return { bytes, objects };
  }

  async close() {
    if (!this.locked) return;
    const path = this.path('owner.json');
    const owner = JSON.parse(await this.read(path, 4096));
    if (owner.owner !== this.owner) throw new Error('Storage ownership changed unexpectedly.');
    await fs.unlink(path);
    await this.syncDirectory(this.root);
    this.locked = false;
  }
}
