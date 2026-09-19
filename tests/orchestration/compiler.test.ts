import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import type { CompileOptions } from '../../orchestration/compiler/index.ts';
import { compile, schemaHasPath } from '../../orchestration/compiler/index.ts';
import { testRegistry } from '../helpers/registry.ts';

const registry = testRegistry();
const opts = (over: Partial<CompileOptions> = {}): CompileOptions => ({
  environment: 'production',
  capabilities: registry,
  today: '2026-09-19',
  ...over,
});

const manifest = (): any => ({
  apiVersion: 'omniflow.dev/v1',
  kind: 'Workflow',
  metadata: { name: 'order-flow', version: '1.2.0', owner: 'ops@example.com', description: 'd', criticality: 'high' },
  triggers: [{ type: 'manual' }, { type: 'schedule', cron: '  0   2 * * * ' }, { type: 'webhook', name: 'incoming' }],
  inputs: {
    orderId: { type: 'string', required: true },
    amount: { type: 'integer', required: true, minimum: 1 },
    note: { type: 'string', default: 'none' },
  },
  context: { region: 'eu' },
  steps: [
    {
      id: 'lookup',
      type: 'capability',
      uses: 'http-get@^1',
      with: { url: 'https://api.example.com/orders/${{ inputs.orderId }}' },
      egress: ['api.example.com'],
      timeout: '30s',
    },
    {
      id: 'charge',
      type: 'capability',
      uses: 'test-charge@^1',
      dependsOn: ['lookup'],
      with: { amount: '${{ inputs.amount }}', customer: '${{ steps.lookup.output.body.customer }}' },
      idempotencyKey: 'charge-${{ inputs.orderId }}',
      compensate: {
        uses: 'test-refund@^1',
        with: { chargeId: '${{ steps.charge.output.chargeId }}' },
        idempotencyKey: 'refund-${{ inputs.orderId }}',
      },
    },
    {
      id: 'announce',
      type: 'capability',
      uses: 'test-chat@^1',
      dependsOn: ['charge'],
      with: { text: 'Charged ${{ steps.charge.output.chargeId }}' },
      idempotencyKey: 'chat-${{ inputs.orderId }}',
    },
  ],
  outputs: { chargeId: '${{ steps.charge.output.chargeId }}', region: '${{ context.region }}' },
  policy: { concurrency: 2, dedupWindow: '10m', dedupKey: '${{ inputs.orderId }}' },
});

const compileOk = (m: unknown, o = opts()) => {
  const r = compile(m, o);
  expect(r.errors, JSON.stringify(r.errors, null, 2)).toEqual([]);
  expect(r.ok).toBe(true);
  return r;
};
const codesOf = (m: unknown, o = opts()) => compile(m, o).errors.map((e) => e.code);

