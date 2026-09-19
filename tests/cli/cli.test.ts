import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseArgs, parseInputs, UsageError } from '../../cli/args.ts';
import { runCli } from '../../cli/main.ts';
import { openState, stateOptionsFor } from '../../state/index.ts';
import { createLogger } from '../../core/index.ts';
import { loadConfig } from '../../server/config.ts';
import { createOmniflow } from '../../server/platform.ts';
import { buildServer } from '../../gateway/server.ts';
import { type Api, echoStep, makeApi, until, yamlWf } from '../helpers/api.ts';

interface Result {
  code: number;
  out: string;
  err: string;
}

async function cli(argv: string[], opts: { env?: Record<string, string>; stdin?: string; cwd?: string } = {}): Promise<Result> {
  let out = '';
  let err = '';
  const code = await runCli(
    argv,
    { out: (t) => (out += t), err: (t) => (err += t), readStdin: async () => opts.stdin ?? '' },
    { OMNIFLOW_LOG_LEVEL: 'silent', ...opts.env },
    opts.cwd ?? tmpdir(),
  );
  return { code, out, err };
}

const tmp = () => mkdtempSync(join(tmpdir(), 'omniflow-cli-'));
const HELLO = yamlWf('hello', [echoStep('greet', 'hello ${{ inputs.who }}'), echoStep('again', '${{ steps.greet.output.value }}!', { dependsOn: ['greet'] })], {
  inputs: { who: { type: 'string', default: 'world' } },
  outputs: { message: '${{ steps.again.output.value }}' },
});

describe('argument parsing', () => {
  it('handles flags, values, repeats, equals and --', () => {
    const a = parseArgs(['run', 'wf', '--input', 'a=1', '--input=b=2', '--json', '--dry-run', '-h', '--', '--not-a-flag']);
    expect(a.positionals).toEqual(['run', 'wf', '--not-a-flag']);
    expect(a.flags.get('input')).toEqual(['a=1', 'b=2']);
    expect(a.flags.has('json') && a.flags.has('dry-run') && a.flags.has('help')).toBe(true);
  });

  it('decodes JSON-looking input values and keeps strings as strings', () => {
    expect(parseInputs(['n=42', 'f=1.5', 'b=true', 'z=null', 'l=[1,2]', 'o={"a":1}', 's=hello', 'eq=a=b', 'bad=[oops'])).toEqual({
      n: 42, f: 1.5, b: true, z: null, l: [1, 2], o: { a: 1 }, s: 'hello', eq: 'a=b', bad: '[oops',
    });
  });

  it('rejects malformed and prototype-polluting inputs', () => {
    expect(() => parseInputs(['novalue'])).toThrow(UsageError);
    expect(() => parseInputs(['=x'])).toThrow(UsageError);
    expect(() => parseInputs(['__proto__=x'])).toThrow(UsageError);
  });
});

