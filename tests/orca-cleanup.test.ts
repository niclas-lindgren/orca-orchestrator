import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/orca/cli.mjs";
import { cleanupIssue } from "../src/orca/cleanup.mjs";

function setup({ merged = true, dirty = "", pids = [], receipt = { ok: true, result: { branchDeleted: true } }, discoveryFails = false }: {
  merged?: boolean;
  dirty?: string;
  pids?: number[];
  receipt?: Record<string, unknown>;
  discoveryFails?: boolean;
} = {}) {
  const calls: string[] = [];
  let worktreeLists = 0;
  const exec = (c: string, a: string[]) => {
    calls.push(`${c} ${a.join(" ")}`);
    if (c === "gh") return { status: 0, stderr: "", stdout: JSON.stringify(merged ? [{ number: 5 }] : []) };
    if (c === "git" && a[0] === "worktree") {
      worktreeLists += 1;
      if (discoveryFails) return { status: 1, stderr: "list failed", stdout: "" };
      return { status: 0, stderr: "", stdout: worktreeLists === 1 ? "worktree /r/native/issue-7\nbranch refs/heads/agent/issue-7\n" : "" };
    }
    if (a[0] === "status") return { status: 0, stderr: "", stdout: dirty };
    if (a[0] === "worktree" && a[1] === "rm") return { status: 0, stderr: "", stdout: JSON.stringify(receipt) };
    return { status: 0, stderr: "", stdout: "" };
  };
  return { calls, run: () => cleanupIssue({ repoRoot: "/r", issue: 7, exec, holders: () => pids, exists: () => true }) };
}

describe("orca cleanup", () => {
  it("removes worktree and branch after a merged PR", () => {
    const t = setup();
    expect(t.run()).toMatchObject({ ok: true, branchRemoved: true });
    expect(t.calls.some((call) => call.includes("worktree rm --worktree /r/native/issue-7 --delete-branch --json"))).toBe(true);
    expect(t.calls.some((call) => call.startsWith("git branch -D"))).toBe(false);
  });

  it("fails closed when worktree discovery or the native receipt is invalid", () => {
    expect(setup({ discoveryFails: true }).run()).toMatchObject({ ok: false, code: "WORKTREE_DISCOVERY_FAILED" });
    expect(setup({ receipt: { ok: false } }).run()).toMatchObject({ ok: false, code: "WORKTREE_REMOVE_FAILED" });
  });

  it.each([
    ["unmerged", { merged: false }, "NOT_MERGED"],
    ["dirty", { dirty: " M a.ts" }, "DIRTY_WORKTREE"],
    ["live session", { pids: [4242] }, "LIVE_SESSION"],
  ])("refuses and removes nothing when %s", (_n, opts, code) => {
    const t = setup(opts);
    expect(t.run()).toMatchObject({ ok: false, code });
    expect(t.calls.some((c) => c.includes("worktree rm --worktree") || c.startsWith("git branch -D"))).toBe(false);
  });

  it("parses the cleanup command", () => {
    expect(parseArgs(["cleanup", "--issue", "7"])).toEqual({ command: "cleanup", issue: 7 });
    expect(parseArgs(["cleanup"])).toMatchObject({ error: expect.any(String) });
  });
});
