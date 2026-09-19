import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CapabilityRegistry, createDefaultRegistry, sendToChannel } from '../capabilities/index.ts';
import { type Clock, createLogger, type Logger, randomToken, systemClock } from '../core/index.ts';
import { Authenticator } from '../gateway/auth.ts';
import { AlertManager, AnalysisAgent, createMetrics, formatAlert } from '../insight/index.ts';
import { ApprovalService, Orchestrator } from '../orchestration/orchestrator/index.ts';
import { RegistryService } from '../orchestration/registry/index.ts';
import { CircuitBreakers, StepRuntime } from '../orchestration/runtime/index.ts';
import { RunService, Scheduler } from '../orchestration/scheduler/index.ts';
import { TriggerManager } from '../orchestration/triggers/index.ts';
import type { Principal } from '../schemas/index.ts';
import { defaultPolicyConfig, parsePolicyDocument, PolicyEngine } from '../security/policy/index.ts';
import { createKeyring, SecretBroker } from '../security/secret-broker/index.ts';
import { openState, type State, stateOptionsFor } from '../state/index.ts';
import type { Config } from './config.ts';
import type { Omniflow } from '../gateway/context.ts';

export type { Omniflow };

/**
 * The composition root: every component of architecture §5, wired together. Layers below never
 * import this file — dependencies point inward, and this is the only place that knows about all of
 * them.
 */

export interface OmniflowOverrides {
  state?: State;
  clock?: Clock;
  log?: Logger;
  capabilities?: CapabilityRegistry;
}

export function createOmniflow(config: Config, overrides: OmniflowOverrides = {}): Omniflow {
  const clock = overrides.clock ?? systemClock;
  const log = overrides.log ?? createLogger({ level: config.logLevel });
  const state = overrides.state ?? openState(stateOptionsFor(config.dataDir, clock));
  const capabilities = overrides.capabilities ?? createDefaultRegistry(config.adapters);

  const policy = new PolicyEngine(defaultPolicyConfig({ environment: config.environment, publishApprovals: config.publishApprovals }));
  const broker = new SecretBroker(state.secrets, createKeyring(config.masterKey, config.previousMasterKeys), clock);
  const breakers = new CircuitBreakers({}, clock, (capability, s) => {
    state.events.append({
      tenant: 'default',
      type: s === 'open' ? 'capability.circuit-opened' : 'capability.circuit-closed',
      data: { capability, state: s },
    });
    (s === 'open' ? log.warn : log.info).call(log, `circuit ${s}`, { capability });
  });
  const runtime = new StepRuntime({ registry: capabilities, events: state.events, idempotency: state.idempotency, kv: state.kv, broker, breakers, clock, log });
  const orchestrator = new Orchestrator({ state, executor: runtime, clock, log, config: { maxConcurrentSteps: config.maxConcurrentSteps } });
  const registry = new RegistryService({ state, capabilities, policy, clock });

  let scheduler!: Scheduler;
  const runs = new RunService({ state, orchestrator, registry, policy, clock, onQueued: () => scheduler?.pump() });
  scheduler = new Scheduler({ state, orchestrator, registry, clock, log, config: { maxConcurrentRuns: config.maxConcurrentRuns } });
  const triggers = new TriggerManager({ state, runService: runs, orchestrator, broker, registry, clock, log });
  const approvals = new ApprovalService({ state, orchestrator, policy, clock });
  const auth = new Authenticator(state, { sessionTtlHours: config.sessionTtlHours, log });
  const metrics = createMetrics(state, { version: config.version, environment: config.environment, breakers: () => breakers.snapshot() });
  const analysis = new AnalysisAgent({ state, clock, log });
  const alerts = new AlertManager({
    state,
    clock,
    log,
    circuits: () => breakers.snapshot(),
    config: { intervalMs: config.alertIntervalSeconds * 1000 },
    notify: async (alert, event) => {
      const text = formatAlert(alert, event);
      const results = await Promise.allSettled(config.alertChannels.map((name) => sendToChannel(config.adapters, name, text)));
      results.forEach((r, i) => r.status === 'rejected' && log.error('could not deliver alert', { channel: config.alertChannels[i], key: alert.key, error: r.reason }));
    },
  });
  let analysisTimer: NodeJS.Timeout | undefined;

  const app: Omniflow = {
    config,
    log,
    clock,
    state,
    capabilities,
    policy,
    broker,
    breakers,
    orchestrator,
    registry,
    runs,
    scheduler,
    triggers,
    approvals,
    auth,
    metrics,
    analysis,
    alerts,

    async start() {
      state.identity.ensureTenant('default', 'Default');
      loadPolicies(app);
      const bootstrap = await bootstrapAdmin(app);
      const { recovered } = orchestrator.start();
      scheduler.start();
      triggers.start();
      alerts.start();
      if (config.analysisIntervalHours > 0) {
        // First pass a few minutes after boot (so there is history to read), then on the configured cadence.
        const every = config.analysisIntervalHours * 3_600_000;
        const first = setTimeout(() => {
          analysis.runAll();
          analysisTimer = setInterval(() => analysis.runAll(), every);
          analysisTimer.unref();
        }, Math.min(every, 5 * 60_000));
        first.unref();
        analysisTimer = first;
      }
      if (config.seedExamples) seedExamples(app);
      state.events.append({ tenant: 'default', type: 'system.started', data: { version: config.version, environment: config.environment, recovered } });
      log.info('omniflow started', { version: config.version, environment: config.environment, recovered, capabilities: capabilities.latest().length });
      return { recovered, ...(bootstrap ? { bootstrap } : {}) };
    },

    async stop() {
      scheduler.stop();
      triggers.stop();
      alerts.stop();
      if (analysisTimer) clearTimeout(analysisTimer);
      await orchestrator.stop();
      state.events.append({ tenant: 'default', type: 'system.stopped', data: {} });
      state.db.checkpoint();
      state.close();
    },
  };
  return app;
}

