import Stripe from 'stripe';
import {
  AuthenticationError,
  ConflictError,
  EntitlementError,
  ForbiddenError,
  OmniflowError,
  systemClock,
  type Clock,
} from '../core/index.ts';
import type { Principal } from '../schemas/index.ts';
import type { State } from '../state/index.ts';
import { BILLING_PLANS, effectivePlan, isPaidPlan, type PaidPlanId, type PlanId } from './catalog.ts';

export interface BillingConfig {
  enabled: boolean;
  /** Must be a Stripe test-mode key (sk_test_ or rk_test_). Live keys are rejected. */
  secretKey?: string;
  webhookSecret?: string;
  pricePro?: string;
  priceTeam?: string;
}

interface BillingAccountRow {
  tenant_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  plan: string;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: number;
  updated_at: string;
}

interface BillingAccountUpdate {
  customerId?: string | null;
  subscriptionId?: string | null;
  plan?: PlanId;
  status?: string;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
}

function objectId(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === 'string') return id;
  }
  return undefined;
}

function metadataTenant(metadata: { tenant_id?: string } | null | undefined): string | undefined {
  const tenant = metadata?.tenant_id;
  return typeof tenant === 'string' && tenant.length > 0 ? tenant : undefined;
}

function periodEnd(seconds: unknown): string | null {
  return typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : null;
}

function stripeConfigError(message: string): OmniflowError {
  return new OmniflowError('BILLING_NOT_CONFIGURED', message, {
    errorClass: 'catastrophic',
    retryable: false,
  });
}

/**
 * Stripe Billing for standalone OmniFlow installs.
 *
 * - All Stripe calls are server-side and use test-mode credentials only.
 * - Subscription access is sourced from verified webhooks, never the success URL.
 * - The admission gate uses the same tenant-scoped SQLite state as workflow runs.
 */
export class StripeBillingService {
  private readonly state: State;
  private readonly config: BillingConfig;
  private readonly publicUrl: string;
  private readonly clock: Clock;
  private stripeClient: Stripe | undefined;

  constructor(state: State, config: BillingConfig, publicUrl: string, clock: Clock = systemClock) {
    this.state = state;
    this.config = config;
    this.publicUrl = publicUrl.replace(/\/+$/, '');
    this.clock = clock;
  }

  /** AdmissionGate contract consumed by RunService. Dry runs never pass through it. */
  readonly gate = {
    check: (tenant: string): void => {
      // The operator's own workspace is not a customer; only tenants created by sign-up are on a plan.
      if (tenant === 'default') return;
      const view = this.snapshot(tenant);
      if (view.usage.used >= view.usage.limit) {
        throw new EntitlementError(
          'ENTITLEMENT_EXCEEDED',
          `The ${view.plan.name} plan has used its ${view.usage.limit} workflow runs for this calendar month. Upgrade to continue.`,
          { plan: view.plan.id, limit: view.usage.limit, used: view.usage.used, resetsAt: view.usage.period.end },
        );
      }
    },
    admitted: (_run: unknown): void => {
      // Usage is derived from the durable runs table, so there is no second counter to drift.
    },
  };

  private stripe(): Stripe {
    if (!this.config.secretKey || !/^(sk_test_|rk_test_)/.test(this.config.secretKey)) {
      throw stripeConfigError(
        'Configure OMNIFLOW_STRIPE_SECRET_KEY with a Stripe test-mode key (sk_test_ or rk_test_). Live-mode keys are not accepted.',
      );
    }
    this.stripeClient ??= new Stripe(this.config.secretKey, {
      maxNetworkRetries: 2,
      appInfo: { name: 'OmniFlow', version: '1.0.0' },
    });
    return this.stripeClient;
  }

