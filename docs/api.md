# API

OmniFlow's HTTP API is what the console and the CLI use; anything they can do, you can do. The machine
description is the OpenAPI 3.1 document at **`GET /v1/openapi.json`** (generated from the same route
definitions that serve requests, so it cannot lie). This page covers the conventions.

## Authentication

Two ways in, both resolved to a *principal* (a person or an API key) with roles:

- **API keys** for scripts, CI and integrations: `Authorization: Bearer omf_<prefix>_<secret>`. Create one in
  the console (**Users & keys → API keys**), or on the server host with
  `omniflow admin create-api-key --name ci --role operator`. Keys are stored hashed and shown once; they can
  expire and be revoked.
- **Sessions** for people: `POST /v1/auth/login {"email","password"}` sets an `HttpOnly`, `SameSite=Strict`
  cookie. Requests that change state with a cookie must also send `X-Requested-With: omniflow` (CSRF
  protection); Bearer-authenticated requests need no such header.

Roles: `admin`, `author` (write and publish workflows, use AI authoring), `operator` (run, cancel, retry),
`approver` (decide approvals), `viewer` (read). `GET /v1/auth/me` returns your principal and a `can` map of
every action you may perform — the console uses it to hide controls. Passwords are scrypt-hashed; five bad
attempts lock an account for 15 minutes; login is rate-limited per address.

## Conventions

- JSON in, JSON out (`content-type: application/json`). Request bodies are validated **strictly**: unknown
  properties and wrong types are rejected, not coerced. A body whose fields are all optional may be omitted.
