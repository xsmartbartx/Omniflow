# Operations

A runbook for whoever keeps OmniFlow running. Everything here has a command; the ones that matter most
(`doctor`, `backup`, `restore`) are exercised end to end by [`deploy/smoke-test.sh`](../deploy/smoke-test.sh).

- [How it runs](#how-it-runs) · [Deploy](#deploy) · [HTTPS](#https)
- [First-day checklist](#first-day-checklist)
- [Backups](#backups) · [Restore](#restore) · [The master key](#the-master-key)
- [Upgrades](#upgrades)
- [Monitoring](#monitoring) · [Alerts](#alerts)
- [Capacity](#capacity-and-limits) · [Troubleshooting](#troubleshooting)

## How it runs

One Node.js process serves the API and console, runs the scheduler, orchestrator and background loops,
and owns one SQLite database in WAL mode (`OMNIFLOW_DATA_DIR/omniflow.db`). There is nothing else to run:
no queue, no cache, no separate database server.

- **Single node by design.** Never run two servers against the same data directory. On Kubernetes that means
  `replicas: 1` with a `Recreate` rollout; the shipped manifest does this.
- **Restart is the recovery story.** On boot the orchestrator finds every interrupted run and resumes it:
  in-flight steps are re-dispatched with the *same attempt number and idempotency key*, so effects are not
  repeated. Stop with `SIGTERM` (Docker/systemd/Kubernetes do): it stops taking work, lets in-flight steps
  finish (up to 15 s), checkpoints the database and exits.
- **State** lives in the data directory: `omniflow.db` (+ `-wal`/`-shm` while running), `artifacts/` (large
  step outputs, content-addressed), `master.key` if you did not supply one.

## Deploy

| Where | How |
|---|---|
| One host with Docker | `cp .env.example .env && docker compose up -d` — hardened: non-root, read-only root filesystem, no capabilities, `no-new-privileges`. |
| Kubernetes | [`deploy/k8s/omniflow.yaml`](../deploy/k8s/omniflow.yaml): ConfigMap, PVC, single-replica Deployment, Service, Ingress, egress `NetworkPolicy`, nightly backup `CronJob`. Build and push your own image first. |
| Bare metal / VM | [`deploy/systemd/omniflow.service`](../deploy/systemd/omniflow.service) with `npm ci --omit=dev && npm run build`. Needs Node.js 24+. |

Build the image yourself: `docker build -t registry.example.com/omniflow:1.0.0 .` (about 260 MB, Alpine, Node 24).
The release workflow in `.github/workflows/release.yml` builds multi-architecture images with provenance and
an SBOM when you push a `v*.*.*` tag.

### HTTPS

Never expose the plain HTTP port to the internet. Terminate TLS in front of it and tell OmniFlow:

```
OMNIFLOW_PUBLIC_URL=https://omniflow.example.com
OMNIFLOW_TRUST_PROXY=true
```

- **Caddy** (automatic certificates): set `OMNIFLOW_DOMAIN` and run `docker compose --profile tls up -d`;
  see [`deploy/Caddyfile`](../deploy/Caddyfile).
- **nginx**: [`deploy/nginx.conf`](../deploy/nginx.conf).
- **Ingress-nginx**: annotations are in the Kubernetes manifest.

Whatever you use, the live run stream (`/v1/runs/{id}/stream`, server-sent events) must not be buffered and
needs a long read timeout — the provided configs do this. If live logs never appear in the console, this is
the cause.

## First-day checklist

```bash
omniflow admin doctor          # in the container: docker compose exec omniflow omniflow admin doctor
```

`doctor` checks that the data directory is writable and has space, the database passes SQLite's integrity
check, the audit hash chain is intact, every stored secret can be decrypted with the configured key,
`master.key` is not world-readable, an active administrator exists, and — in production — that HTTPS,
proxy trust, and alerting are set up. It exits non-zero on a real problem, so it works as a deployment gate
and a monitoring probe.

Then: change the bootstrap admin's password, create named users instead of sharing it, give integrations
API keys with minimal roles, set an alert channel, schedule backups, and store the master key elsewhere.

## Backups

```bash
omniflow admin backup /data/backups/omniflow-$(date +%F).db
```

This takes a **consistent snapshot while the server is running** (SQLite `VACUUM INTO`) and copies the
artifacts directory beside it as `<file>.artifacts`. It does not include the master key — see below.

- **Docker Compose:** [`deploy/backup.sh`](../deploy/backup.sh) takes a snapshot, copies it out of the volume,
  verifies the audit chain, and prunes old ones. Cron it: `17 2 * * * cd /srv/omniflow && deploy/backup.sh /srv/backups`.
- **Kubernetes:** the shipped `CronJob` writes to `/data/backups` on the volume (keeping 14); copy them off
  the cluster with your volume-snapshot tooling.
- **Test your restores.** A backup you have not restored is a hope.

## Restore

Restore onto a **stopped** server (it refuses if the database is in use):

```bash
docker compose stop omniflow
docker compose run --rm --no-deps omniflow omniflow admin restore /data/backups/omniflow-2026-06-01.db --yes
docker compose start omniflow
docker compose exec omniflow omniflow admin doctor
```

`restore` first verifies the snapshot on a scratch copy — SQLite integrity *and* the audit hash chain of every
workspace — and refuses a damaged or tampered backup. It keeps the database it replaces as
`omniflow.db.pre-restore-<timestamp>`, and restores the artifacts if present. Restoring onto a fresh host
into an empty data directory works the same way (drop `--yes`).

## The master key

Stored secrets are encrypted with `OMNIFLOW_MASTER_KEY`. A backup contains the ciphertext and *not* the key.

- **Keep a copy of the key somewhere that is not the same disk as the data.** Without it a restore has
  every workflow, run and audit record but no secrets.
- In production supply the key from your secret manager rather than letting OmniFlow generate `master.key`.
- `omniflow admin doctor` verifies that the key you have decrypts what is stored.

**Rotating the key:** set the new key as `OMNIFLOW_MASTER_KEY` and the old one in
`OMNIFLOW_PREVIOUS_MASTER_KEYS`, restart, then run `omniflow admin rotate-master-key`. Every secret is
re-encrypted under the new key; when `doctor` reports none are left on an older key, remove
`OMNIFLOW_PREVIOUS_MASTER_KEYS`.

## Upgrades

1. Read `CHANGELOG.md` for the version.
2. **Take a backup** and check `omniflow admin doctor` first.
3. Pull/build the new image and restart (`docker compose pull && docker compose up -d`, or roll the
   Kubernetes Deployment). Database migrations run automatically at start-up, inside a transaction.
4. Check `omniflow status` and `omniflow admin doctor`; open the console.

Published workflow versions are immutable and stored with their compiled plan, so an upgrade never changes
what an existing version does; runs in flight across a restart resume on the plan they started with.
To go back, restore the pre-upgrade backup on the old image (downgrading across a migration is not
supported).

## Monitoring

- **Liveness / readiness:** `GET /healthz` (process is up) and `GET /readyz` (database reachable). The image
  ships a Docker `HEALTHCHECK`; Kubernetes probes are in the manifest.
- **Metrics:** `GET /metrics` in Prometheus format (auth: `OMNIFLOW_METRICS_TOKEN` or an API key with audit
  access). Series are listed in [the API guide](api.md#metrics). Useful alerts on them:
  `rate(omniflow_runs_total{status="failed"}[15m])`, `omniflow_queue_depth > 0` for a while,
  `omniflow_circuit_open == 1`, `omniflow_approvals_pending` growing.
- **Logs:** JSON lines on stdout (`docker compose logs -f omniflow`); secrets are redacted, and every request
  and error carries a `requestId`.
- **The dashboard and Insights page** show outcomes, latency, cost, failing steps and open alerts.

### Alerts

OmniFlow watches itself and tells you, once, when something needs a person — and when it is over:

| Alert | Fires when |
|---|---|
| `workflow-failing:<name>` | at least half of ≥4 runs finished in the last 30 minutes failed (critical at 80%) |
| `runs-stalled:<name>` | a run has been "running" for 30 minutes with no step making progress |
| `approvals-waiting` | an approval has waited over an hour |
| `queue-backlog` | 50 runs queued, or the oldest has waited over 5 minutes |
| `circuit-open:<capability>` | a capability's circuit breaker is open (a dependency is down) |
| `audit-integrity` | the audit hash chain fails verification (checked every 6 hours) — treat as a security incident |

Alerts appear on the dashboard and Insights page and are written to the audit log. To also send them to chat,
define a channel and name it:

```
OMNIFLOW_CHANNELS={"ops":"https://hooks.slack.com/services/T000/B000/XXXX"}
OMNIFLOW_ALERT_CHANNELS=ops
```

An alert is delivered once when raised, reminded every six hours while it persists, and announced when it
resolves. A failed delivery is logged and never blocks alerting. Open alerts survive a restart.

The **Analysis Agent** (daily, `OMNIFLOW_ANALYSIS_INTERVAL_HOURS`) reads run history and files *suggestions*
on the Insights page: steps whose failures are ignored, retry storms, duplicated workflows, cost hotspots,
rubber-stamp approvals, shell steps past their sunset, schedule drift, unexercised compensation. It writes
only to that suggestion queue.

## Capacity and limits

- Sized for many thousands of runs a day on one modest host; give it CPU/RAM rather than replicas.
  `OMNIFLOW_MAX_CONCURRENT_RUNS` / `_STEPS` bound the parallelism; the queue absorbs bursts.
- SQLite is fast but single-writer: the design accepts that in exchange for simplicity. Put the data directory
  on local SSD-backed storage, not a network filesystem.
- Large step outputs are stored as content-addressed artifacts, not in the database; events are capped at
  64 KiB of data each. Plan storage for the audit log (append-only, never pruned) — it grows steadily.
- The audit log and run history are retained until you decide otherwise; there is no automatic purge.
- **HA** means fast restart and tested restores, not two copies. Expect a few seconds of downtime on restart;
  scheduled triggers missed while down fire on recovery (`catchup: latest`) or are dropped (`none`),
  per trigger.

## Troubleshooting

| Symptom | Look at |
|---|---|
| Server exits at start with `Invalid configuration: <VAR> …` | The named variable; nothing is ignored silently. |
| Exits with `Invalid policy file …` | A file in `OMNIFLOW_POLICY_DIR` does not parse — fix or remove it. |
| Can't sign in / locked out | `omniflow admin reset-password --email you@…` (on the host). Five failures lock an account for 15 minutes. |
| No API key yet | `omniflow admin create-api-key --name me --role admin` on the host. |
| Console loads but the run page never updates | The proxy is buffering server-sent events; see [HTTPS](#https). |
| Sign-in "works" but you are sent straight back to the login page | `OMNIFLOW_PUBLIC_URL` is `https://` but you are browsing over plain `http://`: the `Secure` session cookie is dropped by the browser. Use the https URL (or set the public URL to match). |
| A run is stuck in `waiting-approval` | `omniflow approvals`; a different person must decide, and `alerts` will flag it after an hour. |
| A step fails with `EGRESS_DENIED` | The step must list the host in `egress`, and private addresses need `OMNIFLOW_ALLOW_PRIVATE_EGRESS`. |
| `Capability 'x' is not registered` | It needs configuration to exist (`OMNIFLOW_SHELL_ALLOWED_COMMANDS`, `_DATASOURCES`, `_CHANNELS`, `_SMTP_URL`, `_LLM_API_KEY`). |
| A publish opened a change request instead | Production policy needs a second person; `omniflow changes` shows why and who can approve. |
| `doctor` says secrets cannot be decrypted | The master key differs from the one they were written with — restore the right key. |
| `doctor` says the audit chain is broken | Something modified history. Preserve the database and the latest good backup, then investigate. |
| Disk filling | `artifacts/` and the audit log only grow; check `doctor`'s disk line, and back up then archive. |
| Kill switch / rollback in an incident | `omniflow workflows kill <name> --reason …`; `omniflow workflows activate <name> <old-version>`; and to stop everything that uses a broken integration, kill the capability in the console (**Capabilities**). |
