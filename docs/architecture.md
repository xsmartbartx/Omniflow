# Architecture

The full reasoning is in [the vision and design document](omniflow-architecture-and-vision.md) and the
[ADRs](adr/); this page is the map of what was built and where it lives.

## The shape

OmniFlow separates *deciding* from *doing* and *reasoning* from *acting*:

1. **Authoring** turns intent into a **manifest** (a human, an importer, or an AI Planner — all producing drafts).
2. The **Compiler** validates it and produces an immutable, content-addressed **plan**: resolved capability
   contracts, a deterministic topological order, analysed effects, scopes, egress and cost bounds. The plan
   hash is `sha256` of its canonical JSON; the same manifest always compiles to the same hash.
3. The **Registry** stores versions immutably and tracks which is active (stable, canary).
4. The **Scheduler / Triggers** create runs; the **Orchestrator** advances them with *pure decision
   functions* over the recorded state; the **Step Runtime** executes one attempt through a **capability
   adapter**.
5. Everything that happens is appended to the **hash-chained event log**; current state is a queryable
   projection. The **Insight** plane reads that history — it never writes to the execution plane.

Because decisions are pure functions of (plan, state, seed), runs are deterministic and replayable, and
crash recovery is just "load state, decide again".

## Modules

```
core/            errors (classified), canonical JSON + hashing, ids, seeded RNG, time, redaction, DAG,
                 the expression language (parser, evaluator, whitelisted functions, templates)
schemas/         manifest, plan, capability, event, policy types and JSON Schemas
security/        validator (source-mapped), secret broker, policy engine + autonomy, pentest, webhook auth
capabilities/    the adapter contract, registry, and the built-in adapters (http, storage, database,
                 shell, notify, llm, util)
state/           SQLite state plane: database, migrations, event log, run/step store, idempotency,
                 approvals, artifacts, registry, identity, secrets, triggers, authoring, analytics
orchestration/   compiler · orchestrator (+ approval service) · runtime (step runner, circuit breakers) ·
                 registry service · scheduler (+ run service) · trigger manager
insight/         observability (metrics, dashboard overview) · analysis agent · alerting
authoring/       planner · importer · explainer · docs generator · the governed change service
gateway/         REST API, auth, RBAC enforcement, CSRF, rate limits, SSE, OpenAPI, static console
server/          composition root (wires everything together) and the process entry point
cli/             the `omniflow` command
console/         the web UI (vanilla JS, no build step, strict CSP)
```

### Layering is enforced, not aspirational

`scripts/check-layers.ts` runs in `npm run verify` and CI and fails on any import that crosses a boundary the
wrong way:

```
core ← schemas ← security ← capabilities / state ← orchestration ← insight / authoring ← gateway ← server, cli
```

Plus two special rules that carry the safety argument: **agent code** (`authoring/agents`, `insight/analysis`,
`security/pentest`) may not import the registry, scheduler, orchestrator, runtime, triggers or adapters — an
agent has no code path to the execution plane — and **the orchestrator** may import no network module and
contains no `fetch(`, so orchestration can never leak into the outside world.

## Key design decisions

| Decision | Why |
|---|---|
| Workflows are declarative data | Provable before running, diffable, reviewable, safe for AI to draft. |
| Capabilities are the only door out | One place to declare effects, scopes, egress, failure modes; one place to guard. |
| Expressions cannot loop or assign | Any expression terminates and is deterministic; nothing to sandbox. |
| Effects are claimed before they happen | `idempotency ledger claim → act → complete` (or release): exactly-once across crashes. |
| Compensation is explicit, reverse-ordered, first-class | A failed rollback is its own terminal state, never hidden. |
| The event log is the source of truth | Audit, metrics, replay and the live stream all read one chain; UPDATE/DELETE are refused by triggers. |
| SQLite in WAL mode, single node | Trivial to run, back up and reason about; the price is no horizontal scaling. |
| Multi-tenancy from the first row | `tenant_id` everywhere; isolation is a property of every query, not a bolt-on. |
| AI proposes, the engine disposes | A manipulated model can waste a reviewer's time, not cause an incident. |

## A run, end to end

1. `POST /v1/workflows/{name}/run` → RBAC → **RunService**: resolve the active version (canary-aware), check
   kill/disable, validate inputs strictly, dedupe, apply concurrency and cost policy → a `queued` run.
2. **Scheduler** admits it within `MAX_CONCURRENT_RUNS` → the orchestrator `run.started`.
3. **Orchestrator** loop: `decide(plan, stepStates)` → ready steps → for each, evaluate `when`, resolve
   templates, claim the idempotency key, lease secrets → hand to the **Step Runtime**.
4. **Step Runtime**: circuit breaker → adapter `execute` with timeout and abort signal → validate the output
   against the declared schema → classify any failure. The orchestrator records the outcome as events and
   updates state atomically, then decides again.
5. Failure: retry per policy (seeded jitter), route, continue, or **compensate** completed steps in reverse.
   Waiting on approvals, timers, events or child runs costs nothing and survives restarts.
6. Terminal state → `run.succeeded` / `failed` / `rolled-back` / `compensation-failed` / `cancelled`; completion
   triggers fire; metrics and the live stream update from the same events.

## Testing strategy

Behaviour is proven where it matters most rather than only asserted: pure-function unit tests for the compiler
and decisions, a golden plan-hash test that pins determinism, chaos and crash-recovery tests for the
orchestrator (random failures, killed-and-restarted engines, exactly-once effects), containment tests for
secrets across every table, injection and SSRF corpora, end-to-end HTTP flows (publish → change request →
four-eyes approval → run → stream → audit verify), CLI tests against real servers, static checks on the console's
CSP properties, and a container smoke test that builds the image and exercises it. Coverage floors (80% overall,
90% for core, compiler, orchestrator, policy) are enforced in CI.
