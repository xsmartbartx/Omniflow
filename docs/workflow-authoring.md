# Writing workflows

A workflow is a YAML **manifest**: data, not code. It says *when* to run, *what it needs*, and *which steps
to take in which order* — and nothing about how the engine does it. Because it is data, OmniFlow can prove a
lot about it before it runs.

Every complete manifest in this guide is checked by the test suite, so they compile as written.

- [Anatomy](#anatomy)
- [Triggers](#triggers) · [Inputs](#inputs) · [Steps](#steps) · [Expressions](#expressions)
- [Errors, retries and idempotency](#errors-retries-and-idempotency)
- [Compensation (undoing work)](#compensation-undoing-work)
- [Approvals](#approvals) · [Guards and limits](#guards-and-limits)
- [Testing](#testing) · [Versions and rollout](#versions-and-rollout)
- [Migrating what you already have](#migrating-what-you-already-have) · [AI-assisted authoring](#ai-assisted-authoring)

## Anatomy

```yaml
apiVersion: omniflow.dev/v1
kind: Workflow
metadata:
  name: order-router            # kebab-case, unique per workspace
  version: 1.0.0                # semver; a published version is immutable
  owner: ops@example.com        # someone accountable
  description: Routes a batch of orders — big ones to review, the rest straight through.
  criticality: low              # low | medium | high | critical (drives approval policy)
triggers:
  - type: manual
inputs:
  orders:
    type: array
    required: true
    maxItems: 100
steps:
  - id: classify
    type: map
    items: "inputs.orders"
    maxItems: 100
    uses: util-echo@^1
    with:
      value: "${{ item.id }}"
  - id: any-large
    type: branch
    dependsOn: [classify]
    cases:
      - name: has-large
        when: "len(inputs.orders) > 0 && max(pluck(inputs.orders, 'total')) >= 1000"
    default: all-small
outputs:
  needsReview: "${{ steps.any-large.output.case == 'has-large' }}"
```

The top-level keys are `metadata`, `triggers`, `inputs`, `steps`, and optionally `outputs`, `guards`,
`policy`, `observability` and `context`. Unknown keys are errors, with a suggestion when you mistype one.
The complete schema is [`schemas/manifest.schema.json`](../schemas/manifest.schema.json).

## Triggers

A workflow can have several. Each starts a run with inputs.

```yaml
triggers:
  - type: manual                                   # a person or the API
  - type: schedule
    name: weekday-morning
    cron: "0 8 * * 1-5"                            # 5 fields (6 with seconds)
    timezone: Europe/Warsaw
    inputs: { region: emea }                       # static inputs for scheduled runs
    catchup: none                                  # none | latest: what to do with firings missed while down
  - type: webhook
    name: order-created                            # → POST /v1/hooks/<tenant>/<workflow>/order-created
    inputs:
      orderId: "${{ event.payload.orderId }}"      # map the JSON body onto workflow inputs
  - type: event
    event: payment.received                        # published with POST /v1/events
    filter: "event.payload.amount > 0"
  - type: workflow-completion
    workflow: nightly-import
    status: failed                                 # succeeded | failed | any
```

Webhooks are **signed**: create the signing secret in the console (**Triggers → Signing secret**) and
see [the API guide](api.md#webhooks) for how to sign a delivery. Replays and stale deliveries are rejected.

## Inputs

```yaml
inputs:
  orderId: { type: string, required: true, pattern: "^A-[0-9]+$" }
  amount:  { type: number, required: true, minimum: 0.01, maximum: 10000 }
  region:  { type: string, default: emea, enum: [emea, amer, apac] }
  card:    { type: string, sensitivity: secret }        # never shown in the console or logs
```

Types: `string`, `integer`, `number`, `boolean`, `object`, `array`. Inputs are validated *strictly* (no
silent coercion) before a run starts. `sensitivity` (`public` · `internal` · `confidential` · `secret`)
flows through the plan: anything derived from a `secret` input is redacted from history, and steps that
handle `confidential` data are held to stricter policy.

## Steps

Every step has an `id` (kebab-case, unique) and a `type`. Steps run as soon as everything in
`dependsOn` has succeeded; independent steps run in parallel. Common options on any step:

| Option | Meaning |
|---|---|
| `dependsOn: [ids]` | Run after these. No cycles; references must point at (transitive) dependencies. |
| `when: "<expression>"` | Skip the step unless this is true. |
| `timeout: 30s` | Fail the attempt after this long. Defaults come from `policy.timeout`. |
| `retry: {…}` | See [errors and retries](#errors-retries-and-idempotency). |
| `idempotencyKey: "<template>"` | Required for effectful capabilities. |
| `onError: fail \| continue \| compensate \| { routeTo: id }` | What a failure means for the run. |
| `compensate: {…}` | How to undo this step. |
| `sensitivity`, `produces` | Data classification; a JSON Schema for the output so downstream references are checked. |

### `capability` — do something

```yaml
- id: fetch-rates
  type: capability
  uses: http-get@^1              # name@version-constraint (see the catalogue)
  egress: [api.example.com]      # network capabilities must name the hosts they may reach
  with:
    url: "https://api.example.com/rates?base=${{ inputs.currency }}"
```

`with` is checked against the capability's input schema at compile time. Unknown fields, wrong types and
missing required fields are errors on the line they occur. Browse what is available in the
[capability catalogue](reference/capabilities.md).

### `branch` — choose a path

```yaml
- id: size
  type: branch
  dependsOn: [fetch-order]
  cases:
    - { name: large, when: "steps.fetch-order.output.total >= 1000" }
    - { name: medium, when: "steps.fetch-order.output.total >= 100" }
  default: small
- id: alert-finance
  type: capability
  uses: util-noop@^1
  dependsOn: [size]
  when: "steps.size.output.case == 'large'"
```

The chosen name is `steps.<id>.output.case`. Steps downstream of a branch use `when` to pick their side.

### `map` — do it for each item

```yaml
- id: enrich
  type: map
  items: "inputs.customers"      # a bare expression yielding an array
  maxItems: 200                  # a hard bound, enforced at compile time and at run time
  concurrency: 10
  errorTolerance: { percent: 5 } # how many item failures the step tolerates
  uses: util-echo@^1
  with: { value: "${{ item.id }}" }
```

### `parallel`, `wait`, `subworkflow`, `terminate`

```yaml
- { id: join, type: parallel, join: all, dependsOn: [a, b, c] }      # all | any (first success wins)
- { id: settle, type: wait, duration: 10m }                           # …or: until: { event: payment.received }
- { id: child, type: subworkflow, workflow: send-receipt, version: 1.2.0, with: { orderId: "${{ inputs.orderId }}" } }
- { id: stop, type: terminate, status: failure, errorClass: business, message: Not eligible }
```

Subworkflows are always pinned to an exact version, and their cost and depth count against the parent's
limits. `wait` costs nothing while it waits.

## Expressions

Expressions appear in `${{ … }}` templates inside strings, and bare in `when`, `items`, `filter` and
guards. The language is small on purpose: **it cannot loop, assign, or reach the outside world**, so any
expression is guaranteed to finish and to give the same answer twice.

**Scopes.** `inputs.<name>` · `steps.<id>.output.<field>` · `steps.<id>.status` · `context.<key>`
(deployment facts plus `context.now`, the run's start time) · `run.id`, `run.dryRun` ·
`secrets.<NAME>` (only inside a step's `with`) · `item` (inside `map`) · `event` (inside webhook/event
trigger inputs).

**Operators.** `+ - * / %`, `== != < <= > >=`, `&& || !`, `? :`, `in` (membership), property access
`a.b`, indexing `a[0]` / `a["odd-key"]`. `+` also joins strings. A missing property is `null`, not an
error. A template that is exactly one `${{ … }}` keeps its type (`"${{ inputs.n }}"` is a number);
embedded in text it becomes text.

**Functions** (the complete list; anything else is a compile error):

| | |
|---|---|
| Strings | `len lower upper trim contains startsWith endsWith join split replace slice toString` |
| Collections | `len keys values pluck first last unique sort contains slice join` |
| Numbers | `sum min max round floor ceil abs toNumber` |
| Data | `toJson fromJson hash isNull` |
| Time (pure) | `dateAdd date epochMs` — arithmetic on ISO timestamps; nothing reads the clock |
| Deterministic ids | `uuid` — derived from the run's seed, so a replay produces the same ids |

```yaml
value: "${{ round(sum(pluck(steps.load.output.rows, 'total')) / len(steps.load.output.rows), 2) }}"
```

Names with dashes are fine after a dot: `steps.fetch-order.output.total`.

## Errors, retries and idempotency

Every failure carries a **class**, and the class decides what happens — no guessing:

| Class | Meaning | Default |
|---|---|---|
| `transient` | A blip: timeout, 503, connection reset | retried |
| `systemic` | A dependency is down (circuit open) | retried; alerts fire |
| `contract` | The data did not match what was declared | not retried |
| `business` | The other side said no (declined, out of stock) | not retried |
| `authorisation` | Not allowed (bad credential, blocked host) | not retried |

```yaml
retry:
  attempts: 4                    # total, including the first
  backoff: exponential           # fixed | exponential
  initialDelay: 2s
  maxDelay: 1m
  jitter: 0.2                    # seeded from the run, so replays wait the same
  retryOn: [transient, systemic] # narrow or widen the classes that may be retried
```

`onError` decides what a step's *final* failure means: `fail` (the default) fails the run and starts
compensation; `continue` records it and carries on; `{ routeTo: <step> }` diverts to a fallback step (which
must depend on the failing one); `compensate` starts rollback explicitly.

**Effectful steps must be idempotent.** A capability that changes the world (`effect: effectful`) requires
an `idempotencyKey`. OmniFlow records the key *before* it acts and passes it downstream, so a retry, a
crash-recovery or a duplicate delivery never repeats the effect. Make keys meaningful and stable:

```yaml
idempotencyKey: "charge-${{ inputs.orderId }}"        # good: same order → same charge
idempotencyKey: "${{ run.id }}"                       # only right if a new run should act again
```

## Compensation (undoing work)

A step can declare how to undo itself. If the run later fails, completed steps are compensated **in reverse
order**; a compensation that itself fails ends the run as `compensation-failed` and alerts loudly — it never
pretends everything is fine.

```yaml
apiVersion: omniflow.dev/v1
kind: Workflow
metadata:
  name: order-fulfilment
  version: 1.0.0
  owner: ops@example.com
  description: Reserves stock, charges the customer, and undoes the reservation if the charge fails.
  criticality: high
triggers:
  - type: webhook
    name: order-created
    inputs:
      orderId: "${{ event.payload.orderId }}"
      amount: "${{ event.payload.amount }}"
inputs:
  orderId: { type: string, required: true }
  amount: { type: number, required: true, minimum: 0.01 }
guards:
  pre:
    - { name: sane-amount, expr: "inputs.amount < 100000", message: Refuse implausibly large orders }
policy:
  maxRunCost: 20
  dedupKey: "${{ inputs.orderId }}"
  dedupWindow: 1h
steps:
  - id: reserve-stock
    type: capability
    uses: file-write@^1
    with:
      path: "reservations/${{ inputs.orderId }}.txt"
      content: reserved
    idempotencyKey: "reserve-${{ inputs.orderId }}"
    timeout: 20s
    compensate:
      uses: file-delete@^1
      with: { path: "reservations/${{ inputs.orderId }}.txt" }
      idempotencyKey: "release-${{ inputs.orderId }}"
  - id: charge
    type: capability
    uses: notify-webhook@^1
    dependsOn: [reserve-stock]
    egress: [payments.example.com]
    with: { url: "https://payments.example.com/charge", format: generic, text: "charge ${{ inputs.amount }}" }
    idempotencyKey: "charge-${{ inputs.orderId }}"
    retry: { attempts: 3, backoff: exponential, initialDelay: 2s, maxDelay: 30s, jitter: 0.2, retryOn: [transient] }
    timeout: 30s
    onError: compensate
outputs:
  charged: "${{ steps.charge.status == 'succeeded' }}"
```

The risk review flags effectful steps that have no compensation. Compensating capabilities must have a static network allow-list or none (they cannot depend on
step-declared hosts, because rollback must not fail on configuration).

## Approvals

```yaml
- id: sign-off
  type: approval
  dependsOn: [validate]
  message: "Refund ${{ inputs.amount }} for order ${{ inputs.orderId }}?"
  approvers: { roles: [approver, admin] }      # and/or users: [ids]
  timeout: 4h
  onTimeout: deny                              # deny | escalate | approve (approve needs a justification)
```

The run pauses at zero cost. **Whoever started the run cannot approve it** (four-eyes) unless the step
opts in with `allowSelfApproval: true` and policy allows it. Decisions, comments and timeouts are audited.
Approvals show up in the console inbox and in `omniflow approvals`, and approvals that wait too long raise an alert.

## Guards and limits

```yaml
guards:
  pre:        [{ name: within-limit, expr: "inputs.amount < 5000", message: Larger refunds follow the manual process }]
  invariants: [{ name: no-negative, expr: "steps.compute.output.total >= 0", message: Total went negative }]
policy:
  timeout: 30s              # default per-step timeout
  retry: { attempts: 3 }    # default retry policy
  concurrency: 1            # at most this many simultaneous runs
  concurrencyPolicy: skip   # skip | queue
  maxRunCost: 50            # abort a run that would exceed this
  maxDailyCost: 500
  dedupKey: "${{ inputs.orderId }}"
  dedupWindow: 1h           # equal keys inside the window are duplicates
```

`pre` guards are checked before the run starts; `invariants` after every step — a violation fails the run.
Cost is in abstract *units* declared by each capability; use it to bound blast radius (an LLM step costs
more than an echo).

## Testing

You can check a workflow at five levels, cheapest first:

```bash
omniflow validate wf.yaml            # syntax, schema, references, capabilities, policy-relevant risk — no server
omniflow compile wf.yaml             # the exact immutable plan and its hash (what the engine will run)
omniflow dev wf.yaml --input k=v     # run it end to end on a throw-away platform; add --secret NAME=value
omniflow dev wf.yaml --dry-run       # effectful steps are simulated, not performed
omniflow run <name> --dry-run --wait # the same, on a real server (the audit log records it as a dry run)
```

`validate` exits non-zero on errors, so it belongs in CI: `omniflow validate workflows/`. Dry runs never
touch the outside world — effectful capabilities return synthetic output shaped by their declared schema —
and they are excluded from every rate, cost and alert.

## Versions and rollout

Published versions are immutable; to change a workflow, publish a new version. In production, changes that
policy flags (effectful steps, shell steps, high criticality, high risk) open a **change request** that a
second person approves, shown as a diff against the active version.

```bash
omniflow publish wf.yaml --canary 10             # send 10% of runs to the new version
omniflow workflows promote my-workflow           # happy? make it the stable version
omniflow workflows rollback-canary my-workflow   # not happy? drop it
omniflow workflows activate my-workflow 1.0.0    # or pin any published version — instant rollback
omniflow workflows kill my-workflow --reason "duplicate charges"   # refuse new runs, cancel queued ones
```

## Migrating what you already have

`omniflow import crontab /etc/crontab` turns each cron job into a draft workflow that wraps the command,
unchanged, in a supervised `shell-exec` step with a **sunset date** — the *Lift* strategy. It gains
retries, timeouts, an audit trail and alerts on day one; the sunset date stops the bridge becoming
permanent, and the Analysis Agent reports any that outlive it. Then replace steps with typed capabilities
one at a time. Commands that need shell syntax (pipes, redirects) are written to a script file rather than
run as `sh -c` strings, because OmniFlow will not run those.

`omniflow import script legacy.sh` asks the AI Planner to propose a *decomposed* workflow instead.

## AI-assisted authoring

With `OMNIFLOW_LLM_API_KEY` set, the console's **Editor & AI** tab and `omniflow plan "<what you want>"`
turn a description into a draft manifest. The Planner sees the capability catalogue and the validator,
repairs its own mistakes, and lists what it had to assume as open questions.

It can only produce a **draft**. There is no route from a model's answer to a published workflow that skips
validation, the pentest-style risk review, policy, and — for anything that matters — a human. Workflows
carry an *autonomy tier*: `T0` advisory only · `T1` draft (default) · `T2` opens a change request ·
`T3` may publish inside a declared blast radius (no confidential data, only reversible effects, bounded
cost, no shell). Set it per workflow (`omniflow workflows autonomy <name> T2`, admins only).