/** Load operator policy documents. A broken governance rule must stop the platform, not be skipped. */
function loadPolicies(app: Omniflow): void {
  const { policyDir } = app.config;
  if (!existsSync(policyDir)) return;
  const docs = [];
  for (const file of readdirSync(policyDir).filter((f) => /\.(ya?ml|json)$/.test(f)).sort()) {
    const res = parsePolicyDocument(readFileSync(join(policyDir, file), 'utf8'));
    if (!res.ok || !res.document) {
      throw new Error(`Invalid policy file ${file}: ${res.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`);
    }
    docs.push(res.document);
  }
  const problems = app.policy.loadDocuments(docs);
  if (problems.length > 0) throw new Error(`Invalid policy rules: ${problems.map((p) => p.message).join('; ')}`);
  app.log.info('policies loaded', { documents: docs.length, rules: app.policy.ruleCount });
}

/** First start: create the initial admin so the platform is never left without a way in. */
async function bootstrapAdmin(app: Omniflow): Promise<{ email: string; password: string } | undefined> {
  if (app.state.identity.countUsers() > 0) return undefined;
  const password = app.config.admin.password ?? `${randomToken(12)}Aa1`;
  const generated = app.config.admin.password === undefined;
  await app.auth.createUser(
    { id: 'system:bootstrap', type: 'system', name: 'Bootstrap', tenant: 'default', roles: ['admin'] },
    { email: app.config.admin.email, name: 'Administrator', password, roles: ['admin'], mustChangePassword: generated },
  );
  app.log.warn('created the initial administrator', { email: app.config.admin.email, ...(generated ? { generatedPassword: 'see the value returned by start(); change it at first sign-in' } : {}) });
  return { email: app.config.admin.email, password: generated ? password : '(set by OMNIFLOW_ADMIN_PASSWORD)' };
}

/** Publish the shipped example workflows (opt-in). Anything that needs review is left as a change request. */
function seedExamples(app: Omniflow): void {
  const dir = app.config.workflowsDir;
  if (!existsSync(dir)) return;
  const admin: Principal = { id: 'system:seed', type: 'system', name: 'Seed', tenant: 'default', roles: ['admin'] };
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    try {
      const text = readFileSync(join(dir, file), 'utf8');
      const r = app.registry.submit(admin, text);
      app.log.info('seeded example workflow', { file, status: r.status });
    } catch (e) {
      const msg = (e as Error).message;
      if (!/already exists|must be greater/.test(msg)) app.log.warn('could not seed example workflow', { file, error: msg });
    }
  }
}

