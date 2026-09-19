# Configuration

OmniFlow is configured entirely through environment variables, read once at start-up. A malformed value
stops the server with a message naming the variable — nothing is silently ignored. Run
`omniflow admin doctor` to check a deployment. [`.env.example`](../.env.example) is a ready-to-copy template;
a test keeps it, this page and the code in step.

Docker Compose reads `.env` next to `docker-compose.yml` (or the file named by `OMNIFLOW_ENV_FILE`).

## Core

| Variable | Default | |
|---|---|---|
| `OMNIFLOW_ENV` | `production` | `development`, `staging` or `production`. Production applies the strictest publishing gates: workflows with effectful or shell steps, high criticality or high risk need a second person's approval. |
| `OMNIFLOW_DATA_DIR` | `./data` (`/data` in the image) | Database, artifacts and (if not supplied) the generated master key. Back this up. |
| `OMNIFLOW_HOST` / `OMNIFLOW_PORT` | `0.0.0.0` / `8080` | Listen address. |
| `OMNIFLOW_PUBLIC_URL` | `http://localhost:<port>` | The URL people use. `https://` marks session cookies `Secure`, and is what webhook URLs shown in the console are built from. |
| `OMNIFLOW_TRUST_PROXY` | `false` | Trust `X-Forwarded-*` from a reverse proxy, so rate limits and the audit log see real client addresses. Only enable behind a proxy you control. |
| `OMNIFLOW_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent`. Logs are JSON lines on stdout with secrets redacted. |
| `OMNIFLOW_ADMIN_EMAIL` | `admin@omniflow.local` | The first administrator, created only when there are no users. |
| `OMNIFLOW_ADMIN_PASSWORD` | *(generated)* | If unset, a random password is generated and printed once to the server's terminal; the account must change it at first sign-in. |

## Secrets and keys

| Variable | Default | |
|---|---|---|
| `OMNIFLOW_MASTER_KEY` | *(generated into the data dir)* | Base64 32-byte key encrypting stored secrets (AES-256-GCM, bound to tenant and name). Generate: `openssl rand -base64 32`. **Losing it makes stored secrets unrecoverable.** |
| `OMNIFLOW_PREVIOUS_MASTER_KEYS` | | Comma-separated older keys, kept readable during a rotation. Then run `omniflow admin rotate-master-key`. |
| `OMNIFLOW_METRICS_TOKEN` | | Bearer token for `GET /metrics`. Without it, only API keys with audit access can scrape. |

## Governance

| Variable | Default | |
|---|---|---|
| `OMNIFLOW_PUBLISH_APPROVALS` | `1` | How many distinct people must approve a production change that needs review (1–5). |
| `OMNIFLOW_POLICY_DIR` | `./policies` (`/etc/omniflow/policies` in the image) | Directory of `kind: Policy` documents ([examples](../policies/examples/house-rules.yaml)). A rule that fails to parse stops the server — a broken governance rule is never silently skipped. |
| `OMNIFLOW_WORKFLOWS_DIR` | `./workflows` (`/app/workflows` in the image) | Where seeded example workflows come from. |
| `OMNIFLOW_SEED_EXAMPLES` | `false` | Publish the example workflows at start-up (those needing review are left as change requests). |

## Capacity and limits

| Variable | Default | |
|---|---|---|
| `OMNIFLOW_MAX_CONCURRENT_RUNS` | `16` | Runs executing at once (1–1000). Others queue. |
| `OMNIFLOW_MAX_CONCURRENT_STEPS` | `32` | Step attempts in flight (1–1000). |
| `OMNIFLOW_SESSION_TTL_HOURS` | `12` | Console session lifetime (1–720). |
| `OMNIFLOW_RATE_LIMIT_PER_MIN` | `600` | Per-principal API rate limit (10–100000). Login and webhooks have their own, stricter limits. |

## Insight and alerting

| Variable | Default | |
|---|---|---|
| `OMNIFLOW_CHANNELS` | `{}` | JSON object `name → webhook URL` for chat/webhook channels. Prefix a URL with `slack:`, `teams:`, `discord:` or `generic:` to choose the payload format (Slack-style is the default). Enables the `notify-channel` capability. |
| `OMNIFLOW_ALERT_CHANNELS` | | Comma-separated channel names that receive alerts. Must be defined in `OMNIFLOW_CHANNELS`. |
| `OMNIFLOW_ANALYSIS_INTERVAL_HOURS` | `24` | How often the Analysis Agent reviews run history and files improvement proposals. `0` disables it. |
| `OMNIFLOW_ALERT_INTERVAL_SECONDS` | `60` | How often alert conditions are evaluated (5–3600). |

## Capabilities

| Variable | Default | |
|---|---|---|
| `OMNIFLOW_STORAGE_DIR` | `<data dir>/files` | Root that the `file-*` capabilities are confined to. |
| `OMNIFLOW_DATASOURCES` | `{}` | JSON `name → URL` (`postgres://…` or `sqlite:///path`). Enables `database-query` / `database-command`. |
| `OMNIFLOW_SMTP_URL` / `OMNIFLOW_SMTP_FROM` | | SMTP connection (`smtps://user:pass@host:465`) and sender. Enables `notify-email`. |
| `OMNIFLOW_LLM_API_KEY` (or `ANTHROPIC_API_KEY`) | | Enables `llm-inference` and AI authoring (Planner, script importer). |
| `OMNIFLOW_LLM_MODEL` | `claude-sonnet-5` | Model used for both. |
| `OMNIFLOW_LLM_BASE_URL` | `https://api.anthropic.com` | Point at a compatible gateway if you need one. |
| `OMNIFLOW_SHELL_ALLOWED_COMMANDS` | | Comma-separated **absolute** paths `shell-exec` may run. Empty disables shell steps entirely. |
| `OMNIFLOW_ALLOW_PRIVATE_EGRESS` | `false` | Let allow-listed hosts resolve to private/loopback addresses (needed for on-prem APIs and compose service names). |

## Docker Compose only

| Variable | Default | |
|---|---|---|
| `OMNIFLOW_BIND` | `127.0.0.1` | Host address the port is published on. Keep loopback behind a proxy. |
| `OMNIFLOW_DOMAIN` | `localhost` | Hostname Caddy gets a certificate for (`--profile tls`). |
| `OMNIFLOW_IMAGE` | `omniflow:latest` | Image name to build/run. |
| `OMNIFLOW_ENV_FILE` | `.env` | Which env file to load. |

## Command-line client

| Variable | |
|---|---|
| `OMNIFLOW_URL` | Server to talk to (default `http://127.0.0.1:8080`). |
| `OMNIFLOW_API_KEY` | API key to authenticate with. |
| `OMNIFLOW_SECRET_VALUE` | Value for `omniflow secrets set NAME` when not piped on stdin. |
| `OMNIFLOW_NEW_PASSWORD` | Password for `omniflow admin create-user` (otherwise a temporary one is generated). |
| `NO_COLOR` | Disable coloured output. |

`omniflow admin …` commands run against a data directory directly and read `OMNIFLOW_DATA_DIR`,
`OMNIFLOW_MASTER_KEY` and `OMNIFLOW_PREVIOUS_MASTER_KEYS` like the server does.
