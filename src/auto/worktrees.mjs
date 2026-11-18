// Issue branch naming and fail-closed discovery of the native Orca worktree.
// Creation is native Orca's job (`orca worktree create`); nothing here shells out to `git worktree add`.
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export const branchFor = (issue) => `agent/issue-${issue}`;
export const worktreePathFor = (repoRoot, issue) => join(repoRoot, ".worktrees", `issue-${issue}`);

// Native Orca may place an issue worktree anywhere. Discovery is fail-closed:
// callers must distinguish an absent worktree from a failed Git query instead
// of silently guessing the legacy `.worktrees` path.
export function resolveIssueWorktree(repoRoot, issue, exec = (_command, args, cwd) => git(cwd, args)) {
  const result = exec("git", ["worktree", "list", "--porcelain"], repoRoot);
  if (result.status !== 0) {
    return { ok: false, code: "WORKTREE_DISCOVERY_FAILED", error: result.stderr?.trim() || "git worktree list failed" };
  }
  const wanted = `refs/heads/${branchFor(issue)}`;
  for (const block of (result.stdout ?? "").split(/\n\s*\n/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    const branch = /^branch (.+)$/m.exec(block)?.[1];
    if (path && branch === wanted) return { ok: true, path, branch: branchFor(issue) };
  }
  return { ok: false, code: "WORKTREE_NOT_FOUND", branch: branchFor(issue) };
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: result.status, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
}
