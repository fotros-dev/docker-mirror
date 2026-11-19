import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { mockRegistry, testApp, request, imageFixture, indexFixture, dataDirectory } from '../helpers/registry.js';
import { sha256 } from '../../src/registry/validation.js';
import { mediaTypes } from '../../src/registry/manifests.js';
import { setTimeout as delay } from 'node:timers/promises';
import { networkError } from '../../src/core/errors.js';

test('single-platform Pull, HEAD, digest lookup, ranges and offline restart', async t => {
  const upstream = await mockRegistry(t);
  const image = imageFixture();
  upstream.add('library/demo', 'latest', image);
  const storage = await dataDirectory(t);
  const app = await testApp(t, upstream, {}, storage);
  const manifest = await request(app, '/v2/library/demo/manifests/latest');
  assert.equal(manifest.status, 200);
  assert.deepEqual(manifest.bytes, image.bytes);
  assert.equal(manifest.headers.get('docker-content-digest'), image.digest);
  await app.archives.waitForIdle();
  assert.equal((await app.status()).archives.complete, 1);
  const initialCount = upstream.requests.length;
  upstream.offline = true;
  const head = await request(app, '/v2/library/demo/manifests/latest', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.bytes.length, 0);
  assert.equal(head.headers.get('content-length'), String(image.bytes.length));
  assert.equal((await request(app, `/v2/library/demo/manifests/${image.digest}`)).status, 200);
  assert.equal((await request(app, '/v2/library/demo/manifests/latest', { headers: { accept: 'text/plain' } })).status, 406);
  const layer = await request(app, `/v2/library/demo/blobs/${image.layerDigest}`);
  assert.deepEqual(layer.bytes, image.layer);
  const range = await request(app, `/v2/library/demo/blobs/${image.layerDigest}`, { headers: { range: 'bytes=2-7' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), `bytes 2-7/${image.layer.length}`);
  assert.deepEqual(range.bytes, image.layer.subarray(2, 8));
  assert.equal((await request(app, `/v2/library/demo/blobs/${image.layerDigest}`, { headers: { range: 'bytes=9999-' } })).status, 416);
  assert.equal(upstream.requests.length, initialCount);
  await app.close();
  const restarted = await testApp(t, upstream, {}, storage);
  assert.equal((await request(restarted, '/v2/library/demo/manifests/latest')).status, 200);
  assert.deepEqual((await request(restarted, `/v2/library/demo/blobs/${image.layerDigest}`)).bytes, image.layer);
  assert.equal(upstream.requests.length, initialCount);
});

test('all platforms, shared blobs, nested indexes and Docker media types are archived', async t => {
  const upstream = await mockRegistry(t);
  const shared = Buffer.from('shared content');
  const amd = imageFixture({ shared });
  const arm = imageFixture({ architecture: 'arm64', shared, docker: true });
  const nested = indexFixture([arm], true);
  const root = indexFixture([amd, nested]);
  for (const image of [amd, arm, nested]) upstream.add('library/multi', null, image);
  upstream.add('library/multi', 'latest', root);
  const app = await testApp(t, upstream);
  assert.equal((await request(app, '/v2/library/multi/manifests/latest')).status, 200);
  await app.archives.waitForIdle();
  const status = await app.status();
  assert.equal(status.archives.complete, 1);
  assert.equal(status.storage.objects, 7);
  const sharedGets = upstream.requests.filter(value => value.url.endsWith(`/blobs/${sha256(shared)}`) && value.method === 'GET');
  assert.equal(sharedGets.length, 1);
  upstream.offline = true;
  assert.deepEqual((await request(app, `/v2/library/multi/manifests/${arm.digest}`)).bytes, arm.bytes);
  assert.equal((await request(app, `/v2/library/multi/blobs/${sha256(shared)}`)).status, 200);
});

test('GHCR and Quay route to one deterministic provider', async t => {
  const upstream = await mockRegistry(t);
  const image = imageFixture();
  upstream.add('owner/demo', '1.0', image);
  const app = await testApp(t, upstream);
  assert.equal((await request(app, '/v2/ghcr.io/owner/demo/manifests/1.0')).status, 200);
  assert.equal((await request(app, '/v2/quay.io/owner/demo/manifests/1.0')).status, 200);
  await app.archives.waitForIdle();
  assert.ok(app.telemetry.counters.upstream_ghcr > 0);
  assert.ok(app.telemetry.counters.upstream_quay > 0);
  assert.equal(app.telemetry.counters.upstream_dockerhub, undefined);
});

test('upstream 404, 401, 429 and temporary errors remain distinguishable', async t => {
  const upstream = await mockRegistry(t);
  const app = await testApp(t, upstream);
  assert.equal((await request(app, '/v2/library/absent/manifests/latest')).status, 404);
  upstream.failures.set('/v2/library/private/manifests/latest', 401);
  const unauthorized = await request(app, '/v2/library/private/manifests/latest');
  assert.equal(unauthorized.status, 502);
  upstream.failures.set('/v2/library/broken/manifests/latest', 503);
  const unavailable = await request(app, '/v2/library/broken/manifests/latest');
  assert.equal(unavailable.status, 503);
  upstream.failures.set('/v2/library/limited/manifests/latest', { status: 429, headers: { 'retry-after': '30' } });
  const limited = await request(app, '/v2/library/limited/manifests/latest');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '30');
  const count = upstream.requests.length;
  assert.equal((await request(app, '/v2/library/limited/manifests/latest')).status, 429);
  assert.equal(upstream.requests.length, count);
});

