import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultAdapterConfig } from '../../capabilities/index.ts';
import { verifyWebhook } from '../../security/webhook.ts';
import { loadConfig } from '../../server/config.ts';
import { parseRunWebhooks, WebhookDispatcher } from '../../server/webhooks.ts';
import { type Api, ADMIN, makeApi, until, yamlWf } from '../helpers/api.ts';

interface Hit {
  headers: IncomingMessage['headers'];
  body: string;
}
const SECRET = 'a-secret-of-at-least-16-chars';

/** A local receiver whose answers a test scripts: each request pops the next status (default 200). */
async function receiver() {
  const hits: Hit[] = [];
  const script: number[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      hits.push({ headers: req.headers, body });
      res.statusCode = script.shift() ?? 200;
      res.end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { hits, script, url: `http://127.0.0.1:${port}/hook/path-with-a-token`, close: () => server.close() };
}

const echo = (name: string) =>
  yamlWf(name, [{ id: 'a', type: 'capability', uses: 'util-echo@^1', with: { value: '${{ inputs.note }}' } }], {
    inputs: { note: { type: 'string', default: 'x' } },
  });

let api: Api | undefined;
let rx: Awaited<ReturnType<typeof receiver>> | undefined;
afterEach(async () => {
  await api?.stop();
  rx?.close();
  api = undefined;
  rx = undefined;
});

async function setup(hooks: unknown[] = [{}]) {
  rx = await receiver();
  const cfg = hooks.map((h) => ({ url: rx!.url, secret: SECRET, ...(h as object) }));
  api = await makeApi({
    env: {
      OMNIFLOW_ENV: 'development',
      OMNIFLOW_ALLOW_PRIVATE_EGRESS: 'true',
      OMNIFLOW_RUN_WEBHOOKS: JSON.stringify(cfg),
    },
  });
  const admin = await api.login();
  return { admin, hooks: api.app.webhooks! };
}

async function runOnce(admin: Awaited<ReturnType<Api['login']>>, name: string, input = 'x') {
  expect((await admin.post('/v1/workflows', { manifest: echo(name) })).status).toBeLessThan(300);
  const r = await admin.post(`/v1/workflows/${name}/run`, { inputs: { note: input } });
  expect(r.status).toBe(202);
  const id = r.body.run.id as string;
  await until(async () => (await admin.get(`/v1/runs/${id}`)).body.run.status === 'succeeded');
  return id;
}

describe('outbound run webhooks', () => {
  it('delivers a signed event with the run, and nothing from the run inputs', async () => {
    const { admin, hooks } = await setup();
    const id = await runOnce(admin, 'hook-one', 'super-secret-input-value');
    expect(await hooks.tick()).toBe(1);
    expect(rx!.hits).toHaveLength(1);
    const { headers, body } = rx!.hits[0]!;
    expect(headers['x-omniflow-event']).toBe('run.succeeded');
    expect(headers['x-omniflow-delivery']).toMatch(/^evt_/);
    const verdict = verifyWebhook({
      secret: SECRET,
      timestamp: String(headers['x-omniflow-timestamp']),
      signature: String(headers['x-omniflow-signature']),
      rawBody: body,
      nowMs: Date.now(),
    });
    expect(verdict.ok).toBe(true);
    const event = JSON.parse(body);
    expect(event).toMatchObject({
      type: 'run.succeeded',
      tenant: 'default',
      run: { id, workflow: 'hook-one', status: 'succeeded' },
    });
    expect(body).not.toContain('super-secret-input-value');
    expect(body).not.toContain(SECRET);
  });

  it('does not deliver twice: a second pass and a restarted dispatcher find nothing new', async () => {
    const { admin, hooks } = await setup();
    await runOnce(admin, 'hook-two');
    expect(await hooks.tick()).toBe(1);
    expect(await hooks.tick()).toBe(0);
    const fresh = new WebhookDispatcher({
      state: api!.app.state,
      hooks: api!.app.config.runWebhooks as never,
      adapters: { ...defaultAdapterConfig(), allowPrivateNetworks: true },
    });
    expect(fresh.collect()).toBe(0);
    expect(await fresh.tick()).toBe(0);
    expect(rx!.hits).toHaveLength(1);
  });

  it('retries a failing receiver with the same delivery id, then succeeds', async () => {
    const { admin, hooks } = await setup();
    rx!.script.push(503);
    await runOnce(admin, 'hook-retry');
    expect(await hooks.tick()).toBe(0);
    const row = api!.app.state.webhooks.list('default')[0]!;
    expect(row).toMatchObject({ status: 'pending', attempts: 1, lastStatus: 503 });
    api!.app.state.db.run("UPDATE webhook_deliveries SET next_attempt_at = '2000-01-01T00:00:00.000Z'");
    expect(await hooks.tick()).toBe(1);
    expect(rx!.hits).toHaveLength(2);
    expect(rx!.hits[1]!.headers['x-omniflow-delivery']).toBe(rx!.hits[0]!.headers['x-omniflow-delivery']);
    expect(api!.app.state.webhooks.list('default')[0]).toMatchObject({ status: 'delivered', attempts: 2 });
  });

  it('gives up at once on a 4xx other than 408/429', async () => {
    const { admin, hooks } = await setup();
    rx!.script.push(404);
    await runOnce(admin, 'hook-404');
    await hooks.tick();
    expect(api!.app.state.webhooks.list('default')[0]).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastStatus: 404,
    });
    api!.app.state.db.run("UPDATE webhook_deliveries SET next_attempt_at = '2000-01-01T00:00:00.000Z'");
    await hooks.tick();
    expect(rx!.hits).toHaveLength(1);
  });

  it('honours the event filter and the tenant', async () => {
    const { admin, hooks } = await setup([{ events: ['run.failed'] }]);
    await runOnce(admin, 'hook-filter');
    expect(await hooks.tick()).toBe(0);
    expect(rx!.hits).toHaveLength(0);

    api!.app.state.identity.ensureTenant('other', 'Other');
    api!.app.state.events.append({
      tenant: 'other',
      type: 'run.failed',
      runId: 'run_x',
      data: { error: { code: 'X', message: 'boom' } },
    });
    expect(await hooks.tick()).toBe(0); // the hook belongs to tenant "default"
    expect(rx!.hits).toHaveLength(0);
  });

  it('lists deliveries for the workspace and shows only the origin of the receiver', async () => {
    const { admin, hooks } = await setup();
    await runOnce(admin, 'hook-list');
    await hooks.tick();
    const res = await admin.get('/v1/webhooks/deliveries');
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({ event: 'run.succeeded', status: 'delivered', attempts: 1 });
    expect(res.body.items[0].origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(res.text).not.toContain('path-with-a-token');
    expect(res.text).not.toContain(SECRET);
    const viewer = await api!.key(['viewer']);
    expect((await viewer.get('/v1/webhooks/deliveries')).status).toBe(403);
  });

  it('marks a delivery failed when its webhook is removed from the configuration', async () => {
    const { admin } = await setup();
    await runOnce(admin, 'hook-removed');
    const gone = new WebhookDispatcher({ state: api!.app.state, hooks: [], adapters: defaultAdapterConfig() });
    api!.app.webhooks!.stop();
    // enqueue through the real dispatcher, then deliver through one that no longer knows the hook
    await api!.app.webhooks!.tick().catch(() => 0);
    api!.app.state.db.run(
      "UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = '2000-01-01T00:00:00.000Z'",
    );
    await gone.tick();
    expect(api!.app.state.webhooks.list('default')[0]).toMatchObject({ status: 'failed' });
    expect(api!.app.state.webhooks.list('default')[0]?.lastError).toContain('removed');
  });
});

