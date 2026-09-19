import { createHash } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { CapabilityDeclaration } from '../../../schemas/index.ts';
import { type CapabilityAdapter, CapabilityError } from '../../contract/types.ts';
import type { AdapterConfig } from '../config.ts';
import { safeRequest } from '../http/safe-http.ts';

export type ChatFormat = 'slack' | 'teams' | 'discord' | 'generic';

function bodyFor(format: ChatFormat, text: string, payload?: unknown): string {
  if (payload !== undefined) return JSON.stringify(payload);
  if (format === 'discord') return JSON.stringify({ content: text.slice(0, 2000) });
  return JSON.stringify({ text });
}

function classifyStatus(status: number): CapabilityError | null {
  if (status >= 200 && status < 300) return null;
  if (status === 429 || status >= 500) return new CapabilityError('NOTIFY_UNAVAILABLE', `The notification service responded ${status}`, { errorClass: 'transient', retryable: true, details: { status } });
  if (status === 401 || status === 403 || status === 404) return new CapabilityError('NOTIFY_REJECTED', `The notification endpoint rejected the request (${status}); check the webhook URL`, { errorClass: 'authorisation', retryable: false, details: { status } });
  return new CapabilityError('NOTIFY_FAILED', `The notification service responded ${status}`, { errorClass: 'business', retryable: false, details: { status } });
}

