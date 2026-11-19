import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { mockRegistry, testApp, request, imageFixture, indexFixture } from '../helpers/registry.js';

async function fixture(t, overrides = {}, image = imageFixture({ shared: Buffer.alloc(200000, 42) })) {
  const upstream = await mockRegistry(t);
  upstream.add('library/stream', 'latest', image);
  const app = await testApp(t, upstream, { retryBackoffMs: 10, ...overrides });
  app.archives.stopping = true;
  await request(app, '/v2/library/stream/manifests/latest');
  const path = `/v2/library/stream/blobs/${image.layerDigest}`;
  return { upstream, app, image, path };
}

async function within(promise, ms = 2500) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Operation exceeded deadline')), ms); })]); }
  finally { clearTimeout(timer); }
}

async function waitUntil(predicate) {
  await within((async () => { while (!await predicate()) await delay(10); })());
}

function holdBlob(upstream, digest) {
  const released = Promise.withResolvers();
  upstream.blobHandler = async ({ request, response, bytes, digest: current }) => {
    if (request.method !== 'GET' || current !== digest) return false;
    response.writeHead(200, { 'content-length': bytes.length, 'docker-content-digest': digest });
    response.write(bytes.subarray(0, bytes.length / 2));
    released.promise.then(() => { if (!response.destroyed) response.end(bytes.subarray(bytes.length / 2)); });
    return true;
  };
  return released.resolve;
}

function gets(upstream, digest) { return upstream.requests.filter(entry => entry.method === 'GET' && entry.url.endsWith(digest)); }

// This uses wall-clock time deliberately; a timer-only mock would miss the production failure.
test('a cache miss streams past 30 seconds while satisfying a 30-second response-header deadline', { timeout: 45000 }, async t => {
  const { upstream, app, image, path } = await fixture(t, { idleTimeoutMs: 40000 });
  const release = holdBlob(upstream, image.layerDigest);
  t.after(release);
  const started = Date.now();
  const response = await new Promise((resolve, reject) => {
    const client = http.get(`${app.origin}${path}`, resolve);
    const timer = setTimeout(() => client.destroy(new Error('Docker response-header timeout')), 30000);
    client.once('response', () => clearTimeout(timer));
    client.once('error', error => { clearTimeout(timer); reject(error); });
  });
  const headerMs = Date.now() - started;
  assert.ok(headerMs < 2500, `headers took ${headerMs}ms`);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-length'], String(image.layer.length));
  const chunks = [];
  const completed = (async () => { for await (const chunk of response) chunks.push(chunk); })();
  await waitUntil(() => chunks.length > 0);
  assert.equal(await app.store.content(image.layerDigest), null);
  await delay(Math.max(1, 31000 - (Date.now() - started)));
  release();
  await completed;
  assert.ok(Date.now() - started >= 31000);
  assert.deepEqual(Buffer.concat(chunks), image.layer);
  assert.ok(await app.store.content(image.layerDigest));
  t.diagnostic(`response headers: ${headerMs}ms; verified transfer: ${Date.now() - started}ms`);
});

