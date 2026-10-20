import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../server/config.ts';
import { type Api, type Client, echoStep, makeApi, until, yamlWf } from '../helpers/api.ts';

let api: Api;
let admin: Client;
beforeAll(async () => {
  api = await makeApi();
  admin = await api.login();
});
afterAll(async () => {
  await api.stop();
});

const failStep = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'capability',
  uses: 'util-fail@^1',
  with: { errorClass: 'business', message: 'nope' },
  ...extra,
});

async function runMany(workflow: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) expect((await admin.post(`/v1/workflows/${workflow}/run`, {})).status).toBe(202);
  await until(
    () =>
      api.app.state.runs
        .listRuns({ tenant: 'default', workflow, limit: 100 })
        .every((r) => ['succeeded', 'failed'].includes(r.status)) &&
      api.app.state.runs.countRuns({ tenant: 'default', workflow }) >= n,
  );
}

describe('insight endpoints', () => {
  it('require authentication and the right role', async () => {
    expect((await api.anon.get('/v1/insights/overview')).status).toBe(401);
    expect((await api.anon.get('/v1/proposals')).status).toBe(401);
    const viewer = await api.key(['viewer']);
    expect((await viewer.get('/v1/insights/overview')).status).toBe(200);
    expect((await viewer.get('/v1/insights/alerts')).status).toBe(200);
    expect((await viewer.post('/v1/insights/analyze')).status).toBe(403);
    expect((await viewer.post('/v1/proposals/prp_x/decide', { status: 'dismissed' })).status).toBe(403);
  });

  it('shows what ran on the dashboard', async () => {
    await admin.post('/v1/workflows', { manifest: yamlWf('dash-ok', [echoStep('a', 1)]) });
    await admin.post('/v1/workflows', { manifest: yamlWf('dash-bad', [failStep('x')]) });
    await runMany('dash-ok', 3);
    await runMany('dash-bad', 2);
    const o = (await admin.get('/v1/insights/overview?hours=6')).body;
    expect(o.window.hours).toBe(6);
    expect(o.runs).toMatchObject({ total: 5, succeeded: 3, failed: 2 });
    expect(o.workflows.map((w: { name: string }) => w.name).sort()).toEqual(['dash-bad', 'dash-ok']);
    expect(o.failingSteps[0]).toMatchObject({ workflow: 'dash-bad', stepId: 'x', failed: 2 });
    expect((await admin.get('/v1/insights/overview?hours=0')).status).toBe(400);
  });

  it('runs the analysis agent on demand and manages the proposal queue', async () => {
    // A step that always fails, with the failure swallowed: exactly the kind of thing the agent should notice.
    await admin.post('/v1/workflows', {
      manifest: yamlWf('swallower', [
        echoStep('first', 1),
        failStep('flaky', { dependsOn: ['first'], onError: 'continue' }),
      ]),
    });
    await runMany('swallower', 12);

    const analysed = await admin.post('/v1/insights/analyze');
    expect(analysed.status).toBe(200);
    expect(analysed.body.raised).toBeGreaterThanOrEqual(1);
    const open = (await admin.get('/v1/proposals?status=open&workflow=swallower')).body.items;
    const p = open.find((x: { kind: string }) => x.kind === 'analysis.ignored-failure');
    expect(p).toMatchObject({ workflowName: 'swallower', source: 'analysis-agent', status: 'open' });
    expect(p.body.evidence).toMatchObject({ ignoredFailures: 12 });
    expect((await admin.get(`/v1/proposals/${p.id}`)).body.title).toContain('flaky');

    // running it again does not pile up duplicates
    const again = await admin.post('/v1/insights/analyze');
    expect(again.body.raised).toBe(0);

    // dismissing it takes it off the open list, once
    const decided = await admin.post(`/v1/proposals/${p.id}/decide`, { status: 'dismissed' });
    expect(decided.status).toBe(200);
    expect(decided.body).toMatchObject({ status: 'dismissed', decidedBy: expect.any(String) });
    expect((await admin.post(`/v1/proposals/${p.id}/decide`, { status: 'accepted' })).status).toBe(409);
    expect(
      (await admin.get('/v1/proposals?status=open&workflow=swallower')).body.items.some(
        (x: { id: string }) => x.id === p.id,
      ),
    ).toBe(false);
    expect((await admin.post('/v1/proposals/prp_nope/decide', { status: 'accepted' })).status).toBe(404);
    expect((await admin.post(`/v1/proposals/${p.id}/decide`, { status: 'exploded' })).status).toBe(400);

    // the analysis is recorded in the audit log, but the workflow itself was not touched
    const audit = (await admin.get('/v1/audit/events?type=insight.analysis-completed,agent.proposal-created')).body
      .items;
    expect(audit.length).toBeGreaterThanOrEqual(2);
    expect((await admin.get('/v1/workflows/swallower')).body.settings.stableVersion).toBe('1.0.0');
  });

  it('keeps proposals and dashboards inside their tenant', async () => {
    api.app.state.identity.ensureTenant('acme', 'Acme');
    const other = await api.key(['admin'], 'acme');
    expect((await other.get('/v1/proposals')).body.items).toEqual([]);
    expect((await other.get('/v1/insights/overview')).body.runs.total).toBe(0);
    const someId = (await admin.get('/v1/proposals')).body.items[0].id;
    expect((await other.get(`/v1/proposals/${someId}`)).status).toBe(404);
    expect((await other.post(`/v1/proposals/${someId}/decide`, { status: 'dismissed' })).status).toBe(404);
  });

  it('lists open alerts (none on a healthy system) and history', async () => {
    const r = await admin.get('/v1/insights/alerts');
    expect(r.status).toBe(200);
    expect(r.body.active).toBeInstanceOf(Array);
    expect(r.body.history).toBeInstanceOf(Array);
  });
});

