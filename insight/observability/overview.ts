import type { State } from '../../state/index.ts';
import { parseMs, percentile, ratio } from '../util.ts';

/** Everything the dashboard shows, computed in one read-only pass over run history. */
export interface Overview {
  window: { hours: number; since: string; until: string };
  runs: {
    total: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    active: number;
    queued: number;
    /** Succeeded ÷ finished (cancelled runs do not count against a workflow). Null when nothing finished. */
    successRate: number | null;
  };
  latencyMs: { p50: number | null; p95: number | null };
  /** Runs that needed a person, as a share of all runs — the honest measure of whether work was really automated. */
  manualInterventionRate: number | null;
  approvals: { pending: number; medianDecisionMs: number | null };
  queue: { depth: number; oldestWaitMs: number | null };
  cost: { total: number };
  hourly: Array<{ hour: string; succeeded: number; failed: number; other: number }>;
  workflows: Array<{ name: string; runs: number; succeeded: number; failed: number; successRate: number | null; p95Ms: number | null; cost: number }>;
  failingSteps: Array<{ workflow: string; stepId: string; failed: number; executions: number; topError: string | null }>;
}

const FINISHED = new Set(['succeeded', 'failed', 'rolled-back', 'compensation-failed']);

export function buildOverview(state: State, tenant: string, opts: { hours?: number } = {}): Overview {
  const hours = Math.min(24 * 30, Math.max(1, opts.hours ?? 24));
  const now = state.clock.now();
  const since = new Date(now.getTime() - hours * 3_600_000).toISOString();

  const wf = state.analytics.workflowRunStats(tenant, since);
  const timings = state.analytics.runTimings(tenant, since);
  const durations = new Map<string, number[]>();
  const all: number[] = [];
  for (const r of timings) {
    if (!FINISHED.has(r.status)) continue;
    const s = parseMs(r.startedAt);
    const f = parseMs(r.finishedAt);
    if (s === undefined || f === undefined) continue;
    all.push(f - s);
    durations.set(r.workflow, [...(durations.get(r.workflow) ?? []), f - s]);
  }

  const succeeded = wf.reduce((n, w) => n + w.succeeded, 0);
  const failed = wf.reduce((n, w) => n + w.failed, 0);
  const total = wf.reduce((n, w) => n + w.total, 0);
  const counts = state.runs.countByStatus(tenant);
  const active = ['running', 'waiting-approval', 'waiting-event', 'compensating'].reduce((n, s) => n + (counts[s] ?? 0), 0);
  const approvals = state.analytics.approvalStats(tenant, since);
  const decisions = approvals.flatMap((a) => (a.medianDecisionMs === null ? [] : [a.medianDecisionMs]));
  const queue = state.analytics.queue(tenant);
  const { runs: seenRuns, withApproval } = state.analytics.interventionCounts(tenant, since);

  const stepErrors = state.analytics.stepErrors(tenant, since);
  const failingSteps = state.analytics
    .stepStats(tenant, since)
    .filter((s) => s.failed > 0)
    .map((s) => ({
      workflow: s.workflow,
      stepId: s.stepId,
      failed: s.failed,
      executions: s.succeeded + s.failed,
      topError: stepErrors.find((e) => e.workflow === s.workflow && e.stepId === s.stepId)?.code ?? null,
    }))
    .sort((a, b) => b.failed - a.failed || a.workflow.localeCompare(b.workflow) || a.stepId.localeCompare(b.stepId))
    .slice(0, 10);

  return {
    window: { hours, since, until: now.toISOString() },
    runs: {
      total,
      succeeded,
      failed,
      cancelled: wf.reduce((n, w) => n + w.cancelled, 0),
      active,
      queued: counts.queued ?? 0,
      successRate: succeeded + failed === 0 ? null : ratio(succeeded, succeeded + failed),
    },
    latencyMs: { p50: percentile(all, 50) ?? null, p95: percentile(all, 95) ?? null },
    manualInterventionRate: seenRuns === 0 ? null : ratio(withApproval, seenRuns),
    approvals: { pending: state.approvals.pendingCount(tenant), medianDecisionMs: percentile(decisions, 50) ?? null },
    queue: { depth: queue.depth, oldestWaitMs: queue.oldestCreatedAt ? now.getTime() - Date.parse(queue.oldestCreatedAt) : null },
    cost: { total: wf.reduce((n, w) => n + w.cost, 0) },
    hourly: state.analytics.runsByHour(tenant, Math.min(hours, 72)),
    workflows: wf
      .map((w) => ({
        name: w.workflow,
        runs: w.total,
        succeeded: w.succeeded,
        failed: w.failed,
        successRate: w.succeeded + w.failed === 0 ? null : ratio(w.succeeded, w.succeeded + w.failed),
        p95Ms: percentile(durations.get(w.workflow) ?? [], 95) ?? null,
        cost: w.cost,
      }))
      .sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name)),
    failingSteps,
  };
}
