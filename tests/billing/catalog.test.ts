import { describe, expect, it } from 'vitest';
import { BILLING_PLANS, effectivePlan, isPaidPlan } from '../../billing/catalog.ts';

describe('billing plan ladder', () => {
  it('defines a free tier, a 500-run Pro limit, and a higher Team tier', () => {
    expect(BILLING_PLANS.free.monthlyRunLimit).toBe(25);
    expect(BILLING_PLANS.pro.monthlyUsd).toBe(19);
    expect(BILLING_PLANS.pro.monthlyRunLimit).toBe(500);
    expect(BILLING_PLANS.team.monthlyUsd).toBe(49);
    expect(BILLING_PLANS.team.monthlyRunLimit).toBe(2500);
  });

  it('grants paid limits only for active or trialing subscriptions', () => {
    expect(effectivePlan('pro', 'active')).toBe('pro');
    expect(effectivePlan('team', 'trialing')).toBe('team');
    expect(effectivePlan('pro', 'past_due')).toBe('free');
    expect(effectivePlan('team', 'canceled')).toBe('free');
    expect(effectivePlan('owner', 'active')).toBe('free');
    expect(isPaidPlan('pro')).toBe(true);
    expect(isPaidPlan('free')).toBe(false);
  });
});
