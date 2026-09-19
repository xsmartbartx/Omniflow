import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { flag, flagAll, has, intFlag, parseInputs, UsageError } from '../args.ts';
import { ApiError } from '../client.ts';
import { type CliContext, client, emit, need } from '../context.ts';
import { ago, humanDuration, renderIssue, statusColour, table } from '../format.ts';
import { expandFiles } from './local.ts';

/** Commands that talk to a running OmniFlow server over its HTTP API. */

const TERMINAL = new Set(['succeeded', 'failed', 'rolled-back', 'compensation-failed', 'cancelled']);

export async function statusCommand(ctx: CliContext): Promise<number> {
  const api = client(ctx, { needKey: false });
  const info = await api.get('/v1/info');
  const probe = await api.get('/readyz').catch((e) => ({ status: 'unavailable', error: (e as Error).message }));
  const ready = { ready: probe.status === 'ready', ...(probe.error ? { error: probe.error } : {}) };
  emit(ctx, { info, ready }, () => {
    const s = ctx.style;
    return [
      `${s.bold('OmniFlow')} ${info.version}  ${s.dim(`(${info.environment})`)}`,
      `ready: ${ready.ready ? s.green('yes') : s.red('no')}${ready.error ? s.dim(`  ${ready.error}`) : ''}`,
      ...(info.capabilities !== undefined ? [`capabilities: ${info.capabilities}`] : []),
    ].join('\n');
  });
  return ready.ready ? 0 : 1;
}

// -------------------------------------------------------------------- workflows

export async function workflowsCommand(ctx: CliContext): Promise<number> {
  const sub = ctx.args.positionals[1] ?? 'list';
  const api = client(ctx);
  const s = ctx.style;

  if (sub === 'list') {
    const { items } = await api.get('/v1/workflows');
    emit(ctx, items, () => {
      if (items.length === 0) return 'No workflows yet. Publish one with: omniflow publish <file>';
      return table(
        items.map((w: any) => [
          w.name,
          w.stableVersion ?? '—',
          w.killed ? s.red('killed') : w.enabled ? s.green('enabled') : s.yellow('disabled'),
          w.criticality ?? '—',
          `${w.recent.succeeded}/${w.recent.total} ok`,
          w.lastRun ? `${statusColour(s, w.lastRun.status)} ${s.dim(ago(w.lastRun.createdAt))}` : '—',
        ]),
        ['NAME', 'VERSION', 'STATE', 'CRITICALITY', 'RECENT', 'LAST RUN'],
        s,
      );
    });
    return 0;
  }

  const name = need(ctx, 2, 'workflow');
  if (sub === 'show') {
    const w = await api.get(`/v1/workflows/${encodeURIComponent(name)}`);
    emit(ctx, w, () =>
      [
        `${s.bold(w.name)}  ${w.settings.killed ? s.red('KILLED') : w.settings.enabled ? s.green('enabled') : s.yellow('disabled')}  autonomy ${w.settings.autonomyTier}`,
        w.plan?.workflow.description ? w.plan.workflow.description : '',
        `stable ${w.settings.stableVersion ?? '—'}${w.settings.canaryVersion ? `  canary ${w.settings.canaryVersion} (${w.settings.canaryPercent}%)` : ''}`,
        '',
        s.bold('Versions'),
        table(
          w.versions.map((v: any) => [
            v.version,
            v.status,
            v.publishedBy ?? '—',
            ago(v.publishedAt),
            String(v.planHash).slice(0, 19),
          ]),
          ['VERSION', 'STATUS', 'PUBLISHED BY', 'WHEN', 'PLAN'],
          s,
        ),
        ...(w.recentRuns.length ? ['', s.bold('Recent runs'), runsTable(ctx, w.recentRuns)] : []),
        ...(w.pendingChanges.length
          ? ['', s.yellow(`${w.pendingChanges.length} change request(s) awaiting approval`)]
          : []),
      ]
        .filter((x) => x !== '')
        .join('\n'),
    );
    return 0;
  }

  if (sub === 'graph') {
    const g = await api.get(
      `/v1/workflows/${encodeURIComponent(name)}/graph${flag(ctx.args, 'version') ? `?version=${encodeURIComponent(flag(ctx.args, 'version')!)}` : ''}`,
    );
    emit(ctx, g, () =>
      [
        `flowchart TD`,
        ...g.nodes.map((n: any) => `  ${n.id}["${n.id}${n.capability ? `<br/>${n.capability}` : ''}"]`),
        ...g.edges.map((e: any) => `  ${e.from} ${e.conditional ? '-.->' : '-->'} ${e.to}`),
        ...g.routes.map((r: any) => `  ${r.from} -. on error .-> ${r.to}`),
      ].join('\n'),
    );
    return 0;
  }

  // Rollout & control operations.
  const ops: Record<string, () => unknown> = {
    activate: () => ({ version: need(ctx, 3, 'version') }),
    canary: () => ({ version: need(ctx, 3, 'version'), percent: Number(need(ctx, 4, 'percent')) }),
    promote: () => ({}),
    'rollback-canary': () => ({}),
    deprecate: () => ({ version: need(ctx, 3, 'version') }),
    enable: () => ({}),
    disable: () => ({}),
    kill: () => ({ reason: flag(ctx.args, 'reason') ?? need(ctx, 3, 'reason') }),
    revive: () => ({}),
    autonomy: () => ({ tier: need(ctx, 3, 'tier') }),
  };
  const body = ops[sub];
  if (!body)
    throw new UsageError(
      `Unknown workflows subcommand '${sub}'. Try: list, show, graph, ${Object.keys(ops).join(', ')}`,
    );
  await api.post(`/v1/workflows/${encodeURIComponent(name)}/${sub}`, body());
  ctx.out(ctx.json ? `${JSON.stringify({ ok: true })}\n` : `${s.green('✓')} ${sub} ${name}\n`);
  return 0;
}