test('concurrent live pulls and ranges share one transfer and HEAD never waits for the body', async t => {
  const { upstream, app, image, path } = await fixture(t);
  const release = holdBlob(upstream, image.layerDigest);
  t.after(release);
  const first = await within(fetch(`${app.origin}${path}`));
  const others = await within(Promise.all(Array.from({ length: 8 }, () => fetch(`${app.origin}${path}`))));
  const ranges = await within(Promise.all(['bytes=2-7', 'bytes=-10', 'bytes=190000-', 'bytes=199990-999999'].map(range => fetch(`${app.origin}${path}`, { headers: { range } }))));
  const rangedBodies = ranges.map(response => response.arrayBuffer());
  const head = await within(request(app, path, { method: 'HEAD', headers: { range: 'bytes=1-3' } }));
  assert.equal(head.status, 200);
  assert.equal(head.bytes.length, 0);
  assert.equal(head.headers.get('content-length'), String(image.layer.length));
  assert.equal((await request(app, path, { headers: { range: 'bytes=999999-' } })).status, 416);
  assert.equal(await app.store.content(image.layerDigest), null);
  assert.equal(gets(upstream, image.layerDigest).length, 1);
  let rangeFinished = false;
  rangedBodies[0].then(() => { rangeFinished = true; });
  await delay(30);
  assert.equal(rangeFinished, false, 'even an early range must retain its last byte until verification');
  release();
  for (const response of [first, ...others]) assert.deepEqual(Buffer.from(await response.arrayBuffer()), image.layer);
  const bodies = await Promise.all(rangedBodies);
  for (const [i, [start, end]] of [[2, 7], [199990, 199999], [190000, 199999], [199990, 199999]].entries()) {
    assert.equal(ranges[i].status, 206);
    assert.equal(ranges[i].headers.get('content-range'), `bytes ${start}-${end}/${image.layer.length}`);
    assert.equal(ranges[i].headers.get('content-length'), String(end - start + 1));
    assert.deepEqual(Buffer.from(bodies[i]), image.layer.subarray(start, end + 1));
  }
  const cached = await request(app, path, { headers: { range: 'bytes=1-2', 'if-range': '"different"' } });
  assert.equal(cached.status, 200);
  assert.deepEqual(cached.bytes, image.layer);
});

test('transient pre-header failures use bounded exponential retries and retain HTTP errors', async t => {
  const { upstream, app, image, path } = await fixture(t);
  let attempts = 0;
  upstream.blobHandler = ({ response, digest }) => {
    if (digest !== image.layerDigest || ++attempts > 2) return false;
    response.writeHead(503); response.end(); return true;
  };
  assert.deepEqual((await request(app, path)).bytes, image.layer);
  assert.equal(attempts, 3);
  assert.equal(app.telemetry.counters.upstreamRetries, 2);
  const log = await fs.readFile(app.store.path('logs', 'registry.jsonl'), 'utf8');
  const metrics = log.trim().split('\n').map(line => JSON.parse(line)).find(entry => entry.event === 'blob_download' && entry.digest === image.layerDigest);
  assert.equal(metrics.retryCount, 2);
  assert.equal(metrics.bytes, image.layer.length);
  assert.ok(metrics.upstreamTtfbMs >= 30);
  assert.ok(metrics.queueWaitMs >= 0);
});

test('exhausted 503, confirmed 404, denied access, and rate limits fail before success headers', async t => {
  for (const [status, expected, attempts] of [[503, 503, 3], [404, 404, 1], [403, 502, 1], [429, 429, 1]]) {
    await t.test(String(status), async t => {
      const { upstream, app, image, path } = await fixture(t);
      upstream.failures.set(path, { status, headers: { 'retry-after': '2' } });
      const result = await request(app, path);
      assert.equal(result.status, expected);
      if (status === 429) assert.equal(result.headers.get('retry-after'), '2');
      assert.equal(gets(upstream, image.layerDigest).length, attempts);
      assert.equal(await app.store.content(image.layerDigest), null);
    });
  }
});

test('an interrupted stream aborts clients, retains only temporary bytes, and a later pull resumes', async t => {
  const { upstream, app, image, path } = await fixture(t);
  upstream.interrupt.add(image.layerDigest);
  const response = await fetch(`${app.origin}${path}`);
  assert.equal(response.status, 200);
  await assert.rejects(response.arrayBuffer());
  await waitUntil(() => !app.mirror.transfers.size);
  assert.equal(await app.store.content(image.layerDigest), null);
  assert.equal(await app.store.get('public', image.layerDigest), null);
  assert.equal((await app.store.get('repos', 'library/stream')).blobs[image.layerDigest], undefined);
  assert.equal((await fs.stat(app.store.path('downloads', `${image.layerDigest.slice(7)}.part`))).size, 100000);
  assert.deepEqual((await request(app, path)).bytes, image.layer);
  assert.equal(gets(upstream, image.layerDigest).length, 2);
  assert.equal(gets(upstream, image.layerDigest)[1].headers.range, 'bytes=100000-');
});

