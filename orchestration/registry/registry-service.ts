import { EventEmitter } from 'node:events';
import semver from 'semver';
import { parse as parseYaml } from 'yaml';
import {
  type Clock,
  ConflictError,
  contentHash,
  ForbiddenError,
  type Issue,
  type JsonObject,
  NotFoundError,
  PolicyDeniedError,
  sha256Hex,
  systemClock,
  ValidationError,
} from '../../core/index.ts';
import type { CapabilityRegistry } from '../../capabilities/index.ts';
import type { Manifest } from '../../schemas/manifest.ts';
import type { Plan } from '../../schemas/plan.ts';
import type { AutonomyTier, PolicyDecision, Principal } from '../../schemas/policy.ts';
import { analyzeWorkflow, type PentestReport } from '../../security/pentest/index.ts';
import type { PolicyEngine, RiskSummary } from '../../security/policy/index.ts';
import type { ChangeRecord, State, VersionRecord, WorkflowSettings } from '../../state/index.ts';
import { compile, type SubworkflowResolver } from '../compiler/index.ts';

export interface RegistryServiceDeps {
  state: State;
  capabilities: CapabilityRegistry;
  policy: PolicyEngine;
  clock?: Clock;
  /** Deployment facts injected as `context.*` at compile time. */
  context?: JsonObject;
}

export interface InspectResult {
  ok: boolean;
  issues: Issue[];
  errors: Issue[];
  warnings: Issue[];
  manifest?: Manifest;
  plan?: Plan;
  planHash?: string;
  risk?: PentestReport;
}

export type SubmitResult =
  | { status: 'published'; version: VersionRecord; risk: PentestReport }
  | { status: 'pending-approval'; change: ChangeRecord; decision: PolicyDecision; risk: PentestReport };

export interface SubmitOptions {
  origin?: 'human' | 'agent';
  /** Take only this percentage of runs (canary) instead of becoming the stable version. */
  canaryPercent?: number;
  /** Open a change request even where policy alone would publish — e.g. an autonomy tier that requires a human. */
  forceApproval?: { code: string; reason: string };
}

export interface RegistryEvents {
  /** The version that new runs use (and whose triggers are live) changed. */
  activated: [{ tenant: string; workflow: string; version: string }];
  /** A workflow can no longer run (disabled/killed) or was removed from service. */
  deactivated: [{ tenant: string; workflow: string }];
}

const summarise = (r: PentestReport): RiskSummary => ({ score: r.score, level: r.level, blocking: r.blocking, findings: r.findings.length });

/**
 * Workflow Registry service (architecture §5.1 #7): immutable, versioned publishing with lineage,
 * an approval record, and risk review. Every path to publication — human, agent-proposed, change
 * request — goes through `publishInternal`, so nothing reaches the registry without validation,
 * compilation, pentest review and a policy decision.
 */
export class RegistryService {
  private readonly st: State;
  private readonly caps: CapabilityRegistry;
  private readonly policy: PolicyEngine;
  private readonly clock: Clock;
  private readonly context: JsonObject;
  private readonly emitter = new EventEmitter();

  constructor(deps: RegistryServiceDeps) {
    this.st = deps.state;
    this.caps = deps.capabilities;
    this.policy = deps.policy;
    this.clock = deps.clock ?? systemClock;
    this.context = deps.context ?? {};
  }

  on<K extends keyof RegistryEvents>(event: K, listener: (...args: RegistryEvents[K]) => void): () => void {
    this.emitter.on(event, listener as (...a: unknown[]) => void);
    return () => this.emitter.off(event, listener as (...a: unknown[]) => void);
  }

  // ------------------------------------------------------------ inspection
  private subworkflows(tenant: string): SubworkflowResolver {
    return {
      resolve: (name, version) => {
        const v = this.st.registry.getVersion(tenant, name, version);
        const plan = v && this.st.registry.getPlan(tenant, v.planHash);
        if (!v || !plan || v.status === 'frozen') return undefined;
        return {
          version,
          planHash: v.planHash,
          inputSchema: plan.inputSchema,
          subworkflowDepth: plan.analysis.subworkflowDepth,
          subworkflowChain: [plan.workflow.name, ...plan.analysis.subworkflowChain],
          maxInvocations: plan.analysis.maxInvocations,
          estimatedCost: plan.analysis.estimatedCost,
          maxCost: plan.analysis.maxCost,
        };
      },
    };
  }

