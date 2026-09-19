import * as api from '../api.js';
import { clear, h } from '../dom.js';
import { duration, number, shortHash, TERMINAL_RUN, timestamp, tone, truncate } from '../format.js';
import { renderGraph } from '../graph.js';
import { can } from '../session.js';
import { badge, button, card, codeBlock, dataTable, errorBox, formDialog, kv, notice, openDialog, pageHeader, spinner, statusBadge, toast } from '../ui.js';
import { runLink, wfLink } from './common.js';

const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour12: false }) + iso.slice(19, 23);

export default async function run(ctx) {
  const id = ctx.params.id;
  const base = `/v1/runs/${api.enc(id)}`;
  let data = await api.get(base);
  let graph = null;
  try {
    graph = await api.get(`/v1/workflows/${api.enc(data.run.workflow)}/graph?version=${api.enc(data.run.version)}`);
  } catch {
    /* the graph is a nicety */
  }

  const head = h('div');
  const summary = h('div');
  const explainBox = h('div');
  const graphBox = h('div');
  const stepsBox = h('div');
  const approvalsBox = h('div');
  const childrenBox = h('div');
  const log = h('div', { class: 'eventlog', role: 'log', 'aria-live': 'off' });
  const seen = new Set();
  const liveNote = h('span', { class: 'muted' });

  const addEvent = (e) => {
    if (seen.has(e.seq)) return;
    seen.add(e.seq);
    const bad = /failed|error|denied|compensation-failed|circuit-opened/.test(e.type);
    const good = /succeeded|approved/.test(e.type);
    const d = e.data ?? {};
    const detail = [d.attempt !== undefined ? `attempt ${d.attempt}` : null, d.error?.message ?? d.message ?? d.reason ?? null, d.errorCode ?? d.error?.code ?? null, d.decision ?? null, d.durationMs !== undefined ? duration(d.durationMs) : null].filter(Boolean).join(' · ');
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
    log.append(h('div', { class: ['ev', bad ? 'bad' : good ? 'good' : ''] }, h('span', { class: 't' }, clock(e.ts)), h('span', { class: 'ty' }, e.type), h('span', {}, [e.stepId ? h('strong', {}, `${e.stepId} `) : '', truncate(detail, 160)])));
    if (atBottom) log.scrollTop = log.scrollHeight;
  };

  const draw = async () => {
    const r = data.run;
    const terminal = TERMINAL_RUN.has(r.status);
    const rerun = can('run.retry') && terminal ? button('Run again', { icon: 'refresh', onClick: async () => { const x = await api.post(`${base}/retry`); if (x.run) location.hash = `#/runs/${api.enc(x.run.id)}`; else toast(`Skipped: ${x.reason}`, 'warn'); } }) : null;
    const cancel = can('run.cancel') && !terminal ? button('Cancel run', { kind: 'danger', icon: 'stop', onClick: async () => { const v = await formDialog({ title: 'Cancel this run?', intro: 'Steps in flight are stopped and any completed effects are compensated where possible.', fields: [{ name: 'reason', label: 'Reason (optional)' }], submitLabel: 'Cancel run', danger: true }); if (v) { await api.post(`${base}/cancel`, v.reason ? { reason: v.reason } : {}); toast('Cancellation requested', 'good'); await refresh(); } } }) : null;
    clear(head).append(pageHeader(h('span', {}, 'Run ', h('code', {}, r.id.replace(/^run_/, '')), ' ', statusBadge(r.status), r.dryRun ? badge('dry run', 'neutral') : null, r.canary ? badge('canary', 'accent') : null), h('span', {}, wfLink(r.workflow, r.version), ` · started ${timestamp(r.startedAt ?? r.createdAt)}`), [rerun, cancel]));

    clear(summary).append(card('Summary', kv([['Workflow', wfLink(r.workflow, r.version)], ['Status', statusBadge(r.status)], ['Trigger', `${r.trigger.type}${r.trigger.name ? ` · ${r.trigger.name}` : ''}`], ['Requested by', r.requestedBy.name], ['Took', duration(r.durationMs)], ['Cost', number(r.cost)], ['Plan', h('code', { title: r.planHash }, shortHash(r.planHash))], r.parentRunId ? ['Parent run', runLink(r.parentRunId)] : null, r.correlationId ? ['Correlation', h('code', {}, r.correlationId)] : null, ['Inputs', Object.keys(r.inputs).length ? codeBlock(JSON.stringify(r.inputs, null, 2), { copy: false }) : h('span', { class: 'muted' }, 'none')], r.outputs && Object.keys(r.outputs).length ? ['Outputs', codeBlock(JSON.stringify(r.outputs, null, 2))] : null])));

    if (graph) clear(graphBox).append(card('Progress', h('div', { class: 'dag-wrap' }, renderGraph(graph, { states: Object.fromEntries(data.steps.map((s) => [s.id, s.status])), onSelect: (sid) => stepDialog(data.steps.find((s) => s.id === sid), base) }))));

    clear(stepsBox).append(card('Steps', dataTable({
      rows: data.steps,
      empty: 'No steps recorded.',
      onRow: (s) => stepDialog(s, base),
      columns: [
        { label: '', render: (s) => h('span', { class: ['dot', tone(s.status) === 'good' ? 'good' : tone(s.status) === 'bad' ? 'bad' : tone(s.status) === 'warn' ? 'warn' : '', s.status === 'running' ? 'pulse' : ''] }) },
        { label: 'Step', render: (s) => h('div', {}, h('strong', {}, s.name ?? s.id), s.name ? h('span', { class: 'muted' }, ` ${s.id}`) : null) },
        { label: 'Uses', render: (s) => (s.capability ? h('code', {}, s.capability) : s.type) },
        { label: 'Status', render: (s) => h('span', {}, statusBadge(s.status), s.handled ? badge(`handled: ${s.handled}`, 'neutral') : null, s.compensation?.status ? badge(`undo: ${s.compensation.status}`, s.compensation.status === 'failed' ? 'bad' : 'neutral') : null) },
        { label: 'Try', class: 'num', render: (s) => (s.attempt > 1 ? `${s.attempt}/${s.maxAttempts}` : '') },
        { label: 'Took', class: 'num nowrap', render: (s) => duration(s.durationMs) },
        { label: 'Note', render: (s) => (s.error ? h('span', { class: 'muted', title: s.error.message }, truncate(`${s.error.code}: ${s.error.message}`, 70)) : s.skippedReason ? h('span', { class: 'muted' }, s.skippedReason) : '') },
      ],
    }), { flush: true }));

    const pend = data.approvals.filter((a) => a.status === 'pending');
    clear(approvalsBox).append(data.approvals.length ? card('Approvals', dataTable({ rows: data.approvals, columns: [{ label: 'Step', render: (a) => a.stepId }, { label: 'Request', render: (a) => a.message }, { label: 'Status', render: (a) => statusBadge(a.status) }, { label: 'Decided by', render: (a) => a.decidedBy ?? '—' }, { label: '', render: (a) => (a.status === 'pending' && can('approval.decide') ? h('span', { class: 'row', style: { gap: '4px' } }, button('Approve', { small: true, kind: 'primary', onClick: () => decide(a, 'approved', refresh) }), button('Deny', { small: true, kind: 'danger', onClick: () => decide(a, 'denied', refresh) })) : '') }] }), { flush: true }) : null);
    if (pend.length && !can('approval.decide')) approvalsBox.append(notice('warn', 'This run is waiting for an approver.'));

    clear(childrenBox).append(data.children.length ? card('Child runs', dataTable({ rows: data.children, columns: [{ label: 'Run', render: (c) => runLink(c.id) }, { label: 'Workflow', render: (c) => wfLink(c.workflow) }, { label: 'Status', render: (c) => statusBadge(c.status) }] }), { flush: true }) : null);

    try {
      const ex = await api.get(`${base}/explain`);
      clear(explainBox).append(card('What happened', h('div', { class: 'stack' }, h('strong', {}, ex.headline), ex.failure ? notice('bad', h('p', {}, h('strong', {}, 'Why: '), ex.failure.cause), h('p', {}, h('strong', {}, 'Afterwards: '), ex.failure.whatHappenedNext), h('p', {}, h('strong', {}, 'What to do: '), ex.failure.suggestion)) : null, h('ul', {}, ex.narrative.map((n) => h('li', {}, n))))));
    } catch {
      clear(explainBox);
    }
  };

  let refreshing = false;
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      data = await api.get(base);
      await draw();
    } finally {
      refreshing = false;
    }
  };

  await draw();

  // ---- live events: replay history, then follow until the run finishes
  const ac = new AbortController();
  ctx.cleanup(() => ac.abort());
  const events = await api.get(`${base}/events?limit=500`).catch(() => ({ items: [] }));
  for (const e of events.items) addEvent(e);
  log.scrollTop = log.scrollHeight;
  if (!TERMINAL_RUN.has(data.run.status)) {
    clear(liveNote).append(badge('live', 'good'));
    let timer;
    api.stream(`${base}/stream`, (e) => {
      addEvent(e);
      clearTimeout(timer);
      timer = setTimeout(refresh, 400);
    }, ac.signal).then(() => refresh(), () => {});
    ctx.poll(async () => { if (!TERMINAL_RUN.has(data.run.status)) await refresh(); else clear(liveNote); }, 4000);
  }

  return h('div', { class: 'stack' }, head, explainBox, graphBox, stepsBox, approvalsBox, childrenBox, card('Event log', log, { actions: liveNote }), summary);
}

