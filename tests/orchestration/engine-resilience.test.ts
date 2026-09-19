import { afterEach, describe, expect, it } from 'vitest';
import { type Engine, echo, fastRetry, makeEngine, wf } from '../helpers/engine.ts';

let e: Engine;
const engines: Engine[] = [];
const track = (x: Engine) => {
  engines.push(x);
  return x;
};
afterEach(async () => {
  for (const x of engines.splice(0)) await x.orch.stop();
});

const flaky = (id: string, failTimes: number, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'capability',
  uses: 'sim-flaky@^1',
  with: { key: id, failTimes, ...(extra.errorClass ? { errorClass: extra.errorClass } : {}) },
  retry: fastRetry(3),
  ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'errorClass')),
});
const effect = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'capability',
  uses: 'sim-effect@^1',
  with: { label: id },
  idempotencyKey: `key-${id}`,
  retry: fastRetry(3),
  ...extra,
});
const undo = (label: string, key = `undo-key-${label}`) => ({
  uses: 'sim-undo@^1',
  with: { label },
  idempotencyKey: key,
});

const until = async (fn: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('condition not reached in time');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('retry and timeout', () => {
  it('retries transient failures with back-off and then succeeds', async () => {
    e = track(makeEngine());
    e.publish(wf([flaky('svc', 2)], { outputs: { attempts: '${{ steps.svc.output.attempts }}' } }));
    const run = await e.run('wf');
    expect(run.status).toBe('succeeded');
    expect(run.outputs).toEqual({ attempts: 3 });
    expect(e.step(run.id, 'svc')!.attempt).toBe(3);
    const t = e.types(run.id);
    expect(t.filter((x) => x === 'step.started')).toHaveLength(3);
    expect(t.filter((x) => x === 'step.retry-scheduled')).toHaveLength(2);
    const failed = e.events(run.id).filter((x) => x.type === 'step.failed');
    expect(failed.every((x) => x.data.willRetry === true)).toBe(true);
    expect(failed[0]!.data.error).toMatchObject({ code: 'FLAKY', class: 'transient' });
  });

  it('gives up when attempts are exhausted and reports the classified failure', async () => {
    e = track(makeEngine());
    e.publish(wf([flaky('svc', 99)]));
    const run = await e.run('wf');
    expect(run.status).toBe('failed');
    expect(run.error).toMatchObject({ code: 'FLAKY', class: 'transient' });
    expect(e.step(run.id, 'svc')!.attempt).toBe(3);
    expect(
      e
        .events(run.id)
        .filter((x) => x.type === 'step.failed')
        .at(-1)!.data,
    ).toMatchObject({ final: true, willRetry: false });
  });

  it('never retries business or authorisation failures', async () => {
    for (const errorClass of ['business', 'authorisation']) {
      e = track(makeEngine());
      e.publish(wf([flaky('svc', 99, { errorClass })]));
      const run = await e.run('wf');
      expect(run.status).toBe('failed');
      expect(e.step(run.id, 'svc')!.attempt, errorClass).toBe(1);
    }
  });

  it('derives retry jitter from the run seed: reproducible, and different for other seeds', async () => {
    const delays = async (seed: string) => {
      e = track(makeEngine());
      e.publish(
        wf([
          {
            ...flaky('svc', 99),
            retry: { attempts: 4, backoff: 'exponential', initialDelay: '20ms', maxDelay: '500ms', jitter: 0.5 },
          },
        ]),
      );
      const run = await e.run('wf', {}, { seed });
      return e
        .events(run.id)
        .filter((x) => x.type === 'step.retry-scheduled')
        .map((x) => x.data.delayMs);
    };
    const a1 = await delays('seed-A');
    const a2 = await delays('seed-A');
    const b = await delays('seed-B');
    expect(a1).toEqual(a2);
    expect(a1).toHaveLength(3);
    expect(b).not.toEqual(a1);
    for (const d of a1 as number[]) expect(d).toBeGreaterThan(0);
  });

  it('times out slow steps as transient failures, aborts the adapter, and retries', async () => {
    e = track(makeEngine());
    e.publish(
      wf([
        {
          id: 'slow',
          type: 'capability',
          uses: 'sim-slow@^1',
          with: { ms: 2000 },
          timeout: '60ms',
          retry: fastRetry(2),
        },
      ]),
    );
    const run = await e.run('wf');
    expect(run.status).toBe('failed');
    expect(run.error).toMatchObject({ code: 'STEP_TIMEOUT', class: 'transient' });
    expect(e.step(run.id, 'slow')!.attempt).toBe(2);
    await until(() => e.world.concurrent === 0); // the adapter was told to stop
  });

  it('retries a schema-violating response once, then fails as a contract error', async () => {
    e = track(makeEngine());
    e.publish(wf([{ id: 'bad', type: 'capability', uses: 'sim-bad-output@^1', retry: fastRetry(5) }]));
    const run = await e.run('wf');
    expect(run.status).toBe('failed');
    expect(run.error).toMatchObject({ code: 'OUTPUT_INVALID', class: 'contract' });
    expect(e.step(run.id, 'bad')!.attempt).toBe(2); // one retry, not five
  });
});

describe('effective exactly-once execution (ADR-0002 D3)', () => {
  it('replays the recorded result instead of repeating an effect', async () => {
    e = track(makeEngine());
    e.publish(wf([effect('charge')], { outputs: { id: '${{ steps.charge.output.id }}' } }));
    const first = await e.run('wf');
    const second = await e.run('wf');
    expect(first.outputs).toEqual({ id: 'eff_charge' });
    expect(second.outputs).toEqual({ id: 'eff_charge' });
    expect(e.world.calls).toEqual(['charge']); // the adapter was reached once
    expect(e.types(second.id)).toContain('step.idempotent-replay');
    expect(e.state.runs.getRun(second.id)!.cost).toBe(0); // a replay costs nothing
  });

  it('performs distinct effects for distinct keys', async () => {
    e = track(makeEngine());
    e.publish(
      wf([effect('a', { idempotencyKey: 'k-${{ inputs.n }}', with: { label: 'a-${{ inputs.n }}' } })], {
        inputs: { n: { type: 'integer', required: true } },
      }),
    );
    await e.run('wf', { n: 1 });
    await e.run('wf', { n: 2 });
    await e.run('wf', { n: 1 });
    expect(e.world.effects.sort()).toEqual(['a-1', 'a-2']);
  });

  it('a retry after a failed attempt is not blocked by the failed claim', async () => {
    e = track(makeEngine());
    // The effect step depends on a flaky guard; the retry path must re-claim its key cleanly.
    e.publish(wf([flaky('gate', 1), effect('pay', { dependsOn: ['gate'] })]));
    const run = await e.run('wf');
    expect(run.status).toBe('succeeded');
    expect(e.world.effects).toEqual(['pay']);
  });
});

describe('chaos: a worker killed mid-step (architecture §12.1)', () => {
  it('recovers without duplicate effects and without re-running finished steps', async () => {
    e = track(makeEngine());
    e.publish(
      wf(
        [
          effect('first'),
          effect('second', { dependsOn: ['first'], with: { label: 'second', hangMs: 400 } }),
          effect('third', { dependsOn: ['second'] }),
        ],
        { outputs: { last: '${{ steps.third.output.id }}' } },
      ),
    );
    const run = await e.run('wf', {}, { wait: false });
    await until(() => e.step(run.id, 'second')?.status === 'running');

    // kill -9: nothing more is persisted by this process
    await e.orch.stop();
    expect(e.step(run.id, 'second')!.status).toBe('running'); // durable state still says "running"
    expect(e.state.runs.getRun(run.id)!.status).toBe('running');

    // a new process starts over the same durable state
    const e2 = track(e.restart());
    const done = await e2.orch.waitForRun(run.id, 10_000);
    expect(done.status).toBe('succeeded');
    expect(done.outputs).toEqual({ last: 'eff_third' });

    expect(e2.world.effects).toEqual(['first', 'second', 'third']); // each effect happened exactly once
    expect(e2.world.calls.filter((c) => c === 'first')).toHaveLength(1); // a finished step is never re-run
    expect(e2.world.calls.filter((c) => c === 'second')).toHaveLength(2); // the interrupted step was re-dispatched…
    expect(e2.step(run.id, 'second')!.attempt).toBe(1); // …under the same attempt number, same idempotency key
    expect(e2.types(run.id)).toContain('step.recovered');
    expect(e2.types(run.id)).toContain('run.recovered');
    expect(e2.state.events.verify('default').ok).toBe(true);
  });

  it('resumes a run that was waiting on a timer when the process died', async () => {
    e = track(makeEngine());
    e.publish(wf([{ id: 'nap', type: 'wait', duration: '250ms' }, echo('after', 'done', { dependsOn: ['nap'] })]));
    const run = await e.run('wf', {}, { wait: false });
    await until(() => e.step(run.id, 'nap')?.status === 'waiting-timer');
    await e.orch.stop();
    const e2 = track(e.restart());
    const done = await e2.orch.waitForRun(run.id);
    expect(done.status).toBe('succeeded');
  });

  it('re-drives runs that were queued-and-started but never dispatched', async () => {
    e = track(makeEngine());
    e.publish(wf([echo('a', 1)]));
    const run = e.submit('wf');
    await e.orch.stop(); // dies before the first advance
    const e2 = track(e.restart());
    expect((await e2.orch.waitForRun(run.id)).status).toBe('succeeded');
  });
});

describe('compensation and rollback (§9.2)', () => {
  const saga = (failing = true) =>
    wf([
      effect('s1', { compensate: undo('undo-s1') }),
      effect('s2', { dependsOn: ['s1'], compensate: undo('undo-s2') }),
      {
        id: 'boom',
        type: 'capability',
        uses: 'util-fail@^1',
        dependsOn: ['s2'],
        with: { message: 'downstream broke' },
        retry: { attempts: 1 },
        onError: failing ? 'compensate' : 'fail',
      },
    ]);

  it('rolls back completed steps in reverse order and ends RolledBack', async () => {
    e = track(makeEngine());
    e.publish(saga());
    const run = await e.run('wf');
    expect(run.status).toBe('rolled-back');
    expect(run.error).toMatchObject({ code: 'DELIBERATE_FAILURE' });
    expect(e.world.effects).toEqual(['s1', 's2']);
    expect(e.world.compensations).toEqual(['undo-s2', 'undo-s1']); // latest first
    const t = e.types(run.id);
    expect(t).toContain('run.compensating');
    expect(t.filter((x) => x === 'step.compensation.succeeded')).toHaveLength(2);
    expect(t.at(-1)).toBe('run.rolled-back');
    expect(e.step(run.id, 's1')!.compensationStatus).toBe('done');
  });

  it('does not compensate unless the failing step asks for it (onError: compensate)', async () => {
    e = track(makeEngine());
    e.publish(saga(false));
    const run = await e.run('wf');
    expect(run.status).toBe('failed');
    expect(e.world.compensations).toEqual([]);
  });

  it('CompensationFailed is a distinct terminal state that alerts a human', async () => {
    e = track(makeEngine());
    const alerts: string[] = [];
    e.orch.on('compensation-failed', (r) => alerts.push(r.id));
    e.world.failUndo.add('undo-s2');
    e.publish(saga());
    const run = await e.run('wf');
    expect(run.status).toBe('compensation-failed');
    expect(run.status).not.toBe('failed');
    expect(run.error).toMatchObject({ code: 'COMPENSATION_FAILED', class: 'catastrophic' });
    expect((run.error!.details as any).failedSteps[0].stepId).toBe('s2');
    expect(e.world.compensations).toEqual(['undo-s1']); // the remaining compensations still ran
    expect(e.types(run.id)).toContain('run.compensation-failed');
    expect(alerts).toEqual([run.id]);
  });

  it('finishes a rollback that was interrupted by a crash, without repeating compensations', async () => {
    e = track(makeEngine());
    e.publish(
      wf([
        effect('s1', {
          compensate: { uses: 'sim-effect@^1', with: { label: 'undo-s1', hangMs: 400 }, idempotencyKey: 'undo-s1' },
        }),
        {
          id: 'boom',
          type: 'capability',
          uses: 'util-fail@^1',
          dependsOn: ['s1'],
          retry: { attempts: 1 },
          onError: 'compensate',
        },
      ]),
    );
    const run = await e.run('wf', {}, { wait: false });
    await until(() => e.step(run.id, 's1')?.compensationStatus === 'running');
    await e.orch.stop();
    const e2 = track(e.restart());
    const done = await e2.orch.waitForRun(run.id, 10_000);
    expect(done.status).toBe('rolled-back');
    expect(e2.world.effects).toEqual(['s1', 'undo-s1']); // compensation happened exactly once
  });

  it('skips rollback (plain failure) when nothing completed has a compensation', async () => {
    e = track(makeEngine());
    e.publish(
      wf([
        echo('a', 1),
        {
          id: 'boom',
          type: 'capability',
          uses: 'util-fail@^1',
          dependsOn: ['a'],
          retry: { attempts: 1 },
          onError: 'compensate',
        },
      ]),
    );
    expect((await e.run('wf')).status).toBe('failed');
  });
});

describe('cancellation', () => {
  it('cancels a run whose step is in flight, aborting the adapter', async () => {
    e = track(makeEngine());
    e.publish(
      wf([
        { id: 'slow', type: 'capability', uses: 'sim-slow@^1', with: { ms: 5000 } },
        echo('after', 1, { dependsOn: ['slow'] }),
      ]),
    );
    const run = await e.run('wf', {}, { wait: false });
    await until(() => e.step(run.id, 'slow')?.status === 'running');
    const t0 = Date.now();
    e.orch.cancelRun(run.id, { id: 'usr_1', name: 'Ada' }, 'no longer needed');
    const done = await e.orch.waitForRun(run.id);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(done.status).toBe('cancelled');
    expect(done.error?.message).toContain('Ada');
    expect(e.step(run.id, 'slow')!.status).toBe('cancelled');
    expect(e.step(run.id, 'after')!.status).toBe('skipped');
    await until(() => e.world.concurrent === 0);
  });

  it('cancels a queued run directly and ignores cancelling a finished one', async () => {
    e = track(makeEngine());
    e.publish(wf([echo('a', 1)]));
    const v = e.state.registry.latestVersion('default', 'wf')!;
    const queued = e.orch.createRun({
      tenant: 'default',
      plan: e.state.registry.getPlan('default', v.planHash)!,
      planHash: v.planHash,
      inputs: {},
      principal: { id: 'u', type: 'user', name: 'u', tenant: 'default', roles: ['admin'] },
      trigger: { type: 'manual' },
    });
    expect(e.orch.cancelRun(queued.id, { id: 'u' }).status).toBe('cancelled');
    const done = await e.run('wf');
    expect(e.orch.cancelRun(done.id, { id: 'u' }).status).toBe('succeeded');
  });

  it('cancelling a run that awaits approval denies the pending approval', async () => {
    e = track(makeEngine());
    e.publish(wf([{ id: 'gate', type: 'approval', message: 'ok?', timeout: '1h', onTimeout: 'deny' }]));
    const run = await e.run('wf', {}, { wait: false });
    await e.orch.waitForRun(run.id, 3000, (r) => r.status === 'waiting-approval');
    e.orch.cancelRun(run.id, { id: 'u' });
    expect((await e.orch.waitForRun(run.id)).status).toBe('cancelled');
    expect(e.state.approvals.list({ tenant: 'default' })[0]!.status).toBe('denied');
  });

  it('refuses to cancel a run that is being rolled back', async () => {
    e = track(makeEngine());
    e.publish(
      wf([
        effect('s1', {
          compensate: { uses: 'sim-effect@^1', with: { label: 'undo', hangMs: 500 }, idempotencyKey: 'undo' },
        }),
        {
          id: 'boom',
          type: 'capability',
          uses: 'util-fail@^1',
          dependsOn: ['s1'],
          retry: { attempts: 1 },
          onError: 'compensate',
        },
      ]),
    );
    const run = await e.run('wf', {}, { wait: false });
    await e.orch.waitForRun(run.id, 5000, (r) => r.status === 'compensating');
    expect(() => e.orch.cancelRun(run.id, { id: 'u' })).toThrow(/rolled back/);
    expect((await e.orch.waitForRun(run.id)).status).toBe('rolled-back');
  });
});
