import { describe, expect, it } from 'vitest';
import { compile } from '../../orchestration/compiler/index.ts';
import type { Plan, Principal, Role } from '../../schemas/index.ts';
import {
  autonomyVerdict,
  checkBlastRadius,
  defaultPolicyConfig,
  PolicyEngine,
  parsePolicyDocument,
  type RiskSummary,
  roleAllows,
} from '../../security/policy/index.ts';
import { testRegistry } from '../helpers/registry.ts';

const registry = testRegistry();
const P = (roles: Role[], over: Partial<Principal> = {}): Principal => ({
  id: `usr_${roles.join('')}`,
  type: 'user',
  name: roles.join(','),
  tenant: 'default',
  roles,
  ...over,
});

const compilePlan = (steps: unknown[], extra: Record<string, unknown> = {}): Plan => {
  const r = compile(
    {
      apiVersion: 'omniflow.dev/v1',
      kind: 'Workflow',
      metadata: { name: 'wf', version: '1.0.0', owner: 'a@b.c', description: 'd', criticality: 'low' },
      triggers: [{ type: 'manual' }],
      inputs: {},
      steps,
      ...extra,
    },
    { environment: 'production', capabilities: registry, today: '2026-09-19' },
  );
  expect(r.errors).toEqual([]);
  return r.plan!;
};

const pureStep = { id: 'a', type: 'capability', uses: 'util-noop@^1' };
const chargeStep = (over: Record<string, unknown> = {}) => ({
  id: 'pay',
  type: 'capability',
  uses: 'test-charge@^1',
  with: { amount: 1, customer: 'c' },
  idempotencyKey: 'k',
  compensate: { uses: 'test-refund@^1', with: { chargeId: '${{ steps.pay.output.chargeId }}' }, idempotencyKey: 'r' },
  ...over,
});

describe('RBAC', () => {
  const engine = new PolicyEngine();

  it('grants each role exactly its permissions', () => {
    const matrix: Array<[Role, string, boolean]> = [
      ['viewer', 'workflow.read', true],
      ['viewer', 'workflow.run', false],
      ['author', 'workflow.publish', true],
      ['author', 'workflow.manage', false],
      ['author', 'secret.write', false],
      ['operator', 'workflow.run', true],
      ['operator', 'workflow.publish', false],
      ['operator', 'approval.decide', false],
      ['approver', 'approval.decide', true],
      ['approver', 'workflow.run', false],
      ['admin', 'user.manage', true],
      ['admin', 'secret.write', true],
    ];
    for (const [role, action, allowed] of matrix) {
      expect(roleAllows([role], action as never), `${role} → ${action}`).toBe(allowed);
    }
  });

  it('unions multiple roles and denies with a reason code', () => {
    expect(engine.decide({ principal: P(['viewer', 'operator']), action: 'workflow.run' }).effect).toBe('allow');
    const d = engine.decide({ principal: P(['viewer']), action: 'workflow.run' });
    expect(d).toMatchObject({ effect: 'deny', reasonCode: 'RBAC_DENIED' });
    expect(d.reason).toContain('viewer');
  });

  it('isolates tenants', () => {
    const d = engine.decide({ principal: P(['admin']), action: 'workflow.read', resource: { tenant: 'other' } });
    expect(d).toMatchObject({ effect: 'deny', reasonCode: 'TENANT_MISMATCH' });
  });

  it('reserves tenant management for platform admins', () => {
    expect(engine.decide({ principal: P(['admin']), action: 'tenant.manage' }).effect).toBe('allow');
    expect(engine.decide({ principal: P(['admin'], { tenant: 'acme' }), action: 'tenant.manage' })).toMatchObject({
      effect: 'deny',
      reasonCode: 'PLATFORM_ADMIN_ONLY',
    });
    // A platform admin may act across tenants only for tenant management
    expect(
      engine.decide({ principal: P(['admin']), action: 'tenant.manage', resource: { tenant: 'acme' } }).effect,
    ).toBe('allow');
    expect(
      engine.decide({ principal: P(['admin']), action: 'workflow.run', resource: { tenant: 'acme' } }).effect,
    ).toBe('deny');
  });

  it('enforces four-eyes on change approval', () => {
    const self = engine.decide({
      principal: P(['admin'], { id: 'usr_1' }),
      action: 'workflow.approve-change',
      resource: { changeAuthor: 'usr_1' },
    });
    expect(self).toMatchObject({ effect: 'deny', reasonCode: 'SELF_APPROVAL' });
    expect(
      engine.decide({
        principal: P(['approver'], { id: 'usr_2' }),
        action: 'workflow.approve-change',
        resource: { changeAuthor: 'usr_1' },
      }).effect,
    ).toBe('allow');
  });
});

