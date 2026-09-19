import { type Clock, type Logger, nullLogger, systemClock } from '../../core/index.ts';
import type { Principal } from '../../schemas/policy.ts';
import { ACTIVE_RUN_STATUSES, type State } from '../../state/index.ts';
import type { Orchestrator } from '../orchestrator/index.ts';
import type { RegistryService } from '../registry/index.ts';

export interface SchedulerConfig {
  /** Runs allowed to be executing at once across every tenant. */
  maxConcurrentRuns: number;
  /** Per-tenant share of that capacity (fairness — one tenant cannot starve the rest). */
  maxConcurrentRunsPerTenant: number;
  pollMs: number;
  /** Auto-rollback a canary once it has this many finished runs and fails more than `maxFailureRate`. */
  canary: { minRuns: number; maxFailureRate: number };
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  maxConcurrentRuns: 16,
  maxConcurrentRunsPerTenant: 16,
  pollMs: 500,
  canary: { minRuns: 5, maxFailureRate: 0.3 },
};

const SYSTEM_PRINCIPAL = (tenant: string): Principal => ({
  id: 'system:scheduler',
  type: 'system',
  name: 'Scheduler',
  tenant,
  roles: ['admin'],
});

/**
 * Scheduler (architecture §5.1 #9): decides *when* and *whether* a queued run starts — global and
 * per-workflow concurrency limits, priorities, tenant fairness, and admission control. It does not
 * know what steps do.
 */
export class Scheduler {
  private readonly st: State;
  private readonly orch: Orchestrator;
  private readonly registry: RegistryService | undefined;
  private readonly cfg: SchedulerConfig;
  private readonly clock: Clock;
  private readonly log: Logger;
  private timer: NodeJS.Timeout | undefined;
  private off: (() => void) | undefined;
  private pumping = false;
  private housekeeping = 0;

  constructor(deps: {
    state: State;
    orchestrator: Orchestrator;
    registry?: RegistryService;
    config?: Partial<SchedulerConfig>;
    clock?: Clock;
    log?: Logger;
  }) {
    this.st = deps.state;
    this.orch = deps.orchestrator;
    this.registry = deps.registry;
    this.cfg = { ...DEFAULT_SCHEDULER_CONFIG, ...deps.config };
    this.clock = deps.clock ?? systemClock;
    this.log = deps.log ?? nullLogger;
  }

  start(): void {
    this.off = this.orch.on('run-finished', () => this.pump());
    this.timer = setInterval(() => this.tick(), this.cfg.pollMs);
    this.timer.unref?.();
    this.pump();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.off?.();
  }

  private tick(): void {
    this.pump();
    if (++this.housekeeping % 120 === 0) {
      try {
        this.evaluateCanaries();
        this.st.idempotency.purgeExpired();
        this.st.identity.purgeExpiredSessions();
        this.st.triggers.purge();
      } catch (e) {
        this.log.error('housekeeping failed', { error: e });
      }
    }
  }

  /** Admit as many queued runs as capacity, per-workflow limits and fairness allow. Returns how many started. */
  pump(): number {
    if (this.pumping) return 0;
    this.pumping = true;
    let started = 0;
    try {
      const queued = this.st.runs.runsByStatus(['queued'], 500);
      if (queued.length === 0) return 0;
      const counts = this.st.runs.countByStatus();
      let active = ACTIVE_RUN_STATUSES.reduce((n, s) => n + (counts[s] ?? 0), 0);
      const perTenant = new Map<string, number>();
      const perWorkflow = new Map<string, number>();

      for (const run of queued) {
        if (active >= this.cfg.maxConcurrentRuns) break;
        const settings = this.st.registry.getSettings(run.tenant, run.workflowName);
        if (settings?.killed || settings?.enabled === false) {
          // Queued behind a limit while an operator pulled the plug: do not start it.
          this.orch.cancelRun(
            run.id,
            { id: 'system:scheduler', name: 'Scheduler' },
            settings.killed ? 'workflow killed while queued' : 'workflow disabled while queued',
          );
          continue;
        }
        const tenantActive = perTenant.get(run.tenant) ?? this.st.runs.activeCount(run.tenant);
        if (tenantActive >= this.cfg.maxConcurrentRunsPerTenant) continue;

        const plan = this.st.registry.getPlan(run.tenant, run.planHash);
        const wfKey = `${run.tenant}/${run.workflowName}`;
        const wfActive = perWorkflow.get(wfKey) ?? this.st.runs.activeCount(run.tenant, run.workflowName);
        if (plan && wfActive >= plan.policy.concurrency) continue;

        this.orch.startRun(run.id);
        started++;
        active++;
        perTenant.set(run.tenant, tenantActive + 1);
        perWorkflow.set(wfKey, wfActive + 1);
      }
    } catch (e) {
      this.log.error('scheduler pump failed', { error: e });
    } finally {
      this.pumping = false;
    }
    return started;
  }

  /** Automatic canary rollback on SLO breach (architecture §17, Phase 4). */
  evaluateCanaries(): string[] {
    if (!this.registry) return [];
    const rolledBack: string[] = [];
    for (const tenant of this.st.identity.listTenants()) {
      for (const wf of this.st.registry.listWorkflows(tenant.id)) {
        const s = wf.settings;
        if (!s.canaryVersion || s.canaryPercent <= 0) continue;
        const runs = this.st.runs
          .listRuns({ tenant: tenant.id, workflow: wf.name, limit: 100 })
          .filter(
            (r) =>
              r.workflowVersion === s.canaryVersion &&
              r.canary &&
              ['succeeded', 'failed', 'rolled-back', 'compensation-failed'].includes(r.status),
          );
        if (runs.length < this.cfg.canary.minRuns) continue;
        const failed = runs.filter((r) => r.status !== 'succeeded').length;
        if (failed / runs.length > this.cfg.canary.maxFailureRate) {
          this.registry.rollbackCanary(
            SYSTEM_PRINCIPAL(tenant.id),
            wf.name,
            `automatic rollback: ${failed}/${runs.length} canary runs failed`,
          );
          rolledBack.push(`${tenant.id}/${wf.name}`);
        }
      }
    }
    return rolledBack;
  }
}
