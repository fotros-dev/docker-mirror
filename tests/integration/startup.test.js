import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { cp, copyFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { dataDirectory, trackStorage } from '../helpers/registry.js';
import { projectRoot } from '../../src/config/config.js';

test('clean clone starts with the mandatory command from an unrelated working directory', async t => {
  const directory = await dataDirectory(t);
  await cp(join(projectRoot, 'src'), join(directory, 'src'), { recursive: true });
  await copyFile(join(projectRoot, 'package.json'), join(directory, 'package.json'));
  const env = { PATH: process.env.PATH, PORT: '0' };
  const child = spawn(process.execPath, [join(directory, 'src/main.js'), 'serve'], { cwd: '/', env, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  closed.catch(() => {});
  trackStorage(directory, { close: async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  } });
  let output = '';
  let error = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { error += bytes; });
  for (let count = 0; count < 500 && !output.includes('Listening:'); count++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(error);
    await delay(10);
  }
  const listening = /^Listening: (http:\/\/127\.0\.0\.1:(\d+))$/m.exec(output);
  assert.ok(listening, `Missing loopback listening address: ${output}${error}`);
  assert.ok(Number(listening[2]) > 0 && Number(listening[2]) <= 65535);
  assert.match(output, /Push: disabled/);
  assert.match(output, /Upstreams: dockerhub, ghcr, quay/);
  assert.equal((await stat(join(directory, 'data'))).isDirectory(), true);
  const response = await fetch(`${listening[1]}/v2/`, { signal: AbortSignal.timeout(5000) });
  await response.arrayBuffer();
  assert.equal(response.status, 200);
  child.kill('SIGTERM');
  const [code] = await closed;
  assert.equal(code, 0, error);
  const status = spawnSync(process.execPath, [join(directory, 'src/main.js'), 'status'], { cwd: '/', env, encoding: 'utf8', timeout: 10000 });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).pushEnabled, false);
});