test('Bearer auth uses repository pull scope, caches tokens, and rejects hostile realms', async t => {
  const upstream = await mockRegistry(t);
  upstream.requireBearer = true;
  const image = imageFixture();
  upstream.add('library/authenticated', 'latest', image);
  const app = await testApp(t, upstream);
  assert.equal((await request(app, '/v2/library/authenticated/manifests/latest')).status, 200);
  await app.archives.waitForIdle();
  const tokenRequests = upstream.requests.filter(value => value.url.startsWith('/token?'));
  assert.equal(tokenRequests.length, 1);
  assert.equal(new URL(tokenRequests[0].url, upstream.origin).searchParams.get('scope'), 'repository:library/authenticated:pull');
  upstream.maliciousRealm = 'http://169.254.169.254/token';
  const hostile = await request(app, '/v2/library/other/manifests/latest');
  assert.equal(hostile.status, 502);
  assert.equal(upstream.requests.filter(value => value.url.startsWith('/token?')).length, 1);
});

test('sync switches complete versions atomically and preserves historical digests', async t => {
  const upstream = await mockRegistry(t);
  const first = imageFixture({ label: 'first' });
  const second = imageFixture({ label: 'second' });
  upstream.add('library/versioned', 'latest', first);
  const app = await testApp(t, upstream);
  await request(app, '/v2/library/versioned/manifests/latest');
  await app.archives.waitForIdle();
  upstream.add('library/versioned', 'latest', second);
  upstream.failures.set(`/v2/library/versioned/blobs/${second.layerDigest}`, 503);
  await app.sync.run();
  await app.archives.waitForIdle();
  assert.equal((await request(app, '/v2/library/versioned/manifests/latest')).headers.get('docker-content-digest'), first.digest);
  assert.equal((await app.status()).archives.partial, 1);
  upstream.failures.clear();
  const failed = [...app.archives.jobs.values()].find(job => job.digest === second.digest);
  await app.archives.enqueue(failed.route, failed.digest, 'latest', true);
  await app.archives.waitForIdle();
  const current = await request(app, '/v2/library/versioned/manifests/latest');
  assert.equal(current.headers.get('docker-content-digest'), second.digest);
  upstream.offline = true;
  assert.deepEqual((await request(app, `/v2/library/versioned/manifests/${first.digest}`)).bytes, first.bytes);
  assert.deepEqual((await request(app, `/v2/library/versioned/blobs/${first.layerDigest}`)).bytes, first.layer);
  const record = await app.store.get('repos', 'library/versioned');
  assert.equal(record.tags.latest.history.length, 2);
  upstream.offline = false;
  const before = upstream.requests.length;
  assert.equal((await app.sync.run())[0].state, 'unchanged');
  assert.equal(upstream.requests.length, before + 1);
});

