import { AuthenticationError } from '../core/index.ts';
import type { NexoraPlan, NexoraRole } from '../state/index.ts';
import { PLACEHOLDER_RUN_LIMITS } from './plans.ts';
import type { CoreEvent, CorePorts, EntitlementAction, EntitlementDecision, VerifiedIdentity } from './types.ts';

const ROLES: readonly NexoraRole[] = ['owner', 'admin', 'member', 'billing', 'viewer'];

/** Fake assertions are `fake.<base64url(json)>`: UNSIGNED, for development and tests only. */
export function fakeAssertion(i: {
  orgId: string;
  userId: string;
  email: string;
  name?: string;
  role: NexoraRole;
}): string {
  return `fake.${Buffer.from(JSON.stringify({ name: i.email, ...i })).toString('base64url')}`;
}

/**
 * An in-memory NEXORA Core: identity assertions, per-org plans, and a usage meter that counts the events it
 * receives (deduplicated by event id, as the real Core must do). Lets the whole integration run and be
 * tested before NEXORA's contracts exist.
 */
export class FakeCore implements CorePorts {
  readonly plans = new Map<string, NexoraPlan>();
  readonly status = new Map<string, 'active' | 'suspended' | 'disabled'>();
  readonly received: CoreEvent[] = [];
  /** Make the event endpoint fail (for retry tests). */
  failEvents = false;
  /** Make entitlement lookups fail (for outage tests). */
  failEntitlements = false;
  private readonly seen = new Set<string>();
  private readonly usage = new Map<string, number>();

  setPlan(orgId: string, plan: NexoraPlan): void {
    this.plans.set(orgId, plan);
  }

  usageOf(orgId: string): number {
    return this.usage.get(orgId) ?? 0;
  }

  readonly identity = {
    verifyAssertion: async (assertion: string): Promise<VerifiedIdentity> => {
      if (!assertion.startsWith('fake.')) throw new AuthenticationError('Invalid NEXORA identity assertion');
      try {
        const v = JSON.parse(
          Buffer.from(assertion.slice(5), 'base64url').toString('utf8'),
        ) as Partial<VerifiedIdentity>;
        if (
          typeof v.orgId !== 'string' ||
          typeof v.userId !== 'string' ||
          typeof v.email !== 'string' ||
          !v.role ||
          !ROLES.includes(v.role)
        )
          throw new Error('shape');
        return { orgId: v.orgId, userId: v.userId, email: v.email, name: v.name ?? v.email, role: v.role };
      } catch {
        throw new AuthenticationError('Invalid NEXORA identity assertion');
      }
    },
  };

  readonly entitlements = {
    check: async (orgId: string, _action: EntitlementAction): Promise<EntitlementDecision> => {
      if (this.failEntitlements) throw new Error('core unreachable');
      const plan = this.plans.get(orgId) ?? 'free';
      const limit = PLACEHOLDER_RUN_LIMITS[plan];
      const remaining = Math.max(0, limit - this.usageOf(orgId));
      return {
        allowed: remaining > 0,
        remaining,
        limit,
        plan,
        orgStatus: this.status.get(orgId) ?? 'active',
      };
    },
  };

  readonly events = {
    send: async (e: CoreEvent): Promise<void> => {
      if (this.failEvents) throw new Error('core unreachable');
      if (this.seen.has(e.id)) return; // a duplicate delivery is harmless, by contract
      this.seen.add(e.id);
      this.received.push(e);
      if (e.kind === 'usage' && e.name === 'constans.run.started') this.usage.set(e.orgId, this.usageOf(e.orgId) + 1);
    },
  };
}
