import * as api from '../api.js';
import { clear, h } from '../dom.js';
import { badge, button, card, errorBox, notice, pageHeader } from '../ui.js';

const money = (amount) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(amount);
const prettyDate = (value) => (value ? new Date(value).toLocaleDateString() : '—');

export default async function billing(ctx) {
  let data;
  try {
    data = await api.get('/v1/billing');
  } catch (error) {
    return h('div', {}, pageHeader('Plans & billing'), errorBox(error));
  }

  const feedback = h('div');
  const startCheckout = async (plan) => {
    clear(feedback);
    try {
      const result = await api.post('/v1/billing/checkout', { plan });
      if (!result?.url) throw new Error('Stripe did not return a Checkout URL.');
      window.location.assign(result.url);
    } catch (error) {
      feedback.append(errorBox(error));
    }
  };
  const openPortal = async () => {
    clear(feedback);
    try {
      const result = await api.post('/v1/billing/portal');
      if (!result?.url) throw new Error('Stripe did not return a Customer Portal URL.');
      window.location.assign(result.url);
    } catch (error) {
      feedback.append(errorBox(error));
    }
  };

  if (ctx.query.checkout === 'success') {
    feedback.append(
      notice(
        'info',
        'Checkout returned successfully. Subscription access updates after Stripe sends a verified webhook; refresh in a moment if the plan has not changed.',
      ),
    );
  } else if (ctx.query.checkout === 'cancelled') {
    feedback.append(notice('info', 'Checkout was cancelled. Your current plan has not been changed.'));
  }

  const currentPlan = data.plan;
  const used = data.usage.used;
  const limit = data.usage.limit;
  const percent = Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  const usageBlock = card(
    'Current subscription',
    h(
      'div',
      { class: 'billing-current' },
      h(
        'div',
        { class: 'billing-current-title' },
        h('strong', {}, currentPlan.name),
        badge(data.status, data.status === 'active' || data.status === 'trialing' ? 'good' : 'neutral'),
      ),
      h('p', { class: 'muted' }, currentPlan.summary),
      h(
        'div',
        { class: 'billing-usage-line' },
        h('strong', {}, `${used.toLocaleString()} / ${limit.toLocaleString()}`),
        h('span', { class: 'muted' }, 'workflow runs this month'),
      ),
      h(
        'div',
        {
          class: 'billing-meter',
          role: 'progressbar',
          'aria-label': 'Workflow runs used this month',
          'aria-valuemin': 0,
          'aria-valuemax': limit,
          'aria-valuenow': used,
        },
        h('span', { style: { width: `${percent}%` } }),
      ),
      h(
        'div',
        { class: 'billing-usage-meta' },
        h('span', {}, `${Math.max(0, limit - used).toLocaleString()} remaining`),
        h('span', { class: 'muted' }, `Resets ${prettyDate(data.usage.period.end)}`),
      ),
      data.subscription.currentPeriodEnd
        ? h(
            'p',
            { class: 'muted' },
            `Subscription period ends ${prettyDate(data.subscription.currentPeriodEnd)}${data.subscription.cancelAtPeriodEnd ? ' (cancellation scheduled)' : ''}.`,
          )
        : null,
      data.subscription.hasCustomer ? button('Manage billing', { kind: 'secondary', onClick: openPortal }) : null,
    ),
  );

  const planCards = data.plans.map((plan) => {
    const detail = h(
      'div',
      { class: 'billing-plan-body' },
      h(
        'div',
        { class: 'billing-plan-price' },
        plan.monthlyUsd === 0 ? '$0' : money(plan.monthlyUsd),
        h('span', { class: 'muted' }, plan.monthlyUsd === 0 ? ' forever' : ' / month'),
      ),
      h('p', { class: 'muted' }, plan.summary),
      h('p', {}, h('strong', {}, plan.monthlyRunLimit.toLocaleString()), ' workflow runs / month'),
      h('ul', { class: 'billing-features' }, ...plan.features.map((feature) => h('li', {}, feature))),
      plan.current
        ? badge('Current plan', 'good')
        : plan.id === 'free'
          ? h('span', { class: 'muted' }, 'No payment required')
          : button(`Choose ${plan.name}`, {
              kind: plan.id === 'pro' ? 'primary' : 'secondary',
              disabled: !plan.checkoutAvailable || !data.enabled,
              onClick: () => startCheckout(plan.id),
            }),
      plan.id !== 'free' && (!plan.checkoutAvailable || !data.enabled)
        ? h(
            'p',
            { class: 'muted billing-config-note' },
            'Checkout is unavailable until test-mode Stripe Price IDs and billing settings are configured.',
          )
        : null,
    );
    return card(plan.name, detail);
  });

  return h(
    'div',
    {},
    pageHeader('Plans & billing'),
    feedback,
    !data.enabled
      ? notice(
          'warn',
          'Billing is currently disabled. Configure OMNIFLOW_BILLING_ENABLED=true and Stripe test-mode settings to exercise Checkout.',
        )
      : null,
    h(
      'div',
      { class: 'grid grid-2 billing-summary-grid' },
      usageBlock,
      card(
        'Usage policy',
        h(
          'div',
          {},
          h(
            'p',
            {},
            'Usage is counted by non-dry-run workflow run requests accepted during the current UTC calendar month.',
          ),
          h(
            'p',
            { class: 'muted' },
            'A run is not granted extra quota by visiting the Checkout success page. Verified Stripe webhooks update subscription entitlements.',
          ),
        ),
      ),
    ),
    h('h2', { class: 'billing-section-title' }, 'Choose a plan'),
    h('div', { class: 'grid grid-3 billing-plans' }, ...planCards),
  );
}
