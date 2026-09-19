import { createDefaultRegistry, CapabilityError, defineCapability, type CapabilityRegistry } from '../../capabilities/index.ts';
import { contentHash, systemClock } from '../../core/index.ts';
import { compile } from '../../orchestration/compiler/index.ts';
import { Orchestrator, type OrchestratorConfig } from '../../orchestration/orchestrator/index.ts';
import { CircuitBreakers, StepRuntime } from '../../orchestration/runtime/index.ts';
import type { CapabilityDeclaration, EventRecord, Plan } from '../../schemas/index.ts';
import { createKeyring, generateMasterKey, SecretBroker } from '../../security/secret-broker/index.ts';
import type { RunRecord } from '../../state/index.ts';
import { makeState, principal, type TestState } from './state.ts';

/** The "outside world" for simulation tests: what external systems observed. */
export interface World {
  /** Unique external effects — an external system that dedupes by idempotency key, like a payment API. */
  effects: string[];
  /** Raw invocations of effectful capabilities (including replays that reached the adapter). */
  calls: string[];
  compensations: string[];
  failUndo: Set<string>;
  attempts: Map<string, number>;
  concurrent: number;
  maxConcurrent: number;
  seenKeys: Set<string>;
  secretsSeen: string[];
}

export const newWorld = (): World => ({
  effects: [],
  calls: [],
  compensations: [],
  failUndo: new Set(),
  attempts: new Map(),
  concurrent: 0,
  maxConcurrent: 0,
  seenKeys: new Set(),
  secretsSeen: [],
});

const base: Omit<CapabilityDeclaration, 'name' | 'effect'> = {
  version: '1.0.0',
  description: 'simulation capability',
  family: 'sim',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  scopes: [],
  egress: { mode: 'none' },
  costModel: { unitsPerInvocation: 1, latencyClass: 'fast' },
  failureModes: [],
  dataClassification: 'confidential',
  dryRun: 'execute',
};

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

