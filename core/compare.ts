/**
 * Locale-independent string order: by UTF-16 code unit, exactly what `Array.prototype.sort()` does with no
 * argument. Written out as a function so intent is explicit and the order is stable across machines (plan hashes,
 * canonical JSON and the audit chain depend on it; `localeCompare` would make them depend on the locale).
 */
export function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
