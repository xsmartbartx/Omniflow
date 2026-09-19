import * as api from '../api.js';
import { clear, h } from '../dom.js';
import { ago } from '../format.js';
import { can } from '../session.js';
import {
  badge,
  button,
  card,
  confirmDialog,
  dataTable,
  emptyState,
  errorBox,
  notice,
  pageHeader,
  spinner,
  statusBadge,
  tabs,
  toast,
} from '../ui.js';

const STARTER = `apiVersion: omniflow.dev/v1
kind: Workflow
metadata:
  name: my-first-workflow
  version: 1.0.0
  owner: you@example.com
  description: Describe what this workflow is for.
  criticality: low
triggers:
  - type: manual
inputs:
  name:
    type: string
    default: world
steps:
  - id: greet
    type: capability
    uses: util-echo@^1
    with:
      value: "Hello, \${{ inputs.name }}!"
outputs:
  greeting: "\${{ steps.greet.output.value }}"
`;

export default async function editor(ctx) {
  const status = await api.get('/v1/authoring/status').catch(() => ({ aiEnabled: false }));
  const editorEl = h('textarea', {
    class: 'input editor',
    spellcheck: 'false',
    autocapitalize: 'off',
    autocomplete: 'off',
    'aria-label': 'Workflow manifest (YAML)',
    wrap: 'off',
  });
  const position = h('span', { class: 'muted' }, 'Ln 1, Col 1');
  const results = h('div');
  const banner = h('div');
  let draftId = ctx.params.draft ?? null;
  let dirty = false;
  let lastValidation = null;

  // ---- load initial content
  if (draftId) {
    const d = await api.get(`/v1/drafts/${api.enc(draftId)}`);
    editorEl.value = d.manifestText;
    if (d.notes?.rationale || d.notes?.openQuestions?.length) clear(banner).append(agentNote(d));
  } else if (ctx.query.from) {
    const name = ctx.query.from;
    const version = ctx.query.version ?? (await api.get(`/v1/workflows/${api.enc(name)}`)).settings.stableVersion;
    const v = await api.get(`/v1/workflows/${api.enc(name)}/versions/${api.enc(version)}`);
    editorEl.value = bump(v.version.manifestText);
    clear(banner).append(
      notice(
        'info',
        `Editing a copy of ${name}@${version}. Its version number has been bumped — published versions are immutable.`,
      ),
    );
  } else editorEl.value = STARTER;

  const updatePos = () => {
    const upto = editorEl.value.slice(0, editorEl.selectionStart);
    const lines = upto.split('\n');
    position.textContent = `Ln ${lines.length}, Col ${lines.at(-1).length + 1}`;
  };
  const goto = (line, col = 1) => {
    const lines = editorEl.value.split('\n');
    const offset = lines.slice(0, Math.max(0, line - 1)).reduce((n, l) => n + l.length + 1, 0) + Math.max(0, col - 1);
    editorEl.focus();
    editorEl.setSelectionRange(offset, offset);
    editorEl.scrollTop = Math.max(0, (line - 4) * 19.5);
    updatePos();
  };

  // ---- validation
  const validate = async () => {
    clear(results).append(spinner('Checking…'));
    try {
      const r = await api.post('/v1/workflows/validate', { manifest: editorEl.value });
      lastValidation = r;
      clear(results).append(renderValidation(r, goto));
    } catch (e) {
      lastValidation = null;
      clear(results).append(errorBox(e));
    }
    return lastValidation;
  };
  let timer;
  editorEl.addEventListener('input', () => {
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(validate, 900);
  });
  for (const ev of ['click', 'keyup']) editorEl.addEventListener(ev, updatePos);
  editorEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Tab' && !ev.shiftKey) {
      ev.preventDefault();
      document.execCommand?.('insertText', false, '  ');
    }
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 's') {
      ev.preventDefault();
      saveDraft();
    }
  });
  ctx.cleanup(() => clearTimeout(timer));
  const warnLeave = (ev) => {
    if (!dirty) return;
    ev.preventDefault();
    ev.returnValue = '';
  };
  window.addEventListener('beforeunload', warnLeave);
  ctx.cleanup(() => window.removeEventListener('beforeunload', warnLeave));

  // ---- actions
  const saveDraft = async () => {
    const d = draftId
      ? await api.put(`/v1/drafts/${api.enc(draftId)}`, { manifest: editorEl.value })
      : await api.post('/v1/drafts', { manifest: editorEl.value });
    draftId = d.id;
    dirty = false;
    history.replaceState(null, '', `#/editor/${api.enc(draftId)}`);
    toast('Draft saved', 'good');
    return d;
  };
  const publish = async () => {
    const v = lastValidation ?? (await validate());
    if (!v?.ok) return toast('Fix the errors first — the manifest does not validate.', 'bad');
    const effect = v.policy?.effect;
    if (
      effect === 'require-approval' &&
      !(await confirmDialog({
        title: 'This will open a change request',
        message: `${v.policy.reason}. A second person must approve before it is published.`,
        confirmLabel: 'Request approval',
      }))
    )
      return;
    const r = await api.post('/v1/workflows', { manifest: editorEl.value });
    dirty = false;
    if (r.status === 'published') {
      toast(`Published ${r.version.name}@${r.version.version}`, 'good');
      location.hash = `#/workflows/${api.enc(r.version.name)}`;
    } else {
      toast('Change request opened for approval', 'good');
      location.hash = '#/changes';
    }
  };

  const toolbar = h(
    'div',
    { class: 'row' },
    button('Check', { icon: 'check', onClick: validate }),
    can('workflow.draft') ? button('Save draft', { onClick: saveDraft }) : null,
    can('workflow.publish') ? button('Publish', { kind: 'primary', onClick: publish }) : null,
    position,
  );

  // ---- side panel
  const ai = () => {
    if (!status.aiEnabled)
      return notice(
        'info',
        h('strong', {}, 'AI drafting is off. '),
        'Set OMNIFLOW_LLM_API_KEY on the server and restart to let the assistant draft workflows from a description. Everything else here works without it.',
      );
    const intent = h('textarea', {
      class: 'input',
      rows: 6,
      placeholder:
        'e.g. Every weekday at 8, fetch yesterday’s orders from the orders API and post a summary to the #ops channel. Retry on errors.',
      'aria-label': 'What should the workflow do?',
    });
    const revise = ctx.query.from
      ? h(
          'label',
          { class: 'check' },
          h('input', { type: 'checkbox', checked: true, id: 'revise' }),
          h('span', {}, `Revise ${ctx.query.from} (the assistant sees its current manifest)`),
        )
      : null;
    const out = h('div');
    return h(
      'div',
      { class: 'stack' },
      h(
        'p',
        { class: 'muted' },
        'The assistant writes a draft, checks it with the same validator you use, and repairs its own mistakes. It can’t publish or run anything: you review and publish.',
      ),
      intent,
      revise,
      button('Draft with AI', {
        kind: 'primary',
        icon: 'authoring',
        busyLabel: 'Drafting…',
        onClick: async () => {
          if (intent.value.trim().length < 3) return toast('Describe what you want first.', 'bad');
          clear(out).append(spinner('The assistant is working — this can take up to a minute…'));
          try {
            const r = await api.post('/v1/authoring/plan', {
              intent: intent.value.trim(),
              ...(revise?.querySelector('input').checked ? { workflow: ctx.query.from } : {}),
            });
            const manifest = r.draft
              ? (await api.get(`/v1/drafts/${api.enc(r.draft.id)}`)).manifestText
              : r.plan.manifest;
            if (!manifest)
              return clear(out).append(notice('warn', 'The assistant did not produce a usable draft. Try rephrasing.'));
            if (
              editorEl.value.trim() !== STARTER.trim() &&
              !(await confirmDialog({
                title: 'Replace the editor content?',
                message: 'The editor already has content. Loading the draft replaces it.',
                confirmLabel: 'Replace',
              }))
            )
              return clear(out);
            editorEl.value = manifest;
            draftId = r.draft?.id ?? null;
            dirty = false;
            if (draftId) history.replaceState(null, '', `#/editor/${api.enc(draftId)}`);
            clear(out).append(
              r.mode === 'proposal-only'
                ? notice(
                    'warn',
                    'This workflow is at autonomy tier T0 (advisory), so the draft was not saved. Copy what you need.',
                  )
                : null,
              notice(
                r.plan.ok ? 'good' : 'warn',
                r.plan.ok
                  ? `Draft ready after ${r.plan.attempts} attempt${r.plan.attempts === 1 ? '' : 's'}.`
                  : 'The draft still has problems the assistant could not fix — see the checks, and edit by hand.',
              ),
              r.plan.rationale ? h('p', {}, r.plan.rationale) : null,
              r.plan.openQuestions?.length
                ? h(
                    'div',
                    {},
                    h('strong', {}, 'Please confirm'),
                    h(
                      'ul',
                      {},
                      r.plan.openQuestions.map((q) => h('li', {}, q)),
                    ),
                  )
                : null,
              r.plan.injectionSignals?.length
                ? notice(
                    'warn',
                    'The material you supplied contained text that looks like instructions to an AI. It was treated as data, but review the draft carefully.',
                  )
                : null,
            );
            await validate();
          } catch (e) {
            clear(out).append(errorBox(e));
          }
        },
      }),
      out,
    );
  };

  const importer = () => {
    const text = h('textarea', {
      class: 'input mono',
      rows: 8,
      placeholder: '# paste a crontab\n0 2 * * * /usr/bin/curl -fsS https://backup.example.com/run',
      spellcheck: 'false',
      'aria-label': 'Crontab',
    });
    const out = h('div');
    return h(
      'div',
      { class: 'stack' },
      h(
        'p',
        { class: 'muted' },
        'Bring existing cron jobs in as drafts. Each job is wrapped as-is in a supervised shell step with a sunset date, so it gains retries, alerts and an audit trail on day one — then you replace it step by step.',
      ),
      text,
      button('Import crontab', {
        kind: 'primary',
        onClick: async () => {
          const r = await api.post('/v1/import/crontab', { text: text.value });
          clear(out).append(
            h(
              'div',
              { class: 'stack' },
              r.drafts.map((d) =>
                card(
                  h(
                    'span',
                    {},
                    d.draft.workflowName ?? 'draft',
                    ' ',
                    d.draft.validation?.ok ? badge('valid', 'good') : badge('needs work', 'warn'),
                  ),
                  h(
                    'div',
                    { class: 'stack' },
                    h(
                      'ul',
                      {},
                      d.notes.map((n) => h('li', {}, n)),
                    ),
                    d.script
                      ? h(
                          'div',
                          {},
                          h('strong', {}, `Script to install at ${d.script.path}`),
                          h('pre', { class: 'code' }, d.script.content),
                        )
                      : null,
                  ),
                  {
                    actions: button('Open', {
                      small: true,
                      onClick: () => (location.hash = `#/editor/${api.enc(d.draft.id)}`),
                    }),
                  },
                ),
              ),
              r.skipped.map((k) => notice('warn', `Line ${k.line} skipped: ${k.reason}`)),
              r.drafts.length === 0 && r.skipped.length === 0 ? emptyState('Nothing to import') : null,
            ),
          );
        },
      }),
      out,
    );
  };

  const drafts = async () => {
    const { items } = await api.get('/v1/drafts');
    return dataTable({
      rows: items,
      empty: 'No drafts yet. Use “Save draft” to keep work in progress.',
      onRow: (d) => (location.hash = `#/editor/${api.enc(d.id)}`),
      columns: [
        { label: 'Draft', render: (d) => d.workflowName ?? '(unnamed)' },
        {
          label: 'From',
          render: (d) =>
            d.origin === 'agent' ? badge('AI', 'accent') : d.origin === 'import' ? badge('import', 'neutral') : 'you',
        },
        { label: 'Status', render: (d) => statusBadge(d.status) },
        { label: 'Valid', render: (d) => (d.validation?.ok ? badge('yes', 'good') : badge('no', 'warn')) },
        { label: 'Updated', render: (d) => ago(d.updatedAt) },
        {
          label: '',
          render: (d) =>
            d.status !== 'published'
              ? button('', {
                  small: true,
                  kind: 'ghost',
                  icon: 'x',
                  title: 'Delete draft',
                  onClick: async () => {
                    await api.del(`/v1/drafts/${api.enc(d.id)}`);
                    toast('Draft deleted', 'good');
                    ctx.navigate(draftId ? `/editor/${api.enc(draftId)}` : '/editor', { tab: 'drafts' });
                  },
                })
              : '',
        },
      ],
    });
  };

  const side = tabs(
    [
      { id: 'checks', label: 'Checks', render: () => results },
      ...(can('agent.invoke') ? [{ id: 'ai', label: 'AI assistant', render: ai }] : []),
      ...(can('workflow.draft')
        ? [
            { id: 'import', label: 'Import cron', render: importer },
            { id: 'drafts', label: 'Drafts', render: drafts },
          ]
        : []),
    ],
    ctx.query.tab ?? 'checks',
  );

  validate();
  return h(
    'div',
    {},
    pageHeader('Editor', 'Write a workflow manifest, see problems as you type, and publish when it is right.', toolbar),
    banner,
    h('div', { class: 'editor-grid' }, card(null, editorEl, { flush: true }), side),
  );
}

