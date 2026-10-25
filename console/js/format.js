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

/** Turn a search term into a test. `*` matches any run of characters; everything else is literal text. */
export function matcher(term) {
  const t = term.trim().toLowerCase();
  if (!t) return () => true;
  if (!t.includes('*')) return (text) => text.includes(t);
  const re = new RegExp(
    t
      .split('*')
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, String.raw`\$&`))
      .join('.*'),
  );
  return (text) => re.test(text);
}

/** `plural(1, 'step')` is "step", `plural(2, 'step')` is "steps"; pass the plural form for irregular words. */
export const plural = (n, one, many = `${one}s`) => (n === 1 ? one : many);

const CLASS_WHY = {
  transient: 'a temporary problem (network, timeout, rate limit)',
  contract: 'the input or output did not match its schema',
  authorisation: 'it was not allowed to do this',
  business: 'a business rule said no',
  systemic: 'a problem in a dependency or the platform',
  catastrophic: 'a failure that must not be repeated automatically',
};

/**
 * One plain sentence on why a step retried or stopped, from fields the run already carries.
 * Returns null when there is nothing to explain (a step that simply worked the first time).
 */
export function stepOutcome(step) {
  const { status, attempt = 1, maxAttempts = 1, error } = step;
  const why = error ? (CLASS_WHY[error.class] ?? 'an error') : null;
  if (status === 'retry-wait')
    return `Attempt ${attempt} of ${maxAttempts} failed${why ? ` because of ${why}` : ''}. It is waiting to try again.`;
  if (status === 'failed' && error) {
    if (error.retryable === false)
      return `Stopped after ${attempt} ${plural(attempt, 'attempt')}: ${why}, and ${error.class} errors are not retried automatically.`;
    if (attempt >= maxAttempts)
      return maxAttempts > 1
        ? `Gave up after ${maxAttempts} attempts: ${why}, and the retry limit was reached.`
        : `Failed on its only attempt: ${why}. This step is not set to retry.`;
    return `Stopped after ${attempt} ${plural(attempt, 'attempt')} of ${maxAttempts}: ${why}.`;
  }
  if (status === 'succeeded' && attempt > 1)
    return `Succeeded on attempt ${attempt} of ${maxAttempts}, after earlier attempts failed.`;
  return null;
}
