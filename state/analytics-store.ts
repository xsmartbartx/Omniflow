import { type Clock, systemClock } from '../core/index.ts';
import type { Db } from './database.ts';

/**
 * Read-only aggregate queries over run history — the read model behind the dashboard, the analysis
 * agent and alerting. Nothing here writes. Dry runs are excluded everywhere: they simulate effects
 * and would distort every rate and cost figure.
 */

export interface StepStat {
  workflow: string;
  stepId: string;
  /** Rows seen (a step that never started because the run stopped earlier is not counted). */
  seen: number;
  succeeded: number;
  failed: number;
  skipped: number;
  /** Failures the workflow absorbed with `onError: continue`. */
  ignored: number;
  /** Steps that needed more than one attempt. */
  retried: number;
  attempts: number;
  cost: number;
  compensated: number;
  compensationFailed: number;
}

export interface StepErrorStat {
  workflow: string;
  stepId: string;
  code: string;
  errorClass: string;
  count: number;
}

export interface WorkflowRunStat {
  workflow: string;
  total: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  cost: number;
}

export interface RunTiming {
  workflow: string;
  status: string;
  triggerType: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  scheduledFor: string | null;
}

export interface ApprovalStat {
  workflow: string;
  stepId: string;
  total: number;
  approved: number;
  denied: number;
  timedOut: number;
  pending: number;
  medianDecisionMs: number | null;
}

export interface HourBucket {
  hour: string;
  succeeded: number;
  failed: number;
  other: number;
}

const FAILED = new Set(['failed', 'rolled-back', 'compensation-failed']);
const NOT_DRY = 'r.dry_run = 0';

export class AnalyticsStore {
  private readonly db: Db;
  private readonly clock: Clock;

  constructor(db: Db, clock: Clock = systemClock) {
    this.db = db;
    this.clock = clock;
  }

  /** Run outcomes per workflow since `since` (ISO). */
  workflowRunStats(tenant: string, since: string): WorkflowRunStat[] {
    return this.db
      .all<{ workflow: string; total: number; succeeded: number; failed: number; cancelled: number; cost: number }>(
        `SELECT r.workflow_name AS workflow, COUNT(*) AS total,
                SUM(r.status = 'succeeded') AS succeeded,
                SUM(r.status IN ('failed','rolled-back','compensation-failed')) AS failed,
                SUM(r.status = 'cancelled') AS cancelled,
                COALESCE(SUM(r.cost), 0) AS cost
           FROM runs r WHERE r.tenant_id = ? AND r.created_at >= ? AND ${NOT_DRY}
          GROUP BY r.workflow_name ORDER BY r.workflow_name`,
        [tenant, since],
      )
      .map((r) => ({ ...r, succeeded: r.succeeded ?? 0, failed: r.failed ?? 0, cancelled: r.cancelled ?? 0 }));
  }

  /** Per-step behaviour across runs. */
  stepStats(tenant: string, since: string): StepStat[] {
    return this.db
      .all<{
        workflow: string;
        step_id: string;
        seen: number;
        succeeded: number;
        failed: number;
        skipped: number;
        ignored: number;
        retried: number;
        attempts: number;
        cost: number;
        compensated: number;
        comp_failed: number;
      }>(
        `SELECT r.workflow_name AS workflow, s.step_id AS step_id,
                SUM(s.status IN ('succeeded','failed','skipped')) AS seen,
                SUM(s.status = 'succeeded') AS succeeded,
                SUM(s.status = 'failed') AS failed,
                SUM(s.status = 'skipped') AS skipped,
                SUM(s.handled = 'continue') AS ignored,
                SUM(s.attempt > 1) AS retried,
                COALESCE(SUM(s.attempt), 0) AS attempts,
                COALESCE(SUM(s.cost), 0) AS cost,
                SUM(s.compensation_status = 'done') AS compensated,
                SUM(s.compensation_status = 'failed') AS comp_failed
           FROM step_states s JOIN runs r ON r.id = s.run_id
          WHERE r.tenant_id = ? AND r.created_at >= ? AND ${NOT_DRY}
          GROUP BY r.workflow_name, s.step_id ORDER BY r.workflow_name, s.step_id`,
        [tenant, since],
      )
      .map((r) => ({
        workflow: r.workflow,
        stepId: r.step_id,
        seen: r.seen ?? 0,
        succeeded: r.succeeded ?? 0,
        failed: r.failed ?? 0,
        skipped: r.skipped ?? 0,
        ignored: r.ignored ?? 0,
        retried: r.retried ?? 0,
        attempts: r.attempts,
        cost: r.cost,
        compensated: r.compensated ?? 0,
        compensationFailed: r.comp_failed ?? 0,
      }));
  }