describe('alert configuration', () => {
  const base = { OMNIFLOW_DATA_DIR: '', OMNIFLOW_LOG_LEVEL: 'silent' };
  it('accepts alert channels that are defined, and rejects ones that are not', () => {
    const dir = api.dir;
    const ok = loadConfig(
      {
        ...base,
        OMNIFLOW_DATA_DIR: dir,
        OMNIFLOW_CHANNELS: '{"ops":"slack:https://hooks.slack.com/x"}',
        OMNIFLOW_ALERT_CHANNELS: 'ops',
      },
      { cwd: dir },
    );
    expect(ok.alertChannels).toEqual(['ops']);
    expect(() =>
      loadConfig({ ...base, OMNIFLOW_DATA_DIR: dir, OMNIFLOW_ALERT_CHANNELS: 'nowhere' }, { cwd: dir }),
    ).toThrow(/not defined in OMNIFLOW_CHANNELS/);
    const defaults = loadConfig({ ...base, OMNIFLOW_DATA_DIR: dir }, { cwd: dir });
    expect(defaults).toMatchObject({ alertChannels: [], analysisIntervalHours: 24, alertIntervalSeconds: 60 });
    expect(() =>
      loadConfig({ ...base, OMNIFLOW_DATA_DIR: dir, OMNIFLOW_ALERT_INTERVAL_SECONDS: '1' }, { cwd: dir }),
    ).toThrow(/between 5 and 3600/);
  });
});

describe("alerts reach the operator's chat channel", () => {
  it('delivers a raised and a resolved alert through the configured webhook', async () => {
    const received: Array<{ text: string }> = [];
    const hook = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push(JSON.parse(body));
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r));
    const port = (hook.address() as { port: number }).port;
    const wired = await makeApi({
      env: {
        OMNIFLOW_CHANNELS: JSON.stringify({ ops: `generic:http://127.0.0.1:${port}/hook` }),
        OMNIFLOW_ALERT_CHANNELS: 'ops',
        OMNIFLOW_ALLOW_PRIVATE_EGRESS: 'true',
      },
    });
    try {
      const a = await wired.login();
      await a.post('/v1/workflows', { manifest: yamlWf('breaks', [failStep('x')]) });
      for (let i = 0; i < 5; i++) await a.post('/v1/workflows/breaks/run', {});
      await until(
        () =>
          wired.app.state.runs.listRuns({ tenant: 'default', workflow: 'breaks' }).filter((r) => r.status === 'failed')
            .length === 5,
      );

      const first = await wired.app.alerts.tick();
      expect(first.raised).toBe(1);
      expect(received).toHaveLength(1);
      expect(received[0]!.text).toContain('[CRITICAL] breaks is failing');
      expect(received[0]!.text).toContain('5 of 5 runs failed');
      expect((await a.get('/v1/insights/alerts')).body.active[0]).toMatchObject({
        key: 'workflow-failing:breaks',
        severity: 'critical',
      });

      // the same problem is not announced twice
      await wired.app.alerts.tick();
      expect(received).toHaveLength(1);
    } finally {
      await wired.stop();
      await new Promise<void>((r) => hook.close(() => r()));
    }
  });

  it('keeps working when the channel is unreachable', async () => {
    const wired = await makeApi({
      env: {
        OMNIFLOW_CHANNELS: JSON.stringify({ ops: 'generic:http://127.0.0.1:1/hook' }),
        OMNIFLOW_ALERT_CHANNELS: 'ops',
        OMNIFLOW_ALLOW_PRIVATE_EGRESS: 'true',
      },
    });
    try {
      const a = await wired.login();
      await a.post('/v1/workflows', { manifest: yamlWf('breaks', [failStep('x')]) });
      for (let i = 0; i < 5; i++) await a.post('/v1/workflows/breaks/run', {});
      await until(
        () =>
          wired.app.state.runs.listRuns({ tenant: 'default', workflow: 'breaks' }).filter((r) => r.status === 'failed')
            .length === 5,
      );
      expect((await wired.app.alerts.tick()).raised).toBe(1);
      expect((await a.get('/v1/insights/alerts')).body.active).toHaveLength(1);
    } finally {
      await wired.stop();
    }
  });
});
