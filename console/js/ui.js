import { ApiError, issuesOf } from './api.js';
import { clear, h, svg } from './dom.js';
import { tone } from './format.js';

// ------------------------------------------------------------------ icons
const ICONS = {
  dashboard: 'M3 3h7v9H3z M14 3h7v5h-7z M14 12h7v9h-7z M3 16h7v5H3z',
  workflow: 'M4 4h6v6H4z M14 14h6v6h-6z M10 7h4a2 2 0 0 1 2 2v5',
  runs: 'M3 12h4l3-8 4 16 3-8h4',
  approvals: 'M9 12l2 2 4-4 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  changes: 'M6 3v12 M18 9v12 M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  capability: 'M21 8l-9-5-9 5v8l9 5 9-5z M3 8l9 5 9-5 M12 13v8',
  secret: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4',
  trigger: 'M13 2L4 14h7l-1 8 9-12h-7z',
  insight: 'M4 20V10 M10 20V4 M16 20v-7 M22 20H2',
  audit: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  admin:
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M22 21v-2a4 4 0 0 0-3-3.9 M16 3.1a4 4 0 0 1 0 7.8',
  authoring:
    'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z M19 16l.9 2.1L22 19l-2.1.9L19 22l-.9-2.1L16 19l2.1-.9z',
  plus: 'M12 5v14 M5 12h14',
  refresh: 'M21 12a9 9 0 1 1-3-6.7 M21 3v6h-6',
  play: 'M6 4l14 8-14 8z',
  x: 'M18 6L6 18 M6 6l12 12',
  check: 'M5 13l4 4L19 7',
  alert: 'M12 3l10 18H2z M12 10v5 M12 18v.01',
  edit: 'M4 20h4L20 8l-4-4L4 16z',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.3-4.3',
  menu: 'M4 6h16 M4 12h16 M4 18h16',
  copy: 'M8 8h12v12H8z M4 16V4h12',
  download: 'M12 3v12 M7 10l5 5 5-5 M4 21h16',
  chevron: 'M9 6l6 6-6 6',
  stop: 'M6 6h12v12H6z',
};

export function icon(name, { size = 18 } = {}) {
  return svg(
    'svg',
    {
      class: 'icon',
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 1.8,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
    },
    svg('path', { d: ICONS[name] ?? ICONS.workflow }),
  );
}

// -------------------------------------------------------------- primitives
export const badge = (text, toneName = 'neutral', title) =>
  h('span', { class: `badge badge-${toneName}`, title }, text);
export const statusBadge = (status, label) => badge(label ?? status, tone(status));
export const mono = (text) => h('code', { class: 'mono' }, text);
export const muted = (text) => h('span', { class: 'muted' }, text);

export function spinner(label = 'Loading…') {
  return h('div', { class: 'loading', role: 'status' }, h('span', { class: 'spinner' }), h('span', {}, label));
}

export function emptyState(title, hint, action) {
  return h('div', { class: 'empty' }, h('strong', {}, title), hint ? h('p', {}, hint) : null, action ?? null);
}

/** Show an error (with any validation issues) in a consistent box. */
export function errorBox(err, { title } = {}) {
  const e = err instanceof ApiError ? err : new Error(err?.message ?? String(err));
  const issues = issuesOf(e);
  return h(
    'div',
    { class: 'alert alert-bad', role: 'alert' },
    h('strong', {}, title ?? (e.status === 403 ? 'Not allowed' : 'Something went wrong')),
    h('p', {}, e.message),
    issues.length
      ? h(
          'ul',
          {},
          issues
            .slice(0, 10)
            .map((i) => h('li', {}, i.path ? h('code', {}, i.path) : null, i.path ? ' ' : '', i.message)),
        )
      : null,
  );
}

export function notice(kind, ...content) {
  return h('div', { class: `alert alert-${kind}` }, ...content);
}

/** A button whose async click handler disables it and reports failures as toasts. */
export function button(
  label,
  { kind = 'secondary', onClick, disabled, title, small, icon: ic, type = 'button', busyLabel } = {},
) {
  const el = h(
    'button',
    { type, class: ['btn', `btn-${kind}`, small ? 'btn-sm' : ''], title, disabled: !!disabled },
    ic ? icon(ic, { size: small ? 14 : 16 }) : null,
    label ? h('span', {}, label) : null,
  );
  if (onClick) {
    el.addEventListener('click', async (ev) => {
      if (el.disabled) return;
      const original = el.lastChild?.textContent;
      el.disabled = true;
      if (busyLabel && el.lastChild) el.lastChild.textContent = busyLabel;
      try {
        await onClick(ev);
      } catch (e) {
        toast(e?.message ?? String(e), 'bad');
      } finally {
        el.disabled = !!disabled;
        if (busyLabel && el.lastChild && original !== undefined) el.lastChild.textContent = original;
      }
    });
  }
  return el;
}