test('concurrent requests deduplicate downloads and cannot serve incomplete bytes', async t => {
  const upstream = await mockRegistry(t);
  const image = imageFixture();
  upstream.add('library/concurrent', 'latest', image);
  upstream.delayMs = 10;
  const app = await testApp(t, upstream);
  const roots = await Promise.all(Array.from({ length: 10 }, () => request(app, '/v2/library/concurrent/manifests/latest')));
  assert.ok(roots.every(root => root.status === 200));
  const blobs = await Promise.all(Array.from({ length: 12 }, () => request(app, `/v2/library/concurrent/blobs/${image.layerDigest}`)));
  assert.ok(blobs.every(blob => blob.bytes.equals(image.layer)));
  await app.archives.waitForIdle();
  assert.equal(upstream.requests.filter(value => value.method === 'GET' && value.url.endsWith(`/blobs/${image.layerDigest}`)).length, 1);
  assert.equal((await app.status()).archives.complete, 1);
});

test('interrupted downloads resume after restart and pending archives recover', async t => {
  const upstream = await mockRegistry(t);
  const image = imageFixture({ shared: Buffer.alloc(100000, 42) });
  upstream.add('library/resume', 'latest', image);
  upstream.interrupt.add(image.layerDigest);
  const storage = await dataDirectory(t);
  const app = await testApp(t, upstream, {}, storage);
  await request(app, '/v2/library/resume/manifests/latest');
  await app.archives.waitForIdle();
  assert.equal((await app.status()).archives.partial, 1);
  const partial = app.store.path('downloads', `${image.layerDigest.slice(7)}.part`);
  assert.equal((await fs.stat(partial)).size, 50000);
  const job = [...app.archives.jobs.values()][0];
  await app.store.set('jobs', job.id, { ...job, state: 'downloading', nextAttempt: 0 });
  await app.close();
  const restarted = await testApp(t, upstream, {}, storage);
  await restarted.archives.waitForIdle();
  assert.equal((await restarted.status()).archives.complete, 1);
  assert.ok(upstream.requests.some(value => value.url.endsWith(image.layerDigest) && value.headers.range === 'bytes=50000-'));
  assert.equal((await restarted.verify()).ok, true);
});

test('corrupt manifests and incorrect descriptor sizes never become complete', async t => {
  const upstream = await mockRegistry(t);
  const image = imageFixture();
  const badValue = { ...image.value, layers: [{ ...image.value.layers[0], size: image.layer.length + 1 }] };
  const bytes = Buffer.from(JSON.stringify(badValue));
  upstream.add('library/badsize', 'latest', { ...image, value: badValue, bytes, digest: sha256(bytes) });
  const app = await testApp(t, upstream);
  assert.equal((await request(app, '/v2/library/badsize/manifests/latest')).status, 200);
  await app.archives.waitForIdle();
  assert.equal((await app.status()).archives.complete, 0);
  upstream.manifests.set(`library/badsize@${image.digest}`, Buffer.from('broken bytes'));
  assert.equal((await request(app, `/v2/library/badsize/manifests/${image.digest}`)).status, 502);
});

test('on-disk corruption is detected and verification marks affected archives', async t => {
  const upstream = await mockRegistry(t);
  const image = imageFixture();
  upstream.add('library/corrupt', 'latest', image);
  const app = await testApp(t, upstream);
  await request(app, '/v2/library/corrupt/manifests/latest');
  await app.archives.waitForIdle();
  const path = app.store.contentPath(image.layerDigest);
  await fs.chmod(path, 0o600);
  await fs.writeFile(path, 'corrupted');
  const result = await app.verify();
  assert.equal(result.ok, false);
  assert.equal((await app.status()).archives.corrupted, 1);
  const repaired = await request(app, `/v2/library/corrupt/blobs/${image.layerDigest}`);
  assert.equal(repaired.status, 200);
  assert.deepEqual(repaired.bytes, image.layer);
});

test('unsupported index descriptors are recorded as partial; artifact platforms are classified', async t => {
  const upstream = await mockRegistry(t);
  const image = imageFixture();
  const root = indexFixture([image]);
  root.value.manifests[0].platform = { os: 'unknown', architecture: 'unknown' };
  root.value.manifests.push({ mediaType: 'application/vnd.example.future', digest: sha256('future'), size: 6 });
  root.bytes = Buffer.from(JSON.stringify(root.value));
  root.digest = sha256(root.bytes);
  upstream.add('library/artifacts', null, image);
  upstream.add('library/artifacts', 'latest', root);
  const app = await testApp(t, upstream);
  await request(app, '/v2/library/artifacts/manifests/latest');
  await app.archives.waitForIdle();
  const job = [...app.archives.jobs.values()][0];
  assert.equal(job.state, 'partial');
  assert.equal(job.limitations[0].reason, 'UNSUPPORTED_DESCRIPTOR');
  assert.equal(job.platforms[0].kind, 'artifact');
});