  /** Validate, compile and review a manifest without persisting anything. */
  inspect(tenant: string, text: string | unknown, origin: 'human' | 'agent' = 'human'): InspectResult {
    const compiled = compile(text, {
      environment: this.policy.environment,
      capabilities: this.caps,
      subworkflows: this.subworkflows(tenant),
      context: this.context,
      today: this.clock.now().toISOString().slice(0, 10),
    });
    if (!compiled.ok || !compiled.plan || !compiled.hash) {
      return { ok: false, issues: compiled.issues, errors: compiled.errors, warnings: compiled.warnings };
    }
    // The validator has already accepted this text, so parsing it again cannot fail.
    const manifest = (typeof text === 'string' ? parseYaml(text, { maxAliasCount: 0 }) : text) as Manifest;
    const risk = analyzeWorkflow({ manifest, plan: compiled.plan, origin });
    return { ok: true, issues: compiled.issues, errors: [], warnings: compiled.warnings, manifest, plan: compiled.plan, planHash: compiled.hash, risk };
  }

  // ------------------------------------------------------------- publishing
  /** Submit a manifest for publication. Publishes immediately when policy allows, otherwise opens a change request. */
  submit(principal: Principal, text: string, opts: SubmitOptions = {}): SubmitResult {
    const origin = opts.origin ?? 'human';
    const tenant = principal.tenant;
    const r = this.inspect(tenant, text, origin);
    if (!r.ok || !r.plan || !r.manifest || !r.risk) throw new ValidationError('The manifest is invalid', r.errors);
    const name = r.plan.workflow.name;
    const version = r.plan.workflow.version;
    this.assertVersionIsNew(tenant, name, version);

    const settings = this.st.registry.getSettings(tenant, name);
    const decision = this.policy.decide({
      principal,
      action: 'workflow.publish',
      resource: {
        tenant,
        workflow: name,
        version,
        criticality: r.plan.workflow.criticality,
        environment: this.policy.environment,
        plan: r.plan,
        risk: summarise(r.risk),
        origin,
        autonomyTier: settings?.autonomyTier ?? 'T1',
      },
    });
    this.audit(principal, 'workflow.publish', decision, name);
    if (decision.effect === 'deny') throw new PolicyDeniedError(decision.reasonCode, decision.reason, { workflow: name, version });

    const gate =
      decision.effect === 'require-approval'
        ? decision
        : opts.forceApproval
          ? { ...decision, effect: 'require-approval' as const, reasonCode: opts.forceApproval.code, reason: opts.forceApproval.reason, requiredApprovals: 1 }
          : undefined;
    if (gate) {
      const change = this.st.authoring.createChange({
        tenant,
        workflowName: name,
        version,
        manifestText: text,
        requestedBy: principal.id,
        requestedByName: principal.name,
        reasonCode: gate.reasonCode,
        reason: gate.reason,
        requiredApprovals: gate.requiredApprovals ?? 1,
        risk: r.risk,
        origin,
      });
      this.st.events.append({
        tenant,
        type: 'workflow.change-requested',
        actor: actorOf(principal),
        data: { workflow: name, version, changeId: change.id, reasonCode: gate.reasonCode, requiredApprovals: change.requiredApprovals },
      });
      return { status: 'pending-approval', change, decision: gate, risk: r.risk };
    }
    const published = this.publishInternal(tenant, text, r, { publishedBy: principal.id, origin, ...(opts.canaryPercent ? { canaryPercent: opts.canaryPercent } : {}) });
    return { status: 'published', version: published, risk: r.risk };
  }

