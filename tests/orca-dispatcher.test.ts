import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { blockersOf, insideWindow, priorityOf, tick } from "../src/orca/dispatcher.mjs";
import { main, parseArgs } from "../src/orca/cli.mjs";

// Monday 2026-11-02 10:00 UTC = 11:00 in Europe/Oslo, inside the default window.
const NOW = Date.UTC(2026, 10, 2, 10, 0, 0);
const repoRoot = "/repo";

type Lease = { issue: number; owner: string; run_id: string; state: string; lease_expires_at: number };
type Issue = { number: number; title: string; labels: string[]; body?: string };

// A scripted world: the lease store, Orca's worker list and GitHub. Each fake call
// edits it the way the real command would, so a second tick sees the first one.
function world(opts: { issues?: Issue[]; closed?: number[]; prs?: number[]; verdict?: string } = {}) {
  const state = {
    leases: [] as Lease[],
    workers: [] as Array<Record<string, unknown>>,
    issues: opts.issues ?? [],
    closed: new Set(opts.closed ?? []),
    prs: new Set(opts.prs ?? []),
    verdict: opts.verdict ?? "CLEAR",
    ghDown: false,
    orcaListDown: false,
    startOutcome: "ready" as "ready" | "fail",
    adoptRefused: false,
    calls: [] as string[],
    workerStarts: [] as Array<{ args: string[]; retryOf: string | null; task: string | null }>,
  };
  const out = (value: unknown, status = 0) => ({ status, stdout: JSON.stringify(value), stderr: "" });
  const exec = (command: string, args: string[]) => {
    const flag = (name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined) as string;
    if (command === "node") {
      const sub = args[2]; // the fake mirrors the real argv shape: node <bin> auto <sub> ...
      state.calls.push(`auto ${sub}`);
      if (sub === "status") {
        const issue = flag("issue");
        return out({ ok: true, runs: issue ? state.leases.filter((l) => l.issue === Number(issue)) : state.leases });
      }
      if (sub === "claim") {
        const issue = Number(flag("issue"));
        if (state.leases.some((l) => l.issue === issue)) return out({ ok: false, code: "LEASE_CONFLICT" }, 1);
        state.leases.push({ issue, owner: flag("owner"), run_id: flag("run"), state: "IMPLEMENTING", lease_expires_at: NOW + 3_600_000 });
        return out({ ok: true });
      }
      if (sub === "release") {
        state.leases = state.leases.filter((l) => l.issue !== Number(flag("issue")));
        return out({ ok: true });
      }
      if (sub === "renew") return out({ ok: true });
      if (sub === "adopt") {
        const issue = Number(flag("issue"));
        const run = state.leases.find((l) => l.issue === issue);
        if (!run) return out({ ok: false, code: "NO_RUN" }, 1);
        if (state.adoptRefused) return { status: 1, stdout: "", stderr: "LEASE_LIVE" };
        run.owner = flag("owner");
        run.run_id = flag("run");
        run.lease_expires_at = NOW + 3_600_000;
        return out({ ok: true, run });
      }
      if (sub === "handover") return out({ ok: true });
      if (sub === "auth-check") {
        if (state.verdict === "REQUIRES_FOUNDER") state.leases = state.leases.filter((l) => l.issue !== Number(flag("issue")));
        return out({ ok: true, result: state.verdict });
      }
    }
    if (command === "orca") {
      state.calls.push(`orca ${args[0]} ${args[1] ?? ""}`.trim());
      if (args[0] === "status") return out({ ok: true, result: { runtime: { reachable: true } } });
      if (args[0] === "worktree" && args[1] === "show") {
        const path = flag("worktree").slice("path:".length);
        return out({ ok: true, result: { worktree: { id: `ep::${path}`, path } } });
      }
      if (args[1] === "worker-list") return state.orcaListDown ? out({}, 1) : out({ ok: true, result: { workers: state.workers } });
      if (args[1] === "run-create") return out({ ok: true });
      if (args[1] === "worker-start") {
        if (state.startOutcome === "fail") return out({ ok: false }, 1);
        const worktreeId = args[args.indexOf("--worktree") + 1].slice("id:".length);
        state.workerStarts.push({ args, retryOf: flag("retry-of") ?? null, task: flag("task") ?? null });
        state.workers.push({ dispatchId: `ctx_${state.workerStarts.length}`, taskId: "task_new", state: "ready", liveness: "live", workspace: worktreeId });
        return out({ ok: true, result: { state: "ready", dispatchId: `ctx_${state.workerStarts.length}`, taskId: "task_new" } });
      }
    }
    if (command === "gh") {
      if (state.ghDown) return { status: 1, stdout: "", stderr: "network" };
      if (args[0] === "issue" && args[1] === "list") return out(state.issues.map((i) => ({ ...i, labels: i.labels.map((name) => ({ name })) })));
      if (args[0] === "issue" && args[1] === "view") {
        if (args.includes("--jq")) return { status: 0, stdout: `Issue ${args[2]}`, stderr: "" };
        return out({ state: state.closed.has(Number(args[2])) ? "CLOSED" : "OPEN" });
      }
      if (args[0] === "pr") return out(state.prs.has(Number(args[3].replace("agent/issue-", ""))) ? [{ number: 1 }] : []);
    }
    return { status: 1, stdout: "", stderr: `unscripted ${command} ${args.join(" ")}` };
  };
  return { state, exec: exec as never };
}