export async function decide(approval, decision, after) {
  const v = await formDialog({ title: `${decision === 'approved' ? 'Approve' : 'Deny'} “${approval.stepId}”`, intro: approval.message, fields: [{ name: 'comment', label: 'Comment (optional)' }], submitLabel: decision === 'approved' ? 'Approve' : 'Deny', danger: decision === 'denied' });
  if (!v) return;
  await api.post(`/v1/approvals/${api.enc(approval.id)}/decide`, { decision, ...(v.comment ? { comment: v.comment } : {}) });
  toast(decision === 'approved' ? 'Approved' : 'Denied', 'good');
  await after?.();
}

async function stepDialog(step, base) {
  if (!step) return;
  const out = h('div');
  const load = button('Load full output', { small: true, onClick: async () => {
    clear(out).append(spinner());
    try {
      const r = await api.get(`${base}/steps/${api.enc(step.id)}/output`);
      clear(out).append(codeBlock(JSON.stringify(r.output, null, 2)));
    } catch (e) {
      clear(out).append(errorBox(e));
    }
  } });
  const preview = step.output?.redacted ? notice('warn', `Output withheld: this step handles ${step.output.sensitivity} data.`) : step.output !== null && step.output !== undefined ? codeBlock(JSON.stringify(step.output, null, 2)) : h('span', { class: 'muted' }, 'No output recorded.');
  await openDialog({
    title: `Step ${step.id}`,
    wide: true,
    body: h('div', { class: 'stack' }, kv([['Kind', step.type], ['Uses', step.capability ? h('code', {}, step.capability) : null], ['Effect', step.effect], ['Status', statusBadge(step.status)], ['Attempts', `${step.attempt} of ${step.maxAttempts}`], ['Started', timestamp(step.startedAt)], ['Took', duration(step.durationMs)], ['Cost', number(step.cost)], step.skippedReason ? ['Skipped because', step.skippedReason] : null, step.childRunId ? ['Child run', runLink(step.childRunId)] : null]), step.error ? notice('bad', h('strong', {}, `${step.error.code} (${step.error.class})`), h('p', {}, step.error.message)) : null, step.compensation ? notice(step.compensation.status === 'failed' ? 'bad' : 'info', `Undo with ${step.compensation.capability}: ${step.compensation.status ?? 'not needed'}`) : null, h('div', {}, h('strong', {}, 'Output'), preview, step.outputRef ? h('div', { class: 'row' }, load) : null, out)),
    actions: (close) => [button('Close', { kind: 'primary', onClick: () => close(true) })],
  });
}
