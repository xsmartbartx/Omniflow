import { ExpressionError, evaluate, type Issue, isTruthy, type Node, parseExpressionField } from '../../core/index.ts';
import type { Plan } from '../../schemas/plan.ts';
import type { Action, AutonomyTier, EnvironmentName, PolicyDecision, Principal, Role } from '../../schemas/policy.ts';
import type { PolicyDocument } from '../../schemas/policy-manifest.ts';

/**
 * Policy Engine (architecture §5.1 #4): may this principal do this, in this environment, against
 * these capabilities? Returns allow / deny / require-approval with a reason code. It cannot
 * execute anything. It evaluates the *whole plan* — cumulative scope analysis (threat T5) — not
 * individual steps.
 */

// --------------------------------------------------------------------- RBAC
const VIEW: Action[] = ['workflow.read', 'run.read'];

export const ROLE_ACTIONS: Record<Role, ReadonlySet<Action> | 'all'> = {
  admin: 'all',
  author: new Set<Action>([
    ...VIEW,
    'workflow.draft',
    'workflow.publish',
    'workflow.run',
    'agent.invoke',
    'secret.read-names',
  ]),
  operator: new Set<Action>([
    ...VIEW,
    'workflow.run',
    'workflow.manage',
    'run.cancel',
    'run.retry',
    'trigger.manage',
    'event.publish',
    'secret.read-names',
    'audit.read',
  ]),
  approver: new Set<Action>([...VIEW, 'approval.decide', 'workflow.approve-change']),
  viewer: new Set<Action>(VIEW),
};

/** Agents may read and draft. They can never publish, run, approve or manage — ADR-0002 D4. */
export const AGENT_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  'workflow.read',
  'run.read',
  'workflow.draft',
  'agent.invoke',
]);

export function roleAllows(roles: readonly Role[], action: Action): boolean {
  return roles.some((r) => {
    const set = ROLE_ACTIONS[r];
    return set === 'all' || set?.has(action);
  });
}

// ------------------------------------------------------------------- config
export interface ScopeRule {
  /** All of these scopes together trigger the rule. */
  scopes: string[];
  effect: 'deny' | 'require-approval';
  reason: string;
}

/** Default cumulative-scope rules: combinations that make exfiltration or lateral movement possible. */
export const DEFAULT_SCOPE_RULES: ScopeRule[] = [
  {
    scopes: ['db:read', 'network:http'],
    effect: 'require-approval',
    reason: 'reads database content and can send it over the network (exfiltration path)',
  },
  {
    scopes: ['storage:read', 'network:http'],
    effect: 'require-approval',
    reason: 'reads stored files and can send them over the network (exfiltration path)',
  },
  {
    scopes: ['process:exec', 'network:http'],
    effect: 'require-approval',
    reason: 'runs local processes and can reach the network',
  },
  {
    scopes: ['process:exec', 'db:write'],
    effect: 'require-approval',
    reason: 'runs local processes and can modify database content',
  },
];

export interface PolicyConfig {
  environment: EnvironmentName;
  /** Tenant whose admins may manage tenants. */
  platformTenant: string;
  scopeRules: ScopeRule[];
  /** Approvals required for a production publish that needs one. */
  publishApprovals: number;
  /** Bounds for T3 autonomy. */
  blastRadius: { maxRunCost: number };
}

export function defaultPolicyConfig(over: Partial<PolicyConfig> = {}): PolicyConfig {
  return {
    environment: 'production',
    platformTenant: 'default',
    scopeRules: DEFAULT_SCOPE_RULES,
    publishApprovals: 1,
    blastRadius: { maxRunCost: 100 },
    ...over,
  };
}

// ------------------------------------------------------------------ request
export interface RiskSummary {
  score: number;
  level: 'low' | 'medium' | 'high' | 'critical';
  /** True when at least one finding blocks promotion. */
  blocking: boolean;
  findings: number;
}

export interface PolicyRequest {
  principal: Principal;
  action: Action;
  resource?: {
    tenant?: string;
    workflow?: string;
    version?: string;
    criticality?: string;
    environment?: EnvironmentName;
    plan?: Plan;
    risk?: RiskSummary;
    /** Who authored the artifact being acted on. */
    origin?: 'human' | 'agent';
    autonomyTier?: AutonomyTier;
    dryRun?: boolean;
    /** Principal id that requested the change being approved (four-eyes). */
    changeAuthor?: string;
  };
}

interface CompiledRule {
  doc: string;
  id: string;
  effect: 'deny' | 'require-approval';
  actions: ReadonlySet<string> | null;
  when: Node;
  reason: string;
  approvals: number;
}

