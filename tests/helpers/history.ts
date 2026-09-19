import { stringify } from 'yaml';
import { createDefaultRegistry } from '../../capabilities/index.ts';
import type { ErrorInfo } from '../../core/index.ts';
import { contentHash } from '../../core/index.ts';
import { compile } from '../../orchestration/compiler/index.ts';
import type { Plan } from '../../schemas/index.ts';
import type { State, StepPatch } from '../../state/index.ts';
import { defaultAdapterConfig } from '../../capabilities/index.ts';
import type { ManualClock } from '../../core/index.ts';
import { principal } from './state.ts';

const caps = createDefaultRegistry(defaultAdapterConfig());

export const manifestOf = (name: string, steps: unknown[], extra: Record<string, unknown> = {}, version = '1.0.0') => ({
  apiVersion: 'omniflow.dev/v1',
  kind: 'Workflow',
  metadata: { name, version, owner: 'ops@example.com', description: 'history fixture', criticality: 'low' },
  triggers: [{ type: 'manual' }],
  inputs: {},
  steps,
  ...extra,
});

export const echo = (id: string, value: unknown = 1, extra: Record<string, unknown> = {}) => ({ id, type: 'capability', uses: 'util-echo@^1', with: { value }, ...extra });

export function compileWf(name: string, steps: unknown[], extra: Record<string, unknown> = {}): { plan: Plan; hash: string; text: string } {
  const text = stringify(manifestOf(name, steps, extra));
  const r = compile(text, { environment: 'production', capabilities: caps, today: '2026-06-01' });
  if (!r.ok || !r.plan || !r.hash) throw new Error(`fixture does not compile: ${JSON.stringify(r.errors)}`);
  return { plan: r.plan, hash: r.hash, text };
}

/** Publish a compiled workflow straight into the registry store and make it stable. */
export function publish(state: State, name: string, steps: unknown[], extra: Record<string, unknown> = {}, mutate?: (p: Plan) => void): Plan {
  const { plan, hash, text } = compileWf(name, steps, extra);
  mutate?.(plan);
  state.registry.insertVersion({ tenant: 'default', name, version: '1.0.0', manifestText: text, manifestHash: contentHash(text), planHash: hash, plan, environment: 'production', publishedBy: 'test' });
  state.registry.patchSettings('default', name, { stableVersion: '1.0.0' }, 'test');
  return plan;
}

export interface RunSpec {
  workflow: string;
  status?: 'succeeded' | 'failed' | 'cancelled' | 'running' | 'queued';
  /** Milliseconds after the (manual) clock's current time at which the run was created. */
  stepIds?: string[];
  steps?: Record<string, StepPatch & { error?: ErrorInfo }>;
  cost?: number;
  trigger?: { type: string; payload?: unknown };
  /** ms the run waits in the queue before starting. */
  queueMs?: number;
  /** ms the run takes once started. */
  durationMs?: number;
  dryRun?: boolean;
  error?: ErrorInfo;
}

/** Record a finished run as though it had happened at the state clock's current time. */
export function addRun(state: State & { clock: ManualClock }, spec: RunSpec): string {
  const stepIds = spec.stepIds ?? Object.keys(spec.steps ?? {});
  const run = state.runs.createRun({
    tenant: 'default',
    workflowName: spec.workflow,
    workflowVersion: '1.0.0',
    planHash: 'sha256:fixture',
    stepIds,
    dryRun: spec.dryRun ?? false,
    environment: 'production',
    triggerType: spec.trigger?.type ?? 'manual',
    ...(spec.trigger?.payload !== undefined ? { triggerPayload: spec.trigger.payload } : {}),
    inputs: {},
    requestedBy: principal(),
  });
  const status = spec.status ?? 'succeeded';
  if (status === 'queued') return run.id;
  state.clock.advance(spec.queueMs ?? 0);
  state.runs.transition(run.id, 'running');
  for (const [id, patch] of Object.entries(spec.steps ?? {})) state.runs.patchStep(run.id, id, patch);
  if (spec.cost) state.runs.patchRun(run.id, { cost: spec.cost });
  if (status === 'running') return run.id;
  state.clock.advance(spec.durationMs ?? 1000);
  state.runs.transition(run.id, status, status === 'failed' ? { error: spec.error ?? { code: 'BOOM', message: 'boom', class: 'systemic', retryable: false } } : {});
  return run.id;
}

export const ok = (extra: StepPatch = {}): StepPatch => ({ status: 'succeeded', attempt: 1, ...extra });
export const bad = (code = 'HTTP_500', cls: ErrorInfo['class'] = 'transient', extra: StepPatch = {}): StepPatch => ({
  status: 'failed',
  attempt: 1,
  error: { code, message: `${code} happened`, class: cls, retryable: false },
  ...extra,
});
export const skipped = (): StepPatch => ({ status: 'skipped', skippedReason: 'when false' });
