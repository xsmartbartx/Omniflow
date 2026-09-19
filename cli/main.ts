#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OmniflowError } from '../core/index.ts';
import { has, parseArgs, UsageError } from './args.ts';
import { ApiError, ConnectionError } from './client.ts';
import { adminCommand } from './commands/admin.ts';
import { docsCommand, draftsCommand, explainCommand, importCommand, planCommand } from './commands/authoring.ts';
import { compileCommand, devCommand, validateCommand } from './commands/local.ts';
import {
  alertsCommand,
  analyzeCommand,
  approvalsCommand,
  auditCommand,
  capabilitiesCommand,
  changesCommand,
  insightsCommand,
  proposalsCommand,
  publishCommand,
  runCommand,
  runsCommand,
  secretsCommand,
  statusCommand,
  workflowsCommand,
} from './commands/remote.ts';
import type { CliContext, Env } from './context.ts';
import { makeStyle } from './format.ts';
import { HELP } from './help.ts';

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  readStdin(): Promise<string>;
}

type Command = (ctx: CliContext) => Promise<number>;

const COMMANDS: Record<string, Command> = {
  validate: validateCommand,
  compile: compileCommand,
  dev: devCommand,
  status: statusCommand,
  workflows: workflowsCommand,
  workflow: workflowsCommand,
  publish: publishCommand,
  run: runCommand,
  runs: runsCommand,
  approvals: approvalsCommand,
  changes: changesCommand,
  capabilities: capabilitiesCommand,
  secrets: secretsCommand,
  audit: auditCommand,
  insights: insightsCommand,
  alerts: alertsCommand,
  analyze: analyzeCommand,
  proposals: proposalsCommand,
  plan: planCommand,
  drafts: draftsCommand,
  import: importCommand,
  explain: explainCommand,
  docs: docsCommand,
  admin: adminCommand,
};

export function packageVersion(): string {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    for (const candidate of [join(root, 'package.json'), join(root, '..', 'package.json')]) {
      try {
        return JSON.parse(readFileSync(candidate, 'utf8')).version;
      } catch {
        /* try the next location (src vs dist layout) */
      }
    }
  } catch {
    /* fall through */
  }
  return '0.0.0';
}

/**
 * Run the CLI. Returns the process exit code instead of exiting, so it can be driven from tests.
 * 0 = success, 1 = the operation failed, 2 = usage error.
 */
export async function runCli(
  argv: readonly string[],
  io: CliIo,
  env: Env = process.env,
  cwd: string = process.cwd(),
): Promise<number> {
  const args = parseArgs(argv);
  // Colour only when the entry point saw a terminal (it sets OMNIFLOW_COLOR_FORCE) and nobody opted out.
  const color =
    env.OMNIFLOW_COLOR_FORCE !== undefined &&
    !has(args, 'no-color') &&
    env.NO_COLOR === undefined &&
    env.TERM !== 'dumb';
  const style = makeStyle(color);
  const ctx: CliContext = {
    out: (t) => io.out(t),
    err: (t) => io.err(t),
    readStdin: () => io.readStdin(),
    env,
    cwd,
    style,
    json: has(args, 'json'),
    args,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };

  if (has(args, 'version')) {
    io.out(`${packageVersion()}\n`);
    return 0;
  }
  const name = args.positionals[0];
  if (!name || name === 'help' || has(args, 'help')) {
    io.out(HELP);
    return name || has(args, 'help') ? 0 : 2;
  }
  const command = COMMANDS[name];
  if (!command) {
    io.err(`${style.red('error')}: unknown command '${name}'\n\n${HELP}`);
    return 2;
  }

  try {
    return await command(ctx);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`${style.red('error')}: ${e.message}\n${style.dim("Run 'omniflow --help' for usage.")}\n`);
      return 2;
    }
    if (e instanceof ApiError) {
      const hint =
        e.status === 401
          ? `\n${style.dim('Check OMNIFLOW_API_KEY. Create a key with: omniflow admin create-api-key --name cli')}`
          : '';
      io.err(`${style.red('error')}${style.dim(`[${e.code}]`)}: ${e.message}${hint}\n`);
      const issues = (e.details as { issues?: Array<{ path: string; message: string }> } | undefined)?.issues;
      if (issues?.length) for (const i of issues) io.err(`  - ${i.path ? `${i.path}: ` : ''}${i.message}\n`);
      return 1;
    }
    if (e instanceof ConnectionError) {
      io.err(`${style.red('error')}: ${e.message}\n`);
      return 1;
    }
    if (e instanceof OmniflowError) {
      io.err(`${style.red('error')}${style.dim(`[${e.code}]`)}: ${e.message}\n`);
      return 1;
    }
    io.err(`${style.red('unexpected error')}: ${(e as Error).stack ?? String(e)}\n`);
    return 1;
  }
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

if (import.meta.main) {
  runCli(
    process.argv.slice(2),
    { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t), readStdin: readAllStdin },
    { ...process.env, ...(process.stdout.isTTY ? { OMNIFLOW_COLOR_FORCE: '1' } : {}) },
  ).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`Fatal: ${(e as Error).message}\n`);
      process.exitCode = 1;
    },
  );
}
