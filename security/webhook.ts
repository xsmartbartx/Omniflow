import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook authentication (threat T6: replay or forgery of a trigger).
 *
 * A delivery carries `X-OmniFlow-Timestamp` (unix seconds) and `X-OmniFlow-Signature: v1=<hex>`,
 * where the signature is HMAC-SHA256 over `"<timestamp>.<raw body>"` with the trigger's secret.
 * The timestamp bounds replay to a short window; a nonce store closes it completely.
 */

export const WEBHOOK_TOLERANCE_MS = 5 * 60_000;

export function signWebhook(secret: string, timestampSeconds: number, rawBody: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestampSeconds}.${rawBody}`).digest('hex')}`;
}

export type WebhookVerdict =
  | { ok: true; nonce: string }
  | { ok: false; reason: 'missing-headers' | 'bad-timestamp' | 'stale-timestamp' | 'bad-signature' };

export function verifyWebhook(opts: {
  secret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: string;
  nowMs: number;
  toleranceMs?: number;
}): WebhookVerdict {
  const { secret, timestamp, signature, rawBody, nowMs } = opts;
  if (!timestamp || !signature) return { ok: false, reason: 'missing-headers' };
  if (!/^\d{9,11}$/.test(timestamp)) return { ok: false, reason: 'bad-timestamp' };
  const tsMs = Number(timestamp) * 1000;
  if (Math.abs(nowMs - tsMs) > (opts.toleranceMs ?? WEBHOOK_TOLERANCE_MS))
    return { ok: false, reason: 'stale-timestamp' };

  const expected = signWebhook(secret, Number(timestamp), rawBody);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.trim());
  // Constant-time comparison; length is not secret (fixed format), content is.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad-signature' };
  return { ok: true, nonce: expected };
}