export async function publishCommand(ctx: CliContext): Promise<number> {
  const paths = ctx.args.positionals.slice(1);
  if (paths.length === 0) throw new UsageError('Usage: omniflow publish <file|dir> [--canary <percent>]');
  const api = client(ctx);
  const s = ctx.style;
  const canaryPercent = intFlag(ctx.args, 'canary');
  let failures = 0;
  const results: unknown[] = [];
  for (const file of expandFiles(ctx, paths)) {
    const manifest = file === '-' ? await ctx.readStdin() : readFileSync(resolve(ctx.cwd, file), 'utf8');
    try {
      const r = await api.post('/v1/workflows', { manifest, ...(canaryPercent ? { canaryPercent } : {}) });
      results.push({ file, ...r });
      if (!ctx.json) {
        if (r.status === 'published')
          ctx.out(
            `${s.green('✓')} published ${s.bold(`${r.version.name}@${r.version.version}`)}  risk ${r.risk.level} (${r.risk.score})\n`,
          );
        else
          ctx.out(
            `${s.yellow('…')} ${s.bold(`${r.change.workflowName}@${r.change.version}`)} needs approval (${r.decision.reason}) — change ${r.change.id}\n`,
          );
      }
    } catch (e) {
      if (!(e instanceof ApiError) || e.status >= 500) throw e;
      failures++;
      results.push({ file, error: { code: e.code, message: e.message, details: e.details } });
      if (!ctx.json) {
        const issues = (e.details as { issues?: any[] } | undefined)?.issues;
        if (issues?.length) for (const i of issues) ctx.err(`${renderIssue(s, file, manifest, i)}\n\n`);
        ctx.err(`${s.red('✗')} ${file}: ${e.message}\n`);
      }
    }
  }
  if (ctx.json) ctx.out(`${JSON.stringify(results, null, 2)}\n`);
  return failures > 0 ? 1 : 0;
}

