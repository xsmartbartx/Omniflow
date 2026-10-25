import { ForbiddenError } from '../../core/index.ts';
import type { RouteDef } from '../http.ts';
import { obj } from './util.ts';

/** Customer-facing Billing API. Webhook fulfillment is done only after signature verification. */
export function billingRoutes(): RouteDef[] {
  return [
    {
      method: 'GET',
      url: '/v1/billing',
      summary: 'Current plan, monthly workflow usage, and available plans',
      tag: 'Billing',
      handler: ({ app, principal }) => app.billing.snapshot(principal.tenant),
    },
    {
      method: 'POST',
      url: '/v1/billing/checkout',
      summary: 'Create a Stripe-hosted subscription Checkout session in test mode',
      tag: 'Billing',
      schema: { body: obj({ plan: { type: 'string', enum: ['pro', 'team'] } }, ['plan']) },
      handler: async ({ app, principal, body }) => {
        if (principal.type !== 'user' || !principal.roles.includes('admin'))
          throw new ForbiddenError('Only a workspace administrator can start Checkout.');
        return app.billing.createCheckout(principal, body.plan);
      },
    },
    {
      method: 'POST',
      url: '/v1/billing/portal',
      summary: 'Create a Stripe Customer Portal session for subscription management',
      tag: 'Billing',
      handler: async ({ app, principal }) => {
        if (principal.type !== 'user' || !principal.roles.includes('admin'))
          throw new ForbiddenError('Only a workspace administrator can manage billing.');
        return app.billing.createPortal(principal);
      },
    },
    {
      method: 'POST',
      url: '/v1/billing/webhook',
      summary: 'Verified Stripe Billing webhook receiver',
      tag: 'Billing',
      public: true,
      limit: 'webhook',
      status: 200,
      handler: async ({ app, req, body }) => {
        return app.billing.handleWebhook(
          typeof body === 'string' ? body : '',
          typeof req.headers['stripe-signature'] === 'string' ? req.headers['stripe-signature'] : undefined,
        );
      },
    },
  ];
}