  private ensureAccount(tenant: string): void {
    this.state.db.run(
      `INSERT OR IGNORE INTO billing_accounts
       (tenant_id, stripe_customer_id, stripe_subscription_id, plan, status, current_period_end, cancel_at_period_end, updated_at)
       VALUES (?, NULL, NULL, 'free', 'free', NULL, 0, ?)`,
      [tenant, this.clock.now().toISOString()],
    );
  }

  private account(tenant: string): BillingAccountRow | undefined {
    return this.state.db.get<BillingAccountRow>('SELECT * FROM billing_accounts WHERE tenant_id = ?', [tenant]);
  }

  private updateAccount(tenant: string, update: BillingAccountUpdate): void {
    this.ensureAccount(tenant);
    const columns: string[] = [];
    const values: Array<string | number | null> = [];
    const add = (column: string, value: string | number | null) => {
      columns.push(`${column} = ?`);
      values.push(value);
    };
    if (Object.hasOwn(update, 'customerId')) add('stripe_customer_id', update.customerId ?? null);
    if (Object.hasOwn(update, 'subscriptionId')) add('stripe_subscription_id', update.subscriptionId ?? null);
    if (Object.hasOwn(update, 'plan') && update.plan) add('plan', update.plan);
    if (Object.hasOwn(update, 'status') && update.status) add('status', update.status);
    if (Object.hasOwn(update, 'currentPeriodEnd')) add('current_period_end', update.currentPeriodEnd ?? null);
    if (Object.hasOwn(update, 'cancelAtPeriodEnd')) add('cancel_at_period_end', update.cancelAtPeriodEnd ? 1 : 0);
    add('updated_at', this.clock.now().toISOString());
    values.push(tenant);
    this.state.db.run(`UPDATE billing_accounts SET ${columns.join(', ')} WHERE tenant_id = ?`, values);
  }

  private tenantForStripeObjects(customerId?: string, subscriptionId?: string): string | undefined {
    if (subscriptionId) {
      const bySubscription = this.state.db.get<{ tenant_id: string }>(
        'SELECT tenant_id FROM billing_accounts WHERE stripe_subscription_id = ?',
        [subscriptionId],
      );
      if (bySubscription) return bySubscription.tenant_id;
    }
    if (customerId) {
      const byCustomer = this.state.db.get<{ tenant_id: string }>(
        'SELECT tenant_id FROM billing_accounts WHERE stripe_customer_id = ?',
        [customerId],
      );
      if (byCustomer) return byCustomer.tenant_id;
    }
    return undefined;
  }

  private planFromPrice(priceId?: string): PaidPlanId | undefined {
    if (priceId && priceId === this.config.pricePro) return 'pro';
    if (priceId && priceId === this.config.priceTeam) return 'team';
    return undefined;
  }

  private planFromSubscription(subscription: Stripe.Subscription): PaidPlanId | undefined {
    // The Price is authoritative: Stripe Customer Portal plan changes do not rewrite metadata.
    const item = subscription.items.data[0];
    const pricePlan = this.planFromPrice(item?.price.id);
    if (pricePlan) return pricePlan;
    if (isPaidPlan(subscription.metadata?.plan)) return subscription.metadata.plan;
    return undefined;
  }

