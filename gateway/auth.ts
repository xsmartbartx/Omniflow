import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import {
  AuthenticationError,
  ForbiddenError,
  type Logger,
  nullLogger,
  randomToken,
  ValidationError,
  ConflictError,
} from '../core/index.ts';
import type { Principal, Role } from '../schemas/index.ts';
import { ROLES } from '../schemas/index.ts';
import type { ApiKeyRecord, State, UserRecord } from '../state/index.ts';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MIN_PASSWORD = 12;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function checkPasswordPolicy(password: string, email?: string): void {
  const problems: string[] = [];
  if (password.length < MIN_PASSWORD) problems.push(`at least ${MIN_PASSWORD} characters`);
  if (password.length > 256) problems.push('at most 256 characters');
  if (email && password.toLowerCase().includes(email.split('@')[0]!.toLowerCase()) && email.split('@')[0]!.length > 3) problems.push('must not contain your email name');
  if (/^(.)\1+$/.test(password) || /^(password|123456|qwerty|letmein)/i.test(password)) problems.push('is too easy to guess');
  if (problems.length > 0) {
    throw new ValidationError(`Password ${problems.join(', ')}`, [{ path: 'password', code: 'WEAK_PASSWORD', message: `Password ${problems.join(', ')}` }]);
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** `omf_<12 hex>_<43 base64url>` — the prefix is public and indexed; the secret is stored only as a hash. */
export function newApiKey(): { full: string; prefix: string; hash: string } {
  const prefix = randomBytes(6).toString('hex');
  const secret = randomToken(32);
  return { full: `omf_${prefix}_${secret}`, prefix, hash: sha256(secret) };
}

export function parseApiKey(token: string): { prefix: string; secret: string } | undefined {
  const m = /^omf_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/.exec(token);
  return m ? { prefix: m[1]!, secret: m[2]! } : undefined;
}

export const SESSION_COOKIE = 'omf_session';

export interface LoginResult {
  token: string;
  expiresAt: string;
  principal: Principal;
  user: { id: string; email: string; name: string; roles: Role[]; mustChangePassword: boolean };
}

const toPrincipalFromUser = (u: UserRecord): Principal => ({ id: u.id, type: 'user', name: u.email, tenant: u.tenant, roles: u.roles });
const toPrincipalFromKey = (k: ApiKeyRecord): Principal => ({ id: k.id, type: 'api-key', name: k.name, tenant: k.tenant, roles: k.roles });

/** Gateway authentication: sessions for people, API keys for machines. Authorisation is the Policy Engine's job. */
export class Authenticator {
  private readonly st: State;
  private readonly sessionTtlMs: number;
  private readonly log: Logger;
  private dummyHash: Promise<string> | undefined;

  constructor(state: State, opts: { sessionTtlHours: number; log?: Logger }) {
    this.st = state;
    this.sessionTtlMs = opts.sessionTtlHours * 3_600_000;
    this.log = opts.log ?? nullLogger;
  }

  private audit(type: 'auth.login' | 'auth.login-failed' | 'auth.logout', tenant: string, data: Record<string, unknown>, actor?: { type: string; id: string }): void {
    this.st.events.append({ tenant, type, ...(actor ? { actor } : {}), data });
  }

  async login(email: string, password: string, opts: { tenant?: string; ip?: string; userAgent?: string } = {}): Promise<LoginResult> {
    const generic = new AuthenticationError('Invalid email or password');
    const candidates = this.st.identity.findUsersByEmail(email).filter((u) => !opts.tenant || u.tenant === opts.tenant);
    const user = candidates.length === 1 ? candidates[0] : undefined;

    // Always burn the same amount of time, whether or not the account exists.
    if (!user || user.disabled || !user.passwordHash) {
      this.dummyHash ??= hashPassword('not-a-real-password');
      await verifyPassword(password, await this.dummyHash);
      this.audit('auth.login-failed', opts.tenant ?? 'default', { reason: candidates.length > 1 ? 'ambiguous' : 'unknown-or-disabled', ...(opts.ip ? { ip: opts.ip } : {}) });
      throw generic;
    }
    if (user.lockedUntil && user.lockedUntil > new Date().toISOString()) {
      this.audit('auth.login-failed', user.tenant, { reason: 'locked', userId: user.id });
      throw new AuthenticationError('This account is temporarily locked after repeated failed sign-ins. Try again later.');
    }
    if (!(await verifyPassword(password, user.passwordHash))) {
      const { locked } = this.st.identity.recordLoginFailure(user.id, MAX_FAILURES, LOCK_MS);
      this.audit('auth.login-failed', user.tenant, { reason: locked ? 'locked-now' : 'bad-password', userId: user.id, ...(opts.ip ? { ip: opts.ip } : {}) });
      throw generic;
    }
    if (this.st.identity.getTenant(user.tenant)?.disabled) throw generic;

    this.st.identity.recordLoginSuccess(user.id);
    const token = randomToken(32);
    const session = this.st.identity.createSession({ id: sha256(token), userId: user.id, tenant: user.tenant, ttlMs: this.sessionTtlMs, ...(opts.ip ? { ip: opts.ip } : {}), ...(opts.userAgent ? { userAgent: opts.userAgent.slice(0, 200) } : {}) });
    this.audit('auth.login', user.tenant, { userId: user.id, ...(opts.ip ? { ip: opts.ip } : {}) }, { type: 'user', id: user.id });
    return {
      token,
      expiresAt: session.expiresAt,
      principal: toPrincipalFromUser(user),
      user: { id: user.id, email: user.email, name: user.name, roles: user.roles, mustChangePassword: user.mustChangePassword },
    };
  }

  authenticateSession(token: string): { principal: Principal; user: UserRecord } | undefined {
    const session = this.st.identity.getSession(sha256(token));
    if (!session || session.expiresAt <= new Date().toISOString()) return undefined;
    const user = this.st.identity.getUser(session.userId);
    if (!user || user.disabled || this.st.identity.getTenant(user.tenant)?.disabled) return undefined;
    this.st.identity.touchSession(session.id);
    return { principal: toPrincipalFromUser(user), user };
  }

  authenticateApiKey(token: string): Principal | undefined {
    const parsed = parseApiKey(token);
    if (!parsed) return undefined;
    const key = this.st.identity.findApiKeyByPrefix(parsed.prefix);
    const a = Buffer.from(sha256(parsed.secret));
    const b = Buffer.from(key?.keyHash ?? sha256('x'));
    if (!key || a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
    const now = new Date().toISOString();
    if (key.revokedAt || (key.expiresAt && key.expiresAt <= now)) return undefined;
    if (this.st.identity.getTenant(key.tenant)?.disabled) return undefined;
    this.st.identity.touchApiKey(key.id);
    return toPrincipalFromKey(key);
  }

  logout(token: string, principal: Principal): void {
    this.st.identity.deleteSession(sha256(token));
    this.audit('auth.logout', principal.tenant, { userId: principal.id }, { type: 'user', id: principal.id });
  }

  async changePassword(userId: string, current: string, next: string): Promise<void> {
    const user = this.st.identity.getUser(userId);
    if (!user?.passwordHash || !(await verifyPassword(current, user.passwordHash))) throw new AuthenticationError('The current password is incorrect');
    checkPasswordPolicy(next, user.email);
    this.st.identity.updateUser(userId, { passwordHash: await hashPassword(next), mustChangePassword: false });
    this.st.identity.deleteUserSessions(userId); // sign out everywhere
    this.st.events.append({ tenant: user.tenant, type: 'auth.user-updated', actor: { type: 'user', id: userId }, data: { userId, change: 'password' } });
  }

  // ------------------------------------------------------------- administration
  async createUser(actor: Principal, u: { email: string; name?: string; password: string; roles: Role[]; tenant?: string; mustChangePassword?: boolean }): Promise<UserRecord> {
    const tenant = u.tenant ?? actor.tenant;
    if (tenant !== actor.tenant && !(actor.roles.includes('admin') && actor.tenant === 'default')) throw new ForbiddenError('You cannot create users in another tenant');
    this.assertRoles(u.roles);
    checkPasswordPolicy(u.password, u.email);
    if (!this.st.identity.getTenant(tenant)) throw new ValidationError('Unknown tenant', [{ path: 'tenant', code: 'UNKNOWN_TENANT', message: `Tenant '${tenant}' does not exist` }]);
    const user = this.st.identity.createUser({ tenant, email: u.email, name: u.name ?? u.email, passwordHash: await hashPassword(u.password), roles: u.roles, ...(u.mustChangePassword ? { mustChangePassword: true } : {}) });
    this.st.events.append({ tenant, type: 'auth.user-created', actor: { type: actor.type, id: actor.id, name: actor.name }, data: { userId: user.id, email: user.email, roles: user.roles } });
    return user;
  }

  /** Operator-initiated reset (break-glass): sets a temporary password, clears any lockout and signs the user out. */
  async resetPassword(actor: Principal, userId: string, password: string): Promise<void> {
    const user = this.st.identity.getUser(userId);
    if (!user) throw new AuthenticationError('User not found');
    checkPasswordPolicy(password, user.email);
    this.st.identity.updateUser(userId, { passwordHash: await hashPassword(password), mustChangePassword: true });
    this.st.identity.recordLoginSuccess(userId);
    this.st.identity.deleteUserSessions(userId);
    this.st.events.append({ tenant: user.tenant, type: 'auth.user-updated', actor: { type: actor.type, id: actor.id, name: actor.name }, data: { userId, change: 'password-reset' } });
  }

  updateUser(actor: Principal, id: string, patch: { name?: string; roles?: Role[]; disabled?: boolean }): UserRecord {
    const user = this.st.identity.getUser(id);
    if (!user || user.tenant !== actor.tenant) throw new AuthenticationError('User not found');
    if (patch.roles) this.assertRoles(patch.roles);
    if (id === actor.id && (patch.disabled === true || (patch.roles && !patch.roles.includes('admin') && user.roles.includes('admin')))) {
      throw new ConflictError('You cannot disable yourself or remove your own admin role');
    }
    this.st.identity.updateUser(id, patch);
    if (patch.disabled) this.st.identity.deleteUserSessions(id);
    this.st.events.append({ tenant: user.tenant, type: 'auth.user-updated', actor: { type: actor.type, id: actor.id, name: actor.name }, data: { userId: id, ...patch } });
    return this.st.identity.getUser(id)!;
  }

  createApiKey(actor: Principal, k: { name: string; roles: Role[]; expiresAt?: string }): { key: string; record: ApiKeyRecord } {
    this.assertRoles(k.roles);
    if (!actor.roles.includes('admin') && k.roles.some((r) => !actor.roles.includes(r))) throw new ForbiddenError('An API key cannot hold roles you do not have');
    const gen = newApiKey();
    const record = this.st.identity.createApiKey({ tenant: actor.tenant, name: k.name, prefix: gen.prefix, keyHash: gen.hash, roles: k.roles, createdBy: actor.id, ...(k.expiresAt ? { expiresAt: k.expiresAt } : {}) });
    this.st.events.append({ tenant: actor.tenant, type: 'auth.apikey-created', actor: { type: actor.type, id: actor.id, name: actor.name }, data: { keyId: record.id, name: k.name, roles: k.roles } });
    return { key: gen.full, record };
  }

  revokeApiKey(actor: Principal, id: string): void {
    const key = this.st.identity.getApiKey(id);
    if (!key || key.tenant !== actor.tenant) throw new AuthenticationError('API key not found');
    this.st.identity.revokeApiKey(id);
    this.st.events.append({ tenant: actor.tenant, type: 'auth.apikey-revoked', actor: { type: actor.type, id: actor.id, name: actor.name }, data: { keyId: id } });
  }

  private assertRoles(roles: Role[]): void {
    for (const r of roles) {
      if (!(ROLES as readonly string[]).includes(r)) throw new ValidationError(`Unknown role '${r}'`, [{ path: 'roles', code: 'UNKNOWN_ROLE', message: `Roles are: ${ROLES.join(', ')}` }]);
    }
    if (roles.length === 0) throw new ValidationError('At least one role is required', [{ path: 'roles', code: 'NO_ROLES', message: 'At least one role is required' }]);
  }
}
