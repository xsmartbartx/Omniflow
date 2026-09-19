import { type Clock, ConflictError, newId, systemClock } from '../core/index.ts';
import type { Role } from '../schemas/index.ts';
import { type Db, fromJson } from './database.ts';

export interface TenantRecord {
  id: string;
  name: string;
  createdAt: string;
  disabled: boolean;
}

export interface UserRecord {
  id: string;
  tenant: string;
  email: string;
  name: string;
  passwordHash?: string;
  roles: Role[];
  disabled: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  lastLoginAt?: string;
  failedLogins: number;
  lockedUntil?: string;
}

export interface ApiKeyRecord {
  id: string;
  tenant: string;
  name: string;
  /** Public, indexed part of the key (`omf_<prefix>_<secret>`). */
  prefix: string;
  keyHash: string;
  roles: Role[];
  createdBy: string;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface SessionRecord {
  id: string;
  userId: string;
  tenant: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  ip?: string;
  userAgent?: string;
}

interface TRow {
  id: string;
  name: string;
  created_at: string;
  disabled: number;
}
interface URow {
  id: string;
  tenant_id: string;
  email: string;
  name: string;
  password_hash: string | null;
  roles: string;
  disabled: number;
  must_change_password: number;
  created_at: string;
  last_login_at: string | null;
  failed_logins: number;
  locked_until: string | null;
}
interface KRow {
  id: string;
  tenant_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  roles: string;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}
interface SRow {
  id: string;
  user_id: string;
  tenant_id: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  ip: string | null;
  user_agent: string | null;
}

const toTenant = (r: TRow): TenantRecord => ({
  id: r.id,
  name: r.name,
  createdAt: r.created_at,
  disabled: r.disabled === 1,
});
const toUser = (r: URow): UserRecord => ({
  id: r.id,
  tenant: r.tenant_id,
  email: r.email,
  name: r.name,
  ...(r.password_hash ? { passwordHash: r.password_hash } : {}),
  roles: fromJson<Role[]>(r.roles) ?? [],
  disabled: r.disabled === 1,
  mustChangePassword: r.must_change_password === 1,
  createdAt: r.created_at,
  ...(r.last_login_at ? { lastLoginAt: r.last_login_at } : {}),
  failedLogins: r.failed_logins,
  ...(r.locked_until ? { lockedUntil: r.locked_until } : {}),
});
const toKey = (r: KRow): ApiKeyRecord => ({
  id: r.id,
  tenant: r.tenant_id,
  name: r.name,
  prefix: r.key_prefix,
  keyHash: r.key_hash,
  roles: fromJson<Role[]>(r.roles) ?? [],
  createdBy: r.created_by,
  createdAt: r.created_at,
  ...(r.expires_at ? { expiresAt: r.expires_at } : {}),
  ...(r.last_used_at ? { lastUsedAt: r.last_used_at } : {}),
  ...(r.revoked_at ? { revokedAt: r.revoked_at } : {}),
});
const toSession = (r: SRow): SessionRecord => ({
  id: r.id,
  userId: r.user_id,
  tenant: r.tenant_id,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  lastSeenAt: r.last_seen_at,
  ...(r.ip ? { ip: r.ip } : {}),
  ...(r.user_agent ? { userAgent: r.user_agent } : {}),
});

/** Tenants, users, API keys and sessions. Password and key hashing live in the Gateway. */
export class IdentityStore {
  private readonly db: Db;
  private readonly clock: Clock;

  constructor(db: Db, clock: Clock = systemClock) {
    this.db = db;
    this.clock = clock;
  }

  private now(): string {
    return this.clock.now().toISOString();
  }

  // ---- tenants
  createTenant(id: string, name: string): TenantRecord {
    if (this.getTenant(id)) throw new ConflictError(`Tenant '${id}' already exists`);
    this.db.run('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)', [id, name, this.now()]);
    return this.getTenant(id)!;
  }
  ensureTenant(id: string, name: string): TenantRecord {
    return this.getTenant(id) ?? this.createTenant(id, name);
  }
  getTenant(id: string): TenantRecord | undefined {
    const r = this.db.get<TRow>('SELECT * FROM tenants WHERE id = ?', [id]);
    return r ? toTenant(r) : undefined;
  }
  listTenants(): TenantRecord[] {
    return this.db.all<TRow>('SELECT * FROM tenants ORDER BY created_at').map(toTenant);
  }
  setTenantDisabled(id: string, disabled: boolean): void {
    this.db.run('UPDATE tenants SET disabled = ? WHERE id = ?', [disabled ? 1 : 0, id]);
  }