  /** Approve a pending change. Publishes once the required number of distinct approvers is reached. */
  approveChange(principal: Principal, changeId: string, comment?: string): { change: ChangeRecord; published?: VersionRecord } {
    const change = this.mustGetChange(principal.tenant, changeId);
    if (change.status !== 'pending') throw new ConflictError(`Change ${changeId} is ${change.status}`);
    const decision = this.policy.decide({
      principal,
      action: 'workflow.approve-change',
      resource: { tenant: change.tenant, workflow: change.workflowName, changeAuthor: change.requestedBy },
    });
    this.audit(principal, 'workflow.approve-change', decision, change.workflowName);
    if (decision.effect !== 'allow') throw new PolicyDeniedError(decision.reasonCode, decision.reason);
    if (change.approvals.some((a) => a.by === principal.id)) throw new ConflictError('You have already approved this change');

    const approvals = [...change.approvals, { by: principal.id, name: principal.name, at: this.clock.now().toISOString(), ...(comment ? { comment } : {}) }];
    if (approvals.length < change.requiredApprovals) {
      return { change: this.st.authoring.patchChange(changeId, { approvals }) };
    }

    // Enough approvals: re-inspect against the *current* registry (capabilities or subworkflows may have changed).
    const r = this.inspect(change.tenant, change.manifestText, change.origin === 'agent' ? 'agent' : 'human');
    if (!r.ok || !r.plan || !r.risk) throw new ConflictError('The manifest no longer compiles against the current registry', { errors: r.errors });
    if (r.risk.blocking) throw new PolicyDeniedError('BLOCKING_FINDINGS', 'The pentest review raised blocking findings; the change cannot be published');
    this.assertVersionIsNew(change.tenant, change.workflowName, change.version);
    const published = this.publishInternal(change.tenant, change.manifestText, r, {
      publishedBy: change.requestedBy,
      origin: change.origin === 'agent' ? 'agent' : 'human',
      approval: { changeId, approvals, requiredApprovals: change.requiredApprovals, reasonCode: change.reasonCode },
    });
    this.st.events.append({
      tenant: change.tenant,
      type: 'workflow.change-approved',
      actor: actorOf(principal),
      data: { workflow: change.workflowName, version: change.version, changeId, approvers: approvals.map((a) => a.by) },
    });
    const updated = this.st.authoring.patchChange(changeId, { approvals, status: 'published', decidedBy: principal.id, ...(comment ? { decisionComment: comment } : {}) });
    return { change: updated, published };
  }

  rejectChange(principal: Principal, changeId: string, comment?: string): ChangeRecord {
    const change = this.mustGetChange(principal.tenant, changeId);
    if (change.status !== 'pending') throw new ConflictError(`Change ${changeId} is ${change.status}`);
    const decision = this.policy.decide({ principal, action: 'workflow.approve-change', resource: { tenant: change.tenant, workflow: change.workflowName } });
    if (decision.effect !== 'allow') throw new PolicyDeniedError(decision.reasonCode, decision.reason);
    this.st.events.append({
      tenant: change.tenant,
      type: 'workflow.change-rejected',
      actor: actorOf(principal),
      data: { workflow: change.workflowName, version: change.version, changeId, ...(comment ? { comment } : {}) },
    });
    return this.st.authoring.patchChange(changeId, { status: 'rejected', decidedBy: principal.id, ...(comment ? { decisionComment: comment } : {}) });
  }

  withdrawChange(principal: Principal, changeId: string): ChangeRecord {
    const change = this.mustGetChange(principal.tenant, changeId);
    if (change.status !== 'pending') throw new ConflictError(`Change ${changeId} is ${change.status}`);
    if (change.requestedBy !== principal.id && !principal.roles.includes('admin')) throw new ForbiddenError('Only the requester or an admin can withdraw a change');
    return this.st.authoring.patchChange(changeId, { status: 'withdrawn', decidedBy: principal.id });
  }

  private assertVersionIsNew(tenant: string, name: string, version: string): void {
    if (this.st.registry.getVersion(tenant, name, version)) {
      throw new ConflictError(`${name}@${version} already exists; published versions are immutable — bump the version`, { workflow: name, version });
    }
    const latest = this.st.registry.listVersions(tenant, name)[0];
    if (latest && !semver.gt(version, latest.version)) {
      throw new ConflictError(`Version ${version} must be greater than the latest published version ${latest.version}`, { workflow: name, latest: latest.version });
    }
  }

