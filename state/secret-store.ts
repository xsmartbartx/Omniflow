import { type Clock, newId, systemClock } from '../core/index.ts';
import { type Db, fromJson } from './database.ts';

export interface SecretRecord {
  tenant: string;
  name: string;
  /** Opaque ciphertext — encryption and decryption happen in the Secret Broker. */
  cipher: string;
  keyId: string;
  description?: string;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type SecretSummary = Omit<SecretRecord, 'cipher'>;

export interface LeaseRecord {
  id: string;
  tenant: string;
  runId?: string;
  stepId?: string;
  names: string[];
  issuedAt: string;
  expiresAt: string;
  revokedAt?: string;
}

interface Row {
  tenant_id: string;
  name: string;
  cipher: string;
  key_id: string;
  description: string | null;
  version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}
interface LRow {
  id: string;
  tenant_id: string;
  run_id: string | null;
  step_id: string | null;
  names: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
}

const toRecord = (r: Row): SecretRecord => ({
  tenant: r.tenant_id,
  name: r.name,
  cipher: r.cipher,
  keyId: r.key_id,
  ...(r.description ? { description: r.description } : {}),
  version: r.version,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toLease = (r: LRow): LeaseRecord => ({
  id: r.id,
  tenant: r.tenant_id,
  ...(r.run_id ? { runId: r.run_id } : {}),
  ...(r.step_id ? { stepId: r.step_id } : {}),
  names: fromJson<string[]>(r.names) ?? [],
  issuedAt: r.issued_at,
  expiresAt: r.expires_at,
  ...(r.revoked_at ? { revokedAt: r.revoked_at } : {}),
});

/** Persistence for encrypted secrets and the lease audit trail. Never sees a plaintext value. */
export class SecretStore {
  private readonly db: Db;
  private readonly clock: Clock;

  constructor(db: Db, clock: Clock = systemClock) {
    this.db = db;
    this.clock = clock;
  }

  put(tenant: string, name: string, cipher: string, keyId: string, by: string, description?: string): void {
    const now = this.clock.now().toISOString();
    this.db.run(
      `INSERT INTO secrets (tenant_id, name, cipher, key_id, description, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, name) DO UPDATE SET cipher = excluded.cipher, key_id = excluded.key_id,
         description = COALESCE(excluded.description, description), version = version + 1, updated_at = excluded.updated_at`,
      [tenant, name, cipher, keyId, description ?? null, by, now, now],
    );
  }

  get(tenant: string, name: string): SecretRecord | undefined {
    const r = this.db.get<Row>('SELECT * FROM secrets WHERE tenant_id = ? AND name = ?', [tenant, name]);
    return r ? toRecord(r) : undefined;
  }

  /** Names and metadata only — ciphertext is never listed. */
  list(tenant: string): SecretSummary[] {
    return this.db.all<Row>('SELECT * FROM secrets WHERE tenant_id = ? ORDER BY name', [tenant]).map((r) => {
      const { cipher: _c, ...rest } = toRecord(r);
      return rest;
    });
  }

  all(): SecretRecord[] {
    return this.db.all<Row>('SELECT * FROM secrets').map(toRecord);
  }

  delete(tenant: string, name: string): boolean {
    return this.db.run('DELETE FROM secrets WHERE tenant_id = ? AND name = ?', [tenant, name]).changes > 0;
  }

  // ---- leases (audit only; the secret values are not stored here)
  recordLease(l: { tenant: string; runId?: string; stepId?: string; names: string[]; ttlMs: number }): LeaseRecord {
    const id = newId('lse');
    const now = this.clock.now();
    this.db.run(
      `INSERT INTO secret_leases (id, tenant_id, run_id, step_id, names, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        l.tenant,
        l.runId ?? null,
        l.stepId ?? null,
        JSON.stringify(l.names),
        now.toISOString(),
        new Date(now.getTime() + l.ttlMs).toISOString(),
      ],
    );
    return toLease(this.db.get<LRow>('SELECT * FROM secret_leases WHERE id = ?', [id])!);
  }

  revokeLease(id: string): void {
    this.db.run('UPDATE secret_leases SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?', [
      this.clock.now().toISOString(),
      id,
    ]);
  }

  /** Leases that outlived their step (should be empty after crash recovery). */
  outstandingLeases(): LeaseRecord[] {
    return this.db.all<LRow>('SELECT * FROM secret_leases WHERE revoked_at IS NULL').map(toLease);
  }

  revokeOutstanding(): number {
    return this.db.run('UPDATE secret_leases SET revoked_at = ? WHERE revoked_at IS NULL', [
      this.clock.now().toISOString(),
    ]).changes;
  }
}
