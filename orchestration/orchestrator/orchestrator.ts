import { EventEmitter } from 'node:events';
import {
  type Clock,
  ConflictError,
  createRng,
  type ErrorInfo,
  evaluate,
  isTruthy,
  type Logger,
  type Node,
  nullLogger,
  parseExpressionField,
  resolveValue,
  systemClock,
  toErrorInfo,
} from '../../core/index.ts';
import type { Plan, PlanStep } from '../../schemas/plan.ts';
import type { Principal } from '../../schemas/policy.ts';
import {
  type ApprovalRecord,
  isTerminalRun,
  type RunRecord,
  type RunStatus,
  type State,
  type StepRecord,
} from '../../state/index.ts';
import {
  allTerminal,
  backoffDelayMs,
  classifyPending,
  compensationQueue,
  hasCompensable,
  isTerminalStep,
  shouldRetry,
  unhandledFailures,
} from './decide.ts';
import {
  DEFAULT_ORCHESTRATOR_CONFIG,
  type OrchestratorConfig,
  type StepAttempt,
  type StepExecutor,
  type StepResult,
} from './ports.ts';

export interface CreateRunRequest {
  tenant: string;
  plan: Plan;
  planHash: string;
  /** Already validated against the plan's input schema (defaults applied). */
  inputs: Record<string, unknown>;
  principal: Principal;
  trigger: { type: string; name?: string; payload?: unknown };
  dryRun?: boolean;
  priority?: number;
  correlationId?: string;
  parent?: { runId: string; stepId: string };
  canary?: boolean;
  dedupKey?: string;
  seed?: string;
}

export interface OrchestratorDeps {
  state: State;
  executor: StepExecutor;
  config?: Partial<OrchestratorConfig>;
  clock?: Clock;
  log?: Logger;
}

export interface OrchestratorEventMap {
  'run-finished': [RunRecord];
  'approval-requested': [ApprovalRecord, RunRecord];
  'compensation-failed': [RunRecord];
}

interface Driver {
  active: boolean;
  dirty: boolean;
  inflight: Map<string, AbortController>;
}

const SYSTEM = { type: 'system', id: 'orchestrator', name: 'Orchestrator' } as const;

/**
 * The Orchestrator (architecture §5.1 #10) owns the run state machine: which steps are ready,
 * dispatching them, applying retry and compensation policy, and persisting a checkpoint after every
 * step. It never calls an external system — that is the Step Runtime's job, behind the
 * `StepExecutor` port. Everything it decides is recomputed from durable state, so a crash at any
 * point is recovered by simply re-driving the run.
 */
export class Orchestrator {
  private readonly st: State;
  private readonly exec: StepExecutor;
  private readonly cfg: OrchestratorConfig;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly emitter = new EventEmitter();
  private readonly drivers = new Map<string, Driver>();
  private readonly starved = new Set<string>();
  private readonly exprCache = new Map<string, Node>();
  private slots = 0;
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;
  private ticking = false;

  constructor(deps: OrchestratorDeps) {
    this.st = deps.state;
    this.exec = deps.executor;
    this.cfg = { ...DEFAULT_ORCHESTRATOR_CONFIG, ...deps.config };
    this.clock = deps.clock ?? systemClock;
    this.log = deps.log ?? nullLogger;
    this.emitter.setMaxListeners(50);
  }

  on<K extends keyof OrchestratorEventMap>(event: K, listener: (...args: OrchestratorEventMap[K]) => void): () => void {
    this.emitter.on(event, listener as (...a: unknown[]) => void);
    return () => this.emitter.off(event, listener as (...a: unknown[]) => void);
  }

  // ================================================================ lifecycle
  /** Recover interrupted runs, then start the timer loop. */
  start(): { recovered: number } {
    this.stopped = false;
    const recovered = this.recover();
    this.timer = setInterval(() => this.tick(), this.cfg.tickMs);
    this.timer.unref?.();
    return { recovered };
  }

  /** Stop ticking and abort every in-flight step. Runs are left durable and resume on the next start. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const d of this.drivers.values()) for (const ac of d.inflight.values()) ac.abort();
    const deadline = Date.now() + 5000;
    while (this.slots > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  }

  get inflightSteps(): number {
    return this.slots;
  }

  /**
   * Crash recovery (architecture §12.1): a step that was running when the process died is
   * re-dispatched with the *same* attempt number and idempotency key. Effectful steps that had
   * already succeeded externally replay their recorded result instead of repeating the effect.
   */
  recover(): number {
    this.st.secrets.revokeOutstanding();
    let n = 0;
    for (const run of this.st.runs.runsByStatus(['running', 'waiting-approval', 'waiting-event', 'compensating'], 10_000)) {
      n++;
      this.recoverRun(run);
      this.kick(run.id);
    }
    return n;
  }

  private recoverRun(run: RunRecord): void {
    const now = this.clock.now().toISOString();
    let touched = 0;
    for (const s of this.st.runs.getSteps(run.id)) {
      if (s.status === 'running') {
        this.st.runs.patchStep(run.id, s.stepId, { status: 'retry-wait', attempt: Math.max(0, s.attempt - 1), wakeAt: now });
        this.event(run, 'step.recovered', { attempt: s.attempt }, s.stepId);
        touched++;
      }
      if (s.compensationStatus === 'running') {
        this.st.runs.patchStep(run.id, s.stepId, { compensationStatus: 'pending' });
        touched++;
      }
    }
    if (touched > 0) this.event(run, 'run.recovered', { steps: touched });
  }

