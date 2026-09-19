import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  classifyAddress,
  createHttpCapabilities,
  defaultAdapterConfig,
  isAddressAllowed,
  matchesEgress,
} from '../../capabilities/index.ts';
import { makeCtx } from '../helpers/ctx.ts';

describe('egress matching', () => {
  it('matches exact hosts on default ports only unless a port is given', () => {
    expect(matchesEgress({ host: 'api.example.com', port: 443 }, ['api.example.com'])).toBe(true);
    expect(matchesEgress({ host: 'api.example.com', port: 80 }, ['api.example.com'])).toBe(true);
    expect(matchesEgress({ host: 'api.example.com', port: 8080 }, ['api.example.com'])).toBe(false);
    expect(matchesEgress({ host: 'api.example.com', port: 8080 }, ['api.example.com:8080'])).toBe(true);
    expect(matchesEgress({ host: 'api.example.com', port: 443 }, ['API.EXAMPLE.COM'])).toBe(true);
  });

  it('supports subdomain wildcards but not the apex, and never bare wildcards', () => {
    expect(matchesEgress({ host: 'a.example.com', port: 443 }, ['*.example.com'])).toBe(true);
    expect(matchesEgress({ host: 'a.b.example.com', port: 443 }, ['*.example.com'])).toBe(true);
    expect(matchesEgress({ host: 'example.com', port: 443 }, ['*.example.com'])).toBe(false);
    expect(matchesEgress({ host: 'evilexample.com', port: 443 }, ['*.example.com'])).toBe(false);
    expect(matchesEgress({ host: 'example.com.evil.io', port: 443 }, ['example.com'])).toBe(false);
    expect(matchesEgress({ host: 'x.com', port: 443 }, [])).toBe(false);
  });
});

describe('address classification (SSRF)', () => {
  it('always forbids metadata, link-local, multicast and unspecified addresses', () => {
    for (const ip of ['169.254.169.254', '169.254.0.1', '0.0.0.0', '224.0.0.1', '100.100.100.200', 'fe80::1', '::']) {
      expect(classifyAddress(ip), ip).toBe('forbidden');
      expect(isAddressAllowed(ip, true), `${ip} even with allowPrivate`).toBe(false);
    }
  });

  it('blocks private ranges unless the operator opts in', () => {
    for (const ip of [
      '10.1.2.3',
      '172.16.0.9',
      '172.31.255.1',
      '192.168.1.1',
      '127.0.0.1',
      '100.64.0.1',
      '::1',
      'fd12::1',
    ]) {
      expect(classifyAddress(ip), ip).toBe('private');
      expect(isAddressAllowed(ip, false), ip).toBe(false);
      expect(isAddressAllowed(ip, true), ip).toBe(true);
    }
  });

  it('allows public addresses and unwraps IPv4-mapped IPv6', () => {
    expect(classifyAddress('93.184.216.34')).toBe('ok');
    expect(classifyAddress('2606:2800:220:1::1')).toBe('ok');
    expect(classifyAddress('::ffff:127.0.0.1')).toBe('private');
    expect(classifyAddress('::ffff:169.254.169.254')).toBe('forbidden');
    expect(classifyAddress('172.32.0.1')).toBe('ok'); // just outside 172.16/12
    expect(classifyAddress('not-an-ip')).toBe('forbidden');
  });
});

let server: Server;
let base: string;
let otherBase: string;
let other: Server;
const seen: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: string }> = [];

function handler(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
    const url = new URL(req.url ?? '/', 'http://x');
    switch (url.pathname) {
      case '/json':
        res.setHeader('content-type', 'application/json');
        res.setHeader('set-cookie', 'session=abc');
        res.end(JSON.stringify({ hello: 'world', q: url.searchParams.get('q') }));
        return;
      case '/text':
        res.setHeader('content-type', 'text/plain');
        res.end('plain');
        return;
      case '/echo':
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ method: req.method, body, ct: req.headers['content-type'] }));
        return;
      case '/429':
        res.statusCode = 429;
        res.setHeader('retry-after', '7');
        res.end('slow down');
        return;
      case '/503':
        res.statusCode = 503;
        res.end();
        return;
      case '/404':
        res.statusCode = 404;
        res.end('nope');
        return;
      case '/401':
        res.statusCode = 401;
        res.end();
        return;
      case '/redirect-ok':
        res.statusCode = 302;
        res.setHeader('location', '/json');
        res.end();
        return;
      case '/redirect-out':
        res.statusCode = 302;
        res.setHeader('location', `${otherBase}/json`);
        res.end();
        return;
      case '/redirect-loop':
        res.statusCode = 302;
        res.setHeader('location', '/redirect-loop');
        res.end();
        return;
      case '/big':
        res.end(Buffer.alloc(20_000, 'a'));
        return;
      case '/slow':
        setTimeout(() => res.end('late'), 2000);
        return;
      case '/created':
        res.statusCode = 201;
        res.end('made');
        return;
      default:
        res.statusCode = 404;
        res.end();
    }
  });
}

