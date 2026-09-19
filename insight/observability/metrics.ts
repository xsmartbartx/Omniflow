/**
 * Minimal Prometheus-compatible metrics registry (architecture §13). Dependency-free: counters,
 * gauges and histograms with labels, rendered in the text exposition format.
 */

type Labels = Record<string, string>;

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const key = (labels: Labels) => Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}="${esc(v)}"`).join(',');

class Counter {
  readonly values = new Map<string, number>();
  readonly name: string;
  readonly help: string;
  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }
  inc(labels: Labels = {}, by = 1): void {
    const k = key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
}

class Gauge {
  readonly values = new Map<string, number>();
  readonly name: string;
  readonly help: string;
  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }
  set(labels: Labels, value: number): void {
    this.values.set(key(labels), value);
  }
  reset(): void {
    this.values.clear();
  }
}

class Histogram {
  readonly series = new Map<string, { counts: number[]; sum: number; count: number }>();
  readonly name: string;
  readonly help: string;
  readonly buckets: number[];
  constructor(name: string, help: string, buckets: number[]) {
    this.name = name;
    this.help = help;
    this.buckets = buckets;
  }
  observe(labels: Labels, value: number): void {
    const k = key(labels);
    let s = this.series.get(k);
    if (!s) {
      s = { counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.series.set(k, s);
    }
    s.sum += value;
    s.count++;
    this.buckets.forEach((b, i) => {
      if (value <= b) s!.counts[i]!++;
    });
  }
}

export const DURATION_BUCKETS = [0.005, 0.025, 0.1, 0.5, 1, 2.5, 10, 30, 120, 600, 3600];

export class MetricsRegistry {
  private readonly counters = new Map<string, Counter>();
  private readonly gauges = new Map<string, Gauge>();
  private readonly histograms = new Map<string, Histogram>();
  private readonly collectors: Array<() => void> = [];

  counter(name: string, help: string): Counter {
    let c = this.counters.get(name);
    if (!c) this.counters.set(name, (c = new Counter(name, help)));
    return c;
  }
  gauge(name: string, help: string): Gauge {
    let g = this.gauges.get(name);
    if (!g) this.gauges.set(name, (g = new Gauge(name, help)));
    return g;
  }
  histogram(name: string, help: string, buckets = DURATION_BUCKETS): Histogram {
    let h = this.histograms.get(name);
    if (!h) this.histograms.set(name, (h = new Histogram(name, help, buckets)));
    return h;
  }

  /** Register a function run at scrape time to refresh gauges from live state. */
  collect(fn: () => void): void {
    this.collectors.push(fn);
  }

  render(): string {
    for (const c of this.collectors) {
      try {
        c();
      } catch {
        /* a failing collector must not break the scrape */
      }
    }
    const out: string[] = [];
    const line = (name: string, labels: string, v: number) => out.push(`${name}${labels ? `{${labels}}` : ''} ${Number.isFinite(v) ? v : 0}`);
    for (const c of this.counters.values()) {
      out.push(`# HELP ${c.name} ${c.help}`, `# TYPE ${c.name} counter`);
      for (const [l, v] of c.values) line(c.name, l, v);
    }
    for (const g of this.gauges.values()) {
      out.push(`# HELP ${g.name} ${g.help}`, `# TYPE ${g.name} gauge`);
      for (const [l, v] of g.values) line(g.name, l, v);
    }
    for (const h of this.histograms.values()) {
      out.push(`# HELP ${h.name} ${h.help}`, `# TYPE ${h.name} histogram`);
      for (const [l, s] of h.series) {
        h.buckets.forEach((b, i) => line(`${h.name}_bucket`, `${l}${l ? ',' : ''}le="${b}"`, s.counts[i]!));
        line(`${h.name}_bucket`, `${l}${l ? ',' : ''}le="+Inf"`, s.count);
        line(`${h.name}_sum`, l, s.sum);
        line(`${h.name}_count`, l, s.count);
      }
    }
    return `${out.join('\n')}\n`;
  }
}
