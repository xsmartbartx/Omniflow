# Capabilities

A **capability** is the only way a workflow touches the outside world: an HTTP call, a database query, a
file, a message, a model. Everything a workflow can *do* is a capability; everything else in a manifest is
control flow. That single choke point is what lets OmniFlow reason about workflows before they run.

Each capability is a **declaration** (data) plus an **adapter** (code). The declaration states, up front:

| Field | What it lets OmniFlow do |
|---|---|
| `inputSchema` / `outputSchema` | Check every `with:` block and every downstream reference at compile time; validate outputs at run time. |
| `effect` — `pure` · `idempotent` · `effectful` | Require idempotency keys for effectful steps; retry safely; simulate in dry runs; compute risk. |
| `scopes` (e.g. `db:write`, `network:http`) | Analyse what a *whole workflow* can do in combination — e.g. *read the database + send over HTTP* needs approval as an exfiltration path. |
| `egress` — `none` · `static` hosts · `step` | Default-deny networking: a step may only reach hosts it names, and the SSRF guard checks every resolved address. |
| `failureModes` (code, class, retryable) | Let the engine decide between retry, route, compensate and stop without guessing. |
| `costModel`, `dataClassification`, `dryRun` | Bound spend, gate handling of sensitive data, and define dry-run behaviour. |

Browse the built-ins in the **[capability catalogue](reference/capabilities.md)** (generated from the
declarations, so it is always current), or in the console under **Capabilities**, where operators can also
flip a per-capability **kill switch**.

## Built-ins at a glance

| Family | Capabilities | Available when |
|---|---|---|
| Helpers | `util-echo`, `util-noop`, `util-assert`, `util-fail` | always |
| HTTP | `http-get`, `http-request` | always (SSRF-safe; hosts must be named per step) |
| Files | `file-read`, `file-list`, `file-write`, `file-delete` | always (confined to `OMNIFLOW_STORAGE_DIR`) |
| Notifications | `notify-webhook` | always |
| | `notify-channel` | `OMNIFLOW_CHANNELS` is set |
| | `notify-email` | `OMNIFLOW_SMTP_URL` is set |
| Databases | `database-query`, `database-command` | `OMNIFLOW_DATASOURCES` is set |
| Shell | `shell-exec` | `OMNIFLOW_SHELL_ALLOWED_COMMANDS` is set |
| AI | `llm-inference` | `OMNIFLOW_LLM_API_KEY` is set |

A capability that is not configured simply does not exist: a workflow that uses it fails validation with
"not registered", instead of failing at 3 a.m.

## Notes on the sharp ones

- **`http-*`** — the destination host must be in the step's `egress` list. Private, loopback and link-local
  addresses are refused *after DNS resolution* (defeating rebinding) unless the operator sets
  `OMNIFLOW_ALLOW_PRIVATE_EGRESS`. Redirects are not followed; responses are size-capped.
- **`shell-exec`** — an argument *vector* (never a shell string), an executable on the operator's absolute-path
  allow-list, a scrubbed environment, a throw-away working directory, a size-capped output, and the whole
  process group killed on timeout or cancel. Every shell step **must carry a `sunset` date**. OmniFlow does
  not sandbox the process beyond that: run it in a container with no access to anything you would not hand the
  script, ideally a dedicated network-restricted runner.
- **`database-*`** — parameterised statements only. `database-command` records its idempotency key *in the
  same transaction* as the change, so it happens exactly once.
- **`llm-inference`** — treat the model as a component whose output must be validated. Untrusted content goes
  in `data` (framed as data, never as instructions); give it a `schema` to get validated JSON; a schema
  violation is an ordinary, retryable failure.

## Adding your own

You do not fork OmniFlow to add a capability: you build a small distribution that registers it next to the
built-ins. [`examples/custom-capability/server.ts`](../examples/custom-capability/server.ts) is a complete,
tested example:

```ts
import { CapabilityError, createDefaultRegistry, defineCapability } from '../../capabilities/index.ts';

export const lookupCustomer = defineCapability<{ customerId: string }, { name: string; tier: 'free' | 'pro' }>({
  declaration: {
    name: 'acme-lookup-customer',
    version: '1.0.0',
    family: 'acme',
    description: 'Look up a customer in the Acme CRM. Read-only.',
    inputSchema: { type: 'object', required: ['customerId'], additionalProperties: false, properties: { customerId: { type: 'string' } } },
    outputSchema: { type: 'object', required: ['name', 'tier'], properties: { name: { type: 'string' }, tier: { enum: ['free', 'pro'] } } },
    effect: 'idempotent',
    scopes: ['crm:read'],
    egress: { mode: 'static', hosts: ['crm.acme.example:443'] },
    costModel: { unitsPerInvocation: 1, latencyClass: 'fast' },
    failureModes: [{ code: 'CUSTOMER_NOT_FOUND', class: 'business', retryable: false, description: 'No such customer' }],
    dataClassification: 'confidential',
    dryRun: 'execute',
  },
  async execute(ctx, input) {
    // use ctx.signal for cancellation, ctx.lease for secrets, ctx.idempotencyKey for effectful calls
    const found = await crm.find(input.customerId, { signal: ctx.signal });
    if (!found) throw new CapabilityError('CUSTOMER_NOT_FOUND', `No customer ${input.customerId}`, { errorClass: 'business' });
    return found;
  },
});

const registry = createDefaultRegistry(config.adapters);
registry.register(lookupCustomer, { owner: 'crm-platform-team', source: 'plugin' });
// then: createOmniflow(config, { capabilities: registry })
```

### The rules an adapter must follow

1. **One adapter, one external system.** No business logic, no orchestration, no reading the run's other steps.
2. **Honour `ctx.signal`.** Timeouts and cancellations arrive through it; a step that ignores it holds a worker.
3. **Classify every failure.** Throw `CapabilityError` with a class that is true: *transient* if trying again
   might work, *business* if it will not. Misclassification is how retry storms start (the Analysis Agent
   looks for exactly that).
4. **Effectful means idempotent-on-the-wire.** Pass `ctx.idempotencyKey` to the downstream system where it
   supports one, and make a repeated call with the same key a no-op. OmniFlow guarantees it will not repeat
   the *call*; only the downstream system can guarantee it does not repeat the *effect*.
5. **Never log a secret.** Read them from `ctx.lease` (scoped to this step, revoked when it ends); logs and
   events are also redacted, but do not rely on it.
6. **Declare honestly.** Under-declared scopes or egress do not make a capability safer, they make policy
   blind. The declaration is what reviewers approve.
7. **Provide a dry-run story.** `dryRun: 'execute'` for reads; `'simulate'` for anything effectful (optionally
   with a hand-written `simulate()`; otherwise the output is derived from `outputSchema`).

An adapter can be unit-tested on its own — it is just an object with an `execute` function — and then in a
workflow with `omniflow dev`. The example ships both kinds of test.

A registered capability needs a **named owner**: someone is accountable for every way workflows reach out.
