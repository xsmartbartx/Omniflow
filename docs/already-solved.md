# Problems you no longer have to solve yourself

If you have built workflows on a queue, a cron, or a hand-rolled state machine, these are the things you
usually end up writing yourself. OmniFlow does each of them as part of the manifest. Every snippet below is
the real syntax; the full reference is [Writing workflows](workflow-authoring.md).

| You would otherwise write… | In OmniFlow it is… |
|---|---|
| Retry loops that retry the wrong things | `retry.retryOn`: only the error classes you choose |
| "Undo" code for half-finished work | `compensate` on a step; rolled back in reverse order |
| Polling or timers that wait for something | a `wait` step, which costs nothing while waiting |
| Locks to stop runs piling up | `policy.concurrency` and `concurrencyPolicy` |
| Duplicate-charge protection | `idempotencyKey`, recorded before the step acts |
| Duplicate trigger protection | `dedupKey` and `dedupWindow` |

## Retry only what is worth retrying

Every failure carries a class. A timeout is `transient` and is worth another go; a declined payment is
`business` and is not. You name the classes that may be retried:

```yaml
retry: { attempts: 4, backoff: exponential, initialDelay: 2s, maxDelay: 1m, jitter: 0.2, retryOn: [transient, systemic] }
```

The run page says, in one sentence, why a step retried or stopped.

## Undo, in the right order

```yaml
compensate:
  uses: inventory-release@^1
  idempotencyKey: "release-${{ inputs.orderId }}"
```

If the run fails later, finished steps are undone in reverse order. If an undo itself fails, the run ends as
`compensation-failed` and raises an alert; it never pretends to have rolled back.

## Wait without holding anything

```yaml
- { id: settle, type: wait, until: { event: payment.received } }
```

## Keep runs from piling up

```yaml
policy: { concurrency: 1, concurrencyPolicy: skip }   # or: queue
```

## Do it once, even after a crash

An effectful step needs an `idempotencyKey`. OmniFlow records the key before it acts and passes it
downstream, so a retry, a crash recovery or a duplicate delivery does not repeat the effect:

```yaml
idempotencyKey: "charge-${{ inputs.orderId }}"
```

OmniFlow guarantees it will not repeat the call for the same key. The thing you call has to honour the key
too; that part is up to the downstream service.

## What this does not solve

- OmniFlow runs on one node with one SQLite file. If you need horizontal scale, it is not the right tool.
- Shell steps are sandboxed by your container, not by OmniFlow.
- See [Known limits](implementation-status.md) for the full list.
