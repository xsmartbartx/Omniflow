import { beforeEach, describe, expect, it } from 'vitest';
import { type Alert, type AlertEvent, AlertManager, buildOverview, formatAlert } from '../../insight/index.ts';
import { addRun, bad, echo, ok, publish } from '../helpers/history.ts';
import { makeState, type TestState } from '../helpers/state.ts';

const MIN = 60_000;
let s: TestState;
let sent: Array<{ event: AlertEvent; alert: Alert }>;
let circuits: Record<string, { state: string }>;
let mgr: AlertManager;
const make = (over: Partial<ConstructorParameters<typeof AlertManager>[0]> = {}) =>
  new AlertManager({ state: s, clock: s.clock, notify: async (alert, event) => void sent.push({ event, alert }), circuits: () => circuits, config: { auditVerifyEveryMs: 0 }, ...over });

beforeEach(() => {
  s = makeState();
  sent = [];
  circuits = {};
  mgr = make();
  publish(s, 'pay', [echo('charge')]);
});

const failures = (n: number, of: number) => {
  for (let i = 0; i < of; i++) addRun(s, { workflow: 'pay', status: i < n ? 'failed' : 'succeeded', steps: { charge: i < n ? bad('CARD_DECLINED', 'business') : ok() } });
};

describe('workflow failure alerts', () => {
  it('raises once, stays quiet while it persists, and announces when it clears', async () => {
    failures(4, 6);
    expect(await mgr.tick()).toEqual({ raised: 1, resolved: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.event).toBe('raised');
    expect(sent[0]!.alert).toMatchObject({ key: 'workflow-failing:pay', severity: 'warning', tenant: 'default' });
    expect(sent[0]!.alert.message).toContain('4 of 6 runs failed');
    expect(sent[0]!.alert.message).toContain('BOOM');

    s.clock.advance(5 * MIN);
    expect(await mgr.tick()).toEqual({ raised: 0, resolved: 0 });
    expect(sent).toHaveLength(1);
    expect(mgr.active('default').map((a) => a.key)).toEqual(['workflow-failing:pay']);

    s.clock.advance(40 * MIN); // the failures leave the look-back window
    expect(await mgr.tick()).toEqual({ raised: 0, resolved: 1 });
    expect(sent.map((x) => x.event)).toEqual(['raised', 'resolved']);
    expect(mgr.active('default')).toEqual([]);
    expect(s.events.list({ tenant: 'default', types: ['alert.raised', 'alert.resolved'] }).map((e) => e.type)).toEqual(['alert.raised', 'alert.resolved']);
  });

  it('is critical when almost everything fails, and silent when there is too little to judge', async () => {
    failures(5, 5);
    await mgr.tick();
    expect(sent[0]!.alert.severity).toBe('critical');

    const quiet = makeState();
    publish(quiet, 'pay', [echo('charge')]);
    addRun(quiet, { workflow: 'pay', status: 'failed', steps: { charge: bad() } });
    addRun(quiet, { workflow: 'pay', status: 'failed', steps: { charge: bad() } });
    const m2 = new AlertManager({ state: quiet, clock: quiet.clock });
    expect(await m2.tick()).toEqual({ raised: 0, resolved: 0 });
  });

  it('ignores dry runs', async () => {
    for (let i = 0; i < 10; i++) addRun(s, { workflow: 'pay', status: 'failed', dryRun: true, steps: { charge: bad() } });
    expect(await mgr.tick()).toEqual({ raised: 0, resolved: 0 });
  });

  it('reminds about a persisting alert only after the renotify interval', async () => {
    mgr = make({ config: { renotifyMs: 60 * MIN, failureWindowMs: 24 * 60 * MIN, auditVerifyEveryMs: 0 } });
    failures(4, 6);
    await mgr.tick();
    s.clock.advance(30 * MIN);
    await mgr.tick();
    expect(sent).toHaveLength(1);
    s.clock.advance(31 * MIN);
    await mgr.tick();
    expect(sent.map((x) => x.event)).toEqual(['raised', 'reminder']);
    s.clock.advance(10 * MIN);
    await mgr.tick();
    expect(sent).toHaveLength(2);
  });
});

describe('other conditions', () => {
  it('approvals that wait past the SLA', async () => {
    const run = addRun(s, { workflow: 'pay', status: 'running', steps: { charge: { status: 'waiting-approval' } } });
    s.approvals.create({ tenant: 'default', runId: run, stepId: 'gate', workflowName: 'pay', message: 'ok?', approvers: { roles: ['approver'], users: [] }, expiresAt: new Date(s.clock.now().getTime() + 86_400_000).toISOString(), onTimeout: 'deny', allowSelf: false });
    await mgr.tick();
    expect(mgr.active('default')).toEqual([]);
    s.clock.advance(61 * MIN);
    await mgr.tick();
    expect(mgr.active('default')[0]).toMatchObject({ key: 'approvals-waiting', severity: 'warning' });
    expect(mgr.active('default')[0]!.message).toContain('pay › gate');
    s.approvals.decide(s.approvals.list({ tenant: 'default' })[0]!.id, 'approved', 'usr_y');
    expect((await mgr.tick()).resolved).toBe(1);
  });

  it('stalled runs — but not runs that are legitimately waiting or executing', async () => {
    addRun(s, { workflow: 'pay', status: 'running', steps: { charge: { status: 'succeeded', attempt: 1 } }, stepIds: ['charge', 'next'] });
    const waiting = addRun(s, { workflow: 'pay', status: 'running', stepIds: ['a', 'b'], steps: { a: { status: 'succeeded', attempt: 1 }, b: { status: 'waiting-event', waitEvent: 'x' } } });
    expect(waiting).toBeTruthy();
    s.clock.advance(45 * MIN);
    await mgr.tick();
    const active = mgr.active('default');
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ key: 'runs-stalled:pay', severity: 'critical' });
    expect(active[0]!.title).toBe('pay has 1 stalled run');
  });

  it('a backed-up queue', async () => {
    addRun(s, { workflow: 'pay', status: 'queued', stepIds: ['charge'] });
    await mgr.tick();
    expect(mgr.active('default')).toEqual([]);
    s.clock.advance(6 * MIN);
    await mgr.tick();
    expect(mgr.active('default')[0]).toMatchObject({ key: 'queue-backlog' });
  });

  it('open circuit breakers are reported once, under the default tenant only', async () => {
    s.identity.ensureTenant('t2', 'Two');
    circuits = { 'http-request': { state: 'open' }, 'util-echo': { state: 'closed' } };
    await mgr.tick();
    expect(sent.map((x) => [x.alert.tenant, x.alert.key])).toEqual([['default', 'circuit-open:http-request']]);
    circuits = { 'http-request': { state: 'closed' } };
    await mgr.tick();
    expect(sent.map((x) => x.event)).toEqual(['raised', 'resolved']);
  });

  it('raises a critical alert if the audit hash chain is broken — and keeps it until the chain is repaired', async () => {
    for (let i = 0; i < 4; i++) s.events.append({ tenant: 'default', type: 'system.started', data: { i } });
    s.db.exec('DROP TRIGGER events_no_update');
    s.db.run(`UPDATE events SET data = '{"evil":true}' WHERE seq = 2`);
    await mgr.tick();
    const a = mgr.active('default').find((x) => x.key === 'audit-integrity')!;
    expect(a.severity).toBe('critical');
    expect(a.message).toContain('security incident');
    // not re-verified on this tick (rare check) — the alert must not flap
    mgr = make({ config: { auditVerifyEveryMs: 60 * MIN } });
    mgr.restore();
    s.clock.advance(1 * MIN);
    await mgr.tick();
    expect(mgr.active('default').some((x) => x.key === 'audit-integrity')).toBe(true);
  });
});

