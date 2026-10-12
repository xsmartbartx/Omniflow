import * as api from '../api.js';
import { h } from '../dom.js';
import { ago, number, plural, shortHash, timestamp } from '../format.js';
import { renderGraph } from '../graph.js';
import { renderMarkdown } from '../markdown.js';
import { can, isAdmin } from '../session.js';
import {
  badge,
  button,
  card,
  codeBlock,
  confirmDialog,
  dataTable,
  emptyState,
  errorBox,
  formDialog,
  kv,
  notice,
  openDialog,
  pageHeader,
  select,
  statusBadge,
  tabs,
  toast,
} from '../ui.js';
import { runsTable } from './common.js';

const isRunnable = (s) => !s.killed && s.enabled;

function killedNotice(s) {
  return s.killed
    ? notice('bad', h('strong', {}, 'Killed. '), s.killReason ?? 'This workflow refuses new runs.')
    : null;
}

function pendingNotice(count) {
  return count
    ? notice(
        'warn',
        h('strong', {}, `${count} change ${plural(count, 'request')} waiting. `),
        h('a', { href: '#/changes' }, 'Review'),
      )
    : null;
}

export default async function workflow(ctx) {
  const name = ctx.params.name;
  const base = `/v1/workflows/${api.enc(name)}`;
  const detail = await api.get(base);
  const stable = detail.settings.stableVersion;
  const s = detail.settings;
  const reload = () => ctx.navigate(`/workflows/${api.enc(name)}`);
  const manage = can('workflow.manage');

  const control = (label, opts, fn) =>
    button(label, {
      small: true,
      ...opts,
      onClick: async () => {
        await fn();
        toast(`${label} done`, 'good');
        reload();
      },
    });
  const killWorkflow = async () => {
    const v = await formDialog({
      title: `Kill ${name}?`,
      intro: 'New runs are refused and queued runs are cancelled until you lift the switch.',
      fields: [
        { name: 'reason', label: 'Reason', required: true, placeholder: 'e.g. duplicate charges — investigating' },
      ],
      submitLabel: 'Kill',
      danger: true,
    });
    if (!v) return;
    await api.post(`${base}/kill`, { reason: v.reason });
    toast('Workflow killed', 'good');
    reload();
  };
  const stateBadge = statusBadge(stateName(s));
  const toggle = s.enabled ? 'disable' : 'enable';

  const actions = [
    can('workflow.run') && stable && isRunnable(s)
      ? button('Run', { kind: 'primary', icon: 'play', onClick: () => runDialog(name, detail) })
      : null,
    can('workflow.draft')
      ? button('New version', { icon: 'edit', onClick: () => (location.hash = `#/editor?from=${api.enc(name)}`) })
      : null,
    manage && !s.killed ? control(s.enabled ? 'Disable' : 'Enable', {}, () => api.post(`${base}/${toggle}`)) : null,
    manage && !s.killed ? button('Kill switch', { kind: 'danger', small: true, onClick: killWorkflow }) : null,
    manage && s.killed ? control('Lift kill switch', { kind: 'primary' }, () => api.post(`${base}/revive`)) : null,
  ];

  const header = pageHeader(
    h('span', {}, name, ' ', stateBadge),
    detail.plan?.workflow.description ?? 'No description',
    actions,
  );
  const killed = killedNotice(s);
  const pending = pendingNotice(detail.pendingChanges.length);

  const overview = async () => {
    const [explain, graph] = await Promise.all([
      stable ? api.get(`${base}/explain`).catch(() => null) : null,
      stable ? api.get(`${base}/graph`).catch(() => null) : null,
    ]);
    if (!graph) return emptyState('No active version', 'Publish a version and activate it to see its graph.');
    const p = detail.plan;
    return h(
      'div',
      { class: 'stack' },
      explain ? card('In plain language', h('p', {}, explain.summary), {}) : null,
      card('Flow', h('div', { class: 'dag-wrap' }, renderGraph(graph))),
      h(
        'div',
        { class: 'grid grid-2' },
        card(
          'Details',
          kv([
            ['Owner', p.workflow.owner],
            ['Team', p.workflow.team],
            ['Criticality', p.workflow.criticality],
            ['Active version', stable],
            ['Autonomy tier', s.autonomyTier],
            ['Plan', h('code', { title: p.planHash }, shortHash(p.planHash))],
            ['Steps', p.analysis.stepCount],
            ['Worst-case cost', number(p.analysis.maxCost)],
            ['Data sensitivity', p.analysis.maxSensitivity],
            ['Can reach', p.analysis.egress.length ? p.analysis.egress.join(', ') : 'nothing outside Constans'],
          ]),
        ),
        card(
          'Safeguards & findings',
          h(
            'div',
            { class: 'stack' },
            explain?.safeguards.length
              ? h(
                  'ul',
                  {},
                  explain.safeguards.map((x) => h('li', {}, x)),
                )
              : h('p', { class: 'muted' }, 'No explicit safeguards declared.'),
            detail.findings.length
              ? dataTable({
                  rows: detail.findings,
                  columns: [
                    { label: 'Severity', render: (f) => statusBadge(f.severity) },
                    { label: 'Finding', render: (f) => f.message },
                  ],
                })
              : h('p', { class: 'muted' }, 'The risk review found nothing to report.'),
          ),
        ),
      ),
    );
  };

  const versions = async () =>
    card(
      null,
      dataTable({
        rows: detail.versions,
        columns: [
          {
            label: 'Version',
            render: (v) =>
              h(
                'span',
                {},
                h('strong', {}, v.version),
                v.version === stable ? badge('active', 'good') : null,
                v.version === s.canaryVersion ? badge(`canary ${s.canaryPercent}%`, 'accent') : null,
              ),
          },
          { label: 'Status', render: (v) => statusBadge(v.status) },
          {
            label: 'Published',
            render: (v) => h('span', { title: timestamp(v.publishedAt) }, `${ago(v.publishedAt)} by ${v.publishedBy}`),
          },
          { label: 'Plan', render: (v) => h('code', { title: v.planHash }, shortHash(v.planHash, 10)) },
          {
            label: '',
            class: 'nowrap',
            render: (v) =>
              h(
                'span',
                { class: 'row', style: { gap: '4px' } },
                button('Manifest', { small: true, onClick: () => showManifest(name, v.version) }),
                manage && v.status === 'published' && v.version !== stable
                  ? button('Activate', {
                      small: true,
                      kind: 'primary',
                      onClick: async () => {
                        if (
                          !(await confirmDialog({
                            title: `Activate ${v.version}?`,
                            message: `New runs will use ${name}@${v.version}. Roll back by activating the previous version.`,
                            confirmLabel: 'Activate',
                          }))
                        )
                          return;
                        await api.post(`${base}/activate`, { version: v.version });
                        toast('Version activated', 'good');
                        reload();
                      },
                    })
                  : null,
                manage && v.status === 'published' && v.version !== stable
                  ? button('Canary', {
                      small: true,
                      onClick: async () => {
                        const r = await formDialog({
                          title: `Canary ${v.version}`,
                          intro: 'Send a share of runs to this version, and watch before promoting it.',
                          fields: [
                            {
                              name: 'percent',
                              label: 'Percent of runs (0 clears)',
                              type: 'number',
                              value: '10',
                              required: true,
                            },
                          ],
                        });
                        if (r) {
                          await api.post(`${base}/canary`, { version: v.version, percent: Number(r.percent) });
                          toast('Canary set', 'good');
                          reload();
                        }
                      },
                    })
                  : null,
              ),
          },
        ],
      }),
      { flush: true },
    );

  const runs = async () =>
    card(null, runsTable(detail.recentRuns, { showWorkflow: false, empty: 'This workflow has not run yet.' }), {
      flush: true,
      actions: h('a', { href: `#/runs?workflow=${api.enc(name)}` }, 'All runs'),
    });

  const triggers = async () =>
    card(
      null,
      dataTable({
        rows: detail.triggers,
        empty: 'Manual only — no automatic triggers.',
        columns: [
          { label: 'Name', render: (t) => t.name },
          { label: 'Type', render: (t) => badge(t.type, 'neutral') },
          {
            label: 'Detail',
            render: (t) => h('code', {}, t.config?.cron ?? t.config?.event ?? t.config?.workflow ?? ''),
          },
          { label: 'Next fire', render: (t) => (t.nextFireAt ? timestamp(t.nextFireAt) : '—') },
          { label: 'Enabled', render: (t) => (t.enabled ? 'yes' : 'no') },
        ],
      }),
      { flush: true },
    );

  const docs = async () => {
    const d = await api.get(`${base}/docs`);
    return h(
      'div',
      { class: 'stack' },
      renderMarkdown(d.markdown, {
        onCode: (lang, text) =>
          lang === 'mermaid' ? codeBlock(text, { label: 'Mermaid source (paste into any Mermaid viewer)' }) : null,
      }),
      h(
        'div',
        { class: 'row' },
        h('a', { class: 'btn', href: `${base}/docs?format=markdown`, download: `${name}.md` }, 'Download Markdown'),
      ),
    );
  };

  const adminBits =
    isAdmin() && stable
      ? h(
          'div',
          { class: 'row' },
          h('span', { class: 'muted' }, 'Autonomy tier for AI-authored changes:'),
          select(['T0', 'T1', 'T2', 'T3'], s.autonomyTier, {
            onChange: async (ev) => {
              await api.post(`${base}/autonomy`, { tier: ev.target.value });
              toast('Autonomy tier updated', 'good');
            },
          }),
          h('span', { class: 'muted' }, 'T0 advise · T1 draft · T2 request · T3 publish inside the blast radius'),
        )
      : null;

  return h(
    'div',
    {},
    header,
    h(
      'div',
      { class: 'stack' },
      killed,
      pending,
      tabs(
        [
          { id: 'overview', label: 'Overview', render: overview },
          { id: 'versions', label: 'Versions', count: detail.versions.length, render: versions },
          { id: 'runs', label: 'Runs', render: runs },
          { id: 'triggers', label: 'Triggers', count: detail.triggers.length, render: triggers },
          { id: 'docs', label: 'Docs', render: docs },
        ],
        ctx.query.tab,
      ),
      adminBits,
    ),
  );
}

