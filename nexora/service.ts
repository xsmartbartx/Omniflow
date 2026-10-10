import { ConflictError, EntitlementError, type Logger, nullLogger, ValidationError } from '../core/index.ts';
import type { AdmissionGate } from '../orchestration/scheduler/index.ts';
import type { Principal } from '../schemas/index.ts';
import type { NexoraOrg, RunRecord, State, UserRecord } from '../state/index.ts';
import { omniflowRoles } from './roles.ts';
import type { CorePorts, EntitlementDecision, VerifiedIdentity } from './types.ts';

export const RUN_START = 'run.start' as const;
const ORG_ID = /^[A-Za-z0-9_-]{1,100}$/;

export interface NexoraServiceOptions {
  /** How long a fetched entitlement is fresh. */
  entitlementTtlMs?: number;
  /** After expiry a known org keeps its last answer this long if Core is unreachable (architecture D9). */
  graceMs?: number;
  log?: Logger;
}

export interface UsageView {
  metered: true;
  orgId: string;
  plan: string;
  status: string;
  used: number;
  limit: number | null;
  remaining: number | null;
  period: { start: string; end: string };
}

/**
 * The NEXORA integration: provisions orgs and users from verified identities, answers "may this org start
 * a run" from a local cache that is refreshed from Core, and records usage in the outbox. All Core access
 * goes through the injected ports.
 */
export class NexoraService {
  private readonly st: State;
  private readonly core: CorePorts;
  private readonly ttl: number;
  private readonly grace: number;
  private readonly log: Logger;

  constructor(state: State, core: CorePorts, opts: NexoraServiceOptions = {}) {
    this.st = state;
    this.core = core;
    this.ttl = opts.entitlementTtlMs ?? 60_000;
    this.grace = opts.graceMs ?? 15 * 60_000;
    this.log = opts.log ?? nullLogger;
  }

  /** Verify an assertion and make sure the org, user and entitlement exist locally. */
  async signIn(assertion: string): Promise<{ user: UserRecord; org: NexoraOrg; identity: VerifiedIdentity }> {
    const identity = await this.core.identity.verifyAssertion(assertion);
    const org = this.provisionOrg(identity.orgId);
    if (org.status !== 'active') {
      throw new EntitlementError('ENTITLEMENT_DENIED', 'This organisation is not active for OmniFlow');
    }
    const user = this.provisionUser(org, identity);
    await this.refreshEntitlement(org.orgId).catch((e) => {
      this.log.warn('entitlement refresh failed at sign-in', { orgId: org.orgId, error: e });
    });
    return { user, org, identity };
  }

  private provisionOrg(orgId: string): NexoraOrg {
    if (!ORG_ID.test(orgId)) {
      throw new ValidationError('Invalid organisation id', [
        { path: 'orgId', code: 'INVALID_ORG', message: 'Organisation ids may only use letters, digits, - and _' },
      ]);
    }
    return this.st.db.transaction(() => {
      const existing = this.st.nexora.getOrg(orgId);
      if (existing) return existing;
      const tenant = `nx_${orgId}`;
      this.st.identity.ensureTenant(tenant, `NEXORA organisation ${orgId}`);
      const org = this.st.nexora.insertOrg(orgId, tenant, 'free');
      this.st.events.append({ tenant, type: 'system.started', data: { nexoraOrg: orgId, provisioned: true } });
      return org;
    });
  }

  private provisionUser(org: NexoraOrg, id: VerifiedIdentity): UserRecord {
    const roles = omniflowRoles(id.role);
    return this.st.db.transaction(() => {
      const link = this.st.nexora.getIdentity(org.orgId, id.userId);
      if (link) {
        this.st.identity.updateUser(link.userId, { roles });
        this.st.nexora.upsertIdentity({ ...link, role: id.role });
        return this.st.identity.getUser(link.userId)!;
      }
      if (this.st.identity.getUserByEmail(org.tenant, id.email)) {
        throw new ConflictError('A different NEXORA user already uses this email in this organisation');
      }
      const user = this.st.identity.createUser({ tenant: org.tenant, email: id.email, name: id.name, roles });
      this.st.nexora.upsertIdentity({
        orgId: org.orgId,
        externalUserId: id.userId,
        tenant: org.tenant,
        userId: user.id,
        role: id.role,
      });
      return user;
    });
  }

