# orca-orchestrator

Issue-delivery tooling and agent skills for repositories worked on with [Orca](https://orca.build),
shared so that fixes are made once instead of in every repository's private copy.

**Native lifecycle** (`orca orchestration|worktree`): Orca owns runs, tasks, supervised workers,
retries, lineage, and child worktrees. The skills load the current native contract with
`orca skills get orchestration --full` instead of routing lifecycle through repository npm scripts.

**Installed guard adapters** (`orca_guard`): the Pi extension and Claude MCP plugin expose the
repository-specific safety layer that native Orca does not provide: atomic issue leases, protected-
domain authority, repair caps, fresh ChatGPT review, exact-head verification, and guarded cleanup.
The adapter launches the package's bundled guard CLI, so consumer repositories need neither an
`orca-orchestrator` npm dependency nor `auto`/`orca` package scripts.

**Learning (proposal-only)** (`orca-orchestrator learn record|report|propose|packet`): captures bounded,
structured run outcomes in a repository-scoped SQLite store, reports recurring review/QA/workflow
failures, and suggests investigations. It never runs agents, changes gates, creates issues or PRs,
or updates its own code. See [docs/learning.md](docs/learning.md).

**Improvement proposer** (`orca-improve`): a separate Pi skill turns a recurring, aggregate-only
learning packet into a narrowly scoped candidate and draft PR in the shared package. It never
self-approves, auto-merges, or weakens the independent evaluation gate. See
[docs/improving.md](docs/improving.md).

**Replay evaluation** (`orca-orchestrator learn evaluate`): compares pinned clean baseline and
candidate checkouts against a single trusted, bounded fixture suite. Includes regression and
safety-case accounting, strict provenance and fails closed on mutated checkouts. This is an
offline contract-evaluation harness, **not** an end-to-end agent productivity benchmark or
an automatic merge authority. See [docs/evaluation.md](docs/evaluation.md).

**Agent integrations**: `extensions/orca.ts` contributes Pi's allowlisted `orca_guard`, read-only
`orca_status`, and `/orca-status [issue]`. `.mcp.json` starts the dependency-free Claude adapter in
`bin/orca-orchestrator-mcp.mjs`. Both load commands from the installed package rather than the
consumer checkout. The same package also loads the canonical skills below.

| Skill | Use |
|---|---|
| `orca-flow` | One session takes one issue from the default branch to a squash-merged PR, with a fresh-context ChatGPT review in between. |
| `orca-fleet` | One coordinating session launches several independent issues in parallel as child worktrees, then reviews and merges them one at a time. |

Repository-specific behaviour (the gate command, default branch, ChatGPT project, protected domains,
worker instructions) comes from `orca.config.json`; see [docs/configuration.md](docs/configuration.md).
To use it in a repository, see [docs/installing.md](docs/installing.md).

## Development

```bash
npm install
npm run check      # syntax check + the full test suite
```

The tests include the safety rules the skills must keep (`tests/skills.test.ts`), so editing a skill
can fail a test that names the rule it would weaken.

## Learning pilot

The coordinating session should submit one sanitized observation per completed or blocked
issue-run (the `orca-flow` skill explains when). The engine deliberately does not infer success
from a worker claim or substitute for independent review. A separate improvement agent may
consume `learn propose`, but promotion requires independent evaluations and the existing review
and authority gates. The initial release does not automate those downstream steps.

## Status

v0.3: flow and fleet use native Orca for orchestration and worktree lifecycle. Pi and Claude expose
allowlisted installed-package guard adapters, issue leases bind durably to native run/task/dispatch
receipts, and consumer repositories no longer need orchestration npm scripts or a package dependency.
Proposal-only learning and independent promotion policy remain unchanged.
