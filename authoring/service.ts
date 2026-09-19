import type { CapabilityRegistry } from '../capabilities/index.ts';
import {
  type Clock,
  ConflictError,
  NotFoundError,
  OmniflowError,
  systemClock,
  ValidationError,
} from '../core/index.ts';
import type { RegistryService, SubmitResult } from '../orchestration/registry/index.ts';
import type { Principal } from '../schemas/index.ts';
import type { PolicyEngine, RiskSummary } from '../security/policy/index.ts';
import { type AutonomyVerdict, autonomyVerdict } from '../security/policy/index.ts';
import type { DraftRecord, DraftStatus, State } from '../state/index.ts';
import { explainPlan, explainRun, type PlanExplanation, type RunExplanation } from './agents/explainer.ts';
import { type ImportResult, importCrontab } from './agents/importer.ts';
import { Planner, type PlanResult, type ValidationOutcome } from './agents/planner.ts';
import { capabilityMarkdown, indexMarkdown, workflowMarkdown, workflowMermaid } from './docs/generator.ts';
import type { LlmClient } from './llm.ts';

export interface AuthoringServiceDeps {
  state: State;
  registry: RegistryService;
  policy: PolicyEngine;
  capabilities: CapabilityRegistry;
  /** Absent when no model is configured; everything except AI drafting still works. */
  llm?: LlmClient;
  /** Model calls the Planner may spend repairing one draft. */
  plannerAttempts?: number;
  clock?: Clock;
}

export interface PlanRequestInput {
  intent: string;
  /** Improve this existing workflow instead of creating a new one. */
  workflow?: string;
  untrusted?: Array<{ label: string; content: string }>;
  proposalId?: string;
}

export interface PlanOutcome {
  /** `proposal-only` (T0): the advice is returned but nothing is stored. `draft`: a draft was saved. */
  mode: 'draft' | 'proposal-only' | 'none';
  draft?: DraftRecord;
  plan: Omit<PlanResult, 'manifest'> & { manifest?: string };
}

const AGENT = { type: 'agent', id: 'planner', name: 'Planner Agent' } as const;

/**
 * The governed change service: the only place where agent output meets the registry. Agents produce
 * text; this service stores it as a *draft*, validates it exactly as it would a human's, and — only
 * when a human asks — moves it towards publication under the workflow's autonomy tier. There is no
 * code path from a model's reply to a published version that skips validation, risk review and policy.
 */
export class AuthoringService {
  private readonly st: State;
  private readonly registry: RegistryService;
  private readonly policy: PolicyEngine;
  private readonly caps: CapabilityRegistry;
  private readonly planner: Planner | undefined;
  private readonly clock: Clock;

  constructor(deps: AuthoringServiceDeps) {
    this.st = deps.state;
    this.registry = deps.registry;
    this.policy = deps.policy;
    this.caps = deps.capabilities;
    this.planner = deps.llm
      ? new Planner({
          llm: deps.llm,
          // Agent-origin validation: stricter risk heuristics, and strictly read-only.
          validate: (text, tenant) => this.validateText(tenant, text, 'agent'),
          capabilities: () => this.caps.latest().map((c) => c.declaration),
          ...(deps.plannerAttempts ? { maxAttempts: deps.plannerAttempts } : {}),
        })
      : undefined;
    this.clock = deps.clock ?? systemClock;
  }

  get aiEnabled(): boolean {
    return this.planner !== undefined;
  }

  // ------------------------------------------------------------ validation
  /** Read-only: parse, compile and risk-review. */
  validateText(
    tenant: string,
    text: string,
    origin: 'human' | 'agent' = 'human',
  ): ValidationOutcome & { planHash?: string; workflow?: string; version?: string } {
    const r = this.registry.inspect(tenant, text, origin);
    return {
      ok: r.ok && !r.risk?.blocking,
      errors: r.errors,
      warnings: r.warnings,
      ...(r.risk
        ? {
            risk: {
              score: r.risk.score,
              level: r.risk.level,
              blocking: r.risk.blocking,
              findings: r.risk.findings.map((f) => ({
                ruleId: f.ruleId,
                severity: f.severity,
                blocking: f.blocking,
                message: f.message,
                ...(f.stepId ? { stepId: f.stepId } : {}),
              })),
            },
          }
        : {}),
      ...(r.planHash ? { planHash: r.planHash } : {}),
      ...(r.plan ? { workflow: r.plan.workflow.name, version: r.plan.workflow.version } : {}),
    };
  }

