/**
 * Event schema (architecture §10.2). The event log is append-only and schema-enforced: new fields
 * are optional, existing fields are never repurposed. Every event that leaves the engine is
 * sanitised first (see `state/event-log.ts`).
 */

/** Per event type: whether it must carry a run id, and the `data` keys that must be present. */
export const EVENT_CATALOGUE = {
  // ---- run lifecycle
  'run.queued': { run: true, required: ['workflow', 'version', 'planHash'] },
  'run.started': { run: true, required: [] },
  'run.succeeded': { run: true, required: [] },
  'run.failed': { run: true, required: ['error'] },
  'run.cancelled': { run: true, required: [] },
  'run.waiting': { run: true, required: ['on'] },
  'run.resumed': { run: true, required: [] },
  'run.compensating': { run: true, required: ['cause'] },
  'run.rolled-back': { run: true, required: [] },
  'run.compensation-failed': { run: true, required: ['error'] },
  'run.deduplicated': { run: false, required: ['workflow', 'existingRunId'] },
  'run.skipped': { run: false, required: ['workflow', 'reason'] },
  'run.guard-failed': { run: true, required: ['guard'] },
  'run.recovered': { run: true, required: [] },
  // ---- step lifecycle
  'step.started': { run: true, required: ['attempt'] },
  'step.succeeded': { run: true, required: ['attempt', 'durationMs'] },
  'step.failed': { run: true, required: ['attempt', 'error'] },
  'step.retry-scheduled': { run: true, required: ['attempt', 'delayMs'] },
  'step.skipped': { run: true, required: ['reason'] },
  'step.waiting': { run: true, required: ['on'] },
  'step.idempotent-replay': { run: true, required: ['idempotencyKey'] },
  'step.recovered': { run: true, required: [] },
  'step.dry-run': { run: true, required: [] },
  'step.item.succeeded': { run: true, required: ['index'] },
  'step.item.failed': { run: true, required: ['index', 'error'] },
  'step.compensation.started': { run: true, required: [] },
  'step.compensation.succeeded': { run: true, required: [] },
  'step.compensation.failed': { run: true, required: ['error'] },
  // ---- approvals
  'approval.requested': { run: true, required: ['approvalId'] },
  'approval.decided': { run: true, required: ['approvalId', 'decision'] },
  'approval.timed-out': { run: true, required: ['approvalId', 'outcome'] },
  'approval.escalated': { run: true, required: ['approvalId'] },
  // ---- secrets (never carries a value)
  'secret.lease.issued': { run: false, required: ['leaseId', 'names'] },
  'secret.lease.revoked': { run: false, required: ['leaseId'] },
  'secret.written': { run: false, required: ['name'] },
  'secret.deleted': { run: false, required: ['name'] },
  // ---- policy & governance
  'policy.decision': { run: false, required: ['action', 'effect', 'reasonCode'] },
  'workflow.draft-saved': { run: false, required: ['workflow'] },
  'workflow.change-requested': { run: false, required: ['workflow', 'version', 'changeId'] },
  'workflow.change-approved': { run: false, required: ['workflow', 'version', 'changeId'] },
  'workflow.change-rejected': { run: false, required: ['workflow', 'version', 'changeId'] },
  'workflow.published': { run: false, required: ['workflow', 'version', 'planHash'] },
  'workflow.deprecated': { run: false, required: ['workflow', 'version'] },
  'workflow.killed': { run: false, required: ['workflow'] },
  'workflow.revived': { run: false, required: ['workflow'] },
  'workflow.settings-changed': { run: false, required: ['workflow'] },
  'workflow.rollout-changed': { run: false, required: ['workflow'] },
  // ---- triggers
  'trigger.registered': { run: false, required: ['workflow', 'trigger'] },
  'trigger.fired': { run: false, required: ['workflow', 'trigger'] },
  'trigger.rejected': { run: false, required: ['workflow', 'trigger', 'reason'] },
  // ---- identity
  'auth.login': { run: false, required: [] },
  'auth.login-failed': { run: false, required: [] },
  'auth.logout': { run: false, required: [] },
  'auth.user-created': { run: false, required: ['userId'] },
  'auth.user-updated': { run: false, required: ['userId'] },
  'auth.apikey-created': { run: false, required: ['keyId'] },
  'auth.apikey-revoked': { run: false, required: ['keyId'] },
  // ---- capabilities
  'capability.killed': { run: false, required: ['capability'] },
  'capability.revived': { run: false, required: ['capability'] },
  'capability.circuit-opened': { run: false, required: ['capability'] },
  'capability.circuit-closed': { run: false, required: ['capability'] },
  // ---- agents & insight
  'agent.draft-created': { run: false, required: ['agent', 'draftId'] },
  'agent.proposal-created': { run: false, required: ['agent', 'proposalId'] },
  'pentest.finding': { run: false, required: ['ruleId', 'severity'] },
  // ---- system
  'system.started': { run: false, required: [] },
  'system.stopped': { run: false, required: [] },
  'audit.export': { run: false, required: [] },
  'artifact.tombstoned': { run: false, required: ['ref'] },
} as const satisfies Record<string, { run: boolean; required: readonly string[] }>;

export type EventType = keyof typeof EVENT_CATALOGUE;
export const EVENT_TYPES = Object.keys(EVENT_CATALOGUE) as EventType[];

export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && Object.hasOwn(EVENT_CATALOGUE, value);
}

/** Maximum serialised `data` size. Larger payloads must be stored as artifacts and referenced by hash. */
export const MAX_EVENT_DATA_BYTES = 64 * 1024;

export interface EventActor {
  type: string;
  id: string;
  name?: string;
}

/** What a caller supplies. */
export interface NewEvent {
  tenant: string;
  type: EventType;
  runId?: string;
  stepId?: string;
  attempt?: number;
  actor?: EventActor;
  correlationId?: string;
  data?: Record<string, unknown>;
}

/** What is stored and returned. */
export interface EventRecord {
  seq: number;
  id: string;
  tenant: string;
  ts: string;
  type: EventType;
  runId?: string;
  stepId?: string;
  attempt?: number;
  actor?: EventActor;
  correlationId?: string;
  data: Record<string, unknown>;
  /** Hash of the previous event of this tenant — the tamper-evident chain (T7). */
  prevHash: string;
  hash: string;
}

export const GENESIS_HASH = `sha256:${'0'.repeat(64)}`;
