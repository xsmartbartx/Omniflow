import * as api from '../api.js';
import { clear, h } from '../dom.js';
import { number } from '../format.js';
import { can } from '../session.js';
import { badge, button, card, dataTable, icon, input, pageHeader, select, statusBadge } from '../ui.js';
import { triggerChips, when, wfLink } from './common.js';

const stateOf = (w) => (w.killed ? 'killed' : w.enabled ? 'enabled' : 'disabled');

export default async function workflows(ctx) {
  const { items } = await api.get('/v1/workflows');
  const list = h('div');
  const q = input({ type: 'search', placeholder: 'Filter workflows…', 'aria-label': 'Filter workflows', value: ctx.query.q ?? '' });
  const state = select([['', 'Any state'], 'enabled', 'disabled', 'killed'], '', { 'aria-label': 'State' });
  const crit = select([['', 'Any criticality'], 'low', 'medium', 'high', 'critical'], '', { 'aria-label': 'Criticality' });

  const draw = () => {
    const term = q.value.trim().toLowerCase();
    const rows = items.filter((w) => (!term || `${w.name} ${w.description ?? ''} ${w.owner ?? ''}`.toLowerCase().includes(term)) && (!state.value || stateOf(w) === state.value) && (!crit.value || w.criticality === crit.value));
    clear(list).append(
      dataTable({
        rows,
        empty: items.length ? 'No workflow matches these filters.' : 'No workflows yet. Create your first one in the editor.',
        onRow: (w) => (location.hash = `#/workflows/${api.enc(w.name)}`),
        columns: [
          { label: 'Workflow', class: 'wide', render: (w) => h('div', {}, wfLink(w.name), w.description ? h('div', { class: 'muted' }, w.description) : null) },
          { label: 'Version', class: 'nowrap', render: (w) => h('span', {}, w.stableVersion ?? '—', w.canary ? badge(`canary ${w.canary.version} · ${w.canary.percent}%`, 'accent') : null) },
          { label: 'State', render: (w) => statusBadge(stateOf(w)) },
          { label: 'Criticality', render: (w) => w.criticality ?? '—' },
          { label: 'Triggers', render: (w) => triggerChips(w.triggers) },
          { label: 'Recent', class: 'num nowrap', render: (w) => (w.recent.total ? h('span', {}, `${w.recent.succeeded}/${w.recent.total}`, w.recent.failed ? badge(`${w.recent.failed} failed`, 'bad') : null) : '—') },
          { label: 'Last run', class: 'nowrap', render: (w) => (w.lastRun ? h('span', {}, statusBadge(w.lastRun.status), ' ', when(w.lastRun.createdAt)) : '—') },
        ],
      }),
    );
  };
  for (const c of [q, state, crit]) c.addEventListener('input', draw);
  draw();

  return h('div', {}, pageHeader('Workflows', `${number(items.length)} workflow${items.length === 1 ? '' : 's'}`, can('workflow.draft') ? [button('New workflow', { kind: 'primary', icon: 'plus', onClick: () => (location.hash = '#/editor') })] : null), h('div', { class: 'toolbar' }, h('div', { class: 'search' }, icon('search', { size: 15 }), q), state, crit), card(null, list, { flush: true }));
}
