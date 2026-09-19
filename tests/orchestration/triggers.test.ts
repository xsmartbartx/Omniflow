import { afterEach, describe, expect, it } from 'vitest';
import { signWebhook } from '../../security/webhook.ts';
import { echo, wf } from '../helpers/engine.ts';
import { makePlatform, type Platform } from '../helpers/platform.ts';

let p: Platform;
afterEach(async () => {
  await p?.stop();
});

const workflow = (
  name: string,
  triggers: unknown[],
  extra: Record<string, unknown> = {},
  steps: unknown[] = [echo('a', 1)],
) => {
  const m = wf(steps, { triggers, ...extra }, name);
  return m;
};
const publish = (m: unknown) => {
  const r = p.publish(p.users.author, m);
  expect(r.status).toBe('published');
};
const runsOf = (name: string) => p.state.runs.listRuns({ tenant: 'default', workflow: name });
const settle = async (name: string, n: number) => {
  const t0 = Date.now();
  while (
    runsOf(name).length < n ||
    runsOf(name).some((r) => !['succeeded', 'failed', 'cancelled'].includes(r.status))
  ) {
    if (Date.now() - t0 > 5000) throw new Error(`runs of ${name} did not settle`);
    await new Promise((r) => setTimeout(r, 10));
  }
  return runsOf(name);
};

describe('schedule triggers', () => {
  const sched = (extra: Record<string, unknown> = {}) => ({
    type: 'schedule',
    name: 'every-five',
    cron: '*/5 * * * *',
    ...extra,
  });

  it('registers on publish, fires each slot exactly once, and never double-fires', async () => {
    p = makePlatform();
    publish(workflow('cron', [sched({ inputs: { n: 7 } })], { inputs: { n: { type: 'integer', default: 0 } } }));
    const [t] = p.state.triggers.listForWorkflow('default', 'cron');
    expect(t).toMatchObject({ name: 'every-five', type: 'schedule', enabled: true });
    const slot = new Date(t!.nextFireAt!);
    expect(slot.getUTCMinutes() % 5).toBe(0);

    p.triggerClock.set(new Date(slot.getTime() + 1000));
    p.triggers.runDue();
    p.triggers.runDue(); // a second tick in the same instant must not fire again
    const runs = await settle('cron', 1);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ triggerType: 'schedule', triggerName: 'every-five', status: 'succeeded' });
    expect(runs[0]!.inputs).toEqual({ n: 7 });

    const next = new Date(p.state.triggers.get(t!.id)!.nextFireAt!);
    expect(next.getTime()).toBe(slot.getTime() + 5 * 60_000);
    p.triggerClock.set(new Date(next.getTime() + 500));
    p.triggers.runDue();
    expect(await settle('cron', 2)).toHaveLength(2);
    expect(p.state.events.list({ tenant: 'default', types: ['trigger.fired'] })).toHaveLength(2);
  });

  it('after an outage skips missed slots by default instead of firing a burst', async () => {
    p = makePlatform();
    publish(workflow('cron', [sched()]));
    const [t] = p.state.triggers.listForWorkflow('default', 'cron');
    p.triggerClock.set(new Date(new Date(t!.nextFireAt!).getTime() + 3 * 3_600_000)); // engine was down for 3 hours
    p.triggers.runDue();
    await new Promise((r) => setTimeout(r, 50));
    expect(runsOf('cron')).toHaveLength(0);
    expect(new Date(p.state.triggers.get(t!.id)!.nextFireAt!).getTime()).toBeGreaterThan(
      p.triggerClock.now().getTime(),
    );
    expect(p.state.events.list({ tenant: 'default', types: ['trigger.rejected'] })[0]!.data.reason).toMatch(
      /missed slot .* skipped/,
    );
  });

  it('with catchup: latest fires once for the missed period', async () => {
    p = makePlatform();
    publish(workflow('cron', [sched({ catchup: 'latest' })]));
    const [t] = p.state.triggers.listForWorkflow('default', 'cron');
    p.triggerClock.set(new Date(new Date(t!.nextFireAt!).getTime() + 3 * 3_600_000));
    p.triggers.runDue();
    p.triggers.runDue();
    expect(await settle('cron', 1)).toHaveLength(1);
  });

  it('keeps the schedule position when a new version keeps the same cron, and stops when disabled', async () => {
    p = makePlatform();
    publish(workflow('cron', [sched()]));
    const before = p.state.triggers.listForWorkflow('default', 'cron')[0]!.nextFireAt;
    const v2 = workflow('cron', [sched()]);
    v2.metadata.version = '1.1.0';
    publish(v2);
    expect(p.state.triggers.listForWorkflow('default', 'cron')[0]!.nextFireAt).toBe(before);

    p.registry.setEnabled(p.users.operator, 'cron', false);
    p.triggerClock.set(new Date(new Date(before!).getTime() + 1000));
    p.triggers.runDue();
    await new Promise((r) => setTimeout(r, 50));
    expect(runsOf('cron')).toHaveLength(0);
  });

  it('records a rejection when the governed run pipeline refuses the run', async () => {
    p = makePlatform();
    publish(workflow('cron', [sched()]));
    p.registry.kill(p.users.operator, 'cron', 'incident');
    const [t] = p.state.triggers.listForWorkflow('default', 'cron');
    p.triggerClock.set(new Date(new Date(t!.nextFireAt!).getTime() + 1000));
    p.triggers.runDue();
    expect(runsOf('cron')).toHaveLength(0);
    expect(
      p.state.events
        .list({ tenant: 'default', types: ['trigger.rejected'] })
        .some((e) => String(e.data.reason).includes('kill switch')),
    ).toBe(true);
  });
});

