import { type Clock, type ErrorInfo, newId, OmniflowError, systemClock } from '../core/index.ts';
import type { Principal } from '../schemas/index.ts';
import { type Db, fromJson, toJson } from './database.ts';

/** Run state machine (architecture §9.2). */
export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting-approval'
  | 'waiting-event'
  | 'compensating'
  | 'succeeded'
  | 'failed'
  | 'rolled-back'
  | 'compensation-failed'
  | 'cancelled';

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'succeeded',
  'failed',
  'rolled-back',
  'compensation-failed',
  'cancelled',
];
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [
  'running',
  'waiting-approval',
  'waiting-event',
  'compensating',
];

export const isTerminalRun = (s: RunStatus): boolean => TERMINAL_RUN_STATUSES.includes(s);

const TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  queued: ['running', 'cancelled'],
  running: ['waiting-approval', 'waiting-event', 'compensating', 'succeeded', 'failed', 'cancelled'],
  'waiting-approval': ['running', 'failed', 'cancelled', 'compensating'],
  'waiting-event': ['running', 'failed', 'cancelled', 'compensating'],
  compensating: ['rolled-back', 'compensation-failed'],
  succeeded: [],
  failed: [],
  'rolled-back': [],
  'compensation-failed': [],
  cancelled: [],
};

export type StepStatus =
  | 'pending'
  | 'running'
  | 'retry-wait'
  | 'waiting-approval'
  | 'waiting-event'
  | 'waiting-timer'
  | 'waiting-child'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export const TERMINAL_STEP_STATUSES: readonly StepStatus[] = ['succeeded', 'failed', 'skipped', 'cancelled'];

export type CompensationStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface RunRecord {
  id: string;
  tenant: string;
  workflowName: string;
  workflowVersion: string;
  planHash: string;
  status: RunStatus;
  dryRun: boolean;
  environment: string;
  triggerType: string;
  triggerName?: string;
  triggerPayload?: unknown;
  correlationId?: string;
  parentRunId?: string;
  parentStepId?: string;
  inputs: Record<string, unknown>;
  seed: string;
  contextNow: string;
  priority: number;
  dedupKey?: string;
  requestedBy: Principal;
  canary: boolean;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: ErrorInfo;
  outputs?: Record<string, unknown>;
  cost: number;
  cancelRequested: boolean;
}

export interface StepRecord {
  runId: string;
  stepId: string;
  status: StepStatus;
  attempt: number;
  startedAt?: string;
  finishedAt?: string;
  wakeAt?: string;
  output?: unknown;
  outputRef?: string;
  error?: ErrorInfo;
  skippedReason?: string;
  /** Set when a failure was absorbed by `onError: continue` or `routeTo`. */
  handled?: 'continue' | 'route';
  idempotencyKey?: string;
  childRunId?: string;
  approvalId?: string;
  waitEvent?: string;
  waitCorrelation?: string;
  compensationStatus?: CompensationStatus;
  compensationError?: ErrorInfo;
  /** Order in which steps succeeded — compensation runs in reverse of it. */
  completedSeq?: number;
  cost: number;
  updatedAt: string;
}

export interface NewRun {
  tenant: string;
  workflowName: string;
  workflowVersion: string;
  planHash: string;
  stepIds: string[];
  dryRun: boolean;
  environment: string;
  triggerType: string;
  triggerName?: string;
  triggerPayload?: unknown;
  correlationId?: string;
  parentRunId?: string;
  parentStepId?: string;
  inputs: Record<string, unknown>;
  seed?: string;
  contextNow?: string;
  priority?: number;
  dedupKey?: string;
  requestedBy: Principal;
  canary?: boolean;
}

export type RunPatch = Partial<
  Pick<RunRecord, 'error' | 'outputs' | 'cost' | 'cancelRequested' | 'startedAt' | 'finishedAt'>
>;

export type StepPatch = Partial<
  Omit<StepRecord, 'runId' | 'stepId' | 'updatedAt'> & {
    output: unknown | null;
    error: ErrorInfo | null;
  }
>;

