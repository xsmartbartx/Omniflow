/**
 * Policy decision contract (architecture §10.2): small and total — allow, deny or
 * require-approval, always with a reason code.
 */

export const ROLES = ['admin', 'author', 'operator', 'approver', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export type PrincipalType = 'user' | 'api-key' | 'system' | 'agent' | 'trigger';

export interface Principal {
  id: string;
  type: PrincipalType;
  name: string;
  tenant: string;
  roles: Role[];
}

export type PolicyEffect = 'allow' | 'deny' | 'require-approval';

export interface PolicyDecision {
  effect: PolicyEffect;
  /** Stable machine-readable code, e.g. `RBAC_DENIED`, `PROD_PUBLISH_NEEDS_APPROVAL`. */
  reasonCode: string;
  reason: string;
  /** Ids of the rules that contributed to the decision. */
  ruleIds?: string[];
  /** For `require-approval`: how many distinct approvers are needed. */
  requiredApprovals?: number;
}

export const ACTIONS = [
  'workflow.read',
  'workflow.draft',
  'workflow.publish',
  'workflow.approve-change',
  'workflow.run',
  'workflow.manage', // enable/disable, kill switch, rollout
  'run.read',
  'run.cancel',
  'run.retry',
  'approval.decide',
  'secret.read-names',
  'secret.write',
  'trigger.manage',
  'capability.manage',
  'user.manage',
  'apikey.manage',
  'tenant.manage',
  'audit.read',
  'agent.invoke',
  'event.publish',
  'policy.manage',
] as const;
export type Action = (typeof ACTIONS)[number];

export type EnvironmentName = 'development' | 'staging' | 'production';
export const ENVIRONMENTS: readonly EnvironmentName[] = ['development', 'staging', 'production'];

/** Autonomy tiers (architecture §8.3). T1 is the default. */
export type AutonomyTier = 'T0' | 'T1' | 'T2' | 'T3';