beforeAll(async () => {
  server = createServer(handler);
  other = createServer(handler);
  await Promise.all([
    new Promise<void>((r) => server.listen(0, '127.0.0.1', r)),
    new Promise<void>((r) => other.listen(0, '127.0.0.1', r)),
  ]);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  other.close();
});

const build = (over: Partial<ReturnType<typeof defaultAdapterConfig>> = {}) => {
  const cfg = defaultAdapterConfig({ allowPrivateNetworks: true, ...over });
  cfg.http.maxResponseBytes = 10_000;
  const [get, request] = createHttpCapabilities(cfg);
  return { get: get!, request: request! };
};
const allow = () => [new URL(base).host];

describe('http-get', () => {
  it('reads JSON, applies query parameters, and drops set-cookie', async () => {
    const { get } = build();
    const out = await get.execute(makeCtx({ egress: allow() }), { url: `${base}/json`, query: { q: 'a b' } });
    expect(out).toMatchObject({ status: 200, ok: true, body: { hello: 'world', q: 'a b' } });
    expect(out.headers['set-cookie']).toBeUndefined();
    expect(out.headers['content-type']).toBe('application/json');
  });

  it('returns text bodies as strings', async () => {
    const out = await build().get.execute(makeCtx({ egress: allow() }), { url: `${base}/text` });
    expect(out.body).toBe('plain');
  });

  it('maps HTTP statuses onto error classes', async () => {
    const { get } = build();
    const run = (p: string) => get.execute(makeCtx({ egress: allow() }), { url: `${base}${p}` }).catch((e) => e);
    const e429 = await run('/429');
    expect(e429).toMatchObject({ code: 'HTTP_429', errorClass: 'transient', retryable: true });
    expect(e429.details).toMatchObject({ status: 429, retryAfter: '7' });
    expect(await run('/503')).toMatchObject({ code: 'HTTP_5XX', errorClass: 'transient', retryable: true });
    expect(await run('/404')).toMatchObject({ code: 'HTTP_4XX', errorClass: 'business', retryable: false });
    expect(await run('/401')).toMatchObject({ code: 'HTTP_401', errorClass: 'authorisation', retryable: false });
  });

  it('honours expectStatus', async () => {
    const { get } = build();
    const ok = await get.execute(makeCtx({ egress: allow() }), { url: `${base}/404`, expectStatus: [404] });
    expect(ok.status).toBe(404);
    const created = await get.execute(makeCtx({ egress: allow() }), { url: `${base}/created` });
    expect(created.status).toBe(201);
  });

  it('follows same-allow-list redirects and refuses redirects that leave the allow-list', async () => {
    const { get } = build();
    const followed = await get.execute(makeCtx({ egress: allow() }), { url: `${base}/redirect-ok` });
    expect(followed.body).toMatchObject({ hello: 'world' });
    const escaped = await get.execute(makeCtx({ egress: allow() }), { url: `${base}/redirect-out` }).catch((e) => e);
    expect(escaped).toMatchObject({ code: 'EGRESS_DENIED', errorClass: 'authorisation', retryable: false });
    const loop = await get.execute(makeCtx({ egress: allow() }), { url: `${base}/redirect-loop` }).catch((e) => e);
    expect(loop.code).toBe('HTTP_TOO_MANY_REDIRECTS');
  });

  it('caps response size', async () => {
    const err = await build()
      .get.execute(makeCtx({ egress: allow() }), { url: `${base}/big` })
      .catch((e) => e);
    expect(err).toMatchObject({ code: 'HTTP_RESPONSE_TOO_LARGE', errorClass: 'contract' });
  });

  it('times out as a transient failure', async () => {
    const err = await build()
      .get.execute(makeCtx({ egress: allow() }), { url: `${base}/slow`, timeoutMs: 150 })
      .catch((e) => e);
    expect(err).toMatchObject({ code: 'HTTP_TIMEOUT', errorClass: 'transient', retryable: true });
  });

  it('stops promptly when the run is cancelled', async () => {
    const ac = new AbortController();
    const p = build()
      .get.execute(makeCtx({ egress: allow(), signal: ac.signal }), { url: `${base}/slow` })
      .catch((e) => e);
    setTimeout(() => ac.abort(), 50);
    const err = await p;
    expect(err.code).toBe('CANCELLED');
  });
});

