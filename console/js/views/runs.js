import * as api from '../api.js';
import { clear, h } from '../dom.js';

import { card, input, pageHeader, select } from '../ui.js';
import { runsTable } from './common.js';

const STATUSES = [
  '',
  'queued',
  'running',
  'waiting-approval',
  'waiting-event',
  'succeeded',
  'failed',
  'rolled-back',
  'compensation-failed',
  'cancelled',
];

export default async function runs(ctx) {
  const workflow = input({ placeholder: 'Workflow name', value: ctx.query.workflow ?? '', 'aria-label': 'Workflow' });
  const status = select(
    STATUSES.map((s) => [s, s || 'Any status']),
    ctx.query.status ?? '',
    { 'aria-label': 'Status' },
  );
  const list = h('div');
  const footer = h('p', { class: 'muted' });
  let limit = 50;

  const load = async () => {
    const q = new URLSearchParams({ limit: String(limit) });
    if (workflow.value.trim()) q.set('workflow', workflow.value.trim());
    if (status.value) q.set('status', status.value);
    const r = await api.get(`/v1/runs?${q}`);
    clear(list).append(runsTable(r.items, { empty: 'No runs match.' }));
    clear(footer).append(
      `Showing ${r.items.length} of ${r.total}.`,
      r.items.length < r.total
        ? h(
            'button',
            {
              class: 'btn btn-sm',
              type: 'button',
              onClick: () => {
                limit += 50;
                load();
              },
            },
            'Show more',
          )
        : '',
    );
    return r;
  };
  let debounce;
  workflow.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(load, 250);
  });
  status.addEventListener('change', load);
  await load();
  ctx.poll(load, 5000);
  return h(
    'div',
    {},
    pageHeader('Runs', 'Every execution, newest first. This list refreshes on its own.'),
    h('div', { class: 'toolbar' }, workflow, status),
    card(null, list, { flush: true }),
    footer,
  );
}
