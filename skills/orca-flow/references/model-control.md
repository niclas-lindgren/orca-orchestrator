# Live Pi model selection

Use this branch for a finalized provider quota, rate-limit or availability failure in an **existing Pi worker**. For a harness change or a stopped/released worker, use [harness migration](harness-migration.md) and native Orca recovery instead.

## Ownership

Load the current native Orca guide and inspect its command discovery first. If native Orca provides dispatch-addressed live Pi model control, use it. The installed `orca_worker_model` adapter fills only the missing Pi TUI selection seam; it is not a second orchestrator. Native Orca remains authoritative for Run/coordinator generation, Task, dispatch, terminal incarnation, worktree, custody and liveness. Follow its existing skills for lifecycle, messaging, escalation, retries and circuit breakers.

The adapter is local Unix-only, for terminal coordinators and supervised terminal Pi workers with provable live native assignment and the updated package already loaded in that Pi process. It never starts/stops/retries workers, changes harness, aborts requests, injects prompts or calls an inference provider. Remote, stale, released, non-Pi or unverifiable targets fail closed. Do not steer worker terminals to install/reload it. An older running worker without the endpoint is unsupported until its owner safely updates/reloads it at a settled boundary.

## Policy

The coordinator owns selection. Model-order approval does not override repository privacy/provider agreements, protected-domain approval or delivery leases. The user approves an ordered list of **exact provider/model IDs**, including the worker's current model. There is no default provider order. On the first switch the tool prompts for the list and confirmation; absent UI, cancellation or refusal means stop and ask the user. Authentication/catalogue presence does not prove provider availability.

Approval is stored in Pi's existing session history for the native Run/coordinator generation, not in a new policy database or Pi global defaults. To change it, the user runs:

```text
/orca-model-policy ctx_DISPATCH provider/model,other-provider/model
```

A switch advances exactly one position. It never skips, wraps or automatically replays a failed turn. A failed test, tool result, code defect, review rejection, authentication error or context overflow is not a fallback trigger. Exhausted order means ask the user; use native Orca messaging/escalation, not a new retry engine.

## Inspect, select, reconcile

1. Bind the intended Run through native `run-use` if necessary. The tool verifies the caller is its current coordinator; receiving Pi independently verifies native assignment and its own pane/worktree.
2. Inspect without inference:
   ```text
   orca_worker_model({ action: "status", dispatch: "ctx_DISPATCH" })
   ```
   Record returned `identity`, `sessionId`, `model`, `idle` and `lastFailure`. An unavailable endpoint is not permission to restart, inject a slash command or adopt another worker.
3. Wait for Pi to settle, including automatic retries/compaction and queued messages. Busy means stop and wait for native notification. This version has no abort-and-switch mode.
4. After an eligible finalized assistant provider error, select the next approved model with a unique request ID:
   ```text
   orca_worker_model({
     action: "switch", dispatch: "ctx_DISPATCH", sessionId: "PI_SESSION_FROM_STATUS",
     requestId: "UNIQUE_REQUEST_ID", expectedModel: "provider/current-model",
     target: "other-provider/next-model", reason: "rate-limit"
   })
   ```
   `reason` must match the current model's observed `quota`, `rate-limit` or `provider-unavailable` error. The receiver checks session, expected old model, policy order and native identity, persists intent, calls Pi's public `setModel`, then verifies readback/native custody before acknowledging.
5. Only `receipt.outcome: "selected"` acknowledges selection. It preserves the Pi session/history and native Task/dispatch/worktree; it does **not** prove successful inference. Check effective thinking level, context/capability compatibility and ordinary repository authority before continuing work through native orchestration messaging.
6. A disconnect, timeout, `pending` or `unknown` result is ambiguous. Query, don't repeat:
   ```text
   orca_worker_model({ action: "result", dispatch: "ctx_DISPATCH", sessionId: "PI_SESSION_FROM_STATUS", requestId: "SAME_REQUEST_ID" })
   ```
   Inspect current status as well. Persisted intent prevents blind setter replay, including after reload; an unknown/pending receipt requires reconciliation and a coordinator/user decision. Never manufacture a new Task/Run/request just to bypass that uncertainty or a native breaker.

## Security and limits

The model-only endpoint is a private owner-checked 0700 directory/0600 Unix socket; no TCP, generic commands or credential reads. Local OS-user custody is the same trust scope as access to the local Orca CLI: this does not sandbox mutually untrusted processes running as that user. Do not install the researched unrestricted RPC extension alongside it as a purported guarded control path.

Pi's setter and Orca's assignment store are not one distributed transaction. Receiver checks bracket the setter; revocation/session replacement or setter errors after attempted mutation are reported as unknown, not safely retryable failure. This version provides neither remote control nor automatic continuation. See [research and validation](../../../docs/research/live-model-control.md) for source findings and test scope.