test('missing child manifests and excessively nested indexes remain incomplete', async t => {
  const upstream = await mockRegistry(t);
  const image = imageFixture();
  const missing = indexFixture([image]);
  upstream.add('library/missing', 'latest', missing);
  const app = await testApp(t, upstream, { maxDepth: 2 });
  await request(app, '/v2/library/missing/manifests/latest');
  let child = image;
  upstream.add('library/deep', null, image);
  for (let index = 0; index < 4; index++) {
    child = indexFixture([child]);
    upstream.add('library/deep', index === 3 ? 'latest' : null, child);
  }
  await request(app, '/v2/library/deep/manifests/latest');
  await app.archives.waitForIdle();
  assert.equal((await app.status()).archives.complete, 0);
  assert.ok([...app.archives.jobs.values()].some(job => job.error?.code === 'MANIFEST_INVALID'));
});

test('reserved JavaScript property names are safe, valid tags', async t => {
  const upstream = await mockRegistry(t);
  const image = imageFixture();
  for (const tag of ['__proto__', 'constructor', 'toString']) upstream.add('library/properties', tag, image);
  const app = await testApp(t, upstream);
  for (const tag of ['__proto__', 'constructor', 'toString']) assert.equal((await request(app, `/v2/library/properties/manifests/${tag}`)).status, 200);
  await app.archives.waitForIdle();
  const record = await app.store.get('repos', 'library/properties');
  for (const tag of ['__proto__', 'constructor', 'toString']) assert.equal(record.tags[tag].current, image.digest);
  assert.equal({}.pending, undefined);
});

test('periodic synchronization runs without a manual sync command', async t => {
  const upstream = await mockRegistry(t);
  const first = imageFixture({ label: 'scheduled-first' });
  const second = imageFixture({ label: 'scheduled-second' });
  upstream.add('library/scheduled', 'latest', first);
  const app = await testApp(t, upstream);
  await request(app, '/v2/library/scheduled/manifests/latest');
  await app.archives.waitForIdle();
  upstream.add('library/scheduled', 'latest', second);
  app.config.syncEnabled = true;
  app.config.syncIntervalMs = 100;
  app.sync.start();
  let current;
  for (let count = 0; count < 300; count++) {
    current = (await app.store.get('repos', 'library/scheduled')).tags.latest.current;
    if (current === second.digest) break;
    await delay(20);
  }
  assert.equal(current, second.digest);
});

test('external descriptor URLs are never fetched and missing external content stays partial', async t => {
  const upstream = await mockRegistry(t);
  const image = imageFixture();
  image.value.layers[0].urls = ['http://169.254.169.254/latest/meta-data/'];
  image.bytes = Buffer.from(JSON.stringify(image.value));
  image.digest = sha256(image.bytes);
  upstream.add('library/external', 'latest', image);
  upstream.blobs.delete(`library/external@${image.layerDigest}`);
  const app = await testApp(t, upstream);
  await request(app, '/v2/library/external/manifests/latest');
  await app.archives.waitForIdle();
  const job = [...app.archives.jobs.values()][0];
  assert.equal(job.state, 'partial');
  assert.equal(job.limitations[0].reason, 'EXTERNAL_CONTENT_UNAVAILABLE');
  assert.equal(upstream.requests.some(value => value.url.includes('meta-data')), false);
});

test('suspected broad outage returns 503 while completed archives and confirmed 404 remain correct', async t => {
  const upstream = await mockRegistry(t);
  const image = imageFixture();
  upstream.add('library/available', 'latest', image);
  const app = await testApp(t, upstream, { connectivityEnabled: true });
  await request(app, '/v2/library/available/manifests/latest');
  await app.archives.waitForIdle();
  assert.equal((await request(app, '/v2/library/absent/manifests/latest')).status, 404);
  app.connectivity.destinations = ['https://one.invalid/', 'https://two.invalid/', 'https://three.invalid/'];
  app.transport.request = async () => { throw networkError({ code: 'ENOTFOUND' }); };
  const failure = await request(app, '/v2/library/network-failure/manifests/latest');
  assert.equal(failure.status, 503);
  assert.equal(failure.json().errors[0].detail.reason, 'INTERNATIONAL_CONNECTIVITY_DISRUPTION');
  const cached = await request(app, '/v2/library/available/manifests/latest');
  assert.equal(cached.status, 200);
});
