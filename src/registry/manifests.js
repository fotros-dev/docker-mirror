import { fail } from '../core/errors.js';
import { digest, sha256 } from './validation.js';

export const mediaTypes = {
  ociManifest: 'application/vnd.oci.image.manifest.v1+json',
  ociIndex: 'application/vnd.oci.image.index.v1+json',
  dockerManifest: 'application/vnd.docker.distribution.manifest.v2+json',
  dockerIndex: 'application/vnd.docker.distribution.manifest.list.v2+json'
};
export const manifestTypes = new Set([mediaTypes.ociManifest, mediaTypes.dockerManifest]);
export const indexTypes = new Set([mediaTypes.ociIndex, mediaTypes.dockerIndex]);
export const isManifestType = type => manifestTypes.has(type) || indexTypes.has(type);

function descriptor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'MANIFEST_INVALID', 'Invalid content descriptor.');
  digest(value.digest);
  if (!Number.isSafeInteger(value.size) || value.size < 0 || typeof value.mediaType !== 'string' || value.mediaType.length > 256 || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(value.mediaType)) fail(400, 'MANIFEST_INVALID', 'Descriptor size or media type is invalid.');
  if (value.platform !== undefined && (!value.platform || typeof value.platform.os !== 'string' || typeof value.platform.architecture !== 'string')) fail(400, 'MANIFEST_INVALID', 'Invalid platform descriptor.');
  if (value.urls !== undefined && (!Array.isArray(value.urls) || value.urls.length > 16 || !value.urls.every(url => typeof url === 'string' && url.length <= 8192))) fail(400, 'MANIFEST_INVALID', 'Invalid descriptor URLs.');
  if (value.data !== undefined) {
    if (typeof value.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)) fail(400, 'MANIFEST_INVALID', 'Invalid inline descriptor data.');
    const bytes = Buffer.from(value.data, 'base64');
    if (bytes.length !== value.size || sha256(bytes) !== value.digest) fail(400, 'DIGEST_INVALID', 'Inline descriptor verification failed.');
  }
  return value;
}

export function parseManifest(bytes, suppliedType, { maxManifestBytes = 8 * 1024 ** 2, maxDescriptors = 10000 } = {}) {
  if (bytes.length > maxManifestBytes) fail(413, 'MANIFEST_INVALID', 'Manifest exceeds the configured size limit.');
  let value;
  try { value = JSON.parse(bytes); }
  catch { fail(400, 'MANIFEST_INVALID', 'Manifest must be valid JSON.'); }
  if (!value || value.schemaVersion !== 2) fail(400, 'MANIFEST_INVALID', 'Only schema version 2 manifests are supported.');
  const contentType = suppliedType?.split(';')[0].trim();
  const mediaType = value.mediaType ?? contentType;
  if (!isManifestType(mediaType) || contentType && contentType !== mediaType) fail(400, 'MANIFEST_INVALID', 'Unsupported or inconsistent manifest media type.');
  const index = indexTypes.has(mediaType);
  if (index && !Array.isArray(value.manifests) || !index && (!value.config || !Array.isArray(value.layers))) fail(400, 'MANIFEST_INVALID', 'Manifest structure does not match its media type.');
  const descriptors = index ? value.manifests : [value.config, ...value.layers];
  if (descriptors.length > maxDescriptors) fail(400, 'MANIFEST_INVALID', 'Manifest has too many descriptors.');
  descriptors.forEach(descriptor);
  if (value.subject !== undefined) descriptor(value.subject);
  const sizes = new Map();
  for (const item of descriptors) {
    if (sizes.has(item.digest) && sizes.get(item.digest) !== item.size) fail(400, 'SIZE_INVALID', 'Conflicting descriptor sizes.');
    sizes.set(item.digest, item.size);
  }
  const artifact = !!value.artifactType || !index && !['application/vnd.oci.image.config.v1+json', 'application/vnd.docker.container.image.v1+json'].includes(value.config.mediaType);
  return { value, mediaType, index, descriptors, artifact };
}

export function acceptsManifest(accept, type) {
  if (!accept) return true;
  const choices = accept.split(',').map(part => {
    const [range, ...parameters] = part.trim().split(';');
    const weight = parameters.find(value => value.trim().startsWith('q='));
    const q = weight ? Number(weight.trim().slice(2)) : 1;
    const specificity = range === type ? 2 : range === `${type.split('/')[0]}/*` ? 1 : range === '*/*' ? 0 : -1;
    return { specificity, q };
  }).filter(choice => choice.specificity >= 0).sort((a, b) => b.specificity - a.specificity);
  return choices.length > 0 && Number.isFinite(choices[0].q) && choices[0].q > 0;
}
