import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Operator-controlled configuration for the built-in adapters. Nothing here can be changed by a
 * workflow manifest — a manifest can only *request* a capability; the operator decides what the
 * capability is allowed to reach.
 */
export interface AdapterConfig {
  /** Allow allow-listed hosts to resolve to private/loopback addresses (needed for docker-compose service names). */
  allowPrivateNetworks: boolean;
  http: {
    maxResponseBytes: number;
    maxRedirects: number;
    defaultTimeoutMs: number;
    userAgent: string;
  };
  shell: {
    /** Absolute paths of executables that `shell-exec` may run. Empty = shell capability disabled. */
    allowedCommands: string[];
    scratchRoot: string;
    maxOutputBytes: number;
    /** Environment variables (names) passed through from the engine's own environment. Usually none. */
    passEnv: string[];
  };
  storage: {
    /** Directory `file-*` capabilities are confined to. */
    root: string;
    maxFileBytes: number;
  };
  /** Named database connections: name → connection URL (`postgres://…` or `sqlite:///path`). */
  datasources: Record<string, string>;
  email: { smtpUrl?: string; from?: string };
  /** Named notification channels (chat/webhook): name → webhook URL. */
  channels: Record<string, string>;
  llm: { apiKey?: string; model: string; baseUrl: string; maxOutputTokens: number };
}

export function defaultAdapterConfig(overrides: Partial<AdapterConfig> = {}): AdapterConfig {
  return {
    allowPrivateNetworks: false,
    http: {
      maxResponseBytes: 5 * 1024 * 1024,
      maxRedirects: 3,
      defaultTimeoutMs: 30_000,
      userAgent: 'OmniFlow/1.0 (+https://omniflow.dev)',
    },
    shell: {
      allowedCommands: [],
      scratchRoot: join(tmpdir(), 'omniflow-scratch'),
      maxOutputBytes: 1024 * 1024,
      passEnv: [],
    },
    storage: { root: join(tmpdir(), 'omniflow-files'), maxFileBytes: 50 * 1024 * 1024 },
    datasources: {},
    email: {},
    channels: {},
    llm: {
      model: 'claude-sonnet-5',
      baseUrl: 'https://api.anthropic.com',
      maxOutputTokens: 4096,
    },
    ...overrides,
  };
}
