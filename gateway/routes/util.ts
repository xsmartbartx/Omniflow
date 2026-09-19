import { NotFoundError } from '../../core/index.ts';
import type { Plan, PlanStep, Principal } from '../../schemas/index.ts';
import type { RunRecord, StepRecord } from '../../state/index.ts';
import type { Omniflow } from '../context.ts';

export const name = { type: 'string', pattern: '^[a-z][a-z0-9]*(-[a-z0-9]+)*$', maxLength: 64 } as const;
export const id = { type: 'string', minLength: 1, maxLength: 128 } as const;
export const limitQ = { type: 'integer', minimum: 1, maximum: 500, default: 50 } as const;

export const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

/** Compact run representation for lists and dashboards. */
export function runSummary(r: RunRecord) {
  return {
    id: r.id,
    workflow: r.workflowName,
    version: r.workflowVersion,
    status: r.status,
    dryRun: r.dryRun,
    canary: r.canary,
    trigger: { type: r.triggerType, ...(r.triggerName ? { name: r.triggerName } : {}) },
    requestedBy: { id: r.requestedBy.id, name: r.requestedBy.name },
    createdAt: r.createdAt,
    startedAt: r.startedAt ?? null,
    finishedAt: r.finishedAt ?? null,
    durationMs: r.startedAt && r.finishedAt ? Date.parse(r.finishedAt) - Date.parse(r.startedAt) : null,
    cost: r.cost,
    error: r.error ?? null,
    parentRunId: r.parentRunId ?? null,
    correlationId: r.correlationId ?? null,
  };
}

const CONFIDENTIAL = new Set(['confidential', 'secret']);

/** A step as shown to a person: plan metadata plus state. Confidential outputs are withheld from listings. */
export function stepView(_plan: Plan | undefined, rec: StepRecord, ps: PlanStep | undefined) {
  const hidden = ps !== undefined && CONFIDENTIAL.has(ps.sensitivity) && rec.output !== undefined;
  return {
    id: rec.stepId,
    type: ps?.type ?? 'unknown',
    name: ps?.name ?? null,
    capability: ps?.capability ? `${ps.capability.name}@${ps.capability.version}` : null,
    effect: ps?.effect ?? null,
    dependsOn: ps?.dependsOn ?? [],
    order: ps?.order ?? 0,
    status: rec.status,
    attempt: rec.attempt,
    maxAttempts: ps?.retry?.attempts ?? 1,
    timeoutMs: ps?.timeoutMs ?? null,
    startedAt: rec.startedAt ?? null,
    finishedAt: rec.finishedAt ?? null,
    durationMs: rec.startedAt && rec.finishedAt ? Date.parse(rec.finishedAt) - Date.parse(rec.startedAt) : null,
    wakeAt: rec.wakeAt ?? null,
    output: hidden ? { redacted: true, sensitivity: ps!.sensitivity } : previewOutput(rec.output),
    outputRef: rec.outputRef ?? null,
    error: rec.error ?? null,
    skippedReason: rec.skippedReason ?? null,
    handled: rec.handled ?? null,
    approvalId: rec.approvalId ?? null,
    childRunId: rec.childRunId ?? null,
    waitEvent: rec.waitEvent ?? null,
    compensation: ps?.compensate ? { status: rec.compensationStatus ?? null, error: rec.compensationError ?? null, capability: ps.compensate.capability.name } : null,
    cost: rec.cost,
  };
}

function previewOutput(v: unknown): unknown {
  if (v === undefined) return null;
  const json = JSON.stringify(v);
  return json.length > 20_000 ? { truncated: true, size: json.length } : v;
}

export function mustRun(app: Omniflow, principal: Principal, runId: string): RunRecord {
  const run = app.state.runs.getRun(runId, principal.tenant);
  if (!run) throw new NotFoundError('Run', runId);
  return run;
}

export function planOf(app: Omniflow, run: RunRecord): Plan | undefined {
  return app.state.registry.getPlan(run.tenant, run.planHash);
}

export function csv(v: unknown): string[] | undefined {
  return typeof v === 'string' && v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
}
