import type { JsonObject } from '../../core/index.ts';
import type { Step } from '../../schemas/manifest.ts';

/** Whether a property path can exist in a value described by `schema`. `unknown` = cannot tell. */
export type PathVerdict = 'yes' | 'no' | 'unknown';

export function schemaHasPath(schema: unknown, path: readonly string[]): PathVerdict {
  if (path.length === 0) return 'yes';
  if (schema === null || typeof schema !== 'object') return 'unknown';
  const s = schema as JsonObject;
  if (s.oneOf || s.anyOf || s.allOf || s.$ref || s.if) return 'unknown';

  const type = Array.isArray(s.type) ? s.type : s.type === undefined ? [] : [s.type];
  const [seg, ...rest] = path as [string, ...string[]];

  if (type.includes('array') && !type.includes('object')) {
    if (seg === 'length') return rest.length === 0 ? 'yes' : 'no';
    if (/^\d+$/.test(seg)) return schemaHasPath(s.items, rest);
    return 'no';
  }
  const props = s.properties as JsonObject | undefined;
  if (props && Object.hasOwn(props, seg)) return schemaHasPath(props[seg], rest);
  const additional = s.additionalProperties;
  if (additional !== null && typeof additional === 'object') return schemaHasPath(additional, rest);
  if (props && additional === false) return 'no';
  if (type.length === 1 && ['string', 'integer', 'number', 'boolean', 'null'].includes(type[0] as string)) {
    return seg === 'length' && type[0] === 'string' && rest.length === 0 ? 'yes' : 'no';
  }
  return 'unknown';
}

const OBJ = 'object';

/**
 * JSON Schema of what a step publishes as `steps.<id>.output`, or `undefined` when unknown.
 * For `map`, `produces` (or the body capability's output schema) describes each *item* result.
 */
export function stepOutputSchema(step: Step, capabilityOutput?: JsonObject): JsonObject | undefined {
  switch (step.type) {
    case 'capability':
      return step.produces ?? capabilityOutput;
    case 'map': {
      const item = step.produces ?? capabilityOutput;
      return {
        type: OBJ,
        required: ['results', 'failures', 'count'],
        properties: {
          results: { type: 'array', ...(item ? { items: item } : {}) },
          failures: {
            type: 'array',
            items: {
              type: OBJ,
              properties: { index: { type: 'integer' }, error: { type: OBJ } },
            },
          },
          count: { type: 'integer' },
        },
        additionalProperties: false,
      };
    }
    case 'branch':
      return {
        type: OBJ,
        required: ['case'],
        properties: { case: { type: 'string' } },
        additionalProperties: false,
      };
    case 'parallel':
      return {
        type: OBJ,
        required: ['results'],
        properties: { results: { type: OBJ } },
        additionalProperties: false,
      };
    case 'approval':
      return {
        type: OBJ,
        required: ['decision'],
        properties: {
          decision: { enum: ['approved', 'denied'] },
          by: { type: 'string' },
          comment: { type: 'string' },
          decidedAt: { type: 'string' },
          timedOut: { type: 'boolean' },
        },
        additionalProperties: false,
      };
    case 'wait':
      return step.until
        ? {
            type: OBJ,
            required: ['event'],
            properties: { event: { type: 'string' }, payload: {} },
            additionalProperties: false,
          }
        : {
            type: OBJ,
            properties: { waitedMs: { type: 'integer' } },
            additionalProperties: false,
          };
    case 'subworkflow':
      return {
        type: OBJ,
        required: ['runId', 'outputs'],
        properties: { runId: { type: 'string' }, outputs: { type: OBJ } },
        additionalProperties: false,
      };
    default:
      return undefined;
  }
}