  // =================================================================== runs
  createRun(req: CreateRunRequest): RunRecord {
    const plan = req.plan;
    const run = this.st.runs.createRun({
      tenant: req.tenant,
      workflowName: plan.workflow.name,
      workflowVersion: plan.workflow.version,
      planHash: req.planHash,
      stepIds: plan.steps.map((s) => s.id),
      dryRun: req.dryRun ?? false,
      environment: plan.environment,
      triggerType: req.trigger.type,
      ...(req.trigger.name ? { triggerName: req.trigger.name } : {}),
      ...(req.trigger.payload !== undefined ? { triggerPayload: req.trigger.payload } : {}),
      ...(req.correlationId ? { correlationId: req.correlationId } : {}),
      ...(req.parent ? { parentRunId: req.parent.runId, parentStepId: req.parent.stepId } : {}),
      inputs: req.inputs,
      ...(req.seed ? { seed: req.seed } : {}),
      ...(req.priority !== undefined ? { priority: req.priority } : {}),
      ...(req.dedupKey ? { dedupKey: req.dedupKey } : {}),
      requestedBy: req.principal,
      canary: req.canary ?? false,
    });
    this.event(run, 'run.queued', {
      workflow: plan.workflow.name,
      version: plan.workflow.version,
      planHash: req.planHash,
      trigger: req.trigger.type,
      triggerName: req.trigger.name ?? null,
      dryRun: run.dryRun,
      canary: run.canary,
      inputs: this.maskInputs(plan, req.inputs),
    });
    return run;
  }

  /** Admit a queued run: `queued → running`, evaluate pre-run guards, begin dispatching. */
  startRun(runId: string): RunRecord | undefined {
    const run = this.st.runs.getRun(runId);
    if (!run || run.status !== 'queued') return run;
    const running = this.st.runs.transition(runId, 'running');
    this.event(running, 'run.started', { attempt: 1 });
    const plan = this.plan(running);
    const scope = { inputs: running.inputs, context: this.contextOf(running, plan), run: this.runScope(running) };
    for (const g of plan.guards.pre) {
      let ok = false;
      try {
        ok = isTruthy(evaluate(this.parse(g.expr), scope, { seed: running.seed }));
      } catch {
        ok = false;
      }
      if (!ok) {
        this.event(running, 'run.guard-failed', { guard: g.name, message: g.message ?? `Guard '${g.name}' failed` });
        this.finishRun(running, 'failed', { error: { code: 'GUARD_FAILED', message: g.message ?? `Pre-run guard '${g.name}' failed`, class: 'business', retryable: false } });
        return this.st.runs.getRun(runId);
      }
    }
    this.kick(runId);
    return running;
  }

  /** Operator cancellation (`Running → Cancelled`). A run that is already compensating finishes compensating. */
  cancelRun(runId: string, actor: { id: string; name?: string }, reason = 'cancelled by operator'): RunRecord {
    const run = this.st.runs.getRun(runId);
    if (!run) throw new ConflictError(`Run '${runId}' not found`);
    if (isTerminalRun(run.status)) return run;
    const error: ErrorInfo = { code: 'CANCELLED', message: `Cancelled by ${actor.name ?? actor.id}: ${reason}`, class: 'business', retryable: false };
    if (run.status === 'queued') return this.finishRun(run, 'cancelled', { error });
    if (run.status === 'compensating') throw new ConflictError('Run is being rolled back and cannot be cancelled until compensation finishes');
    this.st.runs.patchRun(runId, { cancelRequested: true, error });
    this.drivers.get(runId)?.inflight.forEach((ac) => ac.abort());
    this.kick(runId);
    return this.st.runs.getRun(runId)!;
  }

  /** Deliver an external event to steps waiting on it. Returns the number of steps resumed. */
  deliverEvent(tenant: string, event: string, correlation: string | null, payload: unknown): number {
    const steps = this.st.runs.findWaitingEventSteps(tenant, event, correlation);
    let n = 0;
    for (const s of steps) {
      const run = this.st.runs.getRun(s.runId);
      if (!run || isTerminalRun(run.status)) continue;
      const ps = this.plan(run).steps.find((x) => x.id === s.stepId);
      if (!ps) continue;
      this.succeedStep(run, ps, { event, payload: payload ?? null }, { cost: 0, durationMs: 0 });
      this.kick(run.id);
      n++;
    }
    return n;
  }

  /** Apply a recorded approval decision to its waiting step. The Approval Service decides; the Orchestrator resumes. */
  resolveApproval(approvalId: string): void {
    const a = this.st.approvals.get(approvalId);
    if (!a || a.status === 'pending') return;
    const run = this.st.runs.getRun(a.runId);
    const step = run ? this.st.runs.getStep(a.runId, a.stepId) : undefined;
    if (!run || !step || step.status !== 'waiting-approval' || isTerminalRun(run.status)) return;
    const ps = this.plan(run).steps.find((x) => x.id === a.stepId);
    if (!ps) return;
    if (a.status === 'approved') {
      this.succeedStep(run, ps, {
        decision: 'approved',
        by: a.decidedBy ?? 'unknown',
        ...(a.comment ? { comment: a.comment } : {}),
        decidedAt: a.decidedAt ?? this.clock.now().toISOString(),
        ...(a.decidedBy === 'system:timeout' ? { timedOut: true } : {}),
      }, { cost: 0, durationMs: 0 });
    } else {
      const timedOut = a.status === 'timed-out';
      this.failStep(run, ps, {
        code: timedOut ? 'APPROVAL_TIMEOUT' : 'APPROVAL_DENIED',
        message: timedOut ? 'The approval request timed out and was denied' : `Approval denied by ${a.decidedBy ?? 'an approver'}${a.comment ? `: ${a.comment}` : ''}`,
        class: 'business',
        retryable: false,
      }, 'approval');
    }
    this.kick(run.id);
  }

