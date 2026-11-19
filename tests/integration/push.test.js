import test from 'node:test';
import assert from 'node:assert/strict';
import { passwordHash } from '../../src/auth/auth.js';
import { basic, testApp, request, imageFixture, dataDirectory } from '../helpers/registry.js';
import { sha256 } from '../../src/registry/validation.js';
import { writeFile, stat } from 'node:fs/promises';

const password = 'correct horse battery staple';
const encoded = await passwordHash(password);
const users = [
  { username: 'alice', passwordHash: encoded, permissions: [{ repository: 'local/team/*', actions: ['pull', 'push'] }], admin: true },
  { username: 'bob', passwordHash: encoded, permissions: [{ repository: 'local/team/*', actions: ['pull', 'push'] }] },
  { username: 'reader', passwordHash: encoded, permissions: [{ repository: 'local/team/*', actions: ['pull'] }] },
  { username: 'other', passwordHash: encoded, permissions: [{ repository: 'local/other/*', actions: ['pull', 'push'] }] }
];
const authorization = basic('alice', password);

async function upload(app, name, bytes, auth = authorization) {
  return request(app, `/v2/${name}/blobs/uploads/?digest=${sha256(bytes)}`, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/octet-stream' }, body: bytes });
}

test('Push defaults disabled and enabled Push requires configured authentication', async t => {
  const app = await testApp(t);
  assert.equal((await request(app, '/v2/local/team/api/blobs/uploads/', { method: 'POST' })).status, 405);
  await assert.rejects(testApp(t, null, { pushEnabled: true }), /requires at least one configured user/);
});

test('Docker-compatible Basic authentication, permission scopes and protected diagnostics', async t => {
  const app = await testApp(t, null, { pushEnabled: true, users });
  assert.equal((await request(app, '/v2/')).status, 200);
  assert.equal((await request(app, '/v2/', { headers: { authorization } })).status, 200);
  assert.equal((await request(app, '/v2/', { headers: { authorization: basic('alice', 'wrong') } })).status, 401);
  const anonymous = await request(app, '/v2/local/team/api/blobs/uploads/', { method: 'POST' });
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get('www-authenticate'), /^Basic /);
  assert.equal((await request(app, '/v2/local/team/api/blobs/uploads/', { method: 'POST', headers: { authorization: basic('reader', password) } })).status, 403);
  assert.equal((await request(app, '/v2/local/other/api/blobs/uploads/', { method: 'POST', headers: { authorization } })).status, 403);
  assert.equal((await request(app, '/v2/library/nginx/blobs/uploads/', { method: 'POST', headers: { authorization } })).status, 403);
  assert.equal((await request(app, '/admin/status')).status, 401);
  assert.equal((await request(app, '/admin/status', { headers: { authorization: basic('reader', password) } })).status, 403);
  const status = await request(app, '/admin/status', { headers: { authorization } });
  assert.equal(status.status, 200);
  assert.equal(status.bytes.toString().includes(encoded), false);
  const health = await request(app, '/healthz');
  assert.equal(health.status, 200);
  assert.equal(health.bytes.toString().includes('local/team'), false);
});

test('chunked upload offsets, status, owner isolation, resume and cancellation', async t => {
  const storage = await dataDirectory(t);
  const app = await testApp(t, null, { pushEnabled: true, users }, storage);
  const start = await request(app, '/v2/local/team/api/blobs/uploads/', { method: 'POST', headers: { authorization, host: 'attacker.example', 'x-forwarded-host': 'attacker.example' } });
  assert.equal(start.status, 202);
  const location = start.headers.get('location');
  assert.ok(location.startsWith('/v2/local/team/api/blobs/uploads/'));
  const wrongRange = await request(app, location, { method: 'PATCH', headers: { authorization, 'content-range': '4-7' }, body: 'abcd' });
  assert.equal(wrongRange.status, 416);
  const first = await request(app, location, { method: 'PATCH', headers: { authorization, 'content-type': 'application/octet-stream', 'content-range': '0-3' }, body: 'abcd' });
  assert.equal(first.status, 202);
  assert.equal(first.headers.get('range'), '0-3');
  assert.equal((await request(app, location, { headers: { authorization: basic('bob', password) } })).status, 404);
  assert.equal((await request(app, location.replace('/team/api/', '/team/other/'), { headers: { authorization } })).status, 404);
  await app.close();
  const restarted = await testApp(t, null, { pushEnabled: true, users }, storage);
  const status = await request(restarted, location, { headers: { authorization } });
  assert.equal(status.status, 204);
  assert.equal(status.headers.get('range'), '0-3');
  const bytes = Buffer.from('abcdefgh');
  const complete = await request(restarted, `${location}?digest=${sha256(bytes)}`, { method: 'PUT', headers: { authorization, 'content-range': '4-7' }, body: 'efgh' });
  assert.equal(complete.status, 201);
  assert.deepEqual((await request(restarted, `/v2/local/team/api/blobs/${sha256(bytes)}`, { headers: { authorization } })).bytes, bytes);
  const cancel = await request(restarted, '/v2/local/team/api/blobs/uploads/', { method: 'POST', headers: { authorization } });
  assert.equal((await request(restarted, cancel.headers.get('location'), { method: 'DELETE', headers: { authorization } })).status, 204);
  assert.equal((await request(restarted, cancel.headers.get('location'), { headers: { authorization } })).status, 404);
});

