import { afterEach, describe, expect, it } from 'vitest';
import { echo, type Engine, fastRetry, makeEngine, wf } from '../helpers/engine.ts';

let e: Engine;
afterEach(async () => {
  await e?.orch.stop();
});

describe('engine: linear and data flow', () => {
  it('runs steps in order, passes typed data between them, and records the whole history', async () => {
    e = makeEngine();
    e.publish(
      wf(
        [
          echo('first', { n: 21, tag: '${{ inputs.tag }}' }),
          echo('second', '${{ steps.first.output.value.n * 2 }}', { dependsOn: ['first'] }),
        ],
        { inputs: { tag: { type: 'string', default: 'x' } }, outputs: { answer: '${{ steps.second.output.value }}', tag: '${{ steps.first.output.value.tag }}' } },
      ),
    );
    const run = await e.run('wf', { tag: 'hello' });
    expect(run.status).toBe('succeeded');
    expect(run.outputs).toEqual({ answer: 42, tag: 'hello' });
    expect(run.planHash).toMatch(/^sha256:/);
    expect(run.startedAt && run.finishedAt).toBeTruthy();

    // The complete history is reconstructable from the event log alone.
    expect(e.types(run.id)).toEqual([
      'run.queued',
      'run.started',
      'step.started',
      'step.succeeded',
      'step.started',
      'step.succeeded',
      'run.succeeded',
    ]);
    const queued = e.events(run.id)[0]!;
    expect(queued.data).toMatchObject({ workflow: 'wf', version: '1.0.0', planHash: run.planHash });
    expect(e.state.events.verify('default').ok).toBe(true);
  });

  it('checkpoints each step: durable state matches the event log', async () => {
    e = makeEngine();
    e.publish(wf([echo('a', 1), echo('b', 2, { dependsOn: ['a'] })]));
    const run = await e.run('wf');
    const steps = e.state.runs.getSteps(run.id);
    expect(steps.every((s) => s.status === 'succeeded' && s.attempt === 1)).toBe(true);
    expect(steps.map((s) => s.completedSeq).sort()).toEqual([1, 2]);
  });

  it('runs independent steps concurrently and joins them', async () => {
    e = makeEngine();
    const slow = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'capability', uses: 'sim-slow@^1', with: { ms: 150, tag: id }, ...extra });
    e.publish(wf([slow('a'), slow('b'), slow('c'), echo('join', '${{ steps.a.output.tag }}', { dependsOn: ['a', 'b', 'c'] })]));
    const t0 = Date.now();
    const run = await e.run('wf');
    const elapsed = Date.now() - t0;
    expect(run.status).toBe('succeeded');
    expect(e.world.maxConcurrent).toBe(3);
    expect(elapsed).toBeLessThan(420); // three 150ms steps in parallel, not 450ms in series
  });

  it('honours the per-run and global concurrency caps', async () => {
    e = makeEngine({ config: { maxConcurrentSteps: 2 } });
    const slow = (id: string) => ({ id, type: 'capability', uses: 'sim-slow@^1', with: { ms: 60 } });
    e.publish(wf([slow('a'), slow('b'), slow('c'), slow('d'), slow('e')]));
    const run = await e.run('wf');
    expect(run.status).toBe('succeeded');
    expect(e.world.maxConcurrent).toBe(2);

    e = makeEngine();
    e.publish(wf([slow('a'), slow('b'), slow('c'), slow('d')], { policy: { maxParallelSteps: 1 } }));
    expect((await e.run('wf')).status).toBe('succeeded');
    expect(e.world.maxConcurrent).toBe(1);
  });
});

