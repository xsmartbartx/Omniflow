import type { FastifyReply } from 'fastify';
import type { RouteDef } from '../http.ts';
import { id, name, obj } from './util.ts';

const manifest = { type: 'string', minLength: 1, maxLength: 1_048_576 } as const;
const version = { type: 'string', maxLength: 64 } as const;
const draftStatus = { enum: ['open', 'submitted', 'rejected', 'published'] } as const;

function sendText(reply: FastifyReply, type: string, text: string): void {
  reply.hijack();
  reply.raw.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" });
  reply.raw.end(text);
}

/** Drafts, AI authoring, importers, explanations and generated documentation. */
export function authoringRoutes(): RouteDef[] {
  return [
    {
      method: 'GET',
      url: '/v1/authoring/status',
      summary: 'Whether AI authoring is available, and which model it uses',
      tag: 'Authoring',
      action: 'workflow.read',
      handler: ({ app }) => ({ aiEnabled: app.authoring.aiEnabled, model: app.authoring.aiEnabled ? app.config.adapters.llm.model : null }),
    },

    // ------------------------------------------------------------------ drafts
    {
      method: 'GET',
      url: '/v1/drafts',
      summary: 'Drafts (human, AI-authored and imported)',
      tag: 'Authoring',
      action: 'workflow.read',
      schema: { querystring: obj({ status: draftStatus }) },
      handler: ({ app, principal, query }) => ({ items: app.authoring.listDrafts(principal, query.status).map(({ manifestText: _m, ...d }) => d) }),
    },
    {
      method: 'POST',
      url: '/v1/drafts',
      summary: 'Save a draft manifest. It is validated and risk-reviewed, but not published.',
      tag: 'Authoring',
      action: 'workflow.draft',
      status: 201,
      schema: { body: obj({ manifest }, ['manifest']) },
      handler: ({ app, principal, body }) => app.authoring.createDraft(principal, { manifest: body.manifest }),
    },
    {
      method: 'GET',
      url: '/v1/drafts/:id',
      summary: 'A draft with its manifest and latest validation',
      tag: 'Authoring',
      action: 'workflow.read',
      schema: { params: obj({ id }, ['id']) },
      handler: ({ app, principal, params }) => app.authoring.getDraft(principal, params.id),
    },
    {
      method: 'PUT',
      url: '/v1/drafts/:id',
      summary: 'Replace a draft’s manifest (re-validates it)',
      tag: 'Authoring',
      action: 'workflow.draft',
      schema: { params: obj({ id }, ['id']), body: obj({ manifest }, ['manifest']) },
      handler: ({ app, principal, params, body }) => app.authoring.updateDraft(principal, params.id, body.manifest),
    },
    {
      method: 'DELETE',
      url: '/v1/drafts/:id',
      summary: 'Delete an unpublished draft',
      tag: 'Authoring',
      action: 'workflow.draft',
      schema: { params: obj({ id }, ['id']) },
      handler: ({ app, principal, params }) => {
        app.authoring.deleteDraft(principal, params.id);
        return { ok: true };
      },
    },
    {
      method: 'POST',
      url: '/v1/drafts/:id/validate',
      summary: 'Re-run validation, compilation and risk review against the current registry',
      tag: 'Authoring',
      action: 'workflow.draft',
      schema: { params: obj({ id }, ['id']) },
      handler: ({ app, principal, params }) => app.authoring.revalidate(principal, params.id),
    },
    {
      method: 'POST',
      url: '/v1/drafts/:id/submit',
      summary: 'Publish a draft, or open a change request when policy requires approval',
      tag: 'Authoring',
      action: 'workflow.publish',
      schema: { params: obj({ id }, ['id']), body: obj({ canaryPercent: { type: 'integer', minimum: 1, maximum: 100 } }) },
      handler: ({ app, principal, params, body, reply }) => {
        const r = app.authoring.submitDraft(principal, params.id, body?.canaryPercent ? { canaryPercent: body.canaryPercent } : {});
        if (r.status === 'published') {
          reply.code(201);
          const { manifestText: _m, ...v } = r.version;
          return { status: 'published', version: v, risk: { score: r.risk.score, level: r.risk.level, findings: r.risk.findings.length } };
        }
        reply.code(202);
        const { manifestText: _m, ...change } = r.change;
        return { status: 'pending-approval', change, decision: { effect: r.decision.effect, reasonCode: r.decision.reasonCode, reason: r.decision.reason } };
      },
    },
    {
      method: 'POST',
      url: '/v1/drafts/:id/apply',
      summary: 'Apply an agent-authored draft under the workflow’s autonomy tier (T0–T3)',
      tag: 'Authoring',
      action: 'workflow.publish',
      schema: { params: obj({ id }, ['id']) },
      handler: ({ app, principal, params }) => {
        const r = app.authoring.applyDraft(principal, params.id);
        if (!r.result) return { applied: false, tier: r.tier, verdict: r.verdict };
        return r.result.status === 'published'
          ? { applied: true, tier: r.tier, verdict: r.verdict, status: 'published', version: r.result.version.version }
          : { applied: true, tier: r.tier, verdict: r.verdict, status: 'pending-approval', changeId: r.result.change.id };
      },
    },

    // ------------------------------------------------------------- AI drafting
    {
      method: 'POST',
      url: '/v1/authoring/plan',
      summary: 'Describe what you want; the Planner Agent writes a draft manifest. It is only a draft.',
      tag: 'Authoring',
      action: 'agent.invoke',
      schema: { body: obj({ intent: { type: 'string', minLength: 3, maxLength: 8000 }, workflow: name }, ['intent']) },
      handler: async ({ app, principal, body, req }) => app.authoring.plan(principal, { intent: body.intent, ...(body.workflow ? { workflow: body.workflow } : {}) }, abortOnClose(req)),
    },
    {
      method: 'POST',
      url: '/v1/authoring/from-proposal/:id',
      summary: 'Turn an improvement proposal into a draft revision of the affected workflow',
      tag: 'Authoring',
      action: 'agent.invoke',
      schema: { params: obj({ id }, ['id']) },
      handler: async ({ app, principal, params, req }) => app.authoring.draftFromProposal(principal, params.id, abortOnClose(req)),
    },

    // ---------------------------------------------------------------- importers
    {
      method: 'POST',
      url: '/v1/import/crontab',
      summary: 'Import a crontab: one Lift draft per job, wrapped in a supervised shell step with a sunset date',
      tag: 'Authoring',
      action: 'workflow.draft',
      schema: { body: obj({ text: { type: 'string', minLength: 1, maxLength: 200_000 }, owner: { type: 'string', maxLength: 200 }, timezone: { type: 'string', maxLength: 64 } }, ['text']) },
      handler: ({ app, principal, body }) => {
        const r = app.authoring.importCrontab(principal, body);
        return { drafts: r.drafts.map(({ draft, notes, line }) => ({ line, notes, draft: { id: draft.id, workflowName: draft.workflowName ?? null, validation: draft.validation } })), skipped: r.skipped, environment: r.environment };
      },
    },
    {
      method: 'POST',
      url: '/v1/import/script',
      summary: 'Import a legacy script: the Planner Agent proposes a decomposed workflow (draft only)',
      tag: 'Authoring',
      action: 'agent.invoke',
      schema: { body: obj({ script: { type: 'string', minLength: 1, maxLength: 200_000 }, name, description: { type: 'string', maxLength: 2000 } }, ['script']) },
      handler: async ({ app, principal, body, req }) => app.authoring.importScript(principal, body, abortOnClose(req)),
    },

    // -------------------------------------------------------- explain and docs
    {
      method: 'GET',
      url: '/v1/workflows/:name/explain',
      summary: 'A plain-language explanation of what a workflow does',
      tag: 'Authoring',
      action: 'workflow.read',
      schema: { params: obj({ name }, ['name']), querystring: obj({ version }) },
      handler: ({ app, principal, params, query }) => app.authoring.explainWorkflow(principal, params.name, query.version),
    },
    {
      method: 'GET',
      url: '/v1/workflows/:name/docs',
      summary: 'Generated documentation with a Mermaid diagram (json, markdown or mermaid)',
      tag: 'Authoring',
      action: 'workflow.read',
      raw: true,
      schema: { params: obj({ name }, ['name']), querystring: obj({ version, format: { enum: ['json', 'markdown', 'mermaid'] } }) },
      handler: ({ app, principal, params, query, reply }) => {
        const d = app.authoring.workflowDocs(principal, params.name, query.version);
        if (query.format === 'markdown') return sendText(reply, 'text/markdown', d.markdown);
        if (query.format === 'mermaid') return sendText(reply, 'text/plain', d.mermaid);
        reply.type('application/json').send(d);
      },
    },
    {
      method: 'GET',
      url: '/v1/runs/:id/explain',
      summary: 'A plain-language account of what happened in a run, and what to do about a failure',
      tag: 'Authoring',
      action: 'run.read',
      schema: { params: obj({ id }, ['id']) },
      handler: ({ app, principal, params }) => app.authoring.explainRun(principal, params.id),
    },
    {
      method: 'GET',
      url: '/v1/docs/capabilities',
      summary: 'The capability catalogue as Markdown',
      tag: 'Authoring',
      action: 'workflow.read',
      raw: true,
      handler: ({ app, reply }) => sendText(reply, 'text/markdown', app.authoring.catalogueDocs()),
    },
    {
      method: 'GET',
      url: '/v1/docs/workflows',
      summary: 'An index of all workflows as Markdown',
      tag: 'Authoring',
      action: 'workflow.read',
      raw: true,
      handler: ({ app, principal, reply }) => sendText(reply, 'text/markdown', app.authoring.indexDocs(principal)),
    },
  ];
}

/** Abort the model call if the client goes away — no point paying for an answer nobody will read. */
function abortOnClose(req: { raw: { on(e: 'close', f: () => void): unknown; destroyed?: boolean } }): AbortSignal {
  const ac = new AbortController();
  req.raw.on('close', () => ac.abort());
  return ac.signal;
}
