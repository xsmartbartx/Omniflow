import { svg } from './dom.js';

/** Stacked bars (succeeded / failed / other) per hour. Heights are attributes, so no inline styles are needed. */
export function runsChart(hourly, { width = 720, height = 150 } = {}) {
  const pad = { l: 28, r: 6, t: 8, b: 20 };
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const max = Math.max(1, ...hourly.map((b) => b.succeeded + b.failed + b.other));
  const step = innerW / Math.max(1, hourly.length);
  const bw = Math.max(2, step * 0.7);
  const y = (v) => (v / max) * innerH;
  const ticks = [0, Math.ceil(max / 2), max].filter((v, i, a) => a.indexOf(v) === i);

  const bars = hourly.flatMap((b, i) => {
    const x = pad.l + i * step + (step - bw) / 2;
    let base = pad.t + innerH;
    const seg = (v, cls, label) => {
      if (v <= 0) return null;
      const hgt = y(v);
      base -= hgt;
      return svg(
        'rect',
        { x: x.toFixed(2), y: base.toFixed(2), width: bw.toFixed(2), height: hgt.toFixed(2), class: cls, rx: 1 },
        svg(
          'title',
          {},
          `${new Date(b.hour).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })} — ${v} ${label}`,
        ),
      );
    };
    return [
      seg(b.succeeded, 'bar-ok', 'succeeded'),
      seg(b.failed, 'bar-bad', 'failed'),
      seg(b.other, 'bar-other', 'other'),
    ];
  });

  const labels = hourly.flatMap((b, i) =>
    i % Math.max(1, Math.ceil(hourly.length / 8)) === 0
      ? [
          svg(
            'text',
            { x: (pad.l + i * step + step / 2).toFixed(1), y: height - 5, class: 'axis', 'text-anchor': 'middle' },
            `${new Date(b.hour).getHours()}:00`,
          ),
        ]
      : [],
  );
  return svg(
    'svg',
    { class: 'chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Runs per hour' },
    ticks.map((t) =>
      svg(
        'g',
        {},
        svg('line', {
          x1: pad.l,
          x2: width - pad.r,
          y1: pad.t + innerH - y(t),
          y2: pad.t + innerH - y(t),
          class: 'grid',
        }),
        svg('text', { x: pad.l - 5, y: pad.t + innerH - y(t) + 3, class: 'axis', 'text-anchor': 'end' }, String(t)),
      ),
    ),
    bars,
    labels,
  );
}
