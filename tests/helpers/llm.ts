import type { LlmClient, LlmRequest, LlmResponse } from '../../authoring/index.ts';

type Reply = string | ((req: LlmRequest, n: number) => string | Promise<string>);

/** A model that says exactly what the test scripted, and remembers what it was asked. */
export class ScriptedLlm implements LlmClient {
  readonly model = 'scripted-model';
  readonly calls: LlmRequest[] = [];
  private readonly replies: Reply[];

  constructor(...replies: Reply[]) {
    this.replies = replies;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(structuredClone(req));
    const n = this.calls.length;
    const r = this.replies[Math.min(n - 1, this.replies.length - 1)];
    if (r === undefined) throw new Error('ScriptedLlm has no reply configured');
    const text = typeof r === 'function' ? await r(req, n) : r;
    return { text, model: this.model, usage: { inputTokens: 100, outputTokens: 50 }, stopReason: 'end_turn' };
  }
}

/** A reply in the format the Planner asks for. */
export const modelReply = (manifest: string, o: { rationale?: string; questions?: string[] } = {}): string =>
  `<rationale>\n${o.rationale ?? 'A straightforward workflow.'}\n</rationale>\n<questions>\n${(o.questions ?? []).map((q) => `- ${q}`).join('\n') || 'none'}\n</questions>\n\`\`\`yaml\n${manifest}\n\`\`\``;
