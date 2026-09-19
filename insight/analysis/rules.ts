import type { PlanStep } from '../../schemas/index.ts';
import { humanMs, parseMs, pct, percentile, ratio } from '../util.ts';
import type { AnalysisInput, Finding, Rule, Thresholds, WorkflowFacts } from './types.ts';

/**
 * The Analysis Agent's rules (architecture §13.2). Each is a pure function from a snapshot of run
 * history to findings — no I/O, no clock, no randomness — so every rule can be tested with a
 * handful of numbers, and the same history always yields the same advice.
 */

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const capOf = (s: PlanStep) => (s.capability ? `${s.capability.name}@${s.capability.version}` : s.type);

/** Steps whose failures the workflow swallows (`onError: continue`) — a problem being ignored. */
export const ignoredFailures: Rule = (input, t) => {
  const out: Finding[] = [];
  for (const wf of input.workflows) {
    for (const s of wf.steps.values()) {
      const ran = s.succeeded + s.failed;
      if (s.ignored < 5 || ran < t.minSamples) continue;
      const rate = ratio(s.ignored, ran);
      if (rate < t.ignoredFailureRate) continue;
      out.push({
        rule: 'ignored-failure',
        severity: rate >= 0.9 ? 'high' : 'medium',
        workflow: wf.name,
        stepId: s.stepId,
        key: `ignored-failure:${wf.name}:${s.stepId}`,
        title: `Step '${s.stepId}' fails ${pct(rate)} of the time and the failure is ignored`,
        summary: `In ${wf.name}, step '${s.stepId}' failed in ${s.ignored} of ${ran} runs, but onError: continue lets the workflow carry on as if nothing happened.`,
        recommendation:
          rate >= 0.9
            ? `The step almost never works, so it contributes nothing. Fix the cause${topError(wf, s.stepId)}, or remove the step.`
            : `Decide whether the step matters. If it does, stop ignoring its failures (route them to a handler or fail the run); if it doesn't, remove it.`,
        evidence: {
          runsSeen: ran,
          ignoredFailures: s.ignored,
          rate: round(rate),
          topErrors: wf.errors.get(s.stepId)?.slice(0, 3) ?? [],
        },
      });
    }
  }
  return out;
};

/** Steps that fail often and are not being ignored — the workflow itself is unreliable there. */
export const failingSteps: Rule = (input, t) => {
  const out: Finding[] = [];
  for (const wf of input.workflows) {
    for (const s of wf.steps.values()) {
      const ran = s.succeeded + s.failed;
      if (ran < t.minSamples || s.failed <= s.ignored) continue;
      const rate = ratio(s.failed, ran);
      if (rate < t.failingStepRate) continue;
      out.push({
        rule: 'failing-step',
        severity: rate >= 0.7 ? 'high' : 'medium',
        workflow: wf.name,
        stepId: s.stepId,
        key: `failing-step:${wf.name}:${s.stepId}`,
        title: `Step '${s.stepId}' fails ${pct(rate)} of the time`,
        summary: `${wf.name} › ${s.stepId} failed in ${s.failed} of ${ran} executions over the last ${input.windowDays} days.`,
        recommendation: `Investigate the dominant failure${topError(wf, s.stepId)}. If it is an upstream dependency, add a fallback route or tighten the timeout; if it is bad input, validate earlier in the workflow.`,
        evidence: {
          executions: ran,
          failed: s.failed,
          rate: round(rate),
          topErrors: wf.errors.get(s.stepId)?.slice(0, 3) ?? [],
        },
      });
    }
  }
  return out;
};

/** Steps behind a `when` that is never true — dead weight. */
export const deadSteps: Rule = (input, t) => {
  const out: Finding[] = [];
  for (const wf of input.workflows) {
    for (const s of wf.steps.values()) {
      if (s.seen < t.minSamples * 2 || s.skipped !== s.seen) continue;
      out.push({
        rule: 'dead-step',
        severity: 'low',
        workflow: wf.name,
        stepId: s.stepId,
        key: `dead-step:${wf.name}:${s.stepId}`,
        title: `Step '${s.stepId}' has never run`,
        summary: `${wf.name} › ${s.stepId} was skipped in all ${s.seen} runs of the last ${input.windowDays} days: its condition is never true.`,
        recommendation: `If the branch is obsolete, remove the step (and anything only it depends on). If it is meant to run, its condition is wrong.`,
        evidence: { runsSeen: s.seen, skipped: s.skipped },
      });
    }
  }
  return out;
};

