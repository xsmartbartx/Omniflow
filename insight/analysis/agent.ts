import { type Clock, createLogger, type Logger, systemClock } from '../../core/index.ts';
import type { ProposalRecord, State } from '../../state/index.ts';
import { analyse } from './rules.ts';
import { type AnalysisInput, DEFAULT_THRESHOLDS, type Finding, type Thresholds, type WorkflowFacts } from './types.ts';

export const ANALYSIS_SOURCE = 'analysis-agent';

export interface AnalysisAgentDeps {
  state: State;
  clock?: Clock;
  log?: Logger;
  thresholds?: Partial<Thresholds>;
  /** How much history to consider. */
  windowDays?: number;
  /** How long a dismissed finding stays quiet before it may be raised again. */
  dismissCooldownDays?: number;
  /** How long an accepted finding stays quiet, giving the fix time to show up in the data. */
  acceptedCooldownDays?: number;
}

export interface AnalysisReport {
  tenant: string;
  findings: Finding[];
  /** Proposals newly placed in the queue. */
  raised: ProposalRecord[];
  /** Findings that were already open, or recently dismissed/accepted, and so were not raised again. */
  suppressed: number;
  /** Open proposals of ours whose problem has since gone away. */
  resolved: number;
}

/**
 * The Analysis Agent (architecture §5.1 #20, §13.2). It reads history — never the execution plane —
 * and its only output is the proposal queue: "AI proposes, engine disposes". It has no handle on the
 * registry, scheduler or orchestrator (the layer checker forbids importing them), so a defect or a
 * poisoned input here can, at worst, put a useless suggestion in front of a human.
 */
export class AnalysisAgent {
  private readonly st: State;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly thresholds: Thresholds;
  private readonly windowDays: number;
  private readonly dismissCooldownMs: number;
  private readonly acceptedCooldownMs: number;

