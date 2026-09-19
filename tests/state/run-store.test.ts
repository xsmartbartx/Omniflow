import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError } from '../../core/index.ts';
import type { NewRun } from '../../state/index.ts';
import { makeState, principal, type TestState } from '../helpers/state.ts';

let s: TestState;
beforeEach(() => {
  s = makeState();
});

const newRun = (over: Partial<NewRun> = {}): NewRun => ({
  tenant: 'default',
  workflowName: 'wf',
  workflowVersion: '1.0.0',
  planHash: 'sha256:aaa',
  stepIds: ['a', 'b'],
  dryRun: false,
  environment: 'production',
  triggerType: 'manual',
  inputs: { x: 1 },
  requestedBy: principal(),
  ...over,
});

describe('run store: lifecycle', () => {
  it('creates a queued run with pending steps and deterministic seed/now', () => {
    const r = s.runs.createRun(newRun());
    expect(r.status).toBe('queued');
    expect(r.id).toMatch(/^run_/);
    expect(r.seed).toBe(r.id);
    expect(r.contextNow).toBe('2026-06-01T12:00:00.000Z');
    expect(r.inputs).toEqual({ x: 1 });
    expect(r.requestedBy.name).toBe('Test User');
    expect(s.runs.getSteps(r.id).map((x) => [x.stepId, x.status])).toEqual([
      ['a', 'pending'],
      ['b', 'pending'],
    ]);
  });

  it('enforces the run state machine of architecture §9.2', () => {
    const r = s.runs.createRun(newRun());
    expect(() => s.runs.transition(r.id, 'succeeded')).toThrow(/cannot move from 'queued' to 'succeeded'/);
    s.clock.advance(1000);
    const running = s.runs.transition(r.id, 'running');
    expect(running.startedAt).toBe('2026-06-01T12:00:01.000Z');
    s.runs.transition(r.id, 'waiting-approval');
    s.runs.transition(r.id, 'running');
    s.runs.transition(r.id, 'compensating', { error: { code: 'X', message: 'm', class: 'business', retryable: false } });
    const done = s.runs.transition(r.id, 'compensation-failed');
    expect(done.finishedAt).toBeDefined();
    expect(done.error?.code).toBe('X');
    // Terminal states are final
    for (const to of ['running', 'succeeded', 'failed', 'cancelled'] as const) {
      expect(() => s.runs.transition(r.id, to)).toThrow(/cannot move/);
    }
    expect(() => s.runs.transition('run_missing', 'running')).toThrow(/not found/);
  });

  it('keeps CompensationFailed distinct from Failed', () => {
    const a = s.runs.createRun(newRun());
    s.runs.transition(a.id, 'running');
    expect(s.runs.transition(a.id, 'failed').status).toBe('failed');
    const b = s.runs.createRun(newRun());
    s.runs.transition(b.id, 'running');
    s.runs.transition(b.id, 'compensating');
    expect(s.runs.transition(b.id, 'compensation-failed').status).toBe('compensation-failed');
    expect(s.runs.countByStatus('default')).toMatchObject({ failed: 1, 'compensation-failed': 1 });
  });

  it('stores outputs and cost; queues, lists, filters and counts', () => {
    const a = s.runs.createRun(newRun());
    s.clock.advance(1000);
    const b = s.runs.createRun(newRun({ workflowName: 'other', triggerType: 'schedule' }));
    s.runs.transition(a.id, 'running');
    s.runs.transition(a.id, 'succeeded', { outputs: { ok: true }, cost: 3 });
    expect(s.runs.getRun(a.id)!.outputs).toEqual({ ok: true });
    expect(s.runs.listRuns({ tenant: 'default' }).map((r) => r.id)).toEqual([b.id, a.id]); // newest first
    expect(s.runs.listRuns({ tenant: 'default', workflow: 'wf' })).toHaveLength(1);
    expect(s.runs.listRuns({ tenant: 'default', status: ['queued'] })[0]!.id).toBe(b.id);
    expect(s.runs.listRuns({ tenant: 'default', triggerType: 'schedule' })).toHaveLength(1);
    expect(s.runs.countRuns({ tenant: 'default' })).toBe(2);
    expect(s.runs.getRun(a.id, 'someone-else')).toBeUndefined(); // tenant isolation
  });

  it('counts active runs and returns queued runs by priority then age', () => {
    const low = s.runs.createRun(newRun({ priority: 9 }));
    s.clock.advance(10);
    const high = s.runs.createRun(newRun({ priority: 1 }));
    expect(s.runs.runsByStatus(['queued']).map((r) => r.id)).toEqual([high.id, low.id]);
    s.runs.transition(high.id, 'running');
    expect(s.runs.activeCount('default', 'wf')).toBe(1);
    expect(s.runs.activeCount('default')).toBe(1);
    expect(s.runs.activeCount('default', 'other')).toBe(0);
  });

  it('finds duplicates by dedup key inside a window', () => {
    const r = s.runs.createRun(newRun({ dedupKey: 'order-1' }));
    expect(s.runs.findByDedupKey('default', 'wf', 'order-1', '2026-06-01T11:00:00.000Z')?.id).toBe(r.id);
    expect(s.runs.findByDedupKey('default', 'wf', 'order-1', '2026-06-01T13:00:00.000Z')).toBeUndefined();
    expect(s.runs.findByDedupKey('default', 'wf', 'order-2', '2026-06-01T11:00:00.000Z')).toBeUndefined();
  });

  it('tracks per-run and per-day cost', () => {
    const r = s.runs.createRun(newRun());
    s.runs.addRunCost(r.id, 'default', 'wf', 2.5);
    s.runs.addRunCost(r.id, 'default', 'wf', 1);
    s.runs.addRunCost(r.id, 'default', 'wf', 0); // no-op
    expect(s.runs.getRun(r.id)!.cost).toBe(3.5);
    expect(s.runs.dailyCost('default', 'wf')).toBe(3.5);
    expect(s.runs.dailyCost('default', 'wf', '2020-01-01')).toBe(0);
  });

  it('links child runs to parents', () => {
    const p = s.runs.createRun(newRun());
    const c = s.runs.createRun(newRun({ parentRunId: p.id, parentStepId: 'a' }));
    expect(s.runs.childrenOf(p.id).map((x) => x.id)).toEqual([c.id]);
  });
});

