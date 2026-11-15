// Issue-owned branch and worktree guard for the autonomous controller (#962, M1).
// A worktree is created or reused only after the lease claim succeeded, and an
// existing worktree is reused only when it is on the issue's own branch.
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
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

export function ensureWorktree(repoRoot, issue, baseRef = "main") {
  const path = worktreePathFor(repoRoot, issue);
  const branch = branchFor(issue);
  if (existsSync(path)) {
    // Identity is the path plus the shared git dir, not the branch name: an
    // unrelated repository that happens to be on agent/issue-N must not pass.
    const top = git(path, ["rev-parse", "--show-toplevel"]);
    const common = git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const rootCommon = git(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const samePlace = top.status === 0 && realpathSync(top.stdout) === realpathSync(path);
    const sameRepo = common.status === 0 && rootCommon.status === 0 && realpathSync(common.stdout) === realpathSync(rootCommon.stdout);
    if (!samePlace || !sameRepo) return { ok: false, code: "WORKSPACE_MISMATCH", path, expected: branch, actual: null };
    const current = git(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (current.status !== 0 || current.stdout !== branch) {
      return { ok: false, code: "WORKSPACE_MISMATCH", path, expected: branch, actual: current.stdout || null };
    }
    // Uncommitted work from a previous run is evidence: report it, never clean it.
    const status = git(path, ["status", "--porcelain"]);
    if (status.status !== 0) return { ok: false, code: "WORKSPACE_UNREADABLE", path, error: status.stderr || "git status failed" };
    return { ok: true, path, branch, created: false, dirty: status.stdout !== "" };
  }
  const exists = git(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0;
  // Reusing a surviving branch keeps a crashed run's commits; a new branch
  // always starts from the base ref, never from the root's working state.
  const args = exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, baseRef];
  const added = git(repoRoot, args);
  if (added.status !== 0) return { ok: false, code: "WORKTREE_FAILED", path, error: added.stderr };
  return { ok: true, path, branch, created: true, dirty: false };
}