interface RunRow {
  id: string;
  tenant_id: string;
  workflow_name: string;
  workflow_version: string;
  plan_hash: string;
  status: RunStatus;
  dry_run: number;
  environment: string;
  trigger_type: string;
  trigger_name: string | null;
  trigger_payload: string | null;
  correlation_id: string | null;
  parent_run_id: string | null;
  parent_step_id: string | null;
  inputs: string;
  seed: string;
  context_now: string;
  priority: number;
  dedup_key: string | null;
  requested_by: string;
  canary: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  outputs: string | null;
  cost: number;
  cancel_requested: number;
}

interface StepRow {
  run_id: string;
  step_id: string;
  status: StepStatus;
  attempt: number;
  started_at: string | null;
  finished_at: string | null;
  wake_at: string | null;
  output: string | null;
  output_ref: string | null;
  error: string | null;
  skipped_reason: string | null;
  handled: string | null;
  idempotency_key: string | null;
  child_run_id: string | null;
  approval_id: string | null;
  wait_event: string | null;
  wait_correlation: string | null;
  compensation_status: CompensationStatus | null;
  compensation_error: string | null;
  completed_seq: number | null;
  cost: number;
  updated_at: string;
}

const opt = <K extends string, V>(key: K, v: V | null | undefined): { [P in K]?: V } =>
  (v === null || v === undefined ? {} : { [key]: v }) as { [P in K]?: V };

function toRun(r: RunRow): RunRecord {
  return {
    id: r.id,
    tenant: r.tenant_id,
    workflowName: r.workflow_name,
    workflowVersion: r.workflow_version,
    planHash: r.plan_hash,
    status: r.status,
    dryRun: r.dry_run === 1,
    environment: r.environment,
    triggerType: r.trigger_type,
    ...opt('triggerName', r.trigger_name),
    ...opt('triggerPayload', fromJson(r.trigger_payload)),
    ...opt('correlationId', r.correlation_id),
    ...opt('parentRunId', r.parent_run_id),
    ...opt('parentStepId', r.parent_step_id),
    inputs: fromJson<Record<string, unknown>>(r.inputs) ?? {},
    seed: r.seed,
    contextNow: r.context_now,
    priority: r.priority,
    ...opt('dedupKey', r.dedup_key),
    requestedBy: fromJson<Principal>(r.requested_by)!,
    canary: r.canary === 1,
    createdAt: r.created_at,
    ...opt('startedAt', r.started_at),
    ...opt('finishedAt', r.finished_at),
    ...opt('error', fromJson<ErrorInfo>(r.error)),
    ...opt('outputs', fromJson<Record<string, unknown>>(r.outputs)),
    cost: r.cost,
    cancelRequested: r.cancel_requested === 1,
  };
}

function toStep(r: StepRow): StepRecord {
  return {
    runId: r.run_id,
    stepId: r.step_id,
    status: r.status,
    attempt: r.attempt,
    ...opt('startedAt', r.started_at),
    ...opt('finishedAt', r.finished_at),
    ...opt('wakeAt', r.wake_at),
    ...(r.output !== null ? { output: fromJson(r.output) } : {}),
    ...opt('outputRef', r.output_ref),
    ...opt('error', fromJson<ErrorInfo>(r.error)),
    ...opt('skippedReason', r.skipped_reason),
    ...opt('handled', r.handled as 'continue' | 'route' | null),
    ...opt('idempotencyKey', r.idempotency_key),
    ...opt('childRunId', r.child_run_id),
    ...opt('approvalId', r.approval_id),
    ...opt('waitEvent', r.wait_event),
    ...opt('waitCorrelation', r.wait_correlation),
    ...opt('compensationStatus', r.compensation_status),
    ...opt('compensationError', fromJson<ErrorInfo>(r.compensation_error)),
    ...opt('completedSeq', r.completed_seq),
    cost: r.cost,
    updatedAt: r.updated_at,
  };
}

export interface RunFilter {
  tenant?: string;
  workflow?: string;
  status?: readonly RunStatus[];
  triggerType?: string;
  parentRunId?: string;
  since?: string;
  before?: string;
  limit?: number;
  offset?: number;
}