async function showManifest(name, version) {
  const v = await api.get(`/v1/workflows/${api.enc(name)}/versions/${api.enc(version)}`);
  await openDialog({
    title: `${name}@${version}`,
    wide: true,
    body: h(
      'div',
      { class: 'stack' },
      codeBlock(v.version.manifestText),
      v.findings.length
        ? dataTable({
            rows: v.findings,
            columns: [
              { label: 'Severity', render: (f) => statusBadge(f.severity) },
              { label: 'Finding', render: (f) => f.message },
            ],
          })
        : null,
    ),
    actions: (close) => [
      button('Edit as new version', {
        onClick: () => {
          close(true);
          location.hash = `#/editor?from=${api.enc(name)}&version=${api.enc(version)}`;
        },
      }),
      button('Close', { kind: 'primary', onClick: () => close(true) }),
    ],
  });
}

/** A run form generated from the workflow's declared inputs. */
const stateName = (s) => {
  if (s.killed) return 'killed';
  return s.enabled ? 'enabled' : 'disabled';
};

/** The form-dialog field shape for one workflow input. */
function fieldShape(spec) {
  const fallback = spec.default !== undefined ? String(spec.default) : undefined;
  if (spec.enum) return { options: spec.enum.map(String), value: fallback };
  if (spec.type === 'boolean') return { type: 'checkbox', value: spec.default === true };
  if (spec.type === 'object' || spec.type === 'array')
    return { textarea: true, rows: 3, placeholder: spec.type === 'array' ? '[ … ]' : '{ … }' };
  let type = 'text';
  if (spec.sensitivity === 'secret') type = 'password';
  else if (spec.type === 'integer' || spec.type === 'number') type = 'number';
  return { type, value: fallback ?? '' };
}

