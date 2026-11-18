---
name: orca-fleet
description: Deliver several independent GitHub issues in parallel with one native Orca run, one task and child worktree per issue, at most three supervised workers, and serialized guarded review and merge. Use when the user asks to run a fleet or implement several issues concurrently.
---

# Orca Fleet

Coordinate up to three independent issues. Native Orca owns the run, task DAG, workers, retries, and child worktrees. The installed Pi extension or Claude MCP plugin supplies repository-specific leases, authority, repair, review, verification, and cleanup guards.

## Command surfaces

```bash
ORCA="${ORCA_CLI_COMMAND:-orca}"
"$ORCA" skills get orchestration --full
```

Use direct native commands for lifecycle. Use the installed `orca_guard` adapter for guards:

- Pi: `orca_guard({ group, command, args })`
- Claude: `mcp__orca-orchestrator__orca_guard({ group, command, args })`

`GUARD auto claim --issue 42 ...` below is shorthand for one adapter tool call with each remaining token supplied as a string in `args`.

Never use `npm run auto`, `npm run orca`, `npx orca-orchestrator`, repository-local wrapper scripts, raw background shells, ad-hoc PTYs, or detached agents.

## Mandatory preflight

Before selecting or claiming issues:

1. Confirm clean coordinator checkout and read repository instructions plus `orca.config.json`.
2. Confirm `gh auth status`.
3. Confirm `"$ORCA" runtime status --json` and read the full orchestration skill.
4. Call `GUARD auto status` to prove the installed adapter can load repository config/state.
5. Confirm native Orca browser automation and fresh ChatGPT review are available.
6. Run `GUARD auto recover`.

Missing config, unavailable Orca, missing adapter, browser degradation, GitHub failure, or dirty coordinator state means claim nothing.

## Plan one native run

Fetch open issues and comments with `gh api`. Build a dependency table from explicit issue relationships and overlapping files/domains. Select no more than three issues that are genuinely independent. Keep epics and dependent work out of the initial wave unless the user explicitly directed otherwise.

Create one run:

```bash
"$ORCA" orchestration run-create --objective "Deliver issues #A, #B, #C with guarded review and exact-head merge" --json
```

For each issue create one durable Task. Express real dependencies with `--deps`; do not encode order in prose alone:

```bash
"$ORCA" orchestration task-create --run "$NATIVE_RUN" --spec "Implement issue #A completely; stop before coordinator-owned review and merge" --deps '[]' --json
```

Record the run and task ids. The coordinator session remains the sole reviewer and merger.

## Claim before launch

Create stable coordinator identities:

```bash
OWNER="${PI_SESSION_ID:-${CLAUDE_SESSION_ID:-$(whoami)}}"
RUN_ID="$(date +%s)-$$"
```

For every selected issue:

```text
GUARD auto claim --issue ISSUE --owner OWNER --run RUN_ID --ttl-min 30
GUARD auto auth-check --issue ISSUE --phase plan --owner OWNER --run RUN_ID
```

Any conflict, pause, native binding, or authority decision removes that issue from the wave. Never replace it silently with unrelated work.

Renew every live lease every 10 minutes and before/after long waits.

## Start one worker per issue

Start at most three workers. Close the launch-to-binding race by recording a
provisional durable binding **before** native Orca can start the worker:

1. Create the exact native issue worktree and retain its explicit selector:
   ```bash
   "$ORCA" worktree create --branch "agent/issue-$ISSUE" --issue "$ISSUE" \
     --parent-worktree current --base-branch "$DEFAULT_BRANCH" \
     --retry-launch "$WORKTREE_REQUEST" --json
   ```
2. Generate a durable `START_REQUEST`, then bind `pending:START_REQUEST`:
   ```text
   GUARD auto bind-native --issue ISSUE --owner OWNER --run RUN_ID --native-run NATIVE_RUN --task TASK_ID --dispatch pending:START_REQUEST --worktree WORKTREE_SELECTOR
   ```
3. Only after that receipt succeeds, start the worker on the explicit worktree:
   ```bash
   "$ORCA" orchestration worker-start \
     --task "$TASK_ID" \
     --worktree "$WORKTREE_SELECTOR" \
     --name "issue-$ISSUE" \
     --agent "$AGENT" \
     --setup run \
     --retry-request "$START_REQUEST" \
     --json
   ```
4. Finalize the same binding with the confirmed dispatch receipt:
   ```text
   GUARD auto bind-native --issue ISSUE --owner OWNER --run RUN_ID --native-run NATIVE_RUN --task TASK_ID --dispatch DISPATCH_ID --worktree WORKTREE_SELECTOR
   ```

The worker prompt must require branch `agent/issue-ISSUE`, issue acceptance tests,
the configured gate, commits and push, and a handoff containing head SHA and
evidence. A provisional binding blocks takeover even if the coordinator crashes
or the lease expires during launch. On an ambiguous launch, keep the provisional
binding and replay only with the same `--retry-request`. If launch is confirmed
not to have started, unbind the exact `pending:START_REQUEST` before cleanup.

