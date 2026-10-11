# Launch plan

## Gates (nothing public until these are true)

1. **Real NEXORA Core.** Today only a fake, unsigned Core exists and nexora mode is refused in production. Needs real identity verification, `nx_live_` keys, and the entitlement and event contracts (milestone M1).
2. **Name chosen and cleared** (Constans or Tenax): trademark search by a lawyer, then the rename.
3. **Prices and the "stop at limit" rule decided** (`pricing.md`), Stripe objects created in test mode, then live by you.
4. **Legal pages:** NEXORA's Terms, Privacy and Security statement are drafts awaiting a lawyer.
5. **No S1/S2 bugs; must-haves done** (`parity.md`: 8 of 17 today).

## Not applicable

- **App Store / Google Play listing:** OmniFlow is a web product inside NEXORA, with no mobile app, so there is no `listing.json` and nothing for `listing.py` to check. (If a mobile app is ever built, the copycat rule applies and the listing must lead with the fixes.)

## Before launch

- **Beta list:** a signup on the product page and in NEXORA's console; honest copy: "in development, single-node, limits stated".
- **Analytics and errors:** product events from the NEXORA usage events (`omniflow.run.started` exists today); error tracking via the monitoring NEXORA already plans (Sentry). Not set up in this repo.
- **Docs ready:** quickstart, errors-retries-idempotency, and a "coming from other tools" page (what maps to what, no names in product copy).
- **Fixes first:** at least the top two from `fixes.md` (retention/archival; outbound webhooks) or say they are on the roadmap, as the page does.

## Where the category's frustrated users talk (from the research, not new)

- Hacker News threads found in `reviews.csv`: the Temporal complexity and pricing thread (<https://news.ycombinator.com/item?id=48331337>, <https://news.ycombinator.com/item?id=48316355>) and the durable-workflow side-effects threads (<https://news.ycombinator.com/item?id=48769191>, <https://news.ycombinator.com/item?id=49697521>). Read them; reply only with something useful and say who you are.
- GitHub issue trackers of the same projects (feature-request boards). Do not spam them.
- **Reddit was not researched**: find the threads by hand first.

## Launch post

Lead with the fix, not the feature list: "Durable workflows without running a cluster: one container, exactly-once effects, every run explained." State the limit in the first paragraph (single node). Show HN or Product Hunt only when the product can actually be tried by a stranger; one demo org with the Free plan is enough. No fake upvotes, no testimonials, no reviewer quotes.

## First 10 users

By hand, not a campaign: people you already know who run cron jobs, scripts or n8n/Zapier flows that move money or provision accounts. Ask for 30 minutes watching them set up one real workflow, with permission to quote them later. Names are yours to fill in; I have none to suggest.

## What I did not do

No page was built or published; no Stripe object, domain, social account or store listing was created; no outreach was sent.
