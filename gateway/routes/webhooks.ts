import type { RouteDef } from '../http.ts';
import { obj } from './util.ts';

/** Visibility into outbound run webhooks. Hooks themselves are operator configuration (CONSTANS_RUN_WEBHOOKS). */
export function webhookRoutes(): RouteDef[] {
  return [
    {
      method: 'GET',
      url: '/v1/webhooks/deliveries',
      summary: 'Recent outbound webhook deliveries for your workspace (newest first)',
      tag: 'Webhooks',
      action: 'audit.read',
      schema: { querystring: obj({ limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 } }) },
      handler: ({ app, principal, query }) => {
        const origin = (hookId: string) => {
          const h = app.config.runWebhooks.find((x) => x.id === hookId);
          return h ? new URL(h.url).origin : null; // paths and queries can carry tokens: only the origin is shown
        };
        return {
          items: app.state.webhooks.list(principal.tenant, query.limit ?? 100).map((d) => ({
            id: d.id,
            hook: d.hookId,
            origin: origin(d.hookId),
            event: d.eventType,
            runId: d.runId ?? null,
            status: d.status,
            attempts: d.attempts,
            lastStatus: d.lastStatus ?? null,
            lastError: d.lastError ?? null,
            createdAt: d.createdAt,
            nextAttemptAt: d.status === 'pending' ? d.nextAttemptAt : null,
            deliveredAt: d.deliveredAt ?? null,
          })),
        };
      },
    },
  ];
}
