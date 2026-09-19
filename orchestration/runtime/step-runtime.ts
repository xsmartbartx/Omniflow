import {
  type Clock,
  collectReferences,
  type ErrorInfo,
  evaluate,
  type Logger,
  nullLogger,
  OmniflowError,
  parseExpressionField,
  redact,
  resolveValue,
  scanTemplates,
  scrubString,
  systemClock,
  createRng,
} from '../../core/index.ts';
import { type CapabilityRegistry, exampleFromSchema } from '../../capabilities/index.ts';
import type { RegisteredCapability } from '../../capabilities/contract/types.ts';
import type { CapabilityContext } from '../../schemas/capability.ts';
import type { ActiveLease, SecretBroker } from '../../security/secret-broker/index.ts';
import { validateValue } from '../../security/validator/index.ts';
import type { EventLog, IdempotencyStore, KvStore } from '../../state/index.ts';
import { backoffDelayMs, shouldRetry } from '../orchestrator/decide.ts';
import type { StepAttempt, StepExecutor, StepResult } from '../orchestrator/ports.ts';
import type { CircuitBreakers } from './circuit-breaker.ts';

export interface RuntimeDeps {
  registry: CapabilityRegistry;
  events: EventLog;
  idempotency: IdempotencyStore;
  kv: KvStore;
  broker: SecretBroker;
  breakers: CircuitBreakers;
  clock?: Clock;
  log?: Logger;
  /** Extra time a lease/claim outlives the step timeout. */
  graceMs?: number;
}

interface InvokeParams {
  cap: RegisteredCapability;
  withTemplate: unknown;
  keyTemplate?: string | undefined;
  egress: string[];
  timeoutMs: number;
  outputSchema: object;
  extraScope?: Record<string, unknown>;
  /** Idempotency claim owner. */
  owner: string;
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

function secretNamesIn(value: unknown): string[] {
  const names = new Set<string>();
  for (const f of scanTemplates(value, '')) {
    for (const part of f.template?.parts ?? []) {
      if (part.kind !== 'expr') continue;
      for (const r of collectReferences(part.ast)) {
        if (r.root === 'secrets' && r.path[0]) names.add(r.path[0]);
      }
    }
  }
  return [...names].sort();
}

/**
 * Step Runtime (architecture §5.1 #11): executes exactly one step attempt inside an envelope of
 * timeout, cancellation, secret lease, idempotency claim, schema validation and redaction. It is
 * stateless between steps and reaches the outside world only through Capability Adapters.
 *
 * Attempt lifecycle (§9.3): Prepared → Authorised → Executing → Validated → Recorded. The secret
 * lease is revoked in every path — a credential outliving its step is how a bounded system becomes
 * an unbounded one.
 */
export class StepRuntime implements StepExecutor {
  private readonly d: RuntimeDeps;
  private readonly clock: Clock;
  private readonly log: Logger;

  constructor(deps: RuntimeDeps) {
    this.d = deps;
    this.clock = deps.clock ?? systemClock;
    this.log = deps.log ?? nullLogger;
  }

  private resolveCapability(ref: { name: string; version: string; hash: string }): RegisteredCapability | StepResult {
    const cap = this.d.registry.get(ref.name, ref.version);
    if (!cap) {
      return this.failed('prepare', 0, { code: 'CAPABILITY_MISSING', message: `Capability ${ref.name}@${ref.version} is no longer registered`, class: 'systemic', retryable: false });
    }
    if (cap.hash !== ref.hash) {
      return this.failed('prepare', 0, {
        code: 'CAPABILITY_CHANGED',
        message: `Capability ${ref.name}@${ref.version} changed since this plan was compiled; republish the workflow`,
        class: 'catastrophic',
        retryable: false,
      });
    }
    return cap;
  }

  private failed(phase: string, durationMs: number, error: ErrorInfo): StepResult {
    return { kind: 'failed', error, durationMs, phase };
  }