- Errors share one shape, with a stable machine-readable `code`:

  ```json
  { "error": { "code": "VALIDATION_FAILED", "message": "The manifest is invalid", "class": "contract",
               "details": { "issues": [ { "path": "steps[0].uses", "code": "UNKNOWN_CAPABILITY",
                                          "message": "Capability 'util-ecoh' is not registered — did you mean 'util-echo'?",
                                          "line": 18, "column": 11 } ] },
               "requestId": "req_01J…" } }
  ```

  | Status | Meaning |
  |---|---|
  | 400 | Validation failed (`details.issues` say where) |
  | 401 | Not signed in / bad key |
  | 403 | Signed in but not allowed (RBAC, policy, four-eyes) |
  | 404 | No such thing in *your* workspace (other workspaces' objects are indistinguishable from missing) |
  | 409 | Conflict: version already published, already decided, workflow killed… |
  | 429 | Rate limited; honour `Retry-After` |
  | 502 / 503 | The AI provider failed / AI authoring is not configured |
  | 500 | A bug; quote `requestId` |

- Lists are newest-first and bounded (`limit`, `offset`/`afterSeq`/`beforeSeq` where relevant).
- Every request gets a `requestId`; it appears in errors and in server logs.

## Endpoint map

Paths are under `/v1`. The *Needs* column names the roles that may call it (`admin` may call everything).

| Area | Endpoints | Needs |
|---|---|---|
| **Meta** | `GET /healthz` · `GET /readyz` · `GET /v1/info` · `GET /v1/openapi.json` · `GET /metrics` | none (metrics: token) |
| **Auth** | `POST /auth/login` · `POST /auth/logout` · `GET /auth/me` · `POST /auth/password` | — |
| **Workflows** | `GET /workflows` · `GET /workflows/{name}` · `GET …/versions/{v}` · `GET …/graph` · `GET …/explain` · `GET …/docs` | any signed-in role |
| | `POST /workflows/validate` (check without saving) · `POST /workflows` (publish, or open a change request) | author |
| | `POST /workflows/{name}/run` | author, operator |
| | `POST /workflows/{name}/{activate\|canary\|promote\|rollback-canary\|deprecate\|enable\|disable\|kill\|revive}` | operator |
| | `POST /workflows/{name}/autonomy` | admin |
| **Change requests** | `GET /changes` · `GET /changes/{id}` | any signed-in role |
| | `POST /changes/{id}/approve` · `POST …/reject` (never by the requester) | approver |
| | `POST /changes/{id}/withdraw` | author (the requester) |
| **Runs** | `GET /runs` · `GET /runs/{id}` · `GET …/events` · `GET …/steps/{step}/output` · `GET …/explain` · `GET …/stream` (live, SSE) | any signed-in role |
| | `POST /runs/{id}/cancel` · `POST …/retry` | operator |
| **Approvals** | `GET /approvals` | any signed-in role |
| | `POST /approvals/{id}/decide` | approver (and named by the step) |
| **Insight** | `GET /insights/overview` · `GET /insights/alerts` · `GET /proposals` · `GET /proposals/{id}` | any signed-in role |
| | `POST /insights/analyze` | author |
| | `POST /proposals/{id}/decide` | author |
| **Authoring** | `GET /drafts` · `GET /drafts/{id}` · `GET /authoring/status` | any signed-in role |
| | `POST /drafts` · `PUT/DELETE /drafts/{id}` · `POST …/validate` · `POST /import/crontab` | author |
| | `POST /drafts/{id}/submit` · `POST …/apply` | author (needs publish rights) |
| | `POST /authoring/plan` · `POST /authoring/from-proposal/{id}` · `POST /import/script` | author (AI) |
| **Docs** | `GET /docs/capabilities` · `GET /docs/workflows` (Markdown) | any signed-in role |
| **Capabilities** | `GET /capabilities` | any signed-in role |
| | `POST /capabilities/{name}/{kill\|revive}` | admin |
| **Secrets** | `GET /secrets` (names and metadata only — values are write-only) | author, operator |
| | `PUT /secrets/{name}` · `DELETE /secrets/{name}` | admin |
| **Triggers** | `GET /triggers` · `GET /channels` | any signed-in role |
| | `POST /workflows/{name}/triggers/{trigger}/rotate-secret` · `POST /events` | operator |
| **Governance** | `GET/POST /users` · `PATCH /users/{id}` · `GET/POST /api-keys` · `DELETE /api-keys/{id}` · `GET/POST /tenants` | admin |
| | `GET /audit/events` · `GET /audit/verify` · `GET /audit/export` (NDJSON) | operator |

## Starting a run

```bash
curl -sS -X POST "$OMNIFLOW_URL/v1/workflows/hello-world/run" \
  -H "Authorization: Bearer $OMNIFLOW_API_KEY" -H 'content-type: application/json' \
  -d '{"inputs":{"name":"Ada"},"correlationId":"order-1042"}'
# 202 {"status":"queued","run":{"id":"run_01J…","status":"queued", …}}
```

Options: `version` (pin instead of the active one), `dryRun`, `priority` (1–9), `correlationId`. A run may be
answered `deduplicated` (the workflow's `dedupKey` matched a recent run) or `skipped` (concurrency policy).
Fetch it with `GET /v1/runs/{id}`: it includes each step's status, attempts, timings and (non-sensitive)
output.

## Streaming a run

`GET /v1/runs/{id}/stream` is a server-sent-event stream. It first **replays** the run's history, then follows
it live, and ends shortly after the run reaches a terminal state. Each frame:

```
id: 42
event: step.succeeded
data: {"seq":42,"type":"step.succeeded","runId":"run_…","stepId":"greet","ts":"…","data":{…}}
```

Send `Last-Event-ID` to resume without gaps. Behind a reverse proxy, disable buffering for this path
(see [Operations](operations.md#https)).

## Webhooks

`POST /v1/hooks/{tenant}/{workflow}/{trigger}` starts a run from an external event. Deliveries are
authenticated with an HMAC over the *exact* body bytes:

```
X-OmniFlow-Timestamp: <unix seconds>
X-OmniFlow-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
X-OmniFlow-Delivery:  <unique id>          (optional; makes retries idempotent)
```

The timestamp must be within five minutes of the server's clock, and a signature is accepted once, so
captured deliveries cannot be replayed. Create or rotate the secret in the console (**Triggers → Signing
secret**) or with `POST /v1/workflows/{name}/triggers/{trigger}/rotate-secret` — the secret is shown once.

```bash
ts=$(date +%s)
body='{"orderId":"A-1042","amount":129.9}'
sig=$(printf '%s.%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
curl -X POST "$OMNIFLOW_URL/v1/hooks/default/order-fulfilment/order-created" \
  -H "X-OmniFlow-Timestamp: $ts" -H "X-OmniFlow-Signature: v1=$sig" \
  -H 'content-type: application/json' -d "$body"
```

```js
// Node
import { createHmac } from 'node:crypto';
const ts = Math.floor(Date.now() / 1000).toString();
const sig = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
headers['X-OmniFlow-Timestamp'] = ts;
headers['X-OmniFlow-Signature'] = `v1=${sig}`;
```

Failed authentication always answers the same way, whatever was wrong (unknown workflow, bad signature,
stale timestamp), so the endpoint reveals nothing to a prober.

## Publishing events

`POST /v1/events {"type":"payment.received","payload":{…},"correlation":"order-1042"}` resumes runs waiting
for that event (a `wait` step with `until`) and fires `event` triggers whose filter matches.

## Metrics

`GET /metrics` speaks the Prometheus text format. Authenticate with `Authorization: Bearer
$OMNIFLOW_METRICS_TOKEN`, or with any API key that may read the audit log (`operator` or `admin`). Series include
`omniflow_runs_total{workflow,status}`, `omniflow_run_duration_seconds`, `omniflow_steps_total{outcome}`,
`omniflow_step_retries_total`, `omniflow_idempotent_replays_total`, `omniflow_policy_denials_total`,
`omniflow_queue_depth`, `omniflow_active_runs`, `omniflow_approvals_pending`, `omniflow_circuit_open{capability}`,
`omniflow_event_log_events` and `omniflow_uptime_seconds`.