export function card(title, body, { actions, class: cls, flush } = {}) {
  return h(
    'section',
    { class: ['card', cls, flush ? 'card-flush' : ''] },
    title || actions
      ? h(
          'header',
          { class: 'card-head' },
          title ? h('h3', {}, title) : h('span'),
          actions ? h('div', { class: 'card-actions' }, actions) : null,
        )
      : null,
    h('div', { class: 'card-body' }, body),
  );
}

export function pageHeader(title, subtitle, actions) {
  return h(
    'header',
    { class: 'page-head' },
    h('div', {}, h('h1', {}, title), subtitle ? h('p', { class: 'subtitle' }, subtitle) : null),
    actions ? h('div', { class: 'page-actions' }, actions) : null,
  );
}

export function kv(pairs) {
  return h(
    'dl',
    { class: 'kv' },
    pairs.filter(Boolean).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v ?? '—')]),
  );
}

export function codeBlock(text, { copy = true, label } = {}) {
  const pre = h('pre', { class: 'code' }, h('code', {}, text));
  return h(
    'div',
    { class: 'codeblock' },
    label ? h('div', { class: 'codeblock-label' }, label) : null,
    copy
      ? button('', {
          kind: 'ghost',
          small: true,
          icon: 'copy',
          title: 'Copy',
          onClick: async () => {
            await copyText(text);
            toast('Copied', 'good');
          },
        })
      : null,
    pre,
  );
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { value: text, class: 'sr-only' });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

export function field(label, control, help) {
  return h(
    'label',
    { class: 'field' },
    h('span', { class: 'field-label' }, label),
    control,
    help ? h('span', { class: 'field-help' }, help) : null,
  );
}

export function input(props = {}) {
  return h('input', { class: 'input', autocomplete: 'off', spellcheck: 'false', ...props });
}

export function select(options, value, props = {}) {
  return h(
    'select',
    { class: 'input', ...props },
    options.map((o) => {
      const [v, l] = Array.isArray(o) ? o : [o, o];
      return h('option', { value: v, selected: v === value }, l);
    }),
  );
}

// ------------------------------------------------------------------ tables
/** columns: [{ label, render(row) → Node|string, class }] */
export function dataTable({ columns, rows, empty = 'Nothing here yet.', onRow, rowClass }) {
  if (!rows.length) return emptyState(empty);
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'table' },
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          columns.map((c) => h('th', { class: c.class, scope: 'col' }, c.label)),
        ),
      ),
      h(
        'tbody',
        {},
        rows.map((row) => {
          const tr = h(
            'tr',
            { class: [onRow ? 'clickable' : '', rowClass?.(row)], tabindex: onRow ? 0 : undefined },
            columns.map((c) => h('td', { class: c.class }, c.render(row))),
          );
          if (onRow) {
            tr.addEventListener('click', (ev) => !ev.target.closest('a, button, input, select') && onRow(row));
            tr.addEventListener('keydown', (ev) => ev.key === 'Enter' && onRow(row));
          }
          return tr;
        }),
      ),
    ),
  );
}

export function tabs(items, activeId, onChange) {
  const panel = h('div', { class: 'tab-panel', role: 'tabpanel' });
  const bar = h('div', { class: 'tabs', role: 'tablist' });
  let current = activeId ?? items[0].id;
  const show = async (id) => {
    current = id;
    for (const b of bar.children) b.setAttribute('aria-selected', String(b.dataset.id === id));
    clear(panel).append(spinner());
    const item = items.find((i) => i.id === id);
    try {
      clear(panel).append(await item.render());
    } catch (e) {
      clear(panel).append(errorBox(e));
    }
    onChange?.(id);
  };
  for (const it of items)
    bar.append(
      h(
        'button',
        {
          type: 'button',
          role: 'tab',
          class: 'tab',
          dataset: { id: it.id },
          'aria-selected': String(it.id === current),
          onClick: () => show(it.id),
        },
        it.label,
        it.count ? h('span', { class: 'tab-count' }, String(it.count)) : null,
      ),
    );
  const root = h('div', { class: 'tabset' }, bar, panel);
  show(current);
  return root;
}

