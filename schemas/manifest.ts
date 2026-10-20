import type { ErrorClass, JsonObject, JsonValue, Sensitivity } from '../core/index.ts';

/**
 * Workflow manifest — the declarative artifact of ADR-0002 D1. A manifest is data, never code.
 * Everything not described here is a validation error (architecture §6.2).
 */

export const API_VERSION = 'omniflow.dev/v1' as const;

export type Criticality = 'low' | 'medium' | 'high' | 'critical';
export type Duration = string | number;

export interface Metadata {
  /** kebab-case workflow name. */
  name: string;
  /** Semver. Published versions are immutable. */
  version: string;
  owner: string;
  team?: string;
  description?: string;
  labels?: Record<string, string>;
  criticality?: Criticality;
}

// ---------------------------------------------------------------- triggers
export interface ManualTrigger {
  type: 'manual';
  name?: string;
  description?: string;
}
export interface ScheduleTrigger {
  type: 'schedule';
  name?: string;
  /** Standard 5-field cron (or 6 with seconds). */
  cron: string;
  timezone?: string;
  /** Static input values for scheduled runs. */
  inputs?: JsonObject;
  /** What to do about firings missed while the engine was down. */
  catchup?: 'none' | 'latest';
}
export interface WebhookTrigger {
  type: 'webhook';
  name: string;
  /** Map workflow inputs from `event.payload` with templates. Defaults to using the payload as-is. */
  inputs?: JsonObject;
}
export interface EventTrigger {
  type: 'event';
  /** Event type this trigger subscribes to, e.g. `order.created`. */
  event: string;
  name?: string;
  /** Bare expression over `event`; the trigger fires only when it is truthy. */
  filter?: string;
  inputs?: JsonObject;
}
export interface WorkflowCompletionTrigger {
  type: 'workflow-completion';
  workflow: string;
  status?: 'succeeded' | 'failed' | 'any';
  name?: string;
  inputs?: JsonObject;
}
export type Trigger = ManualTrigger | ScheduleTrigger | WebhookTrigger | EventTrigger | WorkflowCompletionTrigger;

// ------------------------------------------------------------------ inputs
export type InputType = 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array';

export interface InputSpec {
  type: InputType;
  description?: string;
  required?: boolean;
  default?: JsonValue;
  enum?: JsonValue[];
  pattern?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  items?: JsonObject;
  properties?: JsonObject;
  sensitivity?: Sensitivity;
}

// ------------------------------------------------------------------- steps
export interface RetryPolicy {
  /** Total attempts including the first. */
  attempts: number;
  backoff?: 'fixed' | 'exponential';
  initialDelay?: Duration;
  maxDelay?: Duration;
  /** 0..1 fraction of the delay randomised — from the run's seeded generator, so replay is stable. */
  jitter?: number;
  /** Error classes that may be retried. Default: transient, systemic. */
  retryOn?: ErrorClass[];
}

export type OnError = 'fail' | 'continue' | 'compensate' | { routeTo: string };

export interface CompensateSpec {
  uses: string;
  with?: JsonObject;
  idempotencyKey?: string;
  timeout?: Duration;
}

interface StepBase {
  /** kebab-case, unique, stable across versions. Renaming an id is a breaking change. */
  id: string;
  name?: string;
  description?: string;
  dependsOn?: string[];
  /** Bare expression evaluated once at dispatch. */
  when?: string;
  timeout?: Duration;
  retry?: RetryPolicy;
  /** Template producing a stable key. Required for effectful capabilities. */
  idempotencyKey?: string;
  compensate?: CompensateSpec;
  onError?: OnError;
  /** JSON Schema of this step's output; downstream references are verified against it. */
  produces?: JsonObject;
  sensitivity?: Sensitivity;
}

export interface CapabilityStep extends StepBase {
  type: 'capability';
  /** `name@constraint`, e.g. `http-get@^1`. */
  uses: string;
  with?: JsonObject;
  /** Hosts this step may reach, for capabilities whose egress is declared by the step. */
  egress?: string[];
  /** Review-by date (ISO) — mandatory for shell steps so migration bridges cannot become permanent. */
  sunset?: string;
}

