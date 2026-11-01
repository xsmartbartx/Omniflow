import { describe, expect, it } from 'vitest';
import { type Api, ADMIN, makeApi } from '../helpers/api.ts';
import { inbox, type Sent, tokenOf } from '../helpers/inbox.ts';

const CHOSEN = 'a-long-enough-passphrase';

async function withApi(fn: (api: Api, sent: Sent[]) => Promise<void>) {
  const { mailer, sent } = inbox();
  const api = await makeApi({ env: { OMNIFLOW_SIGNUP: 'true' }, mailer });
  try {
    await fn(api, sent);
  } finally {
    await api.stop();
  }
}

describe('inviting a teammate by email', () => {
  it('mails a link, lets the person choose their own password, and keeps them in the inviter’s workspace', () =>
    withApi(async (api, sent) => {
      const owner = await api.anon.post('/v1/auth/signup', { email: 'owner@example.com', password: CHOSEN });
      const tenant = owner.body.principal.tenant as string;
      const admin = await api.login('owner@example.com', CHOSEN);

      const res = await admin.post('/v1/users/invite', { email: 'mate@example.com', name: 'Mate', roles: ['viewer'] });
      expect(res.status, res.text).toBe(201);
      expect(res.body.passwordHash).toBeUndefined();
      expect(res.body.tenant).toBe(tenant);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ to: 'mate@example.com', subject: expect.stringContaining('invited') });
      expect(sent[0]!.text).toContain('expires in 7 days');

      // nobody knows a password yet; the link is how they get one
      expect((await api.anon.post('/v1/auth/login', { email: 'mate@example.com', password: CHOSEN })).status).toBe(401);
      const token = tokenOf(sent[0]!, 'reset');
      expect((await api.anon.post('/v1/auth/reset', { token, password: CHOSEN })).status).toBe(200);
      const mate = await api.login('mate@example.com', CHOSEN);
      const me = await mate.get('/v1/auth/me');
      expect(me.body.principal.tenant).toBe(tenant);
      expect(me.body.principal.roles).toEqual(['viewer']);
      // a link works once
      expect((await api.anon.post('/v1/auth/reset', { token, password: CHOSEN })).status).toBe(401);
    }));

  it('is for administrators, refuses a taken address, and does not exist without a mail relay', async () => {
    await withApi(async (api, sent) => {
      await api.anon.post('/v1/auth/signup', { email: 'owner@example.com', password: CHOSEN });
      const admin = await api.login('owner@example.com', CHOSEN);
      expect((await admin.post('/v1/users/invite', { email: 'mate@example.com', roles: ['viewer'] })).status).toBe(201);
      expect((await admin.post('/v1/users/invite', { email: 'MATE@example.com', roles: ['viewer'] })).status).toBe(409);
      expect((await admin.post('/v1/users/invite', { email: 'owner@example.com', roles: ['viewer'] })).status).toBe(
        409,
      );
      expect((await admin.post('/v1/users/invite', { email: 'x@example.com', roles: ['nonsense'] })).status).toBe(400);
      expect(sent).toHaveLength(1);

      const viewer = await api.key(['viewer']);
      expect((await viewer.post('/v1/users/invite', { email: 'y@example.com', roles: ['viewer'] })).status).toBe(403);
      expect((await api.anon.post('/v1/users/invite', { email: 'y@example.com', roles: ['viewer'] })).status).toBe(401);
    });

    const plain = await makeApi();
    try {
      const operator = await plain.login(ADMIN.email, ADMIN.password);
      expect((await operator.post('/v1/users/invite', { email: 'z@example.com', roles: ['viewer'] })).status).toBe(404);
    } finally {
      await plain.stop();
    }
  });
});