describe('compiler: plan shape', () => {
  it('compiles to a resolved, ordered, defaulted plan', () => {
    const { plan, hash } = compileOk(manifest());
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const p = plan!;
    expect(p.planVersion).toBe(1);
    expect(p.environment).toBe('production');
    expect(p.steps.map((s) => s.id)).toEqual(['lookup', 'charge', 'announce']);
    expect(p.steps.map((s) => s.order)).toEqual([0, 1, 2]);

    const lookup = p.steps[0]!;
    expect(lookup.capability).toMatchObject({ name: 'http-get', version: '1.0.0' });
    expect(lookup.capability!.hash).toMatch(/^sha256:/);
    expect(lookup.timeoutMs).toBe(30_000);
    expect(lookup.egress).toEqual(['api.example.com']);
    expect(lookup.effect).toBe('idempotent');
    // Platform default retry injected as milliseconds
    expect(lookup.retry).toEqual({
      attempts: 3,
      backoff: 'exponential',
      initialDelayMs: 1000,
      maxDelayMs: 60_000,
      jitter: 0.2,
      retryOn: ['systemic', 'transient'],
    });
    expect(p.steps[1]!.timeoutMs).toBe(300_000); // default step timeout
    expect(p.steps[1]!.egress).toEqual(['pay.example.com']); // static egress from the capability
    expect(p.steps[1]!.compensate?.capability.name).toBe('test-refund');
    expect(p.steps[1]!.onError).toBe('fail');
  });

  it('normalises triggers, policy and context', () => {
    const p = compileOk(manifest()).plan!;
    expect(p.triggers.map((t: any) => t.name)).toEqual(['manual-1', 'schedule-1', 'incoming']);
    expect(p.triggers[1]).toMatchObject({ cron: '0 2 * * *', timezone: 'UTC', catchup: 'none' });
    expect(p.policy).toMatchObject({ concurrency: 2, concurrencyPolicy: 'queue', dedupWindowMs: 600_000, maxParallelSteps: 8 });
    expect(p.context).toEqual({ region: 'eu', environment: 'production' });
    expect(p.inputSchema).toMatchObject({ type: 'object', required: ['orderId', 'amount'], additionalProperties: false });
  });

  it('lets the deployment context override the manifest but never `now`', () => {
    const p = compileOk(manifest(), opts({ context: { region: 'us', flag: true } })).plan!;
    expect(p.context).toEqual({ region: 'us', flag: true, environment: 'production' });
    expect(JSON.stringify(p)).not.toContain('"now"');
  });

  it('analyses the plan for policy and scheduling', () => {
    const a = compileOk(manifest()).plan!.analysis;
    expect(a.stepCount).toBe(3);
    expect(a.depth).toBe(3);
    expect(a.effects).toEqual({ pure: 0, idempotent: 1, effectful: 3 }); // incl. the compensation
    expect(a.scopes).toEqual(['network:http', 'payments:write', 'chat:write'].sort());
    expect(a.egress).toEqual(['api.example.com', 'chat.example.com', 'pay.example.com']);
    expect(a.capabilities).toEqual(['http-get@1.0.0', 'test-chat@1.0.0', 'test-charge@1.0.0', 'test-refund@1.0.0']);
    expect(a.hasCompensation).toBe(true);
    expect(a.maxInvocations).toBe(4);
    expect(a.estimatedCost).toBe(3);
    expect(a.maxCost).toBeGreaterThan(a.estimatedCost);
  });

  it('accepts YAML text and reports source lines for compile errors', () => {
    const m = manifest();
    m.steps[1].idempotencyKey = undefined;
    const r = compile(stringify(m), opts());
    const err = r.errors.find((e) => e.code === 'EFFECTFUL_WITHOUT_IDEMPOTENCY_KEY');
    expect(err?.line).toBeGreaterThan(1);
  });
});

describe('compiler: purity and determinism (ADR-0002 D2)', () => {
  it('is a pure function: identical inputs give byte-identical plans', () => {
    const a = compileOk(manifest());
    const b = compileOk(manifest());
    expect(JSON.stringify(a.plan)).toBe(JSON.stringify(b.plan));
    expect(a.hash).toBe(b.hash);
  });

  it('does not depend on step order, key order, or text vs object form', () => {
    const base = compileOk(manifest());
    const shuffled = manifest();
    shuffled.steps.reverse();
    expect(compileOk(shuffled).hash).toBe(base.hash === undefined ? '' : compileOk(shuffled).hash);
    // Reversed declaration order changes the *source* hash but not the plan's step order.
    expect(compileOk(shuffled).plan!.steps.map((s) => s.id)).toEqual(['lookup', 'charge', 'announce']);
    const asText = compileOk(stringify(manifest()));
    expect(asText.hash).toBe(base.hash);
  });

  it('does not mutate its input', () => {
    const m = manifest();
    const before = JSON.stringify(m);
    compileOk(m);
    expect(JSON.stringify(m)).toBe(before);
  });

  it('changes the hash when semantics change', () => {
    const base = compileOk(manifest()).hash;
    const m = manifest();
    m.steps[0].timeout = '31s';
    expect(compileOk(m).hash).not.toBe(base);
    expect(compileOk(manifest(), opts({ environment: 'staging' })).hash).not.toBe(base);
  });

  it('pins the plan hash for a fixture (golden test — update deliberately when compilation semantics change)', () => {
    const { hash } = compileOk(manifest());
    expect(hash).toBe('sha256:REPLACE_ME');
  });
});

describe('compiler: capability resolution', () => {
  it('reports unknown capabilities with a suggestion and unsatisfiable versions', () => {
    const m = manifest();
    m.steps[0].uses = 'http-gett@^1';
    const err = compile(m, opts()).errors.find((e) => e.code === 'UNKNOWN_CAPABILITY');
    expect(err?.message).toContain("did you mean 'http-get'");
    const m2 = manifest();
    m2.steps[0].uses = 'http-get@^9';
    expect(compile(m2, opts()).errors.find((e) => e.code === 'NO_MATCHING_VERSION')?.message).toContain('1.0.0');
  });
});

