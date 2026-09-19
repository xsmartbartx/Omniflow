import type { ErrorInfo } from '../../core/index.ts';
import type { Plan, PlanStep } from '../../schemas/index.ts';
import type { ApprovalRecord, RunRecord, StepRecord } from '../../state/index.ts';

/**
 * Plain-language explanations of plans and runs (architecture §5.1 #6). Deterministic on purpose: an
 * explanation people rely on during an incident must not depend on a model being reachable, and must
 * not be able to hallucinate. Every sentence below is derived from the plan or the recorded run.
 */

// --------------------------------------------------------------------- cron

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n: string) => n.padStart(2, '0');
function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

/** Describe the common cron shapes in words; anything unusual is quoted back verbatim rather than guessed at. */
export function describeCron(expr: string, timezone?: string): string {
  const tz = timezone ? ` (${timezone})` : ' (UTC)';
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return `on the cron schedule \`${expr}\`${tz}`;
  const [min, hour, dom, mon, dow] = f as [string, string, string, string, string];
  const num = (s: string) => /^\d+$/.test(s);
  const time = num(min) && num(hour) ? `${pad(hour)}:${pad(min)}` : undefined;

  if (f.every((x) => x === '*')) return 'every minute';
  if (/^\*\/\d+$/.test(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') return `every ${min.slice(2)} minutes`;
  if (num(min) && /^\*\/\d+$/.test(hour) && dom === '*' && mon === '*' && dow === '*') return `every ${hour.slice(2)} hours, at minute ${min}`;
  if (num(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') return min === '0' ? 'every hour, on the hour' : `every hour at minute ${min}`;
  if (time && dom === '*' && mon === '*' && dow === '*') return `every day at ${time}${tz}`;
  if (time && dom === '*' && mon === '*' && num(dow)) return `every ${DAYS[Number(dow) % 7]} at ${time}${tz}`;
  if (time && dom === '*' && mon === '*' && dow === '1-5') return `every weekday at ${time}${tz}`;
  if (time && num(dom) && mon === '*' && dow === '*') return `on the ${ordinal(Number(dom))} of every month at ${time}${tz}`;
  if (time && num(dom) && num(mon) && dow === '*') return `every ${MONTHS[Number(mon) - 1] ?? `month ${mon}`} ${ordinal(Number(dom))} at ${time}${tz}`;
  return `on the cron schedule \`${expr}\`${tz}`;
}

// ------------------------------------------------------------------- plans

export interface PlanExplanation {
  title: string;
  /** One paragraph a non-engineer can read. */
  summary: string;
  triggers: string[];
  inputs: string[];
  steps: Array<{ id: string; text: string }>;
  safeguards: string[];
  risks: string[];
  /** The whole thing as Markdown. */
  markdown: string;
}

const humanMs = (ms: number) => (ms >= 3_600_000 ? `${+(ms / 3_600_000).toFixed(1)} h` : ms >= 60_000 ? `${+(ms / 60_000).toFixed(1)} min` : `${+(ms / 1000).toFixed(1)} s`);

function describeTrigger(t: Plan['triggers'][number]): string {
  switch (t.type) {
    case 'manual':
      return 'when someone starts it by hand (or through the API)';
    case 'schedule':
      return describeCron(t.cron, t.timezone);
    case 'webhook':
      return `when an external system calls its webhook “${t.name}”`;
    case 'event':
      return `when a “${t.event}” event is published${t.filter ? ` and \`${t.filter}\` holds` : ''}`;
    case 'workflow-completion':
      return `after the workflow “${t.workflow}” ${t.status === 'failed' ? 'fails' : t.status === 'any' ? 'finishes' : 'succeeds'}`;
  }
}

function describeStep(s: PlanStep, plan: Plan): string {
  const by = new Map(plan.steps.map((x) => [x.id, x]));
  const label = (id: string) => `“${by.get(id)?.name ?? id}”`;
  const parts: string[] = [];
  const title = s.name ?? s.id;
  switch (s.type) {
    case 'capability':
      parts.push(`**${title}** — uses the \`${s.capability?.name}\` capability${s.effect === 'effectful' ? ' (this changes something in the outside world)' : s.effect === 'idempotent' ? ' (safe to repeat)' : ' (read-only)'}.`);
      break;
    case 'branch':
      parts.push(`**${title}** — chooses a path: ${s.cases?.map((c) => `“${c.name}” when \`${c.when}\``).join(', ')}${s.default ? `, otherwise “${s.default}”` : ''}.`);
      break;
    case 'parallel':
      parts.push(`**${title}** — waits for ${s.join === 'any' ? 'the first of' : 'all of'} its branches.`);
      break;
    case 'map':
      parts.push(`**${title}** — repeats \`${s.capability?.name ?? 'a capability'}\` for each item in \`${s.items}\` (at most ${s.maxItems}${s.concurrency ? `, ${s.concurrency} at a time` : ''}).`);
      break;
    case 'approval':
      parts.push(`**${title}** — pauses for a person to approve: “${s.message}”. ${s.onTimeout === 'deny' ? 'If nobody answers in time it is denied' : s.onTimeout === 'escalate' ? 'If nobody answers in time it escalates' : 'If nobody answers in time it is approved automatically'} after ${humanMs(s.timeoutMs)}.`);
      break;
    case 'wait':
      parts.push(`**${title}** — waits ${s.until ? `for the “${s.until.event}” event` : humanMs(s.durationMs ?? 0)}.`);
      break;
    case 'subworkflow':
      parts.push(`**${title}** — runs the workflow “${s.workflow}” version ${s.version} and waits for it.`);
      break;
    case 'terminate':
      parts.push(`**${title}** — ends the run as ${s.status === 'success' ? 'a success' : 'a failure'}.`);
      break;
  }
  if (s.dependsOn.length) parts.push(`Runs after ${s.dependsOn.map(label).join(' and ')}.`);
  if (s.when) parts.push(`Only runs when \`${s.when}\`.`);
  if (s.retry && s.retry.attempts > 1) parts.push(`Retries up to ${s.retry.attempts - 1} more time${s.retry.attempts === 2 ? '' : 's'} on ${s.retry.retryOn.join('/')} errors.`);
  if (s.type !== 'approval' && s.type !== 'wait') parts.push(`Times out after ${humanMs(s.timeoutMs)}.`);
  if (s.compensate) parts.push(`If the run later fails, this is undone with \`${s.compensate.capability.name}\`.`);
  if (typeof s.onError === 'object' && s.onError) parts.push(`If it fails, the run continues at ${label(s.onError.routeTo)}.`);
  else if (s.onError === 'continue') parts.push('If it fails, the run carries on regardless.');
  if (s.sunset) parts.push(`Temporary bridge — must be reviewed by ${s.sunset}.`);
  return parts.join(' ');
}

