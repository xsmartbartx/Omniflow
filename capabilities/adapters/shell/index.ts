import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import type { CapabilityContext, CapabilityDeclaration } from '../../../schemas/index.ts';
import { type CapabilityAdapter, CapabilityError } from '../../contract/types.ts';
import type { AdapterConfig } from '../config.ts';

interface ShellInput {
  argv: string[];
  stdin?: string;
  env?: Record<string, string>;
  expectExit?: number[];
  /** Exit codes that indicate a transient condition and may be retried. */
  retryableExit?: number[];
}

interface ShellOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_ARG = 8192;
const MAX_ARGV_TOTAL = 128 * 1024;

/**
 * `shell-exec` — the migration bridge (architecture §7.2, §11.4). It lets an existing script run
 * unmodified as a step on day one, under supervision. It is also the largest risk surface, so it is
 * constrained beyond any other capability:
 *
 *  - the command is an argument vector, never a shell string — the injection class is removed;
 *  - the executable must be on an operator-maintained absolute-path allow-list;
 *  - the environment is scrubbed: only an operator allow-list plus the step's declared variables;
 *  - the working directory is a fresh scratch directory, discarded at step end;
 *  - output is size-capped and the whole process group is killed on timeout or cancellation;
 *  - every shell step must carry a sunset date (enforced by the Compiler).
 *
 * Network isolation and resource limits are enforced by the container the engine runs in; run
 * shell steps in a dedicated, network-restricted runner for anything beyond trusted scripts.
 */
