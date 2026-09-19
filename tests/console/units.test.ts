import { describe, expect, it } from 'vitest';
import { collapse, diffLines, stats } from '../../console/js/diff.js';
import {
  ago,
  coerceInput,
  duration,
  number,
  percent,
  shortHash,
  tone,
  truncate,
  until,
} from '../../console/js/format.js';
import { layoutGraph, NODE_H, NODE_W } from '../../console/js/graph.js';
import { markdownToAst, parseInline } from '../../console/js/markdown.js';
import { href, matchRoute } from '../../console/js/router.js';

describe('format', () => {
  const now = Date.parse('2026-06-01T12:00:00Z');
  it('describes time relative to now', () => {
    expect(ago('2026-06-01T11:59:58Z', now)).toBe('just now');
    expect(ago('2026-06-01T11:59:30Z', now)).toBe('30s ago');
    expect(ago('2026-06-01T11:50:00Z', now)).toBe('10m ago');
    expect(ago('2026-06-01T09:00:00Z', now)).toBe('3h ago');
    expect(ago('2026-05-29T12:00:00Z', now)).toBe('3d ago');
    expect(ago(null, now)).toBe('—');
    expect(until('2026-06-01T12:00:45Z', now)).toBe('in 45s');
    expect(until('2026-06-02T12:00:00Z', now)).toBe('in 1d');
    expect(until('2026-06-01T11:00:00Z', now)).toBe('now');
  });

  it('formats durations, numbers and percentages', () => {
    expect(duration(0)).toBe('0 ms');
    expect(duration(950)).toBe('950 ms');
    expect(duration(2500)).toBe('2.5 s');
    expect(duration(125_000)).toBe('2 min 5 s');
    expect(duration(3_900_000)).toBe('1 h 5 min');
    expect(duration(null)).toBe('—');
    expect(percent(0.9567, 1)).toBe('95.7%');
    expect(percent(null)).toBe('—');
    expect(number(1234567.891)).toBe('1,234,567.89');
    expect(shortHash('sha256:abcdef0123456789abcdef')).toBe('abcdef012345');
    expect(truncate('x'.repeat(100), 10)).toBe('xxxxxxxxx…');
  });

  it('colours statuses consistently', () => {
    expect(tone('succeeded')).toBe('good');
    expect(tone('failed')).toBe('bad');
    expect(tone('waiting-approval')).toBe('warn');
    expect(tone('critical')).toBe('bad');
    expect(tone('something-new')).toBe('neutral');
  });

  it('coerces form input by declared type', () => {
    expect(coerceInput('integer', '42')).toBe(42);
    expect(coerceInput('number', '1.5')).toBe(1.5);
    expect(coerceInput('boolean', 'true')).toBe(true);
    expect(coerceInput('object', '{"a":1}')).toEqual({ a: 1 });
    expect(coerceInput('string', 'hi')).toBe('hi');
    expect(coerceInput('string', '')).toBeUndefined();
    expect(() => coerceInput('object', '{oops')).toThrow();
  });
});

describe('router', () => {
  const routes = [
    { path: '/dashboard' },
    { path: '/workflows/:name' },
    { path: '/runs/:id' },
    { path: '/editor/:draft' },
  ];
  it('matches static and parameterised routes, decoding params and reading the query', () => {
    expect(matchRoute(routes, '#/dashboard').route.path).toBe('/dashboard');
    const m = matchRoute(routes, '#/workflows/order%20flow?tab=runs&x=1');
    expect(m.route.path).toBe('/workflows/:name');
    expect(m.params).toEqual({ name: 'order flow' });
    expect(m.query).toEqual({ tab: 'runs', x: '1' });
    expect(matchRoute(routes, '#/nope').route).toBeUndefined();
    expect(matchRoute(routes, '#/workflows/a/b').route).toBeUndefined();
    expect(matchRoute(routes, '').path).toBe('/');
  });

  it('builds hrefs', () => {
    expect(href('/runs', { workflow: 'a b' })).toBe('#/runs?workflow=a+b');
    expect(href('/runs')).toBe('#/runs');
  });
});