/** Repeated retries: a flaky dependency, or errors classified so that they are retried pointlessly. */
export const retryStorms: Rule = (input, t) => {
  const out: Finding[] = [];
  for (const wf of input.workflows) {
    for (const s of wf.steps.values()) {
      const ran = s.succeeded + s.failed;
      if (ran < t.minSamples || s.retried < t.retryStormMinRetried) continue;
      const rate = ratio(s.retried, ran);
      if (rate < t.retryStormRate) continue;
      const planStep = wf.plan.steps.find((p) => p.id === s.stepId);
      const errs = wf.errors.get(s.stepId) ?? [];
      const nonTransient = errs.filter((e) => e.errorClass !== 'transient' && e.errorClass !== 'systemic');
      const misclassified =
        nonTransient.length > 0 &&
        planStep?.retry?.retryOn.some((c) => nonTransient.some((e) => e.errorClass === c)) === true;
      out.push({
        rule: 'retry-storm',
        severity: misclassified || rate >= 0.6 ? 'high' : 'medium',
        workflow: wf.name,
        stepId: s.stepId,
        key: `retry-storm:${wf.name}:${s.stepId}`,
        title: `Step '${s.stepId}' needs retries in ${pct(rate)} of runs`,
        summary: `${wf.name} › ${s.stepId} took more than one attempt in ${s.retried} of ${ran} executions (${round(ratio(s.attempts, Math.max(1, s.seen)))} attempts on average).`,
        recommendation: misclassified
          ? `Retries are configured for ${nonTransient[0]!.errorClass} errors (${nonTransient[0]!.code}), which retrying cannot fix. Remove that class from retryOn so the run fails fast — or fix how the capability classifies the error.`
          : `The dependency is unreliable. Add exponential backoff with jitter, raise the timeout if calls are merely slow, or put the capability behind a fallback route.`,
        evidence: {
          executions: ran,
          retried: s.retried,
          averageAttempts: round(ratio(s.attempts, Math.max(1, s.seen))),
          configuredRetryOn: planStep?.retry?.retryOn ?? [],
          topErrors: errs.slice(0, 3),
        },
      });
    }
  }
  return out;
};

// ---------------------------------------------------------------- duplicates

const fingerprint = (s: PlanStep): string =>
  s.capability
    ? `${s.capability.name}|${Object.keys(s.with ?? {})
        .sort()
        .join(',')}`
    : s.type;

/** A workflow's steps as a bag: the nth occurrence of a fingerprint is distinct from the (n-1)th. */
function fingerprints(wf: WorkflowFacts): Map<string, PlanStep> {
  const seen = new Map<string, number>();
  const out = new Map<string, PlanStep>();
  for (const s of wf.plan.steps) {
    if (s.type === 'terminate') continue;
    const fp = fingerprint(s);
    const n = seen.get(fp) ?? 0;
    seen.set(fp, n + 1);
    out.set(`${fp}#${n}`, s);
  }
  return out;
}

function differingParameters(a: Map<string, PlanStep>, b: Map<string, PlanStep>): string[] {
  const out = new Set<string>();
  for (const [fp, s] of a) {
    const other = b.get(fp);
    if (!other?.with || !s.with) continue;
    for (const k of Object.keys(s.with))
      if (JSON.stringify(s.with[k]) !== JSON.stringify(other.with[k])) out.add(`${s.capability?.name ?? s.type}.${k}`);
  }
  return [...out].sort();
}

/** Two workflows that are the same workflow with different parameters. */
export const duplicateWorkflows: Rule = (input, t) => {
  const out: Finding[] = [];
  const bags = input.workflows.map((wf) => ({ wf, steps: fingerprints(wf) }));
  for (let i = 0; i < bags.length; i++) {
    for (let j = i + 1; j < bags.length; j++) {
      const a = bags[i]!;
      const b = bags[j]!;
      if (Math.min(a.steps.size, b.steps.size) < 3) continue;
      const shared = [...a.steps.keys()].filter((f) => b.steps.has(f)).length;
      const union = a.steps.size + b.steps.size - shared;
      const similarity = shared / union;
      if (similarity < t.duplicateSimilarity) continue;
      const [x, y] = [a.wf.name, b.wf.name].sort();
      const params = differingParameters(a.steps, b.steps);
      out.push({
        rule: 'duplicate-workflows',
        severity: 'medium',
        key: `duplicate-workflows:${x}:${y}`,
        workflow: x!,
        title: `'${x}' and '${y}' are near-duplicates`,
        summary: `${x} and ${y} share ${pct(similarity)} of their steps (${shared} of ${union}). Two copies drift apart and have to be fixed twice.`,
        recommendation: params.length
          ? `Merge them into one parameterised workflow. The differences are ${params.slice(0, 5).join(', ')}${params.length > 5 ? '…' : ''} — make those inputs.`
          : `Merge them into one workflow; they do the same thing.`,
        evidence: {
          workflows: [x, y],
          similarity: round(similarity),
          sharedSteps: shared,
          differingParameters: params,
        },
      });
    }
  }
  return out;
};

