import { ERROR_CLASSES, SENSITIVITY_LEVELS } from '../core/index.ts';

/**
 * JSON Schema (draft 2020-12) for workflow manifests, generated from one source of truth.
 * `npm run schemas:emit` writes `manifest.schema.json` for editor tooling (YAML language servers
 * use it for completion and inline validation). Every object is closed (`additionalProperties:
 * false`): there is no escape hatch for arbitrary fields.
 */

type Schema = Record<string, unknown>;

const KEBAB = '^[a-z][a-z0-9]*(-[a-z0-9]+)*$';
const IDENT = '^[A-Za-z][A-Za-z0-9_]*$';
const SEMVER = '^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z-.]+)?(?:\\+[0-9A-Za-z-.]+)?$';

const str = (extra: Schema = {}): Schema => ({ type: 'string', maxLength: 4096, ...extra });
const kebab = (): Schema => ({ type: 'string', pattern: KEBAB, maxLength: 64 });
const expr = (): Schema => ({ type: 'string', minLength: 1, maxLength: 4096 });
const duration = (): Schema => ({ type: ['string', 'integer'], minimum: 0, maxLength: 64 });
const sensitivity = (): Schema => ({ enum: [...SENSITIVITY_LEVELS] });
const errorClass = (): Schema => ({ enum: [...ERROR_CLASSES] });
const obj = (properties: Schema, required: string[] = [], extra: Schema = {}): Schema => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
  ...extra,
});
const freeObject = (max = 100): Schema => ({ type: 'object', maxProperties: max });

const retry: Schema = obj(
  {
    attempts: { type: 'integer', minimum: 1, maximum: 20 },
    backoff: { enum: ['fixed', 'exponential'] },
    initialDelay: duration(),
    maxDelay: duration(),
    jitter: { type: 'number', minimum: 0, maximum: 1 },
    retryOn: { type: 'array', items: errorClass(), uniqueItems: true },
  },
  ['attempts'],
);

const onError: Schema = {
  oneOf: [
    { enum: ['fail', 'continue', 'compensate'] },
    obj({ routeTo: kebab() }, ['routeTo']),
  ],
};

const compensate: Schema = obj(
  {
    uses: str({ minLength: 3 }),
    with: freeObject(),
    idempotencyKey: str(),
    timeout: duration(),
  },
  ['uses'],
);

const stepBaseProps = (): Schema => ({
  id: kebab(),
  name: str({ maxLength: 200 }),
  description: str({ maxLength: 2000 }),
  dependsOn: { type: 'array', items: kebab(), uniqueItems: true, maxItems: 50 },
  when: expr(),
  timeout: duration(),
  retry,
  idempotencyKey: str(),
  compensate,
  onError,
  produces: freeObject(50),
  sensitivity: sensitivity(),
});

const step = (type: string, props: Schema, required: string[] = []): Schema => ({
  type: 'object',
  properties: { ...stepBaseProps(), type: { const: type }, ...props },
  required: ['id', 'type', ...required],
  additionalProperties: false,
});

const hosts: Schema = {
  type: 'array',
  items: str({ minLength: 1, maxLength: 253 }),
  maxItems: 50,
  uniqueItems: true,
};

const steps: Schema[] = [
  step(
    'capability',
    { uses: str({ minLength: 3 }), with: freeObject(), egress: hosts, sunset: str({ maxLength: 32 }) },
    ['uses'],
  ),
  step(
    'branch',
    {
      cases: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        items: obj({ name: kebab(), when: expr() }, ['name', 'when']),
      },
      default: kebab(),
    },
    ['cases'],
  ),
  step('parallel', { join: { enum: ['all', 'any'] } }, ['join', 'dependsOn']),
  step(
    'map',
    {
      items: expr(),
      maxItems: { type: 'integer', minimum: 1, maximum: 100000 },
      concurrency: { type: 'integer', minimum: 1, maximum: 256 },
      errorTolerance: obj({
        count: { type: 'integer', minimum: 0 },
        percent: { type: 'number', minimum: 0, maximum: 100 },
      }),
      uses: str({ minLength: 3 }),
      with: freeObject(),
      egress: hosts,
      sunset: str({ maxLength: 32 }),
    },
    ['items', 'maxItems', 'uses'],
  ),
  step(
    'approval',
    {
      message: str({ minLength: 1 }),
      approvers: obj({
        roles: { type: 'array', items: str({ maxLength: 64 }), maxItems: 20 },
        users: { type: 'array', items: str({ maxLength: 254 }), maxItems: 50 },
      }),
      onTimeout: { enum: ['deny', 'escalate', 'approve'] },
      justification: str({ minLength: 1 }),
      allowSelfApproval: { type: 'boolean' },
    },
    ['message', 'timeout', 'onTimeout'],
  ),
  step(
    'wait',
    {
      duration: duration(),
      until: obj({ event: str({ minLength: 1, maxLength: 200 }), correlation: str() }, ['event']),
    },
    [],
  ),
  step(
    'subworkflow',
    { workflow: kebab(), version: str({ pattern: SEMVER, maxLength: 64 }), with: freeObject() },
    ['workflow', 'version'],
  ),
  step(
    'terminate',
    { status: { enum: ['success', 'failure'] }, errorClass: errorClass(), message: str() },
    ['status'],
  ),
];