export function simCapabilities(world: World) {
  return [
    defineCapability({
      declaration: {
        ...base,
        name: 'sim-effect',
        effect: 'effectful',
        dryRun: 'simulate',
        inputSchema: { type: 'object', required: ['label'], properties: { label: { type: 'string' }, hangMs: { type: 'integer' } }, additionalProperties: false },
        outputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } }, additionalProperties: false },
        compensation: 'sim-undo@^1',
      },
      execute: async (ctx, i: { label: string; hangMs?: number }) => {
        world.calls.push(i.label);
        // The external system dedupes by idempotency key, as real payment/e-mail APIs do.
        const dedupe = ctx.idempotencyKey ?? i.label;
        if (!world.seenKeys.has(dedupe)) {
          world.seenKeys.add(dedupe);
          world.effects.push(i.label);
        }
        if (i.hangMs) await sleep(i.hangMs, ctx.signal);
        return { id: `eff_${i.label}` };
      },
    }),
    defineCapability({
      declaration: {
        ...base,
        name: 'sim-undo',
        effect: 'effectful',
        dryRun: 'simulate',
        inputSchema: { type: 'object', required: ['label'], properties: { label: { type: 'string' } }, additionalProperties: false },
        failureModes: [{ code: 'UNDO_FAILED', class: 'business', retryable: false }],
      },
      execute: async (_ctx, i: { label: string }) => {
        if (world.failUndo.has(i.label)) throw new CapabilityError('UNDO_FAILED', `cannot undo ${i.label}`, { errorClass: 'business' });
        world.compensations.push(i.label);
        return { undone: i.label };
      },
    }),
    defineCapability({
      declaration: {
        ...base,
        name: 'sim-flaky',
        effect: 'idempotent',
        inputSchema: {
          type: 'object',
          required: ['key', 'failTimes'],
          properties: { key: { type: 'string' }, failTimes: { type: 'integer' }, errorClass: { type: 'string' } },
          additionalProperties: false,
        },
        outputSchema: { type: 'object', required: ['attempts'], properties: { attempts: { type: 'integer' } } },
      },
      execute: async (_ctx, i: { key: string; failTimes: number; errorClass?: string }) => {
        const n = (world.attempts.get(i.key) ?? 0) + 1;
        world.attempts.set(i.key, n);
        if (n <= i.failTimes) throw new CapabilityError('FLAKY', `attempt ${n} failed`, { errorClass: (i.errorClass as never) ?? 'transient' });
        return { attempts: n };
      },
    }),
    defineCapability({
      declaration: {
        ...base,
        name: 'sim-slow',
        effect: 'idempotent',
        inputSchema: { type: 'object', required: ['ms'], properties: { ms: { type: 'integer' }, tag: { type: 'string' } }, additionalProperties: false },
        outputSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' }, tag: { type: 'string' } } },
      },
      execute: async (ctx, i: { ms: number; tag?: string }) => {
        world.concurrent++;
        world.maxConcurrent = Math.max(world.maxConcurrent, world.concurrent);
        try {
          await sleep(i.ms, ctx.signal);
          return { ok: true, ...(i.tag ? { tag: i.tag } : {}) };
        } finally {
          world.concurrent--;
        }
      },
    }),
    defineCapability({
      declaration: {
        ...base,
        name: 'sim-secret',
        effect: 'idempotent',
        inputSchema: { type: 'object', required: ['token'], properties: { token: { type: 'string' }, leak: { type: 'boolean' }, echo: { type: 'boolean' } }, additionalProperties: false },
        outputSchema: { type: 'object' },
      },
      execute: async (_ctx, i: { token: string; leak?: boolean; echo?: boolean }) => {
        world.secretsSeen.push(i.token);
        if (i.leak) throw new Error(`upstream rejected token ${i.token}`);
        return i.echo ? { length: i.token.length, echoed: i.token } : { length: i.token.length };
      },
    }),
    defineCapability({
      declaration: {
        ...base,
        name: 'sim-bad-output',
        effect: 'idempotent',
        outputSchema: { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } },
      },
      execute: async () => ({ n: 'not-a-number' }),
    }),
    defineCapability({
      declaration: {
        ...base,
        name: 'sim-big',
        effect: 'idempotent',
        inputSchema: { type: 'object', properties: { size: { type: 'integer' } } },
      },
      execute: async (_ctx, i: { size?: number }) => ({ blob: 'x'.repeat(i.size ?? 10) }),
    }),
  ];
}

export function registryWithSims(world: World): CapabilityRegistry {
  const r = createDefaultRegistry();
  for (const c of simCapabilities(world)) r.register(c);
  return r;
}

export const wf = (steps: unknown[], extra: Record<string, unknown> = {}, name = 'wf'): any => ({
  apiVersion: 'omniflow.dev/v1',
  kind: 'Workflow',
  metadata: { name, version: '1.0.0', owner: 'test@example.com', description: 'test', criticality: 'low' },
  triggers: [{ type: 'manual' }],
  inputs: {},
  steps,
  ...extra,
});

export const echo = (id: string, value: unknown, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'capability',
  uses: 'util-echo@^1',
  with: { value },
  ...extra,
});

/** A retry policy tuned for fast tests. */
export const fastRetry = (attempts = 3) => ({ attempts, backoff: 'fixed', initialDelay: '10ms', maxDelay: '50ms', jitter: 0 });

export interface Engine {
  state: TestState;
  registry: CapabilityRegistry;
  world: World;
  orch: Orchestrator;
  broker: SecretBroker;
  breakers: CircuitBreakers;
  keyring: ReturnType<typeof createKeyring>;
  publish(manifest: unknown): { plan: Plan; hash: string };
  /** Create and start a run of a published workflow, then wait for it to settle. */
  run(name: string, inputs?: Record<string, unknown>, opts?: { dryRun?: boolean; wait?: boolean; seed?: string }): Promise<RunRecord>;
  submit(name: string, inputs?: Record<string, unknown>, opts?: { dryRun?: boolean; seed?: string }): RunRecord;
  events(runId: string): EventRecord[];
  types(runId: string, prefix?: string): string[];
  step(runId: string, stepId: string): ReturnType<TestState['runs']['getStep']>;
  /** Simulate a process restart: a brand-new orchestrator and runtime over the same durable state. */
  restart(): Engine;
}

