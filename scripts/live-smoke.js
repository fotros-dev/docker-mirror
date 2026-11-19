import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, projectRoot } from '../src/config/config.js';
import { Application } from '../src/app.js';
import { routeRepository } from '../src/registry/validation.js';
import { isManifestType } from '../src/registry/manifests.js';

await mkdir(join(projectRoot, 'data'), { recursive: true });
const dataDir = await mkdtemp(join(projectRoot, 'data', 'live-smoke-'));
const config = { ...loadConfig({ SYNC_ENABLED: 'false', CONNECTIVITY_CHECK_ENABLED: 'false', LOG_LEVEL: 'silent', UPSTREAM_TIMEOUT_SECONDS: '15' }), dataDir };
const app = await new Application(config).initialize();
try {
  for (const [name, tag] of [['library/hello-world', 'latest'], ['ghcr.io/astral-sh/uv', '0.9.0'], ['quay.io/prometheus/busybox', 'latest']]) {
    try {
      const route = routeRepository(name, config.providers);
      const root = await app.mirror.manifest(route, tag);
      let selected = root;
      let depth = 0;
      while (selected.parsed.index && depth++ < config.maxDepth) {
        const child = selected.parsed.descriptors.find(value => isManifestType(value.mediaType) && value.platform?.os === 'linux' && value.platform?.architecture === 'amd64');
        if (!child) throw new Error('No linux/amd64 descriptor.');
        selected = await app.mirror.manifest(route, child.digest, { expectedSize: child.size, expectedType: child.mediaType });
      }
      const descriptor = selected.parsed.descriptors[0];
      await app.mirror.blob(route, descriptor.digest, descriptor);
      const layer = selected.parsed.descriptors[1];
      if (layer && layer.size <= 4 * 1024 ** 2) await app.mirror.blob(route, layer.digest, layer);
      console.log(JSON.stringify({ repository: name, state: 'passed', root: root.digest, manifest: selected.digest, config: descriptor.digest, layer: layer && layer.size <= 4 * 1024 ** 2 ? layer.digest : 'skipped: larger than smoke-test limit' }));
    } catch (error) {
      console.log(JSON.stringify({ repository: name, state: 'failed', status: error.status, code: error.code, reason: error.detail?.reason, message: error.message }));
      process.exitCode = 1;
    }
  }
} finally {
  await app.close();
  console.log(`Diagnostic state preserved at ${dataDir}`);
}
