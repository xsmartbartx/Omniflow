# Implementation status

Working notes for the build of OmniFlow against `omniflow-architecture-and-vision.md` and
`adr/ADR-0002-workflow-execution-model.md`. Stack: TypeScript on Node 24+, SQLite (`node:sqlite`) for the
state plane, Fastify for the gateway, a dependency-free static console.

Quality gate for every task: `npm run verify` (typecheck, lint, layer check, tests).

## Built (each item committed with tests)

| # | Area | Where | Notes |
|---|---|---|---|
| 0 | Foundation | `scripts/check-layers.ts`, `docs/adr/ADR-0001` | Layer rules of §4.1 and ADR-0002 D4/D6 enforced mechanically |
| 1 | Core | `core/` | Error taxonomy, canonical hashing, seeded RNG, redaction, logger, sandboxed non-Turing-complete expression language |
| 2 | Schemas + Validator | `schemas/`, `security/validator/` | Closed JSON Schema, positional YAML errors, DAG / data-flow / secrets checks |
| 3 | Capability contract | `capabilities/contract/` | Registry, declaration validation, dry-run flag, effect classes |
| 3 | Adapters | `capabilities/adapters/` | util, http (SSRF-hardened), shell, database (sqlite + postgres), files, notify (webhook/channel/email), llm |
| 4 | Compiler | `orchestration/compiler/` | Pure; plan hash; idempotency, egress, classification, fan-out, sunset, cost checks |
| 5 | State plane | `state/` | Hash-chained append-only event log, run/step state, idempotency ledger, artifacts (tombstoning), immutable registry |
| 6 | Security | `security/` | Secret Broker (AES-GCM, leases), Policy Engine (RBAC, tenancy, scope analysis, autonomy tiers, policy docs), pentest heuristics |
| 7 | Orchestrator + Runtime | `orchestration/orchestrator/`, `orchestration/runtime/` | Durable state machine, retry/back-off, compensation, crash recovery, circuit breakers |
| 8 | Control plane | `orchestration/registry/`, `scheduler/`, `triggers/` | Publish + change control, canary, run admission, scheduler, cron/webhook/event/completion triggers, approvals |

## Remaining

9. Gateway (Fastify REST API, auth, rate limits, SSE, OpenAPI, metrics) + server composition root
10. CLI
11. Insight (observability, analysis agent, proposals, alerting)
12. AI authoring (planner via Claude, legacy importer, explain, docs generator, change service)
13. Console (static SPA)
14. Deployment (Dockerfile, compose, k8s example, backup/restore) — verify by building and running
15. CI, docs suite, example workflows, release notes, licences; final end-to-end verification

## Known limits (documented honestly)

* Single-node: SQLite state plane. The stores are the seam for a Postgres backend.
* Shell isolation relies on the container boundary (no in-process network/resource jail).
* Effective exactly-once requires the external system to honour the idempotency key (forwarded by adapters).
