# Configuration

Constans is configured entirely through environment variables, read once at start-up. A malformed value
stops the server with a message naming the variable — nothing is silently ignored. Run
`constans admin doctor` to check a deployment. [`.env.example`](../.env.example) is a ready-to-copy template;
a test keeps it, this page and the code in step.

Docker Compose reads `.env` next to `docker-compose.yml` (or the file named by `CONSTANS_ENV_FILE`).

## Core

| Variable | Default | |
|---|---|---|
| `CONSTANS_ENV` | `production` | `development`, `staging` or `production`. Production applies the strictest publishing gates: workflows with effectful or shell steps, high criticality or high risk need a second person's approval. |
| `CONSTANS_DATA_DIR` | `./data` (`/data` in the image) | Database, artifacts and (if not supplied) the generated master key. Back this up. |
| `CONSTANS_HOST` / `CONSTANS_PORT` | `0.0.0.0` / `8080` | Listen address. |
| `CONSTANS_PUBLIC_URL` | `http://localhost:<port>` | The URL people use. `https://` marks session cookies `Secure`, and is what webhook URLs shown in the console are built from. |
| `CONSTANS_TRUST_PROXY` | `false` | Trust `X-Forwarded-*` from a reverse proxy, so rate limits and the audit log see real client addresses. Only enable behind a proxy you control. |
| `CONSTANS_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent`. Logs are JSON lines on stdout with secrets redacted. |
| `CONSTANS_ADMIN_EMAIL` | `admin@constans.local` | The first administrator, created only when there are no users. |
| `CONSTANS_ADMIN_PASSWORD` | *(generated)* | If unset, a random password is generated and printed once to the server's terminal; the account must change it at first sign-in. |

## Secrets and keys

| Variable | Default | |
|---|---|---|
| `CONSTANS_MASTER_KEY` | *(generated into the data dir)* | Base64 32-byte key encrypting stored secrets (AES-256-GCM, bound to tenant and name). Generate: `openssl rand -base64 32`. **Losing it makes stored secrets unrecoverable.** |
| `CONSTANS_PREVIOUS_MASTER_KEYS` | | Comma-separated older keys, kept readable during a rotation. Then run `constans admin rotate-master-key`. |
| `CONSTANS_METRICS_TOKEN` | | Bearer token for `GET /metrics`. Without it, only API keys with audit access can scrape. |

## Governance

| Variable | Default | |
|---|---|---|
| `CONSTANS_PUBLISH_APPROVALS` | `1` | How many distinct people must approve a production change that needs review (1–5). |
| `CONSTANS_POLICY_DIR` | `./policies` (`/etc/constans/policies` in the image) | Directory of `kind: Policy` documents ([examples](../policies/examples/house-rules.yaml)). A rule that fails to parse stops the server — a broken governance rule is never silently skipped. |
| `CONSTANS_WORKFLOWS_DIR` | `./workflows` (`/app/workflows` in the image) | Where seeded example workflows come from. |
| `CONSTANS_SEED_EXAMPLES` | `false` | Publish the example workflows at start-up (those needing review are left as change requests). |

## Capacity and limits

| Variable | Default | |
|---|---|---|
| `CONSTANS_MAX_CONCURRENT_RUNS` | `16` | Runs executing at once (1–1000). Others queue. |
| `CONSTANS_MAX_CONCURRENT_STEPS` | `32` | Step attempts in flight (1–1000). |
| `CONSTANS_SESSION_TTL_HOURS` | `12` | Console session lifetime (1–720). |
| `CONSTANS_RATE_LIMIT_PER_MIN` | `600` | Per-principal API rate limit (10–100000). Login and webhooks have their own, stricter limits. |

## Insight and alerting