test('digest mismatch terminates full and range responses and never poisons the permanent cache', async t => {
  const { upstream, app, image, path } = await fixture(t);
  const release = holdBlob(upstream, image.layerDigest);
  const full = await fetch(`${app.origin}${path}`);
  const range = await fetch(`${app.origin}${path}`, { headers: { range: 'bytes=0-4' } });
  const fullBody = assert.rejects(full.arrayBuffer());
  const rangeBody = assert.rejects(range.arrayBuffer());
  // Alter the already received temporary prefix; the final SHA-256 must catch it.
  await waitUntil(async () => (await fs.stat(app.store.path('downloads', `${image.layerDigest.slice(7)}.part`))).size > 0);
  const handle = await app.store.open(app.store.path('downloads', `${image.layerDigest.slice(7)}.part`), 2);
  await handle.write(Buffer.from('wrong'), 0, 5, 0);
  await handle.close();
  release();
  await Promise.all([fullBody, rangeBody]);
  await waitUntil(() => !app.mirror.transfers.size);
  assert.equal(await app.store.content(image.layerDigest), null);
  assert.equal(await app.store.get('public', image.layerDigest), null);
  await assert.rejects(fs.stat(app.store.path('downloads', `${image.layerDigest.slice(7)}.part`)), { code: 'ENOENT' });
  upstream.blobHandler = undefined;
  assert.deepEqual((await request(app, path)).bytes, image.layer);
});

test('invalid upstream digest, size, encoding, status and resume metadata cannot produce success headers', async t => {
  for (const [label, status, headers, resume] of [
    ['digest', 200, { 'docker-content-digest': `sha256:${'0'.repeat(64)}` }],
    ['length', 200, { 'content-length': '7' }],
    ['range-on-200', 200, { 'content-range': 'bytes 0-7/8' }],
    ['unsolicited-206', 206, { 'content-range': 'bytes 0-7/8' }],
    ['encoding', 200, { 'content-encoding': 'gzip' }],
    ['resume-range', 206, { 'content-range': 'bytes 1-199999/200000' }, true],
    ['no-content', 204, {}]
  ]) {
    await t.test(label, async t => {
      const { upstream, app, image, path } = await fixture(t);
      if (resume) await fs.writeFile(app.store.path('downloads', `${image.layerDigest.slice(7)}.part`), image.layer.subarray(0, 100000));
      upstream.blobHandler = ({ request, response }) => {
        if (request.method === 'HEAD') return false;
        response.writeHead(status, headers); response.end(); return true;
      };
      assert.equal((await request(app, path)).status, 502);
      assert.equal(await app.store.content(image.layerDigest), null);
    });
  }
});

test('disconnects release client readers while the shared archival transfer continues', async t => {
  const { upstream, app, image, path } = await fixture(t);
  const release = holdBlob(upstream, image.layerDigest);
  t.after(release);
  const controller = new AbortController();
  const first = await fetch(`${app.origin}${path}`, { signal: controller.signal });
  const reader = first.body.getReader();
  assert.ok((await reader.read()).value.length > 0);
  controller.abort();
  await waitUntil(() => app.telemetry.counters.blobClientDisconnects === 1);
  const other = await within(fetch(`${app.origin}${path}`));
  release();
  assert.deepEqual(Buffer.from(await other.arrayBuffer()), image.layer);
  assert.equal(gets(upstream, image.layerDigest).length, 1);
  assert.ok(await app.store.content(image.layerDigest));
  // No clients are required to finish the archive, either.
  const next = imageFixture({ shared: Buffer.alloc(100000, 99) });
  upstream.add('library/stream', 'next', next);
  await request(app, '/v2/library/stream/manifests/next');
  const nextRelease = holdBlob(upstream, next.layerDigest);
  const abort = new AbortController();
  await fetch(`${app.origin}/v2/library/stream/blobs/${next.layerDigest}`, { signal: abort.signal });
  abort.abort();
  nextRelease();
  await waitUntil(async () => !!await app.store.content(next.layerDigest));
});

