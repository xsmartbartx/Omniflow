import { afterEach, describe, expect, it } from 'vitest';
import { echo, wf } from '../helpers/engine.ts';
import { makePlatform, type Platform, user } from '../helpers/platform.ts';

let p: Platform;
afterEach(async () => {
  await p?.stop();
});

const pure = (name = 'wf', version = '1.0.0', extra: Record<string, unknown> = {}) => {
  const m = wf([echo('a', 1)], extra, name);
  m.metadata.version = version;
  return m;
};
const effectful = (name = 'pay', version = '1.0.0') => {
  const m = wf([{ id: 'charge', type: 'capability', uses: 'sim-effect@^1', with: { label: 'c' }, idempotencyKey: 'k' }], {}, name);
  m.metadata.version = version;
  return m;
};
const slow = (name: string, ms: number, extra: Record<string, unknown> = {}) =>
  wf([{ id: 's', type: 'capability', uses: 'sim-slow@^1', with: { ms } }], { inputs: { n: { type: 'integer', default: 0 } }, ...extra }, name);
const asPublished = (r: ReturnType<Platform['publish']>) => {
  expect(r.status).toBe('published');
  return r as Extract<typeof r, { status: 'published' }>;
};
const trig = (who: Platform['users']['admin'], workflow: string, inputs: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  p.runs.trigger({ principal: who, workflow, inputs, trigger: { type: 'manual' }, ...extra });

describe('publishing and change control', () => {
  it('publishes a low-risk workflow immediately, recording lineage, risk and findings', () => {
    p = makePlatform();
    const r = asPublished(p.publish(p.users.author, pure()));
    expect(r.version).toMatchObject({ name: 'wf', version: '1.0.0', status: 'published', publishedBy: 'usr_author' });
    expect(r.risk.level).toBe('low');
    expect(p.state.registry.getSettings('default', 'wf')).toMatchObject({ stableVersion: '1.0.0', enabled: true, killed: false });
    expect(p.state.events.list({ tenant: 'default', types: ['workflow.published'] })).toHaveLength(1);

    const v2 = asPublished(p.publish(p.users.author, pure('wf', '1.1.0')));
    expect(v2.version.parentVersion).toBe('1.0.0');
  });

  it('rejects invalid manifests with positioned issues', () => {
    p = makePlatform();
    const bad = pure();
    bad.steps[0].uses = 'no-such-capability@^1';
    expect(() => p.publish(p.users.author, bad)).toThrow(/manifest is invalid/);
    try {
      p.publish(p.users.author, bad);
    } catch (e: any) {
      expect(e.issues[0].code).toBe('UNKNOWN_CAPABILITY');
    }
  });

  it('never publishes the same version twice, and versions only move forward', () => {
    p = makePlatform();
    asPublished(p.publish(p.users.author, pure('wf', '1.1.0')));
    expect(() => p.publish(p.users.author, pure('wf', '1.1.0'))).toThrow(/already exists/);
    expect(() => p.publish(p.users.author, pure('wf', '1.0.5'))).toThrow(/must be greater/);
  });

  it('refuses viewers and agents; agents hold no publishing authority (ADR-0002 D4)', () => {
    p = makePlatform();
    expect(() => p.publish(p.users.viewer, pure())).toThrow(/do not permit/);
    const agent = { ...user('agent_planner', ['author', 'admin']), type: 'agent' as const };
    try {
      p.publish(agent, pure());
      expect.unreachable();
    } catch (e: any) {
      expect(e.code).toBe('AGENT_NO_EXECUTION');
    }
  });

  it('blocks publication while the pentest review has blocking findings', () => {
    p = makePlatform();
    const m = pure();
    m.steps[0].with.value = 'AKIAIOSFODNN7EXAMPLE'; // a credential written into the manifest
    try {
      p.publish(p.users.admin, m);
      expect.unreachable();
    } catch (e: any) {
      expect(e.code).toBe('BLOCKING_FINDINGS');
    }
    expect(p.state.registry.listVersions('default', 'wf')).toHaveLength(0);
  });

  it('opens a change request for effectful production workflows and publishes once approved (four-eyes)', () => {
    p = makePlatform();
    const r = p.publish(p.users.admin, effectful());
    expect(r.status).toBe('pending-approval');
    if (r.status !== 'pending-approval') return;
    expect(r.decision.reasonCode).toBe('PROD_EFFECTFUL_NEEDS_APPROVAL');
    expect(p.state.registry.getVersion('default', 'pay', '1.0.0')).toBeUndefined();

    // the requester cannot approve their own change
    expect(() => p.registry.approveChange(p.users.admin, r.change.id)).toThrow(/cannot be approved by the person who requested it/);
    // a role without the permission cannot either
    expect(() => p.registry.approveChange(p.users.author, r.change.id)).toThrow(/do not permit/);

    const done = p.registry.approveChange(p.users.approver, r.change.id, 'reviewed the idempotency key');
    expect(done.change.status).toBe('published');
    expect(done.published).toMatchObject({ name: 'pay', version: '1.0.0', publishedBy: 'usr_admin' });
    expect((done.published!.approval as any).approvals[0]).toMatchObject({ by: 'usr_approver', comment: 'reviewed the idempotency key' });
    expect(p.state.events.list({ tenant: 'default', types: ['workflow.change-requested', 'workflow.change-approved', 'workflow.published'] })).toHaveLength(3);
  });

  it('can require several distinct approvers', () => {
    p = makePlatform({ policy: { publishApprovals: 2 } });
    const r = p.publish(p.users.admin, effectful());
    if (r.status !== 'pending-approval') throw new Error('expected a change request');
    const first = p.registry.approveChange(p.users.approver, r.change.id);
    expect(first.change.status).toBe('pending');
    expect(first.published).toBeUndefined();
    expect(() => p.registry.approveChange(p.users.approver, r.change.id)).toThrow(/already approved/);
    const second = p.registry.approveChange(p.users.approver2, r.change.id);
    expect(second.published).toBeDefined();
  });

  it('supports rejecting and withdrawing changes', () => {
    p = makePlatform();
    const r = p.publish(p.users.admin, effectful());
    if (r.status !== 'pending-approval') throw new Error('expected a change request');
    expect(p.registry.rejectChange(p.users.approver, r.change.id, 'not yet').status).toBe('rejected');
    expect(() => p.registry.approveChange(p.users.approver, r.change.id)).toThrow(/is rejected/);
    const r2 = p.publish(p.users.admin, effectful('pay2'));
    if (r2.status !== 'pending-approval') throw new Error('expected a change request');
    expect(() => p.registry.withdrawChange(p.users.operator, r2.change.id)).toThrow(/Only the requester/);
    expect(p.registry.withdrawChange(p.users.admin, r2.change.id).status).toBe('withdrawn');
  });

  it('does not gate the same workflow outside production', () => {
    p = makePlatform({ environment: 'development' });
    expect(p.publish(p.users.author, effectful()).status).toBe('published');
  });

  it('applies operator-defined policy documents', async () => {
    const { parsePolicyDocument } = await import('../../security/policy/index.ts');
    p = makePlatform();
    p.policy.loadDocuments([
      parsePolicyDocument({
        apiVersion: 'omniflow.dev/v1',
        kind: 'Policy',
        metadata: { name: 'house' },
        rules: [{ id: 'no-crit', effect: 'deny', actions: ['workflow.publish'], when: 'workflow.criticality == "critical"', reason: 'freeze on critical workflows' }],
      }).document!,
    ]);
    const m = pure();
    m.metadata.criticality = 'critical';
    expect(() => p.publish(p.users.admin, m)).toThrow(/freeze on critical/);
  });
});

describe('rollout: activation, canary and rollback', () => {
  it('serves the canary to a stable share of runs and can promote or roll it back', () => {
    p = makePlatform();
    asPublished(p.publish(p.users.author, pure('wf', '1.0.0')));
    asPublished(p.publish(p.users.author, pure('wf', '2.0.0'), { canaryPercent: 30 }));
    expect(p.state.registry.getSettings('default', 'wf')).toMatchObject({ stableVersion: '1.0.0', canaryVersion: '2.0.0', canaryPercent: 30 });

    const picks = Array.from({ length: 400 }, (_, i) => p.registry.resolveActive('default', 'wf', `key-${i}`));
    const canary = picks.filter((x) => x.canary).length;
    expect(canary).toBeGreaterThan(80);
    expect(canary).toBeLessThan(160); // ≈ 30 % of 400
    // the choice is deterministic per key
    expect(p.registry.resolveActive('default', 'wf', 'key-7').version.version).toBe(p.registry.resolveActive('default', 'wf', 'key-7').version.version);

    expect(p.registry.promoteCanary(p.users.operator, 'wf')).toMatchObject({ stableVersion: '2.0.0', canaryPercent: 0 });
    p.registry.setCanary(p.users.operator, 'wf', '1.0.0', 50);
    expect(p.registry.rollbackCanary(p.users.operator, 'wf').canaryPercent).toBe(0);
  });

  it('rolls back to an earlier version, and refuses to deprecate the stable one', () => {
    p = makePlatform();
    asPublished(p.publish(p.users.author, pure('wf', '1.0.0')));
    asPublished(p.publish(p.users.author, pure('wf', '1.1.0')));
    expect(() => p.registry.deprecate(p.users.operator, 'wf', '1.1.0')).toThrow(/stable version cannot be deprecated/);
    p.registry.activate(p.users.operator, 'wf', '1.0.0');
    expect(p.registry.resolveActive('default', 'wf', 'k').version.version).toBe('1.0.0');
    p.registry.deprecate(p.users.operator, 'wf', '1.1.0');
    expect(() => p.registry.activate(p.users.operator, 'wf', '1.1.0')).toThrow(/deprecated/);
    expect(() => p.registry.activate(p.users.viewer, 'wf', '1.0.0')).toThrow(/do not permit/);
  });

  it('automatically rolls back a canary whose runs keep failing', async () => {
    p = makePlatform({ scheduler: { canary: { minRuns: 4, maxFailureRate: 0.3 } } });
    asPublished(p.publish(p.users.author, pure('wf', '1.0.0')));
    const bad = wf([{ id: 'boom', type: 'capability', uses: 'util-fail@^1', retry: { attempts: 1 } }], {}, 'wf');
    bad.metadata.version = '2.0.0';
    asPublished(p.publish(p.users.author, bad, { canaryPercent: 100 }));
    for (let i = 0; i < 4; i++) {
      const r = trig(p.users.operator, 'wf');
      if (r.status !== 'queued') throw new Error('expected queued');
      expect(r.run.canary).toBe(true);
      await p.wait(r.run);
    }
    expect(p.scheduler.evaluateCanaries()).toEqual(['default/wf']);
    expect(p.state.registry.getSettings('default', 'wf')).toMatchObject({ canaryPercent: 0, stableVersion: '1.0.0' });
    expect(p.state.events.list({ tenant: 'default', types: ['workflow.rollout-changed'] }).some((e) => String(e.data.reason).includes('automatic rollback'))).toBe(true);
  });
});

describe('run admission: validation, authorisation and controls', () => {
  it('validates inputs, applies defaults, and reports errors by path', () => {
    p = makePlatform();
    asPublished(p.publish(p.users.author, pure('wf', '1.0.0', { inputs: { n: { type: 'integer', required: true, minimum: 1 }, tag: { type: 'string', default: 'x' } } })));
    try {
      trig(p.users.operator, 'wf', { n: 0, extra: true });
      expect.unreachable();
    } catch (e: any) {
      expect(e.issues.map((i: any) => i.path).sort()).toEqual(['inputs.extra', 'inputs.n']);
    }
    const r = trig(p.users.operator, 'wf', { n: 5 });
    if (r.status !== 'queued') throw new Error('expected queued');
    expect(r.run.inputs).toEqual({ n: 5, tag: 'x' });
  });

  it('enforces RBAC, tenant isolation and unknown workflows', () => {
    p = makePlatform();
    asPublished(p.publish(p.users.author, pure()));
    expect(() => trig(p.users.viewer, 'wf')).toThrow(/do not permit/);
    expect(() => trig(p.users.operator, 'ghost')).toThrow(/not found/);
    p.state.identity.ensureTenant('acme', 'Acme');
    expect(() => trig(user('usr_acme', ['operator'], 'acme'), 'wf')).toThrow(/not found/); // other tenants cannot even see it
    expect(p.state.events.list({ tenant: 'default', types: ['policy.decision'] }).some((e) => e.data.action === 'workflow.run')).toBe(true);
  });

  it('honours the kill switch and disable, and cancels runs queued behind them', async () => {
    p = makePlatform({ scheduler: { maxConcurrentRuns: 1 } });
    asPublished(p.publish(p.users.author, slow('busy', 300)));
    const first = trig(p.users.operator, 'busy');
    const second = trig(p.users.operator, 'busy');
    if (first.status !== 'queued' || second.status !== 'queued') throw new Error('expected queued');
    p.registry.kill(p.users.operator, 'busy', 'incident 7');
    expect(() => trig(p.users.operator, 'busy')).toThrow(/kill switch: incident 7/);
    await p.wait(first.run);
    expect((await p.wait(second.run)).status).toBe('cancelled'); // never started
    expect(p.state.runs.getRun(second.run.id)!.error!.message).toContain('killed while queued');
    p.registry.revive(p.users.operator, 'busy');
    p.registry.setEnabled(p.users.operator, 'busy', false);
    expect(() => trig(p.users.operator, 'busy')).toThrow(/disabled/);
  });

  it('deduplicates within a window and skips beyond a concurrency limit when so configured', async () => {
    p = makePlatform();
    asPublished(p.publish(p.users.author, slow('dd', 30, { inputs: { order: { type: 'string', required: true } }, policy: { dedupWindow: '1h', dedupKey: 'order-${{ inputs.order }}' } })));
    const a = trig(p.users.operator, 'dd', { order: 'o1' });
    const b = trig(p.users.operator, 'dd', { order: 'o1' });
    const c = trig(p.users.operator, 'dd', { order: 'o2' });
    if (a.status !== 'queued' || c.status !== 'queued') throw new Error('expected queued');
    expect(b).toMatchObject({ status: 'deduplicated' });
    expect((b as any).run.id).toBe(a.run.id);
    expect(c.run.id).not.toBe(a.run.id);
    expect(p.state.events.list({ tenant: 'default', types: ['run.deduplicated'] })).toHaveLength(1);
    await p.wait(a.run);
    await p.wait(c.run);

    asPublished(p.publish(p.users.author, slow('sk', 200, { policy: { concurrency: 1, concurrencyPolicy: 'skip' } })));
    const one = trig(p.users.operator, 'sk');
    const two = trig(p.users.operator, 'sk');
    expect(one.status).toBe('queued');
    expect(two).toMatchObject({ status: 'skipped' });
    if (one.status === 'queued') await p.wait(one.run);
  });

  it('queues beyond a per-workflow concurrency limit and runs them one at a time', async () => {
    p = makePlatform();
    asPublished(p.publish(p.users.author, slow('serial', 60, { policy: { concurrency: 1 } })));
    const runs = [0, 1, 2].map(() => trig(p.users.operator, 'serial')).map((r) => (r as any).run);
    await Promise.all(runs.map((r) => p.wait(r)));
    expect(p.world.maxConcurrent).toBe(1);
    expect(runs.every((r) => p.state.runs.getRun(r.id)!.status === 'succeeded')).toBe(true);
  });

  it('caps total running workflows and admits by priority', async () => {
    p = makePlatform({ scheduler: { maxConcurrentRuns: 1 } });
    asPublished(p.publish(p.users.author, slow('prio', 120)));
    const first = (trig(p.users.operator, 'prio') as any).run;
    const low = (trig(p.users.operator, 'prio', {}, { priority: 9 }) as any).run;
    const high = (trig(p.users.operator, 'prio', {}, { priority: 1 }) as any).run;
    await Promise.all([first, low, high].map((r) => p.wait(r)));
    const started = (r: { id: string }) => p.state.runs.getRun(r.id)!.startedAt!;
    expect(started(high) < started(low)).toBe(true); // lower number = higher priority
    expect(p.world.maxConcurrent).toBe(1);
  });

  it('enforces a daily cost ceiling', async () => {
    p = makePlatform();
    asPublished(p.publish(p.users.author, slow('costly', 10, { policy: { maxDailyCost: 2 } })));
    for (let i = 0; i < 2; i++) await p.wait((trig(p.users.operator, 'costly') as any).run);
    expect(() => trig(p.users.operator, 'costly')).toThrow(/Daily cost ceiling/);
    expect(p.state.events.list({ tenant: 'default', types: ['run.skipped'] }).some((e) => e.data.reason === 'daily-cost-ceiling')).toBe(true);
  });

  it('retries a finished run on the exact same plan, and cancels via the service with RBAC', async () => {
    p = makePlatform();
    asPublished(p.publish(p.users.author, pure('wf', '1.0.0')));
    const first = (trig(p.users.operator, 'wf') as any).run;
    await p.wait(first);
    asPublished(p.publish(p.users.author, pure('wf', '1.1.0')));
    const again = p.runs.retry(p.users.operator, first.id);
    if (again.status !== 'queued') throw new Error('expected queued');
    expect(again.run.workflowVersion).toBe('1.0.0'); // pinned to the original version, not the new stable one
    expect(again.run.triggerType).toBe('retry');
    await p.wait(again.run);
    expect(() => p.runs.retry(p.users.viewer, first.id)).toThrow(/do not permit/);

    asPublished(p.publish(p.users.author, slow('long', 5000)));
    const running = (trig(p.users.operator, 'long') as any).run;
    await p.orch.waitForRun(running.id, 3000, (r) => r.status === 'running');
    expect(() => p.runs.cancel(p.users.viewer, running.id)).toThrow(/do not permit/);
    p.runs.cancel(p.users.operator, running.id, 'test');
    expect((await p.wait(running)).status).toBe('cancelled');
  });
});

describe('approvals: who may decide', () => {
  const gated = (roles?: string[]) =>
    wf([{ id: 'gate', type: 'approval', message: 'ok?', timeout: '1h', onTimeout: 'deny', ...(roles ? { approvers: { roles } } : {}) }], {}, 'gated');
  const pending = () => p.approvals.list(p.users.admin, { status: 'pending' })[0]!;

  it('lets an eligible approver decide, records who, and resumes the run', async () => {
    p = makePlatform();
    asPublished(p.publish(p.users.author, gated()));
    const run = (trig(p.users.operator, 'gated') as any).run;
    await p.orch.waitForRun(run.id, 3000, (r) => r.status === 'waiting-approval');
    expect(() => p.approvals.decide(p.users.viewer, pending().id, 'approved')).toThrow(/do not permit/);
    expect(() => p.approvals.decide(p.users.operator, pending().id, 'approved')).toThrow(/do not permit/);
    const decided = p.approvals.decide(p.users.approver, pending().id, 'approved', 'fine');
    expect(decided).toMatchObject({ status: 'approved', decidedBy: 'usr_approver' });
    expect((await p.wait(run)).status).toBe('succeeded');
    expect(p.state.events.list({ tenant: 'default', types: ['approval.decided'] })[0]!.actor).toMatchObject({ id: 'usr_approver' });
    expect(() => p.approvals.decide(p.users.approver2, decided.id, 'denied')).toThrow(/already approved/);
  });

  it('enforces four-eyes: the person who started the run cannot approve it', async () => {
    p = makePlatform();
    asPublished(p.publish(p.users.author, gated()));
    const run = (trig(p.users.admin, 'gated') as any).run; // an admin starts it…
    await p.orch.waitForRun(run.id, 3000, (r) => r.status === 'waiting-approval');
    try {
      p.approvals.decide(p.users.admin, pending().id, 'approved'); // …and cannot rubber-stamp it
      expect.unreachable();
    } catch (e: any) {
      expect(e.details.code).toBe('SELF_APPROVAL');
    }
    p.approvals.decide(p.users.approver, pending().id, 'denied', 'no');
    expect((await p.wait(run)).status).toBe('failed');
  });

  it('restricts a gate to the roles it names; admins remain a break-glass route', async () => {
    p = makePlatform();
    asPublished(p.publish(p.users.author, gated(['finance'])));
    const run = (trig(p.users.operator, 'gated') as any).run;
    await p.orch.waitForRun(run.id, 3000, (r) => r.status === 'waiting-approval');
    expect(() => p.approvals.decide(p.users.approver, pending().id, 'approved')).toThrow(/not one of the approvers/);
    const finance = user('usr_finance', ['approver', 'finance' as never]);
    expect(p.approvals.canDecide(finance, pending())).toBe(true);
    p.approvals.decide(p.users.admin, pending().id, 'approved');
    expect((await p.wait(run)).status).toBe('succeeded');
  });

  it('does not show another tenant’s approvals', async () => {
    p = makePlatform();
    asPublished(p.publish(p.users.author, gated()));
    const run = (trig(p.users.operator, 'gated') as any).run;
    await p.orch.waitForRun(run.id, 3000, (r) => r.status === 'waiting-approval');
    const other = user('usr_other', ['approver'], 'acme');
    p.state.identity.ensureTenant('acme', 'Acme');
    expect(p.approvals.list(other)).toEqual([]);
    expect(() => p.approvals.get(other, pending().id)).toThrow(/not found/);
  });
});
