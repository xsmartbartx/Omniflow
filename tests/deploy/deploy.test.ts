import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, parseAllDocuments } from 'yaml';
import { createDefaultRegistry, defaultAdapterConfig } from '../../capabilities/index.ts';
import { compile } from '../../orchestration/compiler/index.ts';
import { parsePolicyDocument } from '../../security/policy/index.ts';
import { runCli } from '../../cli/main.ts';
import { makeApi, until } from '../helpers/api.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const walk = (dir: string): string[] => readdirSync(join(ROOT, dir)).flatMap((f) => (statSync(join(ROOT, dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));

describe('configuration documentation cannot drift from the code', () => {
  const documented = new Set([...read('.env.example').matchAll(/\b((?:OMNIFLOW|ANTHROPIC)_[A-Z_]+)\b/g)].map((m) => m[1]!));
  const sources = ['server', 'gateway', 'capabilities', 'insight', 'authoring'].flatMap((d) => walk(d)).filter((f) => f.endsWith('.ts'));
  const used = new Set(sources.flatMap((f) => [...read(f).matchAll(/\b(OMNIFLOW_[A-Z_]+|ANTHROPIC_API_KEY)\b/g)].map((m) => m[1]!)));

  it('every variable the server reads is documented in .env.example', () => {
    expect([...used].filter((v) => !documented.has(v)).sort()).toEqual([]);
  });

  it('every variable documented there is really read (or is a compose-level setting)', () => {
    const composeLevel = new Set(['OMNIFLOW_BIND', 'OMNIFLOW_DOMAIN', 'OMNIFLOW_IMAGE', 'OMNIFLOW_ENV_FILE']);
    expect([...documented].filter((v) => !used.has(v) && !composeLevel.has(v)).sort()).toEqual([]);
  });

  it('a copied .env.example (secrets blank) loads as a valid configuration', async () => {
    const { loadConfig } = await import('../../server/config.ts');
    const env: Record<string, string> = {};
    for (const line of read('.env.example').split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line);
      if (m?.[2]) env[m[1]!] = m[2];
    }
    const dir = join(ROOT, 'node_modules', '.cache', `envtest-${process.pid}`);
    const cfg = loadConfig({ ...env, OMNIFLOW_DATA_DIR: dir, OMNIFLOW_ADMIN_PASSWORD: 'x'.repeat(16) }, { cwd: dir });
    expect(cfg.environment).toBe('production');
    expect(cfg.analysisIntervalHours).toBe(24);
    expect(cfg.alertChannels).toEqual([]);
  });
});

describe('container image and compose file', () => {
  const dockerfile = read('Dockerfile');
  it('runs as a non-root user with a health check and a graceful init', () => {
    expect(dockerfile).toMatch(/^USER 10001:10001$/m);
    expect(dockerfile).toContain('HEALTHCHECK');
    expect(dockerfile).toContain('/healthz');
    expect(dockerfile).toContain('tini');
    expect(dockerfile).not.toMatch(/^ADD\s+https?:/m);
    expect(dockerfile).not.toMatch(/curl[^\n]*\|\s*(ba)?sh/);
  });

  it('copies only things that exist, and never source secrets or tests', () => {
    for (const m of dockerfile.matchAll(/^COPY (?!--from)(.+?)\s+\.?\/?[\w./]*$/gm)) {
      for (const src of m[1]!.split(/\s+/)) expect(() => statSync(join(ROOT, src)), `COPY ${src}`).not.toThrow();
    }
    expect(dockerfile).not.toMatch(/COPY\s+(tests|docs|\.env|data)\b/);
    const ignore = read('.dockerignore');
    for (const p of ['node_modules', 'data', '.env', 'tests', '.git']) expect(ignore).toContain(p);
  });

  it('compose hardens the container and keeps the port on loopback by default', () => {
    const c = parse(read('docker-compose.yml'));
    const svc = c.services.omniflow;
    expect(svc.read_only).toBe(true);
    expect(svc.cap_drop).toEqual(['ALL']);
    expect(svc.security_opt).toContain('no-new-privileges:true');
    expect(svc.ports[0]).toContain('127.0.0.1');
    expect(svc.volumes).toContain('omniflow-data:/data');
    expect(c.services.caddy.profiles).toEqual(['tls']);
    expect(c.services.caddy.depends_on.omniflow.condition).toBe('service_healthy');
  });
});

