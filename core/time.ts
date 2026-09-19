import { ValidationError } from './errors.ts';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Deterministic clock for tests and simulation runs. */
export class ManualClock implements Clock {
  private current: number;
  constructor(start: Date | string | number = '2026-01-01T00:00:00.000Z') {
    this.current = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current += ms;
  }
  set(to: Date | string | number): void {
    this.current = new Date(to).getTime();
  }
}

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Parse a duration into milliseconds. Accepts a number of ms, `250ms`, `30s`, `5m`, `2h`, `1d`,
 * compound `1h30m`, or ISO-8601 `PT1H30M` / `P1DT2H`.
 */
export function parseDuration(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) throw badDuration(input);
    return Math.round(input);
  }
  const text = input.trim();
  const iso = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(text);
  if (iso && text.length > 1 && !/^PT?$/i.test(text)) {
    const [, w, d, h, m, s] = iso;
    return Math.round(
      Number(w ?? 0) * UNIT_MS.w! +
        Number(d ?? 0) * UNIT_MS.d! +
        Number(h ?? 0) * UNIT_MS.h! +
        Number(m ?? 0) * UNIT_MS.m! +
        Number(s ?? 0) * 1000,
    );
  }
  const compound = /^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d|w))+$/.test(text);
  if (!compound) throw badDuration(input);
  let total = 0;
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d|w)/g)) {
    total += Number(m[1]) * UNIT_MS[m[2]!]!;
  }
  return Math.round(total);
}

function badDuration(input: unknown): ValidationError {
  return new ValidationError(`Invalid duration: ${JSON.stringify(input)}`, [
    { path: '', code: 'INVALID_DURATION', message: `Invalid duration ${JSON.stringify(input)}` },
  ]);
}

export function isDuration(input: unknown): boolean {
  try {
    parseDuration(input as string | number);
    return true;
  } catch {
    return false;
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const parts: string[] = [];
  let rest = Math.round(ms / 1000);
  for (const [unit, size] of [
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
    ['s', 1],
  ] as const) {
    const n = Math.floor(rest / size);
    if (n > 0) parts.push(`${n}${unit}`);
    rest -= n * size;
  }
  return parts.join('') || '0s';
}
