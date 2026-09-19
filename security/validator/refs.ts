import semver from 'semver';

/** A reference to a capability: `name@constraint`, e.g. `http-get@^1`. */
export interface CapabilityRef {
  name: string;
  range: string;
}

const NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Returns `null` when `ref` is not `name@<valid, pinned semver range>`. */
export function parseCapabilityRef(ref: string): CapabilityRef | null {
  const at = ref.lastIndexOf('@');
  if (at <= 0) return null;
  const name = ref.slice(0, at);
  const range = ref.slice(at + 1).trim();
  if (!NAME.test(name)) return null;
  if (range === '' || range === '*' || range === 'latest' || range === 'x') return null;
  if (semver.validRange(range) === null) return null;
  return { name, range };
}

const HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

/** Egress entries are hostnames, optionally with a leading `*.` wildcard and/or a port. Bare `*` is refused. */
export function isValidEgressHost(host: string): boolean {
  return HOST.test(host) && host !== '*' && host.length <= 253;
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().startsWith(value);
}

/**
 * Heuristic for catastrophic-backtracking patterns (nested quantifiers such as `(a+)+`, `(.*)*`,
 * `(a|aa)+`). Author-supplied patterns run against untrusted input, so anything suspicious is
 * refused at validation time.
 */
export function isSuspiciousRegex(pattern: string): boolean {
  if (pattern.length > 500) return true;
  if (/\([^()]*[+*][^()]*\)\s*[+*{]/.test(pattern)) return true;
  if (/\([^()]*\|[^()]*\)\s*[+*{]/.test(pattern)) return true;
  if (/\.\*.*\.\*.*\.\*/.test(pattern)) return true;
  return false;
}