  // ---------------------------------------------------------------- drafts
  createDraft(
    principal: Principal,
    input: { manifest: string; origin?: 'human' | 'agent' | 'import'; notes?: Record<string, unknown> },
  ): DraftRecord {
    const origin = input.origin ?? 'human';
    const v = this.validateText(principal.tenant, input.manifest, origin === 'agent' ? 'agent' : 'human');
    return this.st.authoring.createDraft({
      tenant: principal.tenant,
      ...(v.workflow ? { workflowName: v.workflow } : {}),
      manifestText: input.manifest,
      origin,
      createdBy: principal.id,
      notes: input.notes ?? {},
      validation: v,
    });
  }

  getDraft(principal: Principal, id: string): DraftRecord {
    const d = this.st.authoring.getDraft(id, principal.tenant);
    if (!d) throw new NotFoundError('Draft', id);
    return d;
  }

  listDrafts(principal: Principal, status?: DraftStatus): DraftRecord[] {
    return this.st.authoring.listDrafts(principal.tenant, status);
  }

  updateDraft(principal: Principal, id: string, manifest: string): DraftRecord {
    const d = this.getDraft(principal, id);
    if (d.status === 'published')
      throw new ConflictError('A published draft cannot be edited; create a new draft or a new version');
    const v = this.validateText(principal.tenant, manifest, d.origin === 'agent' ? 'agent' : 'human');
    return this.st.authoring.updateDraft(id, {
      manifestText: manifest,
      ...(v.workflow ? { workflowName: v.workflow } : {}),
      status: 'open',
      validation: v,
    });
  }

  revalidate(principal: Principal, id: string): DraftRecord {
    const d = this.getDraft(principal, id);
    return this.st.authoring.updateDraft(id, {
      validation: this.validateText(principal.tenant, d.manifestText, d.origin === 'agent' ? 'agent' : 'human'),
    });
  }

  deleteDraft(principal: Principal, id: string): void {
    this.getDraft(principal, id);
    if (!this.st.authoring.deleteDraft(principal.tenant, id))
      throw new ConflictError('A published draft cannot be deleted');
  }

  // -------------------------------------------------------------- AI drafting
  private requirePlanner(): Planner {
    if (!this.planner) {
      throw new OmniflowError(
        'AI_NOT_CONFIGURED',
        'AI authoring is not configured. Set OMNIFLOW_LLM_API_KEY (or ANTHROPIC_API_KEY) and restart. Everything else works without it.',
        { errorClass: 'systemic', retryable: false },
      );
    }
    return this.planner;
  }