describe('help and errors', () => {
  it('prints help and version; unknown commands are a usage error', async () => {
    expect((await cli(['--help'])).out).toContain('Usage: omniflow');
    expect((await cli([])).code).toBe(2);
    expect((await cli(['--version'])).out).toMatch(/^\d+\.\d+\.\d+/);
    const bad = await cli(['frobnicate']);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("unknown command 'frobnicate'");
  });

  it('asks for an API key instead of calling the server without one', async () => {
    const r = await cli(['workflows']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('OMNIFLOW_API_KEY');
  });

  it('reports an unreachable server clearly', async () => {
    const r = await cli(['workflows', '--key', 'omf_x'], { env: { OMNIFLOW_URL: 'http://127.0.0.1:1' } });
    expect(r.code).toBe(1);
    expect(r.err).toContain('Could not reach');
  });
});

describe('validate and compile (offline)', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'hello.yaml'), HELLO);
  writeFileSync(join(dir, 'bad.yaml'), yamlWf('bad', [{ id: 'one', type: 'capability', uses: 'util-ecoh@^1', with: { value: 1 } }]));
  mkdirSync(join(dir, 'good'));
  writeFileSync(join(dir, 'good', 'a.yaml'), yamlWf('alpha', [echoStep('s', 1)]));
  writeFileSync(join(dir, 'good', 'b.yml'), yamlWf('beta', [echoStep('s', 2)]));
  writeFileSync(join(dir, 'good', 'notes.txt'), 'ignored');

  it('accepts a valid manifest and exits 0', async () => {
    const r = await cli(['validate', 'hello.yaml'], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.out).toContain('hello@1.0.0');
    expect(r.out).toContain('1/1 valid');
  });

  it('points at the offending line with a suggestion, and exits 1', async () => {
    const r = await cli(['validate', 'bad.yaml'], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.err).toContain("UNKNOWN_CAPABILITY");
    expect(r.err).toContain("did you mean 'util-echo'");
    expect(r.err).toMatch(/--> bad\.yaml:\d+:\d+/);
    expect(r.err).toContain('uses: util-ecoh@^1');
  });

  it('expands directories to their yaml files and reports per file', async () => {
    const r = await cli(['validate', 'good'], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.out).toContain('alpha@1.0.0');
    expect(r.out).toContain('beta@1.0.0');
    expect(r.out).toContain('2/2 valid');
    const mixed = await cli(['validate', 'good', 'bad.yaml'], { cwd: dir });
    expect(mixed.code).toBe(1);
    expect(mixed.out).toContain('2/3 valid');
  });

  it('reads from stdin and emits JSON', async () => {
    const r = await cli(['validate', '-', '--json'], { stdin: HELLO });
    const parsed = JSON.parse(r.out);
    expect(r.code).toBe(0);
    expect(parsed[0]).toMatchObject({ ok: true, workflow: 'hello', steps: 2, risk: { level: 'low' } });
    expect(parsed[0].planHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('usage errors: no files, missing path', async () => {
    expect((await cli(['validate'])).code).toBe(2);
    expect((await cli(['validate', 'nope.yaml'], { cwd: dir })).code).toBe(2);
    expect((await cli(['validate', 'x.yaml', '--env', 'moon'], { cwd: dir })).code).toBe(2);
  });

  it('compile prints the plan hash and writes the plan file', async () => {
    const r = await cli(['compile', 'hello.yaml', '--out', 'plan.json'], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.out).toContain('greet');
    const written = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8'));
    expect(written.hash).toMatch(/^sha256:/);
    expect(written.plan.steps).toHaveLength(2);
    expect((await cli(['compile', 'bad.yaml'], { cwd: dir })).code).toBe(1);
  });

  it('compiles to the same plan hash the server computes (one compiler, two front ends)', async () => {
    const api = await makeApi();
    try {
      const admin = await api.login();
      const server = (await admin.post('/v1/workflows/validate', { manifest: HELLO })).body.planHash;
      const local = JSON.parse((await cli(['compile', '-', '--json'], { stdin: HELLO })).out).hash;
      expect(local).toBe(server);
    } finally {
      await api.stop();
    }
  });
});

describe('dev (embedded run)', () => {
  it('runs a workflow end to end and leaves nothing behind', async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, 'hello.yaml'), HELLO);
    const r = await cli(['dev', 'hello.yaml', '--input', 'who=Ada'], { cwd });
    expect(r.code).toBe(0);
    expect(r.out).toContain('hello Ada!');
    expect(r.out).toMatch(/greet[\s\S]*again/);
    // no data directory was created in the working directory
    expect(() => readFileSync(join(cwd, 'data', 'omniflow.db'))).toThrow();
  });

  it('exits 1 when the run fails and shows why', async () => {
    const wf = yamlWf('boom', [{ id: 'x', type: 'capability', uses: 'util-fail@^1', with: { errorClass: 'business', message: 'nope' } }]);
    const r = await cli(['dev', '-'], { stdin: wf });
    expect(r.code).toBe(1);
    expect(r.out).toContain('failed');
  });

  it('supports --dry-run and machine-readable output', async () => {
    const r = await cli(['dev', '-', '--json', '--dry-run'], { stdin: HELLO });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ status: 'succeeded', outputs: { message: 'hello world!' } });
  });

  it('passes secrets to the ephemeral store and can auto-answer approval gates', async () => {
    const wf = yamlWf('gated', [{ id: 'gate', type: 'approval', message: 'Ship it?', timeout: '1h', onTimeout: 'deny' }, echoStep('after', 'shipped', { dependsOn: ['gate'] })]);
    const waiting = cli(['dev', '-', '--timeout', '1'], { stdin: wf });
    expect((await waiting).code).toBe(1);
    const r = await cli(['dev', '-', '--auto-approve'], { stdin: wf });
    expect(r.code).toBe(0);
    expect(r.err).toContain('auto-approved');
  });

  it('rejects unusable input flags', async () => {
    expect((await cli(['dev', '-', '--input', 'broken'], { stdin: HELLO })).code).toBe(2);
    expect((await cli(['dev', '-', '--secret', 'noequals'], { stdin: HELLO })).code).toBe(2);
    expect((await cli(['dev'])).code).toBe(2);
  });
});

