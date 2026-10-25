import { createHash } from 'node:crypto';
import { type AdapterConfig, safeRequest } from '../capabilities/index.ts';
import { type Logger, nullLogger, redactMessage } from '../core/index.ts';
import { signWebhook } from '../security/webhook.ts';
import { type Delivery, GLOBAL_TENANT, type State } from '../state/index.ts';

/** Run events a hook may subscribe to. Terminal outcomes are the default. */
export const WEBHOOK_EVENTS = [
  'run.started',
  'run.succeeded',
  'run.failed',
  'run.cancelled',
  'run.rolled-back',
  'run.compensation-failed',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
const DEFAULT_EVENTS: WebhookEvent[] = [
  'run.succeeded',
  'run.failed',
  'run.cancelled',
  'run.rolled-back',
  'run.compensation-failed',
];

export interface RunWebhook {
  /** Stable id derived from url and tenant; shown in the delivery list. */
  id: string;
  url: string;
  secret: string;
  events: WebhookEvent[];
  tenant: string;
}

export const MAX_ATTEMPTS = 8;
const CURSOR_KEY = 'webhooks.cursor';

/** Parse `OMNIFLOW_RUN_WEBHOOKS`: a JSON array of `{ url, secret, events?, tenant? }`. Throws a message naming the problem. */
export function parseRunWebhooks(raw: string | undefined, opts: { production: boolean }): RunWebhook[] {
  if (!raw?.trim()) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('must be a JSON array');
  }
  if (!Array.isArray(data)) throw new Error('must be a JSON array');
  const hooks: RunWebhook[] = data.map((h, i) => {
    const where = `entry ${i}`;
    if (typeof h !== 'object' || h === null) throw new Error(`${where} must be an object`);
    const { url, secret, events, tenant } = h as Record<string, unknown>;
    if (typeof url !== 'string') throw new Error(`${where}: url is required`);
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new Error(`${where}: url is not a valid URL`);
    }
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local && !opts.production))
      throw new Error(`${where}: url must be https (http only for localhost outside production)`);
    if (u.username || u.password) throw new Error(`${where}: put credentials in the secret, not the url`);
    if (typeof secret !== 'string' || secret.length < 16)
      throw new Error(`${where}: secret must be at least 16 characters`);
    let evs: WebhookEvent[] = DEFAULT_EVENTS;
    if (events !== undefined) {
      if (
        !Array.isArray(events) ||
        events.length === 0 ||
        events.some((e) => !(WEBHOOK_EVENTS as readonly string[]).includes(e as string))
      )
        throw new Error(`${where}: events must be a non-empty list from ${WEBHOOK_EVENTS.join(', ')}`);
      evs = [...new Set(events as WebhookEvent[])];
    }
    const t = typeof tenant === 'string' && tenant ? tenant : 'default';
    const id = createHash('sha256').update(`${url}|${t}`).digest('hex').slice(0, 12);
    return { id, url, secret, events: evs, tenant: t };
  });
  if (new Set(hooks.map((h) => h.id)).size !== hooks.length) throw new Error('the same url and tenant appear twice');
  return hooks;
}

const hostPort = (url: string): string => {
  const u = new URL(url);
  return u.port ? `${u.hostname}:${u.port}` : u.hostname;
};

/** Only the origin of a hook's url is ever shown or logged: paths and queries can carry tokens. */
export const originOf = (url: string): string => new URL(url).origin;

type EventRow = ReturnType<State['events']['list']>[number];
type RunRow = ReturnType<State['runs']['getRun']>;

/** The JSON body sent for one event: the run it belongs to and, for failures, a redacted error. */
function webhookPayload(e: EventRow, run: RunRow): Record<string, unknown> {
  const error =
    typeof e.data.error === 'object' && e.data.error ? (e.data.error as Record<string, unknown>) : undefined;
  return {
    id: e.id,
    type: e.type,
    occurredAt: e.ts,
    tenant: e.tenant,
    run: {
      id: e.runId ?? null,
      workflow: run?.workflowName ?? null,
      version: run?.workflowVersion ?? null,
      status: run?.status ?? null,
      ...(e.correlationId ? { correlationId: e.correlationId } : {}),
    },
    ...(error
      ? {
          error: {
            code: error.code ?? null,
            message: redactMessage(typeof error.message === 'string' ? error.message : '').slice(0, 300),
          },
        }
      : {}),
  };
}

/**
 * Delivers run-lifecycle events to operator-configured URLs. Durable and at-least-once: new events are
 * found by reading the event log past a persisted cursor (so a crash loses nothing), turned into delivery
 * rows (idempotent per hook and event), then sent with retries and exponential backoff. Receivers should
 * dedupe on `X-OmniFlow-Delivery`, which is the event id and does not change between attempts.
 */
