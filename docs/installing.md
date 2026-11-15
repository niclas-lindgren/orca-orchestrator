# Installing `orca-orchestrator`

`orca-orchestrator` v0.3 separates lifecycle from repository-specific safety:

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
"${ORCA_CLI_COMMAND:-orca}" runtime status --json
"${ORCA_CLI_COMMAND:-orca}" skills get orchestration --full
```

## Pi

Install or update the package from GitHub:

```text
/package install git:github.com/niclas-lindgren/orca-orchestrator
/package update orca-orchestrator
```

Restart Pi after installation. The package contributes:

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