  // ---- users
  createUser(u: {
    tenant: string;
    email: string;
    name: string;
    passwordHash?: string;
    roles: Role[];
    mustChangePassword?: boolean;
  }): UserRecord {
    const email = u.email.trim().toLowerCase();
    if (this.getUserByEmail(u.tenant, email)) throw new ConflictError(`A user with email '${email}' already exists`);
    const id = newId('usr');
    this.db.run(
      `INSERT INTO users (id, tenant_id, email, name, password_hash, roles, must_change_password, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        u.tenant,
        email,
        u.name,
        u.passwordHash ?? null,
        JSON.stringify(u.roles),
        u.mustChangePassword ? 1 : 0,
        this.now(),
      ],
    );
    return this.getUser(id)!;
  }
  getUser(id: string): UserRecord | undefined {
    const r = this.db.get<URow>('SELECT * FROM users WHERE id = ?', [id]);
    return r ? toUser(r) : undefined;
  }
  getUserByEmail(tenant: string, email: string): UserRecord | undefined {
    const r = this.db.get<URow>('SELECT * FROM users WHERE tenant_id = ? AND email = ?', [
      tenant,
      email.trim().toLowerCase(),
    ]);
    return r ? toUser(r) : undefined;
  }
  /** Find a user by email across tenants (login). Returns all matches so the caller can require a tenant when ambiguous. */
  findUsersByEmail(email: string): UserRecord[] {
    return this.db.all<URow>('SELECT * FROM users WHERE email = ?', [email.trim().toLowerCase()]).map(toUser);
  }
  listUsers(tenant: string): UserRecord[] {
    return this.db.all<URow>('SELECT * FROM users WHERE tenant_id = ? ORDER BY email', [tenant]).map(toUser);
  }
  countUsers(): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0;
  }
  updateUser(
    id: string,
    patch: { name?: string; roles?: Role[]; disabled?: boolean; passwordHash?: string; mustChangePassword?: boolean },
  ): void {
    this.db.run(
      `UPDATE users SET name = COALESCE(?, name), roles = COALESCE(?, roles), disabled = COALESCE(?, disabled),
         password_hash = COALESCE(?, password_hash), must_change_password = COALESCE(?, must_change_password) WHERE id = ?`,
      [
        patch.name ?? null,
        patch.roles ? JSON.stringify(patch.roles) : null,
        patch.disabled === undefined ? null : patch.disabled ? 1 : 0,
        patch.passwordHash ?? null,
        patch.mustChangePassword === undefined ? null : patch.mustChangePassword ? 1 : 0,
        id,
      ],
    );
  }
  recordLoginSuccess(id: string): void {
    this.db.run('UPDATE users SET last_login_at = ?, failed_logins = 0, locked_until = NULL WHERE id = ?', [
      this.now(),
      id,
    ]);
  }
  /** Increment the failure counter; lock the account for `lockMs` after `maxFailures`. */
  recordLoginFailure(id: string, maxFailures: number, lockMs: number): { locked: boolean } {
    return this.db.transaction(() => {
      this.db.run('UPDATE users SET failed_logins = failed_logins + 1 WHERE id = ?', [id]);
      const u = this.getUser(id)!;
      if (u.failedLogins >= maxFailures) {
        this.db.run('UPDATE users SET locked_until = ?, failed_logins = 0 WHERE id = ?', [
          new Date(this.clock.now().getTime() + lockMs).toISOString(),
          id,
        ]);
        return { locked: true };
      }
      return { locked: false };
    });
  }

  // ---- API keys
  createApiKey(k: {
    tenant: string;
    name: string;
    prefix: string;
    keyHash: string;
    roles: Role[];
    createdBy: string;
    expiresAt?: string;
  }): ApiKeyRecord {
    const id = newId('key');
    this.db.run(
      `INSERT INTO api_keys (id, tenant_id, name, key_prefix, key_hash, roles, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        k.tenant,
        k.name,
        k.prefix,
        k.keyHash,
        JSON.stringify(k.roles),
        k.createdBy,
        this.now(),
        k.expiresAt ?? null,
      ],
    );
    return this.getApiKey(id)!;
  }
  getApiKey(id: string): ApiKeyRecord | undefined {
    const r = this.db.get<KRow>('SELECT * FROM api_keys WHERE id = ?', [id]);
    return r ? toKey(r) : undefined;
  }
  findApiKeyByPrefix(prefix: string): ApiKeyRecord | undefined {
    const r = this.db.get<KRow>('SELECT * FROM api_keys WHERE key_prefix = ?', [prefix]);
    return r ? toKey(r) : undefined;
  }
  listApiKeys(tenant: string): ApiKeyRecord[] {
    return this.db
      .all<KRow>('SELECT * FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC', [tenant])
      .map(toKey);
  }
  revokeApiKey(id: string): void {
    this.db.run('UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?', [this.now(), id]);
  }
  touchApiKey(id: string): void {
    this.db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [this.now(), id]);
  }

  // ---- sessions (the id is a hash of the bearer token; the token itself is never stored)
  createSession(s: {
    id: string;
    userId: string;
    tenant: string;
    ttlMs: number;
    ip?: string;
    userAgent?: string;
  }): SessionRecord {
    const now = this.clock.now();
    this.db.run(
      `INSERT INTO sessions (id, user_id, tenant_id, created_at, expires_at, last_seen_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        s.id,
        s.userId,
        s.tenant,
        now.toISOString(),
        new Date(now.getTime() + s.ttlMs).toISOString(),
        now.toISOString(),
        s.ip ?? null,
        s.userAgent ?? null,
      ],
    );
    return this.getSession(s.id)!;
  }
  getSession(id: string): SessionRecord | undefined {
    const r = this.db.get<SRow>('SELECT * FROM sessions WHERE id = ?', [id]);
    return r ? toSession(r) : undefined;
  }
  touchSession(id: string): void {
    this.db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [this.now(), id]);
  }
  deleteSession(id: string): void {
    this.db.run('DELETE FROM sessions WHERE id = ?', [id]);
  }
  deleteUserSessions(userId: string): void {
    this.db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
  }
  purgeExpiredSessions(): number {
    return this.db.run('DELETE FROM sessions WHERE expires_at <= ?', [this.now()]).changes;
  }
}