describe('run store: step state and timers', () => {
  it('patches steps, clears nullable columns, and orders completions', () => {
    const r = s.runs.createRun(newRun());
    s.runs.patchStep(r.id, 'a', { status: 'running', attempt: 1, startedAt: 'T', idempotencyKey: 'k' });
    s.runs.patchStep(r.id, 'a', { status: 'succeeded', output: { v: 1 }, completedSeq: s.runs.nextCompletionSeq(r.id) });
    s.runs.patchStep(r.id, 'b', { status: 'succeeded', completedSeq: s.runs.nextCompletionSeq(r.id) });
    const a = s.runs.getStep(r.id, 'a')!;
    expect(a).toMatchObject({ status: 'succeeded', attempt: 1, output: { v: 1 }, idempotencyKey: 'k', completedSeq: 1 });
    expect(s.runs.getStep(r.id, 'b')!.completedSeq).toBe(2);
    s.runs.patchStep(r.id, 'a', { output: null });
    expect(s.runs.getStep(r.id, 'a')!.output).toBeUndefined();
    expect(() => s.runs.patchStep(r.id, 'nope', { status: 'running' })).toThrow(/not found/);
  });

  it('finds steps whose timers are due, only in live runs', () => {
    const r = s.runs.createRun(newRun());
    s.runs.transition(r.id, 'running');
    s.runs.patchStep(r.id, 'a', { status: 'retry-wait', wakeAt: '2026-06-01T12:00:05.000Z' });
    s.runs.patchStep(r.id, 'b', { status: 'waiting-timer', wakeAt: '2026-06-01T12:10:00.000Z' });
    expect(s.runs.dueSteps('2026-06-01T12:00:04.000Z')).toHaveLength(0);
    expect(s.runs.dueSteps('2026-06-01T12:00:06.000Z').map((x) => x.stepId)).toEqual(['a']);
    expect(s.runs.dueSteps('2026-06-01T12:11:00.000Z')).toHaveLength(2);
    s.runs.transition(r.id, 'failed');
    expect(s.runs.dueSteps('2026-06-01T12:11:00.000Z')).toHaveLength(0);
  });

  it('matches waiting-event steps by event and correlation, within a tenant', () => {
    const r = s.runs.createRun(newRun());
    s.runs.patchStep(r.id, 'a', { status: 'waiting-event', waitEvent: 'payment.settled', waitCorrelation: 'o-1' });
    s.runs.patchStep(r.id, 'b', { status: 'waiting-event', waitEvent: 'payment.settled' }); // any correlation
    expect(s.runs.findWaitingEventSteps('default', 'payment.settled', 'o-1').map((x) => x.stepId).sort()).toEqual(['a', 'b']);
    expect(s.runs.findWaitingEventSteps('default', 'payment.settled', 'o-2').map((x) => x.stepId)).toEqual(['b']);
    expect(s.runs.findWaitingEventSteps('other', 'payment.settled', 'o-1')).toHaveLength(0);
    expect(s.runs.findWaitingEventSteps('default', 'other.event', null)).toHaveLength(0);
  });
});

