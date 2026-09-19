/** JSON value types and small, dependency-free helpers shared by every layer. */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Read a nested value; returns `undefined` when any segment is missing. Never walks the prototype chain. */
export function getPath(root: unknown, path: ReadonlyArray<string | number>): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      if (typeof seg !== 'number' && !/^\d+$/.test(String(seg))) return undefined;
      cur = cur[Number(seg)];
    } else if (typeof cur === 'object') {
      if (!Object.hasOwn(cur as object, String(seg))) return undefined;
      cur = (cur as Record<string, unknown>)[String(seg)];
    } else {
      return undefined;
    }
  }
  return cur;
}

export function deepClone<T>(value: T): T {
  return structuredClone(value);
}

export function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** Approximate serialized size in bytes of a JSON-compatible value. */
export function jsonSize(value: unknown): number {
  return byteLength(JSON.stringify(value) ?? 'null');
}
