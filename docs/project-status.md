# Project status

As of 2026-10-15. A maintainer's snapshot of what is done, what was decided and what is still open. It contains no secrets.
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

`site/` holds a standalone, build-less product site for Constans (home, platform, security, pricing), with a NEXORA
family strip. It has a strict CSP, a preview server (`npm run site`), an e2e spec and hosting files. **It is not deployed.**
Every call-to-action opens `https://onenexora.com/company#contact`. See [`site/README.md`](../site/README.md).

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
- Go-ahead before any deployment. Nothing is deployed.
