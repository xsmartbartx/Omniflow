import { type Clock, ConflictError, NotFoundError, newId, systemClock } from '../core/index.ts';
import { type Db, fromJson, toJson } from './database.ts';

export type DraftStatus = 'open' | 'submitted' | 'rejected' | 'published';

export interface DraftRecord {
  id: string;
  tenant: string;
  workflowName?: string;
  manifestText: string;
  /** `human` or `agent:<name>` — agent output is always a draft, never a publish. */
  origin: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  status: DraftStatus;
  notes?: unknown;
  validation?: unknown;
}

export type ChangeStatus = 'pending' | 'approved' | 'rejected' | 'published' | 'withdrawn';

export interface ChangeRecord {
  id: string;
  tenant: string;
  workflowName: string;
  version: string;
  manifestText: string;
  status: ChangeStatus;
  requestedBy: string;
  requestedByName?: string;
  requestedAt: string;
  reasonCode: string;
  reason: string;
  requiredApprovals: number;
  approvals: Array<{ by: string; name?: string; at: string; comment?: string }>;
  decidedBy?: string;
  decidedAt?: string;
  decisionComment?: string;
  risk?: unknown;
  origin: string;
}

export interface ProposalRecord {
  id: string;
  tenant: string;
  kind: string;
  workflowName?: string;
  title: string;
  body: unknown;
  source: string;
  status: 'open' | 'accepted' | 'dismissed';
  createdAt: string;
  decidedBy?: string;
  decidedAt?: string;
}

export interface FindingRecord {
  id: string;
  tenant: string;
  workflowName: string;
  version: string;
  planHash: string;
  ruleId: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  blocking: boolean;
  message: string;
  detail?: unknown;
  createdAt: string;
}

interface DRow {
  id: string;
  tenant_id: string;
  workflow_name: string | null;
  manifest_text: string;
  origin: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  status: DraftStatus;
  notes: string | null;
  validation: string | null;
}
interface CRow {
  id: string;
  tenant_id: string;
  workflow_name: string;
  version: string;
  manifest_text: string;
  status: ChangeStatus;
  requested_by: string;
  requested_by_name: string | null;
  requested_at: string;
  reason_code: string;
  reason: string;
  required_approvals: number;
  approvals: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_comment: string | null;
  risk: string | null;
  origin: string;
}
interface PRow {
  id: string;
  tenant_id: string;
  kind: string;
  workflow_name: string | null;
  title: string;
  body: string;
  source: string;
  status: 'open' | 'accepted' | 'dismissed';
  created_at: string;
  decided_by: string | null;
  decided_at: string | null;
}
interface FRow {
  id: string;
  tenant_id: string;
  workflow_name: string;
  version: string;
  plan_hash: string;
  rule_id: string;
  severity: FindingRecord['severity'];
  blocking: number;
  message: string;
  detail: string | null;
  created_at: string;
}

const toDraft = (r: DRow): DraftRecord => ({
  id: r.id,
  tenant: r.tenant_id,
  ...(r.workflow_name ? { workflowName: r.workflow_name } : {}),
  manifestText: r.manifest_text,
  origin: r.origin,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  status: r.status,
  ...(r.notes ? { notes: fromJson(r.notes) } : {}),
  ...(r.validation ? { validation: fromJson(r.validation) } : {}),
});
const toChange = (r: CRow): ChangeRecord => ({
  id: r.id,
  tenant: r.tenant_id,
  workflowName: r.workflow_name,
  version: r.version,
  manifestText: r.manifest_text,
  status: r.status,
  requestedBy: r.requested_by,
  ...(r.requested_by_name ? { requestedByName: r.requested_by_name } : {}),
  requestedAt: r.requested_at,
  reasonCode: r.reason_code,
  reason: r.reason,
  requiredApprovals: r.required_approvals,
  approvals: fromJson(r.approvals) ?? [],
  ...(r.decided_by ? { decidedBy: r.decided_by } : {}),
  ...(r.decided_at ? { decidedAt: r.decided_at } : {}),
  ...(r.decision_comment ? { decisionComment: r.decision_comment } : {}),
  ...(r.risk ? { risk: fromJson(r.risk) } : {}),
  origin: r.origin,
});
const toProposal = (r: PRow): ProposalRecord => ({
  id: r.id,
  tenant: r.tenant_id,
  kind: r.kind,
  ...(r.workflow_name ? { workflowName: r.workflow_name } : {}),
  title: r.title,
  body: fromJson(r.body),
  source: r.source,
  status: r.status,
  createdAt: r.created_at,
  ...(r.decided_by ? { decidedBy: r.decided_by } : {}),
  ...(r.decided_at ? { decidedAt: r.decided_at } : {}),
});
const toFinding = (r: FRow): FindingRecord => ({
  id: r.id,
  tenant: r.tenant_id,
  workflowName: r.workflow_name,
  version: r.version,
  planHash: r.plan_hash,
  ruleId: r.rule_id,
  severity: r.severity,
  blocking: r.blocking === 1,
  message: r.message,
  ...(r.detail ? { detail: fromJson(r.detail) } : {}),
  createdAt: r.created_at,
});