describe('remote commands against a live server', () => {
  let api: Api;
  let url = '';
  let key = '';
  const env = () => ({ OMNIFLOW_URL: url, OMNIFLOW_API_KEY: key });

  beforeAll(async () => {
    api = await makeApi();
    await api.server.listen({ host: '127.0.0.1', port: 0 });
    const addr = api.server.server.address();
    url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    key = (await api.key(['admin'])).apiKey!;
  });
  afterAll(async () => {
    await api.stop();
  });

  it('reports server status without needing a key', async () => {
    const r = await cli(['status'], { env: { OMNIFLOW_URL: url } });
    expect(r.code).toBe(0);
    expect(r.out).toContain('OmniFlow');
    expect(r.out).toContain('ready: yes');
  });

  it('rejects a bad key with a hint', async () => {
    const r = await cli(['workflows'], { env: { OMNIFLOW_URL: url, OMNIFLOW_API_KEY: 'omf_000000000000_wrong' } });
    expect(r.code).toBe(1);
    expect(r.err).toContain('Check OMNIFLOW_API_KEY');
  });

  it('publishes, lists, runs, follows, inspects and audits a workflow', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'hello.yaml'), HELLO);

    const pub = await cli(['publish', 'hello.yaml'], { env: env(), cwd: dir });
    expect(pub.code).toBe(0);
    expect(pub.out).toContain('published hello@1.0.0');
    // publishing the same version again is a conflict, reported cleanly
    const dup = await cli(['publish', 'hello.yaml'], { env: env(), cwd: dir });
    expect(dup.code).toBe(1);

    const list = await cli(['workflows'], { env: env() });
    expect(list.out).toContain('hello');
    expect(list.out).toContain('1.0.0');

    const started = await cli(['run', 'hello', '--input', 'who=CLI', '--json'], { env: env() });
    expect(started.code).toBe(0);
    const runId = JSON.parse(started.out).run.id as string;
    await until(() => api.app.state.runs.getRun(runId)?.status === 'succeeded');

    const show = await cli(['runs', 'show', runId], { env: env() });
    expect(show.code).toBe(0);
    expect(show.out).toContain('succeeded');
    expect(show.out).toContain('hello CLI!');

    const runs = await cli(['runs', '--workflow', 'hello'], { env: env() });
    expect(runs.out).toContain(runId);

    const tailed = await cli(['runs', 'tail', runId], { env: env() });
    expect(tailed.code).toBe(0);
    expect(tailed.out).toContain('run.succeeded');

    const events = await cli(['runs', 'events', runId], { env: env() });
    expect(events.out).toContain('step.succeeded');

    const output = await cli(['runs', 'output', runId, 'greet'], { env: env() });
    expect(JSON.parse(output.out)).toEqual({ value: 'hello CLI' });

    const graph = await cli(['workflows', 'graph', 'hello'], { env: env() });
    expect(graph.out).toContain('greet --> again');

    const audit = await cli(['audit', 'verify'], { env: env() });
    expect(audit.code).toBe(0);
    expect(audit.out).toContain('audit log intact');

    const exportPath = join(dir, 'audit.ndjson');
    const exp = await cli(['audit', 'export', '--out', exportPath], { env: env() });
    expect(exp.code).toBe(0);
    expect(readFileSync(exportPath, 'utf8').split('\n').filter(Boolean).length).toBeGreaterThan(5);
  });

  it('`run --wait` streams to completion and exits non-zero when the run fails', async () => {
    const ok = await cli(['publish', '-'], { env: env(), stdin: yamlWf('waits', [echoStep('a', 1)]) });
    expect(ok.code).toBe(0);
    const good = await cli(['run', 'waits', '--wait'], { env: env() });
    expect(good.code).toBe(0);
    expect(good.out).toContain('succeeded');

    await cli(['publish', '-'], { env: env(), stdin: yamlWf('fails', [{ id: 'x', type: 'capability', uses: 'util-fail@^1', with: { errorClass: 'business', message: 'nope' } }]) });
    const bad = await cli(['run', 'fails', '--wait'], { env: env() });
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('failed');
  });

  it('reports invalid manifests with source locations when publishing', async () => {
    const r = await cli(['publish', '-'], { env: env(), stdin: yamlWf('broken', [{ id: 'one', type: 'capability', uses: 'util-ecoh@^1', with: {} }]) });
    expect(r.code).toBe(1);
    expect(r.err).toContain('UNKNOWN_CAPABILITY');
  });

  it('controls rollout: canary, kill, revive, disable, enable', async () => {
    await cli(['publish', '-'], { env: env(), stdin: yamlWf('ctl', [echoStep('a', 1)]) });
    await cli(['publish', '-'], { env: env(), stdin: yamlWf('ctl', [echoStep('a', 2)], {}, '1.1.0') });
    expect((await cli(['workflows', 'activate', 'ctl', '1.0.0'], { env: env() })).code).toBe(0);
    expect((await cli(['workflows', 'kill', 'ctl', '--reason', 'testing'], { env: env() })).code).toBe(0);
    const killed = await cli(['workflows', 'show', 'ctl'], { env: env() });
    expect(killed.out).toContain('KILLED');
    expect((await cli(['run', 'ctl'], { env: env() })).code).toBe(1);
    expect((await cli(['workflows', 'revive', 'ctl'], { env: env() })).code).toBe(0);
    expect((await cli(['workflows', 'disable', 'ctl'], { env: env() })).code).toBe(0);
    expect((await cli(['workflows', 'enable', 'ctl'], { env: env() })).code).toBe(0);
    expect((await cli(['workflows', 'autonomy', 'ctl', 'T2'], { env: env() })).code).toBe(0);
    expect((await cli(['workflows', 'wobble', 'ctl'], { env: env() })).code).toBe(2);
    expect((await cli(['workflows', 'canary', 'ctl'], { env: env() })).code).toBe(2);
  });

  it('answers approvals from the command line', async () => {
    const stdin = yamlWf('needs-ok', [{ id: 'gate', type: 'approval', message: 'Ship?', timeout: '1h', onTimeout: 'deny' }, echoStep('after', 'shipped', { dependsOn: ['gate'] })]);
    await cli(['publish', '-'], { env: env(), stdin });
    const runner = await cli(['run', 'needs-ok', '--json'], { env: env() });
    const runId = JSON.parse(runner.out).run.id as string;
    await until(() => api.app.state.approvals.list({ tenant: 'default', status: 'pending' }).length > 0);
    const list = await cli(['approvals'], { env: env() });
    expect(list.out).toContain('gate');
    const id = api.app.state.approvals.list({ tenant: 'default', status: 'pending' })[0]!.id;
    // The API key that started the run may not approve it (four-eyes) …
    expect((await cli(['approvals', 'approve', id], { env: env() })).code).toBe(1);
    // … a different person may.
    const other = (await api.key(['admin'])).apiKey!;
    const ok = await cli(['approvals', 'approve', id, '--comment', 'lgtm'], { env: { OMNIFLOW_URL: url, OMNIFLOW_API_KEY: other } });
    expect(ok.code).toBe(0);
    await until(() => api.app.state.runs.getRun(runId)?.status === 'succeeded');
    expect((await cli(['approvals', 'approve'], { env: env() })).code).toBe(2);
  });

  it('manages secrets without putting values on the command line', async () => {
    const set = await cli(['secrets', 'set', 'DB_PASSWORD', '--stdin', '--description', 'db'], { env: env(), stdin: 's3cr3t-value\n' });
    expect(set.code).toBe(0);
    expect(set.out + set.err).not.toContain('s3cr3t-value');
    const list = await cli(['secrets'], { env: env() });
    expect(list.out).toContain('DB_PASSWORD');
    expect(list.out).not.toContain('s3cr3t-value');
    expect((await cli(['secrets', 'set', 'NOPE'], { env: env() })).code).toBe(2);
    expect((await cli(['secrets', 'delete', 'DB_PASSWORD'], { env: env() })).code).toBe(0);
  });

  it('lists capabilities and change requests', async () => {
    const caps = await cli(['capabilities'], { env: env() });
    expect(caps.out).toContain('util-echo@1.0.0');
    expect((await cli(['changes'], { env: env() })).out).toContain('No change requests');
  });
});