describe('agents hold no execution authority (ADR-0002 D4)', () => {
  const engine = new PolicyEngine();
  const agent = P(['author', 'admin'], { type: 'agent', id: 'agent_planner' });

  it('may only read, draft and be invoked — even with admin roles', () => {
    for (const a of ['workflow.read', 'workflow.draft', 'agent.invoke', 'run.read'] as const) {
      expect(engine.decide({ principal: agent, action: a }).effect, a).toBe('allow');
    }
    for (const a of [
      'workflow.publish',
      'workflow.run',
      'secret.write',
      'approval.decide',
      'workflow.manage',
      'user.manage',
    ] as const) {
      expect(engine.decide({ principal: agent, action: a })).toMatchObject({
        effect: 'deny',
        reasonCode: 'AGENT_NO_EXECUTION',
      });
    }
    expect(engine.can(agent, 'workflow.publish')).toBe(false);
  });
});

describe('publish gates and environment', () => {
  const engine = new PolicyEngine();
  const author = P(['author']);

  it('allows a pure production workflow without ceremony', () => {
    const d = engine.decide({
      principal: author,
      action: 'workflow.publish',
      resource: { plan: compilePlan([pureStep]) },
    });
    expect(d.effect).toBe('allow');
  });

  it('requires approval for effectful production workflows', () => {
    const d = engine.decide({
      principal: author,
      action: 'workflow.publish',
      resource: { plan: compilePlan([chargeStep()]) },
    });
    expect(d).toMatchObject({
      effect: 'require-approval',
      reasonCode: 'PROD_EFFECTFUL_NEEDS_APPROVAL',
      requiredApprovals: 1,
    });
  });

  it('does not gate the same workflow outside production', () => {
    const dev = new PolicyEngine(defaultPolicyConfig({ environment: 'development' }));
    const plan = compilePlan([chargeStep()]);
    expect(
      dev.decide({ principal: author, action: 'workflow.publish', resource: { plan, environment: 'development' } })
        .effect,
    ).toBe('allow');
  });

  it('requires approval for high criticality and high risk', () => {
    const plan = compilePlan([pureStep]);
    expect(
      engine.decide({ principal: author, action: 'workflow.publish', resource: { plan, criticality: 'critical' } })
        .reasonCode,
    ).toBe('PROD_CRITICAL_NEEDS_APPROVAL');
    const risk: RiskSummary = { score: 70, level: 'critical', blocking: false, findings: 3 };
    expect(engine.decide({ principal: author, action: 'workflow.publish', resource: { plan, risk } }).reasonCode).toBe(
      'HIGH_RISK_NEEDS_APPROVAL',
    );
  });

  it('denies publishing while blocking findings exist', () => {
    const risk: RiskSummary = { score: 40, level: 'high', blocking: true, findings: 1 };
    const d = engine.decide({
      principal: author,
      action: 'workflow.publish',
      resource: { plan: compilePlan([pureStep]), risk },
    });
    expect(d).toMatchObject({ effect: 'deny', reasonCode: 'BLOCKING_FINDINGS' });
    // even an admin cannot publish through blocking findings
    expect(
      engine.decide({
        principal: P(['admin']),
        action: 'workflow.publish',
        resource: { plan: compilePlan([pureStep]), risk },
      }).effect,
    ).toBe('deny');
  });

  it('can require more than one approver', () => {
    const strict = new PolicyEngine(defaultPolicyConfig({ publishApprovals: 2 }));
    const d = strict.decide({
      principal: author,
      action: 'workflow.publish',
      resource: { plan: compilePlan([chargeStep()]) },
    });
    expect(d.requiredApprovals).toBe(2);
  });
});

