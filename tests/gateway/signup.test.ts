import { describe, expect, it } from 'vitest';
import { type Api, makeApi, yamlWf } from '../helpers/api.ts';

const PASSWORD = 'a-long-enough-passphrase';
const hello = (name: string) =>
  yamlWf(name, [{ id: 'a', type: 'capability', uses: 'util-echo@^1', with: { value: 'x' } }]);

/** Run `fn` against a fresh server with the given environment, and always shut it down. */
async function withApi(env: Record<string, string>, fn: (api: Api) => Promise<void>) {
  const api = await makeApi({ env });
  try {
    await fn(api);
  } finally {
    await api.stop();
  }
}
const signup = (api: Api, email: string, password = PASSWORD, extra: Record<string, string> = {}) =>
  api.anon.post('/v1/auth/signup', { email, password, ...extra });
const ON = { OMNIFLOW_SIGNUP: 'true' };

describe('self-serve sign-up', () => {
  it('is off by default: the route does not exist and /v1/info says so', () =>
    withApi({}, async (api) => {
      expect((await api.anon.get('/v1/info')).body.signup).toBe(false);
      expect((await signup(api, 'a@example.com')).status).toBe(404);
    }));

  it('creates a tenant of its own, signs the user in, and keeps accounts apart', () =>
    withApi(ON, async (api) => {
      expect((await api.anon.get('/v1/info')).body.signup).toBe(true);
      const res = await signup(api, 'new@example.com', PASSWORD, { organization: 'Acme' });
      expect(res.status, res.text).toBe(200);
      expect(res.body.principal.tenant).toMatch(/^acct-[a-z0-9]+$/);
      expect(res.body.principal.roles).toEqual(['admin']);
      expect(String(res.headers['set-cookie'])).toContain('HttpOnly');
      const cookie = String(res.headers['set-cookie']).split(';')[0]!;

      // the new tenant can publish; the operator's tenant cannot see it
      const mine = await api.anon.request('POST', '/v1/workflows', {
        body: { manifest: hello('acme-flow') },
        headers: { cookie, 'x-requested-with': 'omniflow' },
      });
      expect(mine.status, mine.text).toBeLessThan(300);
      const operator = await (await api.login()).get('/v1/workflows');
      expect(JSON.stringify(operator.body)).not.toContain('acme-flow');
      const theirs = await api.anon.request('GET', '/v1/workflows', { headers: { cookie } });
      expect(JSON.stringify(theirs.body)).toContain('acme-flow');

      // and a second sign-up is a different tenant
      const other = await signup(api, 'other@example.com');
      expect(other.body.principal.tenant).not.toBe(res.body.principal.tenant);
    }));

  it('refuses a taken email, a weak password and a malformed address', () =>
    withApi(ON, async (api) => {
      expect((await signup(api, 'dup@example.com')).status).toBe(200);
      expect((await signup(api, 'DUP@example.com')).status).toBe(409);
      expect((await signup(api, 'weak@example.com', 'short')).status).toBe(400);
      expect((await signup(api, 'not-an-email')).status).toBe(400);
    }));

  it('stops accepting accounts at the configured cap', () =>
    withApi({ ...ON, OMNIFLOW_SIGNUP_MAX_TENANTS: '2' }, async (api) => {
      expect((await signup(api, 'u1@example.com')).status).toBe(200);
      expect((await signup(api, 'u2@example.com')).status).toBe(200);
      expect((await signup(api, 'u3@example.com')).status).toBe(403);
    }));

  it('rate-limits bursts from one address', () =>
    withApi(ON, async (api) => {
      const codes: number[] = [];
      for (let i = 0; i < 8; i++) codes.push((await signup(api, 'weak@example.com', 'x')).status);
      expect(codes).toContain(429);
    }));

  it('is never on in NEXORA mode, where identity comes from NEXORA', () =>
    withApi(
      { ...ON, OMNIFLOW_MODE: 'nexora', OMNIFLOW_NEXORA_CORE: 'fake', OMNIFLOW_ENV: 'development' },
      async (api) => {
        expect((await api.anon.get('/v1/info')).body.signup).toBe(false);
      },
    ));
});