describe('idempotency ledger (ADR-0002 D3)', () => {
  const claim = (owner: string, key = 'k1') => s.idempotency.claim('default', 'charge', key, owner, 60_000);

  it('claims, completes and then replays the recorded output', () => {
    expect(claim('run1/a')).toEqual({ state: 'claimed', reclaimed: false });
    s.idempotency.complete('default', 'charge', 'k1', 'run1/a', { chargeId: 'ch_1' });
    expect(claim('run2/a')).toEqual({ state: 'replay', output: { chargeId: 'ch_1' } });
    expect(claim('run1/a')).toEqual({ state: 'replay', output: { chargeId: 'ch_1' } });
  });

  it('serialises concurrent claimants: the second sees "busy"', () => {
    expect(claim('run1/a').state).toBe('claimed');
    expect(claim('run2/a')).toEqual({ state: 'busy', owner: 'run1/a' });
  });

  it('lets the same owner re-claim after a crash', () => {
    claim('run1/a');
    expect(claim('run1/a')).toEqual({ state: 'claimed', reclaimed: true });
  });

  it('frees a key after a failed attempt so a retry may perform the effect', () => {
    claim('run1/a');
    s.idempotency.release('default', 'charge', 'k1', 'run1/a');
    expect(claim('run2/a')).toEqual({ state: 'claimed', reclaimed: false });
  });

  it('never releases a key the caller does not own, nor a completed one', () => {
    claim('run1/a');
    s.idempotency.release('default', 'charge', 'k1', 'run2/a');
    expect(s.idempotency.peek('default', 'charge', 'k1')?.owner).toBe('run1/a');
    s.idempotency.complete('default', 'charge', 'k1', 'run1/a', { ok: 1 });
    s.idempotency.release('default', 'charge', 'k1', 'run1/a');
    expect(s.idempotency.peek('default', 'charge', 'k1')?.state).toBe('succeeded');
  });

  it('reclaims abandoned claims and forgets expired keys', () => {
    claim('run1/a');
    s.clock.advance(61_000);
    expect(claim('run2/a')).toEqual({ state: 'claimed', reclaimed: true });
    s.idempotency.complete('default', 'charge', 'k1', 'run2/a', { ok: 1 }, 1000);
    s.clock.advance(2000);
    expect(claim('run3/a').state).toBe('claimed'); // completed key expired
    expect(s.idempotency.purgeExpired()).toBe(0);
  });

  it('scopes keys by tenant and capability', () => {
    claim('run1/a');
    expect(s.idempotency.claim('default', 'refund', 'k1', 'run2/a', 60_000).state).toBe('claimed');
    expect(s.idempotency.claim('other', 'charge', 'k1', 'run2/a', 60_000).state).toBe('claimed');
  });
});

describe('approvals', () => {
  const create = () =>
    s.approvals.create({
      tenant: 'default',
      runId: 'run_1',
      stepId: 'gate',
      message: 'ok?',
      approvers: { roles: ['approver'], users: [] },
      requestedBy: 'usr_a',
      expiresAt: '2026-06-01T13:00:00.000Z',
      onTimeout: 'deny',
      allowSelf: false,
    });

  it('decides exactly once', () => {
    const a = create();
    expect(a.status).toBe('pending');
    const d = s.approvals.decide(a.id, 'approved', 'usr_b', 'lgtm');
    expect(d).toMatchObject({ status: 'approved', decidedBy: 'usr_b', comment: 'lgtm' });
    expect(() => s.approvals.decide(a.id, 'denied', 'usr_c')).toThrow(/already approved/);
    expect(() => s.approvals.decide('apr_missing', 'denied', 'x')).toThrow(/not found/);
  });

  it('lists pending approvals, finds due ones, and escalates once', () => {
    const a = create();
    expect(s.approvals.list({ tenant: 'default', status: 'pending' })).toHaveLength(1);
    expect(s.approvals.pendingCount('default')).toBe(1);
    expect(s.approvals.due('2026-06-01T12:59:00.000Z')).toHaveLength(0);
    expect(s.approvals.due('2026-06-01T13:00:01.000Z').map((x) => x.id)).toEqual([a.id]);
    s.approvals.escalate(a.id, '2026-06-01T14:00:00.000Z');
    expect(s.approvals.get(a.id)).toMatchObject({ escalated: true, expiresAt: '2026-06-01T14:00:00.000Z' });
    expect(s.approvals.get(a.id, 'other')).toBeUndefined();
  });
});

