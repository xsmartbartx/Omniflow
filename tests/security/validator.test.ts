import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { buildManifestSchema } from '../../schemas/index.ts';
import {
  checkSchemaDefinition,
  isIsoDate,
  isSuspiciousRegex,
  isValidEgressHost,
  parseCapabilityRef,
  validateManifest,
  validateValue,
} from '../../security/validator/index.ts';

const base = () => ({
  apiVersion: 'omniflow.dev/v1',
  kind: 'Workflow',
  metadata: {
    name: 'demo-flow',
    version: '1.0.0',
    owner: 'team@example.com',
    description: 'Demo',
    criticality: 'low',
  },
  triggers: [{ type: 'manual' }],
  inputs: {
    customerId: { type: 'string', required: true },
    limit: { type: 'integer', default: 10, minimum: 1, maximum: 100 },
  },
  steps: [
    {
      id: 'fetch',
      type: 'capability',
      uses: 'http-get@^1',
      with: { url: 'https://api.example.com/c/${{ inputs.customerId }}' },
      egress: ['api.example.com'],
    },
    {
      id: 'notify',
      type: 'capability',
      uses: 'notify-webhook@^1',
      dependsOn: ['fetch'],
      with: { url: 'https://hooks.example.com/x', body: '${{ steps.fetch.output.body }}' },
      idempotencyKey: 'n-${{ inputs.customerId }}',
    },
  ],
  outputs: { status: '${{ steps.fetch.output.status }}' },
});

const errorsOf = (m: unknown) => validateManifest(m).errors;
const codes = (m: unknown) => errorsOf(m).map((e) => e.code);

describe('manifest validator: happy path', () => {
  it('accepts a valid manifest, as an object and as YAML text', () => {
    const asObject = validateManifest(base());
    expect(asObject.errors).toEqual([]);
    expect(asObject.ok).toBe(true);
    expect(asObject.manifest?.metadata.name).toBe('demo-flow');

    const asYaml = validateManifest(stringify(base()));
    expect(asYaml.ok).toBe(true);
  });

  it('also accepts JSON text', () => {
    expect(validateManifest(JSON.stringify(base())).ok).toBe(true);
  });

  it('emits a schema that compiles under the strict validator', () => {
    expect(() => JSON.stringify(buildManifestSchema())).not.toThrow();
    expect(validateManifest(base()).issues.filter((i) => i.severity !== 'warning')).toEqual([]);
  });
});

describe('manifest validator: YAML handling and positions', () => {
  it('reports YAML syntax errors with line and column', () => {
    const r = validateManifest('apiVersion: omniflow.dev/v1\nkind: [unclosed\n');
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.code).toMatch(/^YAML_/);
    expect(r.errors[0]!.line).toBeGreaterThanOrEqual(1);
  });

  it('rejects aliases, anchors and merge keys', () => {
    const doc = `${stringify(base())}\nextra: &a {x: 1}\nmore: *a\n`;
    const r = validateManifest(doc);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toEqual(
      expect.arrayContaining(['YAML_ANCHOR_FORBIDDEN', 'YAML_ALIAS_FORBIDDEN']),
    );
    const merge = validateManifest('a: &x {k: 1}\nb:\n  <<: *x\n');
    expect(merge.errors.some((e) => e.code === 'YAML_MERGE_FORBIDDEN')).toBe(true);
  });

  it('rejects duplicate keys', () => {
    const r = validateManifest('kind: Workflow\nkind: Workflow\n');
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.code).toMatch(/^YAML_/);
  });

  it('points at the exact line of a schema error', () => {
    const text = [
      'apiVersion: omniflow.dev/v1',
      'kind: Workflow',
      'metadata:',
      '  name: demo-flow',
      '  version: 1.0.0',
      '  owner: a@b.c',
      'triggers:',
      '  - type: manual',
      'inputs: {}',
      'steps:',
      '  - id: only',
      '    type: capability',
      '    uses: util-noop@^1',
      '    timeoutt: 5s',
      '',
    ].join('\n');
    const r = validateManifest(text);
    const err = r.errors.find((e) => e.message.startsWith("Unknown property 'timeoutt'"));
    expect(err).toBeDefined();
    expect(err!.line).toBe(14);
    expect(err!.message).toContain("did you mean 'timeout'");
  });

  it('points at the offending step in a semantic error', () => {
    const text = [
      'apiVersion: omniflow.dev/v1',
      'kind: Workflow',
      'metadata: {name: demo-flow, version: 1.0.0, owner: a@b.c}',
      'triggers: [{type: manual}]',
      'inputs: {}',
      'steps:',
      '  - id: a',
      '    type: capability',
      '    uses: util-noop@^1',
      '    dependsOn: [ghost]',
    ].join('\n');
    const r = validateManifest(text);
    const err = r.errors.find((e) => e.code === 'UNKNOWN_DEPENDENCY');
    expect(err?.line).toBe(10);
    expect(err?.path).toBe('steps[0].dependsOn[0]');
  });

  it('enforces the document size limit', () => {
    const r = validateManifest(`a: ${'x'.repeat(2000)}`, { maxBytes: 100 });
    expect(r.errors[0]!.code).toBe('DOCUMENT_TOO_LARGE');
  });
});

