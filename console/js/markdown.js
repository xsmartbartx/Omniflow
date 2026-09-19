import { h } from './dom.js';

// A deliberately small Markdown subset (what OmniFlow's own docs generator emits): headings, paragraphs,
// lists, tables, fenced code, quotes, rules, and inline code/bold/italic/links. Parsing produces a plain
// AST (unit-tested); rendering builds DOM nodes with textContent, so nothing in the input can inject markup.

const SAFE_URL = /^(https?:|mailto:|#|\/(?!\/))/i;

export function parseInline(text) {
  const out = [];
  let i = 0;
  let buf = '';
  const flush = () => {
    if (buf) out.push({ t: 'text', v: buf });
    buf = '';
  };
  while (i < text.length) {
    const rest = text.slice(i);
    let m;
    if ((m = /^`([^`]+)`/.exec(rest))) {
      flush();
      out.push({ t: 'code', v: m[1] });
      i += m[0].length;
    } else if ((m = /^\*\*([^*]+)\*\*/.exec(rest))) {
      flush();
      out.push({ t: 'strong', c: parseInline(m[1]) });
      i += m[0].length;
    } else if ((m = /^_([^_\s][^_]*)_/.exec(rest)) && (i === 0 || /\W/.test(text[i - 1]))) {
      flush();
      out.push({ t: 'em', c: parseInline(m[1]) });
      i += m[0].length;
    } else if ((m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest))) {
      flush();
      out.push(SAFE_URL.test(m[2]) ? { t: 'link', href: m[2], c: parseInline(m[1]) } : { t: 'text', v: m[1] });
      i += m[0].length;
    } else if (text[i] === '\\' && i + 1 < text.length) {
      buf += text[i + 1];
      i += 2;
    } else {
      buf += text[i++];
    }
  }
  flush();
  return out;
}

const splitRow = (line) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));

export function markdownToAst(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    let m;
    if ((m = /^```\s*([\w-]*)\s*$/.exec(line))) {
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push({ t: 'code', lang: m[1], v: body.join('\n') });
    } else if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) {
      blocks.push({ t: 'heading', level: m[1].length, c: parseInline(m[2]) });
      i++;
    } else if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push({ t: 'rule' });
      i++;
    } else if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|?\s*:?-{3,}/.test(lines[i + 1])) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(splitRow(lines[i++]));
      blocks.push({ t: 'table', head: head.map(parseInline), rows: rows.map((r) => r.map(parseInline)) });
    } else if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items = [];
      while (i < lines.length && (ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/).test(lines[i])) {
        items.push(parseInline(lines[i].replace(ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/, '')));
        i++;
      }
      blocks.push({ t: 'list', ordered, items });
    } else if (/^>\s?/.test(line)) {
      const q = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push({ t: 'quote', c: parseInline(q.join(' ')) });
    } else {
      const p = [];
      while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,4}\s|```|>|\s*[-*]\s+|\s*\d+\.\s+|\|)/.test(lines[i])) p.push(lines[i++]);
      if (p.length === 0) p.push(lines[i++]);
      blocks.push({ t: 'p', c: parseInline(p.join(' ')) });
    }
  }
  return blocks;
}

function inline(nodes) {
  return nodes.map((n) => {
    switch (n.t) {
      case 'text':
        return n.v;
      case 'code':
        return h('code', {}, n.v);
      case 'strong':
        return h('strong', {}, inline(n.c));
      case 'em':
        return h('em', {}, inline(n.c));
      case 'link':
        return h('a', { href: n.href, rel: 'noopener noreferrer', ...(n.href.startsWith('#') || n.href.startsWith('/') ? {} : { target: '_blank' }) }, inline(n.c));
      default:
        return '';
    }
  });
}

/** Render Markdown as DOM. `opts.onCode(lang, text)` may return a node to replace a fenced code block (e.g. a diagram). */
export function renderMarkdown(src, opts = {}) {
  const root = h('div', { class: 'md' });
  for (const b of markdownToAst(src)) {
    switch (b.t) {
      case 'heading':
        root.append(h(`h${Math.min(6, b.level + 1)}`, {}, inline(b.c)));
        break;
      case 'p':
        root.append(h('p', {}, inline(b.c)));
        break;
      case 'quote':
        root.append(h('blockquote', {}, inline(b.c)));
        break;
      case 'rule':
        root.append(h('hr'));
        break;
      case 'code':
        root.append(opts.onCode?.(b.lang, b.v) ?? h('pre', { class: 'code' }, h('code', {}, b.v)));
        break;
      case 'list':
        root.append(h(b.ordered ? 'ol' : 'ul', {}, b.items.map((it) => h('li', {}, inline(it)))));
        break;
      case 'table':
        root.append(h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', {}, h('tr', {}, b.head.map((c) => h('th', {}, inline(c))))), h('tbody', {}, b.rows.map((r) => h('tr', {}, r.map((c) => h('td', {}, inline(c)))))))));
        break;
      default:
        break;
    }
  }
  return root;
}