describe('http egress enforcement', () => {
  it('denies a step that declares no egress', async () => {
    const err = await build()
      .get.execute(makeCtx(), { url: `${base}/json` })
      .catch((e) => e);
    expect(err).toMatchObject({ code: 'EGRESS_DENIED' });
  });

  it('denies hosts outside the allow-list', async () => {
    const err = await build()
      .get.execute(makeCtx({ egress: ['api.example.com'] }), { url: `${base}/json` })
      .catch((e) => e);
    expect(err).toMatchObject({ code: 'EGRESS_DENIED', errorClass: 'authorisation' });
  });

  it('blocks private addresses by default even when the host is allow-listed', async () => {
    const strict = build({ allowPrivateNetworks: false });
    const err = await strict.get.execute(makeCtx({ egress: allow() }), { url: `${base}/json` }).catch((e) => e);
    expect(err).toMatchObject({ code: 'EGRESS_DENIED' });
  });

  it('never reaches cloud metadata, even when allow-listed and private access is enabled', async () => {
    const err = await build()
      .get.execute(makeCtx({ egress: ['169.254.169.254'] }), { url: 'http://169.254.169.254/latest/meta-data/' })
      .catch((e) => e);
    expect(err).toMatchObject({ code: 'EGRESS_DENIED' });
    const v6 = await build()
      .get.execute(makeCtx({ egress: ['[fd00:ec2::254]'.replace(/[[\]]/g, '')] }), { url: 'http://[fd00:ec2::254]/' })
      .catch((e) => e);
    expect(v6).toMatchObject({ code: 'EGRESS_DENIED' });
  });

  it('rejects non-http schemes, embedded credentials and header injection', async () => {
    const { get } = build();
    const ctx = makeCtx({ egress: allow() });
    expect(await get.execute(ctx, { url: 'file:///etc/passwd' }).catch((e) => e)).toMatchObject({
      code: 'EGRESS_DENIED',
    });
    expect(await get.execute(ctx, { url: `http://user:pw@${new URL(base).host}/json` }).catch((e) => e)).toMatchObject({
      code: 'EGRESS_DENIED',
    });
    expect(
      await get.execute(ctx, { url: `${base}/json`, headers: { host: 'evil.test' } }).catch((e) => e),
    ).toMatchObject({ code: 'HTTP_INVALID_HEADER' });
    expect(
      await get.execute(ctx, { url: `${base}/json`, headers: { 'x-a': 'v\r\nx-injected: 1' } }).catch((e) => e),
    ).toMatchObject({ code: 'HTTP_INVALID_HEADER' });
  });

  it('normalises numeric IP tricks before checking (127.1, decimal, hex)', async () => {
    const { get } = build({ allowPrivateNetworks: false });
    for (const host of ['127.1', '2130706433', '0x7f000001']) {
      const err = await get
        .execute(makeCtx({ egress: [host] }), { url: `http://${host}:${new URL(base).port}/json` })
        .catch((e) => e);
      expect(err.code, host).toBe('EGRESS_DENIED');
    }
  });
});

describe('http-request', () => {
  it('sends JSON bodies and forwards the idempotency key', async () => {
    seen.length = 0;
    const { request } = build();
    const out = await request.execute(makeCtx({ egress: allow(), idempotencyKey: 'order-42' }), {
      url: `${base}/echo`,
      method: 'POST',
      body: { a: 1 },
    });
    expect(out.body).toMatchObject({ method: 'POST', body: '{"a":1}', ct: 'application/json' });
    expect(seen.at(-1)!.headers['idempotency-key']).toBe('order-42');
  });

  it('sends string bodies verbatim and uses the caller content-type', async () => {
    const { request } = build();
    const out = await request.execute(makeCtx({ egress: allow() }), {
      url: `${base}/echo`,
      method: 'PUT',
      body: 'raw',
      headers: { 'Content-Type': 'text/csv' },
    });
    expect(out.body).toMatchObject({ method: 'PUT', body: 'raw', ct: 'text/csv' });
  });

  it('is declared effectful with a simulated dry run that performs no request', async () => {
    seen.length = 0;
    const { request } = build();
    expect(request.declaration.effect).toBe('effectful');
    expect(request.declaration.dryRun).toBe('simulate');
    const sim = await request.simulate!(makeCtx({ dryRun: true }), { url: `${base}/echo` });
    expect(sim).toMatchObject({ status: 200, dryRun: true });
    expect(seen).toHaveLength(0);
  });
});
