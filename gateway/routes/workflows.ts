import { NotFoundError } from '../../core/index.ts';
import type { PolicyDecision } from '../../schemas/index.ts';
import type { RouteDef } from '../http.ts';
import { csv, id, limitQ, name, obj, runSummary } from './util.ts';

const wfParam = obj({ name }, ['name']);

export function workflowRoutes(): RouteDef[] {
  return [
    {
      method: 'GET',
      url: '/v1/workflows',
      summary: 'List workflows with their active version, settings and recent outcomes',
      tag: 'Workflows',
      action: 'workflow.read',
      handler: ({ app, principal }) => {
        const items = app.state.registry.listWorkflows(principal.tenant).map((w) => {
          const recent = app.state.runs.listRuns({ tenant: principal.tenant, workflow: w.name, limit: 20 });
          const plan = w.settings.stableVersion ? app.state.registry.getVersion(principal.tenant, w.name, w.settings.stableVersion) : undefined;
          const p = plan ? app.state.registry.getPlan(principal.tenant, plan.planHash) : undefined;
          return {
            name: w.name,
            description: p?.workflow.description ?? null,
            owner: p?.workflow.owner ?? null,
            team: p?.workflow.team ?? null,
            criticality: p?.workflow.criticality ?? null,
            versions: w.versions,
            stableVersion: w.settings.stableVersion ?? null,
            latest: w.latest ?? null,
            canary: w.settings.canaryVersion ? { version: w.settings.canaryVersion, percent: w.settings.canaryPercent } : null,
            enabled: w.settings.enabled,
            killed: w.settings.killed,
            autonomyTier: w.settings.autonomyTier,
            lastPublishedAt: w.lastPublishedAt ?? null,
            triggers: app.state.triggers.listForWorkflow(principal.tenant, w.name).map((t) => ({ name: t.name, type: t.type, nextFireAt: t.nextFireAt ?? null })),
            lastRun: recent[0] ? runSummary(recent[0]) : null,
            recent: {
              total: recent.length,
              succeeded: recent.filter((r) => r.status === 'succeeded').length,
              failed: recent.filter((r) => ['failed', 'rolled-back', 'compensation-failed'].includes(r.status)).length,
            },
            analysis: p?.analysis ?? null,
          };
        });
        return { items };
      },
    },
    {
      method: 'GET',
      url: '/v1/workflows/:name',
      summary: 'Workflow detail: settings, versions, triggers, findings and recent runs',
      tag: 'Workflows',
      action: 'workflow.read',
      schema: { params: wfParam },
      handler: ({ app, principal, params }) => {
        const settings = app.state.registry.getSettings(principal.tenant, params.name);
        if (!settings) throw new NotFoundError('Workflow', params.name);
        const versions = app.state.registry.listVersions(principal.tenant, params.name).map(({ manifestText: _m, ...v }) => v);
        const stable = settings.stableVersion ? app.state.registry.getVersion(principal.tenant, params.name, settings.stableVersion) : undefined;
        const plan = stable ? app.state.registry.getPlan(principal.tenant, stable.planHash) : undefined;
        return {
          name: params.name,
          settings,
          versions,
          triggers: app.state.triggers.listForWorkflow(principal.tenant, params.name),
          plan: plan ? { workflow: plan.workflow, inputs: plan.inputs, analysis: plan.analysis, policy: plan.policy, triggers: plan.triggers, planHash: stable!.planHash } : null,
          findings: settings.stableVersion ? app.state.authoring.listFindings(principal.tenant, params.name, settings.stableVersion) : [],
          recentRuns: app.state.runs.listRuns({ tenant: principal.tenant, workflow: params.name, limit: 15 }).map(runSummary),
          pendingChanges: app.state.authoring.listChanges(principal.tenant, 'pending').filter((c) => c.workflowName === params.name).map(({ manifestText: _m, ...c }) => c),
        };
      },
    },
    {
      method: 'GET',
      url: '/v1/workflows/:name/versions/:version',
      summary: 'One published version: manifest text, compiled plan, risk and findings',
      tag: 'Workflows',
      action: 'workflow.read',
      schema: { params: obj({ name, version: { type: 'string', maxLength: 64 } }, ['name', 'version']) },
      handler: ({ app, principal, params }) => {
        const v = app.state.registry.getVersion(principal.tenant, params.name, params.version);
        if (!v) throw new NotFoundError('Workflow version', `${params.name}@${params.version}`);
        return { version: v, plan: app.state.registry.getPlan(principal.tenant, v.planHash), findings: app.state.authoring.listFindings(principal.tenant, params.name, params.version) };
      },
    },
    {
      method: 'GET',
      url: '/v1/workflows/:name/graph',
      summary: 'The workflow as a graph (nodes and edges) for visualisation',
      tag: 'Workflows',
      action: 'workflow.read',
      schema: { params: wfParam, querystring: obj({ version: { type: 'string', maxLength: 64 } }) },
      handler: ({ app, principal, params, query }) => {
        const settings = app.state.registry.getSettings(principal.tenant, params.name);
        const version = query.version ?? settings?.stableVersion;
        if (!version) throw new NotFoundError('Workflow', params.name);
        const { plan } = app.registry.getVersionPlan(principal.tenant, params.name, version);
        return {
          version,
          nodes: plan.steps.map((s) => ({ id: s.id, type: s.type, name: s.name ?? null, capability: s.capability ? `${s.capability.name}@${s.capability.version}` : null, effect: s.effect ?? null, order: s.order, hasCompensation: s.compensate !== undefined, sensitivity: s.sensitivity })),
          edges: plan.steps.flatMap((s) => s.dependsOn.map((d) => ({ from: d, to: s.id, conditional: s.when !== undefined }))),
          routes: plan.steps.flatMap((s) => (typeof s.onError === 'object' && s.onError !== null ? [{ from: s.id, to: s.onError.routeTo }] : [])),
        };
      },
    },
    {
      method: 'POST',
      url: '/v1/workflows/validate',
      summary: 'Validate, compile and risk-review a manifest without saving it',
      tag: 'Workflows',
      action: 'workflow.draft',
      schema: { body: obj({ manifest: { type: 'string', minLength: 1, maxLength: 1_048_576 } }, ['manifest']) },
      handler: ({ app, principal, body }) => {
        const r = app.registry.inspect(principal.tenant, body.manifest);
        return {
          ok: r.ok,
          errors: r.errors,
          warnings: r.warnings,
          ...(r.plan ? { workflow: r.plan.workflow, planHash: r.planHash, analysis: r.plan.analysis, steps: r.plan.steps.length } : {}),
          ...(r.risk ? { risk: { score: r.risk.score, level: r.risk.level, blocking: r.risk.blocking, findings: r.risk.findings } } : {}),
          ...(r.plan ? { policy: describePolicy(app.policy.decide({ principal, action: 'workflow.publish', resource: { tenant: principal.tenant, workflow: r.plan.workflow.name, criticality: r.plan.workflow.criticality, plan: r.plan, ...(r.risk ? { risk: { score: r.risk.score, level: r.risk.level, blocking: r.risk.blocking, findings: r.risk.findings.length } } : {}) } })) } : {}),
        };
      },
    },
    {
      method: 'POST',
      url: '/v1/workflows',
      summary: 'Publish a workflow version (or open a change request when policy requires approval)',
      tag: 'Workflows',
      action: 'workflow.publish',
      schema: { body: obj({ manifest: { type: 'string', minLength: 1, maxLength: 1_048_576 }, canaryPercent: { type: 'integer', minimum: 1, maximum: 100 } }, ['manifest']) },
      handler: ({ app, principal, body, reply }) => {
        const r = app.registry.submit(principal, body.manifest, body.canaryPercent ? { canaryPercent: body.canaryPercent } : {});
        if (r.status === 'published') {
          reply.code(201);
          const { manifestText: _m, ...version } = r.version;
          return { status: 'published', version, risk: { score: r.risk.score, level: r.risk.level, findings: r.risk.findings.length } };
        }
        reply.code(202);
        const { manifestText: _m, ...change } = r.change;
        return { status: 'pending-approval', change, decision: describePolicy(r.decision) };
      },
    },
    {
      method: 'POST',
      url: '/v1/workflows/:name/run',
      summary: 'Start a run',
      tag: 'Runs',
      action: 'workflow.run',
      status: 202,
      schema: {
        params: wfParam,
        body: obj({ inputs: { type: 'object' }, version: { type: 'string', maxLength: 64 }, dryRun: { type: 'boolean' }, priority: { type: 'integer', minimum: 1, maximum: 9 }, correlationId: { type: 'string', maxLength: 128 } }),
      },
      handler: ({ app, principal, params, body = {}, reply }) => {
        const r = app.runs.trigger({
          principal,
          workflow: params.name,
          ...(body.version ? { version: body.version } : {}),
          inputs: body.inputs ?? {},
          trigger: { type: principal.type === 'api-key' ? 'api' : 'manual', name: principal.name },
          ...(body.dryRun ? { dryRun: true } : {}),
          ...(body.priority ? { priority: body.priority } : {}),
          ...(body.correlationId ? { correlationId: body.correlationId } : {}),
        });
        if (r.status === 'queued') return { status: 'queued', run: runSummary(r.run) };
        reply.code(200);
        return r.status === 'deduplicated' ? { status: 'deduplicated', run: runSummary(r.run) } : { status: 'skipped', reason: r.reason };
      },
    },

    // --------------------------------------------------------------- rollout
    ...(
      [
        ['activate', 'Point the stable version at a published version (promotion or rollback)', { version: { type: 'string', maxLength: 64 } }, ['version'], (a, p, n, b) => a.registry.activate(p, n, b.version)],
        ['canary', 'Send a percentage of runs to a version (0 clears the canary)', { version: { type: 'string', maxLength: 64 }, percent: { type: 'integer', minimum: 0, maximum: 100 } }, ['version', 'percent'], (a, p, n, b) => a.registry.setCanary(p, n, b.version, b.percent)],
        ['promote', 'Promote the canary to stable', {}, [], (a, p, n) => a.registry.promoteCanary(p, n)],
        ['rollback-canary', 'Drop the canary', {}, [], (a, p, n) => a.registry.rollbackCanary(p, n, 'manual rollback')],
        ['deprecate', 'Deprecate a version', { version: { type: 'string', maxLength: 64 } }, ['version'], (a, p, n, b) => a.registry.deprecate(p, n, b.version)],
        ['enable', 'Enable the workflow', {}, [], (a, p, n) => a.registry.setEnabled(p, n, true)],
        ['disable', 'Disable the workflow (triggers stop, new runs are refused)', {}, [], (a, p, n) => a.registry.setEnabled(p, n, false)],
        ['kill', 'Kill switch: refuse new runs and cancel queued ones', { reason: { type: 'string', minLength: 1, maxLength: 500 } }, ['reason'], (a, p, n, b) => a.registry.kill(p, n, b.reason)],
        ['revive', 'Lift the kill switch', {}, [], (a, p, n) => a.registry.revive(p, n)],
        ['autonomy', 'Set the agent autonomy tier (T0–T3)', { tier: { enum: ['T0', 'T1', 'T2', 'T3'] } }, ['tier'], (a, p, n, b) => a.registry.setAutonomy(p, n, b.tier)],
      ] as Array<[string, string, Record<string, unknown>, string[], (a: any, p: any, n: string, b: any) => unknown]>
    ).map(
      ([op, summary, props, required, fn]): RouteDef => ({
        method: 'POST',
        url: `/v1/workflows/:name/${op}`,
        summary,
        tag: 'Rollout & controls',
        action: 'workflow.manage',
        schema: { params: wfParam, body: obj(props, required) },
        handler: ({ app, principal, params, body }) => ({ ok: true, result: fn(app, principal, params.name, body ?? {}) }),
      }),
    ),

    {
      method: 'GET',
      url: '/v1/changes',
      summary: 'Change requests awaiting approval',
      tag: 'Change control',
      action: 'workflow.read',
      schema: { querystring: obj({ status: { enum: ['pending', 'approved', 'rejected', 'published', 'withdrawn'] } }) },
      handler: ({ app, principal, query }) => ({
        items: app.state.authoring.listChanges(principal.tenant, query.status).map(({ manifestText: _m, ...c }) => c),
      }),
    },
    {
      method: 'GET',
      url: '/v1/changes/:id',
      summary: 'A change request with its manifest and risk review',
      tag: 'Change control',
      action: 'workflow.read',
      schema: { params: obj({ id }, ['id']) },
      handler: ({ app, principal, params }) => {
        const c = app.state.authoring.getChange(params.id, principal.tenant);
        if (!c) throw new NotFoundError('Change request', params.id);
        return c;
      },
    },
    {
      method: 'POST',
      url: '/v1/changes/:id/approve',
      summary: 'Approve a change request (publishes once enough approvers agree)',
      tag: 'Change control',
      action: 'workflow.approve-change',
      schema: { params: obj({ id }, ['id']), body: obj({ comment: { type: 'string', maxLength: 1000 } }) },
      handler: ({ app, principal, params, body }) => {
        const r = app.registry.approveChange(principal, params.id, body?.comment);
        const { manifestText: _m, ...change } = r.change;
        return { change, ...(r.published ? { published: { name: r.published.name, version: r.published.version } } : {}) };
      },
    },
    {
      method: 'POST',
      url: '/v1/changes/:id/reject',
      summary: 'Reject a change request',
      tag: 'Change control',
      action: 'workflow.approve-change',
      schema: { params: obj({ id }, ['id']), body: obj({ comment: { type: 'string', maxLength: 1000 } }) },
      handler: ({ app, principal, params, body }) => {
        const { manifestText: _m, ...c } = app.registry.rejectChange(principal, params.id, body?.comment);
        return c;
      },
    },
    {
      method: 'POST',
      url: '/v1/changes/:id/withdraw',
      summary: 'Withdraw your own change request',
      tag: 'Change control',
      action: 'workflow.draft',
      schema: { params: obj({ id }, ['id']) },
      handler: ({ app, principal, params }) => {
        const { manifestText: _m, ...c } = app.registry.withdrawChange(principal, params.id);
        return c;
      },
    },
  ];
}

const describePolicy = (d: PolicyDecision) => ({ effect: d.effect, reasonCode: d.reasonCode, reason: d.reason, ...(d.requiredApprovals ? { requiredApprovals: d.requiredApprovals } : {}) });

export { csv, limitQ };
