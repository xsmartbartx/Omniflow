# Product page draft

For `onenexora.com/products/<slug>`, following the layout of the existing Gateway page (breadcrumb, hero with status badge, overview that states scope plainly, capabilities, plans, docs, one button). **Draft only: not published, and it cannot go live until the real NEXORA Core exists** (today only a fake, unsigned one does). Name is a placeholder, `{{name}}`, until the owner chooses (recommended: Constans).

Voice: plain, exact, calm (`brand.md`). No testimonials, no user counts, no logos: the proof section stays empty until there are real beta users who agree to be quoted.

---

**← Products**

**Cloud** · **Beta**   (set the badge only when it is true)

# {{name}}

**Durable workflows without the cluster.**

## What it is

{{name}} runs the work that is too important for a cron job and too fiddly for a spreadsheet: refunds, provisioning, data pipelines, approvals. You describe a workflow as a short manifest. It is checked before it runs, executed from a single container, and every step is recorded.

Today it is a single-node service on one SQLite file. It does not scale across machines, and high availability means restarting quickly. If you need a cluster, this is not the right tool yet.

## The problem it answers

- **When a step fails, you are left guessing.** Retries, partial effects and "did that charge go through twice?" become your code to write.
- **Running the engine is a job in itself.** Clusters, databases and upgrades before the first workflow.

## How it works

1. **Write or describe a workflow.** A manifest, or a plain-language draft that someone must review.
2. **It is checked, then it runs.** Unknown steps, bad references and missing idempotency keys are errors you see with a line number before anything runs.
3. **You see what happened.** Every attempt, retry and approval is recorded in a tamper-evident log, and any run can be explained in plain text.

## Capabilities

- **One effect, once.** Effectful steps carry an idempotency key recorded before the step acts, so a retry or a crash does not repeat it.
- **Retry only what should be retried.** Choose which failure classes retry; the rest stop and say why.
- **Undo in order.** Failed workflows roll back completed steps in reverse.
- **Approvals that cost nothing while they wait.** Four-eyes review for changes and for individual steps.
- **An audit trail nobody can quietly edit.** Hash-chained, with a one-click integrity check.
- **One container.** One SQLite file, backups and restores are one command each.

Not built yet (said plainly): retention and archival of old runs, signed outbound webhooks on run state changes, workflow search, sign-in and billing through NEXORA outside development.

## Plans

Per organisation, no per-seat pricing, no overage charges: at the limit new runs are refused until the next period or an upgrade; dry runs always work. **Prices pending** (proposal in `pricing.md`).

| plan | runs / month |
| --- | --- |
| Free | 100 |
| Starter | 1,500 |
| Pro | 10,000 |
| Business | 50,000 |
| Scale | 250,000 |

## Documentation

- Quickstart →
- Writing workflows →
- Errors, retries and idempotency →

## FAQ

- **Can I import from other tools?** There are importers for crontab files and shell scripts. There is no importer for n8n, Zapier, Airflow or Temporal workflows.
- **What happens at my plan limit?** New runs are refused with a clear message; nothing is billed beyond your plan.
- **Is it open source?** No. It is proprietary software; see the licence.
- **Where does my data live?** In one SQLite file in the deployment you choose.
- **Does the AI run my workflows?** No. AI drafts and proposes; every draft goes through the same checks and human approval as anything else.

## Availability

{{name}} is in development. [Join the beta list] → (button label: "Open {{name}}" only when it is live).

---

Checks: all contrast comes from the NEXORA tokens already verified (15 pairs per theme, 0 AA failures). This page has not been built into the NEXORA website (separate repo, owner publishes).
