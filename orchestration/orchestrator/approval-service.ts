import { type Clock, ConflictError, ForbiddenError, NotFoundError, PolicyDeniedError, systemClock } from '../../core/index.ts';
import type { Principal } from '../../schemas/policy.ts';
import type { PolicyEngine } from '../../security/policy/index.ts';
import type { ApprovalRecord, ApprovalStatus, State } from '../../state/index.ts';
import type { Orchestrator } from './orchestrator.ts';

/**
 * Approval Service (architecture §5.1 #18): routes a request to the people allowed to decide it,
 * records the decision with identity and timestamp, and hands the outcome to the Orchestrator. It
 * cannot resume a run itself.
 */
export class ApprovalService {
  private readonly st: State;
  private readonly orch: Orchestrator;
  private readonly policy: PolicyEngine;
  private readonly clock: Clock;

  constructor(deps: { state: State; orchestrator: Orchestrator; policy: PolicyEngine; clock?: Clock }) {
    this.st = deps.state;
    this.orch = deps.orchestrator;
    this.policy = deps.policy;
    this.clock = deps.clock ?? systemClock;
  }

  list(principal: Principal, f: { status?: ApprovalStatus; runId?: string; limit?: number } = {}): ApprovalRecord[] {
    return this.st.approvals.list({ tenant: principal.tenant, ...f });
  }

  get(principal: Principal, id: string): ApprovalRecord {
    const a = this.st.approvals.get(id, principal.tenant);
    if (!a) throw new NotFoundError('Approval', id);
    return a;
  }

  /** May this principal decide this approval? Eligible approvers are named by role or user; admins may always decide. */
  canDecide(principal: Principal, a: ApprovalRecord): boolean {
    if (principal.roles.includes('admin')) return true;
    if (a.approvers.users.includes(principal.id) || a.approvers.users.includes(principal.name)) return true;
    return a.approvers.roles.some((r) => (principal.roles as string[]).includes(r));
  }

  decide(principal: Principal, id: string, decision: 'approved' | 'denied', comment?: string): ApprovalRecord {
    const d = this.policy.decide({ principal, action: 'approval.decide', resource: { tenant: principal.tenant } });
    if (d.effect !== 'allow') throw new PolicyDeniedError(d.reasonCode, d.reason);
    const a = this.get(principal, id);
    if (a.status !== 'pending') throw new ConflictError(`Approval ${id} was already ${a.status}`);
    if (this.clock.now().toISOString() > a.expiresAt && a.onTimeout !== 'escalate') {
      throw new ConflictError('This approval has expired and is being resolved by its timeout policy');
    }
    if (!this.canDecide(principal, a)) {
      throw new ForbiddenError('You are not one of the approvers for this request', { approvers: a.approvers });
    }
    // Four-eyes: the initiator of the run may not approve their own request (unless the gate allows it).
    if (!a.allowSelf && a.requestedBy && a.requestedBy === principal.id) {
      throw new ForbiddenError('You started this run and cannot approve your own request', { code: 'SELF_APPROVAL' });
    }
    const decided = this.st.approvals.decide(id, decision, principal.id, comment);
    this.st.events.append({
      tenant: principal.tenant,
      type: 'approval.decided',
      runId: a.runId,
      stepId: a.stepId,
      actor: { type: principal.type, id: principal.id, name: principal.name },
      data: { approvalId: id, decision, ...(comment ? { comment } : {}) },
    });
    this.orch.resolveApproval(id);
    return decided;
  }
}
