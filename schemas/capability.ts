import type { ErrorClass, JsonObject, Sensitivity } from '../core/index.ts';

/**
 * Capability contract (architecture §7, ADR-0002 D3) — the public extension point and the only
 * path from the engine to anything external.
 */

/** `pure` has no external effect; `idempotent` may be repeated safely; `effectful` needs an idempotency key. */
export type EffectClass = 'pure' | 'idempotent' | 'effectful';

export type EgressSpec =
  /** No network access at all. */
  | { mode: 'none' }
  /** Fixed allow-list baked into the capability. */
  | { mode: 'static'; hosts: string[] }
  /** The step must declare its own allow-list (`egress:`), and the runtime enforces it. */
  | { mode: 'step' };

export interface FailureMode {
  code: string;
  class: ErrorClass;
  retryable: boolean;
  description?: string;
}

export interface CostModel {
  /** Abstract cost units per invocation — monetary, rate-limit tokens, or whatever the operator chooses. */
  unitsPerInvocation: number;
  latencyClass: 'instant' | 'fast' | 'slow' | 'very-slow';
}

export interface CapabilityDeclaration {
  /** kebab-case. */
  name: string;
  /** Semver. */
  version: string;
  description: string;
  /** Adapter family: http, shell, database, storage, notification, llm, util … */
  family: string;
  inputSchema: JsonObject;
  outputSchema: JsonObject;
  effect: EffectClass;
  /** Permissions the adapter needs. The Secret Broker issues only these. */
  scopes: string[];
  egress: EgressSpec;
  costModel: CostModel;
  failureModes: FailureMode[];
  /** `name@constraint` of the capability that reverses this one. */
  compensation?: string;
  /** Highest sensitivity of data this capability may handle. */
  dataClassification: Sensitivity;
  /**
   * How the adapter behaves when a run is a dry run: `simulate` suppresses the external effect and
   * returns a typed synthetic output; `execute` performs the operation because it is read-only.
   * Every capability MUST declare one (ADR-0002 D3).
   */
  dryRun: 'simulate' | 'execute';
  /** Regions in which the capability may operate; used for data-residency checks. */
  regions?: string[];
}

export interface Lease {
  readonly id: string;
  /** Resolve a secret the step was granted. Throws if not granted or revoked. */
  get(name: string): string;
  has(name: string): boolean;
}

/** Everything an adapter may know about the invocation it is serving. */
export interface CapabilityContext {
  tenant: string;
  runId: string;
  stepId: string;
  attempt: number;
  dryRun: boolean;
  /** Stable key for effectful invocations; adapters pass it to the external system where supported. */
  idempotencyKey?: string;
  /** Hosts this step declared for `egress: step`. */
  egress: string[];
  /** Aborted on timeout or run cancellation. Adapters MUST honour it. */
  signal: AbortSignal;
  /** Secret lease for this step only. */
  lease: Lease;
  /** The run's seeded generator output for anything that needs "randomness". */
  seed: string;
  /** Run start time (`context.now`). */
  now: string;
  log: (msg: string, fields?: Record<string, unknown>) => void;
}

/** A typed failure an adapter reports; maps onto one of the declared failure modes. */
export interface CapabilityFailure {
  code: string;
  class: ErrorClass;
  retryable?: boolean;
  message: string;
  details?: Record<string, unknown>;
}