  private publishInternal(
    tenant: string,
    text: string,
    r: InspectResult,
    o: { publishedBy: string; origin: 'human' | 'agent'; approval?: unknown; canaryPercent?: number },
  ): VersionRecord {
    const plan = r.plan!;
    const name = plan.workflow.name;
    const latest = this.st.registry.listVersions(tenant, name)[0];
    const record = this.st.db.transaction(() => {
      const v = this.st.registry.insertVersion({
        tenant,
        name,
        version: plan.workflow.version,
        manifestText: text,
        manifestHash: contentHash(r.manifest),
        planHash: r.planHash!,
        plan,
        environment: this.policy.environment,
        ...(latest ? { parentVersion: latest.version } : {}),
        publishedBy: o.publishedBy,
        approval: { origin: o.origin, ...(o.approval ? (o.approval as object) : {}) },
        risk: { score: r.risk!.score, level: r.risk!.level, findings: r.risk!.findings.length },
      });
      this.st.authoring.replaceFindings(
        tenant,
        name,
        v.version,
        v.planHash,
        r.risk!.findings.map((f) => ({ ruleId: f.ruleId, severity: f.severity, blocking: f.blocking, message: f.message, detail: { ...(f.stepId ? { stepId: f.stepId } : {}), ...(f.path ? { path: f.path } : {}) } })),
      );
      const settings = this.st.registry.getSettings(tenant, name)!;
      if (o.canaryPercent && o.canaryPercent > 0 && settings.stableVersion) {
        this.st.registry.patchSettings(tenant, name, { canaryVersion: v.version, canaryPercent: Math.min(100, o.canaryPercent) }, o.publishedBy);
      } else {
        this.st.registry.patchSettings(tenant, name, { stableVersion: v.version }, o.publishedBy);
      }
      this.st.events.append({
        tenant,
        type: 'workflow.published',
        actor: { type: 'user', id: o.publishedBy },
        data: { workflow: name, version: v.version, planHash: v.planHash, origin: o.origin, riskScore: r.risk!.score, ...(o.canaryPercent ? { canaryPercent: o.canaryPercent } : {}) },
      });
      return v;
    });
    const settings = this.st.registry.getSettings(tenant, name)!;
    if (settings.stableVersion) this.emitter.emit('activated', { tenant, workflow: name, version: settings.stableVersion });
    return record;
  }

  // ---------------------------------------------------------- lifecycle ops
  /** Point the stable version at any published version (promotion or rollback). */
  activate(principal: Principal, name: string, version: string): WorkflowSettings {
    this.authorise(principal, 'workflow.manage', name);
    const v = this.st.registry.getVersion(principal.tenant, name, version);
    if (!v) throw new NotFoundError('Workflow version', `${name}@${version}`);
    if (v.status !== 'published') throw new ConflictError(`${name}@${version} is ${v.status} and cannot be activated`);
    const s = this.st.registry.patchSettings(principal.tenant, name, { stableVersion: version, clearCanary: true }, principal.id);
    this.st.events.append({ tenant: principal.tenant, type: 'workflow.rollout-changed', actor: actorOf(principal), data: { workflow: name, stable: version, canary: null } });
    this.emitter.emit('activated', { tenant: principal.tenant, workflow: name, version });
    return s;
  }

  setCanary(principal: Principal, name: string, version: string, percent: number): WorkflowSettings {
    this.authorise(principal, 'workflow.manage', name);
    if (!this.st.registry.getVersion(principal.tenant, name, version)) throw new NotFoundError('Workflow version', `${name}@${version}`);
    const s = this.st.registry.patchSettings(principal.tenant, name, percent <= 0 ? { clearCanary: true } : { canaryVersion: version, canaryPercent: Math.min(100, Math.floor(percent)) }, principal.id);
    this.st.events.append({ tenant: principal.tenant, type: 'workflow.rollout-changed', actor: actorOf(principal), data: { workflow: name, canary: percent <= 0 ? null : version, percent } });
    return s;
  }

  promoteCanary(principal: Principal, name: string): WorkflowSettings {
    const cur = this.st.registry.getSettings(principal.tenant, name);
    if (!cur?.canaryVersion) throw new ConflictError(`${name} has no canary to promote`);
    return this.activate(principal, name, cur.canaryVersion);
  }

  rollbackCanary(principal: Principal, name: string, reason = 'manual rollback'): WorkflowSettings {
    this.authorise(principal, 'workflow.manage', name);
    const s = this.st.registry.patchSettings(principal.tenant, name, { clearCanary: true }, principal.id);
    this.st.events.append({ tenant: principal.tenant, type: 'workflow.rollout-changed', actor: actorOf(principal), data: { workflow: name, canary: null, rolledBack: true, reason } });
    return s;
  }

  deprecate(principal: Principal, name: string, version: string): void {
    this.authorise(principal, 'workflow.manage', name);
    const settings = this.st.registry.getSettings(principal.tenant, name);
    if (settings?.stableVersion === version) throw new ConflictError('The stable version cannot be deprecated; activate another version first');
    this.st.registry.setStatus(principal.tenant, name, version, 'deprecated');
    this.st.events.append({ tenant: principal.tenant, type: 'workflow.deprecated', actor: actorOf(principal), data: { workflow: name, version } });
  }