test('background architecture archival cannot starve a requested architecture or a cache hit', async t => {
  const upstream = await mockRegistry(t);
  const slow = imageFixture({ architecture: 'arm64', label: 'slow', shared: Buffer.alloc(200000, 41) });
  const wanted = imageFixture({ label: 'wanted', shared: Buffer.alloc(100000, 42) });
  const root = indexFixture([slow, wanted]);
  for (const image of [root, slow, wanted]) upstream.add('library/priority', image === root ? 'latest' : null, image);
  const release = holdBlob(upstream, slow.layerDigest);
  t.after(release);
  const app = await testApp(t, upstream, { downloadConcurrency: 1, foregroundDownloads: 1 });
  await request(app, '/v2/library/priority/manifests/latest');
  await waitUntil(() => gets(upstream, slow.layerDigest).length > 0);
  await within(request(app, `/v2/library/priority/manifests/${wanted.digest}`));
  const path = `/v2/library/priority/blobs/${wanted.layerDigest}`;
  assert.deepEqual((await within(request(app, path))).bytes, wanted.layer);
  assert.deepEqual((await within(request(app, path))).bytes, wanted.layer);
  const head = await within(request(app, `/v2/library/priority/blobs/${slow.layerDigest}`, { method: 'HEAD' }));
  assert.equal(head.status, 200);
  const joined = await within(fetch(`${app.origin}/v2/library/priority/blobs/${slow.layerDigest}`));
  release();
  assert.deepEqual(Buffer.from(await joined.arrayBuffer()), slow.layer);
  await app.archives.waitForIdle();
  assert.equal([...app.archives.jobs.values()].find(job => job.digest === root.digest).state, 'complete');
  assert.equal(gets(upstream, slow.layerDigest).length, 1);
});

test('chunked upstream, ignored resume Range and zero-length blobs retain exact lengths', async t => {
  const { upstream, app, image, path } = await fixture(t);
  await fs.writeFile(app.store.path('downloads', `${image.layerDigest.slice(7)}.part`), Buffer.from('old partial'));
  upstream.blobHandler = ({ request, response, bytes, digest }) => {
    if (request.method === 'HEAD') return false;
    response.writeHead(200, { 'docker-content-digest': digest });
    response.write(bytes.subarray(0, 100)); response.end(bytes.subarray(100)); return true;
  };
  const result = await request(app, path);
  assert.equal(result.headers.get('content-length'), String(image.layer.length));
  assert.deepEqual(result.bytes, image.layer);
  const empty = imageFixture({ shared: Buffer.alloc(0) });
  upstream.add('library/stream', 'empty', empty);
  await request(app, '/v2/library/stream/manifests/empty');
  const resultEmpty = await request(app, `/v2/library/stream/blobs/${empty.layerDigest}`);
  assert.equal(resultEmpty.status, 200);
  assert.equal(resultEmpty.headers.get('content-length'), '0');
  assert.equal(resultEmpty.bytes.length, 0);
  assert.equal(gets(upstream, empty.layerDigest).length, 1);
  assert.ok(await app.store.content(empty.layerDigest));
});

test('response-header timeouts are bounded, retried, and returned before downstream success', async t => {
  const { upstream, app, image, path } = await fixture(t, { headerTimeoutMs: 60, headerBudgetMs: 250, upstreamRetries: 1 });
  upstream.blobHandler = ({ request }) => request.method === 'GET';
  const started = Date.now();
  const result = await within(request(app, path));
  assert.equal(result.status, 503);
  assert.ok(Date.now() - started < 1000);
  assert.equal(gets(upstream, image.layerDigest).length, 2);
  assert.equal(await app.store.content(image.layerDigest), null);
});

test('idle-read timeouts abort partial responses without retrying an already started client body', async t => {
  const { upstream, app, image, path } = await fixture(t, { idleTimeoutMs: 60 });
  const release = holdBlob(upstream, image.layerDigest);
  t.after(release);
  const response = await within(fetch(`${app.origin}${path}`));
  await assert.rejects(within(response.arrayBuffer()));
  await waitUntil(() => !app.mirror.transfers.size);
  assert.equal(gets(upstream, image.layerDigest).length, 1);
  assert.equal(await app.store.content(image.layerDigest), null);
  assert.equal(app.telemetry.counters.blobClientDisconnects ?? 0, 0);
});

