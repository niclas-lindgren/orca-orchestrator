import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommand } from "../src/auto/cli.mjs";
import { adoptRun, bindNativeWorker, claimIssue, getRun, handoverRun, openState, recoverExpired, releaseLease, renewLease, transfersFor, unbindNativeWorker } from "../src/auto/state.mjs";
import { classifyWorker, worktreeWorkerStatus } from "../src/orca/workers.mjs";
import { resumePreface, resumeReport } from "../src/orca/resume.mjs";
import { buildTaskSpec } from "../src/orca/adapter.mjs";
import { activeConfig } from "../src/config.mjs";

const T0 = 1_000_000;
const TTL = 30 * 60_000;
const later = T0 + TTL + 1;

describe("run handover and adoption (state)", () => {
  it("adopts an expired run, keeping its position and native binding, and fences the old identity", () => {
    const db = openState(":memory:");
    claimIssue(db, { issue: 7, owner: "a", runId: "r1", now: T0 });
    db.prepare("UPDATE runs SET state = 'IMPLEMENTING', attempts = 2 WHERE issue = 7").run();
    bindNativeWorker(db, { issue: 7, owner: "a", runId: "r1", nativeRunId: "run_1", taskId: "task_1", dispatchId: "ctx_1", worktree: "id:wt", now: T0 });
    // The coordinator died: the native binding blocks recovery, a claim and an unbind by anyone else...
    expect(recoverExpired(db, { now: later })).toEqual([]);
    expect(claimIssue(db, { issue: 7, owner: "b", runId: "r2", now: later })).toMatchObject({ ok: false, code: "NATIVE_BINDING_ACTIVE" });
    expect(unbindNativeWorker(db, { issue: 7, owner: "b", runId: "r2", dispatchId: "ctx_1" })).toMatchObject({ code: "NOT_OWNER" });
    // ...but an explicit adoption of the run that was inspected succeeds.
    const adopted = adoptRun(db, { issue: 7, owner: "b", runId: "r2", fromRunId: "r1", now: later });
    expect(adopted).toMatchObject({ ok: true, resumedFrom: "IMPLEMENTING", run: { state: "IMPLEMENTING", owner: "b", run_id: "r2", attempts: 2, native_dispatch_id: "ctx_1" } });
    expect(renewLease(db, { issue: 7, owner: "a", runId: "r1", now: later + 1 })).toMatchObject({ code: "LEASE_LOST" });
    expect(unbindNativeWorker(db, { issue: 7, owner: "b", runId: "r2", dispatchId: "ctx_1", now: later + 2 })).toMatchObject({ ok: true });
    expect(transfersFor(db, 7)).toMatchObject([{ kind: "adopt", from_run_id: "r1", to_run_id: "r2", from_state: "IMPLEMENTING", native_dispatch_id: "ctx_1" }]);
  });

  it("restores the pre-expiry state of an EXPIRED run and moves its repair counters", () => {
    const db = openState(":memory:");
    claimIssue(db, { issue: 7, owner: "a", runId: "r1", now: T0 });
    db.prepare("UPDATE runs SET state = 'REVIEWING' WHERE issue = 7").run();
    db.prepare("INSERT INTO repair_findings (issue, run_id, key, repairs) VALUES (7, 'r1', 'k', 2)").run();
    db.prepare("INSERT INTO authority_approvals (issue, run_id, block_id, domain, approved_at) VALUES (7, 'r1', 1, 'billing', 1)").run();
    expect(recoverExpired(db, { now: later })).toEqual([7]);
    expect(getRun(db, 7)).toMatchObject({ state: "EXPIRED", expired_from_state: "REVIEWING" });
    expect(adoptRun(db, { issue: 7, owner: "b", runId: "r2", fromRunId: "r1", now: later }).run).toMatchObject({ state: "REVIEWING", expired_from_state: null });
    expect(db.prepare("SELECT run_id FROM repair_findings WHERE issue = 7").get()).toMatchObject({ run_id: "r2" });
    // Approval was given to the old session and is not inherited.
    expect(db.prepare("SELECT run_id FROM authority_approvals WHERE issue = 7").get()).toMatchObject({ run_id: "r1" });
  });

  it("refuses a live lease, a wrong or reused run id, and terminal runs", () => {
    const db = openState(":memory:");
    claimIssue(db, { issue: 7, owner: "a", runId: "r1", now: T0 });
    expect(adoptRun(db, { issue: 7, owner: "b", runId: "r2", fromRunId: "r1", now: T0 + 1 })).toMatchObject({ ok: false, code: "LEASE_LIVE", holder: "a" });
    expect(adoptRun(db, { issue: 7, owner: "b", runId: "r2", fromRunId: "other", now: later })).toMatchObject({ ok: false, code: "RUN_MISMATCH", expected: "r1" });
    expect(adoptRun(db, { issue: 7, owner: "b", runId: "r1", fromRunId: "r1", now: later })).toMatchObject({ ok: false, code: "INVALID_ARGS" });
    expect(adoptRun(db, { issue: 8, owner: "b", runId: "r2", fromRunId: "r1", now: later })).toMatchObject({ ok: false, code: "NO_RUN" });
    db.prepare("UPDATE runs SET state = 'PARKED' WHERE issue = 7").run();
    expect(adoptRun(db, { issue: 7, owner: "b", runId: "r2", fromRunId: "r1", now: later })).toMatchObject({ ok: false, code: "ISSUE_TERMINAL" });
  });

  it("lets the holder hand over at once, even with a native binding that blocks release", () => {
    const db = openState(":memory:");
    claimIssue(db, { issue: 7, owner: "a", runId: "r1", now: T0 });
    bindNativeWorker(db, { issue: 7, owner: "a", runId: "r1", nativeRunId: "n", taskId: "t", dispatchId: "d", worktree: "w", now: T0 });
    expect(releaseLease(db, { issue: 7, owner: "a", runId: "r1" })).toMatchObject({ code: "NATIVE_BINDING_ACTIVE" });
    expect(handoverRun(db, { issue: 7, owner: "x", runId: "r1", now: T0 + 5 })).toMatchObject({ code: "NOT_OWNER" });
    expect(handoverRun(db, { issue: 7, owner: "a", runId: "r1", now: T0 + 5 }).ok).toBe(true);
    expect(renewLease(db, { issue: 7, owner: "a", runId: "r1", now: T0 + 6 })).toMatchObject({ code: "LEASE_LOST" });
    expect(adoptRun(db, { issue: 7, owner: "b", runId: "r2", fromRunId: "r1", now: T0 + 6 })).toMatchObject({ ok: true, run: { state: "CLAIMED", native_dispatch_id: "d" } });
    expect(transfersFor(db, 7).map((t) => t.kind)).toEqual(["handover", "adopt"]);
  });

  it("upgrades a store created before transfers existed", () => {
    const db = openState(":memory:");
    expect(db.prepare("SELECT COUNT(*) AS n FROM run_transfers").get()).toMatchObject({ n: 0 });
  });
});

