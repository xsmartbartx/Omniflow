import * as api from '../api.js';
import { clear, h } from '../dom.js';
import { timestamp, truncate } from '../format.js';
import { can } from '../session.js';
import { button, card, dataTable, input, notice, openDialog, codeBlock, pageHeader, toast } from '../ui.js';
import { runLink } from './common.js';

export default async function audit() {
  const type = input({ placeholder: 'Event type (e.g. run.failed, workflow.published)', 'aria-label': 'Event type', style: { minWidth: '300px' } });
  const box = h('div');
  const more = h('div', { class: 'row' });
  let before;
  let rows = [];

  const load = async (append) => {
    const q = new URLSearchParams({ limit: '100', order: 'desc' });
    if (type.value.trim()) q.set('type', type.value.trim());
    if (append && before) q.set('beforeSeq', String(before));
    const r = await api.get(`/v1/audit/events?${q}`);
    rows = append ? rows.concat(r.items) : r.items;
    before = rows.at(-1)?.seq;
    clear(box).append(dataTable({
      rows,
      empty: 'No events match.',
      onRow: (e) => openDialog({ title: `#${e.seq} ${e.type}`, wide: true, body: codeBlock(JSON.stringify(e, null, 2)), actions: (close) => [button('Close', { kind: 'primary', onClick: () => close(true) })] }),
      columns: [
        { label: '#', class: 'num', render: (e) => e.seq },
        { label: 'When', class: 'nowrap', render: (e) => timestamp(e.ts) },
        { label: 'Event', render: (e) => h('code', {}, e.type) },
        { label: 'Actor', render: (e) => e.actor?.name ?? e.actor?.id ?? 'system' },
        { label: 'Run', render: (e) => (e.runId ? runLink(e.runId) : '') },
        { label: 'Detail', render: (e) => h('span', { class: 'muted' }, truncate(JSON.stringify(e.data), 90)) },
      ],
    }));
    clear(more).append(r.items.length === 100 ? button('Load older', { onClick: () => load(true) }) : h('span', { class: 'muted' }, `${rows.length} of ${r.total} events shown`));
  };
  let debounce;
  type.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => load(false), 300);
  });
  await load(false);

  const verifyBox = h('div');
  const verify = button('Verify integrity', { icon: 'audit', busyLabel: 'Verifying…', onClick: async () => {
    const r = await api.get('/v1/audit/verify');
    clear(verifyBox).append(r.ok ? notice('good', h('strong', {}, 'The audit log is intact. '), `${r.checked} events verified; every hash and link matches.`) : notice('bad', h('strong', {}, 'Tampering detected. '), `The chain breaks at event ${r.brokenAtSeq}: ${r.reason}. Treat this as a security incident.`));
    if (r.ok) toast('Audit log intact', 'good');
  } });
  return h('div', {}, pageHeader('Audit log', 'An append-only, hash-chained record of everything that happened.', [verify, can('audit.read') ? h('a', { class: 'btn', href: '/v1/audit/export', download: 'omniflow-audit.ndjson' }, 'Export') : null]), h('div', { class: 'stack' }, verifyBox, h('div', { class: 'toolbar' }, type), card(null, box, { flush: true }), more));
}
