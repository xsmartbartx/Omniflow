import { type Clock, systemClock } from '../../core/index.ts';

export type BreakerState = 'closed' | 'open' | 'half-open';

interface Entry {
  state: BreakerState;
  failures: number;
  openedAt?: number;
  probing: boolean;
}

export interface BreakerOptions {
  /** Consecutive transient/systemic failures that open the circuit. */
  failureThreshold: number;
  /** How long the circuit stays open before one probe is allowed through. */
  cooldownMs: number;
}

export const DEFAULT_BREAKER: BreakerOptions = { failureThreshold: 5, cooldownMs: 30_000 };

/**
 * Per-capability circuit breakers (architecture §12.3). When an adapter is failing systemically,
 * further steps are *deferred* rather than failed — they do not consume an attempt — and resume
 * automatically once a probe succeeds ("systemic: pause, alert, resume on recovery").
 */
export class CircuitBreakers {
  private readonly entries = new Map<string, Entry>();
  private readonly opts: BreakerOptions;
  private readonly clock: Clock;
  private readonly onChange: ((capability: string, state: BreakerState) => void) | undefined;

  constructor(
    opts: Partial<BreakerOptions> = {},
    clock: Clock = systemClock,
    onChange?: (c: string, s: BreakerState) => void,
  ) {
    this.opts = { ...DEFAULT_BREAKER, ...opts };
    this.clock = clock;
    this.onChange = onChange;
  }

  private entry(name: string): Entry {
    let e = this.entries.get(name);
    if (!e) {
      e = { state: 'closed', failures: 0, probing: false };
      this.entries.set(name, e);
    }
    return e;
  }

  check(name: string): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const e = this.entry(name);
    if (e.state === 'closed') return { allowed: true };
    const now = this.clock.now().getTime();
    if (e.state === 'open') {
      const remaining = (e.openedAt ?? now) + this.opts.cooldownMs - now;
      if (remaining > 0) return { allowed: false, retryAfterMs: remaining };
      e.state = 'half-open';
      e.probing = true;
      this.onChange?.(name, 'half-open');
      return { allowed: true }; // this caller is the probe
    }
    // half-open: exactly one probe at a time
    if (e.probing) return { allowed: false, retryAfterMs: 1000 };
    e.probing = true;
    return { allowed: true };
  }

  success(name: string): void {
    const e = this.entry(name);
    const wasOpen = e.state !== 'closed';
    e.state = 'closed';
    e.failures = 0;
    e.probing = false;
    delete e.openedAt;
    if (wasOpen) this.onChange?.(name, 'closed');
  }

  /** Record a failure. Only failures that indicate the capability is unhealthy should be reported. */
  failure(name: string): void {
    const e = this.entry(name);
    e.probing = false;
    if (e.state === 'half-open') {
      this.open(name, e);
      return;
    }
    e.failures++;
    if (e.state === 'closed' && e.failures >= this.opts.failureThreshold) this.open(name, e);
  }

  private open(name: string, e: Entry): void {
    e.state = 'open';
    e.openedAt = this.clock.now().getTime();
    this.onChange?.(name, 'open');
  }

  /** Release a probe that ended without a health signal (e.g. cancelled). */
  release(name: string): void {
    this.entry(name).probing = false;
  }

  snapshot(): Record<string, { state: BreakerState; failures: number; openedAt?: string }> {
    return Object.fromEntries(
      [...this.entries].map(([k, v]) => [
        k,
        {
          state: v.state,
          failures: v.failures,
          ...(v.openedAt ? { openedAt: new Date(v.openedAt).toISOString() } : {}),
        },
      ]),
    );
  }
}