function hostPort(url: string): string {
  const u = new URL(url);
  return `${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
}

/** Parse a channel definition: `https://…` (Slack-style) or `teams:https://…`, `discord:https://…`, `generic:https://…`. */
export function parseChannel(def: string): { format: ChatFormat; url: string } {
  const m = /^(slack|teams|discord|generic):(https?:\/\/.+)$/i.exec(def);
  return m ? { format: m[1]!.toLowerCase() as ChatFormat, url: m[2]! } : { format: 'slack', url: def };
}

/** Send a chat/webhook message to an operator-configured channel. Used by `notify-channel` and by alerting. */
export async function sendToChannel(config: AdapterConfig, channel: string, text: string, signal: AbortSignal = AbortSignal.timeout(15_000)): Promise<void> {
  const def = config.channels[channel];
  if (!def) throw new CapabilityError('NOTIFY_UNKNOWN_CHANNEL', `Channel '${channel}' is not configured (available: ${Object.keys(config.channels).join(', ') || 'none'})`, { errorClass: 'contract', retryable: false });
  const { format, url } = parseChannel(def);
  const res = await safeRequest({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', 'user-agent': config.http.userAgent },
    body: bodyFor(format, text),
    signal,
    allowedHosts: [hostPort(url)],
    allowPrivate: config.allowPrivateNetworks,
    maxResponseBytes: 64 * 1024,
    maxRedirects: 0,
    timeoutMs: 15_000,
    followRedirects: false,
  });
  const err = classifyStatus(res.status);
  if (err) throw err;
}

const failureModes = [
  { code: 'NOTIFY_UNAVAILABLE', class: 'transient' as const, retryable: true },
  { code: 'NOTIFY_REJECTED', class: 'authorisation' as const, retryable: false },
  { code: 'NOTIFY_FAILED', class: 'business' as const, retryable: false },
  { code: 'NOTIFY_UNKNOWN_CHANNEL', class: 'contract' as const, retryable: false },
  { code: 'EGRESS_DENIED', class: 'authorisation' as const, retryable: false },
  { code: 'EMAIL_REJECTED', class: 'business' as const, retryable: false },
  { code: 'EMAIL_UNAVAILABLE', class: 'transient' as const, retryable: true },
];

export function createWebhookNotifier(config: AdapterConfig): CapabilityAdapter[] {
  const webhook: CapabilityAdapter = {
    declaration: {
      name: 'notify-webhook',
      version: '1.0.0',
      family: 'notification',
      description: 'Post a message to a chat or generic webhook URL (Slack, Teams, Discord or raw JSON). The destination host must be in the step’s egress allow-list.',
      inputSchema: {
        type: 'object',
        required: ['url'],
        additionalProperties: false,
        properties: {
          url: { type: 'string', minLength: 8, maxLength: 2048 },
          text: { type: 'string', maxLength: 10_000 },
          payload: {},
          format: { enum: ['slack', 'teams', 'discord', 'generic'], default: 'slack' },
        },
      },
      outputSchema: { type: 'object', required: ['status', 'ok'], properties: { status: { type: 'integer' }, ok: { type: 'boolean' } }, additionalProperties: false },
      effect: 'effectful',
      scopes: ['network:http'],
      egress: { mode: 'step' },
      costModel: { unitsPerInvocation: 1, latencyClass: 'fast' },
      failureModes,
      dataClassification: 'internal',
      dryRun: 'simulate',
    } as CapabilityDeclaration,
    simulate: () => ({ status: 200, ok: true }),
    async execute(ctx, input: { url: string; text?: string; payload?: unknown; format?: ChatFormat }) {
      if (ctx.egress.length === 0) throw new CapabilityError('EGRESS_DENIED', "This step must declare 'egress' hosts", { errorClass: 'authorisation', retryable: false });
      const res = await safeRequest({
        method: 'POST',
        url: input.url,
        headers: { 'content-type': 'application/json', 'user-agent': config.http.userAgent, ...(ctx.idempotencyKey ? { 'idempotency-key': ctx.idempotencyKey } : {}) },
        body: bodyFor(input.format ?? 'slack', input.text ?? '', input.payload),
        signal: ctx.signal,
        allowedHosts: ctx.egress,
        allowPrivate: config.allowPrivateNetworks,
        maxResponseBytes: 64 * 1024,
        maxRedirects: 0,
        timeoutMs: 15_000,
        followRedirects: false,
      });
      const err = classifyStatus(res.status);
      if (err) throw err;
      return { status: res.status, ok: true };
    },
  };
  return [webhook];
}

export function createChannelNotifier(config: AdapterConfig): CapabilityAdapter[] {
  const channel: CapabilityAdapter = {
    declaration: {
      name: 'notify-channel',
      version: '1.0.0',
      family: 'notification',
      description: `Send a message to an operator-configured channel (${Object.keys(config.channels).join(', ') || 'none configured'}). The webhook URL is held by the platform, never in the workflow.`,
      inputSchema: {
        type: 'object',
        required: ['channel', 'text'],
        additionalProperties: false,
        properties: { channel: { type: 'string', minLength: 1, maxLength: 64 }, text: { type: 'string', minLength: 1, maxLength: 10_000 }, severity: { enum: ['info', 'warning', 'error'], default: 'info' } },
      },
      outputSchema: { type: 'object', required: ['sent'], properties: { sent: { type: 'boolean' } }, additionalProperties: false },
      effect: 'effectful',
      scopes: ['network:http'],
      egress: { mode: 'none' },
      costModel: { unitsPerInvocation: 1, latencyClass: 'fast' },
      failureModes,
      dataClassification: 'internal',
      dryRun: 'simulate',
    } as CapabilityDeclaration,
    simulate: () => ({ sent: true }),
    async execute(ctx, input: { channel: string; text: string; severity?: string }) {
      const prefix = input.severity === 'error' ? '🔴 ' : input.severity === 'warning' ? '🟠 ' : '';
      await sendToChannel(config, input.channel, `${prefix}${input.text}`, ctx.signal);
      return { sent: true };
    },
  };
  return [channel];
}

export function createEmailNotifier(config: AdapterConfig): CapabilityAdapter[] {
  const smtp = config.email.smtpUrl;
  if (!smtp) return [];
  // `json:` is a development sink: messages are built but not sent, and returned in the output.
  const transport = smtp === 'json:' ? nodemailer.createTransport({ jsonTransport: true }) : nodemailer.createTransport(smtp);
  const email: CapabilityAdapter = {
    declaration: {
      name: 'notify-email',
      version: '1.0.0',
      family: 'notification',
      description: 'Send an email through the platform’s configured SMTP relay.',
      inputSchema: {
        type: 'object',
        required: ['to', 'subject'],
        additionalProperties: false,
        properties: {
          to: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', format: 'email', maxLength: 254 } },
          subject: { type: 'string', minLength: 1, maxLength: 300, pattern: '^[^\\r\\n]*$' },
          text: { type: 'string', maxLength: 500_000 },
          html: { type: 'string', maxLength: 500_000 },
          replyTo: { type: 'string', format: 'email', maxLength: 254 },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['messageId', 'accepted', 'rejected'],
        properties: { messageId: { type: 'string' }, accepted: { type: 'array', items: { type: 'string' } }, rejected: { type: 'array', items: { type: 'string' } } },
        additionalProperties: false,
      },
      effect: 'effectful',
      scopes: ['smtp:send'],
      egress: { mode: 'none' },
      costModel: { unitsPerInvocation: 1, latencyClass: 'slow' },
      failureModes,
      dataClassification: 'confidential',
      dryRun: 'simulate',
    } as CapabilityDeclaration,
    simulate: (_ctx, input: { to: string[] }) => ({ messageId: '<dry-run@omniflow.local>', accepted: input.to, rejected: [] }),
    async execute(ctx, input: { to: string[]; subject: string; text?: string; html?: string; replyTo?: string }) {
      // A stable Message-ID derived from the idempotency key lets receiving systems collapse duplicates.
      const messageId = ctx.idempotencyKey ? `<${createHash('sha256').update(ctx.idempotencyKey).digest('hex').slice(0, 32)}@omniflow.local>` : undefined;
      try {
        const info = await transport.sendMail({
          from: config.email.from ?? 'omniflow@localhost',
          to: input.to,
          subject: input.subject,
          ...(input.text ? { text: input.text } : {}),
          ...(input.html ? { html: input.html } : {}),
          ...(input.replyTo ? { replyTo: input.replyTo } : {}),
          ...(messageId ? { messageId } : {}),
          headers: { 'X-OmniFlow-Run': ctx.runId, ...(ctx.idempotencyKey ? { 'X-OmniFlow-Idempotency-Key': ctx.idempotencyKey } : {}) },
        });
        return { messageId: String(info.messageId ?? messageId ?? ''), accepted: (info.accepted ?? input.to).map(String), rejected: (info.rejected ?? []).map(String) };
      } catch (e) {
        const err = e as { responseCode?: number; code?: string; message?: string };
        const code = err.responseCode ?? 0;
        if (code >= 500 || (code >= 400 && code < 500) || ['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'ECONNRESET', 'EDNS'].includes(err.code ?? '')) {
          throw new CapabilityError(code >= 500 ? 'EMAIL_REJECTED' : 'EMAIL_UNAVAILABLE', `SMTP: ${(err.message ?? 'send failed').slice(0, 200)}`, {
            errorClass: code >= 500 ? 'business' : 'transient',
            retryable: code < 500,
          });
        }
        throw new CapabilityError('EMAIL_UNAVAILABLE', `SMTP: ${(err.message ?? 'send failed').slice(0, 200)}`, { errorClass: 'transient', retryable: true });
      }
    },
  };
  return [email];
}
