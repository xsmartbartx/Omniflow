# Getting started

This takes about ten minutes and ends with a workflow that pauses for a human approval.

## 1. Install

### Docker Compose (recommended)

```bash
git clone <this repository> constans && cd constans
cp .env.example .env
```

Edit `.env` and set at least:

- `CONSTANS_ADMIN_PASSWORD` — the first administrator's password (you are asked to change it at first sign-in).
  If you leave it empty a random one is generated and printed once in the server log.
- `CONSTANS_MASTER_KEY` — encrypts stored secrets. `openssl rand -base64 32` makes one. If empty, a key is
  generated into the data volume; fine for a trial, but for anything real supply your own **and keep a copy
  somewhere else** (see [Operations](operations.md#the-master-key)).

```bash
docker compose up -d
docker compose logs -f constans      # wait for "listening"
```

Open <http://localhost:8080> and sign in as `admin@example.com`.

For a trial you can set `CONSTANS_ENV=development`, which relaxes the production publishing gates
(second-person approval for effectful workflows). Use `production` for anything real.

### From source

Requires Node.js 24 or newer.

```bash
npm ci
CONSTANS_ADMIN_PASSWORD='a-long-password-here' npm run dev       # → http://localhost:8080
```

Data goes to `./data` (`CONSTANS_DATA_DIR`). For a production build: `npm run build && npm start`.

### Bare metal (systemd)

See [`deploy/systemd/constans.service`](../deploy/systemd/constans.service) — it documents the install steps
and ships with a sandboxed unit.

## 2. The command-line tool

The CLI is in the container as `constans`, and on your machine after `npm ci` as `node cli/main.ts`
(or `npm link` to get `constans` on your PATH). Two things need no server at all:

```bash
constans validate workflows/            # check manifests; errors point at the offending line
constans dev workflows/hello-world.yaml --input name=Ada     # run one on a throw-away platform
```

Everything else talks to a server. Create an API key on the machine that holds the data (this needs no
login — it is the break-glass path for a fresh install):

```bash
docker compose exec constans constans admin create-api-key --name laptop --role admin
```

```bash
export CONSTANS_URL=http://localhost:8080
export CONSTANS_API_KEY=cns_…           # the key it printed — it is shown once
constans status
```

Give a key only the roles it needs: `viewer` (read), `operator` (run, cancel), `author` (write and publish
workflows), `approver` (decide approvals), `admin` (everything).

## 3. Publish and run a workflow

The repository ships examples in `workflows/`. Publish them:

```bash
docker compose exec constans constans publish /app/workflows       # or, from your checkout: constans publish workflows/
```

Run one and watch it:

```bash
constans run hello-world --input name=Ada --wait
```

`--wait` streams each event as it happens and exits `0` only if the run succeeded — handy in scripts and CI.

Open the console (**Runs**) to see the same run with its graph, timings and inputs/outputs. **Workflows →
hello-world → Docs** shows the generated documentation and diagram.

## 4. Make a workflow wait for a person

`approval-gated-refund` pauses at an approval step. Start it:

```bash
constans run approval-gated-refund --input orderId=A-1042 --input amount=129.90
constans approvals                       # it is waiting
```

The run cannot be approved by whoever started it (four-eyes). Sign in to the console as a *different*
person — create one under **Users & keys** — and press **Approve** in the **Approvals** inbox, or:

```bash
CONSTANS_API_KEY=<another key> constans approvals approve <id> --comment "checked with finance"
```

The run resumes, finishes, and every step — including who approved, when, and why — is in the audit log.

## 5. Write your own

In the console, **Editor & AI** gives you a manifest editor that checks as you type. Start from the
template, or from an existing workflow (**New version**), or describe what you want and let the AI
assistant draft it (needs `CONSTANS_LLM_API_KEY`). A draft is never live: you review it and publish it.

From the CLI:

```bash
constans validate my-workflow.yaml       # errors and warnings, with source lines
constans dev my-workflow.yaml            # try it end to end, nothing persisted
constans publish my-workflow.yaml        # for real (may open a change request in production)
```

Then read **[Writing workflows](workflow-authoring.md)**.

## 6. Before you rely on it

- Put HTTPS in front of it and set `CONSTANS_PUBLIC_URL` and `CONSTANS_TRUST_PROXY=true` —
  `docker compose --profile tls up -d` does it with Caddy. See [Operations](operations.md#https).
- Set up [backups](operations.md#backups) and store the master key separately.
- Configure an [alert channel](operations.md#alerts) so failures reach you.
- Run `constans admin doctor` — it checks the things you would otherwise check by hand.
- Bringing existing jobs over? `constans import crontab /etc/crontab` turns each cron line into a
  supervised workflow draft ([details](workflow-authoring.md#migrating-what-you-already-have)).
