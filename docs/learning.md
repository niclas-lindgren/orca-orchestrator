# Orca learning: phase 1 (proposal-only)

The learning layer is **not a self-modifying agent**. It preserves bounded, structured evidence
from issue delivery, groups repeated findings, and emits investigation proposals. It never
launches workers, creates issues, changes permissions, edits code, bypasses gates or merges PRs.

## Register a run and measure observation coverage

Before implementation (after a successful claim), register the **guard run ID and issue**, not the native fleet Run ID shared by multiple issues. Each issue attempt needs its own ID. Use the same ID in the terminal observation:

```json
{"runId":"example-run-001","issue":123,"workflow":"fleet","reviewMode":"delegated"}
```

```sh
orca-orchestrator learn start --input /tmp/orca-run-start.json
```

`workflow` is `flow`, `fleet` or `unknown`; `reviewMode` is `default`, `delegated` or `unknown`. Delegation is valid only with `fleet`. The installed package supplies its version; callers cannot supply a version or another repository. The registration is idempotent. Unknown workflow/mode may be filled before terminal recording; conflicting identity/version changes or retroactively classifying an unregistered terminal observation are refused. If a package version changes mid-run, keep the original registration; command events identify the version executing each attempt. Do not invent a fresh run ID merely to bypass a conflict.

`learn report` includes `telemetry.coverage`: registered runs with and without terminal observations, plus unregistered terminal observations. **A missing observation is not a failed run**: it can be active, transferred to a successor run, interrupted or omitted. This is coverage of registered runs only, not proof that all delivery attempts were captured. Legacy observations have unknown version/workflow/mode rather than fabricated provenance.

## Record a terminal run

Run from the repository that owns the issue. The coordinator should record verified facts after
a merged PR or a documented blocker. Write a temporary JSON file outside the checkout:

```json
{
  "runId": "example-run-001",
  "issue": 123,
  "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "outcome": "merged",
  "durationMs": 180000,
  "costUsd": 1.25,
  "findings": [
    { "category": "review", "key": "tenant-boundary", "severity": "P1", "disposition": "fixed" },
    { "category": "qa", "key": "integration-coverage", "severity": "P2" }
  ]
}
```

For a run stopped before a commit, omit `headSha`. `costUsd` may be omitted if unknown.
Only record `durationMs` if measured; otherwise omit it and leave the average unknown.
Optional `metrics` contains measured non-negative integers only: `reviewRounds`, `reviewWaitMs`, `coordinatorInterventions`, `leaseLosses`, `adoptions`. Omit unknowns rather than inserting zero or estimates. For example, `"metrics":{"reviewRounds":2,"coordinatorInterventions":0}` is valid only if both counts were actually tracked. Count review rounds as distinct exact-head review conversations, interventions as explicit coordinator decisions/guidance requests (not routine status), lease losses as observed loss episodes (not repeated refused polls), and adoptions as successful lease transfers. Reports retain each metric's `measuredRuns` denominator and total by package version/workflow/review mode. These are caller-reported observations, not independently verified facts.
Use **one terminal observation per unique run ID**. An exact retry is idempotent; a changed
observation with an existing run ID is refused (`RUN_CONFLICT`).
A new terminal attempt needs a new run ID.

```sh
orca-orchestrator learn record --input /tmp/orca-run.json
orca-orchestrator learn report
orca-orchestrator learn propose --min-occurrences 3
orca-orchestrator learn packet --id review:tenant-boundary --min-occurrences 3
```

The CLI prints one JSON response per command. `report` includes run outcome totals, averages
where measured, and recurring findings. `propose` ranks repeat findings
by frequency and highest severity (excluding explicitly retracted findings), with investigation hypotheses labeled
`PROPOSAL_ONLY`. Nothing is automatically enacted.

## Opt-in operational metadata (not transcript logging)

Enable capture in the consumer repository's `orca.config.json`:

```json
{"learning":{"captureCommands":true}}
```

Merge this field into the existing configuration; do not replace the gate, review project or protected-domain policy. Capture is off by default. Only literal `true` enables it.

The bundled CLI (also used by Pi and Claude guard adapters) records completed attempts for an allowlist of lease, authority, repair, review and verification/cleanup commands. Each event contains only command name, a fixed result-code enum, elapsed milliseconds, installed package version, and validated issue/run identifiers if available. Unknown failure codes become `OTHER_ERROR`; raw arguments, errors, output, owner names, page URLs, prompts and first messages are **not stored**. Successful `claim`/`adopt` receipts also register the run with unknown workflow/mode; `learn start` supplies those labels before work proceeds.

