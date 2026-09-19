import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signWebhook } from '../../security/webhook.ts';
import { ADMIN, type Api, type Client, echoStep, makeApi, until, yamlWf } from '../helpers/api.ts';

let api: Api;
let admin: Client;
beforeAll(async () => {
  api = await makeApi();
  admin = await api.login();
});
afterAll(async () => {
  await api.stop();
});

const publish = (c: Client, text: string) => c.post('/v1/workflows', { manifest: text });
const runOf = async (c: Client, name: string, inputs: Record<string, unknown> = {}) => {
  const r = await c.post(`/v1/workflows/${name}/run`, { inputs });
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  return r.body.run.id as string;
};
const finished = async (c: Client, id: string) => {
  await until(async () =>
    ['succeeded', 'failed', 'cancelled', 'rolled-back', 'compensation-failed'].includes(
      (await c.get(`/v1/runs/${id}`)).body.run.status,
    ),
  );
  return (await c.get(`/v1/runs/${id}`)).body;
};

describe('meta endpoints', () => {
  it('serves health, readiness and platform info without authentication', async () => {
    expect((await api.anon.get('/healthz')).body).toEqual({ status: 'ok' });
    expect((await api.anon.get('/readyz')).body.status).toBe('ready');
    const info = (await api.anon.get('/v1/info')).body;
    expect(info).toMatchObject({ name: 'OmniFlow', environment: 'production', setupRequired: false });
    expect(info.capabilities).toBeGreaterThan(5);
  });

  it('publishes an OpenAPI 3.1 description that documents every route and its required action', async () => {
    const spec = (await api.anon.get('/v1/openapi.json')).body;
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths).length).toBeGreaterThan(40);
    expect(spec.paths['/v1/workflows/{name}/run'].post['x-required-action']).toBe('workflow.run');
    expect(spec.paths['/healthz'].get.security).toEqual([]);
    expect(spec.components.securitySchemes).toHaveProperty('bearerApiKey');
    expect(spec.components.securitySchemes).toHaveProperty('sessionCookie');
  });

  it('protects metrics and exposes Prometheus text with a token', async () => {
    expect((await api.anon.get('/metrics')).status).toBe(401);
    const res = await api.anon.get('/metrics', { authorization: 'Bearer metrics-token-123' });
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/plain');
    expect(res.text).toContain('omniflow_active_runs');
    expect(res.text).toContain('omniflow_build_info{');
    expect(res.text).toMatch(/# TYPE omniflow_runs_total counter/);
  });

  it('sends security headers, echoes request ids, and never leaks stack traces', async () => {
    const res = await api.anon.get('/v1/workflows', { 'x-request-id': 'my-request-12345' });
    expect(res.status).toBe(401);
    expect(res.headers['x-request-id']).toBe('my-request-12345');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.error).toMatchObject({ code: 'UNAUTHENTICATED', requestId: 'my-request-12345' });
    expect(res.text).not.toMatch(/at \S+ \(|node_modules|\.ts:/);
    expect((await api.anon.get('/v1/nothing-here')).status).toBe(404);
  });
});

