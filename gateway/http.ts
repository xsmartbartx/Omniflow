import type { FastifyInstance, FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import {
  AuthenticationError,
  ConflictError,
  ForbiddenError,
  type Issue,
  NotFoundError,
  OmniflowError,
  PolicyDeniedError,
  RateLimitedError,
  redact,
  ValidationError,
} from '../core/index.ts';
import type { Action, Principal } from '../schemas/index.ts';
import { SESSION_COOKIE } from './auth.ts';
import type { Omniflow } from './context.ts';
import type { RateLimiter } from './rate-limit.ts';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
    sessionToken?: string;
    viaCookie?: boolean;
  }
}

export interface Ctx<B = any, Q = any, P = any> {
  req: FastifyRequest;
  reply: FastifyReply;
  app: Omniflow;
  principal: Principal;
  body: B;
  query: Q;
  params: P;
}

export interface RouteDef {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  summary: string;
  tag: string;
  /** No authentication (health checks, login, signed webhooks). */
  public?: boolean;
  /** RBAC action checked through the Policy Engine before the handler runs. */
  action?: Action;
  schema?: { params?: object; querystring?: object; body?: object };
  /** Success status code. */
  status?: number;
  /** Handler takes over the raw response (streaming). */
  raw?: boolean;
  /** Stricter per-IP rate limit bucket name. */
  limit?: 'login' | 'webhook';
  handler: (ctx: Ctx) => unknown | Promise<unknown>;
}

// ------------------------------------------------------------------ errors
export interface ProblemBody {
  error: { code: string; message: string; class: string; details?: unknown; requestId?: string };
}

export function statusFor(e: unknown): number {
  if (e instanceof ValidationError) return 400;
  if (e instanceof AuthenticationError) return 401;
  if (e instanceof ForbiddenError || e instanceof PolicyDeniedError) return 403;
  if (e instanceof NotFoundError) return 404;
  if (e instanceof ConflictError) return 409;
  if (e instanceof RateLimitedError) return 429;
  if (e instanceof OmniflowError && e.code === 'AI_NOT_CONFIGURED') return 503;
  if (e instanceof OmniflowError && e.code.startsWith('LLM_')) return 502;
  if (e instanceof OmniflowError)
    return e.errorClass === 'contract'
      ? 400
      : e.errorClass === 'authorisation'
        ? 403
        : e.errorClass === 'business'
          ? 409
          : 500;
  return 500;
}

/** Server-side conditions whose messages are written for the caller (configuration and upstream-provider problems). */
const USER_FACING_5XX = new Set([
  'AI_NOT_CONFIGURED',
  'LLM_UNAVAILABLE',
  'LLM_BAD_RESPONSE',
  'LLM_AUTH',
  'LLM_REJECTED',
]);

export function problem(
  e: unknown,
  requestId: string,
): { status: number; body: ProblemBody; headers?: Record<string, string> } {
  const status = statusFor(e);
  if (e instanceof OmniflowError && (status < 500 || USER_FACING_5XX.has(e.code))) {
    const info = e.toInfo();
    return {
      status,
      body: {
        error: {
          code: info.code,
          message: info.message,
          class: info.class,
          ...(info.details ? { details: redact(info.details) } : {}),
          requestId,
        },
      },
      ...(e instanceof RateLimitedError
        ? { headers: { 'retry-after': String((e.details as { retryAfterSeconds: number }).retryAfterSeconds) } }
        : {}),
    };
  }
  // Anything else is a bug or an infrastructure fault: never leak internals to the client.
  return {
    status: 500,
    body: {
      error: {
        code: 'INTERNAL',
        message: 'An internal error occurred. Quote the request id when reporting it.',
        class: 'systemic',
        requestId,
      },
    },
  };
}

export function fromFastifyValidation(
  validation: Array<{ instancePath?: string; message?: string; keyword?: string; params?: Record<string, unknown> }>,
  where: string,
): ValidationError {
  const issues: Issue[] = validation.map((v) => ({
    path: `${where}${(v.instancePath ?? '').replace(/\//g, '.')}`.replace(/\.$/, ''),
    code: `SCHEMA_${(v.keyword ?? 'invalid').toUpperCase()}`,
    message:
      v.keyword === 'required'
        ? `Missing required property '${String(v.params?.missingProperty)}'`
        : v.keyword === 'additionalProperties'
          ? `Unknown property '${String(v.params?.additionalProperty)}'`
          : (v.message ?? 'Invalid value'),
  }));
  return new ValidationError('The request is invalid', issues);
}