test('DNS connection timeouts include lookup and retain destination pinning', async t => {
  const { upstream, app, path } = await fixture(t, { connectTimeoutMs: 30, headerBudgetMs: 200, upstreamRetries: 1 });
  app.config.providers.dockerhub.origin = upstream.origin.replace('127.0.0.1', 'fixture.invalid');
  let lookups = 0;
  app.transport.lookup = async () => { lookups++; await delay(150); return [{ address: '127.0.0.1', family: 4 }]; };
  const result = await within(request(app, path));
  assert.equal(result.status, 503);
  assert.equal(lookups, 2);
});

test('active body reads may outlive the header budget while respecting the idle-read timeout', async t => {
  const { upstream, app, image, path } = await fixture(t, { headerTimeoutMs: 60, headerBudgetMs: 150, idleTimeoutMs: 200 });
  upstream.blobHandler = ({ request, response, bytes }) => {
    if (request.method === 'HEAD') return false;
    response.writeHead(200, { 'content-length': bytes.length });
    response.flushHeaders();
    let offset = 0;
    const timer = setInterval(() => {
      const next = Math.min(bytes.length, offset + 20000);
      response.write(bytes.subarray(offset, next));
      offset = next;
      if (offset === bytes.length) response.end();
    }, 40);
    response.once('close', () => clearInterval(timer));
    return true;
  };
  const started = Date.now();
  assert.deepEqual((await request(app, path)).bytes, image.layer);
  assert.ok(Date.now() - started > 350);
});

test('queued background single flights are promoted and overload has a bounded header wait', async t => {
  const { upstream, app, image, path } = await fixture(t, { downloadConcurrency: 1, foregroundDownloads: 1, headerBudgetMs: 200 });
  const release = holdBlob(upstream, image.layerDigest);
  t.after(release);
  const route = { name: 'library/stream', remote: 'library/stream', provider: 'dockerhub' };
  const background = app.mirror.blob(route, image.layerDigest);
  await waitUntil(() => gets(upstream, image.layerDigest).length === 1);
  const queuedImage = imageFixture({ shared: Buffer.alloc(20000, 11) });
  upstream.add('library/stream', 'queued', queuedImage);
  await request(app, '/v2/library/stream/manifests/queued');
  const queued = app.mirror.blob(route, queuedImage.layerDigest);
  await waitUntil(() => app.mirror.downloads.queue.length === 1);
  assert.deepEqual((await within(request(app, `/v2/library/stream/blobs/${queuedImage.layerDigest}`))).bytes, queuedImage.layer);
  await queued;
  assert.equal(gets(upstream, queuedImage.layerDigest).length, 1);
  // Fill both slots with held transfers, then ensure the next request gets a bounded 503.
  const second = imageFixture({ shared: Buffer.alloc(10000, 12) });
  upstream.add('library/stream', 'second', second);
  await request(app, '/v2/library/stream/manifests/second');
  const oldHandler = upstream.blobHandler;
  let releaseSecond;
  const secondGate = new Promise(resolve => { releaseSecond = resolve; });
  upstream.blobHandler = args => {
    if (args.digest !== second.layerDigest) return oldHandler(args);
    args.response.writeHead(200, { 'content-length': args.bytes.length });
    args.response.write(args.bytes.subarray(0, 1));
    secondGate.then(() => args.response.end(args.bytes.subarray(1)));
    return true;
  };
  const held = await fetch(`${app.origin}/v2/library/stream/blobs/${second.layerDigest}`);
  const third = imageFixture({ shared: Buffer.alloc(10000, 13) });
  upstream.add('library/stream', 'third', third);
  await request(app, '/v2/library/stream/manifests/third');
  assert.equal((await within(request(app, `/v2/library/stream/blobs/${third.layerDigest}`))).status, 503);
  releaseSecond(); release();
  await held.arrayBuffer(); await background;
  await app.mirror.close();
  assert.deepEqual((await request(app, path)).bytes, image.layer);
});

