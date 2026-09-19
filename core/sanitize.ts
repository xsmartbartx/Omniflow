/**
 * Sanitisation and redaction (architecture §10.1, `data-flow` rules).
 *
 * The Sanitizer normalises and redacts; it never rejects — rejection is the Validator's job.
 * Everything that reaches the event log, the state store or a log line passes through here, on the
 * error paths as well as the success paths (risk R10).
 */

export const SENSITIVITY_LEVELS = ['public', 'internal', 'confidential', 'secret'] as const;
export type Sensitivity = (typeof SENSITIVITY_LEVELS)[number];

export function sensitivityRank(level: Sensitivity): number {
  return SENSITIVITY_LEVELS.indexOf(level);
}

export function maxSensitivity(a: Sensitivity, b: Sensitivity): Sensitivity {
  return sensitivityRank(a) >= sensitivityRank(b) ? a : b;
}

export function isSensitivity(value: unknown): value is Sensitivity {
  return typeof value === 'string' && (SENSITIVITY_LEVELS as readonly string[]).includes(value);
}

export const REDACTED = '[REDACTED]';

/** Object keys whose values are never logged. */
const SENSITIVE_KEY =
  /(pass(word|wd|phrase)?|secret|token|api[-_]?key|apikey|authorization|auth[-_]?header|cookie|credential|private[-_]?key|bearer|signature|client[-_]?secret|connection[-_]?string|dsn)/i;

/** Value patterns recognisable as credentials wherever they appear in free text. */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@\S+/gi,
  /\bomf_[A-Za-z0-9]{6,}_[A-Za-z0-9_-]{20,}\b/g,
];

export interface RedactOptions {
  /** Exact secret values known to the caller (e.g. a lease) — scrubbed wherever they appear. */
  secretValues?: Iterable<string>;
  maxDepth?: number;
  maxString?: number;
  maxArray?: number;
  maxKeys?: number;
}

const DEFAULTS = { maxDepth: 12, maxString: 8192, maxArray: 200, maxKeys: 200 };

// Control characters (except \t \n \r) and invisible bidirectional-override characters used for
// log forging and "Trojan Source" attacks.
const CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}${String.fromCharCode(12)}${String.fromCharCode(14)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  'g',
);
const BIDI_AND_ZERO_WIDTH = /[​-‏‪-‮⁦-⁩﻿]/g;

/** Remove characters that enable log forging and "Trojan Source" attacks; normalise to NFC. */
export function sanitizeText(text: string): string {
  return text.normalize('NFC').replace(CONTROL_CHARS, '').replace(BIDI_AND_ZERO_WIDTH, '');
}

export function scrubString(text: string, options: RedactOptions = {}): string {
  const max = options.maxString ?? DEFAULTS.maxString;
  let out = sanitizeText(text);
  if (options.secretValues) {
    for (const secret of options.secretValues) {
      if (secret.length >= 4) out = out.split(secret).join(REDACTED);
    }
  }
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  if (out.length > max) out = `${out.slice(0, max)}…[truncated ${out.length - max} chars]`;
  return out;
}

/**
 * Deep, bounded, cycle-safe copy of `value` with sensitive keys and credential-shaped strings
 * replaced by `[REDACTED]`. Safe to persist or log.
 */
export function redact(value: unknown, options: RedactOptions = {}): unknown {
  const opts = { ...DEFAULTS, ...options };
  const secretList = options.secretValues ? [...options.secretValues] : [];
  const seen = new WeakSet<object>();

  const walk = (v: unknown, depth: number, keyHint?: string): unknown => {
    if (keyHint !== undefined && SENSITIVE_KEY.test(keyHint) && v !== null && v !== undefined) {
      return typeof v === 'boolean' || typeof v === 'number' ? v : REDACTED;
    }
    if (typeof v === 'string') return scrubString(v, { ...opts, secretValues: secretList });
    if (v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'function' || typeof v === 'symbol') return undefined;
    if (v instanceof Date) return v.toISOString();
    if (v instanceof Error) {
      return {
        name: v.name,
        message: scrubString(v.message, { ...opts, secretValues: secretList }),
      };
    }
    if (typeof v === 'object') {
      if (seen.has(v)) return '[Circular]';
      if (depth >= opts.maxDepth) return '[MaxDepth]';
      seen.add(v);
      if (Array.isArray(v)) {
        const items = v.slice(0, opts.maxArray).map((x) => walk(x, depth + 1));
        if (v.length > opts.maxArray) items.push(`…[${v.length - opts.maxArray} more items]`);
        return items;
      }
      const out: Record<string, unknown> = {};
      let n = 0;
      for (const [k, x] of Object.entries(v)) {
        if (n++ >= opts.maxKeys) {
          out['…'] = 'truncated';
          break;
        }
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        out[sanitizeText(k)] = walk(x, depth + 1, k);
      }
      return out;
    }
    return undefined;
  };
  return walk(value, 0);
}

/** Convenience for the common case of redacting an error message. */
export function redactMessage(message: string, options: RedactOptions = {}): string {
  return scrubString(message, options);
}
