import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { UsageError, flag, has } from '../args.ts';
import { type CliContext, client, emit, need } from '../context.ts';
import { ago, table } from '../format.ts';

/** Drafts, AI authoring, importers, explanations and generated docs. */

function summarise(ctx: CliContext, draft: any): string[] {
  const s = ctx.style;
  const v = draft.validation ?? {};
  const lines = [`${v.ok ? s.green('✓ valid') : s.red('✗ not valid yet')}${v.risk ? `  risk ${v.risk.level} (${v.risk.score})` : ''}  ${s.dim(draft.id)}`];
  for (const e of (v.errors ?? []).slice(0, 8)) lines.push(`  ${s.red('error')}${s.dim(`[${e.code}]`)} ${e.path ? `${e.path}: ` : ''}${e.message}`);
  for (const f of (v.risk?.findings ?? []).filter((x: any) => x.blocking)) lines.push(`  ${s.red('blocking')}${s.dim(`[${f.ruleId}]`)} ${f.message}`);
  return lines;
}

const outFile = (ctx: CliContext, text: string): boolean => {
  const out = flag(ctx.args, 'out');
  if (!out) return false;
  writeFileSync(resolve(ctx.cwd, out), text.endsWith('\n') ? text : `${text}\n`);
  ctx.out(`${ctx.style.green('✓')} wrote ${out}\n`);
  return true;
};

export async function planCommand(ctx: CliContext): Promise<number> {
  const intent = ctx.args.positionals.slice(1).join(' ').trim();
  if (!intent) throw new UsageError('Usage: omniflow plan "<what you want>" [--workflow <name>] [--out draft.yaml]');
  const s = ctx.style;
  const r = await client(ctx).post('/v1/authoring/plan', { intent, ...(flag(ctx.args, 'workflow') ? { workflow: flag(ctx.args, 'workflow') } : {}) });
  emit(ctx, r, () => {
    const out: string[] = [];
    if (r.plan.rationale) out.push(s.bold('Rationale'), r.plan.rationale, '');
    if (r.plan.openQuestions?.length) out.push(s.bold('Open questions'), ...r.plan.openQuestions.map((q: string) => `  - ${q}`), '');
    if (r.plan.injectionSignals?.length) out.push(s.yellow(`Warning: ${r.plan.injectionSignals.length} prompt-injection signal(s) in the supplied material. Review the draft with extra care.`), '');
    if (r.mode === 'proposal-only') out.push(s.yellow('This workflow is at autonomy tier T0 (advisory): nothing was saved.'), '', r.plan.manifest ?? '');
    else if (r.draft) out.push(...summarise(ctx, r.draft), '', `Review it with: omniflow drafts show ${r.draft.id}   ·   publish with: omniflow drafts submit ${r.draft.id}`);
    else out.push(s.red('The model did not produce a usable manifest.'));
    return out.join('\n');
  });
  const manifest = r.draft ? (await client(ctx).get(`/v1/drafts/${r.draft.id}`)).manifestText : r.plan.manifest;
  if (manifest && !ctx.json) outFile(ctx, manifest);
  return r.plan.ok ? 0 : 1;
}

export async function draftsCommand(ctx: CliContext): Promise<number> {
  const sub = ctx.args.positionals[1] ?? 'list';
  const api = client(ctx);
  const s = ctx.style;
  if (sub === 'list') {
    const r = await api.get(`/v1/drafts${flag(ctx.args, 'status') ? `?status=${flag(ctx.args, 'status')}` : ''}`);
    emit(ctx, r.items, () =>
      r.items.length === 0
        ? 'No drafts.'
        : table(r.items.map((d: any) => [d.id, d.workflowName ?? '—', d.origin, d.status, d.validation?.ok ? s.green('valid') : s.red('invalid'), ago(d.updatedAt)]), ['DRAFT', 'WORKFLOW', 'ORIGIN', 'STATUS', 'VALIDATION', 'UPDATED'], s),
    );
    return 0;
  }
  if (sub === 'create') {
    const file = need(ctx, 2, 'manifest file');
    const manifest = file === '-' ? await ctx.readStdin() : readFileSync(resolve(ctx.cwd, file), 'utf8');
    const d = await api.post('/v1/drafts', { manifest });
    emit(ctx, d, () => summarise(ctx, d).join('\n'));
    return d.validation?.ok ? 0 : 1;
  }
  const id = need(ctx, 2, 'draft id');
  const path = `/v1/drafts/${encodeURIComponent(id)}`;
  switch (sub) {
    case 'show': {
      const d = await api.get(path);
      if (has(ctx.args, 'manifest') && !ctx.json) {
        if (!outFile(ctx, d.manifestText)) ctx.out(d.manifestText);
      } else emit(ctx, d, () => [`${s.bold(d.workflowName ?? '(unnamed)')}  ${d.origin} · ${d.status}`, ...summarise(ctx, d), ...(d.notes?.rationale ? ['', d.notes.rationale] : []), ...((d.notes?.openQuestions ?? []).map((q: string) => `  ? ${q}`)), '', d.manifestText].join('\n'));
      return 0;
    }
    case 'validate': {
      const d = await api.post(`${path}/validate`);
      emit(ctx, d, () => summarise(ctx, d).join('\n'));
      return d.validation?.ok ? 0 : 1;
    }
    case 'submit': {
      const r = await api.post(`${path}/submit`, has(ctx.args, 'canary') ? { canaryPercent: Number(flag(ctx.args, 'canary')) } : {});
      emit(ctx, r, () => (r.status === 'published' ? `${s.green('✓')} published ${s.bold(`${r.version.name}@${r.version.version}`)}` : `${s.yellow('…')} needs approval (${r.decision.reason}) — change ${r.change.id}`));
      return 0;
    }
    case 'apply': {
      const r = await api.post(`${path}/apply`);
      emit(ctx, r, () => (r.applied ? `${s.green('✓')} tier ${r.tier}: ${r.status === 'published' ? `published ${r.version}` : `change request ${r.changeId} opened for approval`}\n  ${r.verdict.reason}` : `${s.yellow('—')} tier ${r.tier}: nothing applied. ${r.verdict.reason}`));
      return 0;
    }
    case 'delete': {
      await api.del(path);
      ctx.out(`${s.green('✓')} deleted ${id}\n`);
      return 0;
    }
    default:
      throw new UsageError(`Unknown drafts subcommand '${sub}'. Try: list, create, show, validate, submit, apply, delete`);
  }
}

