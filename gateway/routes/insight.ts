import { NotFoundError } from '../../core/index.ts';
import { buildOverview } from '../../insight/index.ts';
import type { RouteDef } from '../http.ts';
import { id, obj } from './util.ts';

const proposalStatus = { enum: ['open', 'accepted', 'dismissed'] } as const;

/** The Insight plane's read side: dashboards, alerts, and the proposal queue the Analysis Agent writes to. */
export function insightRoutes(): RouteDef[] {
  return [
    {
      method: 'GET',
      url: '/v1/insights/overview',
      summary: 'Dashboard: run outcomes, latency, cost, approvals and the noisiest failing steps',
      tag: 'Insight',
      action: 'run.read',
      schema: { querystring: obj({ hours: { type: 'integer', minimum: 1, maximum: 720, default: 24 } }) },
      handler: ({ app, principal, query }) => buildOverview(app.state, principal.tenant, { hours: query.hours ?? 24 }),
    },
    {
      method: 'GET',
      url: '/v1/insights/alerts',
      summary: 'Alerts that are open now, and recent alert history',
      tag: 'Insight',
      action: 'workflow.read',
      handler: ({ app, principal }) => ({ active: app.alerts.active(principal.tenant), history: app.alerts.history(principal.tenant, 50) }),
    },
    {
      method: 'POST',
      url: '/v1/insights/analyze',
      summary: 'Run the Analysis Agent now. New findings land in the proposal queue; nothing else changes.',
      tag: 'Insight',
      action: 'agent.invoke',
      status: 200,
      handler: ({ app, principal }) => {
        const r = app.analysis.run(principal.tenant);
        return { findings: r.findings.length, raised: r.raised.length, suppressed: r.suppressed, resolved: r.resolved, proposals: r.raised };
      },
    },
    {
      method: 'GET',
      url: '/v1/proposals',
      summary: 'Improvement proposals from the Analysis Agent and the authoring agents',
      tag: 'Insight',
      action: 'workflow.read',
      schema: { querystring: obj({ status: proposalStatus, workflow: { type: 'string', maxLength: 64 } }) },
      handler: ({ app, principal, query }) => ({
        items: app.state.authoring.listProposals(principal.tenant, query.status).filter((p) => !query.workflow || p.workflowName === query.workflow),
      }),
    },
    {
      method: 'GET',
      url: '/v1/proposals/:id',
      summary: 'One proposal, with the evidence behind it',
      tag: 'Insight',
      action: 'workflow.read',
      schema: { params: obj({ id }, ['id']) },
      handler: ({ app, principal, params }) => {
        const p = app.state.authoring.getProposal(params.id, principal.tenant);
        if (!p) throw new NotFoundError('Proposal', params.id);
        return p;
      },
    },
    {
      method: 'POST',
      url: '/v1/proposals/:id/decide',
      summary: 'Accept or dismiss a proposal. Accepting records intent; it does not change any workflow.',
      tag: 'Insight',
      action: 'workflow.draft',
      schema: { params: obj({ id }, ['id']), body: obj({ status: { enum: ['accepted', 'dismissed'] } }, ['status']) },
      handler: ({ app, principal, params, body }) => {
        if (!app.state.authoring.getProposal(params.id, principal.tenant)) throw new NotFoundError('Proposal', params.id);
        return app.state.authoring.decideProposal(params.id, body.status, principal.id);
      },
    },
  ];
}
