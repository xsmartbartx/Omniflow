import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The console is served under `script-src 'self'; style-src 'self'`. These checks make that policy a
 * property of the source, not just of the response header: nothing here can need an inline script or
 * style, nothing builds markup from strings, and nothing loads from another origin.
 */

const ROOT = resolve(import.meta.dirname, '../../console');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
const all = files(ROOT);
const js = all.filter((f) => f.endsWith('.js'));
const read = (f: string) => readFileSync(f, 'utf8');
const rel = (f: string) => relative(ROOT, f);

describe('console source is CSP-safe', () => {
  it('has the files it needs', () => {
    for (const f of ['index.html', 'styles.css', 'favicon.svg', 'js/app.js'])
      expect(existsSync(join(ROOT, f)), f).toBe(true);
    expect(js.length).toBeGreaterThan(20);
  });

  it('never builds markup from strings or evaluates code', () => {
    const banned: Array<[RegExp, string]> = [
      [
        /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write|createContextualFragment|DOMParser/,
        'markup from strings',
      ],
      [/\beval\s*\(|new\s+Function\s*\(|setTimeout\s*\(\s*['"`]|setInterval\s*\(\s*['"`]/, 'string evaluation'],
      [/\.setAttribute\(\s*['"]style['"]/, 'inline style attribute'],
      [/\.setAttribute\(\s*['"]on/i, 'inline event handler attribute'],
      [/\bsrcdoc\b/, 'srcdoc'],
    ];
    for (const f of js.filter((x) => !x.endsWith('dom.js')))
      for (const [re, why] of banned) expect(re.test(read(f)), `${rel(f)}: ${why}`).toBe(false);
    // dom.js is the one place that names these — only to forbid them
    expect(read(join(ROOT, 'js/dom.js'))).toContain("'innerHTML'");
  });

  it('index.html has no inline script, inline style, inline handlers or foreign origins', () => {
    const html = read(join(ROOT, 'index.html'));
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son\w+\s*=/i);
    const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]!);
    for (const u of urls) expect(u.startsWith('/'), u).toBe(true);
  });

  it('stylesheet and script never reach other origins', () => {
    expect(read(join(ROOT, 'styles.css'))).not.toMatch(/@import|url\(\s*['"]?(https?:)?\/\//i);
    for (const f of js) {
      const src = read(f);
      const external = [...src.matchAll(/https?:\/\/[^\s'"`)]+/g)]
        .map((m) => m[0])
        .filter((u) => !u.startsWith('http://www.w3.org/2000/svg'));
      expect(
        external.filter((u) => !/example\.(com|invalid)|localhost|127\.0\.0\.1/.test(u)),
        `${rel(f)} mentions an external URL`,
      ).toEqual([]);
    }
  });

  it('every relative import resolves to a real file', () => {
    for (const f of js) {
      for (const m of read(f).matchAll(/(?:import\s[^'"]*from\s*|import\s*\(\s*)['"](\.[^'"]+)['"]/g)) {
        expect(existsSync(resolve(dirname(f), m[1]!)), `${rel(f)} imports ${m[1]}`).toBe(true);
      }
    }
  });

  it('every route in the table points at a real view module', () => {
    const app = read(join(ROOT, 'js/app.js'));
    const views = [...app.matchAll(/import\('\.\/views\/([\w-]+)\.js'\)/g)].map((m) => m[1]!);
    expect(views.length).toBeGreaterThanOrEqual(15);
    for (const v of views) {
      const src = read(join(ROOT, `js/views/${v}.js`));
      expect(src, `${v}.js must export a default view`).toMatch(/export default (async )?function/);
    }
    // and every view file is reachable from the router
    for (const f of readdirSync(join(ROOT, 'js/views')).filter((n) => n.endsWith('.js'))) {
      const name = f.replace(/\.js$/, '');
      if (name === 'common') continue;
      expect(
        views.includes(name) || read(join(ROOT, 'js/app.js')).includes(`views/${name}.js`),
        `${name} is not routed`,
      ).toBe(true);
    }
  });

  it('the shipped copy is small enough to be served without a build step', () => {
    const bytes = all.reduce((n, f) => n + statSync(f).size, 0);
    expect(bytes).toBeLessThan(400_000);
  });
});
