import { AuthenticationError, NotFoundError } from '../../core/index.ts';
import { fakeAssertion } from '../../nexora/index.ts';
import { parseCookies, type RouteDef, sessionCookie } from '../http.ts';
import { obj } from './util.ts';

const ROLE_ENUM = ['owner', 'admin', 'member', 'billing', 'viewer'];

/**
 * NEXORA integration routes. Registered only in `nexora` mode, so a standalone install does not
 * expose them at all.
 */
export function nexoraRoutes(): RouteDef[] {
  return [
    {
      method: 'GET',
      url: '/app',
      summary: 'Sign in with a NEXORA identity (sets an Constans session, redirects to the console)',
      tag: 'NEXORA',
      public: true,
      raw: true,
      limit: 'sso',
      handler: async ({ req, reply, app }) => {
        const nx = app.nexora;
        if (!nx) throw new NotFoundError('Route');
        const assertion = parseCookies(req.headers.cookie)[app.config.nexora.assertionCookie];
        if (!assertion) throw new AuthenticationError('Sign in to NEXORA first');
        const { user } = await nx.service.signIn(assertion);
        const ttlMs = app.config.nexora.sessionTtlMinutes * 60_000;
        const { token } = app.auth.issueSession(user, ttlMs, {
          ip: req.ip,
          ...(req.headers['user-agent'] ? { userAgent: req.headers['user-agent'] } : {}),
        });
        reply
          .header(
            'set-cookie',
            sessionCookie(token, Math.floor(ttlMs / 1000), app.config.publicUrl.startsWith('https:')),
          )
          .code(302)
          .header('location', '/#/dashboard')
          .send();
      },
    },
    {
      method: 'GET',
      url: '/v1/nexora/usage',
      summary: 'Runs used this month against the organisation plan',
      tag: 'NEXORA',
      handler: ({ app, principal }) => app.nexora?.service.usage(principal) ?? { metered: false },
    },
    {
      method: 'POST',
      url: '/app/dev-login',
      summary: 'Development only: set a fake NEXORA identity cookie (unsigned; disabled in production)',
      tag: 'NEXORA',
      public: true,
      limit: 'sso',
      schema: {
        body: obj(
          {
            orgId: { type: 'string', maxLength: 100 },
            userId: { type: 'string', maxLength: 100 },
            email: { type: 'string', format: 'email', maxLength: 200 },
            name: { type: 'string', maxLength: 100 },
            role: { type: 'string', enum: ROLE_ENUM },
          },
          ['orgId', 'userId', 'email', 'role'],
        ),
      },
      handler: ({ app, reply, body }) => {
        if (!app.nexora?.fake || app.config.environment === 'production') throw new NotFoundError('Route');
        const cookie = `${app.config.nexora.assertionCookie}=${fakeAssertion(body)}; Path=/; HttpOnly; SameSite=Lax`;
        reply.header('set-cookie', cookie);
        return { ok: true, next: '/app' };
      },
    },
  ];
}