test('a stalled authentication body obeys the overall header budget', async t => {
  const { upstream, app, image, path } = await fixture(t, { headerBudgetMs: 150, idleTimeoutMs: 10000, upstreamRetries: 0 });
  upstream.requireBearer = true;
  upstream.tokenHandler = ({ response }) => {
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
    response.write('{');
    return true;
  };
  assert.equal((await within(request(app, path))).status, 503);
  await waitUntil(() => !app.transport.requests.size);
  assert.equal(await app.store.content(image.layerDigest), null);
});

test('a corrupt upstream body, including a one-byte blob, cannot complete successfully', async t => {
  for (const length of [1, 200000]) {
    await t.test(String(length), async t => {
      const { upstream, app, image, path } = await fixture(t, {}, imageFixture({ shared: Buffer.alloc(length, 42) }));
      upstream.blobHandler = ({ response, bytes }) => {
        response.writeHead(200, { 'content-length': bytes.length, 'docker-content-digest': image.layerDigest });
        response.end(Buffer.alloc(bytes.length, 43));
        return true;
      };
      const response = await fetch(`${app.origin}${path}`);
      await assert.rejects(response.arrayBuffer());
      await waitUntil(() => !app.mirror.transfers.size);
      assert.equal(await app.store.content(image.layerDigest), null);
      assert.equal(await app.store.get('public', image.layerDigest), null);
    });
  }
});

test('disconnecting before upstream headers releases HTTP work without cancelling archival', async t => {
  const { upstream, app, image, path } = await fixture(t);
  const release = Promise.withResolvers();
  upstream.blobHandler = ({ request, response, bytes }) => {
    if (request.method === 'HEAD') return false;
    release.promise.then(() => { response.writeHead(200, { 'content-length': bytes.length }); response.end(bytes); });
    return true;
  };
  const controller = new AbortController();
  const pending = fetch(`${app.origin}${path}`, { signal: controller.signal }).catch(() => {});
  await waitUntil(() => gets(upstream, image.layerDigest).length === 1);
  controller.abort();
  await pending;
  await waitUntil(() => !app.httpWork.size);
  release.resolve();
  await app.mirror.close();
  assert.ok(await app.store.content(image.layerDigest));
  assert.equal(app.telemetry.counters.blobClientDisconnects, 1);
});

test('a paused slow client receives backpressure while another pull and archival finish', async t => {
  const { upstream, app, image, path } = await fixture(t, {}, imageFixture({ shared: Buffer.alloc(16 * 1024 * 1024, 42) }));
  const release = holdBlob(upstream, image.layerDigest);
  t.after(release);
  const paused = await new Promise((resolve, reject) => {
    const client = http.get(`${app.origin}${path}`, resolve);
    client.once('error', reject);
  });
  paused.pause();
  const fast = await fetch(`${app.origin}${path}`);
  release();
  assert.deepEqual(Buffer.from(await fast.arrayBuffer()), image.layer);
  assert.ok(await app.store.content(image.layerDigest));
  const chunks = [];
  for await (const chunk of paused) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), image.layer);
  assert.equal(gets(upstream, image.layerDigest).length, 1);
});

test('transient token endpoint failures are retried without relaxing authentication', async t => {
  const { upstream, app, image, path } = await fixture(t);
  upstream.requireBearer = true;
  let tokens = 0;
  upstream.tokenHandler = ({ response }) => {
    if (++tokens !== 1) return false;
    response.writeHead(503); response.end(); return true;
  };
  assert.deepEqual((await request(app, path)).bytes, image.layer);
  assert.equal(tokens, 2);
  assert.equal(app.telemetry.counters.upstreamRetries, 1);
  assert.ok(gets(upstream, image.layerDigest).some(entry => entry.headers.authorization === 'Bearer fixture-bearer-token'));
});