describe('robustness', () => {
  it('a failing notifier never stops alerting or loses the alert', async () => {
    mgr = make({ notify: async () => Promise.reject(new Error('slack is down')) });
    failures(4, 6);
    expect(await mgr.tick()).toEqual({ raised: 1, resolved: 0 });
    expect(mgr.active('default')).toHaveLength(1);
    expect(s.events.list({ tenant: 'default', types: ['alert.raised'] })).toHaveLength(1);
  });

  it('remembers open alerts across a restart: no repeat notification, and it still resolves', async () => {
    failures(4, 6);
    await mgr.tick();
    expect(sent).toHaveLength(1);

    const restarted = make();
    restarted.restore();
    expect(restarted.active('default').map((a) => a.key)).toEqual(['workflow-failing:pay']);
    s.clock.advance(5 * MIN);
    await restarted.tick();
    expect(sent).toHaveLength(1);
    s.clock.advance(40 * MIN);
    await restarted.tick();
    expect(sent.map((x) => x.event)).toEqual(['raised', 'resolved']);
    expect(restarted.active('default')).toEqual([]);
    expect(restarted.history('default').map((h) => h.event)).toEqual(['resolved', 'raised']);
  });

  it('overlapping ticks do not double-report', async () => {
    failures(4, 6);
    const [a, b] = await Promise.all([mgr.tick(), mgr.tick()]);
    expect(a.raised + b.raised).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('formats alerts for chat channels without leaking anything but the message', () => {
    const alert: Alert = { tenant: 'default', key: 'k', severity: 'critical', title: 'pay is failing', message: '4 of 6 runs failed.', raisedAt: '', lastNotifiedAt: '' };
    expect(formatAlert(alert, 'raised')).toBe('[CRITICAL] pay is failing\n4 of 6 runs failed.\n(OmniFlow, tenant default)');
    expect(formatAlert(alert, 'resolved')).toBe('[RESOLVED] pay is failing\n(OmniFlow, tenant default)');
    expect(formatAlert(alert, 'reminder')).toContain('[STILL CRITICAL]');
  });
});

describe('dashboard overview', () => {
  it('summarises the last day of runs', () => {
    publish(s, 'report', [echo('a'), echo('b', 1, { dependsOn: ['a'] })]);
    for (let i = 0; i < 8; i++) addRun(s, { workflow: 'pay', durationMs: 1000 * (i + 1), cost: 2, steps: { charge: ok({ cost: 2 }) } });
    for (let i = 0; i < 2; i++) addRun(s, { workflow: 'pay', status: 'failed', steps: { charge: bad('CARD_DECLINED', 'business') } });
    addRun(s, { workflow: 'report', status: 'cancelled', steps: { a: ok() } });
    addRun(s, { workflow: 'report', status: 'queued', stepIds: ['a', 'b'] });
    const run = addRun(s, { workflow: 'report', status: 'running', stepIds: ['a', 'b'], steps: { a: ok() } });
    s.approvals.create({ tenant: 'default', runId: run, stepId: 'gate', workflowName: 'report', message: 'ok?', approvers: { roles: [], users: [] }, expiresAt: new Date(s.clock.now().getTime() + 86_400_000).toISOString(), onTimeout: 'deny', allowSelf: false });
    addRun(s, { workflow: 'pay', dryRun: true, status: 'failed', steps: { charge: bad() } }); // must not count

    const o = buildOverview(s, 'default');
    expect(o.runs).toMatchObject({ total: 13, succeeded: 8, failed: 2, cancelled: 1, active: 1, queued: 1 });
    expect(o.runs.successRate).toBeCloseTo(0.8);
    expect(o.latencyMs.p50).not.toBeNull();
    expect(o.latencyMs.p95).toBeGreaterThanOrEqual(o.latencyMs.p50!);
    expect(o.approvals.pending).toBe(1);
    expect(o.manualInterventionRate).toBeCloseTo(1 / 13);
    expect(o.cost.total).toBe(16);
    expect(o.workflows.map((w) => [w.name, w.runs, w.failed])).toEqual([['pay', 10, 2], ['report', 3, 0]]);
    expect(o.workflows[0]).toMatchObject({ successRate: 0.8 });
    expect(o.failingSteps).toEqual([{ workflow: 'pay', stepId: 'charge', failed: 2, executions: 10, topError: 'CARD_DECLINED' }]);
    expect(o.hourly).toHaveLength(24);
    expect(o.hourly.reduce((n, h) => n + h.succeeded + h.failed + h.other, 0)).toBe(13);
    expect(o.queue.depth).toBe(1);
  });

  it('handles an empty system', () => {
    const o = buildOverview(makeState(), 'default');
    expect(o.runs).toMatchObject({ total: 0, successRate: null });
    expect(o.latencyMs).toEqual({ p50: null, p95: null });
    expect(o.manualInterventionRate).toBeNull();
    expect(o.workflows).toEqual([]);
  });

  it('is scoped to one tenant', () => {
    addRun(s, { workflow: 'pay', steps: { charge: ok() } });
    s.identity.ensureTenant('t2', 'Two');
    expect(buildOverview(s, 't2').runs.total).toBe(0);
  });
});
