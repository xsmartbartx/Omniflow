import { type Clock, createLogger, type Logger, systemClock } from '../../core/index.ts';
import type { State } from '../../state/index.ts';
import { humanMs, pct, ratio } from '../util.ts';

export type AlertSeverity = 'warning' | 'critical';

export interface Alert {
  tenant: string;
  /** Stable identity of the condition — the same problem is one alert, however often it is re-observed. */
  key: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  raisedAt: string;
  lastNotifiedAt: string;
}

export type AlertEvent = 'raised' | 'reminder' | 'resolved';

/** Delivers an alert to humans. Failures are reported and swallowed; they never stop alerting. */
export type AlertNotifier = (alert: Alert, event: AlertEvent) => Promise<void>;

export interface AlertConfig {
  /** Look-back window for "this workflow is failing". */
  failureWindowMs: number;
  failureMinRuns: number;
  failureRate: number;
  approvalSlaMs: number;
  /** A running run that has done nothing for this long, with no step in flight, is stalled. */
  stalledMs: number;
  queueAgeMs: number;
  queueDepth: number;
  /** Repeat notifications for alerts that stay open. */
  renotifyMs: number;
  /** How often to walk the audit hash chain. 0 = on every tick. */
  auditVerifyEveryMs: number;
  intervalMs: number;
}

export const DEFAULT_ALERT_CONFIG: AlertConfig = {
  failureWindowMs: 30 * 60_000,
  failureMinRuns: 4,
  failureRate: 0.5,
  approvalSlaMs: 60 * 60_000,
  stalledMs: 30 * 60_000,
  queueAgeMs: 5 * 60_000,
  queueDepth: 50,
  renotifyMs: 6 * 60 * 60_000,
  auditVerifyEveryMs: 6 * 60 * 60_000,
  intervalMs: 60_000,
};

export interface AlertManagerDeps {
  state: State;
  clock?: Clock;
  log?: Logger;
  notify?: AlertNotifier;
  /** Circuit breaker states (platform-wide). Supplied by the composition root so this module stays read-only. */
  circuits?: () => Record<string, { state: string }>;
  config?: Partial<AlertConfig>;
}

type Candidate = Pick<Alert, 'key' | 'severity' | 'title' | 'message'>;

const idOf = (tenant: string, key: string) => `${tenant}::${key}`;

/**
 * SLO alerting (architecture §5.1 #19): watches the state plane for conditions a person should hear
 * about, tells them once, reminds them occasionally, and says when it is over. Read-only over run
 * state; its only writes are `alert.*` audit events.
 */
export class AlertManager {
  private readonly st: State;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly notify: AlertNotifier | undefined;
  private readonly circuits: (() => Record<string, { state: string }>) | undefined;
  private readonly cfg: AlertConfig;
  private readonly open = new Map<string, Alert>();
  private nextAuditCheck = 0;
  private readonly auditBroken = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;

  constructor(deps: AlertManagerDeps) {
    this.st = deps.state;
    this.clock = deps.clock ?? systemClock;
    this.log = deps.log ?? createLogger({ level: 'silent' });
    this.notify = deps.notify;
    this.circuits = deps.circuits;
    this.cfg = { ...DEFAULT_ALERT_CONFIG, ...deps.config };
  }

  /** Rebuild the set of open alerts from the audit log, so a restart neither forgets nor repeats them. */
  restore(): void {
    this.open.clear();
    for (const t of this.st.identity.listTenants()) {
      const events = this.st.events.list({
        tenant: t.id,
        types: ['alert.raised', 'alert.resolved'],
        order: 'asc',
        limit: 5000,
      });
      for (const e of events) {
        const d = e.data as { key: string; severity?: AlertSeverity; title?: string; message?: string };
        if (e.type === 'alert.raised') {
          this.open.set(idOf(t.id, d.key), {
            tenant: t.id,
            key: d.key,
            severity: d.severity ?? 'warning',
            title: d.title ?? d.key,
            message: d.message ?? '',
            raisedAt: e.ts,
            lastNotifiedAt: e.ts,
          });
        } else this.open.delete(idOf(t.id, d.key));
      }
    }
  }

