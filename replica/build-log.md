# Build log

Branch `build/nexora-m0`. Milestone M0 of `architecture.md` (vertical slice) plus the console restyle from `design/`.
Everything runs against a **fake, unsigned NEXORA Core** (`nexora/fakes.ts`); the server refuses it when `OMNIFLOW_ENV=production`.

| ID | date | status | what is missing / what was harder |
| --- | --- | --- | --- |
| shell | 2026-10-10 | done | Console restyled to NEXORA tokens (dark default, light via OS or class). Mechanical rename of ~130 variable uses; raw hex in sidebar/toast/dialog replaced by tokens. Toasts no longer rely on white-on-colour (failed AA in dark): they keep the card background with a coloured edge |
| S01 login | 2026-10-10 | partial | NEXORA mode shows "Continue with NEXORA" (links to `/app`). Real NEXORA sign-in URL unknown, so it points at `/app` only |
| S02 dashboard | 2026-10-10 | done | Plan usage card (meter + text), warning at 80%, error notice at limit. Screens saved in `clone-screens/` (1440 and 390 widths, limit state) |
| S03-S16 | 2026-10-10 | restyled only | Colours and tokens changed; layouts untouched. Not re-screenshotted individually; no browser tests exist for the console (known limit) |
| backend M0 | 2026-10-10 | done | migration 2, `NexoraStore`, ports, `NexoraService`, admission gate in `RunService`, outbox worker, `/app`, `/v1/nexora/usage`, `/app/dev-login` (dev only), `nexora` layer in the layer checker |

## Decisions and deviations

- **Session revalidation is only partly as designed.** The architecture says every session request re-reads the user's current membership. Built: sessions last 5 minutes (configurable), roles are refreshed at each sign-in, and a suspended/disabled org kills sessions immediately (`tenantGuard`). A member removed in NEXORA keeps access until their 5-minute session ends. Closing the gap needs a membership lookup per request through `IdentityPort`; not built.
- **Revocation of API keys:** `nx_live_` key auth is not built (M1), so the key-cache question is still open.
- **Own rate bucket for `/app`** (240/min, burst 120 per IP) instead of the strict password-login bucket, because an office can share one IP.
- **Unlinked tenants are not metered** (the operator's own `default` tenant). Deliberate: otherwise the operator is locked out when Core is down.
- **Fake Core quotas are placeholders** (`nexora/plans.ts`); real quotas and prices are the owner's decision.
- **Dry runs are not metered.**

## Not built yet (next)

M1: real assertion verification (Clerk), `nx_live_` keys, lifecycle webhook, `run.completed` / publish / approval / audit events, health heartbeat, registry record, licence fix. M2: NEXORA shell strip, docs section, rate-limit headers, console browser tests.
