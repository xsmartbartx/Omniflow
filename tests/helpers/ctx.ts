import type { CapabilityContext, Lease } from '../../schemas/index.ts';

export function stubLease(secrets: Record<string, string> = {}): Lease {
  return {
    id: 'lse_test',
    get(name) {
      if (!(name in secrets)) throw new Error(`secret ${name} not granted`);
      return secrets[name]!;
    },
    has: (name) => name in secrets,
  };
}

export function makeCtx(overrides: Partial<CapabilityContext> = {}): CapabilityContext {
  return {
    tenant: 'default',
    runId: 'run_test',
    stepId: 'step',
    attempt: 1,
    dryRun: false,
    egress: [],
    signal: new AbortController().signal,
    lease: stubLease(),
    seed: 'seed',
    now: '2026-01-01T00:00:00.000Z',
    log: () => {},
    ...overrides,
  };
}