export function explainPlan(plan: Plan): PlanExplanation {
  const w = plan.workflow;
  const triggers = plan.triggers.map(describeTrigger);
  const inputs = Object.entries(plan.inputs).map(([k, v]) => `\`${k}\` (${v.type}${v.required ? ', required' : v.default !== undefined ? `, default ${JSON.stringify(v.default)}` : ', optional'})${v.description ? ` — ${v.description}` : ''}`);
  const ordered = [...plan.steps].sort((a, b) => a.order - b.order);
  const steps = ordered.map((s) => ({ id: s.id, text: describeStep(s, plan) }));

  const a = plan.analysis;
  const safeguards: string[] = [];
  if (plan.guards.pre.length) safeguards.push(`Before it starts it checks: ${plan.guards.pre.map((g) => g.message ?? g.name).join('; ')}.`);
  if (plan.guards.invariants.length) safeguards.push(`After every step it keeps checking: ${plan.guards.invariants.map((g) => g.message ?? g.name).join('; ')}. A violation stops the run.`);
  if (plan.policy.maxRunCost !== undefined) safeguards.push(`A single run is capped at ${plan.policy.maxRunCost} cost units${plan.policy.maxDailyCost !== undefined ? ` and the workflow at ${plan.policy.maxDailyCost} per day` : ''}.`);
  if (plan.policy.concurrency) safeguards.push(`At most ${plan.policy.concurrency} run${plan.policy.concurrency === 1 ? '' : 's'} at a time${plan.policy.concurrencyPolicy === 'skip' ? '; extra triggers are skipped' : '; extras wait in line'}.`);
  if (plan.policy.dedupKey) safeguards.push('Duplicate triggers within a short window are ignored.');
  if (ordered.some((s) => s.type === 'approval')) safeguards.push('A person must approve before it proceeds past the approval step.');

  const risks: string[] = [];
  const effectful = ordered.filter((s) => s.effect === 'effectful');
  if (effectful.length) {
    const uncompensated = effectful.filter((s) => !s.compensate);
    risks.push(`${effectful.length} step${effectful.length === 1 ? ' changes' : 's change'} things outside OmniFlow (${effectful.map((s) => `“${s.name ?? s.id}”`).join(', ')}).`);
    if (uncompensated.length === effectful.length) risks.push('None of them can be undone automatically, so a failure part-way through needs a person to clean up.');
    else if (uncompensated.length) risks.push(`${uncompensated.map((s) => `“${s.name ?? s.id}”`).join(', ')} cannot be undone automatically, so a failure after ${uncompensated.length === 1 ? 'it' : 'them'} needs a person to clean up.`);
  }
  if (a.families.includes('shell')) risks.push('It runs shell commands, the least constrained kind of step. That is meant to be temporary.');
  if (a.maxSensitivity === 'confidential' || a.maxSensitivity === 'secret') risks.push(`It handles ${a.maxSensitivity} data.`);
  if (a.egress.length) risks.push(`It can contact: ${a.egress.join(', ')}.`);

  const summary = [
    `${w.description ? `${w.description.replace(/\.?$/, '.')} ` : ''}`,
    `It runs ${triggers.length ? triggers.join(', or ') : 'only when started manually'} and has ${ordered.length} step${ordered.length === 1 ? '' : 's'}.`,
    effectful.length ? ` It changes things in ${effectful.length} of them.` : ' It only reads and computes; it changes nothing outside OmniFlow.',
  ]
    .join('')
    .trim();

  const md: string[] = [`# ${w.name} ${w.version}`, '', summary, '', '## When it runs', ...triggers.map((t) => `- ${t}`)];
  if (inputs.length) md.push('', '## What it needs', ...inputs.map((i) => `- ${i}`));
  md.push('', '## What it does', ...steps.map((s, i) => `${i + 1}. ${s.text}`));
  if (safeguards.length) md.push('', '## Safeguards', ...safeguards.map((x) => `- ${x}`));
  if (risks.length) md.push('', '## Things to know', ...risks.map((x) => `- ${x}`));
  md.push('', `_Owner: ${w.owner}${w.team ? ` (${w.team})` : ''} · criticality ${w.criticality}_`);

  return { title: `${w.name} ${w.version}`, summary, triggers, inputs, steps, safeguards, risks, markdown: md.join('\n') };
}

