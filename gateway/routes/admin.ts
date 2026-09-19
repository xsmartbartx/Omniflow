import { NotFoundError, ValidationError } from '../../core/index.ts';
import { ROLES } from '../../schemas/index.ts';
import { GLOBAL_TENANT } from '../../state/index.ts';
import type { RouteDef } from '../http.ts';
import { id, limitQ, name, obj } from './util.ts';

const roles = { type: 'array', items: { enum: [...ROLES] }, minItems: 1, uniqueItems: true } as const;

export function adminRoutes(): RouteDef[] {
  return [
    // ----------------------------------------------------------- capabilities
    {
      method: 'GET',
      url: '/v1/capabilities',
      summary: 'The capability catalogue: contracts, effect classes, scopes, egress, health',
      tag: 'Capabilities',
      action: 'workflow.read',
      handler: ({ app, principal }) => {
        const flags = new Map(app.state.kv.listCapabilityFlags(principal.tenant).filter((f) => f.killed).map((f) => [f.name, f]));
        const breakers = app.breakers.snapshot();
        return {
          items: app.capabilities.list().map((c) => ({
            ...c.declaration,
            hash: c.hash,
            owner: c.registration.owner,
            source: c.registration.source,
            killed: flags.has(c.declaration.name) ? { reason: flags.get(c.declaration.name)!.reason ?? null, scope: flags.get(c.declaration.name)!.tenant === GLOBAL_TENANT ? 'platform' : 'tenant' } : null,
            circuit: breakers[c.declaration.name]?.state ?? 'closed',
          })),
        };
      },
    },
    ...(['kill', 'revive'] as const).map(
      (op): RouteDef => ({
        method: 'POST',
        url: `/v1/capabilities/:name/${op}`,
        summary: op === 'kill' ? 'Kill switch: steps using this capability fail fast' : 'Lift the capability kill switch',
        tag: 'Capabilities',
        action: 'capability.manage',
        schema: { params: obj({ name }, ['name']), body: obj({ reason: { type: 'string', maxLength: 500 } }) },
        handler: ({ app, principal, params, body }) => {
          if (!app.capabilities.has(params.name)) throw new NotFoundError('Capability', params.name);
          app.state.kv.setCapabilityKilled(principal.tenant, params.name, op === 'kill', principal.id, body?.reason);
          app.state.events.append({ tenant: principal.tenant, type: op === 'kill' ? 'capability.killed' : 'capability.revived', actor: { type: principal.type, id: principal.id, name: principal.name }, data: { capability: params.name, ...(body?.reason ? { reason: body.reason } : {}) } });
          return { ok: true };
        },
      }),
    ),

    // ---------------------------------------------------------------- secrets
    {
      method: 'GET',
      url: '/v1/secrets',
      summary: 'Secret names and metadata (never values)',
      tag: 'Secrets',
      action: 'secret.read-names',
      handler: ({ app, principal }) => ({ items: app.broker.list(principal.tenant) }),
    },
    {
      method: 'PUT',
      url: '/v1/secrets/:name',
      summary: 'Create or replace a secret. The value is encrypted at rest and cannot be read back.',
      tag: 'Secrets',
      action: 'secret.write',
      schema: { params: obj({ name: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,63}$' } }, ['name']), body: obj({ value: { type: 'string', minLength: 1, maxLength: 65536 }, description: { type: 'string', maxLength: 300 } }, ['value']) },
      handler: ({ app, principal, params, body }) => {
        app.broker.put(principal.tenant, params.name, body.value, principal.id, body.description);
        app.state.events.append({ tenant: principal.tenant, type: 'secret.written', actor: { type: principal.type, id: principal.id, name: principal.name }, data: { name: params.name } });
        return { ok: true, name: params.name };
      },
    },
    {
      method: 'DELETE',
      url: '/v1/secrets/:name',
      summary: 'Delete a secret',
      tag: 'Secrets',
      action: 'secret.write',
      schema: { params: obj({ name: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,63}$' } }, ['name']) },
      handler: ({ app, principal, params }) => {
        if (!app.broker.delete(principal.tenant, params.name)) throw new NotFoundError('Secret', params.name);
        app.state.events.append({ tenant: principal.tenant, type: 'secret.deleted', actor: { type: principal.type, id: principal.id, name: principal.name }, data: { name: params.name } });
        return { ok: true };
      },
    },

    // --------------------------------------------------------------- triggers
    {
      method: 'GET',
      url: '/v1/triggers',
      summary: 'Registered triggers (schedules, webhooks, events, completions)',
      tag: 'Triggers',
      action: 'workflow.read',
      handler: ({ app, principal }) => ({ items: app.state.triggers.list(principal.tenant), hookUrl: `${app.config.publicUrl}/v1/hooks/${principal.tenant}` }),
    },
    {
      method: 'POST',
      url: '/v1/workflows/:name/triggers/:trigger/rotate-secret',
      summary: 'Create or rotate a webhook signing secret. Shown once.',
      tag: 'Triggers',
      action: 'trigger.manage',
      schema: { params: obj({ name, trigger: name }, ['name', 'trigger']) },
      handler: ({ app, principal, params }) => {
        const r = app.triggers.rotateWebhookSecret(principal.tenant, params.name, params.trigger);
        return {
          secret: r.secret,
          url: `${app.config.publicUrl}/v1/hooks/${principal.tenant}/${params.name}/${params.trigger}`,
          signing: 'Send X-OmniFlow-Timestamp (unix seconds) and X-OmniFlow-Signature: v1=HMAC_SHA256(secret, "<timestamp>.<raw body>") as hex. Optionally send X-OmniFlow-Delivery with a unique id.',
        };
      },
    },
    {
      method: 'POST',
      url: '/v1/events',
      summary: 'Publish an event: resumes waiting steps and fires event triggers',
      tag: 'Triggers',
      action: 'event.publish',
      status: 202,
      schema: { body: obj({ type: { type: 'string', minLength: 1, maxLength: 200 }, payload: {}, correlation: { type: 'string', maxLength: 200 } }, ['type']) },
      handler: ({ app, principal, body }) => app.triggers.publishEvent(principal.tenant, body.type, body.payload ?? {}, body.correlation),
    },

    // ------------------------------------------------------- users & API keys
    {
      method: 'GET',
      url: '/v1/users',
      summary: 'Users in your tenant',
      tag: 'Administration',
      action: 'user.manage',
      handler: ({ app, principal }) => ({ items: app.state.identity.listUsers(principal.tenant).map(({ passwordHash: _p, ...u }) => u) }),
    },
    {
      method: 'POST',
      url: '/v1/users',
      summary: 'Create a user',
      tag: 'Administration',
      action: 'user.manage',
      status: 201,
      schema: { body: obj({ email: { type: 'string', format: 'email', maxLength: 254 }, name: { type: 'string', maxLength: 100 }, password: { type: 'string', maxLength: 256 }, roles, tenant: { type: 'string', maxLength: 64 } }, ['email', 'password', 'roles']) },
      handler: async ({ app, principal, body }) => {
        const { passwordHash: _p, ...u } = await app.auth.createUser(principal, { ...body, mustChangePassword: true });
        return u;
      },
    },
    {
      method: 'PATCH',
      url: '/v1/users/:id',
      summary: 'Update a user (name, roles, disabled)',
      tag: 'Administration',
      action: 'user.manage',
      schema: { params: obj({ id }, ['id']), body: obj({ name: { type: 'string', maxLength: 100 }, roles, disabled: { type: 'boolean' } }) },
      handler: ({ app, principal, params, body }) => {
        const { passwordHash: _p, ...u } = app.auth.updateUser(principal, params.id, body ?? {});
        return u;
      },
    },
    {
      method: 'GET',
      url: '/v1/api-keys',
      summary: 'API keys in your tenant (never the secret)',
      tag: 'Administration',
      action: 'apikey.manage',
      handler: ({ app, principal }) => ({ items: app.state.identity.listApiKeys(principal.tenant).map(({ keyHash: _h, ...k }) => k) }),
    },
    {
      method: 'POST',
      url: '/v1/api-keys',
      summary: 'Create an API key. The key is shown once.',
      tag: 'Administration',
      action: 'apikey.manage',
      status: 201,
      schema: { body: obj({ name: { type: 'string', minLength: 1, maxLength: 100 }, roles, expiresAt: { type: 'string', format: 'date-time' } }, ['name', 'roles']) },
      handler: ({ app, principal, body }) => {
        const { key, record } = app.auth.createApiKey(principal, body);
        const { keyHash: _h, ...rest } = record;
        return { key, ...rest };
      },
    },
    {
      method: 'DELETE',
      url: '/v1/api-keys/:id',
      summary: 'Revoke an API key',
      tag: 'Administration',
      action: 'apikey.manage',
      schema: { params: obj({ id }, ['id']) },
      handler: ({ app, principal, params }) => {
        app.auth.revokeApiKey(principal, params.id);
        return { ok: true };
      },
    },
    {
      method: 'GET',
      url: '/v1/tenants',
      summary: 'Tenants (platform administrators only)',
      tag: 'Administration',
      action: 'tenant.manage',
      handler: ({ app }) => ({ items: app.state.identity.listTenants() }),
    },
    {
      method: 'POST',
      url: '/v1/tenants',
      summary: 'Create a tenant (an isolated workspace)',
      tag: 'Administration',
      action: 'tenant.manage',
      status: 201,
      schema: { body: obj({ id: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,40}$' }, name: { type: 'string', minLength: 1, maxLength: 100 } }, ['id', 'name']) },
      handler: ({ app, body }) => app.state.identity.createTenant(body.id, body.name),
    },
    {
      method: 'GET',
      url: '/v1/channels',
      summary: 'Notification channels configured by the operator (names only)',
      tag: 'Administration',
      action: 'workflow.read',
      handler: ({ app }) => ({ items: Object.entries(app.config.adapters.channels).map(([n, def]) => ({ name: n, format: /^(slack|teams|discord|generic):/i.exec(def)?.[1]?.toLowerCase() ?? 'slack' })) }),
    },

    // ------------------------------------------------------------------ audit
    {
      method: 'GET',
      url: '/v1/audit/events',
      summary: 'The audit log',
      tag: 'Audit',
      action: 'audit.read',
      schema: { querystring: obj({ type: { type: 'string', maxLength: 300 }, runId: { type: 'string', maxLength: 64 }, afterSeq: { type: 'integer', minimum: 0 }, beforeSeq: { type: 'integer', minimum: 0 }, order: { enum: ['asc', 'desc'] }, limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 } }) },
      handler: ({ app, principal, query }) => ({
        items: app.state.events.list({
          tenant: principal.tenant,
          ...(query.type ? { types: String(query.type).split(',') } : {}),
          ...(query.runId ? { runId: query.runId } : {}),
          ...(query.afterSeq !== undefined ? { afterSeq: query.afterSeq } : {}),
          ...(query.beforeSeq !== undefined ? { beforeSeq: query.beforeSeq } : {}),
          order: query.order ?? 'desc',
          limit: query.limit ?? 100,
        }),
        total: app.state.events.count(principal.tenant),
      }),
    },
    {
      method: 'GET',
      url: '/v1/audit/verify',
      summary: 'Verify the tamper-evident hash chain of the audit log',
      tag: 'Audit',
      action: 'audit.read',
      handler: ({ app, principal }) => app.state.events.verify(principal.tenant),
    },
    {
      method: 'GET',
      url: '/v1/audit/export',
      summary: 'Export the audit log as newline-delimited JSON (evidence for auditors)',
      tag: 'Audit',
      action: 'audit.read',
      raw: true,
      handler: ({ app, principal, reply }) => {
        app.state.events.append({ tenant: principal.tenant, type: 'audit.export', actor: { type: principal.type, id: principal.id, name: principal.name }, data: { by: principal.name } });
        const verification = app.state.events.verify(principal.tenant);
        reply.hijack();
        reply.raw.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'content-disposition': `attachment; filename="omniflow-audit-${principal.tenant}.ndjson"`, 'cache-control': 'no-store' });
        reply.raw.write(`${JSON.stringify({ _meta: { tenant: principal.tenant, exportedAt: new Date().toISOString(), chain: verification } })}\n`);
        let after = 0;
        for (;;) {
          const batch = app.state.events.list({ tenant: principal.tenant, afterSeq: after, limit: 1000 });
          if (batch.length === 0) break;
          for (const e of batch) reply.raw.write(`${JSON.stringify(e)}\n`);
          after = batch[batch.length - 1]!.seq;
        }
        reply.raw.end();
      },
    },
  ];
}

export { limitQ, ValidationError };
