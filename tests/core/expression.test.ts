import { describe, expect, it } from 'vitest';
import {
  collectReferences,
  ExpressionError,
  ExpressionSyntaxError,
  evaluate,
  functionsUsed,
  parseExpression,
  parseExpressionField,
  parseTemplate,
  renderTemplate,
  resolveValue,
  scanTemplates,
} from '../../core/index.ts';

const scope = {
  inputs: { n: 5, name: 'Ada', tags: ['a', 'b', 'c'], nested: { deep: { x: 1 } } },
  steps: {
    'fetch-customer': {
      output: {
        body: {
          id: 42,
          items: [
            { sku: 'A', qty: 2 },
            { sku: 'B', qty: 3 },
          ],
        },
      },
    },
  },
  context: { now: '2026-01-01T00:00:00.000Z', environment: 'production' },
  secrets: {},
};

const ev = (src: string, s: Record<string, unknown> = scope, opts = {}) => evaluate(parseExpression(src), s, opts);

describe('expression: literals and operators', () => {
  it('evaluates arithmetic with precedence', () => {
    expect(ev('1 + 2 * 3')).toBe(7);
    expect(ev('(1 + 2) * 3')).toBe(9);
    expect(ev('10 % 4 - 1')).toBe(1);
    expect(ev('-inputs.n')).toBe(-5);
  });

  it('evaluates comparison and logic', () => {
    expect(ev('inputs.n > 3 && inputs.name == "Ada"')).toBe(true);
    expect(ev('inputs.n < 3 || inputs.name == "Bob"')).toBe(false);
    expect(ev('!(inputs.n == 5)')).toBe(false);
    expect(ev("'abc' < 'abd'")).toBe(true);
  });

  it('supports ternary, coalesce and membership', () => {
    expect(ev('inputs.n > 3 ? "big" : "small"')).toBe('big');
    expect(ev('inputs.missing ?? "fallback"')).toBe('fallback');
    expect(ev('"b" in inputs.tags')).toBe(true);
    expect(ev('"z" in inputs.tags')).toBe(false);
    expect(ev('"name" in inputs')).toBe(true);
    expect(ev('"da" in inputs.name')).toBe(true);
  });

  it('supports array literals and both quote styles', () => {
    expect(ev('[1, 2, "x"]')).toEqual([1, 2, 'x']);
    expect(ev("'it\\'s'")).toBe("it's");
    expect(ev('"tab\\there"')).toBe('tab\there');
  });

  it('is strictly typed: no implicit coercion', () => {
    expect(ev('1 == "1"')).toBe(false);
    expect(() => ev('1 + "1"')).toThrow(/Cannot add/);
    expect(() => ev('"a" * 2')).toThrow(/needs numbers/);
    expect(() => ev('1 < "2"')).toThrow(/Cannot compare/);
    expect(() => ev('1 / 0')).toThrow(/Division by zero/);
  });

  it('treats ordering comparisons with null as false (safe navigation)', () => {
    expect(ev('inputs.missing > 3')).toBe(false);
    expect(ev('inputs.missing != null')).toBe(false);
    expect(ev('inputs.missing == null')).toBe(true);
  });

  it('short-circuits logical operators and returns operand values', () => {
    expect(ev('0 || "x"')).toBe('x');
    expect(ev('"a" && "b"')).toBe('b');
    expect(ev('false && (1 / 0)')).toBe(false); // right side never evaluated
  });
});

describe('expression: property access', () => {
  it('reads kebab-case ids after a dot', () => {
    expect(ev('steps.fetch-customer.output.body.id')).toBe(42);
    expect(ev("steps['fetch-customer'].output.body.id")).toBe(42);
  });

  it('reads array elements and length', () => {
    expect(ev('steps.fetch-customer.output.body.items[1].sku')).toBe('B');
    expect(ev('inputs.tags.length')).toBe(3);
    expect(ev('inputs.tags[10]')).toBeNull();
    expect(ev('inputs.tags[-1]')).toBeNull();
  });

  it('returns null for missing paths instead of throwing', () => {
    expect(ev('inputs.nothing.at.all')).toBeNull();
    expect(ev('inputs.n.foo')).toBeNull();
  });

  it('never reaches the prototype chain', () => {
    expect(ev('inputs.constructor')).toBeNull();
    expect(ev('inputs.__proto__')).toBeNull();
    expect(ev('inputs.toString')).toBeNull();
    expect(ev('inputs["constructor"]')).toBeNull();
    expect(ev('"a".constructor')).toBeNull();
  });

  it('rejects an unknown root identifier at runtime', () => {
    expect(() => ev('nope.x')).toThrow(ExpressionError);
    expect(() => ev('process.env')).toThrow(/Unknown identifier/);
  });
});