export function createShellCapabilities(config: AdapterConfig): CapabilityAdapter[] {
  const allowed = new Set(config.shell.allowedCommands.map((c) => normalize(c)));

  const declaration: CapabilityDeclaration = {
    name: 'shell-exec',
    version: '1.0.0',
    family: 'shell',
    description:
      'Run an allow-listed executable with an argument vector (never a shell string). The migration bridge for existing scripts: supervised, time-boxed, with a scrubbed environment and a throw-away working directory.',
    inputSchema: {
      type: 'object',
      required: ['argv'],
      additionalProperties: false,
      properties: {
        argv: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'string', maxLength: MAX_ARG } },
        stdin: { type: 'string', maxLength: 1_000_000 },
        env: { type: 'object', maxProperties: 50, additionalProperties: { type: 'string', maxLength: 8192 } },
        expectExit: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 255 }, maxItems: 10 },
        retryableExit: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 255 }, maxItems: 10 },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['exitCode', 'stdout', 'stderr', 'truncated', 'durationMs'],
      properties: {
        exitCode: { type: 'integer' },
        stdout: { type: 'string' },
        stderr: { type: 'string' },
        truncated: { type: 'boolean' },
        durationMs: { type: 'integer' },
      },
      additionalProperties: false,
    },
    effect: 'effectful',
    scopes: ['process:exec'],
    egress: { mode: 'none' },
    costModel: { unitsPerInvocation: 1, latencyClass: 'slow' },
    failureModes: [
      {
        code: 'SHELL_COMMAND_NOT_ALLOWED',
        class: 'authorisation',
        retryable: false,
        description: 'The executable is not on the allow-list',
      },
      {
        code: 'SHELL_EXIT_NONZERO',
        class: 'business',
        retryable: false,
        description: 'The command exited with an unexpected status',
      },
      {
        code: 'SHELL_EXIT_RETRYABLE',
        class: 'transient',
        retryable: true,
        description: 'The command exited with a status the step declared retryable',
      },
      {
        code: 'SHELL_NOT_FOUND',
        class: 'contract',
        retryable: false,
        description: 'The executable could not be started',
      },
    ],
    dataClassification: 'confidential',
    dryRun: 'simulate',
  };

  const adapter: CapabilityAdapter<ShellInput, ShellOutput> = {
    declaration,
    simulate: async () => ({ exitCode: 0, stdout: '', stderr: '', truncated: false, durationMs: 0 }),
    async execute(ctx: CapabilityContext, input: ShellInput): Promise<ShellOutput> {
      const [exe, ...args] = input.argv;
      if (!exe || !isAbsolute(exe) || !allowed.has(normalize(exe))) {
        throw new CapabilityError(
          'SHELL_COMMAND_NOT_ALLOWED',
          `'${exe ?? ''}' is not on the shell allow-list (absolute paths only)`,
          {
            errorClass: 'authorisation',
            retryable: false,
          },
        );
      }
      if (input.argv.some((a) => a.includes('\0')) || input.argv.reduce((n, a) => n + a.length, 0) > MAX_ARGV_TOTAL) {
        throw new CapabilityError('SHELL_ARGV_INVALID', 'Arguments contain NUL bytes or are too large', {
          errorClass: 'contract',
          retryable: false,
        });
      }
      for (const name of Object.keys(input.env ?? {})) {
        if (!ENV_NAME.test(name)) {
          throw new CapabilityError('SHELL_ENV_INVALID', `Invalid environment variable name '${name}'`, {
            errorClass: 'contract',
            retryable: false,
          });
        }
      }

      await mkdir(config.shell.scratchRoot, { recursive: true, mode: 0o700 });
      const scratch = await mkdtemp(join(config.shell.scratchRoot, 'step-'));
      const env: Record<string, string> = {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        LANG: 'C.UTF-8',
        HOME: scratch,
        TMPDIR: scratch,
      };
      for (const name of config.shell.passEnv) if (process.env[name] !== undefined) env[name] = process.env[name]!;
      Object.assign(env, input.env ?? {});

      const max = config.shell.maxOutputBytes;
      const started = Date.now();
      try {
        return await new Promise<ShellOutput>((resolve, reject) => {
          const child = spawn(exe, args, {
            cwd: scratch,
            env,
            shell: false,
            detached: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          });
          let out = '';
          let err = '';
          let truncated = false;
          let settled = false;
          const killGroup = (sig: NodeJS.Signals) => {
            try {
              if (child.pid) process.kill(-child.pid, sig);
            } catch {
              /* already gone */
            }
          };
          const onAbort = () => {
            killGroup('SIGTERM');
            setTimeout(() => killGroup('SIGKILL'), 2000).unref();
          };
          ctx.signal.addEventListener('abort', onAbort, { once: true });
          if (ctx.signal.aborted) onAbort();

          const collect = (which: 'out' | 'err') => (chunk: Buffer) => {
            const cur = which === 'out' ? out : err;
            if (cur.length + chunk.length > max) {
              truncated = true;
              const room = Math.max(0, max - cur.length);
              if (room > 0)
                which === 'out'
                  ? (out += chunk.subarray(0, room).toString('utf8'))
                  : (err += chunk.subarray(0, room).toString('utf8'));
              return;
            }
            if (which === 'out') out += chunk.toString('utf8');
            else err += chunk.toString('utf8');
          };
          child.stdout.on('data', collect('out'));
          child.stderr.on('data', collect('err'));
          child.stdin.on('error', () => {});
          child.stdin.end(input.stdin ?? '');

          child.on('error', (e: NodeJS.ErrnoException) => {
            if (settled) return;
            settled = true;
            ctx.signal.removeEventListener('abort', onAbort);
            reject(
              new CapabilityError('SHELL_NOT_FOUND', `Could not start '${exe}': ${e.code ?? e.message}`, {
                errorClass: 'contract',
                retryable: false,
              }),
            );
          });
          child.on('close', (code, signal) => {
            if (settled) return;
            settled = true;
            ctx.signal.removeEventListener('abort', onAbort);
            killGroup('SIGKILL'); // reap anything the script left behind
            if (ctx.signal.aborted) return reject(ctx.signal.reason ?? new Error('cancelled'));
            const exitCode = code ?? (signal ? 128 : 1);
            const expected = input.expectExit ?? [0];
            if (!expected.includes(exitCode)) {
              const retryable = input.retryableExit?.includes(exitCode) ?? false;
              return reject(
                new CapabilityError(
                  retryable ? 'SHELL_EXIT_RETRYABLE' : 'SHELL_EXIT_NONZERO',
                  `'${exe}' exited with status ${exitCode}${err ? `: ${err.trim().slice(0, 500)}` : ''}`,
                  {
                    errorClass: retryable ? 'transient' : 'business',
                    retryable,
                    details: { exitCode, ...(signal ? { signal } : {}) },
                  },
                ),
              );
            }
            resolve({ exitCode, stdout: out, stderr: err, truncated, durationMs: Date.now() - started });
          });
        });
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
  };
  return [adapter as CapabilityAdapter];
}
