export interface ParsedArgs {
  /** Words before the first flag, e.g. `['run', 'nightly-report']`. */
  positionals: string[];
  flags: Map<string, string[]>;
}

/** Flags that never take a value. */
const BOOLEAN = new Set([
  'json',
  'dry-run',
  'wait',
  'help',
  'version',
  'force',
  'no-color',
  'remote',
  'yes',
  'quiet',
  'follow',
  'stdin',
]);

/**
 * Minimal, dependency-free argument parser: `--flag`, `--flag value`, `--flag=value`, repeated flags,
 * `-h`/`-v` shorthands and `--` to stop parsing.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  const push = (k: string, v: string) => flags.set(k, [...(flags.get(k) ?? []), v]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a === '-h') push('help', 'true');
    else if (a === '-v') push('version', 'true');
    else if (a.startsWith('--')) {
      const { name, value, consumedNext } = parseLongFlag(a, argv[i + 1]);
      push(name, value);
      if (consumedNext) i++;
    } else positionals.push(a);
  }
  return { positionals, flags };
}

/** One `--name`, `--name=value` or `--name value` token; `next` is the following argument, if any. */
function parseLongFlag(
  token: string,
  next: string | undefined,
): { name: string; value: string; consumedNext: boolean } {
  const eq = token.indexOf('=');
  if (eq > 0) return { name: token.slice(2, eq), value: token.slice(eq + 1), consumedNext: false };
  const name = token.slice(2);
  if (BOOLEAN.has(name) || next === undefined || next.startsWith('--'))
    return { name, value: 'true', consumedNext: false };
  return { name, value: next, consumedNext: true };
}

export const flag = (a: ParsedArgs, name: string): string | undefined => a.flags.get(name)?.at(-1);

/** `?name=value` (URL-encoded) when the flag is set, otherwise nothing. */
export const queryFlag = (a: ParsedArgs, name: string): string => {
  const value = flag(a, name);
  return value ? `?${name}=${encodeURIComponent(value)}` : '';
};
export const flagAll = (a: ParsedArgs, name: string): string[] => a.flags.get(name) ?? [];
export const has = (a: ParsedArgs, name: string): boolean => a.flags.has(name);
export function intFlag(a: ParsedArgs, name: string): number | undefined {
  const v = flag(a, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new UsageError(`--${name} must be an integer (got '${v}')`);
  return n;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Parse `key=value` pairs; values that are valid JSON (numbers, booleans, objects, arrays) are decoded. */
export function parseInputs(pairs: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i <= 0) throw new UsageError(`--input expects key=value (got '${p}')`);
    const key = p.slice(0, i);
    const raw = p.slice(i + 1);
    let value: unknown = raw;
    if (/^(-?\d+(\.\d+)?|true|false|null|\[.*\]|\{.*\})$/s.test(raw)) {
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
    }
    if (key === '__proto__' || key === 'constructor') throw new UsageError(`Invalid input name '${key}'`);
    out[key] = value;
  }
  return out;
}