describe('manifest validator: schema errors', () => {
  it('reports missing required properties', () => {
    const m: any = base();
    delete m.metadata.owner;
    expect(errorsOf(m).some((e) => e.message.includes("Missing required property 'owner'"))).toBe(true);
  });

  it('rejects unknown top-level properties (closed schema)', () => {
    const m: any = base();
    m.script = 'rm -rf /';
    expect(errorsOf(m).some((e) => e.message.includes("Unknown property 'script'"))).toBe(true);
  });

  it('reports an unknown step type via the discriminator', () => {
    const m: any = base();
    m.steps[0].type = 'shell-script';
    expect(codes(m)).toContain('SCHEMA_DISCRIMINATOR');
  });

  it('validates enums, patterns and ranges', () => {
    const m: any = base();
    m.metadata.name = 'Not_Kebab';
    m.metadata.version = 'v1';
    m.metadata.criticality = 'urgent';
    const errs = errorsOf(m);
    expect(errs.some((e) => e.path === 'metadata.name')).toBe(true);
    expect(errs.some((e) => e.path === 'metadata.version')).toBe(true);
    expect(errs.some((e) => e.path === 'metadata.criticality' && e.message.startsWith('Must be one of'))).toBe(true);
  });

  it('requires per-type fields', () => {
    const m: any = base();
    m.steps.push({ id: 'p', type: 'parallel', dependsOn: ['fetch', 'notify'] });
    m.steps.push({ id: 'ap', type: 'approval', message: 'ok?' });
    const errs = errorsOf(m);
    expect(errs.some((e) => e.message.includes("'join'"))).toBe(true);
    expect(errs.some((e) => e.message.includes("'onTimeout'"))).toBe(true);
    expect(errs.some((e) => e.message.includes("'timeout'"))).toBe(true);
  });

  it('rejects an invalid onError', () => {
    const m: any = base();
    m.steps[0].onError = 'ignore';
    expect(errorsOf(m).length).toBeGreaterThan(0);
  });
});

describe('manifest validator: graph rules', () => {
  it('rejects duplicate ids, unknown and self dependencies', () => {
    const m: any = base();
    m.steps.push({ ...m.steps[0] });
    expect(codes(m)).toContain('DUPLICATE_STEP_ID');

    const m2: any = base();
    m2.steps[0].dependsOn = ['nope', 'fetch'];
    expect(codes(m2)).toEqual(expect.arrayContaining(['UNKNOWN_DEPENDENCY', 'SELF_DEPENDENCY']));
  });

  it('reports the concrete cycle', () => {
    const m: any = base();
    m.steps[0].dependsOn = ['notify'];
    const err = errorsOf(m).find((e) => e.code === 'DEPENDENCY_CYCLE');
    expect(err?.message).toMatch(/fetch → notify → fetch|notify → fetch → notify/);
  });

  it('refuses anything depending on a terminate step', () => {
    const m: any = base();
    m.steps.push({ id: 'stop', type: 'terminate', status: 'success' });
    m.steps[1].dependsOn = ['fetch', 'stop'];
    expect(codes(m)).toContain('DEPENDS_ON_TERMINATE');
  });

  it('checks routeTo targets', () => {
    const m: any = base();
    m.steps[0].onError = { routeTo: 'ghost' };
    expect(codes(m)).toContain('UNKNOWN_ROUTE_TARGET');
    const m2: any = base();
    m2.steps[0].onError = { routeTo: 'notify' };
    expect(codes(m2)).not.toContain('ROUTE_TARGET_NOT_DEPENDENT'); // notify depends on fetch
    m2.steps.push({ id: 'other', type: 'capability', uses: 'util-noop@^1' });
    m2.steps[0].onError = { routeTo: 'other' };
    expect(codes(m2)).toContain('ROUTE_TARGET_NOT_DEPENDENT');
  });
});