// -------------------------------------------------------------------- runs

export interface RunExplanation {
  headline: string;
  narrative: string[];
  failure?: {
    stepId: string;
    code: string;
    errorClass: string;
    cause: string;
    whatHappenedNext: string;
    suggestion: string;
  };
  waitingOn?: string;
  markdown: string;
}

const ADVICE: Record<string, { cause: string; suggestion: string }> = {
  transient: { cause: 'A temporary problem in something the step depends on (a network blip, an overloaded service).', suggestion: 'Usually safe to retry the run. If it keeps happening, check that dependency’s status, or add backoff and a longer timeout.' },
  systemic: { cause: 'A dependency the step relies on was unavailable, or its circuit breaker is open.', suggestion: 'Check the capability’s health on the Capabilities page. The run can be retried once the dependency recovers.' },
  contract: { cause: 'The data the step received or produced did not match what was declared — usually a change in an upstream system or a wrong input.', suggestion: 'Look at the step’s input and output. Fix the input, or update the workflow if the upstream format changed. Retrying will not help until then.' },
  business: { cause: 'The step worked technically but the other side said no (for example a declined payment or a rejected request).', suggestion: 'This needs a decision, not a retry: correct the data, or handle this outcome explicitly with a branch or error route.' },
  authorisation: { cause: 'The step was not allowed to do what it tried — a credential, permission or network rule blocked it.', suggestion: 'Check the secret it uses, the capability’s scopes and the allowed hosts. Retrying will not help until access is fixed.' },
  catastrophic: { cause: 'An internal invariant was violated. This should never happen in normal operation.', suggestion: 'Treat it as a bug: keep the run for evidence and report it, with the run id.' },
};

const dur = (from?: string, to?: string) => (from && to ? humanMs(Date.parse(to) - Date.parse(from)) : undefined);

