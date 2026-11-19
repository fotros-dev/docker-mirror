import { createHash } from 'node:crypto';
import { fail } from '../core/errors.js';

const repositoryPattern = /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*)*$/;
const tagPattern = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/;

export function repository(value) {
  if (typeof value !== 'string' || value.length > 255 || !repositoryPattern.test(value)) fail(400, 'NAME_INVALID', 'Invalid repository name.');
  return value;
}

export function digest(value) {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) fail(400, 'DIGEST_INVALID', 'Only canonical sha256 digests are supported.');
  return value;
}

export function reference(value) {
  if (typeof value !== 'string') fail(400, 'MANIFEST_INVALID', 'Invalid image reference.');
  if (value.includes(':')) return digest(value);
  if (!tagPattern.test(value)) fail(400, 'MANIFEST_INVALID', 'Invalid image tag.');
  return value;
}

export const sha256 = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export const keyHash = value => createHash('sha256').update(value).digest('hex');

export function routeRepository(name, providers) {
  repository(name);
  if (name === 'local' || name === 'ghcr.io' || name === 'quay.io') fail(400, 'NAME_INVALID', 'Reserved namespaces require a repository.');
  if (name.startsWith('local/')) return { name, provider: 'local', remote: name.slice(6) };
  const provider = name.startsWith('ghcr.io/') ? 'ghcr' : name.startsWith('quay.io/') ? 'quay' : 'dockerhub';
  const remote = provider === 'ghcr' ? name.slice(8) : provider === 'quay' ? name.slice(8) : name.includes('/') ? name : `library/${name}`;
  if (!providers[provider]?.enabled) fail(503, 'UPSTREAM_UNAVAILABLE', 'This upstream registry is disabled.');
  return { name: provider === 'dockerhub' ? remote : name, provider, remote };
}