describe('engine: branching, joins and conditions', () => {
  const branching = () =>
    wf(
      [
        { id: 'route', type: 'branch', cases: [{ name: 'big', when: 'inputs.n > 10' }, { name: 'mid', when: 'inputs.n > 5' }], default: 'small' },
        echo('big-arm', 'BIG', { dependsOn: ['route'], when: 'steps.route.output.case == "big"' }),
        echo('mid-arm', 'MID', { dependsOn: ['route'], when: 'steps.route.output.case == "mid"' }),
        echo('small-arm', 'SMALL', { dependsOn: ['route'], when: 'steps.route.output.case == "small"' }),
        echo('after-big', 'never-unless-big', { dependsOn: ['big-arm'] }),
        echo('join', '${{ steps.route.output.case }}', { dependsOn: ['big-arm', 'mid-arm', 'small-arm'] }),
      ],
      { inputs: { n: { type: 'integer', required: true } }, outputs: { picked: '${{ steps.join.output.value }}' } },
    );

  it('takes exactly one arm, skips the others, and still runs the join', async () => {
    e = makeEngine();
    e.publish(branching());
    for (const [n, arm] of [[50, 'big'], [7, 'mid'], [1, 'small']] as const) {
      const run = await e.run('wf', { n });
      expect(run.status, `n=${n}`).toBe('succeeded');
      expect(run.outputs).toEqual({ picked: arm });
      const statuses = Object.fromEntries(e.state.runs.getSteps(run.id).map((s) => [s.stepId, s.status]));
      expect(statuses[`${arm}-arm`]).toBe('succeeded');
      expect(statuses.join).toBe('succeeded');
      const skipped = ['big-arm', 'mid-arm', 'small-arm'].filter((a) => a !== `${arm}-arm`);
      for (const s of skipped) expect(statuses[s], s).toBe('skipped');
    }
    // a step whose only dependency was skipped is skipped too
    const run = await e.run('wf', { n: 1 });
    expect(e.step(run.id, 'after-big')!.status).toBe('skipped');
    expect(e.step(run.id, 'after-big')!.skippedReason).toBe('upstream-skipped');
  });

  it('records why each skipped step was skipped', async () => {
    e = makeEngine();
    e.publish(branching());
    const run = await e.run('wf', { n: 1 });
    expect(e.step(run.id, 'big-arm')!.skippedReason).toBe('condition-false');
    expect(e.events(run.id).filter((x) => x.type === 'step.skipped').map((x) => x.data.reason)).toContain('condition-false');
  });

  it('fails a step whose condition cannot be evaluated, with a contract error', async () => {
    e = makeEngine();
    e.publish(wf([echo('a', 1), echo('b', 2, { dependsOn: ['a'], when: 'steps.a.output.value < "text"' })]));
    const run = await e.run('wf');
    expect(run.status).toBe('failed');
    expect(run.error).toMatchObject({ code: 'WHEN_EVALUATION_FAILED', class: 'contract' });
  });

  it('parallel join:any completes on the first success and cancels the slower branches', async () => {
    e = makeEngine();
    const slow = (id: string, ms: number) => ({ id, type: 'capability', uses: 'sim-slow@^1', with: { ms, tag: id } });
    e.publish(
      wf([slow('fast', 30), slow('slow', 3000), { id: 'race', type: 'parallel', join: 'any', dependsOn: ['fast', 'slow'] }], {
        outputs: { winner: '${{ keys(steps.race.output.results) }}' },
      }),
    );
    const t0 = Date.now();
    const run = await e.run('wf');
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(run.status).toBe('succeeded');
    expect(run.outputs).toEqual({ winner: ['fast'] });
    expect(e.step(run.id, 'slow')!.status).toBe('cancelled');
  });

  it('parallel join:all gathers every branch result', async () => {
    e = makeEngine();
    e.publish(wf([echo('x', 1), echo('y', 2), { id: 'all', type: 'parallel', join: 'all', dependsOn: ['x', 'y'] }], { outputs: { n: '${{ len(steps.all.output.results) }}' } }));
    expect((await e.run('wf')).outputs).toEqual({ n: 2 });
  });
});

describe('engine: error handling (onError)', () => {
  const failing = (extra: Record<string, unknown> = {}) => ({ id: 'boom', type: 'capability', uses: 'util-fail@^1', with: { message: 'nope' }, retry: { attempts: 1 }, ...extra });

  it('fails the run by default and skips everything downstream', async () => {
    e = makeEngine();
    e.publish(wf([failing(), echo('after', 1, { dependsOn: ['boom'] })]));
    const run = await e.run('wf');
    expect(run.status).toBe('failed');
    expect(run.error).toMatchObject({ code: 'DELIBERATE_FAILURE', class: 'business', message: 'nope' });
    expect(e.step(run.id, 'boom')!.status).toBe('failed');
    expect(e.step(run.id, 'after')!.status).toBe('skipped');
    expect(e.types(run.id)).toContain('run.failed');
  });

  it('onError: continue lets the run carry on with the failed step’s output as null', async () => {
    e = makeEngine();
    e.publish(wf([failing({ onError: 'continue' }), echo('after', '${{ steps.boom.output ?? "recovered" }}', { dependsOn: ['boom'] })], { outputs: { v: '${{ steps.after.output.value }}' } }));
    const run = await e.run('wf');
    expect(run.status).toBe('succeeded');
    expect(run.outputs).toEqual({ v: 'recovered' });
    expect(e.step(run.id, 'boom')).toMatchObject({ status: 'failed', handled: 'continue' });
  });

  it('onError: routeTo sends control to the handler and skips other dependents', async () => {
    e = makeEngine();
    e.publish(
      wf(
        [
          failing({ onError: { routeTo: 'handler' } }),
          echo('handler', '${{ steps.boom.error.code }}', { dependsOn: ['boom'] }),
          echo('normal', 'ok', { dependsOn: ['boom'] }),
        ],
        { outputs: { handled: '${{ steps.handler.output.value }}' } },
      ),
    );
    const run = await e.run('wf');
    expect(run.status).toBe('succeeded');
    expect(run.outputs).toEqual({ handled: 'DELIBERATE_FAILURE' });
    expect(e.step(run.id, 'normal')!.status).toBe('skipped');
  });
});