describe('manifest validator: data-flow and secrets', () => {
  it('rejects references to steps that are not upstream', () => {
    const m: any = base();
    m.steps[0].with.extra = '${{ steps.notify.output.x }}';
    expect(codes(m)).toContain('STEP_NOT_UPSTREAM');
  });

  it('rejects unknown steps, inputs, roots and fields', () => {
    const m: any = base();
    m.steps[1].with.a = '${{ steps.ghost.output }}';
    m.steps[1].with.b = '${{ inputs.nothing }}';
    m.steps[1].with.c = '${{ process.env }}';
    m.steps[1].with.d = '${{ steps.fetch.stdout }}';
    m.steps[1].with.e = '${{ run.password }}';
    expect(codes(m)).toEqual(
      expect.arrayContaining([
        'UNKNOWN_STEP_REFERENCE',
        'UNKNOWN_INPUT',
        'UNKNOWN_REFERENCE_ROOT',
        'UNKNOWN_STEP_FIELD',
        'UNKNOWN_RUN_FIELD',
      ]),
    );
  });

  it('allows secrets only inside step inputs', () => {
    const ok: any = base();
    ok.steps[1].with.token = '${{ secrets.API_TOKEN }}';
    expect(validateManifest(ok).ok).toBe(true);

    for (const place of ['when', 'idempotencyKey', 'outputs'] as const) {
      const bad: any = base();
      if (place === 'when') bad.steps[1].when = 'secrets.API_TOKEN != null';
      if (place === 'idempotencyKey') bad.steps[1].idempotencyKey = 'k-${{ secrets.API_TOKEN }}';
      if (place === 'outputs') bad.outputs.leak = '${{ secrets.API_TOKEN }}';
      expect(codes(bad), place).toContain('SECRET_NOT_ALLOWED');
    }
  });

  it('reports expression syntax errors with the template location', () => {
    const m: any = base();
    m.steps[1].with.body = '${{ 1 + }}';
    const err = errorsOf(m).find((e) => e.code === 'EXPRESSION_SYNTAX');
    expect(err?.path).toBe('steps[1].with.body');
  });

  it('restricts item/index to map bodies', () => {
    const m: any = base();
    m.steps[1].with.x = '${{ item }}';
    expect(codes(m)).toContain('UNKNOWN_REFERENCE_ROOT');
    const ok: any = base();
    ok.steps.push({
      id: 'each',
      type: 'map',
      items: 'steps.fetch.output.body.rows',
      maxItems: 10,
      uses: 'http-get@^1',
      dependsOn: ['fetch'],
      egress: ['api.example.com'],
      with: { url: 'https://api.example.com/r/${{ item.id }}?i=${{ index }}' },
    });
    expect(validateManifest(ok).errors).toEqual([]);
  });

  it('lets compensation read its own step output', () => {
    const m: any = base();
    m.steps[0].compensate = {
      uses: 'http-request@^1',
      with: { url: 'https://api.example.com/undo/${{ steps.fetch.output.body.id }}' },
    };
    expect(validateManifest(m).errors).toEqual([]);
  });
});

