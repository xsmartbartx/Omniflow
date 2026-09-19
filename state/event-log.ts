import { type Clock, contentHash, newId, redact, systemClock, ValidationError } from '../core/index.ts';
import {
  EVENT_CATALOGUE,
  type EventActor,
  type EventRecord,
  type EventType,
  GENESIS_HASH,
  isEventType,
  MAX_EVENT_DATA_BYTES,
  type NewEvent,
} from '../schemas/events.ts';
import { type Db, fromJson, toJson } from './database.ts';

interface Row {
  seq: number;
  id: string;
  tenant_id: string;
  ts: string;
  type: string;
  run_id: string | null;
  step_id: string | null;
  attempt: number | null;
  actor: string | null;
  correlation_id: string | null;
  data: string;
  prev_hash: string;
  hash: string;
}

export interface EventQuery {
  tenant?: string;
  runId?: string;
  stepId?: string;
  types?: readonly string[];
  /** Only events with `seq` greater than this. */
  afterSeq?: number;
  beforeSeq?: number;
  limit?: number;
  order?: 'asc' | 'desc';
}

export interface ChainVerification {
  ok: boolean;
  checked: number;
  /** First event whose hash or link does not verify. */
  brokenAtSeq?: number;
  reason?: string;
}

function toRecord(r: Row): EventRecord {
  const actor = fromJson<EventActor>(r.actor);
  return {
    seq: r.seq,
    id: r.id,
    tenant: r.tenant_id,
    ts: r.ts,
    type: r.type as EventType,
    ...(r.run_id ? { runId: r.run_id } : {}),
    ...(r.step_id ? { stepId: r.step_id } : {}),
    ...(r.attempt !== null ? { attempt: r.attempt } : {}),
    ...(actor ? { actor } : {}),
    ...(r.correlation_id ? { correlationId: r.correlation_id } : {}),
    data: fromJson<Record<string, unknown>>(r.data) ?? {},
    prevHash: r.prev_hash,
    hash: r.hash,
  };
}

function hashOf(e: Omit<EventRecord, 'seq' | 'hash'>): string {
  return contentHash({
    prev: e.prevHash,
    id: e.id,
    tenant: e.tenant,
    ts: e.ts,
    type: e.type,
    runId: e.runId ?? null,
    stepId: e.stepId ?? null,
    attempt: e.attempt ?? null,
    actor: e.actor ?? null,
    correlationId: e.correlationId ?? null,
    data: e.data,
  });
}

/**
 * The audit trail and the replay source (architecture §5.1 #16).
 *
 *  - append-only: enforced by SQLite triggers, not just by this class;
 *  - schema-enforced: unknown types and missing required fields are rejected;
 *  - sanitised: every event is redacted before it is stored, on error paths as well as success;
 *  - tamper-evident: each tenant's events form a hash chain (threat T7).
 */
export class EventLog {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly listeners = new Set<(e: EventRecord) => void>();

  constructor(db: Db, clock: Clock = systemClock) {
    this.db = db;
    this.clock = clock;
  }

