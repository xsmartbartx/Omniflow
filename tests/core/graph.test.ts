import { describe, expect, it } from 'vitest';
import { longestPath, topologicalOrder, transitiveDependencies } from '../../core/index.ts';

const deps = (o: Record<string, string[]>) => new Map(Object.entries(o));

describe('graph', () => {
  it('sorts dependencies first with lexicographic tie-breaking', () => {
    const ids = ['d', 'c', 'b', 'a'];
    const r = topologicalOrder(ids, deps({ d: ['b', 'c'], c: ['a'], b: ['a'], a: [] }));
    expect(r.cycle).toBeUndefined();
    expect(r.order).toEqual(['a', 'b', 'c', 'd']);
  });

  it('is independent of declaration order', () => {
    const d = deps({ x: [], y: ['x'], z: ['x'], w: ['y', 'z'] });
    const a = topologicalOrder(['x', 'y', 'z', 'w'], d).order;
    const b = topologicalOrder(['w', 'z', 'y', 'x'], d).order;
    expect(a).toEqual(b);
  });

  it('reports a concrete cycle', () => {
    const r = topologicalOrder(['a', 'b', 'c', 'ok'], deps({ a: ['c'], b: ['a'], c: ['b'], ok: [] }));
    expect(r.cycle).toBeDefined();
    expect(r.cycle![0]).toBe(r.cycle![r.cycle!.length - 1]);
    expect(new Set(r.cycle)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('computes transitive dependencies and depth', () => {
    const d = deps({ a: [], b: ['a'], c: ['b'], d: ['a'] });
    const { order } = topologicalOrder(['a', 'b', 'c', 'd'], d);
    const t = transitiveDependencies(order, d);
    expect([...t.get('c')!].sort()).toEqual(['a', 'b']);
    expect([...t.get('d')!]).toEqual(['a']);
    expect(longestPath(order, d)).toBe(3);
  });
});
