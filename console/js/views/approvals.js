import * as api from '../api.js';
import { clear, h } from '../dom.js';
import { timestamp, until } from '../format.js';
import { can } from '../session.js';
import { button, card, dataTable, pageHeader, statusBadge, tabs } from '../ui.js';
import { runLink, when, wfLink } from './common.js';
import { decide } from './run.js';

export default async function approvals(ctx) {
  const view = (status) => async () => {
    const box = h('div');
    const load = async () => {
      const { items } = await api.get(`/v1/approvals?status=${status}&limit=200`);
      clear(box).append(
        dataTable({
          rows: items,
          empty: status === 'pending' ? 'Nothing is waiting for a decision.' : 'No approvals here.',
          columns: [
            { label: 'Request', render: (a) => h('div', {}, h('strong', {}, a.message), h('div', { class: 'muted' }, a.workflowName ? wfLink(a.workflowName) : null, ` › ${a.stepId}`)) },
            { label: 'Run', render: (a) => runLink(a.runId) },
            { label: 'Requested', class: 'nowrap', render: (a) => when(a.requestedAt) },
            { label: status === 'pending' ? 'Expires' : 'Decided', class: 'nowrap', render: (a) => (status === 'pending' ? h('span', { title: timestamp(a.expiresAt) }, `${until(a.expiresAt)} (${a.onTimeout})`) : h('span', {}, a.decidedBy ?? 'timeout', a.comment ? h('div', { class: 'muted' }, `“${a.comment}”`) : null)) },
            { label: '', class: 'nowrap', render: (a) => (status !== 'pending' ? statusBadge(a.status) : a.canDecide ? h('span', { class: 'row', style: { gap: '4px' } }, button('Approve', { small: true, kind: 'primary', onClick: () => decide(a, 'approved', after) }), button('Deny', { small: true, kind: 'danger', onClick: () => decide(a, 'denied', after) })) : h('span', { class: 'muted', title: can('approval.decide') ? 'You started this run, or are not one of its approvers' : 'You do not have the approver role' }, 'not yours')) },
          ],
        }),
      );
    };
    const after = async () => {
      await load();
      ctx.refreshBadges();
    };
    await load();
    if (status === 'pending') ctx.poll(load, 10000);
    return card(null, box, { flush: true });
  };
  return h('div', {}, pageHeader('Approvals', 'Runs that are paused until a person decides.'), tabs([{ id: 'pending', label: 'Waiting', render: view('pending') }, { id: 'approved', label: 'Approved', render: view('approved') }, { id: 'denied', label: 'Denied', render: view('denied') }, { id: 'timed-out', label: 'Timed out', render: view('timed-out') }]));
}
