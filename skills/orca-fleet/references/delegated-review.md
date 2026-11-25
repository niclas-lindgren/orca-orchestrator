# Delegated review loop (opt-in)

By default the fleet coordinator reads each PR, opens the fresh review chat, relays findings and waits. That spends the coordinator's context on every diff and holds its lease through every review round. This reference lets a **worker** run the review/repair loop on its own exact head and hand the coordinator a short summary, while the coordinator keeps every approval and merge decision.

Use it only when the coordinator chose it for the whole fleet before launching workers. A worker never opts itself in. If any precondition below fails, fall back to the default coordinator-reviewed path; do not improvise.

## What stays with the coordinator

The coordinator alone owns: the lease (`claim`, `renew`, `adopt`, `release`), protected-domain authority (`auth-check`, `founder-resume`), CI, `verify-head`, the merge, unbinding and cleanup, and the decision to accept a verdict. A worker's report is a claim, not approval. Delegation moves the review *iterations*, never the *decision*.

## Preconditions

1. The worker is a Pi worker started by the coordinator, with the installed `orca_guard` adapter loaded. After implementation, the worker sends a nonterminal status message with its PR, pushed head and gate evidence without ending the dispatch; reserve `worker_done` for the final handoff. Before the round-0 probe or any review round, the coordinator validates the existing fleet handoff checks and performs serialized-pipeline steps 1 and 2: ensure the PR is open, non-draft and current, renew the lease and repeat plan authority. Only after these succeed does the coordinator explicitly authorize entry into delegated review for the exact issue, PR, dispatch and current head. A browser-slot grant or implementation-complete message is **not review authorization**. A new head requires renewed coordinator authorization before its review round; the worker never runs the authority checks itself.
2. Before round 1 the worker obtains the coordinator's explicit review-slot grant (see below), then proves it can reach the review browser by calling `GUARD orca review-open` and replying to the coordinator with the page id, or the exact error. It releases the slot after the probe. On any error the worker stops and the coordinator reviews instead.
3. The coordinator's task spec supplies `OWNER`, the current guard `RUN_ID`, the issue, the PR number once it exists, and the review request template below. The worker must not claim, renew, adopt, release or `founder-resume`.
4. **One review round at a time across the whole fleet.** The browser is shared; guard commands do not provide a cross-worker browser lock. The coordinator maintains one exclusive review slot for **every browser operation**, including the round-0 probe, review rounds and disputes, coordinator acceptance reads, and chat cleanup. Before touching the browser, a worker asks the coordinator for the review slot (`orchestration ask`) and waits for an explicit grant naming its dispatch and the probe or round. Asking alone is not a grant. Hold the slot through the entire probe or review/dispute exchange, then release it with a status message before repairing. After a coordinator interruption, reconcile any previous slot grant against native worker liveness before issuing another grant. The coordinator must also reserve the slot before its own browser operations and must not grant another holder access until the previous holder has confirmed release or is proven stopped; silence or timeout is not release.

## The worker loop

For each round, on the PR's current head, obtain both exact-head coordinator review authorization and a new exclusive browser-slot grant. A previous round's grant cannot be reused.

1. Confirm the branch is clean, pushed, and `git rev-parse HEAD` equals the GitHub PR head. Record that SHA.
2. `GUARD orca review-open`, then write the request from the template below to `MESSAGE_FILE`, and `GUARD orca review-send --page PAGE_ID --message-file MESSAGE_FILE`. Preserve that exact first-message file for guarded cleanup. Record the conversation with `GUARD auto review-record --issue ISSUE --owner OWNER --run RUN_ID --url CHAT_URL --page PAGE_ID --head HEAD` (owner and run from the spec). Require a successful `ok: true` receipt before continuing to wait, read, dispute or repair. On any refusal (including `LEASE_LOST`), error, timeout or ambiguous recording result, stop immediately and notify the coordinator with the chat URL, page id, exact first message and receipt; do not treat the review as recorded or approved. The coordinator retains this recovery evidence and reconciles the durable record under a valid lease before any continuation.
3. `GUARD orca review-wait --page PAGE_ID`, then `GUARD orca review-read --page PAGE_ID`. Silence, timeout, a stale or different SHA, or ambiguous output is **not approval**: report it and stop.
4. Findings with severity P1 or P2 are blocking. Before repairing them, `GUARD auto repair-record --issue ISSUE --owner OWNER --run RUN_ID --pr PR --head REVIEWED_HEAD --findings-file FILE`. `REVIEWED_HEAD` is the SHA named in the completed review, not a later working-tree commit; check the successful receipt's `pr` and `headSha` against that PR and SHA. The file is JSON: `{"findings":[{"severity":"P2","file":"path","summary":"one sentence"}]}`; a plain Markdown file is rejected. Repair only after `repair-record` succeeds (`ok: true`, action `RECORDED` or `ALREADY_RECORDED`) for the exact issue, PR and reviewed head. On **every other result**, error, timeout or unreadable receipt, **stop immediately** and message the coordinator; do not edit, commit or push a repair. This includes `LEASE_LOST`, a run mismatch, a repair-cap refusal, `PAUSED`, `ISSUE_BLOCKED`, `PR_HEAD_MISMATCH`, `DIRTY_WORKTREE` and `GITHUB_UNAVAILABLE`. The guard's cap is the loop bound; do not exceed it, and never use more than three rounds per PR without asking.
5. Repair on the same branch, run the full configured gate, push, then start the next round with a **new** review chat for the **new** head. An old verdict never carries over.
6. Stop when a round on the current head returns APPROVE with no blocking findings, or when the cap, a blocker, or an unresolved disagreement is reached.