// ------------------------------------------------------------- cookies & auth
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}
export const clearSessionCookie = (secure: boolean) =>
  `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function authenticate(app: Omniflow, req: FastifyRequest): Principal {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const principal = app.auth.authenticateApiKey(header.slice(7).trim());
    if (!principal) throw new AuthenticationError('Invalid or expired API key');
    return principal;
  }
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) {
    const res = app.auth.authenticateSession(token);
    if (!res) throw new AuthenticationError('Your session has expired; sign in again');
    // Cookie-authenticated writes must carry a header a cross-site form cannot set (CSRF).
    if (MUTATING.has(req.method) && req.headers['x-requested-with'] !== 'omniflow') {
      throw new ForbiddenError('Missing X-Requested-With header', { code: 'CSRF' });
    }
    req.sessionToken = token;
    req.viaCookie = true;
    return res.principal;
  }
  throw new AuthenticationError();
}

// ------------------------------------------------------------ route plumbing
export interface Registered {
  def: RouteDef;
}

export function registerRoutes(
  fastify: FastifyInstance,
  app: Omniflow,
  defs: RouteDef[],
  limiters: { api: RateLimiter; login: RateLimiter; webhook: RateLimiter },
): void {
  for (const def of defs) {
    const handler: RouteHandlerMethod = async (req, reply) => {
      const ip = req.ip;
      const bucket = def.limit === 'login' ? limiters.login : def.limit === 'webhook' ? limiters.webhook : undefined;
      if (bucket) {
        const wait = bucket.take(`${def.limit}:${ip}`);
        if (wait > 0) throw new RateLimitedError(wait);
      }
      let principal: Principal | undefined;
      if (!def.public) {
        principal = authenticate(app, req);
        req.principal = principal;
        const wait = limiters.api.take(`p:${principal.id}`);
        if (wait > 0) throw new RateLimitedError(wait);
        if (def.action) {
          const decision = app.policy.decide({ principal, action: def.action, resource: { tenant: principal.tenant } });
          if (decision.effect !== 'allow') {
            app.state.events.append({
              tenant: principal.tenant,
              type: 'policy.decision',
              actor: { type: principal.type, id: principal.id, name: principal.name },
              data: {
                action: def.action,
                effect: decision.effect,
                reasonCode: decision.reasonCode,
                reason: decision.reason,
                route: `${def.method} ${def.url}`,
              },
            });
            throw new PolicyDeniedError(decision.reasonCode, decision.reason);
          }
        }
      }
      reply.code(def.status ?? 200); // handlers may override (e.g. 201 for a fresh publish, 202 for a change request)
      const result = await def.handler({
        req,
        reply,
        app,
        principal: principal as Principal,
        body: req.body,
        query: req.query,
        params: req.params,
      });
      if (def.raw) return reply;
      return result === undefined ? null : result;
    };
    const optionalBody =
      def.schema?.body !== undefined && !(def.schema.body as { required?: string[] }).required?.length;
    fastify.route({
      method: def.method,
      url: def.url,
      ...(optionalBody
        ? {
            // A body whose fields are all optional may be omitted entirely.
            preValidation: async (req: FastifyRequest) => {
              if (req.body === undefined || req.body === null) req.body = {};
            },
          }
        : {}),
      ...(def.schema ? { schema: def.schema } : {}),
      handler,
    });
  }
}

// ------------------------------------------------------------------- OpenAPI
export function buildOpenApi(defs: RouteDef[], info: { version: string }): object {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const d of defs) {
    const url = d.url.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const params: unknown[] = [];
    for (const name of [...d.url.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!)) {
      params.push({ name, in: 'path', required: true, schema: { type: 'string' } });
    }
    const q = d.schema?.querystring as { properties?: Record<string, unknown>; required?: string[] } | undefined;
    for (const [name, schema] of Object.entries(q?.properties ?? {}))
      params.push({ name, in: 'query', required: q?.required?.includes(name) ?? false, schema });
    (paths[url] ??= {})[d.method.toLowerCase()] = {
      summary: d.summary,
      tags: [d.tag],
      operationId: `${d.method.toLowerCase()}${url.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ?? '').toUpperCase())}`,
      ...(d.public ? { security: [] } : {}),
      ...(d.action ? { 'x-required-action': d.action } : {}),
      ...(params.length ? { parameters: params } : {}),
      ...(d.schema?.body
        ? {
            requestBody: {
              required: ((d.schema.body as { required?: string[] }).required?.length ?? 0) > 0,
              content: { 'application/json': { schema: d.schema.body } },
            },
          }
        : {}),
      responses: {
        [String(d.status ?? 200)]: { description: 'Success' },
        '400': {
          description: 'Validation failed',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Problem' } } },
        },
        ...(d.public
          ? {}
          : {
              '401': { description: 'Authentication required' },
              '403': { description: 'Not permitted (RBAC or policy)' },
            }),
        '429': { description: 'Rate limited' },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'OmniFlow API',
      version: info.version,
      description:
        'Declarative workflow substrate: publish validated workflows, run them deterministically, audit everything.',
    },
    servers: [{ url: '/' }],
    security: [{ bearerApiKey: [] }, { sessionCookie: [] }],
    paths,
    components: {
      securitySchemes: {
        bearerApiKey: {
          type: 'http',
          scheme: 'bearer',
          description: 'API key: `Authorization: Bearer omf_<prefix>_<secret>`',
        },
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: SESSION_COOKIE,
          description: 'Console session. Mutating requests also need `X-Requested-With: omniflow`.',
        },
      },
      schemas: {
        Problem: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                class: { type: 'string' },
                details: {},
                requestId: { type: 'string' },
              },
            },
          },
        },
      },
    },
  };
}
