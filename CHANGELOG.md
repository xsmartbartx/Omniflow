# Changelog

All notable changes to OmniFlow are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Upgrading? Read [Operations → Upgrades](docs/operations.md#upgrades).

## [Unreleased]

## [1.0.0] - 2026-09-19

First release.

### Engine
- Declarative workflow manifests (YAML) validated with source-mapped diagnostics and compiled to immutable,
  content-addressed plans. Triggers: manual, cron (with timezone and catch-up), signed webhooks, events,
  workflow completion.
- Step types: capability, branch, parallel, map (bounded fan-out), approval, wait (timer or event),
  subworkflow (version-pinned), terminate.
- A small, total expression language (no loops, no assignment, whitelisted functions) with static reference
  checking against capability output schemas.
- Deterministic orchestration: pure decision functions, seeded jitter and ids, crash recovery that resumes
  interrupted runs with the same attempt and idempotency key.
- Exactly-once effects through an idempotency ledger; retries with backoff and error classification;
  reverse-order compensation with a distinct `compensation-failed` outcome; dry runs.
- Circuit breakers, cost ceilings, concurrency and dedup policy, canary rollout with automatic rollback,
  kill switches at workflow and capability level.
- Append-only, hash-chained event log; immutable registry; multi-tenancy in every table.

### Capabilities
- HTTP (SSRF-safe, default-deny egress), files (confined), SQL (SQLite and Postgres, idempotent commands),
  shell (allow-listed argv, sandbox by container), webhook / chat channel / email notifications,
  LLM inference with schema-validated output, and pure helpers.
- A capability contract and registry, with a documented, tested path for adding your own.

### Security and governance
- RBAC (admin, author, operator, approver, viewer), four-eyes approval, tenant isolation, policy-as-code,
  cumulative-scope analysis, pentest-style risk review (blocking findings), autonomy tiers T0–T3.
- Secret broker (AES-256-GCM, step-scoped leases, master-key rotation), webhook HMAC with replay protection,
  scrypt passwords with lockout, hashed API keys, CSRF protection, strict CSP.

### AI features (optional)
- Planner: intent → validated draft manifest with a repair loop; legacy script importer.
- Crontab importer (deterministic "Lift" drafts); plain-language explainer for plans and runs;
  generated docs with Mermaid diagrams.
- Analysis Agent: eleven rules over run history, filing proposals only; proposal → draft revision loop.
- All agent output is drafts and proposals: no path to production except validation, review and policy.

### Interfaces
- REST API with OpenAPI 3.1, server-sent event run streams, Prometheus metrics, alerting to chat channels.
- Web console: dashboard, workflow graph, live runs, approvals inbox, change-request review with diffs,
  editor with live validation and AI assistant, insights, capabilities, triggers, secrets, audit, admin.
- CLI: `validate`, `compile`, `dev` (no server); workflows, runs, approvals, changes, secrets, audit,
  insights, drafts, import, explain, docs; `admin` break-glass operations (`create-api-key`, `doctor`,
  `backup`, `restore`, `rotate-master-key`, …).

### Deployment
- Multi-stage, non-root, read-only-root container image; Docker Compose with optional Caddy TLS;
  Kubernetes manifests (single replica, egress policy, backup CronJob); systemd unit; nginx config.
- CI (verify, coverage floor, container smoke test, image scan) and a release workflow with provenance/SBOM.