export interface EngineOptions {
  config?: Partial<OrchestratorConfig>;
  world?: World;
  state?: TestState;
  keyring?: ReturnType<typeof createKeyring>;
}

export function makeEngine(opts: EngineOptions = {}): Engine {
  const state = opts.state ?? makeState();
  state.clock.set(new Date()); // real time: simulation tests use real timers
  const world = opts.world ?? newWorld();
  const registry = registryWithSims(world);
  const keyring = opts.keyring ?? createKeyring(generateMasterKey());
  const broker = new SecretBroker(state.secrets, keyring, systemClock);
  const breakers = new CircuitBreakers({ failureThreshold: 3, cooldownMs: 100 }, systemClock);
  const runtime = new StepRuntime({ registry, events: state.events, idempotency: state.idempotency, kv: state.kv, broker, breakers, clock: systemClock });
  const orch = new Orchestrator({ state, executor: runtime, clock: systemClock, config: { tickMs: 20, ...opts.config } });
  orch.start();

  const swResolver = {
    resolve(name: string, version: string) {
      const v = state.registry.getVersion('default', name, version);
      const plan = v && state.registry.getPlan('default', v.planHash);
      if (!v || !plan) return undefined;
      return {
        version,
        planHash: v.planHash,
        inputSchema: plan.inputSchema,
        subworkflowDepth: plan.analysis.subworkflowDepth,
        subworkflowChain: [plan.workflow.name, ...plan.analysis.subworkflowChain],
        maxInvocations: plan.analysis.maxInvocations,
        estimatedCost: plan.analysis.estimatedCost,
        maxCost: plan.analysis.maxCost,
      };
    },
  };

  const engine: Engine = {
    state,
    registry,
    world,
    orch,
    broker,
    breakers,
    keyring,
    publish(manifest) {
      const r = compile(manifest, { environment: 'production', capabilities: registry, subworkflows: swResolver, today: '2026-09-19' });
      if (!r.ok || !r.plan || !r.hash) throw new Error(`compile failed: ${JSON.stringify(r.errors)}`);
      state.registry.insertVersion({
        tenant: 'default',
        name: r.plan.workflow.name,
        version: r.plan.workflow.version,
        manifestText: JSON.stringify(manifest),
        manifestHash: contentHash(manifest),
        planHash: r.hash,
        plan: r.plan,
        environment: 'production',
        publishedBy: 'usr_test',
      });
      return { plan: r.plan, hash: r.hash };
    },
    submit(name, inputs = {}, o = {}) {
      const v = state.registry.latestVersion('default', name)!;
      const plan = state.registry.getPlan('default', v.planHash)!;
      const run = orch.createRun({
        tenant: 'default',
        plan,
        planHash: v.planHash,
        inputs,
        principal: principal(),
        trigger: { type: 'manual' },
        ...(o.dryRun ? { dryRun: true } : {}),
        ...(o.seed ? { seed: o.seed } : {}),
      });
      orch.startRun(run.id);
      return run;
    },
    async run(name, inputs = {}, o = {}) {
      const run = engine.submit(name, inputs, o);
      if (o.wait === false) return run;
      return orch.waitForRun(run.id, 10_000);
    },
    events: (runId) => state.events.list({ tenant: 'default', runId, limit: 5000 }),
    types: (runId, prefix) => engine.events(runId).map((e) => e.type).filter((t) => !prefix || t.startsWith(prefix)),
    step: (runId, stepId) => state.runs.getStep(runId, stepId),
    restart() {
      return makeEngine({ ...opts, state, world, keyring, ...(opts.config ? { config: opts.config } : {}) });
    },
  };
  return engine;
}
