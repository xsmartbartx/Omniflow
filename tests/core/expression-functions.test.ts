import { describe, expect, it } from 'vitest';
import { byteLength, deepClone, evaluate, ExpressionError, FUNCTION_NAMES, FUNCTIONS, getPath, isPlainObject, jsonSize, parseExpression } from '../../core/index.ts';

const call = (name: string, ...args: unknown[]) => FUNCTIONS[name]!.fn(args, { seed: 'run_seed' });
const ev = (src: string, scope: Record<string, unknown> = {}, opts = {}) => evaluate(parseExpression(src), scope, opts);

describe('every whitelisted function: behaviour', () => {
  const cases: Array<[string, unknown[], unknown]> = [
    ['len', ['héllo'], 5],
    ['len', [[1, 2, 3]], 3],
    ['len', [{ a: 1, b: 2 }], 2],
    ['len', [null], 0],
    ['lower', ['ÀBc'], 'àbc'],
    ['upper', ['abc'], 'ABC'],
    ['trim', ['  x \n'], 'x'],
    ['contains', ['haystack', 'st'], true],
    ['contains', ['haystack', 5], false],
    ['contains', [[1, { a: 1 }], { a: 1 }], true],
    ['contains', [[1, 2], 3], false],
    ['contains', [42, 4], false],
    ['startsWith', ['omniflow', 'omni'], true],
    ['endsWith', ['omniflow', 'flow'], true],
    ['endsWith', ['omniflow', 'omni'], false],
    ['join', [['a', 1, null, true, { b: 2 }], '-'], 'a-1--true-{"b":2}'],
    ['join', [['a', 'b']], 'a,b'],
    ['split', ['a,b,c', ','], ['a', 'b', 'c']],
    ['replace', ['a-b-c', '-', '+'], 'a+b+c'],
    ['slice', ['abcdef', 1, 3], 'bc'],
    ['slice', [[1, 2, 3, 4], 2], [3, 4]],
    ['keys', [{ b: 1, a: 2 }], ['a', 'b']],
    ['keys', ['nope'], []],
    ['values', [{ b: 1, a: 2 }], [2, 1]],
    ['values', [[1]], []],
    ['pluck', [[{ id: 1 }, { id: 2 }, { other: 3 }, 'x'], 'id'], [1, 2, null, null]],
    ['first', [[7, 8]], 7],
    ['first', [[]], null],
    ['first', ['x'], null],
    ['last', [[7, 8]], 8],
    ['last', [[]], null],
    ['unique', [[1, '1', 1, { a: 1 }, { a: 1 }]], [1, '1', { a: 1 }]],
    ['sort', [[3, 1, 2]], [1, 2, 3]],
    ['sort', [['b', 'a', 'c']], ['a', 'b', 'c']],
    ['sort', [[]], []],
    ['sum', [[1, 2, 3.5]], 6.5],
    ['sum', [[]], 0],
    ['min', [[4, 2, 9]], 2],
    ['min', [[]], null],
    ['max', [[4, 2, 9]], 9],
    ['max', [[]], null],
    ['round', [2.567, 2], 2.57],
    ['round', [2.5], 3],
    ['floor', [2.9], 2],
    ['ceil', [2.1], 3],
    ['abs', [-4], 4],
    ['toNumber', ['12.5'], 12.5],
    ['toNumber', [7], 7],
    ['toString', [12], '12'],
    ['toString', [null], ''],
    ['toString', [{ b: 1, a: [true] }], '{"a":[true],"b":1}'],
    ['toJson', [{ b: 1, a: 2 }], '{"a":2,"b":1}'],
    ['fromJson', ['{"a":[1,2]}'], { a: [1, 2] }],
    ['isNull', [null], true],
    ['isNull', [undefined], true],
    ['isNull', [0], false],
    ['dateAdd', ['2026-01-01T00:00:00.000Z', '1h'], '2026-01-01T01:00:00.000Z'],
    ['dateAdd', ['2026-01-01T00:00:00.000Z', 86_400_000], '2026-01-02T00:00:00.000Z'],
    ['date', ['2026-03-04T23:59:59.999Z'], '2026-03-04'],
    ['epochMs', ['1970-01-01T00:00:01.000Z'], 1000],
  ];
  it.each(cases)('%s(%j) = %j', (name, args, expected) => {
    expect(call(name, ...args)).toEqual(expected);
  });

  it('hash is a stable sha256 of the canonical form; uuid is deterministic per seed and label', () => {
    expect(call('hash', 'abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(call('hash', { b: 1, a: 2 })).toBe(call('hash', { a: 2, b: 1 }));
    expect(call('uuid')).toBe(call('uuid'));
    expect(call('uuid', 'x')).not.toBe(call('uuid', 'y'));
    expect(call('uuid')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(() => FUNCTIONS.uuid!.fn([], {})).toThrow(/needs a run seed/);
  });
});

describe('every whitelisted function: type errors are values, not crashes', () => {
  const bad: Array<[string, unknown[], RegExp]> = [
    ['len', [5], /string, array or object/],
    ['lower', [5], /a string/],
    ['upper', [null], /a string/],
    ['trim', [{}], /a string/],
    ['startsWith', [1, 'a'], /strings/],
    ['endsWith', ['a', 1], /strings/],
    ['join', ['nope'], /an array/],
    ['split', [1, ','], /a string/],
    ['split', ['a', 1], /separator/],
    ['replace', ['a', 1, 'b'], /a string/],
    ['slice', [{}, 1], /string or array/],
    ['slice', ['abc', 'x'], /numeric bounds/],
    ['pluck', ['x', 'id'], /an array/],
    ['pluck', [[], 1], /string key/],
    ['unique', ['x'], /an array/],
    ['sort', [[1, 'a']], /numbers or of strings/],
    ['sum', [[1, 'a']], /numbers/],
    ['min', [['a']], /numbers/],
    ['max', ['x'], /an array/],
    ['round', ['x'], /a number/],
    ['round', [1, 'x'], /digits/],
    ['floor', ['1'], /a number/],
    ['ceil', [null], /a number/],
    ['abs', ['1'], /a number/],
    ['toNumber', ['abc'], /could not convert/],
    ['toNumber', [''], /could not convert/],
    ['toNumber', [null], /could not convert/],
    ['fromJson', ['{oops'], /invalid JSON/],
    ['fromJson', [5], /invalid JSON/],
    ['dateAdd', ['not a date', '1h'], /invalid timestamp/],
    ['dateAdd', [5, '1h'], /ISO timestamp/],
    ['dateAdd', ['2026-01-01T00:00:00Z', Number.POSITIVE_INFINITY], /out of range/],
    ['dateAdd', ['2026-01-01T00:00:00Z', 9e15], /out of range/],
    ['date', ['garbage'], /invalid timestamp/],
    ['epochMs', ['garbage'], /invalid timestamp/],
  ];
  it.each(bad)('%s(%j) → %s', (name, args, message) => {
    expect(() => call(name, ...args)).toThrow(ExpressionError);
    expect(() => call(name, ...args)).toThrow(message);
  });

  it('strings that would exceed the size budget are refused', () => {
    const big = 'x'.repeat(600_000);
    expect(() => call('join', [big, big])).toThrow(/too long/);
    expect(() => call('replace', big, 'x', 'yy')).toThrow(/too long/);
    expect(() => call('toString', big + big)).toThrow(/too long/);
    expect(call('toString', big)).toHaveLength(600_000);
  });

  it('the language has exactly the documented functions, each with sane arity', () => {
    expect([...FUNCTION_NAMES].sort()).toEqual(
      ['abs', 'ceil', 'contains', 'date', 'dateAdd', 'endsWith', 'epochMs', 'first', 'floor', 'fromJson', 'hash', 'isNull', 'join', 'keys', 'last', 'len', 'lower', 'max', 'min', 'pluck', 'replace', 'round', 'slice', 'sort', 'split', 'startsWith', 'sum', 'toJson', 'toNumber', 'toString', 'trim', 'unique', 'upper', 'uuid', 'values'].sort(),
    );
    for (const [name, spec] of Object.entries(FUNCTIONS)) expect(spec.min <= spec.max && spec.min >= 0, name).toBe(true);
    // nothing in the whitelist is an escape hatch
    for (const name of FUNCTION_NAMES) expect(['eval', 'constructor', 'require', 'import', 'process', 'Function']).not.toContain(name);
  });
});

describe('functions through the evaluator (arity, purity, budgets)', () => {
  it('rejects wrong arity and unknown functions', () => {
    expect(() => ev('len()')).toThrow(/argument/);
    expect(() => ev('len(1, 2)')).toThrow(/argument/);
    expect(() => ev('eval("1")')).toThrow(/Unknown function/i);
    expect(() => ev('constructor("x")')).toThrow();
  });

  it('composes: a realistic expression', () => {
    const scope = { inputs: { orders: [{ id: 'a', total: 20.5 }, { id: 'b', total: 1000 }, { id: 'c', total: 9.5 }] } };
    expect(ev("round(sum(pluck(inputs.orders, 'total')) / len(inputs.orders), 1)", scope)).toBe(343.3);
    expect(ev("join(sort(pluck(inputs.orders, 'id')), '|')", scope)).toBe('a|b|c');
    expect(ev("max(pluck(inputs.orders, 'total')) >= 1000 ? 'review' : 'auto'", scope)).toBe('review');
  });

  it('uuid uses the run seed and is reproducible', () => {
    expect(ev("uuid('a')", {}, { seed: 's1' })).toBe(ev("uuid('a')", {}, { seed: 's1' }));
    expect(ev("uuid('a')", {}, { seed: 's1' })).not.toBe(ev("uuid('a')", {}, { seed: 's2' }));
  });
});

describe('json helpers', () => {
  it('reads paths safely, clones deeply, and measures size', () => {
    const v = { a: { b: [10, { c: 'x' }] } };
    expect(getPath(v, ['a', 'b', 1, 'c'])).toBe('x');
    expect(getPath(v, ['a', 'zz', 'c'])).toBeUndefined();
    expect(getPath(null, ['a'])).toBeUndefined();
    expect(getPath(v, ['__proto__', 'polluted'])).toBeUndefined();
    const copy = deepClone(v);
    expect(copy).toEqual(v);
    expect(copy).not.toBe(v);
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(new Date())).toBe(false);
    expect(byteLength('héllo')).toBe(6);
    expect(jsonSize({ a: 'é' })).toBe(byteLength('{"a":"é"}'));
  });
});