export async function runCommand(ctx: CliContext): Promise<number> {
  const name = need(ctx, 1, 'workflow');
  const api = client(ctx);
  const s = ctx.style;
  let inputs: Record<string, unknown> = {};
  const inputFile = flag(ctx.args, 'input-file');
  if (inputFile) {
    try {
      inputs = JSON.parse(
        inputFile === '-' ? await ctx.readStdin() : readFileSync(resolve(ctx.cwd, inputFile), 'utf8'),
      );
    } catch (e) {
      throw new UsageError(`--input-file must contain a JSON object: ${(e as Error).message}`);
    }
  }
  inputs = { ...inputs, ...parseInputs(flagAll(ctx.args, 'input')) };
  const r = await api.post(`/v1/workflows/${encodeURIComponent(name)}/run`, {
    inputs,
    ...(flag(ctx.args, 'version') ? { version: flag(ctx.args, 'version') } : {}),
    ...(has(ctx.args, 'dry-run') ? { dryRun: true } : {}),
    ...(flag(ctx.args, 'correlation-id') ? { correlationId: flag(ctx.args, 'correlation-id') } : {}),
  });
  if (r.status === 'skipped') {
    ctx.out(ctx.json ? `${JSON.stringify(r)}\n` : `${s.yellow('skipped')}: ${r.reason}\n`);
    return 0;
  }
  if (!has(ctx.args, 'wait') && !has(ctx.args, 'follow')) {
    ctx.out(
      ctx.json
        ? `${JSON.stringify(r)}\n`
        : `${s.green('✓')} ${r.status} run ${s.bold(r.run.id)}\n  follow it with: omniflow runs tail ${r.run.id}\n`,
    );
    return 0;
  }
  return tail(ctx, r.run.id);
}

// ------------------------------------------------------------------------ runs

function runsTable(ctx: CliContext, items: any[]): string {
  const s = ctx.style;
  return table(
    items.map((r) => [
      r.id,
      r.workflow,
      r.version,
      statusColour(s, r.status),
      r.trigger.type,
      humanDuration(r.durationMs),
      ago(r.createdAt),
    ]),
    ['RUN', 'WORKFLOW', 'VERSION', 'STATUS', 'TRIGGER', 'TOOK', 'STARTED'],
    s,
  );
}

export async function runsCommand(ctx: CliContext): Promise<number> {
  const sub = ctx.args.positionals[1] ?? 'list';
  const api = client(ctx);
  const s = ctx.style;

  if (sub === 'list') {
    const q = new URLSearchParams();
    for (const [f, p] of [
      ['workflow', 'workflow'],
      ['status', 'status'],
      ['limit', 'limit'],
    ] as const)
      if (flag(ctx.args, f)) q.set(p, flag(ctx.args, f)!);
    const r = await api.get(`/v1/runs${q.size ? `?${q}` : ''}`);
    emit(ctx, r, () =>
      r.items.length === 0 ? 'No runs.' : `${runsTable(ctx, r.items)}\n${s.dim(`${r.items.length} of ${r.total}`)}`,
    );
    return 0;
  }

  const id = need(ctx, 2, 'run id');
  if (sub === 'show') {
    const r = await api.get(`/v1/runs/${encodeURIComponent(id)}`);
    emit(ctx, r, () => {
      const run = r.run;
      return [
        `${s.bold(run.workflow)}@${run.version}  ${statusColour(s, run.status)}${run.dryRun ? s.dim(' (dry run)') : ''}  ${s.dim(run.id)}`,
        `started ${ago(run.startedAt ?? run.createdAt)} · took ${humanDuration(run.durationMs)} · cost ${run.cost} · plan ${s.dim(String(run.planHash).slice(0, 19))}`,
        ...(run.error ? [`${s.red(run.error.code)}: ${run.error.message}`] : []),
        '',
        table(
          r.steps.map((st: any) => [
            st.id,
            st.capability ?? st.type,
            statusColour(s, st.status),
            st.attempt > 1 ? `${st.attempt}/${st.maxAttempts}` : '',
            humanDuration(st.durationMs),
            st.error ? s.dim(String(st.error.message).slice(0, 60)) : st.skippedReason ? s.dim(st.skippedReason) : '',
          ]),
          ['STEP', 'CAPABILITY', 'STATUS', 'TRY', 'TOOK', 'NOTE'],
          s,
        ),
        ...(run.outputs && Object.keys(run.outputs).length
          ? ['', s.bold('outputs'), JSON.stringify(run.outputs, null, 2)]
          : []),
        ...(r.approvals.some((a: any) => a.status === 'pending')
          ? [
              '',
              s.yellow(
                `Waiting for approval: omniflow approvals approve ${r.approvals.find((a: any) => a.status === 'pending').id}`,
              ),
            ]
          : []),
      ].join('\n');
    });
    return 0;
  }
  if (sub === 'events') {
    const r = await api.get(`/v1/runs/${encodeURIComponent(id)}/events`);
    emit(ctx, r, () =>
      r.items
        .map((e: any) => `${String(e.seq).padStart(6)}  ${e.ts}  ${e.type}${e.stepId ? s.dim(`  ${e.stepId}`) : ''}`)
        .join('\n'),
    );
    return 0;
  }
  if (sub === 'output') {
    const step = need(ctx, 3, 'step id');
    const r = await api.get(`/v1/runs/${encodeURIComponent(id)}/steps/${encodeURIComponent(step)}/output`);
    ctx.out(`${JSON.stringify(r.output, null, 2)}\n`);
    return 0;
  }
  if (sub === 'tail' || sub === 'watch') return tail(ctx, id);
  if (sub === 'cancel') {
    await api.post(
      `/v1/runs/${encodeURIComponent(id)}/cancel`,
      flag(ctx.args, 'reason') ? { reason: flag(ctx.args, 'reason') } : {},
    );
    ctx.out(`${s.green('✓')} cancellation requested for ${id}\n`);
    return 0;
  }
  if (sub === 'retry') {
    const r = await api.post(`/v1/runs/${encodeURIComponent(id)}/retry`);
    ctx.out(
      ctx.json
        ? `${JSON.stringify(r)}\n`
        : r.status === 'skipped'
          ? `${s.yellow('skipped')}: ${r.reason}\n`
          : `${s.green('✓')} new run ${s.bold(r.run.id)}\n`,
    );
    return 0;
  }
  throw new UsageError(`Unknown runs subcommand '${sub}'. Try: list, show, tail, events, output, cancel, retry`);
}

