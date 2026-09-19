import { type AdapterConfig, safeRequest } from '../capabilities/index.ts';
import { OmniflowError } from '../core/index.ts';
import type { LlmClient } from '../authoring/llm.ts';

/**
 * The Anthropic Messages API behind the authoring agents' `LlmClient` port. It goes through the same
 * SSRF-safe HTTP client as every other outbound call: one allowed host, no redirects, bounded size.
 * Returns `undefined` when no API key is configured, and the platform then reports AI authoring as
 * unavailable instead of failing obscurely.
 */
export function createAnthropicClient(config: AdapterConfig): LlmClient | undefined {
  if (!config.llm.apiKey) return undefined;
  const base = config.llm.baseUrl.replace(/\/$/, '');
  const u = new URL(base);
  const allowedHost = `${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
  const apiKey = config.llm.apiKey;

  return {
    model: config.llm.model,
    async complete(req, signal) {
      const res = await safeRequest({
        method: 'POST',
        url: `${base}/v1/messages`,
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'user-agent': config.http.userAgent },
        body: JSON.stringify({ model: config.llm.model, max_tokens: req.maxTokens ?? config.llm.maxOutputTokens, system: req.system, messages: req.messages }),
        signal: signal ?? AbortSignal.timeout(180_000),
        allowedHosts: [allowedHost],
        allowPrivate: config.allowPrivateNetworks,
        maxResponseBytes: 4 * 1024 * 1024,
        maxRedirects: 0,
        timeoutMs: 180_000,
        followRedirects: false,
      });
      if (res.status === 401 || res.status === 403) {
        throw new OmniflowError('LLM_AUTH', 'The AI provider rejected the API key. Check OMNIFLOW_LLM_API_KEY.', { errorClass: 'authorisation', retryable: false });
      }
      if (res.status === 429 || res.status === 529 || res.status >= 500) {
        throw new OmniflowError('LLM_UNAVAILABLE', `The AI provider is unavailable or rate limiting (HTTP ${res.status}). Try again shortly.`, { errorClass: 'transient', retryable: true });
      }
      const text = res.body.toString('utf8');
      if (res.status >= 400) {
        let detail = '';
        try {
          detail = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? '';
        } catch {
          /* not JSON */
        }
        throw new OmniflowError('LLM_REJECTED', `The AI provider rejected the request (HTTP ${res.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`, { errorClass: 'business', retryable: false });
      }
      let body: { content?: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number }; stop_reason?: string; model?: string };
      try {
        body = JSON.parse(text);
      } catch {
        throw new OmniflowError('LLM_BAD_RESPONSE', 'The AI provider returned something that is not JSON', { errorClass: 'systemic', retryable: true });
      }
      return {
        text: (body.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join(''),
        model: body.model ?? config.llm.model,
        usage: { inputTokens: body.usage?.input_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? 0 },
        stopReason: body.stop_reason ?? 'unknown',
      };
    },
  };
}
