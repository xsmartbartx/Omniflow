import type { Clock } from '../core/index.ts';
import { systemClock } from '../core/index.ts';
import type { Db } from './database.ts';

export type NexoraPlan = 'free' | 'starter' | 'pro' | 'business' | 'scale';
export type NexoraOrgStatus = 'active' | 'suspended' | 'disabled';
export type NexoraRole = 'owner' | 'admin' | 'member' | 'billing' | 'viewer';
export type OutboxKind = 'usage' | 'audit' | 'health';

export interface NexoraOrg {
  orgId: string;
  tenant: string;
  plan: NexoraPlan;
  status: NexoraOrgStatus;
  planSyncedAt?: string;
}

export interface NexoraIdentity {
  orgId: string;
  externalUserId: string;
  tenant: string;
  userId: string;
  role: NexoraRole;
}

export interface EntitlementRow {
  orgId: string;
  action: string;
  allowed: boolean;
  remaining: number | null;
  limit: number | null;
  fetchedAt: string;
  expiresAt: string;
}

export interface OutboxItem {
  id: string;
  tenant: string;
  orgId: string;
  kind: OutboxKind;
  name: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  correlationId?: string;
  occurredAt: string;
  attempts: number;
}

interface OrgRow {
  org_id: string;
  tenant_id: string;
  plan: NexoraPlan;
  status: NexoraOrgStatus;
  plan_synced_at: string | null;
}
interface IdRow {
  org_id: string;
  external_user_id: string;
  tenant_id: string;
  user_id: string;
  nexora_role: NexoraRole;
}
interface EntRow {
  org_id: string;
  action: string;
  allowed: number;
  remaining: number | null;
  limit_total: number | null;
  fetched_at: string;
  expires_at: string;
}
interface OutRow {
  id: string;
  tenant_id: string;
  org_id: string;
  kind: OutboxKind;
  name: string;
  payload: string;
  idempotency_key: string;
  correlation_id: string | null;
  occurred_at: string;
  attempts: number;
}

const toOrg = (r: OrgRow): NexoraOrg => ({
  orgId: r.org_id,
  tenant: r.tenant_id,
  plan: r.plan,
  status: r.status,
  ...(r.plan_synced_at ? { planSyncedAt: r.plan_synced_at } : {}),
});

/**
 * Persistence for the NEXORA integration (migration 2). Every method that returns tenant data is keyed by
 * the org or tenant it was asked about; nothing lists across orgs except the outbox and cache sweeps the
 * worker needs.
 */
export class NexoraStore {
  private readonly db: Db;
  private readonly clock: Clock;

  constructor(db: Db, clock: Clock = systemClock) {
    this.db = db;
    this.clock = clock;
  }

  private now(): string {
    return this.clock.now().toISOString();
  }

  // ---- orgs
  getOrg(orgId: string): NexoraOrg | undefined {
    const r = this.db.get<OrgRow>('SELECT * FROM nexora_orgs WHERE org_id = ?', [orgId]);
    return r ? toOrg(r) : undefined;
  }
  getOrgByTenant(tenant: string): NexoraOrg | undefined {
    const r = this.db.get<OrgRow>('SELECT * FROM nexora_orgs WHERE tenant_id = ?', [tenant]);
    return r ? toOrg(r) : undefined;
  }
  listOrgs(): NexoraOrg[] {
    return this.db.all<OrgRow>('SELECT * FROM nexora_orgs ORDER BY created_at').map(toOrg);
  }
  insertOrg(orgId: string, tenant: string, plan: NexoraPlan): NexoraOrg {
    const now = this.now();
    this.db.run(
      'INSERT INTO nexora_orgs (org_id, tenant_id, plan, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [orgId, tenant, plan, 'active', now, now],
    );
    return this.getOrg(orgId)!;
  }
  setPlan(orgId: string, plan: NexoraPlan): void {
    const now = this.now();
    this.db.run('UPDATE nexora_orgs SET plan = ?, plan_synced_at = ?, updated_at = ? WHERE org_id = ?', [
      plan,
      now,
      now,
      orgId,
    ]);
  }
  setStatus(orgId: string, status: NexoraOrgStatus): void {
    this.db.run('UPDATE nexora_orgs SET status = ?, updated_at = ? WHERE org_id = ?', [status, this.now(), orgId]);
  }

  // ---- identities
  getIdentity(orgId: string, externalUserId: string): NexoraIdentity | undefined {
    const r = this.db.get<IdRow>('SELECT * FROM nexora_identities WHERE org_id = ? AND external_user_id = ?', [
      orgId,
      externalUserId,
    ]);
    return r ? this.toIdentity(r) : undefined;
  }
  getIdentityByUser(userId: string): NexoraIdentity | undefined {
    const r = this.db.get<IdRow>('SELECT * FROM nexora_identities WHERE user_id = ?', [userId]);
    return r ? this.toIdentity(r) : undefined;
  }
  upsertIdentity(i: NexoraIdentity): void {
    const now = this.now();
    this.db.run(
      `INSERT INTO nexora_identities (org_id, external_user_id, tenant_id, user_id, nexora_role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (org_id, external_user_id) DO UPDATE SET nexora_role = excluded.nexora_role, updated_at = excluded.updated_at`,
      [i.orgId, i.externalUserId, i.tenant, i.userId, i.role, now, now],
    );
  }
  private toIdentity(r: IdRow): NexoraIdentity {
    return {
      orgId: r.org_id,
      externalUserId: r.external_user_id,
      tenant: r.tenant_id,
      userId: r.user_id,
      role: r.nexora_role,
    };
  }

