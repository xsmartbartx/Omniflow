import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../server/config.ts';
import { fakeAssertion } from '../../nexora/index.ts';
import type { NexoraRole } from '../../state/index.ts';
import { type Api, makeApi, yamlWf } from '../helpers/api.ts';

const COOKIE = '__session';
const echoStep = (id: string) => ({ id, type: 'capability', uses: 'util-echo@^1', with: { value: id } });

let api: Api;
beforeAll(async () => {
  api = await makeApi({
    env: { OMNIFLOW_MODE: 'nexora', OMNIFLOW_NEXORA_CORE: 'fake', OMNIFLOW_ENV: 'development' },
  });
});
afterAll(async () => {
  await api.stop();
});

const core = () => api.app.nexora!.fake!;
const svc = () => api.app.nexora!.service;
const st = () => api.app.state;

/** Sign in through /app and return a client bound to the OmniFlow session cookie. */
async function signIn(orgId: string, userId: string, role: NexoraRole, email = `${userId}@example.com`) {
  const res = await api.server.inject({
    method: 'GET',
    url: '/app',
    headers: { cookie: `${COOKIE}=${fakeAssertion({ orgId, userId, email, role })}` },
  });
  expect(res.statusCode, res.body).toBe(302);
  const cookie = String(res.headers['set-cookie']).split(';')[0]!;
  const call = async (method: string, url: string, body?: unknown) => {
    const r = await api.server.inject({
      method: method as never,
      url,
      headers: {
        cookie,
        ...(method !== 'GET' ? { 'x-requested-with': 'omniflow' } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null, headers: r.headers };
  };
  return { cookie, call };
}

async function publishHello(call: Awaited<ReturnType<typeof signIn>>['call'], name: string) {
  const res = await call('POST', '/v1/workflows', { manifest: yamlWf(name, [echoStep('a')]) });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
}

describe('mode and configuration', () => {
  it('standalone installs do not expose the NEXORA routes and keep the plain health answer', async () => {
    const s = await makeApi();
    try {
      expect((await s.anon.get('/app')).status).toBe(404);
      expect((await s.anon.get('/healthz')).body).toEqual({ status: 'ok' });
      expect((await s.anon.get('/v1/info')).body.mode).toBe('standalone');
    } finally {
      await s.stop();
    }
  });

  it('refuses the unsigned fake Core in production, and refuses nexora mode without choosing a Core', () => {
    const base = { OMNIFLOW_ADMIN_PASSWORD: 'correct-horse-battery-staple', OMNIFLOW_MASTER_KEY: 'x'.repeat(43) + '=' };
    expect(() => loadConfig({ ...base, OMNIFLOW_MODE: 'nexora', OMNIFLOW_NEXORA_CORE: 'fake' })).toThrow(/production/);
    expect(() => loadConfig({ ...base, OMNIFLOW_MODE: 'nexora', OMNIFLOW_ENV: 'development' })).toThrow(
      /OMNIFLOW_NEXORA_CORE/,
    );
    expect(() => loadConfig({ ...base, OMNIFLOW_MODE: 'sideways' })).toThrow(/OMNIFLOW_MODE/);
  });

  it('reports the product on the health endpoint in nexora mode', async () => {
    const h = await api.anon.get('/healthz');
    expect(h.body).toMatchObject({ status: 'ok', product: 'omniflow', mode: 'nexora' });
  });
});

describe('sign-in', () => {
  it('rejects a missing or forged assertion', async () => {
    expect((await api.anon.get('/app')).status).toBe(401);
    const forged = await api.server.inject({ method: 'GET', url: '/app', headers: { cookie: `${COOKIE}=fake.AAAA` } });
    expect(forged.statusCode).toBe(401);
    const real = await api.server.inject({
      method: 'GET',
      url: '/app',
      headers: { cookie: `${COOKIE}=eyJhbGciOi.real.token` },
    });
    expect(real.statusCode).toBe(401);
  });

  it('provisions an org, a tenant and a user with mapped roles, and sets a short-lived session', async () => {
    const { call, cookie } = await signIn('org_A1', 'user_member', 'member');
    const me = (await call('GET', '/v1/auth/me')).body;
    expect(me.principal).toMatchObject({ tenant: 'nx_org_A1', roles: ['author', 'operator'] });
    expect(st().nexora.getOrg('org_A1')).toMatchObject({ tenant: 'nx_org_A1', plan: 'free', status: 'active' });
    const sess = st().identity.getSession(
      (await import('node:crypto'))
        .createHash('sha256')
        .update(decodeURIComponent(cookie.split('=')[1]!))
        .digest('hex'),
    );
    expect(Date.parse(sess!.expiresAt) - Date.parse(sess!.createdAt)).toBe(5 * 60_000);
  });

  it('applies a role change on the next sign-in and never keeps a password', async () => {
    await signIn('org_A1', 'user_member', 'member');
    const again = await signIn('org_A1', 'user_member', 'viewer');
    expect((await again.call('GET', '/v1/auth/me')).body.principal.roles).toEqual(['viewer']);
    const user = st().identity.getUserByEmail('nx_org_A1', 'user_member@example.com');
    expect(user?.passwordHash).toBeUndefined();
  });

  it('rejects ids that could not be a safe tenant name', async () => {
    const res = await api.server.inject({
      method: 'GET',
      url: '/app',
      headers: {
        cookie: `${COOKIE}=${fakeAssertion({ orgId: "o'; drop--", userId: 'u', email: 'u@example.com', role: 'admin' })}`,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('keeps organisations apart: one cannot see the other’s runs', async () => {
    const a = await signIn('org_ISO1', 'a_admin', 'owner');
    const b = await signIn('org_ISO2', 'b_admin', 'owner');
    await publishHello(a.call, 'iso-a');
    expect((await a.call('POST', '/v1/workflows/iso-a/run', { inputs: {} })).status).toBe(202);
    expect((await a.call('GET', '/v1/runs')).body.items).toHaveLength(1);
    expect((await b.call('GET', '/v1/runs')).body.items).toHaveLength(0);
    expect((await b.call('GET', '/v1/workflows/iso-a')).status).toBe(404);
  });
});

describe('metering', () => {
  it('counts a run once, mirrors it to Core through the outbox, and survives duplicate delivery', async () => {
    const o = await signIn('org_M1', 'm_owner', 'owner');
    await publishHello(o.call, 'meter-me');
    const run = await o.call('POST', '/v1/workflows/meter-me/run', { inputs: {} });
    expect(run.status).toBe(202);

    const usage = (await o.call('GET', '/v1/nexora/usage')).body;
    expect(usage).toMatchObject({ metered: true, orgId: 'org_M1', plan: 'free', used: 1, limit: 100, remaining: 99 });

    const outbox = st().nexora.dueOutbox();
    const row = outbox.find((r) => r.orgId === 'org_M1' && r.name === 'omniflow.run.started')!;
    expect(row).toMatchObject({
      name: 'omniflow.run.started',
      kind: 'usage',
      idempotencyKey: `run.started:${run.body.run.id}`,
    });

    await api.app.nexora!.worker.tick();
    expect(core().usageOf('org_M1')).toBe(1);
    // the same event delivered again does not count twice
    await core().events.send({
      id: row.idempotencyKey,
      kind: 'usage',
      name: row.name,
      orgId: 'org_M1',
      occurredAt: row.occurredAt,
      payload: {},
    });
    expect(core().usageOf('org_M1')).toBe(1);
    expect(
      st()
        .nexora.dueOutbox()
        .filter((r) => r.orgId === 'org_M1'),
    ).toHaveLength(0);
  });

  it('writes the same event once even if the enqueue is repeated', () => {
    const o = st().nexora.getOrg('org_M1')!;
    const item = {
      id: 'dup-1',
      tenant: o.tenant,
      orgId: o.orgId,
      kind: 'usage' as const,
      name: 'omniflow.run.started',
      payload: {},
      idempotencyKey: 'dup-1',
      occurredAt: new Date().toISOString(),
    };
    expect(st().nexora.enqueue(item)).toBe(true);
    expect(st().nexora.enqueue(item)).toBe(false);
  });

  it('refuses a run with 429 when the plan is used up, but still allows dry runs', async () => {
    const o = await signIn('org_L1', 'l_owner', 'owner');
    await publishHello(o.call, 'limit-me');
    for (let i = 0; i < 100; i++)
      await core().events.send({
        id: `pre-${i}`,
        kind: 'usage',
        name: 'omniflow.run.started',
        orgId: 'org_L1',
        occurredAt: new Date().toISOString(),
        payload: {},
      });
    await svc().refreshEntitlement('org_L1');

    const refused = await o.call('POST', '/v1/workflows/limit-me/run', { inputs: {} });
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('ENTITLEMENT_EXCEEDED');
    expect((await o.call('GET', '/v1/runs')).body.items).toHaveLength(0);

    const dry = await o.call('POST', '/v1/workflows/limit-me/run', { inputs: {}, dryRun: true });
    expect(dry.status).toBe(202);
  });

  it('cannot overspend the last unit with back-to-back runs', async () => {
    const o = await signIn('org_L2', 'l2_owner', 'owner');
    await publishHello(o.call, 'last-unit');
    for (let i = 0; i < 99; i++)
      await core().events.send({
        id: `pre2-${i}`,
        kind: 'usage',
        name: 'omniflow.run.started',
        orgId: 'org_L2',
        occurredAt: new Date().toISOString(),
        payload: {},
      });
    await svc().refreshEntitlement('org_L2');
    const results = [];
    for (let i = 0; i < 3; i++)
      results.push((await o.call('POST', '/v1/workflows/last-unit/run', { inputs: {} })).status);
    expect(results).toEqual([202, 429, 429]);
  });

  it('does not meter an organisation-less tenant (the operator’s own default tenant)', async () => {
    const admin = await api.login();
    const wf = yamlWf('ops-own', [echoStep('a')]);
    expect((await admin.post('/v1/workflows', { manifest: wf })).status).toBeLessThan(300);
    expect((await admin.post('/v1/workflows/ops-own/run', { inputs: {} })).status).toBe(202);
    expect((await admin.get('/v1/nexora/usage')).body).toEqual({ metered: false });
  });
});

describe('event mirroring', () => {
  it('mirrors the run outcome as usage and the publish as audit, without inflating the run count', async () => {
    const o = await signIn('org_E1', 'e_owner', 'owner');
    await publishHello(o.call, 'mirror-me');
    const run = await o.call('POST', '/v1/workflows/mirror-me/run', { inputs: {} });
    expect(run.status).toBe(202);
    const rows = async () =>
      st()
        .nexora.dueOutbox()
        .filter((r) => r.orgId === 'org_E1');
    const deadline = Date.now() + 10_000;
    while (!(await rows()).some((r) => r.name === 'omniflow.run.succeeded') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const all = await rows();
    expect(all.find((r) => r.name === 'omniflow.workflow.published')).toMatchObject({ kind: 'audit' });
    const done = all.find((r) => r.name === 'omniflow.run.succeeded')!;
    expect(done).toMatchObject({ kind: 'usage' });
    expect(done.payload).toMatchObject({ runId: run.body.run.id, workflow: 'mirror-me' });

    await api.app.nexora!.worker.tick();
    expect(core().usageOf('org_E1')).toBe(1);
  });

  it('does not mirror events of a tenant without an organisation', () => {
    const before = st().nexora.dueOutbox().length;
    st().events.append({
      type: 'workflow.killed',
      tenant: 'default',
      actor: { kind: 'system', id: 'test' },
      data: { workflow: 'x' },
    } as never);
    expect(st().nexora.dueOutbox()).toHaveLength(before);
  });
});

describe('outage behaviour', () => {
  it('keeps a known org running for the grace period, then refuses with 503', async () => {
    const o = await signIn('org_O1', 'o_owner', 'owner');
    await publishHello(o.call, 'outage');
    core().failEntitlements = true;
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    st().db.run('UPDATE nexora_entitlement_cache SET expires_at = ? WHERE org_id = ?', [ago(60_000), 'org_O1']);
    expect((await o.call('POST', '/v1/workflows/outage/run', { inputs: {} })).status).toBe(202);

    st().db.run('UPDATE nexora_entitlement_cache SET expires_at = ? WHERE org_id = ?', [ago(16 * 60_000), 'org_O1']);
    const down = await o.call('POST', '/v1/workflows/outage/run', { inputs: {} });
    expect(down.status).toBe(503);
    expect(down.body.error.code).toBe('ENTITLEMENT_UNAVAILABLE');
    core().failEntitlements = false;
  });

  it('retries failed deliveries with backoff and delivers them later', async () => {
    const o = await signIn('org_R1', 'r_owner', 'owner');
    await publishHello(o.call, 'retry-me');
    core().failEvents = true;
    await o.call('POST', '/v1/workflows/retry-me/run', { inputs: {} });
    await api.app.nexora!.worker.tick();
    const failed = st().db.get<{ attempts: number; sent_at: string | null; last_error: string }>(
      "SELECT attempts, sent_at, last_error FROM nexora_outbox WHERE org_id = 'org_R1'",
    )!;
    expect(failed).toMatchObject({ attempts: 1, sent_at: null });
    expect(failed.last_error).toContain('unreachable');
    expect(core().usageOf('org_R1')).toBe(0);

    core().failEvents = false;
    st().db.run("UPDATE nexora_outbox SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE org_id = 'org_R1'");
    await api.app.nexora!.worker.tick();
    expect(core().usageOf('org_R1')).toBe(1);
  });
});

describe('lifecycle', () => {
  it('stops a suspended organisation immediately: sessions die and runs are denied', async () => {
    const o = await signIn('org_S1', 's_owner', 'owner');
    await publishHello(o.call, 'suspend-me');
    expect((await o.call('GET', '/v1/auth/me')).status).toBe(200);

    core().status.set('org_S1', 'suspended');
    await svc().refreshEntitlement('org_S1');

    expect((await o.call('GET', '/v1/auth/me')).status).toBe(401);
    const again = await api.server.inject({
      method: 'GET',
      url: '/app',
      headers: {
        cookie: `${COOKIE}=${fakeAssertion({ orgId: 'org_S1', userId: 's_owner', email: 's_owner@example.com', role: 'owner' })}`,
      },
    });
    expect(again.statusCode).toBe(403);
    expect(() => svc().gate.check('nx_org_S1')).toThrow(/suspended/);
  });
});

describe('schema guarantees', () => {
  it('rejects an identity that points at another tenant’s user, and an outbox row for the wrong tenant', () => {
    const a = st().nexora.getOrg('org_A1')!;
    const foreign = st().identity.getUserByEmail('nx_org_ISO1', 'a_admin@example.com')!;
    expect(() =>
      st().nexora.upsertIdentity({
        orgId: a.orgId,
        externalUserId: 'evil',
        tenant: a.tenant,
        userId: foreign.id,
        role: 'admin',
      }),
    ).toThrow();
    expect(() =>
      st().nexora.enqueue({
        id: 'x',
        tenant: 'nx_org_ISO1',
        orgId: a.orgId,
        kind: 'usage',
        name: 'n',
        payload: {},
        idempotencyKey: 'x',
        occurredAt: new Date().toISOString(),
      }),
    ).toThrow();
  });

  it('does not leak the assertion or any key into events', () => {
    const dump = JSON.stringify(st().db.all('SELECT * FROM events'));
    expect(dump).not.toContain('fake.');
  });
});
