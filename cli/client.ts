/** A small typed client for the OmniFlow HTTP API, used by the CLI's remote commands. */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionError';
  }
}

export interface ClientOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  timeoutMs?: number;
}

export class ApiClient {
  private readonly base: string;
  private readonly key: string | undefined;
  private readonly timeout: number;

  constructor(opts: ClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.key = opts.apiKey;
    this.timeout = opts.timeoutMs ?? 30_000;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { accept: 'application/json', ...(this.key ? { authorization: `Bearer ${this.key}` } : {}), ...extra };
  }

  async request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: this.headers(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeout),
      });
    } catch (e) {
      throw new ConnectionError(`Could not reach ${this.base} (${(e as { cause?: { code?: string } }).cause?.code ?? (e as Error).message}). Is the server running, and is OMNIFLOW_URL correct?`);
    }
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) {
      const err = data?.error;
      throw new ApiError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? `HTTP ${res.status}`, err?.details);
    }
    return data as T;
  }

  get<T = any>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }
  post<T = any>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body ?? {});
  }
  put<T = any>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }
  del<T = any>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  /** Stream server-sent events, calling `onEvent` for each until the server closes the stream. */
  async stream(path: string, onEvent: (e: { id?: string; event: string; data: any }) => void, signal?: AbortSignal): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, { headers: this.headers({ accept: 'text/event-stream' }), ...(signal ? { signal } : {}) });
    } catch (e) {
      throw new ConnectionError(`Could not reach ${this.base}: ${(e as Error).message}`);
    }
    if (!res.ok || !res.body) {
      const t = await res.text();
      let err: any;
      try {
        err = JSON.parse(t).error;
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? `HTTP ${res.status}`);
    }
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let id: string | undefined;
        let event = 'message';
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('id:')) id = line.slice(3).trim();
          else if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trim());
        }
        if (data.length > 0) {
          let parsed: unknown = data.join('\n');
          try {
            parsed = JSON.parse(data.join('\n'));
          } catch {
            /* keep text */
          }
          onEvent({ ...(id ? { id } : {}), event, data: parsed });
        }
      }
    }
  }
}