  /** Current plan and calendar-month usage, always scoped to the authenticated tenant. */
  snapshot(tenant: string) {
    const row = this.account(tenant);
    const planId = effectivePlan(row?.plan, row?.status);
    const plan = BILLING_PLANS[planId];
    const now = this.clock.now();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const usage = this.state.db.get<{ used: number }>(
      `SELECT COUNT(*) AS used FROM runs
       WHERE tenant_id = ? AND dry_run = 0 AND created_at >= ? AND created_at < ?`,
      [tenant, start.toISOString(), end.toISOString()],
    );
    const used = usage?.used ?? 0;
    return {
      enabled: this.config.enabled,
      plan: { ...plan },
      status: row?.status ?? 'free',
      subscription: {
        status: row?.status ?? 'free',
        currentPeriodEnd: row?.current_period_end ?? null,
        cancelAtPeriodEnd: row?.cancel_at_period_end === 1,
        hasCustomer: Boolean(row?.stripe_customer_id),
      },
      usage: {
        used,
        limit: plan.monthlyRunLimit,
        remaining: Math.max(0, plan.monthlyRunLimit - used),
        period: { start: start.toISOString(), end: end.toISOString() },
      },
      plans: (Object.values(BILLING_PLANS) as Array<(typeof BILLING_PLANS)[PlanId]>).map((candidate) => ({
        ...candidate,
        current: candidate.id === planId,
        checkoutAvailable:
          this.config.enabled &&
          Boolean(this.config.secretKey) &&
          (candidate.id === 'pro'
            ? Boolean(this.config.pricePro)
            : candidate.id === 'team'
              ? Boolean(this.config.priceTeam)
              : false),
      })),
    };
  }

  async createCheckout(principal: Principal, requestedPlan: PaidPlanId): Promise<{ url: string }> {
    if (!this.config.enabled)
      throw stripeConfigError('Billing is disabled. Set OMNIFLOW_BILLING_ENABLED=true to enable test-mode billing.');
    if (!isPaidPlan(requestedPlan)) throw new ConflictError('Choose a supported paid plan.');
    const priceId = requestedPlan === 'pro' ? this.config.pricePro : this.config.priceTeam;
    if (!priceId || !/^price_[A-Za-z0-9]+$/.test(priceId)) {
      throw stripeConfigError(
        `Configure OMNIFLOW_STRIPE_PRICE_${requestedPlan.toUpperCase()} with a test-mode Stripe Price ID.`,
      );
    }
    if (principal.type !== 'user') throw new ForbiddenError('A signed-in user account is required to start Checkout.');
    const user = this.state.identity.getUser(principal.id);
    if (!user || user.tenant !== principal.tenant || user.disabled) {
      throw new ForbiddenError('A valid active user account is required to start Checkout.');
    }

    const stripe = this.stripe();
    this.ensureAccount(principal.tenant);
    let customerId = this.account(principal.tenant)?.stripe_customer_id ?? undefined;
    if (!customerId) {
      const customer = await stripe.customers.create(
        { email: user.email, name: user.name, metadata: { tenant_id: principal.tenant } },
        { idempotencyKey: `omniflow-customer-${principal.tenant}` },
      );
      customerId = customer.id;
      this.updateAccount(principal.tenant, { customerId });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: principal.tenant,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { tenant_id: principal.tenant, plan: requestedPlan, actor_id: principal.id },
      subscription_data: { metadata: { tenant_id: principal.tenant, plan: requestedPlan } },
      allow_promotion_codes: true,
      success_url: `${this.publicUrl}/#/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${this.publicUrl}/#/billing?checkout=cancelled`,
    });

