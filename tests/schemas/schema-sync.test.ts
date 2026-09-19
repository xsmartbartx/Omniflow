import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildManifestSchema, inputsToJsonSchema } from '../../schemas/index.ts';

describe('emitted schemas', () => {
  it('manifest.schema.json matches its generator (run `node scripts/emit-schemas.ts`)', () => {
    const onDisk = JSON.parse(
      readFileSync(new URL('../../schemas/manifest.schema.json', import.meta.url), 'utf8'),
    );
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(buildManifestSchema())));
  });
});

describe('inputsToJsonSchema', () => {
  it('builds a closed schema with required list and bounded strings', () => {
    const schema = inputsToJsonSchema({
      id: { type: 'string', required: true, sensitivity: 'internal' },
      n: { type: 'integer', default: 3 },
      flag: { type: 'boolean', required: true, default: false },
    }) as any;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['id']); // has-default inputs are never "required"
    expect(schema.properties.id.maxLength).toBeGreaterThan(0);
    expect(schema.properties.id.sensitivity).toBeUndefined();
    expect(schema.properties.n.default).toBe(3);
  });
});