  /** Turn intent into a draft. The Planner sees the capability catalogue and a validator; it sees nothing else. */
  async plan(principal: Principal, req: PlanRequestInput, signal?: AbortSignal): Promise<PlanOutcome> {
    const planner = this.requirePlanner();
    let baseManifest: string | undefined;
    let tier: 'T0' | 'T1' | 'T2' | 'T3' = 'T1';
    if (req.workflow) {
      const settings = this.st.registry.getSettings(principal.tenant, req.workflow);
      if (!settings?.stableVersion) throw new NotFoundError('Workflow', req.workflow);
      tier = settings.autonomyTier;
      baseManifest = this.registry.getVersionPlan(principal.tenant, req.workflow, settings.stableVersion).version
        .manifestText;
    }
    const result = await planner.plan(
      {
        tenant: principal.tenant,
        intent: req.intent,
        ...(baseManifest ? { baseManifest } : {}),
        ...(req.untrusted ? { untrusted: req.untrusted } : {}),
      },
      signal,
    );
    const { manifest, ...summary } = result;

    if (tier === 'T0' && req.workflow) {
      // Advisory only: show the proposal, store nothing.
      return { mode: 'proposal-only', plan: { ...summary, ...(manifest ? { manifest } : {}) } };
    }
    if (!manifest) return { mode: 'none', plan: summary };

    const draft = this.createDraft(principal, {
      manifest,
      origin: 'agent',
      notes: {
        agent: 'planner',
        intent: req.intent.slice(0, 2000),
        rationale: result.rationale,
        openQuestions: result.openQuestions,
        attempts: result.attempts,
        model: result.model,
        usage: result.usage,
        injectionSignals: result.injectionSignals,
        ...(req.workflow ? { revises: req.workflow } : {}),
        ...(req.proposalId ? { proposalId: req.proposalId } : {}),
      },
    });
    this.st.events.append({
      tenant: principal.tenant,
      type: 'agent.draft-created',
      actor: { ...AGENT },
      data: {
        agent: 'planner',
        draftId: draft.id,
        requestedBy: principal.id,
        valid: result.ok,
        attempts: result.attempts,
        ...(req.workflow ? { workflow: req.workflow } : {}),
        ...(result.injectionSignals.length ? { injectionSignals: result.injectionSignals.length } : {}),
      },
    });
    return { mode: 'draft', draft, plan: { ...summary, manifest } };
  }

  /** Close the learning loop (§13.2): an Analysis Agent proposal becomes a draft revision of the affected workflow. */
  async draftFromProposal(principal: Principal, proposalId: string, signal?: AbortSignal): Promise<PlanOutcome> {
    const p = this.st.authoring.getProposal(proposalId, principal.tenant);
    if (!p) throw new NotFoundError('Proposal', proposalId);
    if (!p.workflowName)
      throw new ConflictError('This proposal is not about a specific workflow, so there is nothing to revise');
    const body = (p.body ?? {}) as {
      summary?: string;
      recommendation?: string;
      evidence?: unknown;
      stepId?: string | null;
    };
    return this.plan(
      principal,
      {
        workflow: p.workflowName,
        proposalId,
        intent: `Apply this improvement to the workflow "${p.workflowName}": ${p.title}${body.stepId ? ` (step "${body.stepId}")` : ''}.\nRecommendation: ${body.recommendation ?? ''}\nMake the smallest change that addresses it.`,
        untrusted: [
          {
            label: 'analysis evidence',
            content: JSON.stringify({ summary: body.summary, evidence: body.evidence }, null, 2),
          },
        ],
      },
      signal,
    );
  }

  /** Legacy script → decomposed draft. The script is third-party content: framed as data, never as instructions. */
  async importScript(
    principal: Principal,
    input: { script: string; name?: string; description?: string },
    signal?: AbortSignal,
  ): Promise<PlanOutcome> {
    return this.plan(
      principal,
      {
        intent: `Convert the legacy script below into an OmniFlow workflow.${input.name ? ` Name it "${input.name}".` : ''}${input.description ? ` What it is for: ${input.description}` : ''}\nReplace each recognisable operation with a typed capability from the catalogue (HTTP calls, database queries, notifications…). Anything that has no capability equivalent should be listed in <questions>. Do not use shell-exec unless nothing else fits, and then it needs a sunset date. Give every step a sensible timeout and retry policy, and add compensation where an action can be undone.`,
        untrusted: [{ label: 'legacy script', content: input.script }],
      },
      signal,
    );
  }

