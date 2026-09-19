import * as api from '../api.js';
import { h } from '../dom.js';
import { can } from '../session.js';
import { badge, button, card, codeBlock, dataTable, formDialog, input, kv, notice, openDialog, pageHeader, statusBadge, toast } from '../ui.js';

const effectTone = { pure: 'good', idempotent: 'warn', effectful: 'bad' };

export default async function capabilities(ctx) {
  const { items } = await api.get('/v1/capabilities');
  const box = h('div');
  const q = input({ type: 'search', placeholder: 'Filter capabilities…', 'aria-label': 'Filter capabilities' });
  const draw = () => {
    const term = q.value.trim().toLowerCase();
    const rows = items.filter((c) => !term || `${c.name} ${c.family} ${c.description}`.toLowerCase().includes(term));
    box.replaceChildren(dataTable({ rows, empty: 'No capability matches.', onRow: (c) => detail(c, ctx), columns: [
      { label: 'Capability', render: (c) => h('div', {}, h('strong', {}, c.name), h('span', { class: 'muted' }, ` @${c.version}`), h('div', { class: 'muted' }, c.description.split('. ')[0])) },
      { label: 'Family', render: (c) => c.family },
      { label: 'Effect', render: (c) => badge(c.effect, effectTone[c.effect] ?? 'neutral') },
      { label: 'Network', render: (c) => (c.egress.mode === 'none' ? 'none' : c.egress.mode === 'static' ? c.egress.hosts.join(', ') : 'per step') },
      { label: 'Scopes', render: (c) => (c.scopes.length ? c.scopes.map((s) => h('code', { class: 'muted' }, `${s} `)) : '—') },
      { label: 'State', render: (c) => (c.killed ? badge('killed', 'bad') : c.circuit !== 'closed' ? badge(`circuit ${c.circuit}`, 'warn') : statusBadge('ok')) },
    ] }));
  };
  q.addEventListener('input', draw);
  draw();
  return h('div', {}, pageHeader('Capabilities', 'The only ways a workflow can touch the outside world. Each declares its contract, effect and reach.', h('a', { class: 'btn', href: '/v1/docs/capabilities', download: 'capabilities.md' }, 'Download catalogue')), h('div', { class: 'toolbar' }, q), card(null, box, { flush: true }));
}

async function detail(c, ctx) {
  const manage = can('capability.manage');
  await openDialog({
    title: `${c.name}@${c.version}`,
    wide: true,
    body: h('div', { class: 'stack' }, c.killed ? notice('bad', h('strong', {}, 'Kill switch on. '), c.killed.reason ?? '', ` (${c.killed.scope})`) : null, h('p', {}, c.description), kv([['Family', c.family], ['Effect', badge(c.effect, effectTone[c.effect] ?? 'neutral')], ['Dry run', c.dryRun], ['Data classification', c.dataClassification], ['Scopes', c.scopes.join(', ') || 'none'], ['Undo with', c.compensation ? h('code', {}, c.compensation) : null], ['Cost', `${c.costModel.unitsPerInvocation} units · ${c.costModel.latencyClass}`], ['Contract hash', h('code', {}, String(c.hash).slice(0, 19))]]), h('div', {}, h('strong', {}, 'Input'), codeBlock(JSON.stringify(c.inputSchema, null, 2))), h('div', {}, h('strong', {}, 'Output'), codeBlock(JSON.stringify(c.outputSchema, null, 2))), c.failureModes.length ? dataTable({ rows: c.failureModes, columns: [{ label: 'Failure', render: (f) => h('code', {}, f.code) }, { label: 'Class', render: (f) => f.class }, { label: 'Retryable', render: (f) => (f.retryable ? 'yes' : 'no') }, { label: 'Meaning', render: (f) => f.description ?? '' }] }) : null),
    actions: (close) => [manage ? (c.killed ? button('Lift kill switch', { kind: 'primary', onClick: async () => { await api.post(`/v1/capabilities/${api.enc(c.name)}/revive`, {}); toast('Capability revived', 'good'); close(true); ctx.navigate('/capabilities'); } }) : button('Kill switch', { kind: 'danger', onClick: async () => { const v = await formDialog({ title: `Kill ${c.name}?`, intro: 'Every step that uses it fails fast until you lift the switch.', fields: [{ name: 'reason', label: 'Reason', required: true }], submitLabel: 'Kill', danger: true }); if (v) { await api.post(`/v1/capabilities/${api.enc(c.name)}/kill`, { reason: v.reason }); toast('Capability killed', 'good'); close(true); ctx.navigate('/capabilities'); } } })) : null, button('Close', { onClick: () => close(true) })],
  });
}
