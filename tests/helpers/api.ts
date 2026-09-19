import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { stringify } from 'yaml';
import type { LlmClient } from '../../authoring/index.ts';
import { systemClock } from '../../core/index.ts';
import { buildServer } from '../../gateway/server.ts';
import type { Role } from '../../schemas/index.ts';
import { loadConfig } from '../../server/config.ts';
import { createOmniflow, type Omniflow } from '../../server/platform.ts';
import { makeState } from './state.ts';

export const ADMIN = { email: 'admin@example.com', password: 'correct-horse-battery-staple' };

export interface Api {
  app: Omniflow;
  server: FastifyInstance;
  dir: string;
  /** Sign in and return a client bound to the session cookie. */
  login(email?: string, password?: string): Promise<Client>;
  /** A client authenticated with a fresh API key holding `roles`. */
  key(roles: Role[], tenant?: string): Promise<Client>;
  anon: Client;
  stop(): Promise<void>;
}

export interface Client {
  request(
    method: string,
    url: string,
    opts?: { body?: unknown; raw?: string; headers?: Record<string, string>; noCsrf?: boolean },
  ): Promise<{ status: number; body: any; headers: Record<string, any>; text: string }>;
  get(url: string, headers?: Record<string, string>): ReturnType<Client['request']>;
  post(url: string, body?: unknown, headers?: Record<string, string>): ReturnType<Client['request']>;
  put(url: string, body?: unknown): ReturnType<Client['request']>;
  patch(url: string, body?: unknown): ReturnType<Client['request']>;
  del(url: string): ReturnType<Client['request']>;
  cookie?: string;
  apiKey?: string;
}

export async function makeApi(opts: { env?: Record<string, string>; llm?: LlmClient } = {}): Promise<Api> {
  const dir = mkdtempSync(join(tmpdir(), 'omniflow-api-'));
  const config = loadConfig(
    {
      OMNIFLOW_DATA_DIR: dir,
      OMNIFLOW_ADMIN_EMAIL: ADMIN.email,
      OMNIFLOW_ADMIN_PASSWORD: ADMIN.password,
      OMNIFLOW_LOG_LEVEL: 'silent',
      OMNIFLOW_ENV: 'production',
      OMNIFLOW_STORAGE_DIR: join(dir, 'files'),
      OMNIFLOW_METRICS_TOKEN: 'metrics-token-123',
      ...opts.env,
    },
    { cwd: dir },
  );
  const state = makeState({ clock: systemClock });
  const app = createOmniflow(config, { state, llm: opts.llm ?? null });
  await app.start();
  const { server } = await buildServer(app);
  await server.ready();

  const client = (auth: { cookie?: string; apiKey?: string }): Client => {
    const request: Client['request'] = async (method, url, o = {}) => {
      const headers: Record<string, string> = { ...(o.headers ?? {}) };
      if (auth.cookie) {
        headers.cookie = auth.cookie;
        if (method !== 'GET' && !o.noCsrf) headers['x-requested-with'] = 'omniflow';
      }
      if (auth.apiKey) headers.authorization = `Bearer ${auth.apiKey}`;
      let payload: string | undefined;
      if (o.raw !== undefined) payload = o.raw;
      else if (o.body !== undefined) payload = JSON.stringify(o.body);
      if (payload !== undefined) headers['content-type'] ??= 'application/json';
      const res = await server.inject({
        method: method as never,
        url,
        headers,
        ...(payload !== undefined ? { payload } : {}),
      });
      let body: any;
      try {
        body = res.body ? JSON.parse(res.body) : null;
      } catch {
        body = null;
      }
      return { status: res.statusCode, body, headers: res.headers, text: res.body };
    };
    return {
      request,
      get: (url, headers) => request('GET', url, headers ? { headers } : {}),
      post: (url, body, headers) =>
        request('POST', url, { ...(body !== undefined ? { body } : {}), ...(headers ? { headers } : {}) }),
      put: (url, body) => request('PUT', url, { body }),
      patch: (url, body) => request('PATCH', url, { body }),
      del: (url) => request('DELETE', url),
      ...(auth.cookie ? { cookie: auth.cookie } : {}),
      ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
    };
  };

  const anon = client({});
  const api: Api = {
    app,
    server,
    dir,
    anon,
    async login(email = ADMIN.email, password = ADMIN.password) {
      const res = await anon.post('/v1/auth/login', { email, password });
      if (res.status !== 200) throw new Error(`login failed: ${res.status} ${res.text}`);
      const setCookie = String(res.headers['set-cookie']);
      return client({ cookie: setCookie.split(';')[0]! });
    },
    async key(roles, tenant = 'default') {
      const actor = { id: 'usr_bootstrap', type: 'user' as const, name: 'admin', tenant, roles: ['admin' as const] };
      const { key } = app.auth.createApiKey(actor, { name: `test-${roles.join('-')}`, roles });
      return client({ apiKey: key });
    },
    async stop() {
      await server.close();
      await app.orchestrator.stop();
      app.scheduler.stop();
      app.triggers.stop();
      app.alerts.stop();
    },
  };
  return api;
}

/** Workflow manifests for API tests, as YAML text. */
export const yamlWf = (name: string, steps: unknown[], extra: Record<string, unknown> = {}, version = '1.0.0') =>
  stringify({
    apiVersion: 'omniflow.dev/v1',
    kind: 'Workflow',
    metadata: { name, version, owner: 'ops@example.com', description: 'API test workflow', criticality: 'low' },
    triggers: [{ type: 'manual' }],
    inputs: {},
    steps,
    ...extra,
  });

export const echoStep = (id: string, value: unknown, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'capability',
  uses: 'util-echo@^1',
  with: { value },
  ...extra,
});

export async function until(fn: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('condition not reached in time');
    await new Promise((r) => setTimeout(r, 15));
  }
}