  /** Ask Core and cache the answer. Also applies Core's view of the org status. */
  async refreshEntitlement(orgId: string): Promise<EntitlementDecision> {
    const d = await this.core.entitlements.check(orgId, RUN_START);
    this.st.db.transaction(() => {
      this.st.nexora.putEntitlement(
        { orgId, action: RUN_START, allowed: d.allowed, remaining: d.remaining, limit: d.limit },
        this.ttl,
      );
      if (this.st.nexora.getOrg(orgId)?.plan !== d.plan) this.st.nexora.setPlan(orgId, d.plan);
      if (d.orgStatus && this.st.nexora.getOrg(orgId)?.status !== d.orgStatus)
        this.st.nexora.setStatus(orgId, d.orgStatus);
    });
    return d;
  }

  /** Refresh every cached entitlement that has expired. Called by the worker. */
  async refreshExpired(): Promise<number> {
    let n = 0;
    for (const orgId of this.st.nexora.expiredEntitlementOrgs(RUN_START)) {
      try {
        await this.refreshEntitlement(orgId);
        n++;
      } catch (e) {
        this.log.warn('entitlement refresh failed', { orgId, error: e });
      }
    }
    return n;
  }

  /** Is this tenant's session still allowed to act? Used on every session request. */
  isTenantActive(tenant: string): boolean {
    const org = this.st.nexora.getOrgByTenant(tenant);
    return !org || org.status === 'active';
  }

  /** The run admission gate (synchronous: reads only the local cache). */
  readonly gate: AdmissionGate = {
    check: (tenant) => {
      const org = this.st.nexora.getOrgByTenant(tenant);
      if (!org) return; // not a NEXORA org (e.g. the operator's own default tenant): not metered
      if (org.status !== 'active') {
        throw new EntitlementError('ENTITLEMENT_DENIED', `Organisation access is ${org.status}`, {
          status: org.status,
        });
      }
      const row = this.st.nexora.getEntitlement(org.orgId, RUN_START);
      const now = Date.now();
      if (!row || Date.parse(row.expiresAt) + this.grace < now) {
        throw new EntitlementError(
          'ENTITLEMENT_UNAVAILABLE',
          'Your plan limits could not be confirmed right now. Try again shortly.',
        );
      }
      if (!row.allowed || (row.remaining !== null && row.remaining <= 0)) {
        throw new EntitlementError(
          'ENTITLEMENT_EXCEEDED',
          'Your plan has no runs left this period. Upgrade to continue.',
          {
            plan: org.plan,
            limit: row.limit,
          },
        );
      }
    },
    admitted: (run: RunRecord) => {
      const org = this.st.nexora.getOrgByTenant(run.tenant);
      if (!org) return;
      this.st.nexora.consumeUnit(org.orgId, RUN_START);
      this.st.nexora.enqueue({
        id: `run.started:${run.id}`,
        tenant: run.tenant,
        orgId: org.orgId,
        kind: 'usage',
        name: 'omniflow.run.started',
        payload: { runId: run.id, workflow: run.workflowName, version: run.workflowVersion },
        idempotencyKey: `run.started:${run.id}`,
        ...(run.correlationId ? { correlationId: run.correlationId } : {}),
        occurredAt: run.createdAt,
      });
    },
  };

  usage(principal: Principal, at: Date = new Date()): UsageView | { metered: false } {
    const org = this.st.nexora.getOrgByTenant(principal.tenant);
    if (!org) return { metered: false };
    const row = this.st.nexora.getEntitlement(org.orgId, RUN_START);
    const used = this.st.nexora.runsInMonth(org.tenant, at);
    const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
    const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
    return {
      metered: true,
      orgId: org.orgId,
      plan: org.plan,
      status: org.status,
      used,
      limit: row?.limit ?? null,
      remaining: row?.remaining ?? null,
      period: { start: start.toISOString(), end: end.toISOString() },
    };
  }
}
