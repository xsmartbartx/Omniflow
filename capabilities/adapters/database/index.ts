import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import type { CapabilityDeclaration } from '../../../schemas/index.ts';
import { type CapabilityAdapter, CapabilityError } from '../../contract/types.ts';
import type { AdapterConfig } from '../config.ts';

export type Row = Record<string, unknown>;
export interface QueryResult {
  rows: Row[];
  rowCount: number;
  truncated: boolean;
}
export interface CommandResult {
  rows: Row[];
  rowCount: number;
  /** True when the idempotency key was already applied, so nothing was executed. */
  duplicate: boolean;
}

/** Driver abstraction so PostgreSQL and SQLite share one capability surface (and tests can inject fakes). */
export interface DbDriver {
  query(sql: string, params: SqlParam[], o: { maxRows: number; timeoutMs: number }): Promise<QueryResult>;
  command(
    sql: string,
    params: SqlParam[],
    o: { idempotencyKey?: string | undefined; timeoutMs: number },
  ): Promise<CommandResult>;
  close(): Promise<void>;
}
export type SqlParam = string | number | boolean | null;

export interface PgLike {
  connect(): Promise<{
    query(q: unknown, v?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>;
    release(): void;
  }>;
  end(): Promise<void>;
}
export type PgFactory = (connectionString: string) => PgLike;

const defaultPgFactory: PgFactory = (connectionString) =>
  new pg.Pool({
    connectionString,
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  }) as unknown as PgLike;

const IDEMPOTENCY_DDL =
  'CREATE TABLE IF NOT EXISTS omniflow_idempotency (key TEXT PRIMARY KEY, created_at TEXT NOT NULL)';

function clean(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] =
      typeof v === 'bigint'
        ? Number.isSafeInteger(Number(v))
          ? Number(v)
          : v.toString()
        : v instanceof Date
          ? v.toISOString()
          : v instanceof Uint8Array
            ? Buffer.from(v).toString('base64')
            : v;
  }
  return out;
}

function sqliteDriver(path: string): DbDriver {
  mkdirSync(dirname(path), { recursive: true });
  return {
    async query(sql, params, { maxRows }) {
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        const rows = db.prepare(sql).all(...params.map(toSqlite)) as Row[];
        return { rows: rows.slice(0, maxRows).map(clean), rowCount: rows.length, truncated: rows.length > maxRows };
      } finally {
        db.close();
      }
    },
    async command(sql, params, { idempotencyKey }) {
      const db = new DatabaseSync(path);
      try {
        db.exec('BEGIN IMMEDIATE');
        try {
          if (idempotencyKey) {
            db.exec(IDEMPOTENCY_DDL);
            const res = db
              .prepare('INSERT OR IGNORE INTO omniflow_idempotency (key, created_at) VALUES (?, ?)')
              .run(idempotencyKey, new Date().toISOString());
            if (Number(res.changes) === 0) {
              db.exec('ROLLBACK');
              return { rows: [], rowCount: 0, duplicate: true };
            }
          }
          const stmt = db.prepare(sql);
          let rows: Row[] = [];
          let rowCount: number;
          if (stmt.columns().length > 0) {
            rows = stmt.all(...params.map(toSqlite)) as Row[];
            rowCount = rows.length;
          } else {
            rowCount = Number(stmt.run(...params.map(toSqlite)).changes);
          }
          db.exec('COMMIT');
          return { rows: rows.map(clean), rowCount, duplicate: false };
        } catch (e) {
          try {
            db.exec('ROLLBACK');
          } catch {
            /* already rolled back */
          }
          throw e;
        }
      } finally {
        db.close();
      }
    },
    async close() {},
  };
}

const toSqlite = (p: SqlParam) => (typeof p === 'boolean' ? (p ? 1 : 0) : p);

