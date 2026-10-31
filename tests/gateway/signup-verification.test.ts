import { describe, expect, it } from 'vitest';
import { type Api, makeApi } from '../helpers/api.ts';
import { inbox, type Sent, tokenOf } from '../helpers/inbox.ts';

const PASSWORD = 'a-long-enough-passphrase';
const ON = { OMNIFLOW_SIGNUP: 'true', OMNIFLOW_SIGNUP_VERIFY_EMAIL: 'true', OMNIFLOW_SMTP_URL: 'json:' };

async function withApi(fn: (api: Api, sent: Sent[]) => Promise<void>, env: Record<string, string> = ON) {
  const { mailer, sent } = inbox();
  const api = await makeApi({ env, mailer });
  try {
    await fn(api, sent);
  } finally {
    await api.stop();
  }
}
const signup = (api: Api, email: string) => api.anon.post('/v1/auth/signup', { email, password: PASSWORD });
const login = (api: Api, email: string, password = PASSWORD) => api.anon.post('/v1/auth/login', { email, password });
const verify = (api: Api, token: string) => api.anon.post('/v1/auth/verify', { token });

describe('email confirmation at sign-up', () => {
  it('asks for a mail relay when it is switched on without one', async () => {
    await expect(makeApi({ env: { OMNIFLOW_SIGNUP: 'true', OMNIFLOW_SIGNUP_VERIFY_EMAIL: 'true' } })).rejects.toThrow(
      /OMNIFLOW_SIGNUP_VERIFY_EMAIL/,
    );
  });

  it('is off by default: sign-up signs the person straight in', () =>
    withApi(
      async (api, sent) => {
        expect((await api.anon.get('/v1/info')).body.signupVerifyEmail).toBe(false);
        const res = await signup(api, 'quick@example.com');
        expect(res.status).toBe(200);
        expect(sent).toHaveLength(0);
      },
      { OMNIFLOW_SIGNUP: 'true', OMNIFLOW_SMTP_URL: 'json:' },
    ));

  it('holds the account until the emailed link is followed, once', () =>
    withApi(async (api, sent) => {
      expect((await api.anon.get('/v1/info')).body.signupVerifyEmail).toBe(true);
      const res = await signup(api, 'careful@example.com');
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ verify: true });
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ to: 'careful@example.com', subject: expect.stringContaining('Confirm') });

      // the right password is told why; a wrong one learns nothing
      const blocked = await login(api, 'careful@example.com');
      expect(blocked.status).toBe(401);
      expect(JSON.stringify(blocked.body)).toContain('Confirm your email');
      const wrong = await login(api, 'careful@example.com', 'not-the-password-123');
      expect(JSON.stringify(wrong.body)).not.toContain('Confirm your email');

      const token = tokenOf(sent[0]!, 'verify');
      expect((await verify(api, token)).status).toBe(200);
      expect((await login(api, 'careful@example.com')).status).toBe(200);
      expect((await verify(api, token)).status).toBe(401); // single use
      expect((await verify(api, 'z'.repeat(43))).status).toBe(401);

      const [created] = api.app.state.events.list({ types: ['auth.user-created'], order: 'desc', limit: 1 });
      expect(created?.data).toMatchObject({ selfServe: true, emailVerification: 'pending' });
    }));

  it('resends a link only to an unconfirmed address, and answers the same for every address', () =>
    withApi(async (api, sent) => {
      await signup(api, 'later@example.com');
      const first = tokenOf(sent[0]!, 'verify');
      const resend = (email: string) => api.anon.post('/v1/auth/resend-verification', { email });

      const known = await resend('later@example.com');
      const unknown = await resend('nobody@example.com');
      expect(unknown.status).toBe(known.status);
      expect(unknown.body).toEqual(known.body);
      expect(sent.map((m) => m.to)).toEqual(['later@example.com', 'later@example.com']);

      // the new link works, and it retired the first
      expect((await verify(api, first)).status).toBe(401);
      expect((await verify(api, tokenOf(sent[1]!, 'verify'))).status).toBe(200);
      // a confirmed address is not mailed again
      await resend('later@example.com');
      expect(sent).toHaveLength(2);
    }));

  it('leaves the operator and every existing account alone', () =>
    withApi(async (api) => {
      expect((await api.login()).cookie).toBeDefined();
    }));
});