export class WebhookDispatcher {
  private readonly st: State;
  private readonly hooks: Map<string, RunWebhook>;
  private readonly adapters: AdapterConfig;
  private readonly log: Logger;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(opts: { state: State; hooks: RunWebhook[]; adapters: AdapterConfig; log?: Logger; intervalMs?: number }) {
    this.st = opts.state;
    this.hooks = new Map(opts.hooks.map((h) => [h.id, h]));
    this.adapters = opts.adapters;
    this.log = opts.log ?? nullLogger;
    this.intervalMs = opts.intervalMs ?? 2_000;
  }

  /** Read new events into delivery rows. The cursor moves only after the rows are written. */
  collect(): number {
    const types = [...new Set([...this.hooks.values()].flatMap((h) => h.events))];
    if (types.length === 0) return 0;
    const cursor = this.st.kv.get<number>(GLOBAL_TENANT, CURSOR_KEY);
    if (cursor === undefined) {
      // First start: begin at "now", never replay history to a new hook.
      const last = this.st.events.list({ order: 'desc', limit: 1 })[0]?.seq ?? 0;
      this.st.kv.set(GLOBAL_TENANT, CURSOR_KEY, last);
      return 0;
    }
    const events = this.st.events.list({ types, afterSeq: cursor, order: 'asc', limit: 500 });
    let made = 0;
    this.st.db.transaction(() => {
      for (const e of events) {
        const run = e.runId ? this.st.runs.getRun(e.runId, e.tenant) : undefined;
        for (const h of this.hooks.values()) {
          if (h.tenant !== e.tenant || !h.events.includes(e.type as WebhookEvent)) continue;
          const ok = this.st.webhooks.enqueue({
            tenant: e.tenant,
            hookId: h.id,
            eventSeq: e.seq,
            eventType: e.type,
            ...(e.runId ? { runId: e.runId } : {}),
            payload: webhookPayload(e, run),
          });
          if (ok) made++;
        }
      }
      const advanced = events.at(-1)?.seq;
      if (advanced !== undefined) this.st.kv.set(GLOBAL_TENANT, CURSOR_KEY, advanced);
    });
    return made;
  }

  private async deliver(d: Delivery): Promise<boolean> {
    const hook = this.hooks.get(d.hookId);
    if (!hook) {
      this.st.webhooks.markFailed(d.id, 'the webhook was removed from the configuration');
      return false;
    }
    const body = JSON.stringify(d.payload);
    const ts = Math.floor(this.st.clock.now().getTime() / 1000);
    let status: number | undefined;
    try {
      const res = await safeRequest({
        method: 'POST',
        url: hook.url,
        headers: {
          'content-type': 'application/json',
          'user-agent': this.adapters.http.userAgent,
          'x-omniflow-event': d.eventType,
          'x-omniflow-delivery': String((d.payload as { id?: string }).id ?? d.id),
          'x-omniflow-timestamp': String(ts),
          'x-omniflow-signature': signWebhook(hook.secret, ts, body),
        },
        body,
        signal: AbortSignal.timeout(10_000),
        allowedHosts: [hostPort(hook.url)],
        allowPrivate: this.adapters.allowPrivateNetworks,
        maxResponseBytes: 16 * 1024,
        maxRedirects: 0,
        timeoutMs: 10_000,
        followRedirects: false,
      });
      status = res.status;
      if (res.status >= 200 && res.status < 300) {
        this.st.webhooks.markDelivered(d.id, res.status);
        return true;
      }
      const permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
      if (permanent) {
        this.st.webhooks.markFailed(d.id, `the receiver answered ${res.status}`, res.status);
        return false;
      }
      throw new Error(`the receiver answered ${res.status}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (d.attempts + 1 >= MAX_ATTEMPTS) this.st.webhooks.markFailed(d.id, msg, status);
      else {
        this.st.webhooks.markRetry(d.id, Math.min(2 ** d.attempts * 5_000, 3_600_000), msg, status);
        this.log.warn('webhook delivery failed', {
          hook: hook.id,
          origin: originOf(hook.url),
          attempt: d.attempts + 1,
        });
      }
      return false;
    }
  }

  /** One pass: collect, then deliver what is due. Returns how many were delivered. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      this.collect();
      let delivered = 0;
      for (const d of this.st.webhooks.due()) {
        if (await this.deliver(d)) delivered++;
      }
      return delivered;
    } finally {
      this.running = false;
    }
  }

  start(): void {
    this.collect(); // pin the cursor now so events during the first interval are not skipped
    this.timer = setInterval(
      () => void this.tick().catch((e) => this.log.error('webhook worker failed', { error: e })),
      this.intervalMs,
    );
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