describe('webhook triggers (T6: replay and forgery)', () => {
  const hook = () =>
    workflow('hooked', [{ type: 'webhook', name: 'incoming', inputs: { order: '${{ event.payload.id }}' } }], {
      inputs: { order: { type: 'string', required: true } },
    });
  const setup = () => {
    p = makePlatform();
    publish(hook());
    const secret = p.triggers.rotateWebhookSecret('default', 'hooked', 'incoming').secret;
    const send = (
      body: string,
      over: {
        secret?: string;
        ts?: number;
        delivery?: string;
        workflow?: string;
        trigger?: string;
        signature?: string;
      } = {},
    ) => {
      const ts = over.ts ?? Math.floor(p.triggerClock.now().getTime() / 1000);
      return p.triggers.handleWebhook({
        tenant: 'default',
        workflow: over.workflow ?? 'hooked',
        trigger: over.trigger ?? 'incoming',
        rawBody: body,
        headers: {
          timestamp: String(ts),
          signature: over.signature ?? signWebhook(over.secret ?? secret, ts, body),
          delivery: over.delivery ?? `d-${Math.random()}`,
        },
      });
    };
    return { secret, send };
  };

  it('accepts a correctly signed delivery and maps the payload onto workflow inputs', async () => {
    const { send } = setup();
    const r = send('{"id":"o-1","extra":true}');
    expect(r.status).toBe('queued');
    const [run] = await settle('hooked', 1);
    expect(run).toMatchObject({ triggerType: 'webhook', triggerName: 'incoming', status: 'succeeded' });
    expect(run!.inputs).toEqual({ order: 'o-1' });
  });

  it('rejects replays of a delivery', () => {
    const { send } = setup();
    expect(send('{"id":"o-1"}', { delivery: 'same' }).status).toBe('queued');
    expect(() => send('{"id":"o-1"}', { delivery: 'same' })).toThrow('Webhook authentication failed');
    expect(
      p.state.events
        .list({ tenant: 'default', types: ['trigger.rejected'] })
        .some((e) => e.data.reason === 'webhook replay'),
    ).toBe(true);
  });

  it('rejects forged, stale and malformed deliveries with one uniform error (no oracle)', () => {
    const { send } = setup();
    const uniform = 'Webhook authentication failed';
    expect(() => send('{"id":"x"}', { secret: 'whsec_wrong' })).toThrow(uniform); // forged signature
    expect(() => send('{"id":"x"}', { signature: 'v1=deadbeef' })).toThrow(uniform);
    expect(() => send('{"id":"x"}', { ts: Math.floor(p.triggerClock.now().getTime() / 1000) - 3600 })).toThrow(uniform); // stale
    expect(() => send('{"id":"x"}', { trigger: 'nonexistent' })).toThrow(uniform); // unknown webhook = wrong signature
    expect(() => send('{"id":"x"}', { workflow: 'ghost' })).toThrow(uniform);
    expect(() =>
      p.triggers.handleWebhook({
        tenant: 'default',
        workflow: 'hooked',
        trigger: 'incoming',
        rawBody: '{}',
        headers: { timestamp: undefined, signature: undefined },
      }),
    ).toThrow(uniform);
    expect(runsOf('hooked')).toHaveLength(0);
  });

  it('signs the body: tampering after signing is detected', () => {
    const { secret, send } = setup();
    const ts = Math.floor(p.triggerClock.now().getTime() / 1000);
    const sig = signWebhook(secret, ts, '{"id":"o-1"}');
    expect(() => send('{"id":"o-EVIL"}', { ts, signature: sig })).toThrow('Webhook authentication failed');
  });

  it('validates the payload after authenticating it', () => {
    const { send } = setup();
    expect(() => send('not json')).toThrow(/must be JSON/);
    expect(() => send('{"nope":1}')).toThrow(/Mapped trigger inputs are invalid|invalid/i); // maps to order: null
    expect(() => send(JSON.stringify({ id: 'x'.repeat(1_100_000) }))).toThrow(/too large/);
  });

  it('rotating the secret invalidates the old one; the secret is never stored in plaintext', () => {
    const { secret, send } = setup();
    const rotated = p.triggers.rotateWebhookSecret('default', 'hooked', 'incoming').secret;
    expect(rotated).not.toBe(secret);
    expect(() => send('{"id":"a"}', { secret })).toThrow('Webhook authentication failed');
    expect(send('{"id":"a"}', { secret: rotated }).status).toBe('queued');
    const dump = p.state.db
      .all('SELECT * FROM secrets')
      .map((r) => JSON.stringify(r))
      .join('');
    expect(dump).not.toContain(rotated);
    expect(dump).not.toContain(secret);
  });

  it('stops accepting deliveries when the workflow is disabled', () => {
    const { send } = setup();
    p.registry.setEnabled(p.users.operator, 'hooked', false);
    expect(() => send('{"id":"a"}')).toThrow('Webhook authentication failed');
  });
});