  /** The error codes behind failed steps, most frequent first. */
  stepErrors(tenant: string, since: string): StepErrorStat[] {
    return this.db
      .all<{ workflow: string; step_id: string; code: string | null; cls: string | null; n: number }>(
        `SELECT r.workflow_name AS workflow, s.step_id AS step_id,
                json_extract(s.error, '$.code') AS code, json_extract(s.error, '$.class') AS cls, COUNT(*) AS n
           FROM step_states s JOIN runs r ON r.id = s.run_id
          WHERE r.tenant_id = ? AND r.created_at >= ? AND ${NOT_DRY} AND s.error IS NOT NULL
          GROUP BY r.workflow_name, s.step_id, code, cls ORDER BY n DESC`,
        [tenant, since],
      )
      .map((r) => ({
        workflow: r.workflow,
        stepId: r.step_id,
        code: r.code ?? 'UNKNOWN',
        errorClass: r.cls ?? 'unknown',
        count: r.n,
      }));
  }

  /** Timing facts for the most recent runs (bounded), for latency, queue wait and schedule drift. */
  runTimings(tenant: string, since: string, limit = 5000): RunTiming[] {
    return this.db
      .all<{
        workflow: string;
        status: string;
        trigger_type: string;
        created_at: string;
        started_at: string | null;
        finished_at: string | null;
        scheduled_for: string | null;
      }>(
        `SELECT r.workflow_name AS workflow, r.status, r.trigger_type, r.created_at, r.started_at, r.finished_at,
                CASE WHEN r.trigger_type = 'schedule' THEN json_extract(r.trigger_payload, '$.scheduledFor') END AS scheduled_for
           FROM runs r WHERE r.tenant_id = ? AND r.created_at >= ? AND ${NOT_DRY}
          ORDER BY r.created_at DESC LIMIT ?`,
        [tenant, since, limit],
      )
      .map((r) => ({
        workflow: r.workflow,
        status: r.status,
        triggerType: r.trigger_type,
        createdAt: r.created_at,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        scheduledFor: r.scheduled_for,
      }));
  }

  /** How approval gates behave. */
  approvalStats(tenant: string, since: string): ApprovalStat[] {
    const rows = this.db.all<{
      workflow: string | null;
      step_id: string;
      status: string;
      requested_at: string;
      decided_at: string | null;
    }>(
      `SELECT workflow_name AS workflow, step_id, status, requested_at, decided_at
         FROM approvals WHERE tenant_id = ? AND requested_at >= ?`,
      [tenant, since],
    );
    const groups = new Map<string, { workflow: string; stepId: string; rows: typeof rows }>();
    for (const r of rows) {
      const key = `${r.workflow ?? '?'}::${r.step_id}`;
      const g = groups.get(key) ?? { workflow: r.workflow ?? 'unknown', stepId: r.step_id, rows: [] };
      g.rows.push(r);
      groups.set(key, g);
    }
    return [...groups.values()]
      .map((g) => {
        const decided = g.rows
          .filter((r) => r.decided_at && (r.status === 'approved' || r.status === 'denied'))
          .map((r) => Date.parse(r.decided_at!) - Date.parse(r.requested_at))
          .sort((a, b) => a - b);
        return {
          workflow: g.workflow,
          stepId: g.stepId,
          total: g.rows.length,
          approved: g.rows.filter((r) => r.status === 'approved').length,
          denied: g.rows.filter((r) => r.status === 'denied').length,
          timedOut: g.rows.filter((r) => r.status === 'timed-out').length,
          pending: g.rows.filter((r) => r.status === 'pending').length,
          medianDecisionMs: decided.length ? decided[Math.floor(decided.length / 2)]! : null,
        };
      })
      .sort((a, b) => a.workflow.localeCompare(b.workflow) || a.stepId.localeCompare(b.stepId));
  }