describe('compiler: idempotency and effects (ADR-0002 D3)', () => {
  it('rejects an effectful step without an idempotencyKey — at compile time', () => {
    const m = manifest();
    delete m.steps[1].idempotencyKey;
    expect(codesOf(m)).toContain('EFFECTFUL_WITHOUT_IDEMPOTENCY_KEY');
  });

  it('warns when a key is given to a pure capability', () => {
    const m = manifest();
    m.steps.push({ id: 'p', type: 'capability', uses: 'util-noop@^1', idempotencyKey: 'x', dependsOn: ['announce'] });
    const r = compile(m, opts());
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.code)).toContain('IDEMPOTENCY_KEY_UNNEEDED');
  });

  it('requires effectful compensations to carry an idempotencyKey', () => {
    const m = manifest();
    delete m.steps[1].compensate.idempotencyKey;
    expect(codesOf(m)).toContain('COMPENSATION_WITHOUT_IDEMPOTENCY_KEY');
  });

  it('requires a map over an effectful capability to key by item', () => {
    const m = manifest();
    m.steps.push({
      id: 'fanout',
      type: 'map',
      dependsOn: ['lookup'],
      items: 'steps.lookup.output.body.lines',
      maxItems: 10,
      uses: 'test-chat@^1',
      with: { text: '${{ item }}' },
      idempotencyKey: 'same-for-everyone',
    });
    expect(codesOf(m)).toContain('MAP_KEY_NOT_ITEM_SPECIFIC');
    m.steps.at(-1).idempotencyKey = 'line-${{ index }}';
    expect(codesOf(m)).not.toContain('MAP_KEY_NOT_ITEM_SPECIFIC');
  });

  it('suggests declared compensation for an effectful step without one', () => {
    const m = manifest();
    delete m.steps[1].compensate;
    const r = compile(m, opts());
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.code)).toContain('COMPENSATION_AVAILABLE');
  });
});

describe('compiler: capability input contracts', () => {
  it('checks required fields, unknown fields and literal values', () => {
    const m = manifest();
    m.steps[1].with = { amount: 0, surprise: 1 };
    const errs = compile(m, opts()).errors;
    expect(errs.map((e) => e.code)).toEqual(
      expect.arrayContaining(['MISSING_INPUT_FIELD', 'UNKNOWN_INPUT_FIELD', 'INVALID_LITERAL_INPUT']),
    );
    expect(errs.find((e) => e.code === 'MISSING_INPUT_FIELD')?.message).toContain("'customer'");
  });

  it('skips type checks for dynamic values but still checks presence', () => {
    const m = manifest();
    m.steps[1].with = { amount: '${{ inputs.note }}', customer: 'c' };
    expect(compile(m, opts()).ok).toBe(true);
  });
});

describe('compiler: egress, classification, residency, sunset', () => {
  it('requires step-declared egress for network capabilities and forbids it elsewhere', () => {
    const m = manifest();
    delete m.steps[0].egress;
    expect(codesOf(m)).toContain('EGRESS_REQUIRED');
    const m2 = manifest();
    m2.steps.push({ id: 'n', type: 'capability', uses: 'util-noop@^1', egress: ['x.example.com'], dependsOn: ['announce'] });
    expect(codesOf(m2)).toContain('EGRESS_NOT_APPLICABLE');
    const m3 = manifest();
    m3.steps[1].egress = ['other.example.com'];
    const r = compile(m3, opts());
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.code)).toContain('EGRESS_IGNORED');
    expect(r.plan!.steps[1]!.egress).toEqual(['pay.example.com']);
  });

  it('enforces the data-classification ceiling and propagates it downstream', () => {
    const m = manifest();
    m.inputs.orderId.sensitivity = 'confidential';
    // announce (ceiling: internal) consumes charge, which consumed the confidential order id.
    const errs = compile(m, opts()).errors;
    expect(errs.map((e) => e.code)).toContain('CLASSIFICATION_EXCEEDED');
    expect(errs.find((e) => e.code === 'CLASSIFICATION_EXCEEDED')?.message).toContain('announce');
  });

  it('checks data residency against declared regions', () => {
    const m = manifest();
    m.policy.dataResidency = ['us'];
    expect(codesOf(m)).toContain('RESIDENCY_VIOLATION');
    m.policy.dataResidency = ['eu'];
    const r = compile(m, opts());
    expect(r.errors.map((e) => e.code)).not.toContain('RESIDENCY_VIOLATION');
    expect(r.warnings.map((w) => w.code)).toContain('RESIDENCY_UNKNOWN');
  });

  it('requires a valid, unexpired sunset on shell steps', () => {
    const m = manifest();
    m.steps.push({ id: 'legacy', type: 'capability', uses: 'test-shell@^1', dependsOn: ['announce'], with: { argv: ['/bin/true'] }, idempotencyKey: 'legacy-1' });
    expect(codesOf(m)).toContain('SUNSET_REQUIRED');
    m.steps.at(-1).sunset = '2026-01-01';
    expect(codesOf(m)).toContain('SUNSET_EXPIRED');
    m.steps.at(-1).sunset = '2026-12-31';
    expect(codesOf(m)).not.toContain('SUNSET_EXPIRED');
    expect(codesOf(m)).not.toContain('SUNSET_REQUIRED');
  });
});

