import type { Issue } from '../../core/index.ts';
import { detectInjection, frameAsData } from '../../security/pentest/index.ts';
import type { CapabilityDeclaration } from '../../schemas/index.ts';
import type { LlmClient } from '../llm.ts';
import { capabilityCatalogue, plannerSystemPrompt } from './prompt.ts';

/**
 * The Planner Agent (architecture §5.1 #5). Intent in, *draft manifest* out. It talks to the model and
 * to a validator, and to nothing else: it has no registry, scheduler or orchestrator, and the layer
 * checker keeps it that way. The validator is a read-only port, so a manipulated model can at worst
 * produce a draft that a human then reads.
 */

export interface ValidationOutcome {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  risk?: { score: number; level: string; blocking: boolean; findings: Array<{ ruleId: string; severity: string; blocking: boolean; message: string; stepId?: string }> };
}

export interface PlannerDeps {
  llm: LlmClient;
  /** Read-only: parse, compile and risk-review a manifest without saving it. */
  validate: (manifest: string) => ValidationOutcome;
  capabilities: () => CapabilityDeclaration[];
  /** Model calls allowed per request, including the first (default 3). */
  maxAttempts?: number;
}

export interface PlanRequest {
  /** What the person wants, in their words. */
  intent: string;
  /** Revise this manifest instead of starting from scratch. */
  baseManifest?: string;
  /** Third-party material to analyse (a legacy script, a pasted ticket). Always framed as data. */
  untrusted?: Array<{ label: string; content: string }>;
}

export interface PlanResult {
  /** True when the manifest passed validation with no errors and no blocking findings. */
  ok: boolean;
  manifest?: string;
  rationale: string;
  openQuestions: string[];
  attempts: number;
  validation: ValidationOutcome;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
  /** Prompt-injection signals found in the untrusted material (informational — the material was framed as data regardless). */
  injectionSignals: string[];
}

const MAX_INTENT = 8_000;
const MAX_UNTRUSTED = 60_000;

export class Planner {
  private readonly llm: LlmClient;
  private readonly validate: PlannerDeps['validate'];
  private readonly capabilities: PlannerDeps['capabilities'];
  private readonly maxAttempts: number;

  constructor(deps: PlannerDeps) {
    this.llm = deps.llm;
    this.validate = deps.validate;
    this.capabilities = deps.capabilities;
    this.maxAttempts = Math.max(1, deps.maxAttempts ?? 3);
  }

  async plan(req: PlanRequest, signal?: AbortSignal): Promise<PlanResult> {
    const system = plannerSystemPrompt(capabilityCatalogue(this.capabilities()));
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [{ role: 'user', content: this.brief(req) }];
    const injectionSignals = (req.untrusted ?? []).flatMap((u) => detectInjection(u.content).map((m) => `${u.label}: ${m.pattern}`));
    const usage = { inputTokens: 0, outputTokens: 0 };
    let model = this.llm.model;

    let last: { manifest?: string; rationale: string; openQuestions: string[] } = { rationale: '', openQuestions: [] };
    let validation: ValidationOutcome = { ok: false, errors: [{ path: '', code: 'NO_MANIFEST', message: 'The model did not produce a manifest' }], warnings: [] };

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const res = await this.llm.complete({ system, messages, maxTokens: 8_000 }, signal);
      usage.inputTokens += res.usage.inputTokens;
      usage.outputTokens += res.usage.outputTokens;
      model = res.model;
      const parsed = parseReply(res.text);
      messages.push({ role: 'assistant', content: res.text });

      if (!parsed.manifest) {
        validation = { ok: false, errors: [{ path: '', code: 'NO_MANIFEST', message: 'The reply contained no ```yaml block' }], warnings: [] };
        messages.push({ role: 'user', content: 'Your reply did not contain a manifest. Reply again in the required format, with the complete manifest in a ```yaml block.' });
        continue;
      }
      last = { manifest: parsed.manifest, rationale: parsed.rationale || last.rationale, openQuestions: parsed.openQuestions };
      validation = this.validate(parsed.manifest);
      const blocking = validation.risk?.findings.filter((f) => f.blocking) ?? [];
      if (validation.ok && blocking.length === 0) {
        return { ok: true, ...last, manifest: parsed.manifest, attempts: attempt, validation, usage, model, injectionSignals };
      }
      messages.push({ role: 'user', content: repairMessage(validation, blocking) });
    }

    return { ok: false, ...last, attempts: this.maxAttempts, validation, usage, model, injectionSignals };
  }

  private brief(req: PlanRequest): string {
    const parts: string[] = [];
    parts.push(req.baseManifest ? 'Revise the existing workflow below according to the request. Keep everything that is not affected, and bump metadata.version (semver, patch or minor as appropriate).' : 'Create a new workflow for the request below.');
    parts.push(`Request:\n${req.intent.slice(0, MAX_INTENT)}`);
    if (req.baseManifest) parts.push(`Existing manifest:\n\`\`\`yaml\n${req.baseManifest}\n\`\`\``);
    let budget = MAX_UNTRUSTED;
    for (const u of req.untrusted ?? []) {
      const content = u.content.slice(0, budget);
      budget -= content.length;
      parts.push(frameAsData(u.label, content));
      if (budget <= 0) break;
    }
    return parts.join('\n\n');
  }
}

function repairMessage(v: ValidationOutcome, blocking: NonNullable<ValidationOutcome['risk']>['findings']): string {
  const lines: string[] = [];
  for (const e of v.errors.slice(0, 20)) lines.push(`- [${e.code}] ${e.path ? `${e.path}: ` : ''}${e.message}${e.line ? ` (line ${e.line})` : ''}`);
  for (const f of blocking.slice(0, 10)) lines.push(`- [risk:${f.ruleId}] ${f.message}${f.stepId ? ` (step ${f.stepId})` : ''}`);
  return `The validator rejected that manifest:\n${lines.join('\n')}\n\nFix these problems and reply again in the same format with the COMPLETE corrected manifest. Do not remove functionality to make errors go away, and do not invent capabilities.`;
}

/** Pull the sections out of a model reply. Tolerant of missing tags and of prose around the fenced block. */
export function parseReply(text: string): { rationale: string; openQuestions: string[]; manifest?: string } {
  const tag = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i').exec(text)?.[1]?.trim() ?? '';
  const fences = [...text.matchAll(/```(?:ya?ml)?[ \t]*\n([\s\S]*?)```/gi)].map((m) => m[1]!.trim());
  // the manifest is the (last) fenced block that looks like one
  const manifest = [...fences].reverse().find((f) => /^\s*apiVersion:/m.test(f));
  const questions = tag('questions')
    .split('\n')
    .map((l) => l.replace(/^\s*[-*•]\s*/, '').trim())
    .filter((l) => l && !/^none\.?$/i.test(l));
  return { rationale: tag('rationale'), openQuestions: questions, ...(manifest ? { manifest } : {}) };
}