describe('cumulative scope analysis over the whole plan (T5)', () => {
  it('flags combinations no single step reveals', () => {
    const engine = new PolicyEngine();
    const plan = compilePlan([
      { id: 'read', type: 'capability', uses: 'test-reader@^1' }, // db:read
      {
        id: 'send',
        type: 'capability',
        uses: 'http-get@^1',
        dependsOn: ['read'],
        egress: ['x.example.com'],
        with: { url: 'https://x.example.com/' },
      }, // network:http
    ]);
    const d = engine.decide({ principal: P(['author']), action: 'workflow.publish', resource: { plan } });
    expect(d.effect).toBe('require-approval');
    expect(d.reasonCode).toContain('SCOPE_COMBINATION_DB_READ+NETWORK_HTTP');
    expect(d.reason).toContain('exfiltration');
  });

  it('supports deny-level scope rules', () => {
    const engine = new PolicyEngine(
      defaultPolicyConfig({
        scopeRules: [{ scopes: ['db:read', 'network:http'], effect: 'deny', reason: 'forbidden here' }],
      }),
    );
    const plan = compilePlan([
      { id: 'read', type: 'capability', uses: 'test-reader@^1' },
      {
        id: 'send',
        type: 'capability',
        uses: 'http-get@^1',
        dependsOn: ['read'],
        egress: ['x.example.com'],
        with: { url: 'https://x.example.com/' },
      },
    ]);
    expect(engine.decide({ principal: P(['author']), action: 'workflow.publish', resource: { plan } }).effect).toBe(
      'deny',
    );
    expect(engine.decide({ principal: P(['operator']), action: 'workflow.run', resource: { plan } }).effect).toBe(
      'deny',
    );
  });
});

describe('operator-defined policy documents', () => {
  const doc = `
apiVersion: omniflow.dev/v1
kind: Policy
metadata: { name: house-rules }
rules:
  - id: no-shell-in-prod
    effect: deny
    actions: [workflow.publish]
    when: environment == "production" && contains(plan.analysis.families, "shell")
    reason: Shell steps are not allowed in production.
  - id: critical-needs-two
    effect: require-approval
    when: workflow.criticality == "critical"
    approvals: 2
    reason: Critical workflows need two approvers.
`;

  it('parses and validates documents', () => {
    const r = parsePolicyDocument(doc);
    expect(r.ok).toBe(true);
    expect(r.document!.rules).toHaveLength(2);
  });

  it('reports bad documents with positions and unknown facts', () => {
    expect(parsePolicyDocument('kind: Policy').ok).toBe(false);
    const bad = parsePolicyDocument(doc.replace('environment ==', 'env ==').replace('effect: deny', 'effect: shrug'));
    expect(bad.ok).toBe(false);
    const dup = parsePolicyDocument(doc.replace('critical-needs-two', 'no-shell-in-prod'));
    expect(dup.issues.map((i) => i.code)).toContain('DUPLICATE_RULE');
    expect(parsePolicyDocument(doc.replace('== "critical"', '== ')).issues.map((i) => i.code)).toContain(
      'EXPRESSION_SYNTAX',
    );
    expect(parsePolicyDocument(doc.replace('workflow.criticality', 'process.env')).issues.map((i) => i.code)).toContain(
      'UNKNOWN_FACT',
    );
  });

  it('applies deny and require-approval rules over the plan facts', () => {
    const engine = new PolicyEngine();
    expect(engine.loadDocuments([parsePolicyDocument(doc).document!])).toEqual([]);
    expect(engine.ruleCount).toBe(2);

    const shell = compilePlan([
      {
        id: 'legacy',
        type: 'capability',
        uses: 'test-shell@^1',
        with: { argv: ['/bin/true'] },
        idempotencyKey: 'k',
        sunset: '2026-12-31',
      },
    ]);
    const denied = engine.decide({ principal: P(['author']), action: 'workflow.publish', resource: { plan: shell } });
    expect(denied).toMatchObject({
      effect: 'deny',
      reasonCode: 'POLICY_RULE_DENIED',
      ruleIds: ['house-rules/no-shell-in-prod'],
    });

    const pure = compilePlan([pureStep]);
    const crit = engine.decide({
      principal: P(['author']),
      action: 'workflow.publish',
      resource: { plan: pure, criticality: 'critical' },
    });
    expect(crit).toMatchObject({ effect: 'require-approval', requiredApprovals: 2 });
    expect(
      engine.decide({ principal: P(['author']), action: 'workflow.publish', resource: { plan: pure } }).effect,
    ).toBe('allow');
  });

  it('fails closed when a deny rule cannot be evaluated', () => {
    const engine = new PolicyEngine();
    const broken = parsePolicyDocument({
      apiVersion: 'omniflow.dev/v1',
      kind: 'Policy',
      metadata: { name: 'broken' },
      rules: [{ id: 'r', effect: 'deny', when: 'plan.analysis.stepCount + "x" > 1', reason: 'x' }],
    }).document!;
    engine.loadDocuments([broken]);
    expect(
      engine.decide({
        principal: P(['author']),
        action: 'workflow.publish',
        resource: { plan: compilePlan([pureStep]) },
      }).effect,
    ).toBe('deny');
  });
});