  // ---------------------------------------------------------------- capability step
  async executeCapability(a: StepAttempt): Promise<StepResult> {
    const ref = a.step.capability;
    if (!ref) return this.failed('prepare', 0, { code: 'PLAN_INVALID', message: 'Step has no capability', class: 'catastrophic', retryable: false });
    const cap = this.resolveCapability(ref);
    if (!('adapter' in cap)) return cap;
    return this.invoke(a, {
      cap,
      withTemplate: a.step.with ?? {},
      keyTemplate: a.step.idempotencyKey,
      egress: a.step.egress ?? [],
      timeoutMs: a.step.timeoutMs,
      outputSchema: (a.step.produces ?? cap.declaration.outputSchema) as object,
      owner: `${a.runId}/${a.step.id}`,
    });
  }

  // --------------------------------------------------------------------- map step
  async executeMap(a: StepAttempt): Promise<StepResult> {
    const started = this.clock.now().getTime();
    const step = a.step;
    const ref = step.capability;
    if (!ref || !step.items) return this.failed('prepare', 0, { code: 'PLAN_INVALID', message: 'Map step is incomplete', class: 'catastrophic', retryable: false });
    const cap = this.resolveCapability(ref);
    if (!('adapter' in cap)) return cap;

    let items: unknown;
    try {
      items = evaluate(parseExpressionField(step.items), a.scope, { seed: a.seed });
    } catch (e) {
      return this.failed('prepare', 0, { code: 'MAP_ITEMS_INVALID', message: `Could not evaluate 'items': ${(e as Error).message}`, class: 'contract', retryable: false });
    }
    if (!Array.isArray(items)) {
      return this.failed('prepare', 0, { code: 'MAP_ITEMS_INVALID', message: "'items' did not evaluate to an array", class: 'contract', retryable: false });
    }
    const n = items.length;
    if (n > (step.maxItems ?? 0)) {
      return this.failed('prepare', 0, { code: 'MAP_TOO_LARGE', message: `Collection has ${n} items; maxItems is ${step.maxItems}`, class: 'contract', retryable: false });
    }

    const tol = step.errorTolerance;
    const allowed = Math.max(tol?.count ?? 0, Math.floor(((tol?.percent ?? 0) / 100) * n));
    const results: unknown[] = new Array(n).fill(null);
    const failures: Array<{ index: number; error: ErrorInfo }> = [];
    let cost = 0;
    let next = 0;
    const stop = new AbortController();
    const signal = AbortSignal.any([a.signal, stop.signal]);
    const retry = step.retry;
    const rng = createRng(a.seed).fork(`${step.id}/map`);

    const runItem = async (index: number): Promise<void> => {
      let attempt = 0;
      for (;;) {
        attempt++;
        const res = await this.invoke(
          { ...a, signal, attempt },
          {
            cap,
            withTemplate: step.with ?? {},
            keyTemplate: step.idempotencyKey,
            egress: step.egress ?? [],
            timeoutMs: step.timeoutMs,
            outputSchema: (step.produces ?? cap.declaration.outputSchema) as object,
            extraScope: { item: items[index], index },
            owner: `${a.runId}/${step.id}#${index}`,
          },
        );
        if (res.kind === 'succeeded') {
          results[index] = res.output;
          cost += res.cost;
          if (n <= 50) this.emit(a, 'step.item.succeeded', { index });
          return;
        }
        if (res.kind === 'deferred') {
          attempt--;
          await sleep(res.retryAfterMs, signal);
          if (signal.aborted) return;
          continue;
        }
        const verdict = shouldRetry(retry, attempt, res.error);
        if (verdict.retry && !signal.aborted) {
          await sleep(backoffDelayMs(retry!, attempt, rng.next()), signal);
          if (signal.aborted) return;
          continue;
        }
        failures.push({ index, error: res.error });
        this.emit(a, 'step.item.failed', { index, error: res.error });
        if (failures.length > allowed) stop.abort();
        return;
      }
    };

    const workers = Array.from({ length: Math.min(step.concurrency ?? 4, Math.max(n, 1)) }, async () => {
      while (!signal.aborted) {
        const idx = next++;
        if (idx >= n) return;
        await runItem(idx);
      }
    });
    await Promise.all(workers);

    const durationMs = this.clock.now().getTime() - started;
    if (a.signal.aborted) {
      return this.failed('execute', durationMs, { code: 'CANCELLED', message: 'Map step was cancelled', class: 'systemic', retryable: false });
    }
    if (failures.length > allowed) {
      const first = failures.sort((x, y) => x.index - y.index)[0]!;
      return this.failed('execute', durationMs, {
        code: 'MAP_TOLERANCE_EXCEEDED',
        message: `${failures.length} of ${n} items failed (tolerated: ${allowed}); first failure at index ${first.index}: ${first.error.message}`,
        class: first.error.class,
        retryable: false,
        details: { failures: failures.slice(0, 10) },
      });
    }
    return {
      kind: 'succeeded',
      output: { results, failures: failures.sort((x, y) => x.index - y.index), count: n },
      cost,
      durationMs,
    };
  }

