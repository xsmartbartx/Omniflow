import * as api from './api.js';

/** Who is signed in, and what they may do. */
export const session = { me: null, info: null };

export async function loadSession() {
  session.me = await api.get('/v1/auth/me');
  return session.me;
}

export function clearSession() {
  session.me = null;
}

export const can = (action) => session.me?.can?.[action] === true;
export const roles = () => session.me?.principal?.roles ?? [];
export const isAdmin = () => roles().includes('admin');