### Disagreeing with the reviewer

A worker may challenge a finding by sending the reviewer concrete source evidence in the same chat. It must not argue about severity without evidence, and must not rely on a retraction it did not quote. Every disagreement is reported to the coordinator verbatim: the finding, the evidence sent, and the reviewer's answer. A finding the reviewer did not explicitly retract or downgrade stays open.

### Review request template

The coordinator fixes this template; a worker fills the blanks and adds nothing else. The request must not steer the verdict (no "this is ready", no asking for approval).

```text
Independent review of <repo> PR #<n>, issue #<issue>, exact head <40-char SHA>, base <base SHA>.
Read the actual diff and source and the live issue and every comment. If anything is inaccessible say UNPROVEN.
Do not modify GitHub or source.

Acceptance criteria (verbatim from the live issue): <criteria>
Protected-domain boundaries and non-goals (verbatim): <list>

Worker-reported evidence, NOT independently verified: <commands and counts, including skips, and known gaps>

Report concrete reachable defects with file:line, evidence, the violated contract, an exact fix and confidence,
separate blocking findings from optional improvements, then give APPROVE or REQUEST_CHANGES for this exact head only.
```

## Handoff summary to the coordinator

Keep it short enough to read without opening the diff. Send it with `worker_done`:

```text
PR / branch / worktree:
Final head SHA (pushed, clean tree):
Rounds run, and the head reviewed in each:
Final review: chat URL, reviewed SHA, verdict, date
Findings: id, severity, file:line, fixed in <sha> | open | disputed
Disputes: verbatim finding, evidence sent, reviewer reply
Gate/tests actually run on the final head: command, exit, counts, skips
Not verified or known gaps:
Guard receipts: review-record and repair-record results
```

## What the coordinator does with it

1. Check `reviewed SHA == final head == PR head`. Any later commit invalidates the review and needs another round. Independently inspect `GUARD orca resume-report --issue ISSUE`: its `reviewChats` must contain the final chat with matching `url`, `page_id`, `head_sha`, `owner` and `run_id` for the authorized review. A missing or mismatched durable record is **not approved**, even if the worker supplies a successful-looking receipt or an APPROVE chat.
2. Read the verdict **from the recorded chat itself** with `GUARD orca review-read --page PAGE_ID` (or open the recorded URL), not from the worker's paraphrase. `review-read` returns only the latest assistant reply; it is **insufficient to verify dispute history**. If any dispute occurred, open the recorded conversation URL and inspect the complete exchange: every original finding, worker evidence, dispute and reviewer reply, independently of the handoff. If the full history is unavailable or cannot be matched to the recorded chat, treat the review as **not approved**. A disputed finding without an explicit retraction or downgrade in that full history counts as open.
3. Check that `repair-record` entries exist for every repaired round.
4. Run `auth-check --phase merge`, wait for CI, then `verify-head`, then `gh pr merge --match-head-commit`.
5. If the summary is incomplete, the verdict is not APPROVE on the exact head, the chat is unreadable, or anything is ambiguous, treat it as **not approved**. Send the worker back or run the default review yourself.
6. The coordinator may spot-check the diff at any time. It need not read it in full when the summary and the chat verdict agree.

Cleanup of the review chats the worker created is the coordinator's, via `review-delete` with the recorded first message, after the merge.