  // ------------------------------------------------------------------ compensation
  async executeCompensation(a: StepAttempt): Promise<StepResult> {
    const comp = a.step.compensate;
    if (!comp) return this.failed('prepare', 0, { code: 'PLAN_INVALID', message: 'Step has no compensation', class: 'catastrophic', retryable: false });
    const cap = this.resolveCapability(comp.capability);
    if (!('adapter' in cap)) return cap;
    const retry = a.step.retry ?? { attempts: 3, backoff: 'exponential' as const, initialDelayMs: 500, maxDelayMs: 10_000, jitter: 0.2, retryOn: ['transient' as const, 'systemic' as const] };
    const rng = createRng(a.seed).fork(`${a.step.id}/comp`);
    let attempt = 0;
    for (;;) {
      attempt++;
      const res = await this.invoke(
        { ...a, attempt },
        {
          cap,
          withTemplate: comp.with,
          keyTemplate: comp.idempotencyKey,
          egress: comp.egress,
          timeoutMs: comp.timeoutMs,
          outputSchema: cap.declaration.outputSchema as object,
          owner: `${a.runId}/${a.step.id}!comp`,
        },
      );
      if (res.kind === 'succeeded') return res;
      if (res.kind === 'deferred') {
        attempt--;
        await sleep(res.retryAfterMs, a.signal);
        if (a.signal.aborted) return this.failed('execute', 0, { code: 'CANCELLED', message: 'Compensation cancelled', class: 'systemic', retryable: false });
        continue;
      }
      if (shouldRetry(retry, attempt, res.error).retry) {
        await sleep(backoffDelayMs(retry, attempt, rng.next()), a.signal);
        continue;
      }
      return res;
    }
  }

  // --------------------------------------------------------------------- one call
  private emit(a: StepAttempt, type: 'step.item.succeeded' | 'step.item.failed' | 'step.dry-run' | 'step.idempotent-replay' | 'secret.lease.issued' | 'secret.lease.revoked', data: Record<string, unknown>): void {
    this.d.events.append({ tenant: a.tenant, type, runId: a.runId, stepId: a.step.id, attempt: a.attempt, data });
  }

