# What the category's users want, and what to do about it

## Read this first: what this evidence is

- **There is no "original" to read reviews of.** OmniFlow and the NEXORA products are yours and have no public reviews. I used the workflow-tool category instead: n8n, Apache Airflow, Temporal, Zapier and similar.
- **Sample: 80 items from 2 sources** (GitHub issues 68, Hacker News comments 12). **0 star ratings.** The target was 100+ items from 3+ sources; I did not reach it. G2, Capterra, Trustpilot, Reddit and app stores were not read (terms and API access), so the theme counts below are thin and developer-biased.
- **How the sample was built:** GitHub = the most-reacted open issues of three projects (feature requests and bugs by people who use them, not a random sample). Hacker News = comments from the official Algolia search that mention these tools and use at least two complaint words, then hand-filtered to drop job ads, self-promotion and off-topic comments (107 collected, 80 kept). GitHub rows show the issue title plus a `[N reactions on repo]` tag that I added; the rest is verbatim.
- The theme matcher is keyword-based and sometimes misfiles (for example an auth bug landed under "upgrades"). I read every listed quote by hand; counts are indicative, not measurements.
- Reviewers' words are research only. None goes on a landing page.

Full table and quotes: [feedback.md](feedback.md). Raw rows: [reviews.csv](reviews.csv).

## 1. What they hate

| # | problem | items | sources | evidence |
| --- | --- | --- | --- | --- |
| 1 | Failures, retries and recovery are hard to get right | 13 | 2 | "Different retry options based on failure type [35 reactions on temporalio/temporal]" <https://github.com/temporalio/temporal/issues/131> · "Any mildly complex system will have side effects outside your DB, then you want idempotency." <https://news.ycombinator.com/item?id=48769191> |
| 2 | Hard to see and debug what a workflow is doing | 11 | 2 | "Ringpop and TChannel are hard to debug when things go wrong." <https://news.ycombinator.com/item?id=48331337> · "Support wildcard search for workflows [11 reactions on temporalio/temporal]" <https://github.com/temporalio/temporal/issues/3056> |
| 3 | Running the engine is complex, and gets worse at scale | 9 | 2 | "Temporal gets much more complex with scale." <https://news.ycombinator.com/item?id=48331337> · "Git sync for plugins in the Helm Chart [30 reactions on apache/airflow]" <https://github.com/apache/airflow/issues/11708> |
| 4 | AI agent steps misbehave inside workflows | 8 | 2 | "AI Agent doesn't store the Tool usages in memory [33 reactions on n8n-io/n8n]" <https://github.com/n8n-io/n8n/issues/14361> |
| 5 | Metered pricing is hard to predict | 4 | 2 | "Have you evaluated Temporal Cloud pricing?" <https://news.ycombinator.com/item?id=48316355> (a thread about what an "action" costs) |
| 6 | Upgrades and breaking changes (**thin**, 1 source) | 5 | 1 | "Aim for error free rolling bounces and upgrades of Temporal [11 reactions on temporalio/temporal]" <https://github.com/temporalio/temporal/issues/1428> |

## 2. What is missing

| # | ask | items | sources | evidence |
| --- | --- | --- | --- | --- |
| 1 | Finer control: priority, concurrency limits, waiting on other workflows, schedules (**thin**, 1 source) | 14 | 1 | "Provide priority task queues [55 reactions on temporalio/temporal]" <https://github.com/temporalio/temporal/issues/1507> · "Add ability for workflow to wait for completion of an external workflow [76 reactions on temporalio/temporal]" <https://github.com/temporalio/temporal/issues/680> |
| 2 | More storage backends, including a lighter one (**thin**, 1 source) | 8 | 1 | "Support sqlite in production." <https://github.com/temporalio/temporal/issues/3366> · "MongoDB as Persistent [59 reactions on temporalio/temporal]" <https://github.com/temporalio/temporal/issues/2318> |
| 3 | Notifications and safety hooks: events from workflows, secrets handling, audit | 5 | 2 | "Workflows/activities to post event notifications that could be listened to [9 reactions on temporalio/temporal]" <https://github.com/temporalio/temporal/issues/3709> · "Hook notification when you turn on/off (pause/unpause) a DAG from the UI [12 reactions on apache/airflow]" <https://github.com/apache/airflow/issues/36516> |

