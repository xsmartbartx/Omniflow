import { collectReferences, ExpressionSyntaxError, type Issue, parseExpressionField } from '../../core/index.ts';
import { buildPolicySchema, POLICY_FACT_ROOTS, type PolicyDocument } from '../../schemas/policy-manifest.ts';
import { validateAgainstSchema } from '../validator/schema-validator.ts';
import { parseSource } from '../validator/source-map.ts';

const schema = buildPolicySchema();

export interface PolicyParseResult {
  ok: boolean;
  document?: PolicyDocument;
  issues: Issue[];
}

/** Parse and validate a `kind: Policy` document (YAML/JSON text or object). */
export function parsePolicyDocument(source: string | unknown): PolicyParseResult {
  let value: unknown = source;
  let locate: ReturnType<typeof parseSource>['locate'] | undefined;
  const issues: Issue[] = [];
  if (typeof source === 'string') {
    const parsed = parseSource(source, 256 * 1024);
    issues.push(...parsed.issues);
    if (parsed.value === undefined) return { ok: false, issues };
    value = parsed.value;
    locate = parsed.locate;
  }
  const res = validateAgainstSchema(schema, value, locate);
  issues.push(...res.issues);
  if (!res.ok) return { ok: false, issues };

  const doc = value as PolicyDocument;
  const ids = new Set<string>();
  doc.rules.forEach((rule, i) => {
    if (ids.has(rule.id)) issues.push({ path: `rules[${i}].id`, code: 'DUPLICATE_RULE', message: `Duplicate rule id '${rule.id}'` });
    ids.add(rule.id);
    try {
      const ast = parseExpressionField(rule.when);
      for (const ref of collectReferences(ast)) {
        if (!POLICY_FACT_ROOTS.includes(ref.root)) {
          issues.push({
            path: `rules[${i}].when`,
            code: 'UNKNOWN_FACT',
            message: `'${ref.root}' is not a policy fact (available: ${POLICY_FACT_ROOTS.join(', ')})`,
          });
        }
      }
    } catch (e) {
      if (e instanceof ExpressionSyntaxError) {
        issues.push({ path: `rules[${i}].when`, code: 'EXPRESSION_SYNTAX', message: `${e.message} (at character ${e.pos + 1})` });
      } else throw e;
    }
  });
  const errors = issues.filter((x) => x.severity !== 'warning');
  return errors.length === 0 ? { ok: true, document: doc, issues } : { ok: false, issues };
}
