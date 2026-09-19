/**
 * Expression language AST.
 *
 * The language is deliberately NOT Turing-complete (ADR-0002 D1): there are no loops, no user
 * functions, no recursion, no assignment, and no way to call anything except a fixed whitelist of
 * pure functions. Evaluation cost is bounded by the size of the expression.
 */

export type BinaryOp =
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'in';

export type Node =
  | { type: 'literal'; value: string | number | boolean | null; pos: number }
  | { type: 'ident'; name: string; pos: number }
  | { type: 'member'; object: Node; property: string; pos: number }
  | { type: 'index'; object: Node; index: Node; pos: number }
  | { type: 'call'; name: string; args: Node[]; pos: number }
  | { type: 'unary'; op: '!' | '-'; arg: Node; pos: number }
  | { type: 'binary'; op: BinaryOp; left: Node; right: Node; pos: number }
  | { type: 'logical'; op: '&&' | '||' | '??'; left: Node; right: Node; pos: number }
  | { type: 'cond'; test: Node; then: Node; else: Node; pos: number }
  | { type: 'array'; items: Node[]; pos: number };

export class ExpressionError extends Error {
  readonly code: string;
  readonly pos: number;
  constructor(code: string, message: string, pos = 0) {
    super(message);
    this.name = 'ExpressionError';
    this.code = code;
    this.pos = pos;
  }
}

export class ExpressionSyntaxError extends ExpressionError {
  constructor(message: string, pos: number) {
    super('EXPR_SYNTAX', message, pos);
    this.name = 'ExpressionSyntaxError';
  }
}

/** Depth-first visit of every node. */
export function visit(node: Node, cb: (n: Node) => void): void {
  cb(node);
  switch (node.type) {
    case 'member':
      visit(node.object, cb);
      break;
    case 'index':
      visit(node.object, cb);
      visit(node.index, cb);
      break;
    case 'call':
      for (const a of node.args) visit(a, cb);
      break;
    case 'unary':
      visit(node.arg, cb);
      break;
    case 'binary':
    case 'logical':
      visit(node.left, cb);
      visit(node.right, cb);
      break;
    case 'cond':
      visit(node.test, cb);
      visit(node.then, cb);
      visit(node.else, cb);
      break;
    case 'array':
      for (const i of node.items) visit(i, cb);
      break;
    default:
      break;
  }
}

/** A statically-known data dependency, e.g. `steps.fetch.output.body.id`. */
export interface Reference {
  root: string;
  /** Static path segments after the root; stops at the first dynamic index. */
  path: string[];
  /** True when the access continues through a computed index. */
  dynamic: boolean;
  pos: number;
}

export function collectReferences(node: Node): Reference[] {
  const refs: Reference[] = [];

  const chain = (n: Node): Reference | null => {
    const segments: Array<{ kind: 'static'; name: string } | { kind: 'dynamic' }> = [];
    let cur: Node = n;
    for (;;) {
      if (cur.type === 'member') {
        segments.unshift({ kind: 'static', name: cur.property });
        cur = cur.object;
      } else if (cur.type === 'index') {
        if (cur.index.type === 'literal' && cur.index.value !== null) {
          segments.unshift({ kind: 'static', name: String(cur.index.value) });
        } else {
          segments.unshift({ kind: 'dynamic' });
        }
        cur = cur.object;
      } else {
        break;
      }
    }
    if (cur.type !== 'ident') return null;
    const path: string[] = [];
    let dynamic = false;
    for (const s of segments) {
      if (s.kind === 'dynamic') {
        dynamic = true;
        break;
      }
      path.push(s.name);
    }
    return { root: cur.name, path, dynamic, pos: cur.pos };
  };

  const walk = (n: Node): void => {
    if (n.type === 'member' || n.type === 'index' || n.type === 'ident') {
      const ref = chain(n);
      if (ref) refs.push(ref);
      // Still descend into computed indexes, whose expressions may reference other data.
      let cur: Node = n;
      while (cur.type === 'member' || cur.type === 'index') {
        if (cur.type === 'index' && !(cur.index.type === 'literal')) walk(cur.index);
        cur = cur.object;
      }
      if (cur.type !== 'ident') walk(cur);
      return;
    }
    switch (n.type) {
      case 'call':
        for (const a of n.args) walk(a);
        break;
      case 'unary':
        walk(n.arg);
        break;
      case 'binary':
      case 'logical':
        walk(n.left);
        walk(n.right);
        break;
      case 'cond':
        walk(n.test);
        walk(n.then);
        walk(n.else);
        break;
      case 'array':
        for (const i of n.items) walk(i);
        break;
      default:
        break;
    }
  };
  walk(node);
  return refs;
}

export function functionsUsed(node: Node): string[] {
  const names = new Set<string>();
  visit(node, (n) => {
    if (n.type === 'call') names.add(n.name);
  });
  return [...names];
}

export function nodeCount(node: Node): number {
  let n = 0;
  visit(node, () => {
    n++;
  });
  return n;
}
