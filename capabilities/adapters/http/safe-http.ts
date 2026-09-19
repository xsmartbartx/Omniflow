import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import { Agent, request } from 'undici';
import { CapabilityError } from '../../contract/types.ts';
import { isAddressAllowed, matchesEgress } from './egress.ts';

export interface SafeRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  signal: AbortSignal;
  /** Hosts this call may reach (the step's/capability's declared egress). */
  allowedHosts: readonly string[];
  allowPrivate: boolean;
  maxResponseBytes: number;
  maxRedirects: number;
  timeoutMs: number;
  followRedirects?: boolean;
}

export interface SafeResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  url: string;
  truncated: boolean;
}

const FORBIDDEN_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization',
]);

function egressDenied(message: string, details?: Record<string, unknown>): CapabilityError {
  return new CapabilityError('EGRESS_DENIED', message, {
    errorClass: 'authorisation',
    retryable: false,
    ...(details ? { details } : {}),
  });
}

/**
 * Agents are keyed by policy. The custom `lookup` validates every resolved address *at connect
 * time*, so a hostname that resolves to a public address during a pre-check and to an internal one
 * at connect time (DNS rebinding) is still refused.
 */
const agents = new Map<boolean, Agent>();
function agentFor(allowPrivate: boolean): Agent {
  let agent = agents.get(allowPrivate);
  if (!agent) {
    agent = new Agent({
      connect: {
        lookup: ((hostname: string, options: any, callback: any) => {
          dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
            if (err) return callback(err);
            const list = addresses as unknown as Array<{ address: string; family: number }>;
            const bad = list.find((a) => !isAddressAllowed(a.address, allowPrivate));
            if (bad || list.length === 0) {
              return callback(
                Object.assign(new Error(`Refusing to connect to ${hostname}: blocked address`), {
                  code: 'EGRESS_BLOCKED_ADDRESS',
                }),
              );
            }
            if (options?.all) return callback(null, list);
            return callback(null, list[0]!.address, list[0]!.family);
          });
        }) as never,
      },
      keepAliveTimeout: 10_000,
      headersTimeout: 60_000,
      bodyTimeout: 60_000,
    });
    agents.set(allowPrivate, agent);
  }
  return agent;
}

function validateTarget(raw: string, req: SafeRequest): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CapabilityError('HTTP_INVALID_URL', `Invalid URL`, {
      errorClass: 'contract',
      retryable: false,
    });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw egressDenied(`Only http and https are allowed (got ${url.protocol})`);
  }
  if (url.username || url.password) {
    throw egressDenied('Credentials in URLs are not allowed; use a header with a secret');
  }
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!matchesEgress({ host, port }, req.allowedHosts)) {
    throw egressDenied(`Host '${host}:${port}' is not in the declared egress allow-list`, {
      host,
      port,
      allowed: [...req.allowedHosts],
    });
  }
  if (isIP(host) && !isAddressAllowed(host, req.allowPrivate)) {
    throw egressDenied(`Address '${host}' is in a blocked network range`);
  }
  return url;
}

function classifyNetworkError(e: unknown, req: SafeRequest): CapabilityError {
  if (e instanceof CapabilityError) return e;
  const err = e as { code?: string; name?: string; message?: string; cause?: { code?: string } };
  const code = err.code ?? err.cause?.code;
  if (req.signal.aborted) {
    const reason = req.signal.reason as { name?: string } | undefined;
    if (reason?.name === 'TimeoutError') {
      return new CapabilityError('HTTP_TIMEOUT', `Request timed out after ${req.timeoutMs}ms`, {
        errorClass: 'transient',
      });
    }
    return new CapabilityError('CANCELLED', 'Request cancelled', {
      errorClass: 'systemic',
      retryable: false,
    });
  }
  if (
    err.name === 'TimeoutError' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  ) {
    return new CapabilityError('HTTP_TIMEOUT', 'Request timed out', { errorClass: 'transient' });
  }
  if (code === 'EGRESS_BLOCKED_ADDRESS') {
    return egressDenied(err.message ?? 'Blocked address');
  }
  return new CapabilityError('HTTP_NETWORK', `Network error${code ? ` (${code})` : ''}`, {
    errorClass: 'transient',
    details: code ? { code } : {},
  });
}

/** Abandon a response stream without letting its abort surface as an uncaught 'error' event. */
function discard(body: { on(e: 'error', l: () => void): unknown; destroy(): unknown }): void {
  body.on('error', () => {});
  body.destroy();
}

/** An HTTP client that can only reach what it has been explicitly allowed to reach. */
export async function safeRequest(req: SafeRequest): Promise<SafeResponse> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers ?? {})) {
    const lower = k.toLowerCase();
    if (FORBIDDEN_HEADERS.has(lower)) {
      throw new CapabilityError('HTTP_INVALID_HEADER', `Header '${k}' may not be set`, {
        errorClass: 'contract',
        retryable: false,
      });
    }
    if (/[\r\n]/.test(v) || /[\r\n]/.test(k)) {
      throw new CapabilityError('HTTP_INVALID_HEADER', `Header '${k}' contains a line break`, {
        errorClass: 'contract',
        retryable: false,
      });
    }
    headers[lower] = v;
  }

  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(req.timeoutMs)]);
  const guarded: SafeRequest = { ...req, signal };
  let url = validateTarget(req.url, guarded);
  let method = req.method;
  let body = req.body;

  for (let hop = 0; ; hop++) {
    try {
      const res = await request(url, {
        method: method as never,
        headers,
        ...(body !== undefined && method !== 'GET' && method !== 'HEAD' ? { body } : {}),
        signal,
        dispatcher: agentFor(req.allowPrivate),
      });

      const status = res.statusCode;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && typeof location === 'string' && req.followRedirects !== false) {
        discard(res.body);
        if (hop >= req.maxRedirects) {
          throw new CapabilityError('HTTP_TOO_MANY_REDIRECTS', `More than ${req.maxRedirects} redirects`, {
            errorClass: 'business',
            retryable: false,
          });
        }
        url = validateTarget(new URL(location, url).toString(), guarded);
        if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
        }
        // Never forward credentials to a different origin.
        delete headers.authorization;
        delete headers.cookie;
        continue;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      for await (const chunk of res.body) {
        const buf = chunk as Buffer;
        size += buf.length;
        if (size > req.maxResponseBytes) {
          truncated = true;
          discard(res.body);
          break;
        }
        chunks.push(buf);
      }
      if (truncated) {
        throw new CapabilityError(
          'HTTP_RESPONSE_TOO_LARGE',
          `Response exceeded the ${req.maxResponseBytes}-byte limit`,
          { errorClass: 'contract', retryable: false },
        );
      }
      const outHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (k === 'set-cookie' || v === undefined) continue;
        outHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v);
      }
      return {
        status,
        headers: outHeaders,
        body: Buffer.concat(chunks),
        url: url.toString(),
        truncated,
      };
    } catch (e) {
      throw classifyNetworkError(e, guarded);
    }
  }
}