describe("worker classification (Orca 1.4 worker-list shape)", () => {
  const row = (over: Record<string, unknown>) => ({ dispatchId: "d", workspace: "repo::/w/issue-1", ...over });
  it("reads liveness first and never treats unverifiable as dead", () => {
    expect(classifyWorker(row({ state: "ready", liveness: "live" }))).toBe("live");
    expect(classifyWorker(row({ state: "failed", liveness: "exited" }))).toBe("dead");
    expect(classifyWorker(row({ state: "failed", liveness: "unverifiable" }))).toBe("unverifiable");
    expect(classifyWorker(row({ state: "succeeded" }))).toBe("dead");
    expect(classifyWorker({ workerState: "active", resource: { worktreeId: "x" } })).toBe("live");
  });
  it("matches the exact worktree path, not a suffix of another one", () => {
    const rows = [row({ liveness: "live" })];
    expect(worktreeWorkerStatus(rows, "/w/issue-1")).toBe("live");
    expect(worktreeWorkerStatus(rows, "/other/w/issue-1")).toBe("none");
    expect(worktreeWorkerStatus([row({ liveness: "exited" }), row({ liveness: "unverifiable" })], "/w/issue-1")).toBe("unverifiable");
    expect(worktreeWorkerStatus([row({ liveness: "exited" })], "/w/issue-1")).toBe("dead");
  });
});

