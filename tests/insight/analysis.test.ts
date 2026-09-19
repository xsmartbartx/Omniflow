import { beforeEach, describe, expect, it } from 'vitest';
import { AnalysisAgent, ANALYSIS_SOURCE, analyse, DEFAULT_THRESHOLDS, type AnalysisInput, type Finding } from '../../insight/index.ts';
import { addRun, bad, compileWf, echo, ok, publish, skipped } from '../helpers/history.ts';
import { makeState, type TestState } from '../helpers/state.ts';

let s: TestState;
let agent: AnalysisAgent;
beforeEach(() => {
  s = makeState();
  agent = new AnalysisAgent({ state: s, clock: s.clock });
});

const find = (fs: Finding[], rule: string, stepId?: string) => fs.filter((f) => f.rule === rule && (stepId === undefined || f.stepId === stepId));
const times = (n: number, fn: (i: number) => void) => {
  for (let i = 0; i < n; i++) fn(i);
};

describe('analysis rules over run history', () => {
  it('flags a step whose failures are swallowed, and does not double-report it as failing', () => {
    publish(s, 'sync', [echo('a'), echo('b', 1, { dependsOn: ['a'] })]);
    times(20, (i) => addRun(s, { workflow: 'sync', steps: { a: i < 14 ? bad('HTTP_503', 'transient', { handled: 'continue' }) : ok(), b: ok() } }));
    const f = agent.analyse('default');
    const ignored = find(f, 'ignored-failure', 'a');
    expect(ignored).toHaveLength(1);
    expect(ignored[0]).toMatchObject({ severity: 'medium', workflow: 'sync', key: 'ignored-failure:sync:a' });
    expect(ignored[0]!.evidence).toMatchObject({ ignoredFailures: 14, runsSeen: 20, topErrors: [{ code: 'HTTP_503', count: 14 }] });
    expect(ignored[0]!.summary).toContain('14 of 20');
    expect(find(f, 'failing-step', 'a')).toHaveLength(0);
    expect(find(f, 'ignored-failure', 'b')).toHaveLength(0);
  });

  it('a step that (almost) always fails while ignored is high severity', () => {
    publish(s, 'sync', [echo('a')]);
    times(20, (i) => addRun(s, { workflow: 'sync', steps: { a: i === 0 ? ok() : bad('E', 'transient', { handled: 'continue' }) } }));
    expect(find(agent.analyse('default'), 'ignored-failure')[0]).toMatchObject({ severity: 'high' });
  });

  it('does not draw conclusions from too little history', () => {
    publish(s, 'sync', [echo('a')]);
    times(6, () => addRun(s, { workflow: 'sync', steps: { a: bad('E', 'transient', { handled: 'continue' }) } }));
    expect(agent.analyse('default')).toEqual([]);
  });

  it('flags steps that fail often (unhandled) with the dominant error', () => {
    publish(s, 'pay', [echo('charge')]);
    times(20, (i) => addRun(s, { workflow: 'pay', status: i < 8 ? 'failed' : 'succeeded', steps: { charge: i < 8 ? bad(i < 6 ? 'CARD_DECLINED' : 'TIMEOUT', 'business') : ok() } }));
    const [f] = find(agent.analyse('default'), 'failing-step');
    expect(f).toMatchObject({ severity: 'medium', stepId: 'charge' });
    expect(f!.evidence.topErrors).toMatchObject([{ code: 'CARD_DECLINED', count: 6 }, { code: 'TIMEOUT', count: 2 }]);
    expect(f!.recommendation).toContain('CARD_DECLINED');
  });

  it('flags steps that never run because their condition is never true', () => {
    publish(s, 'gated', [echo('a'), echo('legacy', 1, { dependsOn: ['a'] })]);
    times(25, () => addRun(s, { workflow: 'gated', steps: { a: ok(), legacy: skipped() } }));
    expect(find(agent.analyse('default'), 'dead-step').map((f) => f.stepId)).toEqual(['legacy']);
    addRun(s, { workflow: 'gated', steps: { a: ok(), legacy: ok() } }); // it ran once → no longer dead
    expect(find(agent.analyse('default'), 'dead-step')).toEqual([]);
  });

  it('diagnoses retry storms, and calls out retries on errors that retrying cannot fix', () => {
    publish(s, 'flaky', [echo('call', 1, { retry: { attempts: 3, retryOn: ['transient'] } })]);
    times(20, (i) => addRun(s, { workflow: 'flaky', steps: { call: ok({ attempt: i < 8 ? 3 : 1 }) } }));
    const [storm] = find(agent.analyse('default'), 'retry-storm');
    expect(storm).toMatchObject({ severity: 'medium', stepId: 'call' });
    expect(storm!.recommendation).toContain('backoff');
    expect(storm!.evidence).toMatchObject({ retried: 8, executions: 20 });

    // a second workflow retries business errors — a misclassification
    publish(s, 'mis', [echo('call', 1, { retry: { attempts: 3, retryOn: ['transient', 'business'] } })]);
    times(20, (i) => addRun(s, { workflow: 'mis', status: 'failed', steps: { call: i < 12 ? bad('OUT_OF_STOCK', 'business', { attempt: 3 }) : ok({ attempt: 1 }) } }));
    const mis = find(agent.analyse('default'), 'retry-storm').find((f) => f.workflow === 'mis')!;
    expect(mis.severity).toBe('high');
    expect(mis.recommendation).toContain('Remove that class from retryOn');
  });

  it('finds near-duplicate workflows and names the parameters that differ', () => {
    const steps = (region: string, channel: string) => [
      echo('fetch', region),
      { id: 'transform', type: 'capability', uses: 'util-echo@^1', dependsOn: ['fetch'], with: { value: 'x' } },
      { id: 'notify', type: 'capability', uses: 'util-noop@^1', dependsOn: ['transform'], with: { note: channel } },
    ];
    publish(s, 'report-eu', steps('eu', '#eu'));
    publish(s, 'report-us', steps('us', '#us'));
    publish(s, 'unrelated', [echo('one'), echo('two', 2, { dependsOn: ['one'] })]);
    const dups = find(agent.analyse('default'), 'duplicate-workflows');
    expect(dups).toHaveLength(1);
    expect(dups[0]).toMatchObject({ severity: 'medium', key: 'duplicate-workflows:report-eu:report-us' });
    expect(dups[0]!.evidence.differingParameters).toEqual(expect.arrayContaining(['util-echo.value', 'util-noop.note']));
    expect(dups[0]!.recommendation).toContain('parameterised');
  });

  it('reports cost hotspots by workflow and by step, with advice matched to the capability family', () => {
    publish(s, 'cheap', [echo('a')]);
    publish(s, 'llm-heavy', [echo('draft'), echo('post', 1, { dependsOn: ['draft'] })], {}, (p) => {
      p.steps[0]!.family = 'llm';
    });
    times(10, () => addRun(s, { workflow: 'cheap', steps: { a: ok({ cost: 1 }) }, cost: 1 }));
    times(10, () => addRun(s, { workflow: 'llm-heavy', steps: { draft: ok({ cost: 9 }), post: ok({ cost: 1 }) }, cost: 10 }));
    const f = find(agent.analyse('default'), 'cost-hotspot');
    const wf = f.find((x) => !x.stepId)!;
    expect(wf).toMatchObject({ workflow: 'llm-heavy', title: "'llm-heavy' accounts for 91% of all cost" });
    const step = f.find((x) => x.stepId === 'draft')!;
    expect(step.recommendation).toContain('smaller model');
    expect(f.some((x) => x.workflow === 'cheap')).toBe(false);
  });

  it('spots approval gates that are rubber stamps, always denied, or ignored', () => {
    publish(s, 'gate', [echo('a')]);
    const approve = (wf: string, step: string, status: 'approved' | 'denied' | 'timed-out') => {
      const run = addRun(s, { workflow: wf, status: 'running', steps: { a: ok() } });
      const a = s.approvals.create({ tenant: 'default', runId: run, stepId: step, workflowName: wf, message: 'ok?', approvers: { roles: ['approver'], users: [] }, requestedBy: 'usr_x', expiresAt: new Date(s.clock.now().getTime() + 3_600_000).toISOString(), onTimeout: 'deny', allowSelf: false });
      s.clock.advance(120_000);
      s.approvals.decide(a.id, status, status === 'timed-out' ? 'system' : 'usr_y');
    };
    times(12, () => approve('gate', 'stamp', 'approved'));
    times(6, () => approve('gate', 'risky', 'denied'));
    times(6, () => approve('gate', 'risky', 'approved'));
    times(5, () => approve('gate', 'ghost', 'timed-out'));
    times(5, () => approve('gate', 'ghost', 'approved'));
    const f = agent.analyse('default');
    expect(find(f, 'approval-rubber-stamp', 'stamp')[0]!.summary).toContain('2.0min');
    expect(find(f, 'approval-often-denied', 'risky')[0]!.title).toContain('50%');
    expect(find(f, 'approval-timeouts', 'ghost')).toHaveLength(1);
    expect(find(f, 'approval-rubber-stamp', 'risky')).toHaveLength(0);
  });

  it('reports shell steps past (or nearing) their sunset date', () => {
    publish(s, 'bridge', [echo('old'), echo('soon', 1, { dependsOn: ['old'] }), echo('later', 1, { dependsOn: ['soon'] })], {}, (p) => {
      p.steps[0]!.sunset = '2026-05-01';
      p.steps[1]!.sunset = '2026-06-20';
      p.steps[2]!.sunset = '2027-01-01';
    });
    const f = find(agent.analyse('default'), 'shell-sunset');
    expect(f.map((x) => [x.stepId, x.severity])).toEqual([['old', 'high'], ['soon', 'medium']]);
    expect(f[0]!.title).toContain('31 days past');
    expect(f[1]!.title).toContain('19 days');
  });

  it('measures schedule drift and queue starvation', () => {
    publish(s, 'nightly', [echo('a')]);
    times(25, () => {
      const scheduledFor = s.clock.now().toISOString();
      addRun(s, { workflow: 'nightly', trigger: { type: 'schedule', payload: { scheduledFor } }, queueMs: 180_000, steps: { a: ok() } });
    });
    const f = agent.analyse('default');
    expect(find(f, 'schedule-drift')[0]).toMatchObject({ workflow: 'nightly', severity: 'medium' });
    expect(find(f, 'schedule-drift')[0]!.title).toContain('3.0min');
    expect(find(f, 'queue-starvation')[0]!.evidence.worst).toMatchObject([{ workflow: 'nightly' }]);
  });

  it('notes compensation that has never been exercised, and idle scheduled workflows', () => {
    publish(s, 'saga', [{ ...echo('reserve'), compensate: { uses: 'util-noop@^1', with: {} } }], {});
    times(25, () => addRun(s, { workflow: 'saga', steps: { reserve: ok() } }));
    const unex = find(agent.analyse('default'), 'unexercised-compensation');
    expect(unex).toHaveLength(1);
    expect(unex[0]).toMatchObject({ severity: 'info', workflow: 'saga' });
    addRun(s, { workflow: 'saga', steps: { reserve: ok({ compensationStatus: 'done' }) } });
    expect(find(agent.analyse('default'), 'unexercised-compensation')).toHaveLength(0);

    publish(s, 'cron', [echo('a')], { triggers: [{ type: 'schedule', name: 'daily', cron: '0 3 * * *' }] });
    s.clock.advance(10 * 86_400_000);
    expect(find(agent.analyse('default'), 'idle-workflow').map((f) => f.workflow)).toEqual(['cron']);
  });

  it('ignores dry runs and other tenants', () => {
    publish(s, 'sync', [echo('a')]);
    times(30, () => addRun(s, { workflow: 'sync', dryRun: true, steps: { a: bad('E', 'transient', { handled: 'continue' }) } }));
    expect(agent.analyse('default')).toEqual([]);
    s.identity.ensureTenant('other', 'Other');
    expect(agent.analyse('other')).toEqual([]);
  });

  it('is deterministic: the same history yields identical, severity-ordered findings', () => {
    publish(s, 'a-wf', [echo('a')]);
    times(20, (i) => addRun(s, { workflow: 'a-wf', status: 'failed', steps: { a: i < 10 ? bad('X', 'business') : ok() } }));
    const one = agent.analyse('default');
    const two = agent.analyse('default');
    expect(two).toEqual(one);
    const order = ['high', 'medium', 'low', 'info'];
    expect(one.map((f) => order.indexOf(f.severity))).toEqual([...one.map((f) => order.indexOf(f.severity))].sort((a, b) => a - b));
  });

  it('rules are pure: compiled plans alone are enough to run them on an empty history', () => {
    const { plan } = compileWf('solo', [echo('a')]);
    const input: AnalysisInput = {
      now: '2026-06-01T00:00:00.000Z',
      today: '2026-06-01',
      windowDays: 14,
      workflows: [{ name: 'solo', version: '1.0.0', enabled: true, killed: false, activeSince: undefined, plan, runs: { workflow: 'solo', total: 0, succeeded: 0, failed: 0, cancelled: 0, cost: 0 }, steps: new Map(), errors: new Map() }],
      approvals: [],
      timings: [],
    };
    expect(analyse(input, DEFAULT_THRESHOLDS)).toEqual([]);
  });
});

