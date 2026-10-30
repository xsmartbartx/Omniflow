import { describe, expect, it } from 'vitest';
import { type Api, makeApi } from '../helpers/api.ts';
import { inbox, type Sent, tokenOf } from '../helpers/inbox.ts';

const PASSWORD = 'a-long-enough-passphrase';
const NEW_PASSWORD = 'another-long-passphrase-9';

async function withApi(fn: (api: Api, sent: Sent[]) => Promise<void>, env: Record<string, string> = {}) {
  const { mailer, sent } = inbox();
  const api = await makeApi({ env: { OMNIFLOW_SIGNUP: 'true', ...env }, mailer });
  try {
    await fn(api, sent);
  } finally {
    await api.stop();
  }
}
const signup = (api: Api, email: string) => api.anon.post('/v1/auth/signup', { email, password: PASSWORD });
const forgot = (api: Api, email: string) => api.anon.post('/v1/auth/forgot', { email });
const reset = (api: Api, token: string, password: string) => api.anon.post('/v1/auth/reset', { token, password });

describe('password reset by email', () => {
  it('is off without a mailer: the routes do not exist and /v1/info says so', async () => {
    const api = await makeApi();
    try {
      expect((await api.anon.get('/v1/info')).body.passwordReset).toBe(false);
      expect((await forgot(api, 'a@example.com')).status).toBe(404);
      expect((await reset(api, 'x'.repeat(30), NEW_PASSWORD)).status).toBe(404);
    } finally {
      await api.stop();
    }
  });

  it('mails a link, lets the person choose a new password once, and ends their old sessions', () =>
    withApi(async (api, sent) => {
      expect((await api.anon.get('/v1/info')).body.passwordReset).toBe(true);
      const first = await signup(api, 'forgetful@example.com');
      const oldCookie = String(first.headers['set-cookie']).split(';')[0]!;
      expect((await api.anon.request('GET', '/v1/auth/me', { headers: { cookie: oldCookie } })).status).toBe(200);

      expect((await forgot(api, 'forgetful@example.com')).status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ to: 'forgetful@example.com', subject: expect.stringContaining('Reset') });
      const token = tokenOf(sent[0]!, 'reset');
      expect(token.length).toBeGreaterThan(20);

      expect((await reset(api, token, NEW_PASSWORD)).status).toBe(200);
      // the old password and the old session are gone; the new password works
      expect(
        (await api.anon.post('/v1/auth/login', { email: 'forgetful@example.com', password: PASSWORD })).status,
      ).toBe(401);
      expect((await api.anon.request('GET', '/v1/auth/me', { headers: { cookie: oldCookie } })).status).toBe(401);
      expect(
        (await api.anon.post('/v1/auth/login', { email: 'forgetful@example.com', password: NEW_PASSWORD })).status,
      ).toBe(200);
      // the link works once
      expect((await reset(api, token, 'yet-another-long-passphrase-1')).status).toBe(401);
    }));

  it('answers the same for an unknown address and sends nothing', () =>
    withApi(async (api, sent) => {
      await signup(api, 'real@example.com');
      const known = await forgot(api, 'real@example.com');
      const unknown = await forgot(api, 'nobody@example.com');
      expect(unknown.status).toBe(known.status);
      expect(unknown.body).toEqual(known.body);
      expect(sent.map((m) => m.to)).toEqual(['real@example.com']);
    }));

  it('keeps the link alive after a weak password, and refuses a bad, expired or replaced token', () =>
    withApi(async (api, sent) => {
      await signup(api, 'careful@example.com');
      await forgot(api, 'careful@example.com');
      const token = tokenOf(sent[0]!, 'reset');
      expect((await reset(api, token, 'short')).status).toBe(400);
      expect((await reset(api, 'z'.repeat(43), NEW_PASSWORD)).status).toBe(401);

      // asking again retires the earlier link
      await forgot(api, 'careful@example.com');
      expect((await reset(api, token, NEW_PASSWORD)).status).toBe(401);
      const fresh = tokenOf(sent[1]!, 'reset');

      // an expired link is refused
      api.app.state.db.run("UPDATE password_resets SET expires_at = '2020-01-01T00:00:00.000Z'");
      expect((await reset(api, fresh, NEW_PASSWORD)).status).toBe(401);
    }));

  it('clears a lockout, since the person has proven they own the address', () =>
    withApi(async (api, sent) => {
      await signup(api, 'locked@example.com');
      for (let i = 0; i < 6; i++)
        await api.anon.post('/v1/auth/login', { email: 'locked@example.com', password: 'wrong-password-123' });
      await forgot(api, 'locked@example.com');
      await reset(api, tokenOf(sent[0]!, 'reset'), NEW_PASSWORD);
      expect(
        (await api.anon.post('/v1/auth/login', { email: 'locked@example.com', password: NEW_PASSWORD })).status,
      ).toBe(200);
    }));

  it('rate-limits reset requests from one address', () =>
    withApi(async (api) => {
      const codes: number[] = [];
      for (let i = 0; i < 9; i++) codes.push((await forgot(api, `u${i}@example.com`)).status);
      expect(codes).toContain(429);
    }));
});
