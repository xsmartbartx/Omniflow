import { Cron } from 'croner';
import {
  collectReferences,
  ExpressionSyntaxError,
  hasTemplate,
  type Issue,
  isDuration,
  parseExpressionField,
  parseTemplate,
  type Reference,
  scanTemplates,
  topologicalOrder,
  transitiveDependencies,
} from '../../core/index.ts';
import { inputsToJsonSchema } from '../../schemas/inputs.ts';
import { buildManifestSchema } from '../../schemas/manifest.schema.ts';
import {
  type InputSpec,
  type Manifest,
  RESERVED_CONTEXT_KEYS,
  RUN_SCOPE_KEYS,
  STEP_OUTPUT_KEYS,
  type Step,
} from '../../schemas/manifest.ts';
import { isIsoDate, isSuspiciousRegex, isValidEgressHost, parseCapabilityRef } from './refs.ts';
import { checkSchemaDefinition, validateAgainstSchema, validateValue } from './schema-validator.ts';
import { DEFAULT_MAX_BYTES, formatPath, type Locator, type PathSegment, parseSource } from './source-map.ts';

export interface ManifestValidation {
  ok: boolean;
  manifest?: Manifest;
  /** Errors and warnings, in source order. */
  issues: Issue[];
  errors: Issue[];
  warnings: Issue[];
}

const manifestSchema = buildManifestSchema();

/** Hard platform ceilings the validator enforces regardless of environment. */
export const LIMITS = {
  maxSteps: 200,
  maxMapItems: 100_000,
  maxManifestBytes: DEFAULT_MAX_BYTES,
} as const;

interface ExprScope {
  roots: ReadonlySet<string>;
  /** Step ids whose outputs may be read; `'all'` for places evaluated after the DAG (outputs, invariants). */
  steps: ReadonlySet<string> | 'all';
  secrets: boolean;
  /** Human label used in messages. */
  where: string;
}

const roots = (...r: string[]) => new Set(r);
const BASE = ['inputs', 'context', 'run'] as const;

/** Validate a manifest given as YAML/JSON text (with source positions) or an already-parsed object. */
export function validateManifest(source: string | unknown, options: { maxBytes?: number } = {}): ManifestValidation {
  let value: unknown;
  let locate: Locator | undefined;
  const issues: Issue[] = [];

  if (typeof source === 'string') {
    const parsed = parseSource(source, options.maxBytes ?? LIMITS.maxManifestBytes);
    issues.push(...parsed.issues);
    if (parsed.value === undefined) return finish(issues);
    value = parsed.value;
    locate = parsed.locate;
  } else {
    value = source;
    if (Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') > (options.maxBytes ?? LIMITS.maxManifestBytes)) {
      return finish([{ path: '', code: 'DOCUMENT_TOO_LARGE', message: 'Manifest is too large' }]);
    }
  }

  const schema = validateAgainstSchema(manifestSchema, value, locate);
  issues.push(...schema.issues);
  if (!schema.ok) return finish(issues);

  const manifest = value as Manifest;
  issues.push(...semanticChecks(manifest, locate));
  const result = finish(issues);
  if (result.ok) result.manifest = manifest;
  return result;
}

function finish(issues: Issue[]): ManifestValidation {
  const sorted = [...issues].sort((a, b) => (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER));
  const errors = sorted.filter((i) => i.severity !== 'warning');
  const warnings = sorted.filter((i) => i.severity === 'warning');
  return { ok: errors.length === 0, issues: sorted, errors, warnings };
}