  /** Runs per hour, newest last, with empty hours included so charts have a continuous axis. */
  runsByHour(tenant: string, hours: number): HourBucket[] {
    const now = this.clock.now();
    const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours());
    const start = end - (hours - 1) * 3_600_000;
    const rows = this.db.all<{ hour: string; status: string; n: number }>(
      `SELECT substr(r.created_at, 1, 13) AS hour, r.status, COUNT(*) AS n
         FROM runs r WHERE r.tenant_id = ? AND r.created_at >= ? AND ${NOT_DRY} GROUP BY hour, r.status`,
      [tenant, new Date(start).toISOString()],
    );
    const buckets = new Map<string, HourBucket>();
    for (let t = start; t <= end; t += 3_600_000) {
      const hour = new Date(t).toISOString().slice(0, 13);
      buckets.set(hour, { hour: `${hour}:00:00.000Z`, succeeded: 0, failed: 0, other: 0 });
    }
    for (const r of rows) {
      const b = buckets.get(r.hour);
      if (!b) continue;
      if (r.status === 'succeeded') b.succeeded += r.n;
      else if (FAILED.has(r.status)) b.failed += r.n;
      else b.other += r.n;
    }
    return [...buckets.values()];
  }

  /** Runs that needed a person (an approval was requested) versus all runs, since `since`. */
  interventionCounts(tenant: string, since: string): { runs: number; withApproval: number } {
    const runs =
      this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM runs r WHERE r.tenant_id = ? AND r.created_at >= ? AND ${NOT_DRY}`,
        [tenant, since],
      )?.n ?? 0;
    const withApproval =
      this.db.get<{ n: number }>(
        `SELECT COUNT(DISTINCT a.run_id) AS n FROM approvals a JOIN runs r ON r.id = a.run_id
          WHERE a.tenant_id = ? AND r.created_at >= ? AND ${NOT_DRY}`,
        [tenant, since],
      )?.n ?? 0;
    return { runs, withApproval };
  }

  /** Queued runs and the age of the oldest one. */
  queue(tenant: string): { depth: number; oldestCreatedAt: string | null } {
    const r = this.db.get<{ n: number; oldest: string | null }>(
      `SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM runs WHERE tenant_id = ? AND status = 'queued'`,
      [tenant],
    );
    return { depth: r?.n ?? 0, oldestCreatedAt: r?.oldest ?? null };
  }

  /** Recent failures per workflow inside a short window — for alerting. */
  recentOutcomes(tenant: string, since: string): Array<{ workflow: string; finished: number; failed: number }> {
    return this.db
      .all<{ workflow: string; finished: number; failed: number }>(
        `SELECT r.workflow_name AS workflow,
              SUM(r.status IN ('succeeded','failed','rolled-back','compensation-failed')) AS finished,
              SUM(r.status IN ('failed','rolled-back','compensation-failed')) AS failed
         FROM runs r WHERE r.tenant_id = ? AND r.finished_at >= ? AND ${NOT_DRY}
        GROUP BY r.workflow_name HAVING finished > 0`,
        [tenant, since],
      )
      .map((r) => ({ ...r, finished: r.finished ?? 0, failed: r.failed ?? 0 }));
  }

  /** Runs in `running` state whose newest step activity is older than `before`, excluding runs with a step still legitimately in flight or waiting. */
  stalledRuns(tenant: string, before: string): Array<{ id: string; workflow: string; lastActivity: string }> {
    return this.db
      .all<{ id: string; workflow: string; last: string }>(
        `SELECT r.id AS id, r.workflow_name AS workflow, MAX(COALESCE(s.updated_at, r.started_at, r.created_at)) AS last
         FROM runs r LEFT JOIN step_states s ON s.run_id = r.id
        WHERE r.tenant_id = ? AND r.status = 'running' AND ${NOT_DRY}
          AND NOT EXISTS (SELECT 1 FROM step_states w WHERE w.run_id = r.id
                           AND w.status IN ('running','retry-wait','waiting-approval','waiting-event','waiting-timer','waiting-child'))
        GROUP BY r.id HAVING last < ?`,
        [tenant, before],
      )
      .map((r) => ({ id: r.id, workflow: r.workflow, lastActivity: r.last }));
  }

  /** Approvals that have been pending since before `before`. */
  staleApprovals(
    tenant: string,
    before: string,
  ): Array<{ id: string; workflow: string | null; stepId: string; requestedAt: string }> {
    return this.db
      .all<{ id: string; workflow: string | null; step_id: string; requested_at: string }>(
        `SELECT id, workflow_name AS workflow, step_id, requested_at FROM approvals
        WHERE tenant_id = ? AND status = 'pending' AND requested_at < ? ORDER BY requested_at`,
        [tenant, before],
      )
      .map((r) => ({ id: r.id, workflow: r.workflow, stepId: r.step_id, requestedAt: r.requested_at }));
  }
}
