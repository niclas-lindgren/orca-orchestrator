// Post-merge cleanup of an issue worktree and branch, refusing anything that could lose work or
// pull the floor from another live session.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { branchFor, resolveIssueWorktree } from "../auto/worktrees.mjs";

/** @type {(command: string, args: string[], cwd: string) => {status: number | null, stdout: string, stderr: string}} */
const defaultExec = (command, args, cwd) => spawnSync(command, args, { cwd, encoding: "utf8" });

/** Processes whose working directory is inside `path` (Linux /proc), excluding this process. */
export function liveHolders(path) {
  const holders = [];
  let root;
  try { root = realpathSync(path); } catch { return holders; }
  for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    if (Number(pid) === process.pid) continue;
    try {
      const cwd = readlinkSync(`/proc/${pid}/cwd`);
      if (cwd === root || cwd.startsWith(`${root}/`)) holders.push(Number(pid));
    } catch { /* process gone or not ours */ }
  }
  return holders;
}

const refuse = (code, detail) => ({ ok: false, code, ...(detail ? { detail } : {}) });

export function cleanupIssue({ repoRoot, issue, exec = defaultExec, holders = liveHolders, exists = existsSync }) {
  const branch = branchFor(issue);
  const resolved = resolveIssueWorktree(repoRoot, issue, exec);
  if (!resolved.ok && resolved.code !== "WORKTREE_NOT_FOUND") return refuse(resolved.code, resolved.error ?? "Unable to enumerate Git worktrees");
  const path = resolved.ok ? resolved.path : null;
  const merged = exec("gh", ["pr", "list", "--head", branch, "--state", "merged", "--json", "number"], repoRoot);
  let mergedPrs = [];
  try { mergedPrs = JSON.parse(merged.stdout || "[]"); } catch { /* treated as unmerged */ }
  if (merged.status !== 0 || mergedPrs.length === 0) return refuse("NOT_MERGED", `${branch} has no merged PR`);
  if (path !== null) {
    if (!exists(path)) return refuse("WORKTREE_MISSING", `${path} is registered but missing on disk`);
    const dirty = exec("git", ["status", "--porcelain", "--untracked-files=all"], path);
    if (dirty.status !== 0 || dirty.stdout.trim()) return refuse("DIRTY_WORKTREE", dirty.stdout.trim().split("\n").slice(0, 5).join("; "));
    const pids = holders(path);
    if (pids.length) return refuse("LIVE_SESSION", `processes with cwd in ${path}: ${pids.join(", ")}`);
    const removed = exec(process.env.ORCA_CLI_COMMAND || "orca", ["worktree", "rm", "--worktree", path, "--delete-branch", "--json"], repoRoot);
    if (removed.status !== 0) return refuse("WORKTREE_REMOVE_FAILED", removed.stderr.trim());
    let receipt = {};
    try { receipt = JSON.parse(removed.stdout || "{}"); } catch { return refuse("WORKTREE_REMOVE_FAILED", "Native Orca returned an invalid removal receipt"); }
    if (receipt.ok !== true) return refuse("WORKTREE_REMOVE_FAILED", receipt.error?.message ?? "Native Orca did not confirm removal");
    const after = resolveIssueWorktree(repoRoot, issue, exec);
    if (!after.ok && after.code === "WORKTREE_DISCOVERY_FAILED") return refuse(after.code, after.error ?? "Unable to verify worktree removal");
    if (after.ok) return refuse("WORKTREE_REMOVE_UNCONFIRMED", `${after.path} remains registered for ${branch}`);
    const outcome = receipt.result ?? receipt;
    const branchRemoved = outcome.branchDeleted === true || outcome.branch?.deleted === true;
    return { ok: true, issue, worktreeRemoved: true, branchRemoved, receipt };
  }
  // A missing worktree is not enough evidence to delete its branch. Native Orca
  // owns branch removal and will only delete changes it can prove merged.
  return { ok: true, issue, worktreeRemoved: false, branchRemoved: false };
}
