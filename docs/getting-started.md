# Getting started

This takes about ten minutes and ends with a workflow that pauses for a human approval.

## 1. Install

### Docker Compose (recommended)

```bash
git clone <this repository> omniflow && cd omniflow
cp .env.example .env
```

Edit `.env` and set at least:

- `OMNIFLOW_ADMIN_PASSWORD` — the first administrator's password (you are asked to change it at first sign-in).
  If you leave it empty a random one is generated and printed once in the server log.
- `OMNIFLOW_MASTER_KEY` — encrypts stored secrets. `openssl rand -base64 32` makes one. If empty, a key is
  generated into the data volume; fine for a trial, but for anything real supply your own **and keep a copy
  somewhere else** (see [Operations](operations.md#the-master-key)).

```bash
docker compose up -d
docker compose logs -f omniflow      # wait for "listening"
```

Open <http://localhost:8080> and sign in as `admin@example.com`.

For a trial you can set `OMNIFLOW_ENV=development`, which relaxes the production publishing gates
(second-person approval for effectful workflows). Use `production` for anything real.

### From source

Requires Node.js 24 or newer.

```bash
npm ci
OMNIFLOW_ADMIN_PASSWORD='a-long-password-here' npm run dev       # → http://localhost:8080
```

Data goes to `./data` (`OMNIFLOW_DATA_DIR`). For a production build: `npm run build && npm start`.

### Bare metal (systemd)

See [`deploy/systemd/omniflow.service`](../deploy/systemd/omniflow.service) — it documents the install steps
and ships with a sandboxed unit.

## 2. The command-line tool

The CLI is in the container as `omniflow`, and on your machine after `npm ci` as `node cli/main.ts`
(or `npm link` to get `omniflow` on your PATH). Two things need no server at all:

```bash
omniflow validate workflows/            # check manifests; errors point at the offending line
omniflow dev workflows/hello-world.yaml --input name=Ada     # run one on a throw-away platform
```

Everything else talks to a server. Create an API key on the machine that holds the data (this needs no
login — it is the break-glass path for a fresh install):

```bash
docker compose exec omniflow omniflow admin create-api-key --name laptop --role admin
```

```bash
export OMNIFLOW_URL=http://localhost:8080
export OMNIFLOW_API_KEY=omf_…           # the key it printed — it is shown once
omniflow status
```

Give a key only the roles it needs: `viewer` (read), `operator` (run, cancel), `author` (write and publish
workflows), `approver` (decide approvals), `admin` (everything).

## 3. Publish and run a workflow

The repository ships examples in `workflows/`. Publish them:

```bash
docker compose exec omniflow omniflow publish /app/workflows       # or, from your checkout: omniflow publish workflows/
```

Run one and watch it:

```bash
omniflow run hello-world --input name=Ada --wait
```

```
15:04:05.101  ...                run.queued
15:04:05.103  greet              step.succeeded
15:04:05.104  shout              step.succeeded
15:04:05.105  ...                run.succeeded
✓ succeeded
```

Open the console (**Runs**) to see the same run with its graph, timings and inputs/outputs. **Workflows →
hello-world → Docs** shows the generated documentation and diagram.

## 4. Make a workflow wait for a person

`approval-gated-refund` pauses at an approval step. Start it:

```bash
omniflow run approval-gated-refund --input orderId=A-1042 --input amount=129.90
omniflow approvals                       # it is waiting
```

The run cannot be approved by whoever started it (four-eyes). Sign in to the console as a *different*
person — create one under **Users & keys** — and press **Approve** in the **Approvals** inbox, or:

```bash
OMNIFLOW_API_KEY=<another key> omniflow approvals approve <id> --comment "checked with finance"
```

The run resumes, finishes, and every step — including who approved, when, and why — is in the audit log.

## 5. Write your own

In the console, **Editor & AI** gives you a manifest editor that checks as you type. Start from the
template, or from an existing workflow (**New version**), or describe what you want and let the AI
assistant draft it (needs `OMNIFLOW_LLM_API_KEY`). A draft is never live: you review it and publish it.

From the CLI:

```bash
omniflow validate my-workflow.yaml       # errors and warnings, with source lines
omniflow dev my-workflow.yaml            # try it end to end, nothing persisted
omniflow publish my-workflow.yaml        # for real (may open a change request in production)
```

Then read **[Writing workflows](workflow-authoring.md)**.

## 6. Before you rely on it

- Put HTTPS in front of it and set `OMNIFLOW_PUBLIC_URL` and `OMNIFLOW_TRUST_PROXY=true` —
  `docker compose --profile tls up -d` does it with Caddy. See [Operations](operations.md#https).
- Set up [backups](operations.md#backups) and store the master key separately.
- Configure an [alert channel](operations.md#alerts) so failures reach you.
- Run `omniflow admin doctor` — it checks the things you would otherwise check by hand.
- Bringing existing jobs over? `omniflow import crontab /etc/crontab` turns each cron line into a
  supervised workflow draft ([details](workflow-authoring.md#migrating-what-you-already-have)).