interface Gates {
  denials: Array<{ code: string; reason: string; rule?: string }>;
  approvals: Array<{ code: string; reason: string; approvals: number; rule?: string }>;
}

const deny = (reasonCode: string, reason: string, ruleIds?: string[]): PolicyDecision => ({
  effect: 'deny',
  reasonCode,
  reason,
  ...(ruleIds ? { ruleIds } : {}),
});

/** Any denial wins; otherwise any approval requirement (the strictest count); otherwise allow. */
function verdict({ denials, approvals }: Gates): PolicyDecision {
  if (denials.length > 0) {
    return deny(
      denials[0]!.code,
      denials.map((d) => d.reason).join('; '),
      denials.flatMap((d) => (d.rule ? [d.rule] : [])),
    );
  }
  if (approvals.length > 0) {
    return {
      effect: 'require-approval',
      reasonCode: approvals[0]!.code,
      reason: approvals.map((r) => r.reason).join('; '),
      requiredApprovals: Math.max(...approvals.map((r) => r.approvals)),
      ruleIds: approvals.flatMap((r) => (r.rule ? [r.rule] : [])),
    };
  }
  return { effect: 'allow', reasonCode: 'ALLOWED', reason: 'Permitted' };
}

export class PolicyEngine {
  private readonly config: PolicyConfig;
  private rules: CompiledRule[] = [];

  constructor(config: PolicyConfig = defaultPolicyConfig()) {
    this.config = config;
  }

  /** Bounds for T3 autonomy (used by the change service to decide what an agent may publish on its own). */
  get blastRadius(): { maxRunCost: number } {
    return this.config.blastRadius;
  }

  get environment(): EnvironmentName {
    return this.config.environment;
  }

  /** Load validated policy documents (see `parsePolicyDocument`). Replaces any previously loaded set. */
  loadDocuments(docs: PolicyDocument[]): Issue[] {
    const issues: Issue[] = [];
    const compiled: CompiledRule[] = [];
    for (const doc of docs) {
      for (const r of doc.rules) {
        try {
          compiled.push({
            doc: doc.metadata.name,
            id: `${doc.metadata.name}/${r.id}`,
            effect: r.effect,
            actions: r.actions ? new Set(r.actions) : null,
            when: parseExpressionField(r.when),
            reason: r.reason,
            approvals: r.approvals ?? 1,
          });
        } catch (e) {
          issues.push({
            path: `${doc.metadata.name}/${r.id}`,
            code: 'POLICY_EXPRESSION',
            message: (e as Error).message,
          });
        }
      }
    }
    this.rules = compiled;
    return issues;
  }

  get ruleCount(): number {
    return this.rules.length;
  }

  /** Coarse check: does any role of this principal permit the action at all? */
  can(principal: Principal, action: Action): boolean {
    if (principal.type === 'agent') return AGENT_ACTIONS.has(action) && roleAllows(principal.roles, action);
    return roleAllows(principal.roles, action);
  }

  decide(req: PolicyRequest): PolicyDecision {
    const { action } = req;
    const hard = this.hardDenial(req);
    if (hard) return hard;

    const gates: Gates = { denials: [], approvals: [] };
    const env = req.resource?.environment ?? this.config.environment;
    const plan = req.resource?.plan;

    if (action === 'workflow.publish') this.publishGates(req, env, gates);
    // Cumulative scope analysis over the whole plan (T5) — on publish and run
    if (plan && (action === 'workflow.publish' || action === 'workflow.run')) this.scopeGates(plan, action, env, gates);
    // Operator-defined policy documents
    if (this.rules.length > 0) this.documentGates(req, env, gates);
    return verdict(gates);
  }

  /** Checks that refuse outright, in order: tenant isolation, agents' lack of execution authority, RBAC, four-eyes. */
  private hardDenial(req: PolicyRequest): PolicyDecision | undefined {
    const { principal, action } = req;
    const res = req.resource ?? {};
    if (res.tenant && res.tenant !== principal.tenant) {
      const platformAdmin =
        principal.tenant === this.config.platformTenant &&
        principal.roles.includes('admin') &&
        action === 'tenant.manage';
      if (!platformAdmin) return deny('TENANT_MISMATCH', 'The resource belongs to another tenant');
    }
    if (principal.type === 'agent' && !AGENT_ACTIONS.has(action)) {
      return deny('AGENT_NO_EXECUTION', `Agents may only propose; '${action}' requires a human or a governed workflow`);
    }
    if (!roleAllows(principal.roles, action)) {
      return deny('RBAC_DENIED', `Roles [${principal.roles.join(', ')}] do not permit '${action}'`);
    }
    if (action === 'tenant.manage' && principal.tenant !== this.config.platformTenant) {
      return deny('PLATFORM_ADMIN_ONLY', 'Only platform administrators can manage tenants');
    }
    if (action === 'workflow.approve-change' && res.changeAuthor && res.changeAuthor === principal.id) {
      return deny('SELF_APPROVAL', 'A change cannot be approved by the person who requested it');
    }
    return undefined;
  }

