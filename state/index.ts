import { join } from 'node:path';
import { type Clock, systemClock } from '../core/index.ts';
import { AnalyticsStore } from './analytics-store.ts';
import { ApprovalStore } from './approval-store.ts';
import { ArtifactStore } from './artifact-store.ts';
import { AuthoringStore } from './authoring-store.ts';
import { Db } from './database.ts';
import { EventLog } from './event-log.ts';
import { IdempotencyStore } from './idempotency-store.ts';
import { IdentityStore } from './identity-store.ts';
import { KvStore } from './kv-store.ts';
import { RegistryStore } from './registry-store.ts';
import { RunStore } from './run-store.ts';
import { SecretStore } from './secret-store.ts';
import { TriggerStore } from './trigger-store.ts';

export * from './analytics-store.ts';
export * from './approval-store.ts';
export * from './artifact-store.ts';
export * from './authoring-store.ts';
export * from './database.ts';
export * from './event-log.ts';
export * from './idempotency-store.ts';
export * from './identity-store.ts';
export * from './kv-store.ts';
export * from './registry-store.ts';
export * from './run-store.ts';
export * from './secret-store.ts';
export * from './trigger-store.ts';

/** The state plane: durable facts about what ran, what it produced, and what it consumed. */
export interface State {
  db: Db;
  events: EventLog;
  runs: RunStore;
  idempotency: IdempotencyStore;
  approvals: ApprovalStore;
  artifacts: ArtifactStore;
  registry: RegistryStore;
  identity: IdentityStore;
  secrets: SecretStore;
  triggers: TriggerStore;
  authoring: AuthoringStore;
  kv: KvStore;
  analytics: AnalyticsStore;
  clock: Clock;
  close(): void;
}

export interface OpenStateOptions {
  /** SQLite file path, or `:memory:` for tests. */
  dbPath: string;
  /** Directory for content-addressed artifacts. */
  artifactDir: string;
  clock?: Clock;
}

export function openState(opts: OpenStateOptions): State {
  const clock = opts.clock ?? systemClock;
  const db = new Db(opts.dbPath);
  db.migrate();
  return {
    db,
    clock,
    events: new EventLog(db, clock),
    runs: new RunStore(db, clock),
    idempotency: new IdempotencyStore(db, clock),
    approvals: new ApprovalStore(db, clock),
    artifacts: new ArtifactStore(db, opts.artifactDir, clock),
    registry: new RegistryStore(db, clock),
    identity: new IdentityStore(db, clock),
    secrets: new SecretStore(db, clock),
    triggers: new TriggerStore(db, clock),
    authoring: new AuthoringStore(db, clock),
    kv: new KvStore(db, clock),
    analytics: new AnalyticsStore(db, clock),
    close: () => db.close(),
  };
}

/** Standard layout under a data directory. */
export function stateOptionsFor(dataDir: string, clock?: Clock): OpenStateOptions {
  return { dbPath: join(dataDir, 'omniflow.db'), artifactDir: join(dataDir, 'artifacts'), ...(clock ? { clock } : {}) };
}
