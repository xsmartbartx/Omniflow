# Recon map: OmniFlow → NEXORA product #6 (web + API)

Scope: make OmniFlow (this repo, the workflow engine) a first-class NEXORA product that plugs into NEXORA Core
(identity, orgs, registry, entitlements, billing, API keys, telemetry) the way Sentinel, CSPM and Gateway do.
"Original" = the NEXORA platform pattern (onenexora.com + `xsmartbartx/NEXORA`) plus OmniFlow's own current surface.
For: the owner's own business (both codebases are the owner's). Not a third-party clone.
Date: 2026-10-10

## Sources

| # | source | URL / path | notes |
| --- | --- | --- | --- |
| 1 | NEXORA home | https://onenexora.com | "Build. Secure. Operate." 5 Beta products, 3 pillars, trust links |
| 2 | NEXORA platform | https://onenexora.com/platform | Core = Identity, Organisations, Product Registry, Entitlements, Billing, API Keys, Telemetry |
| 3 | NEXORA products | https://onenexora.com/products | Sentinel, CSPM, Gateway, Vigilo, NeuraWall; all Beta |
| 4 | Product page template | https://onenexora.com/products/gateway | breadcrumb, hero+badge, overview, capabilities, plans, docs links, "Open <Product>" CTA |
| 5 | NEXORA pricing | https://onenexora.com/pricing | 5-tier ladder (Free/Starter/Pro/Business/Scale), yearly -20%, bundles, $125/h services |
| 6 | Bundle Builder | https://onenexora.com/bundles | pick 2-3 of Sentinel/CSPM/Gateway, monthly/yearly toggle |
| 7 | NEXORA docs | https://docs.onenexora.com | base `api.onenexora.com/v1`, bearer `nx_live_…`, org-owned keys, `X-RateLimit-*`; says nothing on registering a product |
| 8 | NEXORA repo | https://github.com/xsmartbartx/NEXORA | monorepo: 10 apps, 10 packages, Clerk, Postgres, Stripe, Redis, Caddy, Oracle Cloud; Phases 0-6 done |
| 9 | OmniFlow repo | this repo (`git ls-files`, `docs/*.md`) | 804 tests; engine, gateway, console, CLI, insight, authoring |
| 10 | OmniFlow API | `docs/api.md`, `GET /v1/openapi.json` | roles admin/author/operator/approver/viewer; `omf_` keys; session cookie + CSRF |
| 11 | ChatGPT project chat | link in the request | **not read**: behind a ChatGPT login and not signed in. Paste the key parts to include them |
| 12 | NEXORA architecture doc | `docs/NEXORA-PLATFORM-ARCHITECTURE.md`, ADR-0011, ADR-0013 in the NEXORA repo | **not yet read**: needed before architect step (§9.1, §9.2, §14.3) |

No private pages, no logins, no API calls beyond public pages and public GitHub. No screenshots captured yet
(`replica/screens/` is empty on purpose; capture with the owner present).

## Core loop

A person describes or writes a workflow, it is validated and reviewed, runs exactly once with approvals and rollback,
and the whole history is auditable. Inside NEXORA: one org, one console, one key, one bill, with runs metered
against the plan.

## Screens

OmniFlow console (hash router, `console/js/app.js`):

