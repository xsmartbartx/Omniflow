# Implementation status

How the build maps onto [the vision and design document](omniflow-architecture-and-vision.md) and
[ADR-0002](adr/ADR-0002-workflow-execution-model.md). Stack: TypeScript on Node 24+ (ESM, run directly in
development, compiled for production), SQLite (`node:sqlite`, WAL) for the state plane, Fastify for the
gateway, a dependency-free static console.

Quality gate for every change: `npm run verify` (typecheck, lint, layer check, tests), plus the coverage floor
(`npm run test:coverage`) and, for deployment changes, `deploy/smoke-test.sh`. All are run by CI.

## Component map (vision §5.1)

| # | Component | Status | Where |
|---|---|---|---|
| 1 | Gateway | ✅ | `gateway/` — REST, sessions + API keys, RBAC, CSRF, rate limits, SSE, OpenAPI, static console |
| 2 | Validator | ✅ | `security/validator/` — closed schema, source-mapped errors, DAG/data-flow/secret checks |
| 3 | Compiler | ✅ | `orchestration/compiler/` — pure, content-addressed plans |
| 4 | Policy Engine | ✅ | `security/policy/` — RBAC, tenancy, four-eyes, cumulative scopes, policy documents, autonomy tiers |
| 5 | Planner Agent | ✅ | `authoring/agents/planner.ts` — validate-and-repair loop, drafts only (needs an LLM key) |
| 6 | Explainer | ✅ | `authoring/agents/explainer.ts` — deterministic plan and run explanations |
| 7 | Registry | ✅ | `orchestration/registry/`, `state/registry-store.ts` — immutable versions, change control, canary, kill |
| 8 | Docs generator | ✅ | `authoring/docs/` — Markdown + Mermaid from compiled plans |
| 9 | Scheduler / Triggers | ✅ | `orchestration/scheduler/`, `orchestration/triggers/` |
| 10 | Orchestrator | ✅ | `orchestration/orchestrator/` — pure decisions, retries, compensation, crash recovery |
| 11 | Step Runtime | ✅ | `orchestration/runtime/` — attempt execution, output validation, circuit breakers |
| 12 | Capability Registry | ✅ | `capabilities/contract/` |
| 13 | Adapters | ✅ | `capabilities/adapters/` — util, http, files, database, shell, notify, llm |
| 14 | Secret Broker | ✅ | `security/secret-broker/` — AES-256-GCM, step-scoped leases, key rotation |
| 15 | State plane | ✅ | `state/` — hash-chained event log, run/step state, idempotency ledger, artifacts |
| 16 | Event log | ✅ | `state/event-log.ts` |
| 17 | Artifact store | ✅ | `state/artifact-store.ts` |
| 18 | Approval service | ✅ | `orchestration/orchestrator/approval-service.ts` |
| 19 | Observability | ✅ | `insight/observability/` — Prometheus metrics, dashboard overview; `insight/alerting/` |
| 20 | Analysis Agent | ✅ | `insight/analysis/` — eleven rule sets, proposals only |
| 21 | Pentest Agent | ✅ | `security/pentest/` — risk scoring, blocking findings, injection corpus |

Beyond the component list: the **CLI** (`cli/`), the **web console** (`console/`), the **governed change
service** with autonomy tiers (`authoring/service.ts`), the legacy importers, and the deployment kit
(`Dockerfile`, `docker-compose.yml`, `deploy/`).

## Verified properties

Each is asserted by tests, not just designed:

- **Determinism:** golden plan-hash test; identical inputs and seed produce identical decisions.
- **Exactly-once effects** across retries and crashes (chaos and crash-recovery suites), given a downstream that
  honours the forwarded idempotency key.
- **Secret containment:** after a run, every database table, event, plan and output is scanned for the secret
  value (log output is redacted at the sink).
- **Agent containment:** the layer checker forbids agent code from importing the execution plane; an injected
  model yields at most a flagged draft.
- **Tenant isolation, RBAC, four-eyes, CSRF, lockout, webhook replay protection** — end-to-end over HTTP.
- **Tamper evidence:** the audit chain detects edits and deletions; backups and restores verify it.
- **Console CSP:** no inline script/style, no string-built markup, no foreign origins — checked on the source.
- **Deployment:** the container image builds, runs non-root with a read-only root filesystem and no
  capabilities, and survives publish → run → backup → restore → restart (`deploy/smoke-test.sh`).
- **Docs cannot drift:** manifests shown in the docs compile; `.env.example`, the configuration reference,
  the generated capability catalogue and CLI reference, and the Kubernetes manifests are tested against the code.

## Known limits (stated plainly)

- **Single node.** One process, one SQLite database. High availability is fast restart plus tested restores.
  The state stores are the seam where a network database would go; that is not built.
- **Shell steps are sandboxed by your container**, not by OmniFlow (argv-only, allow-listed, scrubbed
  environment, throw-away working directory, process-group kill — but no in-process network or resource jail).
- **Exactly-once needs a cooperating downstream** for the effect itself; OmniFlow guarantees it does not repeat
  the call for the same key.
- **No automatic retention.** The audit log and run history grow until you archive them.
- **AI features need an external model provider** and send prompts (intent, imported scripts, analysis
  evidence) to it. They are optional; the rest of the product does not depend on them.
- **The console has no build step and no framework** by choice; it is deliberately plain. It is tested for
  its security properties and pure logic, and was exercised visually, but has no automated browser tests.
- **Postgres** is supported for `database-*` capabilities, not as the state plane.
