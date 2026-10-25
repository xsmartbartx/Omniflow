import { canonicalize } from '../canonical.ts';
import { ExpressionError, type Node } from './ast.ts';
import { FUNCTIONS, type FunctionContext } from './functions.ts';

export interface EvalOptions extends FunctionContext {
  /** Maximum number of AST nodes evaluated; guards against pathological expressions. */
  maxSteps?: number;
}

export const DEFAULT_MAX_STEPS = 20_000;
const MAX_STRING = 1_000_000;

/** JS-like truthiness restricted to JSON: `false`, `null`, `0`, `NaN` and `""` are falsy. */
export function isTruthy(v: unknown): boolean {
  return !(v === false || v === null || v === undefined || v === 0 || v === '' || Number.isNaN(v));
}

const isNum = (v: unknown): v is number => typeof v === 'number';
const isStr = (v: unknown): v is string => typeof v === 'string';

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) {
    return (a ?? null) === (b ?? null);
  }
  if (typeof a === 'object' && typeof b === 'object') return canonicalize(a) === canonicalize(b);
  return false;
}

function describeType(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * Evaluate a parsed expression against `scope`. Missing properties read as `null`
 * (safe navigation); referencing a root identifier that is not in scope is an error.
 */
export function evaluate(node: Node, scope: Record<string, unknown>, options: EvalOptions = {}): unknown {
  let budget = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const fnCtx: FunctionContext = options.seed === undefined ? {} : { seed: options.seed };

  const ev = (n: Node): unknown => {
    if (--budget < 0) {
      throw new ExpressionError('EXPR_BUDGET', 'Expression evaluation budget exceeded', n.pos);
    }
    switch (n.type) {
      case 'literal':
        return n.value;
      case 'ident':
        return readIdentifier(scope, n.name, n.pos);
      case 'member':
        return readProperty(ev(n.object), n.property);
      case 'index':
        return readIndex(ev(n.object), ev(n.index));
      case 'call':
        return callFunction(n.name, n.args.map(ev), fnCtx, n.pos);
      case 'unary':
        return unary(n.op, ev(n.arg), n.pos);
      case 'logical': {
        const left = ev(n.left);
        if (n.op === '&&') return isTruthy(left) ? ev(n.right) : left;
        if (n.op === '||') return isTruthy(left) ? left : ev(n.right);
        return left ?? ev(n.right);
      }
      case 'cond':
        return isTruthy(ev(n.test)) ? ev(n.consequent) : ev(n.alternate);
      case 'array':
        return n.items.map(ev);
      case 'binary':
        return binary(n.op, ev(n.left), ev(n.right), n.pos);
    }
  };

  return ev(node);
}

function readIdentifier(scope: Record<string, unknown>, name: string, pos: number): unknown {
  if (!Object.hasOwn(scope, name)) {
    throw new ExpressionError('EXPR_UNKNOWN_IDENT', `Unknown identifier '${name}'`, pos);
  }
  return scope[name] ?? null;
}

function readIndex(obj: unknown, idx: unknown): unknown {
  if (Array.isArray(obj)) {
    return isNum(idx) && Number.isInteger(idx) && idx >= 0 ? (obj[idx] ?? null) : null;
  }
  if (isStr(idx) || isNum(idx)) return readProperty(obj, String(idx));
  return null;
}

function callFunction(name: string, args: unknown[], ctx: FunctionContext, pos: number): unknown {
  const spec = Object.hasOwn(FUNCTIONS, name) ? FUNCTIONS[name] : undefined;
  if (!spec) throw new ExpressionError('EXPR_UNKNOWN_FUNCTION', `Unknown function '${name}'`, pos);
  const result = spec.fn(args, ctx);
  return result === undefined ? null : result;
}

function unary(op: string, v: unknown, pos: number): unknown {
  if (op === '!') return !isTruthy(v);
  if (!isNum(v)) throw new ExpressionError('EXPR_TYPE', `Cannot negate a ${describeType(v)}`, pos);
  return -v;
}

function readProperty(obj: unknown, prop: string): unknown {
  if (obj === null || obj === undefined) return null;
  if (Array.isArray(obj)) return prop === 'length' ? obj.length : null;
  if (typeof obj === 'string') return prop === 'length' ? obj.length : null;
  if (typeof obj === 'object' && Object.hasOwn(obj as object, prop)) {
    return (obj as Record<string, unknown>)[prop] ?? null;
  }
  return null;
}

function binary(op: string, l: unknown, r: unknown, pos: number): unknown {
  switch (op) {
    case '==':
      return deepEqual(l, r);
    case '!=':
      return !deepEqual(l, r);
    case '<':
    case '<=':
    case '>':
    case '>=':
      return compare(op, l, r, pos);
    case 'in':
      return contains(l, r);
    case '+':
      return add(l, r, pos);
    case '-':
    case '*':
    case '/':
    case '%':
      return arithmetic(op, l, r, pos);
    default:
      throw new ExpressionError('EXPR_SYNTAX', `Unknown operator '${op}'`, pos);
  }
}

function compare(op: string, l: unknown, r: unknown, pos: number): boolean {
  if (l === null || l === undefined || r === null || r === undefined) return false;
  if ((isNum(l) && isNum(r)) || (isStr(l) && isStr(r))) {
    if (op === '<') return l < r;
    if (op === '<=') return l <= r;
    if (op === '>') return l > r;
    return l >= r;
  }
  throw new ExpressionError(
    'EXPR_TYPE',
    `Cannot compare ${describeType(l)} with ${describeType(r)} using '${op}'`,
    pos,
  );
}

/** `l in r`: membership in an array, substring of a string, or key of an object. */
function contains(l: unknown, r: unknown): boolean {
  if (Array.isArray(r)) return r.some((x) => deepEqual(x, l));
  if (isStr(r)) return isStr(l) && r.includes(l);
  if (r !== null && typeof r === 'object') return isStr(l) && Object.hasOwn(r as object, l);
  return false;
}

function add(l: unknown, r: unknown, pos: number): unknown {
  if (isNum(l) && isNum(r)) return l + r;
  if (isStr(l) && isStr(r)) {
    if (l.length + r.length > MAX_STRING) throw new ExpressionError('EXPR_BUDGET', 'string too long', pos);
    return l + r;
  }
  throw new ExpressionError(
    'EXPR_TYPE',
    `Cannot add ${describeType(l)} and ${describeType(r)} — use toString() to build strings`,
    pos,
  );
}

function arithmetic(op: string, l: unknown, r: unknown, pos: number): number {
  if (!isNum(l) || !isNum(r)) {
    throw new ExpressionError(
      'EXPR_TYPE',
      `Operator '${op}' needs numbers, got ${describeType(l)} and ${describeType(r)}`,
      pos,
    );
  }
  if ((op === '/' || op === '%') && r === 0) throw new ExpressionError('EXPR_DIV_ZERO', 'Division by zero', pos);
  if (op === '-') return l - r;
  if (op === '*') return l * r;
  if (op === '/') return l / r;
  return l % r;
}
