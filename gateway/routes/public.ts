import { AuthenticationError, ForbiddenError, NotFoundError, ValidationError } from '../../core/index.ts';
import { ACTIONS } from '../../schemas/index.ts';
import type { MailedToken } from '../auth.ts';
import { clearSessionCookie, type RouteDef, sessionCookie } from '../http.ts';
import { obj } from './util.ts';

/** Who is asking, for the audit trail. */
const clientOf = (req: { ip: string; headers: Record<string, unknown> }) => ({
  ip: req.ip,
  ...(typeof req.headers['user-agent'] === 'string' ? { userAgent: req.headers['user-agent'] } : {}),
});

type App = Parameters<RouteDef['handler']>[0]['app'];

/** The wording of one kind of emailed link. */
interface LinkMail {
  fragment: 'reset' | 'verify';
  subject: string;
  action: string;
  ignore: string;
}
const RESET_MAIL: LinkMail = {
  fragment: 'reset',
  subject: 'Reset your OmniFlow password',
  action: 'choose a new password',
  ignore: 'your password has not changed',
};
const VERIFY_MAIL: LinkMail = {
  fragment: 'verify',
  subject: 'Confirm your email address for OmniFlow',
  action: 'confirm your email address and finish creating your account',
  ignore: 'no account will be usable without it',
};

/** Email a single-use link. Not awaited: the answer must not reveal, by how long it takes, whether an address has an account. */
function mailLink(app: App, ip: string, mailed: MailedToken, mail: LinkMail): void {
  if (!app.mailer) return;
  const base = app.config.publicUrl.endsWith('/') ? app.config.publicUrl.slice(0, -1) : app.config.publicUrl;
  const link = `${base}/#/${mail.fragment}?token=${mailed.token}`;
  void app.mailer
    .send({
      to: mailed.to,
      subject: mail.subject,
      text: `Hello ${mailed.name},\n\nUse this link to ${mail.action}. It works once and expires in ${mailed.expiresInMinutes} minutes:\n\n${link}\n\nIf you did not ask for this, ignore this email: ${mail.ignore}.\n`,
    })
    .catch((error: unknown) => app.log.warn('could not send an email', { error, ip, subject: mail.subject }));
}

/** Set the session cookie for a fresh sign-in (login or sign-up) and answer with who signed in. */
function startedSession(
  app: Parameters<RouteDef['handler']>[0]['app'],
  reply: { header(name: string, value: string): unknown },
  res: { token: string; user: unknown; principal: unknown; expiresAt: string },
) {
  const secure = app.config.publicUrl.startsWith('https:');
  reply.header('set-cookie', sessionCookie(res.token, app.config.sessionTtlHours * 3600, secure));
  return { user: res.user, principal: res.principal, expiresAt: res.expiresAt };
}

