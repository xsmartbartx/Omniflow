import { type Clock, newId, systemClock } from '../core/index.ts';
import { type Db, fromJson } from './database.ts';

export interface TriggerRecord {
  id: string;
  tenant: string;
  workflowName: string;
  workflowVersion: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  lastFiredAt?: string;
  nextFireAt?: string;
}

interface Row {
  id: string;
  tenant_id: string;
  workflow_name: string;
  workflow_version: string;
  name: string;
  type: string;
  config: string;
  enabled: number;
  created_at: string;
  last_fired_at: string | null;
  next_fire_at: string | null;
}

const toRecord = (r: Row): TriggerRecord => ({
  id: r.id,
  tenant: r.tenant_id,
  workflowName: r.workflow_name,
  workflowVersion: r.workflow_version,
  name: r.name,
  type: r.type,
  config: fromJson(r.config) ?? {},
  enabled: r.enabled === 1,
  createdAt: r.created_at,
  ...(r.last_fired_at ? { lastFiredAt: r.last_fired_at } : {}),
  ...(r.next_fire_at ? { nextFireAt: r.next_fire_at } : {}),
});

/** Owns schedules, event subscriptions and webhook endpoints (architecture §5.1 #8). */
export class TriggerStore {
  private readonly db: Db;
  private readonly clock: Clock;

  constructor(db: Db, clock: Clock = systemClock) {
    this.db = db;
    this.clock = clock;
  }

  /** Replace every trigger of a workflow with those declared by its active version, preserving fire history. */
  replaceForWorkflow(
    tenant: string,
    workflow: string,
    version: string,
    triggers: Array<{ name: string; type: string; config: Record<string, unknown>; nextFireAt?: string }>,
  ): TriggerRecord[] {
    return this.db.transaction(() => {
      const existing = new Map(this.listForWorkflow(tenant, workflow).map((t) => [t.name, t]));
      const keep = new Set(triggers.map((t) => t.name));
      for (const t of existing.values()) {
        if (!keep.has(t.name)) this.db.run('DELETE FROM triggers WHERE id = ?', [t.id]);
      }
      const now = this.clock.now().toISOString();
      for (const t of triggers) {
        const cur = existing.get(t.name);
        if (cur) {
          this.db.run(`UPDATE triggers SET workflow_version = ?, type = ?, config = ?, next_fire_at = ? WHERE id = ?`, [
            version,
            t.type,
            JSON.stringify(t.config),
            t.nextFireAt ?? null,
            cur.id,
          ]);
        } else {
          this.db.run(
            `INSERT INTO triggers (id, tenant_id, workflow_name, workflow_version, name, type, config, created_at, next_fire_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              newId('trg'),
              tenant,
              workflow,
              version,
              t.name,
              t.type,
              JSON.stringify(t.config),
              now,
              t.nextFireAt ?? null,
            ],
          );
        }
      }
      return this.listForWorkflow(tenant, workflow);
    });
  }

  removeForWorkflow(tenant: string, workflow: string): void {
    this.db.run('DELETE FROM triggers WHERE tenant_id = ? AND workflow_name = ?', [tenant, workflow]);
  }

  get(id: string): TriggerRecord | undefined {
    const r = this.db.get<Row>('SELECT * FROM triggers WHERE id = ?', [id]);
    return r ? toRecord(r) : undefined;
  }

  find(tenant: string, workflow: string, name: string): TriggerRecord | undefined {
    const r = this.db.get<Row>('SELECT * FROM triggers WHERE tenant_id = ? AND workflow_name = ? AND name = ?', [
      tenant,
      workflow,
      name,
    ]);
    return r ? toRecord(r) : undefined;
  }

  listForWorkflow(tenant: string, workflow: string): TriggerRecord[] {
    return this.db
      .all<Row>('SELECT * FROM triggers WHERE tenant_id = ? AND workflow_name = ? ORDER BY name', [tenant, workflow])
      .map(toRecord);
  }

  list(tenant: string): TriggerRecord[] {
    return this.db
      .all<Row>('SELECT * FROM triggers WHERE tenant_id = ? ORDER BY workflow_name, name', [tenant])
      .map(toRecord);
  }

  listByType(type: string, enabledOnly = true): TriggerRecord[] {
    return this.db
      .all<Row>(`SELECT * FROM triggers WHERE type = ? ${enabledOnly ? 'AND enabled = 1' : ''}`, [type])
      .map(toRecord);
  }

  /** Event triggers subscribed to `eventType` for a tenant. */
  eventSubscribers(tenant: string, eventType: string): TriggerRecord[] {
    return this.listByType('event').filter((t) => t.tenant === tenant && t.config.event === eventType);
  }

  completionSubscribers(tenant: string, workflow: string): TriggerRecord[] {
    return this.listByType('workflow-completion').filter((t) => t.tenant === tenant && t.config.workflow === workflow);
  }

  dueSchedules(nowIso: string): TriggerRecord[] {
    return this.db
      .all<Row>(
        `SELECT * FROM triggers WHERE type = 'schedule' AND enabled = 1 AND next_fire_at IS NOT NULL AND next_fire_at <= ? ORDER BY next_fire_at`,
        [nowIso],
      )
      .map(toRecord);
  }

  patch(id: string, p: { enabled?: boolean; lastFiredAt?: string; nextFireAt?: string | null }): void {
    this.db.run(
      `UPDATE triggers SET enabled = COALESCE(?, enabled), last_fired_at = COALESCE(?, last_fired_at),
         next_fire_at = CASE WHEN ? = 1 THEN ? ELSE next_fire_at END WHERE id = ?`,
      [
        p.enabled === undefined ? null : p.enabled ? 1 : 0,
        p.lastFiredAt ?? null,
        p.nextFireAt === undefined ? 0 : 1,
        p.nextFireAt ?? null,
        id,
      ],
    );
  }

  /** Register a firing exactly once. Returns `false` when this fire key was already recorded (duplicate delivery). */
  recordFire(triggerId: string, fireKey: string, runId?: string): boolean {
    const res = this.db.run(
      'INSERT OR IGNORE INTO trigger_fires (trigger_id, fire_key, run_id, fired_at) VALUES (?, ?, ?, ?)',
      [triggerId, fireKey, runId ?? null, this.clock.now().toISOString()],
    );
    return res.changes === 1;
  }

  attachRunToFire(triggerId: string, fireKey: string, runId: string): void {
    this.db.run('UPDATE trigger_fires SET run_id = ? WHERE trigger_id = ? AND fire_key = ?', [
      runId,
      triggerId,
      fireKey,
    ]);
  }

  /** Remember a webhook nonce; `false` means it was seen before (replay). */
  useNonce(tenant: string, nonce: string, ttlMs: number): boolean {
    const res = this.db.run('INSERT OR IGNORE INTO webhook_nonces (tenant_id, nonce, expires_at) VALUES (?, ?, ?)', [
      tenant,
      nonce,
      new Date(this.clock.now().getTime() + ttlMs).toISOString(),
    ]);
    return res.changes === 1;
  }

  purge(): void {
    const now = this.clock.now();
    this.db.run('DELETE FROM webhook_nonces WHERE expires_at <= ?', [now.toISOString()]);
    this.db.run('DELETE FROM trigger_fires WHERE fired_at < ?', [
      new Date(now.getTime() - 30 * 86_400_000).toISOString(),
    ]);
  }
}
