# Security

OmniFlow sits between people, AI, and systems that matter. Its security model is built on one idea: **no
component that can be wrong or manipulated is allowed to act on its own authority.** Models propose;
validators, policy and people dispose. This page states the model, maps each control to where it lives and
how it is tested, and is explicit about what is *not* covered.

Report a vulnerability: see [SECURITY.md](../SECURITY.md).

## Trust boundaries

```
 people ─┐                 ┌───────────── zero-trust core ──────────────┐
 API keys ┼─► Gateway ────►│ Policy Engine → Registry → Scheduler        │
 webhooks ┘  (authn, RBAC, │      ▲              │                       │
             CSRF, limits) │      │     Orchestrator ⇄ Step Runtime      │
 AI agents ──drafts only──►│ Authoring/Insight (read-only proposals)     │
                           └──────────────────────┬─────────────────────┘
                                                  ▼
                              Capability adapters ──► the outside world
                              (declared contract, egress guard, secret lease)
```

Nothing in the core trusts what it is handed: manifests, model output, webhook bodies, capability results
and run inputs are all untrusted data until validated.

## Threats and controls

| Threat | Control | Where | Verified by |
|---|---|---|---|
| A prompt-injected or buggy model publishes or runs something | Agents can only create **drafts and proposals**. Publication needs validation, a risk review, policy, and (for anything that matters) a human. The layer checker forbids agent code from importing the registry, scheduler, orchestrator, runtime or adapters. Autonomy tiers T0–T3 bound what may be applied. | `authoring/`, `insight/analysis`, `scripts/check-layers.ts`, `security/policy/autonomy.ts` | `check:layers`; `tests/gateway/authoring.test.ts` (injection yields at most a flagged draft); `tests/security/policy.test.ts` |
| Untrusted text steers a model | Third-party content is framed as data (`<untrusted_data>`), kept out of the system prompt, and scanned for injection patterns; LLM output in a workflow is schema-validated; the risk review flags external content reaching an effectful step. | `security/pentest/injection.ts`, `authoring/agents/planner.ts`, `llm-inference` | `tests/security/pentest.test.ts`, `tests/authoring/planner.test.ts` |
| A workflow exfiltrates data or reaches internal services (SSRF) | Default-deny egress per step; every resolved address is checked (private, loopback, link-local, metadata) *after* DNS, so rebinding fails; no redirects; size and time caps. Cumulative-scope analysis flags combinations such as *read data + send over HTTP*. | `capabilities/adapters/http/`, `security/policy/engine.ts` | `tests/capabilities/http.test.ts`, `tests/security/policy.test.ts` |
| Command injection through the shell capability | Argument vectors only (never a shell string); executable must be on an absolute-path allow-list; scrubbed environment; scratch working dir; process-group kill; `sh -c` and destructive patterns are **blocking** risk findings; every shell step needs a `sunset` date. | `capabilities/adapters/shell/`, `security/pentest/analyzer.ts` | `tests/capabilities/adapters.test.ts` |
| Path traversal / symlink escape in file capabilities | Paths are resolved and confined to `OMNIFLOW_STORAGE_DIR`, including through symlinks. | `capabilities/adapters/storage/` | `tests/capabilities/adapters.test.ts` |
| Secrets leak | Stored AES-256-GCM, bound to tenant+name; leased to one step and revoked after; never in manifests (a credential-shaped literal is a **blocking** finding), events, logs, artifacts or API responses (redaction at every sink). A test scans every database table, event, plan and output for the secret's value after a run. | `security/secret-broker/`, `core/sanitize.ts` | `tests/orchestration/engine-governance.test.ts` (secret containment) |
| A step runs twice (double charge) | Idempotency ledger claims a key before acting and passes it downstream; crash recovery re-dispatches with the same attempt and key. | `state/idempotency-store.ts`, `orchestration/orchestrator` | `tests/orchestration/engine-resilience.test.ts` (chaos and crash recovery) |
| History is rewritten | Append-only event log (database triggers refuse UPDATE/DELETE) with a hash chain; `verify` detects edits, deletions and re-ordering; checked every 6 h and on restore. | `state/event-log.ts`, `insight/alerting` | `tests/state/event-log.test.ts`, `tests/cli/ops.test.ts` |
| A published workflow is swapped | Versions are immutable (triggers enforce it) and bound to a content-addressed plan hash. | `state/registry-store.ts`, `orchestration/compiler` | golden plan-hash test, registry tests |
| Someone approves their own change | Four-eyes: a requester cannot approve their own run or change request; agents cannot approve at all. | `security/policy/engine.ts` | `tests/security/policy.test.ts`, `tests/gateway/api.test.ts` |
| Cross-tenant access | `tenant_id` on every row and every query; a foreign object looks identical to a missing one; isolation is tested across the API surface. | `state/*`, `gateway/routes` | `tests/gateway/api.test.ts` (isolation) |
| Session theft / CSRF | `HttpOnly`, `SameSite=Strict`, `Secure` (https) cookies; a required custom header on cookie-authenticated writes; strict CSP with no inline script or style; sessions revoked on password change. | `gateway/http.ts`, `gateway/server.ts`, `console/` | `tests/gateway/api.test.ts`, `tests/gateway/console.test.ts`, `tests/console/static.test.ts` |
| Credential stuffing | scrypt password hashing; a dummy hash comparison for unknown users so timing does not reveal which emails exist; lockout after 5 failures / 15 min; per-IP login rate limit; API keys stored hashed. | `gateway/auth.ts`, `gateway/rate-limit.ts` | `tests/gateway/api.test.ts` |
| Forged or replayed webhooks | HMAC over the exact body bytes with a timestamp window and a nonce store; uniform failure response. | `security/webhook.ts`, `orchestration/triggers` | `tests/orchestration/triggers.test.ts` |
| Runaway cost / fan-out | Per-step, per-run and per-day cost ceilings; bounded `map` sizes checked at compile time; concurrency policy; circuit breakers on failing dependencies. | `orchestration/compiler`, `orchestration/runtime` | compiler and engine tests |
| Malicious manifest (YAML bombs, huge input) | Size limits, alias expansion disabled, strict schema, expression language with no loops and a step budget. | `security/validator/`, `core/expression/` | `tests/security/validator.test.ts`, `tests/core/` |
| Supply chain | Small dependency set (all permissive licenses — see `THIRD_PARTY_NOTICES.md`, kept current by CI); `npm audit` and image scanning in CI; provenance and SBOM on release images; non-root, read-only-root, capability-free container. | `.github/workflows`, `Dockerfile` | CI, `deploy/smoke-test.sh` |

