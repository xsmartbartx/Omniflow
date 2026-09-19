import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AdapterConfig } from '../capabilities/index.ts';
import { defaultAdapterConfig } from '../capabilities/index.ts';
import { type LogLevel, OmniflowError } from '../core/index.ts';
import type { Config } from '../gateway/context.ts';
import type { EnvironmentName } from '../schemas/index.ts';
import { generateMasterKey } from '../security/secret-broker/index.ts';

export type { Config };

type Env = Record<string, string | undefined>;

function fail(name: string, message: string): never {
  throw new OmniflowError('INVALID_CONFIG', `Invalid configuration: ${name} ${message}`, {
    errorClass: 'catastrophic',
    retryable: false,
  });
}

function bool(env: Env, name: string, dflt: boolean): boolean {
  const v = env[name];
  if (v === undefined || v === '') return dflt;
  if (/^(1|true|yes|on)$/i.test(v)) return true;
  if (/^(0|false|no|off)$/i.test(v)) return false;
  return fail(name, `must be true or false (got '${v}')`);
}

function int(env: Env, name: string, dflt: number, min: number, max: number): number {
  const v = env[name];
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max)
    fail(name, `must be an integer between ${min} and ${max} (got '${v}')`);
  return n;
}

function json<T>(env: Env, name: string, dflt: T): T {
  const v = env[name];
  if (!v) return dflt;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fail(name, 'must be valid JSON');
  }
}

/**
 * Load configuration from the environment and fail fast on anything malformed. The master key is
 * taken from `OMNIFLOW_MASTER_KEY`; if it is not set, one is generated once and stored (mode 0600)
 * in the data directory so secrets survive restarts. Production deployments should supply the key
 * from a secret manager instead.
 */
export function loadConfig(
  env: Env = process.env,
  opts: {
    version?: string;
    cwd?: string /** Tooling that only reads must not invent and store a key. */;
    persistMasterKey?: boolean;
  } = {},
): Config {
  const cwd = opts.cwd ?? process.cwd();
  const environment = (env.OMNIFLOW_ENV ?? 'production') as EnvironmentName;
  if (!['development', 'staging', 'production'].includes(environment))
    fail('OMNIFLOW_ENV', 'must be development, staging or production');

  const dataDir = resolve(cwd, env.OMNIFLOW_DATA_DIR ?? './data');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  let masterKey = env.OMNIFLOW_MASTER_KEY?.trim();
  let masterKeySource: Config['masterKeySource'] = 'env';
  if (!masterKey) {
    const keyFile = join(dataDir, 'master.key');
    if (existsSync(keyFile)) {
      masterKey = readFileSync(keyFile, 'utf8').trim();
      masterKeySource = 'file';
    } else {
      masterKey = generateMasterKey();
      if (opts.persistMasterKey === false) masterKeySource = 'ephemeral';
      else {
        writeFileSync(keyFile, `${masterKey}\n`, { mode: 0o600 });
        masterKeySource = 'generated';
      }
    }
  }

  const defaults = defaultAdapterConfig();
  const allowedCommands = (env.OMNIFLOW_SHELL_ALLOWED_COMMANDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const llmKey = env.OMNIFLOW_LLM_API_KEY ?? env.ANTHROPIC_API_KEY;

  const adapters: AdapterConfig = {
    ...defaults,
    allowPrivateNetworks: bool(env, 'OMNIFLOW_ALLOW_PRIVATE_EGRESS', false),
    shell: { ...defaults.shell, allowedCommands, scratchRoot: join(dataDir, 'scratch') },
    storage: { ...defaults.storage, root: resolve(cwd, env.OMNIFLOW_STORAGE_DIR ?? join(dataDir, 'files')) },
    datasources: json<Record<string, string>>(env, 'OMNIFLOW_DATASOURCES', {}),
    channels: json<Record<string, string>>(env, 'OMNIFLOW_CHANNELS', {}),
    email: {
      ...(env.OMNIFLOW_SMTP_URL ? { smtpUrl: env.OMNIFLOW_SMTP_URL } : {}),
      ...(env.OMNIFLOW_SMTP_FROM ? { from: env.OMNIFLOW_SMTP_FROM } : {}),
    },
    llm: {
      ...defaults.llm,
      ...(llmKey ? { apiKey: llmKey } : {}),
      ...(env.OMNIFLOW_LLM_MODEL ? { model: env.OMNIFLOW_LLM_MODEL } : {}),
      ...(env.OMNIFLOW_LLM_BASE_URL ? { baseUrl: env.OMNIFLOW_LLM_BASE_URL } : {}),
    },
  };
  for (const [name, cmd] of Object.entries(allowedCommands))
    if (!cmd.startsWith('/'))
      fail('OMNIFLOW_SHELL_ALLOWED_COMMANDS', `entry ${name} ('${cmd}') must be an absolute path`);

  const alertChannels = (env.OMNIFLOW_ALERT_CHANNELS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const c of alertChannels)
    if (!(c in adapters.channels))
      fail('OMNIFLOW_ALERT_CHANNELS', `names channel '${c}', which is not defined in OMNIFLOW_CHANNELS`);

  const port = int(env, 'OMNIFLOW_PORT', 8080, 1, 65535);
  const logLevel = (env.OMNIFLOW_LOG_LEVEL ?? 'info') as LogLevel;
  if (!['debug', 'info', 'warn', 'error', 'silent'].includes(logLevel))
    fail('OMNIFLOW_LOG_LEVEL', 'must be debug, info, warn, error or silent');

  return {
    environment,
    dataDir,
    host: env.OMNIFLOW_HOST ?? '0.0.0.0',
    port,
    publicUrl: env.OMNIFLOW_PUBLIC_URL ?? `http://localhost:${port}`,
    logLevel,
    masterKey,
    masterKeySource,
    previousMasterKeys: (env.OMNIFLOW_PREVIOUS_MASTER_KEYS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    admin: { email: env.OMNIFLOW_ADMIN_EMAIL ?? 'admin@omniflow.local', password: env.OMNIFLOW_ADMIN_PASSWORD },
    adapters,
    policyDir: resolve(cwd, env.OMNIFLOW_POLICY_DIR ?? './policies'),
    workflowsDir: resolve(cwd, env.OMNIFLOW_WORKFLOWS_DIR ?? './workflows'),
    seedExamples: bool(env, 'OMNIFLOW_SEED_EXAMPLES', false),
    publishApprovals: int(env, 'OMNIFLOW_PUBLISH_APPROVALS', 1, 1, 5),
    maxConcurrentRuns: int(env, 'OMNIFLOW_MAX_CONCURRENT_RUNS', 16, 1, 1000),
    maxConcurrentSteps: int(env, 'OMNIFLOW_MAX_CONCURRENT_STEPS', 32, 1, 1000),
    sessionTtlHours: int(env, 'OMNIFLOW_SESSION_TTL_HOURS', 12, 1, 24 * 30),
    rateLimitPerMinute: int(env, 'OMNIFLOW_RATE_LIMIT_PER_MIN', 600, 10, 100_000),
    trustProxy: bool(env, 'OMNIFLOW_TRUST_PROXY', false),
    metricsToken: env.OMNIFLOW_METRICS_TOKEN,
    alertChannels,
    analysisIntervalHours: int(env, 'OMNIFLOW_ANALYSIS_INTERVAL_HOURS', 24, 0, 24 * 30),
    alertIntervalSeconds: int(env, 'OMNIFLOW_ALERT_INTERVAL_SECONDS', 60, 5, 3600),
    version: opts.version ?? '1.0.0',
  };
}
