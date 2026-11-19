import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SafeTransport, isPublicAddress } from '../../src/network/transport.js';
import { mockRegistry, testApp, imageFixture, request } from '../helpers/registry.js';
import { readFile } from 'node:fs/promises';

for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.100.100.200', '0.0.0.0', '224.0.0.1', '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', '2001:db8::1', '2002:7f00:1::1', '2001::a00:1']) {
  test(`SSRF blocked address ${address}`, () => assert.equal(isPublicAddress(address), false));
}

test('public addresses accepted and arbitrary upstream origins rejected', async () => {
  for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicAddress(address), true);
  const transport = new SafeTransport();
  await assert.rejects(transport.destination('https://evil.example/path', ['registry.example']), { status: 502 });
  await assert.rejects(transport.destination('http://registry.example/path', ['registry.example']), { status: 502 });
  await assert.rejects(transport.destination('https://user:secret@registry.example/path', ['registry.example']), { status: 502 });
  await assert.rejects(transport.destination('https://169.254.169.254/token', ['169.254.169.254']), { status: 502 });
});

test('DNS rebinding and mixed public/private answer sets fail closed', async () => {
  let queries = 0;
  const transport = new SafeTransport({ lookup: async () => { queries++; return [{ address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }]; } });
  await assert.rejects(transport.destination('https://registry.example/', ['registry.example']), { status: 502 });
  assert.equal(queries, 1);
  const pinned = new SafeTransport({ lookup: async () => [{ address: '8.8.8.8', family: 4 }] });
  const result = await pinned.destination('https://registry.example/', ['registry.example']);
  assert.deepEqual(result.addresses, [{ address: '8.8.8.8', family: 4 }]);
});

test('redirects strip credentials across origins and reject unapproved hosts', async t => {
  let leaked;
  const destination = http.createServer((request, response) => { leaked = request.headers.authorization; response.end('content'); });
  await new Promise(resolve => destination.listen(0, '127.0.0.1', resolve));
  const origin = http.createServer((request, response) => { response.writeHead(307, { location: `http://localhost:${destination.address().port}/blob` }); response.end(); });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  t.after(async () => { origin.closeAllConnections(); destination.closeAllConnections(); await Promise.all([new Promise(resolve => origin.close(resolve)), new Promise(resolve => destination.close(resolve))]); });
  const transport = new SafeTransport({ allowPrivate: true, lookup: async () => [{ address: '127.0.0.1', family: 4 }] });
  t.after(() => transport.close());
  const url = `http://127.0.0.1:${origin.address().port}/blob`;
  await assert.rejects(transport.request(url, { allowedHosts: ['127.0.0.1'], headers: { authorization: 'Bearer SECRET' } }), { status: 502 });
  const result = await transport.request(url, { allowedHosts: ['127.0.0.1'], redirectHosts: ['localhost'], headers: { authorization: 'Bearer SECRET' } });
  result.resume();
  assert.equal(leaked, undefined);
});

test('Docker Hub credentials cannot publish private repositories and selection obeys cooldown policy', async t => {
  const upstream = await mockRegistry(t);
  const image = imageFixture();
  upstream.add('library/public', 'latest', image);
  const accounts = [{ username: 'primary', token: 'SUPERSECRET' }, { username: 'secondary', token: 'ANOTHERSECRET' }];
  const app = await testApp(t, upstream, { accounts });
  upstream.failures.set('/v2/private/secret/manifests/latest', 404);
  assert.equal((await request(app, '/v2/private/secret/manifests/latest')).status, 404);
  assert.ok(upstream.requests.every(value => !value.headers.authorization));
  assert.equal(app.upstream.selectAccount().username, 'primary');
  app.upstream.profiles[0].cooldownUntil = Date.now() + 60000;
  assert.equal(app.upstream.selectAccount(), undefined);
  app.config.accountFailover = true;
  assert.equal(app.upstream.selectAccount().username, 'secondary');
  assert.equal((await request(app, '/v2/library/public/manifests/latest')).status, 200);
  await app.archives.waitForIdle();
  assert.equal(JSON.stringify(await app.status()).includes('SUPERSECRET'), false);
});

test('a fabricated public descriptor and dishonest HEAD cannot expose a private CAS blob', async t => {
  const upstream = await mockRegistry(t);
  const image = imageFixture({ shared: Buffer.from('confidential local image content') });
  upstream.add('library/malicious', 'latest', image);
  upstream.blobs.delete(`library/malicious@${image.layerDigest}`);
  upstream.headOverrides.add(`/v2/library/malicious/blobs/${image.layerDigest}`);
  const app = await testApp(t, upstream);
  await app.store.put(image.layer, image.layerDigest);
  await app.repositories.blob({ name: 'local/team/secret', provider: 'local', remote: 'team/secret' }, image.layerDigest, image.layer.length);
  await request(app, '/v2/library/malicious/manifests/latest');
  await app.archives.waitForIdle();
  const publicBlob = await request(app, `/v2/library/malicious/blobs/${image.layerDigest}`);
  assert.equal(publicBlob.status, 404);
  assert.equal(publicBlob.bytes.includes(image.layer), false);
  assert.equal((await app.status()).archives.complete, 0);
});

test('a resolved address is pinned through connection establishment', async t => {
  const server = http.createServer((request, response) => response.end('pinned'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  let queries = 0;
  const transport = new SafeTransport({ allowPrivate: true, lookup: async () => [{ address: ++queries === 1 ? '127.0.0.1' : '10.0.0.1', family: 4 }] });
  t.after(() => transport.close());
  const response = await transport.request(`http://pinned.example:${server.address().port}/`, { allowedHosts: ['pinned.example'] });
  response.resume();
  assert.equal(response.statusCode, 200);
  assert.equal(queries, 1);
});

test('PAT exchange is confined to the trusted token endpoint and quota/log state contains no tokens', async t => {
  const upstream = await mockRegistry(t);
  upstream.requireBearer = true;
  upstream.quotaHeaders = { 'ratelimit-limit': '200;w=21600', 'ratelimit-remaining': '123;w=21600' };
  upstream.add('library/profile', 'latest', imageFixture());
  const token = 'a-long-fixture-personal-access-token';
  const app = await testApp(t, upstream, { accounts: [{ username: 'profile', token }] });
  assert.equal((await request(app, '/v2/library/profile/manifests/latest')).status, 200);
  await app.archives.waitForIdle();
  const basicAuthorization = `Basic ${Buffer.from(`profile:${token}`).toString('base64')}`;
  assert.equal(upstream.requests.filter(value => value.headers.authorization === basicAuthorization).length, 1);
  assert.ok(upstream.requests.filter(value => value.headers.authorization === basicAuthorization).every(value => value.url.startsWith('/token?')));
  assert.equal(app.telemetry.accounts.profile.authentication, 'valid');
  assert.equal(app.telemetry.accounts.profile.remaining, '123;w=21600');
  const status = JSON.stringify(await app.status());
  assert.equal(status.includes(token), false);
  assert.equal(status.includes('fixture-bearer-token'), false);
  await app.telemetry.flush();
  const log = await readFile(app.store.path('logs', 'registry.jsonl'), 'utf8');
  assert.equal(log.includes(token), false);
  assert.equal(log.includes('fixture-bearer-token'), false);
});