  /** Crontab → one Lift draft per job. Deterministic. */
  importCrontab(
    principal: Principal,
    input: { text: string; owner?: string; timezone?: string },
  ): {
    drafts: Array<{ draft: DraftRecord; notes: string[]; line: number; script?: { path: string; content: string } }>;
    skipped: ImportResult['skipped'];
    environment: ImportResult['environment'];
  } {
    const r = importCrontab(input.text, {
      owner: input.owner ?? principal.name,
      today: this.clock.now().toISOString().slice(0, 10),
      ...(input.timezone ? { timezone: input.timezone } : {}),
    });
    const drafts = r.workflows.map((w) => ({
      draft: this.createDraft(principal, {
        manifest: w.manifest,
        origin: 'import',
        notes: {
          importedFrom: 'crontab',
          line: w.line,
          source: w.source,
          notes: w.notes,
          ...(w.script ? { script: w.script } : {}),
        },
      }),
      notes: w.notes,
      line: w.line,
      ...(w.script ? { script: w.script } : {}),
    }));
    return { drafts, skipped: r.skipped, environment: r.environment };
  }

  // ------------------------------------------------- moving a draft towards publication
  /** A human submits a draft: exactly the same path as posting the manifest to the registry. */
  submitDraft(principal: Principal, id: string, opts: { canaryPercent?: number } = {}): SubmitResult {
    const d = this.getDraft(principal, id);
    if (d.status === 'published') throw new ConflictError('This draft has already been published');
    const result = this.registry.submit(principal, d.manifestText, {
      origin: d.origin === 'agent' ? 'agent' : 'human',
      ...(opts.canaryPercent ? { canaryPercent: opts.canaryPercent } : {}),
    });
    this.st.authoring.updateDraft(id, {
      status: result.status === 'published' ? 'published' : 'submitted',
      notes: {
        ...(d.notes as object),
        submittedBy: principal.id,
        outcome: result.status,
        ...(result.status === 'pending-approval'
          ? { changeId: result.change.id }
          : { version: result.version.version }),
      },
    });
    return result;
  }

  /**
   * Apply an agent-authored draft under the workflow's autonomy tier (§8.3):
   * T0/T1 — nothing happens (a human submits it); T2 in production, or T3 outside its blast radius —
   * a change request is opened for a human to approve; T2 elsewhere, or T3 inside the radius — it is
   * published through the normal pipeline, which can still ask for approval. Never bypasses policy.
   */
  applyDraft(principal: Principal, id: string): { verdict: AutonomyVerdict; tier: string; result?: SubmitResult } {
    const d = this.getDraft(principal, id);
    if (d.origin !== 'agent')
      throw new ConflictError('Autonomy tiers govern agent-authored drafts. Submit a human-authored draft directly.');
    if (d.status === 'published') throw new ConflictError('This draft has already been published');
    const inspected = this.registry.inspect(principal.tenant, d.manifestText, 'agent');
    if (!inspected.ok || !inspected.plan || !inspected.risk)
      throw new ValidationError('The draft does not validate', inspected.errors);

    const settings = this.st.registry.getSettings(principal.tenant, inspected.plan.workflow.name);
    const tier = settings?.autonomyTier ?? 'T1';
    const risk: RiskSummary = {
      score: inspected.risk.score,
      level: inspected.risk.level,
      blocking: inspected.risk.blocking,
      findings: inspected.risk.findings.length,
    };
    const verdict = autonomyVerdict(
      tier,
      this.policy.environment,
      inspected.plan,
      risk,
      this.policy.blastRadius.maxRunCost,
    );
    this.st.events.append({
      tenant: principal.tenant,
      type: 'authoring.autonomy-applied',
      actor: { type: principal.type, id: principal.id, name: principal.name },
      data: { draftId: id, workflow: inspected.plan.workflow.name, tier, mode: verdict.mode, reason: verdict.reason },
    });
    if (verdict.mode === 'proposal-only' || verdict.mode === 'draft') return { verdict, tier };

    // The governed principal is a system identity with author rights only: the human who asked is recorded in the draft's notes.
    const governed: Principal = {
      id: 'system:authoring',
      type: 'system',
      name: 'Authoring Service',
      tenant: principal.tenant,
      roles: ['author'],
    };
    const result = this.registry.submit(governed, d.manifestText, {
      origin: 'agent',
      ...(verdict.mode === 'change-request'
        ? { forceApproval: { code: 'AUTONOMY_REQUIRES_APPROVAL', reason: verdict.reason } }
        : {}),
    });
    this.st.authoring.updateDraft(id, {
      status: result.status === 'published' ? 'published' : 'submitted',
      notes: {
        ...(d.notes as object),
        appliedBy: principal.id,
        tier,
        verdict: verdict.mode,
        outcome: result.status,
        ...(result.status === 'pending-approval'
          ? { changeId: result.change.id }
          : { version: result.version.version }),
      },
    });
    return { verdict, tier, result };
  }

