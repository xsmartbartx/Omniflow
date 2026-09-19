import type { JsonObject, JsonValue } from '../../core/index.ts';

/**
 * Build a minimal, valid example from a JSON Schema. Used as the synthetic result of a dry-run
 * step whose capability declares `dryRun: 'simulate'` and provides no hand-written simulation.
 * Deterministic: the same schema always yields the same example.
 */
export function exampleFromSchema(schema: unknown, depth = 0): JsonValue {
  if (schema === null || typeof schema !== 'object' || depth > 8) return null;
  const s = schema as JsonObject;
  if ('const' in s) return s.const as JsonValue;
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0] as JsonValue;
  if (s.default !== undefined) return s.default as JsonValue;
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  switch (type) {
    case 'string':
      return typeof s.minLength === 'number' && s.minLength > 0 ? 'x'.repeat(s.minLength) : '';
    case 'integer':
    case 'number':
      return typeof s.minimum === 'number' ? s.minimum : 0;
    case 'boolean':
      return false;
    case 'null':
      return null;
    case 'array': {
      const min = typeof s.minItems === 'number' ? s.minItems : 0;
      return Array.from({ length: min }, () => exampleFromSchema(s.items, depth + 1));
    }
    case 'object': {
      const out: JsonObject = {};
      const props = (s.properties ?? {}) as JsonObject;
      const required = new Set((s.required as string[] | undefined) ?? []);
      for (const [k, v] of Object.entries(props)) {
        if (required.has(k) || (v as JsonObject)?.default !== undefined) {
          out[k] = exampleFromSchema(v, depth + 1);
        }
      }
      return out;
    }
    default:
      return null;
  }
}
