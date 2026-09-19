import { beforeEach, describe, expect, it } from 'vitest';
import { redact } from '../../core/index.ts';
import {
  createKeyring,
  decryptSecret,
  encryptSecret,
  generateMasterKey,
  SecretBroker,
} from '../../security/secret-broker/index.ts';
import { makeState, type TestState } from '../helpers/state.ts';

let s: TestState;
let broker: SecretBroker;
const key = generateMasterKey();

beforeEach(() => {
  s = makeState();
  broker = new SecretBroker(s.secrets, createKeyring(key), s.clock);
});

describe('secret encryption', () => {
  const ring = createKeyring(key);

  it('round-trips and never stores plaintext', () => {
    const { cipher } = encryptSecret(ring, 't1', 'API_TOKEN', 'super-secret-value');
    expect(cipher).not.toContain('super-secret-value');
    expect(cipher.startsWith('v1:')).toBe(true);
    expect(decryptSecret(ring, 't1', 'API_TOKEN', cipher)).toBe('super-secret-value');
  });

  it('uses a fresh IV for every encryption', () => {
    const a = encryptSecret(ring, 't1', 'N', 'same').cipher;
    const b = encryptSecret(ring, 't1', 'N', 'same').cipher;
    expect(a).not.toBe(b);
  });

  it('binds ciphertext to its tenant and name — it cannot be moved', () => {
    const { cipher } = encryptSecret(ring, 't1', 'A', 'value');
    expect(() => decryptSecret(ring, 't2', 'A', cipher)).toThrow(/failed authentication/);
    expect(() => decryptSecret(ring, 't1', 'B', cipher)).toThrow(/failed authentication/);
  });

  it('detects tampering and unknown keys and formats', () => {
    const { cipher } = encryptSecret(ring, 't', 'A', 'value');
    const parts = cipher.split(':');
    parts[4] = Buffer.from('forged-bytes').toString('base64');
    expect(() => decryptSecret(ring, 't', 'A', parts.join(':'))).toThrow(/failed authentication/);
    expect(() => decryptSecret(createKeyring(generateMasterKey()), 't', 'A', cipher)).toThrow(/not in the keyring/);
    expect(() => decryptSecret(ring, 't', 'A', 'garbage')).toThrow(/unrecognised format/);
  });

  it('validates the master key', () => {
    expect(() => createKeyring('too-short')).toThrow(/32 bytes/);
    expect(() => createKeyring(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
    expect(createKeyring('a'.repeat(64)).keys.size).toBe(1); // hex form
  });
});

describe('secret broker', () => {
  it('stores secrets encrypted at rest and lists names only', () => {
    broker.put('default', 'DB_PASSWORD', 'hunter2-hunter2', 'usr_a', 'prod db');
    const raw = JSON.stringify(s.db.all('SELECT * FROM secrets'));
    expect(raw).not.toContain('hunter2');
    expect(JSON.stringify(broker.list('default'))).not.toContain('hunter2');
    expect(broker.list('default')[0]).toMatchObject({ name: 'DB_PASSWORD', description: 'prod db' });
    expect(broker.has('default', 'DB_PASSWORD')).toBe(true);
    expect(broker.has('other', 'DB_PASSWORD')).toBe(false);
  });

  it('validates names and values', () => {
    expect(() => broker.put('default', '1bad', 'v', 'u')).toThrow(/Invalid secret name/);
    expect(() => broker.put('default', 'has space', 'v', 'u')).toThrow(/Invalid secret name/);
    expect(() => broker.put('default', 'OK', '', 'u')).toThrow(/cannot be empty/);
    expect(() => broker.put('default', 'OK', 'x'.repeat(70_000), 'u')).toThrow(/too large/);
  });

  it('issues leases scoped to exactly the granted names', () => {
    broker.put('default', 'A', 'value-a', 'u');
    broker.put('default', 'B', 'value-b', 'u');
    const lease = broker.lease({ tenant: 'default', runId: 'r', stepId: 's', names: ['A'], ttlMs: 60_000 });
    expect(lease.get('A')).toBe('value-a');
    expect(lease.has('B')).toBe(false);
    expect(() => lease.get('B')).toThrow(/not granted/);
    expect(lease.scope()).toEqual({ A: 'value-a' });
    expect(lease.values()).toEqual(['value-a']);
    expect(s.secrets.outstandingLeases()).toHaveLength(1);
  });

  it('revokes leases at step end and wipes them from memory', () => {
    broker.put('default', 'A', 'value-a', 'u');
    const lease = broker.lease({ tenant: 'default', names: ['A'], ttlMs: 60_000 });
    lease.revoke();
    expect(lease.revoked).toBe(true);
    expect(() => lease.get('A')).toThrow(/revoked/);
    expect(lease.values()).toEqual([]);
    expect(s.secrets.outstandingLeases()).toHaveLength(0);
    lease.revoke(); // idempotent
  });

  it('expires leases', () => {
    broker.put('default', 'A', 'value-a', 'u');
    const lease = broker.lease({ tenant: 'default', names: ['A'], ttlMs: 1000 });
    s.clock.advance(1500);
    expect(() => lease.get('A')).toThrow(/expired/);
    expect(lease.revoked).toBe(true);
  });

  it('refuses to lease a missing secret, and never crosses tenants', () => {
    expect(() => broker.lease({ tenant: 'default', names: ['NOPE'], ttlMs: 1000 })).toThrow(/does not exist/);
    broker.put('default', 'A', 'v', 'u');
    expect(() => broker.lease({ tenant: 'other', names: ['A'], ttlMs: 1000 })).toThrow(/does not exist/);
  });

  it('scrubs leased values from anything that might be logged', () => {
    broker.put('default', 'TOKEN', 'abc123-very-secret', 'u');
    const lease = broker.lease({ tenant: 'default', names: ['TOKEN'], ttlMs: 1000 });
    const out = redact(
      { message: 'upstream said: bad token abc123-very-secret' },
      { secretValues: lease.values() },
    ) as { message: string };
    expect(out.message).not.toContain('abc123-very-secret');
  });

  it('provides an empty lease for steps without secrets', () => {
    const lease = broker.emptyLease();
    expect(lease.scope()).toEqual({});
    expect(() => lease.get('X')).toThrow(/not granted/);
  });

  it('rotates every secret to a new primary key while keeping values intact', () => {
    broker.put('default', 'A', 'value-a', 'u');
    broker.put('default', 'B', 'value-b', 'u');
    const newKey = generateMasterKey();
    const rotated = createKeyring(newKey, [key]);
    expect(broker.rotate(rotated)).toBe(2);
    expect(s.secrets.get('default', 'A')!.keyId).toBe(rotated.primaryId);
    expect(broker.lease({ tenant: 'default', names: ['A', 'B'], ttlMs: 1000 }).scope()).toEqual({
      A: 'value-a',
      B: 'value-b',
    });
    // A fresh broker with only the new key can read them
    const fresh = new SecretBroker(s.secrets, createKeyring(newKey), s.clock);
    expect(fresh.lease({ tenant: 'default', names: ['A'], ttlMs: 1000 }).get('A')).toBe('value-a');
    expect(broker.rotate(rotated)).toBe(0); // idempotent
  });
});
