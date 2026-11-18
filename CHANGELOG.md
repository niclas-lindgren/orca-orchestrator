# Changelog

## Unreleased

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
