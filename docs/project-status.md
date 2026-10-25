# Project status

As of 2026-10-24. A maintainer's snapshot of what is done, what was decided and what is still open. It contains no secrets.
For what the product does today, see [implementation-status.md](implementation-status.md).

## Code quality

SonarCloud (`xsmartbartx_Omniflow`): **0 open issues**, ratings A / A / A, quality gate passing, 0.0% duplication.
Cognitive complexity is under the limit everywhere.

89 findings are deliberately **Accepted** or marked false positive in SonarCloud, each with a written reason and set to
never reopen:

| What | Why it stays |
| --- | --- |
| async methods with no `await` (S7503) | They implement interfaces that return a Promise; `async` keeps synchronous throws as rejected promises. |
| `await` inside a loop (S9382) | Sequential on purpose: alert delivery order, files published in order, map workers pulling items one at a time. |
| Regex complexity (S8786, S5843) | Input is size-limited and the patterns are tested; rewriting risks changing what they match. |
| Hard-coded IPs (S1313) | They are the SSRF blocklist itself. |
| Test passwords, the notify adapter's URL, `contrast.py` | Throwaway test credentials; the SMTP URL comes from operator configuration; a developer tool run by hand. |
| The fixed 250 ms wait in the accessibility e2e (S2925) | It paces sign-ins under the server's login rate limit. Removing it made the suite fail intermittently with "Too many requests". |

## Working conventions

- `npm run verify`, the format check, the docs drift check and `npx playwright test` must pass before a PR.
- Refactors are checked against the old code where a differential test is possible (compiler output, manifest validator
  issues, markdown AST, cron descriptions, contrast output), not only by the test suite.
- No `localeCompare` for determinism-critical sorts.
- Do not make the e2e suite faster by removing waits (see above).

## Product site

`site/` holds a standalone, build-less product site for OmniFlow (home, platform, security, pricing, and draft privacy
and terms pages), with a NEXORA family strip. It has a strict CSP, a preview server (`npm run site`), an e2e spec and
hosting files. **The site itself is not deployed** (the app below is). Every call-to-action opens
`https://onenexora.com/company#contact`. The privacy and terms pages are drafts that need a lawyer. See
[`site/README.md`](../site/README.md).

## Deployment

The standalone product (not NEXORA mode) runs on the shared NEXORA OCI host as its own compose project in `~/omniflow`,
and is served at `https://omniflow.onenexora.com` through the shared edge Caddy (`infrastructure/edge` in the NEXORA
repo carries the site block and the `omniflow_default` network). Secrets live only in `~/omniflow/.env` on the host.
The product site (`site/`) is the optional `site` compose service, served at `www.omniflow.onenexora.com` through the same edge. Redeploy: copy the repo with `git archive`, then `docker compose up -d --build`. NEXORA mode is not deployable until a
real NEXORA Core exists (the fake Core is refused in production).

## Built since the last snapshot

- NEXORA usage and audit events: terminal run outcomes and governance decisions go through the outbox with dedupe and retry.
- `omniflow admin prune`: erases old artifacts and settled delivery rows (never the audit log or run records).
- The step dialog says why a step retried or stopped.
- [`already-solved.md`](already-solved.md), a one-page summary of retries, undo, waiting, concurrency and exactly-once.

## Name

On 2026-10-20 the owner decided to **stay with OmniFlow**, and the earlier rename to "Constans" was reverted everywhere (CLI, package,
`OMNIFLOW_*` variables, `omf_` keys, `omniflow.dev/v1`, docs, console and the product site). The trademark screening of Constans,
Tenax and six more candidates is kept below and in `replica/brand.md`; **OmniFlow was screened on 2026-10-20 and has a direct conflict:** a live, pending USPTO
application for `OMNIFLOW` in class 42 for online workflow management (Synergy Folks Inc), plus other live class 7, 9 and 42 marks, and
the npm name `omniflow` belongs to someone else. See `replica/brand.md`. This needs a trademark lawyer before any public launch.

## Open decisions (owner)

- The product-site domain, a dedicated sign-up or form URL, legal pages, and the redirect from
  `onenexora.com/products/constans` (done in the NEXORA repo).
- **The name "Constans" has a screening conflict:** a UK registration (9 Oct 2026, classes 9 and 42, Constans Ltd). The
  fallback "Tenax" is crowded (651 WIPO records) and has a pending class 42 security-services application (TENAX SECUREOPS)
  next to NEXORA's security products. A third round (2026-10-17) found conflicts for Anchora and Firmo; **Perdura** is the
  clearest on trademarks, but its domains are mostly taken (several registered together in May 2026) and the GitHub
  organisation and PyPI name are taken. Perdura is also in live use: a managed SAP HANA hosting company at
  `perdura.cloud` and `perdura.net` (class 42), a chess product and a memorials service. See `replica/brand.md`. A trademark lawyer should decide.
- The real NEXORA Core contracts, the Pro-limit rule, prices and the Stripe objects.
- Audit-log and run-record retention (tiered retention is an open architecture question, Q6); only artifacts and delivery rows can be pruned today.
- A lawyer's review of the privacy and terms drafts, and the operating entity's name.
- Back up `OMNIFLOW_MASTER_KEY` from the host's `.env`.
