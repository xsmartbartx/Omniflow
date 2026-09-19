import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import Fastify, { type FastifyInstance } from 'fastify';
import { ulid } from '../core/index.ts';
import type { Omniflow } from './context.ts';
import { buildOpenApi, fromFastifyValidation, problem, type RouteDef, registerRoutes } from './http.ts';
import { RateLimiter } from './rate-limit.ts';
import { adminRoutes } from './routes/admin.ts';
import { authoringRoutes } from './routes/authoring.ts';
import { insightRoutes } from './routes/insight.ts';
import { publicRoutes } from './routes/public.ts';
import { runRoutes } from './routes/runs.ts';
import { workflowRoutes } from './routes/workflows.ts';

/** Walk up from this file to the directory holding `package.json`. */
export function packageRoot(from: string = dirname(fileURLToPath(import.meta.url))): string {
  let dir = from;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return resolve(from, '..');
}

const CONSOLE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function securityHeaders(app: Omniflow): Record<string, string> {
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    ...(app.config.publicUrl.startsWith('https:')
      ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' }
      : {}),
  };
}

/**
 * The Gateway (architecture §5.1 #1): the sole entry point for humans and external systems.
 * Authentication, rate limiting, request correlation and transport-level validation — no business
 * logic; every decision is delegated to the Policy Engine and the services below it.
 */
export async function buildServer(app: Omniflow): Promise<{ server: FastifyInstance; routes: RouteDef[] }> {
  const server = Fastify({
    logger: false,
    trustProxy: app.config.trustProxy,
    bodyLimit: 1024 * 1024 + 4096,
    genReqId: (req) => {
      const supplied = req.headers['x-request-id'];
      return typeof supplied === 'string' && /^[A-Za-z0-9._-]{8,64}$/.test(supplied) ? supplied : `req_${ulid()}`;
    },
  });

  // JSON bodies are validated strictly (no type coercion: 42 is not "42"); query strings and path
  // parameters are text by nature, so they are coerced. Unknown properties are rejected, never dropped.
  const ajvOpts = { allErrors: true, useDefaults: true, removeAdditional: false, strict: false } as const;
  // ajv-formats ships CommonJS; under NodeNext its default export is the module namespace.
  const applyFormats = ((addFormats as unknown as { default?: unknown }).default ?? addFormats) as unknown as (
    a: Ajv,
  ) => Ajv;
  const strictAjv = applyFormats(new Ajv({ ...ajvOpts, coerceTypes: false }));
  const coercingAjv = applyFormats(new Ajv({ ...ajvOpts, coerceTypes: 'array' }));
  server.setValidatorCompiler(({ schema, httpPart }) =>
    (httpPart === 'body' ? strictAjv : coercingAjv).compile(schema),
  );

  const limiters = {
    api: new RateLimiter(app.config.rateLimitPerMinute),
    ipGlobal: new RateLimiter(app.config.rateLimitPerMinute * 2),
    login: new RateLimiter(10, 10),
    webhook: new RateLimiter(300, 60),
  };
  const headers = securityHeaders(app);

  // Raw body for webhooks (the signature covers the exact bytes); safe JSON everywhere else.
  const defaultJson = server.getDefaultJsonParser('error', 'ignore');
  server.removeContentTypeParser('application/json');
  server.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (req.url.startsWith('/v1/hooks/')) return done(null, body);
    return defaultJson(req, body as string, done);
  });

  const httpRequests = app.metrics.counter('omniflow_http_requests_total', 'HTTP requests by route and status.');
  const httpSeconds = app.metrics.histogram(
    'omniflow_http_request_duration_seconds',
    'HTTP request duration by route.',
  );

  server.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
    for (const [k, v] of Object.entries(headers)) reply.header(k, v);
    const wait = limiters.ipGlobal.take(`ip:${req.ip}`);
    if (wait > 0) {
      reply.header('retry-after', String(wait));
      reply
        .code(429)
        .send({ error: { code: 'RATE_LIMITED', message: 'Too many requests', class: 'transient', requestId: req.id } });
      return reply;
    }
    if (req.url.startsWith('/v1/') || req.url === '/metrics') {
      reply.header('cache-control', 'no-store');
    }
    return undefined;
  });

  server.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url ?? 'unmatched';
    httpRequests.inc({ method: req.method, route, status: String(reply.statusCode) });
    httpSeconds.observe({ route }, reply.elapsedTime / 1000);
    app.log.debug('request', {
      id: req.id,
      method: req.method,
      route,
      status: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
      principal: req.principal?.id,
    });
  });

  server.setErrorHandler((err, req, reply) => {
    let e: unknown = err;
    const fv = err as {
      validation?: Array<{
        instancePath?: string;
        message?: string;
        keyword?: string;
        params?: Record<string, unknown>;
      }>;
      validationContext?: string;
      statusCode?: number;
      code?: string;
    };
    if (fv.validation) e = fromFastifyValidation(fv.validation, fv.validationContext ?? 'request');
    else if (fv.statusCode && fv.statusCode < 500 && !(e as { errorClass?: unknown }).errorClass) {
      // Fastify's own 4xx (payload too large, malformed JSON, unsupported media type…)
      const status = fv.statusCode;
      void reply
        .code(status)
        .send({
          error: {
            code: fv.code ?? 'BAD_REQUEST',
            message:
              status === 413
                ? 'The request body is too large'
                : status === 415
                  ? 'Send application/json'
                  : 'The request could not be understood',
            class: 'contract',
            requestId: req.id,
          },
        });
      return;
    }
    const p = problem(e, req.id);
    if (p.status >= 500)
      app.log.error('request failed', { id: req.id, method: req.method, url: req.url.split('?')[0], error: e });
    for (const [k, v] of Object.entries(p.headers ?? {})) reply.header(k, v);
    void reply.code(p.status).send(p.body);
  });

  // ---------------------------------------------------------------- routes
  const defs: RouteDef[] = [];
  let openApi: object | undefined;
  const getOpenApi = () => (openApi ??= buildOpenApi(defs, { version: app.config.version }));
  defs.push(
    ...publicRoutes(getOpenApi),
    ...workflowRoutes(),
    ...runRoutes(),
    ...insightRoutes(),
    ...authoringRoutes(),
    ...adminRoutes(),
  );
  registerRoutes(server, app, defs, limiters);

  // ---------------------------------------------------------------- console
  const consoleDir = join(packageRoot(), 'console');
  if (existsSync(consoleDir)) {
    await server.register(fastifyStatic, {
      root: consoleDir,
      prefix: '/',
      wildcard: false,
      setHeaders: (res, path) => {
        res.header('content-security-policy', CONSOLE_CSP);
        res.header('cache-control', path.endsWith('index.html') ? 'no-cache' : 'public, max-age=300');
      },
    });
  }

  server.setNotFoundHandler(async (req, reply) => {
    const isApi = req.url.startsWith('/v1/') || req.method !== 'GET';
    if (!isApi && existsSync(join(consoleDir, 'index.html')) && (req.headers.accept ?? '').includes('text/html')) {
      return reply.type('text/html').header('content-security-policy', CONSOLE_CSP).sendFile('index.html');
    }
    return reply
      .code(404)
      .send({ error: { code: 'NOT_FOUND', message: 'Not found', class: 'business', requestId: req.id } });
  });

  return { server, routes: defs };
}
