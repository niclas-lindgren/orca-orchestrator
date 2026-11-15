---
name: orca-flow
description: Deliver one GitHub issue end to end with native Orca orchestration and worktrees plus the installed Orca guard adapter. Use when the user asks to implement, deliver, review, or merge one issue in an Orca-managed repository.
---

# Orca Flow

Deliver one issue without repository-local orchestration scripts. Native Orca owns worktree and worker lifecycle. The installed Pi extension or Claude plugin owns repository-specific guards that native Orca does not provide.

## Command surfaces

Set the native binary once:

```bash
ORCA="${ORCA_CLI_COMMAND:-orca}"
```

Before acting, read the native contract:

```bash
"$ORCA" skills get orchestration --full
```

Run lifecycle commands directly through `"$ORCA"`.

Run guard commands through the installed adapter, **not a shell package script**:

- Pi: `orca_guard({ group, command, args })`
- Claude: `mcp__orca-orchestrator__orca_guard({ group, command, args })`

In this document, `GUARD auto claim --issue 42 ...` means call that tool with `group: "auto"`, `command: "claim"`, and each remaining token as one string in `args`.

Never use `npm run auto`, `npm run orca`, `npx orca-orchestrator`, or a repository-local `orca-orchestrator` dependency.

## Preconditions

Fail closed before claiming anything.

1. Confirm repository root and clean coordinator checkout:
   ```bash
   git rev-parse --show-toplevel
   git status --short --branch
   ```
2. Read repository instructions and `orca.config.json`. The configured gate is mandatory.
3. Confirm GitHub auth: `gh auth status`.
4. Confirm native Orca is reachable: `"$ORCA" runtime status --json`.
5. Confirm the adapter is installed by calling `GUARD auto status`.
6. Confirm browser review is available. Browser degradation, missing adapter, unavailable Orca, missing config, or failed GitHub auth means stop before claim.

Do not clean unrelated changes, reuse another session's worktree, or bypass a failed precondition.

## Select and claim one issue

List eligible open issues with `gh api`. Skip epics unless the user explicitly chose one, issues with unresolved dependencies, and issues already owned by another live run.

Create stable identities for this session:

```bash
OWNER="${PI_SESSION_ID:-${CLAUDE_SESSION_ID:-$(whoami)}}"
RUN_ID="$(date +%s)-$$"
```

Claim atomically:

```text
GUARD auto recover
GUARD auto claim --issue ISSUE --owner OWNER --run RUN_ID --ttl-min 30
```

A conflict, active native binding, pause, or ambiguous response means do not proceed. Renew every 10 minutes and before/after long review, CI, or user waits:

```text
GUARD auto renew --issue ISSUE --owner OWNER --run RUN_ID --ttl-min 30
```

Lease loss stops all mutation immediately.

## Create the native issue worktree

Native Orca, not the guard adapter, creates the worktree:

```bash
"$ORCA" worktree create \
  --branch "agent/issue-$ISSUE" \
  --issue "$ISSUE" \
  --parent-worktree current \
  --base-branch "$(jq -r '.defaultBranch // "main"' orca.config.json)" \
  --json
```

Record the returned worktree selector and absolute path. If launch receipt is ambiguous, replay only with the same `--retry-launch` operation id. Refuse a dirty reused worktree or unexpected branch; preserve it for recovery.

Run all implementation, commits, pushes, and PR commands from the returned worktree.

## Authority and implementation

Before edits, run:

```text
GUARD auto auth-check --issue ISSUE --phase plan --owner OWNER --run RUN_ID
```

If the result requires founder/user input, stop, preserve evidence, and do not reinterpret silence as approval. After explicit approval use `founder-resume`, then repeat the authority check.

Read the issue and comments using `gh api`, inspect relevant code, implement the smallest complete solution, and add regression tests. Preserve repository boundaries and unrelated user changes.

Run the configured gate exactly. Do not substitute a weaker test command.

Commit, push `agent/issue-ISSUE`, and open or update one PR that closes the issue.

## Fresh independent review

Every merge attempt requires a fresh ChatGPT review of the current PR head.

1. Call `GUARD orca review-open` and record the page id.
2. Write a review request file naming repository, PR, exact head SHA, issue acceptance criteria, and asking for prioritized actionable findings with file/line evidence.
3. Call `GUARD orca review-send --page PAGE --message-file FILE`.
4. Call `review-wait`, then `review-read`. Silence, timeout, stale SHA, or ambiguous output is not approval.
5. Before each repair, record the reviewed head and findings:
   ```text
   GUARD auto repair-record --issue ISSUE --owner OWNER --run RUN_ID --pr PR --head SHA --findings-file FILE
   ```
6. Fix valid findings, rerun the full gate, push, and start a **new review chat** for the new head. Never self-approve or reuse an old verdict.

Respect the repair cap reported by the ledger. On exhaustion, stop and request a decision.

## Exact-head verification and merge

Wait for required CI with bounded polling. Renew the lease while waiting. CI failure, timeout, cancellation, or unknown state blocks merge.

Repeat authority for the exact pull request, then call:

```text
GUARD auto auth-check --issue ISSUE --phase merge --pr PR --owner OWNER --run RUN_ID
GUARD orca verify-head --issue ISSUE --owner OWNER --run RUN_ID --pr PR
```

The verifier must confirm all of the following in one receipt: open non-draft PR, expected base/branch, clean native worktree, GitHub head equals local head, current base, configured gate success, and unchanged head/base after the gate.

Immediately squash-merge that exact head:

```bash
gh pr merge "$PR" --squash --delete-branch=false --match-head-commit "$VERIFIED_HEAD"
```

If GitHub or the head changes after verification, verify again. Never force merge.

## Cleanup and chat deletion

After confirming the merge:

1. Unbind any native fleet dispatch first; a single-flow worktree has no dispatch binding.
2. Call `GUARD orca cleanup --issue ISSUE`. Cleanup checks merged PR, cleanliness, and live holders, then delegates removal and branch deletion to `orca worktree rm --delete-branch`; native Orca must prove deletion safe.
3. Release the lease:
   ```text
   GUARD auto release --issue ISSUE --owner OWNER --run RUN_ID
   ```
4. Delete only review chats created by this run. Write the expected chat identity to a file and call `GUARD orca review-delete --page PAGE --message-file FILE [--project-id ID]`. A mismatch must refuse deletion.

If cleanup is unsafe, leave the worktree and branch intact and report the exact blocker. Never use raw `git worktree remove`, `git branch -D`, or broad browser cleanup.

## Completion report

Report the issue, PR, merged SHA, gate result, fresh-review result, exact-head receipt, cleanup receipt, and any retained recovery artifacts. Do not claim completion unless merge and post-merge checks are verified.