/**
 * Drafts, change requests, proposals and findings. Agents may write drafts and proposals — the
 * "draft store" and "proposal queue" of architecture §8.1 — and nothing else.
 */
export class AuthoringStore {
  private readonly db: Db;
  private readonly clock: Clock;

  constructor(db: Db, clock: Clock = systemClock) {
    this.db = db;
    this.clock = clock;
  }

  private now(): string {
    return this.clock.now().toISOString();
  }

  // ---- drafts
  createDraft(d: {
    tenant: string;
    workflowName?: string;
    manifestText: string;
    origin: string;
    createdBy: string;
    notes?: unknown;
    validation?: unknown;
  }): DraftRecord {
    const id = newId('drf');
    const now = this.now();
    this.db.run(
      `INSERT INTO drafts (id, tenant_id, workflow_name, manifest_text, origin, created_by, created_at, updated_at, notes, validation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        d.tenant,
        d.workflowName ?? null,
        d.manifestText,
        d.origin,
        d.createdBy,
        now,
        now,
        toJson(d.notes),
        toJson(d.validation),
      ],
    );
    return this.getDraft(id)!;
  }
  getDraft(id: string, tenant?: string): DraftRecord | undefined {
    const r = tenant
      ? this.db.get<DRow>('SELECT * FROM drafts WHERE id = ? AND tenant_id = ?', [id, tenant])
      : this.db.get<DRow>('SELECT * FROM drafts WHERE id = ?', [id]);
    return r ? toDraft(r) : undefined;
  }
  listDrafts(tenant: string, status?: DraftStatus): DraftRecord[] {
    const rows = status
      ? this.db.all<DRow>(
          'SELECT * FROM drafts WHERE tenant_id = ? AND status = ? ORDER BY updated_at DESC LIMIT 200',
          [tenant, status],
        )
      : this.db.all<DRow>('SELECT * FROM drafts WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT 200', [tenant]);
    return rows.map(toDraft);
  }
  updateDraft(
    id: string,
    p: { manifestText?: string; workflowName?: string; status?: DraftStatus; notes?: unknown; validation?: unknown },
  ): DraftRecord {
    const res = this.db.run(
      `UPDATE drafts SET manifest_text = COALESCE(?, manifest_text), workflow_name = COALESCE(?, workflow_name),
         status = COALESCE(?, status), notes = COALESCE(?, notes), validation = COALESCE(?, validation), updated_at = ? WHERE id = ?`,
      [
        p.manifestText ?? null,
        p.workflowName ?? null,
        p.status ?? null,
        toJson(p.notes),
        toJson(p.validation),
        this.now(),
        id,
      ],
    );
    if (res.changes === 0) throw new NotFoundError('Draft', id);
    return this.getDraft(id)!;
  }
  deleteDraft(tenant: string, id: string): boolean {
    return (
      this.db.run(`DELETE FROM drafts WHERE id = ? AND tenant_id = ? AND status != 'published'`, [id, tenant]).changes >
      0
    );
  }

  // ---- change requests
  createChange(c: {
    tenant: string;
    workflowName: string;
    version: string;
    manifestText: string;
    requestedBy: string;
    requestedByName?: string;
    reasonCode: string;
    reason: string;
    requiredApprovals: number;
    risk?: unknown;
    origin?: string;
  }): ChangeRecord {
    const dup = this.db.get<{ id: string }>(
      `SELECT id FROM change_requests WHERE tenant_id = ? AND workflow_name = ? AND version = ? AND status IN ('pending', 'approved')`,
      [c.tenant, c.workflowName, c.version],
    );
    if (dup)
      throw new ConflictError(`A change for ${c.workflowName}@${c.version} is already open (${dup.id})`, {
        changeId: dup.id,
      });
    const id = newId('chg');
    this.db.run(
      `INSERT INTO change_requests (id, tenant_id, workflow_name, version, manifest_text, requested_by, requested_by_name, requested_at,
         reason_code, reason, required_approvals, risk, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        c.tenant,
        c.workflowName,
        c.version,
        c.manifestText,
        c.requestedBy,
        c.requestedByName ?? null,
        this.now(),
        c.reasonCode,
        c.reason,
        c.requiredApprovals,
        toJson(c.risk),
        c.origin ?? 'human',
      ],
    );
    return this.getChange(id)!;
  }
  getChange(id: string, tenant?: string): ChangeRecord | undefined {
    const r = tenant
      ? this.db.get<CRow>('SELECT * FROM change_requests WHERE id = ? AND tenant_id = ?', [id, tenant])
      : this.db.get<CRow>('SELECT * FROM change_requests WHERE id = ?', [id]);
    return r ? toChange(r) : undefined;
  }
  listChanges(tenant: string, status?: ChangeStatus): ChangeRecord[] {
    const rows = status
      ? this.db.all<CRow>(
          'SELECT * FROM change_requests WHERE tenant_id = ? AND status = ? ORDER BY requested_at DESC LIMIT 200',
          [tenant, status],
        )
      : this.db.all<CRow>('SELECT * FROM change_requests WHERE tenant_id = ? ORDER BY requested_at DESC LIMIT 200', [
          tenant,
        ]);
    return rows.map(toChange);
  }
  patchChange(
    id: string,
    p: { status?: ChangeStatus; approvals?: ChangeRecord['approvals']; decidedBy?: string; decisionComment?: string },
  ): ChangeRecord {
    const res = this.db.run(
      `UPDATE change_requests SET status = COALESCE(?, status), approvals = COALESCE(?, approvals),
         decided_by = COALESCE(?, decided_by), decided_at = CASE WHEN ? IS NULL THEN decided_at ELSE ? END,
         decision_comment = COALESCE(?, decision_comment) WHERE id = ?`,
      [
        p.status ?? null,
        p.approvals ? JSON.stringify(p.approvals) : null,
        p.decidedBy ?? null,
        p.decidedBy ?? null,
        this.now(),
        p.decisionComment ?? null,
        id,
      ],
    );
    if (res.changes === 0) throw new NotFoundError('Change request', id);
    return this.getChange(id)!;
  }

