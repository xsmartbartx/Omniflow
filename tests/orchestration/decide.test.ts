import { describe, expect, it } from 'vitest';
import { backoffDelayMs, classifyPending, compensationQueue, shouldRetry, unhandledFailures } from '../../orchestration/orchestrator/index.ts';
import type { Plan, PlanRetry, PlanStep } from '../../schemas/index.ts';
import type { StepRecord, StepStatus } from '../../state/index.ts';

const step = (id: string, dependsOn: string[] = [], over: Partial<PlanStep> = {}): PlanStep => ({
  id,
  type: 'capability',
  order: 0,
  dependsOn,
  timeoutMs: 1000,
  onError: 'fail',
  sensitivity: 'internal',
  ...over,
});
const plan = (steps: PlanStep[]): Plan => ({ steps }) as unknown as Plan;
const rec = (id: string, status: StepStatus, over: Partial<StepRecord> = {}): StepRecord => ({
  runId: 'r',
  stepId: id,
  status,
  attempt: 0,
  cost: 0,
  updatedAt: '',
  ...over,
});
const recs = (list: StepRecord[]) => new Map(list.map((r) => [r.stepId, r]));
const ids = (steps: PlanStep[]) => steps.map((s) => s.id);

describe('classifyPending', () => {
  it('runs roots immediately and releases dependents as dependencies succeed', () => {
    const p = plan([step('a'), step('b', ['a']), step('c', ['a']), step('d', ['b', 'c'])]);
    expect(ids(classifyPending(p, recs([rec('a', 'pending'), rec('b', 'pending'), rec('c', 'pending'), rec('d', 'pending')])).runnable)).toEqual(['a']);
    const after = classifyPending(p, recs([rec('a', 'succeeded'), rec('b', 'pending'), rec('c', 'pending'), rec('d', 'pending')]));
    expect(ids(after.runnable)).toEqual(['b', 'c']); // independent steps become ready together
    const join = classifyPending(p, recs([rec('a', 'succeeded'), rec('b', 'succeeded'), rec('c', 'running'), rec('d', 'pending')]));
    expect(join.runnable).toEqual([]); // d waits for c
  });

  it('never re-dispatches steps that are not pending', () => {
    const p = plan([step('a'), step('b')]);
    expect(ids(classifyPending(p, recs([rec('a', 'running'), rec('b', 'succeeded')])).runnable)).toEqual([]);
  });

  it('skips a step when every dependency was skipped, but not when one succeeded (branch join)', () => {
    const p = plan([step('arm-a'), step('arm-b'), step('after-a', ['arm-a']), step('join', ['arm-a', 'arm-b'])]);
    const c = classifyPending(p, recs([rec('arm-a', 'skipped'), rec('arm-b', 'succeeded'), rec('after-a', 'pending'), rec('join', 'pending')]));
    expect(c.skips.map((s) => [s.step.id, s.reason])).toEqual([['after-a', 'upstream-skipped']]);
    expect(ids(c.runnable)).toEqual(['join']);
    const none = classifyPending(p, recs([rec('arm-a', 'skipped'), rec('arm-b', 'skipped'), rec('after-a', 'pending'), rec('join', 'pending')]));
    expect(none.skips.map((s) => s.step.id).sort()).toEqual(['after-a', 'join']);
  });

  it('blocks dependents of an unhandled failure', () => {
    const p = plan([step('a'), step('b', ['a'])]);
    const c = classifyPending(p, recs([rec('a', 'failed'), rec('b', 'pending')]));
    expect(c.skips).toEqual([{ step: p.steps[1], reason: 'upstream-failed' }]);
  });

  it('lets onError:continue proceed and routeTo release only its target', () => {
    const p = plan([
      step('a', [], { onError: { routeTo: 'cleanup' } }),
      step('cleanup', ['a']),
      step('other', ['a']),
    ]);
    const c = classifyPending(p, recs([rec('a', 'failed', { handled: 'route' }), rec('cleanup', 'pending'), rec('other', 'pending')]));
    expect(ids(c.runnable)).toEqual(['cleanup']);
    expect(c.skips.map((s) => s.step.id)).toEqual(['other']);

    const cont = plan([step('a', [], { onError: 'continue' }), step('b', ['a'])]);
    expect(ids(classifyPending(cont, recs([rec('a', 'failed', { handled: 'continue' }), rec('b', 'pending')])).runnable)).toEqual(['b']);
  });

  it('treats parallel join:any as ready on the first success, and all-terminal otherwise', () => {
    const p = plan([step('x'), step('y'), step('join', ['x', 'y'], { type: 'parallel', join: 'any' })]);
    expect(ids(classifyPending(p, recs([rec('x', 'succeeded'), rec('y', 'running'), rec('join', 'pending')])).runnable)).toEqual(['join']);
    expect(classifyPending(p, recs([rec('x', 'running'), rec('y', 'running'), rec('join', 'pending')])).runnable).toEqual([]);
    expect(ids(classifyPending(p, recs([rec('x', 'failed', { handled: 'continue' }), rec('y', 'failed', { handled: 'continue' }), rec('join', 'pending')])).runnable)).toEqual(['join']);
  });

  it('is pure: identical input gives identical output', () => {
    const p = plan([step('a'), step('b', ['a'])]);
    const r = recs([rec('a', 'succeeded'), rec('b', 'pending')]);
    expect(classifyPending(p, r)).toEqual(classifyPending(p, r));
  });
});

