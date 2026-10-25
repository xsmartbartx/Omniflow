import { type Clock, newId, systemClock } from '../core/index.ts';
import type { Db } from './database.ts';

export type DeliveryStatus = 'pending' | 'delivered' | 'failed';

export interface Delivery {
  id: string;
  tenant: string;
  hookId: string;
  eventSeq: number;
  eventType: string;
  runId?: string;
  payload: Record<string, unknown>;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: string;
  lastStatus?: number;
  lastError?: string;
  createdAt: string;
  deliveredAt?: string;
}

interface Row {
  id: string;
  tenant_id: string;
  hook_id: string;
  event_seq: number;
  event_type: string;
  run_id: string | null;
  payload: string;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: string;
  last_status: number | null;
  last_error: string | null;
  created_at: string;
  delivered_at: string | null;
}

const toDelivery = (r: Row): Delivery => ({
  id: r.id,
  tenant: r.tenant_id,
  hookId: r.hook_id,
  eventSeq: r.event_seq,
  eventType: r.event_type,
  ...(r.run_id ? { runId: r.run_id } : {}),
  payload: JSON.parse(r.payload) as Record<string, unknown>,
  status: r.status,
  attempts: r.attempts,
  nextAttemptAt: r.next_attempt_at,
  ...(r.last_status !== null ? { lastStatus: r.last_status } : {}),
  ...(r.last_error ? { lastError: r.last_error } : {}),
  createdAt: r.created_at,
  ...(r.delivered_at ? { deliveredAt: r.delivered_at } : {}),
});

/** Persistence for outbound webhook deliveries (migration 3). */
export class WebhookStore {
  private readonly db: Db;
  private readonly clock: Clock;

  constructor(db: Db, clock: Clock = systemClock) {
    this.db = db;
    this.clock = clock;
  }

  private now(): string {
    return this.clock.now().toISOString();
  }

  /** Idempotent per (hook, event): returns false if the delivery already exists. */
  enqueue(d: {
    tenant: string;
    hookId: string;
    eventSeq: number;
    eventType: string;
    runId?: string;
    payload: Record<string, unknown>;
  }): boolean {
    const now = this.now();
    const r = this.db.run(
      `INSERT OR IGNORE INTO webhook_deliveries
        (id, tenant_id, hook_id, event_seq, event_type, run_id, payload, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId('whd'), d.tenant, d.hookId, d.eventSeq, d.eventType, d.runId ?? null, JSON.stringify(d.payload), now, now],
    );
    return r.changes > 0;
  }

  due(limit = 50): Delivery[] {
    return this.db
      .all<Row>(
        `SELECT * FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY event_seq LIMIT ?`,
        [this.now(), limit],
      )
      .map(toDelivery);
  }

  markDelivered(id: string, httpStatus: number): void {
    this.db.run(
      `UPDATE webhook_deliveries SET status = 'delivered', attempts = attempts + 1, last_status = ?, last_error = NULL, delivered_at = ? WHERE id = ?`,
      [httpStatus, this.now(), id],
    );
  }

  markRetry(id: string, retryInMs: number, error: string, httpStatus?: number): void {
    this.db.run(
      `UPDATE webhook_deliveries SET attempts = attempts + 1, last_status = ?, last_error = ?, next_attempt_at = ? WHERE id = ?`,
      [httpStatus ?? null, error.slice(0, 300), new Date(this.clock.now().getTime() + retryInMs).toISOString(), id],
    );
  }

  markFailed(id: string, error: string, httpStatus?: number): void {
    this.db.run(
      `UPDATE webhook_deliveries SET status = 'failed', attempts = attempts + 1, last_status = ?, last_error = ? WHERE id = ?`,
      [httpStatus ?? null, error.slice(0, 300), id],
    );
  }

  list(tenant: string, limit = 100): Delivery[] {
    return this.db
      .all<Row>('SELECT * FROM webhook_deliveries WHERE tenant_id = ? ORDER BY event_seq DESC LIMIT ?', [tenant, limit])
      .map(toDelivery);
  }

  /** Delete deliveries that finished (delivered, or given up) before `cutoff`; pending ones are never touched. */
  pruneFinished(cutoff: string): number {
    return this.db.run(`DELETE FROM webhook_deliveries WHERE status != 'pending' AND created_at < ?`, [cutoff]).changes;
  }

  counts(): { pending: number; delivered: number; failed: number } {
    const rows = this.db.all<{ status: DeliveryStatus; n: number }>(
      'SELECT status, COUNT(*) AS n FROM webhook_deliveries GROUP BY status',
    );
    const out = { pending: 0, delivered: 0, failed: 0 };
    for (const r of rows) out[r.status] = Number(r.n);
    return out;
  }
}