const triggers: Schema[] = [
  obj({ type: { const: 'manual' }, name: kebab(), description: str() }, ['type']),
  obj(
    {
      type: { const: 'schedule' },
      name: kebab(),
      cron: str({ minLength: 9, maxLength: 120 }),
      timezone: str({ maxLength: 64 }),
      inputs: freeObject(),
      catchup: { enum: ['none', 'latest'] },
    },
    ['type', 'cron'],
  ),
  obj({ type: { const: 'webhook' }, name: kebab(), inputs: freeObject() }, ['type', 'name']),
  obj(
    {
      type: { const: 'event' },
      name: kebab(),
      event: str({ minLength: 1, maxLength: 200 }),
      filter: expr(),
      inputs: freeObject(),
    },
    ['type', 'event'],
  ),
  obj(
    {
      type: { const: 'workflow-completion' },
      name: kebab(),
      workflow: kebab(),
      status: { enum: ['succeeded', 'failed', 'any'] },
      inputs: freeObject(),
    },
    ['type', 'workflow'],
  ),
];

const inputSpec: Schema = obj(
  {
    type: { enum: ['string', 'integer', 'number', 'boolean', 'object', 'array'] },
    description: str({ maxLength: 1000 }),
    required: { type: 'boolean' },
    default: {},
    enum: { type: 'array', minItems: 1, maxItems: 500 },
    pattern: str({ maxLength: 500 }),
    format: str({ maxLength: 50 }),
    minimum: { type: 'number' },
    maximum: { type: 'number' },
    minLength: { type: 'integer', minimum: 0 },
    maxLength: { type: 'integer', minimum: 0 },
    minItems: { type: 'integer', minimum: 0 },
    maxItems: { type: 'integer', minimum: 0 },
    items: freeObject(50),
    properties: freeObject(100),
    sensitivity: sensitivity(),
  },
  ['type'],
);

const guard: Schema = obj({ name: kebab(), expr: expr(), message: str() }, ['name', 'expr']);

export function buildManifestSchema(): Schema {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://omniflow.dev/schemas/workflow-manifest.v1.json',
    title: 'OmniFlow Workflow Manifest',
    description:
      'Declarative workflow artifact (ADR-0002 D1). Workflows are data, not code; this schema is closed.',
    type: 'object',
    required: ['apiVersion', 'kind', 'metadata', 'triggers', 'inputs', 'steps'],
    additionalProperties: false,
    properties: {
      apiVersion: { const: 'omniflow.dev/v1' },
      kind: { const: 'Workflow' },
      metadata: obj(
        {
          name: kebab(),
          version: str({ pattern: SEMVER, maxLength: 64 }),
          owner: str({ minLength: 1, maxLength: 254 }),
          team: str({ maxLength: 100 }),
          description: str({ maxLength: 2000 }),
          labels: {
            type: 'object',
            maxProperties: 30,
            additionalProperties: str({ maxLength: 200 }),
          },
          criticality: { enum: ['low', 'medium', 'high', 'critical'] },
        },
        ['name', 'version', 'owner'],
      ),
      triggers: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        items: { oneOf: triggers, discriminator: { propertyName: 'type' } },
      },
      inputs: {
        type: 'object',
        maxProperties: 50,
        propertyNames: { pattern: IDENT },
        additionalProperties: inputSpec,
      },
      context: { type: 'object', maxProperties: 50, propertyNames: { pattern: IDENT } },
      steps: {
        type: 'array',
        minItems: 1,
        maxItems: 200,
        items: { oneOf: steps, discriminator: { propertyName: 'type' } },
      },
      guards: obj({
        pre: { type: 'array', items: guard, maxItems: 50 },
        invariants: { type: 'array', items: guard, maxItems: 50 },
      }),
      outputs: { type: 'object', maxProperties: 50 },
      policy: obj({
        timeout: duration(),
        retry,
        concurrency: { type: 'integer', minimum: 1, maximum: 1000 },
        concurrencyPolicy: { enum: ['queue', 'skip'] },
        maxParallelSteps: { type: 'integer', minimum: 1, maximum: 256 },
        dataResidency: { type: 'array', items: str({ maxLength: 32 }), maxItems: 20 },
        maxRunCost: { type: 'number', minimum: 0 },
        maxDailyCost: { type: 'number', minimum: 0 },
        dedupWindow: duration(),
        dedupKey: str(),
      }),
      observability: obj({
        slo: obj({
          successRate: { type: 'number', minimum: 0, maximum: 1 },
          p95Duration: duration(),
        }),
        alerts: obj({
          onFailure: { type: 'array', items: kebab(), maxItems: 20 },
          onCompensationFailed: { type: 'array', items: kebab(), maxItems: 20 },
          onApprovalRequested: { type: 'array', items: kebab(), maxItems: 20 },
        }),
        metrics: {
          type: 'array',
          maxItems: 50,
          items: obj({ name: str({ pattern: '^[a-z][a-z0-9_]*$' }), value: expr(), unit: str() }, [
            'name',
            'value',
          ]),
        },
      }),
    },
  };
}
