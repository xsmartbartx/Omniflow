/**
 * The model, as the authoring agents see it: a text-in, text-out port. Agents get no tools, no network
 * and no registry — only this. The composition root supplies an implementation (Anthropic Messages API),
 * and tests supply a scripted one.
 */
export interface LlmRequest {
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens?: number;
}

export interface LlmResponse {
  text: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  stopReason: string;
}

export interface LlmClient {
  readonly model: string;
  complete(req: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;
}
