# Changelog

## 0.2.0 - 2026-11-09

- Make `orca-orchestrator` installable as a Pi package with the canonical `orca-flow` and `orca-fleet` skills.
- Add the read-only `orca_status` tool and `/orca-status [issue]` command for Pi-native lease and run inspection.
- Keep repository CLI installation separate so CI and non-Pi harnesses can continue to use the same implementation.
