import { type BinaryOp, ExpressionSyntaxError, type Node } from './ast.ts';
import { FUNCTIONS } from './functions.ts';

export const MAX_EXPRESSION_LENGTH = 4096;
const MAX_DEPTH = 48;
const MAX_ARRAY_LITERAL = 256;

type Token =
  | { type: 'num'; value: number; pos: number; end: number }
  | { type: 'str'; value: string; pos: number; end: number }
  | { type: 'ident'; value: string; pos: number; end: number }
  | { type: 'punct'; value: string; pos: number; end: number }
  | { type: 'eof'; value: ''; pos: number; end: number };

const PUNCT2 = ['&&', '||', '??', '==', '!=', '<=', '>='];
const PUNCT1 = '()[],.?:!-+*/%<>';

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    const start = i;
    const prev = tokens[tokens.length - 1];
    const afterDot = prev?.type === 'punct' && prev.value === '.';

    if (/[0-9]/.test(ch) && !afterDot) {
      const m = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(src.slice(i))!;
      i += m[0].length;
      tokens.push({ type: 'num', value: Number(m[0]), pos: start, end: i });
      continue;
    }
    // After a dot, a property name may contain hyphens (kebab-case step ids) and digits.
    if (afterDot && /[A-Za-z0-9_]/.test(ch)) {
      const m = /^[A-Za-z0-9_](?:[A-Za-z0-9_]|-(?=[A-Za-z0-9_]))*/.exec(src.slice(i))!;
      i += m[0].length;
      tokens.push({ type: 'ident', value: m[0], pos: start, end: i });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      i += m[0].length;
      tokens.push({ type: 'ident', value: m[0], pos: start, end: i });
      continue;
    }
    if (ch === "'" || ch === '"') {
      i++;
      let out = '';
      let closed = false;
      while (i < n) {
        const c = src[i]!;
        if (c === ch) {
          closed = true;
          i++;
          break;
        }
        if (c === '\\') {
          const e = src[i + 1];
          if (e === undefined) break;
          const map: Record<string, string> = {
            n: '\n',
            t: '\t',
            r: '\r',
            '\\': '\\',
            "'": "'",
            '"': '"',
            '/': '/',
          };
          if (e === 'u') {
            const hex = src.slice(i + 2, i + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              throw new ExpressionSyntaxError('Invalid \\u escape in string', i);
            }
            out += String.fromCharCode(Number.parseInt(hex, 16));
            i += 6;
            continue;
          }
          if (!(e in map)) throw new ExpressionSyntaxError(`Invalid escape '\\${e}' in string`, i);
          out += map[e];
          i += 2;
          continue;
        }
        out += c;
        i++;
      }
      if (!closed) throw new ExpressionSyntaxError('Unterminated string literal', start);
      tokens.push({ type: 'str', value: out, pos: start, end: i });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (PUNCT2.includes(two)) {
      tokens.push({ type: 'punct', value: two, pos: start, end: i + 2 });
      i += 2;
      continue;
    }
    if (PUNCT1.includes(ch)) {
      tokens.push({ type: 'punct', value: ch, pos: start, end: i + 1 });
      i++;
      continue;
    }
    if (ch === '=' || ch === '&' || ch === '|') {
      throw new ExpressionSyntaxError(
        `Unexpected '${ch}' — did you mean '${ch}${ch}'? (assignment is not supported)`,
        i,
      );
    }
    throw new ExpressionSyntaxError(`Unexpected character '${ch}'`, i);
  }
  tokens.push({ type: 'eof', value: '', pos: n, end: n });
  return tokens;
}

class Parser {
  private i = 0;
  private depth = 0;
  private readonly tokens: Token[];
  private readonly src: string;
  constructor(tokens: Token[], src: string) {
    this.tokens = tokens;
    this.src = src;
  }

