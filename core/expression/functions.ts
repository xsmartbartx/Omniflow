import { canonicalize, sha256Hex } from '../canonical.ts';
import { deterministicUuid } from '../ids.ts';
import { parseDuration } from '../time.ts';
import { ExpressionError } from './ast.ts';

/**
 * The complete, fixed set of functions an expression may call. Every one is pure and total over
 * its declared input types: none reads the clock, the network, the filesystem or unseeded
 * randomness (determinism rules, architecture §6.5).
 */

export interface FunctionContext {
  /** Run seed — the only source of "randomness" (`uuid`). */
  seed?: string;
}

interface FunctionSpec {
  min: number;
  max: number;
  fn: (args: unknown[], ctx: FunctionContext) => unknown;
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isArr = (v: unknown): v is unknown[] => Array.isArray(v);
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function need<T>(name: string, v: unknown, guard: (x: unknown) => x is T, what: string): T {
  if (!guard(v)) throw new ExpressionError('EXPR_TYPE', `${name}() expects ${what}`);
  return v;
}

const MAX_STRING = 1_000_000;
function capString(s: string): string {
  if (s.length > MAX_STRING) throw new ExpressionError('EXPR_BUDGET', 'string too long');
  return s;
}

function display(v: unknown): string {
  if (isStr(v)) return v;
  if (v === null || v === undefined) return '';
  if (isNum(v) || typeof v === 'boolean') return String(v);
  return canonicalize(v);
}

export const FUNCTIONS: Record<string, FunctionSpec> = {
  // ---- collections & strings ----
  len: {
    min: 1,
    max: 1,
    fn: ([v]) => {
      if (v === null || v === undefined) return 0;
      if (isStr(v) || isArr(v)) return v.length;
      if (isObj(v)) return Object.keys(v).length;
      throw new ExpressionError('EXPR_TYPE', 'len() expects a string, array or object');
    },
  },
  lower: { min: 1, max: 1, fn: ([v]) => need('lower', v, isStr, 'a string').toLowerCase() },
  upper: { min: 1, max: 1, fn: ([v]) => need('upper', v, isStr, 'a string').toUpperCase() },
  trim: { min: 1, max: 1, fn: ([v]) => need('trim', v, isStr, 'a string').trim() },
  contains: {
    min: 2,
    max: 2,
    fn: ([hay, needle]) => {
      if (isStr(hay)) return isStr(needle) && hay.includes(needle);
      if (isArr(hay)) return hay.some((x) => canonicalize(x) === canonicalize(needle));
      return false;
    },
  },
  startsWith: {
    min: 2,
    max: 2,
    fn: ([s, p]) => need('startsWith', s, isStr, 'strings').startsWith(need('startsWith', p, isStr, 'strings')),
  },
  endsWith: {
    min: 2,
    max: 2,
    fn: ([s, p]) => need('endsWith', s, isStr, 'strings').endsWith(need('endsWith', p, isStr, 'strings')),
  },
  join: {
    min: 1,
    max: 2,
    fn: ([arr, sep]) =>
      capString(
        need('join', arr, isArr, 'an array')
          .map(display)
          .join(sep === undefined ? ',' : display(sep)),
      ),
  },
  split: {
    min: 2,
    max: 2,
    fn: ([s, sep]) => need('split', s, isStr, 'a string').split(need('split', sep, isStr, 'a string separator')),
  },
  replace: {
    min: 3,
    max: 3,
    fn: ([s, from, to]) =>
      capString(
        need('replace', s, isStr, 'a string')
          .split(need('replace', from, isStr, 'a string'))
          .join(need('replace', to, isStr, 'a string')),
      ),
  },
  slice: {
    min: 2,
    max: 3,
    fn: ([v, a, b]) => {
      const start = need('slice', a, isNum, 'numeric bounds');
      const end = b === undefined ? undefined : need('slice', b, isNum, 'numeric bounds');
      if (isStr(v) || isArr(v)) return v.slice(start, end);
      throw new ExpressionError('EXPR_TYPE', 'slice() expects a string or array');
    },
  },
  keys: { min: 1, max: 1, fn: ([v]) => (isObj(v) ? Object.keys(v).sort() : []) },
  values: {
    min: 1,
    max: 1,
    fn: ([v]) =>
      isObj(v)
        ? Object.keys(v)
            .sort()
            .map((k) => v[k])
        : [],
  },
  pluck: {
    min: 2,
    max: 2,
    fn: ([arr, key]) => {
      const k = need('pluck', key, isStr, 'a string key');
      return need('pluck', arr, isArr, 'an array').map((x) => (isObj(x) && Object.hasOwn(x, k) ? x[k] : null));
    },
  },
  first: { min: 1, max: 1, fn: ([v]) => (isArr(v) && v.length > 0 ? v[0] : null) },
  last: { min: 1, max: 1, fn: ([v]) => (isArr(v) && v.length > 0 ? v[v.length - 1] : null) },
  unique: {
    min: 1,
    max: 1,
    fn: ([v]) => {
      const seen = new Set<string>();
      const out: unknown[] = [];
      for (const x of need('unique', v, isArr, 'an array')) {
        const k = canonicalize(x);
        if (!seen.has(k)) {
          seen.add(k);
          out.push(x);
        }
      }
      return out;
    },
  },
  sort: {
    min: 1,
    max: 1,
    fn: ([v]) => {
      const arr = [...need('sort', v, isArr, 'an array')];
      if (arr.every(isNum)) return (arr as number[]).sort((a, b) => a - b);
      if (arr.every(isStr)) return (arr as string[]).sort();
      throw new ExpressionError('EXPR_TYPE', 'sort() expects an array of numbers or of strings');
    },
  },
  // ---- numbers ----
  sum: {
    min: 1,
    max: 1,
    fn: ([v]) => need('sum', v, isArr, 'an array').reduce<number>((a, x) => a + need('sum', x, isNum, 'numbers'), 0),
  },
  min: {
    min: 1,
    max: 1,
    fn: ([v]) => {
      const arr = need('min', v, isArr, 'an array');
      return arr.length === 0 ? null : Math.min(...arr.map((x) => need('min', x, isNum, 'numbers')));
    },
  },
  max: {
    min: 1,
    max: 1,
    fn: ([v]) => {
      const arr = need('max', v, isArr, 'an array');
      return arr.length === 0 ? null : Math.max(...arr.map((x) => need('max', x, isNum, 'numbers')));
    },
  },
  round: {
    min: 1,
    max: 2,
    fn: ([v, d]) => {
      const n = need('round', v, isNum, 'a number');
      const f = 10 ** (d === undefined ? 0 : need('round', d, isNum, 'digits as a number'));
      return Math.round(n * f) / f;
    },
  },
  floor: { min: 1, max: 1, fn: ([v]) => Math.floor(need('floor', v, isNum, 'a number')) },
  ceil: { min: 1, max: 1, fn: ([v]) => Math.ceil(need('ceil', v, isNum, 'a number')) },
  abs: { min: 1, max: 1, fn: ([v]) => Math.abs(need('abs', v, isNum, 'a number')) },
  // ---- conversion ----
  toNumber: {
    min: 1,
    max: 1,
    fn: ([v]) => {
      if (isNum(v)) return v;
      if (isStr(v) && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
      throw new ExpressionError('EXPR_TYPE', 'toNumber() could not convert the value');
    },
  },
  toString: { min: 1, max: 1, fn: (args: unknown[]) => capString(display(args[0])) },
  toJson: { min: 1, max: 1, fn: ([v]) => capString(canonicalize(v)) },
  fromJson: {
    min: 1,
    max: 1,
    fn: ([v]) => {
      try {
        return JSON.parse(need('fromJson', v, isStr, 'a string'));
      } catch {
        throw new ExpressionError('EXPR_TYPE', 'fromJson() received invalid JSON');
      }
    },
  },
  isNull: { min: 1, max: 1, fn: ([v]) => v === null || v === undefined },
  // ---- deterministic helpers ----
  hash: {
    min: 1,
    max: 1,
    fn: ([v]) => sha256Hex(isStr(v) ? v : canonicalize(v)),
  },
  uuid: {
    min: 0,
    max: 1,
    fn: ([label], ctx) => {
      if (!ctx.seed) throw new ExpressionError('EXPR_TYPE', 'uuid() needs a run seed');
      return deterministicUuid(ctx.seed, label === undefined ? '' : display(label));
    },
  },
  // ---- time as pure arithmetic over ISO timestamps (never reads the clock) ----
  dateAdd: {
    min: 2,
    max: 2,
    fn: ([iso, dur]) => {
      const t = Date.parse(need('dateAdd', iso, isStr, 'an ISO timestamp'));
      if (Number.isNaN(t)) throw new ExpressionError('EXPR_TYPE', 'dateAdd() received an invalid timestamp');
      const ms = typeof dur === 'number' ? dur : parseDuration(need('dateAdd', dur, isStr, 'a duration'));
      return new Date(t + ms).toISOString();
    },
  },
  date: {
    min: 1,
    max: 1,
    fn: ([iso]) => {
      const t = Date.parse(need('date', iso, isStr, 'an ISO timestamp'));
      if (Number.isNaN(t)) throw new ExpressionError('EXPR_TYPE', 'date() received an invalid timestamp');
      return new Date(t).toISOString().slice(0, 10);
    },
  },
  epochMs: {
    min: 1,
    max: 1,
    fn: ([iso]) => {
      const t = Date.parse(need('epochMs', iso, isStr, 'an ISO timestamp'));
      if (Number.isNaN(t)) throw new ExpressionError('EXPR_TYPE', 'epochMs() received an invalid timestamp');
      return t;
    },
  },
};

export const FUNCTION_NAMES: ReadonlySet<string> = new Set(Object.keys(FUNCTIONS));