## Supervision and recovery

Use native Orca state only:

```bash
"$ORCA" orchestration run-show --run "$NATIVE_RUN" --json
"$ORCA" orchestration worker-show --dispatch "$DISPATCH_ID" --json
```

Do not infer failure from silence. An unverifiable worker is still potentially active.

- If running, wait or send a scoped message through native orchestration.
- If a stop is required, use guarded `worker-stop` and retain its receipt.
- If the attempt is terminal and replacement is justified, start a retry on the **same Task** with `--retry-of "$DISPATCH_ID"` and a durable `--retry-request` id.
- After three failed starts, the native circuit breaker requires explicit user direction before reopening work.
- Use `worker-abandon` or `worker-release` only when the native contract authorizes it; never delete evidence to make a slot appear free.

For a replacement, first prove the old dispatch terminal and unbind it exactly. While the lease is still live, create and bind the new `pending:START_REQUEST` before calling `worker-start --retry-of OLD_DISPATCH --retry-request START_REQUEST`; finalize the binding with the new receipt. Ambiguity means leave the applicable old or provisional binding intact and stop.

## Resuming after a lost coordinator or worker

A bound dispatch blocks `claim`, `release` and `recover` for everyone but the exact owner and run that bound it, so a new coordinator cannot reach the issue by claiming. Use:

```text
GUARD orca resume-report --issue ISSUE
GUARD auto adopt --issue ISSUE --owner OWNER --run NEW_RUN_ID --from-run OLD_RUN --ttl-min 30
```

`adopt` needs the old lease to be expired or handed over (`GUARD auto handover` by the old coordinator) and keeps the native binding, which the new coordinator now owns. Then follow `recommendation`: attach to a live worker, or, only for a dispatch `worker-list` shows with `liveness: exited`, unbind it exactly and retry on the same Task with `--retry-of`, passing the report's `specPreface` in the spec. `liveness: unverifiable` is not exited: inspect with `worker-show` and stop. Founder approvals are not inherited.

## Worker handoff gate

A worker completion is a claim, not approval. Before accepting it, verify:

- task and dispatch identities match the binding;
- issue branch and child lineage are correct;
- worktree is clean;
- head SHA is pushed to GitHub;
- configured gate passed;
- scope matches the issue and no protected-domain decision was guessed;
- lease is still owned by this coordinator.

Reject incomplete handoffs and continue on the same Task.

## Serialized review, repair, and merge

Parallelism ends at review. Process one issue at a time through the full guarded pipeline:

1. Ensure its PR is open, non-draft, and current.
2. Renew the lease and repeat plan authority. Immediately before merge run `GUARD auto auth-check --issue ISSUE --phase merge --pr PR --owner OWNER --run RUN_ID`.
3. Open a fresh ChatGPT review chat with `GUARD orca review-open`; send repository, issue, PR, and exact head SHA.
4. Treat timeout, silence, stale SHA, or ambiguous response as not approved.
5. Before each repair call `GUARD auto repair-record --issue ... --pr ... --head ... --findings-file ...`.
6. Apply or dispatch repairs on the same Task, run the full configured gate, push, and request a new review of the new head.
7. Wait for required CI with bounded polling.
8. Repeat merge authority and call `GUARD orca verify-head --issue ISSUE --owner OWNER --run RUN_ID --pr PR`.
9. Immediately squash-merge with `gh pr merge --match-head-commit VERIFIED_HEAD`. Any head/base change invalidates verification.

Never review or merge two fleet issues concurrently. A failed issue does not authorize weakening safeguards for the others.

If the repair cap is exhausted or founder authority is rejected while a worker is bound, stop or abandon the exact native dispatch using its receipt, unbind that exact dispatch, release the parked lease, and preserve the worktree for recovery. Never leave a terminal parked row with an active native binding.

## Completion, unbinding, and cleanup

After merge is verified and the worker is terminal:

```text
GUARD auto unbind-native --issue ISSUE --owner OWNER --run RUN_ID --dispatch DISPATCH_ID
GUARD orca cleanup --issue ISSUE
GUARD auto release --issue ISSUE --owner OWNER --run RUN_ID
```

Cleanup delegates worktree/branch removal to `orca worktree rm --delete-branch`; native Orca must prove the branch safe. Dirty worktrees, live holders, mismatched dispatches, or unproven merges are retained for recovery.

Delete only the fresh review chats created by this coordinator using guarded `review-delete` identity files. Do not bulk-delete browser state.

Finish the native run only after every Task is terminal or explicitly abandoned with evidence. Report per issue: task, dispatch, PR, merged SHA or blocker, gate, review, exact-head, unbind, and cleanup receipts.
