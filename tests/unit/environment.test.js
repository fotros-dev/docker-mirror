import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDirectory } from '../helpers/registry.js';

test('native environment parsing preserves real environment precedence', async t => {
  const path = await dataDirectory(t);
  const file = join(path, 'example.env');
  await writeFile(file, 'HOST=127.0.0.1\nPORT=6000\nPUSH_ENABLED=false\nDOCKER_HUB_ACCOUNTS=\'[{"username":"example","token":"fixture"}]\'\n');
  const module = new URL('../../src/config/config.js', import.meta.url).href;
  const code = `import {loadConfig} from ${JSON.stringify(module)};process.loadEnvFile(process.argv[1]);const config=loadConfig();console.log(JSON.stringify({port:config.port,host:config.host,accounts:config.accounts.length}));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, file], { env: { PATH: process.env.PATH, PORT: '7000' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { port: 7000, host: '127.0.0.1', accounts: 1 });
});