export interface BranchStep extends StepBase {
  type: 'branch';
  cases: Array<{ name: string; when: string }>;
  /** Name emitted when no case matches. A branch without a default must have an always-true final case. */
  default?: string;
}

export interface ParallelStep extends StepBase {
  type: 'parallel';
  /** `all`: wait for every dependency. `any`: complete on the first success and cancel the rest. */
  join: 'all' | 'any';
}

export interface MapStep extends StepBase {
  type: 'map';
  /** Bare expression yielding the array to fan out over. */
  items: string;
  /** Hard upper bound on collection size, enforced at run time and checked against platform limits at compile time. */
  maxItems: number;
  concurrency?: number;
  /** How many item failures are tolerated before the step fails. */
  errorTolerance?: { count?: number; percent?: number };
  uses: string;
  with?: JsonObject;
  egress?: string[];
  sunset?: string;
}

export interface ApprovalStep extends StepBase {
  type: 'approval';
  message: string;
  approvers?: { roles?: string[]; users?: string[] };
  timeout: Duration;
  onTimeout: 'deny' | 'escalate' | 'approve';
  /** Required when `onTimeout: approve`. */
  justification?: string;
  allowSelfApproval?: boolean;
}

export interface WaitStep extends StepBase {
  type: 'wait';
  duration?: Duration;
  until?: { event: string; correlation?: string };
}

export interface SubworkflowStep extends StepBase {
  type: 'subworkflow';
  workflow: string;
  /** Exact semver — subworkflows are always version-pinned. */
  version: string;
  with?: JsonObject;
}

export interface TerminateStep extends StepBase {
  type: 'terminate';
  status: 'success' | 'failure';
  errorClass?: ErrorClass;
  message?: string;
}

export type Step =
  | CapabilityStep
  | BranchStep
  | ParallelStep
  | MapStep
  | ApprovalStep
  | WaitStep
  | SubworkflowStep
  | TerminateStep;

export type StepType = Step['type'];
export const STEP_TYPES: readonly StepType[] = [
  'capability',
  'branch',
  'parallel',
  'map',
  'approval',
  'wait',
  'subworkflow',
  'terminate',
];

// ------------------------------------------------------------ rest of doc
export interface Guard {
  name: string;
  /** Bare expression that must be truthy. */
  expr: string;
  message?: string;
}

export interface Guards {
  /** Checked before the run starts; scope: inputs, context. */
  pre?: Guard[];
  /** Checked after every step completes; scope adds steps. A violation fails the run. */
  invariants?: Guard[];
}

export interface WorkflowPolicy {
  /** Default per-step timeout the compiler injects when a step omits one. */
  timeout?: Duration;
  /** Default retry policy the compiler injects into steps that omit one. */
  retry?: RetryPolicy;
  /** Maximum simultaneous runs of this workflow. */
  concurrency?: number;
  /** What to do with a run that would exceed `concurrency`. */
  concurrencyPolicy?: 'queue' | 'skip';
  maxParallelSteps?: number;
  dataResidency?: string[];
  maxRunCost?: number;
  maxDailyCost?: number;
  dedupWindow?: Duration;
  /** Template over `inputs` — a run with an equal key inside the window is a duplicate. */
  dedupKey?: string;
}

export interface Observability {
  slo?: { successRate?: number; p95Duration?: Duration };
  alerts?: {
    onFailure?: string[];
    onCompensationFailed?: string[];
    onApprovalRequested?: string[];
  };
  metrics?: Array<{ name: string; value: string; unit?: string }>;
}

export interface Manifest {
  apiVersion: typeof API_VERSION;
  kind: 'Workflow';
  metadata: Metadata;
  triggers: Trigger[];
  inputs: Record<string, InputSpec>;
  context?: JsonObject;
  steps: Step[];
  guards?: Guards;
  outputs?: JsonObject;
  policy?: WorkflowPolicy;
  observability?: Observability;
}

export const RESERVED_CONTEXT_KEYS: readonly string[] = ['now', 'environment', 'tenant'];
export const RUN_SCOPE_KEYS: readonly string[] = ['id', 'seed', 'dryRun', 'trigger', 'workflow', 'version'];
export const STEP_OUTPUT_KEYS: readonly string[] = ['output', 'status', 'error'];