/** Health, meta, authentication and the signed webhook endpoint. */
export function publicRoutes(getOpenApi: () => object): RouteDef[] {
  return [
    {
      method: 'GET',
      url: '/healthz',
      summary: 'Liveness probe',
      tag: 'Meta',
      public: true,
      handler: ({ app }) =>
        app.config.mode === 'nexora'
          ? { status: 'ok', product: 'omniflow', version: app.config.version, mode: 'nexora' }
          : { status: 'ok' },
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
        mode: app.config.mode,
        capabilities: app.capabilities.latest().length,
        setupRequired: app.state.identity.countUsers() === 0,
        passwordReset: Boolean(app.mailer) && app.config.mode === 'standalone',
        signupVerifyEmail: app.config.signup.enabled && app.config.signup.verifyEmail && Boolean(app.mailer),
        signup: app.config.signup.enabled,
        ...(app.config.signup.enabled && (app.config.signup.termsUrl || app.config.signup.privacyUrl)
          ? {
              signupTerms: {
                ...(app.config.signup.termsUrl ? { termsUrl: app.config.signup.termsUrl } : {}),
                ...(app.config.signup.privacyUrl ? { privacyUrl: app.config.signup.privacyUrl } : {}),
              },
            }
          : {}),
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
      schema: {
        body: obj(
          {
            email: { type: 'string', maxLength: 254 },
            password: { type: 'string', maxLength: 256 },
            tenant: { type: 'string', maxLength: 64 },
          },
          ['email', 'password'],
        ),
      },
      handler: async ({ req, reply, app, body }) =>
        startedSession(
          app,
          reply,
          await app.auth.login(body.email, body.password, {
            ...(body.tenant ? { tenant: body.tenant } : {}),
            ...clientOf(req),
          }),
        ),
    },
    {
      method: 'POST',
      url: '/v1/auth/signup',
      summary: 'Create an account (a tenant of its own) and sign in; only when the operator turned sign-up on',
      tag: 'Auth',
      public: true,
      limit: 'signup',
      schema: {
        body: obj(
          {
            email: { type: 'string', format: 'email', maxLength: 254 },
            password: { type: 'string', maxLength: 256 },
            name: { type: 'string', maxLength: 100 },
            organization: { type: 'string', maxLength: 100 },
            acceptTerms: { type: 'boolean' },
          },
          ['email', 'password'],
        ),
      },
      handler: async ({ req, reply, app, body }) => {
        const { enabled, maxTenants, termsUrl, privacyUrl } = app.config.signup;
        if (!enabled) throw new NotFoundError('Not found');
        const consentRequired = Boolean(termsUrl || privacyUrl);
        if (consentRequired && body.acceptTerms !== true)
          throw new ValidationError('You must accept the terms and the privacy policy to create an account', [
            {
              path: 'acceptTerms',
              code: 'TERMS_NOT_ACCEPTED',
              message: 'Accept the terms and privacy policy to continue',
            },
          ]);
        const result = await app.auth.signUp(body, {
          maxTenants,
          ...(app.config.signup.verifyEmail && app.mailer ? { verifyEmail: true } : {}),
          ...(consentRequired
            ? { accepted: { ...(termsUrl ? { termsUrl } : {}), ...(privacyUrl ? { privacyUrl } : {}) } }
            : {}),
          ...clientOf(req),
        });
        if ('verify' in result) {
          mailLink(app, req.ip, result.verify, VERIFY_MAIL);
          reply.code(202);
          return { verify: true };
        }
        return startedSession(app, reply, result);
      },
    },
    {
      method: 'POST',
      url: '/v1/auth/verify',
      summary: 'Confirm an email address with the token from the sign-up email',
      tag: 'Auth',
      public: true,
      limit: 'redeem',
      schema: { body: obj({ token: { type: 'string', minLength: 20, maxLength: 200 } }, ['token']) },
      handler: ({ app, body }) => {
        if (!app.config.signup.verifyEmail || !app.mailer) throw new NotFoundError('Not found');
        app.auth.verifyEmail(body.token);
        return { ok: true };
      },
    },
    {
      method: 'POST',
      url: '/v1/auth/resend-verification',
      summary: 'Email a new confirmation link; always answers the same, whether or not the address awaits confirmation',
      tag: 'Auth',
      public: true,
      limit: 'reset',
      schema: { body: obj({ email: { type: 'string', format: 'email', maxLength: 254 } }, ['email']) },
      handler: ({ app, body, req }) => {
        if (!app.config.signup.verifyEmail || !app.mailer) throw new NotFoundError('Not found');
        const pending = app.auth.resendEmailVerification(body.email);
        if (pending) mailLink(app, req.ip, pending, VERIFY_MAIL);
        return { ok: true };
      },
    },
    {
      method: 'POST',
      url: '/v1/auth/forgot',
      summary: 'Email a password reset link; always answers the same, whether or not the address has an account',
      tag: 'Auth',
      public: true,
      limit: 'reset',
      schema: { body: obj({ email: { type: 'string', format: 'email', maxLength: 254 } }, ['email']) },
      handler: ({ app, body, req }) => {
        if (!app.mailer || app.config.mode !== 'standalone') throw new NotFoundError('Not found');
        const reset = app.auth.requestPasswordReset(body.email);
        if (reset) mailLink(app, req.ip, reset, RESET_MAIL);
        return { ok: true };
      },
    },
    {
      method: 'POST',
      url: '/v1/auth/reset',
      summary: 'Choose a new password with the token from the reset email',
      tag: 'Auth',
      public: true,
      limit: 'redeem',
      schema: {
        body: obj(
          { token: { type: 'string', minLength: 20, maxLength: 200 }, password: { type: 'string', maxLength: 256 } },
          ['token', 'password'],
        ),
      },
      handler: async ({ app, body }) => {
        if (!app.mailer || app.config.mode !== 'standalone') throw new NotFoundError('Not found');
        await app.auth.completePasswordReset(body.token, body.password);
        return { ok: true };
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
          ...(user
            ? {
                user: {
                  id: user.id,
                  email: user.email,
                  name: user.name,
                  roles: user.roles,
                  mustChangePassword: user.mustChangePassword,
                },
              }
            : {}),
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
      schema: {
        body: obj({ current: { type: 'string', maxLength: 256 }, next: { type: 'string', maxLength: 256 } }, [
          'current',
          'next',
        ]),
      },
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
        return result.status === 'skipped'
          ? { status: 'skipped', reason: result.reason }
          : { status: result.status, runId: result.run.id };
      },
    },
  ];
}

const header = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