/** Durable current state of every run and step (architecture §5.1 #15). */
export class RunStore {
  private readonly db: Db;
  private readonly clock: Clock;

  constructor(db: Db, clock: Clock = systemClock) {
    this.db = db;
    this.clock = clock;
  }

  private now(): string {
    return this.clock.now().toISOString();
  }

  createRun(n: NewRun): RunRecord {
    const id = newId('run');
    const now = this.now();
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO runs (id, tenant_id, workflow_name, workflow_version, plan_hash, status, dry_run, environment,
           trigger_type, trigger_name, trigger_payload, correlation_id, parent_run_id, parent_step_id, inputs, seed,
           context_now, priority, dedup_key, requested_by, canary, created_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          n.tenant,
          n.workflowName,
          n.workflowVersion,
          n.planHash,
          n.dryRun ? 1 : 0,
          n.environment,
          n.triggerType,
          n.triggerName ?? null,
          toJson(n.triggerPayload),
          n.correlationId ?? null,
          n.parentRunId ?? null,
          n.parentStepId ?? null,
          JSON.stringify(n.inputs),
          n.seed ?? id,
          n.contextNow ?? now,
          n.priority ?? 5,
          n.dedupKey ?? null,
          JSON.stringify(n.requestedBy),
          n.canary ? 1 : 0,
          now,
        ],
      );
      for (const stepId of n.stepIds) {
        this.db.run(`INSERT INTO step_states (run_id, step_id, status, updated_at) VALUES (?, ?, 'pending', ?)`, [
          id,
          stepId,
          now,
        ]);
      }
    });
    return this.getRun(id)!;
  }

  getRun(id: string, tenant?: string): RunRecord | undefined {
    const r = tenant
      ? this.db.get<RunRow>('SELECT * FROM runs WHERE id = ? AND tenant_id = ?', [id, tenant])
      : this.db.get<RunRow>('SELECT * FROM runs WHERE id = ?', [id]);
    return r ? toRun(r) : undefined;
  }

  listRuns(f: RunFilter = {}): RunRecord[] {
    const { where, params } = this.filter(f);
    const limit = Math.min(Math.max(f.limit ?? 50, 1), 500);
    const offset = Math.max(f.offset ?? 0, 0);
    return this.db
      .all<RunRow>(
        `SELECT * FROM runs ${where} ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`,
        params,
      )
      .map(toRun);
  }

  countRuns(f: RunFilter = {}): number {
    const { where, params } = this.filter(f);
    return this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM runs ${where}`, params)?.n ?? 0;
  }

  private filter(f: RunFilter): { where: string; params: Array<string | number> } {
    const w: string[] = [];
    const params: Array<string | number> = [];
    if (f.tenant) w.push('tenant_id = ?'), params.push(f.tenant);
    if (f.workflow) w.push('workflow_name = ?'), params.push(f.workflow);
    if (f.status?.length) w.push(`status IN (${f.status.map(() => '?').join(',')})`), params.push(...f.status);
    if (f.triggerType) w.push('trigger_type = ?'), params.push(f.triggerType);
    if (f.parentRunId) w.push('parent_run_id = ?'), params.push(f.parentRunId);
    if (f.since) w.push('created_at >= ?'), params.push(f.since);
    if (f.before) w.push('created_at < ?'), params.push(f.before);
    return { where: w.length ? `WHERE ${w.join(' AND ')}` : '', params };
  }

  /**
   * Move a run along the state machine. Illegal transitions throw — the state machine of
   * architecture §9.2 is enforced here rather than trusted to callers.
   */
  transition(runId: string, to: RunStatus, patch: RunPatch = {}): RunRecord {
    return this.db.transaction(() => {
      const run = this.getRun(runId);
      if (!run) throw new OmniflowError('RUN_NOT_FOUND', `Run '${runId}' not found`, { errorClass: 'business' });
      if (run.status !== to && !TRANSITIONS[run.status].includes(to)) {
        throw new OmniflowError('ILLEGAL_RUN_TRANSITION', `Run ${runId} cannot move from '${run.status}' to '${to}'`, {
          errorClass: 'catastrophic',
          retryable: false,
        });
      }
      const now = this.now();
      const startedAt = patch.startedAt ?? (to === 'running' && !run.startedAt ? now : undefined);
      const finishedAt = patch.finishedAt ?? (isTerminalRun(to) ? now : undefined);
      this.db.run(
        `UPDATE runs SET status = ?,
           started_at = COALESCE(?, started_at),
           finished_at = COALESCE(?, finished_at),
           error = COALESCE(?, error),
           outputs = COALESCE(?, outputs),
           cost = COALESCE(?, cost),
           cancel_requested = COALESCE(?, cancel_requested)
         WHERE id = ?`,
        [
          to,
          startedAt ?? null,
          finishedAt ?? null,
          toJson(patch.error),
          toJson(patch.outputs),
          patch.cost ?? null,
          patch.cancelRequested === undefined ? null : patch.cancelRequested ? 1 : 0,
          runId,
        ],
      );
      return this.getRun(runId)!;
    });
  }

  patchRun(runId: string, patch: RunPatch): void {
    this.db.run(
      `UPDATE runs SET error = COALESCE(?, error), outputs = COALESCE(?, outputs), cost = COALESCE(?, cost),
         cancel_requested = COALESCE(?, cancel_requested) WHERE id = ?`,
      [
        toJson(patch.error),
        toJson(patch.outputs),
        patch.cost ?? null,
        patch.cancelRequested === undefined ? null : patch.cancelRequested ? 1 : 0,
        runId,
      ],
    );
  }

  addRunCost(runId: string, tenant: string, workflow: string, amount: number): void {
    if (amount <= 0) return;
    const day = this.now().slice(0, 10);
    this.db.transaction(() => {
      this.db.run('UPDATE runs SET cost = cost + ? WHERE id = ?', [amount, runId]);
      this.db.run(
        `INSERT INTO cost_ledger (tenant_id, workflow_name, day, cost) VALUES (?, ?, ?, ?)
         ON CONFLICT (tenant_id, workflow_name, day) DO UPDATE SET cost = cost + excluded.cost`,
        [tenant, workflow, day, amount],
      );
    });
  }

  dailyCost(tenant: string, workflow: string, day: string = this.now().slice(0, 10)): number {
    return (
      this.db.get<{ cost: number }>(
        'SELECT cost FROM cost_ledger WHERE tenant_id = ? AND workflow_name = ? AND day = ?',
        [tenant, workflow, day],
      )?.cost ?? 0
    );
  }

  // ----------------------------------------------------------------- steps
  getSteps(runId: string): StepRecord[] {
    return this.db.all<StepRow>('SELECT * FROM step_states WHERE run_id = ?', [runId]).map(toStep);
  }

  getStep(runId: string, stepId: string): StepRecord | undefined {
    const r = this.db.get<StepRow>('SELECT * FROM step_states WHERE run_id = ? AND step_id = ?', [runId, stepId]);
    return r ? toStep(r) : undefined;
  }

  /** Update selected columns of one step. `null` clears a nullable column; `undefined` leaves it alone. */
  patchStep(runId: string, stepId: string, patch: StepPatch): StepRecord {
    const sets: string[] = ['updated_at = ?'];
    const params: Array<string | number | null> = [this.now()];
    const set = (col: string, v: unknown, json = false) => {
      if (v === undefined) return;
      sets.push(`${col} = ?`);
      params.push(v === null ? null : json ? JSON.stringify(v) : (v as string | number));
    };
    set('status', patch.status);
    set('attempt', patch.attempt);
    set('started_at', patch.startedAt);
    set('finished_at', patch.finishedAt);
    set('wake_at', patch.wakeAt);
    set('output', patch.output, true);
    set('output_ref', patch.outputRef);
    set('error', patch.error, true);
    set('skipped_reason', patch.skippedReason);
    set('handled', patch.handled);
    set('idempotency_key', patch.idempotencyKey);
    set('child_run_id', patch.childRunId);
    set('approval_id', patch.approvalId);
    set('wait_event', patch.waitEvent);
    set('wait_correlation', patch.waitCorrelation);
    set('compensation_status', patch.compensationStatus);
    set('compensation_error', patch.compensationError, true);
    set('completed_seq', patch.completedSeq);
    set('cost', patch.cost);
    params.push(runId, stepId);
    const res = this.db.run(`UPDATE step_states SET ${sets.join(', ')} WHERE run_id = ? AND step_id = ?`, params);
    if (res.changes === 0) {
      throw new OmniflowError('STEP_NOT_FOUND', `Step '${stepId}' of run '${runId}' not found`, {
        errorClass: 'catastrophic',
      });
    }
    return this.getStep(runId, stepId)!;
  }

  nextCompletionSeq(runId: string): number {
    return (
      (this.db.get<{ m: number | null }>('SELECT MAX(completed_seq) AS m FROM step_states WHERE run_id = ?', [runId])
        ?.m ?? 0) + 1
    );
  }

  /** Steps whose timer (retry back-off, sleep, event/approval timeout) has elapsed. */
  dueSteps(nowIso: string, limit = 200): Array<StepRecord & { tenant: string }> {
    return this.db
      .all<StepRow & { tenant_id: string }>(
        `SELECT s.*, r.tenant_id FROM step_states s JOIN runs r ON r.id = s.run_id
         WHERE s.status IN ('retry-wait', 'waiting-timer', 'waiting-event') AND s.wake_at IS NOT NULL AND s.wake_at <= ?
           AND r.status IN ('running', 'waiting-event', 'waiting-approval')
         ORDER BY s.wake_at ASC LIMIT ${limit}`,
        [nowIso],
      )
      .map((r) => ({ ...toStep(r), tenant: r.tenant_id }));
  }

  findWaitingEventSteps(tenant: string, event: string, correlation: string | null): StepRecord[] {
    return this.db
      .all<StepRow>(
        `SELECT s.* FROM step_states s JOIN runs r ON r.id = s.run_id
         WHERE r.tenant_id = ? AND s.status = 'waiting-event' AND s.wait_event = ?
           AND (s.wait_correlation IS NULL OR s.wait_correlation = ?)`,
        [tenant, event, correlation],
      )
      .map(toStep);
  }

  // ------------------------------------------------------- scheduling views
  runsByStatus(statuses: readonly RunStatus[], limit = 1000): RunRecord[] {
    return this.db
      .all<RunRow>(
        `SELECT * FROM runs WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY priority ASC, created_at ASC LIMIT ${limit}`,
        [...statuses],
      )
      .map(toRun);
  }

  activeCount(tenant: string, workflow?: string): number {
    const statuses = ACTIVE_RUN_STATUSES.map(() => '?').join(',');
    return (
      (workflow
        ? this.db.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM runs WHERE tenant_id = ? AND workflow_name = ? AND status IN (${statuses})`,
            [tenant, workflow, ...ACTIVE_RUN_STATUSES],
          )
        : this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM runs WHERE tenant_id = ? AND status IN (${statuses})`, [
            tenant,
            ...ACTIVE_RUN_STATUSES,
          ])
      )?.n ?? 0
    );
  }

  /** The most recent run of a workflow with the given dedup key created at or after `sinceIso`. */
  findByDedupKey(tenant: string, workflow: string, key: string, sinceIso: string): RunRecord | undefined {
    const r = this.db.get<RunRow>(
      `SELECT * FROM runs WHERE tenant_id = ? AND workflow_name = ? AND dedup_key = ? AND created_at >= ?
         AND status NOT IN ('cancelled') ORDER BY created_at DESC LIMIT 1`,
      [tenant, workflow, key, sinceIso],
    );
    return r ? toRun(r) : undefined;
  }

  childrenOf(runId: string): RunRecord[] {
    return this.db.all<RunRow>('SELECT * FROM runs WHERE parent_run_id = ?', [runId]).map(toRun);
  }

  /** Aggregate view used by dashboards and metrics. */
  countByStatus(tenant?: string): Record<string, number> {
    const rows = tenant
      ? this.db.all<{ status: string; n: number }>(
          'SELECT status, COUNT(*) AS n FROM runs WHERE tenant_id = ? GROUP BY status',
          [tenant],
        )
      : this.db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM runs GROUP BY status');
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }
}
