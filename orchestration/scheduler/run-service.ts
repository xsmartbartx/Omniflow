import {
  type Clock,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PolicyDeniedError,
  resolveValue,
  systemClock,
  ValidationError,
} from '../../core/index.ts';
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

export interface RunServiceDeps {
  state: State;
  orchestrator: Orchestrator;
  registry: RegistryService;
  policy: PolicyEngine;
  clock?: Clock;
  /** Called after a run is queued so the scheduler can admit it promptly. */
  onQueued?: () => void;
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
  private readonly clock: Clock;
  private readonly onQueued: (() => void) | undefined;

  constructor(deps: RunServiceDeps) {
    this.st = deps.state;
    this.orch = deps.orchestrator;
    this.reg = deps.registry;
    this.policy = deps.policy;
    this.clock = deps.clock ?? systemClock;
    this.onQueued = deps.onQueued;
  }

  trigger(req: TriggerRequest): TriggerResult {
    const { principal } = req;
    const tenant = principal.tenant;
    const settings = this.st.registry.getSettings(tenant, req.workflow);
    if (!settings) throw new NotFoundError('Workflow', req.workflow);

    // ---- resolve the version (canary selection is stable per (workflow, run key))
    const key = `${this.clock.now().getTime()}:${Math.random()}`;
    const resolved = req.version
      ? { ...this.reg.getVersionPlan(tenant, req.workflow, req.version), canary: false }
      : this.reg.resolveActive(tenant, req.workflow, key);
    const { version, plan, canary } = resolved;

    // ---- authorisation and operator controls
    const decision = this.policy.decide({
      principal,
      action: 'workflow.run',
      resource: {
        tenant,
        workflow: req.workflow,
        version: version.version,
        criticality: plan.workflow.criticality,
        environment: this.policy.environment,
        plan,
        dryRun: req.dryRun ?? false,
      },
    });
    if (decision.effect === 'deny') {
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
    if (!settings.enabled)
      throw new ConflictError(`Workflow '${req.workflow}' is disabled`, { code: 'WORKFLOW_DISABLED' });
    if (settings.killed)
      throw new ConflictError(
        `Workflow '${req.workflow}' is stopped by its kill switch${settings.killReason ? `: ${settings.killReason}` : ''}`,
        { code: 'WORKFLOW_KILLED' },
      );
    if (version.status === 'frozen') throw new ConflictError(`${req.workflow}@${version.version} is frozen`);

    // ---- validate inputs against the plan's schema; defaults are applied here, once
    const checked = validateValue<Record<string, unknown>>(plan.inputSchema, req.inputs ?? {});
    if (!checked.ok) {
      throw new ValidationError(
        `Invalid inputs for ${req.workflow}`,
        checked.issues.map((i) => ({ ...i, path: i.path ? `inputs.${i.path}` : 'inputs' })),
      );
    }
    const inputs = checked.value;

    // ---- deduplication window
    let dedupKey: string | undefined;
    if (plan.policy.dedupKey && plan.policy.dedupWindowMs) {
      try {
        dedupKey = String(resolveValue(plan.policy.dedupKey, { inputs, context: plan.context }));
      } catch {
        dedupKey = undefined;
      }
      if (dedupKey) {
        const since = new Date(this.clock.now().getTime() - plan.policy.dedupWindowMs).toISOString();
        const existing = this.st.runs.findByDedupKey(tenant, req.workflow, dedupKey, since);
        if (existing) {
          this.st.events.append({
            tenant,
            type: 'run.deduplicated',
            data: { workflow: req.workflow, existingRunId: existing.id, dedupKey },
          });
          return { status: 'deduplicated', run: existing };
        }
      }
    }

    // ---- concurrency policy: `skip` drops the run rather than queueing behind the limit
    if (plan.policy.concurrencyPolicy === 'skip') {
      const busy =
        this.st.runs.activeCount(tenant, req.workflow) +
        this.st.runs.countRuns({ tenant, workflow: req.workflow, status: ['queued'] });
      if (busy >= plan.policy.concurrency) {
        this.st.events.append({
          tenant,
          type: 'run.skipped',
          data: { workflow: req.workflow, reason: 'concurrency-limit', limit: plan.policy.concurrency },
        });
        return { status: 'skipped', reason: `Concurrency limit of ${plan.policy.concurrency} reached (policy: skip)` };
      }
    }

    // ---- cost ceilings
    if (plan.policy.maxDailyCost !== undefined) {
      const spent = this.st.runs.dailyCost(tenant, req.workflow);
      if (spent + plan.analysis.estimatedCost > plan.policy.maxDailyCost) {
        this.st.events.append({
          tenant,
          type: 'run.skipped',
          data: { workflow: req.workflow, reason: 'daily-cost-ceiling', spent, ceiling: plan.policy.maxDailyCost },
        });
        throw new PolicyDeniedError(
          'DAILY_COST_CEILING',
          `Daily cost ceiling of ${plan.policy.maxDailyCost} would be exceeded (spent ${spent}, this run ≈ ${plan.analysis.estimatedCost})`,
        );
      }
    }

    const run = this.orch.createRun({
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
    this.onQueued?.();
    return { status: 'queued', run };
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
