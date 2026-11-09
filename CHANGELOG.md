# Changelog

## 0.2.1 - 2026-11-09

- Fix orca-flow skill: remove hardcoded Hockey ChatGPT project URL (now reads from config)
- Fix orca-flow skill: remove hardcoded "P1 first" priority order (now delegates to repository instructions)
- Fix orca-flow skill: correct repair status token from `ALREADY_RECORD` to `ALREADY_RECORDED`

## 0.2.0 - 2026-11-09

- Make `orca-orchestrator` installable as a Pi package with the canonical `orca-flow` and `orca-fleet` skills.
- Add the read-only `orca_status` tool and `/orca-status [issue]` command for Pi-native lease and run inspection.
- Keep repository CLI installation separate so CI and non-Pi harnesses can continue to use the same implementation.
