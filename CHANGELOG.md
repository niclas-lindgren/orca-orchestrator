# Changelog

## Unreleased

- Add an opt-in delegated review loop for `orca-fleet` (`skills/orca-fleet/references/delegated-review.md`): a worker runs fresh-review and repair rounds on its own exact head through the existing guard commands and hands the coordinator a short summary. The default coordinator-reviewed path is unchanged. The coordinator keeps the lease, authority checks, CI, `verify-head`, merge and cleanup, and accepts a verdict only from the recorded review chat on the exact head, with every reviewer dispute surfaced. No guard code, authority, lease or review-freshness rule changes.
- Add Pi-only `orca_worker_model` status/switch/result control for settled local supervised workers, using native Orca assignment/coordinator/custody evidence and Pi's public `setModel` API. No worker lifecycle, generic RPC, inference, request replay or retry engine is added.
- Ask for a user-approved exact model order when unset; `/orca-model-policy` replaces it in existing Pi session history, scoped to the native Run/coordinator generation. Pi's global defaults remain unchanged.
- Persist switch intent/receipts and compare session/old model before selection; reject stale/remote/non-Pi/busy targets and code/test/review failures. Ambiguous setter/transport outcomes require reconciliation, not blind replay.

## 0.4.2 - 2026-11-18

- Fix dispatcher auto-resume reading the stored `worker-start` receipt: it is the CLI envelope, so `dispatchId`/`taskId` live under `result`. A resumed record now carries the new receipt instead of the dead one, and an unconfirmed start is no longer rewritten as `started`.
- Fix `orca-fleet`: `worker-start` on an existing worktree must not pass `--name`/`--setup` (Orca rejects creation flags there), and `run-show` takes `--id`, not `--run`.
- Fix the readiness probe in both skills and `docs/installing.md`: `orca status --json`, not `orca runtime status` (not a command).
- Add a skills test that pins these native command and flag contracts.

## 0.4.1 - 2026-11-18

- De-duplicate against native Orca: `resume-report` prints Orca's own `next` for each worker instead of restating a recovery sequence, and names `run-use` as the native coordinator binding alongside `auto adopt` (the lease transfer).
- Dispatcher auto-resume counts attempts, not successes, and stops permanently when a start is refused, so it never retries past Orca's circuit breaker.
- Document the ownership boundary (Orca vs guard layer) in the README.
- Pin `jsdom` to `^29` and declare `engines.node >=22.13.0`: jsdom 30/31 demand Node `^22.22.2`, so consumer installs on 22.22.1 printed `EBADENGINE` warnings for a test-only dependency.

## 0.4.0 - 2026-11-18

- Add `orca resume-report --issue N`: a read-only join of lease store, Git, GitHub and native Orca that names the resume scenario and the commands for it.
- Add `auto handover` and `auto adopt`: fenced, audited transfer of an issue's run (including a native worker binding) to a new coordinator; keeps position, attempts and repair counters, does not inherit founder approvals.
- `resume-report`: recreating a worktree for an existing branch now always names `--base-branch`, because `--branch` alone makes a new branch from the default base and leaves the existing commits behind (verified on Orca 1.4).
- Add `auto unpause` (deprecated alias: `auto resume`) so the pause switch has a non-confusing name.
- Record the pre-expiry state of an expired run so adoption continues from it.
- Worker task specs can carry a resume preface (existing commits, uncommitted paths, PR, attempted findings).
- Dispatcher: opt-in `autoResume` retries a dead worker on the same native Task after adopting the run; the dispatch record carries the retry count.
- Add `auto review-record` / `review-forget` and list a lost coordinator's review chats in `resume-report`.
- Remove the unused `ensureWorktree` (raw `git worktree add`); worktree creation stays native.
- Fix dispatcher worker matching to Orca's real `worker-list` shape (`workspace`, `state`, `liveness`); `unverifiable` liveness is no longer read as finished, and the issue worktree is resolved through Git instead of assuming `.worktrees/`.

## 0.3.0 - 2026-11-15

- Move worktree, Task, worker supervision, retry, and cleanup lifecycle to native Orca CLI contracts.
- Add Pi and Claude MCP `orca_guard` adapters for repository leases, authority, repair, review, exact-head, and cleanup safeguards without a repository-local npm dependency.
- Add durable provisional/final native dispatch bindings and fail-closed native worktree discovery.
- Migrate the canonical flow/fleet skills and consumer installation guidance away from `npm run auto` / `npm run orca` wrappers.

## 0.2.1 - 2026-11-09

- Fix orca-flow skill: remove hardcoded Hockey ChatGPT project URL (now reads from config)
- Fix orca-flow skill: remove hardcoded "P1 first" priority order (now delegates to repository instructions)
- Fix orca-flow skill: correct repair status token from `ALREADY_RECORD` to `ALREADY_RECORDED`

## 0.2.0 - 2026-11-09

- Make `orca-orchestrator` installable as a Pi package with the canonical `orca-flow` and `orca-fleet` skills.
- Add the read-only `orca_status` tool and `/orca-status [issue]` command for Pi-native lease and run inspection.
- Keep repository CLI installation separate so CI and non-Pi harnesses can continue to use the same implementation.
