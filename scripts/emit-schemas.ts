#!/usr/bin/env node
/** Writes the generated JSON Schema files under `schemas/` for editor tooling and documentation. */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifestSchema } from '../schemas/manifest.schema.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
writeFileSync(
  resolve(root, 'schemas/manifest.schema.json'),
  `${JSON.stringify(buildManifestSchema(), null, 2)}\n`,
);
console.log('Wrote schemas/manifest.schema.json');
