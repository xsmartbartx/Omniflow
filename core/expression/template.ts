import { canonicalize } from '../canonical.ts';
import { ExpressionError, ExpressionSyntaxError, type Node } from './ast.ts';
import { type EvalOptions, evaluate } from './evaluator.ts';
import { parseExpression } from './parser.ts';

/**
 * Templates embed expressions in strings with `${{ … }}`. A string that is exactly one
 * expression resolves to that expression's typed value; otherwise the parts are concatenated
 * into a string. `$${{` escapes a literal `${{`.
 */

export type TemplatePart =
  | { kind: 'text'; text: string }
  | { kind: 'expr'; source: string; ast: Node; offset: number };

export interface Template {
  source: string;
  parts: TemplatePart[];
}

export function hasTemplate(text: string): boolean {
  return text.includes('${{');
}

export function parseTemplate(source: string): Template {
  const parts: TemplatePart[] = [];
  let text = '';
  let i = 0;
  const flush = () => {
    if (text) parts.push({ kind: 'text', text });
    text = '';
  };
  while (i < source.length) {
    if (source.startsWith('$${{', i)) {
      text += '${{';
      i += 4;
      continue;
    }
    if (source.startsWith('${{', i)) {
      const exprStart = i + 3;
      let j = exprStart;
      let quote: string | null = null;
      let end = -1;
      while (j < source.length) {
        const c = source[j]!;
        if (quote) {
          if (c === '\\') j++;
          else if (c === quote) quote = null;
        } else if (c === "'" || c === '"') {
          quote = c;
        } else if (c === '}' && source[j + 1] === '}') {
          end = j;
          break;
        }
        j++;
      }
      if (end === -1) throw new ExpressionSyntaxError("Unterminated '${{' — missing '}}'", i);
      const exprSource = source.slice(exprStart, end);
      let ast: Node;
      try {
        ast = parseExpression(exprSource);
      } catch (e) {
        if (e instanceof ExpressionSyntaxError) {
          throw new ExpressionSyntaxError(e.message, exprStart + e.pos);
        }
        throw e;
      }
      flush();
      parts.push({ kind: 'expr', source: exprSource.trim(), ast, offset: exprStart });
      i = end + 2;
      continue;
    }
    text += source[i];
    i++;
  }
  flush();
  return { source, parts };
}

/**
 * Parse a field that holds a *bare expression* (`when`, `items`, guard conditions). Accepts either
 * the bare form (`inputs.n > 3`) or a single `${{ inputs.n > 3 }}` wrapper.
 */
export function parseExpressionField(source: string): Node {
  const trimmed = source.trim();
  if (trimmed.startsWith('${{')) {
    const tpl = parseTemplate(trimmed);
    if (tpl.parts.length === 1 && tpl.parts[0]!.kind === 'expr') return tpl.parts[0].ast;
    throw new ExpressionSyntaxError('Expected a single ${{ … }} expression', 0);
  }
  return parseExpression(source);
}

function display(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return canonicalize(v);
}

export function renderTemplate(
  tpl: Template,
  scope: Record<string, unknown>,
  options: EvalOptions = {},
): unknown {
  if (tpl.parts.length === 0) return '';
  if (tpl.parts.length === 1 && tpl.parts[0]!.kind === 'expr') {
    return evaluate(tpl.parts[0].ast, scope, options);
  }
  let out = '';
  for (const part of tpl.parts) {
    if (part.kind === 'text') {
      out += part.text;
      continue;
    }
    const v = evaluate(part.ast, scope, options);
    if (v === null || v === undefined) {
      throw new ExpressionError(
        'EXPR_NULL_IN_TEMPLATE',
        `'${part.source}' is null inside a string; use '${part.source} ?? "default"' to allow it`,
        part.offset,
      );
    }
    out += display(v);
  }
  return out;
}

/** Recursively resolve every `${{ }}` inside strings of a JSON-like value. Object keys are static. */
export function resolveValue(
  value: unknown,
  scope: Record<string, unknown>,
  options: EvalOptions = {},
): unknown {
  if (typeof value === 'string') {
    return hasTemplate(value) ? renderTemplate(parseTemplate(value), scope, options) : value;
  }
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, scope, options));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveValue(v, scope, options);
    return out;
  }
  return value;
}

export interface FoundTemplate {
  /** Location, e.g. `with.headers.x-id` or `with.items[0]`. */
  path: string;
  template?: Template;
  error?: ExpressionSyntaxError;
  /** The raw string the template came from. */
  source: string;
}

/** Find and parse every template inside a JSON-like value, reporting syntax errors by location. */
export function scanTemplates(value: unknown, basePath = ''): FoundTemplate[] {
  const found: FoundTemplate[] = [];
  const walk = (v: unknown, path: string) => {
    if (typeof v === 'string') {
      if (!hasTemplate(v)) return;
      try {
        found.push({ path, template: parseTemplate(v), source: v });
      } catch (e) {
        if (e instanceof ExpressionSyntaxError) found.push({ path, error: e, source: v });
        else throw e;
      }
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
    } else if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
    }
  };
  walk(value, basePath);
  return found;
}
