import { randomBytes } from 'node:crypto';
import { sha256Hex } from './canonical.ts';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeBase32(bytes: Uint8Array, length: number): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out.slice(0, length);
}

let lastTime = -1;
let lastRandom = 0n;

/**
 * Sortable, unique identifier: 48-bit millisecond timestamp + 80 bits of randomness, Crockford
 * base32 (26 chars). Monotonic within a process for ids minted in the same millisecond.
 */
export function ulid(now: number = Date.now()): string {
  let rand: bigint;
  if (now <= lastTime) {
    now = lastTime;
    lastRandom += 1n;
    rand = lastRandom;
  } else {
    rand = BigInt(`0x${randomBytes(10).toString('hex')}`);
    lastTime = now;
    lastRandom = rand;
  }
  const buf = new Uint8Array(16);
  let t = now;
  for (let i = 5; i >= 0; i--) {
    buf[i] = t & 0xff;
    t = Math.floor(t / 256);
  }
  let r = rand & ((1n << 80n) - 1n);
  for (let i = 15; i >= 6; i--) {
    buf[i] = Number(r & 0xffn);
    r >>= 8n;
  }
  return encodeBase32(buf, 26);
}

export type IdPrefix =
  | 'run'
  | 'evt'
  | 'apr'
  | 'usr'
  | 'key'
  | 'ses'
  | 'tnt'
  | 'drf'
  | 'chg'
  | 'prp'
  | 'trg'
  | 'lse'
  | 'art'
  | 'sec'
  | 'fnd';

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}

/** Cryptographically random URL-safe token of `bytes` entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Independent generator derived from this one's seed and a label. */
  fork(label: string): Rng;
  readonly seed: string;
}

/**
 * Seeded generator (xoshiro128**). Determinism rule 2 (architecture §6.5): every random value the
 * engine needs — retry jitter, `uuid()` in expressions — derives from a seed recorded on the run.
 */
export function createRng(seed: string): Rng {
  const h = sha256Hex(`rng:${seed}`);
  const s = [0, 1, 2, 3].map((i) => Number.parseInt(h.slice(i * 8, i * 8 + 8), 16) >>> 0);
  if ((s[0]! | s[1]! | s[2]! | s[3]!) === 0) s[0] = 1;
  const rotl = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0;
  const nextU32 = (): number => {
    const result = (rotl(Math.imul(s[1]!, 5) >>> 0, 7) * 9) >>> 0;
    const t = (s[1]! << 9) >>> 0;
    s[2]! ^= s[0]!;
    s[3]! ^= s[1]!;
    s[1]! ^= s[2]!;
    s[0]! ^= s[3]!;
    s[2]! ^= t;
    s[3] = rotl(s[3]!, 11);
    return result;
  };
  const rng: Rng = {
    seed,
    next: () => nextU32() / 0x1_0000_0000,
    int: (min, max) => min + Math.floor(rng.next() * (max - min + 1)),
    fork: (label) => createRng(`${seed}/${label}`),
  };
  return rng;
}

/** RFC-4122-shaped UUID derived deterministically from a seed and labels. */
export function deterministicUuid(seed: string, ...labels: string[]): string {
  const h = sha256Hex(`uuid:${seed}:${labels.join(':')}`)
    .slice(0, 32)
    .split('');
  h[12] = '4';
  h[16] = '89ab'[Number.parseInt(h[16]!, 16) & 3]!;
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}
