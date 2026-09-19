import { enc } from '../api.js';
import { h } from '../dom.js';
import { ago, duration, number, timestamp } from '../format.js';
import { dataTable, statusBadge } from '../ui.js';

export const wfLink = (name, version) => h('a', { href: `#/workflows/${enc(name)}` }, name, version ? h('span', { class: 'muted' }, ` @${version}`) : null);
export const runLink = (id) => h('a', { href: `#/runs/${enc(id)}`, class: 'mono', title: id }, id.replace(/^run_/, '').slice(-10));
export const when = (iso) => h('span', { title: timestamp(iso) }, ago(iso));

export function runsTable(items, { showWorkflow = true, empty = 'No runs yet.' } = {}) {
  return dataTable({
    empty,
    rows: items,
    onRow: (r) => (location.hash = `#/runs/${enc(r.id)}`),
    columns: [
      { label: 'Run', render: (r) => runLink(r.id) },
      ...(showWorkflow ? [{ label: 'Workflow', render: (r) => wfLink(r.workflow, r.version) }] : []),
      { label: 'Status', render: (r) => h('span', {}, statusBadge(r.status), r.dryRun ? h('span', { class: 'muted' }, ' dry run') : null, r.canary ? h('span', { class: 'muted' }, ' canary') : null) },
      { label: 'Trigger', render: (r) => r.trigger.type },
      { label: 'Started', class: 'nowrap', render: (r) => when(r.startedAt ?? r.createdAt) },
      { label: 'Took', class: 'num nowrap', render: (r) => duration(r.durationMs) },
      { label: 'Cost', class: 'num', render: (r) => number(r.cost) },
    ],
  });
}

/** Human-readable trigger chips for a workflow list row. */
export function triggerChips(triggers) {
  return h('span', { class: 'row', style: { gap: '4px' } }, triggers.length ? triggers.map((t) => h('span', { class: 'badge badge-neutral', title: t.nextFireAt ? `next: ${timestamp(t.nextFireAt)}` : t.name }, t.type)) : h('span', { class: 'muted' }, 'manual'));
}
