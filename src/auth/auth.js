import { scrypt as derive, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Semaphore } from '../core/concurrency.js';
import { RegistryError } from '../core/errors.js';
import { validateUsers } from '../config/config.js';

const scrypt = promisify(derive);
const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 ** 2 };

export async function passwordHash(password) {
  if (typeof password !== 'string' || Buffer.byteLength(password) < 12 || Buffer.byteLength(password) > 1024) throw new Error('Passwords must contain 12 to 1024 bytes.');
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64, options);
  return `scrypt$${salt}$${hash.toString('hex')}`;
}

export async function verifyPassword(password, encoded) {
  const [, salt, hash] = encoded.split('$');
  const result = await scrypt(password, salt, 64, options);
  return timingSafeEqual(result, Buffer.from(hash, 'hex'));
}

export function permitted(user, repository, action) {
  return user.permissions.some(rule => rule.actions.includes(action) && (rule.repository === repository || rule.repository.endsWith('/*') && repository.startsWith(rule.repository.slice(0, -1))));
}

export class Authentication {
  constructor(config, store, telemetry) {
    Object.assign(this, { config, store, telemetry });
    this.work = new Semaphore(4, 32);
    this.failures = new Map();
  }

  async initialize() {
    const records = await this.store.get('system', 'users') ?? [];
    const combined = new Map(records.map(user => [user.username, user]));
    for (const user of this.config.users) combined.set(user.username, user);
    this.users = validateUsers([...combined.values()]);
    if (this.config.pushEnabled && !this.users.some(user => user.permissions.some(rule => rule.actions.includes('push')))) throw new Error('PUSH_ENABLED requires at least one configured user with push permission. Run the user add CLI or set REGISTRY_USERS.');
    this.dummy = await passwordHash(randomBytes(32).toString('hex'));
  }

  unauthorized() {
    return new RegistryError(401, 'UNAUTHORIZED', 'Authentication is required.', undefined, { 'www-authenticate': 'Basic realm="Fotros Docker Mirror", charset="UTF-8"' });
  }

  async authenticate(request, required = false) {
    if (request.fotrosUser !== undefined) return request.fotrosUser;
    const authorization = request.headers.authorization;
    if (!authorization) {
      if (required) throw this.unauthorized();
      return null;
    }
    if (!/^Basic [A-Za-z0-9+/]+=*$/i.test(authorization) || authorization.length > 4096) throw this.unauthorized();
    const identity = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
    const colon = identity.indexOf(':');
    if (colon < 1 || identity.length > 2048) throw this.unauthorized();
    const username = identity.slice(0, colon);
    const password = identity.slice(colon + 1);
    const address = request.socket.remoteAddress;
    const key = `${address}:${username}`;
    const previous = this.failures.get(key);
    if (previous?.retryAt > Date.now()) throw new RegistryError(429, 'TOOMANYREQUESTS', 'Authentication temporarily throttled.', undefined, { 'retry-after': String(Math.ceil((previous.retryAt - Date.now()) / 1000)) });
    const user = this.users.find(value => value.username === username);
    let valid;
    try { valid = await this.work.run(() => verifyPassword(password.slice(0, 1024), user?.passwordHash ?? this.dummy)); }
    catch (error) {
      if (error.code === 'EBUSY') throw new RegistryError(429, 'TOOMANYREQUESTS', 'Authentication capacity reached.', undefined, { 'retry-after': '2' });
      throw error;
    }
    if (!valid || !user || password.length > 1024) {
      const count = (previous?.count ?? 0) + 1;
      this.failures.set(key, { count, retryAt: count < 5 ? 0 : Date.now() + Math.min(60000, 1000 * 2 ** Math.min(count - 5, 6)) });
      if (this.failures.size > 4096) this.failures.delete(this.failures.keys().next().value);
      this.telemetry.count('authenticationFailures');
      throw this.unauthorized();
    }
    this.failures.delete(key);
    request.fotrosUser = user;
    return user;
  }

  async authorize(request, repository, action) {
    const user = await this.authenticate(request, true);
    if (!permitted(user, repository, action)) throw new RegistryError(403, 'DENIED', 'Repository permission denied.');
    return user;
  }

  async admin(request) {
    const user = await this.authenticate(request, true);
    if (!user.admin) throw new RegistryError(403, 'DENIED', 'Administrative permission required.');
    return user;
  }
}
