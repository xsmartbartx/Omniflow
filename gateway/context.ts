import type { AuthoringService } from '../authoring/index.ts';
import type { AdapterConfig, CapabilityRegistry } from '../capabilities/index.ts';
import type { Clock, Logger, LogLevel } from '../core/index.ts';
import type { AlertManager, AnalysisAgent, MetricsRegistry } from '../insight/index.ts';
import type { ApprovalService, Orchestrator } from '../orchestration/orchestrator/index.ts';
import type { RegistryService } from '../orchestration/registry/index.ts';
import type { CircuitBreakers } from '../orchestration/runtime/index.ts';
import type { RunService, Scheduler } from '../orchestration/scheduler/index.ts';
import type { TriggerManager } from '../orchestration/triggers/index.ts';
import type { EnvironmentName } from '../schemas/index.ts';
import type { PolicyEngine } from '../security/policy/index.ts';
import type { SecretBroker } from '../security/secret-broker/index.ts';
import type { State } from '../state/index.ts';
import type { NexoraService, OutboxWorker } from '../nexora/index.ts';
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
  /** Where the master key came from. `ephemeral` means this process invented one that is not stored (read-only tooling). */
  masterKeySource: 'env' | 'file' | 'generated' | 'ephemeral';
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
  /** Names (from `adapters.channels`) that receive alerts. */
  alertChannels: string[];
  /** How often the Analysis Agent runs, in hours. 0 disables it. */
  analysisIntervalHours: number;
  /** How often alert conditions are evaluated. */
  alertIntervalSeconds: number;
  version: string;
  /** Outbound run-lifecycle webhooks (CONSTANS_RUN_WEBHOOKS). */
  runWebhooks: Array<{ id: string; url: string; secret: string; events: string[]; tenant: string }>;
  /** `standalone` is Constans as shipped; `nexora` runs it as a tenant product of NEXORA Core. */
  mode: 'standalone' | 'nexora';
  nexora: {
    /** Which Core implementation to use. Only `fake` exists until NEXORA publishes its contracts. */
    core: 'fake';
    /** Lifetime of a session created by NEXORA sign-in. Short, so membership changes apply quickly. */
    sessionTtlMinutes: number;
    /** Cookie that carries the NEXORA identity assertion. */
    assertionCookie: string;
  };
}

export interface Constans {
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
  analysis: AnalysisAgent;
  alerts: AlertManager;
  authoring: AuthoringService;
  /** Present only when CONSTANS_RUN_WEBHOOKS is set. */
  webhooks?: { tick(): Promise<number>; start(): void; stop(): void };
  /** Present only in `nexora` mode. */
  nexora?: { service: NexoraService; worker: OutboxWorker; fake?: import('../nexora/index.ts').FakeCore };
  /** Start background loops, recover interrupted runs, bootstrap the first admin. */
  start(): Promise<{ recovered: number; bootstrap?: { email: string; password: string } }>;
  stop(): Promise<void>;
}