  private peek(): Token {
    return this.tokens[this.i]!;
  }
  private next(): Token {
    return this.tokens[this.i++]!;
  }
  private isPunct(v: string): boolean {
    const t = this.peek();
    return t.type === 'punct' && t.value === v;
  }
  private expectPunct(v: string): Token {
    const t = this.peek();
    if (t.type !== 'punct' || t.value !== v) {
      throw new ExpressionSyntaxError(`Expected '${v}' but found ${this.describe(t)}`, t.pos);
    }
    return this.next();
  }
  private describe(t: Token): string {
    return t.type === 'eof' ? 'end of expression' : `'${this.src.slice(t.pos, t.end)}'`;
  }

  parse(): Node {
    const node = this.parseTernary();
    const t = this.peek();
    if (t.type !== 'eof') {
      throw new ExpressionSyntaxError(`Unexpected ${this.describe(t)}`, t.pos);
    }
    return node;
  }

  private enter(pos: number): void {
    if (++this.depth > MAX_DEPTH) {
      throw new ExpressionSyntaxError('Expression is nested too deeply', pos);
    }
  }
  private leave(): void {
    this.depth--;
  }

  private parseTernary(): Node {
    const pos = this.peek().pos;
    this.enter(pos);
    const test = this.parseCoalesce();
    let result = test;
    if (this.isPunct('?')) {
      this.next();
      const then = this.parseTernary();
      this.expectPunct(':');
      const otherwise = this.parseTernary();
      result = { type: 'cond', test, then, else: otherwise, pos };
    }
    this.leave();
    return result;
  }