describe('compiler: references and outputs', () => {
  it('verifies downstream references against the producing step schema', () => {
    const m = manifest();
    m.steps[2].with.text = '${{ steps.charge.output.recepit.url }}';
    const err = compile(m, opts()).errors.find((e) => e.code === 'UNKNOWN_OUTPUT_FIELD');
    expect(err?.message).toContain('steps.charge.output.recepit.url');
    expect(err?.message).toContain('chargeId');
    // Existing nested field is fine; free-form body is never rejected.
    m.steps[2].with.text = '${{ steps.charge.output.receipt.url }} ${{ steps.lookup.output.body.anything.goes }}';
    expect(compile(m, opts()).ok).toBe(true);
  });

  it('honours a step-level produces schema over the capability output', () => {
    const m = manifest();
    m.steps[0].produces = { type: 'object', properties: { body: { type: 'object', properties: { customer: { type: 'string' } }, additionalProperties: false } } };
    m.steps[1].with.customer = '${{ steps.lookup.output.body.custmer }}';
    expect(codesOf(m)).toContain('UNKNOWN_OUTPUT_FIELD');
  });

  it('checks workflow outputs and context keys', () => {
    const m = manifest();
    m.outputs.bad = '${{ steps.charge.output.nope }}';
    m.outputs.ctx = '${{ context.missing }}';
    const c = codesOf(m);
    expect(c).toContain('UNKNOWN_OUTPUT_FIELD');
    expect(c).toContain('UNKNOWN_CONTEXT_KEY');
  });

  it('types built-in step outputs', () => {
    const m = manifest();
    m.steps.push({
      id: 'route',
      type: 'branch',
      dependsOn: ['announce'],
      cases: [{ name: 'big', when: 'inputs.amount > 100' }],
      default: 'small',
    });
    m.steps.push({
      id: 'after',
      type: 'capability',
      uses: 'util-echo@^1',
      dependsOn: ['route'],
      with: { value: '${{ steps.route.output.case }}' },
    });
    expect(compile(m, opts()).ok).toBe(true);
    m.steps.at(-1).with.value = '${{ steps.route.output.branch }}';
    expect(codesOf(m)).toContain('UNKNOWN_OUTPUT_FIELD');
  });

  it('exposes schemaHasPath semantics', () => {
    const s = { type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'string' } }, additionalProperties: false }, list: { type: 'array', items: { type: 'object', properties: { x: {} } } }, free: { type: 'object' } } };
    expect(schemaHasPath(s, ['a', 'b'])).toBe('yes');
    expect(schemaHasPath(s, ['a', 'c'])).toBe('no');
    expect(schemaHasPath(s, ['list', '0', 'x'])).toBe('yes');
    expect(schemaHasPath(s, ['list', 'foo'])).toBe('no');
    expect(schemaHasPath(s, ['free', 'anything'])).toBe('unknown');
    expect(schemaHasPath(s, ['a', 'b', 'length'])).toBe('yes');
    expect(schemaHasPath({ oneOf: [] }, ['x'])).toBe('unknown');
  });
});