describe('expression: functions', () => {
  it('provides pure collection helpers', () => {
    expect(ev('len(inputs.tags)')).toBe(3);
    expect(ev('join(inputs.tags, "-")')).toBe('a-b-c');
    expect(ev('pluck(steps.fetch-customer.output.body.items, "qty")')).toEqual([2, 3]);
    expect(ev('sum(pluck(steps.fetch-customer.output.body.items, "qty"))')).toBe(5);
    expect(ev('max([3, 9, 4])')).toBe(9);
    expect(ev('unique([1, 1, 2])')).toEqual([1, 2]);
    expect(ev('sort([3, 1, 2])')).toEqual([1, 2, 3]);
    expect(ev('first([])')).toBeNull();
    expect(ev('keys(inputs.nested)')).toEqual(['deep']);
  });

  it('provides string and conversion helpers', () => {
    expect(ev('upper(inputs.name)')).toBe('ADA');
    expect(ev('replace("a-b-c", "-", "_")')).toBe('a_b_c');
    expect(ev('split("a,b", ",")')).toEqual(['a', 'b']);
    expect(ev('toNumber("12.5")')).toBe(12.5);
    expect(ev('toString(12)')).toBe('12');
    expect(ev('fromJson(toJson([1,2]))')).toEqual([1, 2]);
    expect(() => ev('toNumber("x")')).toThrow(/could not convert/);
  });

  it('does time arithmetic without reading the clock', () => {
    expect(ev('dateAdd(context.now, "1h")')).toBe('2026-01-01T01:00:00.000Z');
    expect(ev('date(context.now)')).toBe('2026-01-01');
    expect(ev('epochMs(context.now)')).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
  });

  it('derives uuid() deterministically from the run seed', () => {
    const a = ev('uuid("order")', scope, { seed: 'seed-1' });
    const b = ev('uuid("order")', scope, { seed: 'seed-1' });
    const c = ev('uuid("order")', scope, { seed: 'seed-2' });
    const d = ev('uuid("other")', scope, { seed: 'seed-1' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(() => ev('uuid()')).toThrow(/seed/);
  });

  it('hashes canonically', () => {
    expect(ev('hash({})'.replace('{}', '[1]'))).toBe(ev('hash([1])'));
    expect(ev('hash("abc")')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('rejects unknown functions at parse time', () => {
    expect(() => parseExpression('eval("1")')).toThrow(ExpressionSyntaxError);
    expect(() => parseExpression('require("fs")')).toThrow(/Unknown function/);
    expect(() => parseExpression('constructor("x")')).toThrow(/Unknown function/);
    expect(() => parseExpression('toString.call(1)')).toThrow(); // no method calls
  });

  it('checks arity at parse time', () => {
    expect(() => parseExpression('len()')).toThrow(/takes 1 argument/);
    expect(() => parseExpression('len(1, 2)')).toThrow(/takes 1 argument/);
  });
});

describe('expression: sandbox guarantees (non-Turing-complete)', () => {
  it('has no assignment, loops or function definitions', () => {
    expect(() => parseExpression('x = 1')).toThrow(/assignment is not supported/);
    expect(() => parseExpression('while (true) {}')).toThrow(ExpressionSyntaxError);
    expect(() => parseExpression('(x) => x')).toThrow(ExpressionSyntaxError);
    expect(() => parseExpression('function f() {}')).toThrow(ExpressionSyntaxError);
  });

  it('bounds evaluation cost', () => {
    const big = `[${new Array(200).fill('1').join(',')}]`;
    expect(() => ev(big, scope, { maxSteps: 50 })).toThrow(/budget/);
  });

  it('bounds expression length and nesting', () => {
    expect(() => parseExpression('1+'.repeat(3000))).toThrow(/limit/);
    expect(() => parseExpression(`${'('.repeat(100)}1${')'.repeat(100)}`)).toThrow(/nested too deeply/);
  });

  it('reports syntax errors with positions', () => {
    try {
      parseExpression('1 + * 2');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ExpressionSyntaxError);
      expect((e as ExpressionSyntaxError).pos).toBe(4);
    }
    expect(() => parseExpression('')).toThrow(/Empty/);
    expect(() => parseExpression('"abc')).toThrow(/Unterminated/);
    expect(() => parseExpression('a &')).toThrow(/did you mean/);
    expect(() => parseExpression('1 2')).toThrow(/Unexpected/);
    expect(() => parseExpression('a.')).toThrow(/property name/);
  });
});

describe('expression: static analysis', () => {
  it('collects references with static paths', () => {
    const refs = collectReferences(
      parseExpression('steps.fetch-customer.output.body.id > inputs.n && "x" in context.tags'),
    );
    expect(refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          root: 'steps',
          path: ['fetch-customer', 'output', 'body', 'id'],
        }),
        expect.objectContaining({ root: 'inputs', path: ['n'] }),
        expect.objectContaining({ root: 'context', path: ['tags'] }),
      ]),
    );
  });

  it('treats literal bracket access as static and computed access as dynamic', () => {
    const [ref] = collectReferences(parseExpression("steps['a-b'].output"));
    expect(ref).toMatchObject({ root: 'steps', path: ['a-b', 'output'], dynamic: false });
    const refs = collectReferences(parseExpression('inputs.list[inputs.i].name'));
    expect(refs.find((r) => r.root === 'inputs' && r.dynamic)?.path).toEqual(['list']);
    expect(refs.some((r) => r.root === 'inputs' && r.path[0] === 'i')).toBe(true);
  });

  it('lists the functions an expression calls', () => {
    expect(functionsUsed(parseExpression('len(x) + sum(y) + len(z)')).sort()).toEqual(['len', 'sum']);
  });
});