/** The typed value for a form entry (checkboxes arrive as booleans, everything else as text). */
function inputValue(spec, raw) {
  switch (spec.type) {
    case 'integer':
      return Number.parseInt(raw, 10);
    case 'number':
      return Number(raw);
    case 'boolean':
      return raw === true;
    case 'object':
    case 'array':
      return JSON.parse(raw);
    default:
      return raw;
  }
}

async function runDialog(name, detail) {
  const inputs = detail.plan?.inputs ?? {};
  const fields = Object.entries(inputs).map(([k, spec]) => ({
    name: k,
    label: `${k}${spec.required ? ' *' : ''}`,
    help: [
      spec.description,
      spec.type !== 'string' ? spec.type : null,
      spec.default !== undefined ? `default ${JSON.stringify(spec.default)}` : null,
      spec.sensitivity && spec.sensitivity !== 'public' ? spec.sensitivity : null,
    ]
      .filter(Boolean)
      .join(' · '),
    ...fieldShape(spec),
  }));
  const v = await formDialog({
    title: `Run ${name}`,
    intro: fields.length ? undefined : 'This workflow takes no inputs.',
    fields: [
      ...fields,
      { name: '__dry', type: 'checkbox', label: 'Dry run', help: 'Simulate effects instead of performing them.' },
    ],
    submitLabel: 'Start run',
    wide: true,
  });
  if (!v) return;
  const body = {};
  try {
    for (const [k, spec] of Object.entries(inputs)) {
      const raw = v[k];
      if (raw === '' || raw === undefined) continue;
      body[k] = inputValue(spec, raw);
    }
  } catch (e) {
    return toast(`Invalid input: ${e.message}`, 'bad');
  }
  try {
    const r = await api.post(`/v1/workflows/${api.enc(name)}/run`, {
      inputs: body,
      ...(v.__dry ? { dryRun: true } : {}),
    });
    if (r.status === 'skipped') return toast(`Skipped: ${r.reason}`, 'warn');
    toast(r.status === 'deduplicated' ? 'Already running (duplicate)' : 'Run started', 'good');
    location.hash = `#/runs/${api.enc(r.run.id)}`;
  } catch (e) {
    await openDialog({
      title: 'Could not start the run',
      body: errorBox(e),
      actions: (close) => [button('Close', { kind: 'primary', onClick: () => close(true) })],
    });
  }
}
