import process from 'node:process';
import { emitKeypressEvents } from 'node:readline';
import { loadConfig, loadEnvironment, validateUsers } from './config/config.js';
import { Application } from './app.js';
import { Store } from './storage/store.js';
import { passwordHash } from './auth/auth.js';

async function readPassword() {
  if (!process.stdin.isTTY) {
    let text = '';
    for await (const bytes of process.stdin) {
      text += bytes;
      if (text.length > 2048) throw new Error('Password input is too long.');
    }
    return text.replace(/\r?\n$/, '');
  }
  process.stderr.write('Password: ');
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const done = () => { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.removeListener('keypress', handler); process.stderr.write('\n'); };
    const handler = (text, key) => {
      if (key.name === 'return') { done(); resolve(value); }
      else if (key.ctrl && key.name === 'c') { done(); reject(new Error('Cancelled.')); }
      else if (key.name === 'backspace') value = value.slice(0, -1);
      else if (text && !key.ctrl && value.length < 1024) value += text;
    };
    process.stdin.on('keypress', handler);
  });
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required.');
  loadEnvironment();
  const config = loadConfig();
  const [command = 'serve', action, username, repository, flag] = process.argv.slice(2);
  if (command === 'password') { process.stdout.write(`${await passwordHash(await readPassword())}\n`); return; }
  if (command === 'user') {
    if (!['add', 'remove', 'list'].includes(action)) throw new Error('Usage: user add <username> <local/repository-or-prefix/*> [--admin], user remove <username>, or user list');
    const store = new Store(config.dataDir);
    await store.initialize();
    try {
      const users = await store.get('system', 'users') ?? [];
      if (action === 'list') process.stdout.write(`${JSON.stringify(users.map(({ passwordHash, ...user }) => user), null, 2)}\n`);
      else if (action === 'remove') {
        if (!username) throw new Error('A username is required.');
        await store.set('system', 'users', users.filter(user => user.username !== username));
      } else {
        const user = { username, passwordHash: await passwordHash(await readPassword()), permissions: [{ repository, actions: ['pull', 'push'] }], admin: flag === '--admin' };
        validateUsers([user]);
        await store.set('system', 'users', [...users.filter(value => value.username !== username), user]);
        process.stdout.write('User saved. Restart the server to apply user changes.\n');
      }
    } finally { await store.close(); }
    return;
  }
  if (!['serve', 'status', 'doctor', 'sync', 'verify', 'retry'].includes(command)) throw new Error('Commands: serve, status, doctor, sync, verify, retry, password, user');
  const app = await new Application(config).initialize();
  if (command === 'serve') {
    try {
      const address = await app.listen();
      process.stdout.write(`Fotros Docker Mirror 1.0.0\nListening: http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}\nUpstreams: ${Object.entries(config.providers).filter(([, provider]) => provider.enabled).map(([name]) => name).join(', ') || 'none'}\nPush: ${config.pushEnabled ? 'enabled (authenticated local/ only)' : 'disabled'}\nStorage: ${config.dataDir}\nSynchronization: ${config.syncEnabled ? `enabled, every ${config.syncIntervalMs / 60000} minutes` : 'disabled'}\n`);
    } catch (error) { await app.close(); throw error; }
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      try { await app.close(); }
      catch { process.stderr.write('Shutdown could not persist all state. Inspect storage before restarting.\n'); process.exitCode = 1; }
    });
    return;
  }
  try {
    let result;
    if (command === 'status') result = await app.status();
    if (command === 'doctor') result = { connectivity: await app.connectivity.check(true), storage: await app.store.usage(), metadataRecoveries: app.store.recoveries };
    if (command === 'sync') { result = await app.sync.run(); await app.archives.waitForIdle(3600000); }
    if (command === 'verify') { result = await app.verify(); if (!result.ok) process.exitCode = 1; }
    if (command === 'retry') {
      const jobs = await app.store.list('jobs');
      for (const job of jobs.filter(value => value.state !== 'complete')) await app.archives.enqueue(job.route, job.digest, undefined, true);
      await app.archives.waitForIdle(3600000);
      result = (await app.status()).archives;
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally { await app.close(); }
}

main().catch(error => {
  const message = error.code === 'EADDRINUSE' ? 'The configured address is already in use.' : error.code === 'EACCES' ? 'Storage or listening address permission denied.' : error.message;
  process.stderr.write(`Fotros: ${message}\n`);
  process.exitCode = 1;
});
