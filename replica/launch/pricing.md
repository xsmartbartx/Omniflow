# Pricing (proposal, owner decision)

Prices below are **proposals**. Nothing is created in Stripe and nothing is published. Read on 2026-10-10/11 from each public page.

## What others charge

| product | billing unit | plans (public prices) | read from |
| --- | --- | --- | --- |
| n8n (hosted) | workflow execution (about one per run) | Starter €20/mo for 2.5K executions; Pro €50/mo for 10K; Business €667/mo for 40K, self-hosted only; Enterprise custom. Annual billing, "save 17%". Unlimited users and workflows. Business overage €4,000 per 300,000 executions | <https://n8n.io/pricing>, 2026-10-11 |
| Zapier | task (a completed unit of work, so one run is often several) | Free $0 for 100 tasks; Professional annual $19.99 (750 tasks), $49 (2,000), $129 (10,000), $289 (50,000), $489 (100,000); monthly billing is about 50% higher. Overage 2.5x the base rate on monthly plans, pauses at 3x | <https://zapier.com/pricing>, 2026-10-11 |
| Temporal Cloud | action plus storage | Pay-as-you-go from $50 per million actions (volume discounts to $25); $150 free credits for 90 days; Business support from $500/month | <https://temporal.io/pricing>, 2026-10-11 |
| NEXORA (own ladder) | scans, requests or runs per month | Free / Starter / Pro / Business / Scale; Gateway: $0 / $19 for 1,500 / $59 for 12,000 / $199 for 60,000 / $599 for 300,000 requests; yearly saves 20% | <https://onenexora.com/pricing>, 2026-10-10 |

Units are not equal: one OmniFlow **run** compares best with an n8n execution; Zapier tasks and Temporal actions count steps, so a many-step workflow costs far more there than per run here.

## What users said about price (from `feedback.md`)

4 items, 2 sources, so **thin**. Examples: a thread arguing about what counts as an "Action" in Temporal Cloud pricing (<https://news.ycombinator.com/item?id=48316355>); an older comment calling another vendor "very expensive" with no free trial (<https://news.ycombinator.com/item?id=22343820>). The signal that is repeated across tools: **people want to predict the bill.**

## The model

- One billable unit: **a run that starts** (dry runs are free). Same unit already used by the meter in the console.
- **No overage charges.** At the limit new runs are refused with a clear message and an upgrade link (built; `ENTITLEMENT_EXCEEDED`). Reason: surprise overage is the complaint pattern in the research.
- Flat per org, **no per-seat pricing** (n8n does the same; it removes the "surprise seat jump").
- Yearly billing saves 20%, matching the rest of NEXORA.
- **Five tiers, not three**: the skill advises three, but NEXORA's entitlements and every other product use Free/Starter/Pro/Business/Scale, and the code's `plan` field already has those five. Consistency inside the platform wins.

| tier | for | proposed monthly | runs / month | notes |
| --- | --- | --- | --- | --- |
| Free | trying it on a real workflow | $0 | 100 | hard stop at the limit |
| Starter | one person or a small team's first automations | $19 | 1,500 | |
| Pro | a team running it for real | $49 | 10,000 | roughly n8n Pro's price and volume, below Zapier's 10,000 tasks ($129) |
| Business | many workflows, priority support | $149 | 50,000 | priority support |
| Scale | heavy volume, SLA | $449 | 250,000 | SLA |

Why these numbers: they sit between n8n (volume, price) and Zapier (cheaper per run for multi-step work) and follow Gateway's 1,500 / 12,000 / 60,000 / 300,000 shape. **Cost basis is unknown**: infrastructure per run is small, but I have not measured it, and LLM steps use the customer's own key. Measure a loaded node (runs per minute, disk growth per 1,000 runs) before fixing the Scale price.

## Open decisions (yours)

1. **Do Pro and above stop at the limit?** NEXORA's README says Free orgs are blocked at their limit and Pro are not. The built gate stops every plan. Pick: stop everywhere (predictable), or allow Pro to overrun with a clear, capped, opt-in overage.
2. The five price points and quotas above.
3. Whether OmniFlow joins the Bundle Builder.

## Fix the billing complaints in the product

- One-click cancel through the Stripe customer portal; renewal email 7 days before a yearly renewal; the plan page always shows runs used and the date the period resets (the usage card shows used and limit today, not the reset date yet).
- Downgrade over quota: keep access to history, block new runs, say why.

## Stripe objects to create (you create them, test mode first)

Product "OmniFlow" (name pending), five recurring prices per interval: Starter $19 / $182.40 yearly, Pro $49 / $470.40, Business $149 / $1,430.40, Scale $449 / $4,310.40 (20% off the yearly total), Free needs no price. Metadata `plan=<starter|pro|business|scale>` so NEXORA Billing maps them to the entitlements. Billing lives in NEXORA's `packages/billing/src/plans.ts`, not in this repo.
