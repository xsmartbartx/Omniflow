import { isAlias, isMap, isPair, isScalar, isSeq, LineCounter, parseDocument, visit } from 'yaml';
import type { Issue } from '../../core/index.ts';

export type PathSegment = string | number;

export interface Position {
  line: number;
  column: number;
}

export type Locator = (path: readonly PathSegment[], opts?: { key?: boolean }) => Position | undefined;

export interface ParsedSource {
  /** Parsed value, or `undefined` if the text could not be parsed. */
  value: unknown;
  issues: Issue[];
  locate: Locator;
}

export const DEFAULT_MAX_BYTES = 1_048_576;

/** Format a path the way a human would write it: `steps[2].with.url`. */
export function formatPath(path: readonly PathSegment[]): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(seg)) out += out ? `.${seg}` : seg;
    else out += `[${JSON.stringify(seg)}]`;
  }
  return out;
}

/** Parse a JSON Pointer (`/steps/2/with`) into path segments. */
export function parsePointer(pointer: string): PathSegment[] {
  if (pointer === '') return [];
  return pointer
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
    .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
}

const noLocation: Locator = () => undefined;

/**
 * Parse YAML (or JSON — JSON is valid YAML) into a plain value plus a locator that maps any path
 * back to a source line/column, so validation errors can point at the exact offending text.
 *
 * Anchors, aliases and merge keys are rejected: they make a manifest impossible to review as a
 * flat document and are the classic route to "billion laughs" expansion.
 */
export function parseSource(text: string, maxBytes = DEFAULT_MAX_BYTES): ParsedSource {
  const issues: Issue[] = [];
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    return {
      value: undefined,
      locate: noLocation,
      issues: [
        {
          path: '',
          code: 'DOCUMENT_TOO_LARGE',
          message: `Document exceeds the ${maxBytes}-byte limit`,
        },
      ],
    };
  }

  const lineCounter = new LineCounter();
  const doc = parseDocument(text, {
    lineCounter,
    uniqueKeys: true,
    maxAliasCount: 0,
    version: '1.2',
    prettyErrors: false,
  });

  for (const e of doc.errors) {
    const pos = lineCounter.linePos(e.pos[0]);
    issues.push({
      path: '',
      code: `YAML_${e.code}`,
      message: e.message.split('\n')[0] ?? e.message,
      line: pos.line,
      column: pos.col,
    });
  }
  for (const w of doc.warnings) {
    const pos = lineCounter.linePos(w.pos[0]);
    issues.push({
      path: '',
      code: `YAML_${w.code}`,
      message: w.message.split('\n')[0] ?? w.message,
      line: pos.line,
      column: pos.col,
      severity: 'warning',
    });
  }
  if (doc.errors.length > 0) return { value: undefined, issues, locate: noLocation };

  visit(doc, {
    Alias(_key, node) {
      const pos = lineCounter.linePos(node.range?.[0] ?? 0);
      issues.push({
        path: '',
        code: 'YAML_ALIAS_FORBIDDEN',
        message: 'YAML aliases are not allowed in manifests',
        line: pos.line,
        column: pos.col,
      });
    },
    Pair(_key, pair) {
      const k = pair.key;
      if (isScalar(k) && k.value === '<<') {
        const pos = lineCounter.linePos(k.range?.[0] ?? 0);
        issues.push({
          path: '',
          code: 'YAML_MERGE_FORBIDDEN',
          message: "YAML merge keys ('<<') are not allowed in manifests",
          line: pos.line,
          column: pos.col,
        });
      }
    },
    Node(_key, node) {
      if (isAlias(node)) return;
      const anchor = (node as { anchor?: string }).anchor;
      if (anchor) {
        const pos = lineCounter.linePos(node.range?.[0] ?? 0);
        issues.push({
          path: '',
          code: 'YAML_ANCHOR_FORBIDDEN',
          message: 'YAML anchors are not allowed in manifests',
          line: pos.line,
          column: pos.col,
        });
      }
    },
  });
  if (issues.some((i) => i.severity !== 'warning')) return { value: undefined, issues, locate: noLocation };

  const locate: Locator = (path, opts) => {
    let node: unknown = doc.contents;
    let keyNode: unknown;
    for (const seg of path) {
      if (isMap(node)) {
        const pair = node.items.find((p) => isPair(p) && String(isScalar(p.key) ? p.key.value : p.key) === String(seg));
        if (!pair) break;
        keyNode = pair.key;
        node = pair.value;
      } else if (isSeq(node)) {
        const next = node.items[Number(seg)];
        if (next === undefined) break;
        keyNode = undefined;
        node = next;
      } else {
        break;
      }
    }
    const target = (opts?.key && keyNode ? keyNode : node) as { range?: [number, number, number] } | null;
    const offset = target?.range?.[0];
    if (offset === undefined) return undefined;
    const p = lineCounter.linePos(offset);
    return { line: p.line, column: p.col };
  };

  return { value: doc.toJS({ maxAliasCount: 0 }), issues, locate };
}
