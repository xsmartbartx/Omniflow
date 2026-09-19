import {
  collectReferences,
  contentHash,
  type ErrorClass,
  type Issue,
  type JsonObject,
  longestPath,
  maxSensitivity,
  parseDuration,
  parseExpressionField,
  type Reference,
  type Sensitivity,
  scanTemplates,
  sensitivityRank,
  topologicalOrder,
} from '../../core/index.ts';
import {
  type CapabilityDeclaration,
  type CapabilityStep,
  type EffectClass,
  inputsToJsonSchema,
  type Manifest,
  type MapStep,
  PLAN_VERSION,
  type Plan,
  type PlanAnalysis,
  type PlanCapabilityRef,
  type PlanCompensation,
  type PlanRetry,
  type PlanStep,
  type RetryPolicy,
  type Step,
  type Trigger,
} from '../../schemas/index.ts';
import {
  didYouMean,
  formatPath,
  type Locator,
  type PathSegment,
  parseCapabilityRef,
  parseSource,
  validateManifest,
  validateValue,
} from '../../security/validator/index.ts';
import { schemaHasPath, stepOutputSchema } from './schema-paths.ts';

export interface CapabilityResolver {
  resolve(name: string, range: string): { declaration: CapabilityDeclaration; hash: string } | undefined;
  versions(name: string): string[];
  names(): string[];
}

export interface SubworkflowInfo {
  version: string;
  planHash: string;
  inputSchema: JsonObject;
  subworkflowDepth: number;
  subworkflowChain: string[];
  maxInvocations: number;
  estimatedCost: number;
  maxCost: number;
}

export interface SubworkflowResolver {
  resolve(name: string, version: string): SubworkflowInfo | undefined;
}

export interface CompileLimits {
  maxMapItems: number;
  maxParallelWidth: number;
  maxSubworkflowDepth: number;
  maxInvocations: number;
  defaultStepTimeoutMs: number;
  maxStepTimeoutMs: number;
  maxApprovalTimeoutMs: number;
  defaultRetry: RetryPolicy;
}

export const DEFAULT_LIMITS: CompileLimits = {
  maxMapItems: 100_000,
  maxParallelWidth: 64,
  maxSubworkflowDepth: 3,
  maxInvocations: 250_000,
  defaultStepTimeoutMs: 5 * 60_000,
  maxStepTimeoutMs: 24 * 3_600_000,
  maxApprovalTimeoutMs: 30 * 86_400_000,
  defaultRetry: { attempts: 3, backoff: 'exponential', initialDelay: '1s', maxDelay: '1m', jitter: 0.2 },
};

export interface CompileOptions {
  environment: string;
  capabilities: CapabilityResolver;
  subworkflows?: SubworkflowResolver;
  /** Deployment facts injected as `context.*` (region, feature flags…). Wins over the manifest's own `context`. */
  context?: JsonObject;
  limits?: Partial<CompileLimits>;
  /** `YYYY-MM-DD` — used only to check shell-step sunset dates; never appears in the plan. */
  today: string;
}

export interface CompileResult {
  ok: boolean;
  plan?: Plan;
  /** `sha256:…` content address of the plan. */
  hash?: string;
  issues: Issue[];
  errors: Issue[];
  warnings: Issue[];
}

const DEFAULT_RETRY_ON: ErrorClass[] = ['transient', 'systemic'];

interface ResolvedCap extends PlanCapabilityRef {
  declaration: CapabilityDeclaration;
}

/**
 * Compile a manifest (YAML/JSON text or object) into an immutable execution plan.
 *
 * Pure function: the same manifest, environment and capability-registry state always produce a
 * byte-identical plan and hash. All determinism rules of architecture §6.5 are enforced here
 * rather than left to authors.
 */
