# Architecture: OmniFlow as a NEXORA tenant product

Sources: `replica/recon.md`, `replica/features.csv`, and the NEXORA architecture doc
(`docs/NEXORA-PLATFORM-ARCHITECTURE.md`: §4.2-4.3 contracts and Tenant Contract, §5.2 registry, §6 identity, §9.1 repos,
§13.3 database namespaces, §15.1 integration steps). The doc leaves the contract payloads, key format and entitlement
model undefined (its ADR-0006 to 0010 are still Proposed), so this plan puts every Core call behind a port with a fake.

## Decisions

| # | decision | why | reversible? |
| --- | --- | --- | --- |
| D1 | OmniFlow stays its own repo and process; it integrates as a **tenant** (T-1..T-10), not as an app inside `nexora-platform` | NEXORA §9.1: every product has its own repo and consumes Core only through contracts | yes |
| D2 | **Keep SQLite as the state plane**; org = tenant row in the same file | built, tested (804), documented as single-node by design. NEXORA §13.3 describes a `product_<slug>` Postgres namespace; this is a deviation to confirm (risk R1) | yes, via ADR |
| D3 | Two modes: `OMNIFLOW_MODE=standalone` (today, default) and `nexora` | self-hosters and every existing test must be unaffected | yes |
| D4 | All Core access through three ports: `IdentityPort` (C-AUTH), `EntitlementPort` (C-ENT), `EventPort` (C-EVENT), each with a fake and an HTTP client | payloads undefined; fakes let build and test proceed now | n/a |
| D5 | New layer `nexora/` (imports core, schemas, security, state). Ports are declared in `orchestration` and implemented in `nexora`; `gateway` and `server` may import `nexora` | keeps the orchestrator free of network code (existing layer rule) | n/a |
| D6 | Roles: owner/admin -> admin + approver; member -> author + operator; viewer/billing -> viewer. No product-local role system | NEXORA §6 forbids parallel role systems. Consequence: four-eyes needs two admins (R4) | yes |
| D7 | Identity assertion is verified locally (public-key verification of the short-lived token), not by a call per request | NEXORA §6: products receive verifiable assertions; keeps the console fast | yes |
| D8 | Billable unit: **run admitted**. Entitlement check before admit; usage event after admit | matches Sentinel/CSPM/Gateway "scans/requests per month" | yes |
| D9 | Core unreachable: known org with a cached allow keeps working up to 15 min; unknown org is refused; running runs are never interrupted | an outage at Core must not corrupt in-flight exactly-once work | yes |

## Stack

| layer | choice | why |
| --- | --- | --- |
| runtime | TypeScript, Node 24, Fastify (existing) | already built; no rewrite |
| state | SQLite WAL (existing) + 5 `nexora_*` tables | D2 |
| console | existing vanilla-JS console + NEXORA shell strip (product switcher, account menu) | NEXORA `packages/shell` is a published package; if it needs React, mount it as a separate header island (R5) |
| auth | NEXORA Identity (Clerk behind `packages/auth`) via `IdentityPort` | Core-only auth is Tenant Contract T-2 |
| payments | none in OmniFlow; Stripe lives in NEXORA Billing, OmniFlow only reads entitlements | NEXORA Billing owns subscriptions |
| email | unchanged (OmniFlow notify capability); product emails go through NEXORA Notifications | NEXORA owns transactional email (Postmark) |
| jobs | in-process scheduler (existing) + new outbox worker | same process, no new infra |
| hosting | Docker image on the Oracle Cloud VPS behind Caddy/Cloudflare; subdomain proposed `omniflow.onenexora.com` | NEXORA topology; name may change in `/replica-brand` |

## Schema

Five new tables, in [schema.sql](schema.sql), proposed as migration 2: `nexora_orgs`, `nexora_identities`,
`nexora_entitlement_cache`, `nexora_key_cache`, `nexora_outbox`. Access rule: **data-layer checks**, tenant filtered in
every store method, with an isolation test per store. Hard constraints in the DB: one tenant per org (`UNIQUE`),
one OmniFlow user per (org, Clerk user) (PK), outbox redelivery safe (`UNIQUE idempotency_key`), plan/status/role
enums as `CHECK`.

Existing tables are unchanged. SSO users reuse `users` with `password_hash NULL` (already nullable).

NEXORA side (not in this repo, owner-approved changes only): a Product Registry record and `ProductPlan` rows. Draft:

```
id: prod_omniflow   slug: omniflow   name: OmniFlow   tagline: "Workflows you can trust to run, explain and undo" (<60 chars: shorten)
category: developer (or ai)   platform_pillar: cloud   lifecycle: alpha -> beta   visibility: internal until beta
url: https://onenexora.com/products/omniflow   app_url: https://omniflow.onenexora.com/app
docs_url: https://docs.onenexora.com/products/omniflow   pricing_url: https://onenexora.com/pricing
health_source: https://omniflow.onenexora.com/healthz   owner: bw141105@gmail.com
```

## API

New routes (everything else in `docs/api.md` is unchanged):

| method path | does | who | input | output | flow |
| --- | --- | --- | --- | --- | --- |
| GET `/app` | SSO entry: verify NEXORA assertion, provision org + user on first use, set OmniFlow session, redirect to console. The session is short-lived (<= 5 min) and every session-authenticated request re-reads the user's current org membership and role (from a fresh assertion or Core), so removal or demotion applies on the next request | NEXORA-signed user | assertion (cookie/header, format per C-AUTH) | 302 to `/#/dashboard` | F10, F12 |
| GET `/healthz` | already exists; add `product`, `version`, `mode` fields for T-6 and `health_source` | none | none | 200 JSON | F12 |
| POST `/v1/nexora/lifecycle` | Core tells the product an org or the product is suspended/disabled (T-10) | Core (signed) | `{orgId, status}` | 204 | F11 |
| GET `/v1/nexora/usage` | org-visible usage this period (runs used / limit) for the console banner | any signed-in role | none | `{used, limit, period}` | F12 |
| (middleware) | accept `Authorization: Bearer nx_live_...` on `/v1/*`, map to a principal with scopes | org key | header | principal | F11 |
| (hook) | before `RunService` admits a run: `EntitlementPort.check('run.start')`; after admit: outbox `omniflow.run.started` | n/a | n/a | 429 `ENTITLEMENT_EXCEEDED` with `Retry-After` / upgrade hint | F12 |

