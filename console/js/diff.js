// Line diff (LCS) for reviewing change requests. Pure and unit-tested.

export function diffLines(before, after) {
  const a = String(before ?? '').split('\n');
  const b = String(after ?? '').split('\n');
  const n = a.length;
  const m = b.length;
  // longest-common-subsequence table (manifests are small; O(n·m) is fine)
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) ops.push({ op: 'same', text: a[i++], a: i, b: ++j });
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) ops.push({ op: 'del', text: a[i++], a: i });
    else ops.push({ op: 'add', text: b[j++], b: j });
  }
  while (i < n) ops.push({ op: 'del', text: a[i++], a: i });
  while (j < m) ops.push({ op: 'add', text: b[j++], b: j });
  return ops;
}

/** Collapse long unchanged stretches, keeping `context` lines around each change. */
export function collapse(ops, context = 3) {
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.op === 'same') return;
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true;
  });
  const out = [];
  let skipped = 0;
  ops.forEach((o, i) => {
    if (keep[i]) {
      if (skipped) out.push({ op: 'gap', count: skipped });
      skipped = 0;
      out.push(o);
    } else skipped++;
  });
  if (skipped && out.length) out.push({ op: 'gap', count: skipped });
  return out;
}

export const stats = (ops) => ({
  added: ops.filter((o) => o.op === 'add').length,
  removed: ops.filter((o) => o.op === 'del').length,
});