  /** Resolve once the run reaches a terminal state (or `timeoutMs` elapses). Mostly for tests and the CLI. */
  waitForRun(runId: string, timeoutMs = 15_000, until: (r: RunRecord) => boolean = (r) => isTerminalRun(r.status)): Promise<RunRecord> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const r = this.st.runs.getRun(runId);
        if (r && until(r)) return finish(r);
        return undefined;
      };
      const off = this.st.events.onAppend((e) => {
        if (e.runId === runId) check();
      });
      const poll = setInterval(check, 50);
      const to = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for run ${runId} (status: ${this.st.runs.getRun(runId)?.status})`));
      }, timeoutMs);
      const cleanup = () => {
        off();
        clearInterval(poll);
        clearTimeout(to);
      };
      const finish = (r: RunRecord) => {
        cleanup();
        resolve(r);
      };
      check();
    });
  }

  // ============================================================ driver loop
  kick(runId: string): void {
    if (this.stopped && !this.drivers.has(runId)) {
      // Allow driving while stopped only for runs already known (tests construct without start()).
    }
    let d = this.drivers.get(runId);
    if (!d) {
      d = { active: false, dirty: false, inflight: new Map() };
      this.drivers.set(runId, d);
    }
    d.dirty = true;
    if (d.active) return;
    d.active = true;
    setImmediate(() => this.loop(runId, d));
  }

  private loop(runId: string, d: Driver): void {
    try {
      let guard = 0;
      while (d.dirty && guard++ < 1000) {
        d.dirty = false;
        this.advance(runId, d);
      }
    } catch (e) {
      this.log.error('run advance failed', { runId, error: e });
      this.failInternally(runId, e);
    } finally {
      d.active = false;
      if (d.dirty) this.kick(runId);
      else if (d.inflight.size === 0) {
        const run = this.st.runs.getRun(runId);
        if (!run || isTerminalRun(run.status)) this.drivers.delete(runId);
      }
    }
  }

  private failInternally(runId: string, e: unknown): void {
    try {
      const run = this.st.runs.getRun(runId);
      if (run && !isTerminalRun(run.status) && run.status !== 'queued' && run.status !== 'compensating') {
        this.finishRun(run, 'failed', { error: { ...toErrorInfo(e), code: 'ORCHESTRATOR_ERROR', class: 'catastrophic', retryable: false } });
      }
    } catch (inner) {
      this.log.error('could not fail run after internal error', { runId, error: inner });
    }
  }

  private advance(runId: string, d: Driver): void {
    const run = this.st.runs.getRun(runId);
    if (!run || run.status === 'queued' || isTerminalRun(run.status)) return;
    const plan = this.plan(run);
    let recs = this.records(runId);

    if (run.cancelRequested) return this.advanceCancel(run, plan, recs, d);
    if (run.status === 'compensating') return this.advanceCompensation(run, plan, recs, d);

    // Steps recorded as running that this process is not executing (defence in depth after a crash).
    for (const s of recs.values()) {
      if (s.status === 'running' && !d.inflight.has(s.stepId)) {
        this.st.runs.patchStep(runId, s.stepId, { status: 'retry-wait', attempt: Math.max(0, s.attempt - 1), wakeAt: this.clock.now().toISOString() });
        this.event(run, 'step.recovered', { attempt: s.attempt }, s.stepId);
      }
    }
    recs = this.records(runId);

    const failing = () => unhandledFailures(recs).length > 0 || this.st.runs.getRun(runId)!.error !== undefined;

    if (!failing()) {
      let progress = true;
      for (let pass = 0; progress && pass < plan.steps.length + 5; pass++) {
        progress = false;
        const { runnable, skips } = classifyPending(plan, recs);
        for (const sk of skips) {
          this.skipStep(run, sk.step, sk.reason);
          progress = true;
        }
        for (const ps of runnable) {
          if (recs.get(ps.id)?.status !== 'pending') continue;
          if (failing()) break;
          if (ps.when && !this.evalWhen(run, plan, recs, ps)) {
            if (this.st.runs.getStep(runId, ps.id)?.status === 'pending') this.skipStep(run, ps, 'condition-false');
            progress = true;
            recs = this.records(runId);
            continue;
          }
          if (this.dispatch(run, plan, recs, ps, d)) progress = true;
          recs = this.records(runId);
        }
        recs = this.records(runId);
      }
      // due retries (back-off elapsed)
      const nowMs = this.clock.now().getTime();
      for (const s of recs.values()) {
        if (s.status === 'retry-wait' && s.wakeAt && Date.parse(s.wakeAt) <= nowMs && !failing()) {
          const ps = plan.steps.find((x) => x.id === s.stepId)!;
          this.launch(run, plan, recs, ps, d);
          recs = this.records(runId);
        }
      }
    }

    recs = this.records(runId);
    if (failing()) {
      this.quiesce(run, plan, recs, 'run-failed');
      recs = this.records(runId);
      if (![...recs.values()].some((s) => s.status === 'running') && d.inflight.size === 0) this.finalizeFailure(run, plan, recs);
      return;
    }
    if (allTerminal(recs)) return this.finalizeSuccess(run, plan, recs);
    this.syncVisibility(run, recs);
  }

  // ================================================================ dispatch
  /** Returns true when the step completed inline (so downstream steps may now be ready). */
  private dispatch(run: RunRecord, plan: Plan, recs: Map<string, StepRecord>, ps: PlanStep, d: Driver): boolean {
    switch (ps.type) {
      case 'capability':
      case 'map':
        this.launch(run, plan, recs, ps, d);
        return false;
      case 'branch': {
        const scope = this.scope(run, plan, recs);
        let chosen: string | undefined;
        try {
          for (const c of ps.cases ?? []) {
            if (isTruthy(evaluate(this.parse(c.when), scope, { seed: run.seed }))) {
              chosen = c.name;
              break;
            }
          }
        } catch (e) {
          this.startInline(run, ps);
          this.failStep(run, ps, { code: 'BRANCH_EVALUATION_FAILED', message: (e as Error).message, class: 'contract', retryable: false }, 'branch');
          return true;
        }
        this.startInline(run, ps);
        if (chosen === undefined && ps.default === undefined) {
          this.failStep(run, ps, { code: 'BRANCH_NO_MATCH', message: 'No branch case matched and there is no default', class: 'contract', retryable: false }, 'branch');
        } else {
          this.succeedStep(run, ps, { case: chosen ?? ps.default }, { cost: 0, durationMs: 0 });
        }
        return true;
      }
      case 'parallel': {
        this.startInline(run, ps);
        const results: Record<string, unknown> = {};
        let anyOk = false;
        for (const dep of ps.dependsOn) {
          const r = recs.get(dep);
          if (r?.status === 'succeeded') {
            anyOk = true;
            results[dep] = this.loadOutput(run.tenant, r) ?? null;
          } else if (r && !isTerminalStep(r.status)) {
            // join:any — the remaining branches are no longer needed
            d.inflight.get(dep)?.abort();
            this.st.runs.patchStep(run.id, dep, { status: 'cancelled', finishedAt: this.clock.now().toISOString() });
            this.event(run, 'step.skipped', { reason: 'join-satisfied' }, dep);
          }
        }
        if (ps.join === 'any' && !anyOk) {
          this.failStep(run, ps, { code: 'PARALLEL_ALL_FAILED', message: 'Every parallel branch failed', class: 'business', retryable: false }, 'parallel');
        } else {
          this.succeedStep(run, ps, { results }, { cost: 0, durationMs: 0 });
        }
        return true;
      }
      case 'approval':
        this.requestApproval(run, plan, recs, ps);
        return false;
      case 'wait': {
        const now = this.clock.now();
        this.st.runs.patchStep(run.id, ps.id, {
          startedAt: now.toISOString(),
          attempt: 1,
          ...(ps.until
            ? (() => {
                let corr: string | undefined;
                if (ps.until.correlation) {
                  try {
                    corr = String(resolveValue(ps.until.correlation, this.scope(run, plan, recs), { seed: run.seed }));
                  } catch {
                    corr = undefined;
                  }
                }
                return { status: 'waiting-event' as const, waitEvent: ps.until.event, waitCorrelation: corr ?? null, wakeAt: new Date(now.getTime() + ps.timeoutMs).toISOString() };
              })()
            : { status: 'waiting-timer' as const, wakeAt: new Date(now.getTime() + (ps.durationMs ?? 0)).toISOString() }),
        });
        this.event(run, 'step.waiting', { on: ps.until ? `event:${ps.until.event}` : 'timer' }, ps.id);
        return false;
      }
      case 'subworkflow':
        this.startChild(run, plan, recs, ps);
        return false;
      case 'terminate': {
        this.startInline(run, ps);
        if (ps.status === 'success') {
          this.succeedStep(run, ps, { terminated: true }, { cost: 0, durationMs: 0 });
          for (const s of this.records(run.id).values()) {
            if (s.status === 'pending') this.skipStep(run, plan.steps.find((x) => x.id === s.stepId)!, 'run-terminated');
          }
        } else {
          this.failStep(run, ps, {
            code: 'TERMINATED',
            message: ps.message ? String(this.safeResolve(ps.message, this.scope(run, plan, recs), run.seed)) : 'The workflow terminated with a failure',
            class: ps.errorClass ?? 'business',
            retryable: false,
          }, 'terminate');
        }
        return true;
      }
    }
  }

  private startInline(run: RunRecord, ps: PlanStep): void {
    const now = this.clock.now().toISOString();
    this.st.runs.patchStep(run.id, ps.id, { status: 'running', attempt: 1, startedAt: now });
    this.event(run, 'step.started', { attempt: 1, type: ps.type }, ps.id, 1);
  }

  private launch(run: RunRecord, plan: Plan, recs: Map<string, StepRecord>, ps: PlanStep, d: Driver): void {
    if (d.inflight.size >= plan.policy.maxParallelSteps || this.slots >= this.cfg.maxConcurrentSteps) {
      this.starved.add(run.id);
      return;
    }
    const rec = recs.get(ps.id)!;
    const attempt = rec.attempt + 1;
    const ac = new AbortController();
    d.inflight.set(ps.id, ac);
    this.slots++;
    this.st.runs.patchStep(run.id, ps.id, { status: 'running', attempt, startedAt: rec.startedAt ?? this.clock.now().toISOString(), wakeAt: null });
    this.event(run, 'step.started', { attempt, type: ps.type, capability: ps.capability ? `${ps.capability.name}@${ps.capability.version}` : null, dryRun: run.dryRun }, ps.id, attempt);

    const a: StepAttempt = {
      tenant: run.tenant,
      runId: run.id,
      workflow: run.workflowName,
      plan,
      step: ps,
      attempt,
      scope: this.scope(run, plan, recs),
      dryRun: run.dryRun,
      seed: run.seed,
      now: run.contextNow,
      signal: ac.signal,
    };
    const promise = ps.type === 'map' ? this.exec.executeMap(a) : this.exec.executeCapability(a);
    promise.then(
      (res) => this.onStepResult(run.id, ps.id, attempt, res, d),
      (err) => this.onStepResult(run.id, ps.id, attempt, { kind: 'failed', error: { ...toErrorInfo(err), code: 'RUNTIME_ERROR' }, durationMs: 0, phase: 'runtime' }, d),
    );
  }

  private onStepResult(runId: string, stepId: string, attempt: number, res: StepResult, d: Driver): void {
    this.slots--;
    d.inflight.delete(stepId);
    try {
      const run = this.st.runs.getRun(runId);
      const step = this.st.runs.getStep(runId, stepId);
      if (run && step && step.status === 'running' && step.attempt === attempt && !isTerminalRun(run.status)) {
        const ps = this.plan(run).steps.find((x) => x.id === stepId)!;
        if (res.kind === 'succeeded') {
          this.succeedStep(run, ps, res.output, { cost: res.cost, durationMs: res.durationMs, replayed: res.replayed ?? false, simulated: res.simulated ?? false });
        } else if (res.kind === 'failed') {
          this.failStep(run, ps, res.error, res.phase, res.durationMs);
        } else {
          const wake = new Date(this.clock.now().getTime() + res.retryAfterMs).toISOString();
          this.st.runs.patchStep(runId, stepId, { status: 'retry-wait', attempt: attempt - 1, wakeAt: wake });
          this.event(run, 'step.waiting', { on: res.reason, retryAfterMs: res.retryAfterMs }, stepId, attempt);
        }
      }
    } catch (e) {
      this.log.error('step result handling failed', { runId, stepId, error: e });
      this.failInternally(runId, e);
    }
    this.kick(runId);
    if (this.starved.size > 0) {
      const ids = [...this.starved];
      this.starved.clear();
      for (const id of ids) if (id !== runId) this.kick(id);
    }
  }

  // ========================================================== step outcomes
  private succeedStep(run: RunRecord, ps: PlanStep, output: unknown, meta: { cost: number; durationMs: number; replayed?: boolean; simulated?: boolean }): void {
    const now = this.clock.now().toISOString();
    const seq = this.st.runs.nextCompletionSeq(run.id);
    const stored = this.storeOutput(run, output);
    this.st.runs.patchStep(run.id, ps.id, {
      status: 'succeeded',
      finishedAt: now,
      output: stored.inline ?? null,
      outputRef: stored.ref ?? null,
      error: null,
      wakeAt: null,
      completedSeq: seq,
      cost: meta.cost,
    });
    if (meta.cost > 0) this.st.runs.addRunCost(run.id, run.tenant, run.workflowName, meta.cost);
    const rec = this.st.runs.getStep(run.id, ps.id)!;
    this.event(run, 'step.succeeded', {
      attempt: rec.attempt,
      durationMs: meta.durationMs,
      replayed: meta.replayed ?? false,
      simulated: meta.simulated ?? false,
      cost: meta.cost,
      output: this.preview(ps, output),
      ...(stored.ref ? { outputRef: stored.ref } : {}),
    }, ps.id, rec.attempt);
    this.checkInvariants(run);
  }

  private failStep(run: RunRecord, ps: PlanStep, error: ErrorInfo, phase: string, durationMs = 0): void {
    const rec = this.st.runs.getStep(run.id, ps.id)!;
    const now = this.clock.now();
    const retryable = ps.type === 'capability' || ps.type === 'map' || ps.type === 'subworkflow';
    const verdict = retryable ? shouldRetry(ps.retry, rec.attempt, error) : { retry: false, reason: 'not retryable' };
    if (verdict.retry && ps.retry) {
      const delay = backoffDelayMs(ps.retry, rec.attempt, createRng(run.seed).fork(`${ps.id}/${rec.attempt}`).next());
      const wake = new Date(now.getTime() + delay).toISOString();
      this.st.runs.patchStep(run.id, ps.id, { status: 'retry-wait', wakeAt: wake, error });
      this.event(run, 'step.failed', { attempt: rec.attempt, error, phase, durationMs, willRetry: true }, ps.id, rec.attempt);
      this.event(run, 'step.retry-scheduled', { attempt: rec.attempt, delayMs: delay, wakeAt: wake, reason: verdict.reason }, ps.id, rec.attempt);
      return;
    }
    const handled = ps.onError === 'continue' ? 'continue' : typeof ps.onError === 'object' && ps.onError !== null ? 'route' : null;
    this.st.runs.patchStep(run.id, ps.id, { status: 'failed', finishedAt: now.toISOString(), error, handled, wakeAt: null });
    this.event(run, 'step.failed', {
      attempt: rec.attempt,
      error,
      phase,
      durationMs,
      willRetry: false,
      final: true,
      ...(handled ? { handled } : {}),
      ...(retryable ? { retryDecision: verdict.reason } : {}),
    }, ps.id, rec.attempt);
  }

  private skipStep(run: RunRecord, ps: PlanStep, reason: string): void {
    this.st.runs.patchStep(run.id, ps.id, { status: 'skipped', skippedReason: reason, finishedAt: this.clock.now().toISOString() });
    this.event(run, 'step.skipped', { reason }, ps.id);
  }

  private checkInvariants(run: RunRecord): void {
    const plan = this.plan(run);
    if (plan.guards.invariants.length === 0) return;
    const cur = this.st.runs.getRun(run.id)!;
    if (cur.error !== undefined) return;
    const scope = this.scope(cur, plan, this.records(run.id));
    for (const g of plan.guards.invariants) {
      let ok = false;
      try {
        ok = isTruthy(evaluate(this.parse(g.expr), scope, { seed: run.seed }));
      } catch {
        ok = false;
      }
      if (!ok) {
        this.event(cur, 'run.guard-failed', { guard: g.name, message: g.message ?? `Invariant '${g.name}' was violated` });
        this.st.runs.patchRun(run.id, { error: { code: 'INVARIANT_VIOLATED', message: g.message ?? `Invariant '${g.name}' was violated`, class: 'business', retryable: false } });
        return;
      }
    }
  }

  // =================================================== approvals & subworkflows
  private requestApproval(run: RunRecord, plan: Plan, recs: Map<string, StepRecord>, ps: PlanStep): void {
    const now = this.clock.now();
    const expires = new Date(now.getTime() + ps.timeoutMs).toISOString();
    const message = String(this.safeResolve(ps.message ?? 'Approval requested', this.scope(run, plan, recs), run.seed));
    const approval = this.st.approvals.create({
      tenant: run.tenant,
      runId: run.id,
      stepId: ps.id,
      workflowName: run.workflowName,
      message,
      approvers: ps.approvers ?? { roles: ['approver'], users: [] },
      requestedBy: run.requestedBy.id,
      expiresAt: expires,
      onTimeout: ps.onTimeout ?? 'deny',
      allowSelf: ps.allowSelfApproval ?? false,
    });
    this.st.runs.patchStep(run.id, ps.id, { status: 'waiting-approval', attempt: 1, startedAt: now.toISOString(), approvalId: approval.id, wakeAt: expires });
    this.event(run, 'approval.requested', { approvalId: approval.id, message, approvers: approval.approvers, expiresAt: expires, onTimeout: approval.onTimeout }, ps.id);
    this.event(run, 'step.waiting', { on: 'approval' }, ps.id);
    this.emitter.emit('approval-requested', approval, run);
  }

  private startChild(run: RunRecord, plan: Plan, recs: Map<string, StepRecord>, ps: PlanStep): void {
    const now = this.clock.now().toISOString();
    this.st.runs.patchStep(run.id, ps.id, { attempt: (recs.get(ps.id)?.attempt ?? 0) + 1, startedAt: now });
    try {
      const childPlan = ps.childPlanHash ? this.st.registry.getPlan(run.tenant, ps.childPlanHash) : undefined;
      if (!childPlan || !ps.childPlanHash) throw new Error(`Subworkflow plan ${ps.childPlanHash ?? '(none)'} is not available`);
      const inputs = resolveValue(ps.with ?? {}, this.scope(run, plan, recs), { seed: run.seed }) as Record<string, unknown>;
      const child = this.createRun({
        tenant: run.tenant,
        plan: childPlan,
        planHash: ps.childPlanHash,
        inputs,
        principal: run.requestedBy,
        trigger: { type: 'subworkflow', name: `${run.workflowName}/${ps.id}` },
        dryRun: run.dryRun,
        parent: { runId: run.id, stepId: ps.id },
        ...(run.correlationId ? { correlationId: run.correlationId } : {}),
      });
      this.st.runs.patchStep(run.id, ps.id, { status: 'waiting-child', childRunId: child.id, wakeAt: null });
      this.event(run, 'step.waiting', { on: `subworkflow:${child.id}` }, ps.id);
      this.startRun(child.id);
    } catch (e) {
      this.st.runs.patchStep(run.id, ps.id, { status: 'running' });
      this.failStep(run, ps, { code: 'SUBWORKFLOW_START_FAILED', message: (e as Error).message, class: 'contract', retryable: false }, 'subworkflow');
    }
  }

  private onChildFinished(child: RunRecord): void {
    if (!child.parentRunId || !child.parentStepId) return;
    const parent = this.st.runs.getRun(child.parentRunId);
    const step = parent ? this.st.runs.getStep(child.parentRunId, child.parentStepId) : undefined;
    if (!parent || !step || step.status !== 'waiting-child' || isTerminalRun(parent.status)) return;
    const ps = this.plan(parent).steps.find((x) => x.id === child.parentStepId)!;
    if (child.status === 'succeeded') {
      this.st.runs.patchStep(parent.id, ps.id, { status: 'running' });
      this.succeedStep(parent, ps, { runId: child.id, outputs: child.outputs ?? {} }, { cost: child.cost, durationMs: 0 });
    } else {
      this.st.runs.patchStep(parent.id, ps.id, { status: 'running' });
      this.failStep(parent, ps, {
        code: 'SUBWORKFLOW_FAILED',
        message: `Subworkflow '${child.workflowName}' ${child.status}${child.error ? `: ${child.error.message}` : ''}`,
        class: child.error?.class ?? 'business',
        retryable: false,
        details: { childRunId: child.id, childStatus: child.status },
      }, 'subworkflow');
    }
    this.kick(parent.id);
  }

  // ======================================================= run finalisation
  /** Cancel everything that has not started and is not running (used once a run is failing or cancelled). */
  private quiesce(run: RunRecord, plan: Plan, recs: Map<string, StepRecord>, reason: string): void {
    const now = this.clock.now().toISOString();
    for (const s of recs.values()) {
      const ps = plan.steps.find((x) => x.id === s.stepId)!;
      switch (s.status) {
        case 'pending':
          this.skipStep(run, ps, reason);
          break;
        case 'retry-wait':
        case 'waiting-timer':
        case 'waiting-event':
          this.st.runs.patchStep(run.id, s.stepId, { status: 'cancelled', finishedAt: now, wakeAt: null });
          this.event(run, 'step.skipped', { reason }, s.stepId);
          break;
        case 'waiting-approval':
          if (s.approvalId && this.st.approvals.get(s.approvalId)?.status === 'pending') {
            this.st.approvals.decide(s.approvalId, 'denied', 'system:orchestrator', `Run ${reason}`);
          }
          this.st.runs.patchStep(run.id, s.stepId, { status: 'cancelled', finishedAt: now, wakeAt: null });
          this.event(run, 'step.skipped', { reason }, s.stepId);
          break;
        case 'waiting-child':
          if (s.childRunId) {
            try {
              this.cancelRun(s.childRunId, SYSTEM, `parent run ${reason}`);
            } catch {
              /* the child may be compensating; it finishes on its own */
            }
          }
          this.st.runs.patchStep(run.id, s.stepId, { status: 'cancelled', finishedAt: now });
          this.event(run, 'step.skipped', { reason }, s.stepId);
          break;
        default:
          break;
      }
    }
  }

  private finalizeFailure(run: RunRecord, plan: Plan, recs: Map<string, StepRecord>): void {
    const cur = this.st.runs.getRun(run.id)!;
    const failures = unhandledFailures(recs).sort((a, b) => (a.finishedAt ?? '').localeCompare(b.finishedAt ?? ''));
    const first = failures[0];
    const error: ErrorInfo = cur.error ?? first?.error ?? { code: 'RUN_FAILED', message: 'The run failed', class: 'business', retryable: false };
    const wantsCompensation =
      failures.some((f) => plan.steps.find((s) => s.id === f.stepId)?.onError === 'compensate') ||
      (failures.length === 0 && cur.error !== undefined);
    if (wantsCompensation && hasCompensable(plan, recs)) {
      this.st.runs.transition(run.id, 'compensating', { error });
      this.event(cur, 'run.compensating', { cause: error, failedStep: first?.stepId ?? null });
      this.kick(run.id);
      return;
    }
    this.finishRun(cur, 'failed', { error });
  }

  private finalizeSuccess(run: RunRecord, plan: Plan, recs: Map<string, StepRecord>): void {
    let outputs: Record<string, unknown>;
    try {
      outputs = resolveValue(plan.outputs, this.scope(run, plan, recs), { seed: run.seed }) as Record<string, unknown>;
      if (JSON.stringify(outputs).length > 1024 * 1024) throw new Error('Workflow outputs exceed 1 MiB; write large results to an artifact');
    } catch (e) {
      this.finishRun(run, 'failed', { error: { code: 'OUTPUTS_FAILED', message: `Could not compute workflow outputs: ${(e as Error).message}`, class: 'contract', retryable: false } });
      return;
    }
    this.finishRun(run, 'succeeded', { outputs });
  }

  private finishRun(run: RunRecord, status: RunStatus, patch: { error?: ErrorInfo; outputs?: Record<string, unknown> }): RunRecord {
    const done = this.st.runs.transition(run.id, status, patch);
    const type = ({
      succeeded: 'run.succeeded',
      failed: 'run.failed',
      cancelled: 'run.cancelled',
      'rolled-back': 'run.rolled-back',
      'compensation-failed': 'run.compensation-failed',
    } as Record<string, 'run.succeeded' | 'run.failed' | 'run.cancelled' | 'run.rolled-back' | 'run.compensation-failed'>)[status];
    if (type) {
      this.event(done, type, {
        durationMs: done.startedAt && done.finishedAt ? Date.parse(done.finishedAt) - Date.parse(done.startedAt) : 0,
        cost: done.cost,
        ...(done.error ? { error: done.error } : {}),
        ...(done.outputs ? { outputKeys: Object.keys(done.outputs) } : {}),
      });
    }
    if (status === 'compensation-failed') this.emitter.emit('compensation-failed', done);
    this.emitter.emit('run-finished', done);
    try {
      this.onChildFinished(done);
    } catch (e) {
      this.log.error('parent notification failed', { runId: run.id, error: e });
    }
    return done;
  }

  private advanceCancel(run: RunRecord, plan: Plan, recs: Map<string, StepRecord>, d: Driver): void {
    for (const ac of d.inflight.values()) ac.abort();
    if (d.inflight.size > 0 || [...recs.values()].some((s) => s.status === 'running')) return;
    this.quiesce(run, plan, recs, 'run-cancelled');
    this.finishRun(run, 'cancelled', run.error ? { error: run.error } : {});
  }

  // ============================================================ compensation
  private advanceCompensation(run: RunRecord, plan: Plan, recs: Map<string, StepRecord>, d: Driver): void {
    for (const s of recs.values()) {
      if (s.compensationStatus === 'running' && !d.inflight.has(`${s.stepId}!comp`)) {
        this.st.runs.patchStep(run.id, s.stepId, { compensationStatus: 'pending' });
        recs.set(s.stepId, { ...s, compensationStatus: 'pending' });
      }
    }
    if ([...d.inflight.keys()].some((k) => k.endsWith('!comp'))) return; // one compensation at a time, latest first
    const next = compensationQueue(plan, recs)[0];
    if (!next) {
      const failed = [...recs.values()].filter((s) => s.compensationStatus === 'failed');
      if (failed.length > 0) {
        this.finishRun(run, 'compensation-failed', {
          error: {
            code: 'COMPENSATION_FAILED',
            message: `Rollback left the world inconsistent: compensation failed for ${failed.map((f) => f.stepId).join(', ')}. Manual intervention is required.`,
            class: 'catastrophic',
            retryable: false,
            details: { failedSteps: failed.map((f) => ({ stepId: f.stepId, error: f.compensationError })), cause: run.error ?? null },
          },
        });
      } else {
        this.finishRun(run, 'rolled-back', run.error ? { error: run.error } : {});
      }
      return;
    }
    if (this.slots >= this.cfg.maxConcurrentSteps) {
      this.starved.add(run.id);
      return;
    }
    const key = `${next.id}!comp`;
    const ac = new AbortController();
    d.inflight.set(key, ac);
    this.slots++;
    this.st.runs.patchStep(run.id, next.id, { compensationStatus: 'running' });
    this.event(run, 'step.compensation.started', { capability: next.compensate?.capability.name }, next.id);
    const a: StepAttempt = {
      tenant: run.tenant,
      runId: run.id,
      workflow: run.workflowName,
      plan,
      step: next,
      attempt: 1,
      scope: this.scope(run, plan, recs),
      dryRun: run.dryRun,
      seed: run.seed,
      now: run.contextNow,
      signal: ac.signal,
    };
    this.exec.executeCompensation(a).then(
      (res) => this.onCompensationResult(run.id, next.id, res, d),
      (err) => this.onCompensationResult(run.id, next.id, { kind: 'failed', error: toErrorInfo(err), durationMs: 0, phase: 'runtime' }, d),
    );
  }

  private onCompensationResult(runId: string, stepId: string, res: StepResult, d: Driver): void {
    this.slots--;
    d.inflight.delete(`${stepId}!comp`);
    try {
      const run = this.st.runs.getRun(runId);
      if (run) {
        if (res.kind === 'succeeded') {
          this.st.runs.patchStep(runId, stepId, { compensationStatus: 'done' });
          this.event(run, 'step.compensation.succeeded', { durationMs: res.durationMs, replayed: res.replayed ?? false }, stepId);
        } else {
          const error = res.kind === 'failed' ? res.error : { code: 'COMPENSATION_DEFERRED', message: res.reason, class: 'systemic' as const, retryable: true };
          this.st.runs.patchStep(runId, stepId, { compensationStatus: 'failed', compensationError: error });
          this.event(run, 'step.compensation.failed', { error }, stepId);
        }
      }
    } catch (e) {
      this.log.error('compensation result handling failed', { runId, stepId, error: e });
    }
    this.kick(runId);
  }

  // ============================================================== timers/tick
  private tick(): void {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      const nowIso = this.clock.now().toISOString();
      for (const s of this.st.runs.dueSteps(nowIso)) {
        const run = this.st.runs.getRun(s.runId);
        if (!run || isTerminalRun(run.status)) continue;
        const ps = this.plan(run).steps.find((x) => x.id === s.stepId);
        if (!ps) continue;
        if (s.status === 'waiting-timer') {
          this.succeedStep(run, ps, { waitedMs: ps.durationMs ?? 0 }, { cost: 0, durationMs: ps.durationMs ?? 0 });
        } else if (s.status === 'waiting-event') {
          this.failStep(run, ps, { code: 'WAIT_TIMEOUT', message: `Timed out waiting for event '${s.waitEvent}'`, class: 'business', retryable: false }, 'wait');
        }
        this.kick(run.id);
      }
      for (const a of this.st.approvals.due(nowIso)) this.expireApproval(a);
    } catch (e) {
      this.log.error('tick failed', { error: e });
    } finally {
      this.ticking = false;
    }
  }

  private expireApproval(a: ApprovalRecord): void {
    const run = this.st.runs.getRun(a.runId);
    if (!run || isTerminalRun(run.status)) {
      if (a.status === 'pending') this.st.approvals.decide(a.id, 'timed-out', 'system:timeout', 'run ended');
      return;
    }
    const ps = this.plan(run).steps.find((x) => x.id === a.stepId);
    if (a.onTimeout === 'escalate' && !a.escalated && ps) {
      const newExpiry = new Date(this.clock.now().getTime() + ps.timeoutMs).toISOString();
      this.st.approvals.escalate(a.id, newExpiry);
      this.st.runs.patchStep(a.runId, a.stepId, { wakeAt: newExpiry });
      this.event(run, 'approval.escalated', { approvalId: a.id, newExpiresAt: newExpiry }, a.stepId);
      const fresh = this.st.approvals.get(a.id)!;
      this.emitter.emit('approval-requested', fresh, run);
      return;
    }
    const approve = a.onTimeout === 'approve';
    this.st.approvals.decide(a.id, approve ? 'approved' : 'timed-out', 'system:timeout', approve ? 'auto-approved on timeout' : 'timed out');
    this.event(run, 'approval.timed-out', { approvalId: a.id, outcome: approve ? 'approved' : 'denied' }, a.stepId);
    this.resolveApproval(a.id);
  }

  // ================================================================ helpers
  private plan(run: RunRecord): Plan {
    const plan = this.st.registry.getPlan(run.tenant, run.planHash);
    if (!plan) throw new Error(`Plan ${run.planHash} for run ${run.id} is missing from the registry`);
    return plan;
  }

  private records(runId: string): Map<string, StepRecord> {
    return new Map(this.st.runs.getSteps(runId).map((s) => [s.stepId, s]));
  }

  private parse(expr: string): Node {
    let n = this.exprCache.get(expr);
    if (!n) {
      n = parseExpressionField(expr);
      if (this.exprCache.size > 2000) this.exprCache.clear();
      this.exprCache.set(expr, n);
    }
    return n;
  }

  private contextOf(run: RunRecord, plan: Plan): Record<string, unknown> {
    return { ...plan.context, now: run.contextNow, tenant: run.tenant };
  }

  private runScope(run: RunRecord): Record<string, unknown> {
    return { id: run.id, seed: run.seed, dryRun: run.dryRun, trigger: run.triggerType, workflow: run.workflowName, version: run.workflowVersion };
  }

  /** Expression scope for a run. Secrets are never here — only the Step Runtime, holding a lease, can resolve them. */
  private scope(run: RunRecord, plan: Plan, recs: Map<string, StepRecord>): Record<string, unknown> {
    const steps: Record<string, unknown> = {};
    for (const [id, r] of recs) {
      if (isTerminalStep(r.status) || r.status === 'running') {
        steps[id] = { status: r.status, output: this.loadOutput(run.tenant, r) ?? null, error: r.error ?? null };
      }
    }
    return { inputs: run.inputs, context: this.contextOf(run, plan), steps, run: this.runScope(run) };
  }

  private safeResolve(value: unknown, scope: Record<string, unknown>, seed: string): unknown {
    try {
      return resolveValue(value, scope, { seed });
    } catch {
      return typeof value === 'string' ? value : '';
    }
  }

  private evalWhen(run: RunRecord, plan: Plan, recs: Map<string, StepRecord>, ps: PlanStep): boolean {
    try {
      return isTruthy(evaluate(this.parse(ps.when!), this.scope(run, plan, recs), { seed: run.seed }));
    } catch (e) {
      this.startInline(run, ps);
      this.failStep(run, ps, { code: 'WHEN_EVALUATION_FAILED', message: `Condition could not be evaluated: ${(e as Error).message}`, class: 'contract', retryable: false }, 'when');
      return false;
    }
  }

  private loadOutput(tenant: string, r: StepRecord): unknown {
    if (r.outputRef) return this.st.artifacts.getJson(tenant, r.outputRef);
    return r.output;
  }

  private storeOutput(run: RunRecord, output: unknown): { inline?: unknown; ref?: string } {
    const json = JSON.stringify(output ?? null);
    if (Buffer.byteLength(json, 'utf8') > this.cfg.inlineOutputLimit) {
      return { ref: this.st.artifacts.put(run.tenant, json, { contentType: 'application/json', runId: run.id }).ref };
    }
    return { inline: output ?? null };
  }

  /** What the event log may see of a step's output — classification-driven redaction (§10.1). */
  private preview(ps: PlanStep, output: unknown): unknown {
    const keys = output !== null && typeof output === 'object' && !Array.isArray(output) ? Object.keys(output as object) : undefined;
    if (ps.sensitivity === 'confidential' || ps.sensitivity === 'secret') return { redacted: true, sensitivity: ps.sensitivity, ...(keys ? { keys } : {}) };
    const json = JSON.stringify(output ?? null);
    if (json.length > 4000) return { truncated: true, size: json.length, ...(keys ? { keys } : {}) };
    return output ?? null;
  }

  private maskInputs(plan: Plan, inputs: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(inputs)) {
      const s = plan.inputs[k]?.sensitivity;
      out[k] = s === 'confidential' || s === 'secret' ? '[REDACTED]' : v;
    }
    return out;
  }

  private syncVisibility(run: RunRecord, recs: Map<string, StepRecord>): void {
    const cur = this.st.runs.getRun(run.id)!;
    if (isTerminalRun(cur.status) || cur.status === 'compensating' || cur.status === 'queued') return;
    const all = [...recs.values()];
    const active = all.some((s) => s.status === 'running' || s.status === 'retry-wait' || (s.status === 'pending' && false));
    let want: RunStatus = 'running';
    if (!active) {
      if (all.some((s) => s.status === 'waiting-approval')) want = 'waiting-approval';
      else if (all.some((s) => s.status === 'waiting-event' || s.status === 'waiting-timer' || s.status === 'waiting-child')) want = 'waiting-event';
    }
    if (want !== cur.status) {
      this.st.runs.transition(run.id, want);
      if (want === 'running') this.event(cur, 'run.resumed', {});
      else this.event(cur, 'run.waiting', { on: want === 'waiting-approval' ? 'approval' : 'event' });
    }
  }

  private event(run: RunRecord, type: Parameters<State['events']['append']>[0]['type'], data: Record<string, unknown>, stepId?: string, attempt?: number): void {
    this.st.events.append({
      tenant: run.tenant,
      type,
      runId: run.id,
      ...(stepId ? { stepId } : {}),
      ...(attempt !== undefined ? { attempt } : {}),
      actor: SYSTEM,
      ...(run.correlationId ? { correlationId: run.correlationId } : {}),
      data,
    });
  }
}
