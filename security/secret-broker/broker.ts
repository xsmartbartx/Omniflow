import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { type Clock, newId, OmniflowError, systemClock, ValidationError } from '../../core/index.ts';
import type { Lease } from '../../schemas/capability.ts';

/**
 * Secret Broker (architecture §5.1 #14): issues short-lived, narrowly scoped credentials to an
 * adapter for the duration of one step. Secrets never enter the manifest, the plan, the state
 * store or the event log — only ciphertext at rest, and plaintext only inside a live lease.
 */

// ------------------------------------------------------------------ ports
/** Persistence the broker needs. `state/secret-store.ts` satisfies this structurally. */
export interface SecretStorePort {
  put(tenant: string, name: string, cipher: string, keyId: string, by: string, description?: string): void;
  get(tenant: string, name: string): { cipher: string; keyId: string; version: number } | undefined;
  list(tenant: string): Array<{
    name: string;
    keyId: string;
    version: number;
    description?: string;
    updatedAt: string;
    createdBy: string;
  }>;
  all(): Array<{ tenant: string; name: string; cipher: string; keyId: string; createdBy: string }>;
  delete(tenant: string, name: string): boolean;
  recordLease(l: { tenant: string; runId?: string; stepId?: string; names: string[]; ttlMs: number }): {
    id: string;
    expiresAt: string;
  };
  revokeLease(id: string): void;
}

// ---------------------------------------------------------------- keyring
export interface Keyring {
  primaryId: string;
  keys: Map<string, Buffer>;
}

export const SECRET_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX_SECRET_BYTES = 64 * 1024;

function decodeKey(material: string): Buffer {
  const trimmed = material.trim();
  let buf: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) buf = Buffer.from(trimmed, 'hex');
  else buf = Buffer.from(trimmed, 'base64');
  if (buf.length !== 32) {
    throw new OmniflowError(
      'INVALID_MASTER_KEY',
      'The master key must be exactly 32 bytes (64 hex characters or base64).',
      {
        errorClass: 'catastrophic',
        retryable: false,
      },
    );
  }
  return buf;
}

export const keyIdOf = (key: Buffer): string => createHash('sha256').update(key).digest('hex').slice(0, 8);

/** Build a keyring from one primary key and any number of previous keys (kept so old secrets stay readable until rotated). */
export function createKeyring(primary: string, previous: string[] = []): Keyring {
  const keys = new Map<string, Buffer>();
  const p = decodeKey(primary);
  keys.set(keyIdOf(p), p);
  for (const k of previous) {
    const b = decodeKey(k);
    keys.set(keyIdOf(b), b);
  }
  return { primaryId: keyIdOf(p), keys };
}

export function generateMasterKey(): string {
  return randomBytes(32).toString('base64');
}

// ----------------------------------------------------------------- crypto
/**
 * AES-256-GCM. The ciphertext is bound to `tenant/name` as additional authenticated data, so a
 * row cannot be moved to another secret or tenant without failing authentication.
 */
export function encryptSecret(
  keyring: Keyring,
  tenant: string,
  name: string,
  plaintext: string,
): { cipher: string; keyId: string } {
  const key = keyring.keys.get(keyring.primaryId)!;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(`${tenant}/${name}`));
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return {
    keyId: keyring.primaryId,
    cipher: `v1:${keyring.primaryId}:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`,
  };
}

export function decryptSecret(keyring: Keyring, tenant: string, name: string, cipher: string): string {
  const parts = cipher.split(':');
  if (parts.length !== 5 || parts[0] !== 'v1') {
    throw new OmniflowError('SECRET_CORRUPT', `Secret '${name}' has an unrecognised format`, {
      errorClass: 'catastrophic',
      retryable: false,
    });
  }
  const [, keyId, iv, tag, ct] = parts as [string, string, string, string, string];
  const key = keyring.keys.get(keyId);
  if (!key) {
    throw new OmniflowError(
      'SECRET_KEY_MISSING',
      `Secret '${name}' was encrypted with key ${keyId}, which is not in the keyring`,
      {
        errorClass: 'catastrophic',
        retryable: false,
      },
    );
  }
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    d.setAAD(Buffer.from(`${tenant}/${name}`));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  } catch {
    throw new OmniflowError('SECRET_TAMPERED', `Secret '${name}' failed authentication — it was modified or moved`, {
      errorClass: 'catastrophic',
      retryable: false,
    });
  }
}

// ----------------------------------------------------------------- leases
export interface LeaseRequest {
  tenant: string;
  runId?: string;
  stepId?: string;
  /** Exactly the secrets this step may read — no more. */
  names: string[];
  ttlMs: number;
}

export interface ActiveLease extends Lease {
  readonly names: string[];
  readonly expiresAt: string;
  /** Granted name → value, for resolving `${{ secrets.NAME }}` at the moment of the call. */
  scope(): Record<string, string>;
  /** Plaintext values, used only to scrub them from anything that might be logged. */
  values(): string[];
  revoke(): void;
  readonly revoked: boolean;
}

class LeaseImpl implements ActiveLease {
  readonly id: string;
  readonly names: string[];
  readonly expiresAt: string;
  private secrets: Map<string, string> | null;
  private readonly clock: Clock;
  private readonly expiresMs: number;
  private readonly onRevoke: (id: string) => void;

