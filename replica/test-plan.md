# Test plan

Scope: the OmniFlow flows in `recon.md` (F01-F03) and the NEXORA-mode flows that exist today (F12; F10 and F11 depend on
NEXORA pages and Stripe that are not built or not ours to load-test). Everything runs against local throw-away servers
(`playwright.config.ts`: standalone on 18091, NEXORA mode with the fake Core on 18092). Nothing touches onenexora.com,
and no original app is load-tested. Run: `npx playwright test` (uses the installed Google Chrome, no browser download).

Every spec fails on page errors and any 5xx response, and scans the screen with axe (WCAG 2.0/2.1 A and AA).

## Cases

| ID | case | how | result |
| --- | --- | --- | --- |
| F01-H1 | sign in with the right password reaches the dashboard, no plan card in standalone | e2e | pass |
| F01-N1 | wrong password shows "Could not sign in" | e2e | pass |
| F01-E1 | expired/cleared session returns to sign-in | e2e | pass |
| F01-E2 | 390px width: no horizontal scroll, axe clean | e2e | pass |
| F01-E3 | every console screen (13 routes) x dark and light passes axe | e2e | pass after fixes (B-01..B-05) |
| F01/F02-H1 | publish, run from the console, run succeeds, axe on workflows and run detail | e2e | pass after fixes |
| F02-E1 | two tabs see the same run | e2e | pass |
| F03-H1 | audit log verifies | e2e | pass |
| F12-H1 | NEXORA sign-in provisions the org; usage 0 then 1 of 100 | e2e | pass |
| F12-N1 | no NEXORA identity: "Continue with NEXORA", no password form | e2e | pass |
| F12-N2 | at the plan limit: console shows "Plan limit reached", API answers 429 `ENTITLEMENT_EXCEEDED` | e2e | pass |
| F12-N3 | viewer cannot run or publish (403) | e2e | pass |
| F12-N4 | forged or missing assertion refused (401) | e2e | pass |
| F12-E1 | second org cannot see the first org's workflows | e2e | pass |
| F12-E2 | 390px, no horizontal scroll, axe clean | e2e | pass |
| F12-E3 | NEXORA session ends: sign-in screen, Continue renews it | e2e | pass |
| API | metering, outbox retry/dedupe, outage grace, suspension, schema constraints | vitest `tests/nexora` (18 cases) | pass |

## Not covered (and why)

- Other edge cases in the standard list: very long names, emoji, double-click submit, back/refresh mid-flow, slow network and offline, time-zone display, screen reader pass with a real reader. Not written yet.
- Screens with data in them (approvals, change requests, insights, triggers, secrets): the scan ran on their empty/seeded state only.
- Light-theme appearance beyond axe was not reviewed by eye.
- Email, real OAuth, Stripe checkout: nothing built to test.
- Known gap (documented in `build-log.md`): a member removed in NEXORA keeps access until the 5-minute session ends. No test asserts the intended behaviour because it is not built.
