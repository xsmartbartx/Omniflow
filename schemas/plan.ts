import type { ErrorClass, JsonObject, Sensitivity } from '../core/index.ts';
import type { EffectClass } from './capability.ts';
import type { Guard, InputSpec, Metadata, Observability, OnError, StepType, Trigger } from './manifest.ts';

/**
 * Execution plan — the immutable, content-addressed output of the (pure) Compiler
 * (ADR-0002 D2). Everything a run needs is resolved here: capability versions, defaults, durations
 * in milliseconds, topological order. The plan hash is recorded on every run.
 */

export const PLAN_VERSION = 1 as const;

export interface PlanCapabilityRef {
  name: string;
  /** Exact resolved version. */
  version: string;
  /** Content hash of the declaration that was resolved. */
  hash: string;
}

export interface PlanRetry {
  attempts: number;
  backoff: 'fixed' | 'exponential';
  initialDelayMs: number;
  maxDelayMs: number;
  jitter: number;
  retryOn: ErrorClass[];
}

export interface PlanCompensation {
  capability: PlanCapabilityRef;
  with: JsonObject;
  idempotencyKey?: string;
  timeoutMs: number;
  egress: string[];
}

export interface PlanStep {
  id: string;
  type: StepType;
  name?: string;
  /** Position in the deterministic topological order. */
  order: number;
  /** Normalised (sorted, de-duplicated). */
  dependsOn: string[];
  when?: string;
  timeoutMs: number;
  retry?: PlanRetry;
  idempotencyKey?: string;
  onError: OnError;
  sensitivity: Sensitivity;
  produces?: JsonObject;

  // capability + map
  capability?: PlanCapabilityRef;
  effect?: EffectClass;
  with?: JsonObject;
  egress?: string[];
  sunset?: string;
  compensate?: PlanCompensation;

  // branch
  cases?: Array<{ name: string; when: string }>;
  default?: string;

  // parallel
  join?: 'all' | 'any';

  // map
  items?: string;
  maxItems?: number;
  concurrency?: number;
  errorTolerance?: { count?: number; percent?: number };

  // approval
  message?: string;
  approvers?: { roles: string[]; users: string[] };
  onTimeout?: 'deny' | 'escalate' | 'approve';
  justification?: string;
  allowSelfApproval?: boolean;

  // wait
  durationMs?: number;
  until?: { event: string; correlation?: string };

  // subworkflow
  workflow?: string;
  version?: string;
  /** Hash of the child plan resolved at compile time. */
  childPlanHash?: string;

  // terminate
  status?: 'success' | 'failure';
  errorClass?: ErrorClass;
}

export interface PlanPolicy {
  timeoutMs: number;
  concurrency: number;
  concurrencyPolicy: 'queue' | 'skip';
  maxParallelSteps: number;
  dataResidency: string[];
  maxRunCost?: number;
  maxDailyCost?: number;
  dedupWindowMs?: number;
  dedupKey?: string;
}

export interface PlanAnalysis {
  stepCount: number;
  /** Longest dependency chain. */
  depth: number;
  effects: Record<EffectClass, number>;
  /** Union of every capability scope the plan needs (cumulative-scope analysis input). */
  scopes: string[];
  /** Union of every egress host any step may reach. */
  egress: string[];
  /** `name@version` of every capability used. */
  capabilities: string[];
  /** Largest fan-out any single step may produce. */
  maxFanOut: number;
  /** Upper bound on capability invocations in one run, single attempt. */
  maxInvocations: number;
  subworkflowDepth: number;
  /** Names of every workflow transitively invoked. */
  subworkflowChain: string[];
  families: string[];
  hasApproval: boolean;
  hasCompensation: boolean;
  /** Highest data sensitivity flowing through the plan. */
  maxSensitivity: Sensitivity;
  /** Cost units of one run, single attempt, all fan-out at maximum. */
  estimatedCost: number;
  /** As `estimatedCost` but assuming every retry attempt is consumed. */
  maxCost: number;
}

export interface Plan {
  planVersion: typeof PLAN_VERSION;
  workflow: Pick<Metadata, 'name' | 'version' | 'owner' | 'team' | 'description' | 'labels'> & {
    criticality: NonNullable<Metadata['criticality']>;
  };
  environment: string;
  /** Content hash of the source manifest. */
  sourceHash: string;
  triggers: Trigger[];
  inputs: Record<string, InputSpec>;
  inputSchema: JsonObject;
  /** Static context merged from the manifest and the deployment (never includes `now`). */
  context: JsonObject;
  steps: PlanStep[];
  guards: { pre: Guard[]; invariants: Guard[] };
  outputs: JsonObject;
  policy: PlanPolicy;
  observability: Observability;
  capabilities: Record<string, PlanCapabilityRef>;
  subworkflows: Record<string, { version: string; planHash: string }>;
  analysis: PlanAnalysis;
}
