// Pure formatting helpers (no DOM), shared by every view and unit-tested.

export function ago(iso, now = Date.now()) {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function until(iso, now = Date.now()) {
  if (!iso) return '—';
  const s = Math.round((Date.parse(iso) - now) / 1000);
  if (s <= 0) return 'now';
  if (s < 60) return `in ${s}s`;
  if (s < 3600) return `in ${Math.floor(s / 60)}m`;
  if (s < 86400) return `in ${Math.floor(s / 3600)}h`;
  return `in ${Math.floor(s / 86400)}d`;
}

export function duration(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} min ${Math.round((ms % 60000) / 1000)} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function percent(r, digits = 0) {
  return r === null || r === undefined ? '—' : `${(r * 100).toFixed(digits)}%`;
}

export function number(n) {
  return n === null || n === undefined ? '—' : new Intl.NumberFormat('en').format(Math.round(n * 100) / 100);
}

export function shortHash(hash, n = 12) {
  return hash
    ? String(hash)
        .replace(/^sha256:/, '')
        .slice(0, n)
    : '—';
}

export function truncate(s, n = 80) {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

export function timestamp(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? String(iso)
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

/** How a status (or severity) should be coloured. */
export function tone(status) {
  switch (status) {
    case 'succeeded':
    case 'approved':
    case 'published':
    case 'enabled':
    case 'ok':
    case 'closed':
    case 'active':
    case 'accepted':
    case 'low':
      return 'good';
    case 'failed':
    case 'compensation-failed':
    case 'denied':
    case 'rejected':
    case 'killed':
    case 'critical':
    case 'high':
    case 'open-circuit':
      return 'bad';
    case 'running':
    case 'compensating':
    case 'retry-wait':
    case 'waiting-approval':
    case 'waiting-event':
    case 'waiting-timer':
    case 'waiting-child':
    case 'pending':
    case 'pending-approval':
    case 'queued':
    case 'medium':
    case 'warning':
    case 'submitted':
    case 'rolled-back':
    case 'disabled':
    case 'timed-out':
      return 'warn';
    default:
      return 'neutral';
  }
}

export const TERMINAL_RUN = new Set(['succeeded', 'failed', 'rolled-back', 'compensation-failed', 'cancelled']);

/** Parse `key=value` lines into an object (used for quick input entry). */
export function coerceInput(type, raw) {
  const v = String(raw ?? '');
  if (v === '') return undefined;
  switch (type) {
    case 'integer':
      return Number.parseInt(v, 10);
    case 'number':
      return Number(v);
    case 'boolean':
      return v === 'true';
    case 'object':
    case 'array':
      return JSON.parse(v);
    default:
      return v;
  }
}
