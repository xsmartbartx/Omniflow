import type { CapabilityRegistry } from '../capabilities/index.ts';
import type { AdapterConfig } from '../capabilities/index.ts';
import type { Clock, LogLevel, Logger } from '../core/index.ts';
import type { MetricsRegistry } from '../insight/index.ts';
import type { ApprovalService, Orchestrator } from '../orchestration/orchestrator/index.ts';
import type { RegistryService } from '../orchestration/registry/index.ts';
import type { CircuitBreakers } from '../orchestration/runtime/index.ts';
import type { RunService, Scheduler } from '../orchestration/scheduler/index.ts';
import type { TriggerManager } from '../orchestration/triggers/index.ts';
import type { EnvironmentName } from '../schemas/index.ts';
import type { PolicyEngine } from '../security/policy/index.ts';
import type { SecretBroker } from '../security/secret-broker/index.ts';
import type { State } from '../state/index.ts';
import type { Authenticator } from './auth.ts';

/**
 * The contract between the Gateway and whatever assembles the platform. The Gateway depends on
 * these interfaces; the composition root (`server/`) implements them — never the other way round.
 */

export interface Config {
  environment: EnvironmentName;
  dataDir: string;
  host: string;
  port: number;
  /** Public base URL — decides whether cookies are `Secure`. */
  publicUrl: string;
  logLevel: LogLevel;
  masterKey: string;
  /** Previous master keys, kept readable until secrets are rotated. */
  previousMasterKeys: string[];
  admin: { email: string; password: string | undefined };
  adapters: AdapterConfig;
  policyDir: string;
  workflowsDir: string;
  seedExamples: boolean;
  publishApprovals: number;
  maxConcurrentRuns: number;
  maxConcurrentSteps: number;
  sessionTtlHours: number;
  rateLimitPerMinute: number;
  trustProxy: boolean;
  metricsToken: string | undefined;
  version: string;
}

export interface Omniflow {
  config: Config;
  log: Logger;
  clock: Clock;
  state: State;
  capabilities: CapabilityRegistry;
  policy: PolicyEngine;
  broker: SecretBroker;
  breakers: CircuitBreakers;
  orchestrator: Orchestrator;
  registry: RegistryService;
  runs: RunService;
  scheduler: Scheduler;
  triggers: TriggerManager;
  approvals: ApprovalService;
  auth: Authenticator;
  metrics: MetricsRegistry;
  /** Start background loops, recover interrupted runs, bootstrap the first admin. */
  start(): Promise<{ recovered: number; bootstrap?: { email: string; password: string } }>;
  stop(): Promise<void>;
}
