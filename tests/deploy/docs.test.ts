import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createDefaultRegistry, defaultAdapterConfig } from '../../capabilities/index.ts';
import { compile } from '../../orchestration/compiler/index.ts';
import { OUTPUTS } from '../../scripts/docs-outputs.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const walk = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );

const userDocs = [
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CHANGELOG.md',
  ...walk('docs').filter((f) => f.endsWith('.md') && !f.startsWith('docs/reference/')),
];

describe('documentation stays true to the code', () => {
  it('every workflow manifest shown in the docs compiles as written', () => {
    const base = defaultAdapterConfig();
    const caps = createDefaultRegistry({
      ...base,
      shell: { ...base.shell, allowedCommands: ['/bin/true'] },
      datasources: { d: 'sqlite:///:memory:' },
      channels: { c: 'https://x.invalid/h' },
      email: { smtpUrl: 'smtp://x.invalid', from: 'a@x.invalid' },
      llm: { ...base.llm, apiKey: 'x' },
    });
    let checked = 0;
    for (const file of userDocs) {
      for (const m of read(file).matchAll(/```yaml\n([\s\S]*?)```/g)) {
        const block = m[1]!;
        if (!/^apiVersion: omniflow\.dev\/v1\nkind: Workflow/.test(block)) continue;
        const r = compile(block, { environment: 'production', capabilities: caps, today: '2026-06-01' });
        expect(r.errors, `${file}: ${block.split('\n').find((l) => l.includes('name:'))}`).toEqual([]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(3);
  });

  it('every YAML fragment in the docs at least parses', () => {
    for (const file of userDocs) {
      for (const m of read(file).matchAll(/```yaml\n([\s\S]*?)```/g)) {
        // fragments start mid-document ("- id: …"); wrap them so a syntax slip still fails
        const block = m[1]!;
        expect(() => parse(block), `${file}: ${block.slice(0, 60)}`).not.toThrow();
      }
    }
  });

  it('every relative link and anchor resolves', () => {
    const slug = (h: string) =>
      h
        .toLowerCase()
        .replace(/`/g, '')
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s/g, '-'); // GitHub keeps one hyphen per space
    const anchors = (file: string) =>
      new Set([...read(file).matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) => slug(m[1]!)));
    const broken: string[] = [];
    for (const file of userDocs) {
      const text = read(file).replace(/```[\s\S]*?```/g, '');
      for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1]!;
        if (/^(https?:|mailto:)/.test(target)) continue;
        const [path, anchor] = target.split('#');
        const resolved = path ? join(dirname(file), path) : file;
        if (!existsSync(join(ROOT, resolved))) {
          broken.push(`${file} → ${target} (no such file)`);
          continue;
        }
        if (anchor && resolved.endsWith('.md') && !anchors(resolved).has(anchor))
          broken.push(`${file} → ${target} (no such heading)`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('the configuration reference covers every variable the code reads and .env.example documents', () => {
    const doc = read('docs/configuration.md');
    const vars = new Set(read('.env.example').match(/\b(?:OMNIFLOW|ANTHROPIC)_[A-Z_]+\b/g));
    const sources = ['server', 'gateway', 'capabilities', 'insight', 'authoring', 'cli']
      .flatMap((d) => walk(d))
      .filter((f) => f.endsWith('.ts'));
    const internal = new Set(['OMNIFLOW_COLOR_FORCE']); // set by the CLI entry point itself, not by users
    for (const f of sources)
      for (const m of read(f).matchAll(/\b(OMNIFLOW_[A-Z_]+)\b/g)) if (!internal.has(m[1]!)) vars.add(m[1]!);
    const missing = [...vars].filter((v) => !doc.includes(v)).sort();
    expect(missing).toEqual([]);
  });

  it('generated reference docs are current (run `npm run docs:generate`)', () => {
    for (const [file, content] of Object.entries(OUTPUTS)) expect(read(file), `${file} is stale`).toBe(content);
  });

  it('every test file the security page cites exists', () => {
    for (const m of read('docs/security.md').matchAll(/`(tests\/[\w/.-]+\.test\.ts)`/g))
      expect(existsSync(join(ROOT, m[1]!)), m[1]).toBe(true);
  });

  it('the shipped policy example and file list referenced by the docs exist', () => {
    for (const f of [
      'policies/examples/house-rules.yaml',
      'deploy/k8s/omniflow.yaml',
      'deploy/Caddyfile',
      'deploy/nginx.conf',
      'deploy/systemd/omniflow.service',
      'deploy/backup.sh',
      'deploy/smoke-test.sh',
      'schemas/manifest.schema.json',
      'examples/custom-capability/server.ts',
    ]) {
      expect(existsSync(join(ROOT, f)), f).toBe(true);
    }
  });
});
