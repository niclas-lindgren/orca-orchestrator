# Changelog

## Unreleased

- Add read-only `founder-status --issue N` to show what a founder park blocked (phase, PR, head, domains, evidence, approved domains) and the parked `run_id`.
- Add `founder-resume --dry-run`: same validation, no writes, reports the domains it would approve.
- `founder-resume` `RUN_MISMATCH` now includes `parkedRunId`; the run-id check is unchanged.

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
