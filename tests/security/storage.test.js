import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { Store } from '../../src/storage/store.js';
import { dataDirectory, testApp, trackStorage } from '../helpers/registry.js';
import { sha256 } from '../../src/registry/validation.js';

test('immutable content deduplication, metadata revisions, recovery and ownership lock', async t => {
  const path = await dataDirectory(t);
  const store = trackStorage(path, new Store(path));
  await store.initialize();
  t.after(() => store.close());
  const bytes = Buffer.from('test content');
  await Promise.all([store.put(bytes), store.put(bytes)]);
  assert.equal((await store.usage()).objects, 1);
  await store.set('example', 'key', { value: 1 });
  await store.set('example', 'key', { value: 2 });
  const directory = store.documentDirectory('example', 'key');
  const files = (await fs.readdir(directory)).filter(file => file.endsWith('.json')).sort();
  await fs.writeFile(join(directory, files.at(-1)), 'damaged');
  await assert.rejects(new Store(path).initialize(), /already in use/);
  await store.close();
  const recovered = trackStorage(path, new Store(path));
  await recovered.initialize();
  t.after(() => recovered.close());
  assert.deepEqual(await recovered.get('example', 'key'), { value: 2 });
  assert.equal(recovered.recoveries.length, 1);
  await recovered.set('example', 'key', { value: 3 });
  assert.deepEqual(await recovered.get('example', 'key'), { value: 3 });
});

test('symlinks in content, metadata and data directories cannot escape storage', async t => {
  const path = await dataDirectory(t);
  const outside = await dataDirectory(t);
  await fs.writeFile(join(outside, 'secret'), 'secret');
  const store = trackStorage(path, new Store(path));
  await store.initialize();
  t.after(() => store.close());
  await fs.symlink(join(outside, 'secret'), store.contentPath(sha256('secret')));
  await assert.rejects(store.content(sha256('secret')));
  await fs.symlink(outside, store.path('state', 'evil'));
  await assert.rejects(store.set('evil', 'key', { value: 1 }));
  const linked = join(outside, 'linked');
  await fs.symlink(path, linked);
  await assert.rejects(new Store(linked).initialize(), /symlink/);
  assert.equal(await fs.readFile(join(outside, 'secret'), 'utf8'), 'secret');
});

test('encoded traversal, malicious request targets and conflicting HTTP framing are rejected', async t => {
  const app = await testApp(t);
  const paths = ['/v2/a/%2e%2e/manifests/latest', '/v2/a/%252e%252e/manifests/latest', '/v2/a//b/manifests/latest', '/v2/../etc/manifests/latest', '/v2/a\\b/manifests/latest', '/v2/a/blobs/sha256:../../etc'];
  for (const path of paths) {
    const status = await new Promise((resolve, reject) => {
      const request = http.get(`${app.origin}`, { path }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject);
    });
    assert.equal(status, 400, path);
  }
  for (const framing of ['Content-Length: 4\r\nTransfer-Encoding: chunked', 'Content-Length: 4\r\nContent-Length: 5']) {
    const received = await new Promise((resolve, reject) => {
      const socket = net.connect(app.server.address().port, '127.0.0.1');
      let output = '';
      socket.on('connect', () => socket.write(`POST /v2/local/team/api/blobs/uploads/ HTTP/1.1\r\nHost: localhost\r\n${framing}\r\n\r\n0\r\n\r\n`));
      socket.on('data', bytes => { output += bytes; });
      socket.on('end', () => resolve(output));
      socket.on('error', reject);
    });
    assert.match(received, /^HTTP\/1.1 400/);
  }
});

test('corrupted user metadata never restores a revoked account from an older revision', async t => {
  const path = await dataDirectory(t);
  const store = trackStorage(path, new Store(path));
  await store.initialize();
  await store.set('system', 'users', [{ username: 'revoked' }]);
  await store.set('system', 'users', []);
  const directory = store.documentDirectory('system', 'users');
  const files = (await fs.readdir(directory)).filter(file => file.endsWith('.json')).sort();
  await fs.writeFile(join(directory, files.at(-1)), 'corrupted');
  await fs.writeFile(join(directory, `${files.at(-1)}.copy`), 'corrupted');
  await store.close();
  const restarted = trackStorage(path, new Store(path));
  await restarted.initialize();
  await assert.rejects(restarted.get('system', 'users'), /User metadata is corrupted/);
});

test('a failed primary write after replica commit cannot create divergent acknowledged revisions', async t => {
  const path = await dataDirectory(t);
  const store = trackStorage(path, new Store(path));
  await store.initialize();
  await store.set('example', 'uncertain', { value: 1 });
  const original = store.immutable.bind(store);
  store.immutable = async (target, bytes) => {
    if (target.endsWith('.json')) throw Object.assign(new Error('Disk full after replica publication'), { code: 'ENOSPC' });
    return original(target, bytes);
  };
  await assert.rejects(store.set('example', 'uncertain', { value: 2 }), { code: 'ENOSPC' });
  store.immutable = original;
  assert.deepEqual(await store.get('example', 'uncertain'), { value: 2 });
  await store.set('example', 'uncertain', { value: 3 });
  await store.close();
  const restarted = trackStorage(path, new Store(path));
  await restarted.initialize();
  assert.deepEqual(await restarted.get('example', 'uncertain'), { value: 3 });
});
