import {
  type Clock,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PolicyDeniedError,
  randomToken,
  resolveValue,
  systemClock,
  ValidationError,
} from '../../core/index.ts';
import type { Plan } from '../../schemas/plan.ts';
import type { Principal } from '../../schemas/policy.ts';
import type { PolicyEngine } from '../../security/policy/index.ts';
import { validateValue } from '../../security/validator/index.ts';
import { isTerminalRun, type RunRecord, type State } from '../../state/index.ts';
import type { Orchestrator } from '../orchestrator/index.ts';
import type { RegistryService } from '../registry/index.ts';

export interface TriggerRequest {
  principal: Principal;
  workflow: string;
  /** Pin an exact version; otherwise the active (stable or canary) version is used. */
  version?: string;
  inputs?: Record<string, unknown>;
  trigger: { type: string; name?: string; payload?: unknown };
  dryRun?: boolean;
  priority?: number;
  correlationId?: string;
}

export type TriggerResult =
  | { status: 'queued'; run: RunRecord }
  | { status: 'deduplicated'; run: RunRecord }
  | { status: 'skipped'; reason: string };

/**
 * Optional admission gate (the NEXORA entitlement hook). `check` throws to refuse a run before anything is
 * written; `admitted` runs in the same transaction as the run's creation. Dry runs never reach the gate.
 */
export interface AdmissionGate {
  check(tenant: string): void;
  admitted(run: RunRecord): void;
}

export interface RunServiceDeps {
  state: State;
  orchestrator: Orchestrator;
  registry: RegistryService;
  policy: PolicyEngine;
  clock?: Clock;
  /** Called after a run is queued so the scheduler can admit it promptly. */
  onQueued?: () => void;
  gate?: AdmissionGate;
}

/**
 * Turns "someone or something wants to run workflow X" into a queued run — or a refusal — in one
 * governed pipeline: authorisation, kill/disable checks, version resolution (with canary),
 * input validation, deduplication, concurrency policy and cost ceilings. The Scheduler then decides
 * *when* it starts.
 */
export class RunService {
  private readonly st: State;
  private readonly orch: Orchestrator;
  private readonly reg: RegistryService;
  private readonly policy: PolicyEngine;
  private readonly gate: AdmissionGate | undefined;
  private readonly clock: Clock;
  private readonly onQueued: (() => void) | undefined;

  constructor(deps: RunServiceDeps) {
    this.st = deps.state;
    this.orch = deps.orchestrator;
    this.reg = deps.registry;
    this.policy = deps.policy;
    this.clock = deps.clock ?? systemClock;
    this.onQueued = deps.onQueued;
    this.gate = deps.gate;
  }

  trigger(req: TriggerRequest): TriggerResult {
    const { principal } = req;
    const tenant = principal.tenant;
    const settings = this.st.registry.getSettings(tenant, req.workflow);
    if (!settings) throw new NotFoundError('Workflow', req.workflow);

    // ---- resolve the version (canary selection is stable per (workflow, run key))
    const key = `${this.clock.now().getTime()}:${randomToken(8)}`;
    const resolved = req.version
      ? { ...this.reg.getVersionPlan(tenant, req.workflow, req.version), canary: false }
      : this.reg.resolveActive(tenant, req.workflow, key);
    const { version, plan, canary } = resolved;

    this.authorise(req, plan, version.version);
    this.assertRunnable(req.workflow, settings, version);

    // ---- validate inputs against the plan's schema; defaults are applied here, once
    const checked = validateValue<Record<string, unknown>>(plan.inputSchema, req.inputs ?? {});
    if (!checked.ok) {
      throw new ValidationError(
        `Invalid inputs for ${req.workflow}`,
        checked.issues.map((i) => ({ ...i, path: i.path ? `inputs.${i.path}` : 'inputs' })),
      );
    }
    const inputs = checked.value;

    const dedupKey = this.dedupKeyOf(plan, inputs);
    const early =
      this.checkDedup(tenant, req.workflow, plan, dedupKey) ?? this.checkConcurrency(tenant, req.workflow, plan);
    if (early) return early;
    this.checkDailyCost(tenant, req.workflow, plan);

    if (!req.dryRun) this.gate?.check(tenant);
    const gate = this.gate;
    const create = () =>
      this.orch.createRun({
        tenant,
        plan,
        planHash: version.planHash,
        inputs,
        principal,
        trigger: req.trigger,
        ...(req.dryRun ? { dryRun: true } : {}),
        ...(req.priority !== undefined ? { priority: req.priority } : {}),
        ...(req.correlationId ? { correlationId: req.correlationId } : {}),
        canary,
        ...(dedupKey ? { dedupKey } : {}),
      });
    const run = this.st.db.transaction(() => {
      const created = create();
      if (!req.dryRun) gate?.admitted(created);
      return created;
    });
    this.onQueued?.();
    return { status: 'queued', run };
  }

  /** Run-permission check; a denial is recorded in the audit log before it is thrown. */
  private authorise(req: TriggerRequest, plan: Plan, version: string): void {
    const { principal } = req;
    const tenant = principal.tenant;
    const decision = this.policy.decide({
      principal,
      action: 'workflow.run',
      resource: {
        tenant,
        workflow: req.workflow,
        version,
        criticality: plan.workflow.criticality,
        environment: this.policy.environment,
        plan,
        dryRun: req.dryRun ?? false,
      },
    });
    if (decision.effect !== 'deny') return;
    this.st.events.append({
      tenant,
      type: 'policy.decision',
      actor: { type: principal.type, id: principal.id, name: principal.name },
      data: {
        action: 'workflow.run',
        effect: 'deny',
        reasonCode: decision.reasonCode,
        reason: decision.reason,
        workflow: req.workflow,
      },
    });
    throw new PolicyDeniedError(decision.reasonCode, decision.reason, { workflow: req.workflow });
  }

