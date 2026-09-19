import { describe, expect, it } from 'vitest';
import {
  AuthenticationError,
  ConflictError,
  canonicalize,
  contentHash,
  createLogger,
  createRng,
  deterministicUuid,
  formatDuration,
  getPath,
  isContentHash,
  isDuration,
  isPlainObject,
  type LogRecord,
  ManualClock,
  maxSensitivity,
  NotFoundError,
  newId,
  OmniflowError,
  PolicyDeniedError,
  parseDuration,
  RateLimitedError,
  REDACTED,
  redact,
  sanitizeText,
  scrubString,
  sensitivityRank,
  toErrorInfo,
  ulid,
  ValidationError,
} from '../../core/index.ts';

describe('canonical JSON and content hashes', () => {
  it('sorts keys and is order-insensitive', () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}',
    );
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });

  it('omits undefined members, normalises -0, rejects non-finite numbers and cycles', () => {
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalize(-0)).toBe('0');
    expect(() => canonicalize(Number.NaN)).toThrow();
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => canonicalize(cyc)).toThrow(/cyclic/);
  });

  it('produces well-formed content hashes', () => {
    expect(isContentHash(contentHash('x'))).toBe(true);
    expect(isContentHash('sha256:xyz')).toBe(false);
    expect(contentHash(null)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('identifiers and seeded randomness', () => {
  it('mints unique, sortable ids', () => {
    const ids = Array.from({ length: 200 }, () => ulid());
    expect(new Set(ids).size).toBe(200);
    expect([...ids].sort()).toEqual(ids);
    expect(ids[0]).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(newId('run')).toMatch(/^run_[0-9A-Z]{26}$/);
  });

  it('is monotonic across the same millisecond', () => {
    const t = Date.now() + 10_000;
    expect(ulid(t) < ulid(t)).toBe(true);
  });

  it('generates identical sequences from identical seeds', () => {
    const a = createRng('seed');
    const b = createRng('seed');
    const seqA = Array.from({ length: 10 }, () => a.next());
    const seqB = Array.from({ length: 10 }, () => b.next());
    expect(seqA).toEqual(seqB);
    expect(seqA.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(createRng('other').next()).not.toBe(createRng('seed').next());
  });

  it('forks independent, reproducible streams and supports integer ranges', () => {
    const r = createRng('s');
    expect(r.fork('a').next()).toBe(createRng('s').fork('a').next());
    expect(r.fork('a').next()).not.toBe(r.fork('b').next());
    for (let i = 0; i < 100; i++) {
      const n = r.int(3, 5);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(5);
    }
  });

  it('derives deterministic UUIDs', () => {
    expect(deterministicUuid('s', 'a')).toBe(deterministicUuid('s', 'a'));
    expect(deterministicUuid('s', 'a')).not.toBe(deterministicUuid('s', 'b'));
  });
});

describe('durations and clocks', () => {
  it('parses shorthand, compound and ISO durations', () => {
    expect(parseDuration('250ms')).toBe(250);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('1h30m')).toBe(5_400_000);
    expect(parseDuration('2d')).toBe(172_800_000);
    expect(parseDuration('PT1H30M')).toBe(5_400_000);
    expect(parseDuration('P1DT2H')).toBe(93_600_000);
    expect(parseDuration(1500)).toBe(1500);
  });

  it('rejects malformed durations', () => {
    for (const bad of ['', 'abc', '5', '-1s', '1 s', 'P', 'PT']) {
      expect(isDuration(bad), bad).toBe(false);
    }
    expect(() => parseDuration(-5)).toThrow(ValidationError);
  });

  it('formats durations', () => {
    expect(formatDuration(250)).toBe('250ms');
    expect(formatDuration(90_000)).toBe('1m30s');
    expect(formatDuration(3_723_000)).toBe('1h2m3s');
  });

  it('provides a manual clock', () => {
    const c = new ManualClock('2026-01-01T00:00:00Z');
    c.advance(60_000);
    expect(c.now().toISOString()).toBe('2026-01-01T00:01:00.000Z');
    c.set('2027-01-01T00:00:00Z');
    expect(c.now().getUTCFullYear()).toBe(2027);
  });
});

describe('json helpers', () => {
  it('recognises plain objects', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(new Date())).toBe(false);
    expect(isPlainObject(null)).toBe(false);
  });

  it('reads nested paths without touching prototypes', () => {
    const o = { a: { b: [{ c: 1 }] } };
    expect(getPath(o, ['a', 'b', 0, 'c'])).toBe(1);
    expect(getPath(o, ['a', 'x', 'y'])).toBeUndefined();
    expect(getPath(o, ['a', 'constructor'])).toBeUndefined();
    expect(getPath(o, ['a', 'b', 'length'])).toBeUndefined();
  });
});

describe('error taxonomy', () => {
  it('assigns default retryability by class', () => {
    expect(new OmniflowError('X', 'm', { errorClass: 'transient' }).retryable).toBe(true);
    expect(new OmniflowError('X', 'm', { errorClass: 'contract' }).retryable).toBe(false);
    expect(new OmniflowError('X', 'm', { errorClass: 'systemic' }).retryable).toBe(true);
    expect(
      new OmniflowError('X', 'm', { errorClass: 'transient', retryable: false }).retryable,
    ).toBe(false);
  });

  it('serialises to plain data without stack traces', () => {
    const info = toErrorInfo(new PolicyDeniedError('POLICY_X', 'no', { rule: 'r' }));
    expect(info).toEqual({
      code: 'POLICY_X',
      message: 'no',
      class: 'authorisation',
      retryable: false,
      details: { rule: 'r' },
    });
    expect(JSON.stringify(info)).not.toContain('stack');
  });

  it('carries validation issues', () => {
    const e = new ValidationError('bad', [{ path: 'a', code: 'C', message: 'm' }]);
    expect(e.toInfo().details).toEqual({ issues: [{ path: 'a', code: 'C', message: 'm' }] });
    expect(e.errorClass).toBe('contract');
  });

  it('normalises foreign errors and non-errors', () => {
    const fromNode = Object.assign(new Error('boom'), { code: 'ECONNRESET' });
    expect(toErrorInfo(fromNode)).toMatchObject({
      code: 'ECONNRESET',
      class: 'systemic',
      retryable: true,
    });
    expect(toErrorInfo('str')).toMatchObject({ code: 'INTERNAL', message: 'str' });
  });

  it('exposes specific error types', () => {
    expect(new NotFoundError('Run', 'r1').message).toBe("Run 'r1' not found");
    expect(new ConflictError('dup').code).toBe('CONFLICT');
    expect(new AuthenticationError().code).toBe('UNAUTHENTICATED');
    expect(new RateLimitedError(3).details).toEqual({ retryAfterSeconds: 3 });
  });
});

describe('sanitisation and redaction', () => {
  it('redacts sensitive keys at any depth', () => {
    const out = redact({
      user: 'ada',
      password: 'hunter2',
      nested: { apiKey: 'k', Authorization: 'Bearer abcdefghijkl', ok: 1 },
      list: [{ token: 't' }],
    }) as Record<string, any>;
    expect(out.user).toBe('ada');
    expect(out.password).toBe(REDACTED);
    expect(out.nested.apiKey).toBe(REDACTED);
    expect(out.nested.Authorization).toBe(REDACTED);
    expect(out.nested.ok).toBe(1);
    expect(out.list[0].token).toBe(REDACTED);
  });

  it('redacts credential-shaped strings in free text', () => {
    const samples = [
      'Authorization: Bearer abcdefghijklmnop',
      'key AKIAIOSFODNN7EXAMPLE leaked',
      'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'db postgres://user:pa55w0rd@db.internal:5432/app',
      'sk-abcdefghijklmnopqrstuvwxyz',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijkl',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----',
    ];
    for (const s of samples) {
      const out = scrubString(s);
      expect(out, s).toContain(REDACTED);
      expect(out, s).not.toMatch(/pa55w0rd|AKIAIOSFODNN7EXAMPLE|MIIabc|ghp_abc|sk-abc/);
    }
  });

  it('scrubs known secret values wherever they appear, including error messages', () => {
    const out = redact(new Error('request to https://x/?k=SuperSecretValue123 failed'), {
      secretValues: ['SuperSecretValue123'],
    }) as { message: string };
    expect(out.message).not.toContain('SuperSecretValue123');
    expect(out.message).toContain(REDACTED);
  });

  it('is bounded and cycle-safe', () => {
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    expect((redact(cyc) as any).self).toBe('[Circular]');
    expect(String(redact('x'.repeat(20000)))).toContain('truncated');
    expect((redact(new Array(500).fill(1)) as unknown[]).length).toBe(201);
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 30; i++) {
      deep.n = {};
      deep = deep.n as Record<string, unknown>;
    }
    expect(JSON.stringify(redact(root))).toContain('[MaxDepth]');
  });

  it('drops prototype-polluting keys and control characters', () => {
    const polluted = JSON.parse('{"__proto__": {"x": 1}, "constructor": 2, "ok": 3}');
    expect(redact(polluted)).toEqual({ ok: 3 });
    expect(sanitizeText(`a${String.fromCharCode(0)}b${String.fromCharCode(0x202e)}c`)).toBe('abc');
  });

  it('orders sensitivity levels', () => {
    expect(sensitivityRank('secret')).toBeGreaterThan(sensitivityRank('internal'));
    expect(maxSensitivity('public', 'confidential')).toBe('confidential');
  });
});

describe('logger', () => {
  it('emits redacted structured records and honours levels and child bindings', () => {
    const records: LogRecord[] = [];
    const log = createLogger({ level: 'info', sink: (r) => records.push(r) });
    log.debug('hidden');
    log.child({ runId: 'r1' }).info('hello', { password: 'x', n: 1 });
    log.error('bad', { err: new Error('Bearer abcdefghijklmnop') });
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      level: 'info',
      msg: 'hello',
      runId: 'r1',
      password: REDACTED,
      n: 1,
    });
    expect(JSON.stringify(records[1])).not.toContain('abcdefghijklmnop');
  });
});
