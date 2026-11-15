# Configuration

Everything that differs between repositories lives in `orca.config.json` at the repository root. The
tools and skills hold no repository-specific constants. Create a starter with `orca-orchestrator init`.

| Key | Required by | Meaning |
|---|---|---|
| `repo` | optional | `owner/name` for GitHub calls. Defaults to the `origin` remote. |
| `defaultBranch` | optional (`main`) | The branch PRs target and `verify-head` fetches and compares against. |
| `stateDir` | optional (`.local/auto`) | Where the lease database and dispatch records live. **Ignore it in git.** |
| `gate` | `verify-head`, worker task | `{ "command": "make", "args": ["check"] }`: the one local gate. The worker task and the independent final-head verification both read it, so they cannot name different commands. |
| `review.projectId` / `review.projectName` | all `review-*` commands | The ChatGPT project every review and consult chat must live in. The id is the `g-p-...` segment of the project URL. |
| `workerInstructions` | optional | Lines added to the worker task, for example "Follow AGENTS.md and the docs it routes to." |
| `protectedDomains` | `auth-check` | Kinds of change that need a human decision (see below). With none configured nothing is ever flagged: configure them. |
| `autonomy.profile` | metadata (default: `controlled-execution`) | `product-manager` for proactive Campsty product discovery and proposal preparation, or `controlled-execution` for Hockey/operator-directed work. **Not a grant of write, dispatch, or merge authority.** |

The `learn` commands reuse the configured `stateDir` and repository slug (the repo from
`repo` or `origin`). They store observations in `stateDir/learning.db`. Observations are
segregated by repository even if a state directory is shared; no learning settings grant
permission to bypass protected-domain checks. See [learning.md](learning.md).

## Protected domains

```json
{
  "id": "payments",
  "labels": ["payments"],
  "words": ["payments?", "invoice"],
  "paths": ["^src/billing/", "^prisma/migrations/"]
}
```

`labels` and `paths` or a `words` match in the **issue title** (or a path in the PR diff) is a strong
signal: `auth-check` returns `REQUIRES_FOUNDER`, parks the issue and releases the lease. A `words`
match only in the body or comments is weak: reported, but the result stays `CLEAR`. `words` are regex
stems matched at a word boundary, case-insensitively. Approval is never inferred from a comment or a
label; the coordinating session records the user's in-chat approval with `founder-resume`. Path
patterns are also matched case-insensitively so authorization behavior does not depend on checkout
path casing.

## Example

`examples/camping-booking.orca.config.json` is a complete, real configuration.

## Product autonomy profiles (initial, non-authorizing baseline)

Specify one **named** profile. There are no individual booleans an agent can enable:

```json
{ "autonomy": { "profile": "controlled-execution" } }
```

The missing-profile default is `controlled-execution`. `product-manager` is intended for Campsty only, where the product coordinator may proactively research, run safe persona evaluations, prepare evidence-backed issue proposals and suggest priorities. `controlled-execution` is for Hockey, where any product discovery, issue creation, re-prioritization or implementation must remain inside an operator-requested scope.

**This first change only validates and exposes repository intent; it does not enforce GitHub authorization.** The file is editable by agents in checkout worktrees; it is not a trusted authorization grant. Existing direct `gh`, shell, Pi, Claude and Orca commands are not blocked by this setting. Until a separate trusted decision boundary exists (tracked in the [authorization issue](https://github.com/niclas-lindgren/orca-orchestrator/issues/6)), **neither profile grants permission for autonomous GitHub writes, issue reprioritization, dispatch, merge, publication, or modification of safety rules**. A product agent must not infer authorization from this profile alone. The application must supply separately verified identity, actual scope, approvals and protected-domain checks before those actions.

For rollout: set `product-manager` only in Campsty's `orca.config.json` and `controlled-execution` explicitly in Hockey's. Full product autonomy and native CLI migration are tracked in the [epic](https://github.com/niclas-lindgren/orca-orchestrator/issues/5), [native-Orca issue](https://github.com/niclas-lindgren/orca-orchestrator/issues/7), and [Campsty PM issue](https://github.com/niclas-lindgren/orca-orchestrator/issues/8).