describe('autonomy tiers (§8.3)', () => {
  const plan = compilePlan([pureStep]);
  const effectful = compilePlan([chargeStep()]);

  it('defaults to draft-only and honours each tier', () => {
    expect(autonomyVerdict('T0', 'development', plan, undefined, 100).mode).toBe('proposal-only');
    expect(autonomyVerdict('T1', 'development', plan, undefined, 100).mode).toBe('draft');
    expect(autonomyVerdict('T2', 'staging', plan, undefined, 100).mode).toBe('publish');
    expect(autonomyVerdict('T2', 'production', plan, undefined, 100).mode).toBe('change-request');
  });

  it('confines T3 to a declared blast radius', () => {
    expect(autonomyVerdict('T3', 'production', plan, undefined, 100).mode).toBe('publish');
    // A reversible effectful step on internal data, within the cost ceiling, is inside the radius.
    expect(autonomyVerdict('T3', 'production', effectful, undefined, 100).mode).toBe('publish');
    // The same workflow handling confidential data is outside it.
    const confidential = compilePlan([chargeStep({ with: { amount: 1, customer: '${{ inputs.cust }}' } })], {
      inputs: { cust: { type: 'string', default: 'c', sensitivity: 'confidential' } },
    });
    const v = autonomyVerdict('T3', 'production', confidential, undefined, 100);
    expect(v.mode).toBe('change-request');
    expect(v.reason).toContain('confidential');
  });

  it('requires effects to be reversible inside the radius', () => {
    const irreversible = compilePlan([chargeStep({ compensate: undefined })]);
    const v = autonomyVerdict('T3', 'production', irreversible, undefined, 100);
    expect(v.mode).toBe('change-request');
    expect(v.reason).toContain('not reversible');
  });

  it('reports every blast-radius violation', () => {
    const shell = compilePlan([
      {
        id: 'legacy',
        type: 'capability',
        uses: 'test-shell@^1',
        with: { argv: ['/bin/true'] },
        idempotencyKey: 'k',
        sunset: '2026-12-31',
      },
    ]);
    const r = checkBlastRadius(shell, undefined, 0);
    expect(r.withinRadius).toBe(false);
    expect(r.violations.join(' ')).toMatch(/not reversible/);
    expect(r.violations.join(' ')).toMatch(/shell/);
    expect(r.violations.join(' ')).toMatch(/cost/);
  });

  it('blocking findings prevent any automatic publish at every tier', () => {
    const risk: RiskSummary = { score: 50, level: 'high', blocking: true, findings: 1 };
    for (const tier of ['T2', 'T3'] as const) {
      expect(autonomyVerdict(tier, 'development', plan, risk, 100).mode).toBe('draft');
    }
  });
});