## Roles

`admin` (everything) · `author` (write, publish, run, use AI authoring) · `operator` (run, cancel, retry,
roll out, kill switches, trigger secrets, publish events, read the audit log) · `approver` (decide approvals
and change requests) · `viewer` (read). API keys carry roles; a key cannot be given roles its creator lacks.
Human principals and agents are distinct: an agent identity can only read and draft.

Operator policy documents (`kind: Policy`) add rules on top of these — deny or require approval when an
expression over the plan, principal, environment or risk is true. They can tighten the built-in rules but never
weaken them, and a rule that fails to evaluate fails **closed**.

## What you are responsible for

OmniFlow reduces risk; it does not remove your part in it.

- **Isolation of shell steps.** OmniFlow constrains the command, environment and lifetime of a shell step, but
  it does not sandbox the process. Enable `OMNIFLOW_SHELL_ALLOWED_COMMANDS` only where you accept that
  boundary, and run the container with network access limited to what those scripts need.
- **Exactly-once needs a cooperating downstream.** OmniFlow will not repeat a call for the same idempotency
  key; a system that ignores the key it is sent may still process two different calls twice.
- **TLS and network exposure.** Put HTTPS in front, do not publish the raw port, and restrict who can reach the
  console. Set `OMNIFLOW_TRUST_PROXY` only behind a proxy you control.
- **The master key.** Whoever holds it and a backup can read your secrets. Keep it out of the data volume in
  production and rotate it on your own schedule.
- **Model providers.** With AI features on, prompts (your intent, imported scripts, and evidence from run
  history) are sent to the configured provider. Do not enable them where that is not acceptable; everything
  else works without them.
- **Who holds `admin`.** An administrator can publish, approve, read audit logs and manage keys. Use named
  accounts, keep the group small, and review the audit log.
- **Retention.** Run history and the audit log are kept until you archive them.

## Hardening checklist

- [ ] `OMNIFLOW_ENV=production`; `omniflow admin doctor` passes with no warnings you have not accepted
- [ ] HTTPS in front; `OMNIFLOW_PUBLIC_URL=https://…`; `OMNIFLOW_TRUST_PROXY=true`; raw port not exposed
- [ ] `OMNIFLOW_MASTER_KEY` from a secret manager, copy stored elsewhere; backups tested
- [ ] Bootstrap admin's password changed; named accounts; API keys scoped to minimal roles with expiry
- [ ] `OMNIFLOW_PUBLISH_APPROVALS` ≥ 1 and a policy file for your organisation's rules
- [ ] Shell steps disabled, or confined to a network-restricted container and a short allow-list
- [ ] Alert channel configured; someone watches it
- [ ] Container run as shipped (non-root, read-only root, no capabilities); Kubernetes `NetworkPolicy` applied
