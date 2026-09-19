import { svg } from './dom.js';

// Layered DAG layout (top → bottom). Pure: given nodes and edges it returns coordinates, so the same
// function is unit-tested and used for rendering.

export const NODE_W = 172;
export const NODE_H = 54;
const GAP_X = 28;
const GAP_Y = 46;
const PAD = 16;

export function layoutGraph(nodes, edges) {
  const ids = nodes.map((n) => n.id);
  const preds = new Map(ids.map((id) => [id, []]));
  const succs = new Map(ids.map((id) => [id, []]));
  for (const e of edges) {
    if (!preds.has(e.to) || !succs.has(e.from) || e.from === e.to) continue;
    preds.get(e.to).push(e.from);
    succs.get(e.from).push(e.to);
  }

  // layer = longest path from any root (memoised DFS; cycles cannot occur in a compiled plan, but guard anyway)
  const layer = new Map();
  const visiting = new Set();
  const depth = (id) => {
    if (layer.has(id)) return layer.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const d = preds.get(id).length === 0 ? 0 : 1 + Math.max(...preds.get(id).map(depth));
    visiting.delete(id);
    layer.set(id, d);
    return d;
  };
  for (const id of ids) depth(id);

  const layers = [];
  for (const id of ids) (layers[layer.get(id)] ??= []).push(id);
  for (let i = 0; i < layers.length; i++) layers[i] ??= [];

  // order within layers: a few barycentre sweeps to reduce crossings, ties broken by input order (stable)
  const order = new Map();
  for (const l of layers) for (const [i, id] of l.entries()) order.set(id, i);
  const bary = (id, nb) => {
    const ns = nb.get(id);
    return ns.length ? ns.reduce((s, n) => s + order.get(n), 0) / ns.length : order.get(id);
  };
  for (let sweep = 0; sweep < 4; sweep++) {
    const down = sweep % 2 === 0;
    const seq = down ? layers.slice(1) : layers.slice(0, -1).reverse();
    for (const l of seq) {
      l.sort((a, b) => bary(a, down ? preds : succs) - bary(b, down ? preds : succs) || order.get(a) - order.get(b));
      for (const [i, id] of l.entries()) order.set(id, i);
    }
  }

  const widest = Math.max(1, ...layers.map((l) => l.length));
  const width = PAD * 2 + widest * NODE_W + (widest - 1) * GAP_X;
  const pos = new Map();
  for (const [li, l] of layers.entries()) {
    const rowW = l.length * NODE_W + (l.length - 1) * GAP_X;
    const x0 = (width - rowW) / 2;
    for (const [i, id] of l.entries()) pos.set(id, { x: x0 + i * (NODE_W + GAP_X), y: PAD + li * (NODE_H + GAP_Y), layer: li });
  }

  const laidOut = nodes.map((n) => ({ ...n, ...pos.get(n.id), w: NODE_W, h: NODE_H }));
  const laidEdges = edges
    .filter((e) => pos.has(e.from) && pos.has(e.to) && e.from !== e.to)
    .map((e) => {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      const x1 = a.x + NODE_W / 2;
      const y1 = a.y + NODE_H;
      const x2 = b.x + NODE_W / 2;
      const y2 = b.y;
      const dy = Math.max(20, (y2 - y1) / 2);
      return { ...e, x1, y1, x2, y2, path: `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}` };
    });
  return { nodes: laidOut, edges: laidEdges, width, height: PAD * 2 + layers.length * NODE_H + Math.max(0, layers.length - 1) * GAP_Y };
}

const KIND_LABEL = { capability: '', branch: 'branch', approval: 'approval', parallel: 'parallel', map: 'for each', wait: 'wait', subworkflow: 'subworkflow', terminate: 'end' };

/** Render a laid-out graph as SVG. `states` maps step id → run status for colouring (optional). */
export function renderGraph(graph, { states = {}, onSelect } = {}) {
  const { nodes, edges, width, height } = layoutGraph(
    graph.nodes.map((n) => ({ id: n.id, data: n })),
    [...graph.edges.map((e) => ({ ...e, kind: e.conditional ? 'conditional' : 'flow' })), ...(graph.routes ?? []).map((r) => ({ from: r.from, to: r.to, kind: 'error' }))],
  );
  const root = svg(
    'svg',
    { class: 'dag', viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-label': 'Workflow graph' },
    svg('defs', {}, svg('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: 'dag-arrow' }))),
    edges.map((e) => svg('path', { d: e.path, class: `dag-edge dag-edge-${e.kind}`, 'marker-end': 'url(#arrow)' })),
    nodes.map((n) => {
      const d = n.data;
      const state = states[n.id];
      const title = d.name ?? d.id;
      const sub = d.capability ?? KIND_LABEL[d.type] ?? d.type;
      const g = svg(
        'g',
        { class: ['dag-node', `dag-${d.type}`, d.effect ? `dag-effect-${d.effect}` : '', state ? `dag-state-${state}` : '', onSelect ? 'dag-clickable' : ''], transform: `translate(${n.x}, ${n.y})`, tabindex: onSelect ? 0 : undefined, role: onSelect ? 'button' : undefined, 'aria-label': `${title}${state ? `, ${state}` : ''}` },
        svg('title', {}, `${d.id}${d.capability ? ` — ${d.capability}` : ''}${state ? ` — ${state}` : ''}`),
        svg('rect', { width: n.w, height: n.h, rx: d.type === 'branch' ? 26 : 9, class: 'dag-box' }),
        svg('text', { x: n.w / 2, y: 22, class: 'dag-title', 'text-anchor': 'middle' }, clip(title, 24)),
        svg('text', { x: n.w / 2, y: 40, class: 'dag-sub', 'text-anchor': 'middle' }, clip(`${sub}${d.hasCompensation ? ' · ↺' : ''}`, 28)),
      );
      if (onSelect) {
        g.addEventListener('click', () => onSelect(d.id));
        g.addEventListener('keydown', (ev) => {
          if (ev.key !== 'Enter' && ev.key !== ' ') return;
          ev.preventDefault();
          onSelect(d.id);
        });
      }
      return g;
    }),
  );
  return root;
}

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
