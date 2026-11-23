# In-flight worker harness migration

Use this procedure when the user directs an existing worker to switch harnesses, including bringing a non-Pi worker into compliance with the Pi worker policy. A harness cannot be changed inside a running agent. Replacement preserves the worktree and task history; it does not transfer the old agent's conversation history.

Before acting, load the execution binary's current recovery contract:

```bash
"$ORCA" skills get orchestration --reference references/recovery-and-cleanup.md
```

Follow that contract's receipts and recovery actions if commands or states differ. This procedure does not override leases, authority, the native circuit breaker, custody/Keep open protections, or fleet concurrency limits.

## 1. Inspect and prepare the handoff

Use `worker-list --run NATIVE_RUN --include-remote`, `worker-show --dispatch OLD_DISPATCH` and `worker-read --dispatch OLD_DISPATCH`. Confirm the owning Run, Task, dispatch, harness, execution host and exact worktree. Renew the issue lease and confirm this coordinator owns its guard binding and required authority before mutation. Missing ownership or ambiguous identity means stop.

Record a privacy-safe handoff in the issue or another lifecycle-bound artifact, not just in the old agent's chat. Include:

- Run, Task, dispatch and worktree identities; branch, local head and pushed PR head.
- Work completed, pending acceptance criteria and recorded review repairs.
- Tests actually executed, skipped checks, failures and evidence locations.
- Known uncommitted changes, dependencies and owned processes/test-stack ports.
- Instruction to audit and continue inherited work rather than restart or discard it.

The old worker may still be writing: this snapshot is provisional until it stops. Request a checkpoint through native messaging only if needed and the worker is still active; sending to a settled worker reopens its old harness.

If the Task completed successfully, leave it completed. Do not restart it solely to change harness metadata. If later repairs are needed, create an explicit follow-up Task in the same Run, dependent on the completed Task, with the handoff in its spec; launch that work with Pi in the retained worktree after confirming the old worker has exited. Do not use `send` to reopen the non-Pi worker. The remaining steps describe an unfinished, stopped/failed attempt retried on the same Task; for a legitimate completed-task follow-up, use the new Task id and omit `--retry-of`.

## 2. Stop the exact old attempt and prove exit

For an active attempt that the user authorized replacing:

```bash
"$ORCA" orchestration worker-stop --dispatch "$OLD_DISPATCH" --json
"$ORCA" orchestration worker-show --dispatch "$OLD_DISPATCH" --json
```

Proceed only with confirmed agent exit and a settled dispatch. A stop request or terminal-close action alone is not proof. On `stop_unknown`, inspect the receipt and `worker-show`, then stop and report if exit remains unproven. An abandon receipt fences an assignment but does not prove agent exit; never substitute it for confirmed cancellation. Silence and `unverifiable` liveness are not exit evidence.

For an already-exited attempt, retain the native exit evidence instead of requesting another stop. Follow native release actions for any reclaimable failed-start resources; never kill broad process names or unrelated stacks.

After exit, refresh the handoff from the final worktree status and diff. Preserve commits and uncommitted changes. Do not reset, clean, stash, reinstall dependencies, delete the worktree or create another checkout merely to change harnesses. A dirty inherited tree is expected here: account for it explicitly; the usual clean-tree handoff and merge gates still apply later.

## 3. Replace the binding and start Pi

Use the same owning Run, unfinished Task and exact existing worktree/host. Placement is not inherited: repeat any required remote `--on` selection according to the native placement contract. Do not reuse the old terminal with `--terminal`, which would reuse its harness.

Generate one durable `START_REQUEST`. With the lease live, replace the old binding in this order:

```text
GUARD auto unbind-native --issue ISSUE --owner OWNER --run RUN_ID --dispatch OLD_DISPATCH
GUARD auto bind-native --issue ISSUE --owner OWNER --run RUN_ID --native-run NATIVE_RUN --task TASK_ID --dispatch pending:START_REQUEST --worktree WORKTREE_SELECTOR
```

Only after the provisional binding succeeds:

```bash
"$ORCA" orchestration worker-start \
  --task "$TASK_ID" \
  --run "$NATIVE_RUN" \
  --retry-of "$OLD_DISPATCH" \
  --worktree "$WORKTREE_SELECTOR" \
  --agent pi \
  --retry-request "$START_REQUEST" \
  --json
```

Use Pi's configured model unless the user selected one. A provider or quota failure does not authorize another harness. Do not pass creation flags for an existing worktree.

On an ambiguous launch, keep the provisional binding and inspect native state. Any permitted replay must use the same `--retry-request`; never issue another launch id while the first could have started. Respect the circuit breaker: stop and request the native user-directed recovery procedure rather than creating a new Task or Run to evade it.

Confirm the new dispatch identifies Pi in the receipt or `worker-show`, then finalize:

```text
GUARD auto bind-native --issue ISSUE --owner OWNER --run RUN_ID --native-run NATIVE_RUN --task TASK_ID --dispatch NEW_DISPATCH --worktree WORKTREE_SELECTOR
```

If harness identity, readiness or binding is uncertain, preserve the receipts and stop; do not claim migration success or launch another worker.

## 4. Resume from evidence

Send the new Pi dispatch the handoff and any pending repair instructions through native messaging. Require it to inspect the inherited diff and commits before further edits, preserve unrelated changes, and distinguish predecessor-reported evidence from checks it executes itself. The original Task spec is retained on retries; the old conversation is not.

Record old and new dispatch ids, confirmed stop evidence, final branch/head and both binding receipts. Migration is complete only when the old worker is proven stopped, the Pi dispatch is ready, its guard binding is finalized, and the continuation handoff has been delivered. This is not issue completion, independent review approval or permission to merge. End the coordinator turn and await native notifications rather than polling.