  // -------------------------------------------------------- explain and document
  private planFor(principal: Principal, name: string, version?: string) {
    const v =
      version ??
      this.st.registry.getSettings(principal.tenant, name)?.stableVersion ??
      this.st.registry.latestVersion(principal.tenant, name)?.version;
    if (!v) throw new NotFoundError('Workflow', name);
    return this.registry.getVersionPlan(principal.tenant, name, v);
  }

  explainWorkflow(principal: Principal, name: string, version?: string): PlanExplanation & { version: string } {
    const { plan, version: v } = this.planFor(principal, name, version);
    return { ...explainPlan(plan), version: v.version };
  }

  explainRun(principal: Principal, runId: string): RunExplanation {
    const run = this.st.runs.getRun(runId, principal.tenant);
    if (!run) throw new NotFoundError('Run', runId);
    const plan = this.st.registry.getPlan(run.tenant, run.planHash);
    return explainRun({
      run,
      steps: this.st.runs.getSteps(run.id),
      ...(plan ? { plan } : {}),
      approvals: this.st.approvals.list({ tenant: run.tenant, runId: run.id }),
    });
  }

  workflowDocs(
    principal: Principal,
    name: string,
    version?: string,
  ): { version: string; markdown: string; mermaid: string } {
    const { plan, version: v } = this.planFor(principal, name, version);
    const settings = this.st.registry.getSettings(principal.tenant, name);
    const findings = this.st.authoring.listFindings(principal.tenant, name, v.version);
    const risk = v.risk as { level?: string; score?: number } | undefined;
    return {
      version: v.version,
      mermaid: workflowMermaid(plan),
      markdown: workflowMarkdown(plan, {
        ...(settings
          ? {
              settings: {
                enabled: settings.enabled,
                killed: settings.killed,
                autonomyTier: settings.autonomyTier,
                ...(settings.stableVersion ? { stableVersion: settings.stableVersion } : {}),
              },
            }
          : {}),
        versions: this.st.registry.listVersions(principal.tenant, name).map((x) => ({
          version: x.version,
          status: x.status,
          publishedAt: x.publishedAt,
          publishedBy: x.publishedBy,
        })),
        ...(risk?.level
          ? {
              risk: {
                level: risk.level,
                score: risk.score ?? 0,
                findings: findings.map((f) => ({
                  severity: f.severity,
                  message: f.message,
                  ...(f.detail && typeof f.detail === 'object' && 'stepId' in f.detail
                    ? { stepId: String((f.detail as { stepId: unknown }).stepId) }
                    : {}),
                })),
              },
            }
          : {}),
      }),
    };
  }

  catalogueDocs(): string {
    return capabilityMarkdown(this.caps.list().map((c) => c.declaration));
  }

  indexDocs(principal: Principal): string {
    return indexMarkdown(
      this.st.registry.listWorkflows(principal.tenant).map((w) => {
        const v = w.settings.stableVersion
          ? this.st.registry.getVersion(principal.tenant, w.name, w.settings.stableVersion)
          : undefined;
        const plan = v ? this.st.registry.getPlan(principal.tenant, v.planHash) : undefined;
        return {
          name: w.name,
          description: plan?.workflow.description ?? null,
          stableVersion: w.settings.stableVersion ?? null,
          criticality: plan?.workflow.criticality ?? null,
          owner: plan?.workflow.owner ?? null,
        };
      }),
    );
  }
}
