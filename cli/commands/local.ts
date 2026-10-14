import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createDefaultRegistry, defaultAdapterConfig } from '../../capabilities/index.ts';
import { type Issue, randomToken } from '../../core/index.ts';
import { compile } from '../../orchestration/compiler/index.ts';
import type { Manifest } from '../../schemas/index.ts';
import { analyzeWorkflow } from '../../security/pentest/index.ts';
import { loadConfig } from '../../server/config.ts';
import { createConstans } from '../../server/platform.ts';
import { flag, flagAll, has, parseInputs, UsageError } from '../args.ts';
import { type CliContext, emit } from '../context.ts';
import { humanDuration, renderIssue, statusColour, table } from '../format.ts';

/**
 * Commands that need neither a running server nor a data directory: they work on manifest files.
 * `validate` and `compile` are what CI runs on every pull request.
 */

/** A registry that knows every built-in capability, so files can be checked without deployment config. */
function offlineCapabilities() {
  const base = defaultAdapterConfig();
  return createDefaultRegistry({
    ...base,
    shell: { ...base.shell, allowedCommands: ['/bin/true'] },
    datasources: { offline: 'sqlite:///:memory:' },
    channels: { offline: 'https://example.invalid/hook' },
    email: { smtpUrl: 'smtps://offline.invalid', from: 'constans@offline.invalid' },
    llm: { ...base.llm, apiKey: 'offline-validation-only' },
  });
}

function environmentOf(ctx: CliContext): 'development' | 'staging' | 'production' {
  const env = flag(ctx.args, 'env') ?? ctx.env.CONSTANS_ENV ?? 'production';
  if (env !== 'development' && env !== 'staging' && env !== 'production') {
    throw new UsageError(`--env must be development, staging or production (got '${env}')`);
  }
  return env;
}

/** Expand arguments into manifest files: files as given, directories to their `*.yaml`/`*.yml`, `-` to stdin. */
export function expandFiles(ctx: CliContext, paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (p === '-') {
      out.push('-');
      continue;
    }
    const abs = resolve(ctx.cwd, p);
    if (!existsSync(abs)) throw new UsageError(`No such file or directory: ${p}`);
    if (statSync(abs).isDirectory()) {
      const files = readdirSync(abs)
        .filter((f) => /\.ya?ml$/i.test(f))
        .sort()
        .map((f) => join(p, f));
      if (files.length === 0) throw new UsageError(`No .yaml files in ${p}`);
      out.push(...files);
    } else out.push(p);
  }
  return out;
}

async function readManifest(ctx: CliContext, file: string): Promise<string> {
  if (file === '-') return ctx.readStdin();
  return readFileSync(resolve(ctx.cwd, file), 'utf8');
}

interface Checked {
  file: string;
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  workflow?: string;
  version?: string;
  planHash?: string;
  steps?: number;
  risk?: {
    score: number;
    level: string;
    blocking: boolean;
    findings: Array<{ ruleId: string; severity: string; blocking: boolean; message: string; stepId?: string }>;
  };
  source: string;
  plan?: NonNullable<ReturnType<typeof compile>['plan']>;
}

function check(ctx: CliContext, file: string, source: string): Checked {
  const compiled = compile(source, {
    environment: environmentOf(ctx),
    capabilities: offlineCapabilities(),
    today: new Date().toISOString().slice(0, 10),
  });
  const result: Checked = { file, ok: compiled.ok, errors: compiled.errors, warnings: compiled.warnings, source };
  if (compiled.ok && compiled.plan && compiled.hash) {
    const manifest = parseYaml(source, { maxAliasCount: 0 }) as Manifest;
    const risk = analyzeWorkflow({ manifest, plan: compiled.plan, origin: 'human' });
    result.workflow = compiled.plan.workflow.name;
    result.version = compiled.plan.workflow.version;
    result.planHash = compiled.hash;
    result.steps = compiled.plan.steps.length;
    result.plan = compiled.plan;
    result.risk = { score: risk.score, level: risk.level, blocking: risk.blocking, findings: risk.findings };
    if (risk.blocking) result.ok = false;
  }
  return result;
}

function printChecked(ctx: CliContext, r: Checked): void {
  const s = ctx.style;
  for (const i of [...r.errors, ...r.warnings]) ctx.err(`${renderIssue(s, r.file, r.source, i)}\n\n`);
  for (const f of r.risk?.findings.filter((x) => x.blocking || x.severity === 'high' || x.severity === 'critical') ??
    []) {
    const rule = s.dim(`[${f.ruleId}]`);
    const step = f.stepId ? s.dim(` (step ${f.stepId})`) : '';
    ctx.err(`${f.blocking ? s.red('blocking') : s.yellow('risk')}${rule}: ${f.message}${step}\n\n`);
  }
  if (r.planHash) {
    const okMark = r.ok ? s.green('✓') : s.red('✗');
    const ref = s.bold(`${r.workflow}@${r.version}`);
    ctx.out(
      `${okMark} ${ref}  ${r.steps} steps  risk ${r.risk?.level} (${r.risk?.score})  ${s.dim(r.planHash.slice(0, 19))}  ${s.dim(r.file)}\n`,
    );
  } else {
    ctx.out(`${s.red('✗')} ${r.file}  ${r.errors.length} error${r.errors.length === 1 ? '' : 's'}\n`);
  }
}

