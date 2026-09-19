# OmniFlow

**Workflows you can trust to run, explain and undo — with AI that proposes and never decides.**

OmniFlow is a workflow engine for the work that is too important for a cron job and too fiddly for a
spreadsheet: refunds, provisioning, data pipelines, approvals, incident runbooks. You describe a workflow
as a small, reviewable YAML manifest. OmniFlow validates it, compiles it into an immutable plan, and runs
it deterministically — with retries, timeouts, approvals, rollback, an audit trail nobody can quietly
edit, and a web console to watch it all.

```yaml
apiVersion: omniflow.dev/v1
kind: Workflow
metadata: { name: hello-world, version: 1.0.0, owner: you@example.com, criticality: low }
triggers: [{ type: manual }]
inputs:
  name: { type: string, default: world }
steps:
  - id: greet
    type: capability
    uses: util-echo@^1
    with: { value: "Hello, ${{ inputs.name }}!" }
outputs:
  greeting: "${{ steps.greet.output.value }}"
```

## Why it is different

| | |
|---|---|
| **Declarative, not code** | A manifest is data. It can be linted, diffed, reviewed, versioned and *proven* before it runs: unknown steps, bad references, missing idempotency keys and risky patterns are compile errors, shown with the line they are on. |
| **Deterministic and replayable** | The same plan and inputs make the same decisions. Every step attempt, retry, approval and outcome lands in a hash-chained, append-only event log; tampering is detectable (`omniflow audit verify`). |
| **Safe by construction** | Workflows reach the outside world only through typed *capabilities* that declare their effects, secrets and network reach. Effectful steps carry idempotency keys and run **exactly once**, even across crashes. Failures roll back through compensation, in reverse. |
| **AI that proposes** | A Planner drafts workflows from a description, an importer lifts your crontab or scripts in, and an Analysis Agent reads run history and suggests improvements. All of it produces *drafts and proposals*: it has no path to production except the same validation, risk review and human approval as anyone else. |
| **Governed** | Roles, four-eyes approval, tenant isolation, policy-as-code, autonomy tiers (T0–T3), kill switches at workflow and capability level, canary rollouts with one-command rollback. |
| **Hostable in minutes** | One container, one SQLite file, no external services. Non-root, read-only root filesystem, all capabilities dropped. Backups are one command; so is restoring them. |

## Quick start

You need Docker (or Node.js 24+).

```bash
git clone <this repository> omniflow && cd omniflow
cp .env.example .env            # set OMNIFLOW_ADMIN_PASSWORD; leave the rest for now
docker compose up -d
```

Open <http://localhost:8080>, sign in as `admin@example.com`, and go to **Workflows → New workflow**.
Or from the command line:

```bash
docker compose exec omniflow omniflow admin create-api-key --name me --role admin
export OMNIFLOW_URL=http://localhost:8080 OMNIFLOW_API_KEY=omf_…      # the key it printed

docker compose exec omniflow omniflow publish /app/workflows            # the example workflows
omniflow run hello-world --input name=Ada --wait                        # run one and watch it
omniflow runs                                                           # everything that ran
```

Without Docker: `npm ci && npm run dev` starts the same server on port 8080 (`omniflow dev <file>` runs a
single workflow on a throw-away platform, no server needed).

Then read **[Getting started](docs/getting-started.md)**.

## What is in the box

- **Engine** — compiler, immutable content-addressed plans, orchestrator, scheduler, triggers (manual,
  cron, signed webhooks, events, workflow completion), approvals, compensation, crash recovery, dry runs.
- **Capabilities** — HTTP (SSRF-safe), files, SQL (SQLite/Postgres), shell (allow-listed, sandboxed by the
  container), chat/webhook/email notifications, LLM inference, and pure helpers. Add your own in a few dozen lines
  ([guide](docs/capabilities.md)).
- **Web console** — dashboard, workflow graph, live run view, approvals inbox, change-request review with
  diffs, editor with live validation and an AI assistant, insights, secrets, audit log, users and API keys.
- **CLI** — `validate`, `compile` and `dev` work on files with no server; the rest drives a server
  ([reference](docs/reference/cli.md)).
- **API** — REST + server-sent events, OpenAPI 3.1 at `/v1/openapi.json` ([guide](docs/api.md)).
- **Operations** — Prometheus metrics, alerting to chat, `omniflow admin doctor`, online backups,
  master-key rotation ([runbook](docs/operations.md)).

## Documentation

| | |
|---|---|
| [Getting started](docs/getting-started.md) | Install, first workflow, first approval |
| [Writing workflows](docs/workflow-authoring.md) | The manifest, expressions, retries, compensation, testing |
| [Capabilities](docs/capabilities.md) · [catalogue](docs/reference/capabilities.md) | What workflows can do, and how to add more |
| [API](docs/api.md) | Authentication, endpoints, webhooks, streaming |
| [Configuration](docs/configuration.md) | Every setting |
| [Operations](docs/operations.md) | Deploy, upgrade, back up, monitor, troubleshoot |
| [Security](docs/security.md) | The model, the controls, what you are responsible for |
| [Architecture](docs/architecture.md) | How it fits together and why |
| [Vision & design](docs/omniflow-architecture-and-vision.md) · [ADRs](docs/adr) | The reasoning behind it |

## Know the limits

OmniFlow is deliberately a **single-node** system: one process, one SQLite database (WAL mode). That is
plenty for many thousands of runs a day and keeps it trivial to run, back up and reason about — but it
does not scale horizontally, and high availability means restarting fast (it recovers interrupted runs on
boot), not running two copies. *Exactly-once* holds inside OmniFlow and for downstream systems that honour
the idempotency key it passes them. The shell capability is sandboxed by the container you run it in, not
by OmniFlow. See [Security](docs/security.md) and [Operations](docs/operations.md).

## Development

```bash
npm ci
npm run verify           # typecheck, lint, architecture-layer check, all tests
npm run test:coverage    # with the coverage floor CI enforces
npm run dev              # server with reload
deploy/smoke-test.sh     # build the image and exercise it end to end
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