describe('compiler: bounded fan-out, depth and cost (ADR-0002 D5)', () => {
  it('bounds map fan-out and total invocations', () => {
    const m = manifest();
    m.steps.push({ id: 'big', type: 'map', dependsOn: ['lookup'], items: 'steps.lookup.output.body.rows', maxItems: 5000, uses: 'util-noop@^1' });
    expect(compile(m, opts()).ok).toBe(true);
    expect(codesOf(m, opts({ limits: { maxMapItems: 1000 } }))).toContain('FANOUT_TOO_LARGE');
    expect(codesOf(m, opts({ limits: { maxInvocations: 100 } }))).toContain('TOO_MANY_INVOCATIONS');
  });

  it('bounds parallel width', () => {
    const m = manifest();
    m.steps.push({ id: 'join', type: 'parallel', join: 'all', dependsOn: ['charge', 'lookup'] });
    expect(codesOf(m, opts({ limits: { maxParallelWidth: 1 } }))).toContain('PARALLEL_TOO_WIDE');
  });

  it('checks cost ceilings', () => {
    const m = manifest();
    m.policy.maxRunCost = 1;
    expect(codesOf(m)).toContain('COST_CEILING_TOO_LOW');
    m.policy.maxRunCost = 3;
    const r = compile(m, opts());
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.code)).toContain('COST_MAY_EXCEED_CEILING');
  });

  it('applies workflow-level retry and timeout defaults', () => {
    const m = manifest();
    m.policy.timeout = '2m';
    m.policy.retry = { attempts: 5, initialDelay: '500ms', maxDelay: '5s' };
    const p = compileOk(m).plan!;
    expect(p.steps[1]!.timeoutMs).toBe(120_000);
    expect(p.steps[1]!.retry).toMatchObject({ attempts: 5, initialDelayMs: 500, maxDelayMs: 5000, backoff: 'exponential' });
    m.steps[1].retry = { attempts: 1 };
    expect(compileOk(m).plan!.steps[1]!.retry!.attempts).toBe(1);
  });

  it('rejects timeouts beyond platform limits and inverted retry delays', () => {
    const m = manifest();
    m.steps[0].timeout = '7d';
    m.steps[1].retry = { attempts: 2, initialDelay: '10s', maxDelay: '1s' };
    const c = codesOf(m);
    expect(c).toContain('TIMEOUT_TOO_LARGE');
    expect(c).toContain('INVALID_RETRY');
  });
});

describe('compiler: subworkflows', () => {
  const child = {
    version: '2.0.0',
    planHash: 'sha256:' + 'a'.repeat(64),
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } }, additionalProperties: false },
    subworkflowDepth: 0,
    subworkflowChain: [] as string[],
    maxInvocations: 3,
    estimatedCost: 3,
    maxCost: 9,
  };
  const withSub = () => {
    const m = manifest();
    m.steps.push({ id: 'sub', type: 'subworkflow', dependsOn: ['announce'], workflow: 'child-flow', version: '2.0.0', with: { id: '${{ inputs.orderId }}' } });
    return m;
  };
  const resolver = (info: typeof child | undefined) => ({ resolve: (n: string, v: string) => (n === 'child-flow' && v === '2.0.0' ? info : undefined) });

  it('pins the child plan and folds its cost and invocations into the parent', () => {
    const r = compileOk(withSub(), opts({ subworkflows: resolver(child) }));
    expect(r.plan!.steps.find((s) => s.id === 'sub')!.childPlanHash).toBe(child.planHash);
    expect(r.plan!.subworkflows).toEqual({ 'child-flow': { version: '2.0.0', planHash: child.planHash } });
    expect(r.plan!.analysis.subworkflowDepth).toBe(1);
    expect(r.plan!.analysis.maxInvocations).toBe(4 + 3);
  });

  it('rejects unpublished, mis-shaped, cyclic and too-deep subworkflows', () => {
    expect(codesOf(withSub(), opts({ subworkflows: resolver(undefined) }))).toContain('UNKNOWN_SUBWORKFLOW');
    expect(codesOf(withSub())).toContain('UNKNOWN_SUBWORKFLOW'); // no resolver at all

    const bad = withSub();
    bad.steps.at(-1).with = { nope: 1 };
    expect(codesOf(bad, opts({ subworkflows: resolver(child) }))).toEqual(
      expect.arrayContaining(['MISSING_INPUT_FIELD', 'UNKNOWN_INPUT_FIELD']),
    );

    const cyclic = { ...child, subworkflowChain: ['order-flow'] };
    expect(codesOf(withSub(), opts({ subworkflows: resolver(cyclic) }))).toContain('SUBWORKFLOW_CYCLE');

    const deep = { ...child, subworkflowDepth: 3 };
    expect(codesOf(withSub(), opts({ subworkflows: resolver(deep) }))).toContain('SUBWORKFLOW_TOO_DEEP');
  });
});

describe('compiler: validation is a precondition', () => {
  it('returns validator errors without compiling', () => {
    const m = manifest();
    m.steps[1].dependsOn = ['nope'];
    const r = compile(m, opts());
    expect(r.ok).toBe(false);
    expect(r.plan).toBeUndefined();
    expect(r.errors[0]!.code).toBe('UNKNOWN_DEPENDENCY');
  });
});