describe('engine: map (bounded fan-out)', () => {
  const mapStep = (extra: Record<string, unknown> = {}) => ({
    id: 'each',
    type: 'map',
    items: 'inputs.items',
    maxItems: 20,
    concurrency: 3,
    uses: 'util-echo@^1',
    with: { value: '${{ item * 10 }}' },
    ...extra,
  });
  const inputs = { items: { type: 'array', required: true } };

  it('maps over a collection with bounded concurrency and preserves order', async () => {
    e = makeEngine();
    e.publish(wf([mapStep()], { inputs, outputs: { out: '${{ pluck(steps.each.output.results, "value") }}', n: '${{ steps.each.output.count }}' } }));
    const run = await e.run('wf', { items: [1, 2, 3, 4, 5, 6, 7] });
    expect(run.status).toBe('succeeded');
    expect(run.outputs).toEqual({ out: [10, 20, 30, 40, 50, 60, 70], n: 7 });
    expect(e.types(run.id)).toContain('step.item.succeeded');
  });

  it('enforces maxItems at run time', async () => {
    e = makeEngine();
    e.publish(wf([mapStep({ maxItems: 3 })], { inputs }));
    const run = await e.run('wf', { items: [1, 2, 3, 4] });
    expect(run.status).toBe('failed');
    expect(run.error).toMatchObject({ code: 'MAP_TOO_LARGE', class: 'contract' });
  });

  it('tolerates a bounded number of item failures, and fails beyond it', async () => {
    e = makeEngine();
    const withFail = (tolerance: unknown) =>
      wf(
        [
          mapStep({
            uses: 'sim-flaky@^1',
            retry: { attempts: 1 },
            with: { key: 'item-${{ item }}', failTimes: '${{ item == 2 || item == 4 ? 1 : 0 }}' },
            errorTolerance: tolerance,
          }),
        ],
        { inputs, outputs: { failed: '${{ len(steps.each.output.failures) }}' } },
      );
    e.publish(withFail({ count: 2 }));
    const ok = await e.run('wf', { items: [1, 2, 3, 4, 5] });
    expect(ok.status).toBe('succeeded');
    expect(ok.outputs).toEqual({ failed: 2 });

    e.world.attempts.clear();
    e = makeEngine({ world: e.world, state: undefined as never });
    e.publish(withFail({ count: 1 }));
    const bad = await e.run('wf', { items: [1, 2, 3, 4, 5] });
    expect(bad.status).toBe('failed');
    expect(bad.error).toMatchObject({ code: 'MAP_TOLERANCE_EXCEEDED' });
  });

  it('retries a failing item on its own without failing the step', async () => {
    e = makeEngine();
    e.publish(
      wf(
        [mapStep({ uses: 'sim-flaky@^1', retry: fastRetry(3), with: { key: 'k${{ item }}', failTimes: 1 } })],
        { inputs, outputs: { attempts: '${{ pluck(steps.each.output.results, "attempts") }}' } },
      ),
    );
    const run = await e.run('wf', { items: [1, 2] });
    expect(run.status).toBe('succeeded');
    expect(run.outputs).toEqual({ attempts: [2, 2] });
  });

  it('performs each effect exactly once even when items are retried', async () => {
    e = makeEngine();
    e.publish(
      wf(
        [
          mapStep({
            uses: 'sim-effect@^1',
            with: { label: 'mail-${{ item }}' },
            idempotencyKey: 'mail-${{ item }}',
          }),
        ],
        { inputs },
      ),
    );
    await e.run('wf', { items: [1, 2, 3] });
    await e.run('wf', { items: [1, 2, 3] }); // a second run with the same keys must not repeat any effect
    expect(e.world.effects.sort()).toEqual(['mail-1', 'mail-2', 'mail-3']);
  });
});