/** Follow a run's live event stream until it finishes; exit 0 only if it succeeded. */
async function tail(ctx: CliContext, runId: string): Promise<number> {
  const api = client(ctx);
  const s = ctx.style;
  const line = (e: { type: string; ts: string; stepId?: string; data?: Record<string, unknown> }) => {
    const step = e.stepId ? s.cyan(e.stepId.padEnd(18)) : ' '.repeat(18);
    const detail = describeEvent(e);
    return `${s.dim(e.ts.slice(11, 23))}  ${step} ${e.type}${detail ? s.dim(`  ${detail}`) : ''}`;
  };
  await api.stream(`/v1/runs/${encodeURIComponent(runId)}/stream`, ({ data }) => {
    ctx.out(ctx.json ? `${JSON.stringify(data)}\n` : `${line(data)}\n`);
  });
  const { run } = await api.get(`/v1/runs/${encodeURIComponent(runId)}`);
  if (!ctx.json)
    ctx.out(
      `\n${run.status === 'succeeded' ? s.green('✓') : TERMINAL.has(run.status) ? s.red('✗') : s.yellow('…')} ${statusColour(s, run.status)}${run.error ? `  ${run.error.message}` : ''}\n`,
    );
  return run.status === 'succeeded' ? 0 : 1;
}

function describeEvent(e: { data?: Record<string, unknown> }): string {
  const d = e.data ?? {};
  const parts: string[] = [];
  for (const k of ['attempt', 'reason', 'errorCode', 'message', 'decision', 'capability'])
    if (d[k] !== undefined) parts.push(`${k}=${typeof d[k] === 'object' ? JSON.stringify(d[k]) : d[k]}`);
  return parts.join(' ').slice(0, 100);
}

// ------------------------------------------------------- approvals and changes