describe('failure bookkeeping', () => {
  it('finds unhandled failures only', () => {
    const r = recs([rec('a', 'failed'), rec('b', 'failed', { handled: 'continue' }), rec('c', 'succeeded')]);
    expect(unhandledFailures(r).map((x) => x.stepId)).toEqual(['a']);
  });

  it('orders compensations latest-completed first and ignores finished ones', () => {
    const p = plan([
      step('a', [], { compensate: {} as never }),
      step('b', [], { compensate: {} as never }),
      step('c', [], { compensate: {} as never }),
      step('d'),
    ]);
    const r = recs([
      rec('a', 'succeeded', { completedSeq: 1 }),
      rec('b', 'succeeded', { completedSeq: 2, compensationStatus: 'done' }),
      rec('c', 'succeeded', { completedSeq: 3 }),
      rec('d', 'succeeded', { completedSeq: 4 }),
    ]);
    expect(ids(compensationQueue(p, r))).toEqual(['c', 'a']);
  });
});

describe('retry policy', () => {
  const retry: PlanRetry = { attempts: 3, backoff: 'exponential', initialDelayMs: 1000, maxDelayMs: 8000, jitter: 0, retryOn: ['transient', 'systemic'] };

  it('grows exponentially, caps at maxDelay, and supports fixed back-off', () => {
    expect([1, 2, 3, 4, 5].map((a) => backoffDelayMs(retry, a, 0.5))).toEqual([1000, 2000, 4000, 8000, 8000]);
    expect(backoffDelayMs({ ...retry, backoff: 'fixed' }, 4, 0.5)).toBe(1000);
  });

  it('applies jitter symmetrically and deterministically from the supplied random value', () => {
    const j = { ...retry, jitter: 0.5 };
    expect(backoffDelayMs(j, 1, 0)).toBe(500);
    expect(backoffDelayMs(j, 1, 1)).toBe(1500);
    expect(backoffDelayMs(j, 1, 0.5)).toBe(1000);
    expect(backoffDelayMs(j, 1, 0.3)).toBe(backoffDelayMs(j, 1, 0.3));
    expect(backoffDelayMs(j, 4, 1)).toBe(8000); // never above maxDelay
  });

  it('retries transient and systemic failures until attempts are exhausted', () => {
    expect(shouldRetry(retry, 1, { class: 'transient', retryable: true }).retry).toBe(true);
    expect(shouldRetry(retry, 2, { class: 'systemic', retryable: true }).retry).toBe(true);
    expect(shouldRetry(retry, 3, { class: 'transient', retryable: true })).toMatchObject({ retry: false, reason: 'attempts exhausted' });
  });

  it('never retries authorisation, business or catastrophic failures', () => {
    for (const c of ['authorisation', 'business', 'catastrophic'] as const) {
      expect(shouldRetry(retry, 1, { class: c, retryable: true }).retry, c).toBe(false);
    }
  });

  it('gives contract failures exactly one retry (§12.2)', () => {
    expect(shouldRetry(retry, 1, { class: 'contract', retryable: true }).retry).toBe(true);
    expect(shouldRetry(retry, 2, { class: 'contract', retryable: true }).retry).toBe(false);
  });

  it('honours retryOn and the error’s own retryable flag', () => {
    expect(shouldRetry({ ...retry, retryOn: ['transient'] }, 1, { class: 'systemic', retryable: true }).retry).toBe(false);
    expect(shouldRetry(retry, 1, { class: 'transient', retryable: false }).retry).toBe(false);
    expect(shouldRetry(undefined, 1, { class: 'transient', retryable: true }).retry).toBe(false);
  });
});
