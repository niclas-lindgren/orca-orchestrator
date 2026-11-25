# Installing `orca-orchestrator`

`orca-orchestrator` separates lifecycle from repository-specific safety:

- the native Orca CLI owns runs, tasks, workers, retries, supervision, and worktrees;
- the shared skill supplies the delivery procedure;
- the installed Pi extension or Claude MCP plugin supplies leases, authority, repair, fresh-review, exact-head, and guarded cleanup commands.

Consumer repositories do **not** install `orca-orchestrator` as an npm dependency and do not add `auto` or `orca` package scripts.

## Prerequisites

- Node.js `>=22.19.0`
- authenticated `gh`
- native Orca CLI available as `orca` or through `ORCA_CLI_COMMAND`
- Orca browser automation available for independent ChatGPT review
- repository `orca.config.json` with the exact gate and delivery policy

Verify native Orca before installation:

```bash
"${ORCA_CLI_COMMAND:-orca}" status --json
"${ORCA_CLI_COMMAND:-orca}" skills get orchestration --full
```

## Pi

Install the package from GitHub (tracks the repository's default branch):

```bash
pi install git:github.com/niclas-lindgren/orca-orchestrator
```

Update an existing installation with either command:

```bash
pi update git:github.com/niclas-lindgren/orca-orchestrator
pi update --extensions  # update all installed Pi packages, including skills
```

Use `pi list` to check the configured source. Add `--local` to `pi install` for project-local configuration; project packages load only after project trust is granted. Restart Pi after installation or update so the new extension and skills are loaded. `pi update` without a target updates Pi itself, not this package.

### Versions and pinned installs

- Unpinned Git sources (as above) or an explicit `@main` follow the branch. Updating fetches merged changes even if the package version is unchanged.
- Git tags and commits are pinned. `pi update --extensions` does **not** advance a configured tag/commit. To upgrade, install the desired published ref, for example `pi install git:github.com/niclas-lindgren/orca-orchestrator@<published-tag>`, then verify the source with `pi list`.
- Local-path packages load from that checkout: update the checkout itself, then restart Pi.
- If using an npm source, consumers need a new version published to npm. Versioned npm specifications stay pinned; change the specification to select another version. Git merges or tags alone do not update npm.

Maintainers bump the package version for shipped extension, guard, skill and consumer-documentation changes, and put their notes under a matching version heading in `CHANGELOG.md`. Pi's **Extension Updates** notification depends on the version increasing, including for Git installs. A version bump alone does not publish an npm package or create a Git tag; see the [development release policy](../AGENTS.md).

The package contributes:

- `orca-flow` and `orca-fleet` skills;
- `orca_guard`, the allowlisted repository guard adapter;
- `orca_status` and `/orca-status` for read-only inspection.

The adapter launches its own bundled guard CLI. It never resolves a binary from the consumer repository.

## Claude Code

Install the plugin from its configured marketplace, or load a checkout for development:

```bash
claude --plugin-dir /path/to/orca-orchestrator
```

The plugin root contains `.mcp.json`, which starts the dependency-free `bin/orca-orchestrator-mcp.mjs` server and exposes `orca_guard`. `${CLAUDE_PROJECT_DIR}` is passed as the repository root; `${CLAUDE_PLUGIN_ROOT}` resolves the bundled server.

After installation, confirm the MCP server is connected and its `orca_guard` tool is visible before claiming an issue.

## Consumer repository setup

Keep only repository policy in the consumer:

1. Add and review `orca.config.json`.
2. Keep the configured gate runnable from every issue worktree.
3. Add repository-local instructions such as `AGENTS.md` or `CLAUDE.md` when needed.
4. Do not add `orca-orchestrator` to `dependencies` or `devDependencies`.
5. Remove legacy scripts:
   ```json
   {
     "scripts": {
       "auto": "orca-orchestrator auto",
       "orca": "orca-orchestrator orca"
     }
   }
   ```

Native lifecycle commands are invoked directly:

```bash
ORCA="${ORCA_CLI_COMMAND:-orca}"
"$ORCA" orchestration run-create --objective "..."
"$ORCA" orchestration task-create --spec "..." --deps '[]'
"$ORCA" orchestration worker-start --task TASK --worktree new-child --agent pi
"$ORCA" worktree create --branch agent/issue-42 --issue 42 --parent-worktree current
"$ORCA" worktree rm --worktree SELECTOR --delete-branch --json
```

Repository guards are tool calls, not shell scripts:

```text
orca_guard({ group: "auto", command: "claim", args: ["--issue", "42", "--owner", "...", "--run", "..."] })
orca_guard({ group: "orca", command: "verify-head", args: ["--issue", "42", "--owner", "...", "--run", "...", "--pr", "99"] })
```

## Migration from v0.2

1. Install/update the Pi or Claude package first.
2. Confirm `orca_guard` loads from the installed package.
3. Confirm native Orca runtime, orchestration skill, worktree commands, and browser backend.
4. Remove consumer npm scripts and the GitHub tarball dependency.
5. Reinstall dependencies to update the lockfile.
6. Search for stale invocations:
   ```bash
   rg 'npm run (auto|orca)|orca-orchestrator (auto|orca)' .
   ```
7. Run the repository gate from a clean native Orca child worktree.

Migration fails closed: do not claim work if native Orca or the installed guard adapter is unavailable.

## Version-skew rule

The installed Pi/Claude package is the source of the shared skills and guard adapter. Native Orca is the source of orchestration semantics. A consumer lockfile no longer pins a separate orchestration implementation, eliminating the previous package-versus-skill skew.