// ---------------------------------------------------------------------- cost

const COST_ADVICE: Record<string, string> = {
  llm: 'Use a smaller model for this step, cache identical prompts, or lower the output token limit.',
  http: 'Cache responses, request only the fields you need, or run the workflow less often.',
  database: 'Add an index or narrow the query; batch statements instead of running them one by one.',
  notify: 'Batch notifications into a digest instead of sending one per event.',
};

export const costHotspots: Rule = (input, t) => {
  const out: Finding[] = [];
  const total = input.workflows.reduce((n, w) => n + w.runs.cost, 0);
  const withCost = input.workflows.filter((w) => w.runs.cost >= t.minCost);
  for (const wf of withCost) {
    const share = ratio(wf.runs.cost, total);
    if (withCost.length >= 2 && share >= t.costWorkflowShare) {
      out.push({
        rule: 'cost-hotspot',
        severity: 'medium',
        workflow: wf.name,
        key: `cost-hotspot:${wf.name}`,
        title: `'${wf.name}' accounts for ${pct(share)} of all cost`,
        summary: `${wf.name} used ${round(wf.runs.cost)} of ${round(total)} cost units over the last ${input.windowDays} days across ${wf.runs.total} runs.`,
        recommendation: `Look at how often it runs and which step dominates its cost before optimising anything else.`,
        evidence: { cost: round(wf.runs.cost), totalCost: round(total), share: round(share), runs: wf.runs.total },
      });
    }
    // A step being most of its *own* workflow's cost only matters if the workflow matters, and if there is a choice of steps.
    const meaningful =
      ratio(wf.runs.cost, total) >= 0.25 && [...wf.steps.values()].filter((s) => s.cost > 0).length >= 2;
    for (const s of wf.steps.values()) {
      if (!meaningful || ratio(s.cost, wf.runs.cost) < t.costStepShare) continue;
      const planStep = wf.plan.steps.find((p) => p.id === s.stepId);
      out.push({
        rule: 'cost-hotspot',
        severity: 'low',
        workflow: wf.name,
        stepId: s.stepId,
        key: `cost-hotspot:${wf.name}:${s.stepId}`,
        title: `Step '${s.stepId}' is ${pct(ratio(s.cost, wf.runs.cost))} of ${wf.name}'s cost`,
        summary: `${wf.name} › ${s.stepId} (${planStep ? capOf(planStep) : 'step'}) consumed ${round(s.cost)} of the workflow's ${round(wf.runs.cost)} cost units.`,
        recommendation:
          COST_ADVICE[planStep?.family ?? ''] ??
          'Reduce how often this step runs, or cache its result when inputs repeat.',
        evidence: { stepCost: round(s.cost), workflowCost: round(wf.runs.cost), family: planStep?.family ?? null },
      });
    }
  }
  return out;
};

// ----------------------------------------------------------------- approvals

export const approvalGates: Rule = (input, t) => {
  const out: Finding[] = [];
  for (const a of input.approvals) {
    const decided = a.approved + a.denied;
    const finished = decided + a.timedOut;
    const where = `${a.workflow} › ${a.stepId}`;
    if (a.denied === 0 && a.timedOut === 0 && a.approved >= t.rubberStampMinApprovals) {
      out.push({
        rule: 'approval-rubber-stamp',
        severity: 'low',
        workflow: a.workflow,
        stepId: a.stepId,
        key: `approval-rubber-stamp:${a.workflow}:${a.stepId}`,
        title: `Approval '${a.stepId}' was approved ${a.approved} times out of ${a.approved}`,
        summary: `${where} has never been denied${a.medianDecisionMs !== null ? ` and takes people about ${humanMs(a.medianDecisionMs)} to answer` : ''}. It may be adding delay without adding safety.`,
        recommendation: `Consider replacing the gate with a policy rule that only asks for approval in the risky cases (e.g. above a threshold), or with an autonomy tier.`,
        evidence: { approved: a.approved, medianDecisionMs: a.medianDecisionMs },
      });
    }
    if (finished >= t.minSamples && ratio(a.denied, finished) >= t.deniedRate) {
      out.push({
        rule: 'approval-often-denied',
        severity: 'medium',
        workflow: a.workflow,
        stepId: a.stepId,
        key: `approval-often-denied:${a.workflow}:${a.stepId}`,
        title: `Approval '${a.stepId}' is denied ${pct(ratio(a.denied, finished))} of the time`,
        summary: `${where} was denied ${a.denied} of ${finished} times. Work is being done, then thrown away at the gate.`,
        recommendation: `Add an earlier guard that rejects the cases approvers keep denying, so they never reach a person.`,
        evidence: { approved: a.approved, denied: a.denied, timedOut: a.timedOut },
      });
    }
    if (finished >= t.minSamples && ratio(a.timedOut, finished) >= t.timeoutRate) {
      out.push({
        rule: 'approval-timeouts',
        severity: 'medium',
        workflow: a.workflow,
        stepId: a.stepId,
        key: `approval-timeouts:${a.workflow}:${a.stepId}`,
        title: `Approval '${a.stepId}' times out ${pct(ratio(a.timedOut, finished))} of the time`,
        summary: `${where} went unanswered in ${a.timedOut} of ${finished} cases.`,
        recommendation: `Nobody is watching this gate. Route it to a team channel, add an escalation, or reconsider the timeout.`,
        evidence: { timedOut: a.timedOut, total: finished },
      });
    }
  }
  return out;
};