  constructor(
    id: string,
    secrets: Map<string, string>,
    expiresAt: string,
    clock: Clock,
    onRevoke: (id: string) => void,
  ) {
    this.id = id;
    this.secrets = secrets;
    this.names = [...secrets.keys()].sort();
    this.expiresAt = expiresAt;
    this.expiresMs = Date.parse(expiresAt);
    this.clock = clock;
    this.onRevoke = onRevoke;
  }

  get revoked(): boolean {
    return this.secrets === null;
  }

  private live(): Map<string, string> {
    if (this.secrets === null) {
      throw new OmniflowError('LEASE_REVOKED', 'Secret lease has been revoked', {
        errorClass: 'authorisation',
        retryable: false,
      });
    }
    if (this.clock.now().getTime() > this.expiresMs) {
      this.revoke();
      throw new OmniflowError('LEASE_EXPIRED', 'Secret lease has expired', {
        errorClass: 'authorisation',
        retryable: false,
      });
    }
    return this.secrets;
  }

  has(name: string): boolean {
    return this.secrets?.has(name) ?? false;
  }

  get(name: string): string {
    const s = this.live();
    const v = s.get(name);
    if (v === undefined) {
      throw new OmniflowError('SECRET_NOT_GRANTED', `Secret '${name}' was not granted to this step`, {
        errorClass: 'authorisation',
        retryable: false,
      });
    }
    return v;
  }

  scope(): Record<string, string> {
    return Object.fromEntries(this.live());
  }

  values(): string[] {
    return this.secrets ? [...this.secrets.values()] : [];
  }

  revoke(): void {
    if (this.secrets === null) return;
    this.secrets.clear();
    this.secrets = null;
    this.onRevoke(this.id);
  }
}

export class SecretBroker {
  private readonly store: SecretStorePort;
  private keyring: Keyring;
  private readonly clock: Clock;

  constructor(store: SecretStorePort, keyring: Keyring, clock: Clock = systemClock) {
    this.store = store;
    this.keyring = keyring;
    this.clock = clock;
  }

  put(tenant: string, name: string, value: string, by: string, description?: string): void {
    if (!SECRET_NAME.test(name)) {
      throw new ValidationError(`Invalid secret name '${name}'`, [
        {
          path: 'name',
          code: 'INVALID_SECRET_NAME',
          message: 'Names start with a letter and contain only letters, digits and underscores (max 64).',
        },
      ]);
    }
    if (value.length === 0) {
      throw new ValidationError('A secret cannot be empty', [
        { path: 'value', code: 'EMPTY_SECRET', message: 'value is required' },
      ]);
    }
    if (Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES) {
      throw new ValidationError('Secret is too large', [
        { path: 'value', code: 'SECRET_TOO_LARGE', message: `Secrets are limited to ${MAX_SECRET_BYTES} bytes` },
      ]);
    }
    const { cipher, keyId } = encryptSecret(this.keyring, tenant, name, value);
    this.store.put(tenant, name, cipher, keyId, by, description);
  }

  /** Names and metadata only. There is deliberately no API that returns a plaintext value to a caller outside a lease. */
  list(tenant: string) {
    return this.store.list(tenant);
  }

  has(tenant: string, name: string): boolean {
    return this.store.get(tenant, name) !== undefined;
  }

  delete(tenant: string, name: string): boolean {
    return this.store.delete(tenant, name);
  }

  /** Issue a lease for exactly `req.names`. Revoke it as soon as the step ends. */
  lease(req: LeaseRequest): ActiveLease {
    const secrets = new Map<string, string>();
    for (const name of [...new Set(req.names)]) {
      const rec = this.store.get(req.tenant, name);
      if (!rec) {
        throw new OmniflowError('SECRET_NOT_FOUND', `Secret '${name}' does not exist`, {
          errorClass: 'contract',
          retryable: false,
          details: { name },
        });
      }
      secrets.set(name, decryptSecret(this.keyring, req.tenant, name, rec.cipher));
    }
    const rec = this.store.recordLease({
      tenant: req.tenant,
      ...(req.runId ? { runId: req.runId } : {}),
      ...(req.stepId ? { stepId: req.stepId } : {}),
      names: [...secrets.keys()].sort(),
      ttlMs: req.ttlMs,
    });
    return new LeaseImpl(rec.id, secrets, rec.expiresAt, this.clock, (id) => this.store.revokeLease(id));
  }

  /** A lease that grants nothing — for steps that use no secrets. */
  emptyLease(): ActiveLease {
    return new LeaseImpl(
      newId('lse'),
      new Map(),
      new Date(this.clock.now().getTime() + 60_000).toISOString(),
      this.clock,
      () => {},
    );
  }

  /** Re-encrypt every secret under the current primary key. Returns how many were rewritten. */
  rotate(newKeyring: Keyring): number {
    const old = this.keyring;
    let n = 0;
    for (const rec of this.store.all()) {
      if (rec.keyId === newKeyring.primaryId) continue;
      const plain = decryptSecret(
        old.keys.size >= newKeyring.keys.size ? old : mergeKeyrings(old, newKeyring),
        rec.tenant,
        rec.name,
        rec.cipher,
      );
      const enc = encryptSecret(newKeyring, rec.tenant, rec.name, plain);
      this.store.put(rec.tenant, rec.name, enc.cipher, enc.keyId, rec.createdBy);
      n++;
    }
    this.keyring = newKeyring;
    return n;
  }
}

function mergeKeyrings(a: Keyring, b: Keyring): Keyring {
  return { primaryId: b.primaryId, keys: new Map([...a.keys, ...b.keys]) };
}
