import type { ErrorInfo } from '../../core/index.ts';
import type { Plan, PlanStep } from '../../schemas/plan.ts';

/**
 * The boundary between the Orchestrator and the Step Runtime. The Orchestrator owns the run state
 * machine and never calls an external system (ADR-0002 D6); everything that could touch the
 * outside world sits behind this port and is injected at the composition root.
 */

export interface StepAttempt {
  tenant: string;
  runId: string;
  workflow: string;
  plan: Plan;
  step: PlanStep;
  attempt: number;
  /** Expression scope: inputs, context, steps, run. Secrets are NOT here — the runtime resolves them from a lease. */
  scope: Record<string, unknown>;
  dryRun: boolean;
  seed: string;
  /** Run start time (`context.now`). */
  now: string;
  /** Aborted on cancellation or when the step is superseded. */
  signal: AbortSignal;
}

export type StepResult =
  | {
      kind: 'succeeded';
      output: unknown;
      cost: number;
      durationMs: number;
      replayed?: boolean;
      simulated?: boolean;
    }
  | { kind: 'failed'; error: ErrorInfo; durationMs: number; phase: string }
  /** Not attempted (circuit open, idempotency key busy…). Does not consume an attempt. */
  | { kind: 'deferred'; reason: string; retryAfterMs: number };

export interface StepExecutor {
  /** Execute one attempt of a `capability` step. */
  executeCapability(a: StepAttempt): Promise<StepResult>;
  /** Execute a whole `map` step (bounded concurrency, per-item retries, error tolerance). */
  executeMap(a: StepAttempt): Promise<StepResult>;
  /** Run the compensation of a completed step, with its own retries. */
  executeCompensation(a: StepAttempt): Promise<StepResult>;
}

export interface OrchestratorConfig {
  /** Maximum step executions in flight across every run. */
  maxConcurrentSteps: number;
  /** Timer/approval polling interval. */
  tickMs: number;
  /** Step outputs larger than this are stored as artifacts and referenced by hash. */
  inlineOutputLimit: number;
}

export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  maxConcurrentSteps: 32,
  tickMs: 250,
  inlineOutputLimit: 256 * 1024,
};