export function compile(source: string | unknown, options: CompileOptions): CompileResult {
  const validation = validateManifest(source);
  if (!validation.ok || !validation.manifest) {
    return {
      ok: false,
      issues: validation.issues,
      errors: validation.errors,
      warnings: validation.warnings,
    };
  }
  const manifest = structuredClone(validation.manifest) as Manifest;
  const locate: Locator | undefined = typeof source === 'string' ? parseSource(source).locate : undefined;
  const limits: CompileLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const issues: Issue[] = [...validation.warnings];

  const add = (severity: 'error' | 'warning', path: readonly PathSegment[], code: string, message: string) => {
    const pos = locate?.(path);
    issues.push({
      path: formatPath(path),
      code,
      message,
      ...(severity === 'warning' ? { severity } : {}),
      ...(pos ? { line: pos.line, column: pos.column } : {}),
    });
  };
  const error = (path: readonly PathSegment[], code: string, message: string) => add('error', path, code, message);
  const warn = (path: readonly PathSegment[], code: string, message: string) => add('warning', path, code, message);

  // ------------------------------------------------------------ ordering
  const stepIndex = new Map(manifest.steps.map((s, i) => [s.id, i]));
  const deps = new Map(manifest.steps.map((s) => [s.id, [...new Set(s.dependsOn ?? [])].sort()]));
  const topo = topologicalOrder(
    manifest.steps.map((s) => s.id),
    deps,
  );
  const orderedIds = topo.order;
  const byId = new Map(manifest.steps.map((s) => [s.id, s]));

  // ------------------------------------------- capability resolution (pass A)
  const capOf = new Map<string, ResolvedCap>();
  const compCapOf = new Map<string, ResolvedCap>();
  const resolveCap = (ref: string, path: PathSegment[]): ResolvedCap | undefined => {
    const parsed = parseCapabilityRef(ref);
    if (!parsed) return undefined;
    const found = options.capabilities.resolve(parsed.name, parsed.range);
    if (!found) {
      const versions = options.capabilities.versions(parsed.name);
      if (versions.length === 0) {
        const hint = didYouMean(parsed.name, options.capabilities.names());
        error(
          path,
          'UNKNOWN_CAPABILITY',
          `Capability '${parsed.name}' is not registered${hint ? ` — did you mean '${hint}'?` : ''}`,
        );
      } else {
        error(
          path,
          'NO_MATCHING_VERSION',
          `No version of '${parsed.name}' satisfies '${parsed.range}' (available: ${versions.join(', ')})`,
        );
      }
      return undefined;
    }
    return {
      name: found.declaration.name,
      version: found.declaration.version,
      hash: found.hash,
      declaration: found.declaration,
    };
  };

  manifest.steps.forEach((s, i) => {
    if (s.type === 'capability' || s.type === 'map') {
      const cap = resolveCap(s.uses, ['steps', i, 'uses']);
      if (cap) capOf.set(s.id, cap);
    }
    if (s.type === 'capability' && s.compensate) {
      const cap = resolveCap(s.compensate.uses, ['steps', i, 'compensate', 'uses']);
      if (cap) compCapOf.set(s.id, cap);
    }
  });

  // ---------------------------------- output schemas of every step (pass B)
  const outSchemas = new Map<string, JsonObject | undefined>();
  for (const s of manifest.steps) {
    outSchemas.set(s.id, stepOutputSchema(s, capOf.get(s.id)?.declaration.outputSchema));
  }

  // ------------------------------------------------------ static checks
  const effSensitivity = new Map<string, Sensitivity>();
  const inputSensitivity = (name: string): Sensitivity => manifest.inputs[name]?.sensitivity ?? 'internal';

  const refsOf = (s: Step): Array<{ path: PathSegment[]; refs: Reference[] }> => {
    const out: Array<{ path: PathSegment[]; refs: Reference[] }> = [];
    const i = stepIndex.get(s.id)!;
    const fromValue = (value: unknown, path: PathSegment[]) => {
      for (const f of scanTemplates(value, '')) {
        for (const part of f.template?.parts ?? []) {
          if (part.kind === 'expr') out.push({ path, refs: collectReferences(part.ast) });
        }
      }
    };
    const fromExpr = (src: string | undefined, path: PathSegment[]) => {
      if (src === undefined) return;
      try {
        out.push({ path, refs: collectReferences(parseExpressionField(src)) });
      } catch {
        /* already reported by the validator */
      }
    };
    const p = ['steps', i] as PathSegment[];
    fromExpr(s.when, [...p, 'when']);
    if (s.idempotencyKey) fromValue(s.idempotencyKey, [...p, 'idempotencyKey']);
    if (s.type === 'capability') fromValue(s.with, [...p, 'with']);
    if (s.type === 'map') {
      fromExpr(s.items, [...p, 'items']);
      fromValue(s.with, [...p, 'with']);
    }
    if (s.type === 'branch') s.cases.forEach((c, j) => fromExpr(c.when, [...p, 'cases', j, 'when']));
    if (s.type === 'approval') fromValue(s.message, [...p, 'message']);
    if (s.type === 'subworkflow') fromValue(s.with, [...p, 'with']);
    if (s.type === 'wait') fromValue(s.until?.correlation, [...p, 'until', 'correlation']);
    return out;
  };

  const checkWithShape = (withObj: JsonObject | undefined, schema: JsonObject, path: PathSegment[], what: string) => {
    const props = (schema.properties ?? {}) as JsonObject;
    const required = (schema.required as string[] | undefined) ?? [];
    const w = withObj ?? {};
    for (const req of required) {
      const propSchema = props[req] as JsonObject | undefined;
      if (!(req in w) && propSchema?.default === undefined) {
        error(path, 'MISSING_INPUT_FIELD', `${what} requires '${req}'`);
      }
    }
    for (const [key, value] of Object.entries(w)) {
      if (!Object.hasOwn(props, key)) {
        if (schema.additionalProperties === false) {
          const hint = didYouMean(key, Object.keys(props));
          error(
            [...path, key],
            'UNKNOWN_INPUT_FIELD',
            `${what} has no input '${key}'${hint ? ` — did you mean '${hint}'?` : ''}`,
          );
        }
        continue;
      }
      if (scanTemplates(value, '').length > 0) continue; // dynamic value — checked at run time
      const res = validateValue(props[key] as object, value);
      if (!res.ok) {
        error(
          [...path, key],
          'INVALID_LITERAL_INPUT',
          `'${key}': ${res.issues[0]?.message ?? 'does not match the input schema'}`,
        );
      }
    }
  };

  const checkRefs = (s: Step, list: ReturnType<typeof refsOf>) => {
    let sens: Sensitivity = s.sensitivity ?? 'internal';
    for (const { path, refs } of list) {
      for (const r of refs) {
        if (r.root === 'inputs' && r.path[0]) sens = maxSensitivity(sens, inputSensitivity(r.path[0]));
        if (r.root === 'inputs' && r.path.length === 0) {
          for (const name of Object.keys(manifest.inputs)) sens = maxSensitivity(sens, inputSensitivity(name));
        }
        if (r.root === 'steps' && r.path[0]) {
          sens = maxSensitivity(sens, effSensitivity.get(r.path[0]) ?? 'internal');
          if (r.path[1] === 'output' && r.path.length > 2) {
            const schema = outSchemas.get(r.path[0]);
            if (schema && schemaHasPath(schema, r.path.slice(2)) === 'no') {
              const props = Object.keys((schema.properties ?? {}) as JsonObject);
              error(
                path,
                'UNKNOWN_OUTPUT_FIELD',
                `steps.${r.path[0]}.output.${r.path.slice(2).join('.')} is not produced by '${r.path[0]}'${props.length ? ` (declared: ${props.join(', ')})` : ''}`,
              );
            }
          }
        }
      }
    }
    return sens;
  };

  // per-step plan fragments computed during the pass
  const planSteps: PlanStep[] = [];
  const subworkflows: Plan['subworkflows'] = {};
  let subDepth = 0;
  const subChain = new Set<string>();
  let maxInvocations = 0;
  let estimatedCost = 0;
  let maxCost = 0;
  let maxFan = 1;

  const toRetry = (r: RetryPolicy, path: PathSegment[]): PlanRetry => {
    const initialDelayMs = parseDuration(r.initialDelay ?? '1s');
    const maxDelayMs = parseDuration(r.maxDelay ?? '1m');
    if (maxDelayMs < initialDelayMs)
      error([...path, 'maxDelay'], 'INVALID_RETRY', 'maxDelay is smaller than initialDelay');
    return {
      attempts: r.attempts,
      backoff: r.backoff ?? 'exponential',
      initialDelayMs,
      maxDelayMs,
      jitter: r.jitter ?? 0,
      retryOn: [...new Set(r.retryOn ?? DEFAULT_RETRY_ON)].sort(),
    };
  };

  const policyRetry = manifest.policy?.retry;

  orderedIds.forEach((id, order) => {
    const s = byId.get(id)!;
    const i = stepIndex.get(id)!;
    const p: PathSegment[] = ['steps', i];
    const refs = refsOf(s);
    const sens = checkRefs(s, refs);
    effSensitivity.set(id, sens);

    // ---- timeouts
    const policyTimeout =
      manifest.policy?.timeout !== undefined ? parseDuration(manifest.policy.timeout) : limits.defaultStepTimeoutMs;
    let timeoutMs = s.timeout !== undefined ? parseDuration(s.timeout) : policyTimeout;
    if (s.type === 'approval') {
      if (timeoutMs > limits.maxApprovalTimeoutMs)
        error([...p, 'timeout'], 'TIMEOUT_TOO_LARGE', 'Approval timeout exceeds the platform maximum');
    } else if (s.type === 'wait') {
      timeoutMs =
        s.until && s.timeout !== undefined
          ? parseDuration(s.timeout)
          : s.duration !== undefined
            ? parseDuration(s.duration)
            : timeoutMs;
    } else if (timeoutMs > limits.maxStepTimeoutMs) {
      error(
        [...p, 'timeout'],
        'TIMEOUT_TOO_LARGE',
        `Step timeout exceeds the platform maximum of ${limits.maxStepTimeoutMs}ms`,
      );
    }

    const base: PlanStep = {
      id,
      type: s.type,
      ...(s.name ? { name: s.name } : {}),
      order,
      dependsOn: deps.get(id)!,
      ...(s.when !== undefined ? { when: s.when } : {}),
      timeoutMs,
      onError: s.onError ?? 'fail',
      sensitivity: sens,
      ...(s.produces ? { produces: s.produces } : {}),
    };

    switch (s.type) {
      case 'capability':
      case 'map': {
        const cap = capOf.get(id);
        const step = s as CapabilityStep | MapStep;
        const retrySource = step.retry ?? policyRetry ?? limits.defaultRetry;
        const retry = toRetry(retrySource, [...p, 'retry']);
        base.retry = retry;
        base.with = (step.with ?? {}) as JsonObject;
        if (step.idempotencyKey !== undefined) base.idempotencyKey = step.idempotencyKey;
        if (step.sunset) base.sunset = step.sunset;

        if (cap) {
          const d = cap.declaration;
          base.capability = { name: cap.name, version: cap.version, hash: cap.hash };
          base.effect = d.effect as EffectClass;
          checkWithShape(step.with, d.inputSchema, [...p, 'with'], `'${cap.name}'`);

          // -- idempotency (ADR-0002 D3)
          if (d.effect === 'effectful' && step.idempotencyKey === undefined) {
            error(
              [...p],
              'EFFECTFUL_WITHOUT_IDEMPOTENCY_KEY',
              `Step '${id}' uses effectful capability '${cap.name}' and must declare an idempotencyKey (duplicate effects on retry are otherwise possible)`,
            );
          }
          if (d.effect === 'pure' && step.idempotencyKey !== undefined) {
            warn(
              [...p, 'idempotencyKey'],
              'IDEMPOTENCY_KEY_UNNEEDED',
              `'${cap.name}' is pure; the idempotencyKey has no effect`,
            );
          }
          if (s.type === 'map' && d.effect === 'effectful' && step.idempotencyKey !== undefined) {
            const keyRefs = scanTemplates(step.idempotencyKey, '').flatMap((f) =>
              (f.template?.parts ?? []).flatMap((part) => (part.kind === 'expr' ? collectReferences(part.ast) : [])),
            );
            if (!keyRefs.some((r) => r.root === 'item' || r.root === 'index')) {
              error(
                [...p, 'idempotencyKey'],
                'MAP_KEY_NOT_ITEM_SPECIFIC',
                'A map over an effectful capability needs an idempotencyKey that includes ${{ item… }} or ${{ index }}; otherwise every item shares one key and all but the first would be dropped',
              );
            }
          }

          // -- egress
          const e = d.egress;
          if (e.mode === 'step') {
            if (!step.egress || step.egress.length === 0) {
              error(
                [...p],
                'EGRESS_REQUIRED',
                `'${cap.name}' reaches the network: step '${id}' must declare 'egress' hosts (default is deny)`,
              );
            }
            base.egress = [...new Set(step.egress ?? [])].sort();
          } else if (e.mode === 'static') {
            if (step.egress?.length)
              warn(
                [...p, 'egress'],
                'EGRESS_IGNORED',
                `'${cap.name}' has a fixed egress list; the step's 'egress' is ignored`,
              );
            base.egress = [...e.hosts].sort();
          } else if (step.egress?.length) {
            error(
              [...p, 'egress'],
              'EGRESS_NOT_APPLICABLE',
              `'${cap.name}' has no network access, so 'egress' is not allowed`,
            );
          }

          // -- sunset for migration bridges (§11.4)
          if (d.family === 'shell') {
            if (!step.sunset) {
              error(
                [...p, 'sunset'],
                'SUNSET_REQUIRED',
                'Shell steps must carry a review date (sunset: YYYY-MM-DD) so the migration bridge cannot become permanent',
              );
            } else if (step.sunset < options.today) {
              error(
                [...p, 'sunset'],
                'SUNSET_EXPIRED',
                `Sunset date ${step.sunset} has passed — decompose or re-review this shell step`,
              );
            }
          }

          // -- classification ceiling
          if (sensitivityRank(sens) > sensitivityRank(d.dataClassification)) {
            error(
              [...p],
              'CLASSIFICATION_EXCEEDED',
              `Step '${id}' handles ${sens} data but '${cap.name}' is only cleared for ${d.dataClassification}`,
            );
          }

          // -- data residency
          const residency = manifest.policy?.dataResidency ?? [];
          if (residency.length > 0) {
            if (!d.regions) {
              warn(
                [...p],
                'RESIDENCY_UNKNOWN',
                `'${cap.name}' does not declare regions; residency ${residency.join(', ')} cannot be verified`,
              );
            } else if (!d.regions.some((r) => residency.includes(r))) {
              error(
                [...p],
                'RESIDENCY_VIOLATION',
                `'${cap.name}' only operates in ${d.regions.join(', ')} but the workflow requires ${residency.join(', ')}`,
              );
            }
          }

          // -- cost
          const perInvocation = d.costModel.unitsPerInvocation;
          const invocations = s.type === 'map' ? (s as MapStep).maxItems : 1;
          maxInvocations += invocations;
          estimatedCost += perInvocation * invocations;
          maxCost += perInvocation * invocations * retry.attempts;
          maxFan = Math.max(maxFan, invocations);
          if (d.compensation && d.effect === 'effectful' && !(s as CapabilityStep).compensate) {
            warn(
              [...p],
              'COMPENSATION_AVAILABLE',
              `'${cap.name}' can be reversed by '${d.compensation}' — consider adding 'compensate'`,
            );
          }
        }

        if (s.type === 'map') {
          const m = s as MapStep;
          if (m.maxItems > limits.maxMapItems)
            error(
              [...p, 'maxItems'],
              'FANOUT_TOO_LARGE',
              `maxItems exceeds the platform limit of ${limits.maxMapItems}`,
            );
          base.items = m.items;
          base.maxItems = m.maxItems;
          base.concurrency = Math.min(m.concurrency ?? 4, m.maxItems);
          if (m.errorTolerance) base.errorTolerance = m.errorTolerance;
        }
        if (s.type === 'capability' && s.compensate) {
          const cc = compCapOf.get(id);
          if (cc) {
            const cd = cc.declaration;
            checkWithShape(s.compensate.with, cd.inputSchema, [...p, 'compensate', 'with'], `'${cc.name}'`);
            if (cd.effect === 'effectful' && !s.compensate.idempotencyKey) {
              error(
                [...p, 'compensate'],
                'COMPENSATION_WITHOUT_IDEMPOTENCY_KEY',
                `Compensation '${cc.name}' is effectful and needs an idempotencyKey`,
              );
            }
            const comp: PlanCompensation = {
              capability: { name: cc.name, version: cc.version, hash: cc.hash },
              with: (s.compensate.with ?? {}) as JsonObject,
              ...(s.compensate.idempotencyKey ? { idempotencyKey: s.compensate.idempotencyKey } : {}),
              timeoutMs: s.compensate.timeout !== undefined ? parseDuration(s.compensate.timeout) : policyTimeout,
              egress: cd.egress.mode === 'static' ? [...cd.egress.hosts].sort() : [],
            };
            if (cd.egress.mode === 'step') {
              error(
                [...p, 'compensate'],
                'COMPENSATION_EGRESS_UNSUPPORTED',
                `Compensation '${cc.name}' needs step-declared egress, which compensation does not support; use a capability with a static allow-list`,
              );
            }
            base.compensate = comp;
            maxInvocations += 1;
            maxCost += cd.costModel.unitsPerInvocation * retry.attempts;
          }
        }
        break;
      }
      case 'branch': {
        base.cases = s.cases.map((c) => ({ name: c.name, when: c.when }));
        if (s.default !== undefined) base.default = s.default;
        break;
      }
      case 'parallel': {
        base.join = s.join;
        if (s.dependsOn!.length > limits.maxParallelWidth) {
          error(
            [...p, 'dependsOn'],
            'PARALLEL_TOO_WIDE',
            `A parallel join may have at most ${limits.maxParallelWidth} branches`,
          );
        }
        maxFan = Math.max(maxFan, s.dependsOn!.length);
        break;
      }
      case 'approval': {
        base.message = s.message;
        base.approvers = {
          roles: [...new Set(s.approvers?.roles ?? (s.approvers?.users ? [] : ['approver']))].sort(),
          users: [...new Set(s.approvers?.users ?? [])].sort(),
        };
        base.onTimeout = s.onTimeout;
        if (s.justification) base.justification = s.justification;
        base.allowSelfApproval = s.allowSelfApproval ?? false;
        break;
      }
      case 'wait': {
        if (s.duration !== undefined) base.durationMs = parseDuration(s.duration);
        if (s.until)
          base.until = { event: s.until.event, ...(s.until.correlation ? { correlation: s.until.correlation } : {}) };
        break;
      }
      case 'subworkflow': {
        base.workflow = s.workflow;
        base.version = s.version;
        base.with = (s.with ?? {}) as JsonObject;
        base.retry = toRetry(s.retry ?? { attempts: 1 }, [...p, 'retry']);
        const info = options.subworkflows?.resolve(s.workflow, s.version);
        if (!info) {
          error([...p, 'workflow'], 'UNKNOWN_SUBWORKFLOW', `Subworkflow ${s.workflow}@${s.version} is not published`);
        } else {
          base.childPlanHash = info.planHash;
          subworkflows[s.workflow] = { version: info.version, planHash: info.planHash };
          checkWithShape(s.with, info.inputSchema, [...p, 'with'], `Subworkflow '${s.workflow}'`);
          const chain = [s.workflow, ...info.subworkflowChain];
          if (chain.includes(manifest.metadata.name)) {
            error(
              [...p, 'workflow'],
              'SUBWORKFLOW_CYCLE',
              `Subworkflow cycle: ${manifest.metadata.name} → ${chain.join(' → ')}`,
            );
          }
          for (const c of chain) subChain.add(c);
          subDepth = Math.max(subDepth, 1 + info.subworkflowDepth);
          maxInvocations += info.maxInvocations;
          estimatedCost += info.estimatedCost;
          maxCost += info.maxCost;
        }
        break;
      }
      case 'terminate': {
        base.status = s.status;
        if (s.errorClass) base.errorClass = s.errorClass;
        if (s.message) base.message = s.message;
        break;
      }
    }
    planSteps.push(base);
  });

  if (subDepth > limits.maxSubworkflowDepth) {
    error(
      ['steps'],
      'SUBWORKFLOW_TOO_DEEP',
      `Subworkflow nesting depth ${subDepth} exceeds the limit of ${limits.maxSubworkflowDepth}`,
    );
  }
  if (maxInvocations > limits.maxInvocations) {
    error(
      ['steps'],
      'TOO_MANY_INVOCATIONS',
      `One run could make ${maxInvocations} capability invocations; the limit is ${limits.maxInvocations}`,
    );
  }
  if (manifest.policy?.maxRunCost !== undefined && estimatedCost > manifest.policy.maxRunCost) {
    error(
      ['policy', 'maxRunCost'],
      'COST_CEILING_TOO_LOW',
      `A single run can cost ${estimatedCost} units at minimum, above the maxRunCost of ${manifest.policy.maxRunCost}`,
    );
  } else if (manifest.policy?.maxRunCost !== undefined && maxCost > manifest.policy.maxRunCost) {
    warn(
      ['policy', 'maxRunCost'],
      'COST_MAY_EXCEED_CEILING',
      `With every retry consumed a run could cost ${maxCost} units, above maxRunCost ${manifest.policy.maxRunCost}`,
    );
  }

  // ------------------------------------------- workflow-level references
  const checkWorkflowRefs = (value: unknown, path: PathSegment[]) => {
    for (const f of scanTemplates(value, '')) {
      for (const part of f.template?.parts ?? []) {
        if (part.kind !== 'expr') continue;
        for (const r of collectReferences(part.ast)) {
          if (r.root === 'steps' && r.path[0] && r.path[1] === 'output' && r.path.length > 2) {
            const schema = outSchemas.get(r.path[0]);
            if (schema && schemaHasPath(schema, r.path.slice(2)) === 'no') {
              error(
                path,
                'UNKNOWN_OUTPUT_FIELD',
                `steps.${r.path[0]}.output.${r.path.slice(2).join('.')} is not produced by '${r.path[0]}'`,
              );
            }
          }
          if (r.root === 'context' && r.path[0]) {
            const known = new Set([
              'now',
              'environment',
              'tenant',
              ...Object.keys(manifest.context ?? {}),
              ...Object.keys(options.context ?? {}),
            ]);
            if (!known.has(r.path[0]))
              error(
                path,
                'UNKNOWN_CONTEXT_KEY',
                `context.${r.path[0]} is not defined (declare it in 'context' or provide it via the deployment)`,
              );
          }
        }
      }
    }
  };
  if (manifest.outputs) checkWorkflowRefs(manifest.outputs, ['outputs']);
  // `context.*` is only knowable at compile time — check every expression for undefined keys.
  manifest.steps.forEach((s, i) => {
    for (const { path, refs } of refsOf(s)) {
      for (const r of refs) {
        if (r.root === 'context' && r.path[0]) {
          const known = new Set([
            'now',
            'environment',
            'tenant',
            ...Object.keys(manifest.context ?? {}),
            ...Object.keys(options.context ?? {}),
          ]);
          if (!known.has(r.path[0]))
            error(
              path.length ? path : ['steps', i],
              'UNKNOWN_CONTEXT_KEY',
              `context.${r.path[0]} is not defined (declare it in 'context' or provide it via the deployment)`,
            );
        }
      }
    }
  });

  const errors = issues.filter((x) => x.severity !== 'warning');
  const warnings = issues.filter((x) => x.severity === 'warning');
  if (errors.length > 0) return { ok: false, issues, errors, warnings };

  // ------------------------------------------------------------ assemble
  const caps: Record<string, PlanCapabilityRef> = {};
  const scopes = new Set<string>();
  const egress = new Set<string>();
  const families = new Set<string>();
  const effects: Record<EffectClass, number> = { pure: 0, idempotent: 0, effectful: 0 };
  let sensMax: Sensitivity = 'public';
  for (const c of [...capOf.values(), ...compCapOf.values()]) {
    caps[c.name] = { name: c.name, version: c.version, hash: c.hash };
    for (const sc of c.declaration.scopes) scopes.add(sc);
    families.add(c.declaration.family);
  }
  for (const st of planSteps) {
    if (st.capability && st.effect) effects[st.effect]++;
    for (const h of st.egress ?? []) egress.add(h);
    sensMax = maxSensitivity(sensMax, st.sensitivity);
  }
  for (const st of planSteps) {
    if (st.compensate) {
      const d = compCapOf.get(st.id)?.declaration;
      if (d) effects[d.effect as EffectClass]++;
      for (const h of st.compensate.egress) egress.add(h);
    }
  }

  const analysis: PlanAnalysis = {
    stepCount: planSteps.length,
    depth: longestPath(orderedIds, deps),
    effects,
    scopes: [...scopes].sort(),
    egress: [...egress].sort(),
    capabilities: Object.values(caps)
      .map((c) => `${c.name}@${c.version}`)
      .sort(),
    maxFanOut: maxFan,
    maxInvocations,
    subworkflowDepth: subDepth,
    subworkflowChain: [...subChain].sort(),
    families: [...families].sort(),
    hasApproval: planSteps.some((x) => x.type === 'approval'),
    hasCompensation: planSteps.some((x) => x.compensate !== undefined),
    maxSensitivity: sensMax,
    estimatedCost,
    maxCost,
  };

  const policy = manifest.policy ?? {};
  const plan: Plan = {
    planVersion: PLAN_VERSION,
    workflow: {
      name: manifest.metadata.name,
      version: manifest.metadata.version,
      owner: manifest.metadata.owner,
      ...(manifest.metadata.team ? { team: manifest.metadata.team } : {}),
      ...(manifest.metadata.description ? { description: manifest.metadata.description } : {}),
      ...(manifest.metadata.labels ? { labels: manifest.metadata.labels } : {}),
      criticality: manifest.metadata.criticality ?? 'medium',
    },
    environment: options.environment,
    sourceHash: contentHash(manifest),
    triggers: normaliseTriggers(manifest.triggers),
    inputs: manifest.inputs,
    inputSchema: inputsToJsonSchema(manifest.inputs),
    context: { ...(manifest.context ?? {}), ...(options.context ?? {}), environment: options.environment },
    steps: planSteps,
    guards: { pre: manifest.guards?.pre ?? [], invariants: manifest.guards?.invariants ?? [] },
    outputs: manifest.outputs ?? {},
    policy: {
      timeoutMs: policy.timeout !== undefined ? parseDuration(policy.timeout) : limits.defaultStepTimeoutMs,
      concurrency: policy.concurrency ?? 10,
      concurrencyPolicy: policy.concurrencyPolicy ?? 'queue',
      maxParallelSteps: policy.maxParallelSteps ?? 8,
      dataResidency: [...(policy.dataResidency ?? [])].sort(),
      ...(policy.maxRunCost !== undefined ? { maxRunCost: policy.maxRunCost } : {}),
      ...(policy.maxDailyCost !== undefined ? { maxDailyCost: policy.maxDailyCost } : {}),
      ...(policy.dedupWindow !== undefined ? { dedupWindowMs: parseDuration(policy.dedupWindow) } : {}),
      ...(policy.dedupKey ? { dedupKey: policy.dedupKey } : {}),
    },
    observability: manifest.observability ?? {},
    capabilities: caps,
    subworkflows,
    analysis,
  };
  return { ok: true, plan, hash: contentHash(plan), issues, errors: [], warnings };
}

function normaliseTriggers(triggers: Trigger[]): Trigger[] {
  const used = new Set(triggers.flatMap((t) => ('name' in t && t.name ? [t.name] : [])));
  const counters = new Map<string, number>();
  return triggers.map((t) => {
    const named = { ...t } as Trigger & { name?: string };
    if (!named.name) {
      let n = (counters.get(t.type) ?? 0) + 1;
      let candidate = `${t.type}-${n}`;
      while (used.has(candidate)) candidate = `${t.type}-${++n}`;
      counters.set(t.type, n);
      used.add(candidate);
      named.name = candidate;
    }
    if (named.type === 'schedule') {
      named.timezone ??= 'UTC';
      named.catchup ??= 'none';
      named.cron = named.cron.trim().replace(/\s+/g, ' ');
    }
    return named as Trigger;
  });
}