| Variable | Default | |
|---|---|---|
| `CONSTANS_CHANNELS` | `{}` | JSON object `name → webhook URL` for chat/webhook channels. Prefix a URL with `slack:`, `teams:`, `discord:` or `generic:` to choose the payload format (Slack-style is the default). Enables the `notify-channel` capability. |
| `CONSTANS_ALERT_CHANNELS` | | Comma-separated channel names that receive alerts. Must be defined in `CONSTANS_CHANNELS`. |
| `CONSTANS_ANALYSIS_INTERVAL_HOURS` | `24` | How often the Analysis Agent reviews run history and files improvement proposals. `0` disables it. |
| `CONSTANS_ALERT_INTERVAL_SECONDS` | `60` | How often alert conditions are evaluated (5–3600). |

## Capabilities

| Variable | Default | |
|---|---|---|
| `CONSTANS_STORAGE_DIR` | `<data dir>/files` | Root that the `file-*` capabilities are confined to. |
| `CONSTANS_DATASOURCES` | `{}` | JSON `name → URL` (`postgres://…` or `sqlite:///path`). Enables `database-query` / `database-command`. |
| `CONSTANS_SMTP_URL` / `CONSTANS_SMTP_FROM` | | SMTP connection (`smtps://user:pass@host:465`) and sender. Enables `notify-email`. |
| `CONSTANS_LLM_API_KEY` (or `ANTHROPIC_API_KEY`) | | Enables `llm-inference` and AI authoring (Planner, script importer). |
| `CONSTANS_LLM_MODEL` | `claude-sonnet-5` | Model used for both. |
| `CONSTANS_LLM_BASE_URL` | `https://api.anthropic.com` | Point at a compatible gateway if you need one. |
| `CONSTANS_SHELL_ALLOWED_COMMANDS` | | Comma-separated **absolute** paths `shell-exec` may run. Empty disables shell steps entirely. |
| `CONSTANS_ALLOW_PRIVATE_EGRESS` | `false` | Let allow-listed hosts resolve to private/loopback addresses (needed for on-prem APIs and compose service names). |

## Docker Compose only

| Variable | Default | |
|---|---|---|
| `CONSTANS_BIND` | `127.0.0.1` | Host address the port is published on. Keep loopback behind a proxy. |
| `CONSTANS_DOMAIN` | `localhost` | Hostname Caddy gets a certificate for (`--profile tls`). |
| `CONSTANS_IMAGE` | `constans:latest` | Image name to build/run. |
| `CONSTANS_ENV_FILE` | `.env` | Which env file to load. |

## Command-line client

| Variable | |
|---|---|
| `CONSTANS_URL` | Server to talk to (default `http://127.0.0.1:8080`). |
| `CONSTANS_API_KEY` | API key to authenticate with. |
| `CONSTANS_SECRET_VALUE` | Value for `constans secrets set NAME` when not piped on stdin. |
| `CONSTANS_NEW_PASSWORD` | Password for `constans admin create-user` (otherwise a temporary one is generated). |
| `NO_COLOR` | Disable coloured output. |

`constans admin …` commands run against a data directory directly and read `CONSTANS_DATA_DIR`,
`CONSTANS_MASTER_KEY` and `CONSTANS_PREVIOUS_MASTER_KEYS` like the server does.

## NEXORA integration (optional)

Off unless `CONSTANS_MODE=nexora`. In that mode organisations signing in through NEXORA get their own tenant, runs are
metered against their plan, and usage is reported to NEXORA. **This is a first milestone: only a fake, unsigned NEXORA Core
exists**, so it is for development and staging, and the server refuses to start with it in production.

| Variable | Default | |
|---|---|---|
| `CONSTANS_MODE` | `standalone` | `standalone` (Constans as shipped) or `nexora`. |
| `CONSTANS_NEXORA_CORE` | | Required in `nexora` mode. Only `fake` is accepted; it is refused when `CONSTANS_ENV=production`. |
| `CONSTANS_NEXORA_SESSION_TTL_MINUTES` | `5` | Lifetime of a session created by NEXORA sign-in (1-60). Short on purpose: it bounds how long a removed member keeps access. |
| `CONSTANS_NEXORA_ASSERTION_COOKIE` | `__session` | Name of the cookie that carries the NEXORA identity assertion read by `GET /app`. |