export async function validateCommand(ctx: CliContext): Promise<number> {
  const paths = ctx.args.positionals.slice(1);
  if (paths.length === 0) throw new UsageError('Usage: constans validate <file|dir|-> [...]');
  const strict = has(ctx.args, 'strict');
  const results: Checked[] = [];
  for (const file of expandFiles(ctx, paths)) results.push(check(ctx, file, await readManifest(ctx, file)));

  const failed = results.filter((r) => !r.ok || (strict && r.warnings.length > 0));
  if (ctx.json) {
    ctx.out(
      `${JSON.stringify(
        results.map(({ source: _s, plan: _p, ...r }) => r),
        null,
        2,
      )}\n`,
    );
    return failed.length > 0 ? 1 : 0;
  }
  for (const r of results) printChecked(ctx, r);
  const warnings = results.reduce((n, r) => n + r.warnings.length, 0);
  const noun = warnings === 1 ? 'warning' : 'warnings';
  const warningNote = warnings ? `, ${warnings} ${noun}` : '';
  ctx.out(`\n${results.length - failed.length}/${results.length} valid${warningNote}\n`);
  return failed.length > 0 ? 1 : 0;
}

export async function compileCommand(ctx: CliContext): Promise<number> {
  const file = ctx.args.positionals[1];
  if (!file) throw new UsageError('Usage: constans compile <file> [--out plan.json] [--json]');
  const r = check(ctx, file, await readManifest(ctx, file));
  if (!r.plan || !r.planHash) {
    for (const i of r.errors) ctx.err(`${renderIssue(ctx.style, file, r.source, i)}\n\n`);
    ctx.err(`${ctx.style.red('Compilation failed')} — ${r.errors.length} error${r.errors.length === 1 ? '' : 's'}\n`);
    return 1;
  }
  const outFile = flag(ctx.args, 'out');
  if (outFile)
    writeFileSync(resolve(ctx.cwd, outFile), `${JSON.stringify({ hash: r.planHash, plan: r.plan }, null, 2)}\n`);
  emit(ctx, { hash: r.planHash, plan: r.plan }, () => {
    const s = ctx.style;
    const plan = r.plan!;
    const rows = plan.steps.map((st) => [
      String(st.order),
      st.id,
      st.type,
      st.capability ? `${st.capability.name}@${st.capability.version}` : '—',
      st.effect ?? '—',
      st.dependsOn.join(', ') || '—',
    ]);
    const ref = s.bold(`${plan.workflow.name}@${plan.workflow.version}`);
    const written = outFile ? ` · written to ${outFile}` : '';
    return [
      `${ref}  ${s.dim(r.planHash!)}`,
      `criticality ${plan.workflow.criticality} · max cost ${plan.analysis.maxCost} · ${plan.steps.length} steps${written}`,
      '',
      table(rows, ['#', 'STEP', 'TYPE', 'CAPABILITY', 'EFFECT', 'DEPENDS ON'], s),
    ].join('\n');
  });
  return 0;
}

/**
 * `constans dev <file>` — run a workflow end to end on a throw-away, in-process platform. Nothing
 * is written outside a temporary directory, which is deleted afterwards. Ideal for authoring:
 * publish is auto-approved for the ephemeral admin, approval gates can be auto-answered.
 */
