# orca-orchestrator

Issue-delivery tooling and agent skills for repositories worked on with [Orca](https://orca.build),
shared so that fixes are made once instead of in every repository's private copy.

**Tools** (`orca-orchestrator auto|orca`): a local lease database so two sessions never work the same
issue, claimed worktrees, a protected-domain authority check, a repair ledger with caps, dispatch of
one supervised worker per issue, independent final-head verification, worktree cleanup, and a guarded
ChatGPT review browser (open, send, wait, read, delete-only-what-you-sent).

**Skills** (`skills/`):

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

## Status

v0.1: extracted from the per-repository copies in two projects. Not yet covered: the `orca-deliver`
pilot skill (kept in the originating repository), and a stricter provenance check that ties
`review-delete` to the conversation id returned by `review-send`.
