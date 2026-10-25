import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { type Api, makeApi, yamlWf } from '../helpers/api.ts';

const WEBHOOK_SECRET = 'whsec_testsecret';
const ENV = {
  OMNIFLOW_SIGNUP: 'true',
  OMNIFLOW_BILLING_ENABLED: 'true',
  OMNIFLOW_STRIPE_SECRET_KEY: 'sk_test_unused',
  OMNIFLOW_STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  OMNIFLOW_STRIPE_PRICE_PRO: 'price_testPro',
  OMNIFLOW_STRIPE_PRICE_TEAM: 'price_testTeam',
};
const PASSWORD = 'a-long-enough-passphrase';
const hello = (name: string) =>
  yamlWf(name, [{ id: 'a', type: 'capability', uses: 'util-echo@^1', with: { value: 'x' } }]);

async function withApi(fn: (api: Api) => Promise<void>) {
  const api = await makeApi({ env: ENV });
  try {
    await fn(api);
  } finally {
    await api.stop();
  }
}

/** A customer who signed up: their own tenant, signed in. */
async function customer(api: Api, email = 'buyer@example.com') {
  const res = await api.anon.post('/v1/auth/signup', { email, password: PASSWORD });
  expect(res.status, res.text).toBe(200);
  const cookie = String(res.headers['set-cookie']).split(';')[0]!;
  const call = (method: string, url: string, body?: unknown) =>
    api.anon.request(method, url, {
      headers: { cookie, ...(method !== 'GET' ? { 'x-requested-with': 'omniflow' } : {}) },
      ...(body !== undefined ? { body } : {}),
    });
  return { tenant: res.body.principal.tenant as string, call };
}

/** A webhook delivery signed the way Stripe signs it. */
function signed(event: Record<string, unknown>, secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify(event);
  const signature = new Stripe('sk_test_unused').webhooks.generateTestHeaderString({ payload, secret });
  return { payload, signature };
}
const deliver = (api: Api, event: Record<string, unknown>, secret?: string) => {
  const { payload, signature } = signed(event, secret);
  return api.anon.request('POST', '/v1/billing/webhook', {
    raw: payload,
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
  });
};
const subscriptionEvent = (id: string, tenant: string, status = 'active', price = 'price_testPro') => ({
  id,
  object: 'event',
  type: 'customer.subscription.updated',
  data: {
    object: {
      id: 'sub_1',
      object: 'subscription',
      customer: 'cus_1',
      status,
      cancel_at_period_end: false,
      metadata: { tenant_id: tenant, plan: 'pro' },
      items: { data: [{ price: { id: price }, current_period_end: 1893456000 }] },
    },
  },
});

describe('Stripe billing service', () => {
  it('upgrades a workspace only through a correctly signed webhook, and ignores a replay', () =>
    withApi(async (api) => {
      const { tenant, call } = await customer(api);
      expect((await call('GET', '/v1/billing')).body.plan.id).toBe('free');

      expect((await deliver(api, subscriptionEvent('evt_1', tenant), 'whsec_wrongsecret')).status).toBe(401);
      expect((await call('GET', '/v1/billing')).body.plan.id).toBe('free');

      expect((await deliver(api, subscriptionEvent('evt_1', tenant))).status).toBe(200);
      const upgraded = (await call('GET', '/v1/billing')).body;
      expect(upgraded).toMatchObject({ plan: { id: 'pro' }, usage: { limit: 500 } });
      expect(upgraded.subscription.currentPeriodEnd).toBe('2030-01-01T00:00:00.000Z');

      const again = await deliver(api, subscriptionEvent('evt_1', tenant));
      expect(again.body).toMatchObject({ received: true, duplicate: true });
    }));

  it('falls back to Free when the subscription is no longer active', () =>
    withApi(async (api) => {
      const { tenant, call } = await customer(api);
      await deliver(api, subscriptionEvent('evt_a', tenant));
      await deliver(api, subscriptionEvent('evt_b', tenant, 'past_due'));
      expect((await call('GET', '/v1/billing')).body.plan.id).toBe('free');
    }));

  it('refuses new runs once the monthly quota is used, for customers but not the operator', () =>
    withApi(async (api) => {
      const { tenant, call } = await customer(api);
      expect((await call('POST', '/v1/workflows', { manifest: hello('quota-flow') })).status).toBeLessThan(300);
      const now = new Date().toISOString();
      for (let i = 0; i < 25; i++)
        api.app.state.db.run(
          `INSERT INTO runs (id, tenant_id, workflow_name, workflow_version, plan_hash, status, environment, trigger_type,
             inputs, seed, context_now, requested_by, created_at)
           VALUES (?, ?, 'quota-flow', '1.0.0', 'h', 'succeeded', 'production', 'manual', '{}', 's', ?, 'u', ?)`,
          [`run_q${i}`, tenant, now, now],
        );
      expect((await call('GET', '/v1/billing')).body.usage).toMatchObject({ used: 25, remaining: 0 });
      const blocked = await call('POST', '/v1/workflows/quota-flow/run', { inputs: {} });
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('ENTITLEMENT_EXCEEDED');

      // the operator's own workspace is not on a plan
      const admin = await api.login();
      expect((await admin.post('/v1/workflows', { manifest: hello('ops-flow') })).status).toBeLessThan(300);
      expect((await admin.post('/v1/workflows/ops-flow/run', { inputs: {} })).status).toBe(202);
    }));

  it('lets only a workspace administrator start Checkout or open the portal', () =>
    withApi(async (api) => {
      const { call } = await customer(api);
      // an administrator reaches the Stripe step (test key is fake, so it cannot succeed, but it is not a 403)
      const attempt = await call('POST', '/v1/billing/portal');
      expect(attempt.status).not.toBe(403);
      // an API key with only the viewer role is turned away
      const viewer = await api.key(['viewer']);
      expect((await viewer.post('/v1/billing/checkout', { plan: 'pro' })).status).toBe(403);
    }));
});
