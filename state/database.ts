import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { MIGRATIONS } from './migrations.ts';

export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlParams = readonly SqlValue[];

/**
 * Thin, synchronous wrapper over Node's built-in SQLite. The state plane is deliberately
 * synchronous: every state transition is one short transaction, which is what makes the run state
 * machine easy to reason about and crash-safe (checkpoint after each step).
 */
export class Db {
  readonly raw: DatabaseSync;
  readonly path: string;
  private readonly cache = new Map<string, StatementSync>();
  private depth = 0;
  private afterCommitQueue: Array<() => void> = [];

  constructor(path: string) {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA synchronous = NORMAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 10000');
    this.raw.exec('PRAGMA trusted_schema = OFF');
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  run(sql: string, params: SqlParams = []): { changes: number; lastInsertRowid: number } {
    const r = this.stmt(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get<T = Record<string, unknown>>(sql: string, params: SqlParams = []): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, params: SqlParams = []): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  /**
   * Run `fn` atomically. Nested calls join the outer transaction (via savepoints so an inner
   * failure rolls back only the inner work). `fn` must be synchronous.
   */
  transaction<T>(fn: () => T): T {
    if (this.depth === 0) {
      this.raw.exec('BEGIN IMMEDIATE');
      this.depth = 1;
      try {
        const result = fn();
        this.raw.exec('COMMIT');
        this.depth = 0;
        const queue = this.afterCommitQueue;
        this.afterCommitQueue = [];
        for (const cb of queue) cb();
        return result;
      } catch (e) {
        try {
          this.raw.exec('ROLLBACK');
        } catch {
          /* already rolled back */
        }
        this.afterCommitQueue = [];
        throw e;
      } finally {
        this.depth = 0;
      }
    }
    const name = `sp_${this.depth++}`;
    this.raw.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      this.raw.exec(`RELEASE ${name}`);
      return result;
    } catch (e) {
      this.raw.exec(`ROLLBACK TO ${name}`);
      this.raw.exec(`RELEASE ${name}`);
      throw e;
    } finally {
      this.depth--;
    }
  }

  /** Run `fn` once the outermost transaction commits (immediately if none is open). Dropped on rollback. */
  afterCommit(fn: () => void): void {
    if (this.depth === 0) fn();
    else this.afterCommitQueue.push(fn);
  }

  migrate(): number {
    this.exec(
      'CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
    );
    const applied = new Set(this.all<{ id: number }>('SELECT id FROM _migrations').map((r) => r.id));
    let count = 0;
    for (const m of MIGRATIONS) {
      if (applied.has(m.id)) continue;
      this.transaction(() => {
        this.exec(m.sql);
        this.run('INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)', [
          m.id,
          m.name,
          new Date().toISOString(),
        ]);
      });
      count++;
    }
    return count;
  }

  /** Consistent online backup of the whole database into `destination` (must not exist). */
  backupTo(destination: string): void {
    mkdirSync(dirname(destination), { recursive: true });
    this.raw.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`);
  }

  checkpoint(): void {
    this.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  close(): void {
    this.cache.clear();
    this.raw.close();
  }
}

export const toJson = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));
export function fromJson<T>(s: unknown): T | undefined {
  if (typeof s !== 'string' || s === '') return undefined;
  return JSON.parse(s) as T;
}