describe('admin commands on a data directory', () => {
  const dataDir = tmp();
  let stop: () => Promise<void>;
  let url = '';

  beforeAll(async () => {
    const config = loadConfig(
      { OMNIFLOW_DATA_DIR: dataDir, OMNIFLOW_LOG_LEVEL: 'silent', OMNIFLOW_ADMIN_PASSWORD: 'correct-horse-battery-staple', OMNIFLOW_ENV: 'production' },
      { cwd: dataDir },
    );
    const app = createOmniflow(config, { log: createLogger({ level: 'silent' }) });
    await app.start();
    const { server } = await buildServer(app);
    await server.listen({ host: '127.0.0.1', port: 0 });
    const addr = server.server.address();
    url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    stop = async () => {
      await server.close();
      await app.stop();
    };
  });
  afterAll(async () => {
    await stop();
  });

  const admin = (argv: string[], stdin?: string) => cli(['admin', ...argv], { env: { OMNIFLOW_DATA_DIR: dataDir }, cwd: dataDir, ...(stdin ? { stdin } : {}) });

  it('bootstraps API access with no login: create-api-key, then use it against the server', async () => {
    const created = await admin(['create-api-key', '--name', 'ci', '--role', 'operator', '--json']);
    expect(created.code).toBe(0);
    const { key, roles } = JSON.parse(created.out);
    expect(key).toMatch(/^omf_[0-9a-f]{12}_/);
    expect(roles).toEqual(['operator']);
    const status = await cli(['workflows'], { env: { OMNIFLOW_URL: url, OMNIFLOW_API_KEY: key } });
    expect(status.code).toBe(0);
  });

  it('creates users, resets passwords, lists users', async () => {
    const created = await admin(['create-user', '--email', 'ops@example.com', '--role', 'operator', '--json']);
    expect(created.code).toBe(0);
    const { password } = JSON.parse(created.out);
    // the temporary password works and is flagged for change
    const login = await fetch(`${url}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ops@example.com', password }) });
    expect(login.status).toBe(200);
    expect(((await login.json()) as { user: { mustChangePassword: boolean } }).user.mustChangePassword).toBe(true);

    const reset = JSON.parse((await admin(['reset-password', '--email', 'ops@example.com', '--json'])).out);
    expect(reset.password).not.toBe(password);
    const old = await fetch(`${url}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ops@example.com', password }) });
    expect(old.status).toBe(401);

    const users = await admin(['list-users']);
    expect(users.out).toContain('ops@example.com');
    expect(users.out).toContain('admin@omniflow.local');
    expect((await admin(['create-user', '--email', 'x@example.com', '--role', 'overlord'])).code).toBe(2);
    expect((await admin(['create-user'])).code).toBe(2);
    expect((await admin(['reset-password', '--email', 'ghost@example.com'])).code).toBe(2);
  });

  it('verifies the audit chain and takes a consistent backup that opens on its own', async () => {
    const v = await admin(['verify-audit']);
    expect(v.code).toBe(0);
    expect(v.out).toContain('audit log intact');

    const dest = join(dataDir, 'backups', 'snap.db');
    const b = await admin(['backup', dest]);
    expect(b.code).toBe(0);
    expect(b.out).toContain('master key is NOT in the backup');
    expect((await admin(['backup', dest])).code).toBe(2); // refuses to overwrite

    const restored = openState({ ...stateOptionsFor(join(dataDir, 'restored')), dbPath: dest });
    try {
      expect(restored.identity.countUsers()).toBeGreaterThan(1);
      expect(restored.events.verify('default').ok).toBe(true);
    } finally {
      restored.close();
    }
  });

  it('refuses to run without a database', async () => {
    const r = await cli(['admin', 'list-users'], { env: { OMNIFLOW_DATA_DIR: join(tmp(), 'empty') } });
    expect(r.code).toBe(2);
    expect(r.err).toContain('No OmniFlow database');
  });
});
