import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AdapterConfig } from '../capabilities/index.ts';
import { defaultAdapterConfig } from '../capabilities/index.ts';
import { type LogLevel, ConstansError } from '../core/index.ts';
import type { Config } from '../gateway/context.ts';
import type { EnvironmentName } from '../schemas/index.ts';
import { generateMasterKey } from '../security/secret-broker/index.ts';
import { parseRunWebhooks, type RunWebhook } from './webhooks.ts';

export type { Config };

type Env = Record<string, string | undefined>;

function fail(name: string, message: string): never {
  throw new ConstansError('INVALID_CONFIG', `Invalid configuration: ${name} ${message}`, {
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

function resolveMasterKey(
  env: Env,
  dataDir: string,
  persist: boolean | undefined,
): { masterKey: string; masterKeySource: Config['masterKeySource'] } {
  const fromEnv = env.CONSTANS_MASTER_KEY?.trim();
  if (fromEnv) return { masterKey: fromEnv, masterKeySource: 'env' };
  const keyFile = join(dataDir, 'master.key');
  if (existsSync(keyFile)) return { masterKey: readFileSync(keyFile, 'utf8').trim(), masterKeySource: 'file' };
  const masterKey = generateMasterKey();
  if (persist === false) return { masterKey, masterKeySource: 'ephemeral' };
  writeFileSync(keyFile, `${masterKey}\n`, { mode: 0o600 });
  return { masterKey, masterKeySource: 'generated' };
}

function buildAdapters(env: Env, cwd: string, dataDir: string): AdapterConfig {
  const defaults = defaultAdapterConfig();
  const allowedCommands = (env.CONSTANS_SHELL_ALLOWED_COMMANDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const llmKey = env.CONSTANS_LLM_API_KEY ?? env.ANTHROPIC_API_KEY;

  const adapters: AdapterConfig = {
    ...defaults,
    allowPrivateNetworks: bool(env, 'CONSTANS_ALLOW_PRIVATE_EGRESS', false),
    shell: { ...defaults.shell, allowedCommands, scratchRoot: join(dataDir, 'scratch') },
    storage: { ...defaults.storage, root: resolve(cwd, env.CONSTANS_STORAGE_DIR ?? join(dataDir, 'files')) },
    datasources: json<Record<string, string>>(env, 'CONSTANS_DATASOURCES', {}),
    channels: json<Record<string, string>>(env, 'CONSTANS_CHANNELS', {}),
    email: {
      ...(env.CONSTANS_SMTP_URL ? { smtpUrl: env.CONSTANS_SMTP_URL } : {}),
      ...(env.CONSTANS_SMTP_FROM ? { from: env.CONSTANS_SMTP_FROM } : {}),
    },
    llm: {
      ...defaults.llm,
      ...(llmKey ? { apiKey: llmKey } : {}),
      ...(env.CONSTANS_LLM_MODEL ? { model: env.CONSTANS_LLM_MODEL } : {}),
      ...(env.CONSTANS_LLM_BASE_URL ? { baseUrl: env.CONSTANS_LLM_BASE_URL } : {}),
    },
  };
  for (const [name, cmd] of Object.entries(allowedCommands))
    if (!cmd.startsWith('/'))
      fail('CONSTANS_SHELL_ALLOWED_COMMANDS', `entry ${name} ('${cmd}') must be an absolute path`);
  return adapters;
}

function resolveMode(env: Env, environment: EnvironmentName): { mode: 'standalone' | 'nexora'; nexoraCore: string } {
  const mode = (env.CONSTANS_MODE ?? 'standalone') as 'standalone' | 'nexora';
  if (mode !== 'standalone' && mode !== 'nexora') fail('CONSTANS_MODE', 'must be standalone or nexora');
  const nexoraCore = (env.CONSTANS_NEXORA_CORE ?? '') as string;
  if (mode === 'nexora') {
    if (nexoraCore !== 'fake')
      fail('CONSTANS_NEXORA_CORE', 'must be fake (the only Core implementation until NEXORA publishes its contracts)');
    if (environment === 'production')
      fail('CONSTANS_NEXORA_CORE', 'fake is unsigned and cannot be used when CONSTANS_ENV=production');
  }
  return { mode, nexoraCore };
}

/**
 * Load configuration from the environment and fail fast on anything malformed. The master key is
 * taken from `CONSTANS_MASTER_KEY`; if it is not set, one is generated once and stored (mode 0600)
 * in the data directory so secrets survive restarts. Production deployments should supply the key
 * from a secret manager instead.
 */
export function loadConfig(
  rawEnv: Env = process.env,
  opts: {
    version?: string;
    cwd?: string;
    /** Tooling that only reads must not invent and store a key. */
    persistMasterKey?: boolean;
  } = {},
): Config {
  // A blank value (`CONSTANS_ADMIN_PASSWORD=` in an env file) means "not set", never "set to nothing".
  const env: Env = Object.fromEntries(Object.entries(rawEnv).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const cwd = opts.cwd ?? process.cwd();
  const environment = (env.CONSTANS_ENV ?? 'production') as EnvironmentName;
  if (!['development', 'staging', 'production'].includes(environment))
    fail('CONSTANS_ENV', 'must be development, staging or production');

  const dataDir = resolve(cwd, env.CONSTANS_DATA_DIR ?? './data');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const { masterKey, masterKeySource } = resolveMasterKey(env, dataDir, opts.persistMasterKey);

  const adapters = buildAdapters(env, cwd, dataDir);

  const alertChannels = (env.CONSTANS_ALERT_CHANNELS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const c of alertChannels)
    if (!(c in adapters.channels))
      fail('CONSTANS_ALERT_CHANNELS', `names channel '${c}', which is not defined in CONSTANS_CHANNELS`);

  const port = int(env, 'CONSTANS_PORT', 8080, 1, 65535);
  const logLevel = (env.CONSTANS_LOG_LEVEL ?? 'info') as LogLevel;
  if (!['debug', 'info', 'warn', 'error', 'silent'].includes(logLevel))
    fail('CONSTANS_LOG_LEVEL', 'must be debug, info, warn, error or silent');

  let runWebhooks: RunWebhook[] = [];
  try {
    runWebhooks = parseRunWebhooks(env.CONSTANS_RUN_WEBHOOKS, { production: environment === 'production' });
  } catch (e) {
    fail('CONSTANS_RUN_WEBHOOKS', (e as Error).message);
  }

  const { mode, nexoraCore } = resolveMode(env, environment);

  return {
    environment,
    dataDir,
    host: env.CONSTANS_HOST ?? '0.0.0.0',
    port,
    publicUrl: env.CONSTANS_PUBLIC_URL ?? `http://localhost:${port}`,
    logLevel,
    masterKey,
    masterKeySource,
    previousMasterKeys: (env.CONSTANS_PREVIOUS_MASTER_KEYS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    admin: { email: env.CONSTANS_ADMIN_EMAIL ?? 'admin@constans.local', password: env.CONSTANS_ADMIN_PASSWORD },
    adapters,
    policyDir: resolve(cwd, env.CONSTANS_POLICY_DIR ?? './policies'),
    workflowsDir: resolve(cwd, env.CONSTANS_WORKFLOWS_DIR ?? './workflows'),
    seedExamples: bool(env, 'CONSTANS_SEED_EXAMPLES', false),
    publishApprovals: int(env, 'CONSTANS_PUBLISH_APPROVALS', 1, 1, 5),
    maxConcurrentRuns: int(env, 'CONSTANS_MAX_CONCURRENT_RUNS', 16, 1, 1000),
    maxConcurrentSteps: int(env, 'CONSTANS_MAX_CONCURRENT_STEPS', 32, 1, 1000),
    sessionTtlHours: int(env, 'CONSTANS_SESSION_TTL_HOURS', 12, 1, 24 * 30),
    rateLimitPerMinute: int(env, 'CONSTANS_RATE_LIMIT_PER_MIN', 600, 10, 100_000),
    trustProxy: bool(env, 'CONSTANS_TRUST_PROXY', false),
    metricsToken: env.CONSTANS_METRICS_TOKEN,
    alertChannels,
    analysisIntervalHours: int(env, 'CONSTANS_ANALYSIS_INTERVAL_HOURS', 24, 0, 24 * 30),
    alertIntervalSeconds: int(env, 'CONSTANS_ALERT_INTERVAL_SECONDS', 60, 5, 3600),
    version: opts.version ?? '1.0.0',
    mode,
    runWebhooks,
    nexora: {
      core: 'fake',
      sessionTtlMinutes: int(env, 'CONSTANS_NEXORA_SESSION_TTL_MINUTES', 5, 1, 60),
      assertionCookie: env.CONSTANS_NEXORA_ASSERTION_COOKIE ?? '__session',
    },
  };
}
