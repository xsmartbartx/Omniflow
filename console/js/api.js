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
export const onUnauthenticated = (fn) => (listeners.add(fn), () => listeners.delete(fn));

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
    throw new ApiError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? `Request failed (HTTP ${res.status})`, err?.details);
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