describe('engine: wait, terminate, guards, outputs', () => {
  it('waits for a duration durably', async () => {
    e = makeEngine();
    e.publish(wf([{ id: 'nap', type: 'wait', duration: '120ms' }, echo('after', 'up', { dependsOn: ['nap'] })]));
    const t0 = Date.now();
    const run = await e.run('wf');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(110);
    expect(run.status).toBe('succeeded');
    expect(e.types(run.id)).toContain('run.waiting');
    expect(e.types(run.id)).toContain('run.resumed');
  });

  it('waits for an external event, correlated, and delivers its payload', async () => {
    e = makeEngine();
    e.publish(
      wf([{ id: 'payment', type: 'wait', until: { event: 'payment.settled', correlation: '${{ inputs.order }}' }, timeout: '5s' }], {
        inputs: { order: { type: 'string', required: true } },
        outputs: { amount: '${{ steps.payment.output.payload.amount }}' },
      }),
    );
    const run = await e.run('wf', { order: 'o-1' }, { wait: false });
    await e.orch.waitForRun(run.id, 2000, (r) => r.status === 'waiting-event');
    expect(e.orch.deliverEvent('default', 'payment.settled', 'o-other', { amount: 1 })).toBe(0); // wrong correlation
    expect(e.orch.deliverEvent('default', 'payment.settled', 'o-1', { amount: 99 })).toBe(1);
    const done = await e.orch.waitForRun(run.id);
    expect(done.status).toBe('succeeded');
    expect(done.outputs).toEqual({ amount: 99 });
  });

  it('fails when an awaited event never arrives', async () => {
    e = makeEngine();
    e.publish(wf([{ id: 'w', type: 'wait', until: { event: 'never' }, timeout: '80ms' }]));
    const run = await e.run('wf');
    expect(run.status).toBe('failed');
    expect(run.error).toMatchObject({ code: 'WAIT_TIMEOUT' });
  });

  it('terminate ends the run early with an explicit status', async () => {
    e = makeEngine();
    e.publish(
      wf([
        echo('a', 1),
        { id: 'stop', type: 'terminate', status: 'success', dependsOn: ['a'], when: 'inputs.stop' },
        echo('never', 2, { dependsOn: ['a'], when: '!inputs.stop' }),
      ], { inputs: { stop: { type: 'boolean', default: true } } }),
    );
    const run = await e.run('wf');
    expect(run.status).toBe('succeeded');
    expect(e.step(run.id, 'never')!.status).toBe('skipped');

    e = makeEngine();
    e.publish(wf([{ id: 'stop', type: 'terminate', status: 'failure', errorClass: 'contract', message: 'bad ${{ inputs.what }}' }], { inputs: { what: { type: 'string', default: 'input' } } }));
    const failed = await e.run('wf');
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatchObject({ code: 'TERMINATED', class: 'contract', message: 'bad input' });
  });

  it('checks pre-run guards before anything executes', async () => {
    e = makeEngine();
    e.publish(wf([echo('a', 1)], { inputs: { n: { type: 'integer', required: true } }, guards: { pre: [{ name: 'positive', expr: 'inputs.n > 0', message: 'n must be positive' }] } }));
    const bad = await e.run('wf', { n: -1 });
    expect(bad.status).toBe('failed');
    expect(bad.error).toMatchObject({ code: 'GUARD_FAILED', message: 'n must be positive' });
    expect(e.types(bad.id)).not.toContain('step.started');
    expect(e.types(bad.id)).toContain('run.guard-failed');
    expect((await e.run('wf', { n: 5 })).status).toBe('succeeded');
  });

  it('fails the run when an invariant is violated between steps', async () => {
    e = makeEngine();
    e.publish(
      wf([echo('a', 5), echo('b', 6, { dependsOn: ['a'] })], {
        guards: { invariants: [{ name: 'small', expr: 'steps.a.output.value < 3', message: 'value grew too large' }] },
      }),
    );
    const run = await e.run('wf');
    expect(run.status).toBe('failed');
    expect(run.error).toMatchObject({ code: 'INVARIANT_VIOLATED', message: 'value grew too large' });
    expect(e.step(run.id, 'b')!.status).toBe('skipped');
  });

  it('keeps large step outputs out of run state, as artifacts referenced by hash', async () => {
    e = makeEngine({ config: { inlineOutputLimit: 500 } });
    e.publish(wf([{ id: 'big', type: 'capability', uses: 'sim-big@^1', with: { size: 5000 } }, echo('use', '${{ len(steps.big.output.blob) }}', { dependsOn: ['big'] })], { outputs: { n: '${{ steps.use.output.value }}' } }));
    const run = await e.run('wf');
    expect(run.outputs).toEqual({ n: 5000 });
    const rec = e.step(run.id, 'big')!;
    expect(rec.outputRef).toMatch(/^sha256:/);
    expect(rec.output).toBeUndefined();
    expect(e.state.artifacts.getJson<{ blob: string }>('default', rec.outputRef!).blob).toHaveLength(5000);
    // the event log carries a reference, never the payload
    expect(JSON.stringify(e.events(run.id))).not.toContain('x'.repeat(200));
  });
});