  /** Operator controls: a disabled, killed or frozen workflow does not run. */
  private assertRunnable(
    workflow: string,
    settings: { enabled: boolean; killed: boolean; killReason?: string | undefined },
    version: { version: string; status: string },
  ): void {
    if (!settings.enabled) throw new ConflictError(`Workflow '${workflow}' is disabled`, { code: 'WORKFLOW_DISABLED' });
    if (settings.killed) {
      const reason = settings.killReason ? `: ${settings.killReason}` : '';
      throw new ConflictError(`Workflow '${workflow}' is stopped by its kill switch${reason}`, {
        code: 'WORKFLOW_KILLED',
      });
    }
    if (version.status === 'frozen') throw new ConflictError(`${workflow}@${version.version} is frozen`);
  }

  private dedupKeyOf(plan: Plan, inputs: Record<string, unknown>): string | undefined {
    if (!plan.policy.dedupKey || !plan.policy.dedupWindowMs) return undefined;
    try {
      return String(resolveValue(plan.policy.dedupKey, { inputs, context: plan.context })) || undefined;
    } catch {
      return undefined;
    }
  }

  /** A run with the same dedup key inside the window is not started again. */
  private checkDedup(
    tenant: string,
    workflow: string,
    plan: Plan,
    dedupKey: string | undefined,
  ): TriggerResult | undefined {
    if (!dedupKey || !plan.policy.dedupWindowMs) return undefined;
    const since = new Date(this.clock.now().getTime() - plan.policy.dedupWindowMs).toISOString();
    const existing = this.st.runs.findByDedupKey(tenant, workflow, dedupKey, since);
    if (!existing) return undefined;
    this.st.events.append({
      tenant,
      type: 'run.deduplicated',
      data: { workflow, existingRunId: existing.id, dedupKey },
    });
    return { status: 'deduplicated', run: existing };
  }

  /** Concurrency policy `skip` drops the run rather than queueing behind the limit. */
  private checkConcurrency(tenant: string, workflow: string, plan: Plan): TriggerResult | undefined {
    if (plan.policy.concurrencyPolicy !== 'skip') return undefined;
    const busy =
      this.st.runs.activeCount(tenant, workflow) + this.st.runs.countRuns({ tenant, workflow, status: ['queued'] });
    if (busy < plan.policy.concurrency) return undefined;
    this.st.events.append({
      tenant,
      type: 'run.skipped',
      data: { workflow, reason: 'concurrency-limit', limit: plan.policy.concurrency },
    });
    return { status: 'skipped', reason: `Concurrency limit of ${plan.policy.concurrency} reached (policy: skip)` };
  }

  private checkDailyCost(tenant: string, workflow: string, plan: Plan): void {
    if (plan.policy.maxDailyCost === undefined) return;
    const spent = this.st.runs.dailyCost(tenant, workflow);
    if (spent + plan.analysis.estimatedCost <= plan.policy.maxDailyCost) return;
    this.st.events.append({
      tenant,
      type: 'run.skipped',
      data: { workflow, reason: 'daily-cost-ceiling', spent, ceiling: plan.policy.maxDailyCost },
    });
    throw new PolicyDeniedError(
      'DAILY_COST_CEILING',
      `Daily cost ceiling of ${plan.policy.maxDailyCost} would be exceeded (spent ${spent}, this run ≈ ${plan.analysis.estimatedCost})`,
    );
  }

  /** Cancel a run on behalf of a principal. */
  cancel(principal: Principal, runId: string, reason?: string): RunRecord {
    const run = this.mustGet(principal, runId);
    const d = this.policy.decide({
      principal,
      action: 'run.cancel',
      resource: { tenant: run.tenant, workflow: run.workflowName },
    });
    if (d.effect !== 'allow') throw new PolicyDeniedError(d.reasonCode, d.reason);
    return this.orch.cancelRun(runId, { id: principal.id, name: principal.name }, reason);
  }

  /** Re-run a finished run with the same inputs and the exact same plan. */
  retry(principal: Principal, runId: string): TriggerResult {
    const run = this.mustGet(principal, runId);
    const d = this.policy.decide({
      principal,
      action: 'run.retry',
      resource: { tenant: run.tenant, workflow: run.workflowName },
    });
    if (d.effect !== 'allow') throw new PolicyDeniedError(d.reasonCode, d.reason);
    if (!isTerminalRun(run.status)) throw new ConflictError('Only a finished run can be retried');
    return this.trigger({
      principal,
      workflow: run.workflowName,
      version: run.workflowVersion,
      inputs: run.inputs,
      trigger: { type: 'retry', payload: { retryOf: run.id } },
      dryRun: run.dryRun,
      ...(run.correlationId ? { correlationId: run.correlationId } : {}),
    });
  }

  private mustGet(principal: Principal, runId: string): RunRecord {
    const run = this.st.runs.getRun(runId, principal.tenant);
    if (!run) throw new NotFoundError('Run', runId);
    if (run.tenant !== principal.tenant) throw new ForbiddenError('Run belongs to another tenant');
    return run;
  }
}
