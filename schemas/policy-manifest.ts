import { ACTIONS } from './policy.ts';

/**
 * `kind: Policy` documents let an operator add governance rules without touching code, e.g.
 * "no shell steps in production" or "critical workflows need two approvers". Rules are evaluated
 * by the Policy Engine over a fixed set of facts using the same sandboxed expression language as
 * workflows.
 */

export interface PolicyRuleDoc {
  id: string;
  effect: 'deny' | 'require-approval';
  /** Restrict the rule to these actions. Omit to apply to every action. */
  actions?: string[];
  /** Bare expression over the facts `action`, `principal`, `environment`, `workflow`, `plan`, `risk`, `resource`, `autonomy`. */
  when: string;
  reason: string;
  /** Distinct approvers required, for `require-approval`. */
  approvals?: number;
}

export interface PolicyDocument {
  apiVersion: 'omniflow.dev/v1';
  kind: 'Policy';
  metadata: { name: string; description?: string };
  rules: PolicyRuleDoc[];
}

export const POLICY_FACT_ROOTS: readonly string[] = [
  'action',
  'principal',
  'environment',
  'workflow',
  'plan',
  'risk',
  'resource',
  'autonomy',
];

const KEBAB = '^[a-z][a-z0-9]*(-[a-z0-9]+)*$';

export function buildPolicySchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://omniflow.dev/schemas/policy.v1.json',
    title: 'OmniFlow Policy',
    type: 'object',
    required: ['apiVersion', 'kind', 'metadata', 'rules'],
    additionalProperties: false,
    properties: {
      apiVersion: { const: 'omniflow.dev/v1' },
      kind: { const: 'Policy' },
      metadata: {
        type: 'object',
        required: ['name'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', pattern: KEBAB, maxLength: 64 },
          description: { type: 'string', maxLength: 1000 },
        },
      },
      rules: {
        type: 'array',
        minItems: 1,
        maxItems: 200,
        items: {
          type: 'object',
          required: ['id', 'effect', 'when', 'reason'],
          additionalProperties: false,
          properties: {
            id: { type: 'string', pattern: KEBAB, maxLength: 64 },
            effect: { enum: ['deny', 'require-approval'] },
            actions: { type: 'array', items: { enum: [...ACTIONS] }, uniqueItems: true },
            when: { type: 'string', minLength: 1, maxLength: 2000 },
            reason: { type: 'string', minLength: 1, maxLength: 500 },
            approvals: { type: 'integer', minimum: 1, maximum: 10 },
          },
        },
      },
    },
  };
}
