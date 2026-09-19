import { describe, expect, it } from 'vitest';
import {
  CapabilityError,
  CapabilityRegistry,
  createDefaultRegistry,
  defineCapability,
  exampleFromSchema,
  validateDeclaration,
} from '../../capabilities/index.ts';
import { ValidationError } from '../../core/index.ts';
import type { CapabilityDeclaration } from '../../schemas/index.ts';
import { makeCtx } from '../helpers/ctx.ts';

const decl = (over: Partial<CapabilityDeclaration> = {}): CapabilityDeclaration => ({
  name: 'test-cap',
  version: '1.0.0',
  description: 'test',
  family: 'test',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  effect: 'pure',
  scopes: [],
  egress: { mode: 'none' },
  costModel: { unitsPerInvocation: 0, latencyClass: 'instant' },
  failureModes: [],
  dataClassification: 'internal',
  dryRun: 'execute',
  ...over,
});

const adapter = (over: Partial<CapabilityDeclaration> = {}) =>
  defineCapability({ declaration: decl(over), execute: async () => ({}) });

describe('capability declaration validation', () => {
  it('accepts a well-formed declaration', () => {
    expect(validateDeclaration(decl())).toEqual([]);
  });

  it('requires a dry-run declaration and forces effectful capabilities to simulate', () => {
    expect(validateDeclaration(decl({ dryRun: undefined as never })).map((i) => i.code)).toContain('MISSING_DRY_RUN');
    const codes = validateDeclaration(decl({ effect: 'effectful', dryRun: 'execute', egress: { mode: 'step' } })).map(
      (i) => i.code,
    );
    expect(codes).toContain('EFFECTFUL_MUST_SIMULATE');
    expect(validateDeclaration(decl({ effect: 'effectful', dryRun: 'simulate', egress: { mode: 'step' } }))).toEqual(
      [],
    );
  });

  it('forbids network egress on pure capabilities', () => {
    expect(validateDeclaration(decl({ egress: { mode: 'step' } })).map((i) => i.code)).toContain('PURE_WITH_EGRESS');
  });

  it('validates schemas, egress hosts, failure modes and compensation references', () => {
    const codes = validateDeclaration(
      decl({
        inputSchema: { type: 'string' } as never,
        outputSchema: { type: 'nonsense' } as never,
        effect: 'idempotent',
        egress: { mode: 'static', hosts: ['*'] },
        failureModes: [
          { code: 'A', class: 'transient', retryable: true },
          { code: 'A', class: 'transient', retryable: true },
          { code: 'B', class: 'bogus' as never, retryable: false },
        ],
        compensation: 'no-version',
        name: 'Bad_Name',
        version: 'v1',
      }),
    ).map((i) => i.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'SCHEMA_NOT_OBJECT',
        'INVALID_SCHEMA',
        'INVALID_EGRESS_HOST',
        'DUPLICATE_FAILURE_MODE',
        'INVALID_ERROR_CLASS',
        'INVALID_COMPENSATION',
        'INVALID_NAME',
        'INVALID_VERSION',
      ]),
    );
  });
});

describe('capability registry', () => {
  it('registers, resolves by semver range, and hashes declarations', () => {
    const r = new CapabilityRegistry();
    r.register(adapter({ version: '1.0.0' }));
    r.register(adapter({ version: '1.2.0' }));
    r.register(adapter({ version: '2.0.0' }));
    expect(r.resolve('test-cap', '^1')?.declaration.version).toBe('1.2.0');
    expect(r.resolve('test-cap', '^2')?.declaration.version).toBe('2.0.0');
    expect(r.resolve('test-cap', '1.0.0')?.declaration.version).toBe('1.0.0');
    expect(r.resolve('test-cap', '^3')).toBeUndefined();
    expect(r.resolve('missing', '^1')).toBeUndefined();
    expect(r.resolveRef('test-cap@~1.0')?.declaration.version).toBe('1.0.0');
    expect(r.get('test-cap', '2.0.0')?.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.list().map((c) => c.declaration.version)).toEqual(['1.0.0', '1.2.0', '2.0.0']);
    expect(r.latest()).toHaveLength(1);
    expect(r.latest()[0]!.declaration.version).toBe('2.0.0');
  });

  it('changes the hash when the declaration changes', () => {
    const a = new CapabilityRegistry().register(adapter({ description: 'one' }));
    const b = new CapabilityRegistry().register(adapter({ description: 'two' }));
    expect(a.hash).not.toBe(b.hash);
  });

  it('rejects duplicates, invalid declarations and missing owners', () => {
    const r = new CapabilityRegistry();
    r.register(adapter());
    expect(() => r.register(adapter())).toThrow(/already registered/);
    expect(() => r.register(adapter({ name: 'BAD' }))).toThrow(ValidationError);
    expect(() => r.register(adapter({ name: 'other' }), { owner: ' ', source: 'plugin' })).toThrow(/owner/);
  });

  it('ships a default registry with the built-in capabilities', () => {
    const r = createDefaultRegistry();
    const names = r.latest().map((c) => c.declaration.name);
    expect(names).toEqual(expect.arrayContaining(['http-get', 'http-request', 'util-noop', 'util-echo']));
    for (const c of r.list()) expect(validateDeclaration(c.declaration)).toEqual([]);
    // Every effectful built-in simulates in dry runs.
    for (const c of r.list().filter((c) => c.declaration.effect === 'effectful')) {
      expect(c.declaration.dryRun).toBe('simulate');
    }
  });
});

describe('synthetic dry-run output', () => {
  it('derives a valid minimal example from a schema', () => {
    const schema = {
      type: 'object',
      required: ['id', 'ok', 'items', 'kind', 'nested'],
      properties: {
        id: { type: 'string', minLength: 3 },
        ok: { type: 'boolean' },
        n: { type: 'integer' },
        kind: { enum: ['a', 'b'] },
        items: { type: 'array', minItems: 2, items: { type: 'integer', minimum: 5 } },
        nested: { type: 'object', required: ['x'], properties: { x: { type: 'number' } } },
        opt: { type: 'string' },
      },
    };
    expect(exampleFromSchema(schema)).toEqual({
      id: 'xxx',
      ok: false,
      kind: 'a',
      items: [5, 5],
      nested: { x: 0 },
    });
  });
});

describe('util capabilities', () => {
  const r = createDefaultRegistry();
  const run = (name: string, input: unknown) => r.resolveRef(`${name}@^1`)!.adapter.execute(makeCtx(), input);

  it('echoes and no-ops', async () => {
    expect(await run('util-echo', { value: { a: [1] } })).toEqual({ value: { a: [1] } });
    expect(await run('util-noop', {})).toEqual({ ok: true });
  });

  it('asserts', async () => {
    expect(await run('util-assert', { condition: 1 })).toEqual({ passed: true });
    await expect(run('util-assert', { condition: 0, message: 'nope' })).rejects.toMatchObject({
      code: 'ASSERTION_FAILED',
      errorClass: 'business',
      retryable: false,
    });
  });

  it('fails on demand with the requested class', async () => {
    const err = await run('util-fail', { errorClass: 'transient', message: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(CapabilityError);
    expect(err.errorClass).toBe('transient');
    expect(err.retryable).toBe(true);
  });
});