  start(): void {
    if (this.timer) return;
    this.restore();
    this.nextAuditCheck = this.clock.now().getTime() + this.cfg.auditVerifyEveryMs;
    this.timer = setInterval(
      () => void this.tick().catch((e) => this.log.error('alert tick failed', { error: e })),
      this.cfg.intervalMs,
    );
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  active(tenant: string): Alert[] {
    return [...this.open.values()]
      .filter((a) => a.tenant === tenant)
      .sort((a, b) =>
        a.severity === b.severity ? a.raisedAt.localeCompare(b.raisedAt) : a.severity === 'critical' ? -1 : 1,
      )
      .map((a) => ({ ...a }));
  }

  /** History of alerts (raised and resolved), newest first. */
  history(tenant: string, limit = 100) {
    return this.st.events
      .list({ tenant, types: ['alert.raised', 'alert.resolved'], order: 'desc', limit })
      .map((e) => ({ at: e.ts, event: e.type === 'alert.raised' ? 'raised' : 'resolved', ...(e.data as object) }));
  }

  /** Evaluate every tenant once: raise new alerts, remind about old ones, resolve cleared ones. */
  async tick(): Promise<{ raised: number; resolved: number }> {
    if (this.ticking) return { raised: 0, resolved: 0 };
    this.ticking = true;
    try {
      let raised = 0;
      let resolved = 0;
      const auditDue = this.clock.now().getTime() >= this.nextAuditCheck;
      if (auditDue) this.nextAuditCheck = this.clock.now().getTime() + this.cfg.auditVerifyEveryMs;
      for (const t of this.st.identity.listTenants()) {
        if (t.disabled) continue;
        const seen = new Set<string>();
        for (const c of this.evaluate(t.id, auditDue)) {
          seen.add(c.key);
          const existing = this.open.get(idOf(t.id, c.key));
          const now = this.clock.now().toISOString();
          if (!existing) {
            const alert: Alert = { tenant: t.id, ...c, raisedAt: now, lastNotifiedAt: now };
            this.open.set(idOf(t.id, c.key), alert);
            this.st.events.append({
              tenant: t.id,
              type: 'alert.raised',
              actor: { type: 'system', id: 'alert-manager' },
              data: { key: c.key, severity: c.severity, title: c.title, message: c.message },
            });
            raised++;
            await this.deliver(alert, 'raised');
          } else {
            existing.message = c.message;
            existing.title = c.title;
            existing.severity = c.severity;
            if (this.clock.now().getTime() - Date.parse(existing.lastNotifiedAt) >= this.cfg.renotifyMs) {
              existing.lastNotifiedAt = now;
              await this.deliver(existing, 'reminder');
            }
          }
        }
        for (const [id, alert] of [...this.open]) {
          if (alert.tenant !== t.id || seen.has(alert.key)) continue;
          // The audit check runs rarely; do not "resolve" an integrity alert just because we did not look this tick.
          if (alert.key === 'audit-integrity' && !auditDue) continue;
          this.open.delete(id);
          this.st.events.append({
            tenant: t.id,
            type: 'alert.resolved',
            actor: { type: 'system', id: 'alert-manager' },
            data: { key: alert.key, openForMs: this.clock.now().getTime() - Date.parse(alert.raisedAt) },
          });
          resolved++;
          await this.deliver(alert, 'resolved');
        }
      }
      return { raised, resolved };
    } finally {
      this.ticking = false;
    }
  }

  /** What is wrong right now, for one tenant. Does not touch alert state. */
  evaluate(tenant: string, checkAudit = false): Candidate[] {
    const now = this.clock.now().getTime();
    const iso = (ms: number) => new Date(ms).toISOString();
    const out: Candidate[] = [];

    for (const o of this.st.analytics.recentOutcomes(tenant, iso(now - this.cfg.failureWindowMs))) {
      if (o.finished < this.cfg.failureMinRuns || ratio(o.failed, o.finished) < this.cfg.failureRate) continue;
      const last = this.st.runs.listRuns({
        tenant,
        workflow: o.workflow,
        status: ['failed', 'rolled-back', 'compensation-failed'],
        limit: 1,
      })[0];
      out.push({
        key: `workflow-failing:${o.workflow}`,
        severity: ratio(o.failed, o.finished) >= 0.8 ? 'critical' : 'warning',
        title: `${o.workflow} is failing`,
        message: `${o.failed} of ${o.finished} runs failed in the last ${humanMs(this.cfg.failureWindowMs)} (${pct(ratio(o.failed, o.finished))}).${last?.error ? ` Latest error: ${last.error.code} — ${last.error.message}` : ''}`,
      });
    }

    const stale = this.st.analytics.staleApprovals(tenant, iso(now - this.cfg.approvalSlaMs));
    if (stale.length > 0) {
      const oldest = stale[0]!;
      out.push({
        key: 'approvals-waiting',
        severity: 'warning',
        title: `${stale.length} approval${stale.length === 1 ? '' : 's'} waiting too long`,
        message: `The oldest, for ${oldest.workflow ?? 'a run'} › ${oldest.stepId}, has been waiting ${humanMs(now - Date.parse(oldest.requestedAt))}. Runs stay paused until someone decides.`,
      });
    }

    const byWorkflow = new Map<string, number>();
    for (const r of this.st.analytics.stalledRuns(tenant, iso(now - this.cfg.stalledMs)))
      byWorkflow.set(r.workflow, (byWorkflow.get(r.workflow) ?? 0) + 1);
    for (const [workflow, n] of byWorkflow) {
      out.push({
        key: `runs-stalled:${workflow}`,
        severity: 'critical',
        title: `${workflow} has ${n} stalled run${n === 1 ? '' : 's'}`,
        message: `${n} run${n === 1 ? ' is' : 's are'} marked running but no step has made progress for over ${humanMs(this.cfg.stalledMs)}. The orchestrator may be down or wedged.`,
      });
    }

    const q = this.st.analytics.queue(tenant);
    const age = q.oldestCreatedAt ? now - Date.parse(q.oldestCreatedAt) : 0;
    if (q.depth >= this.cfg.queueDepth || (q.depth > 0 && age >= this.cfg.queueAgeMs)) {
      out.push({
        key: 'queue-backlog',
        severity: 'warning',
        title: 'Runs are backing up',
        message: `${q.depth} run${q.depth === 1 ? ' is' : 's are'} queued; the oldest has waited ${humanMs(age)}. Capacity may be exhausted (OMNIFLOW_MAX_CONCURRENT_RUNS).`,
      });
    }

    // Platform-wide facts are reported under the default tenant only.
    if (tenant === 'default' && this.circuits) {
      for (const [capability, c] of Object.entries(this.circuits())) {
        if (c.state === 'closed') continue;
        out.push({
          key: `circuit-open:${capability}`,
          severity: 'warning',
          title: `Capability ${capability} is failing fast`,
          message: `The circuit breaker for ${capability} is ${c.state}: steps that use it fail immediately instead of hammering a dependency that is down. It closes itself once calls succeed again.`,
        });
      }
    }

    if (checkAudit) {
      const v = this.st.events.verify(tenant);
      if (v.ok) this.auditBroken.delete(tenant);
      else this.auditBroken.set(tenant, `event ${v.brokenAtSeq}: ${v.reason ?? 'hash mismatch'}`);
    }
    const broken = this.auditBroken.get(tenant);
    if (broken) {
      out.push({
        key: 'audit-integrity',
        severity: 'critical',
        title: 'The audit log failed its integrity check',
        message: `The hash chain is broken at ${broken}. Someone altered or removed audit history; treat this as a security incident and restore from a verified backup for evidence.`,
      });
    }
    return out;
  }

  private async deliver(alert: Alert, event: AlertEvent): Promise<void> {
    this.log[alert.severity === 'critical' ? 'error' : 'warn'](`alert ${event}`, {
      key: alert.key,
      tenant: alert.tenant,
      title: alert.title,
    });
    if (!this.notify) return;
    try {
      await this.notify({ ...alert }, event);
    } catch (e) {
      this.log.error('alert notification failed', { key: alert.key, error: e });
    }
  }
}

/** Plain-text rendering shared by every channel. */
export function formatAlert(alert: Alert, event: AlertEvent): string {
  const tag =
    event === 'resolved'
      ? 'RESOLVED'
      : event === 'reminder'
        ? `STILL ${alert.severity.toUpperCase()}`
        : alert.severity.toUpperCase();
  return `[${tag}] ${alert.title}${event === 'resolved' ? '' : `\n${alert.message}`}\n(OmniFlow, tenant ${alert.tenant})`;
}