let stateDir: string;
const enable = (extra: Record<string, unknown> = {}) => writeFileSync(join(stateDir, "dispatcher.json"), JSON.stringify({ enabled: true, ...extra }));
const ready = (number: number, labels: string[] = ["status:ready"], body = ""): Issue => ({ number, title: `Issue ${number}`, labels, body });
const run = async (w: ReturnType<typeof world>, at = NOW) => {
  let n = 0;
  return await tick({ repoRoot, stateDir, exec: w.exec, now: () => at, newRunId: () => `run-${++n}` });
};

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "dispatcher-"));
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

describe("dispatcher tick", () => {
  it("reads Orca's real worker-list shape: workspace path, state and liveness", async () => {
    enable();
    const w = world({ issues: [ready(5)] });
    await run(w);
    const path = "/repo/.worktrees/issue-5";
    const real = (liveness: string, state = "ready") => [{ dispatchId: "ctx_1", state, liveness, workspace: `repo::${path}` }];
    w.state.workers = real("live");
    expect(await run(w)).toMatchObject({ outcome: "AT_CAPACITY", active: [{ issue: 5 }] });
    w.state.workers = real("exited", "failed");
    expect((await run(w)).review).toEqual([{ issue: 5, owner: "dispatcher", runId: "run-1" }]);
    // Orca cannot prove the exit: never finished, always ambiguous.
    w.state.workers = real("unverifiable", "failed");
    const unverifiable = await run(w);
    expect(unverifiable.review).toEqual([]);
    expect(unverifiable.recoverableFailures).toEqual([{ issue: 5, state: "started-unverifiable" }]);
  });

  it("is disabled by default and touches nothing", async () => {
    const w = world({ issues: [ready(5)] });
    expect((await run(w)).outcome).toBe("DISABLED");
    expect(w.state.calls).toEqual([]);
  });

  it("stays disabled when the config is not valid JSON", async () => {
    writeFileSync(join(stateDir, "dispatcher.json"), "{ enabled: true");
    const w = world({ issues: [ready(5)] });
    expect((await run(w)).outcome).toBe("CONFIG_INVALID");
    expect(w.state.calls).toEqual([]);
  });

  it("dispatches one ready issue and records the start", async () => {
    enable();
    const w = world({ issues: [ready(5)] });
    const report = await run(w);
    expect(report.outcome).toBe("DISPATCHED");
    expect(report.dispatched).toEqual([{ issue: 5, runId: "run-1" }]);
    expect(JSON.parse(readFileSync(join(stateDir, "orca-dispatch", "issue-5.json"), "utf8")).state).toBe("started");
    expect(w.state.workers).toHaveLength(1);
    expect(existsSync(join(stateDir, "dispatcher", "status.json"))).toBe(true);
  });

  it("does not dispatch the same issue on a duplicate wake or after a restart", async () => {
    enable({ maxWorkers: 2 });
    const w = world({ issues: [ready(5)] });
    expect((await run(w)).outcome).toBe("DISPATCHED");
    expect((await run(w)).outcome).toBe("IDLE");
    expect((await run(w)).outcome).toBe("IDLE");
    expect(w.state.workers).toHaveLength(1);
  });

  it("holds at capacity while a dispatched worker is live and renews its lease", async () => {
    enable();
    const w = world({ issues: [ready(5), ready(6)] });
    await run(w);
    const second = await run(w);
    expect(second.outcome).toBe("AT_CAPACITY");
    expect(second.active).toHaveLength(1);
    expect(w.state.calls).toContain("auto renew");
    expect(w.state.workers).toHaveLength(1);
  });

  it("frees capacity once the worker has finished and reports the issue for review", async () => {
    enable();
    const w = world({ issues: [ready(5), ready(6)] });
    await run(w);
    w.state.workers = [{ workerState: "stopped", resource: { worktreeId: "ep::/repo/.worktrees/issue-5" } }];
    const report = await run(w);
    expect(report.review.map((r: { issue: number }) => r.issue)).toEqual([5]);
    expect(report.dispatched.map((d: { issue: number }) => d.issue)).toEqual([6]);
  });

  describe("auto-resume of dead workers", () => {
    // An issue the dispatcher started, whose worker provably exited and whose
    // lease lapsed: exactly the state a lost coordinator leaves behind.
    const seed = (w: ReturnType<typeof world>, { retries = 0, liveness = "exited", receipt = { ok: true, result: { state: "ready", dispatchId: "ctx_dead", taskId: "task_5" } } } = {}) => {
      w.state.leases.push({ issue: 5, owner: "dispatcher", run_id: "run-1", state: "IMPLEMENTING", lease_expires_at: NOW - 1 });
      w.state.workers = [{ dispatchId: "ctx_dead", taskId: "task_5", state: "failed", liveness, workspace: "ep::/repo/.worktrees/issue-5" }];
      const dir = join(stateDir, "orca-dispatch");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "issue-5.json");
      writeFileSync(file, JSON.stringify({ issue: 5, runId: "run-1", owner: "dispatcher", state: "started", dispatchReceipt: receipt, resumeRetries: retries }));
      return file;
    };

    it("does nothing unless the operator opted in", async () => {
      enable();
      const w = world({ issues: [] });
      seed(w);
      const report = await run(w);
      expect(report.review.map((r: { issue: number }) => r.issue)).toEqual([5]);
      expect(w.state.calls).not.toContain("auto adopt");
      expect(w.state.workerStarts).toHaveLength(0);
    });

    it("adopts the run and retries the same Task in the existing worktree", async () => {
      enable({ maxWorkers: 2, autoResume: true });
      const w = world({ issues: [] });
      const file = seed(w);
      const report = await run(w);
      expect(report.outcome).toBe("AUTO_RESUMED");
      expect(report.dispatched).toEqual([{ issue: 5, runId: expect.any(String), resumedFrom: "run-1", retryOf: "ctx_dead" }]);
      // The retry names the dead dispatch and its Task instead of a new spec.
      expect(w.state.workerStarts.at(-1)).toMatchObject({ retryOf: "ctx_dead", task: "task_5" });
      expect(w.state.workerStarts.at(-1)!.args).not.toContain("--spec");
      // The confirmed receipt from this start replaces the dead one, so the next
      // resume retries the new dispatch rather than the old chain.
      const written = JSON.parse(readFileSync(file, "utf8"));
      expect(written).toMatchObject({ issue: 5, runId: report.dispatched[0].runId, state: "started", resumeRetries: 1 });
      expect(written.dispatchReceipt.result.dispatchId).not.toBe("ctx_dead");
      expect(written.dispatchReceipt.result.dispatchId).toMatch(/^ctx_/);
      expect(w.state.leases[0]).toMatchObject({ owner: "dispatcher", lease_expires_at: NOW + 3_600_000 });
    });

    it("stops at the retry bound", async () => {
      enable({ maxWorkers: 2, autoResume: true, autoResumeMaxRetries: 1 });
      const w = world({ issues: [] });
      seed(w, { retries: 1 });
      const report = await run(w);
      expect(report.outcome).toBe("IDLE");
      expect(report.skipped).toContainEqual({ issue: 5, reason: "auto-resume retries exhausted (1)" });
      expect(w.state.calls).not.toContain("auto adopt");
    });

    it("does not resume an issue that already has a pull request", async () => {
      enable({ maxWorkers: 2, autoResume: true });
      const w = world({ issues: [], prs: [5] });
      seed(w);
      const report = await run(w);
      expect(report.skipped).toContainEqual({ issue: 5, reason: "delivery PR exists" });
      expect(w.state.workerStarts).toHaveLength(0);
    });

    it("reports a refused adoption without starting a worker", async () => {
      enable({ maxWorkers: 2, autoResume: true });
      const w = world({ issues: [] });
      seed(w);
      w.state.adoptRefused = true;
      const report = await run(w);
      expect(report.skipped).toContainEqual({ issue: 5, reason: "adopt refused: LEASE_LIVE" });
      expect(w.state.workerStarts).toHaveLength(0);
    });

    it("reads a flat receipt written by an earlier version", async () => {
      enable({ maxWorkers: 2, autoResume: true });
      const w = world({ issues: [] });
      seed(w, { receipt: { dispatchId: "ctx_dead", taskId: "task_5" } });
      expect((await run(w)).outcome).toBe("AUTO_RESUMED");
    });

    it("needs a dispatch receipt to know which Task to retry", async () => {
      enable({ maxWorkers: 2, autoResume: true });
      const w = world({ issues: [] });
      seed(w, { receipt: {} });
      const report = await run(w);
      expect(report.skipped).toContainEqual({ issue: 5, reason: "dispatch receipt has no Task to retry" });
      expect(w.state.calls).not.toContain("auto adopt");
    });

    it("stops after a refused start instead of hammering Orca's breaker", async () => {
      enable({ maxWorkers: 2, autoResume: true });
      const w = world({ issues: [] });
      const file = seed(w);
      w.state.startOutcome = "fail";
      const first = await run(w);
      expect(first.errors).toContain("auto-resume #5: WORKER_START_FAILED");
      // The adapter's own state survives the patch: an unconfirmed start must not
      // be rewritten as a normal started record.
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ resumeRetries: 1, autoResumeStopped: "WORKER_START_FAILED", state: "unconfirmed" });
      // The retry chain is Orca's to reopen: the next tick neither retries nor
      // hides the unconfirmed start, which is reported for a person.
      w.state.startOutcome = "ready";
      const second = await run(w);
      expect(second.recoverableFailures).toContainEqual({ issue: 5, state: "unconfirmed" });
      expect(w.state.calls.filter((c) => c === "auto adopt")).toHaveLength(1);
    });

    it("leaves an unverifiable worker alone", async () => {
      enable({ maxWorkers: 2, autoResume: true });
      const w = world({ issues: [] });
      seed(w, { liveness: "unverifiable" });
      const report = await run(w);
      expect(report.outcome).toBe("IDLE");
      expect(w.state.calls).not.toContain("auto adopt");
    });
  });

  it("refuses to run while another tick holds the lock, keeps an old lock whose process is alive, and takes over a dead one", async () => {
    enable();
    mkdirSync(join(stateDir, "dispatcher"), { recursive: true });
    const lock = join(stateDir, "dispatcher", "tick.lock");
    writeFileSync(lock, JSON.stringify({ token: "other", pid: 1, at: NOW - 1000 }));
    const w = world({ issues: [ready(5)] });
    expect((await run(w)).outcome).toBe("TICK_LOCKED");
    expect(w.state.calls).toEqual([]);
    const DEAD_PID = 2_147_483_646;
    writeFileSync(lock, JSON.stringify({ token: "old", pid: process.pid, at: NOW - 3_600_000 }));
    expect((await run(w)).outcome).toBe("TICK_LOCKED");
    writeFileSync(lock, JSON.stringify({ token: "old", pid: DEAD_PID, at: NOW - 3_600_000 }));
    expect((await run(w)).outcome).toBe("DISPATCHED");
    expect(existsSync(lock)).toBe(false);
  });

  it("does not dispatch while paused but still reconciles", async () => {
    enable();
    writeFileSync(join(stateDir, "PAUSED"), "");
    const w = world({ issues: [ready(5)] });
    expect((await run(w)).outcome).toBe("PAUSED");
    expect(w.state.workers).toHaveLength(0);
    expect(w.state.calls).toContain("orca orchestration worker-list");
  });

  it("does not dispatch outside the operating window", async () => {
    enable();
    const w = world({ issues: [ready(5)] });
    expect((await run(w, Date.UTC(2026, 10, 2, 2, 0, 0))).outcome).toBe("OUTSIDE_WINDOW");
    expect(w.state.workers).toHaveLength(0);
  });

  it("counts attempts, not successes, against the daily budget", async () => {
    enable({ dailyStartBudget: 1, maxWorkers: 2 });
    const w = world({ issues: [ready(5), ready(6)] });
    w.state.startOutcome = "fail";
    expect((await run(w)).errors[0]).toContain("record kept");
    // The failed start spent the day's only attempt.
    w.state.startOutcome = "ready";
    rmSync(join(stateDir, "orca-dispatch"), { recursive: true });
    w.state.leases = [];
    expect((await run(w)).outcome).toBe("BUDGET_EXHAUSTED");
    expect(w.state.workers).toHaveLength(0);
  });

  it("treats a corrupted ledger as a spent budget", async () => {
    enable();
    mkdirSync(join(stateDir, "dispatcher"), { recursive: true });
    writeFileSync(join(stateDir, "dispatcher", "ledger.json"), "garbage");
    const w = world({ issues: [ready(5)] });
    expect((await run(w)).outcome).toBe("BUDGET_EXHAUSTED");
  });

  it("starts nothing when GitHub cannot be read", async () => {
    enable();
    const w = world({ issues: [ready(5)] });
    w.state.ghDown = true;
    expect((await run(w)).outcome).toBe("GITHUB_UNAVAILABLE");
    expect(w.state.leases).toEqual([]);
  });

  it("starts nothing when Orca workers cannot be listed", async () => {
    enable();
    const w = world({ issues: [ready(5)] });
    w.state.orcaListDown = true;
    expect((await run(w)).outcome).toBe("RECONCILE_UNRELIABLE");
    expect(w.state.leases).toEqual([]);
  });

  it("fails closed on an unconfirmed start and never retries it", async () => {
    enable({ maxWorkers: 2 });
    const w = world({ issues: [ready(5), ready(6)] });
    w.state.startOutcome = "fail";
    await run(w);
    expect(JSON.parse(readFileSync(join(stateDir, "orca-dispatch", "issue-5.json"), "utf8")).state).toBe("unconfirmed");
    w.state.startOutcome = "ready";
    const again = await run(w);
    expect(again.recoverableFailures).toEqual([{ issue: 5, state: "unconfirmed" }]);
    expect(again.dispatched.map((d: { issue: number }) => d.issue)).toEqual([6]);
    expect(w.state.workers).toHaveLength(1);
  });

  it("treats an unreadable dispatch record as occupying capacity", async () => {
    enable();
    mkdirSync(join(stateDir, "orca-dispatch"), { recursive: true });
    writeFileSync(join(stateDir, "orca-dispatch", "issue-9.json"), "not json");
    const w = world({ issues: [ready(5)] });
    expect((await run(w)).outcome).toBe("AT_CAPACITY");
  });

  it("holds capacity for a fresh claim that never started, then frees an expired one", async () => {
    enable();
    const w = world({ issues: [ready(5)] });
    // Crash between claim and start: a dispatcher lease and no dispatch record.
    w.state.leases.push({ issue: 5, owner: "dispatcher", run_id: "dead", state: "IMPLEMENTING", lease_expires_at: NOW + 60_000 });
    expect((await run(w)).outcome).toBe("AT_CAPACITY");
    w.state.leases[0].lease_expires_at = NOW - 1;
    const report = await run(w);
    expect(report.dispatched.map((d: { issue: number }) => d.issue)).toEqual([5]);
    expect(w.state.workers).toHaveLength(1);
  });

  it("treats a started record with an unidentifiable worker as occupying capacity", async () => {
    enable();
    const w = world({ issues: [ready(6)] });
    mkdirSync(join(stateDir, "orca-dispatch"), { recursive: true });
    writeFileSync(join(stateDir, "orca-dispatch", "issue-5.json"), JSON.stringify({ issue: 5, owner: "dispatcher", runId: "r", state: "started" }));
    w.state.workers = [{ workerState: "active", resource: {} }, { workerState: "active" }];
    const report = await run(w);
    expect(report.outcome).toBe("AT_CAPACITY");
    expect(report.recoverableFailures).toEqual([{ issue: 5, state: "started-worker-unidentified" }]);
  });

  it("treats a worker Orca no longer lists as finished once the lease is terminal", async () => {
    enable();
    const w = world({ issues: [ready(6)] });
    mkdirSync(join(stateDir, "orca-dispatch"), { recursive: true });
    writeFileSync(join(stateDir, "orca-dispatch", "issue-5.json"), JSON.stringify({ issue: 5, owner: "dispatcher", runId: "r", state: "started" }));
    w.state.leases.push({ issue: 5, owner: "dispatcher", run_id: "r", state: "COMPLETE", lease_expires_at: NOW - 1 });
    const report = await run(w);
    expect(report.review.map((r: { issue: number }) => r.issue)).toEqual([5]);
    expect(report.dispatched.map((d: { issue: number }) => d.issue)).toEqual([6]);
  });

  it("stops dispatching when a live worker's lease cannot be renewed", async () => {
    enable({ maxWorkers: 2 });
    const w = world({ issues: [ready(5)] });
    await run(w);
    w.state.issues.push(ready(6));
    const inner = w.exec as unknown as (c: string, a: string[]) => { status: number; stdout: string; stderr: string };
    const failing = ((c: string, a: string[]) => (c === "node" && a[2] === "renew" ? { status: 1, stdout: "", stderr: "boom" } : inner(c, a))) as never;
    const report = await tick({ repoRoot, stateDir, exec: failing, now: () => NOW, newRunId: () => "run-x" });
    expect(report.outcome).toBe("RECONCILE_UNRELIABLE");
    expect(w.state.workers).toHaveLength(1);
  });

  it("stops before claiming when another tick replaced its lock", async () => {
    enable({ maxWorkers: 2 });
    const w = world({ issues: [ready(5)] });
    const inner = w.exec as unknown as (c: string, a: string[]) => { status: number; stdout: string; stderr: string };
    const stealing = ((c: string, a: string[]) => {
      if (c === "gh" && a[0] === "issue" && a[1] === "list") {
        writeFileSync(join(stateDir, "dispatcher", "tick.lock"), JSON.stringify({ token: "thief", pid: process.pid, at: NOW }));
      }
      return inner(c, a);
    }) as never;
    const report = await tick({ repoRoot, stateDir, exec: stealing, now: () => NOW, newRunId: () => "run-x" });
    expect(report.dispatched).toEqual([]);
    expect(report.errors).toContain("tick lock was replaced; stopping");
    expect(w.state.leases).toEqual([]);
    expect(JSON.parse(readFileSync(join(stateDir, "dispatcher", "tick.lock"), "utf8")).token).toBe("thief");
  });

  it("does not reclaim an unreadable lock that was just written", async () => {
    enable();
    mkdirSync(join(stateDir, "dispatcher"), { recursive: true });
    writeFileSync(join(stateDir, "dispatcher", "tick.lock"), "");
    // The file is fresh on disk (real mtime), so a mid-write lock is occupied.
    const w = world({ issues: [ready(5)] });
    expect((await tick({ repoRoot, stateDir, exec: w.exec, now: () => Date.now(), newRunId: () => "r" })).outcome).toBe("TICK_LOCKED");
  });

  it("treats a ledger with an invalid attempt count as a spent budget", async () => {
    enable();
    mkdirSync(join(stateDir, "dispatcher"), { recursive: true });
    writeFileSync(join(stateDir, "dispatcher", "ledger.json"), JSON.stringify({ day: "2026-11-02", attempts: "many" }));
    expect((await run(world({ issues: [ready(5)] }))).outcome).toBe("BUDGET_EXHAUSTED");
  });

  it("skips issues that are blocked, claimed elsewhere, already delivered or excluded", async () => {
    enable({ maxWorkers: 5 });
    const w = world({
      issues: [ready(1, ["status:ready"], "Depends on #90"), ready(2), ready(3), ready(4, ["status:ready", "status:blocked"]), ready(7)],
      closed: [],
      prs: [3],
    });
    w.state.leases.push({ issue: 2, owner: "claude", run_id: "x", state: "IMPLEMENTING", lease_expires_at: NOW + 60_000 });
    const report = await run(w);
    expect(report.dispatched.map((d: { issue: number }) => d.issue)).toEqual([7]);
    expect(report.skipped.map((s: { issue: number }) => s.issue).sort()).toEqual([1, 2, 3, 4]);
  });

  it("dispatches an issue once its dependencies are closed", async () => {
    enable();
    const w = world({ issues: [ready(1, ["status:ready"], "Blocked by #90, #91")], closed: [90, 91] });
    expect((await run(w)).outcome).toBe("DISPATCHED");
  });

  it("orders P0 before other priorities", async () => {
    enable();
    const w = world({ issues: [ready(1, ["status:ready", "priority: P2"]), ready(9, ["status:ready", "priority: P0"])] });
    expect((await run(w)).dispatched.map((d: { issue: number }) => d.issue)).toEqual([9]);
  });

  it("never infers founder approval and keeps unrelated work eligible", async () => {
    enable({ maxWorkers: 2 });
    const w = world({ issues: [ready(1), ready(2)], verdict: "REQUIRES_FOUNDER" });
    const report = await run(w);
    expect(report.dispatched).toEqual([]);
    expect(report.skipped.map((s: { reason: string }) => s.reason)).toEqual(["awaiting founder (REQUIRES_FOUNDER)", "awaiting founder (REQUIRES_FOUNDER)"]);
    expect(w.state.workers).toHaveLength(0);
    expect(w.state.leases).toEqual([]);
    expect(existsSync(join(stateDir, "orca-dispatch", "issue-1.json"))).toBe(false);
  });
});

