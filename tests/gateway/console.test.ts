import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Api, makeApi } from '../helpers/api.ts';

let api: Api;
beforeAll(async () => {
  api = await makeApi();
});
afterAll(async () => {
  await api.stop();
});

const html = { accept: 'text/html' };

describe('the web console is served by the gateway', () => {
  it('serves the app shell with a strict Content-Security-Policy and no caching', async () => {
    const res = await api.anon.get('/', html);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('<div id="app">');
    const csp = String(res.headers['content-security-policy']);
    for (const directive of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'none'"]) expect(csp).toContain(directive);
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('serves modules, styles and the icon with the right types, all under the same policy', async () => {
    const script = await api.anon.get('/js/app.js');
    expect(script.status).toBe(200);
    expect(script.headers['content-type']).toMatch(/javascript/);
    expect(script.headers['content-security-policy']).toContain("script-src 'self'");
    expect(script.text).toContain("import * as api from './api.js'");
    const css = await api.anon.get('/styles.css');
    expect(css.headers['content-type']).toContain('text/css');
    expect((await api.anon.get('/favicon.svg')).headers['content-type']).toContain('image/svg+xml');
    expect(String((await api.anon.get('/js/views/run.js')).headers['cache-control'])).toContain('max-age');
  });

  it('every module the app shell imports is actually served', async () => {
    const app = (await api.anon.get('/js/app.js')).text;
    const lazy = [...app.matchAll(/import\('\.\/(views\/[\w-]+\.js)'\)/g)].map((m) => `/js/${m[1]}`);
    const eager = [...app.matchAll(/from '\.\/([\w-]+\.js)'/g)].map((m) => `/js/${m[1]}`);
    expect(lazy.length + eager.length).toBeGreaterThan(20);
    for (const url of [...lazy, ...eager]) expect((await api.anon.get(url)).status, url).toBe(200);
  });

  it('falls back to the app for deep links, but never for the API or non-browser clients', async () => {
    expect((await api.anon.get('/workflows/some-workflow', html)).text).toContain('<div id="app">');
    const apiMiss = await api.anon.get('/v1/nope', html);
    expect(apiMiss.status).toBe(404);
    expect(apiMiss.body.error.code).toBe('NOT_FOUND');
    const json = await api.anon.get('/workflows/x', { accept: 'application/json' });
    expect(json.status).toBe(404);
    expect((await api.anon.post('/anything', {})).status).toBe(404);
  });

  it('cannot be used to read files outside the console directory', async () => {
    for (const path of ['/../package.json', '/%2e%2e/package.json', '/js/../../package.json', '/..%2fpackage.json', '/js/%2e%2e/%2e%2e/server/config.ts']) {
      const res = await api.anon.get(path);
      expect(res.text, path).not.toContain('"name": "omniflow"');
      expect(res.text, path).not.toContain('loadConfig');
    }
  });

  it('the API stays unauthenticated-safe next to the console', async () => {
    expect((await api.anon.get('/v1/auth/me')).status).toBe(401);
    expect((await api.anon.get('/v1/workflows')).status).toBe(401);
    expect((await api.anon.get('/healthz')).status).toBe(200);
  });

  it('a signed-in session sees the permission map the console uses to show or hide controls', async () => {
    const admin = await api.login();
    const me = (await admin.get('/v1/auth/me')).body;
    expect(me.can['tenant.manage']).toBe(true);
    expect(me.can['workflow.publish']).toBe(true);
    const viewer = await api.key(['viewer']);
    const v = (await viewer.get('/v1/auth/me')).body;
    expect(v.can['workflow.publish']).toBe(false);
    expect(v.can['user.manage']).toBe(false);
    expect(Object.keys(v.can)).toContain('apikey.manage');
  });
});
