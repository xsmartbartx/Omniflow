import { AuthenticationError, ForbiddenError, redact, ValidationError } from '../../core/index.ts';
import { ACTIONS } from '../../schemas/index.ts';
import { clearSessionCookie, type RouteDef, sessionCookie } from '../http.ts';
import { obj } from './util.ts';

/** Health, meta, authentication and the signed webhook endpoint. */
export function publicRoutes(getOpenApi: () => object): RouteDef[] {
  return [
    {
      method: 'GET',
      url: '/healthz',
      summary: 'Liveness probe',
      tag: 'Meta',
      public: true,
      handler: () => ({ status: 'ok' }),
    },
    {
      method: 'GET',
      url: '/readyz',
      summary: 'Readiness probe (state plane reachable, orchestrator running)',
      tag: 'Meta',
      public: true,
      handler: ({ app }) => {
        const ok = app.state.db.get<{ ok: number }>('SELECT 1 AS ok')?.ok === 1;
        return { status: ok ? 'ready' : 'unavailable', activeSteps: app.orchestrator.inflightSteps };
      },
    },
    {
      method: 'GET',
      url: '/v1/info',
      summary: 'Platform information',
      tag: 'Meta',
      public: true,
      handler: ({ app }) => ({
        name: 'OmniFlow',
        version: app.config.version,
        environment: app.config.environment,
        capabilities: app.capabilities.latest().length,
        setupRequired: app.state.identity.countUsers() === 0,
      }),
    },
    {
      method: 'GET',
      url: '/v1/openapi.json',
      summary: 'OpenAPI 3.1 description of this API',
      tag: 'Meta',
      public: true,
      handler: () => getOpenApi(),
    },
    {
      method: 'GET',
      url: '/metrics',
      summary: 'Prometheus metrics',
      tag: 'Meta',
      public: true,
      raw: true,
      handler: ({ req, reply, app }) => {
        // Scrapers use a static token (OMNIFLOW_METRICS_TOKEN) or any API key that may read the audit log.
        const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
        let allowed = false;
        if (app.config.metricsToken && token === app.config.metricsToken) allowed = true;
        else if (token) {
          const p = app.auth.authenticateApiKey(token);
          allowed = p !== undefined && app.policy.can(p, 'audit.read');
        }
        if (!allowed) throw new AuthenticationError('Metrics require a metrics token or an API key with audit access');
        reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8').send(app.metrics.render());
      },
    },

    // ------------------------------------------------------------------ auth
    {
      method: 'POST',
      url: '/v1/auth/login',
      summary: 'Sign in with email and password (sets a session cookie)',
      tag: 'Auth',
      public: true,
      limit: 'login',
      schema: { body: obj({ email: { type: 'string', maxLength: 254 }, password: { type: 'string', maxLength: 256 }, tenant: { type: 'string', maxLength: 64 } }, ['email', 'password']) },
      handler: async ({ req, reply, app, body }) => {
        const res = await app.auth.login(body.email, body.password, {
          ...(body.tenant ? { tenant: body.tenant } : {}),
          ip: req.ip,
          ...(req.headers['user-agent'] ? { userAgent: req.headers['user-agent'] } : {}),
        });
        const secure = app.config.publicUrl.startsWith('https:');
        reply.header('set-cookie', sessionCookie(res.token, app.config.sessionTtlHours * 3600, secure));
        return { user: res.user, principal: res.principal, expiresAt: res.expiresAt };
      },
    },
    {
      method: 'POST',
      url: '/v1/auth/logout',
      summary: 'Sign out',
      tag: 'Auth',
      handler: ({ req, reply, app, principal }) => {
        if (req.sessionToken) app.auth.logout(req.sessionToken, principal);
        reply.header('set-cookie', clearSessionCookie(app.config.publicUrl.startsWith('https:')));
        return { ok: true };
      },
    },
    {
      method: 'GET',
      url: '/v1/auth/me',
      summary: 'The authenticated principal, its roles and permissions',
      tag: 'Auth',
      handler: ({ app, principal }) => {
        const user = principal.type === 'user' ? app.state.identity.getUser(principal.id) : undefined;
        return {
          principal,
          ...(user ? { user: { id: user.id, email: user.email, name: user.name, roles: user.roles, mustChangePassword: user.mustChangePassword } } : {}),
          environment: app.config.environment,
          can: Object.fromEntries(ACTIONS.map((a) => [a, app.policy.can(principal, a)])),
        };
      },
    },
    {
      method: 'POST',
      url: '/v1/auth/password',
      summary: 'Change your password (signs out every other session)',
      tag: 'Auth',
      schema: { body: obj({ current: { type: 'string', maxLength: 256 }, next: { type: 'string', maxLength: 256 } }, ['current', 'next']) },
      handler: async ({ app, principal, body }) => {
        if (principal.type !== 'user') throw new ForbiddenError('Only people have passwords');
        await app.auth.changePassword(principal.id, body.current, body.next);
        return { ok: true };
      },
    },

    // -------------------------------------------------------------- webhooks
    {
      method: 'POST',
      url: '/v1/hooks/:tenant/:workflow/:trigger',
      summary: 'Signed webhook delivery that starts a run',
      tag: 'Triggers',
      public: true,
      limit: 'webhook',
      status: 202,
      handler: ({ req, app, params }) => {
        // The body arrives as the raw string (see the webhook content-type parser) so the signature covers exact bytes.
        const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
        const result = app.triggers.handleWebhook({
          tenant: params.tenant,
          workflow: params.workflow,
          trigger: params.trigger,
          rawBody: raw,
          headers: {
            timestamp: header(req.headers['x-omniflow-timestamp']),
            signature: header(req.headers['x-omniflow-signature']),
            delivery: header(req.headers['x-omniflow-delivery']),
          },
        });
        return result.status === 'skipped' ? { status: 'skipped', reason: result.reason } : { status: result.status, runId: result.run.id };
      },
    },
  ];
}

const header = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export { ValidationError, redact };
