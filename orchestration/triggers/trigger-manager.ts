import { Cron } from 'croner';
import {
  AuthenticationError,
  type Clock,
  evaluate,
  isTruthy,
  type Logger,
  NotFoundError,
  nullLogger,
  parseExpressionField,
  randomToken,
  resolveValue,
  systemClock,
  toErrorInfo,
  ValidationError,
} from '../../core/index.ts';
import type { Plan } from '../../schemas/plan.ts';
import type { Principal } from '../../schemas/policy.ts';
import type { SecretBroker } from '../../security/secret-broker/index.ts';
import { validateValue } from '../../security/validator/index.ts';
import { verifyWebhook } from '../../security/webhook.ts';
import type { RunRecord, State, TriggerRecord } from '../../state/index.ts';
import type { Orchestrator } from '../orchestrator/index.ts';
import type { RegistryService } from '../registry/index.ts';
import type { RunService, TriggerResult } from '../scheduler/index.ts';

const TRIGGER_PRINCIPAL = (tenant: string, name: string): Principal => ({
  id: `trigger:${name}`,
  type: 'trigger',
  name: `trigger:${name}`,
  tenant,
  roles: ['operator'],
});

/** Missed schedule slots older than this are treated as "engine was down" and follow the `catchup` policy. */
const MISSED_AFTER_MS = 60_000;
const MAX_WEBHOOK_BODY = 1024 * 1024;

export interface WebhookDelivery {
  tenant: string;
  workflow: string;
  trigger: string;
  rawBody: string;
  headers: { timestamp: string | undefined; signature: string | undefined; delivery?: string | undefined };
}

export interface WebhookSecretInfo {
  trigger: string;
  /** Shown exactly once, when created or rotated. */
  secret: string;
}

/**
 * Trigger Manager (architecture §5.1 #8): owns schedules, event subscriptions, webhook endpoints
 * and workflow-completion links. It converts a trigger firing into a run request; whether the run
 * is permitted is decided by the Policy Engine inside `RunService`.
 */
export class TriggerManager {
  private readonly st: State;
  private readonly runs: RunService;
  private readonly orch: Orchestrator;
  private readonly broker: SecretBroker;
  private readonly registry: RegistryService;
  private readonly clock: Clock;
  private readonly log: Logger;
  private timer: NodeJS.Timeout | undefined;
  private readonly offs: Array<() => void> = [];
  private ticking = false;

  constructor(deps: {
    state: State;
    runService: RunService;
    orchestrator: Orchestrator;
    broker: SecretBroker;
    registry: RegistryService;
    clock?: Clock;
    log?: Logger;
  }) {
    this.st = deps.state;
    this.runs = deps.runService;
    this.orch = deps.orchestrator;
    this.broker = deps.broker;
    this.registry = deps.registry;
    this.clock = deps.clock ?? systemClock;
    this.log = deps.log ?? nullLogger;
  }

  // =============================================================== lifecycle
  start(tickMs = 1000): void {
    this.offs.push(
      this.registry.on('activated', ({ tenant, workflow, version }) => this.register(tenant, workflow, version)),
      this.registry.on('deactivated', ({ tenant, workflow }) => this.setEnabled(tenant, workflow, false)),
      this.orch.on('run-finished', (run) => this.onRunFinished(run)),
    );
    this.reconcile();
    this.timer = setInterval(() => this.runDue(), tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const off of this.offs.splice(0)) off();
  }

  /** Re-register every enabled workflow's active version (start-up reconciliation). */
  reconcile(): number {
    let n = 0;
    for (const t of this.st.identity.listTenants()) {
      for (const wf of this.st.registry.listWorkflows(t.id)) {
        if (wf.settings.enabled && wf.settings.stableVersion) {
          try {
            this.register(t.id, wf.name, wf.settings.stableVersion);
            n++;
          } catch (e) {
            this.log.error('trigger registration failed', { workflow: wf.name, error: e });
          }
        }
      }
    }
    return n;
  }

