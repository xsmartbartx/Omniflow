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
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const pad = (n: string) => n.padStart(2, '0');
function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

/** "Every N minutes/hours" shapes, which only apply when day, month and weekday are all unrestricted. */
function describeSubDaily(min: string, hour: string, anyDay: boolean): string | undefined {
  if (!anyDay) return undefined;
  const isNum = (s: string) => /^\d+$/.test(s);
  const isStep = (s: string) => /^\*\/\d+$/.test(s);
  if (min === '*' && hour === '*') return 'every minute';
  if (isStep(min) && hour === '*') return `every ${min.slice(2)} minutes`;
  if (isNum(min) && isStep(hour)) return `every ${hour.slice(2)} hours, at minute ${min}`;
  if (isNum(min) && hour === '*') return min === '0' ? 'every hour, on the hour' : `every hour at minute ${min}`;
  return undefined;
}

/** Describe the common cron shapes in words; anything unusual is quoted back verbatim rather than guessed at. */
export function describeCron(expr: string, timezone?: string): string {
  const tz = timezone ? ` (${timezone})` : ' (UTC)';
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return `on the cron schedule \`${expr}\`${tz}`;
  const [min, hour, dom, mon, dow] = f as [string, string, string, string, string];
  const num = (s: string) => /^\d+$/.test(s);
  const time = num(min) && num(hour) ? `${pad(hour)}:${pad(min)}` : undefined;

  const sub = describeSubDaily(min, hour, dom === '*' && mon === '*' && dow === '*');
  if (sub) return sub;
  if (time && dom === '*' && mon === '*' && dow === '*') return `every day at ${time}${tz}`;
  if (time && dom === '*' && mon === '*' && num(dow)) return `every ${DAYS[Number(dow) % 7]} at ${time}${tz}`;
  if (time && dom === '*' && mon === '*' && dow === '1-5') return `every weekday at ${time}${tz}`;
  if (time && num(dom) && mon === '*' && dow === '*')
    return `on the ${ordinal(Number(dom))} of every month at ${time}${tz}`;
  if (time && num(dom) && num(mon) && dow === '*') {
    const month = MONTHS[Number(mon) - 1] ?? `month ${mon}`;
    return `every ${month} ${ordinal(Number(dom))} at ${time}${tz}`;
  }
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

const humanMs = (ms: number) => {
  if (ms >= 3_600_000) return `${+(ms / 3_600_000).toFixed(1)} h`;
  if (ms >= 60_000) return `${+(ms / 60_000).toFixed(1)} min`;
  return `${+(ms / 1000).toFixed(1)} s`;
};

const COMPLETION_VERB: Record<string, string> = { failed: 'fails', any: 'finishes' };

const effectNote = (effect: string | undefined) => {
  if (effect === 'effectful') return ' (this changes something in the outside world)';
  if (effect === 'idempotent') return ' (safe to repeat)';
  return ' (read-only)';
};

const timeoutNote = (onTimeout: string | undefined) => {
  if (onTimeout === 'deny') return 'If nobody answers in time it is denied';
  if (onTimeout === 'escalate') return 'If nobody answers in time it escalates';
  return 'If nobody answers in time it is approved automatically';
};

const describeInput = (k: string, v: { type: string; required?: boolean; default?: unknown; description?: string }) => {
  let flag = ', optional';
  if (v.required) flag = ', required';
  else if (v.default !== undefined) flag = `, default ${JSON.stringify(v.default)}`;
  const detail = v.description ? ` — ${v.description}` : '';
  return `\`${k}\` (${v.type}${flag})${detail}`;
};

const startedBy = (run: { triggerType: string; requestedBy: { name: string } }) => {
  if (run.triggerType === 'schedule') return 'its schedule';
  if (run.triggerType === 'manual') return `${run.requestedBy.name} by hand`;
  return `a ${run.triggerType} trigger`;
};

const handledNote = (handled: string | undefined) => {
  if (handled === 'continue') return '. The workflow carried on anyway.';
  if (handled === 'route') return '. The workflow took its error route.';
  return '.';
};

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

const whatHappenedNext = (compFailed: number, compensated: number) => {
  if (compFailed) return `Rollback started, but ${compFailed} compensation${plural(compFailed, '', 's')} failed.`;
  if (compensated) return `${compensated} earlier step${plural(compensated, ' was', 's were')} undone.`;
  return 'Nothing needed to be undone.';
};

function describeTrigger(t: Plan['triggers'][number]): string {
  switch (t.type) {
    case 'manual':
      return 'when someone starts it by hand (or through the API)';
    case 'schedule':
      return describeCron(t.cron, t.timezone);
    case 'webhook':
      return `when an external system calls its webhook “${t.name}”`;
    case 'event': {
      const holds = t.filter ? ` and \`${t.filter}\` holds` : '';
      return `when a “${t.event}” event is published${holds}`;
    }
    case 'workflow-completion':
      return `after the workflow “${t.workflow}” ${COMPLETION_VERB[t.status ?? ''] ?? 'succeeds'}`;
  }
}

function describeStep(s: PlanStep, plan: Plan): string {
  const by = new Map(plan.steps.map((x) => [x.id, x]));
  const label = (id: string) => `“${by.get(id)?.name ?? id}”`;
  return [describeStepKind(s), ...describeStepExtras(s, label)].join(' ');
}

/** The sentence that says what kind of step this is and what it does. */
function describeStepKind(s: PlanStep): string {
  const parts: string[] = [];
  const title = s.name ?? s.id;
  switch (s.type) {
    case 'capability':
      parts.push(`**${title}** — uses the \`${s.capability?.name}\` capability${effectNote(s.effect)}.`);
      break;
    case 'branch': {
      const cases = s.cases?.map((c) => `“${c.name}” when \`${c.when}\``).join(', ');
      const otherwise = s.default ? `, otherwise “${s.default}”` : '';
      parts.push(`**${title}** — chooses a path: ${cases}${otherwise}.`);
      break;
    }
    case 'parallel':
      parts.push(`**${title}** — waits for ${s.join === 'any' ? 'the first of' : 'all of'} its branches.`);
      break;
    case 'map': {
      const atATime = s.concurrency ? `, ${s.concurrency} at a time` : '';
      parts.push(
        `**${title}** — repeats \`${s.capability?.name ?? 'a capability'}\` for each item in \`${s.items}\` (at most ${s.maxItems}${atATime}).`,
      );
      break;
    }
    case 'approval':
      parts.push(
        `**${title}** — pauses for a person to approve: “${s.message}”. ${timeoutNote(s.onTimeout)} after ${humanMs(s.timeoutMs)}.`,
      );
      break;
    case 'wait': {
      const until = s.until ? `for the “${s.until.event}” event` : humanMs(s.durationMs ?? 0);
      parts.push(`**${title}** — waits ${until}.`);
      break;
    }
    case 'subworkflow':
      parts.push(`**${title}** — runs the workflow “${s.workflow}” version ${s.version} and waits for it.`);
      break;
    case 'terminate':
      parts.push(`**${title}** — ends the run as ${s.status === 'success' ? 'a success' : 'a failure'}.`);
      break;
  }
  return parts.join(' ');
}

/** Ordering, condition, retry, timeout, undo, error-route and sunset notes that apply to any step kind. */
function describeStepExtras(s: PlanStep, label: (id: string) => string): string[] {
  const parts: string[] = [];
  if (s.dependsOn.length) parts.push(`Runs after ${s.dependsOn.map(label).join(' and ')}.`);
  if (s.when) parts.push(`Only runs when \`${s.when}\`.`);
  if (s.retry && s.retry.attempts > 1)
    parts.push(
      `Retries up to ${s.retry.attempts - 1} more time${s.retry.attempts === 2 ? '' : 's'} on ${s.retry.retryOn.join('/')} errors.`,
    );
  if (s.type !== 'approval' && s.type !== 'wait') parts.push(`Times out after ${humanMs(s.timeoutMs)}.`);
  if (s.compensate) parts.push(`If the run later fails, this is undone with \`${s.compensate.capability.name}\`.`);
  if (typeof s.onError === 'object' && s.onError)
    parts.push(`If it fails, the run continues at ${label(s.onError.routeTo)}.`);
  else if (s.onError === 'continue') parts.push('If it fails, the run carries on regardless.');
  if (s.sunset) parts.push(`Temporary bridge — must be reviewed by ${s.sunset}.`);
  return parts;
}

/** Guards, caps, concurrency and approval gates, in plain sentences. */
function safeguardsOf(plan: Plan, ordered: PlanStep[]): string[] {
  const safeguards: string[] = [];
  if (plan.guards.pre.length)
    safeguards.push(`Before it starts it checks: ${plan.guards.pre.map((g) => g.message ?? g.name).join('; ')}.`);
  if (plan.guards.invariants.length)
    safeguards.push(
      `After every step it keeps checking: ${plan.guards.invariants.map((g) => g.message ?? g.name).join('; ')}. A violation stops the run.`,
    );
  if (plan.policy.maxRunCost !== undefined) {
    const daily =
      plan.policy.maxDailyCost !== undefined ? ` and the workflow at ${plan.policy.maxDailyCost} per day` : '';
    safeguards.push(`A single run is capped at ${plan.policy.maxRunCost} cost units${daily}.`);
  }
  if (plan.policy.concurrency) {
    const extras = plan.policy.concurrencyPolicy === 'skip' ? '; extra triggers are skipped' : '; extras wait in line';
    safeguards.push(
      `At most ${plan.policy.concurrency} ${plural(plan.policy.concurrency, 'run', 'runs')} at a time${extras}.`,
    );
  }
  if (plan.policy.dedupKey) safeguards.push('Duplicate triggers within a short window are ignored.');
  if (ordered.some((s) => s.type === 'approval'))
    safeguards.push('A person must approve before it proceeds past the approval step.');
  return safeguards;
}

/** What a reader should know before trusting the workflow: effects that cannot be undone, shell use, data and reach. */
function risksOf(plan: Plan, ordered: PlanStep[]): string[] {
  const a = plan.analysis;
  const risks: string[] = [];
  const effectful = ordered.filter((s) => s.effect === 'effectful');
  if (effectful.length) {
    const uncompensated = effectful.filter((s) => !s.compensate);
    const quote = (s: PlanStep) => `“${s.name ?? s.id}”`;
    risks.push(
      `${effectful.length} ${effectful.length === 1 ? 'step changes' : 'steps change'} things outside Constans (${effectful.map(quote).join(', ')}).`,
    );
    if (uncompensated.length === effectful.length)
      risks.push(
        `${effectful.length === 1 ? 'It cannot' : 'None of them can'} be undone automatically, so a failure part-way through needs a person to clean up.`,
      );
    else if (uncompensated.length)
      risks.push(
        `${uncompensated.map(quote).join(', ')} cannot be undone automatically, so a failure after ${uncompensated.length === 1 ? 'it' : 'them'} needs a person to clean up.`,
      );
  }
  if (a.families.includes('shell'))
    risks.push('It runs shell commands, the least constrained kind of step. That is meant to be temporary.');
  if (a.maxSensitivity === 'confidential' || a.maxSensitivity === 'secret')
    risks.push(`It handles ${a.maxSensitivity} data.`);
  if (a.egress.length) risks.push(`It can contact: ${a.egress.join(', ')}.`);
  return risks;
}

export function explainPlan(plan: Plan): PlanExplanation {
  const w = plan.workflow;
  const triggers = plan.triggers.map(describeTrigger);
  const inputs = Object.entries(plan.inputs).map(([k, v]) => describeInput(k, v));
  const ordered = [...plan.steps].sort((a, b) => a.order - b.order);
  const steps = ordered.map((s) => ({ id: s.id, text: describeStep(s, plan) }));

  const safeguards = safeguardsOf(plan, ordered);
  const effectful = ordered.filter((s) => s.effect === 'effectful');
  const risks = risksOf(plan, ordered);

  const intro = w.description ? `${w.description.replace(/\.?$/, '.')} ` : '';
  const summary = [
    intro,
    `It runs ${triggers.length ? triggers.join(', or ') : 'only when started manually'} and has ${ordered.length} ${plural(ordered.length, 'step', 'steps')}.`,
    effectful.length
      ? ` It changes things in ${effectful.length} of them.`
      : ' It only reads and computes; it changes nothing outside Constans.',
  ]
    .join('')
    .trim();

  const md: string[] = [
    `# ${w.name} ${w.version}`,
    '',
    summary,
    '',
    '## When it runs',
    ...triggers.map((t) => `- ${t}`),
  ];
  if (inputs.length) md.push('', '## What it needs', ...inputs.map((i) => `- ${i}`));
  md.push('', '## What it does', ...steps.map((s, i) => `${i + 1}. ${s.text}`));
  if (safeguards.length) md.push('', '## Safeguards', ...safeguards.map((x) => `- ${x}`));
  if (risks.length) md.push('', '## Things to know', ...risks.map((x) => `- ${x}`));
  const team = w.team ? ` (${w.team})` : '';
  md.push('', `_Owner: ${w.owner}${team} · criticality ${w.criticality}_`);

  return {
    title: `${w.name} ${w.version}`,
    summary,
    triggers,
    inputs,
    steps,
    safeguards,
    risks,
    markdown: md.join('\n'),
  };
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
  transient: {
    cause: 'A temporary problem in something the step depends on (a network blip, an overloaded service).',
    suggestion:
      'Usually safe to retry the run. If it keeps happening, check that dependency’s status, or add backoff and a longer timeout.',
  },
  systemic: {
    cause: 'A dependency the step relies on was unavailable, or its circuit breaker is open.',
    suggestion:
      'Check the capability’s health on the Capabilities page. The run can be retried once the dependency recovers.',
  },
  contract: {
    cause:
      'The data the step received or produced did not match what was declared — usually a change in an upstream system or a wrong input.',
    suggestion:
      'Look at the step’s input and output. Fix the input, or update the workflow if the upstream format changed. Retrying will not help until then.',
  },
  business: {
    cause:
      'The step worked technically but the other side said no (for example a declined payment or a rejected request).',
    suggestion:
      'This needs a decision, not a retry: correct the data, or handle this outcome explicitly with a branch or error route.',
  },
  authorisation: {
    cause: 'The step was not allowed to do what it tried — a credential, permission or network rule blocked it.',
    suggestion:
      'Check the secret it uses, the capability’s scopes and the allowed hosts. Retrying will not help until access is fixed.',
  },
  catastrophic: {
    cause: 'An internal invariant was violated. This should never happen in normal operation.',
    suggestion: 'Treat it as a bug: keep the run for evidence and report it, with the run id.',
  },
};

const dur = (from?: string, to?: string) => (from && to ? humanMs(Date.parse(to) - Date.parse(from)) : undefined);

/** What happened to one step, as one or two sentences (the second when its undo ran or failed). */
function stepSentences(s: StepRecord, n: string): string[] {
  const out: string[] = [];
  const main = stepSentence(s, n);
  if (main) out.push(main);
  if (s.compensationStatus === 'done') out.push(`“${n}” was undone (compensated) after the failure.`);
  else if (s.compensationStatus === 'failed') {
    const why = s.compensationError ? `: ${s.compensationError.message}` : '';
    out.push(`Undoing “${n}” FAILED${why}. This needs a person to clean up.`);
  }
  return out;
}

function stepSentence(s: StepRecord, n: string): string | undefined {
  switch (s.status) {
    case 'succeeded': {
      const onAttempt = s.attempt > 1 ? ` on attempt ${s.attempt}` : '';
      const stepTook = dur(s.startedAt, s.finishedAt);
      const inTime = stepTook ? ` in ${stepTook}` : '';
      return `“${n}” succeeded${onAttempt}${inTime}.`;
    }
    case 'skipped': {
      const why = s.skippedReason ? ` (${s.skippedReason})` : '';
      return `“${n}” was skipped${why}.`;
    }
    case 'failed': {
      const attempts = s.attempt > 1 ? ` after ${s.attempt} attempts` : '';
      return `“${n}” failed${attempts}: ${s.error?.message ?? 'no detail recorded'}${handledNote(s.handled)}`;
    }
    case 'waiting-approval':
      return `“${n}” is waiting for a person to approve it.`;
    case 'waiting-event':
      return `“${n}” is waiting for the “${s.waitEvent}” event.`;
    case 'waiting-timer': {
      const until = s.wakeAt ? ` until ${s.wakeAt}` : '';
      return `“${n}” is waiting for a timer${until}.`;
    }
    case 'retry-wait': {
      const at = s.wakeAt ? ` at ${s.wakeAt}` : '';
      return `“${n}” failed and will be retried${at} (attempt ${s.attempt} so far).`;
    }
    case 'running':
      return `“${n}” is running now.`;
    case 'cancelled':
      return `“${n}” was cancelled.`;
    default:
      return undefined;
  }
}

/** The one-line verdict for a run, plus the failure analysis or the step it is waiting on when relevant. */
function describeOutcome(
  run: RunRecord,
  steps: StepRecord[],
  ordered: StepRecord[],
  name: (id: string) => string,
  took: string | undefined,
): Pick<RunExplanation, 'headline' | 'failure' | 'waitingOn'> {
  switch (run.status) {
    case 'succeeded':
      return { headline: took ? `Succeeded in ${took}.` : 'Succeeded.' };
    case 'cancelled':
      return { headline: 'Cancelled before it finished.' };
    case 'queued':
      return { headline: 'Queued; it has not started yet.' };
    case 'running':
      return { headline: 'Running.' };
    case 'waiting-approval':
    case 'waiting-event': {
      const waiting = steps.find((s) => s.status.startsWith('waiting'));
      const waitingOn = waiting ? name(waiting.stepId) : undefined;
      const at = waitingOn ? ` at “${waitingOn}”` : '';
      const headline =
        run.status === 'waiting-approval' ? `Paused, waiting for approval${at}.` : `Paused, waiting for an event${at}.`;
      return { headline, ...(waitingOn ? { waitingOn } : {}) };
    }
    default:
      return describeFailure(run, ordered, name);
  }
}

function describeFailure(
  run: RunRecord,
  ordered: StepRecord[],
  name: (id: string) => string,
): { headline: string; failure: NonNullable<RunExplanation['failure']> } {
  const bad = ordered.find((s) => s.status === 'failed' && !s.handled) ?? ordered.find((s) => s.status === 'failed');
  const err: ErrorInfo | undefined = bad?.error ?? run.error;
  const advice = ADVICE[err?.class ?? 'systemic']!;
  const compensated = ordered.filter((s) => s.compensationStatus === 'done').length;
  const compFailed = ordered.filter((s) => s.compensationStatus === 'failed').length;
  const failedAt = `Failed at “${bad ? name(bad.stepId) : 'a step'}”`;
  let headline = `${failedAt}.`;
  if (run.status === 'rolled-back') headline = `${failedAt} and was rolled back.`;
  else if (run.status === 'compensation-failed')
    headline = `${failedAt} and the rollback did not complete — needs attention.`;
  return {
    headline,
    failure: {
      stepId: bad?.stepId ?? '',
      code: err?.code ?? 'UNKNOWN',
      errorClass: err?.class ?? 'unknown',
      cause: `${err?.message ?? 'No error detail was recorded.'} ${advice.cause}`,
      whatHappenedNext: whatHappenedNext(compFailed, compensated),
      suggestion: advice.suggestion,
    },
  };
}

export function explainRun(input: {
  run: RunRecord;
  steps: StepRecord[];
  plan?: Plan;
  approvals?: ApprovalRecord[];
}): RunExplanation {
  const { run, steps, plan, approvals = [] } = input;
  const byId = new Map((plan?.steps ?? []).map((s) => [s.id, s]));
  const name = (id: string) => byId.get(id)?.name ?? id;
  const ordered = [...steps].sort(
    (a, b) =>
      (a.completedSeq ?? Number.MAX_SAFE_INTEGER) - (b.completedSeq ?? Number.MAX_SAFE_INTEGER) ||
      (byId.get(a.stepId)?.order ?? 0) - (byId.get(b.stepId)?.order ?? 0),
  );
  const narrative: string[] = [];
  const took = dur(run.startedAt, run.finishedAt);
  const canary = run.canary ? ' (canary version)' : '';
  narrative.push(
    `${run.dryRun ? 'Dry run of' : 'Run of'} ${run.workflowName} ${run.workflowVersion}, started by ${startedBy(run)}${canary}.`,
  );

  for (const s of ordered) narrative.push(...stepSentences(s, name(s.stepId)));
  for (const a of approvals) {
    if (a.status === 'pending') continue;
    const by = a.decidedBy ? ` by ${a.decidedBy}` : '';
    const comment = a.comment ? ` (“${a.comment}”)` : '';
    narrative.push(`Approval “${a.stepId}” was ${a.status}${by}${comment}.`);
  }

  const { headline, failure, waitingOn } = describeOutcome(run, steps, ordered, name, took);

  const md = [`**${headline}**`, '', ...narrative.map((n) => `- ${n}`)];
  if (failure)
    md.push(
      '',
      `**Why:** ${failure.cause}`,
      `**Afterwards:** ${failure.whatHappenedNext}`,
      `**What to do:** ${failure.suggestion}`,
    );
  return {
    headline,
    narrative,
    ...(failure ? { failure } : {}),
    ...(waitingOn ? { waitingOn } : {}),
    markdown: md.join('\n'),
  };
}