describe('event and completion triggers', () => {
  it('fires event triggers whose filter matches, mapping the payload, once per correlation', async () => {
    p = makePlatform();
    publish(
      workflow(
        'on-order',
        [
          {
            type: 'event',
            name: 'big-order',
            event: 'order.created',
            filter: 'event.payload.total > 100',
            inputs: { order: '${{ event.payload.id }}' },
          },
        ],
        { inputs: { order: { type: 'string', required: true } } },
      ),
    );
    expect(p.triggers.publishEvent('default', 'order.created', { id: 'o-1', total: 50 }, 'c1')).toEqual({
      resumed: 0,
      runs: [],
    });
    const hit = p.triggers.publishEvent('default', 'order.created', { id: 'o-2', total: 500 }, 'c2');
    expect(hit.runs).toHaveLength(1);
    expect(p.triggers.publishEvent('default', 'order.created', { id: 'o-2', total: 500 }, 'c2').runs).toEqual([]); // same delivery
    expect(p.triggers.publishEvent('default', 'other.event', { total: 999 }).runs).toEqual([]);
    const [run] = await settle('on-order', 1);
    expect(run).toMatchObject({ triggerType: 'event', status: 'succeeded' });
    expect(run!.inputs).toEqual({ order: 'o-2' });
  });

  it('resumes workflows waiting for the same event', async () => {
    p = makePlatform();
    publish(
      workflow('waiter', [{ type: 'manual' }], { inputs: { order: { type: 'string', required: true } } }, [
        {
          id: 'w',
          type: 'wait',
          until: { event: 'payment.settled', correlation: '${{ inputs.order }}' },
          timeout: '5s',
        },
      ]),
    );
    const r = p.runs.trigger({
      principal: p.users.operator,
      workflow: 'waiter',
      inputs: { order: 'o-9' },
      trigger: { type: 'manual' },
    });
    if (r.status !== 'queued') throw new Error('expected queued');
    await p.orch.waitForRun(r.run.id, 3000, (x) => x.status === 'waiting-event');
    expect(p.triggers.publishEvent('default', 'payment.settled', { amount: 1 }, 'o-9').resumed).toBe(1);
    expect((await p.wait(r.run)).status).toBe('succeeded');
  });

  it('chains workflows: completion triggers carry the outputs of the run that finished', async () => {
    p = makePlatform();
    publish(workflow('first', [{ type: 'manual' }], { outputs: { result: '${{ steps.a.output.value }}' } }));
    publish(
      workflow(
        'second',
        [
          {
            type: 'workflow-completion',
            name: 'after-first',
            workflow: 'first',
            status: 'succeeded',
            inputs: { from: '${{ event.payload.outputs.result }}' },
          },
        ],
        { inputs: { from: { type: 'integer', required: true } } },
      ),
    );
    const r = p.runs.trigger({
      principal: p.users.operator,
      workflow: 'first',
      inputs: {},
      trigger: { type: 'manual' },
    });
    if (r.status !== 'queued') throw new Error('expected queued');
    await p.wait(r.run);
    const [second] = await settle('second', 1);
    expect(second).toMatchObject({ triggerType: 'workflow-completion', status: 'succeeded' });
    expect(second!.inputs).toEqual({ from: 1 });
  });

  it('completion triggers respect the status filter', async () => {
    p = makePlatform();
    publish(
      workflow('flaky', [{ type: 'manual' }], {}, [
        { id: 'boom', type: 'capability', uses: 'util-fail@^1', retry: { attempts: 1 } },
      ]),
    );
    publish(
      workflow('on-success', [{ type: 'workflow-completion', name: 'ok', workflow: 'flaky', status: 'succeeded' }]),
    );
    publish(workflow('on-failure', [{ type: 'workflow-completion', name: 'ko', workflow: 'flaky', status: 'failed' }]));
    const r = p.runs.trigger({
      principal: p.users.operator,
      workflow: 'flaky',
      inputs: {},
      trigger: { type: 'manual' },
    });
    if (r.status !== 'queued') throw new Error('expected queued');
    await p.wait(r.run);
    await settle('on-failure', 1);
    await new Promise((res) => setTimeout(res, 100));
    expect(runsOf('on-failure')).toHaveLength(1);
    expect(runsOf('on-success')).toHaveLength(0);
  });
});
