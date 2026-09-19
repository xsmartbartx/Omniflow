import * as api from '../api.js';
import { collapse, diffLines, stats } from '../diff.js';
import { h } from '../dom.js';
import { ago, timestamp } from '../format.js';
import { can } from '../session.js';
import {
  badge,
  button,
  card,
  codeBlock,
  dataTable,
  formDialog,
  kv,
  notice,
  openDialog,
  pageHeader,
  statusBadge,
  tabs,
  toast,
} from '../ui.js';
import { wfLink } from './common.js';

export default async function changes(ctx) {
  const view = (status) => async () => {
    const { items } = await api.get(`/v1/changes?status=${status}`);
    return card(
      null,
      dataTable({
        rows: items,
        empty: status === 'pending' ? 'No change requests are waiting.' : 'Nothing here.',
        onRow: (c) => open(c.id, ctx),
        columns: [
          {
            label: 'Workflow',
            render: (c) => h('span', {}, wfLink(c.workflowName), h('span', { class: 'muted' }, ` @${c.version}`)),
          },
          { label: 'Why review', render: (c) => c.reason },
          {
            label: 'Requested by',
            render: (c) =>
              h(
                'span',
                {},
                c.requestedByName ?? c.requestedBy,
                c.origin === 'agent' ? badge('AI-authored', 'accent') : null,
              ),
          },
          { label: 'Approvals', class: 'num', render: (c) => `${c.approvals.length}/${c.requiredApprovals}` },
          { label: 'Risk', render: (c) => (c.risk ? statusBadge(c.risk.level) : '—') },
          { label: 'When', render: (c) => h('span', { title: timestamp(c.requestedAt) }, ago(c.requestedAt)) },
          { label: 'Status', render: (c) => statusBadge(c.status) },
        ],
      }),
      { flush: true },
    );
  };
  return h(
    'div',
    {},
    pageHeader('Change requests', 'Publishing that policy says needs a second pair of eyes.'),
    tabs([
      { id: 'pending', label: 'Waiting', render: view('pending') },
      { id: 'published', label: 'Published', render: view('published') },
      { id: 'rejected', label: 'Rejected', render: view('rejected') },
      { id: 'withdrawn', label: 'Withdrawn', render: view('withdrawn') },
    ]),
  );
}

function diffView(before, after) {
  const ops = diffLines(before, after);
  const { added, removed } = stats(ops);
  const rows = collapse(ops, 3).map((o) =>
    o.op === 'gap'
      ? h('div', { class: 'diff-gap' }, `… ${o.count} unchanged line${o.count === 1 ? '' : 's'} …`)
      : h(
          'div',
          { class: `diff-line diff-${o.op}` },
          h('span', { class: 'diff-mark' }, o.op === 'add' ? '+' : o.op === 'del' ? '−' : ' '),
          h('span', {}, o.text || ' '),
        ),
  );
  return h(
    'div',
    {},
    h('div', { class: 'muted' }, `${added} added, ${removed} removed`),
    h('pre', { class: 'code diff' }, rows),
  );
}

async function open(id, ctx) {
  const c = await api.get(`/v1/changes/${api.enc(id)}`);
  let previous = null;
  try {
    const wf = await api.get(`/v1/workflows/${api.enc(c.workflowName)}`);
    if (wf.settings.stableVersion)
      previous = (
        await api.get(`/v1/workflows/${api.enc(c.workflowName)}/versions/${api.enc(wf.settings.stableVersion)}`)
      ).version;
  } catch {
    /* a brand-new workflow has nothing to compare against */
  }
  const findings = c.risk?.findings ?? [];
  const decide = (verb) => async (close) => {
    const v = await formDialog({
      title: `${verb === 'approve' ? 'Approve' : 'Reject'} ${c.workflowName}@${c.version}`,
      fields: [{ name: 'comment', label: 'Comment (optional)' }],
      submitLabel: verb === 'approve' ? 'Approve' : 'Reject',
      danger: verb === 'reject',
    });
    if (!v) return;
    const r = await api.post(`/v1/changes/${api.enc(id)}/${verb}`, v.comment ? { comment: v.comment } : {});
    toast(
      r.published
        ? `Published ${r.published.name}@${r.published.version}`
        : verb === 'approve'
          ? 'Approval recorded'
          : 'Rejected',
      'good',
    );
    close(true);
    ctx.navigate('/changes');
    ctx.refreshBadges();
  };
  await openDialog({
    title: `${c.workflowName} @ ${c.version}`,
    wide: true,
    body: h(
      'div',
      { class: 'stack' },
      kv([
        ['Status', statusBadge(c.status)],
        ['Why it needs review', c.reason],
        ['Requested by', `${c.requestedByName ?? c.requestedBy}${c.origin === 'agent' ? ' (AI-authored)' : ''}`],
        [
          'Approvals',
          `${c.approvals.length} of ${c.requiredApprovals}${c.approvals.length ? ` — ${c.approvals.map((a) => a.name ?? a.by).join(', ')}` : ''}`,
        ],
        c.risk ? ['Risk', h('span', {}, statusBadge(c.risk.level), ` score ${c.risk.score}/100`)] : null,
      ]),
      findings.length
        ? h(
            'div',
            {},
            h('strong', {}, 'Risk findings'),
            dataTable({
              rows: findings,
              columns: [
                { label: 'Severity', render: (f) => statusBadge(f.severity) },
                {
                  label: 'Finding',
                  render: (f) => h('span', {}, f.message, f.blocking ? badge('blocking', 'bad') : null),
                },
              ],
            }),
          )
        : notice('good', 'The risk review found nothing to report.'),
      previous
        ? h(
            'div',
            {},
            h('strong', {}, `Changes from ${previous.version} (active)`),
            diffView(previous.manifestText, c.manifestText),
          )
        : h('div', {}, h('strong', {}, 'Manifest'), codeBlock(c.manifestText)),
    ),
    actions: (close) => [
      button('Close', { onClick: () => close(true) }),
      c.status === 'pending' && can('workflow.approve-change')
        ? [
            button('Reject', { kind: 'danger', onClick: () => decide('reject')(close) }),
            button('Approve', { kind: 'primary', onClick: () => decide('approve')(close) }),
          ]
        : null,
    ],
  });
}
