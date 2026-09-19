import type { ErrorClass } from '../../core/index.ts';
import type { Plan, PlanRetry, PlanStep } from '../../schemas/plan.ts';
import type { StepRecord, StepStatus } from '../../state/run-store.ts';

/**
 * Pure scheduling logic of the run state machine. Given a plan and the current step states, decide
 * what may run next. No I/O, no clock, no randomness — so the "boring core" of the engine is small
 * and can be tested exhaustively.
 */

const TERMINAL: readonly StepStatus[] = ['succeeded', 'failed', 'skipped', 'cancelled'];
export const isTerminalStep = (s: StepStatus): boolean => TERMINAL.includes(s);

export interface Classification {
  /** Pending steps whose dependencies are satisfied. `when` is still to be evaluated by the caller. */
  runnable: PlanStep[];
  /** Pending steps that can never run, with the reason. */
  skips: Array<{ step: PlanStep; reason: string }>;
}

type DepOutcome = 'ok' | 'skipped' | 'blocked';

function outcomeOf(dep: StepRecord, dependent: PlanStep, routes: ReadonlyMap<string, string>): DepOutcome {
  switch (dep.status) {
    case 'succeeded':
      return 'ok';
    case 'skipped':
      return 'skipped';
    case 'failed':
      if (dep.handled === 'continue') return 'ok';
      // A routed failure releases only its declared target; everything else downstream is blocked.
      if (dep.handled === 'route') return routes.get(dep.stepId) === dependent.id ? 'ok' : 'blocked';
      return 'blocked';
    default:
      return 'blocked';
  }
}

/**
 * Dependency semantics:
 *  - A dependency is satisfied when it succeeded, or failed with `onError: continue`, or failed with
 *    `routeTo` naming this very step.
 *  - A skipped dependency counts as satisfied *unless every* dependency was skipped, in which case
 *    the step is skipped too (nothing upstream produced anything). This makes branch arms and joins work.
 *  - A `parallel` join with `join: any` is ready as soon as one branch succeeds.
 */
export function classifyPending(plan: Plan, steps: ReadonlyMap<string, StepRecord>): Classification {
  const routes = new Map(
    plan.steps.flatMap((s) =>
      typeof s.onError === 'object' && s.onError !== null ? [[s.id, s.onError.routeTo] as const] : [],
    ),
  );
  const runnable: PlanStep[] = [];
  const skips: Classification['skips'] = [];

  for (const step of plan.steps) {
    if (steps.get(step.id)?.status !== 'pending') continue;
    const deps = step.dependsOn.map((d) => steps.get(d)).filter((d): d is StepRecord => d !== undefined);

    if (step.type === 'parallel' && step.join === 'any') {
      if (deps.some((d) => d.status === 'succeeded')) runnable.push(step);
      else if (deps.every((d) => isTerminalStep(d.status))) runnable.push(step); // all failed/skipped — the join itself fails
      continue;
    }
    if (!deps.every((d) => isTerminalStep(d.status))) continue;
    if (deps.length === 0) {
      runnable.push(step);
      continue;
    }
    const outcomes = deps.map((d) => outcomeOf(d, step, routes));
    if (outcomes.includes('blocked')) skips.push({ step, reason: 'upstream-failed' });
    else if (outcomes.every((o) => o === 'skipped')) skips.push({ step, reason: 'upstream-skipped' });
    else runnable.push(step);
  }
  return { runnable, skips };
}

export function unhandledFailures(steps: ReadonlyMap<string, StepRecord>): StepRecord[] {
  return [...steps.values()].filter((s) => s.status === 'failed' && !s.handled);
}

export function allTerminal(steps: ReadonlyMap<string, StepRecord>): boolean {
  return [...steps.values()].every((s) => isTerminalStep(s.status));
}

/** Retry back-off. Deterministic: `random` comes from the run's seeded generator. */
export function backoffDelayMs(retry: PlanRetry, attempt: number, random: number): number {
  const base = retry.backoff === 'fixed' ? retry.initialDelayMs : retry.initialDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(base, retry.maxDelayMs);
  const jittered = capped * (1 + retry.jitter * (2 * random - 1));
  return Math.max(0, Math.min(Math.round(jittered), retry.maxDelayMs));
}

export interface RetryVerdict {
  retry: boolean;
  reason: string;
}

/**
 * Failure handling by class (architecture §12.2). `contract` failures (a schema violation on a
 * capability's response) get exactly one retry; authorisation and business failures never retry.
 */
export function shouldRetry(
  retry: PlanRetry | undefined,
  attempt: number,
  error: { class: ErrorClass; retryable: boolean },
): RetryVerdict {
  if (!retry) return { retry: false, reason: 'no retry policy' };
  if (attempt >= retry.attempts) return { retry: false, reason: 'attempts exhausted' };
  if (error.class === 'authorisation' || error.class === 'business' || error.class === 'catastrophic') {
    return { retry: false, reason: `${error.class} failures are not retried` };
  }
  if (error.class === 'contract') {
    return attempt < 2
      ? { retry: true, reason: 'contract failures get one retry' }
      : { retry: false, reason: 'contract failure repeated' };
  }
  if (!error.retryable) return { retry: false, reason: 'error is not retryable' };
  if (!retry.retryOn.includes(error.class)) return { retry: false, reason: `'${error.class}' is not in retryOn` };
  return { retry: true, reason: 'retryable' };
}

/** Steps with a compensation still to run, latest completion first. */
export function compensationQueue(plan: Plan, steps: ReadonlyMap<string, StepRecord>): PlanStep[] {
  return plan.steps
    .filter((ps) => {
      const rec = steps.get(ps.id);
      return (
        ps.compensate !== undefined &&
        rec?.status === 'succeeded' &&
        (rec.compensationStatus === undefined ||
          rec.compensationStatus === 'pending' ||
          rec.compensationStatus === 'running')
      );
    })
    .sort((a, b) => (steps.get(b.id)!.completedSeq ?? 0) - (steps.get(a.id)!.completedSeq ?? 0));
}

export function hasCompensable(plan: Plan, steps: ReadonlyMap<string, StepRecord>): boolean {
  return compensationQueue(plan, steps).length > 0;
}
