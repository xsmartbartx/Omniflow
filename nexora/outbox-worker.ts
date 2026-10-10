import { type Logger, nullLogger } from '../core/index.ts';
import type { State } from '../state/index.ts';
import type { NexoraService } from './service.ts';
import type { EventPort } from './types.ts';

const MAX_BACKOFF_MS = 3_600_000;

/**
 * Delivers the outbox to Core and keeps entitlements fresh. At-least-once: a row is marked sent only after
 * `send` resolves, and Core dedupes on the event id, so a crash between the two is harmless.
 */
export class OutboxWorker {
  private readonly st: State;
  private readonly events: EventPort;
  private readonly service: NexoraService;
  private readonly log: Logger;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(opts: { state: State; events: EventPort; service: NexoraService; log?: Logger; intervalMs?: number }) {
    this.st = opts.state;
    this.events = opts.events;
    this.service = opts.service;
    this.log = opts.log ?? nullLogger;
    this.intervalMs = opts.intervalMs ?? 5_000;
  }

  /** One pass. Returns how many events were delivered. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let delivered = 0;
    try {
      for (const item of this.st.nexora.dueOutbox()) {
        try {
          await this.events.send({
            id: item.idempotencyKey,
            kind: item.kind,
            name: item.name,
            orgId: item.orgId,
            occurredAt: item.occurredAt,
            ...(item.correlationId ? { correlationId: item.correlationId } : {}),
            payload: item.payload,
          });
          this.st.nexora.markSent(item.id);
          delivered++;
        } catch (e) {
          const backoff = Math.min(2 ** item.attempts * 5_000, MAX_BACKOFF_MS);
          this.st.nexora.markFailed(item.id, e instanceof Error ? e.message : String(e), backoff);
          this.log.warn('could not deliver event to NEXORA', { id: item.id, attempts: item.attempts + 1 });
        }
      }
      await this.service.refreshExpired();
    } finally {
      this.running = false;
    }
    return delivered;
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
