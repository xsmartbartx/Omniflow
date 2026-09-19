/** In-memory token-bucket limiter. Per-process, which matches the single-node deployment model. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; last: number }>();
  private lastSweep = Date.now();
  private readonly perMinute: number;
  private readonly burst: number;

  /** @param perMinute sustained rate; @param burst bucket size (defaults to the per-minute rate) */
  constructor(perMinute: number, burst = perMinute) {
    this.perMinute = perMinute;
    this.burst = burst;
  }

  /** Returns `0` when allowed, otherwise the seconds to wait before retrying. */
  take(key: string, now = Date.now()): number {
    if (now - this.lastSweep > 60_000) this.sweep(now);
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.burst, last: now };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.last) / 60_000) * this.perMinute);
    b.last = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil(((1 - b.tokens) / this.perMinute) * 60));
  }

  private sweep(now: number): void {
    this.lastSweep = now;
    for (const [k, b] of this.buckets) if (now - b.last > 10 * 60_000) this.buckets.delete(k);
  }
}