describe('Kubernetes manifests', () => {
  const docs = parseAllDocuments(read('deploy/k8s/omniflow.yaml')).map((d) => d.toJS());
  const byKind = (k: string) => docs.filter((d) => d.kind === k);

  it('are well-formed and cover the whole stack', () => {
    expect(docs.map((d) => d.kind).sort()).toEqual(['ConfigMap', 'CronJob', 'Deployment', 'Ingress', 'NetworkPolicy', 'PersistentVolumeClaim', 'Service']);
  });

  it('run a single pod with a Recreate rollout — two pods must never share the SQLite database', () => {
    const d = byKind('Deployment')[0];
    expect(d.spec.replicas).toBe(1);
    expect(d.spec.strategy.type).toBe('Recreate');
    expect(byKind('PersistentVolumeClaim')[0].spec.accessModes).toEqual(['ReadWriteOnce']);
  });

  it('are hardened: non-root, read-only root, no capabilities, probes on real endpoints', async () => {
    const pod = byKind('Deployment')[0].spec.template.spec;
    expect(pod.securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: 10001 });
    const c = pod.containers[0];
    expect(c.securityContext).toMatchObject({ allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } });
    const api = await makeApi();
    try {
      for (const probe of [c.startupProbe, c.livenessProbe, c.readinessProbe]) {
        expect((await api.anon.get(probe.httpGet.path)).status, probe.httpGet.path).toBe(200);
      }
    } finally {
      await api.stop();
    }
    const backup = byKind('CronJob')[0].spec.jobTemplate.spec.template.spec;
    expect(backup.affinity.podAffinity.requiredDuringSchedulingIgnoredDuringExecution).toHaveLength(1); // must land beside the volume
  });

  it('every secret the deployment expects is listed in the header instructions', () => {
    const text = read('deploy/k8s/omniflow.yaml');
    for (const v of ['OMNIFLOW_MASTER_KEY', 'OMNIFLOW_ADMIN_PASSWORD', 'OMNIFLOW_METRICS_TOKEN']) expect(text).toContain(v);
  });
});

describe('example workflows and policies', () => {
  const defaults = readdirSync(join(ROOT, 'workflows')).filter((f) => f.endsWith('.yaml'));
  const optional = readdirSync(join(ROOT, 'workflows/optional')).filter((f) => f.endsWith('.yaml'));
  const stock = createDefaultRegistry(defaultAdapterConfig());
  const opts = (caps: typeof stock) => ({ environment: 'production', capabilities: caps, today: '2026-06-01' });

  it('the default examples compile against a stock install (no integrations configured)', () => {
    expect(defaults.length).toBeGreaterThanOrEqual(4);
    for (const f of defaults) {
      const r = compile(read(`workflows/${f}`), opts(stock));
      expect(r.errors, f).toEqual([]);
    }
  });

  it('the optional examples need something the stock install lacks — and are valid once it is there', async () => {
    expect(optional.length).toBe(3);
    for (const f of optional) {
      const text = read(`workflows/optional/${f}`);
      expect(compile(text, opts(stock)).errors.length, `${f} should not compile on a stock install`).toBeGreaterThan(0);
    }
    let out = '';
    const code = await runCli(['validate', join(ROOT, 'workflows/optional')], { out: (t) => (out += t), err: () => {}, readStdin: async () => '' }, {}, ROOT);
    expect(code, out).toBe(0);
    expect(out).toContain('3/3 valid');
  });

  it('the sample policy document is valid', () => {
    const r = parsePolicyDocument(read('policies/examples/house-rules.yaml'));
    expect(r.issues).toEqual([]);
    expect(r.document?.rules.map((x) => x.id)).toEqual(['no-shell-in-production', 'critical-needs-two']);
  });

  it('seeding publishes the examples on first start, and they run', async () => {
    const api = await makeApi({ env: { OMNIFLOW_SEED_EXAMPLES: 'true', OMNIFLOW_WORKFLOWS_DIR: join(ROOT, 'workflows'), OMNIFLOW_ENV: 'development' } });
    try {
      const admin = await api.login();
      const names = (await admin.get('/v1/workflows')).body.items.map((w: { name: string }) => w.name).sort();
      expect(names).toEqual(['approval-gated-refund', 'heartbeat', 'hello-world', 'order-router']);

      const hello = (await admin.post('/v1/workflows/hello-world/run', { inputs: { name: 'Ada' } })).body.run.id as string;
      const router = (await admin.post('/v1/workflows/order-router/run', { inputs: { orders: [{ id: 'a', total: 20 }, { id: 'b', total: 5000 }] } })).body.run.id as string;
      await until(() => ['hello', 'router'].length > 0 && [hello, router].every((id) => api.app.state.runs.getRun(id)?.status === 'succeeded'));
      expect((await admin.get(`/v1/runs/${hello}`)).body.run.outputs).toEqual({ greeting: 'Hello, Ada!', loud: 'HELLO, ADA!' });
      expect((await admin.get(`/v1/runs/${router}`)).body.run.outputs).toEqual({ processed: 2, needsReview: true });

      // the approval example pauses until someone other than the requester approves
      const gated = (await admin.post('/v1/workflows/approval-gated-refund/run', { inputs: { orderId: 'A-1', amount: 25 } })).body.run.id as string;
      await until(() => api.app.state.runs.getRun(gated)?.status === 'waiting-approval');
      const tooBig = (await admin.post('/v1/workflows/approval-gated-refund/run', { inputs: { orderId: 'A-2', amount: 50000 } })).body.run.id as string;
      await until(() => api.app.state.runs.getRun(tooBig)?.status === 'failed');
    } finally {
      await api.stop();
    }
  });
});