| ID | screen | route | purpose | key components | states seen |
| --- | --- | --- | --- | --- | --- |
| S01 | Login | (login view) | session sign-in, forced password change | form, lockout message | default, error, locked |
| S02 | Dashboard | `#/dashboard` | health, recent runs, alerts | stat tiles, charts | filled; empty/loading **unverified** |
| S03 | Workflows list | `#/workflows` | browse/publish | table, status badges | filled, empty |
| S04 | Workflow detail | `#/workflows/:name` | versions, graph, explain, canary/kill controls | graph, tabs, action buttons | active, killed, canary |
| S05 | Editor | `#/editor`, `#/editor/:draft` | author YAML with live validation, AI assistant | code editor, issue list, diff | valid, invalid, AI off |
| S06 | Runs list | `#/runs` | filter runs | table, filters | filled, empty |
| S07 | Run detail | `#/runs/:id` | steps, events, live SSE, explain | timeline, step panel | running, succeeded, failed, rolled-back |
| S08 | Approvals inbox | `#/approvals` | decide pending approvals | list, decide dialog | pending, empty |
| S09 | Change requests | `#/changes` | four-eyes review with diffs | diff view | open, approved, rejected |
| S10 | Insights | `#/insights` | analysis proposals, alerts | cards, charts | filled, AI off |
| S11 | Capabilities | `#/capabilities` | catalogue, kill switch | table | live, killed |
| S12 | Triggers | `#/triggers` | cron/webhook/event triggers, rotate secret | table | filled |
| S13 | Secrets | `#/secrets` | write-only secret store | table, form | filled |
| S14 | Audit log | `#/audit` | hash-chained events, verify, export | table, verify button | verified, tampered |
| S15 | Admin | `#/admin` | users, API keys, tenants | tables, forms | filled |
| S16 | Account | `#/account` | change password | form | default |

NEXORA surfaces the product must appear on (public pages only; app internals unseen):

| ID | screen | route | purpose | key components | states seen |
| --- | --- | --- | --- | --- | --- |
| S20 | Home | `onenexora.com/` | pitch + product cards | hero, product cards (Beta badge) | public |
| S21 | Products index | `/products` | registry-driven list | cards | public |
| S22 | Product page | `/products/<slug>` | scope, capabilities, plans, CTA | see template in Sources #4 | public |
| S23 | Pricing | `/pricing` | per-product plan tables | tables, yearly toggle | public |
| S24 | Bundle Builder | `/bundles` | combine 2-3 products | checkboxes, period toggle, price | none selected, selected |
| S25 | Docs | `docs.onenexora.com` | quickstart, concepts, API ref | nav, code blocks | public |
| S26 | NEXORA Console | `console.onenexora.com` | org control plane, billing, API keys | **unseen (needs sign-in)** | unknown |
| S27 | Product app | `<product>.onenexora.com` | each product's own app | **unseen** | unknown |
| S28 | Status | `status.onenexora.com` | manual component status | list | public |

Not verified: empty/loading/error/mobile states for S02-S16 (never recorded), and all of S26/S27.

## Flows

```
F01 Author and publish a workflow (OmniFlow today)
    S05 editor -> S09 change request (if policy needs it) -> S03 list -> S04 detail
    happy path clicks: 4 (edit, submit, approve [other user], activate)
    edge: validation errors with line numbers, four-eyes (requester cannot approve), AI off

F02 Run and watch
    S04 -> run -> S07 (SSE) -> S08 approval -> S07 terminal
    happy path clicks: 2 (Run, watch). edge: approval timeout, retry, cancel, compensation-failed

F03 Audit
    S14 -> verify chain -> export NDJSON

F10 Discover (NEXORA, target)
    S20 -> S21 -> S22 (OmniFlow page) -> S23 pricing -> sign-up via Clerk
    edge: user already signed in; Free limit reached

F11 Subscribe and get a key (NEXORA, target)
    S26 console -> pick OmniFlow plan -> Stripe checkout -> entitlements update -> create org API key -> call API
    edge: webhook delayed, plan downgrade over quota, revoked key (401 immediately)

F12 Use OmniFlow inside an org (NEXORA, target)
    SSO from NEXORA -> S02 in the user's org workspace -> run a workflow -> usage counted -> limit enforced
    edge: Free org blocked at limit (Pro not), org member removed, role mapping
```

F10-F12 are inferred from the NEXORA README and docs; the real console was not seen.

## Components