describe("resume report", () => {
  let root: string;
  const git = (cwd: string, ...a: string[]) => {
    const r = spawnSync("git", a, { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "orca-resume-"));
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "t@example.com");
    git(root, "config", "user.name", "t");
    writeFileSync(join(root, "a.txt"), "a");
    git(root, "add", "a.txt");
    git(root, "commit", "-qm", "init");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  // Real git for the worktree; scripted Orca and GitHub.
  const world = (opts: { workers?: unknown[]; prs?: unknown[]; ghDown?: boolean } = {}) => {
    const exec = (command: string, args: string[], cwd: string) => {
      const out = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: "" });
      if (command === "orca" && args[0] === "worktree") return out({ ok: true, result: { worktree: { id: `repo::${args[3].slice(5)}`, path: args[3].slice(5) } } });
      if (command === "orca" && args[1] === "worker-list") return out({ ok: true, result: { workers: opts.workers ?? [] } });
      if (command === "gh") return opts.ghDown ? { status: 1, stdout: "", stderr: "offline" } : out(opts.prs ?? []);
      return spawnSync(command, args, { cwd, encoding: "utf8" }) as never;
    };
    return exec as never;
  };
  const report = (db: ReturnType<typeof openState>, exec: never, now = later) => resumeReport({ repoRoot: root, issue: 7, db, stateDir: join(root, ".local/auto"), exec, now });
  const addWorktree = () => {
    const path = join(root, "..", `wt-${Math.random().toString(36).slice(2)}`);
    git(root, "worktree", "add", "-q", "-b", "agent/issue-7", path);
    return path;
  };

  it("recommends a fresh start when nothing exists", () => {
    expect(report(openState(":memory:"), world())).toMatchObject({ recommendation: "START_FRESH", lease: null });
  });

  it("launches an agent in the existing worktree for an expired, unbound run (scenario 1)", () => {
    const path = addWorktree();
    writeFileSync(join(path, "b.txt"), "work");
    git(path, "add", "b.txt");
    git(path, "commit", "-qm", "feat: half done");
    writeFileSync(join(path, "c.txt"), "wip");
    const db = openState(":memory:");
    claimIssue(db, { issue: 7, owner: "a", runId: "r1", now: T0 });
    recoverExpired(db, { now: later });
    const r = report(db, world());
    expect(r).toMatchObject({ recommendation: "LAUNCH_WORKER_IN_EXISTING_WORKTREE", lease: { state: "EXPIRED", live: false }, worktree: { dirtyPaths: ["c.txt"], pushed: false } });
    expect(r.worktree.commitsAheadOfBase[0]).toMatch(/feat: half done/);
    expect(r.next[0]).toContain("--from-run r1");
    expect(r.specPreface.join("\n")).toMatch(/do not restart/);
    rmSync(path, { recursive: true, force: true });
  });

  it("attaches to a live bound worker and restarts on the same Task when it provably exited (scenario 2)", () => {
    const path = addWorktree();
    const db = openState(":memory:");
    claimIssue(db, { issue: 7, owner: "a", runId: "r1", now: T0 });
    bindNativeWorker(db, { issue: 7, owner: "a", runId: "r1", nativeRunId: "n", taskId: "task_1", dispatchId: "ctx_1", worktree: "id:wt", now: T0 });
    const wk = (liveness: string) => ({ dispatchId: "ctx_1", taskId: "task_1", state: "ready", liveness, workspace: `repo::${path}` });
    expect(report(db, world({ workers: [wk("live")] }))).toMatchObject({ recommendation: "ATTACH_LIVE_WORKER" });
    expect(report(db, world({ workers: [wk("unverifiable")] }))).toMatchObject({ recommendation: "WORKER_UNVERIFIABLE" });
    const dead = report(db, world({ workers: [wk("exited")] }));
    expect(dead).toMatchObject({ recommendation: "RESTART_WORKER_ON_SAME_TASK", binding: { taskId: "task_1", dispatchId: "ctx_1" } });
    expect(dead.next.join("\n")).toContain("--retry-of ctx_1");
    expect(report(db, world(), later - TTL).recommendation).toBe("LEASE_LIVE");
    rmSync(path, { recursive: true, force: true });
  });

  it("refuses to recommend when a source is unreadable, and stops on a merged PR", () => {
    const db = openState(":memory:");
    expect(report(db, world({ ghDown: true }))).toMatchObject({ recommendation: "UNRELIABLE" });
    expect(report(db, world({ prs: [{ number: 3, state: "MERGED" }] }))).toMatchObject({ recommendation: "CLEANUP" });
  });

  it("puts the resume context into the worker spec", () => {
    const spec = buildTaskSpec({ issue: 7, title: "T", branch: "agent/issue-7", worktree: "/w", gate: { label: "g" } as never, instructions: activeConfig().workerInstructions, resume: { commitsAheadOfBase: ["abc feat: x"], dirtyPaths: ["c.txt"], pr: { number: 4, state: "open" }, openFindings: ["k: 1"] } });
    expect(spec).toContain("abc feat: x");
    expect(spec).toContain("Pull request #4");
    expect(spec).toContain("k: 1");
    expect(resumePreface({})).toHaveLength(1);
  });
});