  constructor(deps: AnalysisAgentDeps) {
    this.st = deps.state;
    this.clock = deps.clock ?? systemClock;
    this.log = deps.log ?? createLogger({ level: 'silent' });
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...deps.thresholds };
    this.windowDays = deps.windowDays ?? 14;
    this.dismissCooldownMs = (deps.dismissCooldownDays ?? 30) * 86_400_000;
    this.acceptedCooldownMs = (deps.acceptedCooldownDays ?? 14) * 86_400_000;
  }

  /** Snapshot the history the rules reason over. */
  gather(tenant: string): AnalysisInput {
    const now = this.clock.now();
    const since = new Date(now.getTime() - this.windowDays * 86_400_000).toISOString();
    const runStats = new Map(this.st.analytics.workflowRunStats(tenant, since).map((r) => [r.workflow, r]));
    const stepStats = this.st.analytics.stepStats(tenant, since);
    const stepErrors = this.st.analytics.stepErrors(tenant, since);

    const workflows: WorkflowFacts[] = [];
    for (const w of this.st.registry.listWorkflows(tenant)) {
      const version = w.settings.stableVersion;
      const record = version ? this.st.registry.getVersion(tenant, w.name, version) : undefined;
      const plan = record ? this.st.registry.getPlan(tenant, record.planHash) : undefined;
      if (!record || !plan) continue;
      const errors = new Map<string, typeof stepErrors>();
      for (const e of stepErrors) if (e.workflow === w.name) errors.set(e.stepId, [...(errors.get(e.stepId) ?? []), e]);
      workflows.push({
        name: w.name,
        version: record.version,
        enabled: w.settings.enabled,
        killed: w.settings.killed,
        activeSince: record.publishedAt,
        plan,
        runs: runStats.get(w.name) ?? { workflow: w.name, total: 0, succeeded: 0, failed: 0, cancelled: 0, cost: 0 },
        steps: new Map(stepStats.filter((s) => s.workflow === w.name).map((s) => [s.stepId, s])),
        errors,
      });
    }
    return {
      now: now.toISOString(),
      today: now.toISOString().slice(0, 10),
      windowDays: this.windowDays,
      workflows,
      approvals: this.st.analytics.approvalStats(tenant, since),
      timings: this.st.analytics.runTimings(tenant, since),
    };
  }

  /** Findings only — nothing is written. */
  analyse(tenant: string): Finding[] {
    return analyse(this.gather(tenant), this.thresholds);
  }

  /** Analyse, then put new findings in the proposal queue. */
  run(tenant: string): AnalysisReport {
    const findings = this.analyse(tenant);
    const now = this.clock.now().getTime();
    const existing = this.st.authoring.listProposals(tenant).filter((p) => p.source === ANALYSIS_SOURCE);
    const keyOf = (p: ProposalRecord) => (p.body as { key?: string } | null)?.key;
    const open = new Map(existing.filter((p) => p.status === 'open').map((p) => [keyOf(p), p]));

    const raised: ProposalRecord[] = [];
    let suppressed = 0;
    for (const f of findings) {
      if (open.has(f.key) || this.coolingDown(existing, f.key, now)) {
        suppressed++;
        continue;
      }
      const p = this.st.authoring.createProposal({
        tenant,
        kind: `analysis.${f.rule}`,
        ...(f.workflow ? { workflowName: f.workflow } : {}),
        title: f.title,
        body: {
          key: f.key,
          rule: f.rule,
          severity: f.severity,
          stepId: f.stepId ?? null,
          summary: f.summary,
          recommendation: f.recommendation,
          evidence: f.evidence,
        },
        source: ANALYSIS_SOURCE,
        dedupeKey: f.key,
      });
      if (!p) {
        suppressed++;
        continue;
      }
      raised.push(p);
      this.st.events.append({
        tenant,
        type: 'agent.proposal-created',
        actor: { type: 'agent', id: ANALYSIS_SOURCE, name: 'Analysis Agent' },
        data: {
          agent: 'analysis',
          proposalId: p.id,
          rule: f.rule,
          severity: f.severity,
          ...(f.workflow ? { workflow: f.workflow } : {}),
        },
      });
    }

    // A finding that no longer holds should not keep nagging: retire the proposal we raised for it.
    const live = new Set(findings.map((f) => f.key));
    let resolved = 0;
    for (const [key, p] of open) {
      if (key === undefined || live.has(key) || now - Date.parse(p.createdAt) < 86_400_000) continue;
      this.st.authoring.decideProposal(p.id, 'dismissed', ANALYSIS_SOURCE);
      resolved++;
    }

    this.st.events.append({
      tenant,
      type: 'insight.analysis-completed',
      actor: { type: 'agent', id: ANALYSIS_SOURCE },
      data: { findings: findings.length, proposals: raised.length, suppressed, resolved, windowDays: this.windowDays },
    });
    this.log.info('analysis completed', {
      tenant,
      findings: findings.length,
      proposals: raised.length,
      suppressed,
      resolved,
    });
    return { tenant, findings, raised, suppressed, resolved };
  }

  /** Analyse every tenant. One tenant's failure must not stop the others. */
  runAll(): AnalysisReport[] {
    const out: AnalysisReport[] = [];
    for (const t of this.st.identity.listTenants()) {
      if (t.disabled) continue;
      try {
        out.push(this.run(t.id));
      } catch (e) {
        this.log.error('analysis failed', { tenant: t.id, error: e });
      }
    }
    return out;
  }

  private coolingDown(existing: ProposalRecord[], key: string, now: number): boolean {
    return existing.some((p) => {
      if ((p.body as { key?: string } | null)?.key !== key || p.status === 'open' || !p.decidedAt) return false;
      if (p.decidedBy === ANALYSIS_SOURCE) return false; // retired because it went away; if it is back, say so
      const age = now - Date.parse(p.decidedAt);
      return age < (p.status === 'accepted' ? this.acceptedCooldownMs : this.dismissCooldownMs);
    });
  }
}
