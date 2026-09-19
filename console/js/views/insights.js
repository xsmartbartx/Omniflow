import * as api from '../api.js';
import { h } from '../dom.js';
import { ago, timestamp } from '../format.js';
import { can } from '../session.js';
import { badge, button, card, dataTable, emptyState, notice, pageHeader, statusBadge, tabs, toast } from '../ui.js';
import { wfLink } from './common.js';

export default async function insights(ctx) {
  const alerts = async () => {
    const r = await api.get('/v1/insights/alerts');
    return h(
      'div',
      { class: 'stack' },
      r.active.length
        ? h(
            'div',
            { class: 'banner-list' },
            r.active.map((a) =>
              notice(
                a.severity === 'critical' ? 'bad' : 'warn',
                h('strong', {}, a.title),
                h('p', {}, a.message),
                h('p', { class: 'muted' }, `Open since ${timestamp(a.raisedAt)}`),
              ),
            ),
          )
        : notice('good', h('strong', {}, 'No open alerts.'), ' Everything is within its limits.'),
      card(
        'History',
        dataTable({
          rows: r.history,
          empty: 'No alerts have fired yet.',
          columns: [
            { label: 'When', class: 'nowrap', render: (e) => h('span', { title: timestamp(e.at) }, ago(e.at)) },
            {
              label: 'Event',
              render: (e) =>
                e.event === 'raised'
                  ? badge('raised', e.severity === 'critical' ? 'bad' : 'warn')
                  : badge('resolved', 'good'),
            },
            { label: 'Alert', render: (e) => e.title ?? e.key },
          ],
        }),
        { flush: true },
      ),
    );
  };

  const proposals = (status) => async () => {
    const { items } = await api.get(`/v1/proposals?status=${status}`);
    const aiOn = (await api.get('/v1/authoring/status').catch(() => ({ aiEnabled: false }))).aiEnabled;
    if (!items.length)
      return emptyState(
        status === 'open' ? 'No open suggestions' : 'Nothing here',
        status === 'open'
          ? 'The Analysis Agent reads your run history and suggests improvements. Run it now, or wait for its daily pass.'
          : undefined,
      );
    return h(
      'div',
      { class: 'stack' },
      items.map((p) => {
        const b = p.body ?? {};
        return card(
          h(
            'span',
            {},
            p.title,
            ' ',
            badge(b.severity ?? 'info', b.severity === 'high' ? 'bad' : b.severity === 'medium' ? 'warn' : 'neutral'),
          ),
          h(
            'div',
            { class: 'stack' },
            h('p', {}, b.summary),
            h('p', {}, h('strong', {}, 'Suggestion: '), b.recommendation),
            p.workflowName
              ? h('p', { class: 'muted' }, 'Workflow: ', wfLink(p.workflowName), b.stepId ? ` › ${b.stepId}` : '')
              : null,
            h(
              'details',
              {},
              h('summary', { class: 'muted' }, 'Evidence'),
              h('pre', { class: 'code' }, JSON.stringify(b.evidence, null, 2)),
            ),
          ),
          {
            actions:
              status === 'open' && can('workflow.draft')
                ? [
                    p.workflowName && can('agent.invoke') && aiOn
                      ? button('Draft a fix with AI', {
                          small: true,
                          icon: 'authoring',
                          busyLabel: 'Drafting…',
                          onClick: async () => {
                            const r = await api.post(`/v1/authoring/from-proposal/${api.enc(p.id)}`);
                            if (r.draft) location.hash = `#/editor/${api.enc(r.draft.id)}`;
                            else toast('The assistant did not produce a usable draft.', 'warn');
                          },
                        })
                      : null,
                    button('Accept', {
                      small: true,
                      onClick: async () => {
                        await api.post(`/v1/proposals/${api.enc(p.id)}/decide`, { status: 'accepted' });
                        toast('Marked as accepted', 'good');
                        ctx.navigate('/insights', { tab: 'proposals' });
                      },
                    }),
                    button('Dismiss', {
                      small: true,
                      onClick: async () => {
                        await api.post(`/v1/proposals/${api.enc(p.id)}/decide`, { status: 'dismissed' });
                        toast('Dismissed', 'good');
                        ctx.navigate('/insights', { tab: 'proposals' });
                      },
                    }),
                  ]
                : statusBadge(p.status),
          },
        );
      }),
    );
  };

  const analyze = can('agent.invoke')
    ? button('Run analysis now', {
        icon: 'insight',
        busyLabel: 'Analysing…',
        onClick: async () => {
          const r = await api.post('/v1/insights/analyze');
          toast(`${r.findings} finding(s), ${r.raised} new suggestion(s)`, 'good');
          ctx.navigate('/insights', { tab: 'proposals' });
        },
      })
    : null;
  return h(
    'div',
    {},
    pageHeader(
      'Insights',
      'Alerts that need attention, and suggestions from the Analysis Agent. Suggestions never change anything on their own.',
      analyze,
    ),
    tabs(
      [
        { id: 'alerts', label: 'Alerts', render: alerts },
        { id: 'proposals', label: 'Suggestions', render: proposals('open') },
        { id: 'closed', label: 'Reviewed', render: proposals('dismissed') },
      ],
      ctx.query.tab,
    ),
  );
}
