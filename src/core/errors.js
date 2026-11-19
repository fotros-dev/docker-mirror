export class RegistryError extends Error {
  constructor(status, code, message, detail, headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.headers = headers;
  }
}

export function fail(status, code, message, detail, headers) {
  throw new RegistryError(status, code, message, detail, headers);
}

export function publicError(error) {
  if (error.code === 'EBUSY') return new RegistryError(503, 'TOOMANYREQUESTS', 'Server capacity reached. Retry shortly.', undefined, { 'retry-after': '2' });
  return error instanceof RegistryError ? error : new RegistryError(500, 'UNKNOWN', 'Internal storage or server failure.');
}

export function networkError(error) {
  if (error instanceof RegistryError) return error;
  const reason = ['ENOTFOUND', 'EAI_AGAIN'].includes(error.code) ? 'DNS_FAILURE'
    : ['ETIMEDOUT', 'ERR_TIMEOUT', 'ABORT_ERR'].includes(error.code) ? 'CONNECTION_TIMEOUT' : 'CONNECTION_FAILURE';
  return new RegistryError(503, 'UPSTREAM_UNAVAILABLE', 'The upstream could not be reached.', { reason });
}