  // ============================================================= registration
  /** Register the triggers declared by a workflow version. Returns webhook secrets created just now (shown once). */
  register(tenant: string, workflow: string, version: string): WebhookSecretInfo[] {
    const { plan } = this.registry.getVersionPlan(tenant, workflow, version);
    const existing = new Map(this.st.triggers.listForWorkflow(tenant, workflow).map((t) => [t.name, t]));
    const now = this.clock.now();
    const created: WebhookSecretInfo[] = [];

    const specs = plan.triggers
      .filter((t) => t.type !== 'manual')
      .map((t) => {
        const name = (t as { name?: string }).name!;
        const { type, name: _n, ...config } = t as unknown as Record<string, unknown>;
        let nextFireAt: string | undefined;
        if (t.type === 'schedule') {
          const prev = existing.get(name);
          const same = prev && prev.config.cron === t.cron && prev.config.timezone === t.timezone;
          nextFireAt =
            same && prev.nextFireAt && prev.nextFireAt > now.toISOString()
              ? prev.nextFireAt
              : this.nextRun(t.cron, t.timezone, now)?.toISOString();
        }
        return { name, type: type as string, config, ...(nextFireAt ? { nextFireAt } : {}) };
      });
    this.st.triggers.replaceForWorkflow(tenant, workflow, version, specs);
    this.setEnabled(tenant, workflow, true);

    for (const s of specs) {
      if (s.type === 'webhook' && !this.broker.has(tenant, this.secretName(workflow, s.name))) {
        created.push(this.rotateWebhookSecret(tenant, workflow, s.name));
      }
      this.st.events.append({
        tenant,
        type: 'trigger.registered',
        data: { workflow, trigger: s.name, kind: s.type, version },
      });
    }
    return created;
  }

  private setEnabled(tenant: string, workflow: string, enabled: boolean): void {
    for (const t of this.st.triggers.listForWorkflow(tenant, workflow)) this.st.triggers.patch(t.id, { enabled });
  }

  private nextRun(cron: string, timezone: string | undefined, from: Date): Date | null {
    return new Cron(cron, { paused: true, ...(timezone ? { timezone } : {}) }).nextRun(from);
  }