The shared browser commands have no issue/run flags. For CLI-driven review calls, set `ORCA_LEARN_RUN_ID` and `ORCA_LEARN_ISSUE` **for that invocation only** to correlate them. Do not set one fleet-wide identity for multiple issues. Calls without matching registered identity remain explicitly uncorrelated; the collector never guesses from the active browser or latest lease. Adapter-driven browser calls currently remain uncorrelated unless their invoking process has correctly scoped these variables.

Reports group command attempts/duration/result codes by executing package version and registered workflow/mode where known. For example, inspect `review-wait` durations and `REPLY_TIMEOUT`, `LEASE_LOST`, `REPAIR_LIMIT` and successful `adopt` counts. **Attempts are not unique rounds, loss episodes or defects**: retries/polls can inflate counts. Use terminal measured metrics for those distinct concepts. There is no coordinator token/context measurement.

Command events retain only the newest **10,000 per repository**; retention does not remove run registrations or terminal observations. Reports explicitly describe this retained window. Telemetry failures emit a fixed diagnostic on stderr but leave the guard's stdout receipt and exit code unchanged. Capture is best-effort: process termination, configuration/startup failures, disabled collection and unavailable storage can leave gaps. It adds bounded local storage/lock overhead and is not an audit-completeness guarantee. It never runs agents, changes authority, retries a guard or infers a merge outcome.

Terminal observations still require explicit submission after verified merge/blocker evidence: the collector cannot infer a GitHub merge from a review or lease-release receipt. Check observation coverage instead of assuming all terminal outcomes were recorded.

### Review finding dispositions

A finding may carry `disposition`: `fixed`, `retracted`, `downgraded`, `open` or `unspecified` (legacy/default). Record the reviewer's explicit retraction/downgrade, not the worker's disagreement alone. For a downgrade, `severity` is the final reviewer-assigned severity. Retractions appear in disposition totals but do not generate recurrence proposals/packets. Downgrades remain findings at their final severity; `unspecified` preserves legacy behavior, not proof of reviewer confirmation. Immutable observations cannot later be edited to erase an allegation—record the terminal disposition accurately the first time.

### Evaluating delegation

Compare cohorts by package version, `fleet` workflow and `default` versus `delegated` mode: terminal outcomes, measured review rounds/wait, interventions, lease losses and adoptions. Include coverage and measured sample counts, and report unknown/unmatched calls. These are observational comparisons with task-selection and reporting bias, **not causal evidence**. Do not claim lower coordinator context use without an actual context/token measurement, or promote a workflow based on a handful of passing runs.

## Data and boundaries

- Repository identity is derived from `orca.config.json` or the `origin` remote. A caller
  cannot supply a different repo flag to read another project's evidence.
- Observations are saved locally in `stateDir/learning.db` (ignored by Git).
  The store is append-only by run ID and repository-scoped. This is **not** a central learning
  database; each repository has its own local history unless the operator intentionally shares
  its state directory.
- Allowed categories: `review`, `qa`, `workflow`, `tool`, `security`.
  Findings have one stable non-secret lowercase identifier and P1/P2/P3 severity.
  One occurrence means one issue-run, not one mention of a problem in logs.
- Input is capped at 64 KiB, findings at 100 per run, and unexpected fields are rejected.
  Do not submit raw output, secrets, freeform chat text, PII, or transcripts.
- Repeated findings are useful signals, **not** proof of a successful fix. An independent
  evaluation harness, held-out tasks, and a fresh security review are required to promote
  any proposed change.
- If local learning persistence fails, it must not affect worktree/lease ownership,
  authority decisions, review requirements, verification or merge eligibility.

## Improvement agent handoff

`learn packet` generates a deterministic, aggregate-only, read-only proposal packet with a
fingerprint of its source observations. It omits run IDs, issue numbers and commit SHAs.
The source repository name and finding identifier can nevertheless be sensitive: do not
paste a private project packet into a public PR without user permission. A separate
`orca-improve` Pi agent may turn a validated proposal into a **draft PR only**, using
[improving.md](improving.md). It does not run continuously or merge itself.

## Contract evaluation

Use `orca-orchestrator learn evaluate` in the **trusted evaluator checkout** against distinct,
clean, pinned baseline and candidate directories. See [evaluation.md](evaluation.md).
This verifies deterministic safety/quality contracts, not agent task-delivery quality.

## Next phases

1. Expand the pinned, deterministic contract replay into true end-to-end agent task evaluation with isolated environments, measured cost/time, and held-out safety tests.
2. Let a separately privileged improvement agent consume proposals and open draft PRs.
3. Keep branch protection, required checks, protected-domain authorization and evaluator
   definitions outside that agent's write access.
4. Only after measured safety and quality wins, consider narrow automatic promotion of
   noncritical strategy adjustments. Never automatically weaken safety rules.
