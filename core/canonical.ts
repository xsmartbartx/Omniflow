import { createHash } from 'node:crypto';

/**
 * Canonical JSON: object keys sorted lexicographically, no insignificant whitespace, `undefined`
 * object members omitted. Two structurally-equal values always serialise to the same bytes, which
 * is what makes plan hashes (ADR-0002 D2) and hash-chained audit records reproducible.
 */
export function canonicalize(value: unknown): string {
  return serialize(value, new Set());
}

function serialize(value: unknown, stack: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('Cannot canonicalise a non-finite number');
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return value.toString();
    case 'undefined':
      return 'null';
    case 'object': {
      const obj = value as object;
      if (stack.has(obj)) throw new TypeError('Cannot canonicalise a cyclic structure');
      stack.add(obj);
      try {
        if (Array.isArray(obj)) return `[${obj.map((v) => serialize(v, stack)).join(',')}]`;
        if (obj instanceof Date) return JSON.stringify(obj.toISOString());
        const record = obj as Record<string, unknown>;
        const keys = Object.keys(record)
          .filter((k) => record[k] !== undefined && typeof record[k] !== 'function')
          .sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${serialize(record[k], stack)}`).join(',')}}`;
      } finally {
        stack.delete(obj);
      }
    }
    default:
      throw new TypeError(`Cannot canonicalise a value of type ${typeof value}`);
  }
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Content address of any JSON-compatible value: `sha256:<64 hex>`. */
export function contentHash(value: unknown): string {
  return `sha256:${sha256Hex(canonicalize(value))}`;
}

export function isContentHash(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}
