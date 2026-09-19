import type { Plan } from '../../schemas/plan.ts';
import type { AutonomyTier, EnvironmentName } from '../../schemas/policy.ts';
import { sensitivityRank } from '../../core/index.ts';
import type { RiskSummary } from './engine.ts';

/**
 * Autonomy tiers (architecture §8.3). Decides what an *agent-authored* artifact may do. The
 * default tier is T1. This is a pure function of tier, environment and blast radius — the agent
 * itself never gets a write path; the governed change service acts on this verdict using the same
 * validation and approval path as a human's.
 */
export type AutonomyMode =
  /** T0 — advisory: nothing is applied and nothing is stored as a draft. */
  | 'proposal-only'
  /** T1 — the agent's output becomes a draft; a human reviews and publishes. */
  | 'draft'
  /** The governed pipeline may publish it (non-production T2, or in-radius T3). */
  | 'publish'
  /** Publishing needs a human: open a change request. */
  | 'change-request';

export interface AutonomyVerdict {
  mode: AutonomyMode;
  reason: string;
}

export interface BlastRadiusResult {
  withinRadius: boolean;
  violations: string[];
}

/** T3 blast radius: no confidential data, reversible steps only, bounded cost, no shell. */
export function checkBlastRadius(plan: Plan, risk: RiskSummary | undefined, maxRunCost: number): BlastRadiusResult {
  const violations: string[] = [];
  if (sensitivityRank(plan.analysis.maxSensitivity) >= sensitivityRank('confidential')) {
    violations.push('handles confidential data');
  }
  for (const s of plan.steps) {
    if (s.effect === 'effectful' && !s.compensate) violations.push(`step '${s.id}' is effectful and not reversible (no compensation)`);
  }
  if (plan.analysis.maxCost > maxRunCost) violations.push(`worst-case cost ${plan.analysis.maxCost} exceeds the ceiling ${maxRunCost}`);
  if (plan.analysis.families.includes('shell')) violations.push('uses shell steps');
  if (risk?.blocking) violations.push('has blocking findings');
  if (risk && (risk.level === 'high' || risk.level === 'critical')) violations.push(`risk level is ${risk.level}`);
  return { withinRadius: violations.length === 0, violations };
}

export function autonomyVerdict(
  tier: AutonomyTier,
  environment: EnvironmentName,
  plan: Plan,
  risk: RiskSummary | undefined,
  maxRunCost: number,
): AutonomyVerdict {
  if (risk?.blocking) return { mode: 'draft', reason: 'Blocking findings prevent any automatic publish' };
  switch (tier) {
    case 'T0':
      return { mode: 'proposal-only', reason: 'T0 is advisory: nothing is applied' };
    case 'T1':
      return { mode: 'draft', reason: 'T1: the agent drafts; a human reviews and publishes' };
    case 'T2':
      return environment === 'production'
        ? { mode: 'change-request', reason: 'T2: production promotion needs human approval' }
        : { mode: 'publish', reason: `T2: may publish to ${environment}` };
    case 'T3': {
      const radius = checkBlastRadius(plan, risk, maxRunCost);
      return radius.withinRadius
        ? { mode: 'publish', reason: 'T3: within the declared blast radius' }
        : { mode: 'change-request', reason: `T3: outside the blast radius (${radius.violations.join('; ')})` };
    }
  }
}
