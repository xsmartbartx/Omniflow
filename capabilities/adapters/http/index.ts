import type { CapabilityContext, CapabilityDeclaration, FailureMode } from '../../../schemas/index.ts';
import { type CapabilityAdapter, CapabilityError } from '../../contract/types.ts';
import type { AdapterConfig } from '../config.ts';
import { safeRequest } from './safe-http.ts';

interface HttpInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  timeoutMs?: number;
  expectStatus?: number[];
  followRedirects?: boolean;
}

interface HttpOutput {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: unknown;
  url: string;
  dryRun?: boolean;
}

const failureModes: FailureMode[] = [
  { code: 'HTTP_TIMEOUT', class: 'transient', retryable: true, description: 'Request timed out' },
  { code: 'HTTP_NETWORK', class: 'transient', retryable: true, description: 'Connection error' },
  {
    code: 'HTTP_429',
    class: 'transient',
    retryable: true,
    description: 'Rate limited by the remote service',
  },
  {
    code: 'HTTP_5XX',
    class: 'transient',
    retryable: true,
    description: '502/503/504 or other retryable server error',
  },
  {
    code: 'HTTP_401',
    class: 'authorisation',
    retryable: false,
    description: 'Credentials rejected',
  },
  {
    code: 'HTTP_4XX',
    class: 'business',
    retryable: false,
    description: 'The service rejected the request',
  },
  {
    code: 'EGRESS_DENIED',
    class: 'authorisation',
    retryable: false,
    description: 'Destination is not in the egress allow-list',
  },
  {
    code: 'HTTP_RESPONSE_TOO_LARGE',
    class: 'contract',
    retryable: false,
    description: 'Response exceeded the size cap',
  },
  { code: 'HTTP_INVALID_URL', class: 'contract', retryable: false },
];

const outputSchema = {
  type: 'object',
  required: ['status', 'ok', 'headers', 'body', 'url'],
  properties: {
    status: { type: 'integer' },
    ok: { type: 'boolean' },
    headers: { type: 'object', additionalProperties: { type: 'string' } },
    body: {},
    url: { type: 'string' },
    dryRun: { type: 'boolean' },
  },
  additionalProperties: false,
};

function inputSchema(withMethod: boolean) {
  return {
    type: 'object',
    required: ['url'],
    additionalProperties: false,
    properties: {
      url: { type: 'string', minLength: 8, maxLength: 4096 },
      ...(withMethod ? { method: { enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], default: 'POST' } } : {}),
      headers: {
        type: 'object',
        additionalProperties: { type: 'string', maxLength: 8192 },
        maxProperties: 50,
      },
      query: {
        type: 'object',
        additionalProperties: { type: ['string', 'number', 'boolean'] },
        maxProperties: 50,
      },
      ...(withMethod ? { body: {} } : {}),
      timeoutMs: { type: 'integer', minimum: 100, maximum: 300_000 },
      expectStatus: {
        type: 'array',
        items: { type: 'integer', minimum: 100, maximum: 599 },
        maxItems: 20,
      },
      followRedirects: { type: 'boolean' },
    },
  };
}

function statusError(status: number, headers: Record<string, string>, body: unknown): CapabilityError {
  const details: Record<string, unknown> = { status };
  if (headers['retry-after']) details.retryAfter = headers['retry-after'];
  const snippet = typeof body === 'string' ? body.slice(0, 500) : JSON.stringify(body)?.slice(0, 500);
  if (snippet) details.bodySnippet = snippet;
  if (status === 429)
    return new CapabilityError('HTTP_429', 'Rate limited (HTTP 429)', {
      errorClass: 'transient',
      details,
    });
  if (status === 408 || status === 425 || status === 500 || status === 502 || status === 503 || status === 504) {
    return new CapabilityError('HTTP_5XX', `Service unavailable (HTTP ${status})`, {
      errorClass: 'transient',
      details,
    });
  }
  if (status === 401 || status === 403) {
    return new CapabilityError('HTTP_401', `Credentials rejected (HTTP ${status})`, {
      errorClass: 'authorisation',
      details,
    });
  }
  return new CapabilityError('HTTP_4XX', `Request rejected (HTTP ${status})`, {
    errorClass: 'business',
    details,
  });
}