export async function approvalsCommand(ctx: CliContext): Promise<number> {
  const sub = ctx.args.positionals[1] ?? 'list';
  const api = client(ctx);
  const s = ctx.style;
  if (sub === 'list') {
    const r = await api.get(`/v1/approvals?status=${flag(ctx.args, 'status') ?? 'pending'}`);
    emit(ctx, r.items, () =>
      r.items.length === 0
        ? 'Nothing waiting for approval.'
        : table(
            r.items.map((a: any) => [
              a.id,
              a.workflowName ?? '—',
              a.stepId ?? '—',
              a.status,
              a.requestedByName ?? a.requestedBy ?? '—',
              a.canDecide ? s.green('you can decide') : '',
            ]),
            ['APPROVAL', 'WORKFLOW', 'STEP', 'STATUS', 'REQUESTED BY', ''],
            s,
          ),
    );
    return 0;
  }
  if (sub === 'approve' || sub === 'deny') {
    const id = need(ctx, 2, 'approval id');
    await api.post(`/v1/approvals/${encodeURIComponent(id)}/decide`, {
      decision: sub === 'approve' ? 'approved' : 'denied',
      ...(flag(ctx.args, 'comment') ? { comment: flag(ctx.args, 'comment') } : {}),
    });
    ctx.out(`${s.green('✓')} ${sub === 'approve' ? 'approved' : 'denied'} ${id}\n`);
    return 0;
  }
  throw new UsageError(`Unknown approvals subcommand '${sub}'. Try: list, approve, deny`);
}

export async function changesCommand(ctx: CliContext): Promise<number> {
  const sub = ctx.args.positionals[1] ?? 'list';
  const api = client(ctx);
  const s = ctx.style;
  if (sub === 'list') {
    const r = await api.get(`/v1/changes?status=${flag(ctx.args, 'status') ?? 'pending'}`);
    emit(ctx, r.items, () =>
      r.items.length === 0
        ? 'No change requests.'
        : table(
            r.items.map((c: any) => [
              c.id,
              `${c.workflowName}@${c.version}`,
              c.status,
              `${c.approvals?.length ?? 0}/${c.requiredApprovals}`,
              c.requestedByName,
              c.risk?.level ?? '—',
            ]),
            ['CHANGE', 'WORKFLOW', 'STATUS', 'APPROVALS', 'REQUESTED BY', 'RISK'],
            s,
          ),
    );
    return 0;
  }
  const id = need(ctx, 2, 'change id');
  if (sub === 'show') {
    const c = await api.get(`/v1/changes/${encodeURIComponent(id)}`);
    if (has(ctx.args, 'manifest')) ctx.out(c.manifestText);
    else
      emit(
        ctx,
        c,
        () =>
          `${s.bold(`${c.workflowName}@${c.version}`)}  ${c.status}\n${c.reason}\nrisk ${c.risk?.level} (${c.risk?.score})\n${(c.risk?.findings ?? []).map((f: any) => `  - [${f.severity}] ${f.message}`).join('\n')}`,
      );
    return 0;
  }
  if (sub === 'approve' || sub === 'reject') {
    const r = await api.post(
      `/v1/changes/${encodeURIComponent(id)}/${sub}`,
      flag(ctx.args, 'comment') ? { comment: flag(ctx.args, 'comment') } : {},
    );
    ctx.out(
      ctx.json
        ? `${JSON.stringify(r)}\n`
        : `${s.green('✓')} ${sub}d ${id}${r.published ? ` — published ${r.published.name}@${r.published.version}` : ''}\n`,
    );
    return 0;
  }
  if (sub === 'withdraw') {
    await api.post(`/v1/changes/${encodeURIComponent(id)}/withdraw`);
    ctx.out(`${s.green('✓')} withdrawn ${id}\n`);
    return 0;
  }
  throw new UsageError(`Unknown changes subcommand '${sub}'. Try: list, show, approve, reject, withdraw`);
}

// ------------------------------------------------------------------ the rest

export async function capabilitiesCommand(ctx: CliContext): Promise<number> {
  const api = client(ctx);
  const { items } = await api.get('/v1/capabilities');
  emit(ctx, items, () =>
    table(
      items.map((c: any) => [
        `${c.name}@${c.version}`,
        c.effect,
        c.killed ? ctx.style.red('killed') : c.circuit === 'open' ? ctx.style.yellow('circuit open') : 'ok',
        c.description ?? '',
      ]),
      ['CAPABILITY', 'EFFECT', 'STATE', 'DESCRIPTION'],
      ctx.style,
    ),
  );
  return 0;
}