  /** Enable/disable and the workflow-level kill switch (§12.3). */
  setEnabled(principal: Principal, name: string, enabled: boolean): WorkflowSettings {
    this.authorise(principal, 'workflow.manage', name);
    const s = this.st.registry.patchSettings(principal.tenant, name, { enabled }, principal.id);
    this.st.events.append({ tenant: principal.tenant, type: 'workflow.settings-changed', actor: actorOf(principal), data: { workflow: name, enabled } });
    if (!enabled) this.emitter.emit('deactivated', { tenant: principal.tenant, workflow: name });
    else if (s.stableVersion) this.emitter.emit('activated', { tenant: principal.tenant, workflow: name, version: s.stableVersion });
    return s;
  }

  kill(principal: Principal, name: string, reason: string): WorkflowSettings {
    this.authorise(principal, 'workflow.manage', name);
    const s = this.st.registry.patchSettings(principal.tenant, name, { killed: true, killReason: reason }, principal.id);
    this.st.events.append({ tenant: principal.tenant, type: 'workflow.killed', actor: actorOf(principal), data: { workflow: name, reason } });
    return s;
  }

  revive(principal: Principal, name: string): WorkflowSettings {
    this.authorise(principal, 'workflow.manage', name);
    const s = this.st.registry.patchSettings(principal.tenant, name, { killed: false }, principal.id);
    this.st.events.append({ tenant: principal.tenant, type: 'workflow.revived', actor: actorOf(principal), data: { workflow: name } });
    return s;
  }

  setAutonomy(principal: Principal, name: string, tier: AutonomyTier): WorkflowSettings {
    if (!principal.roles.includes('admin')) throw new ForbiddenError('Only admins can change a workflow’s autonomy tier');
    const s = this.st.registry.patchSettings(principal.tenant, name, { autonomyTier: tier }, principal.id);
    this.st.events.append({ tenant: principal.tenant, type: 'workflow.settings-changed', actor: actorOf(principal), data: { workflow: name, autonomyTier: tier } });
    return s;
  }

  // ---------------------------------------------------------------- lookups
  /** The version a new run should use: the canary for `percent`% of keys, otherwise stable. */
  resolveActive(tenant: string, name: string, key: string): { version: VersionRecord; plan: Plan; canary: boolean } {
    const settings = this.st.registry.getSettings(tenant, name);
    if (!settings) throw new NotFoundError('Workflow', name);
    let wanted = settings.stableVersion;
    let canary = false;
    if (settings.canaryVersion && settings.canaryPercent > 0) {
      const bucket = Number.parseInt(sha256Hex(`${name}:${key}`).slice(0, 8), 16) % 100;
      if (bucket < settings.canaryPercent) {
        wanted = settings.canaryVersion;
        canary = true;
      }
    }
    if (!wanted) throw new ConflictError(`Workflow '${name}' has no active version`);
    const version = this.st.registry.getVersion(tenant, name, wanted);
    const plan = version && this.st.registry.getPlan(tenant, version.planHash);
    if (!version || !plan) throw new NotFoundError('Workflow version', `${name}@${wanted}`);
    return { version, plan, canary };
  }

  getVersionPlan(tenant: string, name: string, version: string): { version: VersionRecord; plan: Plan } {
    const v = this.st.registry.getVersion(tenant, name, version);
    const plan = v && this.st.registry.getPlan(tenant, v.planHash);
    if (!v || !plan) throw new NotFoundError('Workflow version', `${name}@${version}`);
    return { version: v, plan };
  }

  private mustGetChange(tenant: string, id: string): ChangeRecord {
    const c = this.st.authoring.getChange(id, tenant);
    if (!c) throw new NotFoundError('Change request', id);
    return c;
  }

  private authorise(principal: Principal, action: 'workflow.manage', workflow: string): void {
    const d = this.policy.decide({ principal, action, resource: { tenant: principal.tenant, workflow } });
    if (d.effect !== 'allow') throw new PolicyDeniedError(d.reasonCode, d.reason);
  }

  private audit(principal: Principal, action: string, d: PolicyDecision, workflow: string): void {
    if (d.effect === 'allow') return;
    this.st.events.append({
      tenant: principal.tenant,
      type: 'policy.decision',
      actor: actorOf(principal),
      data: { action, effect: d.effect, reasonCode: d.reasonCode, reason: d.reason, workflow },
    });
  }
}

function actorOf(p: Principal): { type: string; id: string; name: string } {
  return { type: p.type, id: p.id, name: p.name };
}

