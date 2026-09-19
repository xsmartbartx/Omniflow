import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Clock, NotFoundError, OmniflowError, systemClock } from '../core/index.ts';
import type { Db } from './database.ts';

export interface ArtifactMeta {
  tenant: string;
  /** `sha256:<hex>` content address. */
  ref: string;
  size: number;
  contentType: string;
  runId?: string;
  createdAt: string;
  tombstonedAt?: string;
  tombstoneReason?: string;
}

interface Row {
  tenant_id: string;
  hash: string;
  size: number;
  content_type: string;
  run_id: string | null;
  created_at: string;
  tombstoned_at: string | null;
  tombstone_reason: string | null;
}

const toMeta = (r: Row): ArtifactMeta => ({
  tenant: r.tenant_id,
  ref: r.hash,
  size: r.size,
  contentType: r.content_type,
  ...(r.run_id ? { runId: r.run_id } : {}),
  createdAt: r.created_at,
  ...(r.tombstoned_at ? { tombstonedAt: r.tombstoned_at } : {}),
  ...(r.tombstone_reason ? { tombstoneReason: r.tombstone_reason } : {}),
});

/**
 * Content-addressed storage for payloads too large or too sensitive to inline
 * (architecture §5.1 #17). Referenced by hash from run state; never inlined into the event log.
 * Right-to-erasure is served by tombstoning: the bytes are destroyed, the audit chain is untouched.
 */
export class ArtifactStore {
  private readonly db: Db;
  private readonly root: string;
  private readonly clock: Clock;

  constructor(db: Db, root: string, clock: Clock = systemClock) {
    this.db = db;
    this.root = root;
    this.clock = clock;
  }

  private pathFor(tenant: string, hex: string): string {
    return join(this.root, tenant.replace(/[^A-Za-z0-9_-]/g, '_'), hex.slice(0, 2), hex);
  }

  put(tenant: string, data: Buffer | string, opts: { contentType?: string; runId?: string } = {}): ArtifactMeta {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const hex = createHash('sha256').update(bytes).digest('hex');
    const ref = `sha256:${hex}`;
    const existing = this.db.get<Row>('SELECT * FROM artifacts WHERE tenant_id = ? AND hash = ?', [tenant, ref]);
    if (existing && !existing.tombstoned_at) return toMeta(existing);

    const file = this.pathFor(tenant, hex);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes, { mode: 0o600 });
    renameSync(tmp, file);

    const now = this.clock.now().toISOString();
    this.db.run(
      `INSERT INTO artifacts (tenant_id, hash, size, content_type, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, hash) DO UPDATE SET tombstoned_at = NULL, tombstone_reason = NULL, size = excluded.size`,
      [tenant, ref, bytes.length, opts.contentType ?? 'application/octet-stream', opts.runId ?? null, now],
    );
    return toMeta(this.db.get<Row>('SELECT * FROM artifacts WHERE tenant_id = ? AND hash = ?', [tenant, ref])!);
  }

  putJson(tenant: string, value: unknown, runId?: string): ArtifactMeta {
    return this.put(tenant, JSON.stringify(value), { contentType: 'application/json', ...(runId ? { runId } : {}) });
  }

  meta(tenant: string, ref: string): ArtifactMeta | undefined {
    const r = this.db.get<Row>('SELECT * FROM artifacts WHERE tenant_id = ? AND hash = ?', [tenant, ref]);
    return r ? toMeta(r) : undefined;
  }

  get(tenant: string, ref: string): { meta: ArtifactMeta; data: Buffer } {
    const meta = this.meta(tenant, ref);
    if (!meta) throw new NotFoundError('Artifact', ref);
    if (meta.tombstonedAt) {
      throw new OmniflowError('ARTIFACT_ERASED', `Artifact '${ref}' was erased (${meta.tombstoneReason ?? 'no reason recorded'})`, {
        errorClass: 'business',
        retryable: false,
      });
    }
    const data = readFileSync(this.pathFor(tenant, ref.slice('sha256:'.length)));
    // Verify integrity on every read: a bit-flipped or swapped file must never be served as valid.
    if (`sha256:${createHash('sha256').update(data).digest('hex')}` !== ref) {
      throw new OmniflowError('ARTIFACT_CORRUPT', `Artifact '${ref}' failed its integrity check`, {
        errorClass: 'catastrophic',
        retryable: false,
      });
    }
    return { meta, data };
  }

  getJson<T = unknown>(tenant: string, ref: string): T {
    return JSON.parse(this.get(tenant, ref).data.toString('utf8')) as T;
  }

  /** Destroy the bytes but keep the metadata row, so references still resolve to "erased". */
  tombstone(tenant: string, ref: string, reason: string): boolean {
    const meta = this.meta(tenant, ref);
    if (!meta || meta.tombstonedAt) return false;
    rmSync(this.pathFor(tenant, ref.slice('sha256:'.length)), { force: true });
    this.db.run(
      'UPDATE artifacts SET tombstoned_at = ?, tombstone_reason = ? WHERE tenant_id = ? AND hash = ?',
      [this.clock.now().toISOString(), reason, tenant, ref],
    );
    return true;
  }

  list(tenant: string, runId?: string): ArtifactMeta[] {
    const rows = runId
      ? this.db.all<Row>('SELECT * FROM artifacts WHERE tenant_id = ? AND run_id = ? ORDER BY created_at', [tenant, runId])
      : this.db.all<Row>('SELECT * FROM artifacts WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 500', [tenant]);
    return rows.map(toMeta);
  }
}