function parseBody(headers: Record<string, string>, body: Buffer): unknown {
  const text = body.toString('utf8');
  if ((headers['content-type'] ?? '').toLowerCase().includes('json') && text.length > 0) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function build(config: AdapterConfig, ctx: CapabilityContext, input: HttpInput, method: string) {
  const url = new URL(input.url);
  for (const [k, v] of Object.entries(input.query ?? {})) url.searchParams.set(k, String(v));
  const headers: Record<string, string> = {
    'user-agent': config.http.userAgent,
    accept: 'application/json, text/plain;q=0.9, */*;q=0.5',
    ...Object.fromEntries(Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
  };
  let body: string | undefined;
  if (input.body !== undefined && input.body !== null && method !== 'GET') {
    if (typeof input.body === 'string') {
      body = input.body;
    } else {
      body = JSON.stringify(input.body);
      headers['content-type'] ??= 'application/json';
    }
  }
  if (ctx.idempotencyKey && method !== 'GET') headers['idempotency-key'] ??= ctx.idempotencyKey;
  return { url: url.toString(), headers, body };
}

async function perform(
  config: AdapterConfig,
  ctx: CapabilityContext,
  input: HttpInput,
  method: string,
): Promise<HttpOutput> {
  if (ctx.egress.length === 0) {
    throw new CapabilityError('EGRESS_DENIED', "This step must declare 'egress' hosts to use an HTTP capability", {
      errorClass: 'authorisation',
      retryable: false,
    });
  }
  const { url, headers, body } = build(config, ctx, input, method);
  const res = await safeRequest({
    method,
    url,
    headers,
    ...(body !== undefined ? { body } : {}),
    signal: ctx.signal,
    allowedHosts: ctx.egress,
    allowPrivate: config.allowPrivateNetworks,
    maxResponseBytes: config.http.maxResponseBytes,
    maxRedirects: config.http.maxRedirects,
    timeoutMs: input.timeoutMs ?? config.http.defaultTimeoutMs,
    ...(input.followRedirects === undefined ? {} : { followRedirects: input.followRedirects }),
  });
  const parsed = parseBody(res.headers, res.body);
  const expected = input.expectStatus;
  const ok = expected ? expected.includes(res.status) : res.status >= 200 && res.status < 300;
  if (!ok) throw statusError(res.status, res.headers, parsed);
  return { status: res.status, ok: true, headers: res.headers, body: parsed, url: res.url };
}

export function createHttpCapabilities(config: AdapterConfig): CapabilityAdapter[] {
  const common = {
    family: 'http',
    outputSchema,
    scopes: ['network:http'],
    egress: { mode: 'step' as const },
    costModel: { unitsPerInvocation: 1, latencyClass: 'fast' as const },
    failureModes,
    dataClassification: 'confidential' as const,
  };

  const get: CapabilityAdapter<HttpInput, HttpOutput> = {
    declaration: {
      ...common,
      name: 'http-get',
      version: '1.0.0',
      description: "Read a resource over HTTP(S). Destination must be listed in the step's egress allow-list.",
      inputSchema: inputSchema(false),
      effect: 'idempotent',
      dryRun: 'execute',
    } as CapabilityDeclaration,
    execute: (ctx, input) => perform(config, ctx, input, 'GET'),
  };

  const req: CapabilityAdapter<HttpInput, HttpOutput> = {
    declaration: {
      ...common,
      name: 'http-request',
      version: '1.0.0',
      description:
        'Send an HTTP(S) request with any method. Effectful: requires an idempotencyKey, which is forwarded as the Idempotency-Key header.',
      inputSchema: inputSchema(true),
      effect: 'effectful',
      dryRun: 'simulate',
    } as CapabilityDeclaration,
    execute: (ctx, input) => perform(config, ctx, input, input.method ?? 'POST'),
    simulate: (_ctx, input) => ({
      status: 200,
      ok: true,
      headers: {},
      body: null,
      url: input.url,
      dryRun: true,
    }),
  };

  return [get, req] as CapabilityAdapter[];
}