describe('artifact store', () => {
  it('stores content addressed, deduplicates, and verifies integrity on read', () => {
    const a = s.artifacts.put('default', 'hello', { contentType: 'text/plain' });
    const b = s.artifacts.put('default', 'hello');
    expect(a.ref).toBe(b.ref);
    expect(a.ref).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(s.artifacts.get('default', a.ref).data.toString()).toBe('hello');
    expect(s.artifacts.getJson('default', s.artifacts.putJson('default', { n: 1 }).ref)).toEqual({ n: 1 });
    expect(() => s.artifacts.get('other', a.ref)).toThrow(NotFoundError); // tenant isolation
  });

  it('detects a corrupted file', () => {
    const a = s.artifacts.put('default', 'payload');
    const root = join(s.dir, 'artifacts');
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    const file = walk(root).find((f) => readFileSync(f, 'utf8') === 'payload')!;
    writeFileSync(file, 'tampered');
    expect(() => s.artifacts.get('default', a.ref)).toThrow(/integrity/);
  });

  it('tombstones: destroys the bytes, keeps the metadata (right to erasure)', () => {
    const a = s.artifacts.put('default', 'personal data');
    expect(s.artifacts.tombstone('default', a.ref, 'GDPR request')).toBe(true);
    expect(s.artifacts.tombstone('default', a.ref, 'again')).toBe(false);
    expect(() => s.artifacts.get('default', a.ref)).toThrow(/erased \(GDPR request\)/);
    expect(s.artifacts.meta('default', a.ref)?.tombstonedAt).toBeDefined();
    // Storing the same content again restores it.
    s.artifacts.put('default', 'personal data');
    expect(s.artifacts.get('default', a.ref).data.toString()).toBe('personal data');
  });
});

describe('registry store: immutability', () => {
  const version = (v = '1.0.0') => ({
    tenant: 'default',
    name: 'wf',
    version: v,
    manifestText: 'manifest',
    manifestHash: 'sha256:m',
    planHash: `sha256:p${v}`,
    plan: { planVersion: 1 } as never,
    environment: 'production',
    publishedBy: 'usr_a',
  });

  it('publishes once; the same version can never be published again', () => {
    s.registry.insertVersion(version());
    expect(() => s.registry.insertVersion(version())).toThrow(ConflictError);
    expect(s.registry.getPlan('default', 'sha256:p1.0.0')).toEqual({ planVersion: 1 });
  });

  it('refuses in-place edits and deletes at the database level', () => {
    s.registry.insertVersion(version());
    expect(() => s.db.run("UPDATE workflow_versions SET manifest_text = 'evil'")).toThrow(/immutable/);
    expect(() => s.db.run("UPDATE workflow_versions SET plan_hash = 'sha256:evil'")).toThrow(/immutable/);
    expect(() => s.db.run('DELETE FROM workflow_versions')).toThrow(/cannot be deleted/);
    expect(() => s.db.run("UPDATE plans SET body = '{}'")).toThrow(/immutable/);
    expect(() => s.db.run('DELETE FROM plans')).toThrow(/cannot be deleted/);
    // ...but lifecycle status may change
    s.registry.setStatus('default', 'wf', '1.0.0', 'deprecated');
    expect(s.registry.getVersion('default', 'wf', '1.0.0')?.status).toBe('deprecated');
  });

  it('orders versions by semver and finds the latest published', () => {
    for (const v of ['1.2.0', '1.10.0', '1.9.0']) s.registry.insertVersion(version(v));
    expect(s.registry.listVersions('default', 'wf').map((x) => x.version)).toEqual(['1.10.0', '1.9.0', '1.2.0']);
    s.registry.setStatus('default', 'wf', '1.10.0', 'deprecated');
    expect(s.registry.latestVersion('default', 'wf')?.version).toBe('1.9.0');
    expect(s.registry.listWorkflows('default')).toMatchObject([{ name: 'wf', versions: 3, latest: '1.9.0' }]);
  });

  it('manages workflow settings: kill switch, canary, autonomy', () => {
    s.registry.insertVersion(version());
    expect(s.registry.getSettings('default', 'wf')).toMatchObject({ enabled: true, killed: false, autonomyTier: 'T1', canaryPercent: 0 });
    const killed = s.registry.patchSettings('default', 'wf', { killed: true, killReason: 'incident 42' }, 'usr_a');
    expect(killed).toMatchObject({ killed: true, killReason: 'incident 42' });
    const revived = s.registry.patchSettings('default', 'wf', { killed: false }, 'usr_a');
    expect(revived.killReason).toBeUndefined();
    s.registry.patchSettings('default', 'wf', { canaryVersion: '1.1.0', canaryPercent: 10 }, 'usr_a');
    expect(s.registry.patchSettings('default', 'wf', { clearCanary: true }, 'usr_a')).toMatchObject({ canaryPercent: 0 });
    expect(() => s.registry.patchSettings('default', 'ghost', {}, 'x')).toThrow(/no published version/);
  });
});