// -------------------------------------------------------------------- sunset

/** Shell steps are migration bridges (§11.4). Once their review date passes, they have become permanent. */
export const shellSunsets: Rule = (input, t) => {
  const out: Finding[] = [];
  const today = Date.parse(`${input.today}T00:00:00Z`);
  for (const wf of input.workflows) {
    for (const s of wf.plan.steps) {
      if (!s.sunset) continue;
      const due = Date.parse(`${s.sunset}T00:00:00Z`);
      if (Number.isNaN(due)) continue;
      const days = Math.round((due - today) / 86_400_000);
      if (days > t.sunsetWarnDays) continue;
      out.push({
        rule: 'shell-sunset',
        severity: days < 0 ? 'high' : 'medium',
        workflow: wf.name,
        stepId: s.id,
        key: `shell-sunset:${wf.name}:${s.id}`,
        title:
          days < 0
            ? `Shell step '${s.id}' is ${-days} days past its sunset date`
            : `Shell step '${s.id}' reaches its sunset date in ${days} days`,
        summary: `${wf.name} › ${s.id} was meant to be replaced by ${s.sunset}. Temporary bridges that outlive their date become permanent.`,
        recommendation: `Replace it with a typed capability, or renew the sunset date with a written justification.`,
        evidence: { sunset: s.sunset, daysRemaining: days, capability: capOf(s) },
      });
    }
  }
  return out;
};

// ------------------------------------------------------------------ timing

/** Scheduled runs that start late, and runs that wait too long for a slot. */
export const timing: Rule = (input, t) => {
  const out: Finding[] = [];
  const lagByWorkflow = new Map<string, number[]>();
  const waits: number[] = [];
  const waitByWorkflow = new Map<string, number[]>();
  for (const r of input.timings) {
    const created = parseMs(r.createdAt);
    const started = parseMs(r.startedAt);
    if (started !== undefined && created !== undefined) {
      waits.push(started - created);
      waitByWorkflow.set(r.workflow, [...(waitByWorkflow.get(r.workflow) ?? []), started - created]);
    }
    const scheduled = parseMs(r.scheduledFor);
    if (started !== undefined && scheduled !== undefined)
      lagByWorkflow.set(r.workflow, [...(lagByWorkflow.get(r.workflow) ?? []), Math.max(0, started - scheduled)]);
  }
  for (const [workflow, lags] of [...lagByWorkflow].sort()) {
    const p95 = percentile(lags, 95)!;
    if (lags.length < 5 || p95 < t.scheduleDriftP95Ms) continue;
    out.push({
      rule: 'schedule-drift',
      severity: p95 >= t.scheduleDriftP95Ms * 5 ? 'high' : 'medium',
      workflow,
      key: `schedule-drift:${workflow}`,
      title: `'${workflow}' starts ${humanMs(p95)} late (p95)`,
      summary: `Across ${lags.length} scheduled runs, the slowest 5% started ${humanMs(p95)} or more after their scheduled time.`,
      recommendation: `The scheduler is saturated or the workflow is starved by higher-priority work. Raise OMNIFLOW_MAX_CONCURRENT_RUNS, stagger competing schedules, or give this workflow a higher priority.`,
      evidence: { samples: lags.length, p50Ms: percentile(lags, 50), p95Ms: p95 },
    });
  }
  const p95 = percentile(waits, 95);
  if (waits.length >= 20 && p95 !== undefined && p95 >= t.queueWaitP95Ms) {
    const worst = [...waitByWorkflow]
      .map(([w, v]) => ({ workflow: w, p95Ms: percentile(v, 95)! }))
      .sort((a, b) => b.p95Ms - a.p95Ms)
      .slice(0, 3);
    out.push({
      rule: 'queue-starvation',
      severity: 'medium',
      key: 'queue-starvation',
      title: `Runs wait ${humanMs(p95)} for a slot (p95)`,
      summary: `Across ${waits.length} runs the slowest 5% waited ${humanMs(p95)} or more in the queue before starting.`,
      recommendation: `Capacity is the bottleneck. Raise OMNIFLOW_MAX_CONCURRENT_RUNS if the host has headroom, or cap concurrency on the workflows that flood the queue.`,
      evidence: { samples: waits.length, p50Ms: percentile(waits, 50), p95Ms: p95, worst },
    });
  }
  return out;
};

