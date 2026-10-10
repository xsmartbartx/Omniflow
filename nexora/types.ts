import type { NexoraPlan, NexoraRole, OutboxKind } from '../state/index.ts';

/**
 * The three ways OmniFlow talks to NEXORA Core (architecture D4). NEXORA has not published the wire
 * format of these contracts yet (its ADR-0010 is Proposed), so everything here is OmniFlow's own port:
 * a real HTTP client can implement it later without touching callers.
 */

/** C-AUTH: who is calling, and for which organisation. */
export interface VerifiedIdentity {
  orgId: string;
  userId: string;
  email: string;
  name: string;
  role: NexoraRole;
}
export interface IdentityPort {
  /** Verify a NEXORA identity assertion. Throws `AuthenticationError` when it is not valid. */
  verifyAssertion(assertion: string): Promise<VerifiedIdentity>;
}

/** C-ENT: may this organisation do this, and how much is left. */
export type EntitlementAction = 'run.start';
export interface EntitlementDecision {
  allowed: boolean;
  /** Units left this period; null = unlimited. */
  remaining: number | null;
  /** Units in the plan; null = unlimited. */
  limit: number | null;
  plan: NexoraPlan;
  /** Optional lifecycle flag from Core for the whole org. */
  orgStatus?: 'active' | 'suspended' | 'disabled';
}
export interface EntitlementPort {
  check(orgId: string, action: EntitlementAction): Promise<EntitlementDecision>;
}

/** C-EVENT: usage, audit and health reports. The id is the idempotency key; Core must dedupe on it. */
export interface CoreEvent {
  id: string;
  kind: OutboxKind;
  name: string;
  orgId: string;
  occurredAt: string;
  correlationId?: string;
  payload: Record<string, unknown>;
}
export interface EventPort {
  send(event: CoreEvent): Promise<void>;
}

export interface CorePorts {
  identity: IdentityPort;
  entitlements: EntitlementPort;
  events: EventPort;
}
