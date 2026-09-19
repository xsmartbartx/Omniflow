import { type Clock, newId, OmniflowError, systemClock } from '../core/index.ts';
import { type Db, fromJson } from './database.ts';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'timed-out';

export interface ApprovalRecord {
  id: string;
  tenant: string;
  runId: string;
  stepId: string;
  workflowName?: string;
  status: ApprovalStatus;
  message: string;
  approvers: { roles: string[]; users: string[] };
  /** Principal id of whoever started the run — used to enforce four-eyes. */
  requestedBy?: string;
  requestedAt: string;
  expiresAt: string;
  onTimeout: 'deny' | 'escalate' | 'approve';
  escalated: boolean;
  allowSelf: boolean;
  decidedBy?: string;
  decidedAt?: string;
  comment?: string;
}

interface Row {
  id: string;
  tenant_id: string;
  run_id: string;
  step_id: string;
  status: ApprovalStatus;
  message: string;
  approvers: string;
  requested_by: string | null;
  requested_at: string;
  expires_at: string;
  on_timeout: 'deny' | 'escalate' | 'approve';
  escalated: number;
  allow_self: number;
  decided_by: string | null;
  decided_at: string | null;
  comment: string | null;
  workflow_name: string | null;
}

const toRecord = (r: Row): ApprovalRecord => ({
  id: r.id,
  tenant: r.tenant_id,
  runId: r.run_id,
  stepId: r.step_id,
  ...(r.workflow_name ? { workflowName: r.workflow_name } : {}),
  status: r.status,
  message: r.message,
  approvers: fromJson(r.approvers) ?? { roles: [], users: [] },
  ...(r.requested_by ? { requestedBy: r.requested_by } : {}),
  requestedAt: r.requested_at,
  expiresAt: r.expires_at,
  onTimeout: r.on_timeout,
  escalated: r.escalated === 1,
  allowSelf: r.allow_self === 1,
  ...(r.decided_by ? { decidedBy: r.decided_by } : {}),
  ...(r.decided_at ? { decidedAt: r.decided_at } : {}),
  ...(r.comment ? { comment: r.comment } : {}),
});

export interface NewApproval {
  tenant: string;
  runId: string;
  stepId: string;
  workflowName?: string;
  message: string;
  approvers: { roles: string[]; users: string[] };
  requestedBy?: string;
  expiresAt: string;
  onTimeout: 'deny' | 'escalate' | 'approve';
  allowSelf: boolean;
}

/** Human-in-the-loop gates (architecture §5.1 #18). Deciding never resumes a run by itself. */
export class ApprovalStore {
  private readonly db: Db;
  private readonly clock: Clock;

  constructor(db: Db, clock: Clock = systemClock) {
    this.db = db;
    this.clock = clock;
  }

  create(n: NewApproval): ApprovalRecord {
    const id = newId('apr');
    this.db.run(
      `INSERT INTO approvals (id, tenant_id, run_id, step_id, status, message, approvers, requested_by, requested_at,
         expires_at, on_timeout, allow_self, workflow_name)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        n.tenant,
        n.runId,
        n.stepId,
        n.message,
        JSON.stringify(n.approvers),
        n.requestedBy ?? null,
        this.clock.now().toISOString(),
        n.expiresAt,
        n.onTimeout,
        n.allowSelf ? 1 : 0,
        n.workflowName ?? null,
      ],
    );
    return this.get(id)!;
  }

  get(id: string, tenant?: string): ApprovalRecord | undefined {
    const r = tenant
      ? this.db.get<Row>('SELECT * FROM approvals WHERE id = ? AND tenant_id = ?', [id, tenant])
      : this.db.get<Row>('SELECT * FROM approvals WHERE id = ?', [id]);
    return r ? toRecord(r) : undefined;
  }

  list(f: { tenant: string; status?: ApprovalStatus; runId?: string; limit?: number }): ApprovalRecord[] {
    const w = ['tenant_id = ?'];
    const p: string[] = [f.tenant];
    if (f.status) w.push('status = ?'), p.push(f.status);
    if (f.runId) w.push('run_id = ?'), p.push(f.runId);
    const limit = Math.min(f.limit ?? 100, 500);
    return this.db
      .all<Row>(`SELECT * FROM approvals WHERE ${w.join(' AND ')} ORDER BY requested_at DESC LIMIT ${limit}`, p)
      .map(toRecord);
  }

  /** Record a decision. Only a `pending` approval can be decided, exactly once. */
  decide(id: string, status: 'approved' | 'denied' | 'timed-out', by: string, comment?: string): ApprovalRecord {
    return this.db.transaction(() => {
      const cur = this.get(id);
      if (!cur) throw new OmniflowError('APPROVAL_NOT_FOUND', `Approval '${id}' not found`, { errorClass: 'business' });
      if (cur.status !== 'pending') {
        throw new OmniflowError('APPROVAL_ALREADY_DECIDED', `Approval '${id}' was already ${cur.status}`, {
          errorClass: 'business',
          retryable: false,
        });
      }
      this.db.run(`UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, comment = ? WHERE id = ?`, [
        status,
        by,
        this.clock.now().toISOString(),
        comment ?? null,
        id,
      ]);
      return this.get(id)!;
    });
  }

  /** Extend the deadline once (escalation). */
  escalate(id: string, newExpiry: string): void {
    this.db.run(`UPDATE approvals SET escalated = 1, expires_at = ? WHERE id = ? AND status = 'pending'`, [
      newExpiry,
      id,
    ]);
  }

  due(nowIso: string): ApprovalRecord[] {
    return this.db
      .all<Row>(
        `SELECT * FROM approvals WHERE status = 'pending' AND expires_at <= ? ORDER BY expires_at ASC LIMIT 200`,
        [nowIso],
      )
      .map(toRecord);
  }

  pendingCount(tenant: string): number {
    return (
      this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM approvals WHERE tenant_id = ? AND status = 'pending'`, [
        tenant,
      ])?.n ?? 0
    );
  }
}
