## Parity: 50.0 / 100

features 50.0  (24 counted, must-haves 8 of 17 done)

Not shippable yet: 9 must-have features are not done.

## By area, weakest first
- registry                       0.0  (1 features)
- website                        0.0  (1 features)
- billing                        0.0  (3 features)
- docs                           0.0  (1 features)
- ops                            0.0  (1 features)
- legal                          0.0  (1 features)
- api                           37.5  (3 features)
- entitlements                  50.0  (1 features)
- telemetry                     50.0  (1 features)
- ui                            50.0  (2 features)
- identity                      83.3  (3 features)
- engine                       100.0  (2 features)
- governance                   100.0  (2 features)
- console                      100.0  (1 features)
- state                        100.0  (1 features)

## Missing, in build order
- [must] api: Accept nx_live_ org API keys on /v1, no  (omf_ keys stay for self-hosted mode)
- [must] billing: Plan ladder Free/Starter/Pro/Business/Scale with run quotas, no  (price points are an owner decision)
- [must] billing: Stripe products/prices for OmniFlow plans, no  (test mode only until owner approves live)
- [must] legal: Licence consistency (LICENSE vs package.json vs README), no  (Apache-2.0 text still in package.json and README)
- [must] registry: Register OmniFlow in Product Registry (slug/tagline/pillar/lifecycle), no  (appears in GET /v1/products and site)
- [must] website: Product page on onenexora.com following the Gateway template, no  (owner publishes; draft only in this session)
- [must] entitlements: Entitlement enforcement (Free blocked at limit; Pro not), partial  (gate + 429 + local reservation + outage grace done against fake Core; real C-ENT in M1)
- [must] identity: Sign in through NEXORA identity (Clerk SSO), partial  (fake Core only (unsigned); real Clerk assertion verification is M1)
- [must] telemetry: Usage metering runs per org into NEXORA telemetry, partial  (run.started via outbox with dedupe and retry; run.completed, publish, approval and audit events not yet)
- [should] api: Rate-limit headers X-RateLimit-* on API, no  (OmniFlow has rate limits; header parity unverified)
- [should] billing: Add OmniFlow to Bundle Builder and bundle discount, no  (bundle currently covers Sentinel/CSPM/Gateway)
- [should] docs: Docs section at docs.onenexora.com, no  (reuse docs/*.md)
- [should] ops: Status component on status.onenexora.com, no  (manual component list)
- [should] ui: Product switcher / shared shell in console, no  (needs NEXORA shell package decision (architecture R5))

## Left out on purpose (not scored)
- Replace SQLite state plane with Postgres: README says single-node by design; reopen only if scaling demands
- Terms/Privacy/Security statement for the product: NEXORA drafts await a lawyer; not generated here
- Multi-region / data residency: deferred by NEXORA itself
- Partner marketplace listing for OmniFlow: deferred by NEXORA itself

## Yours, not in the original (not scored)
- Browser end-to-end tests for console

## Layout diff

**Not run.** `replica/screens/` is empty: the "original" screens are NEXORA's console and product apps, which are behind sign-in and were never captured, and the public NEXORA pages are not a like-for-like state of an OmniFlow screen. A layout score against nothing would be invented. The clone's own screens are in `replica/clone-screens/` (S01 NEXORA sign-in, S02 dashboard at 1440 and 390 with the limit state), ready to compare once reference captures exist. To do it: capture NEXORA's console dashboard at 1440x900 and 390x844 with the owner signed in, save as `replica/screens/S02.png`, then run `imgdiff.py`.

## Behaviour differences

Compared with the existing NEXORA products, from their public pages and README only (their apps were not used):

| flow | NEXORA products do | OmniFlow does | fix or keep |
| --- | --- | --- | --- |
| sign-in | one NEXORA/Clerk sign-in across subdomains | fake, unsigned assertion; own "Continue with NEXORA" screen | fix in M1 (real verification) |
| limit reached | README: Free orgs blocked at the limit, Pro not blocked | all plans blocked at the limit (fake quotas) | decide: does Pro overage keep running? Owner decision with pricing |
| API keys | `nx_live_` org keys, `X-RateLimit-*` headers | `omf_` keys, no rate-limit headers on responses | fix in M1/M2 |
| removed member | revocation ends access everywhere | access lasts until the 5-minute session ends | fix: per-request membership check |
| navigation | shared shell with product switcher | OmniFlow's own sidebar | decide R5 |
| usage events | usage, audit and health events | `run.started` only | fix in M1 |

## Verdict

**Not shippable.** Nine must-haves are not done (50.0 / 100, 8 of 17 must-haves). No S1 or S2 bug is open (`bugs.md`: six S3/S4, all fixed), and the nexora mode cannot run in production anyway because only the unsigned fake Core exists.

Note on the score: 3 of the 9 open must-haves (plan ladder, Stripe prices, product page and registry record) are owner decisions or owner-published pages, and 1 (licence consistency) is a one-line decision plus edits. Only 5 are engineering work blocked on NEXORA's contracts.

## Top five to do next

1. **Licence consistency** (must): `LICENSE` says proprietary; `package.json`, README, CONTRIBUTING, the Dockerfile label and the notices script say Apache-2.0. Needs your decision, then a small change.
2. **Real identity verification** (must): replace the fake assertion with Clerk's verification once NEXORA's auth package or contract is available.
3. **`nx_live_` API keys** (must) plus **`X-RateLimit-*` headers** (should).
4. **Usage events beyond `run.started`** (must): run completion, publish, approval, audit.
5. **Registry record, plan ladder and product page drafts** (must): draft files only; you publish them.