describe('markdown', () => {
  it('parses the subset the docs generator emits', () => {
    const ast = markdownToAst(
      [
        '# Title',
        '',
        'Some **bold** and `code` and _it_.',
        '',
        '- one',
        '- two',
        '',
        '1. a',
        '2. b',
        '',
        '| A | B |',
        '|---|---|',
        '| 1 | 2 \\| 3 |',
        '',
        '```mermaid',
        'flowchart TD',
        '```',
        '',
        '> quote',
        '',
        '---',
      ].join('\n'),
    );
    expect(ast.map((b: { t: string }) => b.t)).toEqual([
      'heading',
      'p',
      'list',
      'list',
      'table',
      'code',
      'quote',
      'rule',
    ]);
    expect(ast[0]).toMatchObject({ level: 1 });
    expect(ast[2]).toMatchObject({ ordered: false });
    expect(ast[3]).toMatchObject({ ordered: true });
    const table = ast[4] as { rows: Array<Array<Array<{ v: string }>>> };
    expect(table.rows[0]?.map((c) => c[0]?.v)).toEqual(['1', '2 | 3']);
    expect(ast[5]).toMatchObject({ lang: 'mermaid', v: 'flowchart TD' });
  });

  it('never turns text into markup: only http(s), mailto, hash and site-relative links survive', () => {
    const link = (u: string) => parseInline(`[x](${u})`)[0];
    expect(link('https://a.example/x')).toMatchObject({ t: 'link' });
    expect(link('/v1/docs')).toMatchObject({ t: 'link' });
    expect(link('#/runs')).toMatchObject({ t: 'link' });
    expect(link('javascript:alert(1)')).toMatchObject({ t: 'text', v: 'x' });
    expect(link('data:text/html,<script>')).toMatchObject({ t: 'text' });
    expect(link('//evil.example')).toMatchObject({ t: 'text' });
    // raw HTML is just text in the AST; the renderer only ever uses textContent
    expect(parseInline('<img src=x onerror=alert(1)>')).toEqual([{ t: 'text', v: '<img src=x onerror=alert(1)>' }]);
  });
});

describe('graph layout', () => {
  const nodes = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));
  const edges = [
    ['a', 'b'],
    ['a', 'c'],
    ['b', 'd'],
    ['c', 'd'],
    ['d', 'e'],
  ].map(([from, to]) => ({ from, to }));

  it('layers by longest path and never overlaps nodes', () => {
    const g = layoutGraph(nodes, edges);
    const by = Object.fromEntries(g.nodes.map((n: { id: string; layer: number }) => [n.id, n.layer]));
    expect(by).toEqual({ a: 0, b: 1, c: 1, d: 2, e: 3 });
    for (const [i, n] of g.nodes.entries()) {
      for (const m of g.nodes.slice(i + 1)) {
        const apart = Math.abs(n.x - m.x) >= NODE_W || Math.abs(n.y - m.y) >= NODE_H;
        expect(apart, `${n.id} overlaps ${m.id}`).toBe(true);
      }
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x + n.w).toBeLessThanOrEqual(g.width);
      expect(n.y + n.h).toBeLessThanOrEqual(g.height);
    }
    expect(g.edges).toHaveLength(5);
    expect(g.edges[0].path).toMatch(/^M [\d.]+ [\d.]+ C /);
  });

  it('is deterministic, tolerates cycles and unknown edge ends, and handles the empty graph', () => {
    expect(layoutGraph(nodes, edges)).toEqual(layoutGraph(nodes, edges));
    const cyclic = layoutGraph(
      [{ id: 'a' }, { id: 'b' }],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
        { from: 'a', to: 'ghost' },
        { from: 'a', to: 'a' },
      ],
    );
    expect(cyclic.nodes).toHaveLength(2);
    expect(layoutGraph([], []).nodes).toEqual([]);
  });

  it('keeps siblings ordered under their parents (few crossings)', () => {
    const g = layoutGraph(
      ['r', 'l1', 'l2', 'x', 'y'].map((id) => ({ id })),
      [
        ['r', 'l1'],
        ['r', 'l2'],
        ['l1', 'x'],
        ['l2', 'y'],
      ].map(([from, to]) => ({ from, to })),
    );
    const x = Object.fromEntries(g.nodes.map((n: { id: string; x: number }) => [n.id, n.x]));
    expect(x.x < x.y).toBe(x.l1 < x.l2);
  });
});

describe('diff', () => {
  it('finds added, removed and unchanged lines', () => {
    const ops = diffLines('a\nb\nc', 'a\nc\nd');
    expect(ops.map((o: { op: string; text: string }) => `${o.op}:${o.text}`)).toEqual([
      'same:a',
      'del:b',
      'same:c',
      'add:d',
    ]);
    expect(stats(ops)).toEqual({ added: 1, removed: 1 });
    expect(diffLines('same', 'same').every((o: { op: string }) => o.op === 'same')).toBe(true);
    expect(diffLines('', 'x').some((o: { op: string; text: string }) => o.op === 'add' && o.text === 'x')).toBe(true);
  });

  it('collapses long unchanged stretches but keeps context around changes', () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 15', 'line fifteen');
    const c = collapse(diffLines(before, after), 2);
    expect(c.filter((o: { op: string }) => o.op === 'gap')).toHaveLength(2);
    expect(c.filter((o: { op: string }) => o.op !== 'gap')).toHaveLength(2 + 1 + 1 + 2); // two lines of context, the removed and added line, two lines of context
    expect(collapse(diffLines('a', 'a'), 3)).toEqual([]);
  });
});
