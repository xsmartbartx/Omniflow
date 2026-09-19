import { ManualClock, systemClock } from '../../core/index.ts';
import { ApprovalService, Orchestrator } from '../../orchestration/orchestrator/index.ts';
import { RegistryService, type SubmitResult } from '../../orchestration/registry/index.ts';
import { CircuitBreakers, StepRuntime } from '../../orchestration/runtime/index.ts';
import { RunService, Scheduler, type SchedulerConfig } from '../../orchestration/scheduler/index.ts';
import { TriggerManager } from '../../orchestration/triggers/index.ts';
import type { EnvironmentName, Principal, Role } from '../../schemas/index.ts';
import { defaultPolicyConfig, type PolicyConfig, PolicyEngine } from '../../security/policy/index.ts';
import { createKeyring, generateMasterKey, SecretBroker } from '../../security/secret-broker/index.ts';
import type { RunRecord } from '../../state/index.ts';
import { newWorld, registryWithSims, type World } from './engine.ts';
import { makeState, type TestState } from './state.ts';

export const user = (id: string, roles: Role[], tenant = 'default'): Principal => ({
  id,
  type: 'user',
  name: id,
  tenant,
  roles,
});

export interface Platform {
  state: TestState;
  world: World;
  policy: PolicyEngine;
  registry: RegistryService;
  orch: Orchestrator;
  runs: RunService;
  scheduler: Scheduler;
  triggers: TriggerManager;
  approvals: ApprovalService;
  broker: SecretBroker;
  triggerClock: ManualClock;
  users: Record<'admin' | 'author' | 'operator' | 'approver' | 'approver2' | 'viewer', Principal>;
  publish(who: Principal, manifest: unknown, opts?: { canaryPercent?: number }): SubmitResult;
  wait(run: RunRecord, ms?: number): Promise<RunRecord>;
  stop(): Promise<void>;
}

export function makePlatform(
  opts: {
    environment?: EnvironmentName;
    policy?: Partial<PolicyConfig>;
    scheduler?: Partial<SchedulerConfig>;
    world?: World;
  } = {},
): Platform {
  const state = makeState({ clock: systemClock });
  const world = opts.world ?? newWorld();
  const caps = registryWithSims(world);
  const policy = new PolicyEngine(
    defaultPolicyConfig({ environment: opts.environment ?? 'production', ...opts.policy }),
  );
  const registry = new RegistryService({ state, capabilities: caps, policy, clock: systemClock });
  const broker = new SecretBroker(state.secrets, createKeyring(generateMasterKey()), systemClock);
  const runtime = new StepRuntime({
    registry: caps,
    events: state.events,
    idempotency: state.idempotency,
    kv: state.kv,
    broker,
    breakers: new CircuitBreakers({}, systemClock),
    clock: systemClock,
  });
  const orch = new Orchestrator({ state, executor: runtime, clock: systemClock, config: { tickMs: 20 } });
  orch.start();

  let scheduler!: Scheduler;
  const runs = new RunService({ state, orchestrator: orch, registry, policy, onQueued: () => scheduler.pump() });
  scheduler = new Scheduler({ state, orchestrator: orch, registry, config: { pollMs: 20, ...opts.scheduler } });
  scheduler.start();

  const triggerClock = new ManualClock(new Date());
  const triggers = new TriggerManager({
    state,
    runService: runs,
    orchestrator: orch,
    broker,
    registry,
    clock: triggerClock,
  });
  triggers.start(3_600_000); // never auto-ticks; tests call runDue()
  const approvals = new ApprovalService({ state, orchestrator: orch, policy });

  return {
    state,
    world,
    policy,
    registry,
    orch,
    runs,
    scheduler,
    triggers,
    approvals,
    broker,
    triggerClock,
    users: {
      admin: user('usr_admin', ['admin']),
      author: user('usr_author', ['author']),
      operator: user('usr_operator', ['operator']),
      approver: user('usr_approver', ['approver']),
      approver2: user('usr_approver2', ['approver']),
      viewer: user('usr_viewer', ['viewer']),
    },
    publish: (who, manifest, o = {}) => registry.submit(who, JSON.stringify(manifest), o),
    wait: (run, ms = 10_000) => orch.waitForRun(run.id, ms),
    async stop() {
      scheduler.stop();
      triggers.stop();
      await orch.stop();
    },
  };
}