function semanticChecks(m: Manifest, locate?: Locator): Issue[] {
  const issues: Issue[] = [];

  const add = (
    severity: 'error' | 'warning',
    path: readonly PathSegment[],
    code: string,
    message: string,
    keyLoc = false,
  ) => {
    const pos = locate?.(path, { key: keyLoc });
    issues.push({
      path: formatPath(path),
      code,
      message,
      ...(severity === 'warning' ? { severity } : {}),
      ...(pos ? { line: pos.line, column: pos.column } : {}),
    });
  };
  const error = (path: readonly PathSegment[], code: string, message: string, keyLoc = false) =>
    add('error', path, code, message, keyLoc);
  const warn = (path: readonly PathSegment[], code: string, message: string) => add('warning', path, code, message);

  // ------------------------------------------------------------ metadata
  if (!m.metadata.description) {
    warn(['metadata'], 'MISSING_DESCRIPTION', 'Add a description so reviewers know what this workflow is for');
  }
  if (!m.metadata.criticality) {
    warn(['metadata'], 'MISSING_CRITICALITY', "Set 'criticality' so policy and alerting can be tuned");
  }
  for (const key of Object.keys(m.context ?? {})) {
    if (RESERVED_CONTEXT_KEYS.includes(key)) {
      error(['context', key], 'RESERVED_CONTEXT_KEY', `'${key}' is reserved and injected by the engine`, true);
    }
  }

  // -------------------------------------------------------------- inputs
  const inputNames = new Set(Object.keys(m.inputs));
  for (const [name, spec] of Object.entries(m.inputs) as Array<[string, InputSpec]>) {
    const p = ['inputs', name];
    if (spec.pattern !== undefined) {
      if (isSuspiciousRegex(spec.pattern)) {
        error([...p, 'pattern'], 'UNSAFE_REGEX', 'Pattern risks catastrophic backtracking; simplify it');
      } else {
        try {
          new RegExp(spec.pattern, 'u');
        } catch (e) {
          error([...p, 'pattern'], 'INVALID_REGEX', (e as Error).message);
        }
      }
    }
    for (const k of ['items', 'properties'] as const) {
      const sub = spec[k];
      if (sub !== undefined && k === 'items') {
        const bad = checkSchemaDefinition(sub);
        if (bad) error([...p, k], 'INVALID_SCHEMA', bad);
      }
    }
    if (spec.type === 'integer' || spec.type === 'number') {
      if (spec.minimum !== undefined && spec.maximum !== undefined && spec.minimum > spec.maximum) {
        error([...p, 'minimum'], 'INVALID_RANGE', 'minimum is greater than maximum');
      }
    }
    if (spec.default !== undefined) {
      const res = validateValue(inputsToJsonSchema({ [name]: { ...spec, required: false } }), {
        [name]: spec.default,
      });
      if (!res.ok) {
        error(
          [...p, 'default'],
          'INVALID_DEFAULT',
          `Default does not satisfy the input's own constraints: ${res.issues[0]?.message ?? ''}`,
        );
      }
    }
    if (spec.sensitivity === 'secret') {
      error(
        [...p, 'sensitivity'],
        'SECRET_INPUT_FORBIDDEN',
        "Inputs are stored with the run and cannot be 'secret'. Provide credentials through the Secret Broker and reference them as ${{ secrets.NAME }}.",
      );
    }
    if (spec.required === true && spec.default !== undefined) {
      warn([...p, 'required'], 'REQUIRED_WITH_DEFAULT', "'required' has no effect when a default is given");
    }
  }

  // ------------------------------------------------------------ triggers
  const triggerNames = new Set<string>();
  m.triggers.forEach((t, i) => {
    const p: PathSegment[] = ['triggers', i];
    if ('name' in t && t.name) {
      if (triggerNames.has(t.name)) error([...p, 'name'], 'DUPLICATE_TRIGGER', `Duplicate trigger name '${t.name}'`);
      triggerNames.add(t.name);
    }
    if (t.type === 'schedule') {
      try {
        new Cron(t.cron, { paused: true, timezone: t.timezone });
      } catch (e) {
        error([...p, 'cron'], 'INVALID_CRON', `Invalid cron expression: ${(e as Error).message}`);
      }
      if (t.timezone) {
        try {
          new Intl.DateTimeFormat('en', { timeZone: t.timezone });
        } catch {
          error([...p, 'timezone'], 'INVALID_TIMEZONE', `Unknown IANA timezone '${t.timezone}'`);
        }
      }
      if (t.inputs) {
        const res = validateValue(inputsToJsonSchema(m.inputs), t.inputs);
        if (!res.ok) {
          error(
            [...p, 'inputs'],
            'INVALID_TRIGGER_INPUTS',
            `Scheduled inputs are invalid: ${res.issues[0]?.path} ${res.issues[0]?.message}`,
          );
        }
      }
    }
    if (t.type === 'event' && t.filter) {
      checkExpression(t.filter, [...p, 'filter'], {
        roots: roots('event'),
        steps: new Set(),
        secrets: false,
        where: 'trigger filter',
      });
    }
    if ((t.type === 'webhook' || t.type === 'event' || t.type === 'workflow-completion') && t.inputs) {
      checkValue(t.inputs, [...p, 'inputs'], {
        roots: roots('event', 'context'),
        steps: new Set(),
        secrets: false,
        where: 'trigger input mapping',
      });
    }
    if (t.type === 'workflow-completion' && t.workflow === m.metadata.name) {
      error([...p, 'workflow'], 'SELF_TRIGGER', 'A workflow cannot be triggered by its own completion');
    }
  });

  // --------------------------------------------------------------- steps
  if (m.steps.length > LIMITS.maxSteps) {
    error(['steps'], 'TOO_MANY_STEPS', `A workflow may have at most ${LIMITS.maxSteps} steps`);
  }
  const stepIds = new Set<string>();
  const byId = new Map<string, { step: Step; index: number }>();
  m.steps.forEach((s, i) => {
    if (byId.has(s.id)) {
      error(['steps', i, 'id'], 'DUPLICATE_STEP_ID', `Duplicate step id '${s.id}'`);
    } else {
      byId.set(s.id, { step: s, index: i });
    }
    stepIds.add(s.id);
  });

  const deps = new Map<string, string[]>();
  m.steps.forEach((s, i) => {
    const list: string[] = [];
    (s.dependsOn ?? []).forEach((d, j) => {
      if (d === s.id) error(['steps', i, 'dependsOn', j], 'SELF_DEPENDENCY', `Step '${s.id}' depends on itself`);
      else if (!stepIds.has(d)) {
        error(['steps', i, 'dependsOn', j], 'UNKNOWN_DEPENDENCY', `Step '${s.id}' depends on unknown step '${d}'`);
      } else list.push(d);
    });
    deps.set(s.id, list);
  });

  const topo = topologicalOrder([...stepIds], deps);
  if (topo.cycle) {
    error(['steps'], 'DEPENDENCY_CYCLE', `Dependency cycle: ${topo.cycle.join(' → ')}`);
  }
  const ancestors = topo.cycle ? new Map<string, Set<string>>() : transitiveDependencies(topo.order, deps);

  const scopeFor = (s: Step, o: { secrets?: boolean; item?: boolean; self?: boolean; where: string }): ExprScope => {
    const up = new Set(ancestors.get(s.id) ?? []);
    if (o.self) up.add(s.id);
    return {
      roots: o.item ? roots(...BASE, 'steps', 'secrets', 'item', 'index') : roots(...BASE, 'steps', 'secrets'),
      steps: up,
      secrets: o.secrets ?? false,
      where: o.where,
    };
  };

  const terminateIds = new Set(m.steps.filter((s) => s.type === 'terminate').map((s) => s.id));

  const checkCapabilityRef = (ref: string, path: PathSegment[]) => {
    if (!parseCapabilityRef(ref)) {
      error(
        path,
        'INVALID_CAPABILITY_REF',
        `'${ref}' must look like name@constraint with a valid, explicit semver constraint (e.g. http-get@^1)`,
      );
    }
  };

  m.steps.forEach((s, i) => {
    const p: PathSegment[] = ['steps', i];
    (s.dependsOn ?? []).forEach((d, j) => {
      if (terminateIds.has(d)) {
        error([...p, 'dependsOn', j], 'DEPENDS_ON_TERMINATE', `'${d}' ends the run, so nothing can depend on it`);
      }
    });

    for (const key of ['timeout'] as const) {
      const v = s[key];
      if (v !== undefined && !isDuration(v))
        error([...p, key], 'INVALID_DURATION', `Invalid duration ${JSON.stringify(v)}`);
    }
    if (s.produces !== undefined) {
      const bad = checkSchemaDefinition(s.produces);
      if (bad) error([...p, 'produces'], 'INVALID_SCHEMA', `'produces' is not a valid JSON Schema: ${bad}`);
    }
    if (s.retry) {
      if (!['capability', 'map', 'subworkflow'].includes(s.type)) {
        error([...p, 'retry'], 'RETRY_NOT_APPLICABLE', `'retry' is not allowed on '${s.type}' steps`);
      }
      for (const k of ['initialDelay', 'maxDelay'] as const) {
        const v = s.retry[k];
        if (v !== undefined && !isDuration(v))
          error([...p, 'retry', k], 'INVALID_DURATION', `Invalid duration ${JSON.stringify(v)}`);
      }
    }
    if (s.idempotencyKey !== undefined) {
      if (s.type !== 'capability' && s.type !== 'map') {
        error(
          [...p, 'idempotencyKey'],
          'IDEMPOTENCY_NOT_APPLICABLE',
          `'idempotencyKey' is not allowed on '${s.type}' steps`,
        );
      } else {
        checkValue(
          s.idempotencyKey,
          [...p, 'idempotencyKey'],
          scopeFor(s, { item: s.type === 'map', where: 'idempotencyKey' }),
        );
      }
    }
    if (s.when !== undefined) {
      checkExpression(s.when, [...p, 'when'], scopeFor(s, { where: "'when' condition" }));
    }
    if (s.compensate) {
      if (s.type !== 'capability') {
        error([...p, 'compensate'], 'COMPENSATE_NOT_APPLICABLE', "'compensate' is only allowed on capability steps");
      } else {
        checkCapabilityRef(s.compensate.uses, [...p, 'compensate', 'uses']);
        if (s.compensate.with) {
          checkValue(
            s.compensate.with,
            [...p, 'compensate', 'with'],
            scopeFor(s, { secrets: true, self: true, where: 'compensation input' }),
          );
        }
        if (s.compensate.idempotencyKey) {
          checkValue(
            s.compensate.idempotencyKey,
            [...p, 'compensate', 'idempotencyKey'],
            scopeFor(s, { self: true, where: 'compensation idempotencyKey' }),
          );
        }
        if (s.compensate.timeout !== undefined && !isDuration(s.compensate.timeout)) {
          error([...p, 'compensate', 'timeout'], 'INVALID_DURATION', 'Invalid duration');
        }
      }
    }
    if (typeof s.onError === 'object' && s.onError !== null) {
      const target = s.onError.routeTo;
      const t = byId.get(target);
      if (!t) error([...p, 'onError', 'routeTo'], 'UNKNOWN_ROUTE_TARGET', `routeTo target '${target}' does not exist`);
      else if (target === s.id) error([...p, 'onError', 'routeTo'], 'SELF_ROUTE', 'A step cannot route to itself');
      else if (!(t.step.dependsOn ?? []).includes(s.id)) {
        error(
          [...p, 'onError', 'routeTo'],
          'ROUTE_TARGET_NOT_DEPENDENT',
          `routeTo target '${target}' must list '${s.id}' in its dependsOn`,
        );
      }
    }

    switch (s.type) {
      case 'capability': {
        checkCapabilityRef(s.uses, [...p, 'uses']);
        if (s.with) checkValue(s.with, [...p, 'with'], scopeFor(s, { secrets: true, where: 'step input' }));
        checkStepEgress(s.egress, [...p, 'egress']);
        checkSunset(s.sunset, [...p, 'sunset']);
        break;
      }
      case 'map': {
        checkCapabilityRef(s.uses, [...p, 'uses']);
        checkExpression(s.items, [...p, 'items'], scopeFor(s, { where: "'items' expression" }));
        if (s.with)
          checkValue(s.with, [...p, 'with'], scopeFor(s, { secrets: true, item: true, where: 'map body input' }));
        if (s.maxItems > LIMITS.maxMapItems)
          error([...p, 'maxItems'], 'FANOUT_TOO_LARGE', `maxItems may not exceed ${LIMITS.maxMapItems}`);
        checkStepEgress(s.egress, [...p, 'egress']);
        checkSunset(s.sunset, [...p, 'sunset']);
        if (s.errorTolerance && s.errorTolerance.count === undefined && s.errorTolerance.percent === undefined) {
          error([...p, 'errorTolerance'], 'EMPTY_TOLERANCE', "Set 'count' and/or 'percent'");
        }
        break;
      }
      case 'branch': {
        const names = new Set<string>();
        s.cases.forEach((c, j) => {
          if (names.has(c.name)) error([...p, 'cases', j, 'name'], 'DUPLICATE_CASE', `Duplicate case '${c.name}'`);
          names.add(c.name);
          checkExpression(c.when, [...p, 'cases', j, 'when'], scopeFor(s, { where: 'branch condition' }));
        });
        if (s.default !== undefined && names.has(s.default)) {
          error([...p, 'default'], 'DEFAULT_COLLIDES_WITH_CASE', `default name '${s.default}' is also a case name`);
        }
        const last = s.cases[s.cases.length - 1];
        const alwaysTrue = last !== undefined && /^\s*(\$\{\{\s*)?true(\s*\}\})?\s*$/.test(last.when);
        if (s.default === undefined && !alwaysTrue) {
          error(
            [...p],
            'BRANCH_NOT_EXHAUSTIVE',
            "A branch must declare a 'default' or end with an always-true case (when: true)",
          );
        }
        break;
      }
      case 'parallel': {
        if ((s.dependsOn ?? []).length < 2) {
          error(
            [...p, 'dependsOn'],
            'PARALLEL_NEEDS_BRANCHES',
            "A parallel join needs at least two 'dependsOn' branches",
          );
        }
        break;
      }
      case 'approval': {
        if (!isDuration(s.timeout)) error([...p, 'timeout'], 'INVALID_DURATION', 'Invalid duration');
        if (s.onTimeout === 'approve' && !s.justification) {
          error(
            [...p, 'justification'],
            'APPROVE_BY_DEFAULT_NEEDS_JUSTIFICATION',
            "'onTimeout: approve' requires a 'justification'",
          );
        }
        if (s.onTimeout === 'approve') {
          warn(
            [...p, 'onTimeout'],
            'APPROVE_BY_DEFAULT',
            'Approve-on-timeout weakens the gate; a Pentest finding will be raised',
          );
        }
        checkValue(s.message, [...p, 'message'], scopeFor(s, { where: 'approval message' }));
        break;
      }
      case 'wait': {
        const hasDuration = s.duration !== undefined;
        const hasUntil = s.until !== undefined;
        if (hasDuration === hasUntil) {
          error(p, 'WAIT_NEEDS_ONE_OF', "A wait step needs exactly one of 'duration' or 'until'");
        }
        if (hasDuration && !isDuration(s.duration)) error([...p, 'duration'], 'INVALID_DURATION', 'Invalid duration');
        if (hasUntil) {
          if (s.timeout === undefined)
            error(p, 'WAIT_EVENT_NEEDS_TIMEOUT', "Waiting for an event requires a 'timeout'");
          if (s.until?.correlation) {
            checkValue(s.until.correlation, [...p, 'until', 'correlation'], scopeFor(s, { where: 'wait correlation' }));
          }
        }
        break;
      }
      case 'subworkflow': {
        if (s.workflow === m.metadata.name) {
          error([...p, 'workflow'], 'RECURSIVE_SUBWORKFLOW', 'A workflow cannot invoke itself');
        }
        if (s.with) checkValue(s.with, [...p, 'with'], scopeFor(s, { where: 'subworkflow input' }));
        break;
      }
      case 'terminate': {
        if (s.message) checkValue(s.message, [...p, 'message'], scopeFor(s, { where: 'terminate message' }));
        if (s.status === 'failure' && !s.errorClass) {
          warn([...p, 'errorClass'], 'TERMINATE_FAILURE_UNCLASSIFIED', "Classify the failure with 'errorClass'");
        }
        break;
      }
    }
  });

  // -------------------------------------------------------------- guards
  const seenGuards = new Set<string>();
  for (const kind of ['pre', 'invariants'] as const) {
    (m.guards?.[kind] ?? []).forEach((g, i) => {
      const p: PathSegment[] = ['guards', kind, i];
      if (seenGuards.has(g.name)) error([...p, 'name'], 'DUPLICATE_GUARD', `Duplicate guard '${g.name}'`);
      seenGuards.add(g.name);
      checkExpression(g.expr, [...p, 'expr'], {
        roots: kind === 'pre' ? roots('inputs', 'context', 'run') : roots(...BASE, 'steps'),
        steps: kind === 'pre' ? new Set() : 'all',
        secrets: false,
        where: `${kind} guard`,
      });
    });
  }

  // ------------------------------------------------------------- outputs
  if (m.outputs) {
    checkValue(m.outputs, ['outputs'], {
      roots: roots(...BASE, 'steps'),
      steps: 'all',
      secrets: false,
      where: 'workflow output',
    });
  }

  // -------------------------------------------------------------- policy
  if (m.policy) {
    for (const k of ['timeout', 'dedupWindow'] as const) {
      const v = m.policy[k];
      if (v !== undefined && !isDuration(v)) error(['policy', k], 'INVALID_DURATION', 'Invalid duration');
    }
    for (const k of ['initialDelay', 'maxDelay'] as const) {
      const v = m.policy.retry?.[k];
      if (v !== undefined && !isDuration(v)) error(['policy', 'retry', k], 'INVALID_DURATION', 'Invalid duration');
    }
    if (m.policy.dedupKey) {
      checkValue(m.policy.dedupKey, ['policy', 'dedupKey'], {
        roots: roots('inputs', 'context'),
        steps: new Set(),
        secrets: false,
        where: 'dedupKey',
      });
    }
    if (m.policy.dedupKey && m.policy.dedupWindow === undefined) {
      warn(['policy', 'dedupKey'], 'DEDUP_WITHOUT_WINDOW', "'dedupKey' has no effect without 'dedupWindow'");
    }
    if (
      m.policy.maxRunCost !== undefined &&
      m.policy.maxDailyCost !== undefined &&
      m.policy.maxRunCost > m.policy.maxDailyCost
    ) {
      warn(
        ['policy', 'maxRunCost'],
        'RUN_COST_ABOVE_DAILY',
        'maxRunCost exceeds maxDailyCost, so a single run can never fit the daily budget',
      );
    }
  }

  // ------------------------------------------------------- observability
  m.observability?.metrics?.forEach((metric, i) => {
    checkExpression(metric.value, ['observability', 'metrics', i, 'value'], {
      roots: roots(...BASE, 'steps'),
      steps: 'all',
      secrets: false,
      where: 'metric',
    });
  });
  const p95 = m.observability?.slo?.p95Duration;
  if (p95 !== undefined && !isDuration(p95))
    error(['observability', 'slo', 'p95Duration'], 'INVALID_DURATION', 'Invalid duration');

  return issues;

  // ------------------------------------------------------------ helpers
  function checkStepEgress(egress: string[] | undefined, path: PathSegment[]) {
    egress?.forEach((h, j) => {
      if (!isValidEgressHost(h)) {
        error(
          [...path, j],
          'INVALID_EGRESS_HOST',
          `'${h}' is not a valid host (use api.example.com, *.example.com, optionally :port; bare '*' is not allowed)`,
        );
      }
    });
  }
  function checkSunset(sunset: string | undefined, path: PathSegment[]) {
    if (sunset !== undefined && !isIsoDate(sunset)) {
      error(path, 'INVALID_SUNSET', "'sunset' must be an ISO date (YYYY-MM-DD)");
    }
  }

  function checkExpression(src: string, path: PathSegment[], scope: ExprScope) {
    try {
      const ast = parseExpressionField(src);
      checkRefs(collectReferences(ast), path, scope);
    } catch (e) {
      if (e instanceof ExpressionSyntaxError) {
        error(path, 'EXPRESSION_SYNTAX', `${e.message} (at character ${e.pos + 1} of the expression)`);
      } else throw e;
    }
  }

  /** Check every `${{ }}` inside a JSON-like value (or a plain string). */
  function checkValue(value: unknown, path: PathSegment[], scope: ExprScope) {
    const base = formatPath(path);
    for (const found of scanTemplates(value, '')) {
      const rel = found.path;
      const full: PathSegment[] = [...path, ...relativeSegments(rel)];
      if (found.error) {
        error(full, 'EXPRESSION_SYNTAX', `${found.error.message} (at character ${found.error.pos + 1})`);
        continue;
      }
      for (const part of found.template?.parts ?? []) {
        if (part.kind === 'expr') checkRefs(collectReferences(part.ast), full, scope);
      }
    }
    // A bare string value is scanned under an empty base path; nothing more to do.
    void base;
  }

  function relativeSegments(rel: string): PathSegment[] {
    if (rel === '') return [];
    const segs: PathSegment[] = [];
    for (const m2 of rel.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) {
      if (m2[2] !== undefined) segs.push(Number(m2[2]));
      else segs.push(m2[1]!);
    }
    return segs;
  }

  function checkRefs(refs: Reference[], path: PathSegment[], scope: ExprScope) {
    for (const r of refs) {
      if (r.root === 'secrets' && !scope.secrets) {
        error(
          path,
          'SECRET_NOT_ALLOWED',
          `Secrets may only be used inside a step's 'with' input, not in ${scope.where} (they would leak into logs and plans)`,
        );
        continue;
      }
      if (!scope.roots.has(r.root)) {
        const hint = scope.roots.size ? ` (available here: ${[...scope.roots].join(', ')})` : '';
        error(path, 'UNKNOWN_REFERENCE_ROOT', `'${r.root}' is not available in ${scope.where}${hint}`);
        continue;
      }
      switch (r.root) {
        case 'inputs': {
          const first = r.path[0];
          if (first !== undefined && !inputNames.has(first)) {
            error(path, 'UNKNOWN_INPUT', `Unknown input '${first}'`);
          }
          break;
        }
        case 'secrets': {
          if (!scope.secrets) {
            error(
              path,
              'SECRET_NOT_ALLOWED',
              `Secrets may only be used inside a step's 'with' input, not in ${scope.where} (they would leak into logs and plans)`,
            );
          } else if (r.path.length !== 1 || r.dynamic) {
            error(path, 'INVALID_SECRET_REFERENCE', 'Reference a secret as secrets.NAME');
          }
          break;
        }
        case 'run': {
          const first = r.path[0];
          if (first === undefined || !RUN_SCOPE_KEYS.includes(first)) {
            error(
              path,
              'UNKNOWN_RUN_FIELD',
              `run.${first ?? ''} is not a run field (available: ${RUN_SCOPE_KEYS.join(', ')})`,
            );
          }
          break;
        }
        case 'steps': {
          const id = r.path[0];
          if (id === undefined) {
            error(path, 'STEP_REFERENCE_REQUIRED', 'Reference a specific step: steps.<id>.output');
            break;
          }
          if (!stepIds.has(id)) {
            error(path, 'UNKNOWN_STEP_REFERENCE', `Unknown step '${id}'`);
            break;
          }
          if (scope.steps !== 'all' && !scope.steps.has(id)) {
            error(
              path,
              'STEP_NOT_UPSTREAM',
              `Step '${id}' is not upstream of this reference; add it to 'dependsOn' so it has finished first`,
            );
          }
          const field = r.path[1];
          if (field !== undefined && !STEP_OUTPUT_KEYS.includes(field)) {
            error(
              path,
              'UNKNOWN_STEP_FIELD',
              `steps.${id}.${field} is not available (use ${STEP_OUTPUT_KEYS.join(', ')})`,
            );
          }
          break;
        }
        default:
          break;
      }
    }
  }
}

/** Re-exported for the compiler and tests. */
export { hasTemplate, parseTemplate };
