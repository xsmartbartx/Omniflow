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

const STRING_ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '/': '/',
};

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
    const prev = tokens.at(-1);
    const afterDot = prev?.type === 'punct' && prev.value === '.';
    const token = lexToken(src, i, afterDot);
    tokens.push(token);
    i = token.end;
  }
  tokens.push({ type: 'eof', value: '', pos: n, end: n });
  return tokens;
}

/** The token starting at `i`. After a dot, a property name may contain hyphens (kebab-case step ids) and digits. */
function lexToken(src: string, i: number, afterDot: boolean): Token {
  const ch = src[i]!;
  if (/\d/.test(ch) && !afterDot) return lexMatch(src, i, /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'num');
  if (afterDot && /\w/.test(ch)) return lexMatch(src, i, /^\w(?:\w|-(?=\w))*/, 'ident');
  if (/[A-Za-z_]/.test(ch)) return lexMatch(src, i, /^[A-Za-z_]\w*/, 'ident');
  if (ch === "'" || ch === '"') return lexString(src, i);
  return lexPunct(src, i);
}

function lexMatch(src: string, i: number, re: RegExp, type: 'num' | 'ident'): Token {
  const m = re.exec(src.slice(i))!;
  const end = i + m[0].length;
  return type === 'num' ? { type, value: Number(m[0]), pos: i, end } : { type, value: m[0], pos: i, end };
}

function lexString(src: string, start: number): Token {
  const quote = src[start]!;
  let i = start + 1;
  let out = '';
  while (i < src.length) {
    const c = src[i]!;
    if (c === quote) return { type: 'str', value: out, pos: start, end: i + 1 };
    if (c !== '\\') {
      out += c;
      i++;
      continue;
    }
    const e = src[i + 1];
    if (e === undefined) break;
    if (e === 'u') {
      const hex = src.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        throw new ExpressionSyntaxError(String.raw`Invalid \u escape in string`, i);
      }
      out += String.fromCodePoint(Number.parseInt(hex, 16));
      i += 6;
      continue;
    }
    if (!(e in STRING_ESCAPES)) throw new ExpressionSyntaxError(`Invalid escape '\\${e}' in string`, i);
    out += STRING_ESCAPES[e];
    i += 2;
  }
  throw new ExpressionSyntaxError('Unterminated string literal', start);
}

function lexPunct(src: string, i: number): Token {
  const ch = src[i]!;
  const two = src.slice(i, i + 2);
  if (PUNCT2.includes(two)) return { type: 'punct', value: two, pos: i, end: i + 2 };
  if (PUNCT1.includes(ch)) return { type: 'punct', value: ch, pos: i, end: i + 1 };
  if (ch === '=' || ch === '&' || ch === '|') {
    throw new ExpressionSyntaxError(`Unexpected '${ch}' — did you mean '${ch}${ch}'? (assignment is not supported)`, i);
  }
  throw new ExpressionSyntaxError(`Unexpected character '${ch}'`, i);
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
      const consequent = this.parseTernary();
      this.expectPunct(':');
      const alternate = this.parseTernary();
      result = { type: 'cond', test, consequent, alternate, pos };
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
        (t.type === 'punct' && ['<', '<=', '>', '>='].includes(t.value)) || (t.type === 'ident' && t.value === 'in');
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
      case 'ident':
        return this.parseIdentifier(t);
      case 'punct':
        return this.parsePunctuated(t);
      default:
        throw new ExpressionSyntaxError('Unexpected end of expression', t.pos);
    }
  }
  private parseIdentifier(t: Token & { type: 'ident' }): Node {
    if (t.value === 'true') return { type: 'literal', value: true, pos: t.pos };
    if (t.value === 'false') return { type: 'literal', value: false, pos: t.pos };
    if (t.value === 'null') return { type: 'literal', value: null, pos: t.pos };
    if (t.value === 'in') throw new ExpressionSyntaxError("Unexpected keyword 'in'", t.pos);
    if (this.isPunct('(')) return this.parseCall(t);
    return { type: 'ident', name: t.value, pos: t.pos };
  }
  /** A parenthesised expression or an array literal. */
  private parsePunctuated(t: Token & { type: 'punct' }): Node {
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
      throw new ExpressionSyntaxError(`${nameTok.value}() takes ${range} argument(s), got ${args.length}`, nameTok.pos);
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
