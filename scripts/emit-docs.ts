// Generates the reference docs that come straight from the code, so they cannot drift:
//   npm run docs:generate            (writes)   ·   npm run docs:generate -- --check   (CI: fails if stale)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTPUTS } from './docs-outputs.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
let stale = 0;
for (const [file, content] of Object.entries(OUTPUTS)) {
  const path = join(root, file);
  if (check) {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== content) {
      console.error(`${file} is out of date. Run: npm run docs:generate`);
      stale++;
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    console.log(`wrote ${file}`);
  }
}
if (check) {
  if (stale) process.exit(1);
  console.log('generated docs are up to date');
}