export async function secretsCommand(ctx: CliContext): Promise<number> {
  const sub = ctx.args.positionals[1] ?? 'list';
  const api = client(ctx);
  const s = ctx.style;
  if (sub === 'list') {
    const { items } = await api.get('/v1/secrets');
    emit(ctx, items, () =>
      items.length === 0
        ? 'No secrets.'
        : table(
            items.map((x: any) => [x.name, x.description ?? '', ago(x.updatedAt)]),
            ['NAME', 'DESCRIPTION', 'UPDATED'],
            s,
          ),
    );
    return 0;
  }
  const name = need(ctx, 2, 'name');
  if (sub === 'set') {
    // The value is read from stdin (or an interactive-free env var) so it never appears in shell history or `ps`.
    const value = (has(ctx.args, 'stdin') ? await ctx.readStdin() : ctx.env.OMNIFLOW_SECRET_VALUE)?.replace(
      /\r?\n$/,
      '',
    );
    if (!value)
      throw new UsageError(
        'Provide the value on stdin: echo -n "$VALUE" | omniflow secrets set NAME --stdin  (or set OMNIFLOW_SECRET_VALUE)',
      );
    await api.put(`/v1/secrets/${encodeURIComponent(name)}`, {
      value,
      ...(flag(ctx.args, 'description') ? { description: flag(ctx.args, 'description') } : {}),
    });
    ctx.out(`${s.green('✓')} stored ${name}\n`);
    return 0;
  }
  if (sub === 'delete') {
    await api.del(`/v1/secrets/${encodeURIComponent(name)}`);
    ctx.out(`${s.green('✓')} deleted ${name}\n`);
    return 0;
  }
  throw new UsageError(`Unknown secrets subcommand '${sub}'. Try: list, set, delete`);
}

export async function auditCommand(ctx: CliContext): Promise<number> {
  const sub = ctx.args.positionals[1] ?? 'verify';
  const api = client(ctx);
  const s = ctx.style;
  if (sub === 'verify') {
    const r = await api.get('/v1/audit/verify');
    emit(ctx, r, () =>
      r.ok
        ? `${s.green('✓')} audit log intact — ${r.checked} events verified`
        : `${s.red('✗')} audit log TAMPERED at event ${r.brokenAtSeq}: ${r.reason ?? 'hash mismatch'}`,
    );
    return r.ok ? 0 : 1;
  }
  if (sub === 'export') {
    const out = flag(ctx.args, 'out');
    const res = await fetch(
      `${flag(ctx.args, 'url') ?? ctx.env.OMNIFLOW_URL ?? 'http://127.0.0.1:8080'}/v1/audit/export`,
      { headers: { authorization: `Bearer ${flag(ctx.args, 'key') ?? ctx.env.OMNIFLOW_API_KEY ?? ''}` } },
    );
    if (!res.ok) throw new ApiError(res.status, `HTTP_${res.status}`, `Export failed (HTTP ${res.status})`);
    const text = await res.text();
    if (out) {
      writeFileSync(resolve(ctx.cwd, out), text);
      ctx.out(`${s.green('✓')} wrote ${text.split('\n').filter(Boolean).length} events to ${out}\n`);
    } else ctx.out(text);
    return 0;
  }
  throw new UsageError(`Unknown audit subcommand '${sub}'. Try: verify, export`);
}

// -------------------------------------------------------------------- insight

