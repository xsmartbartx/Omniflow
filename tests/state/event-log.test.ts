import { beforeEach, describe, expect, it } from 'vitest';
import { ValidationError } from '../../core/index.ts';
import { type EventRecord, GENESIS_HASH } from '../../schemas/index.ts';
import { Db } from '../../state/index.ts';
import { makeState, type TestState } from '../helpers/state.ts';

let s: TestState;
beforeEach(() => {
  s = makeState();
});

const runEvt = (data: Record<string, unknown> = {}) => ({
  tenant: 'default',
  type: 'run.queued' as const,
  runId: 'run_1',
  data: { workflow: 'w', version: '1.0.0', planHash: 'sha256:x', ...data },
});

describe('database wrapper', () => {
  it('commits, rolls back, and nests transactions with savepoints', () => {
    const db = new Db(':memory:');
    db.exec('CREATE TABLE t (n INTEGER)');
    db.transaction(() => db.run('INSERT INTO t VALUES (1)'));
    expect(() =>
      db.transaction(() => {
        db.run('INSERT INTO t VALUES (2)');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.all<{ n: number }>('SELECT n FROM t')).toEqual([{ n: 1 }]);

    db.transaction(() => {
      db.run('INSERT INTO t VALUES (3)');
      expect(() =>
        db.transaction(() => {
          db.run('INSERT INTO t VALUES (4)');
          throw new Error('inner');
        }),
      ).toThrow('inner');
      db.run('INSERT INTO t VALUES (5)');
    });
    expect(db.all<{ n: number }>('SELECT n FROM t ORDER BY n').map((r) => r.n)).toEqual([1, 3, 5]);
  });

  it('runs afterCommit callbacks only once the outermost transaction commits', () => {
    const db = new Db(':memory:');
    const seen: string[] = [];
    db.transaction(() => {
      db.afterCommit(() => seen.push('a'));
      expect(seen).toEqual([]);
    });
    expect(seen).toEqual(['a']);
    expect(() =>
      db.transaction(() => {
        db.afterCommit(() => seen.push('lost'));
        throw new Error('x');
      }),
    ).toThrow();
    expect(seen).toEqual(['a']);
    db.afterCommit(() => seen.push('immediate'));
    expect(seen).toEqual(['a', 'immediate']);
  });

  it('applies migrations idempotently', () => {
    const db = new Db(':memory:');
    expect(db.migrate()).toBeGreaterThan(0);
    expect(db.migrate()).toBe(0);
  });
});

describe('event log: schema enforcement', () => {
  it('appends a well-formed event with a hash chain', () => {
    const a = s.events.append(runEvt());
    const b = s.events.append({ tenant: 'default', type: 'run.started', runId: 'run_1' });
    expect(a.seq).toBeLessThan(b.seq);
    expect(a.prevHash).toBe(GENESIS_HASH);
    expect(b.prevHash).toBe(a.hash);
    expect(a.id).toMatch(/^evt_/);
    expect(a.ts).toBe('2026-06-01T12:00:00.000Z');
  });

  it('rejects unknown types, missing run ids and missing required fields', () => {
    expect(() => s.events.append({ tenant: 'default', type: 'made.up' as never })).toThrow(ValidationError);
    expect(() => s.events.append({ tenant: 'default', type: 'run.started' })).toThrow(/requires a runId/);
    expect(() => s.events.append({ tenant: 'default', type: 'run.failed', runId: 'r', data: {} })).toThrow(
      /missing required field 'error'/,
    );
  });

  it('sanitises data before storing it — secrets never reach the log', () => {
    const e = s.events.append({
      tenant: 'default',
      type: 'step.failed',
      runId: 'run_1',
      stepId: 's',
      data: {
        attempt: 1,
        error: { message: 'failed with Authorization: Bearer abcdefghijklmnop and postgres://u:hunter2secret@db/x' },
        headers: { authorization: 'Bearer zzzzzzzzzzzz' },
        password: 'p',
      },
    });
    const stored = JSON.stringify(s.events.list({ tenant: 'default' }));
    expect(stored).not.toMatch(/abcdefghijklmnop|hunter2secret|zzzzzzzzzzzz/);
    expect((e.data as any).password).toBe('[REDACTED]');
  });

  it('truncates oversized payloads but keeps required keys', () => {
    const big = Array.from({ length: 200 }, (_, i) => ({ [`k${i}`]: 'x'.repeat(2000) }));
    const e = s.events.append(runEvt({ blob: big }));
    expect((e.data as any)._truncated).toBe(true);
    expect((e.data as any).workflow).toBe('w');
    expect((e.data as any).blob).toBeUndefined();
  });
});

describe('event log: append-only and tamper-evident (T7)', () => {
  it('refuses UPDATE and DELETE at the database level', () => {
    s.events.append(runEvt());
    expect(() => s.db.run("UPDATE events SET type = 'run.failed'")).toThrow(/append-only/);
    expect(() => s.db.run('DELETE FROM events')).toThrow(/append-only/);
  });

  it('verifies an intact chain', () => {
    for (let i = 0; i < 25; i++) s.events.append(runEvt({ i }));
    expect(s.events.verify('default')).toEqual({ ok: true, checked: 25 });
  });

  it('detects content tampering even by someone who removes the triggers', () => {
    for (let i = 0; i < 5; i++) s.events.append(runEvt({ i }));
    s.db.exec('DROP TRIGGER events_no_update');
    s.db.run(`UPDATE events SET data = '{"workflow":"evil","version":"9","planHash":"x"}' WHERE seq = 3`);
    const v = s.events.verify('default');
    expect(v.ok).toBe(false);
    expect(v.brokenAtSeq).toBe(3);
    expect(v.reason).toMatch(/does not match its hash/);
  });

  it('detects a deleted event as a broken link', () => {
    for (let i = 0; i < 5; i++) s.events.append(runEvt({ i }));
    s.db.exec('DROP TRIGGER events_no_delete');
    s.db.run('DELETE FROM events WHERE seq = 3');
    const v = s.events.verify('default');
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/chain link/);
  });

  it('keeps an independent chain per tenant', () => {
    s.identity.ensureTenant('other', 'Other');
    s.events.append(runEvt());
    s.events.append({ ...runEvt(), tenant: 'other' });
    s.events.append(runEvt());
    expect(s.events.last('other')!.prevHash).toBe(GENESIS_HASH);
    expect(s.events.verify('default').ok).toBe(true);
    expect(s.events.verify('other')).toEqual({ ok: true, checked: 1 });
  });
});

describe('event log: reading and live tailing', () => {
  it('filters by run, step, type and sequence', () => {
    s.events.append(runEvt());
    s.events.append({
      tenant: 'default',
      type: 'step.started',
      runId: 'run_1',
      stepId: 'a',
      attempt: 1,
      data: { attempt: 1 },
    });
    s.events.append({
      tenant: 'default',
      type: 'step.started',
      runId: 'run_2',
      stepId: 'a',
      attempt: 1,
      data: { attempt: 1 },
    });
    expect(s.events.list({ tenant: 'default', runId: 'run_1' })).toHaveLength(2);
    expect(s.events.list({ tenant: 'default', types: ['step.started'] })).toHaveLength(2);
    expect(s.events.list({ tenant: 'default', stepId: 'a', runId: 'run_2' })).toHaveLength(1);
    const all = s.events.list({ tenant: 'default' });
    expect(s.events.list({ tenant: 'default', afterSeq: all[0]!.seq })).toHaveLength(2);
    expect(s.events.list({ tenant: 'default', order: 'desc', limit: 1 })[0]!.seq).toBe(all[2]!.seq);
    expect(s.events.count('default')).toBe(3);
  });

  it('notifies listeners only for committed events', () => {
    const seen: EventRecord[] = [];
    const off = s.events.onAppend((e) => seen.push(e));
    s.events.append(runEvt());
    expect(seen).toHaveLength(1);
    expect(() =>
      s.db.transaction(() => {
        s.events.append(runEvt());
        throw new Error('rollback');
      }),
    ).toThrow();
    expect(seen).toHaveLength(1);
    expect(s.events.count('default')).toBe(1);
    off();
    s.events.append(runEvt());
    expect(seen).toHaveLength(1);
  });

  it('survives a throwing listener', () => {
    s.events.onAppend(() => {
      throw new Error('listener bug');
    });
    expect(() => s.events.append(runEvt())).not.toThrow();
  });
});
