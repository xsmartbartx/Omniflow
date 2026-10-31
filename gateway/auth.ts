import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import {
  AuthenticationError,
  ConflictError,
  ForbiddenError,
  type Logger,
  nullLogger,
  randomToken,
  ValidationError,
} from '../core/index.ts';
import type { Principal, Role } from '../schemas/index.ts';
import { ROLES } from '../schemas/index.ts';
import type { ApiKeyRecord, State, TokenKind, UserRecord } from '../state/index.ts';

const scrypt = promisify(scryptCb) as (
  pw: string,
  salt: Buffer,
  len: number,
  opts: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MIN_PASSWORD = 12;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;
/** A mailed link (password reset, email verification) works for this long, once. */
const TOKEN_TTL_MS = 30 * 60_000;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function checkPasswordPolicy(password: string, email?: string): void {
  const problems: string[] = [];
  if (password.length < MIN_PASSWORD) problems.push(`at least ${MIN_PASSWORD} characters`);
  if (password.length > 256) problems.push('at most 256 characters');
  if (email && password.toLowerCase().includes(email.split('@')[0]!.toLowerCase()) && email.split('@')[0]!.length > 3)
    problems.push('must not contain your email name');
  if (/^(.)\1+$/.test(password) || /^(password|123456|qwerty|letmein)/i.test(password))
    problems.push('is too easy to guess');
  if (problems.length > 0) {
    throw new ValidationError(`Password ${problems.join(', ')}`, [
      { path: 'password', code: 'WEAK_PASSWORD', message: `Password ${problems.join(', ')}` },
    ]);
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

const toPrincipalFromUser = (u: UserRecord): Principal => ({
  id: u.id,
  type: 'user',
  name: u.email,
  tenant: u.tenant,
  roles: u.roles,
});
const toPrincipalFromKey = (k: ApiKeyRecord): Principal => ({
  id: k.id,
  type: 'api-key',
  name: k.name,
  tenant: k.tenant,
  roles: k.roles,
});

/** A single-use token to put in an email, with who it is for. */
export interface MailedToken {
  to: string;
  name: string;
  token: string;
  expiresInMinutes: number;
}

/** Gateway authentication: sessions for people, API keys for machines. Authorisation is the Policy Engine's job. */
export class Authenticator {
  private readonly st: State;
  private readonly sessionTtlMs: number;
  private readonly log: Logger;
  private dummyHash: Promise<string> | undefined;
  /** Extra per-request check on a session's tenant (NEXORA: is the org still active). */
  tenantGuard: ((tenant: string) => boolean) | undefined;

  constructor(state: State, opts: { sessionTtlHours: number; log?: Logger }) {
    this.st = state;
    this.sessionTtlMs = opts.sessionTtlHours * 3_600_000;
    this.log = opts.log ?? nullLogger;
  }

  private audit(
    type: 'auth.login' | 'auth.login-failed' | 'auth.logout',
    tenant: string,
    data: Record<string, unknown>,
    actor?: { type: string; id: string },
  ): void {
    this.st.events.append({ tenant, type, ...(actor ? { actor } : {}), data });
  }

  /** Sign-in for an account that does not exist (or cannot sign in): spend the same time as a real check, then fail. */
  private async rejectUnknownUser(
    password: string,
    matches: number,
    opts: { tenant?: string; ip?: string },
  ): Promise<never> {
    this.dummyHash ??= hashPassword('not-a-real-password');
    await verifyPassword(password, await this.dummyHash);
    this.audit('auth.login-failed', opts.tenant ?? 'default', {
      reason: matches > 1 ? 'ambiguous' : 'unknown-or-disabled',
      ...(opts.ip ? { ip: opts.ip } : {}),
    });
    throw new AuthenticationError('Invalid email or password');
  }

  async login(
    email: string,
    password: string,
    opts: { tenant?: string; ip?: string; userAgent?: string } = {},
  ): Promise<LoginResult> {
    const generic = new AuthenticationError('Invalid email or password');
    const candidates = this.st.identity.findUsersByEmail(email).filter((u) => !opts.tenant || u.tenant === opts.tenant);
    const user = candidates.length === 1 ? candidates[0] : undefined;

    // Always burn the same amount of time, whether or not the account exists.
    if (!user || user.disabled || !user.passwordHash) return this.rejectUnknownUser(password, candidates.length, opts);
    if (user.lockedUntil && user.lockedUntil > new Date().toISOString()) {
      this.audit('auth.login-failed', user.tenant, { reason: 'locked', userId: user.id });
      throw new AuthenticationError(
        'This account is temporarily locked after repeated failed sign-ins. Try again later.',
      );
    }
    if (!(await verifyPassword(password, user.passwordHash))) {
      const { locked } = this.st.identity.recordLoginFailure(user.id, MAX_FAILURES, LOCK_MS);
      this.audit('auth.login-failed', user.tenant, {
        reason: locked ? 'locked-now' : 'bad-password',
        userId: user.id,
        ...(opts.ip ? { ip: opts.ip } : {}),
      });
      throw generic;
    }
    if (this.st.identity.getTenant(user.tenant)?.disabled) throw generic;
    // only after the password is right, so this cannot be used to learn which addresses have accounts
    if (user.emailUnverified)
      throw new AuthenticationError('Confirm your email address first: we sent you a link when you signed up.');

    this.st.identity.recordLoginSuccess(user.id);
    const token = randomToken(32);
    const session = this.st.identity.createSession({
      id: sha256(token),
      userId: user.id,
      tenant: user.tenant,
      ttlMs: this.sessionTtlMs,
      ...(opts.ip ? { ip: opts.ip } : {}),
      ...(opts.userAgent ? { userAgent: opts.userAgent.slice(0, 200) } : {}),
    });
    this.audit(
      'auth.login',
      user.tenant,
      { userId: user.id, ...(opts.ip ? { ip: opts.ip } : {}) },
      { type: 'user', id: user.id },
    );
    return {
      token,
      expiresAt: session.expiresAt,
      principal: toPrincipalFromUser(user),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        roles: user.roles,
        mustChangePassword: user.mustChangePassword,
      },
    };
  }

  /** Start a session for a user who was authenticated elsewhere (NEXORA SSO). The caller sets the cookie. */
  issueSession(
    user: UserRecord,
    ttlMs: number,
    opts: { ip?: string; userAgent?: string } = {},
  ): { token: string; expiresAt: string } {
    const token = randomToken(32);
    const session = this.st.identity.createSession({
      id: sha256(token),
      userId: user.id,
      tenant: user.tenant,
      ttlMs,
      ...(opts.ip ? { ip: opts.ip } : {}),
      ...(opts.userAgent ? { userAgent: opts.userAgent.slice(0, 200) } : {}),
    });
    this.audit(
      'auth.login',
      user.tenant,
      { userId: user.id, sso: 'nexora', ...(opts.ip ? { ip: opts.ip } : {}) },
      { type: 'user', id: user.id },
    );
    return { token, expiresAt: session.expiresAt };
  }

  authenticateSession(token: string): { principal: Principal; user: UserRecord } | undefined {
    const session = this.st.identity.getSession(sha256(token));
    if (!session || session.expiresAt <= new Date().toISOString()) return undefined;
    const user = this.st.identity.getUser(session.userId);
    if (!user || user.disabled || this.st.identity.getTenant(user.tenant)?.disabled) return undefined;
    if (this.tenantGuard && !this.tenantGuard(user.tenant)) return undefined;
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
    if (!user?.passwordHash || !(await verifyPassword(current, user.passwordHash)))
      throw new AuthenticationError('The current password is incorrect');
    checkPasswordPolicy(next, user.email);
    this.st.identity.updateUser(userId, { passwordHash: await hashPassword(next), mustChangePassword: false });
    this.st.identity.deleteUserSessions(userId); // sign out everywhere
    this.st.events.append({
      tenant: user.tenant,
      type: 'auth.user-updated',
      actor: { type: 'user', id: userId },
      data: { userId, change: 'password' },
    });
  }

  /**
   * Start a password reset. Returns the token to mail out, or undefined when there is nothing to send (no such account,
   * disabled, or ambiguous): the caller answers the same either way so the form cannot be used to find accounts.
   */
  requestPasswordReset(email: string): MailedToken | undefined {
    const matches = this.st.identity.findUsersByEmail(email.trim());
    const user = matches.length === 1 ? matches[0] : undefined;
    if (!user || user.disabled || !user.passwordHash) return undefined;
    const mailed = this.issueToken('password-reset', user.id, user.email, user.name);
    this.st.events.append({
      tenant: user.tenant,
      type: 'auth.user-updated',
      actor: { type: 'user', id: user.id },
      data: { userId: user.id, change: 'password-reset-requested' },
    });
    return mailed;
  }

  /** Finish a reset with the mailed token: new password, every session ended, any lockout cleared. */
  async completePasswordReset(token: string, next: string): Promise<void> {
    const invalid = new AuthenticationError('This reset link is invalid or has expired. Request a new one.');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const owner = this.st.identity.peekToken('password-reset', tokenHash);
    const user = owner ? this.st.identity.getUser(owner) : undefined;
    if (!user || user.disabled) throw invalid;
    // check the password before redeeming, so a weak one does not use up the link
    checkPasswordPolicy(next, user.email);
    const passwordHash = await hashPassword(next);
    if (this.st.identity.consumeToken('password-reset', tokenHash) !== user.id) throw invalid;
    this.st.identity.updateUser(user.id, { passwordHash, mustChangePassword: false });
    this.st.identity.recordLoginSuccess(user.id);
    this.st.identity.deleteUserSessions(user.id);
    this.st.events.append({
      tenant: user.tenant,
      type: 'auth.user-updated',
      actor: { type: 'user', id: user.id },
      data: { userId: user.id, change: 'password-reset' },
    });
  }

  // ------------------------------------------------------------- administration
  async createUser(
    actor: Principal,
    u: { email: string; name?: string; password: string; roles: Role[]; tenant?: string; mustChangePassword?: boolean },
  ): Promise<UserRecord> {
    const tenant = u.tenant ?? actor.tenant;
    if (tenant !== actor.tenant && !(actor.roles.includes('admin') && actor.tenant === 'default'))
      throw new ForbiddenError('You cannot create users in another tenant');
    this.assertRoles(u.roles);
    checkPasswordPolicy(u.password, u.email);
    if (!this.st.identity.getTenant(tenant))
      throw new ValidationError('Unknown tenant', [
        { path: 'tenant', code: 'UNKNOWN_TENANT', message: `Tenant '${tenant}' does not exist` },
      ]);
    const user = this.st.identity.createUser({
      tenant,
      email: u.email,
      name: u.name ?? u.email,
      passwordHash: await hashPassword(u.password),
      roles: u.roles,
      ...(u.mustChangePassword ? { mustChangePassword: true } : {}),
    });
    this.st.events.append({
      tenant,
      type: 'auth.user-created',
      actor: { type: actor.type, id: actor.id, name: actor.name },
      data: { userId: user.id, email: user.email, roles: user.roles },
    });
    return user;
  }

  /**
   * Self-serve account creation: a new tenant of its own with the sign-up as its administrator, then a normal sign-in.
   * Email addresses are unique across tenants (sign-in looks users up by email), and the number of tenants is capped.
   */
  async signUp(
    u: { email: string; password: string; name?: string; organization?: string },
    opts: {
      maxTenants: number;
      accepted?: { termsUrl?: string; privacyUrl?: string };
      /** Hold the account until the email address is confirmed: the result is a link to mail, not a session. */
      verifyEmail?: boolean;
      ip?: string;
      userAgent?: string;
    },
  ): Promise<LoginResult | { verify: MailedToken }> {
    const email = u.email.trim();
    checkPasswordPolicy(u.password, email);
    if (this.st.identity.findUsersByEmail(email).length > 0)
      throw new ConflictError('An account with this email already exists. Sign in instead.');
    // the operator's own tenant does not count against the cap
    if (this.st.identity.listTenants().length - 1 >= opts.maxTenants)
      throw new ForbiddenError('New accounts are not being accepted right now.');
    const passwordHash = await hashPassword(u.password);
    const tenant = `acct-${randomToken(6)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, 'x')}`;
    const name = u.name?.trim() || email;
    const userId = this.st.db.transaction(() => {
      this.st.identity.createTenant(tenant, u.organization?.trim() || `${name}'s workspace`);
      const user = this.st.identity.createUser({
        tenant,
        email,
        name,
        passwordHash,
        roles: ['admin'],
        ...(opts.verifyEmail ? { emailUnverified: true } : {}),
      });
      this.st.events.append({
        tenant,
        type: 'auth.user-created',
        actor: { type: 'system', id: 'system:signup', name: 'self-serve sign-up' },
        data: {
          userId: user.id,
          email: user.email,
          roles: user.roles,
          selfServe: true,
          ...(opts.verifyEmail ? { emailVerification: 'pending' } : {}),
          // what the person agreed to, and when (the event's own timestamp), so consent can be shown later
          ...(opts.accepted ? { accepted: opts.accepted } : {}),
        },
      });
      return user.id;
    });
    if (opts.verifyEmail) return { verify: this.issueToken('email-verification', userId, email, name) };
    return this.login(email, u.password, {
      tenant,
      ...(opts.ip ? { ip: opts.ip } : {}),
      ...(opts.userAgent ? { userAgent: opts.userAgent } : {}),
    });
  }

  /** Make a single-use token for a user, store its hash, and hand back what the caller needs to mail it. */
  private issueToken(kind: TokenKind, userId: string, to: string, name: string): MailedToken {
    const token = randomToken(32);
    this.st.identity.createToken(
      kind,
      userId,
      createHash('sha256').update(token).digest('hex'),
      new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
    );
    return { to, name, token, expiresInMinutes: TOKEN_TTL_MS / 60_000 };
  }

  /** A fresh verification link for an unconfirmed account; undefined (and nothing to send) for any other address. */
  resendEmailVerification(email: string): MailedToken | undefined {
    const matches = this.st.identity.findUsersByEmail(email.trim());
    const user = matches.length === 1 ? matches[0] : undefined;
    if (!user?.emailUnverified || user.disabled) return undefined;
    return this.issueToken('email-verification', user.id, user.email, user.name);
  }

  /** Confirm an email address with the mailed token. */
  verifyEmail(token: string): void {
    const userId = this.st.identity.consumeToken(
      'email-verification',
      createHash('sha256').update(token).digest('hex'),
    );
    const user = userId ? this.st.identity.getUser(userId) : undefined;
    if (!user) throw new AuthenticationError('This confirmation link is invalid or has expired. Request a new one.');
    this.st.identity.markEmailVerified(user.id);
    this.st.events.append({
      tenant: user.tenant,
      type: 'auth.user-updated',
      actor: { type: 'user', id: user.id },
      data: { userId: user.id, change: 'email-verified' },
    });
  }

  /** Operator-initiated reset (break-glass): sets a temporary password, clears any lockout and signs the user out. */
  async resetPassword(actor: Principal, userId: string, password: string): Promise<void> {
    const user = this.st.identity.getUser(userId);
    if (!user) throw new AuthenticationError('User not found');
    checkPasswordPolicy(password, user.email);
    this.st.identity.updateUser(userId, { passwordHash: await hashPassword(password), mustChangePassword: true });
    this.st.identity.recordLoginSuccess(userId);
    this.st.identity.deleteUserSessions(userId);
    this.st.events.append({
      tenant: user.tenant,
      type: 'auth.user-updated',
      actor: { type: actor.type, id: actor.id, name: actor.name },
      data: { userId, change: 'password-reset' },
    });
  }

  updateUser(actor: Principal, id: string, patch: { name?: string; roles?: Role[]; disabled?: boolean }): UserRecord {
    const user = this.st.identity.getUser(id);
    if (user?.tenant !== actor.tenant) throw new AuthenticationError('User not found');
    if (patch.roles) this.assertRoles(patch.roles);
    if (
      id === actor.id &&
      (patch.disabled === true || (patch.roles && !patch.roles.includes('admin') && user.roles.includes('admin')))
    ) {
      throw new ConflictError('You cannot disable yourself or remove your own admin role');
    }
    this.st.identity.updateUser(id, patch);
    if (patch.disabled) this.st.identity.deleteUserSessions(id);
    this.st.events.append({
      tenant: user.tenant,
      type: 'auth.user-updated',
      actor: { type: actor.type, id: actor.id, name: actor.name },
      data: { userId: id, ...patch },
    });
    return this.st.identity.getUser(id)!;
  }

  createApiKey(
    actor: Principal,
    k: { name: string; roles: Role[]; expiresAt?: string },
  ): { key: string; record: ApiKeyRecord } {
    this.assertRoles(k.roles);
    if (!actor.roles.includes('admin') && k.roles.some((r) => !actor.roles.includes(r)))
      throw new ForbiddenError('An API key cannot hold roles you do not have');
    const gen = newApiKey();
    const record = this.st.identity.createApiKey({
      tenant: actor.tenant,
      name: k.name,
      prefix: gen.prefix,
      keyHash: gen.hash,
      roles: k.roles,
      createdBy: actor.id,
      ...(k.expiresAt ? { expiresAt: k.expiresAt } : {}),
    });
    this.st.events.append({
      tenant: actor.tenant,
      type: 'auth.apikey-created',
      actor: { type: actor.type, id: actor.id, name: actor.name },
      data: { keyId: record.id, name: k.name, roles: k.roles },
    });
    return { key: gen.full, record };
  }

  revokeApiKey(actor: Principal, id: string): void {
    const key = this.st.identity.getApiKey(id);
    if (key?.tenant !== actor.tenant) throw new AuthenticationError('API key not found');
    this.st.identity.revokeApiKey(id);
    this.st.events.append({
      tenant: actor.tenant,
      type: 'auth.apikey-revoked',
      actor: { type: actor.type, id: actor.id, name: actor.name },
      data: { keyId: id },
    });
  }

  private assertRoles(roles: Role[]): void {
    for (const r of roles) {
      if (!(ROLES as readonly string[]).includes(r))
        throw new ValidationError(`Unknown role '${r}'`, [
          { path: 'roles', code: 'UNKNOWN_ROLE', message: `Roles are: ${ROLES.join(', ')}` },
        ]);
    }
    if (roles.length === 0)
      throw new ValidationError('At least one role is required', [
        { path: 'roles', code: 'NO_ROLES', message: 'At least one role is required' },
      ]);
  }
}
