import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import * as fs from 'node:fs/promises';
import { mockRegistry, testApp, request, imageFixture, dataDirectory, trackStorage, basic } from '../helpers/registry.js';
import { routeRepository, sha256 } from '../../src/registry/validation.js';
import { passwordHash } from '../../src/auth/auth.js';

async function childServer(t, storage, upstream, mode) {
  const child = fork(new URL('../helpers/crash-server.js', import.meta.url), [storage, upstream.origin, mode], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const closed = once(child, 'close');
  closed.catch(() => {});
  const kill = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  };
  trackStorage(storage, { close: kill });
  let error = '';
  child.stderr.on('data', bytes => { error += bytes; });
  const events = [];
  child.on('message', event => events.push(event));
  const event = async name => {
    for (let count = 0; count < 500; count++) {
      const match = events.find(value => value.event === name);
      if (match) return match;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Child exited: ${error}`);
      await delay(10);
    }
    throw new Error(`Timed out waiting for ${name}: ${error}`);
  };
  const ready = await event('ready');
  return { child, event, origin: ready.origin, kill };
}

test('SIGKILL between complete job commit and tag publication recovers without upstream', async t => {
  const upstream = await mockRegistry(t);
  const image = imageFixture();
  upstream.add('library/crash', 'latest', image);
  const storage = await dataDirectory(t);
  const child = await childServer(t, storage, upstream, 'tagcommit');
  assert.equal((await fetch(`${child.origin}/v2/library/crash/manifests/latest`)).status, 200);
  await child.event('tag_ready');
  await child.kill();
  const count = upstream.requests.length;
  upstream.offline = true;
  const app = await testApp(t, upstream, {}, storage);
  assert.equal((await request(app, '/v2/library/crash/manifests/latest')).status, 200);
  assert.equal((await app.store.get('repos', 'library/crash')).tags.latest.current, image.digest);
  assert.equal(upstream.requests.length, count);
});

test('SIGKILL during upload finalization recovers committed blob and repository permission', async t => {
  const upstream = await mockRegistry(t);
  const storage = await dataDirectory(t);
  const child = await childServer(t, storage, upstream, 'uploadcommit');
  const bytes = Buffer.from('a blob committed just before SIGKILL');
  const authorization = basic('test', 'a safe fixture password');
  const pending = fetch(`${child.origin}/v2/local/team/api/blobs/uploads/?digest=${sha256(bytes)}`, { method: 'POST', headers: { authorization }, body: bytes }).catch(() => null);
  await child.event('committed');
  await child.kill();
  await pending;
  const users = [{ username: 'test', passwordHash: await passwordHash('a safe fixture password'), permissions: [{ repository: 'local/team/*', actions: ['pull', 'push'] }] }];
  const app = await testApp(t, upstream, { pushEnabled: true, users }, storage);
  const result = await request(app, `/v2/local/team/api/blobs/${sha256(bytes)}`, { headers: { authorization } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.bytes, bytes);
  assert.equal((await request(app, `/v2/local/team/api/blobs/${sha256(bytes)}`)).status, 401);
});

test('pending tags without a job and fully received temporary blobs recover on restart', async t => {
  const upstream = await mockRegistry(t);
  const image = imageFixture();
  upstream.add('library/orphan', 'latest', image);
  const storage = await dataDirectory(t);
  const app = await testApp(t, upstream, {}, storage);
  app.archives.stopping = true;
  const route = routeRepository('library/orphan', app.config.providers);
  await app.mirror.manifest(route, 'latest');
  await app.repositories.track(route, 'latest', image.digest);
  await fs.writeFile(app.store.path('downloads', `${image.layerDigest.slice(7)}.part`), image.layer);
  await app.close();
  const restarted = await testApp(t, upstream, {}, storage);
  await restarted.archives.waitForIdle();
  assert.equal((await restarted.status()).archives.complete, 1);
  assert.equal((await request(restarted, '/v2/library/orphan/manifests/latest')).status, 200);
  assert.equal(upstream.requests.filter(value => value.url.endsWith(`/blobs/${image.layerDigest}`) && value.method === 'GET').length, 0);
});

test('transient metadata write failure preserves the last acknowledged repository revision', async t => {
  const app = await testApp(t);
  await app.store.set('example', 'transaction', { value: 'committed' });
  const original = app.store.immutable.bind(app.store);
  app.store.immutable = async () => { throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' }); };
  await assert.rejects(app.store.set('example', 'transaction', { value: 'lost' }), { code: 'ENOSPC' });
  assert.deepEqual(await app.store.get('example', 'transaction'), { value: 'committed' });
  app.store.immutable = original;
});

test('SIGKILL during an active blob stream resumes verified content after restart', async t => {
  const upstream = await mockRegistry(t);
  const image = imageFixture({ shared: Buffer.alloc(200000, 77) });
  upstream.add('library/killed', 'latest', image);
  upstream.slowStreaming.add(image.layerDigest);
  const storage = await dataDirectory(t);
  const child = await childServer(t, storage, upstream, 'download');
  assert.equal((await fetch(`${child.origin}/v2/library/killed/manifests/latest`)).status, 200);
  const partial = `${storage}/downloads/${image.layerDigest.slice(7)}.part`;
  let size = 0;
  for (let count = 0; count < 500; count++) {
    size = (await fs.stat(partial).catch(() => ({ size: 0 }))).size;
    if (size > 0) break;
    await delay(10);
  }
  assert.equal(size, 100000);
  await child.kill();
  upstream.slowStreaming.clear();
  const app = await testApp(t, upstream, {}, storage);
  await app.archives.waitForIdle();
  assert.equal((await app.status()).archives.complete, 1);
  assert.equal((await app.verify()).ok, true);
  assert.ok(upstream.requests.some(value => value.url.endsWith(image.layerDigest) && value.headers.range === 'bytes=100000-'));
});