function postgresDriver(url: string, factory: PgFactory): DbDriver {
  const pool = factory(url);
  return {
    async query(sql, params, { maxRows, timeoutMs }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN READ ONLY');
        await client.query(`SET LOCAL statement_timeout = ${Math.max(100, Math.floor(timeoutMs))}`);
        const res = await client.query({ text: sql, values: params });
        await client.query('ROLLBACK');
        return {
          rows: res.rows.slice(0, maxRows).map(clean),
          rowCount: res.rows.length,
          truncated: res.rows.length > maxRows,
        };
      } catch (e) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* connection may be broken */
        }
        throw e;
      } finally {
        client.release();
      }
    },
    async command(sql, params, { idempotencyKey, timeoutMs }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL statement_timeout = ${Math.max(100, Math.floor(timeoutMs))}`);
        if (idempotencyKey) {
          await client.query(IDEMPOTENCY_DDL);
          const ins = await client.query(
            'INSERT INTO omniflow_idempotency (key, created_at) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
            [idempotencyKey, new Date().toISOString()],
          );
          if ((ins.rowCount ?? 0) === 0) {
            await client.query('ROLLBACK');
            return { rows: [], rowCount: 0, duplicate: true };
          }
        }
        const res = await client.query({ text: sql, values: params });
        await client.query('COMMIT');
        return { rows: (res.rows ?? []).map(clean), rowCount: res.rowCount ?? 0, duplicate: false };
      } catch (e) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* connection may be broken */
        }
        throw e;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

/** Map driver errors onto the failure taxonomy. */
function classify(e: unknown): CapabilityError {
  if (e instanceof CapabilityError) return e;
  const err = e as { code?: string; message?: string };
  const code = String(err.code ?? '');
  const msg = (err.message ?? 'database error').slice(0, 300);
  if (
    [
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      '57P01',
      '57P03',
      '08006',
      '08001',
      '53300',
      '40001',
      '40P01',
      '55P03',
      '57014',
    ].includes(code) ||
    /timeout|SQLITE_BUSY|SQLITE_LOCKED/i.test(msg)
  ) {
    return new CapabilityError(code === '57014' ? 'DB_TIMEOUT' : 'DB_UNAVAILABLE', msg, {
      errorClass: 'transient',
      retryable: true,
      details: { code },
    });
  }
  if (code.startsWith('28') || code === '42501')
    return new CapabilityError('DB_PERMISSION', msg, { errorClass: 'authorisation', retryable: false });
  if (code.startsWith('23') || /constraint/i.test(msg))
    return new CapabilityError('DB_CONSTRAINT', msg, { errorClass: 'business', retryable: false, details: { code } });
  return new CapabilityError('DB_ERROR', msg, { errorClass: 'contract', retryable: false, details: { code } });
}

const SINGLE_STATEMENT = /^[^;]*;?\s*$/;
const READ_ONLY_START = /^\s*(\/\*[\s\S]*?\*\/\s*)*(select|with|values|explain|show|pragma\s+table_info)\b/i;

const failureModes = [
  {
    code: 'DB_UNAVAILABLE',
    class: 'transient' as const,
    retryable: true,
    description: 'Connection failed, deadlock or serialisation failure',
  },
  { code: 'DB_TIMEOUT', class: 'transient' as const, retryable: true },
  { code: 'DB_PERMISSION', class: 'authorisation' as const, retryable: false },
  {
    code: 'DB_CONSTRAINT',
    class: 'business' as const,
    retryable: false,
    description: 'A constraint rejected the change',
  },
  { code: 'DB_ERROR', class: 'contract' as const, retryable: false, description: 'The statement is invalid' },
  { code: 'DB_UNKNOWN_DATASOURCE', class: 'contract' as const, retryable: false },
  { code: 'DB_INVALID_STATEMENT', class: 'contract' as const, retryable: false },
];

const inputSchema = (extra: object) => ({
  type: 'object',
  required: ['datasource', 'sql'],
  additionalProperties: false,
  properties: {
    datasource: { type: 'string', minLength: 1, maxLength: 64 },
    sql: { type: 'string', minLength: 1, maxLength: 20_000 },
    params: { type: 'array', maxItems: 100, items: { type: ['string', 'number', 'boolean', 'null'] } },
    ...extra,
  },
});

/**
 * Parameterised database access. Statements take `$1`/`?` placeholders and a separate params array —
 * there is no string interpolation path. Reads run in a read-only transaction enforced by the
 * database, and effectful writes use an in-transaction idempotency table so a repeated key applies
 * the change exactly once even if the engine crashed after committing.
 */
export function createDatabaseCapabilities(
  config: AdapterConfig,
  opts: { pgFactory?: PgFactory } = {},
): CapabilityAdapter[] {
  const drivers = new Map<string, DbDriver>();

  const driverFor = (name: string): DbDriver => {
    const url = config.datasources[name];
    if (!url) {
      throw new CapabilityError(
        'DB_UNKNOWN_DATASOURCE',
        `Datasource '${name}' is not configured (available: ${Object.keys(config.datasources).join(', ') || 'none'})`,
        {
          errorClass: 'contract',
          retryable: false,
        },
      );
    }
    let d = drivers.get(name);
    if (!d) {
      d = url.startsWith('sqlite:')
        ? sqliteDriver(url.replace(/^sqlite:(\/\/)?/, ''))
        : postgresDriver(url, opts.pgFactory ?? defaultPgFactory);
      drivers.set(name, d);
    }
    return d;
  };

  const query: CapabilityAdapter = {
    declaration: {
      name: 'database-query',
      version: '1.0.0',
      family: 'database',
      description: 'Run a parameterised read-only query against a configured datasource.',
      inputSchema: inputSchema({ maxRows: { type: 'integer', minimum: 1, maximum: 10_000, default: 1000 } }),
      outputSchema: {
        type: 'object',
        required: ['rows', 'rowCount', 'truncated'],
        properties: {
          rows: { type: 'array', items: { type: 'object' } },
          rowCount: { type: 'integer' },
          truncated: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      effect: 'idempotent',
      scopes: ['db:read'],
      egress: { mode: 'none' },
      costModel: { unitsPerInvocation: 1, latencyClass: 'fast' },
      failureModes,
      dataClassification: 'confidential',
      dryRun: 'execute',
    } as CapabilityDeclaration,
    async execute(ctx, input: { datasource: string; sql: string; params?: SqlParam[]; maxRows?: number }) {
      if (!SINGLE_STATEMENT.test(input.sql) || !READ_ONLY_START.test(input.sql)) {
        throw new CapabilityError(
          'DB_INVALID_STATEMENT',
          'database-query accepts a single SELECT/WITH/VALUES statement; pass literals as params',
          { errorClass: 'contract', retryable: false },
        );
      }
      try {
        return await driverFor(input.datasource).query(input.sql, input.params ?? [], {
          maxRows: input.maxRows ?? 1000,
          timeoutMs: 30_000,
        });
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        throw classify(e);
      }
    },
  };

  const command: CapabilityAdapter = {
    declaration: {
      name: 'database-command',
      version: '1.0.0',
      family: 'database',
      description:
        'Run a parameterised INSERT/UPDATE/DELETE. Effectful: requires an idempotencyKey, which is applied in the same transaction so the change happens exactly once.',
      inputSchema: inputSchema({}),
      outputSchema: {
        type: 'object',
        required: ['rowCount', 'rows', 'duplicate'],
        properties: {
          rowCount: { type: 'integer' },
          rows: { type: 'array', items: { type: 'object' } },
          duplicate: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      effect: 'effectful',
      scopes: ['db:write'],
      egress: { mode: 'none' },
      costModel: { unitsPerInvocation: 1, latencyClass: 'fast' },
      failureModes,
      dataClassification: 'confidential',
      dryRun: 'simulate',
    } as CapabilityDeclaration,
    simulate: () => ({ rowCount: 0, rows: [], duplicate: false }),
    async execute(ctx, input: { datasource: string; sql: string; params?: SqlParam[] }) {
      if (!SINGLE_STATEMENT.test(input.sql)) {
        throw new CapabilityError(
          'DB_INVALID_STATEMENT',
          'database-command accepts a single statement; pass literals as params',
          { errorClass: 'contract', retryable: false },
        );
      }
      try {
        return await driverFor(input.datasource).command(input.sql, input.params ?? [], {
          idempotencyKey: ctx.idempotencyKey,
          timeoutMs: 30_000,
        });
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        throw classify(e);
      }
    },
  };

  return [query, command];
}