export function explainRun(input: { run: RunRecord; steps: StepRecord[]; plan?: Plan; approvals?: ApprovalRecord[] }): RunExplanation {
  const { run, steps, plan, approvals = [] } = input;
  const byId = new Map((plan?.steps ?? []).map((s) => [s.id, s]));
  const name = (id: string) => byId.get(id)?.name ?? id;
  const ordered = [...steps].sort((a, b) => (a.completedSeq ?? Number.MAX_SAFE_INTEGER) - (b.completedSeq ?? Number.MAX_SAFE_INTEGER) || (byId.get(a.stepId)?.order ?? 0) - (byId.get(b.stepId)?.order ?? 0));
  const narrative: string[] = [];
  const took = dur(run.startedAt, run.finishedAt);
  narrative.push(`${run.dryRun ? 'Dry run of' : 'Run of'} ${run.workflowName} ${run.workflowVersion}, started by ${run.triggerType === 'schedule' ? 'its schedule' : run.triggerType === 'manual' ? `${run.requestedBy.name} by hand` : `a ${run.triggerType} trigger`}${run.canary ? ' (canary version)' : ''}.`);

  for (const s of ordered) {
    const n = name(s.stepId);
    switch (s.status) {
      case 'succeeded':
        narrative.push(`“${n}” succeeded${s.attempt > 1 ? ` on attempt ${s.attempt}` : ''}${dur(s.startedAt, s.finishedAt) ? ` in ${dur(s.startedAt, s.finishedAt)}` : ''}.`);
        break;
      case 'skipped':
        narrative.push(`“${n}” was skipped${s.skippedReason ? ` (${s.skippedReason})` : ''}.`);
        break;
      case 'failed':
        narrative.push(`“${n}” failed${s.attempt > 1 ? ` after ${s.attempt} attempts` : ''}: ${s.error?.message ?? 'no detail recorded'}${s.handled === 'continue' ? '. The workflow carried on anyway.' : s.handled === 'route' ? '. The workflow took its error route.' : '.'}`);
        break;
      case 'waiting-approval':
        narrative.push(`“${n}” is waiting for a person to approve it.`);
        break;
      case 'waiting-event':
        narrative.push(`“${n}” is waiting for the “${s.waitEvent}” event.`);
        break;
      case 'waiting-timer':
        narrative.push(`“${n}” is waiting for a timer${s.wakeAt ? ` until ${s.wakeAt}` : ''}.`);
        break;
      case 'retry-wait':
        narrative.push(`“${n}” failed and will be retried${s.wakeAt ? ` at ${s.wakeAt}` : ''} (attempt ${s.attempt} so far).`);
        break;
      case 'running':
        narrative.push(`“${n}” is running now.`);
        break;
      case 'cancelled':
        narrative.push(`“${n}” was cancelled.`);
        break;
      default:
        break;
    }
    if (s.compensationStatus === 'done') narrative.push(`“${n}” was undone (compensated) after the failure.`);
    else if (s.compensationStatus === 'failed') narrative.push(`Undoing “${n}” FAILED${s.compensationError ? `: ${s.compensationError.message}` : ''}. This needs a person to clean up.`);
  }
  for (const a of approvals) {
    if (a.status !== 'pending') narrative.push(`Approval “${a.stepId}” was ${a.status}${a.decidedBy ? ` by ${a.decidedBy}` : ''}${a.comment ? ` (“${a.comment}”)` : ''}.`);
  }

  let headline: string;
  let failure: RunExplanation['failure'];
  let waitingOn: string | undefined;
  switch (run.status) {
    case 'succeeded':
      headline = `Succeeded${took ? ` in ${took}` : ''}.`;
      break;
    case 'cancelled':
      headline = 'Cancelled before it finished.';
      break;
    case 'queued':
      headline = 'Queued; it has not started yet.';
      break;
    case 'running':
      headline = 'Running.';
      break;
    case 'waiting-approval':
    case 'waiting-event': {
      const waiting = steps.find((s) => s.status.startsWith('waiting'));
      waitingOn = waiting ? name(waiting.stepId) : undefined;
      headline = run.status === 'waiting-approval' ? `Paused, waiting for approval${waitingOn ? ` at “${waitingOn}”` : ''}.` : `Paused, waiting for an event${waitingOn ? ` at “${waitingOn}”` : ''}.`;
      break;
    }
    default: {
      const bad = ordered.find((s) => s.status === 'failed' && !s.handled) ?? ordered.find((s) => s.status === 'failed');
      const err: ErrorInfo | undefined = bad?.error ?? run.error;
      const advice = ADVICE[err?.class ?? 'systemic']!;
      const compensated = ordered.filter((s) => s.compensationStatus === 'done').length;
      const compFailed = ordered.filter((s) => s.compensationStatus === 'failed').length;
      headline = run.status === 'rolled-back' ? `Failed at “${bad ? name(bad.stepId) : 'a step'}” and was rolled back.` : run.status === 'compensation-failed' ? `Failed at “${bad ? name(bad.stepId) : 'a step'}” and the rollback did not complete — needs attention.` : `Failed at “${bad ? name(bad.stepId) : 'a step'}”.`;
      failure = {
        stepId: bad?.stepId ?? '',
        code: err?.code ?? 'UNKNOWN',
        errorClass: err?.class ?? 'unknown',
        cause: `${err?.message ?? 'No error detail was recorded.'} ${advice.cause}`,
        whatHappenedNext: compFailed ? `Rollback started, but ${compFailed} compensation${compFailed === 1 ? '' : 's'} failed.` : compensated ? `${compensated} earlier step${compensated === 1 ? ' was' : 's were'} undone.` : 'Nothing needed to be undone.',
        suggestion: advice.suggestion,
      };
    }
  }

  const md = [`**${headline}**`, '', ...narrative.map((n) => `- ${n}`)];
  if (failure) md.push('', `**Why:** ${failure.cause}`, `**Afterwards:** ${failure.whatHappenedNext}`, `**What to do:** ${failure.suggestion}`);
  return { headline, narrative, ...(failure ? { failure } : {}), ...(waitingOn ? { waitingOn } : {}), markdown: md.join('\n') };
}