/** Bump the patch version so a copy of a published manifest can be published. */
export function bump(text) {
  return text.replace(
    /^(\s*version:\s*)["']?(\d+)\.(\d+)\.(\d+)["']?/m,
    (_m, pre, a, b, c) => `${pre}${a}.${b}.${Number(c) + 1}`,
  );
}

function agentNote(d) {
  return notice(
    'info',
    h('strong', {}, 'AI-drafted. '),
    d.notes.rationale ?? '',
    d.notes.openQuestions?.length
      ? h(
          'ul',
          {},
          d.notes.openQuestions.map((q) => h('li', {}, q)),
        )
      : null,
  );
}

function renderValidation(r, goto) {
  const issue = (i, kind) =>
    h(
      'div',
      { class: ['issue', i.line ? 'clickable' : ''], onClick: i.line ? () => goto(i.line, i.column) : undefined },
      badge(kind, kind === 'error' ? 'bad' : 'warn'),
      h(
        'div',
        {},
        h('div', {}, i.message),
        h('div', { class: 'where' }, `${i.code}${i.path ? ` · ${i.path}` : ''}${i.line ? ` · line ${i.line}` : ''}`),
      ),
    );
  const parts = [];
  parts.push(
    r.ok
      ? notice(
          'good',
          h('strong', {}, `${r.workflow.name} ${r.workflow.version} is valid. `),
          `${r.steps} step${r.steps === 1 ? '' : 's'}.`,
        )
      : notice(
          'bad',
          h(
            'strong',
            {},
            r.errors.length
              ? `${r.errors.length} problem${r.errors.length === 1 ? '' : 's'} to fix`
              : 'Blocked by the risk review',
          ),
        ),
  );
  for (const e of r.errors) parts.push(issue(e, 'error'));
  for (const w of r.warnings) parts.push(issue(w, 'warning'));
  if (r.policy)
    parts.push(
      r.policy.effect === 'allow'
        ? notice('good', 'Policy: can be published directly.')
        : r.policy.effect === 'require-approval'
          ? notice('warn', h('strong', {}, 'Needs approval. '), r.policy.reason)
          : notice('bad', h('strong', {}, 'Policy would refuse this. '), r.policy.reason),
    );
  if (r.risk) {
    parts.push(
      h(
        'div',
        {},
        h('strong', {}, 'Risk review '),
        statusBadge(r.risk.level),
        h('span', { class: 'muted' }, ` score ${r.risk.score}/100`),
      ),
    );
    for (const f of r.risk.findings)
      parts.push(
        h(
          'div',
          { class: 'issue' },
          statusBadge(f.severity),
          h(
            'div',
            {},
            h('div', {}, f.message, f.blocking ? badge('blocking', 'bad') : null),
            h('div', { class: 'where' }, `${f.ruleId}${f.stepId ? ` · step ${f.stepId}` : ''}`),
          ),
        ),
      );
  }
  return h('div', { class: 'stack' }, parts);
}