Outbound (to Core, via `EventPort`, from the outbox worker): `omniflow.run.started`, `omniflow.run.completed`
(carries outcome and step count), `omniflow.workflow.published`, `omniflow.approval.decided`, audit records
(actor id, org id, action, resource id, outcome, timestamp, correlation id), and a health heartbeat.
Inbound webhooks: lifecycle only (above). No Stripe webhook here; Billing owns it.
Jobs: outbox delivery (every 5 s, exponential backoff, cap 1 h), heartbeat (60 s), entitlement-cache purge (hourly),
nightly reconcile of local run counts against Core usage (flags drift, never auto-corrects).

Add `X-RateLimit-Limit/Remaining/Reset` to `/v1/*` responses (feature row "Rate-limit headers"); the limiter exists.

## The parts that bite

- **Identity mapping:** Clerk user ids are not OmniFlow user ids; email can change. Key on `(org_id, external_user_id)`, never email. Role changes and member removal in NEXORA must apply on the next request: an OmniFlow session never carries its own role, it is only a handle that triggers re-verification of current membership and role (`nexora_identities` is refreshed, not trusted).
- **Revocation:** NEXORA promises immediate, global revocation. A cache cannot deliver that, so the choice is explicit: **default = verify with Core on every request** (no positive caching). If latency forces caching, the accepted exposure window is `valid_until` <= 30 s, it must be approved by the owner, and F11's "revoked key gets 401 immediately" in `recon.md` is then restated as "within 30 s". Until approved, `nexora_key_cache` is not used for positive hits.
- **Idempotency:** every outbox row gets one stable event id, assigned when the row is written (the id of the source OmniFlow event: run, publication or approval) and reused on every retry; `idempotency_key` = that id, so run, publish and approval events all have a key independent of a run. Core must dedupe on it. If C-EVENT cannot dedupe, usage double-counts after a crash between send and mark-sent. Mitigation: reconcile job + local ledger as source of truth.
- **Races:** two runs admitted at the last remaining unit. Check-then-act on a cache can overshoot by the concurrency level. Accept overshoot of at most `MAX_CONCURRENT_RUNS` for Free (document it) or reserve units in the cache row atomically.
- **Tenancy:** isolation already enforced by `tenant_id`; the new risk is a bug in the org -> tenant lookup. One isolation test per new store.
- **Time:** all stored UTC ISO strings; billing periods are Core's calendar month in UTC; do not compute periods locally.
- **Failure modes:** D9. Fail closed for unknown orgs, open for cached allows.
- **Audit:** two logs now exist (OmniFlow hash chain, NEXORA `telemetry` audit). OmniFlow's remains the tamper-evident source; the NEXORA copy is a feed. Retention: NEXORA keeps audit >= 12 months; OmniFlow has no automatic retention (known limit).
- **GDPR deletion:** deleting a user must not break the hash chain. Store pseudonymous ids (Clerk id) in events, not emails; deletion removes the identity row only.
- **No search, no realtime beyond existing SSE, no offline.**

## Risks (ranked)

- **R1 Data location:** NEXORA §13.3 implies product data in a Postgres namespace. D2 keeps SQLite. If the owner wants to follow the doc, the project becomes L (state plane port) and the 804 tests need a second backend.
- **R2 Undefined contracts:** C-AUTH/C-ENT/C-EVENT payloads and key format do not exist yet. Real HTTP clients cannot be finished until ADR-0010 settles; fakes cover build and test.
- **R3 Shared packages assume Next.js:** `@nexora/auth` and `shell` may not run in Fastify. Need a framework-agnostic `verifyAssertion()`; otherwise write a thin verifier from Clerk's documented public-key verification.
- **R4 Approver role:** NEXORA has no "approver"; D6 gives it to owner/admin. Orgs with one admin cannot use four-eyes.
- **R5 Console tech split:** vanilla console vs NEXORA UI tokens/shell.

## Build order

1. **Vertical slice (M0):** `OMNIFLOW_MODE`, ports + fakes, migration 2, `/app` SSO with a fake IdentityPort, org + user provisioning, entitlement check in `RunService`, outbox row on admit, a delivery worker against a fake Core, usage banner. Screens S02, S03, S07. Tables: all 5. Routes: `/app`, `/v1/nexora/usage`, hook in run admit. Done = in nexora mode with fakes, sign in as a fake org, run a workflow, see usage 1/limit, exceed the limit and get 429; standalone mode untouched (`npm run verify` green).
2. **Must-haves (M1):** real assertion verification, role mapping, `nx_live_` key auth, lifecycle webhook, health shape, licence fix, registry record + product page draft + plans (draft files only), Stripe test-mode price config as documentation (no live calls), layer-check update for `nexora/`.
3. **Should-haves (M2):** shell strip and UI tokens, docs section, bundle entry draft, status component draft, rate-limit headers, console browser tests.
4. **Fixes from `/replica-entrepreneur` (M3).**

Anything that publishes (registry record, website page, Stripe, DNS, status) stays a draft file until the owner approves; it is not done by this pipeline before `/replica-launch`.