describe("adopt / handover commands", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "orca-adopt-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const cmd = (args: string[], now: number) => runCommand(args, { repoRoot: root, stateDir: join(root, "auto"), now });
  const claim = (run: string, now = T0) => cmd(["claim", "--issue", "5", "--owner", "a", "--run", run], now);

  it("requires --from-run, and rewrites the dispatch record to the adopter", () => {
    claim("r1");
    const dir = join(root, "auto", "orca-dispatch");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "issue-5.json"), JSON.stringify({ issue: 5, runId: "r1", owner: "a", state: "started" }));
    expect(cmd(["adopt", "--issue", "5", "--owner", "b", "--run", "r2"], later).code).toBe(2);
    expect(cmd(["adopt", "--issue", "5", "--owner", "b", "--run", "r2", "--from-run", "r1"], T0 + 1).result).toMatchObject({ code: "LEASE_LIVE" });
    expect(cmd(["adopt", "--issue", "5", "--owner", "b", "--run", "r2", "--from-run", "r1"], later).result).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(join(dir, "issue-5.json"), "utf8"))).toMatchObject({ runId: "r2", owner: "b", state: "started", adoptedFrom: { runId: "r1" } });
  });

  it("refuses to adopt past a dispatch record that belongs to another run", () => {
    claim("r1");
    const dir = join(root, "auto", "orca-dispatch");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "issue-5.json"), JSON.stringify({ issue: 5, runId: "zzz", owner: "x", state: "started" }));
    expect(cmd(["adopt", "--issue", "5", "--owner", "b", "--run", "r2", "--from-run", "r1"], later)).toMatchObject({ code: 1, result: { code: "DISPATCH_ACTIVE" } });
  });

  it("hands over through the CLI and honours the pause switch", () => {
    claim("r1");
    expect(cmd(["handover", "--issue", "5", "--owner", "a", "--run", "r1"], T0 + 1).result.ok).toBe(true);
    cmd(["pause"], T0 + 2);
    expect(cmd(["adopt", "--issue", "5", "--owner", "b", "--run", "r2", "--from-run", "r1"], T0 + 3).result).toMatchObject({ code: "PAUSED" });
    cmd(["resume"], T0 + 4);
    expect(cmd(["adopt", "--issue", "5", "--owner", "b", "--run", "r2", "--from-run", "r1"], T0 + 5).result.ok).toBe(true);
  });
});
