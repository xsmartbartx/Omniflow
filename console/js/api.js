// Same-origin API client. Authentication is the HttpOnly session cookie; writes carry the CSRF header.

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const listeners = new Set();
/** Called when the server says the session is gone. */
export function onUnauthenticated(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function request(method, path, body, accept = 'application/json') {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        accept,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'x-requested-with': 'omniflow' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the OmniFlow server. Check your connection.');
  }
  const text = await res.text();
  if (!res.ok) {
    let err;
    try {
      err = JSON.parse(text).error;
    } catch {
      /* not JSON */
    }
    if (res.status === 401 && !path.startsWith('/v1/auth/login')) for (const fn of listeners) fn();
    throw new ApiError(
      res.status,
      err?.code ?? `HTTP_${res.status}`,
      err?.message ?? `Request failed (HTTP ${res.status})`,
      err?.details,
    );
  }
  if (accept !== 'application/json') return text;
  return text ? JSON.parse(text) : null;
}

export const get = (path) => request('GET', path);
export const post = (path, body = {}) => request('POST', path, body);
export const put = (path, body) => request('PUT', path, body);
export const patch = (path, body) => request('PATCH', path, body);
export const del = (path) => request('DELETE', path);
export const getText = (path) => request('GET', path, undefined, 'text/plain, text/markdown');

export const enc = encodeURIComponent;

/** Issues (validation problems) carried by an ApiError, if any. */
export function issuesOf(e) {
  return Array.isArray(e?.details?.issues) ? e.details.issues : [];
}

/** Follow a server-sent-event stream with fetch (EventSource cannot see named events generically). */
export async function stream(path, onEvent, signal) {
  const res = await fetch(path, { credentials: 'same-origin', headers: { accept: 'text/event-stream' }, signal });
  if (!res.ok || !res.body)
    throw new ApiError(res.status, `HTTP_${res.status}`, `Could not open the live stream (HTTP ${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf('\n\n');
    while (idx >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('\n');
      if (data) {
        try {
          onEvent(JSON.parse(data));
        } catch {
          /* ignore malformed frames */
        }
      }
      idx = buffer.indexOf('\n\n');
    }
  }
}
