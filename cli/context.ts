import { ApiClient } from './client.ts';
import { flag, type ParsedArgs, UsageError } from './args.ts';
import type { Style } from './format.ts';

export type Env = Record<string, string | undefined>;

/** Everything a command may touch outside its own arguments — injectable so the CLI is testable. */
export interface CliContext {
  out(text: string): void;
  err(text: string): void;
  readStdin(): Promise<string>;
  env: Env;
  cwd: string;
  style: Style;
  json: boolean;
  args: ParsedArgs;
  /** Sleep helper (real timers by default). */
  sleep(ms: number): Promise<void>;
}

/** Print either machine-readable JSON (`--json`) or the human rendering. */
export function emit(ctx: CliContext, data: unknown, human: () => string): void {
  ctx.out(ctx.json ? `${JSON.stringify(data, null, 2)}\n` : `${human()}\n`);
}

export const DEFAULT_URL = 'http://127.0.0.1:8080';

/** An API client configured from `--url`/`--key` or `OMNIFLOW_URL`/`OMNIFLOW_API_KEY`. */
export function client(ctx: CliContext, opts: { needKey?: boolean } = {}): ApiClient {
  const key = flag(ctx.args, 'key') ?? ctx.env.OMNIFLOW_API_KEY;
  if (opts.needKey !== false && !key) {
    throw new UsageError(
      'No API key. Set OMNIFLOW_API_KEY (or pass --key). Create one with: omniflow admin create-api-key --name cli --role operator',
    );
  }
  return new ApiClient({ baseUrl: flag(ctx.args, 'url') ?? ctx.env.OMNIFLOW_URL ?? DEFAULT_URL, apiKey: key });
}

export function need(ctx: CliContext, index: number, what: string): string {
  const v = ctx.args.positionals[index];
  if (!v) throw new UsageError(`Missing <${what}>`);
  return v;
}
