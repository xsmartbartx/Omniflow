import type { ErrorObject } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { contentHash, type Issue } from '../../core/index.ts';
import { formatPath, type Locator, type PathSegment, parsePointer } from './source-map.ts';

type AjvInstance = InstanceType<typeof Ajv2020>;
type ValidateFn = ReturnType<AjvInstance['compile']>;

// `ajv-formats` ships CommonJS; under NodeNext its default export is the module namespace.
const applyFormats = ((addFormats as unknown as { default?: unknown }).default ??
  addFormats) as unknown as (ajv: AjvInstance) => AjvInstance;

function createAjv(options: { useDefaults: boolean; strict: boolean }): AjvInstance {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: options.strict,
    strictTypes: false,
    discriminator: true,
    allowUnionTypes: true,
    useDefaults: options.useDefaults,
    coerceTypes: false,
    removeAdditional: false,
  });
  applyFormats(ajv);
  return ajv;
}

/** Strict instance for OmniFlow's own schemas (manifest, events …). */
const strictAjv = createAjv({ useDefaults: false, strict: true });
/** Lenient instance for author-supplied schemas (inputs, `produces`, capability contracts). */
const authorAjv = createAjv({ useDefaults: true, strict: false });

const cache = new Map<string, ValidateFn>();
const CACHE_LIMIT = 500;

function compileCached(ajv: AjvInstance, tag: string, schema: object): ValidateFn {
  const key = `${tag}:${contentHash(schema)}`;
  let fn = cache.get(key);
  if (!fn) {
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
    fn = ajv.compile(schema);
    cache.set(key, fn);
  }
  return fn;
}

/** Levenshtein distance, for "did you mean …?" hints. */
function distance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length]![b.length]!;
}

export function didYouMean(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const score = distance(input.toLowerCase(), c.toLowerCase());
    if (score < bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best !== undefined && bestScore <= Math.max(2, Math.floor(input.length / 3))
    ? best
    : undefined;
}

function describeType(schemaType: unknown): string {
  return Array.isArray(schemaType) ? schemaType.join(' or ') : String(schemaType);
}

function toIssue(err: ErrorObject, locate?: Locator): Issue {
  const path: PathSegment[] = parsePointer(err.instancePath);
  const params = err.params as Record<string, any>;
  let message: string;
  let code = `SCHEMA_${err.keyword.toUpperCase()}`;
  let keyLoc = false;

  switch (err.keyword) {
    case 'required':
      message = `Missing required property '${params.missingProperty}'`;
      break;
    case 'additionalProperties': {
      const extra = String(params.additionalProperty);
      const allowed = Object.keys((err.parentSchema as { properties?: object })?.properties ?? {});
      const hint = didYouMean(extra, allowed);
      message = `Unknown property '${extra}'${hint ? ` — did you mean '${hint}'?` : ''}`;
      path.push(extra);
      keyLoc = true;
      break;
    }
    case 'enum':
      message = `Must be one of: ${(params.allowedValues as unknown[]).map((v) => JSON.stringify(v)).join(', ')}`;
      break;
    case 'const':
      message = `Must be ${JSON.stringify(params.allowedValue)}`;
      break;
    case 'type':
      message = `Expected ${describeType(params.type)}`;
      break;
    case 'pattern':
      message = `Does not match the required pattern ${params.pattern}`;
      break;
    case 'minLength':
      message = `Must be at least ${params.limit} character(s) long`;
      break;
    case 'maxLength':
      message = `Must be at most ${params.limit} characters long`;
      break;
    case 'minimum':
    case 'maximum':
      message = `Must be ${params.comparison} ${params.limit}`;
      break;
    case 'minItems':
      message = `Must have at least ${params.limit} item(s)`;
      break;
    case 'maxItems':
      message = `Must have at most ${params.limit} item(s)`;
      break;
    case 'maxProperties':
      message = `Must have at most ${params.limit} properties`;
      break;
    case 'uniqueItems':
      message = 'Items must be unique';
      break;
    case 'propertyNames':
      message = 'Invalid property name';
      break;
    case 'discriminator':
      message =
        params.error === 'tag'
          ? `'${params.tag}' is required`
          : `Unknown ${params.tag} '${(err.data as Record<string, unknown> | undefined)?.[params.tag] ?? ''}'`;
      code = 'SCHEMA_DISCRIMINATOR';
      break;
    case 'oneOf':
      message = 'Does not match any allowed form';
      break;
    default:
      message = err.message ?? `Failed '${err.keyword}'`;
  }

  const pos = locate?.(path, { key: keyLoc });
  return {
    path: formatPath(path),
    code,
    message,
    ...(pos ? { line: pos.line, column: pos.column } : {}),
  };
}

export interface SchemaResult {
  ok: boolean;
  issues: Issue[];
}

/** Validate an OmniFlow-owned document against one of our own (strict) schemas. */
export function validateAgainstSchema(
  schema: object,
  value: unknown,
  locate?: Locator,
): SchemaResult {
  const fn = compileCached(strictAjv, 'strict', schema);
  const ok = fn(value) as boolean;
  if (ok) return { ok: true, issues: [] };
  // Drop noisy composite errors when a more specific one exists.
  const errors = (fn.errors ?? []).filter(
    (e) => e.keyword !== 'oneOf' || (fn.errors ?? []).length === 1,
  );
  const seen = new Set<string>();
  const issues: Issue[] = [];
  for (const e of errors) {
    const issue = toIssue(e, locate);
    const k = `${issue.path}|${issue.message}`;
    if (!seen.has(k)) {
      seen.add(k);
      issues.push(issue);
    }
  }
  return { ok: false, issues };
}

export interface ValueResult<T = unknown> {
  ok: boolean;
  /** The value with schema defaults applied (a copy — the input is never mutated). */
  value: T;
  issues: Issue[];
}

/**
 * Validate a runtime payload (workflow inputs, capability input/output) against an
 * author-supplied JSON Schema. Applies `default`s to a copy. No type coercion is performed.
 */
export function validateValue<T = unknown>(schema: object, value: unknown): ValueResult<T> {
  const fn = compileCached(authorAjv, 'author', schema);
  const copy = structuredClone(value);
  const ok = fn(copy) as boolean;
  if (ok) return { ok: true, value: copy as T, issues: [] };
  const issues = (fn.errors ?? []).map((e) => toIssue(e));
  return { ok: false, value: copy as T, issues };
}

/** Check that an author-supplied JSON Schema is itself valid and compilable. */
export function checkSchemaDefinition(schema: unknown): string | null {
  try {
    if (schema === null || typeof schema !== 'object') return 'Schema must be an object';
    if (!authorAjv.validateSchema(schema)) return authorAjv.errorsText(authorAjv.errors);
    compileCached(authorAjv, 'author', schema as object);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