  private parseCoalesce(): Node {
    let left = this.parseOr();
    while (this.isPunct('??')) {
      const pos = this.next().pos;
      left = { type: 'logical', op: '??', left, right: this.parseOr(), pos };
    }
    return left;
  }
  private parseOr(): Node {
    let left = this.parseAnd();
    while (this.isPunct('||')) {
      const pos = this.next().pos;
      left = { type: 'logical', op: '||', left, right: this.parseAnd(), pos };
    }
    return left;
  }
  private parseAnd(): Node {
    let left = this.parseEquality();
    while (this.isPunct('&&')) {
      const pos = this.next().pos;
      left = { type: 'logical', op: '&&', left, right: this.parseEquality(), pos };
    }
    return left;
  }
  private parseEquality(): Node {
    let left = this.parseComparison();
    while (this.isPunct('==') || this.isPunct('!=')) {
      const t = this.next();
      left = {
        type: 'binary',
        op: t.value as BinaryOp,
        left,
        right: this.parseComparison(),
        pos: t.pos,
      };
    }
    return left;
  }
  private parseComparison(): Node {
    let left = this.parseAdditive();
    for (;;) {
      const t = this.peek();
      const isOp =
        (t.type === 'punct' && ['<', '<=', '>', '>='].includes(t.value)) ||
        (t.type === 'ident' && t.value === 'in');
      if (!isOp) break;
      this.next();
      left = {
        type: 'binary',
        op: t.value as BinaryOp,
        left,
        right: this.parseAdditive(),
        pos: t.pos,
      };
    }
    return left;
  }
  private parseAdditive(): Node {
    let left = this.parseMultiplicative();
    while (this.isPunct('+') || this.isPunct('-')) {
      const t = this.next();
      left = {
        type: 'binary',
        op: t.value as BinaryOp,
        left,
        right: this.parseMultiplicative(),
        pos: t.pos,
      };
    }
    return left;
  }
  private parseMultiplicative(): Node {
    let left = this.parseUnary();
    while (this.isPunct('*') || this.isPunct('/') || this.isPunct('%')) {
      const t = this.next();
      left = {
        type: 'binary',
        op: t.value as BinaryOp,
        left,
        right: this.parseUnary(),
        pos: t.pos,
      };
    }
    return left;
  }
  private parseUnary(): Node {
    if (this.isPunct('!') || this.isPunct('-')) {
      const t = this.next();
      this.enter(t.pos);
      const arg = this.parseUnary();
      this.leave();
      return { type: 'unary', op: t.value as '!' | '-', arg, pos: t.pos };
    }
    return this.parsePostfix();
  }
  private parsePostfix(): Node {
    let node = this.parsePrimary();
    for (;;) {
      if (this.isPunct('.')) {
        const dot = this.next();
        const t = this.peek();
        if (t.type !== 'ident') {
          throw new ExpressionSyntaxError("Expected a property name after '.'", dot.pos + 1);
        }
        this.next();
        node = { type: 'member', object: node, property: t.value, pos: t.pos };
      } else if (this.isPunct('[')) {
        const open = this.next();
        this.enter(open.pos);
        const index = this.parseTernary();
        this.leave();
        this.expectPunct(']');
        node = { type: 'index', object: node, index, pos: open.pos };
      } else {
        break;
      }
    }
    return node;
  }
  private parsePrimary(): Node {
    const t = this.next();
    switch (t.type) {
      case 'num':
        return { type: 'literal', value: t.value, pos: t.pos };
      case 'str':
        return { type: 'literal', value: t.value, pos: t.pos };
      case 'ident': {
        if (t.value === 'true') return { type: 'literal', value: true, pos: t.pos };
        if (t.value === 'false') return { type: 'literal', value: false, pos: t.pos };
        if (t.value === 'null') return { type: 'literal', value: null, pos: t.pos };
        if (t.value === 'in') throw new ExpressionSyntaxError("Unexpected keyword 'in'", t.pos);
        if (this.isPunct('(')) return this.parseCall(t);
        return { type: 'ident', name: t.value, pos: t.pos };
      }
      case 'punct': {
        if (t.value === '(') {
          this.enter(t.pos);
          const inner = this.parseTernary();
          this.leave();
          this.expectPunct(')');
          return inner;
        }
        if (t.value === '[') {
          const items: Node[] = [];
          if (!this.isPunct(']')) {
            do {
              if (items.length >= MAX_ARRAY_LITERAL) {
                throw new ExpressionSyntaxError('Array literal is too large', t.pos);
              }
              items.push(this.parseTernary());
            } while (this.isPunct(',') && this.next());
          }
          this.expectPunct(']');
          return { type: 'array', items, pos: t.pos };
        }
        throw new ExpressionSyntaxError(`Unexpected '${t.value}'`, t.pos);
      }
      default:
        throw new ExpressionSyntaxError('Unexpected end of expression', t.pos);
    }
  }
  private parseCall(nameTok: Token & { type: 'ident' }): Node {
    const spec = FUNCTIONS[nameTok.value];
    if (!spec || !Object.hasOwn(FUNCTIONS, nameTok.value)) {
      throw new ExpressionSyntaxError(
        `Unknown function '${nameTok.value}' — only the built-in functions may be called`,
        nameTok.pos,
      );
    }
    this.expectPunct('(');
    const args: Node[] = [];
    if (!this.isPunct(')')) {
      do {
        args.push(this.parseTernary());
      } while (this.isPunct(',') && this.next());
    }
    this.expectPunct(')');
    if (args.length < spec.min || args.length > spec.max) {
      const range = spec.min === spec.max ? `${spec.min}` : `${spec.min}–${spec.max}`;
      throw new ExpressionSyntaxError(
        `${nameTok.value}() takes ${range} argument(s), got ${args.length}`,
        nameTok.pos,
      );
    }
    return { type: 'call', name: nameTok.value, args, pos: nameTok.pos };
  }
}

/** Parse an expression. Throws `ExpressionSyntaxError` with a source offset on failure. */
export function parseExpression(source: string): Node {
  if (source.length > MAX_EXPRESSION_LENGTH) {
    throw new ExpressionSyntaxError(
      `Expression exceeds the ${MAX_EXPRESSION_LENGTH}-character limit`,
      MAX_EXPRESSION_LENGTH,
    );
  }
  if (source.trim() === '') throw new ExpressionSyntaxError('Empty expression', 0);
  return new Parser(tokenize(source), source).parse();
}