describe("dispatcher helpers", () => {
  it("reads blockers from dependency lines only", async () => {
    expect(blockersOf("Intro #5\nDepends on #7 and #8\nSee #9")).toEqual([7, 8]);
  });
  it("reads priority labels", async () => {
    expect(priorityOf(["bug", "priority: P1"])).toBe(1);
    expect(priorityOf(["bug"])).toBe(9);
  });
  it("evaluates the window in its own time zone", async () => {
    const window = { startHour: 8, endHour: 20, timeZone: "Europe/Oslo" };
    expect(insideWindow(NOW, window)).toBe(true);
    expect(insideWindow(Date.UTC(2026, 10, 2, 22, 0, 0), window)).toBe(false);
  });
});

describe("orca CLI commands", () => {
  it("parses tick and status without flags", async () => {
    expect(parseArgs(["tick"])).toEqual({ command: "tick" });
    expect(parseArgs(["status"])).toEqual({ command: "status" });
    expect(parseArgs(["tick", "--issue", "5"]).error).toContain("no flags");
  });

  it("status reports disabled, the pause state and the last report", async () => {
    const root = mkdtempSync(join(tmpdir(), "dispatcher-root-"));
    try {
      const first = await main(["status"], { repoRoot: root });
      expect(first.result).toMatchObject({ enabled: false, paused: false, last: null });
      await main(["tick"], { repoRoot: root });
      const second = await main(["status"], { repoRoot: root });
      expect(second.result).toMatchObject({ last: { outcome: "DISABLED" } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