## 3. What is unsolved

- **Teams that need durable, auditable automation but cannot run a cluster.** The Temporal comments are about Cassandra, Ringpop and scale ("Cassandra isn’t fun to manage" is in the thread at <https://news.ycombinator.com/item?id=48331337>); n8n and Zapier users run simpler flows. Evidence is two threads and a handful of issues: **suggestive, not a trend.**
- **Side effects that must happen exactly once** are discussed as an engineering problem to solve yourself (<https://news.ycombinator.com/item?id=48769191>, <https://news.ycombinator.com/item?id=49697521>). 2 comments, 1 source: **thin.**

## What you already do (do not rebuild, say it)

`docs/workflow-authoring.md` already covers several of the asks, so these are messaging, not features: retry only for chosen error classes (`retryOn`), compensation in reverse order, `wait` until an event, per-workflow `concurrency` and `concurrencyPolicy`, run priority 1-9, approvals, hash-chained audit, one container with SQLite.

## Fix plan

| # | what | size | skill | evidence |
| --- | --- | --- | --- | --- |
| 1 | **Retention and archival of runs and audit log.** Today history grows forever (a stated limit in `implementation-status.md`). | M | replica-backend | retention requests in the Temporal issues (reviews.csv); operations complexity theme (9 items) |
| 2 | **Outbound webhook on run state changes** (started, succeeded, failed, waiting for approval) to any URL, signed. First check whether the existing alert and `notify-*` paths already cover it. | M | replica-backend | theme "notifications and safety hooks" (5 items, 2 sources) |
| 3 | **Explain a retry in the run view**: why it retried, why it stopped, which error class. The explainer API exists; check what the run page already shows before building. | S | replica-build | failure handling (13 items), debugging (11 items) |
| 4 | **Workflow search and filters** in the console. **Correction 2026-10-11: search by name/description/owner and filters by state and criticality already existed;** this item became a `*` wildcard and a last-run filter (done). | S | replica-build | "Support wildcard search for workflows" and "Improve filtering support in Airflow 3.x UI Views" |
| 5 | **Plain per-run pricing**: one billable unit, shown in the console usage card, no hidden "actions". Already how the NEXORA meter works; keep it that way when prices are set. | S | replica-launch | pricing theme (4 items; a thread arguing about what an action costs) |
| 6 | (done: `docs/already-solved.md`) **Docs that say what is already solved** (retryOn, compensation, wait, concurrency, exactly-once) as a "coming from Temporal/Airflow/n8n" page, without naming them in product copy. | S | replica-launch | "what you already do" above |

Not planned: more storage backends. The evidence is 1 source, and OmniFlow chose single-node SQLite deliberately (already a `skip` row).

## The angle

Pick from three, each backed only by what the evidence supports:

1. **Operational simplicity.** For teams who need workflows that survive crashes but don't want to run and scale a cluster, OmniFlow is one container and one file. Evidence: operational complexity, 9 items, 2 sources.
2. **Exactly-once and explainable.** For teams automating money-moving or irreversible steps who are tired of rolling their own idempotency, OmniFlow records the key before acting and can explain every run. Evidence: failure handling, 13 items, 2 sources; two HN threads on side effects (thin).
3. **AI that proposes, never decides.** For teams wary of agent steps inside production automation, drafts need review and approval. Evidence: AI-agent theme, 8 items, 2 sources, all complaints about agent *behaviour*, not a request for approval gates, so this one is the weakest.

**Recommended: 1 and 2 together**, with 1 as the headline: "durable workflows without the cluster", and exactly-once as the proof point. Caveat: it fits a single-node product; a buyer who needs horizontal scale is not this customer, and the copy must say so. Do not name n8n, Airflow, Temporal or Zapier in the app name, ads or store listing.
