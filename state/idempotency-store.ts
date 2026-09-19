import { type Clock, systemClock } from '../core/index.ts';
import { type Db, fromJson } from './database.ts';

export type ClaimResult =
  /** This caller now owns the key and may perform the effect. */
  | { state: 'claimed'; reclaimed: boolean }
  /** The effect already happened; return this output instead of performing it again. */
  | { state: 'replay'; output: unknown }
  /** Another live owner is performing the effect right now. */
  | { state: 'busy'; owner: string };

interface Row {
  state: 'in-progress' | 'succeeded';
  owner: string;
  output: string | null;
  updated_at: string;
  expires_at: string;
}

/**
 * The idempotency ledger (ADR-0002 D3): the mechanism that turns at-least-once execution into
 * effectively-once for effectful capabilities. A key is *claimed* before the effect, *completed*
 * with the output after it, and *released* if the attempt failed. A retry after a crash between
 * "effect happened" and "result persisted" finds the completed key and replays the recorded
 * output instead of performing the effect a second time.
 */
export class IdempotencyStore {
  private readonly db: Db;
  private readonly clock: Clock;

  constructor(db: Db, clock: Clock = systemClock) {
    this.db = db;
    this.clock = clock;
  }

  /**
   * @param owner   `runId/stepId` of the claimant. The same owner may re-claim its own in-progress key
   *                (crash recovery); a different owner must wait until it completes or expires.
   * @param leaseMs how long an in-progress claim is honoured before it is considered abandoned
   * @param ttlMs   how long a completed key is remembered
   */
  claim(tenant: string, capability: string, key: string, owner: string, leaseMs: number, ttlMs = 7 * 86_400_000): ClaimResult {
    return this.db.transaction(() => {
      const now = this.clock.now();
      const nowIso = now.toISOString();
      const row = this.db.get<Row>(
        'SELECT state, owner, output, updated_at, expires_at FROM idempotency WHERE tenant_id = ? AND capability = ? AND key = ?',
        [tenant, capability, key],
      );
      if (row) {
        const expired = row.expires_at <= nowIso;
        if (row.state === 'succeeded' && !expired) return { state: 'replay', output: fromJson(row.output) ?? null } as const;
        if (row.state === 'in-progress' && !expired && row.owner !== owner) return { state: 'busy', owner: row.owner } as const;
        // expired (either kind) or our own abandoned claim → take it over
        this.db.run(
          `UPDATE idempotency SET state = 'in-progress', owner = ?, output = NULL, updated_at = ?, expires_at = ?
           WHERE tenant_id = ? AND capability = ? AND key = ?`,
          [owner, nowIso, new Date(now.getTime() + leaseMs).toISOString(), tenant, capability, key],
        );
        return { state: 'claimed', reclaimed: true } as const;
      }
      this.db.run(
        `INSERT INTO idempotency (tenant_id, capability, key, state, owner, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, 'in-progress', ?, ?, ?, ?)`,
        [tenant, capability, key, owner, nowIso, nowIso, new Date(now.getTime() + leaseMs).toISOString()],
      );
      void ttlMs;
      return { state: 'claimed', reclaimed: false } as const;
    });
  }

  /** Record the successful outcome so that any later attempt replays it. */
  complete(tenant: string, capability: string, key: string, owner: string, output: unknown, ttlMs = 7 * 86_400_000): void {
    const now = this.clock.now();
    this.db.run(
      `UPDATE idempotency SET state = 'succeeded', output = ?, updated_at = ?, expires_at = ?
       WHERE tenant_id = ? AND capability = ? AND key = ? AND owner = ?`,
      [
        JSON.stringify(output ?? null),
        now.toISOString(),
        new Date(now.getTime() + ttlMs).toISOString(),
        tenant,
        capability,
        key,
        owner,
      ],
    );
  }

  /** The attempt failed: free the key so a retry may perform the effect. */
  release(tenant: string, capability: string, key: string, owner: string): void {
    this.db.run(
      `DELETE FROM idempotency WHERE tenant_id = ? AND capability = ? AND key = ? AND owner = ? AND state = 'in-progress'`,
      [tenant, capability, key, owner],
    );
  }

  peek(tenant: string, capability: string, key: string): { state: string; owner: string; output?: unknown } | undefined {
    const r = this.db.get<Row>(
      'SELECT state, owner, output, updated_at, expires_at FROM idempotency WHERE tenant_id = ? AND capability = ? AND key = ?',
      [tenant, capability, key],
    );
    return r ? { state: r.state, owner: r.owner, ...(r.output !== null ? { output: fromJson(r.output) } : {}) } : undefined;
  }

  purgeExpired(): number {
    return this.db.run('DELETE FROM idempotency WHERE expires_at <= ?', [this.clock.now().toISOString()]).changes;
  }
}