describe('authentication', () => {
  it('signs in with a hardened session cookie and identifies the caller', async () => {
    const res = await api.anon.post('/v1/auth/login', ADMIN);
    expect(res.status).toBe(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/omf_session=/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    const me = (await admin.get('/v1/auth/me')).body;
    expect(me.principal).toMatchObject({ type: 'user', tenant: 'default', roles: ['admin'] });
    expect(me.can['workflow.publish']).toBe(true);
    expect(JSON.stringify(me)).not.toContain('passwordHash');
  });

  it('requires the CSRF header for cookie-authenticated writes', async () => {
    const res = await admin.request('POST', '/v1/workflows/validate', { body: { manifest: 'x' }, noCsrf: true });
    expect(res.status).toBe(403);
    expect(res.body.error.details.code).toBe('CSRF');
    expect((await admin.request('POST', '/v1/workflows/validate', { body: { manifest: 'x' } })).status).toBe(200);
  });

  it('gives one generic failure for a wrong password and an unknown user', async () => {
    const wrong = await api.anon.post('/v1/auth/login', { email: ADMIN.email, password: 'definitely-wrong-password' });
    const unknown = await api.anon.post('/v1/auth/login', {
      email: 'nobody@example.com',
      password: 'definitely-wrong-password',
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it('locks an account after repeated failures, and a lock cannot be bypassed with the right password', async () => {
    const a = await makeApi();
    try {
      const a1 = await a.login();
      await a1.post('/v1/users', {
        email: 'lock@example.com',
        password: 'a-long-enough-passphrase',
        roles: ['viewer'],
      });
      for (let i = 0; i < 5; i++)
        expect(
          (await a.anon.post('/v1/auth/login', { email: 'lock@example.com', password: `wrong-password-${i}xx` }))
            .status,
        ).toBe(401);
      const locked = await a.anon.post('/v1/auth/login', {
        email: 'lock@example.com',
        password: 'a-long-enough-passphrase',
      });
      expect(locked.status).toBe(401);
      expect(locked.body.error.message).toMatch(/temporarily locked/);
    } finally {
      await a.stop();
    }
  });

  it('rate-limits login attempts per source', async () => {
    const a = await makeApi();
    try {
      let last = 0;
      for (let i = 0; i < 14; i++)
        last = (await a.anon.post('/v1/auth/login', { email: 'x@example.com', password: 'wrong-password-xx' })).status;
      expect(last).toBe(429);
    } finally {
      await a.stop();
    }
  });

  it('signs out, invalidating the session', async () => {
    const c = await api.login();
    expect((await c.post('/v1/auth/logout')).status).toBe(200);
    expect((await c.get('/v1/auth/me')).status).toBe(401);
  });

  it('changes passwords under a policy and signs out other sessions', async () => {
    const a = await makeApi();
    try {
      const s1 = await a.login();
      const s2 = await a.login();
      expect((await s1.post('/v1/auth/password', { current: ADMIN.password, next: 'short' })).status).toBe(400);
      expect(
        (await s1.post('/v1/auth/password', { current: 'wrong-current-password', next: 'a-new-long-passphrase-1' }))
          .status,
      ).toBe(401);
      expect(
        (await s1.post('/v1/auth/password', { current: ADMIN.password, next: 'a-new-long-passphrase-1' })).status,
      ).toBe(200);
      expect((await s2.get('/v1/auth/me')).status).toBe(401);
      expect(
        (await a.anon.post('/v1/auth/login', { email: ADMIN.email, password: 'a-new-long-passphrase-1' })).status,
      ).toBe(200);
    } finally {
      await a.stop();
    }
  });

  it('authenticates API keys, and refuses malformed, unknown and revoked ones', async () => {
    const viewer = await api.key(['viewer']);
    expect((await viewer.get('/v1/workflows')).status).toBe(200);
    expect(
      (await api.anon.get('/v1/workflows', { authorization: 'Bearer omf_deadbeef0000_' + 'A'.repeat(43) })).status,
    ).toBe(401);
    expect((await api.anon.get('/v1/workflows', { authorization: 'Bearer nonsense' })).status).toBe(401);

    const created = await admin.post('/v1/api-keys', { name: 'ci', roles: ['operator'] });
    expect(created.status).toBe(201);
    expect(created.body.key).toMatch(/^omf_[0-9a-f]{12}_/);
    expect(created.body.keyHash).toBeUndefined();
    const listed = (await admin.get('/v1/api-keys')).body.items;
    expect(JSON.stringify(listed)).not.toContain(created.body.key);
    const ci = { authorization: `Bearer ${created.body.key}` };
    expect((await api.anon.get('/v1/runs', ci)).status).toBe(200);
    expect((await admin.del(`/v1/api-keys/${created.body.id}`)).status).toBe(200);
    expect((await api.anon.get('/v1/runs', ci)).status).toBe(401);
  });
});

describe('authorisation (RBAC through the Policy Engine)', () => {
  it('lets a viewer read but not write, and explains every refusal', async () => {
    const viewer = await api.key(['viewer']);
    expect((await viewer.get('/v1/workflows')).status).toBe(200);
    const denied = await viewer.post('/v1/workflows', { manifest: yamlWf('w', [echoStep('a', 1)]) });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatchObject({ code: 'RBAC_DENIED' });
    expect(denied.body.error.message).toContain('viewer');
    expect((await viewer.post('/v1/workflows/w/run', {})).status).toBe(403);
    expect((await viewer.get('/v1/secrets')).status).toBe(403);
    expect((await viewer.get('/v1/audit/events')).status).toBe(403);
    // denials are themselves audited
    const audit = (await admin.get('/v1/audit/events?type=policy.decision&limit=50')).body.items;
    expect(audit.some((e: any) => e.data.action === 'workflow.publish' && e.data.effect === 'deny')).toBe(true);
  });

  it('keeps roles separate: operators run but do not publish; authors publish but do not manage', async () => {
    const author = await api.key(['author']);
    const operator = await api.key(['operator']);
    expect((await publish(author, yamlWf('roles-wf', [echoStep('a', 1)]))).status).toBe(201);
    expect((await publish(operator, yamlWf('roles-wf2', [echoStep('a', 1)]))).status).toBe(403);
    expect((await operator.post('/v1/workflows/roles-wf/run', {})).status).toBe(202);
    expect((await author.post('/v1/workflows/roles-wf/disable', {})).status).toBe(403);
    expect((await operator.post('/v1/workflows/roles-wf/disable', {})).status).toBe(200);
    expect((await operator.post('/v1/workflows/roles-wf/run', {})).status).toBe(409);
    expect((await operator.post('/v1/workflows/roles-wf/enable', {})).status).toBe(200);
  });
});

describe('request validation at the boundary', () => {
  it('rejects unknown properties, wrong types and malformed JSON with precise errors', async () => {
    const unknown = await admin.post('/v1/workflows/validate', { manifest: 'x', extra: true });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.details.issues[0].message).toContain("Unknown property 'extra'");
    expect((await admin.post('/v1/workflows/validate', { manifest: 42 })).status).toBe(400);
    expect((await admin.post('/v1/workflows/validate', {})).body.error.details.issues[0].message).toContain(
      "Missing required property 'manifest'",
    );
    const bad = await admin.request('POST', '/v1/workflows/validate', { raw: '{not json' });
    expect(bad.status).toBe(400);
    expect(bad.text).not.toMatch(/SyntaxError|at \S+ \(/);
  });

  it('refuses oversized bodies and prototype-pollution payloads', async () => {
    expect(
      (
        await admin.request('POST', '/v1/workflows/validate', {
          raw: JSON.stringify({ manifest: 'x'.repeat(1_200_000) }),
        })
      ).status,
    ).toBe(413);
    const polluted = await admin.request('POST', '/v1/events', {
      raw: '{"type":"a","payload":{"__proto__":{"admin":true}}}',
    });
    expect(polluted.status).toBe(400);
    expect(({} as any).admin).toBeUndefined();
  });

  it('validates path parameters', async () => {
    expect((await admin.get('/v1/workflows/Not_A_Valid_Name')).status).toBe(400);
    expect((await admin.get('/v1/workflows/does-not-exist')).status).toBe(404);
  });
});

describe('workflow lifecycle over HTTP', () => {
  const manifest = () =>
    yamlWf(
      'order-report',
      [
        echoStep('first', { n: '${{ inputs.n }}' }),
        echoStep('second', '${{ steps.first.output.value.n * 2 }}', { dependsOn: ['first'] }),
      ],
      {
        inputs: { n: { type: 'integer', default: 21 } },
        outputs: { doubled: '${{ steps.second.output.value }}' },
      },
    );

  it('validates without saving, reporting positioned errors and the risk review', async () => {
    const ok = (await admin.post('/v1/workflows/validate', { manifest: manifest() })).body;
    expect(ok).toMatchObject({
      ok: true,
      workflow: { name: 'order-report' },
      risk: { level: 'low' },
      policy: { effect: 'allow' },
    });
    expect(ok.planHash).toMatch(/^sha256:/);

    const bad = (
      await admin.post('/v1/workflows/validate', { manifest: manifest().replace('util-echo@^1', 'util-ecko@^1') })
    ).body;
    expect(bad.ok).toBe(false);
    expect(bad.errors[0]).toMatchObject({ code: 'UNKNOWN_CAPABILITY' });
    expect(bad.errors[0].message).toContain("did you mean 'util-echo'");
    expect(bad.errors[0].line).toBeGreaterThan(1);
    expect((await api.app.state.registry.getVersion('default', 'order-report', '1.0.0')) === undefined).toBe(true);
  });

  it('publishes, lists, describes, graphs and runs it', async () => {
    const pub = await publish(admin, manifest());
    expect(pub.status).toBe(201);
    expect(pub.body).toMatchObject({ status: 'published', version: { name: 'order-report', version: '1.0.0' } });
    expect(pub.body.version.manifestText).toBeUndefined();
    expect((await publish(admin, manifest())).status).toBe(409); // immutable

    const list = (await admin.get('/v1/workflows')).body.items.find((w: any) => w.name === 'order-report');
    expect(list).toMatchObject({ stableVersion: '1.0.0', enabled: true, killed: false, criticality: 'low' });

    const detail = (await admin.get('/v1/workflows/order-report')).body;
    expect(detail.versions).toHaveLength(1);
    expect(detail.plan.analysis.stepCount).toBe(2);
    const version = (await admin.get('/v1/workflows/order-report/versions/1.0.0')).body;
    expect(version.version.manifestText).toContain('order-report');
    expect(version.plan.steps).toHaveLength(2);
    const graph = (await admin.get('/v1/workflows/order-report/graph')).body;
    expect(graph.nodes.map((n: any) => n.id)).toEqual(['first', 'second']);
    expect(graph.edges).toEqual([{ from: 'first', to: 'second', conditional: false }]);

    const id = await runOf(admin, 'order-report', { n: 5 });
    const done = await finished(admin, id);
    expect(done.run).toMatchObject({ status: 'succeeded', inputs: { n: 5 }, outputs: { doubled: 10 } });
    expect(done.steps.map((s: any) => [s.id, s.status, s.attempt])).toEqual([
      ['first', 'succeeded', 1],
      ['second', 'succeeded', 1],
    ]);
    expect(done.plan.workflow.name).toBe('order-report');
  });

  it('reports invalid run inputs by field, and dry runs', async () => {
    const bad = await admin.post('/v1/workflows/order-report/run', { inputs: { n: 'not a number' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.issues[0].path).toBe('inputs.n');
    const dry = await admin.post('/v1/workflows/order-report/run', { inputs: {}, dryRun: true });
    expect(dry.body.run.dryRun).toBe(true);
  });

  it('exposes the run’s audit events and streams them live over SSE, replaying history and ending at completion', async () => {
    const id = await runOf(admin, 'order-report');
    await finished(admin, id);
    const events = (await admin.get(`/v1/runs/${id}/events`)).body.items;
    expect(events.map((e: any) => e.type)).toEqual(
      expect.arrayContaining(['run.queued', 'run.started', 'step.succeeded', 'run.succeeded']),
    );
    expect(events[0].hash).toMatch(/^sha256:/);

    const res = await api.server.inject({
      method: 'GET',
      url: `/v1/runs/${id}/stream`,
      headers: { cookie: admin.cookie! },
    });
    expect(String(res.headers['content-type'])).toContain('text/event-stream');
    expect(res.body).toContain('event: run.queued');
    expect(res.body).toContain('event: run.succeeded');
    expect(res.body.match(/^id: \d+$/gm)!.length).toBe(events.length);
    // resuming after the last event delivers nothing new
    const last = events.at(-1).seq;
    const resumed = await api.server.inject({
      method: 'GET',
      url: `/v1/runs/${id}/stream`,
      headers: { cookie: admin.cookie!, 'last-event-id': String(last) },
    });
    expect(resumed.body).not.toContain('event: run.queued');
  });

  it('cancels and retries runs', async () => {
    await publish(admin, yamlWf('slow-wf', [{ id: 's', type: 'wait', duration: '30s' }]));
    const id = await runOf(admin, 'slow-wf');
    await until(async () => (await admin.get(`/v1/runs/${id}`)).body.run.status === 'waiting-event');
    expect((await admin.post(`/v1/runs/${id}/cancel`, { reason: 'test' })).status).toBe(200);
    const done = await finished(admin, id);
    expect(done.run.status).toBe('cancelled');
    const retried = await admin.post(`/v1/runs/${id}/retry`);
    expect(retried.status).toBe(202);
    expect(retried.body.run.trigger.type).toBe('retry');
    await admin.post(`/v1/runs/${retried.body.run.id}/cancel`);
  });

  it('lists and filters runs', async () => {
    const all = (await admin.get('/v1/runs?limit=5')).body;
    expect(all.items.length).toBeLessThanOrEqual(5);
    expect(all.total).toBeGreaterThan(3);
    const filtered = (await admin.get('/v1/runs?workflow=order-report&status=succeeded')).body;
    expect(filtered.items.every((r: any) => r.workflow === 'order-report' && r.status === 'succeeded')).toBe(true);
  });
});

describe('change control over HTTP (four-eyes)', () => {
  const effectful = (name: string) =>
    yamlWf(name, [
      {
        id: 'save',
        type: 'capability',
        uses: 'file-write@^1',
        with: { path: `${name}.txt`, content: 'hello' },
        idempotencyKey: `k-${name}`,
      },
    ]);

  it('turns a risky publish into a change request that a different person approves', async () => {
    const author = await api.key(['author']);
    const approver = await api.key(['approver']);
    const res = await publish(author, effectful('risky-wf'));
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: 'pending-approval',
      decision: { effect: 'require-approval', reasonCode: 'PROD_EFFECTFUL_NEEDS_APPROVAL' },
    });
    const id = res.body.change.id;
    expect((await admin.get('/v1/workflows/risky-wf')).status).toBe(404); // not published yet

    expect((await author.post(`/v1/changes/${id}/approve`, {})).status).toBe(403); // authors cannot approve
    const pending = (await approver.get('/v1/changes?status=pending')).body.items;
    expect(pending.some((c: any) => c.id === id)).toBe(true);
    const detail = (await approver.get(`/v1/changes/${id}`)).body;
    expect(detail.manifestText).toContain('file-write');
    expect(detail.risk.level).toBeDefined();

    const ok = await approver.post(`/v1/changes/${id}/approve`, { comment: 'idempotency key looks right' });
    expect(ok.status).toBe(200);
    expect(ok.body.published).toEqual({ name: 'risky-wf', version: '1.0.0' });
    expect((await admin.get('/v1/workflows/risky-wf')).status).toBe(200);
  });

  it('supports rejection', async () => {
    const author = await api.key(['author']);
    const approver = await api.key(['approver']);
    const res = await publish(author, effectful('rejected-wf'));
    const rej = await approver.post(`/v1/changes/${res.body.change.id}/reject`, { comment: 'not now' });
    expect(rej.body.status).toBe('rejected');
    expect((await approver.post(`/v1/changes/${res.body.change.id}/approve`, {})).status).toBe(409);
  });
});

describe('approvals over HTTP', () => {
  it('routes an approval step to a different person and resumes the run', async () => {
    await publish(
      admin,
      yamlWf('gated-wf', [
        { id: 'gate', type: 'approval', message: 'Ship it?', timeout: '1h', onTimeout: 'deny' },
        echoStep('after', 'shipped', { dependsOn: ['gate'] }),
      ]),
    );
    const runner = await api.key(['operator']);
    const approver = await api.key(['approver']);
    const id = await runOf(runner, 'gated-wf');
    await until(async () => (await approver.get('/v1/approvals?status=pending')).body.items.length > 0);
    const [a] = (await approver.get('/v1/approvals?status=pending')).body.items;
    expect(a).toMatchObject({ message: 'Ship it?', status: 'pending', canDecide: true });

    expect((await runner.post(`/v1/approvals/${a.id}/decide`, { decision: 'approved' })).status).toBe(403); // operators may not decide
    expect((await approver.post(`/v1/approvals/${a.id}/decide`, { decision: 'maybe' })).status).toBe(400);
    const decided = await approver.post(`/v1/approvals/${a.id}/decide`, { decision: 'approved', comment: 'ok' });
    expect(decided.body).toMatchObject({ status: 'approved', decidedBy: expect.any(String) });
    expect((await finished(runner, id)).run.status).toBe('succeeded');
    expect((await approver.post(`/v1/approvals/${a.id}/decide`, { decision: 'denied' })).status).toBe(409);
  });
});

describe('secrets, capabilities and controls', () => {
  it('stores secrets without ever returning or auditing their value', async () => {
    const value = 'super-secret-value-9f8e7d6c';
    expect((await admin.put('/v1/secrets/API_TOKEN', { value, description: 'the token' })).status).toBe(200);
    expect((await admin.put('/v1/secrets/bad name', { value })).status).toBe(400);
    const listed = await admin.get('/v1/secrets');
    expect(listed.body.items[0]).toMatchObject({ name: 'API_TOKEN', description: 'the token' });
    expect(listed.text).not.toContain(value);
    const audit = await admin.get('/v1/audit/events?type=secret.written');
    expect(audit.text).not.toContain(value);
    expect((await (await api.key(['author'])).put('/v1/secrets/X', { value: 'v' })).status).toBe(403);
    expect((await admin.del('/v1/secrets/API_TOKEN')).status).toBe(200);
    expect((await admin.del('/v1/secrets/API_TOKEN')).status).toBe(404);
  });

  it('lists the capability catalogue and applies capability kill switches', async () => {
    const caps = (await admin.get('/v1/capabilities')).body.items;
    const names = caps.map((c: any) => c.name);
    expect(names).toEqual(expect.arrayContaining(['http-get', 'util-echo', 'file-write']));
    expect(caps.find((c: any) => c.name === 'file-write')).toMatchObject({
      effect: 'effectful',
      dryRun: 'simulate',
      family: 'storage',
      killed: null,
      circuit: 'closed',
    });

    await publish(admin, yamlWf('needs-echo', [echoStep('a', 1)]));
    expect((await admin.post('/v1/capabilities/util-echo/kill', { reason: 'drill' })).status).toBe(200);
    const id = await runOf(admin, 'needs-echo');
    const blocked = await finished(admin, id);
    expect(blocked.run.status).toBe('failed');
    expect(blocked.run.error.code).toBe('CAPABILITY_KILLED');
    expect((await admin.post('/v1/capabilities/util-echo/revive', {})).status).toBe(200);
    expect((await finished(admin, await runOf(admin, 'needs-echo'))).run.status).toBe('succeeded');
    expect((await admin.post('/v1/capabilities/nope/kill', {})).status).toBe(404);
  });

  it('applies the workflow kill switch', async () => {
    await publish(admin, yamlWf('killable', [echoStep('a', 1)]));
    expect((await admin.post('/v1/workflows/killable/kill', { reason: 'incident 12' })).status).toBe(200);
    const r = await admin.post('/v1/workflows/killable/run', {});
    expect(r.status).toBe(409);
    expect(r.body.error.message).toContain('incident 12');
    await admin.post('/v1/workflows/killable/revive', {});
    expect((await admin.post('/v1/workflows/killable/run', {})).status).toBe(202);
  });

  it('manages canaries and rollbacks', async () => {
    await publish(admin, yamlWf('rolling', [echoStep('a', 1)], {}, '1.0.0'));
    const v2 = await admin.post('/v1/workflows', {
      manifest: yamlWf('rolling', [echoStep('a', 2)], {}, '1.1.0'),
      canaryPercent: 50,
    });
    expect(v2.status).toBe(201);
    let detail = (await admin.get('/v1/workflows/rolling')).body;
    expect(detail.settings).toMatchObject({ stableVersion: '1.0.0', canaryVersion: '1.1.0', canaryPercent: 50 });
    expect((await admin.post('/v1/workflows/rolling/promote', {})).status).toBe(200);
    detail = (await admin.get('/v1/workflows/rolling')).body;
    expect(detail.settings).toMatchObject({ stableVersion: '1.1.0', canaryPercent: 0 });
    expect((await admin.post('/v1/workflows/rolling/activate', { version: '1.0.0' })).status).toBe(200);
    expect((await admin.get('/v1/workflows/rolling')).body.settings.stableVersion).toBe('1.0.0');
  });
});

describe('administration and tenancy', () => {
  it('manages users under a password policy and protects against self-lockout', async () => {
    expect(
      (await admin.post('/v1/users', { email: 'weak@example.com', password: 'short', roles: ['viewer'] })).status,
    ).toBe(400);
    expect(
      (
        await admin.post('/v1/users', {
          email: 'not-an-email',
          password: 'a-long-enough-passphrase',
          roles: ['viewer'],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await admin.post('/v1/users', {
          email: 'u@example.com',
          password: 'a-long-enough-passphrase',
          roles: ['superuser'],
        })
      ).status,
    ).toBe(400);
    const created = await admin.post('/v1/users', {
      email: 'Ada@Example.com',
      password: 'a-long-enough-passphrase',
      roles: ['author'],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ email: 'ada@example.com', roles: ['author'], mustChangePassword: true });
    expect(created.body.passwordHash).toBeUndefined();
    expect(
      (
        await admin.post('/v1/users', {
          email: 'ada@example.com',
          password: 'a-long-enough-passphrase',
          roles: ['author'],
        })
      ).status,
    ).toBe(409);
    expect((await admin.patch(`/v1/users/${created.body.id}`, { disabled: true })).status).toBe(200);
    expect(
      (await api.anon.post('/v1/auth/login', { email: 'ada@example.com', password: 'a-long-enough-passphrase' }))
        .status,
    ).toBe(401);
    const me = (await admin.get('/v1/auth/me')).body.principal.id;
    expect((await admin.patch(`/v1/users/${me}`, { disabled: true })).status).toBe(409);
    expect((await admin.patch(`/v1/users/${me}`, { roles: ['viewer'] })).status).toBe(409);
  });

  it('isolates tenants completely', async () => {
    expect((await admin.post('/v1/tenants', { id: 'acme', name: 'Acme Corp' })).status).toBe(201);
    expect((await (await api.key(['admin'])).post('/v1/tenants', { id: 'x1', name: 'X' })).status).toBe(201);
    const created = await admin.post('/v1/users', {
      email: 'root@acme.test',
      password: 'a-long-enough-passphrase',
      roles: ['admin'],
      tenant: 'acme',
    });
    expect(created.status).toBe(201);
    const acme = await api.login('root@acme.test', 'a-long-enough-passphrase');
    expect(acme.cookie).toBeDefined();
    expect((await acme.get('/v1/workflows')).body.items).toEqual([]); // sees none of the default tenant's workflows
    expect((await acme.get('/v1/workflows/order-report')).status).toBe(404);
    expect((await acme.post('/v1/workflows/order-report/run', {})).status).toBe(404);
    const someRun = (await admin.get('/v1/runs?limit=1')).body.items[0].id;
    expect((await acme.get(`/v1/runs/${someRun}`)).status).toBe(404);
    expect((await acme.get('/v1/tenants')).status).toBe(403); // not a platform admin
    expect((await acme.get('/v1/secrets')).body.items).toEqual([]);
    // the tenant's own audit log starts empty of the other tenant's activity
    const events = (await acme.get('/v1/audit/events?limit=500')).body.items;
    expect(events.every((e: any) => e.tenant === 'acme')).toBe(true);
    // and it can publish and run its own workflow with the same name
    expect((await publish(acme, yamlWf('order-report', [echoStep('a', 1)]))).status).toBe(201);
    expect((await acme.get('/v1/workflows')).body.items).toHaveLength(1);
  });

  it('exposes the audit log, its verifiable hash chain, and an NDJSON export', async () => {
    const audit = (await admin.get('/v1/audit/events?limit=5')).body;
    expect(audit.items).toHaveLength(5);
    expect(audit.total).toBeGreaterThan(50);
    expect((await admin.get('/v1/audit/verify')).body).toMatchObject({ ok: true });
    const exp = await api.server.inject({ method: 'GET', url: '/v1/audit/export', headers: { cookie: admin.cookie! } });
    expect(String(exp.headers['content-type'])).toContain('application/x-ndjson');
    const lines = exp.body
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines[0]._meta.chain.ok).toBe(true);
    expect(lines.length).toBeGreaterThan(50);
    expect(lines[1].hash).toMatch(/^sha256:/);
  });
});

describe('triggers over HTTP', () => {
  it('accepts a correctly signed webhook and rejects everything else uniformly', async () => {
    await publish(
      admin,
      yamlWf('hooked-wf', [echoStep('a', '${{ inputs.order }}')], {
        inputs: { order: { type: 'string', required: true } },
        triggers: [{ type: 'webhook', name: 'incoming', inputs: { order: '${{ event.payload.id }}' } }],
      }),
    );
    const rot = await admin.post('/v1/workflows/hooked-wf/triggers/incoming/rotate-secret');
    expect(rot.status).toBe(200);
    expect(rot.body.secret).toMatch(/^whsec_/);
    expect(rot.body.url).toContain('/v1/hooks/default/hooked-wf/incoming');

    const body = JSON.stringify({ id: 'o-77' });
    const ts = Math.floor(Date.now() / 1000);
    const send = (over: Record<string, string> = {}, payload = body) =>
      api.anon.request('POST', '/v1/hooks/default/hooked-wf/incoming', {
        raw: payload,
        headers: {
          'x-omniflow-timestamp': String(ts),
          'x-omniflow-signature': signWebhook(rot.body.secret, ts, payload),
          'x-omniflow-delivery': `d-${Math.random()}`,
          ...over,
        },
      });
    const ok = await send();
    expect(ok.status).toBe(202);
    expect(ok.body).toMatchObject({ status: 'queued' });
    expect((await finished(admin, ok.body.runId)).run.inputs).toEqual({ order: 'o-77' });

    expect((await send({ 'x-omniflow-signature': 'v1=00' })).status).toBe(401);
    expect((await send({ 'x-omniflow-delivery': 'fixed' })).status).toBe(202);
    expect((await send({ 'x-omniflow-delivery': 'fixed' })).status).toBe(401); // replay
    expect(
      (
        await send(
          { 'x-omniflow-signature': signWebhook(rot.body.secret, ts, body) },
          JSON.stringify({ id: 'tampered' }),
        )
      ).status,
    ).toBe(401); // signed body differs from the delivered one
  });

  it('publishes events that resume waiting steps', async () => {
    await publish(
      admin,
      yamlWf(
        'waiting-wf',
        [
          {
            id: 'w',
            type: 'wait',
            until: { event: 'payment.settled', correlation: '${{ inputs.o }}' },
            timeout: '30s',
          },
        ],
        { inputs: { o: { type: 'string', required: true } } },
      ),
    );
    const id = await runOf(admin, 'waiting-wf', { o: 'o-1' });
    await until(async () => (await admin.get(`/v1/runs/${id}`)).body.run.status === 'waiting-event');
    const ev = await admin.post('/v1/events', { type: 'payment.settled', payload: { amount: 5 }, correlation: 'o-1' });
    expect(ev.status).toBe(202);
    expect(ev.body.resumed).toBe(1);
    expect((await finished(admin, id)).run.status).toBe('succeeded');
  });
});

describe('confidential data handling', () => {
  it('hides confidential inputs and outputs from listings and restricts direct output access', async () => {
    await publish(
      admin,
      yamlWf('pii-wf', [{ ...echoStep('id', { ssn: '${{ inputs.ssn }}' }), sensitivity: 'confidential' }], {
        inputs: { ssn: { type: 'string', required: true, sensitivity: 'confidential' } },
      }),
    );
    const id = await runOf(admin, 'pii-wf', { ssn: '123-45-6789' });
    const detail = await finished(admin, id);
    expect(detail.run.inputs).toEqual({ ssn: '[REDACTED]' });
    expect(detail.steps[0].output).toMatchObject({ redacted: true });
    expect(JSON.stringify(detail)).not.toContain('123-45-6789');
    const events = await admin.get(`/v1/runs/${id}/events`);
    expect(events.text).not.toContain('123-45-6789');
    // operators/admins can read the actual output; other roles cannot
    expect((await admin.get(`/v1/runs/${id}/steps/id/output`)).body.output.value).toEqual({ ssn: '123-45-6789' });
    expect((await (await api.key(['author'])).get(`/v1/runs/${id}/steps/id/output`)).status).toBe(403);
  });
});
