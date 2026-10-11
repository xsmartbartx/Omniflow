import type { CapabilityDeclaration, Plan, PlanStep } from '../../schemas/index.ts';
import { describeCron } from '../agents/explainer.ts';

type Trigger = Plan['triggers'][number];

/** The second line of a diagram node: what the step is. */
const stepKind = (s: PlanStep): string => {
  if (s.type === 'capability' && s.capability) return `${s.capability.name}`;
  switch (s.type) {
    case 'approval':
      return 'approval';
    case 'map':
      return `for each · ${s.capability?.name ?? ''}`;
    case 'wait':
      return s.until ? `wait · ${s.until.event}` : 'wait';
    case 'subworkflow':
      return `runs ${s.workflow}`;
    default:
      return s.type;
  }
};

/** Mermaid node syntax for a step: the shape tells you what kind of step it is. */
const nodeLine = (type: string, id: string, l: string): string => {
  switch (type) {
    case 'branch':
      return `  ${id}{"${l}"}`;
    case 'approval':
      return `  ${id}[["${l}"]]`;
    case 'parallel':
      return `  ${id}(("${l}"))`;
    case 'terminate':
      return `  ${id}(["${l}"])`;
    default:
      return `  ${id}["${l}"]`;
  }
};

const triggerLine = (t: Trigger): string => {
  switch (t.type) {
    case 'schedule':
      return `- **schedule** — ${describeCron(t.cron, t.timezone)} (\`${t.cron}\`)`;
    case 'webhook':
      return `- **webhook** \`${t.name}\``;
    case 'event': {
      const filter = t.filter ? ` where \`${t.filter}\`` : '';
      return `- **event** \`${t.event}\`${filter}`;
    }
    case 'workflow-completion':
      return `- **after** \`${t.workflow}\` (${t.status ?? 'succeeded'})`;
    default:
      return '- **manual**';
  }
};

const stateWord = (settings: { killed: boolean; enabled: boolean }) => {
  if (settings.killed) return 'killed';
  return settings.enabled ? 'enabled' : 'disabled';
};

const networkNote = (egress: { mode: string; hosts?: string[] }) => {
  if (egress.mode === 'none') return 'none';
  return egress.mode === 'static' ? egress.hosts?.join(', ') : egress.mode;
};

/**
 * Living documentation, generated from the same compiled plans the engine runs (architecture §5.1 #8):
 * it cannot describe a workflow that does not exist, and it cannot drift from what actually executes.
 */

const esc = (s: string) => s.replaceAll('"', '#quot;').replaceAll(/[<>]/g, (c) => (c === '<' ? '#lt;' : '#gt;'));
const cell = (s: unknown) =>
  String(s ?? '')
    .replaceAll('|', String.raw`\|`)
    .replaceAll('\n', ' ');

/** The plan as a Mermaid flowchart: shape = step kind, colour = effect, dotted = conditional, red = error route. */
export function workflowMermaid(plan: Plan): string {
  const ordered = [...plan.steps].sort((a, b) => a.order - b.order);
  const node = new Map(ordered.map((s, i) => [s.id, `s${i}`]));
  const lines: string[] = ['flowchart TD'];

  const label = (s: PlanStep): string => {
    const head = esc(s.name ?? s.id);
    const sub = stepKind(s);
    return `${head}<br/><small>${esc(sub)}${s.compensate ? ' · compensable' : ''}${s.sunset ? ` · sunset ${s.sunset}` : ''}</small>`;
  };

  lines.push('  start(["trigger"])');
  for (const s of ordered) {
    const id = node.get(s.id)!;
    const l = label(s);
    lines.push(nodeLine(s.type, id, l));
  }
  for (const s of ordered) {
    const id = node.get(s.id)!;
    if (s.dependsOn.length === 0) lines.push(`  start --> ${id}`);
    for (const d of s.dependsOn) {
      const from = node.get(d);
      if (!from) continue;
      const when = s.when && s.when.length > 40 ? `${s.when.slice(0, 37)}...` : s.when;
      lines.push(when ? `  ${from} -.->|"${esc(when)}"| ${id}` : `  ${from} --> ${id}`);
    }
    if (typeof s.onError === 'object' && s.onError && node.has(s.onError.routeTo))
      lines.push(`  ${id} -. "on error" .-> ${node.get(s.onError.routeTo)}`);
  }
  lines.push('  classDef effectful fill:#fdecea,stroke:#c0392b,color:#7b241c');
  lines.push('  classDef idempotent fill:#fef9e7,stroke:#b7950b,color:#7d6608');
  lines.push('  classDef pure fill:#eafaf1,stroke:#1e8449,color:#145a32');
  lines.push('  classDef gate fill:#ebf5fb,stroke:#2874a6,color:#1b4f72');
  const group = (pred: (s: PlanStep) => boolean, cls: string) => {
    const ids = ordered.filter(pred).map((s) => node.get(s.id)!);
    if (ids.length) lines.push(`  class ${ids.join(',')} ${cls}`);
  };
  group((s) => s.effect === 'effectful', 'effectful');
  group((s) => s.effect === 'idempotent', 'idempotent');
  group((s) => s.effect === 'pure', 'pure');
  group((s) => s.type === 'approval' || s.type === 'branch', 'gate');
  return lines.join('\n');
}

