import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/orca/cli.mjs";
import { cleanupIssue } from "../src/orca/cleanup.mjs";

function setup({ merged = true, dirty = "", pids = [] as number[] } = {}) {
  const calls: string[] = [];
  const exec = (c: string, a: string[]) => {
    calls.push(`${c} ${a.join(" ")}`);
    if (c === "gh") return { status: 0, stderr: "", stdout: JSON.stringify(merged ? [{ number: 5 }] : []) };
    if (a[0] === "status") return { status: 0, stderr: "", stdout: dirty };
    return { status: 0, stderr: "", stdout: "" };
  };
  return { calls, run: () => cleanupIssue({ repoRoot: "/r", issue: 7, exec, holders: () => pids, exists: () => true }) };
}

describe("orca cleanup", () => {
  it("removes worktree and branch after a merged PR", () => {
    const t = setup();
    expect(t.run()).toMatchObject({ ok: true, branchRemoved: true });
    expect(t.calls).toContain("git worktree remove /r/.worktrees/issue-7");
    expect(t.calls).toContain("git branch -D agent/issue-7");
  });

  it.each([
    ["unmerged", { merged: false }, "NOT_MERGED"],
    ["dirty", { dirty: " M a.ts" }, "DIRTY_WORKTREE"],
    ["live session", { pids: [4242] }, "LIVE_SESSION"],
  ])("refuses and removes nothing when %s", (_n, opts, code) => {
    const t = setup(opts);
    expect(t.run()).toMatchObject({ ok: false, code });
    expect(t.calls.some((c) => c.startsWith("git worktree remove") || c.startsWith("git branch -D"))).toBe(false);
  });

  it("parses the cleanup command", () => {
    expect(parseArgs(["cleanup", "--issue", "7"])).toEqual({ command: "cleanup", issue: 7 });
    expect(parseArgs(["cleanup"])).toMatchObject({ error: expect.any(String) });
  });
});
