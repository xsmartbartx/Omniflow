import * as api from '../api.js';
import { runsChart } from '../charts.js';
import { clear, h } from '../dom.js';
import { duration, number, percent } from '../format.js';
import { badge, button, card, dataTable, notice, pageHeader } from '../ui.js';
import { wfLink } from './common.js';

export default async function dashboard(ctx) {
  const body = h('div', { class: 'stack' });
  const hours = h('select', { class: 'input', 'aria-label': 'Time window', onChange: () => load() }, [[6, 'Last 6 hours'], [24, 'Last 24 hours'], [72, 'Last 3 days'], [168, 'Last 7 days']].map(([v, l]) => h('option', { value: v, selected: v === 24 }, l)));

  async function load() {
    const [o, alerts, approvals] = await Promise.all([api.get(`/v1/insights/overview?hours=${hours.value}`), api.get('/v1/insights/alerts'), api.get('/v1/approvals?status=pending&limit=200')]);
    const mine = approvals.items.filter((a) => a.canDecide).length;
    const kpi = (label, value, hint, kind) => h('div', { class: ['card', 'kpi', kind] }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), h('div', { class: 'hint' }, hint ?? ' '));
    const rate = o.runs.successRate;
    clear(body).append(
      alerts.active.length ? h('div', { class: 'banner-list' }, alerts.active.slice(0, 4).map((a) => notice(a.severity === 'critical' ? 'bad' : 'warn', h('strong', {}, a.title), h('p', {}, a.message), h('a', { href: '#/insights' }, 'Details')))) : null,
      h('div', { class: 'grid grid-kpi' },
        kpi('Success rate', percent(rate, 1), `${o.runs.succeeded} of ${o.runs.succeeded + o.runs.failed} finished`, rate === null ? '' : rate >= 0.95 ? 'good' : rate >= 0.8 ? 'warn' : 'bad'),
        kpi('Runs', number(o.runs.total), `${o.runs.failed} failed · ${o.runs.cancelled} cancelled`),
        kpi('In flight', number(o.runs.active), `${o.runs.queued} queued`),
        kpi('Waiting for you', String(mine), mine ? 'approvals need a decision' : 'nothing pending', mine ? 'warn' : ''),
        kpi('Latency (p95)', duration(o.latencyMs.p95), `median ${duration(o.latencyMs.p50)}`),
        kpi('Manual work', percent(o.manualInterventionRate), 'runs that needed a person'),
      ),
      h('div', { class: 'grid grid-2' },
        card('Runs per hour', h('div', {}, runsChart(o.hourly), h('div', { class: 'legend' }, h('span', {}, h('i', { class: 'bar-ok', style: { background: 'var(--good)' } }), 'Succeeded'), h('span', {}, h('i', { style: { background: 'var(--bad)' } }), 'Failed'), h('span', {}, h('i', { style: { background: 'var(--muted)' } }), 'Other')))),
        card('Needs attention', o.failingSteps.length ? dataTable({ rows: o.failingSteps, columns: [{ label: 'Step', render: (f) => h('span', {}, wfLink(f.workflow), h('span', { class: 'muted' }, ` › ${f.stepId}`)) }, { label: 'Failed', class: 'num', render: (f) => `${f.failed}/${f.executions}` }, { label: 'Most often', render: (f) => (f.topError ? h('code', {}, f.topError) : '—') }] }) : h('p', { class: 'muted' }, 'No failing steps in this window. '), { flush: o.failingSteps.length > 0 }),
      ),
      card('Workflows', dataTable({ empty: 'No runs in this window.', rows: o.workflows, onRow: (w) => (location.hash = `#/workflows/${api.enc(w.name)}`), columns: [{ label: 'Workflow', render: (w) => wfLink(w.name) }, { label: 'Runs', class: 'num', render: (w) => number(w.runs) }, { label: 'Failed', class: 'num', render: (w) => (w.failed ? badge(String(w.failed), 'bad') : '0') }, { label: 'Success', class: 'num', render: (w) => percent(w.successRate) }, { label: 'p95', class: 'num', render: (w) => duration(w.p95Ms) }, { label: 'Cost', class: 'num', render: (w) => number(w.cost) }] }), { flush: true }),
    );
  }

  await load();
  ctx.poll(load, 15000);
  return h('div', {}, pageHeader('Dashboard', 'How your automation is doing right now.', [hours, button('', { icon: 'refresh', title: 'Refresh', onClick: load })]), body);
}