export interface WorkflowDocContext {
  /** Lifecycle facts, when known. */
  settings?: { enabled: boolean; killed: boolean; stableVersion?: string; autonomyTier: string };
  versions?: Array<{ version: string; status: string; publishedAt: string; publishedBy: string }>;
  risk?: { level: string; score: number; findings: Array<{ severity: string; message: string; stepId?: string }> };
}

export function workflowMarkdown(plan: Plan, ctx: WorkflowDocContext = {}): string {
  const w = plan.workflow;
  const ordered = [...plan.steps].sort((a, b) => a.order - b.order);
  const out: string[] = [`# ${w.name}`, ''];
  if (w.description) out.push(w.description, '');
  out.push(
    '| | |',
    '|---|---|',
    `| Version | ${w.version} |`,
    `| Owner | ${cell(w.owner)}${w.team ? ` (${cell(w.team)})` : ''} |`,
    `| Criticality | ${w.criticality} |`,
    ...(ctx.settings ? [`| State | ${stateWord(ctx.settings)} · autonomy ${ctx.settings.autonomyTier} |`] : []),
    `| Size | ${plan.analysis.stepCount} steps · depth ${plan.analysis.depth} · worst-case cost ${plan.analysis.maxCost} |`,
    '',
    '## Flow',
    '',
    '```mermaid',
    workflowMermaid(plan),
    '```',
    '',
    '## Triggers',
    '',
  );
  for (const t of plan.triggers) {
    out.push(triggerLine(t));
  }
  const inputs = Object.entries(plan.inputs);
  out.push('', '## Inputs', '');
  if (inputs.length === 0) out.push('_None._');
  else {
    out.push('| Name | Type | Required | Default | Description |', '|---|---|---|---|---|');
    for (const [k, v] of inputs)
      out.push(
        `| \`${k}\` | ${v.type} | ${v.required ? 'yes' : 'no'} | ${v.default === undefined ? '' : `\`${cell(JSON.stringify(v.default))}\``} | ${cell(v.description)} |`,
      );
  }
  out.push(
    '',
    '## Steps',
    '',
    '| # | Step | Kind | Capability | Effect | Depends on | Timeout | Retries | Undo |',
    '|---|---|---|---|---|---|---|---|---|',
  );
  for (const s of ordered) {
    out.push(
      `| ${s.order + 1} | \`${s.id}\` | ${s.type} | ${s.capability ? `${s.capability.name}@${s.capability.version}` : ''} | ${s.effect ?? ''} | ${s.dependsOn.map((d) => `\`${d}\``).join(', ')} | ${s.timeoutMs ? `${s.timeoutMs / 1000}s` : ''} | ${s.retry ? s.retry.attempts - 1 : 0} | ${s.compensate ? `\`${s.compensate.capability.name}\`` : ''} |`,
    );
  }
  const a = plan.analysis;
  out.push(
    '',
    '## Analysis',
    '',
    `- Effects: ${Object.entries(a.effects)
      .map(([k, v]) => `${v} ${k}`)
      .join(', ')}`,
    `- Scopes required: ${a.scopes.length ? a.scopes.map((s) => `\`${s}\``).join(', ') : 'none'}`,
    `- Can reach: ${a.egress.length ? a.egress.join(', ') : 'nothing outside Constans'}`,
    `- Data sensitivity: ${a.maxSensitivity}`,
    `- Approval gates: ${a.hasApproval ? 'yes' : 'no'} · compensation: ${a.hasCompensation ? 'yes' : 'no'}`,
  );
  if (ctx.risk) {
    out.push('', `## Risk review — ${ctx.risk.level} (${ctx.risk.score}/100)`, '');
    out.push(
      ...(ctx.risk.findings.length
        ? ctx.risk.findings.map((f) => `- **${f.severity}** ${f.message}${f.stepId ? ` (\`${f.stepId}\`)` : ''}`)
        : ['_No findings._']),
    );
  }
  if (ctx.versions?.length) {
    out.push('', '## Versions', '', '| Version | Status | Published | By |', '|---|---|---|---|');
    for (const v of ctx.versions)
      out.push(`| ${v.version} | ${v.status} | ${v.publishedAt} | ${cell(v.publishedBy)} |`);
  }
  return `${out.join('\n')}\n`;
}

export function capabilityMarkdown(caps: CapabilityDeclaration[]): string {
  const out: string[] = [
    '# Capability catalogue',
    '',
    'Capabilities are the only way a workflow touches the outside world. Each one declares its contract, effect, scopes and reach.',
    '',
  ];
  for (const c of [...caps].sort((a, b) => a.name.localeCompare(b.name))) {
    const props =
      (c.inputSchema as {
        properties?: Record<string, { type?: string; description?: string }>;
        required?: string[];
      }) ?? {};
    const scopes = c.scopes.length ? c.scopes.map((s) => `\`${s}\``).join(', ') : 'none';
    const undo = c.compensation ? ` · **Undo with:** \`${c.compensation}\`` : '';
    out.push(
      `## ${c.name}@${c.version}`,
      '',
      c.description,
      '',
      `- **Effect:** ${c.effect} · **Family:** ${c.family} · **Dry run:** ${c.dryRun}`,
      `- **Scopes:** ${scopes}`,
      `- **Network:** ${networkNote(c.egress)}`,
      `- **Data classification:** ${c.dataClassification}${undo}`,
      '',
    );
    const inputs = Object.entries(props.properties ?? {});
    if (inputs.length) {
      out.push('| Input | Type | Required | Notes |', '|---|---|---|---|');
      for (const [k, v] of inputs)
        out.push(
          `| \`${k}\` | ${cell(Array.isArray(v?.type) ? v.type.join('/') : (v?.type ?? 'any'))} | ${props.required?.includes(k) ? 'yes' : ''} | ${cell(v?.description)} |`,
        );
      out.push('');
    }
    if (c.failureModes.length) {
      out.push(
        'Failure modes: ' +
          c.failureModes.map((f) => `\`${f.code}\` (${f.class}${f.retryable ? ', retryable' : ''})`).join(', '),
        '',
      );
    }
  }
  return `${out.join('\n')}\n`;
}

export function indexMarkdown(
  items: Array<{
    name: string;
    description?: string | null;
    stableVersion?: string | null;
    criticality?: string | null;
    owner?: string | null;
  }>,
): string {
  const out = [
    '# Workflows',
    '',
    '| Workflow | Version | Criticality | Owner | Description |',
    '|---|---|---|---|---|',
  ];
  for (const w of [...items].sort((a, b) => a.name.localeCompare(b.name)))
    out.push(
      `| [${w.name}](${w.name}.md) | ${w.stableVersion ?? ''} | ${w.criticality ?? ''} | ${cell(w.owner)} | ${cell(w.description)} |`,
    );
  return `${out.join('\n')}\n`;
}
