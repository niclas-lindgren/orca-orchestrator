# Orca learning: phase 1 (proposal-only)

The learning layer is **not a self-modifying agent**. It preserves bounded, structured evidence
from issue delivery, groups repeated findings, and emits investigation proposals. It never
launches workers, creates issues, changes permissions, edits code, bypasses gates or merges PRs.

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
    { "category": "review", "key": "tenant-boundary", "severity": "P1" },
    { "category": "qa", "key": "integration-coverage", "severity": "P2" }
  ]
}
```

For a run stopped before a commit, omit `headSha`. `costUsd` may be omitted if unknown.
Only record `durationMs` if measured; otherwise omit it and leave the average unknown.
Use **one terminal observation per unique run ID**. An exact retry is idempotent; a changed
observation with an existing run ID is refused (`RUN_CONFLICT`).
A new terminal attempt needs a new run ID.

```sh
orca-orchestrator learn record --input /tmp/orca-run.json
orca-orchestrator learn report
orca-orchestrator learn propose --min-occurrences 3
```

The CLI prints one JSON response per command. `report` includes run outcome totals, averages
where measured, and recurring findings. `propose` ranks repeat findings
by frequency and highest severity, with investigation hypotheses labeled
`PROPOSAL_ONLY`. Nothing is automatically enacted.

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

## Next phases

1. Build independent task replay/evaluation with pinned baseline and candidate versions.
2. Let a separately privileged improvement agent consume proposals and open draft PRs.
3. Keep branch protection, required checks, protected-domain authorization and evaluator
   definitions outside that agent's write access.
4. Only after measured safety and quality wins, consider narrow automatic promotion of
   noncritical strategy adjustments. Never automatically weaken safety rules.
