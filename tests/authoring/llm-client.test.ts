import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultAdapterConfig } from '../../capabilities/index.ts';
import { createAnthropicClient } from '../../server/llm-client.ts';

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

interface Seen {
  path?: string;
  headers?: IncomingHttpHeaders;
  body?: any;
}

async function fakeProvider(respond: (seen: Seen) => { status: number; body: unknown }): Promise<{ url: string; seen: Seen }> {
  const seen: Seen = {};
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.path = req.url;
      seen.headers = req.headers;
      seen.body = JSON.parse(raw);
      const r = respond(seen);
      res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}

const config = (baseUrl: string, over: { apiKey?: string; allowPrivate?: boolean } = {}) => {
  const c = defaultAdapterConfig({ allowPrivateNetworks: over.allowPrivate ?? true });
  c.llm = { ...c.llm, baseUrl, ...(over.apiKey === undefined ? { apiKey: 'sk-test-key' } : over.apiKey ? { apiKey: over.apiKey } : {}) };
  if (over.apiKey === '') delete c.llm.apiKey;
  return c;
};

describe('Anthropic client', () => {
  it('is absent without an API key', () => {
    expect(createAnthropicClient(config('https://api.anthropic.com', { apiKey: '' }))).toBeUndefined();
  });

  it('calls the Messages API with the right headers and body, and parses the reply', async () => {
    const { url, seen } = await fakeProvider(() => ({ status: 200, body: { model: 'claude-x', content: [{ type: 'text', text: 'Hello ' }, { type: 'tool_use' }, { type: 'text', text: 'world' }], usage: { input_tokens: 12, output_tokens: 3 }, stop_reason: 'end_turn' } }));
    const c = createAnthropicClient(config(url))!;
    const r = await c.complete({ system: 'be brief', messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 });
    expect(r).toEqual({ text: 'Hello world', model: 'claude-x', usage: { inputTokens: 12, outputTokens: 3 }, stopReason: 'end_turn' });
    expect(seen.path).toBe('/v1/messages');
    expect(seen.headers).toMatchObject({ 'x-api-key': 'sk-test-key', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' });
    expect(seen.body).toMatchObject({ model: c.model, max_tokens: 50, system: 'be brief', messages: [{ role: 'user', content: 'hi' }] });
  });

  it.each([
    [401, 'LLM_AUTH', 'rejected the API key'],
    [403, 'LLM_AUTH', 'rejected the API key'],
    [429, 'LLM_UNAVAILABLE', 'rate limiting'],
    [529, 'LLM_UNAVAILABLE', 'unavailable'],
    [500, 'LLM_UNAVAILABLE', 'unavailable'],
    [400, 'LLM_REJECTED', 'prompt is too long'],
  ])('maps HTTP %i to %s', async (status, code, text) => {
    const { url } = await fakeProvider(() => ({ status, body: { error: { message: 'prompt is too long' } } }));
    await expect(createAnthropicClient(config(url))!.complete({ system: 's', messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ code, message: expect.stringContaining(text) });
  });

  it('never leaks the API key into an error', async () => {
    const { url } = await fakeProvider(() => ({ status: 401, body: { error: { message: 'bad key sk-test-key' } } }));
    const err = await createAnthropicClient(config(url))!.complete({ system: 's', messages: [{ role: 'user', content: 'x' }] }).catch((e) => e);
    expect(String(err.message)).not.toContain('sk-test-key');
  });

  it('refuses to reach private addresses unless the operator allowed it (SSRF guard applies to the model too)', async () => {
    const { url } = await fakeProvider(() => ({ status: 200, body: { content: [] } }));
    await expect(createAnthropicClient(config(url, { allowPrivate: false }))!.complete({ system: 's', messages: [{ role: 'user', content: 'x' }] })).rejects.toBeTruthy();
  });

  it('reports a non-JSON reply as a bad response', async () => {
    server = createServer((_req, res) => res.writeHead(200).end('<html>oops</html>'));
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await expect(createAnthropicClient(config(url))!.complete({ system: 's', messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ code: 'LLM_BAD_RESPONSE' });
  });
});