// ------------------------------------------------------------------- hygiene

/** Compensation that has never been exercised is a hope, not a control (risk R8). */
export const unexercisedCompensation: Rule = (input, t) => {
  const out: Finding[] = [];
  for (const wf of input.workflows) {
    const compensable = wf.plan.steps.filter((s) => s.compensate);
    if (compensable.length === 0 || wf.runs.total < t.compensationMinRuns) continue;
    const exercised = compensable.some(
      (s) => (wf.steps.get(s.id)?.compensated ?? 0) + (wf.steps.get(s.id)?.compensationFailed ?? 0) > 0,
    );
    if (exercised) continue;
    out.push({
      rule: 'unexercised-compensation',
      severity: 'info',
      workflow: wf.name,
      key: `unexercised-compensation:${wf.name}`,
      title: `Compensation in '${wf.name}' has never run`,
      summary: `${wf.name} declares compensation for ${compensable.map((s) => `'${s.id}'`).join(', ')}, but none has run in ${wf.runs.total} runs. Rollback that has never been exercised may not work when it is needed.`,
      recommendation: `Rehearse it: run the workflow in staging with a failure injected after the compensable step and confirm the rollback does what you expect.`,
      evidence: { compensableSteps: compensable.map((s) => s.id), runs: wf.runs.total },
    });
  }
  return out;
};

/** A scheduled workflow that stopped running has a broken trigger, or is abandoned. */
export const idleWorkflows: Rule = (input) => {
  const out: Finding[] = [];
  const now = Date.parse(input.now);
  for (const wf of input.workflows) {
    if (!wf.enabled || wf.killed || wf.runs.total > 0) continue;
    if (!wf.plan.triggers.some((tr) => tr.type === 'schedule')) continue;
    const since = parseMs(wf.activeSince);
    if (since === undefined || now - since < (input.windowDays / 2) * 86_400_000) continue;
    out.push({
      rule: 'idle-workflow',
      severity: 'medium',
      workflow: wf.name,
      key: `idle-workflow:${wf.name}`,
      title: `Scheduled workflow '${wf.name}' has not run in ${input.windowDays} days`,
      summary: `${wf.name} is enabled and has a schedule, but produced no runs in the last ${input.windowDays} days.`,
      recommendation: `Check the schedule expression and that the trigger is registered. If the workflow is no longer needed, disable it.`,
      evidence: { activeSince: wf.activeSince ?? null },
    });
  }
  return out;
};

export const ALL_RULES: Array<{ id: string; run: Rule }> = [
  { id: 'ignored-failure', run: ignoredFailures },
  { id: 'failing-step', run: failingSteps },
  { id: 'dead-step', run: deadSteps },
  { id: 'retry-storm', run: retryStorms },
  { id: 'duplicate-workflows', run: duplicateWorkflows },
  { id: 'cost-hotspot', run: costHotspots },
  { id: 'approval-gates', run: approvalGates },
  { id: 'shell-sunset', run: shellSunsets },
  { id: 'timing', run: timing },
  { id: 'unexercised-compensation', run: unexercisedCompensation },
  { id: 'idle-workflow', run: idleWorkflows },
];

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2, info: 3 } as const;

/** Run every rule; order the result most severe first, then by key, so output is stable. */
export function analyse(input: AnalysisInput, t: Thresholds): Finding[] {
  return ALL_RULES.flatMap((r) => r.run(input, t)).sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.key.localeCompare(b.key),
  );
}

function topError(wf: WorkflowFacts, stepId: string): string {
  const top = wf.errors.get(stepId)?.[0];
  return top ? ` (most often ${top.code})` : '';
}
