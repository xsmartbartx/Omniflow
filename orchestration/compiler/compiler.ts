import {
  collectReferences,
  compareStrings,
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
  suggestion,
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

type WithPath = { path: PathSegment[]; refs: Reference[] };
type ApprovalStepDef = Extract<Step, { type: 'approval' }>;
type SubworkflowStepDef = Extract<Step, { type: 'subworkflow' }>;

/**
 * Compile a manifest (YAML/JSON text or object) into an immutable execution plan.
 *
 * Pure function: the same manifest, environment and capability-registry state always produce a
 * byte-identical plan and hash. All determinism rules of architecture §6.5 are enforced here
 * rather than left to authors.
 */
export function compile(source: unknown, options: CompileOptions): CompileResult {
  const validation = validateManifest(source);
  if (!validation.ok || !validation.manifest) {
    return {
      ok: false,
      issues: validation.issues,
      errors: validation.errors,
      warnings: validation.warnings,
    };
  }
  return new PlanCompiler(source, validation.manifest, [...validation.warnings], options).run();
}

/** One compilation: holds the manifest, the issues found so far and the totals accumulated while building steps. */
class PlanCompiler {
  private readonly manifest: Manifest;
  private readonly options: CompileOptions;
  private readonly limits: CompileLimits;
  private readonly locate: Locator | undefined;
  private readonly issues: Issue[];

  private readonly stepIndex: Map<string, number>;
  private readonly deps: Map<string, string[]>;
  private readonly orderedIds: string[];
  private readonly byId: Map<string, Step>;

  private readonly capOf = new Map<string, ResolvedCap>();
  private readonly compCapOf = new Map<string, ResolvedCap>();
  private readonly outSchemas = new Map<string, JsonObject | undefined>();
  private readonly effSensitivity = new Map<string, Sensitivity>();

  private readonly planSteps: PlanStep[] = [];
  private readonly subworkflows: Plan['subworkflows'] = {};
  private subDepth = 0;
  private readonly subChain = new Set<string>();
  private maxInvocations = 0;
  private estimatedCost = 0;
  private maxCost = 0;
  private maxFan = 1;

  constructor(source: unknown, validated: Manifest, warnings: Issue[], options: CompileOptions) {
    this.manifest = structuredClone(validated) as Manifest;
    this.options = options;
    this.locate = typeof source === 'string' ? parseSource(source).locate : undefined;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.issues = warnings;

    const steps = this.manifest.steps;
    this.stepIndex = new Map(steps.map((s, i) => [s.id, i]));
    this.deps = new Map(steps.map((s) => [s.id, [...new Set(s.dependsOn ?? [])].sort(compareStrings)]));
    this.orderedIds = topologicalOrder(
      steps.map((s) => s.id),
      this.deps,
    ).order;
    this.byId = new Map(steps.map((s) => [s.id, s]));
  }

  run(): CompileResult {
    this.resolveCapabilities();
    for (const s of this.manifest.steps) {
      this.outSchemas.set(s.id, stepOutputSchema(s, this.capOf.get(s.id)?.declaration.outputSchema));
    }
    this.orderedIds.forEach((id, order) => {
      this.planSteps.push(this.compileStep(id, order));
    });
    this.checkTotals();
    if (this.manifest.outputs) this.checkWorkflowRefs(this.manifest.outputs, ['outputs']);
    this.checkContextKeys();

    const errors = this.issues.filter((x) => x.severity !== 'warning');
    const warnings = this.issues.filter((x) => x.severity === 'warning');
    if (errors.length > 0) return { ok: false, issues: this.issues, errors, warnings };

    const plan = this.assemble();
    return { ok: true, plan, hash: contentHash(plan), issues: this.issues, errors: [], warnings };
  }

  // ---------------------------------------------------------------- issues
  private add(severity: 'error' | 'warning', path: readonly PathSegment[], code: string, message: string): void {
    const pos = this.locate?.(path);
    this.issues.push({
      path: formatPath(path),
      code,
      message,
      ...(severity === 'warning' ? { severity } : {}),
      ...(pos ? { line: pos.line, column: pos.column } : {}),
    });
  }
  private error(path: readonly PathSegment[], code: string, message: string): void {
    this.add('error', path, code, message);
  }
  private warn(path: readonly PathSegment[], code: string, message: string): void {
    this.add('warning', path, code, message);
  }

  // ------------------------------------------------- capability resolution
  private resolveCap(ref: string, path: PathSegment[]): ResolvedCap | undefined {
    const parsed = parseCapabilityRef(ref);
    if (!parsed) return undefined;
    const caps = this.options.capabilities;
    const found = caps.resolve(parsed.name, parsed.range);
    if (!found) {
      const versions = caps.versions(parsed.name);
      if (versions.length === 0) {
        const hint = didYouMean(parsed.name, caps.names());
        this.error(path, 'UNKNOWN_CAPABILITY', `Capability '${parsed.name}' is not registered${suggestion(hint)}`);
      } else {
        this.error(
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
  }

  private resolveCapabilities(): void {
    this.manifest.steps.forEach((s, i) => {
      if (s.type === 'capability' || s.type === 'map') {
        const cap = this.resolveCap(s.uses, ['steps', i, 'uses']);
        if (cap) this.capOf.set(s.id, cap);
      }
      if (s.type === 'capability' && s.compensate) {
        const cap = this.resolveCap(s.compensate.uses, ['steps', i, 'compensate', 'uses']);
        if (cap) this.compCapOf.set(s.id, cap);
      }
    });
  }

  // ----------------------------------------------------------- references
  private inputSensitivity(name: string): Sensitivity {
    return this.manifest.inputs[name]?.sensitivity ?? 'internal';
  }

  private refsOf(s: Step): WithPath[] {
    const out: WithPath[] = [];
    const i = this.stepIndex.get(s.id)!;
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
    if (s.type === 'branch') {
      for (const [j, c] of s.cases.entries()) fromExpr(c.when, [...p, 'cases', j, 'when']);
    }
    if (s.type === 'approval') fromValue(s.message, [...p, 'message']);
    if (s.type === 'subworkflow') fromValue(s.with, [...p, 'with']);
    if (s.type === 'wait') fromValue(s.until?.correlation, [...p, 'until', 'correlation']);
    return out;
  }

  private checkWithShape(withObj: JsonObject | undefined, schema: JsonObject, path: PathSegment[], what: string): void {
    const props = (schema.properties ?? {}) as JsonObject;
    const required = (schema.required as string[] | undefined) ?? [];
    const w = withObj ?? {};
    for (const req of required) {
      const propSchema = props[req] as JsonObject | undefined;
      if (!(req in w) && propSchema?.default === undefined) {
        this.error(path, 'MISSING_INPUT_FIELD', `${what} requires '${req}'`);
      }
    }
    for (const [key, value] of Object.entries(w)) {
      if (!Object.hasOwn(props, key)) {
        if (schema.additionalProperties === false) {
          const hint = didYouMean(key, Object.keys(props));
          this.error([...path, key], 'UNKNOWN_INPUT_FIELD', `${what} has no input '${key}'${suggestion(hint)}`);
        }
        continue;
      }
      if (scanTemplates(value, '').length > 0) continue; // dynamic value — checked at run time
      const res = validateValue(props[key] as object, value);
      if (!res.ok) {
        this.error(
          [...path, key],
          'INVALID_LITERAL_INPUT',
          `'${key}': ${res.issues[0]?.message ?? 'does not match the input schema'}`,
        );
      }
    }
  }

  /** Check each reference and return the step's effective sensitivity (the highest of everything it reads). */
  private checkRefs(s: Step, list: WithPath[]): Sensitivity {
    let sens: Sensitivity = s.sensitivity ?? 'internal';
    for (const { path, refs } of list) {
      for (const r of refs) {
        if (r.root === 'inputs') sens = maxSensitivity(sens, this.inputsSensitivity(r));
        if (r.root === 'steps' && r.path[0]) {
          sens = maxSensitivity(sens, this.effSensitivity.get(r.path[0]) ?? 'internal');
          this.checkOutputField(r, path, true);
        }
      }
    }
    return sens;
  }

  private inputsSensitivity(r: Reference): Sensitivity {
    if (r.path[0]) return this.inputSensitivity(r.path[0]);
    if (r.path.length > 0) return 'public';
    return Object.keys(this.manifest.inputs).reduce<Sensitivity>(
      (acc, name) => maxSensitivity(acc, this.inputSensitivity(name)),
      'public',
    );
  }

  /** `steps.X.output.a.b` must be something X can produce, when its output shape is known. */
  private checkOutputField(r: Reference, path: PathSegment[], listDeclared: boolean): void {
    if (r.path[1] !== 'output' || r.path.length <= 2) return;
    const schema = this.outSchemas.get(r.path[0]!);
    if (!schema || schemaHasPath(schema, r.path.slice(2)) !== 'no') return;
    const props = Object.keys((schema.properties ?? {}) as JsonObject);
    const declared = listDeclared && props.length ? ` (declared: ${props.join(', ')})` : '';
    this.error(
      path,
      'UNKNOWN_OUTPUT_FIELD',
      `steps.${r.path[0]}.output.${r.path.slice(2).join('.')} is not produced by '${r.path[0]}'${declared}`,
    );
  }

  // ------------------------------------------------------------ one step
  private toRetry(r: RetryPolicy, path: PathSegment[]): PlanRetry {
    const initialDelayMs = parseDuration(r.initialDelay ?? '1s');
    const maxDelayMs = parseDuration(r.maxDelay ?? '1m');
    if (maxDelayMs < initialDelayMs)
      this.error([...path, 'maxDelay'], 'INVALID_RETRY', 'maxDelay is smaller than initialDelay');
    return {
      attempts: r.attempts,
      backoff: r.backoff ?? 'exponential',
      initialDelayMs,
      maxDelayMs,
      jitter: r.jitter ?? 0,
      retryOn: [...new Set(r.retryOn ?? DEFAULT_RETRY_ON)].sort(compareStrings),
    };
  }

  private policyTimeoutMs(): number {
    const t = this.manifest.policy?.timeout;
    return t !== undefined ? parseDuration(t) : this.limits.defaultStepTimeoutMs;
  }

  private stepTimeoutMs(s: Step, p: PathSegment[]): number {
    const limits = this.limits;
    let timeoutMs = s.timeout !== undefined ? parseDuration(s.timeout) : this.policyTimeoutMs();
    if (s.type === 'approval') {
      if (timeoutMs > limits.maxApprovalTimeoutMs)
        this.error([...p, 'timeout'], 'TIMEOUT_TOO_LARGE', 'Approval timeout exceeds the platform maximum');
    } else if (s.type === 'wait') {
      if (s.until && s.timeout !== undefined) timeoutMs = parseDuration(s.timeout);
      else if (s.duration !== undefined) timeoutMs = parseDuration(s.duration);
    } else if (timeoutMs > limits.maxStepTimeoutMs) {
      this.error(
        [...p, 'timeout'],
        'TIMEOUT_TOO_LARGE',
        `Step timeout exceeds the platform maximum of ${limits.maxStepTimeoutMs}ms`,
      );
    }
    return timeoutMs;
  }

  private compileStep(id: string, order: number): PlanStep {
    const s = this.byId.get(id)!;
    const p: PathSegment[] = ['steps', this.stepIndex.get(id)!];
    const sens = this.checkRefs(s, this.refsOf(s));
    this.effSensitivity.set(id, sens);

    const base: PlanStep = {
      id,
      type: s.type,
      ...(s.name ? { name: s.name } : {}),
      order,
      dependsOn: this.deps.get(id)!,
      ...(s.when !== undefined ? { when: s.when } : {}),
      timeoutMs: this.stepTimeoutMs(s, p),
      onError: s.onError ?? 'fail',
      sensitivity: sens,
      ...(s.produces ? { produces: s.produces } : {}),
    };

    this.fillStepKind(base, s, p);
    return base;
  }

  private fillStepKind(base: PlanStep, s: Step, p: PathSegment[]): void {
    switch (s.type) {
      case 'capability':
      case 'map':
        this.fillCapabilityStep(base, s, p);
        break;
      case 'branch':
        base.cases = s.cases.map((c) => ({ name: c.name, when: c.when }));
        if (s.default !== undefined) base.default = s.default;
        break;
      case 'parallel':
        this.fillParallelStep(base, s, p);
        break;
      case 'approval':
        fillApprovalStep(base, s);
        break;
      case 'wait':
        if (s.duration !== undefined) base.durationMs = parseDuration(s.duration);
        if (s.until)
          base.until = { event: s.until.event, ...(s.until.correlation ? { correlation: s.until.correlation } : {}) };
        break;
      case 'subworkflow':
        this.fillSubworkflowStep(base, s, p);
        break;
      case 'terminate':
        base.status = s.status;
        if (s.errorClass) base.errorClass = s.errorClass;
        if (s.message) base.message = s.message;
        break;
    }
  }

  private fillParallelStep(base: PlanStep, s: Extract<Step, { type: 'parallel' }>, p: PathSegment[]): void {
    base.join = s.join;
    if (s.dependsOn!.length > this.limits.maxParallelWidth) {
      this.error(
        [...p, 'dependsOn'],
        'PARALLEL_TOO_WIDE',
        `A parallel join may have at most ${this.limits.maxParallelWidth} branches`,
      );
    }
    this.maxFan = Math.max(this.maxFan, s.dependsOn!.length);
  }

  private fillSubworkflowStep(base: PlanStep, s: SubworkflowStepDef, p: PathSegment[]): void {
    base.workflow = s.workflow;
    base.version = s.version;
    base.with = (s.with ?? {}) as JsonObject;
    base.retry = this.toRetry(s.retry ?? { attempts: 1 }, [...p, 'retry']);
    const info = this.options.subworkflows?.resolve(s.workflow, s.version);
    if (!info) {
      this.error([...p, 'workflow'], 'UNKNOWN_SUBWORKFLOW', `Subworkflow ${s.workflow}@${s.version} is not published`);
      return;
    }
    base.childPlanHash = info.planHash;
    this.subworkflows[s.workflow] = { version: info.version, planHash: info.planHash };
    this.checkWithShape(s.with, info.inputSchema, [...p, 'with'], `Subworkflow '${s.workflow}'`);
    const chain = [s.workflow, ...info.subworkflowChain];
    if (chain.includes(this.manifest.metadata.name)) {
      this.error(
        [...p, 'workflow'],
        'SUBWORKFLOW_CYCLE',
        `Subworkflow cycle: ${this.manifest.metadata.name} → ${chain.join(' → ')}`,
      );
    }
    for (const c of chain) this.subChain.add(c);
    this.subDepth = Math.max(this.subDepth, 1 + info.subworkflowDepth);
    this.maxInvocations += info.maxInvocations;
    this.estimatedCost += info.estimatedCost;
    this.maxCost += info.maxCost;
  }

  private fillCapabilityStep(base: PlanStep, s: CapabilityStep | MapStep, p: PathSegment[]): void {
    const id = s.id;
    const retry = this.toRetry(s.retry ?? this.manifest.policy?.retry ?? this.limits.defaultRetry, [...p, 'retry']);
    base.retry = retry;
    base.with = (s.with ?? {}) as JsonObject;
    if (s.idempotencyKey !== undefined) base.idempotencyKey = s.idempotencyKey;
    if (s.sunset) base.sunset = s.sunset;

    const cap = this.capOf.get(id);
    if (cap) this.checkCapabilityUse(base, s, cap, retry, p);

    if (s.type === 'map') this.fillMapStep(base, s, p);
    if (s.type === 'capability' && s.compensate) this.fillCompensation(base, s, retry, p);
  }

  private fillMapStep(base: PlanStep, m: MapStep, p: PathSegment[]): void {
    if (m.maxItems > this.limits.maxMapItems)
      this.error(
        [...p, 'maxItems'],
        'FANOUT_TOO_LARGE',
        `maxItems exceeds the platform limit of ${this.limits.maxMapItems}`,
      );
    base.items = m.items;
    base.maxItems = m.maxItems;
    base.concurrency = Math.min(m.concurrency ?? 4, m.maxItems);
    if (m.errorTolerance) base.errorTolerance = m.errorTolerance;
  }

  /** Everything that depends on which capability a step uses: idempotency, egress, sunset, classification, residency, cost. */
  private checkCapabilityUse(
    base: PlanStep,
    step: CapabilityStep | MapStep,
    cap: ResolvedCap,
    retry: PlanRetry,
    p: PathSegment[],
  ): void {
    const d = cap.declaration;
    base.capability = { name: cap.name, version: cap.version, hash: cap.hash };
    base.effect = d.effect as EffectClass;
    base.family = d.family;
    this.checkWithShape(step.with, d.inputSchema, [...p, 'with'], `'${cap.name}'`);
    this.checkIdempotency(step, cap, p);
    base.egress = this.egressFor(step, cap, p) ?? base.egress;
    this.checkSunset(step, d.family, p);

    const sens = base.sensitivity;
    if (sensitivityRank(sens) > sensitivityRank(d.dataClassification)) {
      this.error(
        [...p],
        'CLASSIFICATION_EXCEEDED',
        `Step '${step.id}' handles ${sens} data but '${cap.name}' is only cleared for ${d.dataClassification}`,
      );
    }
    this.checkResidency(cap, p);

    const perInvocation = d.costModel.unitsPerInvocation;
    const invocations = step.type === 'map' ? step.maxItems : 1;
    this.maxInvocations += invocations;
    this.estimatedCost += perInvocation * invocations;
    this.maxCost += perInvocation * invocations * retry.attempts;
    this.maxFan = Math.max(this.maxFan, invocations);
    if (d.compensation && d.effect === 'effectful' && !(step as CapabilityStep).compensate) {
      this.warn(
        [...p],
        'COMPENSATION_AVAILABLE',
        `'${cap.name}' can be reversed by '${d.compensation}' — consider adding 'compensate'`,
      );
    }
  }

  /** Effectful capabilities need an idempotency key (ADR-0002 D3); map keys must vary per item. */
  private checkIdempotency(step: CapabilityStep | MapStep, cap: ResolvedCap, p: PathSegment[]): void {
    const d = cap.declaration;
    if (d.effect === 'effectful' && step.idempotencyKey === undefined) {
      this.error(
        [...p],
        'EFFECTFUL_WITHOUT_IDEMPOTENCY_KEY',
        `Step '${step.id}' uses effectful capability '${cap.name}' and must declare an idempotencyKey (duplicate effects on retry are otherwise possible)`,
      );
    }
    if (d.effect === 'pure' && step.idempotencyKey !== undefined) {
      this.warn(
        [...p, 'idempotencyKey'],
        'IDEMPOTENCY_KEY_UNNEEDED',
        `'${cap.name}' is pure; the idempotencyKey has no effect`,
      );
    }
    if (step.type === 'map' && d.effect === 'effectful' && step.idempotencyKey !== undefined) {
      const keyRefs = scanTemplates(step.idempotencyKey, '').flatMap((f) =>
        (f.template?.parts ?? []).flatMap((part) => (part.kind === 'expr' ? collectReferences(part.ast) : [])),
      );
      if (!keyRefs.some((r) => r.root === 'item' || r.root === 'index')) {
        this.error(
          [...p, 'idempotencyKey'],
          'MAP_KEY_NOT_ITEM_SPECIFIC',
          'A map over an effectful capability needs an idempotencyKey that includes ${{ item… }} or ${{ index }}; otherwise every item shares one key and all but the first would be dropped',
        );
      }
    }
  }

  /** The egress list recorded in the plan, or undefined when the capability has no network access. */
  private egressFor(step: CapabilityStep | MapStep, cap: ResolvedCap, p: PathSegment[]): string[] | undefined {
    const e = cap.declaration.egress;
    if (e.mode === 'step') {
      if (!step.egress || step.egress.length === 0) {
        this.error(
          [...p],
          'EGRESS_REQUIRED',
          `'${cap.name}' reaches the network: step '${step.id}' must declare 'egress' hosts (default is deny)`,
        );
      }
      return [...new Set(step.egress ?? [])].sort(compareStrings);
    }
    if (e.mode === 'static') {
      if (step.egress?.length)
        this.warn(
          [...p, 'egress'],
          'EGRESS_IGNORED',
          `'${cap.name}' has a fixed egress list; the step's 'egress' is ignored`,
        );
      return [...e.hosts].sort(compareStrings);
    }
    if (step.egress?.length) {
      this.error(
        [...p, 'egress'],
        'EGRESS_NOT_APPLICABLE',
        `'${cap.name}' has no network access, so 'egress' is not allowed`,
      );
    }
    return undefined;
  }

  /** Shell steps are migration bridges (§11.4) and must carry a live review date. */
  private checkSunset(step: CapabilityStep | MapStep, family: string, p: PathSegment[]): void {
    if (family !== 'shell') return;
    if (!step.sunset) {
      this.error(
        [...p, 'sunset'],
        'SUNSET_REQUIRED',
        'Shell steps must carry a review date (sunset: YYYY-MM-DD) so the migration bridge cannot become permanent',
      );
    } else if (step.sunset < this.options.today) {
      this.error(
        [...p, 'sunset'],
        'SUNSET_EXPIRED',
        `Sunset date ${step.sunset} has passed — decompose or re-review this shell step`,
      );
    }
  }

  private checkResidency(cap: ResolvedCap, p: PathSegment[]): void {
    const residency = this.manifest.policy?.dataResidency ?? [];
    if (residency.length === 0) return;
    const regions = cap.declaration.regions;
    if (!regions) {
      this.warn(
        [...p],
        'RESIDENCY_UNKNOWN',
        `'${cap.name}' does not declare regions; residency ${residency.join(', ')} cannot be verified`,
      );
    } else if (!regions.some((r) => residency.includes(r))) {
      this.error(
        [...p],
        'RESIDENCY_VIOLATION',
        `'${cap.name}' only operates in ${regions.join(', ')} but the workflow requires ${residency.join(', ')}`,
      );
    }
  }

  private fillCompensation(base: PlanStep, s: CapabilityStep, retry: PlanRetry, p: PathSegment[]): void {
    const cc = this.compCapOf.get(s.id);
    if (!cc || !s.compensate) return;
    const cd = cc.declaration;
    this.checkWithShape(s.compensate.with, cd.inputSchema, [...p, 'compensate', 'with'], `'${cc.name}'`);
    if (cd.effect === 'effectful' && !s.compensate.idempotencyKey) {
      this.error(
        [...p, 'compensate'],
        'COMPENSATION_WITHOUT_IDEMPOTENCY_KEY',
        `Compensation '${cc.name}' is effectful and needs an idempotencyKey`,
      );
    }
    const comp: PlanCompensation = {
      capability: { name: cc.name, version: cc.version, hash: cc.hash },
      with: (s.compensate.with ?? {}) as JsonObject,
      ...(s.compensate.idempotencyKey ? { idempotencyKey: s.compensate.idempotencyKey } : {}),
      timeoutMs: s.compensate.timeout !== undefined ? parseDuration(s.compensate.timeout) : this.policyTimeoutMs(),
      egress: cd.egress.mode === 'static' ? [...cd.egress.hosts].sort(compareStrings) : [],
    };
    if (cd.egress.mode === 'step') {
      this.error(
        [...p, 'compensate'],
        'COMPENSATION_EGRESS_UNSUPPORTED',
        `Compensation '${cc.name}' needs step-declared egress, which compensation does not support; use a capability with a static allow-list`,
      );
    }
    base.compensate = comp;
    this.maxInvocations += 1;
    this.maxCost += cd.costModel.unitsPerInvocation * retry.attempts;
  }

  // ------------------------------------------------------ whole-workflow
  private checkTotals(): void {
    const { limits, manifest } = this;
    if (this.subDepth > limits.maxSubworkflowDepth) {
      this.error(
        ['steps'],
        'SUBWORKFLOW_TOO_DEEP',
        `Subworkflow nesting depth ${this.subDepth} exceeds the limit of ${limits.maxSubworkflowDepth}`,
      );
    }
    if (this.maxInvocations > limits.maxInvocations) {
      this.error(
        ['steps'],
        'TOO_MANY_INVOCATIONS',
        `One run could make ${this.maxInvocations} capability invocations; the limit is ${limits.maxInvocations}`,
      );
    }
    const ceiling = manifest.policy?.maxRunCost;
    if (ceiling === undefined) return;
    if (this.estimatedCost > ceiling) {
      this.error(
        ['policy', 'maxRunCost'],
        'COST_CEILING_TOO_LOW',
        `A single run can cost ${this.estimatedCost} units at minimum, above the maxRunCost of ${ceiling}`,
      );
    } else if (this.maxCost > ceiling) {
      this.warn(
        ['policy', 'maxRunCost'],
        'COST_MAY_EXCEED_CEILING',
        `With every retry consumed a run could cost ${this.maxCost} units, above maxRunCost ${ceiling}`,
      );
    }
  }

  private knownContext(): Set<string> {
    return new Set([
      'now',
      'environment',
      'tenant',
      ...Object.keys(this.manifest.context ?? {}),
      ...Object.keys(this.options.context ?? {}),
    ]);
  }

  private unknownContextKey(path: PathSegment[], key: string): void {
    this.error(
      path,
      'UNKNOWN_CONTEXT_KEY',
      `context.${key} is not defined (declare it in 'context' or provide it via the deployment)`,
    );
  }

  /** References in the workflow's `outputs`: step fields must exist and `context.*` keys must be defined. */
  private checkWorkflowRefs(value: unknown, path: PathSegment[]): void {
    const known = this.knownContext();
    const refs = scanTemplates(value, '').flatMap((f) =>
      (f.template?.parts ?? []).flatMap((part) => (part.kind === 'expr' ? collectReferences(part.ast) : [])),
    );
    for (const r of refs) {
      if (r.root === 'steps' && r.path[0]) this.checkOutputField(r, path, false);
      if (r.root === 'context' && r.path[0] && !known.has(r.path[0])) this.unknownContextKey(path, r.path[0]);
    }
  }

  /** `context.*` is only knowable at compile time — check every step expression for undefined keys. */
  private checkContextKeys(): void {
    const known = this.knownContext();
    this.manifest.steps.forEach((s, i) => {
      for (const { path, refs } of this.refsOf(s)) {
        for (const r of refs) {
          const key = r.root === 'context' ? r.path[0] : undefined;
          if (key && !known.has(key)) this.unknownContextKey(path.length ? path : ['steps', i], key);
        }
      }
    });
  }

  // -------------------------------------------------------------- assemble
  private analyse(): { analysis: PlanAnalysis; caps: Record<string, PlanCapabilityRef> } {
    const caps: Record<string, PlanCapabilityRef> = {};
    const scopes = new Set<string>();
    const egress = new Set<string>();
    const families = new Set<string>();
    const effects: Record<EffectClass, number> = { pure: 0, idempotent: 0, effectful: 0 };
    for (const c of [...this.capOf.values(), ...this.compCapOf.values()]) {
      caps[c.name] = { name: c.name, version: c.version, hash: c.hash };
      for (const sc of c.declaration.scopes) scopes.add(sc);
      families.add(c.declaration.family);
    }
    const sensMax = this.tallyEffects(effects, egress);
    const analysis: PlanAnalysis = {
      stepCount: this.planSteps.length,
      depth: longestPath(this.orderedIds, this.deps),
      effects,
      scopes: [...scopes].sort(compareStrings),
      egress: [...egress].sort(compareStrings),
      capabilities: Object.values(caps)
        .map((c) => `${c.name}@${c.version}`)
        .sort(compareStrings),
      maxFanOut: this.maxFan,
      maxInvocations: this.maxInvocations,
      subworkflowDepth: this.subDepth,
      subworkflowChain: [...this.subChain].sort(compareStrings),
      families: [...families].sort(compareStrings),
      hasApproval: this.planSteps.some((x) => x.type === 'approval'),
      hasCompensation: this.planSteps.some((x) => x.compensate !== undefined),
      maxSensitivity: sensMax,
      estimatedCost: this.estimatedCost,
      maxCost: this.maxCost,
    };
    return { analysis, caps };
  }

  /** Count effects and collect egress hosts over the plan's steps (and their compensations); returns the highest sensitivity. */
  private tallyEffects(effects: Record<EffectClass, number>, egress: Set<string>): Sensitivity {
    let sensMax: Sensitivity = 'public';
    for (const st of this.planSteps) {
      if (st.capability && st.effect) effects[st.effect]++;
      for (const h of st.egress ?? []) egress.add(h);
      sensMax = maxSensitivity(sensMax, st.sensitivity);
    }
    for (const st of this.planSteps) {
      if (!st.compensate) continue;
      const d = this.compCapOf.get(st.id)?.declaration;
      if (d) effects[d.effect as EffectClass]++;
      for (const h of st.compensate.egress) egress.add(h);
    }
    return sensMax;
  }

  private assemble(): Plan {
    const { manifest, options, limits } = this;
    const { analysis, caps } = this.analyse();
    const policy = manifest.policy ?? {};
    return {
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
      context: { ...manifest.context, ...options.context, environment: options.environment },
      steps: this.planSteps,
      guards: { pre: manifest.guards?.pre ?? [], invariants: manifest.guards?.invariants ?? [] },
      outputs: manifest.outputs ?? {},
      policy: {
        timeoutMs: policy.timeout !== undefined ? parseDuration(policy.timeout) : limits.defaultStepTimeoutMs,
        concurrency: policy.concurrency ?? 10,
        concurrencyPolicy: policy.concurrencyPolicy ?? 'queue',
        maxParallelSteps: policy.maxParallelSteps ?? 8,
        dataResidency: [...(policy.dataResidency ?? [])].sort(compareStrings),
        ...(policy.maxRunCost !== undefined ? { maxRunCost: policy.maxRunCost } : {}),
        ...(policy.maxDailyCost !== undefined ? { maxDailyCost: policy.maxDailyCost } : {}),
        ...(policy.dedupWindow !== undefined ? { dedupWindowMs: parseDuration(policy.dedupWindow) } : {}),
        ...(policy.dedupKey ? { dedupKey: policy.dedupKey } : {}),
      },
      observability: manifest.observability ?? {},
      capabilities: caps,
      subworkflows: this.subworkflows,
      analysis,
    };
  }
}

function fillApprovalStep(base: PlanStep, s: ApprovalStepDef): void {
  base.message = s.message;
  base.approvers = {
    roles: [...new Set(s.approvers?.roles ?? (s.approvers?.users ? [] : ['approver']))].sort(compareStrings),
    users: [...new Set(s.approvers?.users ?? [])].sort(compareStrings),
  };
  base.onTimeout = s.onTimeout;
  if (s.justification) base.justification = s.justification;
  base.allowSelfApproval = s.allowSelfApproval ?? false;
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
