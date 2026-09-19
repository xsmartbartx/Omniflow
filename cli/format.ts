import type { Issue } from '../core/index.ts';

export interface Style {
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
}

export function makeStyle(enabled: boolean): Style {
  const wrap = (open: number, close: number) => (s: string) => (enabled ? `[${open}m${s}[${close}m` : s);
  return { bold: wrap(1, 22), dim: wrap(2, 22), red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39), cyan: wrap(36, 39) };
}

/** Render a validation issue compiler-style, with the offending source line and a caret. */
export function renderIssue(style: Style, file: string, source: string | undefined, issue: Issue): string {
  const warning = issue.severity === 'warning';
  const head = `${warning ? style.yellow('warning') : style.red('error')}${style.dim(`[${issue.code}]`)}: ${issue.message}`;
  if (!issue.line || source === undefined) return `${head}${issue.path ? style.dim(`\n  at ${issue.path}`) : ''}`;
  const lines = source.split('\n');
  const text = lines[issue.line - 1] ?? '';
  const gutter = String(issue.line).length;
  const pad = ' '.repeat(gutter);
  const col = Math.max(1, issue.column ?? 1);
  return [
    head,
    style.dim(`${pad}--> ${file}:${issue.line}:${col}${issue.path ? `  (${issue.path})` : ''}`),
    style.dim(`${pad} |`),
    `${style.dim(`${issue.line} |`)} ${text}`,
    `${style.dim(`${pad} |`)} ${' '.repeat(col - 1)}${warning ? style.yellow('^') : style.red('^')}`,
  ].join('\n');
}

export function table(rows: string[][], headers: string[], style: Style): string {
  const all = [headers, ...rows];
  const widths = headers.map((_, i) => Math.max(...all.map((r) => visibleLength(r[i] ?? ''))));
  const line = (r: string[]) => r.map((c, i) => c + ' '.repeat(widths[i]! - visibleLength(c))).join('  ').trimEnd();
  return [style.bold(line(headers)), ...rows.map(line)].join('\n');
}

const visibleLength = (s: string) => s.replace(/\[[0-9;]*m/g, '').length;

export function statusColour(style: Style, status: string): string {
  if (['succeeded', 'approved', 'published', 'ok', 'closed'].includes(status)) return style.green(status);
  if (['failed', 'compensation-failed', 'denied', 'rejected', 'killed', 'open'].includes(status)) return style.red(status);
  if (['running', 'queued', 'pending', 'waiting-approval', 'waiting-event', 'compensating', 'retry-wait', 'pending-approval'].includes(status)) return style.yellow(status);
  return status;
}

export function humanDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return m < 60 ? `${m}m${Math.round((ms % 60_000) / 1000)}s` : `${Math.floor(m / 60)}h${m % 60}m`;
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
