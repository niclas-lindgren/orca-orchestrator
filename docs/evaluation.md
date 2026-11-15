# Replay evaluation (phase 2: deterministic contracts)

This is a **trusted evaluator** that executes a fixed suite against *two distinct,
clean, exact-commit Git checkouts* of `orca-orchestrator`: the baseline and the
candidate. It reports whether each case improved, regressed, passed unchanged, or
remains unresolved. Nothing is automatically approved, merged, or installed.

It is not yet an end-to-end coding-agent benchmark; it measures allowlisted
Orca contract behavior (authority, config validation, QA/review finding identity,
and mocked exact-head verification including stale heads, dirty worktrees and
base-branch movement). Real agent delivery, model efficiency, and costs need
a later isolated evaluation runner.

## Run in an ephemeral, credential-free environment

From a **trusted** checkout of the evaluator, create separate detached worktrees
at exact Git SHAs. Do not run on a production host or with privileged tokens.

```bash
git worktree add --detach ../orca-baseline <40-character-baseline-sha>
git worktree add --detach ../orca-candidate <40-character-candidate-sha>

node bin/orca-orchestrator.mjs learn evaluate \
  --suite evals/replay-v1.json \
  --baseline ../orca-baseline \
  --baseline-sha <40-character-baseline-sha> \
  --candidate ../orca-candidate \
  --candidate-sha <40-character-candidate-sha>
```

The command exits 0 only when every candidate case matches the fixed expected
output. It emits a single JSON document containing:

- The full trusted evaluator, baseline and candidate SHA, plus the SHA-256 digest of the suite file.
- Per-case baseline and candidate pass/fail and one of `PASS`, `IMPROVED`,
  `REGRESSION`, or `UNRESOLVED`.
- Aggregate pass, improvement, regression, unresolved and safety-failure counts.
- A clear note that this verdict is **not** a merge authorization.

The trusted evaluator and both target checkouts must start and finish clean; target
checkouts must remain on the exact requested commits. The evaluator must be a third,
distinct checkout; the runner refuses missing, moved or dirty checkouts and detects
changes to the trusted suite during evaluation. It executes a bounded,
allowlisted probe worker separately for each version with a 30-second timeout,
a bounded output buffer, and a deliberately limited inherited environment.

**Important:** A separate Node process with filtered environment variables is
*not* a security sandbox. A malicious or compromised candidate can still access
the filesystem and network with its operating-system identity. Run replay only
on disposable, unprivileged CI workers/containers with network and credential
restrictions enforced outside Node. Do not let a candidate author, replace or
select the trusted suite or the evaluator binary for its own promotion.

## Suite format

The trusted `evals/replay-v1.json` contains version 1 and an array of up to
200 scenarios. Each has:

```json
{
  "id": "authority-title-block",
  "tier": "safety",
  "probe": "authority",
  "input": {
    "domains": [{ "id": "payments", "labels": ["payments"], "words": ["stripe"], "paths": [] }],
    "issue": { "title": "Fix Stripe settlement", "body": "", "labels": [], "comments": [] }
  },
  "expected": { "result": "REQUIRES_FOUNDER", "domains": ["payments"] }
}
```

Supported probes are `authority`, `qa-findings`, `review-findings`, `config`, and
`head-verification`; only their predefined inputs are read. The last probe
uses fixed, synthetic GitHub/Git/gate replies to test the real `verifyHead`
function without contacting a live repository. It cannot replace end-to-end
browser/agent testing. Arbitrary shell commands,
JavaScript, expected verdicts supplied by a candidate, or dynamic success rules
are not supported. The suite must include at least one safety case.

The suite itself should be maintained outside the candidate's write access,
with its hash saved as evidence. Later versions should add hidden/held-out cases,
integration scenarios, agent task success, token/tool cost and elapsed time,
and independently verified merge/policy outcomes.

## Interpreting outcomes

- `EVAL_PASS` means all candidate **contract cases** matched expectations.
  It does not authorize auto-merge or satisfy the current `orca-flow` final-head
  review, authority checks, or independent delivery verification.
- `EVAL_FAIL` means at least one required candidate case failed.
  A candidate is rejected even if the baseline also failed the same case.
- `safetyRegressions` counts **all failed safety cases in the candidate**,
  not just regressions relative to a previously passing baseline. The name is
  intentionally conservative for gating.
- The evaluator never edits or promotes code and never writes to the learning
  database. Adding candidate scoring or promotion requires a separately reviewed PR.

## PR contract replay CI

`.github/workflows/replay.yml` checks proposed changes using two exact SHA checkouts and a
separate trusted checkout of the PR **base** commit. The candidate does not provide its own
scoring code or fixtures to this job. Each checkout disables persisted GitHub credentials,
and the workflow has read-only repository permissions. This is still not an OS sandbox;
use disposable runners without privileged secrets. Protect the workflow and required
check using branch rules/code owner review outside the improvement agent’s credentials.
It must never be possible to satisfy a required replay check merely by removing it from
a candidate branch. The workflow is not a replacement for the fresh-head review gate.

## Next steps

1. Execute realistic agent tasks in fresh disposable worktrees, with mocked
   or isolated external dependencies and a fixed set of success assertions.
2. Capture elapsed time, total inference/tool cost, review rounds and escaped
   defects; compare each strategy over many tasks, including held-out cases.
3. Use a privilege-separated improvement agent only to open draft proposals;
   trusted CI and human review remain the promotion authority.