  /** Subscribe to committed events (used for live tailing). Returns an unsubscribe function. */
  onAppend(listener: (e: EventRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  append(evt: NewEvent): EventRecord {
    if (!isEventType(evt.type)) {
      throw new ValidationError(`Unknown event type '${String(evt.type)}'`, [
        { path: 'type', code: 'UNKNOWN_EVENT_TYPE', message: `'${String(evt.type)}' is not in the event catalogue` },
      ]);
    }
    const spec = EVENT_CATALOGUE[evt.type];
    if (spec.run && !evt.runId) {
      throw new ValidationError(`Event '${evt.type}' requires a runId`, [
        { path: 'runId', code: 'MISSING_RUN_ID', message: 'runId is required for run events' },
      ]);
    }
    const raw = evt.data ?? {};
    for (const key of spec.required) {
      if (!(key in raw)) {
        throw new ValidationError(`Event '${evt.type}' is missing required field '${key}'`, [
          { path: `data.${key}`, code: 'MISSING_EVENT_FIELD', message: `'${key}' is required` },
        ]);
      }
    }

    let data = redact(raw) as Record<string, unknown>;
    if (Buffer.byteLength(JSON.stringify(data), 'utf8') > MAX_EVENT_DATA_BYTES) {
      const kept: Record<string, unknown> = {};
      for (const key of spec.required) kept[key] = data[key];
      data = {
        ...kept,
        _truncated: true,
        _droppedKeys: Object.keys(data).filter((k) => !(k in kept)),
        _note: 'Payload exceeded the event size limit; store large data as an artifact and reference it by hash.',
      };
    }

    const tenant = evt.tenant;
    return this.db.transaction(() => {
      const last = this.db.get<{ hash: string }>(
        'SELECT hash FROM events WHERE tenant_id = ? ORDER BY seq DESC LIMIT 1',
        [tenant],
      );
      const base: Omit<EventRecord, 'seq' | 'hash'> = {
        id: newId('evt'),
        tenant,
        ts: this.clock.now().toISOString(),
        type: evt.type,
        ...(evt.runId ? { runId: evt.runId } : {}),
        ...(evt.stepId ? { stepId: evt.stepId } : {}),
        ...(evt.attempt !== undefined ? { attempt: evt.attempt } : {}),
        ...(evt.actor ? { actor: evt.actor } : {}),
        ...(evt.correlationId ? { correlationId: evt.correlationId } : {}),
        data,
        prevHash: last?.hash ?? GENESIS_HASH,
      };
      const hash = hashOf(base);
      const res = this.db.run(
        `INSERT INTO events (id, tenant_id, ts, type, run_id, step_id, attempt, actor, correlation_id, data, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          base.id,
          tenant,
          base.ts,
          base.type,
          base.runId ?? null,
          base.stepId ?? null,
          base.attempt ?? null,
          toJson(base.actor),
          base.correlationId ?? null,
          JSON.stringify(data),
          base.prevHash,
          hash,
        ],
      );
      const record: EventRecord = { ...base, seq: res.lastInsertRowid, hash };
      this.db.afterCommit(() => {
        for (const l of this.listeners) {
          try {
            l(record);
          } catch {
            /* a faulty listener must never break the write path */
          }
        }
      });
      return record;
    });
  }

  appendMany(events: NewEvent[]): EventRecord[] {
    return this.db.transaction(() => events.map((e) => this.append(e)));
  }

  list(q: EventQuery = {}): EventRecord[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (q.tenant) {
      where.push('tenant_id = ?');
      params.push(q.tenant);
    }
    if (q.runId) {
      where.push('run_id = ?');
      params.push(q.runId);
    }
    if (q.stepId) {
      where.push('step_id = ?');
      params.push(q.stepId);
    }
    if (q.types?.length) {
      where.push(`type IN (${q.types.map(() => '?').join(',')})`);
      params.push(...q.types);
    }
    if (q.afterSeq !== undefined) {
      where.push('seq > ?');
      params.push(q.afterSeq);
    }
    if (q.beforeSeq !== undefined) {
      where.push('seq < ?');
      params.push(q.beforeSeq);
    }
    const order = q.order === 'desc' ? 'DESC' : 'ASC';
    const limit = Math.min(Math.max(q.limit ?? 500, 1), 5000);
    const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq ${order} LIMIT ${limit}`;
    return this.db.all<Row>(sql, params).map(toRecord);
  }

  last(tenant: string): EventRecord | undefined {
    const r = this.db.get<Row>('SELECT * FROM events WHERE tenant_id = ? ORDER BY seq DESC LIMIT 1', [tenant]);
    return r ? toRecord(r) : undefined;
  }

  count(tenant: string): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM events WHERE tenant_id = ?', [tenant])?.n ?? 0;
  }

  /** Recompute and check the whole hash chain for a tenant. */
  verify(tenant: string): ChainVerification {
    let prev = GENESIS_HASH;
    let checked = 0;
    let afterSeq = 0;
    for (;;) {
      const batch = this.db.all<Row>(
        'SELECT * FROM events WHERE tenant_id = ? AND seq > ? ORDER BY seq ASC LIMIT 1000',
        [tenant, afterSeq],
      );
      if (batch.length === 0) break;
      for (const row of batch) {
        const rec = toRecord(row);
        if (rec.prevHash !== prev) {
          return { ok: false, checked, brokenAtSeq: rec.seq, reason: 'chain link does not match the previous event' };
        }
        const { seq: _seq, hash, ...rest } = rec;
        if (hashOf(rest) !== hash) {
          return { ok: false, checked, brokenAtSeq: rec.seq, reason: 'event content does not match its hash' };
        }
        prev = hash;
        checked++;
        afterSeq = rec.seq;
      }
    }
    return { ok: true, checked };
  }
}