  private async invoke(a: StepAttempt, p: InvokeParams): Promise<StepResult> {
    const started = this.clock.now().getTime();
    const decl = p.cap.declaration;
    const elapsed = () => this.clock.now().getTime() - started;
    const grace = this.d.graceMs ?? 30_000;
    let lease: ActiveLease | undefined;
    let claimed = false;
    let key: string | undefined;
    let secretValues: string[] = [];

    try {
      // ---- Authorised: kill switch and circuit breaker
      const killed = this.d.kv.isCapabilityKilled(a.tenant, decl.name);
      if (killed.killed) {
        return this.failed('authorise', elapsed(), {
          code: 'CAPABILITY_KILLED',
          message: `Capability '${decl.name}' is disabled by an operator${killed.reason ? `: ${killed.reason}` : ''}`,
          class: 'systemic',
          retryable: false,
        });
      }
      const gate = this.d.breakers.check(decl.name);
      if (!gate.allowed) return { kind: 'deferred', reason: `circuit open for '${decl.name}'`, retryAfterMs: gate.retryAfterMs };

      // ---- Prepared: lease secrets, resolve and validate the input
      const names = secretNamesIn(p.withTemplate);
      try {
        lease = names.length > 0
          ? this.d.broker.lease({ tenant: a.tenant, runId: a.runId, stepId: a.step.id, names, ttlMs: p.timeoutMs + grace })
          : this.d.broker.emptyLease();
      } catch (e) {
        this.d.breakers.release(decl.name);
        return this.failed('authorise', elapsed(), { ...toInfo(e), class: 'contract', retryable: false });
      }
      secretValues = lease.values();
      if (names.length > 0) this.emit(a, 'secret.lease.issued', { leaseId: lease.id, names });

      const baseScope = { ...a.scope, ...(p.extraScope ?? {}) };
      let input: unknown;
      try {
        input = resolveValue(p.withTemplate, { ...baseScope, secrets: lease.scope() }, { seed: a.seed });
        if (p.keyTemplate !== undefined) key = String(resolveValue(p.keyTemplate, baseScope, { seed: a.seed }));
      } catch (e) {
        this.d.breakers.release(decl.name);
        return this.failed('prepare', elapsed(), { code: 'INPUT_RESOLUTION_FAILED', message: scrubString((e as Error).message, { secretValues }), class: 'contract', retryable: false });
      }
      const valid = validateValue(decl.inputSchema, input);
      if (!valid.ok) {
        this.d.breakers.release(decl.name);
        const msg = valid.issues.slice(0, 5).map((i) => `${i.path || 'input'}: ${i.message}`).join('; ');
        return this.failed('prepare', elapsed(), { code: 'INPUT_INVALID', message: scrubString(`Input for '${decl.name}' is invalid — ${msg}`, { secretValues }), class: 'contract', retryable: false });
      }

      const signal = AbortSignal.any([a.signal, AbortSignal.timeout(p.timeoutMs)]);
      const ctx: CapabilityContext = {
        tenant: a.tenant,
        runId: a.runId,
        stepId: a.step.id,
        attempt: a.attempt,
        dryRun: a.dryRun,
        ...(key !== undefined ? { idempotencyKey: key } : {}),
        egress: p.egress,
        signal,
        lease,
        seed: a.seed,
        now: a.now,
        log: (msg, fields) => this.log.info(msg, { runId: a.runId, stepId: a.step.id, ...fields }),
      };

      // ---- Dry run: effectful capabilities are never executed (structural guarantee, ADR-0002 D3)
      if (a.dryRun && decl.dryRun === 'simulate') {
        const out = p.cap.adapter.simulate ? await p.cap.adapter.simulate(ctx, valid.value) : exampleFromSchema(decl.outputSchema);
        this.emit(a, 'step.dry-run', { capability: decl.name, simulated: true });
        this.d.breakers.release(decl.name);
        return { kind: 'succeeded', output: out, cost: 0, durationMs: elapsed(), simulated: true };
      }

      // ---- Idempotency: effective exactly-once for effectful capabilities
      if (key !== undefined && decl.effect !== 'pure') {
        const claim = this.d.idempotency.claim(a.tenant, decl.name, key, p.owner, p.timeoutMs + grace);
        if (claim.state === 'replay') {
          this.emit(a, 'step.idempotent-replay', { idempotencyKey: key, capability: decl.name });
          this.d.breakers.release(decl.name);
          return { kind: 'succeeded', output: claim.output, cost: 0, durationMs: elapsed(), replayed: true };
        }
        if (claim.state === 'busy') {
          this.d.breakers.release(decl.name);
          return { kind: 'deferred', reason: `idempotency key '${key}' is being processed by ${claim.owner}`, retryAfterMs: 1000 };
        }
        claimed = true;
      }

      // ---- Executing
      const run = p.cap.adapter.execute(ctx, valid.value);
      run.catch(() => {}); // never leave an unhandled rejection if the timeout wins the race
      const output = await Promise.race([
        run,
        new Promise<never>((_, reject) => {
          if (signal.aborted) reject(signal.reason);
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
      ]);

      // ---- The effect happened: record it before validating the response shape.
      if (claimed && key !== undefined) {
        this.d.idempotency.complete(a.tenant, decl.name, key, p.owner, output);
        claimed = false;
      }

      // ---- Validated
      const checked = validateValue(p.outputSchema, output);
      if (!checked.ok) {
        this.d.breakers.release(decl.name);
        const msg = checked.issues.slice(0, 5).map((i) => `${i.path || 'output'}: ${i.message}`).join('; ');
        return this.failed('validate', elapsed(), { code: 'OUTPUT_INVALID', message: scrubString(`'${decl.name}' returned an unexpected shape — ${msg}`, { secretValues }), class: 'contract', retryable: true });
      }
      this.d.breakers.success(decl.name);
      return { kind: 'succeeded', output: redactSecrets(checked.value, secretValues), cost: decl.costModel.unitsPerInvocation, durationMs: elapsed() };
    } catch (e) {
      if (claimed && key !== undefined) this.d.idempotency.release(a.tenant, decl.name, key, p.owner);
      const err = this.classify(e, decl, secretValues, a.signal, p.timeoutMs);
      if (a.signal.aborted) this.d.breakers.release(decl.name);
      else if (err.class === 'transient' || err.class === 'systemic') this.d.breakers.failure(decl.name);
      else this.d.breakers.release(decl.name);
      return this.failed('execute', elapsed(), err);
    } finally {
      if (lease) {
        const id = lease.id;
        const granted = lease.names.length;
        lease.revoke();
        if (granted > 0) this.emit(a, 'secret.lease.revoked', { leaseId: id });
      }
    }
  }

  /** Map anything an adapter throws onto the failure taxonomy, honouring the capability's declared failure modes. */
  private classify(e: unknown, decl: RegisteredCapability['declaration'], secretValues: string[], parent: AbortSignal, timeoutMs: number): ErrorInfo {
    let info: ErrorInfo;
    const reason = (e as { name?: string } | undefined)?.name;
    if (parent.aborted) {
      info = { code: 'CANCELLED', message: 'The step was cancelled', class: 'systemic', retryable: false };
    } else if (reason === 'TimeoutError' || (e instanceof Error && e.name === 'TimeoutError')) {
      info = { code: 'STEP_TIMEOUT', message: `Step exceeded its ${timeoutMs}ms timeout`, class: 'transient', retryable: true };
    } else if (e instanceof OmniflowError) {
      info = e.toInfo();
    } else {
      const code = (e as { code?: unknown } | undefined)?.code;
      info = {
        code: typeof code === 'string' ? code : 'ADAPTER_ERROR',
        message: e instanceof Error ? e.message : String(e),
        class: 'systemic',
        retryable: true,
      };
    }
    const declared = decl.failureModes.find((f) => f.code === info.code);
    if (declared) info = { ...info, class: declared.class, retryable: declared.retryable };
    return {
      ...info,
      message: scrubString(info.message, { secretValues }),
      ...(info.details ? { details: redact(info.details, { secretValues }) as Record<string, unknown> } : {}),
    };
  }
}

function toInfo(e: unknown): ErrorInfo {
  if (e instanceof OmniflowError) return e.toInfo();
  return { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e), class: 'systemic', retryable: true };
}

/** Defence in depth: an adapter that echoes a credential back in its output must not spread it. */
function redactSecrets(value: unknown, secretValues: string[]): unknown {
  if (secretValues.length === 0) return value;
  const json = JSON.stringify(value);
  if (!secretValues.some((s) => s.length >= 4 && json.includes(s))) return value;
  return JSON.parse(secretValues.reduce((acc, s) => (s.length >= 4 ? acc.split(JSON.stringify(s).slice(1, -1)).join('[REDACTED]') : acc), json));
}
