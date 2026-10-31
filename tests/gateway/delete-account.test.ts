import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Api, makeApi, until, yamlWf } from '../helpers/api.ts';

const PASSWORD = 'a-long-enough-passphrase';
const hello = yamlWf('doomed-flow', [{ id: 'a', type: 'capability', uses: 'util-echo@^1', with: { value: 'x' } }]);

async function withApi(fn: (api: Api) => Promise<void>) {
  const api = await makeApi({ env: { OMNIFLOW_SIGNUP: 'true' } });
  try {
    await fn(api);
  } finally {
    await api.stop();
  }
}
const signUp = async (api: Api, email: string) => {
  const res = await api.anon.post('/v1/auth/signup', { email, password: PASSWORD });
  expect(res.status, res.text).toBe(200);
  return { tenant: res.body.principal.tenant as string, client: await api.login(email, PASSWORD) };
};
/** Every table that carries `tenant_id`, other than the audit log, and how many rows it holds for `tenant`. */
function leftovers(api: Api, tenant: string): Record<string, number> {
  const db = api.app.state.db;
  const tables = db
    .all<{ name: string }>(
      `SELECT m.name AS name FROM sqlite_master m, pragma_table_info(m.name) p
       WHERE m.type = 'table' AND p.name = 'tenant_id' AND m.name <> 'events'`,
    )
    .map((t) => t.name);
  const found: Record<string, number> = {};
  for (const t of tables) {
    const n = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE tenant_id = ?`, [tenant])?.n ?? 0;
    if (n > 0) found[t] = n;
  }
  return found;
}

describe('deleting a self-serve account', () => {
  it('erases the tenant and everything it owns, keeps the audit chain, and frees the email', () =>
    withApi(async (api) => {
      const other = await signUp(api, 'other@example.com');
      const { tenant, client } = await signUp(api, 'doomed@example.com');
      expect((await client.post('/v1/workflows', { manifest: hello })).status).toBeLessThan(300);
      const run = await client.post('/v1/workflows/doomed-flow/run', {});
      expect(run.status, run.text).toBeLessThan(300);
      await until(async () => (await client.get(`/v1/runs/${run.body.run.id}`)).body.run?.status === 'succeeded');
      const artifact = api.app.state.artifacts.put(tenant, 'private bytes');
      const artifactDir = join(api.dir, 'artifacts', tenant);
      expect(Object.keys(leftovers(api, tenant)).length).toBeGreaterThan(3);

      // a wrong password changes nothing
      const wrong = await client.post('/v1/auth/delete-account', { password: 'not-the-password-at-all' });
      expect(wrong.status).toBe(401);
      expect((await client.get('/v1/auth/me')).status).toBe(200);

      const events = api.app.state.events.count(tenant);
      const gone = await client.post('/v1/auth/delete-account', { password: PASSWORD });
      expect(gone.status, gone.text).toBe(200);
      expect(String(gone.headers['set-cookie'])).toContain('Max-Age=0');

      expect(leftovers(api, tenant)).toEqual({});
      expect(api.app.state.identity.getTenant(tenant)).toBeUndefined();
      expect(existsSync(artifactDir)).toBe(false);
      expect(artifact.tenant).toBe(tenant);
      // the append-only audit log keeps its record (one event longer) and still verifies
      expect(api.app.state.events.count(tenant)).toBe(events + 1);
      expect(api.app.state.events.verify(tenant).ok).toBe(true);

      // the person can no longer sign in, but may sign up again, and nobody else was touched
      expect((await api.anon.post('/v1/auth/login', { email: 'doomed@example.com', password: PASSWORD })).status).toBe(
        401,
      );
      expect((await api.anon.post('/v1/auth/signup', { email: 'doomed@example.com', password: PASSWORD })).status).toBe(
        200,
      );
      expect((await other.client.get('/v1/auth/me')).status).toBe(200);
    }));

  it('is only for the administrator of a self-serve account', () =>
    withApi(async (api) => {
      const operator = await api.login();
      const res = await operator.post('/v1/auth/delete-account', {
        password: (await import('../helpers/api.ts')).ADMIN.password,
      });
      expect(res.status).toBe(403);
      expect((await operator.get('/v1/auth/me')).status).toBe(200);
      expect(api.app.state.identity.getTenant('default')).toBeDefined();
    }));

  it('waits until a paid subscription is cancelled', () =>
    withApi(async (api) => {
      const { tenant, client } = await signUp(api, 'paying@example.com');
      api.app.state.db.run(
        `INSERT INTO billing_accounts (tenant_id, stripe_customer_id, stripe_subscription_id, plan, status, updated_at)
         VALUES (?, 'cus_test', 'sub_test', 'pro', 'active', ?)`,
        [tenant, new Date().toISOString()],
      );
      const res = await client.post('/v1/auth/delete-account', { password: PASSWORD });
      expect(res.status).toBe(409);
      expect(api.app.state.identity.getTenant(tenant)).toBeDefined();
      api.app.state.db.run("UPDATE billing_accounts SET status = 'canceled' WHERE tenant_id = ?", [tenant]);
      expect((await client.post('/v1/auth/delete-account', { password: PASSWORD })).status).toBe(200);
    }));

  it('leaves published versions and plans undeletable while their tenant exists', () =>
    withApi(async (api) => {
      const { tenant, client } = await signUp(api, 'keeper@example.com');
      expect((await client.post('/v1/workflows', { manifest: hello })).status).toBeLessThan(300);
      const db = api.app.state.db;
      expect(() => db.run('DELETE FROM workflow_versions WHERE tenant_id = ?', [tenant])).toThrow(/cannot be deleted/);
      expect(() => db.run('DELETE FROM plans WHERE tenant_id = ?', [tenant])).toThrow(/cannot be deleted/);
    }));
});
