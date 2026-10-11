# Deploy checklist

Run: 2026-10-11 on `main` at `1e29bbb`. **Verdict: not deployed, and it must not be.** Four hard blockers below. Nothing
was bought, signed in to, created, pushed to a host or switched live.

## Preflight results

| check | result |
| --- | --- |
| `npm run build` (production build) | **pass** |
| `npm run verify` (typecheck, lint, layers, tests) | **pass**, 823 tests |
| `npx playwright test` (e2e + axe) | **pass**, 15 of 15 |
| brand sweep (`sweep.py --config replica/brand.json`) | **pass**, clean (competitor names and domains) |
| licence consistency | **pass**: `package.json` "SEE LICENSE IN LICENSE", README, CONTRIBUTING, Dockerfile label, notices all proprietary |
| parity (`parity.py`) | **fail**: 54.6 / 100, **9 of 17 must-haves done**, verdict "not shippable" |
| open S1/S2 bugs | pass: none (`bugs.md`: six S3/S4, fixed) |
| container smoke test (`deploy/smoke-test.sh`) | **not run**: the Docker daemon is not running on this machine now (it was on 2026-10-10 and passed). Start Docker and re-run |
| `listing.py` | not applicable: web product, no store listing |
| production safety guard | **works as designed**: `OMNIFLOW_MODE=nexora` with the fake Core is refused when `OMNIFLOW_ENV=production` |
| privacy policy and terms live | **fail**: NEXORA's pages are drafts awaiting a lawyer |
| account deletion works | **not built/verified** for NEXORA-mode users (identity rows have no delete path) |
| favicon, titles, OG image are yours | partial: favicon exists; no OG image; product name pending |
| cookie banner | not needed to assess yet: the console sets only the session cookie, no analytics |

## Blockers (any one stops the deploy)

1. **No real NEXORA Core.** Identity assertions are fake and unsigned; entitlement and event contracts are not defined. Nexora mode cannot run in production. Needed: real assertion verification, `nx_live_` keys, real entitlement and event clients (milestone M1).
2. **Must-haves open (9 of 17):** the five above plus plan ladder, Stripe prices, registry record, product page (see `parity.md`).
3. **Name not chosen or cleared** (Constans or Tenax). Renaming after deploy is costly: CLI, env vars, key prefix, image, docs.
4. **Legal pages are drafts.** NEXORA's Terms, Privacy and Security statement need a lawyer.

## Two ways to deploy, once the gates clear

**A. Standalone (could be done today, not as a NEXORA product).** The deployment kit already exists and was smoke-tested: `docker compose --profile tls up -d` with Caddy for HTTPS. This is OmniFlow as shipped, single node. It is a legitimate path if you want to host it yourself without NEXORA integration, with the limits stated in the README.

You do:
1. Buy or choose a domain, e.g. `flow.example.com`, at your registrar.
2. DNS: `A` record `flow` -> the server's public IPv4 (and `AAAA` if IPv6). Open ports 80 and 443 on the server only.
3. On the server: `git clone`, `cp .env.example .env`, then set (names only; values are yours, never pasted here):
   `OMNIFLOW_ADMIN_EMAIL`, `OMNIFLOW_ADMIN_PASSWORD`, `OMNIFLOW_MASTER_KEY` (`openssl rand -base64 32`, **back it up separately**), `OMNIFLOW_PUBLIC_URL=https://flow.example.com`, `OMNIFLOW_DOMAIN=flow.example.com`, `OMNIFLOW_TRUST_PROXY=true`, `OMNIFLOW_METRICS_TOKEN`, `OMNIFLOW_ENV=production`.
4. `docker compose --profile tls up -d`; open the URL; change the admin password on first sign-in.
5. Backups: schedule `deploy/backup.sh` (runbook: `docs/operations.md`), and **test one restore** before relying on it.
6. Monitoring: uptime check on `/healthz`, scrape `/metrics` with the token, alert channel via `OMNIFLOW_ALERT_CHANNELS`.

**B. As a NEXORA product (the goal).** Follows NEXORA's own pipeline and topology, which this repo cannot decide for you:
- Oracle Cloud VPS, Docker, Caddy/Cloudflare edge, `<slug>.onenexora.com` subdomain; separate repo, shared packages consumed as published.
- The deploy needs: the real Core clients, `OMNIFLOW_MODE=nexora` plus a real Core selector (today only `fake` exists), the registry record, staging at `*.staging.onenexora.com` first, then manual promotion. Stripe live mode and the production webhook live in NEXORA Billing, not here.

## What I did not and will not do

No domain bought, no DNS changed, no card or key entered, no Stripe live mode, no host account, no secret created or stored. Those are yours; I wrote the exact names and commands above.

## Watch in the first week (after a deploy)

Disk growth of `/data` (history has no automatic retention yet), `omniflow admin doctor` output, failed-run rate and approval backlog in the console, `/readyz`, restore test results, and the first real backup on the volume.

## To unblock, in order

1. Start Docker; re-run `deploy/smoke-test.sh`.
2. Choose the name; I rename in one pass.
3. M1: real identity, keys, entitlements and events (needs NEXORA's contracts).
4. Decide pricing and the Pro-limit rule; create Stripe objects in test mode.
5. Lawyer reviews Terms and Privacy; trademark search.
6. Re-run this preflight; deploy to staging first.
