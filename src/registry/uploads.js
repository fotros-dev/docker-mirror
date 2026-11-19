import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { KeyedMutex } from '../core/concurrency.js';
import { RegistryError } from '../core/errors.js';
import { digest } from './validation.js';

export class Uploads {
  constructor(config, store, repositories, telemetry) {
    Object.assign(this, { config, store, repositories, telemetry });
    this.mutex = new KeyedMutex();
  }

  path(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new RegistryError(404, 'BLOB_UPLOAD_UNKNOWN', 'Unknown upload session.');
    return this.store.path('uploads', `${id}.part`);
  }

  location(route, id) { return `/v2/${route.name}/blobs/uploads/${id}`; }

  headers(route, session) {
    return { location: this.location(route, session.id), 'docker-upload-uuid': session.id, range: `0-${Math.max(0, session.offset - 1)}`, 'content-length': '0' };
  }

  async start(route, user) {
    const id = randomUUID();
    const file = await this.store.open(this.path(id), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    await file.sync();
    await file.close();
    const session = { id, repository: route.name, owner: user.username, offset: 0, state: 'active', createdAt: new Date().toISOString() };
    await this.store.set('uploads', id, session);
    this.telemetry.count('uploadStarts');
    return session;
  }

  async session(route, id, user) {
    this.path(id);
    const session = await this.store.get('uploads', id);
    if (!session || session.state !== 'active' || session.repository !== route.name || session.owner !== user.username) throw new RegistryError(404, 'BLOB_UPLOAD_UNKNOWN', 'Unknown upload session.');
    const file = await this.store.open(this.path(id), constants.O_RDWR);
    try {
      const size = (await file.stat()).size;
      if (size < session.offset) throw new RegistryError(503, 'BLOB_UPLOAD_INVALID', 'Upload state is inconsistent.');
      if (size > session.offset) { await file.truncate(session.offset); await file.sync(); }
    } finally { await file.close(); }
    return session;
  }

  async status(route, id, user) { return this.mutex.run(id, () => this.session(route, id, user)); }

  async recover() {
    for (const session of await this.store.list('uploads')) {
      if (session.state !== 'committing') continue;
      const route = { name: session.repository, provider: 'local', remote: session.repository.slice(6) };
      let content;
      let temporaryExists = true;
      try { const temporary = await this.store.open(this.path(session.id)); await temporary.close(); }
      catch (error) { if (error.code !== 'ENOENT') throw error; temporaryExists = false; }
      if (temporaryExists) {
        try { content = await this.store.commitFile(this.path(session.id), session.digest, session.offset); }
        catch (error) {
          if (error.code !== 'DIGEST_INVALID') throw error;
          session.state = 'active';
          delete session.digest;
          await this.store.set('uploads', session.id, session);
          continue;
        }
      } else content = await this.store.content(session.digest, session.offset);
      if (!content) throw new Error('Upload commit intent has neither verified content nor a temporary file.');
      await this.repositories.blob(route, session.digest, content.size);
      session.state = 'complete';
      await this.store.set('uploads', session.id, session);
      await fs.unlink(this.path(session.id)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async append(route, id, user, request, completeDigest) {
    if (completeDigest !== undefined) digest(completeDigest);
    return this.mutex.run(id, async () => {
      const session = await this.session(route, id, user);
      const offset = session.offset;
      const header = request.headers['content-range'];
      const range = header === undefined ? null : /^(?:bytes )?(\d+)-(\d+)$/.exec(header);
      if (header !== undefined && (!range || Number(range[1]) !== offset || Number(range[2]) < offset || !Number.isSafeInteger(Number(range[2])))) throw new RegistryError(416, 'BLOB_UPLOAD_INVALID', 'Upload range does not match the committed offset.', undefined, this.headers(route, session));
      const path = this.path(id);
      const file = await this.store.open(path, constants.O_RDWR);
      let position = offset;
      try {
        for await (const chunk of request) {
          if (position + chunk.length > this.config.maxBlobBytes) throw new RegistryError(413, 'SIZE_INVALID', 'Upload exceeds MAX_BLOB_BYTES.');
          let consumed = 0;
          while (consumed < chunk.length) {
            const written = await file.write(chunk, consumed, chunk.length - consumed, position);
            position += written.bytesWritten;
            consumed += written.bytesWritten;
          }
        }
        if (range && Number(range[2]) !== position - 1) throw new RegistryError(416, 'BLOB_UPLOAD_INVALID', 'Upload chunk length does not match its range.');
        await file.sync();
        session.offset = position;
        await this.store.set('uploads', id, session);
      } catch (error) {
        const committed = await this.store.get('uploads', id).catch(() => null);
        if (committed?.offset !== position || position === offset) await file.truncate(offset);
        await file.sync();
        throw error;
      } finally { await file.close(); }
      if (!completeDigest) { this.telemetry.count('uploadChunks'); return session; }
      session.state = 'committing';
      session.digest = completeDigest;
      await this.store.set('uploads', id, session);
      try { await this.store.commitFile(path, completeDigest, position); }
      catch (error) {
        if (error.code === 'DIGEST_INVALID') {
          session.state = 'active';
          delete session.digest;
          await this.store.set('uploads', id, session);
        }
        throw error;
      }
      await this.repositories.blob(route, completeDigest, position);
      session.state = 'complete';
      session.digest = completeDigest;
      await this.store.set('uploads', id, session);
      this.telemetry.count('completedUploads');
      return session;
    });
  }

  async cancel(route, id, user) {
    return this.mutex.run(id, async () => {
      const session = await this.session(route, id, user);
      session.state = 'cancelled';
      await this.store.set('uploads', id, session);
      await fs.unlink(this.path(id));
    });
  }
}
