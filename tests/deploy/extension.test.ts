import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemClock } from '../../core/index.ts';
import { createRegistry, lookupCustomer } from '../../examples/custom-capability/server.ts';
import { buildServer } from '../../gateway/server.ts';
import { loadConfig } from '../../server/config.ts';
import { createOmniflow } from '../../server/platform.ts';
import { type Client, until, yamlWf } from '../helpers/api.ts';
import { makeState } from '../helpers/state.ts';

describe('the documented extension path: a custom distribution with its own capability', () => {
  let app: ReturnType<typeof createOmniflow>;
  let admin: Client;
  let server: Awaited<ReturnType<typeof buildServer>>['server'];

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omniflow-ext-'));
    const config = loadConfig(
      {
        OMNIFLOW_DATA_DIR: dir,
        OMNIFLOW_ADMIN_PASSWORD: 'correct-horse-battery-staple',
        OMNIFLOW_LOG_LEVEL: 'silent',
        OMNIFLOW_ENV: 'development',
      },
      { cwd: dir },
    );
    app = createOmniflow(config, { state: makeState({ clock: systemClock }), capabilities: createRegistry(config) });
    await app.start();
    ({ server } = await buildServer(app));
    await server.ready();
    const res = await server.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'admin@omniflow.local', password: 'correct-horse-battery-staple' },
    });
    const cookie = String(res.headers['set-cookie']).split(';')[0]!;
    const call = async (method: string, url: string, body?: unknown) => {
      const r = await server.inject({
        method: method as never,
        url,
        headers: { cookie, 'x-requested-with': 'omniflow', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { payload: JSON.stringify(body) } : {}),
      });
      return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
    };
    admin = {
      get: (u: string) => call('GET', u),
      post: (u: string, b?: unknown) => call('POST', u, b ?? {}),
    } as unknown as Client;
  });
  afterAll(async () => {
    await server.close();
    await app.orchestrator.stop();
    app.scheduler.stop();
    app.triggers.stop();
    app.alerts.stop();
  });

  it('registers as a plugin with a named owner, next to the built-ins', async () => {
    const caps = (await admin.get('/v1/capabilities')).body.items as Array<{
      name: string;
      source: string;
      owner: string;
    }>;
    expect(caps.find((c) => c.name === 'acme-lookup-customer')).toMatchObject({
      source: 'plugin',
      owner: 'crm-platform-team',
    });
    expect(caps.some((c) => c.name === 'util-echo')).toBe(true);
  });

  it('is validated, run and failure-classified like any built-in', async () => {
    const wf = yamlWf(
      'customer-tier',
      [{ id: 'find', type: 'capability', uses: 'acme-lookup-customer@^1', with: { customerId: '${{ inputs.id }}' } }],
      {
        inputs: { id: { type: 'string', required: true } },
        outputs: { tier: '${{ steps.find.output.tier }}' },
      },
    );
    expect((await admin.post('/v1/workflows', { manifest: wf })).status).toBe(201);

    const ok = (await admin.post('/v1/workflows/customer-tier/run', { inputs: { id: 'c_1' } })).body.run.id as string;
    await until(() => app.state.runs.getRun(ok)?.status === 'succeeded');
    expect((await admin.get(`/v1/runs/${ok}`)).body.run.outputs).toEqual({ tier: 'pro' });

    const missing = (await admin.post('/v1/workflows/customer-tier/run', { inputs: { id: 'c_999' } })).body.run
      .id as string;
    await until(() => app.state.runs.getRun(missing)?.status === 'failed');
    expect(app.state.runs.getRun(missing)!.error).toMatchObject({ code: 'CUSTOMER_NOT_FOUND', class: 'business' });

    // the declared input schema is enforced at compile time, before anything runs
    const bad = yamlWf('bad-customer', [
      { id: 'find', type: 'capability', uses: 'acme-lookup-customer@^1', with: { customerId: 'not-an-id', extra: 1 } },
    ]);
    expect((await admin.post('/v1/workflows', { manifest: bad })).status).toBe(400);
  });

  it('can be unit-tested on its own, with no platform at all', async () => {
    const ctx = { log: () => {} } as never;
    expect(await lookupCustomer.execute(ctx, { customerId: 'c_2' })).toEqual({ name: 'Globex', tier: 'free' });
    await expect(lookupCustomer.execute(ctx, { customerId: 'c_0' })).rejects.toMatchObject({
      code: 'CUSTOMER_NOT_FOUND',
    });
  });
});