| component | variants | states | used on |
| --- | --- | --- | --- |
| OmniFlow console UI (vanilla JS, `console/styles.css`, strict CSP) | table, badge, dialog, tabs, diff, graph, charts, toast | default, loading, error | S01-S16 |
| NEXORA shared shell (`packages/shell`: header, product switcher, account menu) | n/a | signed in/out | S20-S28 |
| NEXORA UI tokens (`packages/ui`) | n/a | n/a | all NEXORA apps |
| Plan table | Free/Starter/Pro/Business/Scale | current, upgrade | S22, S23 |
| Status badge | Beta, live | n/a | S21, S22 |

Console has no framework or build step by design; NEXORA apps are TypeScript monorepo apps. Which UI approach
OmniFlow takes inside NEXORA is the first architect decision (see features `ui-` rows).

## Inferred data model

OmniFlow (read from `state/migrations.ts`, high confidence): `tenants, users, api_keys, sessions, events (hash-chained),
workflow_versions, plans, workflow_settings, drafts, change_requests, proposals, findings, runs, step_states,
idempotency, approvals, cost_ledger, triggers, trigger_fires, webhook_nonces, secrets, secret_leases, artifacts, kv,
capability_flags, channels`. Every tenant-owned table has `tenant_id`.

NEXORA Core (from README/docs, medium confidence; schemas not seen): `api_keys, audit_events, subscriptions` in
Postgres; Product Registry entry `{id, slug, name, tagline, category, pillar, lifecycle, url}`; organisations and
identity live in Clerk; marketplace listing has `provider: nexora|partner`.

Mapping (guess, to confirm in architect):

```
NEXORA organisation  <->  OmniFlow tenant        (1:1, created on first use)   confidence: guess
Clerk user/org role  ->   OmniFlow roles          (admin/author/operator/approver/viewer)   confidence: guess
nx_live_ org key     ->   OmniFlow principal      (today: omf_ keys)   confidence: guess
OmniFlow cost_ledger/runs -> NEXORA telemetry + entitlement counters   confidence: guess
```

## Feature matrix

See `features.csv`. Counts in the summary below.

## Out of scope (cannot or should not be built)

- Multi-region and partner marketplace listings: NEXORA deferred them itself.
- Horizontal scale / HA for OmniFlow: documented single-node SQLite design. Skip unless the owner reopens it.
- Legal pages: NEXORA's Terms, Privacy and Security Statement are drafts awaiting a lawyer; not something to generate.
- Real Stripe live mode, DNS and production deploys: owner-gated, outside this session's authority.
- NEXORA internals not seen (console, account, product apps): cannot be mapped without sign-in.

## Findings that matter now

1. **Licence drift:** `LICENSE` is now proprietary (commit 934843c), but `package.json` says `Apache-2.0`, `README.md`
   ends with "Apache License 2.0", and `THIRD_PARTY_NOTICES.md`/docs may repeat it. Contradictory terms on a
   product you intend to sell.
2. **Two identities:** OmniFlow has its own users/sessions/`omf_` keys; NEXORA uses Clerk and `nx_live_` keys.
3. **Two databases:** OmniFlow state plane is SQLite by design; NEXORA is Postgres. Per-org SQLite files are the
   cheapest bridge; a Postgres state plane is the expensive one.
4. **OmniFlow is absent from the NEXORA site, repo and registry** today.
5. NEXORA's voice is "state what it actually does today". OmniFlow's README claims fit that voice; keep it.

## Size

Screens: 16 OmniFlow + 9 NEXORA (2 unseen). Flows: 3 existing + 3 target. Entities: 26 OmniFlow tables + ~4 NEXORA.
Hard parts: (1) identity/tenancy mapping Clerk <-> OmniFlow, (2) state plane (SQLite per org vs Postgres), (3) usage
metering + entitlements + Stripe plan for runs. Also: hosting the engine's long-running scheduler next to NEXORA's
Next.js-style apps. Size: **M** (a few weeks) if OmniFlow stays its own service behind a Core-aware gateway; **L** if
the state plane moves to Postgres.
