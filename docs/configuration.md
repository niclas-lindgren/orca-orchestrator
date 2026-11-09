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
