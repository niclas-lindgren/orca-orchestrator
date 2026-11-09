import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommand } from "../src/auto/cli.mjs";
import { branchFor } from "../src/auto/worktrees.mjs";

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "campsty-auto-cli-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  writeFileSync(join(root, "a.txt"), "a");
  git(root, "add", "a.txt");
  git(root, "commit", "-q", "-m", "init");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const claim = (issue: number, run: string, owner = "claude", now = 1_000_000) =>
  runCommand(["claim", "--issue", String(issue), "--owner", owner, "--run", run], { repoRoot: root, now });

describe("campsty-auto cli", () => {
  it("claims an issue, creates its worktree on the issue branch and reports status", () => {
    const { code, result } = claim(5, "r1");
    expect(code).toBe(0);
    expect(result).toMatchObject({ ok: true, branch: branchFor(5), worktree: join(root, ".worktrees", "issue-5") });
    expect(git(result.worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe("agent/issue-5");
    const status = runCommand(["status"], { repoRoot: root, now: 1_000_001 });
    expect(status.result.runs).toMatchObject([{ issue: 5, state: "CLAIMED", owner: "claude" }]);
  });

  it("refuses a second claimant without touching the worktree", () => {
    claim(5, "r1");
    const second = claim(5, "r2", "pi", 1_000_100);
    expect(second.code).toBe(1);
    expect(second.result).toMatchObject({ ok: false, code: "LEASE_CONFLICT", holder: "claude" });
  });

  describe("an issue with an Orca worker dispatched for it (#1109)", () => {
    const writeRecord = (issue: number, run: string, state: string, owner = "claude") => {
      const dir = join(root, ".local", "auto", "orca-dispatch");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `issue-${issue}.json`), `${JSON.stringify({ issue, runId: run, owner, state })}\n`);
    };
    // A 30 second lease that has run out by the time anyone else asks.
    const claimShort = (issue: number, run: string) =>
      runCommand(["claim", "--issue", String(issue), "--owner", "claude", "--run", run, "--ttl-min", "0.5"], {
        repoRoot: root,
        now: 1_000_000,
      });

    it("refuses another session even after the lease expired, and leaves the worktree alone", () => {
      claimShort(5, "r1");
      writeRecord(5, "r1", "started");

      const second = claim(5, "r2", "pi", 1_000_000 + 31_000);

      expect(second.code).toBe(1);
      expect(second.result).toMatchObject({
        ok: false,
        code: "DISPATCH_ACTIVE",
        record: { runId: "r1", owner: "claude", state: "started" },
      });
      // The expired lease was not handed over.
      const status = runCommand(["status", "--issue", "5"], { repoRoot: root, now: 1_000_000 + 31_000 });
      expect(status.result.runs[0]).toMatchObject({ owner: "claude", run_id: "r1" });
    });

    it.each(["starting", "started", "unconfirmed"])("treats a %s dispatch as live", (state) => {
      claimShort(5, "r1");
      writeRecord(5, "r1", state);

      expect(claim(5, "r2", "pi", 1_000_000 + 31_000).result).toMatchObject({ ok: false, code: "DISPATCH_ACTIVE" });
    });

    it("lets the coordinating run that dispatched the worker reclaim its own expired lease", () => {
      claimShort(5, "r1");
      writeRecord(5, "r1", "started");

      const again = claim(5, "r1", "claude", 1_000_000 + 31_000);

      expect(again.result).toMatchObject({ ok: true });
    });

    it("lets another session claim once the operator has recovered (record removed) or when no worker started", () => {
      claimShort(5, "r1");
      writeRecord(5, "r1", "not-started");
      expect(claim(5, "r2", "pi", 1_000_000 + 31_000).result).toMatchObject({ ok: true });

      claimShort(6, "r1");
      writeRecord(6, "r1", "started");
      rmSync(join(root, ".local", "auto", "orca-dispatch", "issue-6.json"));
      expect(claim(6, "r2", "pi", 1_000_000 + 31_000).result).toMatchObject({ ok: true });
    });

    it("rolls the lease back and refuses when the record appears between the first look and the claim", () => {
      claimShort(5, "r1");
      // Session B looked (no record), then claims the expired lease; meanwhile A writes its record.
      const raced = runCommand(["claim", "--issue", "5", "--owner", "pi", "--run", "r2"], {
        repoRoot: root,
        now: 1_000_000 + 31_000,
        afterLeaseAcquired: () => writeRecord(5, "r1", "starting"),
      });

      expect(raced.result).toMatchObject({ ok: false, code: "DISPATCH_ACTIVE", record: { runId: "r1", state: "starting" } });
      // B did not keep the lease it briefly took.
      const status = runCommand(["status", "--issue", "5"], { repoRoot: root, now: 1_000_000 + 31_000 });
      expect(status.result.runs[0].owner).not.toBe("pi");
    });

    it.each([
      ["a record that is not JSON", "{not json"],
      ["a JSON null", "null"],
      ["a JSON array", "[]"],
      ["an unknown state", JSON.stringify({ issue: 5, runId: "r1", owner: "claude", state: "mystery" })],
    ])("fails closed on %s", (_label, body) => {
      claimShort(5, "r1");
      const dir = join(root, ".local", "auto", "orca-dispatch");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "issue-5.json"), body);

      expect(claim(5, "r2", "pi", 1_000_000 + 31_000).result).toMatchObject({ ok: false, code: "DISPATCH_ACTIVE" });
    });

    it("does not affect an issue without a record", () => {
      claimShort(8, "r1");

      expect(claim(8, "r2", "pi", 1_000_000 + 31_000).result).toMatchObject({ ok: true });
    });
  });

  it("releases the lease and reports a mismatch when the worktree is on another branch", () => {
    mkdirSync(join(root, ".worktrees"), { recursive: true });
    git(root, "worktree", "add", "-b", "other", join(root, ".worktrees", "issue-7"));
    const { code, result } = claim(7, "r1");
    expect(code).toBe(1);
    expect(result).toMatchObject({ ok: false, code: "WORKSPACE_MISMATCH", expected: "agent/issue-7", actual: "other" });
    const status = runCommand(["status", "--issue", "7"], { repoRoot: root, now: 1_000_001 });
    expect(status.result.runs[0].owner).toBeNull();
  });

  it("rejects a directory that is another repository on a same-named branch", () => {
    const other = join(root, ".worktrees", "issue-9");
    mkdirSync(other, { recursive: true });
    git(other, "init", "-q", "-b", "agent/issue-9");
    expect(claim(9, "r1").result).toMatchObject({ ok: false, code: "WORKSPACE_MISMATCH" });
  });

  it("reports uncommitted work on reuse without cleaning it", () => {
    const first = claim(10, "r1");
    writeFileSync(join(first.result.worktree, "wip.txt"), "x");
    const again = claim(10, "r1", "claude", 1_000_100);
    expect(again.result).toMatchObject({ ok: true, dirty: true });
    expect(existsSync(join(first.result.worktree, "wip.txt"))).toBe(true);
  });

  it("keeps the live lease when a repeated claim fails on the worktree", () => {
    const first = claim(11, "r1");
    rmSync(first.result.worktree, { recursive: true, force: true });
    git(root, "worktree", "add", "-f", join(root, "elsewhere"), "agent/issue-11");
    const again = claim(11, "r1", "claude", 1_000_100);
    expect(again.result).toMatchObject({ ok: false, code: "WORKTREE_FAILED" });
    const status = runCommand(["status", "--issue", "11"], { repoRoot: root, now: 1_000_200 });
    expect(status.result.runs[0]).toMatchObject({ owner: "claude", run_id: "r1" });
  });

  it("reuses the issue branch after release and recovers expired leases", () => {
    const first = claim(8, "r1");
    writeFileSync(join(first.result.worktree, "b.txt"), "b");
    git(first.result.worktree, "add", "b.txt");
    git(first.result.worktree, "commit", "-q", "-m", "work");
    const lapse = 1_000_000 + 31 * 60_000;
    expect(runCommand(["recover"], { repoRoot: root, now: lapse }).result).toMatchObject({ recovered: [8] });
    const again = claim(8, "r2", "claude", lapse + 1);
    expect(again.result).toMatchObject({ ok: true, lease: { state: "CLAIMED", run_id: "r2" } });
    expect(existsSync(join(again.result.worktree, "b.txt"))).toBe(true);
  });

  it("rejects malformed arguments", () => {
    expect(runCommand(["claim", "--issue", "x", "--owner", "a", "--run", "r"], { repoRoot: root }).code).toBe(2);
    expect(runCommand(["claim", "--issue", "3"], { repoRoot: root }).result).toMatchObject({ code: "INVALID_ARGS" });
    expect(runCommand(["bogus"], { repoRoot: root }).code).toBe(2);
  });
});