  // ---- proposals
  createProposal(p: {
    tenant: string;
    kind: string;
    workflowName?: string;
    title: string;
    body: unknown;
    source: string;
    dedupeKey?: string;
  }): ProposalRecord | undefined {
    const id = newId('prp');
    const res = this.db.run(
      `INSERT OR IGNORE INTO proposals (id, tenant_id, kind, workflow_name, title, body, source, created_at, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        p.tenant,
        p.kind,
        p.workflowName ?? null,
        p.title,
        JSON.stringify(p.body ?? null),
        p.source,
        this.now(),
        p.dedupeKey ?? null,
      ],
    );
    return res.changes === 1 ? this.getProposal(id) : undefined;
  }
  getProposal(id: string, tenant?: string): ProposalRecord | undefined {
    const r = tenant
      ? this.db.get<PRow>('SELECT * FROM proposals WHERE id = ? AND tenant_id = ?', [id, tenant])
      : this.db.get<PRow>('SELECT * FROM proposals WHERE id = ?', [id]);
    return r ? toProposal(r) : undefined;
  }
  listProposals(tenant: string, status?: ProposalRecord['status']): ProposalRecord[] {
    const rows = status
      ? this.db.all<PRow>(
          'SELECT * FROM proposals WHERE tenant_id = ? AND status = ? ORDER BY created_at DESC LIMIT 200',
          [tenant, status],
        )
      : this.db.all<PRow>('SELECT * FROM proposals WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 200', [tenant]);
    return rows.map(toProposal);
  }
  decideProposal(id: string, status: 'accepted' | 'dismissed', by: string): ProposalRecord {
    const res = this.db.run(
      `UPDATE proposals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'open'`,
      [status, by, this.now(), id],
    );
    if (res.changes === 0) throw new ConflictError(`Proposal '${id}' is not open`);
    return this.getProposal(id)!;
  }

  // ---- findings
  replaceFindings(
    tenant: string,
    workflow: string,
    version: string,
    planHash: string,
    findings: Array<Omit<FindingRecord, 'id' | 'tenant' | 'workflowName' | 'version' | 'planHash' | 'createdAt'>>,
  ): FindingRecord[] {
    return this.db.transaction(() => {
      this.db.run('DELETE FROM findings WHERE tenant_id = ? AND workflow_name = ? AND version = ?', [
        tenant,
        workflow,
        version,
      ]);
      const now = this.now();
      for (const f of findings) {
        this.db.run(
          `INSERT INTO findings (id, tenant_id, workflow_name, version, plan_hash, rule_id, severity, blocking, message, detail, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            newId('fnd'),
            tenant,
            workflow,
            version,
            planHash,
            f.ruleId,
            f.severity,
            f.blocking ? 1 : 0,
            f.message,
            toJson(f.detail),
            now,
          ],
        );
      }
      return this.listFindings(tenant, workflow, version);
    });
  }
  listFindings(tenant: string, workflow?: string, version?: string): FindingRecord[] {
    const w = ['tenant_id = ?'];
    const p: string[] = [tenant];
    if (workflow) {
      w.push('workflow_name = ?');
      p.push(workflow);
    }
    if (version) {
      w.push('version = ?');
      p.push(version);
    }
    return this.db
      .all<FRow>(`SELECT * FROM findings WHERE ${w.join(' AND ')} ORDER BY created_at DESC LIMIT 500`, p)
      .map(toFinding);
  }
}