export async function devCommand(ctx: CliContext): Promise<number> {
  const file = ctx.args.positionals[1];
  if (!file)
    throw new UsageError('Usage: constans dev <file> [--input k=v] [--secret NAME=value] [--dry-run] [--auto-approve]');
  const source = await readManifest(ctx, file);
  const inputs = parseInputs(flagAll(ctx.args, 'input'));
  const secrets = parseSecrets(flagAll(ctx.args, 'secret'));
  const s = ctx.style;

  const dir = mkdtempSync(join(tmpdir(), 'constans-dev-'));
  const password = `${randomToken(12)}Aa1`;
  const config = loadConfig(
    {
      ...ctx.env,
      CONSTANS_DATA_DIR: dir,
      CONSTANS_ENV: 'development',
      CONSTANS_LOG_LEVEL: 'silent',
      CONSTANS_ADMIN_PASSWORD: password,
      CONSTANS_SEED_EXAMPLES: 'false',
      CONSTANS_POLICY_DIR: join(dir, 'no-policies'),
    },
    { cwd: ctx.cwd },
  );
  const app = createConstans(config);
  try {
    await app.start();
    const admin = {
      id: 'dev:admin',
      type: 'system' as const,
      name: 'dev',
      tenant: 'default',
      roles: ['admin' as const],
    };
    for (const [name, value] of Object.entries(secrets)) app.broker.put('default', name, value, 'dev');

    const published = app.registry.submit(admin, source);
    if (published.status !== 'published')
      throw new UsageError('Publishing was held for approval, which `dev` cannot grant. Check your policy files.');
    const wf = published.version.name;
    const note = s.dim(`published ${wf}@${published.version.version} (ephemeral)`);
    ctx.err(`${note}\n`);

    const started = Date.now();
    const trig = app.runs.trigger({
      principal: admin,
      workflow: wf,
      inputs,
      trigger: { type: 'manual', name: 'cli-dev' },
      ...(has(ctx.args, 'dry-run') ? { dryRun: true } : {}),
    });
    if (trig.status !== 'queued')
      throw new UsageError(`The run was not started (${trig.status === 'skipped' ? trig.reason : trig.status})`);
    const runId = trig.run.id;

    const off = watchApprovals(ctx, app, runId);
    const deadline = started + (Number(flag(ctx.args, 'timeout') ?? 120) || 120) * 1000;
    const printed = new Set<string>();
    let run = app.state.runs.getRun(runId)!;
    while (!DONE_STATUSES.has(run.status)) {
      if (Date.now() > deadline) {
        off();
        ctx.err(`${s.red('Timed out')} waiting for the run to finish (status ${run.status})\n`);
        return 1;
      }
      await ctx.sleep(25);
      printNewSteps(ctx, app, runId, printed);
      run = app.state.runs.getRun(runId)!;
    }
    printNewSteps(ctx, app, runId, printed);
    off();
    printDevResult(ctx, app, run, started);
    return run.status === 'succeeded' ? 0 : 1;
  } finally {
    await app.stop().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}

type DevApp = ReturnType<typeof createConstans>;

const DONE_STATUSES = new Set(['succeeded', 'failed', 'rolled-back', 'compensation-failed', 'cancelled']);

/** Answer (or announce) approval gates of the run as they are requested; returns the function that stops listening. */
function watchApprovals(ctx: CliContext, app: DevApp, runId: string): () => void {
  const s = ctx.style;
  const approver = {
    id: 'dev:approver',
    type: 'system' as const,
    name: 'dev-approver',
    tenant: 'default',
    roles: ['admin' as const],
  };
  return app.state.events.onAppend((e) => {
    if (e.runId !== runId || e.type !== 'approval.requested') return;
    const id = String((e.data as { approvalId: string }).approvalId);
    if (!has(ctx.args, 'auto-approve')) {
      ctx.err(`${s.yellow('waiting for approval')} ${id} — re-run with --auto-approve to answer approval gates\n`);
      return;
    }
    try {
      app.approvals.decide(approver, id, 'approved', 'auto-approved by constans dev');
      ctx.err(`${s.yellow('approval')} ${id} auto-approved\n`);
    } catch (error_) {
      ctx.err(`${s.red('could not auto-approve')}: ${(error_ as Error).message}\n`);
    }
  });
}

/** Print each step the first time it reaches a final status, in completion order. */
function printNewSteps(ctx: CliContext, app: DevApp, runId: string, printed: Set<string>): void {
  const s = ctx.style;
  const steps = [...app.state.runs.getSteps(runId)].sort(
    (a, b) =>
      (a.completedSeq ?? Number.MAX_SAFE_INTEGER) - (b.completedSeq ?? Number.MAX_SAFE_INTEGER) ||
      a.stepId.localeCompare(b.stepId),
  );
  for (const step of steps) {
    const key = `${step.stepId}:${step.status}`;
    if (printed.has(key) || !['succeeded', 'failed', 'skipped', 'cancelled'].includes(step.status)) continue;
    printed.add(key);
    const failure = step.error ? s.dim(`  ${step.error.message}`) : '';
    (ctx.json ? ctx.err : ctx.out)(`  ${statusColour(s, step.status).padEnd(10)} ${step.stepId}${failure}\n`);
  }
}

function printDevResult(
  ctx: CliContext,
  app: DevApp,
  run: NonNullable<ReturnType<DevApp['state']['runs']['getRun']>>,
  started: number,
): void {
  const s = ctx.style;
  if (ctx.json) {
    const steps = app.state.runs
      .getSteps(run.id)
      .map((x) => ({ id: x.stepId, status: x.status, output: x.output ?? null, error: x.error ?? null }));
    ctx.out(
      `${JSON.stringify({ status: run.status, outputs: run.outputs ?? null, error: run.error ?? null, steps }, null, 2)}\n`,
    );
    return;
  }
  const mark = run.status === 'succeeded' ? s.green('✓') : s.red('✗');
  const dry = run.dryRun ? s.dim(' (dry run)') : '';
  ctx.out(`\n${mark} ${statusColour(s, run.status)} in ${humanDuration(Date.now() - started)}${dry}\n`);
  if (run.error) ctx.out(`${s.red(run.error.code)}: ${run.error.message}\n`);
  if (run.outputs && Object.keys(run.outputs).length > 0)
    ctx.out(`${s.bold('outputs')}\n${JSON.stringify(run.outputs, null, 2)}\n`);
}

function parseSecrets(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i <= 0) throw new UsageError(`--secret expects NAME=value (got '${p.split('=')[0]}')`);
    out[p.slice(0, i)] = p.slice(i + 1);
  }
  return out;
}
