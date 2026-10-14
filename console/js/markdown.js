import { h } from './dom.js';

// A deliberately small Markdown subset (what Constans's own docs generator emits): headings, paragraphs,
// lists, tables, fenced code, quotes, rules, and inline code/bold/italic/links. Parsing produces a plain
// AST (unit-tested); rendering builds DOM nodes with textContent, so nothing in the input can inject markup.

const SAFE_URL = /^(https?:|mailto:|#|\/(?!\/))/i;

/** The inline element starting at text[i], if any: its node and how many characters it used. */
function inlineElement(text, i) {
  const rest = text.slice(i);
  let m = /^`([^`]+)`/.exec(rest);
  if (m) return { node: { t: 'code', v: m[1] }, length: m[0].length };
  m = /^\*\*([^*]+)\*\*/.exec(rest);
  if (m) return { node: { t: 'strong', c: parseInline(m[1]) }, length: m[0].length };
  m = /^_([^_\s][^_]*)_/.exec(rest);
  if (m && (i === 0 || /\W/.test(text[i - 1]))) return { node: { t: 'em', c: parseInline(m[1]) }, length: m[0].length };
  m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
  if (!m) return undefined;
  const node = SAFE_URL.test(m[2]) ? { t: 'link', href: m[2], c: parseInline(m[1]) } : { t: 'text', v: m[1] };
  return { node, length: m[0].length };
}

export function parseInline(text) {
  const out = [];
  let i = 0;
  let buf = '';
  const flush = () => {
    if (buf) out.push({ t: 'text', v: buf });
    buf = '';
  };
  while (i < text.length) {
    const el = inlineElement(text, i);
    if (el) {
      flush();
      out.push(el.node);
      i += el.length;
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
    .map((c) => c.trim().replaceAll(String.raw`\|`, '|'));

// Each reader looks at lines[i] and, when it recognises its block, returns { block, next }.
const ORDERED_ITEM = /^\s*\d+\.\s+/;
const BULLET_ITEM = /^\s*[-*]\s+/;

function readCode(lines, i) {
  const m = /^```\s*([\w-]*)$/.exec(lines[i].trimEnd());
  if (!m) return undefined;
  const body = [];
  let j = i + 1;
  while (j < lines.length && lines[j].trimEnd() !== '```') body.push(lines[j++]);
  return { block: { t: 'code', lang: m[1], v: body.join('\n') }, next: j + 1 };
}

function readHeading(lines, i) {
  const m = /^(#{1,4})\s(.*)$/.exec(lines[i]);
  return m ? { block: { t: 'heading', level: m[1].length, c: parseInline(m[2].trimStart()) }, next: i + 1 } : undefined;
}

function readRule(lines, i) {
  return /^(-{3,}|\*{3,})\s*$/.test(lines[i]) ? { block: { t: 'rule' }, next: i + 1 } : undefined;
}

function readTable(lines, i) {
  const isTableRow = (l) => /^\|.*\|\s*$/.test(l);
  if (!isTableRow(lines[i]) || i + 1 >= lines.length || !/^\|?\s*:?-{3,}/.test(lines[i + 1])) return undefined;
  const head = splitRow(lines[i]);
  let j = i + 2;
  const rows = [];
  while (j < lines.length && isTableRow(lines[j])) rows.push(splitRow(lines[j++]));
  return { block: { t: 'table', head: head.map(parseInline), rows: rows.map((r) => r.map(parseInline)) }, next: j };
}

function readList(lines, i) {
  const ordered = ORDERED_ITEM.test(lines[i]);
  if (!ordered && !BULLET_ITEM.test(lines[i])) return undefined;
  const marker = ordered ? ORDERED_ITEM : BULLET_ITEM;
  const items = [];
  let j = i;
  while (j < lines.length && marker.test(lines[j])) items.push(parseInline(lines[j++].replace(marker, '')));
  return { block: { t: 'list', ordered, items }, next: j };
}

function readQuote(lines, i) {
  if (!/^>\s?/.test(lines[i])) return undefined;
  const q = [];
  let j = i;
  while (j < lines.length && /^>\s?/.test(lines[j])) q.push(lines[j++].replace(/^>\s?/, ''));
  return { block: { t: 'quote', c: parseInline(q.join(' ')) }, next: j };
}

function readParagraph(lines, i) {
  const p = [];
  let j = i;
  while (j < lines.length && lines[j].trim() !== '' && !/^(#{1,4}\s|```|>|\s*[-*]\s+|\s*\d+\.\s+|\|)/.test(lines[j]))
    p.push(lines[j++]);
  if (p.length === 0) p.push(lines[j++]);
  return { block: { t: 'p', c: parseInline(p.join(' ')) }, next: j };
}

const BLOCK_READERS = [readCode, readHeading, readRule, readTable, readList, readQuote, readParagraph];

export function markdownToAst(src) {
  const lines = String(src ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  /** @type {any[]} */
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === '') {
      i++;
      continue;
    }
    for (const read of BLOCK_READERS) {
      const got = read(lines, i);
      if (!got) continue;
      blocks.push(got.block);
      i = got.next;
      break;
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
        return h(
          'a',
          {
            href: n.href,
            rel: 'noopener noreferrer',
            ...(n.href.startsWith('#') || n.href.startsWith('/') ? {} : { target: '_blank' }),
          },
          inline(n.c),
        );
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
        root.append(
          h(
            b.ordered ? 'ol' : 'ul',
            {},
            b.items.map((it) => h('li', {}, inline(it))),
          ),
        );
        break;
      case 'table':
        root.append(
          h(
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
                  b.head.map((c) => h('th', {}, inline(c))),
                ),
              ),
              h(
                'tbody',
                {},
                b.rows.map((r) =>
                  h(
                    'tr',
                    {},
                    r.map((c) => h('td', {}, inline(c))),
                  ),
                ),
              ),
            ),
          ),
        );
        break;
      default:
        break;
    }
  }
  return root;
}