describe('templates', () => {
  it('returns the typed value for a whole-string expression', () => {
    const t = parseTemplate('${{ inputs.n }}');
    expect(renderTemplate(t, scope)).toBe(5);
    expect(renderTemplate(parseTemplate('${{ inputs.tags }}'), scope)).toEqual(['a', 'b', 'c']);
  });

  it('interpolates into strings', () => {
    expect(
      renderTemplate(
        parseTemplate('https://x.test/c/${{ steps.fetch-customer.output.body.id }}/i?n=${{ inputs.n }}'),
        scope,
      ),
    ).toBe('https://x.test/c/42/i?n=5');
  });

  it('refuses to silently interpolate null', () => {
    expect(() => renderTemplate(parseTemplate('id-${{ inputs.missing }}'), scope)).toThrow(/is null inside a string/);
    expect(renderTemplate(parseTemplate('id-${{ inputs.missing ?? "none" }}'), scope)).toBe('id-none');
  });

  it('supports escaping and quotes containing braces', () => {
    expect(renderTemplate(parseTemplate('$${{ literal }}'), scope)).toBe('${{ literal }}');
    expect(renderTemplate(parseTemplate("${{ '}}' }}"), scope)).toBe('}}');
  });

  it('reports absolute offsets for syntax errors inside a template', () => {
    try {
      parseTemplate('abc ${{ 1 + }} def');
      expect.unreachable();
    } catch (e) {
      expect((e as ExpressionSyntaxError).pos).toBeGreaterThanOrEqual(7);
    }
    expect(() => parseTemplate('${{ 1 + 2')).toThrow(/Unterminated/);
  });

  it('accepts bare or wrapped expression fields', () => {
    expect(evaluate(parseExpressionField('inputs.n > 3'), scope)).toBe(true);
    expect(evaluate(parseExpressionField('${{ inputs.n > 3 }}'), scope)).toBe(true);
    expect(() => parseExpressionField('a ${{ b }}')).toThrow();
  });

  it('resolves nested values and leaves keys alone', () => {
    const out = resolveValue(
      { url: 'u/${{ inputs.n }}', list: ['${{ inputs.name }}', 'plain'], '${{ key }}': 1, n: 3 },
      scope,
    );
    expect(out).toEqual({ url: 'u/5', list: ['Ada', 'plain'], '${{ key }}': 1, n: 3 });
  });

  it('scans a value tree for templates and syntax errors', () => {
    const found = scanTemplates({ a: '${{ inputs.n }}', b: ['ok', '${{ 1 + }}'], c: { d: 'x' } }, 'with');
    expect(found.map((f) => f.path)).toEqual(['with.a', 'with.b[1]']);
    expect(found[0]!.template).toBeDefined();
    expect(found[1]!.error).toBeInstanceOf(ExpressionSyntaxError);
  });
});
