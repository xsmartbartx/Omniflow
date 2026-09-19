/**
 * DAG utilities. Ordering is fully deterministic — ties are broken lexicographically by node id —
 * so the compiler is a pure function of the manifest (ADR-0002 D2).
 */

export interface TopoResult {
  /** Topologically sorted ids (dependencies first). Incomplete when a cycle exists. */
  order: string[];
  /** One concrete cycle, e.g. `['a', 'b', 'c', 'a']`, when the graph is not a DAG. */
  cycle?: string[];
}

/**
 * @param ids   every node id
 * @param deps  node id → ids it depends on (edges point from dependency to dependent)
 */
export function topologicalOrder(ids: readonly string[], deps: ReadonlyMap<string, readonly string[]>): TopoResult {
  const idSet = new Set(ids);
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of ids) {
    indegree.set(id, 0);
    dependents.set(id, []);
  }
  for (const id of ids) {
    for (const d of new Set(deps.get(id) ?? [])) {
      if (!idSet.has(d)) continue;
      indegree.set(id, (indegree.get(id) ?? 0) + 1);
      dependents.get(d)!.push(id);
    }
  }

  const ready = ids.filter((id) => indegree.get(id) === 0).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const next of dependents.get(id)!) {
      const n = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, n);
      if (n === 0) {
        ready.push(next);
        ready.sort();
      }
    }
  }
  if (order.length === ids.length) return { order };

  const remaining = new Set(ids.filter((id) => !order.includes(id)));
  return { order, cycle: findCycle(remaining, deps) };
}

function findCycle(nodes: ReadonlySet<string>, deps: ReadonlyMap<string, readonly string[]>): string[] {
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    state.set(id, 'visiting');
    stack.push(id);
    for (const d of [...(deps.get(id) ?? [])].sort()) {
      if (!nodes.has(d)) continue;
      if (state.get(d) === 'visiting') return [...stack.slice(stack.indexOf(d)), d];
      if (!state.has(d)) {
        const found = visit(d);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, 'done');
    return undefined;
  };
  for (const id of [...nodes].sort()) {
    if (!state.has(id)) {
      const found = visit(id);
      if (found) return found.reverse();
    }
  }
  return [];
}

/** For every node, the set of all nodes it transitively depends on. Requires an acyclic graph. */
export function transitiveDependencies(
  order: readonly string[],
  deps: ReadonlyMap<string, readonly string[]>,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const id of order) {
    const set = new Set<string>();
    for (const d of deps.get(id) ?? []) {
      set.add(d);
      for (const up of result.get(d) ?? []) set.add(up);
    }
    result.set(id, set);
  }
  return result;
}

/** Longest dependency chain length (number of nodes) in an acyclic graph. */
export function longestPath(order: readonly string[], deps: ReadonlyMap<string, readonly string[]>): number {
  const depth = new Map<string, number>();
  let max = 0;
  for (const id of order) {
    const d = 1 + Math.max(0, ...(deps.get(id) ?? []).map((x) => depth.get(x) ?? 0));
    depth.set(id, d);
    max = Math.max(max, d);
  }
  return max;
}