  // ---- entitlement cache
  getEntitlement(orgId: string, action: string): EntitlementRow | undefined {
    const r = this.db.get<EntRow>('SELECT * FROM nexora_entitlement_cache WHERE org_id = ? AND action = ?', [
      orgId,
      action,
    ]);
    return r
      ? {
          orgId: r.org_id,
          action: r.action,
          allowed: r.allowed === 1,
          remaining: r.remaining,
          limit: r.limit_total,
          fetchedAt: r.fetched_at,
          expiresAt: r.expires_at,
        }
      : undefined;
  }
  putEntitlement(e: Omit<EntitlementRow, 'fetchedAt' | 'expiresAt'>, ttlMs: number): void {
    const now = this.clock.now();
    this.db.run(
      `INSERT INTO nexora_entitlement_cache (org_id, action, allowed, remaining, limit_total, fetched_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (org_id, action) DO UPDATE SET allowed = excluded.allowed, remaining = excluded.remaining,
         limit_total = excluded.limit_total, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
      [
        e.orgId,
        e.action,
        e.allowed ? 1 : 0,
        e.remaining,
        e.limit,
        now.toISOString(),
        new Date(now.getTime() + ttlMs).toISOString(),
      ],
    );
  }
  /** Reserve one unit locally so concurrent admissions cannot all spend the last one. */
  consumeUnit(orgId: string, action: string): void {
    this.db.run(
      'UPDATE nexora_entitlement_cache SET remaining = remaining - 1 WHERE org_id = ? AND action = ? AND remaining IS NOT NULL AND remaining > 0',
      [orgId, action],
    );
  }
  expiredEntitlementOrgs(action: string): string[] {
    return this.db
      .all<{ org_id: string }>('SELECT org_id FROM nexora_entitlement_cache WHERE action = ? AND expires_at <= ?', [
        action,
        this.now(),
      ])
      .map((r) => r.org_id);
  }

  // ---- outbox
  /** Idempotent: a second enqueue with the same key is ignored. Returns whether a row was written. */
  enqueue(item: Omit<OutboxItem, 'attempts'>): boolean {
    const r = this.db.run(
      `INSERT OR IGNORE INTO nexora_outbox
        (id, tenant_id, org_id, kind, name, payload, idempotency_key, correlation_id, occurred_at, attempts, next_attempt_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        item.id,
        item.tenant,
        item.orgId,
        item.kind,
        item.name,
        JSON.stringify(item.payload),
        item.idempotencyKey,
        item.correlationId ?? null,
        item.occurredAt,
        item.occurredAt,
      ],
    );
    return r.changes > 0;
  }
  dueOutbox(limit = 50): OutboxItem[] {
    return this.db
      .all<OutRow>(
        'SELECT * FROM nexora_outbox WHERE sent_at IS NULL AND next_attempt_at <= ? ORDER BY occurred_at LIMIT ?',
        [this.now(), limit],
      )
      .map((r) => ({
        id: r.id,
        tenant: r.tenant_id,
        orgId: r.org_id,
        kind: r.kind,
        name: r.name,
        payload: JSON.parse(r.payload) as Record<string, unknown>,
        idempotencyKey: r.idempotency_key,
        ...(r.correlation_id ? { correlationId: r.correlation_id } : {}),
        occurredAt: r.occurred_at,
        attempts: r.attempts,
      }));
  }
  /** Delete outbox rows that were delivered before `cutoff`; unsent rows are never touched. */
  pruneSent(cutoff: string): number {
    return this.db.run('DELETE FROM nexora_outbox WHERE sent_at IS NOT NULL AND sent_at < ?', [cutoff]).changes;
  }
  markSent(id: string): void {
    this.db.run('UPDATE nexora_outbox SET sent_at = ?, last_error = NULL WHERE id = ?', [this.now(), id]);
  }
  markFailed(id: string, error: string, retryInMs: number): void {
    this.db.run('UPDATE nexora_outbox SET attempts = attempts + 1, last_error = ?, next_attempt_at = ? WHERE id = ?', [
      error.slice(0, 500),
      new Date(this.clock.now().getTime() + retryInMs).toISOString(),
      id,
    ]);
  }
  outboxStats(): { pending: number; sent: number } {
    const r = this.db.get<{ pending: number; sent: number }>(
      'SELECT SUM(sent_at IS NULL) AS pending, SUM(sent_at IS NOT NULL) AS sent FROM nexora_outbox',
    );
    return { pending: Number(r?.pending ?? 0), sent: Number(r?.sent ?? 0) };
  }

  // ---- usage
  /** Real (non-dry) runs created for a tenant in the UTC calendar month containing `at`. */
  runsInMonth(tenant: string, at: Date): number {
    const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString();
    const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)).toISOString();
    const r = this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM runs WHERE tenant_id = ? AND dry_run = 0 AND created_at >= ? AND created_at < ?',
      [tenant, start, end],
    );
    return Number(r?.n ?? 0);
  }
}
