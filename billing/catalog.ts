/** Public plan ladder. Stripe Price IDs are configured separately per environment. */
export const BILLING_PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    monthlyUsd: 0,
    monthlyRunLimit: 25,
    priceLabel: '$0',
    summary: 'Evaluate OmniFlow with a small production-like workload.',
    features: ['25 workflow runs per calendar month', 'Core workflow engine', 'Audit trail'],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    monthlyUsd: 19,
    monthlyRunLimit: 500,
    priceLabel: '$19 / month',
    summary: 'For an individual or small team running workflows regularly.',
    features: [
      '500 workflow runs per calendar month',
      'All workflow authoring features',
      'Self-service billing management',
    ],
  },
  team: {
    id: 'team',
    name: 'Team',
    monthlyUsd: 49,
    monthlyRunLimit: 2500,
    priceLabel: '$49 / month',
    summary: 'Higher usage limits for teams with active automation workloads.',
    features: ['2,500 workflow runs per calendar month', 'All Pro features', 'Higher shared workspace capacity'],
  },
} as const;

export type PlanId = keyof typeof BILLING_PLANS;
export type PaidPlanId = Exclude<PlanId, 'free'>;

export function isPaidPlan(value: unknown): value is PaidPlanId {
  return value === 'pro' || value === 'team';
}

/** A paid tier is active only while Stripe confirms an active or trialing subscription. */
export function effectivePlan(plan: unknown, status: unknown): PlanId {
  if ((status === 'active' || status === 'trialing') && isPaidPlan(plan)) return plan;
  return 'free';
}
