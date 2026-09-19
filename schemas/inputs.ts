import type { JsonObject } from '../core/index.ts';
import type { InputSpec } from './manifest.ts';

/** Default upper bound applied to string inputs that declare none, so no input is unbounded. */
export const DEFAULT_MAX_STRING_INPUT = 100_000;

/**
 * Convert the manifest's compact `inputs` section into a closed JSON Schema for the run's input
 * object. Defaults are applied by the validator; unknown inputs are rejected.
 */
export function inputsToJsonSchema(inputs: Record<string, InputSpec>): JsonObject {
  const properties: JsonObject = {};
  const required: string[] = [];
  for (const [name, spec] of Object.entries(inputs)) {
    const { required: isRequired, sensitivity: _sensitivity, ...schema } = spec;
    const prop: JsonObject = { ...(schema as JsonObject) };
    if (spec.type === 'string' && prop.maxLength === undefined) {
      prop.maxLength = DEFAULT_MAX_STRING_INPUT;
    }
    properties[name] = prop;
    if (isRequired === true && spec.default === undefined) required.push(name);
  }
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}
