import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommand } from "../src/auto/cli.mjs";

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
  it("claims only the issue lease and leaves worktree creation to native Orca", () => {
    const { code, result } = claim(5, "r1");
    expect(code).toBe(0);
    expect(result).toMatchObject({ ok: true, lease: { issue: 5, state: "CLAIMED", owner: "claude" } });
    expect(result).not.toHaveProperty("worktree");
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

  it("binds a native Orca dispatch and reports its durable identity", () => {
    claim(7, "r1");
    const bound = runCommand([
      "bind-native", "--issue", "7", "--owner", "claude", "--run", "r1",
      "--native-run", "run-native", "--task", "task-7", "--dispatch", "dispatch-7", "--worktree", "wt-7",
    ], { repoRoot: root, now: 1_000_100 });
    expect(bound).toMatchObject({ code: 0, result: { ok: true, run: { native_run_id: "run-native", native_task_id: "task-7", native_dispatch_id: "dispatch-7", native_worktree: "wt-7" } } });
  });

  it("finalizes a provisional native launch binding without opening a takeover gap", () => {
    claim(6, "r1");
    const pending = runCommand([
      "bind-native", "--issue", "6", "--owner", "claude", "--run", "r1",
      "--native-run", "run-native", "--task", "task-6", "--dispatch", "pending:start-6", "--worktree", "wt-6",
    ], { repoRoot: root, now: 1_000_100 });
    expect(pending.result).toMatchObject({ ok: true, run: { native_dispatch_id: "pending:start-6" } });
    const finalized = runCommand([
      "bind-native", "--issue", "6", "--owner", "claude", "--run", "r1",
      "--native-run", "run-native", "--task", "task-6", "--dispatch", "dispatch-6", "--worktree", "wt-6",
    ], { repoRoot: root, now: 1_000_200 });
    expect(finalized.result).toMatchObject({ ok: true, run: { native_dispatch_id: "dispatch-6" } });
    expect(runCommand([
      "bind-native", "--issue", "6", "--owner", "claude", "--run", "r1",
      "--native-run", "other", "--task", "task-6", "--dispatch", "dispatch-other", "--worktree", "wt-6",
    ], { repoRoot: root, now: 1_000_300 }).result).toMatchObject({ ok: false, code: "NATIVE_BINDING_ACTIVE", dispatchId: "dispatch-6" });
  });

  it("blocks takeover and release while a native dispatch remains bound", () => {
    claim(8, "r1");
    runCommand([
      "bind-native", "--issue", "8", "--owner", "claude", "--run", "r1",
      "--native-run", "run-native", "--task", "task-8", "--dispatch", "dispatch-8", "--worktree", "wt-8",
    ], { repoRoot: root, now: 1_000_100 });
    const lapse = 1_000_000 + 31 * 60_000;
    expect(runCommand(["recover"], { repoRoot: root, now: lapse }).result).toMatchObject({ recovered: [] });
    expect(claim(8, "r2", "pi", lapse + 1).result).toMatchObject({ ok: false, code: "NATIVE_BINDING_ACTIVE", dispatchId: "dispatch-8" });
    expect(runCommand(["release", "--issue", "8", "--owner", "claude", "--run", "r1"], { repoRoot: root, now: lapse }).result)
      .toMatchObject({ ok: false, code: "NATIVE_BINDING_ACTIVE", dispatchId: "dispatch-8" });
  });

  it("requires the exact native dispatch receipt before unbinding and handing off", () => {
    claim(9, "r1");
    runCommand([
      "bind-native", "--issue", "9", "--owner", "claude", "--run", "r1",
      "--native-run", "run-native", "--task", "task-9", "--dispatch", "dispatch-9", "--worktree", "wt-9",
    ], { repoRoot: root, now: 1_000_100 });
    expect(runCommand(["unbind-native", "--issue", "9", "--owner", "claude", "--run", "r1", "--dispatch", "wrong"], { repoRoot: root, now: 1_000_200 }).result)
      .toMatchObject({ ok: false, code: "DISPATCH_MISMATCH", expected: "dispatch-9" });
    expect(runCommand(["unbind-native", "--issue", "9", "--owner", "claude", "--run", "r1", "--dispatch", "dispatch-9"], { repoRoot: root, now: 1_000_300 }).result)
      .toMatchObject({ ok: true, already: false, run: { native_dispatch_id: null } });
    expect(runCommand(["release", "--issue", "9", "--owner", "claude", "--run", "r1"], { repoRoot: root, now: 1_000_400 }).result)
      .toMatchObject({ ok: true, run: { owner: null } });
  });

  it("rejects malformed arguments", () => {
    expect(runCommand(["claim", "--issue", "x", "--owner", "a", "--run", "r"], { repoRoot: root }).code).toBe(2);
    expect(runCommand(["claim", "--issue", "3"], { repoRoot: root }).result).toMatchObject({ code: "INVALID_ARGS" });
    expect(runCommand(["bogus"], { repoRoot: root }).code).toBe(2);
  });
});

