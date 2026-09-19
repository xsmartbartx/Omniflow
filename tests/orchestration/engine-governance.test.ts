import { afterEach, describe, expect, it } from 'vitest';
import { echo, type Engine, fastRetry, makeEngine, wf } from '../helpers/engine.ts';

let e: Engine;
const engines: Engine[] = [];
const track = (x: Engine) => {
  engines.push(x);
  return x;
};
afterEach(async () => {
  for (const x of engines.splice(0)) await x.orch.stop();
});

const until = async (fn: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('condition not reached in time');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const gate = (extra: Record<string, unknown> = {}) => ({ id: 'gate', type: 'approval', message: 'Approve ${{ inputs.what }}?', timeout: '5s', onTimeout: 'deny', ...extra });
const gated = (extra: Record<string, unknown> = {}) =>
  wf([gate(extra), echo('after', 'released', { dependsOn: ['gate'] })], { inputs: { what: { type: 'string', default: 'the thing' } }, outputs: { by: '${{ steps.gate.output.by }}', v: '${{ steps.after.output.value }}' } });

describe('approvals (human-in-the-loop)', () => {
  it('suspends the run, records the request, and resumes on approval', async () => {
    e = track(makeEngine());
    const requested: string[] = [];
    e.orch.on('approval-requested', (a) => requested.push(a.message));
    e.publish(gated());
    const run = await e.run('wf', {}, { wait: false });
    await e.orch.waitForRun(run.id, 3000, (r) => r.status === 'waiting-approval');
    expect(requested).toEqual(['Approve the thing?']);
    expect(e.step(run.id, 'after')!.status).toBe('pending'); // nothing past the gate has run

    const [a] = e.state.approvals.list({ tenant: 'default', status: 'pending' });
    expect(a).toMatchObject({ runId: run.id, stepId: 'gate', message: 'Approve the thing?', approvers: { roles: ['approver'], users: [] } });
    e.state.approvals.decide(a!.id, 'approved', 'usr_approver', 'looks fine');
    e.orch.resolveApproval(a!.id);

    const done = await e.orch.waitForRun(run.id);
    expect(done.status).toBe('succeeded');
    expect(done.outputs).toEqual({ by: 'usr_approver', v: 'released' });
    const t = e.types(run.id);
    expect(t).toEqual(expect.arrayContaining(['approval.requested', 'run.waiting', 'run.resumed', 'run.succeeded']));
  });

  it('a denial fails the step (a business outcome) and the run', async () => {
    e = track(makeEngine());
    e.publish(gated());
    const run = await e.run('wf', {}, { wait: false });
    await e.orch.waitForRun(run.id, 3000, (r) => r.status === 'waiting-approval');
    const [a] = e.state.approvals.list({ tenant: 'default', status: 'pending' });
    e.state.approvals.decide(a!.id, 'denied', 'usr_approver', 'not today');
    e.orch.resolveApproval(a!.id);
    const done = await e.orch.waitForRun(run.id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatchObject({ code: 'APPROVAL_DENIED', class: 'business' });
    expect(done.error!.message).toContain('not today');
    expect(e.step(run.id, 'after')!.status).toBe('skipped');
  });

  it('timeout with deny policy fails the run', async () => {
    e = track(makeEngine());
    e.publish(gated({ timeout: '100ms', onTimeout: 'deny' }));
    const done = await e.run('wf');
    expect(done.status).toBe('failed');
    expect(done.error).toMatchObject({ code: 'APPROVAL_TIMEOUT' });
    expect(e.types(done.id)).toContain('approval.timed-out');
    expect(e.state.approvals.list({ tenant: 'default' })[0]).toMatchObject({ status: 'timed-out', decidedBy: 'system:timeout' });
  });

  it('timeout with approve-by-default (justified) releases the run and says so', async () => {
    e = track(makeEngine());
    e.publish(gated({ timeout: '100ms', onTimeout: 'approve', justification: 'low risk, reviewed daily' }));
    const done = await e.run('wf');
    expect(done.status).toBe('succeeded');
    expect(e.events(done.id).find((x) => x.type === 'approval.timed-out')!.data.outcome).toBe('approved');
    expect(e.step(done.id, 'gate')!.output).toMatchObject({ decision: 'approved', timedOut: true, by: 'system:timeout' });
  });

  it('escalates once, then denies', async () => {
    e = track(makeEngine());
    const requested: number[] = [];
    e.orch.on('approval-requested', () => requested.push(Date.now()));
    e.publish(gated({ timeout: '120ms', onTimeout: 'escalate' }));
    const done = await e.run('wf');
    expect(done.status).toBe('failed');
    expect(e.types(done.id)).toContain('approval.escalated');
    expect(requested).toHaveLength(2); // the original request and the escalation notice
    expect(e.state.approvals.list({ tenant: 'default' })[0]).toMatchObject({ escalated: true, status: 'timed-out' });
  });

  it('ignores a decision for a step that is no longer waiting', async () => {
    e = track(makeEngine());
    e.publish(gated());
    const run = await e.run('wf', {}, { wait: false });
    await e.orch.waitForRun(run.id, 3000, (r) => r.status === 'waiting-approval');
    const [a] = e.state.approvals.list({ tenant: 'default', status: 'pending' });
    e.orch.cancelRun(run.id, { id: 'u' });
    await e.orch.waitForRun(run.id);
    expect(() => e.orch.resolveApproval(a!.id)).not.toThrow();
    expect(e.state.runs.getRun(run.id)!.status).toBe('cancelled');
  });
});

describe('subworkflows (version-pinned)', () => {
  const child = () =>
    wf([echo('hi', 'hello ${{ inputs.who }}')], { inputs: { who: { type: 'string', required: true } }, outputs: { greeting: '${{ steps.hi.output.value }}' } }, 'child');
  const parent = (extra: Record<string, unknown> = {}) =>
    wf(
      [{ id: 'sub', type: 'subworkflow', workflow: 'child', version: '1.0.0', with: { who: '${{ inputs.name }}' }, ...extra }],
      { inputs: { name: { type: 'string', required: true } }, outputs: { said: '${{ steps.sub.output.outputs.greeting }}', childRun: '${{ steps.sub.output.runId }}' } },
      'parent',
    );

  it('runs the pinned child version and returns its outputs to the parent', async () => {
    e = track(makeEngine());
    e.publish(child());
    e.publish(parent());
    const run = await e.run('parent', { name: 'Ada' });
    expect(run.status).toBe('succeeded');
    expect(run.outputs).toMatchObject({ said: 'hello Ada' });
    const childRun = e.state.runs.getRun((run.outputs as any).childRun)!;
    expect(childRun).toMatchObject({ workflowName: 'child', status: 'succeeded', parentRunId: run.id, parentStepId: 'sub', triggerType: 'subworkflow' });
    expect(run.planHash).not.toBe(childRun.planHash);
  });

  it('pins the child plan at compile time: a later child version changes nothing for the parent', async () => {
    e = track(makeEngine());
    e.publish(child());
    e.publish(parent());
    const v2 = child();
    v2.metadata.version = '2.0.0';
    v2.steps[0].with.value = 'CHANGED ${{ inputs.who }}';
    e.publish(v2);
    const run = await e.run('parent', { name: 'Ada' });
    expect(run.outputs).toMatchObject({ said: 'hello Ada' });
  });

  it('fails the parent step when the child fails, carrying the child’s error class', async () => {
    e = track(makeEngine());
    e.publish(wf([{ id: 'x', type: 'capability', uses: 'util-fail@^1', retry: { attempts: 1 } }], { inputs: { who: { type: 'string', required: true } } }, 'child'));
    e.publish(parent());
    const run = await e.run('parent', { name: 'Ada' });
    expect(run.status).toBe('failed');
    expect(run.error).toMatchObject({ code: 'SUBWORKFLOW_FAILED', class: 'business' });
    expect((run.error!.details as any).childStatus).toBe('failed');
  });

  it('cancelling the parent cancels a waiting child', async () => {
    e = track(makeEngine());
    e.publish(wf([{ id: 'w', type: 'wait', until: { event: 'never' }, timeout: '1h' }], { inputs: { who: { type: 'string', required: true } } }, 'child'));
    e.publish(parent());
    const run = await e.run('parent', { name: 'Ada' }, { wait: false });
    await until(() => e.state.runs.childrenOf(run.id).some((c) => c.status === 'waiting-event'));
    e.orch.cancelRun(run.id, { id: 'u' });
    expect((await e.orch.waitForRun(run.id)).status).toBe('cancelled');
    const [c] = e.state.runs.childrenOf(run.id);
    expect((await e.orch.waitForRun(c!.id)).status).toBe('cancelled');
  });

  it('a subworkflow can itself be retried by its parent', async () => {
    e = track(makeEngine());
    e.publish(wf([{ id: 'f', type: 'capability', uses: 'sim-flaky@^1', with: { key: 'child-flaky', failTimes: 1 }, retry: { attempts: 1 } }], { inputs: { who: { type: 'string', required: true } } }, 'child'));
    e.publish(parent({ retry: { ...fastRetry(2), retryOn: ['business'] } }));
    // business failures never retry, even when listed — the child failure here is transient-class
    const run = await e.run('parent', { name: 'Ada' });
    expect(run.status).toBe('failed');
  });
});

describe('dry run (shadow mode, ADR-0002 D3)', () => {
  it('never performs an effect, still exercises the path, and reads for real', async () => {
    e = track(makeEngine());
    e.publish(
      wf(
        [
          { id: 'read', type: 'capability', uses: 'sim-flaky@^1', with: { key: 'dry-read', failTimes: 0 } },
          { id: 'charge', type: 'capability', uses: 'sim-effect@^1', dependsOn: ['read'], with: { label: 'real-charge' }, idempotencyKey: 'dry-key' },
          echo('after', '${{ steps.charge.output.id }}', { dependsOn: ['charge'] }),
        ],
        { outputs: { id: '${{ steps.after.output.value }}' } },
      ),
    );
    const run = await e.run('wf', {}, { dryRun: true });
    expect(run.status).toBe('succeeded');
    expect(run.dryRun).toBe(true);
    expect(e.world.calls).toEqual([]); // the effectful adapter was never invoked
    expect(e.world.effects).toEqual([]);
    expect(e.world.attempts.get('dry-read')).toBe(1); // the read-only capability did execute
    expect(e.types(run.id)).toContain('step.dry-run');
    expect(run.outputs).toEqual({ id: '' }); // a schema-valid synthetic result flowed downstream
    expect(e.state.runs.getRun(run.id)!.cost).toBe(1); // only the real read cost anything
    // a dry run must not consume the idempotency key of a later real run
    const real = await e.run('wf');
    expect(e.world.effects).toEqual(['real-charge']);
    expect(real.status).toBe('succeeded');
  });
});

describe('secrets never leak (T3, R10)', () => {
  const TOKEN = 'tok-SECRET-9f8e7d6c5b4a';
  const secretWf = (withExtra: Record<string, unknown> = {}) =>
    wf([{ id: 'call', type: 'capability', uses: 'sim-secret@^1', with: { token: '${{ secrets.API_TOKEN }}', ...withExtra }, retry: { attempts: 1 } }], { outputs: { len: '${{ steps.call.output.length }}' } });

  const dumpEverything = (x: Engine): string => {
    const tables = x.state.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
    return tables.map((t) => `${t.name}: ${JSON.stringify(x.state.db.all(`SELECT * FROM ${t.name}`))}`).join('\n');
  };

  it('hands the adapter the value, but persists it nowhere in plaintext', async () => {
    e = track(makeEngine());
    e.broker.put('default', 'API_TOKEN', TOKEN, 'usr');
    e.publish(secretWf());
    const run = await e.run('wf');
    expect(run.status).toBe('succeeded');
    expect(e.world.secretsSeen).toEqual([TOKEN]); // the adapter really got it
    expect(run.outputs).toEqual({ len: TOKEN.length });
    expect(dumpEverything(e)).not.toContain(TOKEN); // ...but it is in no table, event, plan or output
  });

  it('issues one lease per step and revokes it when the step ends', async () => {
    e = track(makeEngine());
    e.broker.put('default', 'API_TOKEN', TOKEN, 'usr');
    e.publish(secretWf());
    const run = await e.run('wf');
    const t = e.types(run.id);
    expect(t).toContain('secret.lease.issued');
    expect(t).toContain('secret.lease.revoked');
    expect(e.state.secrets.outstandingLeases()).toEqual([]);
    expect(e.events(run.id).find((x) => x.type === 'secret.lease.issued')!.data.names).toEqual(['API_TOKEN']);
  });

  it('scrubs the secret from an adapter error message (error paths too)', async () => {
    e = track(makeEngine());
    e.broker.put('default', 'API_TOKEN', TOKEN, 'usr');
    e.publish(secretWf({ leak: true }));
    const run = await e.run('wf');
    expect(run.status).toBe('failed');
    expect(run.error!.message).toContain('upstream rejected token');
    expect(run.error!.message).not.toContain(TOKEN);
    expect(dumpEverything(e)).not.toContain(TOKEN);
    expect(e.state.secrets.outstandingLeases()).toEqual([]); // revoked on the failure path as well
  });

  it('redacts a credential an adapter echoes back in its output', async () => {
    e = track(makeEngine());
    e.broker.put('default', 'API_TOKEN', TOKEN, 'usr');
    e.publish(wf([{ id: 'call', type: 'capability', uses: 'sim-secret@^1', with: { token: '${{ secrets.API_TOKEN }}', echo: true } }], { outputs: { echoed: '${{ steps.call.output.echoed }}' } }));
    const run = await e.run('wf');
    expect(JSON.stringify(run.outputs)).not.toContain(TOKEN);
    expect(dumpEverything(e)).not.toContain(TOKEN);
  });

  it('fails a step that needs a secret which does not exist, without retrying', async () => {
    e = track(makeEngine());
    e.publish(secretWf());
    const run = await e.run('wf');
    expect(run.status).toBe('failed');
    expect(run.error).toMatchObject({ code: 'SECRET_NOT_FOUND', class: 'contract' });
  });

  it('keeps secrets separate per tenant', async () => {
    e = track(makeEngine());
    e.broker.put('other-tenant', 'API_TOKEN', TOKEN, 'usr');
    e.publish(secretWf());
    expect((await e.run('wf')).error?.code).toBe('SECRET_NOT_FOUND');
  });
});

describe('operator controls and circuit breakers (§12.3)', () => {
  it('a capability kill switch stops steps that use it, and can be lifted', async () => {
    e = track(makeEngine());
    e.publish(wf([{ id: 'svc', type: 'capability', uses: 'sim-flaky@^1', with: { key: 'ks', failTimes: 0 }, retry: fastRetry(3) }]));
    e.state.kv.setCapabilityKilled('default', 'sim-flaky', true, 'usr', 'incident 42');
    const blocked = await e.run('wf');
    expect(blocked.status).toBe('failed');
    expect(blocked.error).toMatchObject({ code: 'CAPABILITY_KILLED', class: 'systemic' });
    expect(blocked.error!.message).toContain('incident 42');
    expect(e.step(blocked.id, 'svc')!.attempt).toBe(1); // not retried: an operator decision, not a fault
    expect(e.world.attempts.get('ks')).toBeUndefined(); // the adapter was never reached
    e.state.kv.setCapabilityKilled('default', 'sim-flaky', false, 'usr');
    expect((await e.run('wf')).status).toBe('succeeded');
  });

  it('a platform-wide kill switch applies to every tenant', async () => {
    e = track(makeEngine());
    e.publish(wf([{ id: 'svc', type: 'capability', uses: 'sim-flaky@^1', with: { key: 'g', failTimes: 0 } }]));
    e.state.kv.setCapabilityKilled('_', 'sim-flaky', true, 'root');
    expect((await e.run('wf')).error?.code).toBe('CAPABILITY_KILLED');
  });

  it('opens the circuit after repeated systemic failures and defers — without spending attempts — until it recovers', async () => {
    e = track(makeEngine());
    // threshold is 3 consecutive failures, cooldown 100ms (see makeEngine)
    e.publish(wf([{ id: 'svc', type: 'capability', uses: 'sim-flaky@^1', with: { key: 'cb', failTimes: 3, errorClass: 'systemic' }, retry: { ...fastRetry(6), retryOn: ['systemic', 'transient'] } }]));
    const run = await e.run('wf');
    expect(run.status).toBe('succeeded');
    expect(e.world.attempts.get('cb')).toBe(4); // 3 failures + 1 probe success — no hammering while open
    expect(e.step(run.id, 'svc')!.attempt).toBe(4); // the deferred dispatch did not consume an attempt
    expect(e.events(run.id).some((x) => x.type === 'step.waiting' && String(x.data.on).includes('circuit open'))).toBe(true);
    expect(e.breakers.snapshot()['sim-flaky']!.state).toBe('closed');
  });

  it('a single tenant’s failing capability does not affect a healthy one', async () => {
    e = track(makeEngine());
    e.publish(wf([{ id: 'bad', type: 'capability', uses: 'sim-flaky@^1', with: { key: 'bad', failTimes: 99, errorClass: 'systemic' }, retry: { attempts: 1 }, onError: 'continue' }, echo('good', 1)]));
    const run = await e.run('wf');
    expect(run.status).toBe('succeeded');
  });
});

describe('event log integrity under a full engine run', () => {
  it('records every step and keeps the hash chain intact', async () => {
    e = track(makeEngine());
    e.publish(wf([echo('a', 1), { id: 'boom', type: 'capability', uses: 'util-fail@^1', dependsOn: ['a'], retry: { attempts: 1 }, onError: 'continue' }, echo('c', 3, { dependsOn: ['boom'] })]));
    const run = await e.run('wf');
    expect(run.status).toBe('succeeded');
    expect(e.state.events.verify('default')).toMatchObject({ ok: true });
    expect(e.state.events.count('default')).toBeGreaterThan(8);
  });

  it('never logs confidential inputs or confidential step outputs', async () => {
    e = track(makeEngine());
    e.publish(
      wf([{ ...echo('id', { ssn: '${{ inputs.ssn }}', name: 'visible' }), sensitivity: 'confidential' }], {
        inputs: { ssn: { type: 'string', required: true, sensitivity: 'confidential' } },
      }),
    );
    const run = await e.run('wf', { ssn: '123-45-6789' });
    const log = JSON.stringify(e.events(run.id));
    expect(log).not.toContain('123-45-6789');
    expect(e.events(run.id)[0]!.data.inputs).toEqual({ ssn: '[REDACTED]' });
    expect(e.events(run.id).find((x) => x.type === 'step.succeeded')!.data.output).toMatchObject({ redacted: true, sensitivity: 'confidential' });
  });
});
