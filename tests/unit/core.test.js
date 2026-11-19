import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, projectRoot } from '../../src/config/config.js';
import { repository, digest, reference, routeRepository, sha256 } from '../../src/registry/validation.js';
import { parseManifest, acceptsManifest } from '../../src/registry/manifests.js';
import { parseRange } from '../../src/server/http.js';
import { parseChallenge, retryDelay } from '../../src/upstream/client.js';
import { passwordHash, verifyPassword, permitted } from '../../src/auth/auth.js';
import { networkError } from '../../src/core/errors.js';
import { Semaphore, SingleFlight, DownloadScheduler } from '../../src/core/concurrency.js';
import { imageFixture, indexFixture } from '../helpers/registry.js';

test('safe default configuration and root-relative storage', () => {
  const config = loadConfig({});
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 5000);
  assert.equal(config.dataDir, `${projectRoot}/data`);
  assert.equal(config.pushEnabled, false);
  assert.equal(config.syncIntervalMs, 21600000);
  assert.equal(config.providers.ghcr.enabled, true);
});

for (const env of [{ PUSH_ENABLED: 'yes' }, { PORT: 'wrong' }, { PORT: '99999' }, { SYNC_INTERVAL_MINUTES: '0' }, { DOCKER_HUB_ACCOUNTS: '[' }, { REGISTRY_USERS: '{}' }, { DATA_DIR: '../outside' }, { PUBLIC_URL: 'https://user:secret@host/' }, { PUBLIC_URL: 'https://host/path' }, { PUSH_ENABLED: 'true', HOST: '0.0.0.0', PUBLIC_URL: 'https://registry.example' }, { PUSH_ENABLED: 'true', PUBLIC_URL: 'http://example.com' }, { DOCKER_HUB_ENABLED: '1' }]) {
  test(`configuration fails closed: ${Object.keys(env).join(',')}`, () => assert.throws(() => loadConfig(env)));
}

test('credential arrays are not fixed to four accounts', () => {
  const accounts = Array.from({ length: 7 }, (_, index) => ({ username: `account${index}`, token: 'secret' }));
  assert.equal(loadConfig({ DOCKER_HUB_ACCOUNTS: JSON.stringify(accounts) }).accounts.length, 7);
  assert.throws(() => loadConfig({ DOCKER_HUB_ACCOUNTS: JSON.stringify([accounts[0], accounts[0]]) }));
});

test('deterministic routing and official image normalization', () => {
  const providers = loadConfig({}).providers;
  assert.deepEqual(routeRepository('nginx', providers), { name: 'library/nginx', remote: 'library/nginx', provider: 'dockerhub' });
  assert.equal(routeRepository('example/image', providers).remote, 'example/image');
  assert.equal(routeRepository('ghcr.io/owner/image', providers).provider, 'ghcr');
  assert.equal(routeRepository('quay.io/owner/image', providers).remote, 'owner/image');
  assert.equal(routeRepository('local/team/image', providers).provider, 'local');
  assert.throws(() => routeRepository('local', providers));
  assert.throws(() => routeRepository('ghcr.io/x/y', { ghcr: { enabled: false } }));
});

for (const value of ['../etc', 'a/../../secret', 'A/image', 'a//b', 'a/%2e%2e', 'a\\b', '/abs', 'a/'.repeat(200)]) {
  test(`malicious repository ${value.slice(0, 30)}`, () => assert.throws(() => repository(value)));
}

test('canonical digest and reference validation', () => {
  assert.equal(digest(sha256('test')), sha256('test'));
  for (const value of ['sha256:../etc', 'sha512:abcd', 'sha256:ABC', 'file:///etc/passwd']) assert.throws(() => digest(value));
  assert.equal(reference('17-alpine'), '17-alpine');
  assert.throws(() => reference('bad tag'));
});

test('manifest bytes, descriptors, Docker types and indexes', () => {
  const image = imageFixture();
  assert.equal(parseManifest(image.bytes, image.value.mediaType).descriptors.length, 2);
  assert.equal(parseManifest(indexFixture([image]).bytes).index, true);
  const docker = imageFixture({ docker: true });
  assert.equal(parseManifest(docker.bytes).artifact, false);
  assert.throws(() => parseManifest(Buffer.from('{')));
  assert.throws(() => parseManifest(Buffer.from(JSON.stringify({ ...image.value, schemaVersion: 1 }))));
  assert.throws(() => parseManifest(image.bytes, 'application/octet-stream'));
  assert.throws(() => parseManifest(Buffer.from(JSON.stringify({ ...image.value, layers: [{ ...image.value.layers[0], size: -1 }] }))));
  assert.throws(() => parseManifest(image.bytes, undefined, { maxManifestBytes: 1 }));
});

test('accept negotiation respects explicit q=0 over wildcard', () => {
  assert.equal(acceptsManifest('application/json;q=0,*/*', 'application/json'), false);
  assert.equal(acceptsManifest('application/*;q=0.5', 'application/json'), true);
  assert.equal(acceptsManifest('text/plain', 'application/json'), false);
});