// ------------------------------------------------------------- toasts, dialogs
let toastHost;
export function toast(message, kind = 'neutral', ms = 4500) {
  toastHost ??= document.body.appendChild(h('div', { class: 'toasts', 'aria-live': 'polite' }));
  const t = h('div', { class: `toast toast-${kind}`, role: kind === 'bad' ? 'alert' : 'status' }, message);
  toastHost.append(t);
  setTimeout(() => t.remove(), ms);
}

/** Open a modal dialog. Resolves with whatever `close(value)` is called with (undefined if dismissed). */
export function openDialog({ title, body, actions, wide, onOpen }) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: ['dialog', wide ? 'dialog-wide' : ''], 'aria-label': title });
    const close = (value) => {
      dlg.close();
      dlg.remove();
      resolve(value);
    };
    dlg.addEventListener('cancel', () => resolve(undefined));
    dlg.addEventListener('close', () => dlg.remove());
    dlg.append(
      h(
        'header',
        { class: 'dialog-head' },
        h('h3', {}, title),
        button('', { kind: 'ghost', small: true, icon: 'x', title: 'Close', onClick: () => close(undefined) }),
      ),
      h('div', { class: 'dialog-body' }, body),
      actions ? h('footer', { class: 'dialog-foot' }, actions(close)) : null,
    );
    document.body.append(dlg);
    dlg.showModal();
    onOpen?.(dlg, close);
  });
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return openDialog({
    title,
    body: h('p', {}, message),
    actions: (close) => [
      button('Cancel', { onClick: () => close(false) }),
      button(confirmLabel, { kind: danger ? 'danger' : 'primary', onClick: () => close(true) }),
    ],
  }).then((v) => v === true);
}

/** Ask for a set of values. fields: [{ name, label, type, options, placeholder, required, help, value, textarea }] */
export function formDialog({ title, intro, fields, submitLabel = 'Save', danger = false, wide }) {
  const controls = fields.map((f) => {
    const c = f.options
      ? select(f.options, f.value ?? f.options[0]?.[0] ?? f.options[0], { name: f.name })
      : f.textarea
        ? h(
            'textarea',
            { class: 'input mono', name: f.name, rows: f.rows ?? 5, placeholder: f.placeholder, spellcheck: 'false' },
            f.value ?? '',
          )
        : f.type === 'checkbox'
          ? h('input', { type: 'checkbox', name: f.name, checked: !!f.value })
          : input({
              name: f.name,
              type: f.type ?? 'text',
              placeholder: f.placeholder,
              value: f.value ?? '',
              ...(f.type === 'password' ? { autocomplete: 'new-password' } : {}),
            });
    return {
      f,
      c,
      node:
        f.type === 'checkbox'
          ? h(
              'label',
              { class: 'check' },
              c,
              h('span', {}, f.label),
              f.help ? h('span', { class: 'field-help' }, f.help) : null,
            )
          : field(f.label, c, f.help),
    };
  });
  const errorSlot = h('div');
  return openDialog({
    title,
    wide,
    body: h(
      'form',
      { class: 'form', onSubmit: (e) => e.preventDefault() },
      intro ? h('p', { class: 'muted' }, intro) : null,
      controls.map((x) => x.node),
      errorSlot,
    ),
    onOpen: () => controls[0]?.c.focus?.(),
    actions: (close) => [
      button('Cancel', { onClick: () => close(null) }),
      button(submitLabel, {
        kind: danger ? 'danger' : 'primary',
        onClick: () => {
          const values = {};
          for (const { f, c } of controls) {
            const v = f.type === 'checkbox' ? c.checked : c.value;
            if (f.required && (v === '' || v === undefined))
              return clear(errorSlot).append(notice('bad', `${f.label} is required.`));
            values[f.name] = v;
          }
          close(values);
        },
      }),
    ],
  });
}

/** A one-time secret (API key, webhook secret): shown once, easy to copy. */
export function showSecretDialog({ title, intro, secret, extra }) {
  return openDialog({
    title,
    wide: true,
    body: h(
      'div',
      { class: 'stack' },
      notice('warn', intro ?? 'Copy this now. It cannot be shown again.'),
      codeBlock(secret),
      extra ?? null,
    ),
    actions: (close) => [button('Done', { kind: 'primary', onClick: () => close(true) })],
  });
}
