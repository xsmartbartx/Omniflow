import type { ErrorOptions } from '../../core/index.ts';
import { OmniflowError } from '../../core/index.ts';
import type { CapabilityContext, CapabilityDeclaration } from '../../schemas/index.ts';

/**
 * An adapter is the implementation of one capability — the only component permitted to touch an
 * external system. One adapter, one external system. No business logic, no orchestration.
 */
export interface CapabilityAdapter<I = any, O = any> {
  declaration: CapabilityDeclaration;
  /** Perform the operation. MUST honour `ctx.signal` and never log secret values. */
  execute(ctx: CapabilityContext, input: I): Promise<O>;
  /**
   * Optional hand-written synthetic output for dry runs. When absent the runtime derives a valid
   * example from `outputSchema`. Only consulted for capabilities that declare `dryRun: 'simulate'`.
   */
  simulate?(ctx: CapabilityContext, input: I): Promise<O> | O;
}

/** Failure raised by an adapter. Classified so the Orchestrator never has to guess (§12.2). */
export class CapabilityError extends OmniflowError {
  constructor(code: string, message: string, options: ErrorOptions = {}) {
    super(code, message, options);
  }
}

export interface CapabilityRegistration {
  /** Named owner (required to register a production capability). */
  owner: string;
  source: 'builtin' | 'declarative' | 'plugin';
}

export interface RegisteredCapability {
  adapter: CapabilityAdapter;
  declaration: CapabilityDeclaration;
  /** Content hash of the declaration; recorded in every plan that resolves to this capability. */
  hash: string;
  registration: CapabilityRegistration;
}

/** Identity helper that gives adapter authors full type inference. */
export function defineCapability<I, O>(adapter: CapabilityAdapter<I, O>): CapabilityAdapter<I, O> {
  return adapter;
}