describe('identity, secrets, triggers, authoring and kv stores', () => {
  it('manages users, login lockout and sessions', () => {
    const u = s.identity.createUser({ tenant: 'default', email: 'A@Example.com', name: 'A', roles: ['admin'], passwordHash: 'h' });
    expect(u.email).toBe('a@example.com');
    expect(() => s.identity.createUser({ tenant: 'default', email: 'a@example.com', name: 'A', roles: [] })).toThrow(ConflictError);
    expect(s.identity.findUsersByEmail('A@example.com')).toHaveLength(1);
    expect(s.identity.recordLoginFailure(u.id, 3, 60_000).locked).toBe(false);
    s.identity.recordLoginFailure(u.id, 3, 60_000);
    expect(s.identity.recordLoginFailure(u.id, 3, 60_000).locked).toBe(true);
    expect(s.identity.getUser(u.id)!.lockedUntil).toBe('2026-06-01T12:01:00.000Z');
    s.identity.recordLoginSuccess(u.id);
    expect(s.identity.getUser(u.id)).toMatchObject({ failedLogins: 0 });
    expect(s.identity.getUser(u.id)!.lockedUntil).toBeUndefined();

    const sess = s.identity.createSession({ id: 'hash1', userId: u.id, tenant: 'default', ttlMs: 1000 });
    expect(s.identity.getSession(sess.id)).toBeDefined();
    s.clock.advance(2000);
    expect(s.identity.purgeExpiredSessions()).toBe(1);
  });

  it('stores API keys by prefix and revokes them', () => {
    const k = s.identity.createApiKey({ tenant: 'default', name: 'ci', prefix: 'abc123', keyHash: 'h', roles: ['operator'], createdBy: 'usr' });
    expect(s.identity.findApiKeyByPrefix('abc123')?.id).toBe(k.id);
    s.identity.revokeApiKey(k.id);
    expect(s.identity.getApiKey(k.id)?.revokedAt).toBeDefined();
  });

  it('keeps secret ciphertext out of listings and versions updates', () => {
    s.secrets.put('default', 'API_TOKEN', 'ciphertext', 'k1', 'usr', 'the token');
    s.secrets.put('default', 'API_TOKEN', 'ciphertext2', 'k1', 'usr');
    expect(s.secrets.get('default', 'API_TOKEN')).toMatchObject({ cipher: 'ciphertext2', version: 2, description: 'the token' });
    expect(JSON.stringify(s.secrets.list('default'))).not.toContain('ciphertext');
    const lease = s.secrets.recordLease({ tenant: 'default', runId: 'r', stepId: 's', names: ['API_TOKEN'], ttlMs: 1000 });
    expect(s.secrets.outstandingLeases()).toHaveLength(1);
    s.secrets.revokeLease(lease.id);
    expect(s.secrets.outstandingLeases()).toHaveLength(0);
  });

  it('registers triggers, dedupes firings and rejects replayed nonces', () => {
    const [t] = s.triggers.replaceForWorkflow('default', 'wf', '1.0.0', [
      { name: 'nightly', type: 'schedule', config: { cron: '0 2 * * *' }, nextFireAt: '2026-06-01T02:00:00.000Z' },
      { name: 'hook', type: 'webhook', config: {} },
    ]);
    expect(s.triggers.dueSchedules('2026-06-01T12:00:00.000Z').map((x) => x.name)).toEqual(['nightly']);
    expect(s.triggers.recordFire(t!.id, 'slot-1')).toBe(true);
    expect(s.triggers.recordFire(t!.id, 'slot-1')).toBe(false);
    s.triggers.patch(t!.id, { nextFireAt: '2026-06-02T02:00:00.000Z', lastFiredAt: 'now' });
    expect(s.triggers.dueSchedules('2026-06-01T12:00:00.000Z')).toHaveLength(0);
    // Re-registering keeps fire history and removes triggers no longer declared
    s.triggers.replaceForWorkflow('default', 'wf', '1.1.0', [{ name: 'nightly', type: 'schedule', config: { cron: '0 3 * * *' } }]);
    expect(s.triggers.listForWorkflow('default', 'wf').map((x) => x.name)).toEqual(['nightly']);
    expect(s.triggers.find('default', 'wf', 'nightly')?.lastFiredAt).toBe('now');
    expect(s.triggers.useNonce('default', 'n1', 1000)).toBe(true);
    expect(s.triggers.useNonce('default', 'n1', 1000)).toBe(false);
  });

  it('handles drafts, change requests, proposals and findings', () => {
    const d = s.authoring.createDraft({ tenant: 'default', manifestText: 'x', origin: 'agent:planner', createdBy: 'planner' });
    expect(s.authoring.updateDraft(d.id, { status: 'submitted' }).status).toBe('submitted');
    expect(() => s.authoring.updateDraft('nope', {})).toThrow(NotFoundError);

    const c = s.authoring.createChange({ tenant: 'default', workflowName: 'wf', version: '1.0.0', manifestText: 'x', requestedBy: 'u', reasonCode: 'R', reason: 'r', requiredApprovals: 1 });
    expect(() => s.authoring.createChange({ tenant: 'default', workflowName: 'wf', version: '1.0.0', manifestText: 'x', requestedBy: 'u', reasonCode: 'R', reason: 'r', requiredApprovals: 1 })).toThrow(ConflictError);
    const approved = s.authoring.patchChange(c.id, { approvals: [{ by: 'a', at: 'now' }], status: 'approved', decidedBy: 'a' });
    expect(approved).toMatchObject({ status: 'approved', decidedBy: 'a' });
    expect(approved.decidedAt).toBeDefined();

    const p = s.authoring.createProposal({ tenant: 'default', kind: 'remove-step', title: 't', body: { a: 1 }, source: 'analysis', dedupeKey: 'k' });
    expect(p).toBeDefined();
    expect(s.authoring.createProposal({ tenant: 'default', kind: 'remove-step', title: 't', body: {}, source: 'analysis', dedupeKey: 'k' })).toBeUndefined(); // deduped while open
    expect(s.authoring.decideProposal(p!.id, 'accepted', 'u').status).toBe('accepted');
    expect(() => s.authoring.decideProposal(p!.id, 'dismissed', 'u')).toThrow(ConflictError);

    const f = s.authoring.replaceFindings('default', 'wf', '1.0.0', 'sha256:p', [{ ruleId: 'R1', severity: 'high', blocking: true, message: 'm' }]);
    expect(f).toHaveLength(1);
    expect(s.authoring.replaceFindings('default', 'wf', '1.0.0', 'sha256:p', [])).toHaveLength(0);
  });

  it('stores settings, capability kill switches and channels', () => {
    s.kv.set('default', 'k', { a: 1 });
    expect(s.kv.get('default', 'k')).toEqual({ a: 1 });
    s.kv.delete('default', 'k');
    expect(s.kv.get('default', 'k')).toBeUndefined();

    s.kv.setCapabilityKilled('default', 'http-request', true, 'usr', 'incident');
    expect(s.kv.isCapabilityKilled('default', 'http-request')).toEqual({ killed: true, reason: 'incident' });
    expect(s.kv.isCapabilityKilled('other', 'http-request').killed).toBe(false);
    s.kv.setCapabilityKilled('_', 'shell-exec', true, 'usr'); // platform-wide
    expect(s.kv.isCapabilityKilled('other', 'shell-exec').killed).toBe(true);
    s.kv.setCapabilityKilled('default', 'http-request', false, 'usr');
    expect(s.kv.isCapabilityKilled('default', 'http-request').killed).toBe(false);

    s.kv.putChannel({ tenant: 'default', name: 'ops', type: 'slack', config: { channel: '#ops' }, secretName: 'SLACK_URL' });
    expect(s.kv.getChannel('default', 'ops')?.secretName).toBe('SLACK_URL');
    expect(s.kv.deleteChannel('default', 'ops')).toBe(true);
  });
});
