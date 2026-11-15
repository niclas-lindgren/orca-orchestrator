# Improvement proposer (phase 3)

The canonical Pi skill `orca-improve` proposes **draft pull requests** to improve
`orca-orchestrator` based on repeated delivery findings. The agent can edit and
propose fixes but cannot authorize, approve or merge its own improvement.

This is **not** an unattended self-modifying daemon: an operator must launch the
skill in Pi (for example `/skill:orca-improve`) or explicitly configure a
separate scheduling mechanism and limited credentials. The independent replay
job and mandatory human authorization live outside the proposer.

## Run from a source project

Campsty, hockey-flow and other repositories can record local observations
using the same shared `learn record` command. Once a recurring problem exists:

```sh
orca-orchestrator learn propose --min-occurrences 3
orca-orchestrator learn packet --id review:some-repeated-failure --min-occurrences 3
```

The resulting JSON packet has a scoped repository identifier, a stable finding
ID, aggregate occurrence/affected-issue counts, highest severity and
SHA-256 of the underlying source observations. It contains **no raw run IDs,
commit hashes, issue numbers, logs or chat transcripts**. It is not an
authorization or proof that the proposed fix will help. The `sourceRepo`
and finding ID can themselves reveal project metadata, so review them before
sharing with a public upstream PR.

If there is insufficient evidence, the command returns a nonzero exit code
and a structured error. Do not lower the recurrence threshold to trigger
an improvement just for its own sake.

## Run the improvement agent

Start a new, separate Pi session with the canonical `orca-improve` skill.
It selects one evidence-backed hypothesis, checks whether it represents a
**shared orchestration problem** rather than a product bug, and creates a
narrow candidate branch in the canonical upstream package. It runs normal
quality checks and requests trusted baseline/candidate evaluation.

- One candidate per hypothesis and one draft PR per candidate.
- Never auto-modify authority policy, lease/ownership fences, evaluator
  baselines or fixtures, required workflows, review fresh-context rules,
  or quality thresholds. Escalate such changes to the user.
- Never copy private product issue text or user data into the public shared
  package. Do not publish aggregate source details without permission.
- The proposer may **not** approve, merge, label its own PR independently
  verified, grant production privileges, or make itself a required reviewer.
- Any change to the candidate SHA requires a new independent final-head
  review and fresh evaluation; previous receipts become stale.

## Independent PR gate

`Contract replay` CI uses the trusted evaluator/suite from the base
branch, and the precise base and head SHAs in three clean checkouts on an
unprivileged runner. A passing result is one input to review, **not** a
promotion decision. Protect the workflow and required check with GitHub
branch protection outside the proposer agent's write privileges. The Pi
agent must use credentials that lack bypass/merge permissions to enforce
this separation technically, not just through prompt instructions.

## What remains to reach unattended self-improvement

A separate scheduler and durable supervisor should start bounded improvement
runs, measure outcome and cost against end-to-end coding tasks, compare against
held-out cases, and manage safe retries and escalation. This phase provides the
**evidence-to-draft** path and independent contract replay infrastructure,
not hands-off acceptance or deployment.