  // ================================================================ schedules
  /** Fire every schedule whose slot has arrived. Called by the timer; public so tests and the CLI can drive it. */
  runDue(): void {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const t of this.st.triggers.dueSchedules(this.clock.now().toISOString())) {
        try {
          this.fireSchedule(t);
        } catch (e) {
          this.log.error('schedule firing failed', { trigger: t.name, error: e });
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  fireSchedule(t: TriggerRecord): TriggerResult | undefined {
    const now = this.clock.now();
    const scheduled = new Date(t.nextFireAt!);
    const cron = String(t.config.cron);
    const tz = t.config.timezone as string | undefined;
    const catchup = (t.config.catchup as string | undefined) ?? 'none';

    // Work out the next slot after "now" so a long outage never causes a burst of runs.
    let next = this.nextRun(cron, tz, scheduled);
    while (next && next.getTime() <= now.getTime()) next = this.nextRun(cron, tz, next);
    this.st.triggers.patch(t.id, { nextFireAt: next?.toISOString() ?? null });

    const late = now.getTime() - scheduled.getTime();
    if (late > MISSED_AFTER_MS && catchup === 'none') {
      this.st.events.append({
        tenant: t.tenant,
        type: 'trigger.rejected',
        data: {
          workflow: t.workflowName,
          trigger: t.name,
          reason: `missed slot ${scheduled.toISOString()} skipped (catchup: none)`,
        },
      });
      return undefined;
    }
    // Exactly-once per slot, even across restarts or overlapping ticks.
    if (!this.st.triggers.recordFire(t.id, scheduled.toISOString())) return undefined;

    const inputs = (t.config.inputs as Record<string, unknown> | undefined) ?? {};
    return this.fire(
      t,
      inputs,
      { type: 'schedule', name: t.name, payload: { scheduledFor: scheduled.toISOString() } },
      scheduled.toISOString(),
    );
  }

  private fire(
    t: TriggerRecord,
    inputs: Record<string, unknown>,
    trigger: { type: string; name: string; payload?: unknown },
    fireKey: string,
  ): TriggerResult | undefined {
    try {
      const result = this.runs.trigger({
        principal: TRIGGER_PRINCIPAL(t.tenant, t.name),
        workflow: t.workflowName,
        inputs,
        trigger,
        correlationId: `${t.name}:${fireKey}`,
      });
      this.st.triggers.patch(t.id, { lastFiredAt: this.clock.now().toISOString() });
      if (result.status === 'queued') this.st.triggers.attachRunToFire(t.id, fireKey, result.run.id);
      this.st.events.append({
        tenant: t.tenant,
        type: 'trigger.fired',
        ...(result.status === 'queued' || result.status === 'deduplicated' ? { runId: result.run.id } : {}),
        data: { workflow: t.workflowName, trigger: t.name, kind: t.type, outcome: result.status },
      });
      return result;
    } catch (e) {
      const info = toErrorInfo(e);
      this.st.events.append({
        tenant: t.tenant,
        type: 'trigger.rejected',
        data: { workflow: t.workflowName, trigger: t.name, reason: `${info.code}: ${info.message}` },
      });
      return undefined;
    }
  }

  // ================================================================= webhooks
  private secretName(workflow: string, trigger: string): string {
    return `WEBHOOK_${workflow}_${trigger}`.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 64);
  }

  /** Create or replace a webhook's signing secret. The plaintext is returned once and never retrievable again. */
  rotateWebhookSecret(tenant: string, workflow: string, trigger: string): WebhookSecretInfo {
    const t = this.st.triggers.find(tenant, workflow, trigger);
    if (t?.type !== 'webhook') throw new NotFoundError('Webhook trigger', `${workflow}/${trigger}`);
    const secret = `whsec_${randomToken(32)}`;
    this.broker.put(
      tenant,
      this.secretName(workflow, trigger),
      secret,
      'system:trigger-manager',
      `Signing secret for webhook ${workflow}/${trigger}`,
    );
    return { trigger, secret };
  }

  handleWebhook(d: WebhookDelivery): TriggerResult {
    const t = this.st.triggers.find(d.tenant, d.workflow, d.trigger);
    // Same error for "no such webhook" and "bad signature" — do not reveal which webhooks exist.
    if (t?.type !== 'webhook' || !t.enabled) throw new AuthenticationError('Webhook authentication failed');
    if (Buffer.byteLength(d.rawBody, 'utf8') > MAX_WEBHOOK_BODY) {
      throw new ValidationError('Webhook payload is too large', [
        { path: 'body', code: 'PAYLOAD_TOO_LARGE', message: 'Payloads are limited to 1 MiB' },
      ]);
    }
    const lease = this.broker.lease({
      tenant: d.tenant,
      names: [this.secretName(d.workflow, d.trigger)],
      ttlMs: 5_000,
    });
    let verdict: ReturnType<typeof verifyWebhook>;
    try {
      verdict = verifyWebhook({
        secret: lease.get(this.secretName(d.workflow, d.trigger)),
        timestamp: d.headers.timestamp,
        signature: d.headers.signature,
        rawBody: d.rawBody,
        nowMs: this.clock.now().getTime(),
      });
    } finally {
      lease.revoke();
    }
    if (!verdict.ok) {
      this.st.events.append({
        tenant: d.tenant,
        type: 'trigger.rejected',
        data: { workflow: d.workflow, trigger: d.trigger, reason: `webhook ${verdict.reason}` },
      });
      throw new AuthenticationError('Webhook authentication failed');
    }
    // Replay protection: a given delivery is accepted once.
    const fireKey = d.headers.delivery ?? verdict.nonce;
    if (!this.st.triggers.useNonce(d.tenant, `${t.id}:${fireKey}`, 10 * 60_000)) {
      this.st.events.append({
        tenant: d.tenant,
        type: 'trigger.rejected',
        data: { workflow: d.workflow, trigger: d.trigger, reason: 'webhook replay' },
      });
      throw new AuthenticationError('Webhook authentication failed');
    }

    let payload: unknown;
    try {
      payload = d.rawBody.trim() === '' ? {} : JSON.parse(d.rawBody);
    } catch {
      throw new ValidationError('Webhook body must be JSON', [
        { path: 'body', code: 'INVALID_JSON', message: 'The request body is not valid JSON' },
      ]);
    }
    const inputs = this.mapInputs(t, { type: `webhook:${d.trigger}`, payload }, d.tenant);
    this.st.triggers.recordFire(t.id, fireKey);
    const result = this.fire(t, inputs, { type: 'webhook', name: t.name, payload }, fireKey);
    if (!result)
      throw new ValidationError('The webhook was accepted but the run could not be started', [
        { path: '', code: 'RUN_NOT_STARTED', message: 'See the audit log (trigger.rejected) for the reason' },
      ]);
    return result;
  }

  // ============================================================ events & links
  /** Publish an event: resumes matching `wait` steps and fires matching event triggers. */
  publishEvent(
    tenant: string,
    type: string,
    payload: unknown,
    correlation?: string,
  ): { resumed: number; runs: string[] } {
    const resumed = this.orch.deliverEvent(tenant, type, correlation ?? null, payload);
    const runs: string[] = [];
    for (const t of this.st.triggers.eventSubscribers(tenant, type)) {
      const facts = { event: { type, payload, correlation: correlation ?? null } };
      const filter = t.config.filter as string | undefined;
      if (filter) {
        try {
          if (!isTruthy(evaluate(parseExpressionField(filter), facts))) continue;
        } catch {
          continue;
        }
      }
      try {
        const inputs = this.mapInputs(t, facts.event, tenant);
        const key = correlation ?? `${Date.now()}:${Math.random()}`;
        if (!this.st.triggers.recordFire(t.id, `${type}:${key}`)) continue;
        const r = this.fire(t, inputs, { type: 'event', name: t.name, payload }, `${type}:${key}`);
        if (r && (r.status === 'queued' || r.status === 'deduplicated')) runs.push(r.run.id);
      } catch (e) {
        this.st.events.append({
          tenant,
          type: 'trigger.rejected',
          data: { workflow: t.workflowName, trigger: t.name, reason: (e as Error).message },
        });
      }
    }
    return { resumed, runs };
  }

  private onRunFinished(run: RunRecord): void {
    if (run.status === 'cancelled') return;
    const failed = run.status === 'failed' || run.status === 'rolled-back' || run.status === 'compensation-failed';
    for (const t of this.st.triggers.completionSubscribers(run.tenant, run.workflowName)) {
      const want = (t.config.status as string | undefined) ?? 'succeeded';
      if (!(want === 'any' || (want === 'succeeded' && run.status === 'succeeded') || (want === 'failed' && failed)))
        continue;
      try {
        const facts = {
          type: 'workflow.completed',
          payload: {
            runId: run.id,
            workflow: run.workflowName,
            status: run.status,
            outputs: run.outputs ?? {},
            error: run.error ?? null,
          },
        };
        const inputs = this.mapInputs(t, facts, run.tenant);
        const key = `completion:${run.id}`;
        if (!this.st.triggers.recordFire(t.id, key)) continue;
        this.fire(t, inputs, { type: 'workflow-completion', name: t.name, payload: facts.payload }, key);
      } catch (e) {
        this.log.error('completion trigger failed', { trigger: t.name, error: e });
      }
    }
  }

  /** Build workflow inputs from an event using the trigger's mapping, or the raw payload when none is declared. */
  private mapInputs(
    t: TriggerRecord,
    event: { type: string; payload: unknown },
    tenant: string,
  ): Record<string, unknown> {
    const mapping = t.config.inputs as Record<string, unknown> | undefined;
    if (!mapping) {
      // A completion payload (run id, status, outputs…) is not shaped like workflow inputs; map it explicitly.
      if (t.type === 'workflow-completion') return {};
      if (event.payload === null || typeof event.payload !== 'object' || Array.isArray(event.payload)) return {};
      return event.payload as Record<string, unknown>;
    }
    const v = this.st.registry.getVersion(tenant, t.workflowName, t.workflowVersion);
    const plan: Plan | undefined = v ? this.st.registry.getPlan(tenant, v.planHash) : undefined;
    try {
      const mapped = resolveValue(mapping, { event, context: plan?.context ?? {} }) as Record<string, unknown>;
      // Fail early with a precise message if the mapped inputs cannot satisfy the workflow.
      if (plan) {
        const checked = validateValue(plan.inputSchema, mapped);
        if (!checked.ok) throw new ValidationError('Mapped trigger inputs are invalid', checked.issues);
      }
      return mapped;
    } catch (e) {
      if (e instanceof ValidationError) throw e;
      throw new ValidationError(`Could not map trigger inputs: ${(e as Error).message}`, [
        { path: 'inputs', code: 'TRIGGER_MAPPING_FAILED', message: (e as Error).message },
      ]);
    }
  }
}