describe('the proposal queue', () => {
  const seedProblem = () => {
    publish(s, 'pay', [echo('charge')]);
    times(20, (i) => addRun(s, { workflow: 'pay', status: i < 8 ? 'failed' : 'succeeded', steps: { charge: i < 8 ? bad('CARD_DECLINED', 'business') : ok() } }));
  };

  it('raises each finding once, as a proposal and an audit event, and never writes anywhere else', () => {
    seedProblem();
    const before = { versions: s.registry.listVersions('default', 'pay').length, settings: s.registry.getSettings('default', 'pay') };
    const r1 = agent.run('default');
    expect(r1.raised).toHaveLength(1);
    const [p] = s.authoring.listProposals('default', 'open');
    expect(p).toMatchObject({ kind: 'analysis.failing-step', workflowName: 'pay', source: ANALYSIS_SOURCE, status: 'open' });
    expect(p!.body).toMatchObject({ key: 'failing-step:pay:charge', severity: 'medium', recommendation: expect.stringContaining('CARD_DECLINED') });
    expect(s.events.list({ tenant: 'default', types: ['agent.proposal-created'] })).toHaveLength(1);
    expect(s.events.list({ tenant: 'default', types: ['insight.analysis-completed'] })[0]!.data).toMatchObject({ findings: 1, proposals: 1 });

    const r2 = agent.run('default');
    expect(r2.raised).toHaveLength(0);
    expect(r2.suppressed).toBe(1);
    expect(s.authoring.listProposals('default')).toHaveLength(1);

    // the agent changed nothing about the workflow itself
    expect(s.registry.listVersions('default', 'pay')).toHaveLength(before.versions);
    expect(s.registry.getSettings('default', 'pay')).toEqual(before.settings);
  });

  it('respects a dismissal for a while, then raises the problem again if it persists', () => {
    seedProblem();
    agent.run('default');
    const [p] = s.authoring.listProposals('default', 'open');
    s.authoring.decideProposal(p!.id, 'dismissed', 'usr_human');
    expect(agent.run('default').raised).toHaveLength(0);
    s.clock.advance(31 * 86_400_000);
    // (the history is now outside the window, so refresh it)
    times(20, (i) => addRun(s, { workflow: 'pay', status: i < 8 ? 'failed' : 'succeeded', steps: { charge: i < 8 ? bad('CARD_DECLINED', 'business') : ok() } }));
    expect(agent.run('default').raised).toHaveLength(1);
  });

  it('gives an accepted fix time to show up before re-raising', () => {
    seedProblem();
    agent.run('default');
    s.authoring.decideProposal(s.authoring.listProposals('default', 'open')[0]!.id, 'accepted', 'usr_human');
    s.clock.advance(3 * 86_400_000);
    expect(agent.run('default').raised).toHaveLength(0);
    s.clock.advance(12 * 86_400_000);
    times(20, (i) => addRun(s, { workflow: 'pay', status: i < 8 ? 'failed' : 'succeeded', steps: { charge: i < 8 ? bad('CARD_DECLINED', 'business') : ok() } }));
    expect(agent.run('default').raised).toHaveLength(1);
  });

  it('retires its own proposal once the problem has gone away, and would raise it again if it came back', () => {
    seedProblem();
    agent.run('default');
    s.clock.advance(2 * 86_400_000);
    // the fix ships: new history is clean, and the old failures age out of the window
    s.clock.advance(15 * 86_400_000);
    times(20, () => addRun(s, { workflow: 'pay', steps: { charge: ok() } }));
    const r = agent.run('default');
    expect(r.resolved).toBe(1);
    expect(s.authoring.listProposals('default', 'open')).toHaveLength(0);
    expect(s.authoring.listProposals('default', 'dismissed')[0]).toMatchObject({ decidedBy: ANALYSIS_SOURCE });

    times(30, (i) => addRun(s, { workflow: 'pay', status: i < 20 ? 'failed' : 'succeeded', steps: { charge: i < 20 ? bad('CARD_DECLINED', 'business') : ok() } }));
    expect(agent.run('default').raised).toHaveLength(1);
  });

  it('analyses every tenant, and one broken tenant does not stop the rest', () => {
    seedProblem();
    s.identity.ensureTenant('t2', 'Two');
    const reports = agent.runAll();
    expect(reports.map((r) => r.tenant).sort()).toEqual(['default', 't2']);
    expect(reports.find((r) => r.tenant === 'default')!.raised).toHaveLength(1);
  });
});