    if (!session.url)
      throw stripeConfigError('Stripe did not return a Checkout URL. Verify the configured Price and test account.');
    return { url: session.url };
  }

  async createPortal(principal: Principal): Promise<{ url: string }> {
    if (!this.config.enabled)
      throw stripeConfigError('Billing is disabled. Set OMNIFLOW_BILLING_ENABLED=true to enable test-mode billing.');
    if (principal.type !== 'user') throw new ForbiddenError('A signed-in user account is required to manage billing.');
    const row = this.account(principal.tenant);
    if (!row?.stripe_customer_id)
      throw new ConflictError('This workspace has no Stripe customer yet. Choose a paid plan first.');
    const portal = await this.stripe().billingPortal.sessions.create({
      customer: row.stripe_customer_id,
      return_url: `${this.publicUrl}/#/billing`,
    });
    return { url: portal.url };
  }

  /** Validate the raw request body using Stripe's signature verifier and deduplicate event IDs. */
  async handleWebhook(rawBody: string, signature: string | undefined): Promise<{ received: true; duplicate?: true }> {
    if (!this.config.enabled) throw stripeConfigError('Billing is disabled.');
    if (!this.config.webhookSecret)
      throw stripeConfigError('Configure OMNIFLOW_STRIPE_WEBHOOK_SECRET for signed Stripe webhook delivery.');
    if (!signature) throw new AuthenticationError('Missing Stripe signature.');
    let event: Stripe.Event;
    try {
      event = this.stripe().webhooks.constructEvent(rawBody, signature, this.config.webhookSecret);
    } catch {
      throw new AuthenticationError('Invalid Stripe webhook signature.');
    }

    const result = this.state.db.transaction(() => {
      const duplicate = this.state.db.get<{ event_id: string }>(
        'SELECT event_id FROM billing_webhook_events WHERE event_id = ?',
        [event.id],
      );
      if (duplicate) return true;
      this.applyStripeEvent(event);
      this.state.db.run('INSERT INTO billing_webhook_events (event_id, event_type, processed_at) VALUES (?, ?, ?)', [
        event.id,
        event.type,
        this.clock.now().toISOString(),
      ]);
      return false;
    });
    return result ? { received: true, duplicate: true } : { received: true };
  }

  private applyStripeEvent(event: Stripe.Event): void {
    if (
      event.type === 'customer.subscription.created' ||
      event.type === 'customer.subscription.updated' ||
      event.type === 'customer.subscription.deleted'
    ) {
      this.syncSubscription(event.data.object as Stripe.Subscription);
      return;
    }

    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object as Stripe.Checkout.Session;
      const customerId = objectId(session.customer);
      const subscriptionId = objectId(session.subscription);
      const tenant =
        metadataTenant(session.metadata) ??
        this.tenantForStripeObjects(customerId, subscriptionId) ??
        session.client_reference_id ??
        undefined;
      if (!tenant) return;
      this.ensureAccount(tenant);
      this.updateAccount(tenant, {
        ...(customerId ? { customerId } : {}),
        ...(subscriptionId ? { subscriptionId } : {}),
        ...(isPaidPlan(session.metadata?.plan) ? { plan: session.metadata.plan } : {}),
      });
      // The subscription.* webhook owns activation; a success/return URL never grants access.
      return;
    }

    if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
      const invoice = event.data.object as unknown as {
        customer?: string | Stripe.Customer | null;
        subscription?: string | Stripe.Subscription | null;
        parent?: { subscription_details?: { subscription?: string | Stripe.Subscription | null } | null } | null;
      };
      const customerId = objectId(invoice.customer);
      const subscriptionId =
        objectId(invoice.subscription) ?? objectId(invoice.parent?.subscription_details?.subscription);
      const tenant = this.tenantForStripeObjects(customerId, subscriptionId);
      if (!tenant) return;
      const row = this.account(tenant);
      if (!row || (subscriptionId && row.stripe_subscription_id && row.stripe_subscription_id !== subscriptionId))
        return;
      if (event.type === 'invoice.paid' && !['active', 'trialing', 'past_due'].includes(row.status)) return;
      this.updateAccount(tenant, { status: event.type === 'invoice.paid' ? 'active' : 'past_due' });
    }
  }

  private syncSubscription(subscription: Stripe.Subscription): void {
    const customerId = objectId(subscription.customer);
    const tenant = metadataTenant(subscription.metadata) ?? this.tenantForStripeObjects(customerId, subscription.id);
    if (!tenant) return;
    this.ensureAccount(tenant);
    const plan = this.planFromSubscription(subscription);
    this.updateAccount(tenant, {
      ...(customerId ? { customerId } : {}),
      subscriptionId: subscription.id,
      ...(plan ? { plan } : { plan: 'free' }),
      status: subscription.status,
      // In current Stripe API versions the billing period lives on the subscription item.
      currentPeriodEnd: periodEnd(subscription.items.data[0]?.current_period_end),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
    });
  }
}
