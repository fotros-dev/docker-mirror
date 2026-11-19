import { Application } from '../../src/app.js';
import { loadConfig } from '../../src/config/config.js';
import { SafeTransport } from '../../src/network/transport.js';
import { passwordHash } from '../../src/auth/auth.js';

const [dataDir, origin, mode] = process.argv.slice(2);
const config = { ...loadConfig({ PORT: '0', SYNC_ENABLED: 'false', LOG_LEVEL: 'silent', CONNECTIVITY_CHECK_ENABLED: 'false' }), dataDir };
config.providers.dockerhub = { enabled: true, origin, authOrigins: [origin], cdnHosts: [] };
if (mode === 'uploadcommit') {
  config.pushEnabled = true;
  config.users = [{ username: 'test', passwordHash: await passwordHash('a safe fixture password'), permissions: [{ repository: 'local/team/*', actions: ['pull', 'push'] }] }];
}
const app = await new Application(config, { transport: new SafeTransport({ allowPrivate: true, timeout: 10000 }) }).initialize();
if (mode === 'uploadcommit') {
  const original = app.store.commitFile.bind(app.store);
  app.store.commitFile = async (...args) => {
    const result = await original(...args);
    process.send({ event: 'committed' });
    await new Promise(() => {});
    return result;
  };
}
if (mode === 'tagcommit') app.archives.publish = async () => { process.send({ event: 'tag_ready' }); await new Promise(() => {}); };
await app.listen();
process.send({ event: 'ready', origin: `http://127.0.0.1:${app.server.address().port}` });
process.on('SIGTERM', async () => { await app.close(); process.exit(); });