describe('OMNIFLOW_RUN_WEBHOOKS configuration', () => {
  const ok = { url: 'https://ops.example.com/h', secret: SECRET };
  const parse = (v: unknown, production = true) => parseRunWebhooks(JSON.stringify(v), { production });

  it('accepts a minimal entry and applies the defaults', () => {
    const [h] = parse([ok]);
    expect(h).toMatchObject({ tenant: 'default', url: ok.url });
    expect(h!.events).toContain('run.failed');
    expect(h!.events).not.toContain('run.started');
    expect(h!.id).toMatch(/^[0-9a-f]{12}$/);
  });

  it.each([
    ['not json', 'nope'],
    ['not an array', {}],
    ['plain http in production', [{ ...ok, url: 'http://ops.example.com/h' }]],
    ['credentials in the url', [{ ...ok, url: 'https://u:p@ops.example.com/h' }]],
    ['a short secret', [{ ...ok, secret: 'short' }]],
    ['an unknown event', [{ ...ok, events: ['run.exploded'] }]],
    ['an empty event list', [{ ...ok, events: [] }]],
    ['a duplicate', [ok, ok]],
  ])('rejects %s', (_name, value) => {
    expect(() =>
      parseRunWebhooks(typeof value === 'string' ? value : JSON.stringify(value), { production: true }),
    ).toThrow();
  });

  it('allows plain http to localhost only outside production', () => {
    const local = [{ ...ok, url: 'http://127.0.0.1:9/h' }];
    expect(() => parse(local, true)).toThrow();
    expect(parse(local, false)).toHaveLength(1);
    // ...but never to a remote host, in any environment
    expect(() => parse([{ ...ok, url: 'http://ops.example.com/h' }], false)).toThrow();
  });

  it('stops the server at start-up with the variable named', () => {
    const base = { OMNIFLOW_ADMIN_PASSWORD: ADMIN.password, OMNIFLOW_MASTER_KEY: `${'x'.repeat(43)}=` };
    expect(() =>
      loadConfig({ ...base, OMNIFLOW_RUN_WEBHOOKS: '[{"url":"http://x.example.com","secret":"short"}]' }),
    ).toThrow(/OMNIFLOW_RUN_WEBHOOKS/);
  });
});