describe('manifest validator: step-type rules', () => {
  it('requires exhaustive branches', () => {
    const m: any = base();
    m.steps.push({
      id: 'route',
      type: 'branch',
      dependsOn: ['fetch'],
      cases: [{ name: 'big', when: 'steps.fetch.output.status > 200' }],
    });
    expect(codes(m)).toContain('BRANCH_NOT_EXHAUSTIVE');
    m.steps[2].default = 'other';
    expect(codes(m)).not.toContain('BRANCH_NOT_EXHAUSTIVE');
    delete m.steps[2].default;
    m.steps[2].cases.push({ name: 'rest', when: 'true' });
    expect(codes(m)).not.toContain('BRANCH_NOT_EXHAUSTIVE');
  });

  it('checks approval, wait, parallel and map constraints', () => {
    const m: any = base();
    m.steps.push({
      id: 'gate',
      type: 'approval',
      message: 'ok?',
      timeout: '1h',
      onTimeout: 'approve',
      dependsOn: ['fetch'],
    });
    m.steps.push({ id: 'w', type: 'wait', dependsOn: ['fetch'] });
    m.steps.push({ id: 'w2', type: 'wait', until: { event: 'x.done' }, dependsOn: ['fetch'] });
    m.steps.push({ id: 'j', type: 'parallel', join: 'all', dependsOn: ['fetch'] });
    m.steps.push({
      id: 'big',
      type: 'map',
      items: 'inputs.list',
      maxItems: 10,
      uses: 'util-noop@^1',
      dependsOn: ['fetch'],
    });
    const c = codes(m);
    expect(c).toContain('APPROVE_BY_DEFAULT_NEEDS_JUSTIFICATION');
    expect(c).toContain('WAIT_NEEDS_ONE_OF');
    expect(c).toContain('WAIT_EVENT_NEEDS_TIMEOUT');
    expect(c).toContain('PARALLEL_NEEDS_BRANCHES');
  });

  it('rejects a fan-out above the platform ceiling', () => {
    const m: any = base();
    m.steps.push({
      id: 'big',
      type: 'map',
      items: 'inputs.list',
      maxItems: 100000000,
      uses: 'util-noop@^1',
    });
    expect(codes(m)).toContain('SCHEMA_MAXIMUM');
  });

  it('validates capability references, durations, egress and sunset', () => {
    const m: any = base();
    m.steps[0].uses = 'http-get';
    m.steps[0].timeout = 'soon';
    m.steps[0].egress = ['*', 'not a host'];
    m.steps[0].sunset = '2026-13-45';
    m.steps[1].uses = 'notify-webhook@latest';
    const c = codes(m);
    expect(c.filter((x) => x === 'INVALID_CAPABILITY_REF')).toHaveLength(2);
    expect(c).toContain('INVALID_DURATION');
    expect(c.filter((x) => x === 'INVALID_EGRESS_HOST')).toHaveLength(2);
    expect(c).toContain('INVALID_SUNSET');
  });

  it('restricts retry, idempotencyKey and compensate to applicable step types', () => {
    const m: any = base();
    m.steps.push({
      id: 'stop',
      type: 'terminate',
      status: 'success',
      retry: { attempts: 3 },
      idempotencyKey: 'x',
      compensate: { uses: 'a-b@^1' },
      dependsOn: ['fetch'],
    });
    const c = codes(m);
    expect(c).toEqual(
      expect.arrayContaining(['RETRY_NOT_APPLICABLE', 'IDEMPOTENCY_NOT_APPLICABLE', 'COMPENSATE_NOT_APPLICABLE']),
    );
  });

  it('rejects a recursive subworkflow reference', () => {
    const m: any = base();
    m.steps.push({
      id: 'again',
      type: 'subworkflow',
      workflow: 'demo-flow',
      version: '1.0.0',
      dependsOn: ['fetch'],
    });
    expect(codes(m)).toContain('RECURSIVE_SUBWORKFLOW');
  });
});

