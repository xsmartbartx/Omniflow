import { describe, expect, it } from 'vitest';
import { makeApi, yamlWf } from '../helpers/api.ts';

const PASSWORD = 'a-long-enough-passphrase';
const hello = (name: string) =>
  yamlWf(name, [{ id: 'a', type: 'capability', uses: 'util-echo@^1', with: { value: 'x' } }]);

describe('self-serve sign-up', () => {
  it('is off by default: the route does not exist and /v1/info says so', async () => {
    const api = await makeApi();
    try {
      expect((await api.anon.get('/v1/info')).body.signup).toBe(false);
      const res = await api.anon.post('/v1/auth/signup', { email: 'a@example.com', password: PASSWORD });
      expect(res.status).toBe(404);
    } finally {
      await api.stop();
    }
  });

  it('creates a tenant of its own, signs the user in, and keeps accounts apart', async () => {
    const api = await makeApi({ env: { OMNIFLOW_SIGNUP: 'true' } });
    try {
      expect((await api.anon.get('/v1/info')).body.signup).toBe(true);
      const res = await api.anon.post('/v1/auth/signup', {
        email: 'new@example.com',
        password: PASSWORD,
        organization: 'Acme',
      });
      expect(res.status, res.text).toBe(200);
      expect(res.body.principal.tenant).toMatch(/^acct-[a-z0-9]+$/);
      expect(res.body.principal.roles).toEqual(['admin']);
      const cookie = String(res.headers['set-cookie']).split(';')[0]!;
      expect(String(res.headers['set-cookie'])).toContain('HttpOnly');

      // the new tenant can publish; the operator's tenant cannot see it
      const mine = await api.anon.request('POST', '/v1/workflows', {
        body: { manifest: hello('acme-flow') },
        headers: { cookie, 'x-requested-with': 'omniflow' },
      });
      expect(mine.status, mine.text).toBeLessThan(300);
      const admin = await api.login();
      const adminList = await admin.get('/v1/workflows');
      expect(JSON.stringify(adminList.body)).not.toContain('acme-flow');
      const theirs = await api.anon.request('GET', '/v1/workflows', { headers: { cookie } });
      expect(JSON.stringify(theirs.body)).toContain('acme-flow');

      // and a second sign-up is a different tenant
      const other = await api.anon.post('/v1/auth/signup', { email: 'other@example.com', password: PASSWORD });
      expect(other.body.principal.tenant).not.toBe(res.body.principal.tenant);
    } finally {
      await api.stop();
    }
  });

  it('refuses a taken email, a weak password and a malformed address', async () => {
    const api = await makeApi({ env: { OMNIFLOW_SIGNUP: 'true' } });
    try {
      const ok = await api.anon.post('/v1/auth/signup', { email: 'dup@example.com', password: PASSWORD });
      expect(ok.status).toBe(200);
      expect((await api.anon.post('/v1/auth/signup', { email: 'DUP@example.com', password: PASSWORD })).status).toBe(
        409,
      );
      expect((await api.anon.post('/v1/auth/signup', { email: 'weak@example.com', password: 'short' })).status).toBe(
        400,
      );
      expect((await api.anon.post('/v1/auth/signup', { email: 'not-an-email', password: PASSWORD })).status).toBe(400);
    } finally {
      await api.stop();
    }
  });

  it('stops accepting accounts at the configured cap, and rate-limits bursts', async () => {
    const api = await makeApi({ env: { OMNIFLOW_SIGNUP: 'true', OMNIFLOW_SIGNUP_MAX_TENANTS: '2' } });
    try {
      for (const n of [1, 2]) {
        expect(
          (await api.anon.post('/v1/auth/signup', { email: `u${n}@example.com`, password: PASSWORD })).status,
        ).toBe(200);
      }
      const third = await api.anon.post('/v1/auth/signup', { email: 'u3@example.com', password: PASSWORD });
      expect(third.status).toBe(403);
    } finally {
      await api.stop();
    }
    const burst = await makeApi({ env: { OMNIFLOW_SIGNUP: 'true' } });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 8; i++)
        codes.push((await burst.anon.post('/v1/auth/signup', { email: 'weak@example.com', password: 'x' })).status);
      expect(codes).toContain(429);
    } finally {
      await burst.stop();
    }
  });

  it('is never on in NEXORA mode, where identity comes from NEXORA', async () => {
    const api = await makeApi({
      env: {
        OMNIFLOW_SIGNUP: 'true',
        OMNIFLOW_MODE: 'nexora',
        OMNIFLOW_NEXORA_CORE: 'fake',
        OMNIFLOW_ENV: 'development',
      },
    });
    try {
      expect((await api.anon.get('/v1/info')).body.signup).toBe(false);
    } finally {
      await api.stop();
    }
  });
});