  private publishGates(req: PolicyRequest, env: EnvironmentName, gates: Gates): void {
    const res = req.resource ?? {};
    const approvals = this.config.publishApprovals;
    if (res.risk?.blocking) {
      gates.denials.push({
        code: 'BLOCKING_FINDINGS',
        reason: 'The pentest review raised blocking findings; resolve them before publishing',
      });
    }
    if (env !== 'production') return;
    const plan = res.plan;
    if (plan?.analysis.effects.effectful) {
      gates.approvals.push({
        code: 'PROD_EFFECTFUL_NEEDS_APPROVAL',
        reason: 'Production workflows with effectful steps need a second pair of eyes',
        approvals,
      });
    }
    if (plan?.analysis.families.includes('shell')) {
      gates.approvals.push({
        code: 'PROD_SHELL_NEEDS_APPROVAL',
        reason: 'Shell steps are the largest risk surface and need human approval',
        approvals,
      });
    }
    if (plan && (res.criticality === 'high' || res.criticality === 'critical')) {
      gates.approvals.push({
        code: 'PROD_CRITICAL_NEEDS_APPROVAL',
        reason: `Workflow criticality is ${res.criticality}`,
        approvals,
      });
    }
    if (res.risk && (res.risk.level === 'high' || res.risk.level === 'critical')) {
      gates.approvals.push({
        code: 'HIGH_RISK_NEEDS_APPROVAL',
        reason: `Risk level is ${res.risk.level} (score ${res.risk.score})`,
        approvals,
      });
    }
  }

  private scopeGates(plan: Plan, action: Action, env: EnvironmentName, gates: Gates): void {
    const scopes = new Set(plan.analysis.scopes);
    for (const rule of this.config.scopeRules) {
      if (!rule.scopes.every((s) => scopes.has(s))) continue;
      const code = `SCOPE_COMBINATION_${rule.scopes
        .join('+')
        .toUpperCase()
        .replace(/[^A-Z0-9+]/g, '_')}`;
      const reason = `Combined scopes ${rule.scopes.join(' + ')}: ${rule.reason}`;
      if (rule.effect === 'deny') gates.denials.push({ code, reason });
      else if (env === 'production' || action === 'workflow.publish')
        gates.approvals.push({ code, reason, approvals: this.config.publishApprovals });
    }
  }

  private documentGates(req: PolicyRequest, env: EnvironmentName, gates: Gates): void {
    const facts = this.facts(req, env);
    for (const rule of this.rules) {
      if (rule.actions && !rule.actions.has(req.action)) continue;
      if (!this.ruleHits(rule, facts)) continue;
      if (rule.effect === 'deny')
        gates.denials.push({ code: 'POLICY_RULE_DENIED', reason: rule.reason, rule: rule.id });
      else
        gates.approvals.push({
          code: 'POLICY_RULE_NEEDS_APPROVAL',
          reason: rule.reason,
          approvals: rule.approvals,
          rule: rule.id,
        });
    }
  }

  private ruleHits(rule: CompiledRule, facts: Record<string, unknown>): boolean {
    try {
      return isTruthy(evaluate(rule.when, facts));
    } catch (e) {
      // A policy rule that cannot be evaluated fails closed for deny rules.
      return rule.effect === 'deny' && e instanceof ExpressionError;
    }
  }

  private facts(req: PolicyRequest, env: EnvironmentName): Record<string, unknown> {
    const { principal, action } = req;
    const r = req.resource ?? {};
    return {
      action,
      environment: env,
      principal: {
        id: principal.id,
        type: principal.type,
        name: principal.name,
        tenant: principal.tenant,
        roles: principal.roles,
      },
      workflow: { name: r.workflow ?? null, version: r.version ?? null, criticality: r.criticality ?? null },
      plan: r.plan
        ? { analysis: r.plan.analysis, environment: r.plan.environment, stepCount: r.plan.steps.length }
        : null,
      risk: r.risk ?? null,
      resource: { origin: r.origin ?? 'human', dryRun: r.dryRun ?? false, tenant: r.tenant ?? principal.tenant },
      autonomy: { tier: r.autonomyTier ?? 'T1' },
    };
  }
}
