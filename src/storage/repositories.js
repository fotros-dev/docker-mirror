export function tagEntry(record, tag) {
  return Object.hasOwn(record.tags, tag) ? record.tags[tag] : undefined;
}

export class Repositories {
  constructor(store) { this.store = store; }

  empty(route) {
    return { ...route, tags: {}, manifests: {}, blobs: {}, descriptors: {}, createdAt: new Date().toISOString() };
  }

  async get(route) { return await this.store.get('repos', route.name) ?? this.empty(route); }

  update(route, operation) {
    return this.store.update('repos', route.name, record => operation(record ?? this.empty(route)));
  }

  async manifest(route, digest, parsed, size) {
    await this.update(route, record => {
      record.manifests[digest] = { mediaType: parsed.mediaType, size, artifact: parsed.artifact };
      for (const descriptor of parsed.descriptors) record.descriptors[descriptor.digest] = descriptor;
      return record;
    });
  }

  async blob(route, digest, size) {
    await this.update(route, record => { record.blobs[digest] = { size }; return record; });
  }

  async track(route, tag, candidate) {
    await this.update(route, record => {
      if (!tagEntry(record, tag)) Object.defineProperty(record.tags, tag, { value: { current: null, history: [], pending: candidate }, enumerable: true, writable: true, configurable: true });
      if (!record.tags[tag].current) record.tags[tag].pending = candidate;
      return record;
    });
  }

  async publish(route, tag, digest) {
    await this.update(route, record => {
      const value = tagEntry(record, tag) ?? { current: null, history: [] };
      if (!value.history.some(entry => entry.digest === digest)) value.history.push({ digest, archivedAt: new Date().toISOString() });
      value.current = digest;
      delete value.pending;
      Object.defineProperty(record.tags, tag, { value, enumerable: true, writable: true, configurable: true });
      return record;
    });
  }
}
