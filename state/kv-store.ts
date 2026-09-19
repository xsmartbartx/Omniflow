import { type Clock, systemClock } from '../core/index.ts';
import { type Db, fromJson } from './database.ts';

export interface CapabilityFlag {
  tenant: string;
  name: string;
  killed: boolean;
  reason?: string;
  updatedAt: string;
  updatedBy: string;
}

export interface ChannelRecord {
  tenant: string;
  name: string;
  type: 'webhook' | 'slack' | 'teams' | 'email';
  config: Record<string, unknown>;
  /** Name of the secret holding the webhook URL / credentials. */
  secretName?: string;
  createdAt: string;
}

/** Tenant "_" holds platform-wide settings and flags. */
export const GLOBAL_TENANT = '_';

/** Small operational stores: settings, capability kill switches, notification channels. */
export class KvStore {
  private readonly db: Db;
  private readonly clock: Clock;

  constructor(db: Db, clock: Clock = systemClock) {
    this.db = db;
    this.clock = clock;
  }

  get<T = unknown>(tenant: string, key: string): T | undefined {
    return fromJson<T>(
      this.db.get<{ value: string }>('SELECT value FROM kv WHERE tenant_id = ? AND key = ?', [tenant, key])?.value,
    );
  }
  set(tenant: string, key: string, value: unknown): void {
    this.db.run(
      `INSERT INTO kv (tenant_id, key, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [tenant, key, JSON.stringify(value), this.clock.now().toISOString()],
    );
  }
  delete(tenant: string, key: string): void {
    this.db.run('DELETE FROM kv WHERE tenant_id = ? AND key = ?', [tenant, key]);
  }

  // ---- capability kill switches (per tenant, or global under tenant "_")
  setCapabilityKilled(tenant: string, name: string, killed: boolean, by: string, reason?: string): void {
    this.db.run(
      `INSERT INTO capability_flags (tenant_id, name, killed, reason, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, name) DO UPDATE SET killed = excluded.killed, reason = excluded.reason,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      [tenant, name, killed ? 1 : 0, killed ? (reason ?? null) : null, this.clock.now().toISOString(), by],
    );
  }
  /** Killed for this tenant or platform-wide. */
  isCapabilityKilled(tenant: string, name: string): { killed: boolean; reason?: string } {
    const r = this.db.get<{ killed: number; reason: string | null }>(
      'SELECT killed, reason FROM capability_flags WHERE name = ? AND tenant_id IN (?, ?) AND killed = 1 LIMIT 1',
      [name, tenant, GLOBAL_TENANT],
    );
    return r ? { killed: true, ...(r.reason ? { reason: r.reason } : {}) } : { killed: false };
  }
  listCapabilityFlags(tenant: string): CapabilityFlag[] {
    return this.db
      .all<{
        tenant_id: string;
        name: string;
        killed: number;
        reason: string | null;
        updated_at: string;
        updated_by: string;
      }>('SELECT * FROM capability_flags WHERE tenant_id IN (?, ?) ORDER BY name', [tenant, GLOBAL_TENANT])
      .map((r) => ({
        tenant: r.tenant_id,
        name: r.name,
        killed: r.killed === 1,
        ...(r.reason ? { reason: r.reason } : {}),
        updatedAt: r.updated_at,
        updatedBy: r.updated_by,
      }));
  }

  // ---- notification channels
  putChannel(c: Omit<ChannelRecord, 'createdAt'>): void {
    this.db.run(
      `INSERT INTO channels (tenant_id, name, type, config, secret_name, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, name) DO UPDATE SET type = excluded.type, config = excluded.config, secret_name = excluded.secret_name`,
      [c.tenant, c.name, c.type, JSON.stringify(c.config), c.secretName ?? null, this.clock.now().toISOString()],
    );
  }
  getChannel(tenant: string, name: string): ChannelRecord | undefined {
    const r = this.db.get<{
      tenant_id: string;
      name: string;
      type: ChannelRecord['type'];
      config: string;
      secret_name: string | null;
      created_at: string;
    }>('SELECT * FROM channels WHERE tenant_id = ? AND name = ?', [tenant, name]);
    return r
      ? {
          tenant: r.tenant_id,
          name: r.name,
          type: r.type,
          config: fromJson(r.config) ?? {},
          ...(r.secret_name ? { secretName: r.secret_name } : {}),
          createdAt: r.created_at,
        }
      : undefined;
  }
  listChannels(tenant: string): ChannelRecord[] {
    return this.db
      .all<{
        tenant_id: string;
        name: string;
        type: ChannelRecord['type'];
        config: string;
        secret_name: string | null;
        created_at: string;
      }>('SELECT * FROM channels WHERE tenant_id = ? ORDER BY name', [tenant])
      .map((r) => ({
        tenant: r.tenant_id,
        name: r.name,
        type: r.type,
        config: fromJson(r.config) ?? {},
        ...(r.secret_name ? { secretName: r.secret_name } : {}),
        createdAt: r.created_at,
      }));
  }
  deleteChannel(tenant: string, name: string): boolean {
    return this.db.run('DELETE FROM channels WHERE tenant_id = ? AND name = ?', [tenant, name]).changes > 0;
  }
}