export async function importCommand(ctx: CliContext): Promise<number> {
  const kind = ctx.args.positionals[1];
  const file = ctx.args.positionals[2];
  if ((kind !== 'crontab' && kind !== 'script') || !file) throw new UsageError('Usage: omniflow import crontab <file|-> [--owner e] [--timezone tz] [--out-dir dir]\n       omniflow import script <file> [--name n]');
  const s = ctx.style;
  const api = client(ctx);
  const text = file === '-' ? await ctx.readStdin() : readFileSync(resolve(ctx.cwd, file), 'utf8');

  if (kind === 'script') {
    const r = await api.post('/v1/import/script', { script: text, ...(flag(ctx.args, 'name') ? { name: flag(ctx.args, 'name') } : {}) });
    emit(ctx, r, () => [r.plan.rationale ?? '', ...(r.plan.openQuestions ?? []).map((q: string) => `  ? ${q}`), ...(r.draft ? summarise(ctx, r.draft) : [s.red('No usable draft was produced.')])].join('\n'));
    return r.plan.ok ? 0 : 1;
  }

  const r = await api.post('/v1/import/crontab', { text, ...(flag(ctx.args, 'owner') ? { owner: flag(ctx.args, 'owner') } : {}), ...(flag(ctx.args, 'timezone') ? { timezone: flag(ctx.args, 'timezone') } : {}) });
  const dir = flag(ctx.args, 'out-dir');
  if (dir) {
    mkdirSync(resolve(ctx.cwd, dir), { recursive: true });
    for (const d of r.drafts) {
      const full = await api.get(`/v1/drafts/${d.draft.id}`);
      writeFileSync(join(resolve(ctx.cwd, dir), `${d.draft.workflowName}.yaml`), full.manifestText);
      if (d.script) writeFileSync(join(resolve(ctx.cwd, dir), `${d.draft.workflowName}.sh`), d.script.content, { mode: 0o644 });
    }
  }
  emit(ctx, r, () => {
    const out = r.drafts.map((d: any) => `${s.bold(d.draft.workflowName ?? '?')}  ${d.draft.validation?.ok ? s.green('valid') : s.red('invalid')}  ${s.dim(`line ${d.line}`)}  ${s.dim(d.draft.id)}\n${d.notes.map((n: string) => `    - ${n}`).join('\n')}`);
    for (const k of r.skipped) out.push(`${s.yellow('skipped')} line ${k.line}: ${k.reason}`);
    if (dir) out.push('', `${s.green('✓')} wrote manifests${r.drafts.some((d: any) => d.script) ? ' and suggested scripts' : ''} to ${dir}`);
    return out.join('\n');
  });
  return 0;
}

export async function explainCommand(ctx: CliContext): Promise<number> {
  const kind = ctx.args.positionals[1];
  const target = ctx.args.positionals[2];
  if ((kind !== 'workflow' && kind !== 'run') || !target) throw new UsageError('Usage: omniflow explain workflow <name> [--version v]\n       omniflow explain run <run-id>');
  const api = client(ctx);
  if (kind === 'workflow') {
    const e = await api.get(`/v1/workflows/${encodeURIComponent(target)}/explain${flag(ctx.args, 'version') ? `?version=${encodeURIComponent(flag(ctx.args, 'version')!)}` : ''}`);
    emit(ctx, e, () => e.markdown);
  } else {
    const e = await api.get(`/v1/runs/${encodeURIComponent(target)}/explain`);
    emit(ctx, e, () => e.markdown);
  }
  return 0;
}

export async function docsCommand(ctx: CliContext): Promise<number> {
  const kind = ctx.args.positionals[1];
  const api = client(ctx);
  let text: string;
  if (kind === 'capabilities') text = await api.getText('/v1/docs/capabilities');
  else if (kind === 'index') text = await api.getText('/v1/docs/workflows');
  else if (kind === 'workflow' && ctx.args.positionals[2]) {
    const format = flag(ctx.args, 'format') ?? 'markdown';
    if (format !== 'markdown' && format !== 'mermaid') throw new UsageError('--format must be markdown or mermaid');
    const q = new URLSearchParams({ format });
    if (flag(ctx.args, 'version')) q.set('version', flag(ctx.args, 'version')!);
    text = await api.getText(`/v1/workflows/${encodeURIComponent(ctx.args.positionals[2])}/docs?${q}`);
  } else throw new UsageError('Usage: omniflow docs workflow <name> [--format markdown|mermaid] [--out file]\n       omniflow docs capabilities|index [--out file]');
  if (!outFile(ctx, text)) ctx.out(text.endsWith('\n') ? text : `${text}\n`);
  return 0;
}

