import { redact } from './sanitize.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export interface LogRecord {
  level: Exclude<LogLevel, 'silent'>;
  time: string;
  msg: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export type LogSink = (record: LogRecord) => void;

const stdoutSink: LogSink = (record) => {
  process.stdout.write(`${JSON.stringify(record)}\n`);
};

export interface LoggerOptions {
  level?: LogLevel;
  sink?: LogSink;
  bindings?: Record<string, unknown>;
}

/** Structured JSON logger. Every field is redacted before it reaches the sink. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const threshold = ORDER[level];
  const sink = options.sink ?? stdoutSink;
  const bindings = options.bindings ?? {};

  const emit = (lvl: Exclude<LogLevel, 'silent'>, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < threshold) return;
    const safe = redact({ ...bindings, ...fields }) as Record<string, unknown>;
    sink({ level: lvl, time: new Date().toISOString(), msg, ...safe });
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (extra) => createLogger({ level, sink, bindings: { ...bindings, ...extra } }),
  };
}

export const nullLogger: Logger = createLogger({ level: 'silent' });
