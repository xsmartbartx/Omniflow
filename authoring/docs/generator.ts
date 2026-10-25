import type { CapabilityDeclaration, Plan, PlanStep } from '../../schemas/index.ts';
import { describeCron } from '../agents/explainer.ts';

type Trigger = Plan['triggers'][number];

/** Inline code in Markdown. */
const code = (s: string) => `\`${s}\``;

const findingStep = (stepId: string | undefined) => (stepId ? ` (${code(stepId)})` : '');

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
const cellText = (s: unknown): string => {
  if (typeof s === 'string') return s;
  return typeof s === 'number' || typeof s === 'boolean' ? String(s) : '';
};
const cell = (s: unknown) => cellText(s).replaceAll('|', String.raw`\|`).replaceAll('\n', ' ');

/** Mermaid edges into one step: from `start` or its dependencies (dotted when conditional), plus its error route. */
function edgeLines(s: PlanStep, node: ReadonlyMap<string, string>): string[] {
  const id = node.get(s.id)!;
  const lines: string[] = [];
  if (s.dependsOn.length === 0) lines.push(`  start --> ${id}`);
  for (const d of s.dependsOn) {
    const from = node.get(d);
    if (!from) continue;
    const when = s.when && s.when.length > 40 ? `${s.when.slice(0, 37)}...` : s.when;
    lines.push(when ? `  ${from} -.->|"${esc(when)}"| ${id}` : `  ${from} --> ${id}`);
  }
  if (typeof s.onError === 'object' && s.onError && node.has(s.onError.routeTo))
    lines.push(`  ${id} -. "on error" .-> ${node.get(s.onError.routeTo)}`);
  return lines;
}

/** The plan as a Mermaid flowchart: shape = step kind, colour = effect, dotted = conditional, red = error route. */
export function workflowMermaid(plan: Plan): string {
  const ordered = [...plan.steps].sort((a, b) => a.order - b.order);
  const node = new Map(ordered.map((s, i) => [s.id, `s${i}`]));
  const lines: string[] = ['flowchart TD'];

  const label = (s: PlanStep): string => {
    const head = esc(s.name ?? s.id);
    const sub = stepKind(s);
    const sunset = s.sunset ? ` · sunset ${s.sunset}` : '';
    return `${head}<br/><small>${esc(sub)}${s.compensate ? ' · compensable' : ''}${sunset}</small>`;
  };

  lines.push('  start(["trigger"])');
  for (const s of ordered) {
    const id = node.get(s.id)!;
    const l = label(s);
    lines.push(nodeLine(s.type, id, l));
  }
  for (const s of ordered) lines.push(...edgeLines(s, node));
  lines.push(
    '  classDef effectful fill:#fdecea,stroke:#c0392b,color:#7b241c',
    '  classDef idempotent fill:#fef9e7,stroke:#b7950b,color:#7d6608',
    '  classDef pure fill:#eafaf1,stroke:#1e8449,color:#145a32',
    '  classDef gate fill:#ebf5fb,stroke:#2874a6,color:#1b4f72',
  );
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

function inputsSection(plan: Plan): string[] {
  const inputs = Object.entries(plan.inputs);
  const out = ['', '## Inputs', ''];
  if (inputs.length === 0) return [...out, '_None._'];
  out.push('| Name | Type | Required | Default | Description |', '|---|---|---|---|---|');
  for (const [k, v] of inputs) {
    const def = v.default === undefined ? '' : code(cell(JSON.stringify(v.default)));
    out.push(`| ${code(k)} | ${v.type} | ${v.required ? 'yes' : 'no'} | ${def} | ${cell(v.description)} |`);
  }
  return out;
}

function stepsSection(ordered: PlanStep[]): string[] {
  const out = [
    '',
    '## Steps',
    '',
    '| # | Step | Kind | Capability | Effect | Depends on | Timeout | Retries | Undo |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const s of ordered) {
    const capability = s.capability ? `${s.capability.name}@${s.capability.version}` : '';
    const dependsOn = s.dependsOn.map(code).join(', ');
    const timeout = s.timeoutMs ? `${s.timeoutMs / 1000}s` : '';
    const undo = s.compensate ? code(s.compensate.capability.name) : '';
    out.push(
      `| ${s.order + 1} | ${code(s.id)} | ${s.type} | ${capability} | ${s.effect ?? ''} | ${dependsOn} | ${timeout} | ${s.retry ? s.retry.attempts - 1 : 0} | ${undo} |`,
    );
  }
  return out;
}

function analysisSection(plan: Plan): string[] {
  const a = plan.analysis;
  return [
    '',
    '## Analysis',
    '',
    `- Effects: ${Object.entries(a.effects)
      .map(([k, v]) => `${v} ${k}`)
      .join(', ')}`,
    `- Scopes required: ${a.scopes.length ? a.scopes.map(code).join(', ') : 'none'}`,
    `- Can reach: ${a.egress.length ? a.egress.join(', ') : 'nothing outside OmniFlow'}`,
    `- Data sensitivity: ${a.maxSensitivity}`,
    `- Approval gates: ${a.hasApproval ? 'yes' : 'no'} · compensation: ${a.hasCompensation ? 'yes' : 'no'}`,
  ];
}

export function workflowMarkdown(plan: Plan, ctx: WorkflowDocContext = {}): string {
  const w = plan.workflow;
  const ordered = [...plan.steps].sort((a, b) => a.order - b.order);
  const out: string[] = [`# ${w.name}`, ''];
  if (w.description) out.push(w.description, '');
  const team = w.team ? ` (${cell(w.team)})` : '';
  out.push(
    '| | |',
    '|---|---|',
    `| Version | ${w.version} |`,
    `| Owner | ${cell(w.owner)}${team} |`,
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
  out.push(...inputsSection(plan), ...stepsSection(ordered), ...analysisSection(plan));
  if (ctx.risk) {
    out.push(
      '',
      `## Risk review — ${ctx.risk.level} (${ctx.risk.score}/100)`,
      '',
      ...(ctx.risk.findings.length
        ? ctx.risk.findings.map((f) => `- **${f.severity}** ${f.message}${findingStep(f.stepId)}`)
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
        properties?: Record<string, { type?: string | string[]; description?: string }>;
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
      ...inputTable(props),
    );
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

/** The input table for one capability's schema; nothing when it takes no inputs. */
function inputTable(schema: {
  properties?: Record<string, { type?: string | string[]; description?: string }>;
  required?: string[];
}): string[] {
  const inputs = Object.entries(schema.properties ?? {});
  if (inputs.length === 0) return [];
  const rows = inputs.map(([k, v]) => {
    const type = Array.isArray(v?.type) ? v.type.join('/') : (v?.type ?? 'any');
    return `| \`${k}\` | ${cell(type)} | ${schema.required?.includes(k) ? 'yes' : ''} | ${cell(v?.description)} |`;
  });
  return ['| Input | Type | Required | Notes |', '|---|---|---|---|', ...rows, ''];
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
