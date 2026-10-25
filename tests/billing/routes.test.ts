import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Api, type Client, makeApi } from '../helpers/api.ts';

let api: Api;
let admin: Client;

beforeAll(async () => {
  api = await makeApi({
    env: {
      OMNIFLOW_BILLING_ENABLED: 'true',
      OMNIFLOW_STRIPE_PRICE_PRO: 'price_testPro',
      OMNIFLOW_STRIPE_PRICE_TEAM: 'price_testTeam',
    },
  });
  admin = await api.login();
});

afterAll(async () => {
  await api.stop();
});

describe('Stripe Billing routes', () => {
  it('returns the tenant-scoped Free plan and the three-tier usage ladder', async () => {
    const result = await admin.get('/v1/billing');
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      enabled: true,
      plan: { id: 'free', monthlyRunLimit: 25 },
      usage: { limit: 25, remaining: 25 },
    });
    expect(result.body.plans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'pro', monthlyUsd: 19, monthlyRunLimit: 500 }),
        expect.objectContaining({ id: 'team', monthlyUsd: 49, monthlyRunLimit: 2500 }),
      ]),
    );
  });

  it('never attempts a checkout when test-mode credentials are missing', async () => {
    const result = await admin.post('/v1/billing/checkout', { plan: 'pro' });
    expect(result.status).toBe(503);
    expect(result.body.error.code).toBe('BILLING_NOT_CONFIGURED');
  });

  it('validates the selected plan at the HTTP boundary', async () => {
    const result = await admin.post('/v1/billing/checkout', { plan: 'enterprise' });
    expect(result.status).toBe(400);
  });
});