export async function insightsCommand(ctx: CliContext): Promise<number> {
  const api = client(ctx);
  const s = ctx.style;
  const hours = intFlag(ctx.args, 'hours') ?? 24;
  const o = await api.get(`/v1/insights/overview?hours=${hours}`);
  emit(ctx, o, () => {
    const rate = (r: number | null) => (r === null ? '—' : `${Math.round(r * 100)}%`);
    return [
      s.bold(`Last ${o.window.hours}h`),
      `runs ${o.runs.total} · succeeded ${s.green(String(o.runs.succeeded))} · failed ${o.runs.failed ? s.red(String(o.runs.failed)) : '0'} · success rate ${rate(o.runs.successRate)}`,
      `active ${o.runs.active} · queued ${o.runs.queued} · approvals pending ${o.approvals.pending} · manual intervention ${rate(o.manualInterventionRate)}`,
      `latency p50 ${humanDuration(o.latencyMs.p50)} · p95 ${humanDuration(o.latencyMs.p95)} · cost ${o.cost.total}`,
      ...(o.workflows.length
        ? [
            '',
            table(
              o.workflows.map((w: any) => [
                w.name,
                String(w.runs),
                String(w.failed),
                rate(w.successRate),
                humanDuration(w.p95Ms),
                String(w.cost),
              ]),
              ['WORKFLOW', 'RUNS', 'FAILED', 'SUCCESS', 'P95', 'COST'],
              s,
            ),
          ]
        : []),
      ...(o.failingSteps.length
        ? [
            '',
            s.bold('Failing steps'),
            table(
              o.failingSteps.map((f: any) => [
                `${f.workflow} › ${f.stepId}`,
                `${f.failed}/${f.executions}`,
                f.topError ?? '',
              ]),
              ['STEP', 'FAILED', 'MOST OFTEN'],
              s,
            ),
          ]
        : []),
    ].join('\n');
  });
  return 0;
}

export async function alertsCommand(ctx: CliContext): Promise<number> {
  const api = client(ctx);
  const s = ctx.style;
  const r = await api.get('/v1/insights/alerts');
  emit(ctx, r, () =>
    r.active.length === 0
      ? `${s.green('✓')} No open alerts.`
      : r.active
          .map(
            (a: any) =>
              `${a.severity === 'critical' ? s.red('CRITICAL') : s.yellow('WARNING')}  ${s.bold(a.title)}  ${s.dim(ago(a.raisedAt))}\n  ${a.message}`,
          )
          .join('\n\n'),
  );
  return r.active.some((a: any) => a.severity === 'critical') ? 1 : 0;
}

export async function analyzeCommand(ctx: CliContext): Promise<number> {
  const r = await client(ctx).post('/v1/insights/analyze');
  emit(
    ctx,
    r,
    () =>
      `${ctx.style.green('✓')} analysis complete: ${r.findings} finding(s), ${r.raised} new proposal(s), ${r.suppressed} already known, ${r.resolved} resolved`,
  );
  return 0;
}

export async function proposalsCommand(ctx: CliContext): Promise<number> {
  const sub = ctx.args.positionals[1] ?? 'list';
  const api = client(ctx);
  const s = ctx.style;
  if (sub === 'list') {
    const r = await api.get(`/v1/proposals?status=${flag(ctx.args, 'status') ?? 'open'}`);
    emit(ctx, r.items, () =>
      r.items.length === 0
        ? 'No proposals.'
        : table(
            r.items.map((p: any) => [p.id, p.body?.severity ?? '', p.workflowName ?? '—', p.title]),
            ['PROPOSAL', 'SEVERITY', 'WORKFLOW', 'TITLE'],
            s,
          ),
    );
    return 0;
  }
  const id = need(ctx, 2, 'proposal id');
  if (sub === 'show') {
    const p = await api.get(`/v1/proposals/${encodeURIComponent(id)}`);
    emit(ctx, p, () =>
      [
        s.bold(p.title),
        '',
        p.body?.summary ?? '',
        '',
        `${s.bold('Recommendation:')} ${p.body?.recommendation ?? ''}`,
        '',
        s.dim(JSON.stringify(p.body?.evidence ?? {}, null, 2)),
      ].join('\n'),
    );
    return 0;
  }
  if (sub === 'accept' || sub === 'dismiss') {
    await api.post(`/v1/proposals/${encodeURIComponent(id)}/decide`, {
      status: sub === 'accept' ? 'accepted' : 'dismissed',
    });
    ctx.out(`${s.green('✓')} ${sub === 'accept' ? 'accepted' : 'dismissed'} ${id}\n`);
    return 0;
  }
  throw new UsageError(`Unknown proposals subcommand '${sub}'. Try: list, show, accept, dismiss`);
}
