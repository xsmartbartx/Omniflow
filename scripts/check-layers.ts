#!/usr/bin/env node
/**
 * Enforces the dependency rule of docs/omniflow-architecture-and-vision.md §4.1 and the
 * structural conformance items of ADR-0002:
 *
 *  - Core depends on nothing.
 *  - Security calls only Core (and the contract layer, `schemas`).
 *  - Orchestration may not depend on Pipeline (there is no Pipeline code in this repo).
 *  - No agent module has a write path to the registry, scheduler, orchestrator or adapters (ADR-0002 #5).
 *  - The Orchestrator holds no external network access (§11.3, ADR-0002 D6).
 *
 * Exits non-zero (a build failure) on any violation.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Which layers a layer may import from (besides itself). */
const ALLOWED: Record<string, string[]> = {
  core: [],
  schemas: ['core'],
  security: ['core', 'schemas'],
  capabilities: ['core', 'schemas', 'security'],
  state: ['core', 'schemas', 'security'],
  orchestration: ['core', 'schemas', 'security', 'capabilities', 'state'],
  insight: ['core', 'schemas', 'security', 'capabilities', 'state'],
  authoring: ['core', 'schemas', 'security', 'capabilities', 'state', 'orchestration'],
  gateway: ['core', 'schemas', 'security', 'capabilities', 'state', 'orchestration', 'insight', 'authoring'],
  // The CLI is an entry point like `server`, and its embedded mode (`omniflow dev`) uses the composition root.
  cli: [
    'core',
    'schemas',
    'security',
    'capabilities',
    'state',
    'orchestration',
    'insight',
    'authoring',
    'gateway',
    'server',
  ],
  server: ['core', 'schemas', 'security', 'capabilities', 'state', 'orchestration', 'insight', 'authoring', 'gateway'],
};

/** Agent modules: may only *propose*. They may never import these execution-plane modules. */
const AGENT_DIRS = ['authoring/agents', 'insight/analysis', 'security/pentest'];
const AGENT_FORBIDDEN = [
  'orchestration/registry',
  'orchestration/scheduler',
  'orchestration/orchestrator',
  'orchestration/runtime',
  'orchestration/triggers',
  'capabilities/adapters',
];

/** Modules that must never touch the network directly. */
const NO_NETWORK_DIRS = ['orchestration/orchestrator'];
const NETWORK_MODULES = [
  'node:http',
  'node:https',
  'node:http2',
  'node:net',
  'node:tls',
  'node:dns',
  'node:dgram',
  'undici',
  'fastify',
  'pg',
  'nodemailer',
];

const violations: string[] = [];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'coverage' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|(?:^|[^\w.])import\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

function specifiers(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec) found.push(spec);
  }
  return found;
}

const layerOf = (rel: string): string => rel.split(sep)[0] ?? '';

for (const layer of Object.keys(ALLOWED)) {
  let dir: string;
  try {
    dir = join(root, layer);
    statSync(dir);
  } catch {
    continue;
  }
  for (const file of walk(dir)) {
    const relFile = relative(root, file).split(sep).join('/');
    const source = readFileSync(file, 'utf8');
    for (const spec of specifiers(source)) {
      const isRelative = spec.startsWith('.');
      if (isRelative) {
        const target = relative(root, resolve(dirname(file), spec))
          .split(sep)
          .join('/');
        const targetLayer = layerOf(target);
        if (targetLayer !== layer && !(ALLOWED[layer] ?? []).includes(targetLayer)) {
          violations.push(`${relFile}: layer '${layer}' may not import from '${targetLayer}' (${spec})`);
        }
        if (
          AGENT_DIRS.some((d) => relFile.startsWith(`${d}/`)) &&
          AGENT_FORBIDDEN.some((f) => target === f || target.startsWith(`${f}/`))
        ) {
          violations.push(`${relFile}: agent module may not import execution-plane module '${target}' (ADR-0002 D4)`);
        }
      } else if (NO_NETWORK_DIRS.some((d) => relFile.startsWith(`${d}/`))) {
        const bare = spec.replace(/^node:/, '');
        if (NETWORK_MODULES.some((m) => m === spec || m === `node:${bare}` || spec.startsWith(`${m}/`))) {
          violations.push(`${relFile}: orchestrator may not import network module '${spec}' (ADR-0002 D6)`);
        }
      }
    }
    if (NO_NETWORK_DIRS.some((d) => relFile.startsWith(`${d}/`)) && /\bfetch\s*\(/.test(source)) {
      violations.push(`${relFile}: orchestrator may not call fetch() (ADR-0002 D6)`);
    }
  }
}

if (violations.length > 0) {
  console.error(`Layer check failed with ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ✗ ${v}`);
  process.exit(1);
}
console.log('Layer check passed.');