describe('manifest validator: triggers, inputs, guards, policy', () => {
  it('validates cron and timezone', () => {
    const m: any = base();
    m.triggers = [{ type: 'schedule', cron: '99 * * * *', timezone: 'Mars/Olympus' }];
    expect(codes(m)).toEqual(expect.arrayContaining(['INVALID_CRON', 'INVALID_TIMEZONE']));
    m.triggers = [
      {
        type: 'schedule',
        cron: '0 2 * * *',
        timezone: 'Europe/Warsaw',
        inputs: { customerId: 'c1' },
      },
    ];
    expect(validateManifest(m).errors).toEqual([]);
  });

  it('validates scheduled inputs against the inputs schema', () => {
    const m: any = base();
    m.triggers = [{ type: 'schedule', cron: '0 2 * * *', inputs: { nope: 1 } }];
    expect(codes(m)).toContain('INVALID_TRIGGER_INPUTS');
  });

  it('rejects duplicate trigger names and self-triggering', () => {
    const m: any = base();
    m.triggers = [
      { type: 'webhook', name: 'hook' },
      { type: 'webhook', name: 'hook' },
      { type: 'workflow-completion', workflow: 'demo-flow' },
    ];
    expect(codes(m)).toEqual(expect.arrayContaining(['DUPLICATE_TRIGGER', 'SELF_TRIGGER']));
  });

  it('checks input defaults, ranges and unsafe regexes', () => {
    const m: any = base();
    m.inputs.limit.default = 1000;
    m.inputs.tag = { type: 'string', pattern: '(a+)+$' };
    m.inputs.range = { type: 'integer', minimum: 10, maximum: 1 };
    m.inputs.bad = { type: 'string', pattern: '(' };
    const c = codes(m);
    expect(c).toEqual(expect.arrayContaining(['INVALID_DEFAULT', 'UNSAFE_REGEX', 'INVALID_RANGE', 'INVALID_REGEX']));
  });

  it('rejects reserved context keys', () => {
    const m: any = base();
    m.context = { now: 'x', region: 'eu' };
    expect(codes(m)).toContain('RESERVED_CONTEXT_KEY');
  });

  it('validates guards and outputs scopes', () => {
    const m: any = base();
    m.guards = {
      pre: [
        { name: 'has-id', expr: 'len(inputs.customerId) > 0' },
        { name: 'bad', expr: 'steps.fetch.output != null' },
      ],
      invariants: [{ name: 'ok', expr: 'steps.fetch.output.status < 500' }],
    };
    expect(errorsOf(m).some((e) => e.path === 'guards.pre[1].expr')).toBe(true);
    expect(errorsOf(m).some((e) => e.path.startsWith('guards.invariants'))).toBe(false);
  });

  it('warns rather than errors for advisory issues', () => {
    const m: any = base();
    delete m.metadata.description;
    delete m.metadata.criticality;
    const r = validateManifest(m);
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(['MISSING_DESCRIPTION', 'MISSING_CRITICALITY']),
    );
  });

  it('checks policy durations and dedup settings', () => {
    const m: any = base();
    m.policy = { timeout: 'nope', dedupKey: 'x-${{ inputs.customerId }}' };
    const r = validateManifest(m);
    expect(r.errors.map((e) => e.code)).toContain('INVALID_DURATION');
    expect(r.warnings.map((e) => e.code)).toContain('DEDUP_WITHOUT_WINDOW');
  });
});

describe('validator helpers', () => {
  it('parses capability references', () => {
    expect(parseCapabilityRef('http-get@^1')).toEqual({ name: 'http-get', range: '^1' });
    expect(parseCapabilityRef('http-get@1.2.3')).not.toBeNull();
    expect(parseCapabilityRef('http-get@>=1.0.0 <2.0.0')).not.toBeNull();
    for (const bad of ['http-get', '@1', 'Http@1', 'a@', 'a@*', 'a@latest', 'a@not-a-range']) {
      expect(parseCapabilityRef(bad), bad).toBeNull();
    }
  });

  it('validates egress hosts, ISO dates and suspicious regexes', () => {
    expect(isValidEgressHost('api.example.com')).toBe(true);
    expect(isValidEgressHost('*.example.com')).toBe(true);
    expect(isValidEgressHost('localhost:8080')).toBe(true);
    expect(isValidEgressHost('*')).toBe(false);
    expect(isValidEgressHost('http://x.com')).toBe(false);
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isSuspiciousRegex('^[a-z]+$')).toBe(false);
    expect(isSuspiciousRegex('(a+)+$')).toBe(true);
    expect(isSuspiciousRegex('(a|aa)+')).toBe(true);
  });

  it('validates runtime values, applies defaults, and never mutates the input', () => {
    const schema = {
      type: 'object',
      properties: { n: { type: 'integer', default: 5 }, s: { type: 'string' } },
      required: ['s'],
      additionalProperties: false,
    };
    const input = { s: 'x' };
    const ok = validateValue<{ n: number }>(schema, input);
    expect(ok.ok).toBe(true);
    expect(ok.value.n).toBe(5);
    expect(input).toEqual({ s: 'x' });
    const bad = validateValue(schema, { s: 1, extra: true });
    expect(bad.ok).toBe(false);
    expect(bad.issues.length).toBeGreaterThanOrEqual(2);
    // No coercion: a numeric string is not an integer.
    expect(validateValue(schema, { s: 'x', n: '5' }).ok).toBe(false);
  });

  it('checks that author schemas are valid', () => {
    expect(checkSchemaDefinition({ type: 'object' })).toBeNull();
    expect(checkSchemaDefinition({ type: 'nonsense' })).not.toBeNull();
    expect(checkSchemaDefinition('x')).not.toBeNull();
  });
});
