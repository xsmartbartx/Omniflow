import { ACTIVE_RUN_STATUSES, type State } from '../../state/index.ts';
import { MetricsRegistry } from './metrics.ts';

/**
 * Feed the metrics registry from the event log (the single source of truth) and from live state at
 * scrape time. Read-only over the event log (architecture §5.1 #19).
 */
export function createMetrics(
  state: State,
  opts: { version: string; environment: string; breakers?: () => Record<string, { state: string }> },
): MetricsRegistry {
  const m = new MetricsRegistry();
  const runs = m.counter('omniflow_runs_total', 'Runs that reached a terminal state.');
  const runSeconds = m.histogram('omniflow_run_duration_seconds', 'Run wall-clock duration.');
  const steps = m.counter('omniflow_steps_total', 'Step attempts by outcome.');
  const stepSeconds = m.histogram('omniflow_step_duration_seconds', 'Step attempt duration.');
  const retries = m.counter('omniflow_step_retries_total', 'Step retries scheduled.');
  const replays = m.counter(
    'omniflow_idempotent_replays_total',
    'Effects avoided because an idempotency key had already been applied.',
  );
  const denials = m.counter('omniflow_policy_denials_total', 'Policy decisions that denied or required approval.');
  const triggers = m.counter('omniflow_trigger_events_total', 'Trigger firings and rejections.');
  m.counter('omniflow_build_info', 'Build information.').inc(
    { version: opts.version, environment: opts.environment },
    1,
  );

  const active = m.gauge('omniflow_active_runs', 'Runs currently executing (running, waiting or compensating).');
  const queue = m.gauge('omniflow_queue_depth', 'Runs waiting to be admitted.');
  const approvals = m.gauge('omniflow_approvals_pending', 'Approval requests awaiting a decision.');
  const events = m.gauge('omniflow_event_log_events', 'Events in the audit log.');
  const circuits = m.gauge('omniflow_circuit_open', '1 when a capability circuit is open or half-open.');
  const uptime = m.gauge('omniflow_uptime_seconds', 'Process uptime.');
  const mem = m.gauge('process_resident_memory_bytes', 'Resident memory.');

  state.events.onAppend((e) => {
    const d = e.data as Record<string, unknown>;
    switch (e.type) {
      case 'run.succeeded':
      case 'run.failed':
      case 'run.cancelled':
      case 'run.rolled-back':
      case 'run.compensation-failed': {
        const run = e.runId ? state.runs.getRun(e.runId) : undefined;
        const wf = run?.workflowName ?? 'unknown';
        runs.inc({ workflow: wf, status: e.type.slice(4) });
        if (typeof d.durationMs === 'number') runSeconds.observe({ workflow: wf }, d.durationMs / 1000);
        break;
      }
      case 'step.succeeded':
        steps.inc({ outcome: d.simulated ? 'simulated' : d.replayed ? 'replayed' : 'succeeded' });
        if (typeof d.durationMs === 'number') stepSeconds.observe({}, d.durationMs / 1000);
        break;
      case 'step.failed':
        steps.inc({
          outcome: d.willRetry ? 'retrying' : 'failed',
          class: String((d.error as { class?: string } | undefined)?.class ?? 'unknown'),
        });
        break;
      case 'step.retry-scheduled':
        retries.inc();
        break;
      case 'step.idempotent-replay':
        replays.inc();
        break;
      case 'policy.decision':
        denials.inc({ action: String(d.action), effect: String(d.effect) });
        break;
      case 'trigger.fired':
      case 'trigger.rejected':
        triggers.inc({ event: e.type.slice(8) });
        break;
      default:
        break;
    }
  });

  m.collect(() => {
    const counts = state.runs.countByStatus();
    active.set(
      {},
      ACTIVE_RUN_STATUSES.reduce((n, s) => n + (counts[s] ?? 0), 0),
    );
    queue.set({}, counts.queued ?? 0);
    let pending = 0;
    let total = 0;
    for (const t of state.identity.listTenants()) {
      pending += state.approvals.pendingCount(t.id);
      total += state.events.count(t.id);
    }
    approvals.set({}, pending);
    events.set({}, total);
    uptime.set({}, process.uptime());
    mem.set({}, process.memoryUsage().rss);
    circuits.reset();
    for (const [cap, s] of Object.entries(opts.breakers?.() ?? {}))
      circuits.set({ capability: cap }, s.state === 'closed' ? 0 : 1);
  });
  return m;
}