test('digest mismatch is rejected, manifests publish only with repository content, private Pull stays private', async t => {
  const app = await testApp(t, null, { pushEnabled: true, users });
  const image = imageFixture();
  const mismatch = await request(app, `/v2/local/team/api/blobs/uploads/?digest=${sha256('other')}`, { method: 'POST', headers: { authorization }, body: 'data' });
  assert.equal(mismatch.status, 400);
  const publishOptions = { method: 'PUT', headers: { authorization, 'content-type': image.value.mediaType }, body: image.bytes };
  assert.equal((await request(app, '/v2/local/team/api/manifests/latest', publishOptions)).status, 400);
  for (const bytes of image.blobs.values()) assert.equal((await upload(app, 'local/team/api', bytes)).status, 201);
  const publication = await request(app, '/v2/local/team/api/manifests/latest', publishOptions);
  assert.equal(publication.status, 201);
  assert.equal(publication.headers.get('docker-content-digest'), image.digest);
  const pull = await request(app, '/v2/local/team/api/manifests/latest', { headers: { authorization: basic('reader', password) } });
  assert.deepEqual(pull.bytes, image.bytes);
  assert.equal((await request(app, '/v2/local/team/api/manifests/latest')).status, 401);
  assert.equal((await request(app, `/v2/local/team/api/blobs/${image.layerDigest}`)).status, 401);
  assert.equal((await request(app, `/v2/local/other/api/blobs/${image.layerDigest}`, { headers: { authorization: basic('other', password) } })).status, 404);
  assert.equal((await request(app, '/v2/local/team/empty/manifests/latest', publishOptions)).status, 400);
  const tags = await request(app, '/v2/local/team/api/tags/list', { headers: { authorization } });
  assert.deepEqual(tags.json().tags, ['latest']);
  assert.equal((await request(app, `/v2/local/team/api/manifests/${sha256('bad')}`, publishOptions)).status, 400);
});

test('cross-repository mounts require source Pull permission, and missing mounts fall back to upload', async t => {
  const app = await testApp(t, null, { pushEnabled: true, users });
  const bytes = Buffer.from('shared private blob');
  assert.equal((await upload(app, 'local/team/source', bytes)).status, 201);
  const mountPath = `/v2/local/team/target/blobs/uploads/?mount=${sha256(bytes)}&from=local/team/source`;
  assert.equal((await request(app, mountPath, { method: 'POST', headers: { authorization } })).status, 201);
  const denied = `/v2/local/other/target/blobs/uploads/?mount=${sha256(bytes)}&from=local/team/source`;
  assert.equal((await request(app, denied, { method: 'POST', headers: { authorization: basic('other', password) } })).status, 403);
  const absent = `/v2/local/team/target/blobs/uploads/?mount=${sha256('absent')}&from=local/team/source`;
  assert.equal((await request(app, absent, { method: 'POST', headers: { authorization } })).status, 202);
});

test('upload recovery cannot grant another repository content using a forged committing digest', async t => {
  const storage = await dataDirectory(t);
  const app = await testApp(t, null, { pushEnabled: true, users }, storage);
  const secret = Buffer.from('secret private bytes');
  const incorrect = Buffer.alloc(secret.length, 88);
  const secretDigest = await app.store.put(secret);
  await app.repositories.blob({ name: 'local/other/secret', provider: 'local', remote: 'other/secret' }, secretDigest, secret.length);
  const session = await app.uploads.start({ name: 'local/team/attacker' }, users[0]);
  await writeFile(app.uploads.path(session.id), incorrect);
  await app.store.set('uploads', session.id, { ...session, offset: incorrect.length, state: 'committing', digest: secretDigest });
  await app.close();
  const restarted = await testApp(t, null, { pushEnabled: true, users }, storage);
  assert.equal((await request(restarted, `/v2/local/team/attacker/blobs/${secretDigest}`, { headers: { authorization } })).status, 404);
  assert.equal((await restarted.store.get('uploads', session.id)).state, 'active');
});

test('uncertain chunk metadata publication retains bytes matching the durable upload offset', async t => {
  const app = await testApp(t, null, { pushEnabled: true, users });
  const started = await request(app, '/v2/local/team/api/blobs/uploads/', { method: 'POST', headers: { authorization } });
  const location = started.headers.get('location');
  const original = app.store.immutable.bind(app.store);
  app.store.immutable = async (target, bytes) => {
    if (target.includes('/state/uploads/') && target.endsWith('.json')) throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' });
    return original(target, bytes);
  };
  const result = await request(app, location, { method: 'PATCH', headers: { authorization }, body: 'retained' });
  assert.equal(result.status, 500);
  app.store.immutable = original;
  const state = await request(app, location, { headers: { authorization } });
  assert.equal(state.status, 204);
  assert.equal(state.headers.get('range'), '0-7');
  assert.equal((await stat(app.uploads.path(location.split('/').at(-1)))).size, 8);
});
