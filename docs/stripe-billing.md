# OmniFlow Stripe Billing (test mode)

> Added from a contributed patch, reviewed and adjusted. Differences from the original notes: the operator's own `default` workspace is never metered (only workspaces created by sign-up are on a plan), and only a workspace administrator can start Checkout or open the Customer Portal.

This patch adds a three-tier subscription ladder, tenant-scoped monthly run quotas, Stripe-hosted Checkout, a self-service Customer Portal, and a signature-verified webhook receiver. It does not create products, prices, or webhook endpoints in any Stripe account.

## Plan defaults

| Plan | Suggested price | Workflow runs / UTC calendar month |
|---|---:|---:|
| Free | $0 | 25 |
| Pro | $19/month | 500 |
| Team | $49/month | 2,500 |

Treat the prices as product defaults, not Stripe objects already created. Create one separate test-mode Product per paid tier in your own Stripe sandbox and a recurring monthly Price matching the plan's amount. Place the resulting test-mode Price IDs in the environment variables below. Do not reuse live-mode Price IDs.

## Configure a Stripe sandbox

Set these in the deployment's secret/environment configuration, not in source control:

```dotenv
OMNIFLOW_BILLING_ENABLED=true
OMNIFLOW_STRIPE_SECRET_KEY=sk_test_... # or a restricted rk_test_ key with the required permissions
OMNIFLOW_STRIPE_WEBHOOK_SECRET=whsec_...
OMNIFLOW_STRIPE_PRICE_PRO=price_...
OMNIFLOW_STRIPE_PRICE_TEAM=price_...
```

The application rejects `sk_live_` and `rk_live_` keys and refuses to enable this Stripe integration in NEXORA mode (where tenant entitlements are owned by the Core provider). A missing test key prevents Checkout/Portal calls; an enabled billing gate still enforces the Free tier while the application is being configured. Keep the key only in a secret manager or an untracked local `.env` file. Never commit `.env`, paste keys into issues, or add keys to browser code.

For local webhook forwarding, run the Stripe CLI in test mode and forward to `http://localhost:8080/v1/billing/webhook`; copy the generated `whsec_...` to `OMNIFLOW_STRIPE_WEBHOOK_SECRET`. Configure the webhook to deliver these event types:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

Subscription entitlements are changed by verified webhooks, not by query parameters on the Checkout success page. Repeated event IDs are deduplicated in SQLite. The Customer Portal must also be enabled/configured in the Stripe sandbox.

## What the patch wires in

- `GET /v1/billing`: the tenant's effective plan, status, quota usage, reset date, and whether a test Checkout is configured.
- `POST /v1/billing/checkout`: creates a subscription Checkout Session for `pro` or `team`.
- `POST /v1/billing/portal`: creates a Customer Portal session for the signed-in tenant's Stripe customer.
- `POST /v1/billing/webhook`: verifies Stripe's signature against the unmodified raw body before processing events.
- A server-side admission gate checks the plan quota before a non-dry-run workflow starts. Usage is calculated from persisted run records, avoiding a second counter that could drift.
- A Billing page in the OmniFlow console shows the subscription, usage meter and plan ladder.

`invoice.payment_failed` moves the associated subscription to `past_due`; only active/trialing subscriptions get paid-tier limits. When the subscription becomes canceled or past-due, the effective plan falls back to Free. Review this product policy before launch if you plan to offer a payment-failure grace period.

## Verify locally

```bash
npm run typecheck
npm run lint
npm run test -- tests/billing/catalog.test.ts tests/billing/routes.test.ts
npm run verify
```

Then sign in to OmniFlow, open **Plans & billing**, start a Pro checkout using Stripe test payment data, and confirm that a signed subscription webhook changes the displayed plan. Also test cancellation, `invoice.payment_failed`, webhook replay, and hitting each run quota. Do not test with live-mode credentials.

## Tax and launch checklist

This patch intentionally does not enable `automatic_tax`. Before collecting payments from US/EU customers, review sales-tax/VAT obligations, assign the appropriate tax category, and make sure Stripe Tax has active registrations in any jurisdiction where you expect to collect tax. A toggle alone does not create a tax registration. Before production, add live credentials only through a separately reviewed deployment configuration, add production Prices/webhook endpoints, and complete Stripe's go-live checklist; this patch itself deliberately refuses live credentials.