test('byte range semantics including suffix, clamping and rejection', () => {
  assert.deepEqual(parseRange('bytes=1-4', 10), { start: 1, end: 4 });
  assert.deepEqual(parseRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange('bytes=8-', 10), { start: 8, end: 9 });
  assert.deepEqual(parseRange('bytes=8-99', 10), { start: 8, end: 9 });
  for (const value of ['bytes=-0', 'bytes=10-', 'bytes=5-3', 'bytes=0-1,3-4', 'bytes=-', 'x=1-2']) assert.throws(() => parseRange(value, 10), { status: 416 });
  assert.throws(() => parseRange('bytes=0-0', 0), { status: 416 });
});

test('Bearer challenge parsing and retry-after', () => {
  assert.equal(parseChallenge('Bearer realm="https://auth.example/token",service="registry"').service, 'registry');
  assert.throws(() => parseChallenge('Bearer realm="a",realm="b"'));
  assert.throws(() => parseChallenge('Basic realm="a"'));
  assert.equal(retryDelay('120'), 120000);
  assert.equal(retryDelay('invalid'), 60000);
});

test('scrypt authentication and repository-specific read/write authorization', async () => {
  const encoded = await passwordHash('a sufficiently long password');
  assert.equal(await verifyPassword('a sufficiently long password', encoded), true);
  assert.equal(await verifyPassword('wrong', encoded), false);
  const user = { permissions: [{ repository: 'local/team/*', actions: ['pull'] }] };
  assert.equal(permitted(user, 'local/team/api', 'pull'), true);
  assert.equal(permitted(user, 'local/team/api', 'push'), false);
  assert.equal(permitted(user, 'local/team-other/api', 'pull'), false);
});

test('network errors are distinct from confirmed not-found', () => {
  assert.equal(networkError({ code: 'ENOTFOUND' }).detail.reason, 'DNS_FAILURE');
  assert.equal(networkError({ code: 'ETIMEDOUT' }).status, 503);
  assert.equal(networkError({ code: 'ECONNRESET' }).detail.reason, 'CONNECTION_FAILURE');
});

test('single flight and concurrency limits coordinate work', async () => {
  const flight = new SingleFlight();
  let calls = 0;
  const run = () => flight.run('one', async () => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return 42; });
  assert.deepEqual(await Promise.all([run(), run(), run()]), [42, 42, 42]);
  assert.equal(calls, 1);
  const semaphore = new Semaphore(2);
  let active = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 8 }, () => semaphore.run(async () => { peak = Math.max(peak, ++active); await new Promise(resolve => setTimeout(resolve, 5)); active--; })));
  assert.equal(peak, 2);
});

test('upstream phase timeouts, retry limits and the legacy idle timeout are configurable and bounded', () => {
  const config = loadConfig({});
  assert.equal(config.connectTimeoutMs, 5000);
  assert.equal(config.headerTimeoutMs, 10000);
  assert.equal(config.headerBudgetMs, 25000);
  assert.equal(config.idleTimeoutMs, 120000);
  assert.equal(config.upstreamRetries, 2);
  assert.equal(config.retryBackoffMs, 250);
  assert.equal(config.foregroundDownloads, 2);
  assert.equal(loadConfig({ UPSTREAM_TIMEOUT_SECONDS: '321' }).idleTimeoutMs, 321000);
  assert.equal(loadConfig({ UPSTREAM_TIMEOUT_SECONDS: '321', UPSTREAM_IDLE_TIMEOUT_SECONDS: '45' }).idleTimeoutMs, 45000);
  assert.equal(loadConfig({ UPSTREAM_RETRIES: '0' }).upstreamRetries, 0);
  for (const env of [{ UPSTREAM_RETRIES: '6' }, { UPSTREAM_HEADER_TIMEOUT_SECONDS: '0' }, { UPSTREAM_CONNECT_TIMEOUT_SECONDS: '61' }, { UPSTREAM_IDLE_TIMEOUT_SECONDS: '0' }, { UPSTREAM_HEADER_BUDGET_SECONDS: '121' }, { FOREGROUND_DOWNLOAD_CONCURRENCY: '0' }, { UPSTREAM_RETRY_BACKOFF_MS: '0' }]) assert.throws(() => loadConfig(env));
});


test('a full background queue cannot consume foreground scheduling capacity', async () => {
  const scheduler = new DownloadScheduler(1, 1, 1);
  const gate = Promise.withResolvers();
  const active = scheduler.run('active', () => gate.promise);
  const queued = scheduler.run('queued', async () => 'queued');
  await assert.rejects(scheduler.run('overflow', async () => {}), { code: 'EBUSY' });
  assert.equal(await scheduler.run('foreground', async () => 'served', true), 'served');
  gate.resolve();
  await Promise.all([active, queued]);
});
