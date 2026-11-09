import { AUTO_CLI } from "../src/paths.mjs";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertAuthorityPermits,
  assertRuntimeReady,
  buildDispatchPlan,
  buildTaskSpec,
  dispatch,
  leaseHeldBy,
} from "../src/orca/adapter.mjs";
import { main, parseArgs } from "../src/orca/cli.mjs";

const repoRoot = "/repo";
const owner = "claude";
const runId = "run-1";
const now = 1_000_000;
const lease = { issue: 1059, owner, run_id: runId, state: "IMPLEMENTING", lease_expires_at: now + 60_000 };

type Exec = NonNullable<Parameters<typeof dispatch>[1]>["exec"];
type FakeResult = { status: number; stdout: string; stderr: string };
type ScriptedReplies = Partial<Record<string, FakeResult | FakeResult[]>>;
// The fakes return only the fields the adapter reads from spawnSync.
const fakeExec = (fn: (command: string, args: string[]) => FakeResult) => fn as unknown as Exec;

const ok = (value: unknown): FakeResult => ({ status: 0, stdout: JSON.stringify(value), stderr: "" });
const fail = (value: unknown): FakeResult => ({ status: 1, stdout: JSON.stringify(value), stderr: "" });
const READY = { ok: true, result: { runtime: { reachable: true } } };

// Names the Orca or auto call a command line makes, so fakes can script each step.
function classify(command: string, args: string[]) {
  if (command === "node" && args.includes("auth-check")) return "authCheck";
  if (command === "node" && args.includes("status")) return "lease";
  if (command === "orca" && args[0] === "status") return "status";
  if (command === "orca" && args[0] === "worktree" && args[1] === "show") return "worktreeShow";
  if (command === "orca" && args[1] === "run-create") return "runCreate";
  if (command === "orca" && args[1] === "worker-start") return "workerStart";
  return "other";
}

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "campsty-orca-"));
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

const planFor = () => buildDispatchPlan({ issue: 1059, title: "pilot", owner, runId, repoRoot, stateDir });
const recordPath = () => join(stateDir, "orca-dispatch", "issue-1059.json");

// A scripted world: each step answers with the given reply, and every call is logged.
function world(replies: ScriptedReplies, leaseReads: Array<Array<Record<string, unknown>>> = [[lease]]) {
  const calls: string[] = [];
  const commands: Array<{ name: string; args: string[] }> = [];
  const replyReads = new Map<string, number>();
  const scriptedReply = (name: string, fallback: FakeResult) => {
    const scripted = replies[name];
    if (!Array.isArray(scripted)) return scripted ?? fallback;
    const index = replyReads.get(name) ?? 0;
    replyReads.set(name, index + 1);
    return scripted[Math.min(index, scripted.length - 1)] ?? fallback;
  };
  const exec = fakeExec((command, args) => {
    const name = classify(command, args);
    calls.push(name);
    commands.push({ name, args });
    if (name === "lease") return ok({ ok: true, runs: [] });
    if (name === "authCheck") return scriptedReply(name, ok({ ok: true, result: "CLEAR" }));
    if (name === "status") return scriptedReply(name, ok(READY));
    if (name === "worktreeShow") {
      return scriptedReply(name, ok({ ok: true, result: { worktree: { id: "repo::/repo/.worktrees/issue-1059", path: "/repo/.worktrees/issue-1059" } } }));
    }
    if (name === "runCreate") return scriptedReply(name, ok({ ok: true }));
    if (name === "workerStart") return scriptedReply(name, ok({ ok: true, result: { state: "ready", stage: "input_accepted" } }));
    return ok({});
  });
  let reads = 0;
  const readLeaseRuns = () => leaseReads[Math.min(reads++, leaseReads.length - 1)];
  return { calls, commands, exec, readLeaseRuns };
}

describe("orca adapter", () => {
  it("builds a plan bound to the issue worktree and branch, not the repository root", () => {
    const plan = planFor();
    expect(plan.worktree).toBe("/repo/.worktrees/issue-1059");
    expect(plan.branch).toBe("agent/issue-1059");
    expect(plan.commands.worktreeShow).toEqual([
      "orca",
      "worktree",
      "show",
      "--worktree",
      "path:/repo/.worktrees/issue-1059",
      "--json",
    ]);
    expect(plan.commands.workerStart).toEqual(
      expect.arrayContaining(["orchestration", "worker-start", "--worktree", "path:/repo/.worktrees/issue-1059", "--agent", "claude", "--json"]),
    );
    expect(plan.commands.authCheck).toEqual(
      expect.arrayContaining(["auth-check", "--issue", "1059", "--phase", "plan", "--owner", owner, "--run", runId]),
    );
    expect(plan.commands.authCheck[1]).toBe(AUTO_CLI);
    expect(plan.recordFile).toBe(recordPath());
  });

  it("keeps the worker spec inside its worktree and away from lease, PR and merge actions", () => {
    const spec = buildTaskSpec({ issue: 1059, title: "pilot", branch: "agent/issue-1059", worktree: "/repo/.worktrees/issue-1059" });
    expect(spec).toContain("Target: issue #1059");
    expect(spec).toContain("Do not run the auto CLI's `claim`, `renew`, `release` or `founder-resume`");
    expect(spec).toContain("Do not push, open a pull request, merge or close the issue");
    expect(spec).toContain("not a filesystem guard");
    expect(spec).toContain("`npm run verify` exits 0");
    expect(spec).toContain("worker_done with --outcome succeeded");
  });

  it("accepts only the owner and run that hold an unexpired, non-terminal lease", () => {
    expect(leaseHeldBy([lease], { issue: 1059, owner, runId, now })).toBe(true);
    expect(leaseHeldBy([lease], { issue: 1059, owner: "pi", runId, now })).toBe(false);
    expect(leaseHeldBy([lease], { issue: 1059, owner, runId: "other", now })).toBe(false);
    expect(leaseHeldBy([{ ...lease, lease_expires_at: now }], { issue: 1059, owner, runId, now })).toBe(false);
    expect(leaseHeldBy([{ ...lease, state: "PARKED" }], { issue: 1059, owner, runId, now })).toBe(false);
    expect(leaseHeldBy([], { issue: 1059, owner, runId, now })).toBe(false);
  });

  it("reads runtime readiness from the real orca status --json shape", () => {
    expect(assertRuntimeReady(READY)).toEqual({ ok: true });
    expect(assertRuntimeReady({ ok: true, result: { runtime: { reachable: false } } }).code).toBe("ORCA_UNREACHABLE");
    expect(assertRuntimeReady({ runtimeReachable: true }).code).toBe("ORCA_UNREACHABLE");
  });

  it("permits dispatch only on CLEAR or FOUNDER_APPROVED", () => {
    expect(assertAuthorityPermits({ ok: true, result: "CLEAR" })).toEqual({ ok: true });
    expect(assertAuthorityPermits({ ok: true, result: "FOUNDER_APPROVED" })).toEqual({ ok: true });
    expect(assertAuthorityPermits({ ok: false, result: "REQUIRES_FOUNDER" })).toMatchObject({ ok: false, code: "AUTHORITY_NOT_PERMITTED" });
    expect(assertAuthorityPermits({ ok: false, result: "CHECK_UNAVAILABLE" })).toMatchObject({ ok: false, verdict: "CHECK_UNAVAILABLE" });
    expect(assertAuthorityPermits(null).ok).toBe(false);
  });

  it("starts nothing and leaves no record when the lease is not held", () => {
    const { calls, exec } = world({}, [[]]);
    const receipt = dispatch(planFor(), { exec, readLeaseRuns: () => [], now: () => now });
    expect(receipt).toMatchObject({ ok: false, code: "LEASE_NOT_HELD" });
    expect(calls).toEqual([]);
    expect(existsSync(recordPath())).toBe(false);
  });

  it("refuses protected-domain work before any Orca call and leaves no record", () => {
    const { calls, exec, readLeaseRuns } = world({ authCheck: fail({ ok: false, result: "REQUIRES_FOUNDER" }) });
    const receipt = dispatch(planFor(), { exec, readLeaseRuns, now: () => now });
    expect(receipt).toMatchObject({ ok: false, code: "AUTHORITY_NOT_PERMITTED", verdict: "REQUIRES_FOUNDER" });
    expect(calls).toEqual(["authCheck"]);
    expect(existsSync(recordPath())).toBe(false);
  });

  it("refuses when the Orca runtime is unreachable, before the record is claimed", () => {
    const { calls, exec, readLeaseRuns } = world({ status: ok({ ok: true, result: { runtime: { reachable: false } } }) });
    const receipt = dispatch(planFor(), { exec, readLeaseRuns, now: () => now });
    expect(receipt).toMatchObject({ ok: false, code: "ORCA_UNREACHABLE" });
    expect(calls).toEqual(["authCheck", "status"]);
    expect(existsSync(recordPath())).toBe(false);
  });

  it("resolves the worktree before side effects, then starts by stable worktree id", () => {
    const { calls, commands, exec, readLeaseRuns } = world({});
    const receipt = dispatch(planFor(), { exec, readLeaseRuns, now: () => now });
    expect(calls).toEqual(["authCheck", "status", "worktreeShow", "runCreate", "workerStart"]);
    expect(commands.find(({ name }) => name === "workerStart")?.args).toEqual(
      expect.arrayContaining(["--worktree", "id:repo::/repo/.worktrees/issue-1059"]),
    );
    expect(receipt.ok).toBe(true);
    expect(JSON.parse(readFileSync(recordPath(), "utf8"))).toMatchObject({ issue: 1059, state: "started" });
  });

  it("retries a newly-created worktree discovery miss before creating the run", () => {
    const missing = fail({ ok: false, error: { code: "selector_not_found" } });
    const discovered = ok({
      ok: true,
      result: { worktree: { id: "repo::/repo/.worktrees/issue-1059", path: "/repo/.worktrees/issue-1059" } },
    });
    const sleeps: number[] = [];
    const { calls, exec, readLeaseRuns } = world({ worktreeShow: [missing, discovered] });
    const receipt = dispatch(planFor(), {
      exec,
      readLeaseRuns,
      now: () => now,
      sleep: (ms) => sleeps.push(ms),
      worktreeResolveAttempts: 3,
    });
    expect(receipt.ok).toBe(true);
    expect(calls).toEqual(["authCheck", "status", "worktreeShow", "worktreeShow", "runCreate", "workerStart"]);
    expect(sleeps).toEqual([1_000]);
  });

  it("leaves no dispatch record or run when Orca cannot resolve the worktree", () => {
    const missing = fail({ ok: false, error: { code: "selector_not_found" } });
    const { calls, exec, readLeaseRuns } = world({ worktreeShow: missing });
    const receipt = dispatch(planFor(), {
      exec,
      readLeaseRuns,
      now: () => now,
      sleep: () => undefined,
      worktreeResolveAttempts: 3,
    });
    expect(receipt).toMatchObject({ ok: false, code: "WORKTREE_UNRESOLVED" });
    expect(calls).toEqual(["authCheck", "status", "worktreeShow", "worktreeShow", "worktreeShow"]);
    expect(calls).not.toContain("runCreate");
    expect(existsSync(recordPath())).toBe(false);
  });

  it("stops worktree discovery if the issue lease is lost while waiting", () => {
    const missing = fail({ ok: false, error: { code: "selector_not_found" } });
    const lost = [{ ...lease, owner: "pi", run_id: "other-run" }];
    const { calls, exec, readLeaseRuns } = world({ worktreeShow: missing }, [[lease], lost]);
    const receipt = dispatch(planFor(), {
      exec,
      readLeaseRuns,
      now: () => now,
      sleep: () => undefined,
      worktreeResolveAttempts: 3,
    });
    expect(receipt).toMatchObject({ ok: false, code: "LEASE_LOST_DURING_WORKTREE_RESOLUTION" });
    expect(calls).toEqual(["authCheck", "status", "worktreeShow"]);
    expect(calls).not.toContain("runCreate");
    expect(existsSync(recordPath())).toBe(false);
  });

  it("creates no record or run if the lease is lost during the retry sleep", () => {
    const missing = fail({ ok: false, error: { code: "selector_not_found" } });
    const discovered = ok({
      ok: true,
      result: { worktree: { id: "repo::/repo/.worktrees/issue-1059", path: "/repo/.worktrees/issue-1059" } },
    });
    let leaseLost = false;
    const { calls, exec } = world({ worktreeShow: [missing, discovered] });
    const receipt = dispatch(planFor(), {
      exec,
      readLeaseRuns: () => (leaseLost ? [{ ...lease, owner: "pi", run_id: "other-run" }] : [lease]),
      now: () => now,
      sleep: () => {
        leaseLost = true;
      },
      worktreeResolveAttempts: 3,
    });
    expect(receipt).toMatchObject({ ok: false, code: "LEASE_LOST_DURING_WORKTREE_RESOLUTION" });
    expect(calls).toEqual(["authCheck", "status", "worktreeShow"]);
    expect(calls).not.toContain("runCreate");
    expect(existsSync(recordPath())).toBe(false);
  });

  it("refuses a second dispatch for the same issue through the durable record", () => {
    const first = world({});
    expect(dispatch(planFor(), { exec: first.exec, readLeaseRuns: first.readLeaseRuns, now: () => now }).ok).toBe(true);

    const second = world({});
    const receipt = dispatch(planFor(), { exec: second.exec, readLeaseRuns: second.readLeaseRuns, now: () => now });
    expect(receipt).toMatchObject({ ok: false, code: "DISPATCH_RECORD_EXISTS" });
    expect(second.calls).toEqual(["authCheck", "status", "worktreeShow"]);
  });

  it("records a failed worker start as unconfirmed and never retries it", () => {
    const { calls, exec, readLeaseRuns } = world({ workerStart: fail({ ok: false, failedStage: "placement" }) });
    const receipt = dispatch(planFor(), { exec, readLeaseRuns, now: () => now });
    expect(receipt).toMatchObject({ ok: false, code: "WORKER_START_FAILED" });
    expect(calls.filter((name) => name === "workerStart")).toHaveLength(1);
    expect(JSON.parse(readFileSync(recordPath(), "utf8"))).toMatchObject({ state: "unconfirmed", failedStage: "placement" });
  });

  it("records a structured selector refusal as definitively not started", () => {
    const { calls, exec, readLeaseRuns } = world({
      workerStart: fail({
        ok: false,
        error: {
          code: "selector_not_found",
          data: { selector: "id:repo::/repo/.worktrees/issue-1059", orchestrationRequestId: "request-1" },
        },
      }),
    });
    const receipt = dispatch(planFor(), { exec, readLeaseRuns, now: () => now });
    expect(receipt).toMatchObject({ ok: false, code: "WORKTREE_SELECTOR_NOT_FOUND" });
    expect(calls.filter((name) => name === "workerStart")).toHaveLength(1);
    expect(JSON.parse(readFileSync(recordPath(), "utf8"))).toMatchObject({
      state: "not-started",
      failureCode: "selector_not_found",
      orchestrationRequestId: "request-1",
      selector: "id:repo::/repo/.worktrees/issue-1059",
    });
  });

  it("accepts the live receipt shape: state ready with an intermediate stage", () => {
    const { exec, readLeaseRuns } = world({
      workerStart: ok({ ok: true, result: { state: "ready", stage: "input_accepted", turnStart: "observed", dispatchId: "ctx_1" } }),
    });
    expect(dispatch(planFor(), { exec, readLeaseRuns, now: () => now })).toMatchObject({ ok: true });
  });

  it("treats an exit-0 start whose receipt reports failure as not confirmed", () => {
    const { exec, readLeaseRuns } = world({ workerStart: ok({ ok: false, failedStage: "setup" }) });
    expect(dispatch(planFor(), { exec, readLeaseRuns, now: () => now })).toMatchObject({ ok: false, code: "WORKER_START_UNVERIFIED" });
    expect(JSON.parse(readFileSync(recordPath(), "utf8"))).toMatchObject({ state: "unconfirmed" });
  });

  it("treats a run-create that exits 0 with a failure receipt as unverified and never starts a worker", () => {
    const { calls, exec, readLeaseRuns } = world({ runCreate: ok({ ok: false, error: "no run" }) });
    expect(dispatch(planFor(), { exec, readLeaseRuns, now: () => now })).toMatchObject({ ok: false, code: "RUNCREATE_UNVERIFIED" });
    expect(calls).not.toContain("workerStart");
    expect(JSON.parse(readFileSync(recordPath(), "utf8"))).toMatchObject({ state: "unconfirmed", failedStep: "runCreate" });
  });

  it("requires state ready on worker-start, not only ok:true", () => {
    const { exec, readLeaseRuns } = world({ workerStart: ok({ ok: true, result: { state: "starting", stage: "setup" } }) });
    expect(dispatch(planFor(), { exec, readLeaseRuns, now: () => now })).toMatchObject({ ok: false, code: "WORKER_START_UNVERIFIED" });
  });

  it("refuses when the authority check exits non-zero even with a permitting verdict", () => {
    const { calls, exec, readLeaseRuns } = world({ authCheck: { status: 1, stdout: JSON.stringify({ ok: true, result: "CLEAR" }), stderr: "" } });
    expect(dispatch(planFor(), { exec, readLeaseRuns, now: () => now })).toMatchObject({ ok: false, code: "AUTHORITY_NOT_PERMITTED" });
    expect(calls).toEqual(["authCheck"]);
  });

  it("treats an exit-0 start with unreadable output as unverified", () => {
    const { exec, readLeaseRuns } = world({ workerStart: { status: 0, stdout: "not json", stderr: "" } });
    expect(dispatch(planFor(), { exec, readLeaseRuns, now: () => now })).toMatchObject({ ok: false, code: "WORKER_START_UNVERIFIED" });
  });

  it("stops before worker-start when the lease is lost between the checks", () => {
    const lost = [{ ...lease, owner: "pi", run_id: "other-run" }];
    const { calls, exec, readLeaseRuns } = world({}, [[lease], [lease], lost]);
    const receipt = dispatch(planFor(), { exec, readLeaseRuns, now: () => now });
    expect(receipt).toMatchObject({ ok: false, code: "LEASE_LOST_BEFORE_START" });
    expect(calls).toEqual(["authCheck", "status", "worktreeShow", "runCreate"]);
    expect(JSON.parse(readFileSync(recordPath(), "utf8"))).toMatchObject({ state: "not-started" });
  });

  it("parses flags and rejects a missing lease identity", () => {
    expect(parseArgs(["plan", "--issue", "1059", "--owner", "claude", "--run", "r"])).toEqual({
      command: "plan",
      issue: 1059,
      owner: "claude",
      runId: "r",
      agent: "claude",
    });
    expect(parseArgs(["dispatch", "--issue", "1059", "--owner", "claude"]).error).toBe("--owner and --run are required");
    expect(parseArgs(["launch", "--issue", "1059", "--owner", "c", "--run", "r"]).error).toBe("unknown command launch");
    expect(parseArgs(["plan", "--issue", "x", "--owner", "c", "--run", "r"]).error).toBe("--issue must be a positive integer");
  });

  it("plan prints the Orca calls and starts nothing", () => {
    const calls: string[] = [];
    const exec = fakeExec((command, args) => {
      calls.push([command, ...args].join(" "));
      return { status: 0, stdout: "Fix the thing\n", stderr: "" };
    });
    const { code, result } = main(["plan", "--issue", "1059", "--owner", "claude", "--run", "r"], { repoRoot, exec }) as {
      code: number;
      result: { plan: { commands: Record<string, string[]> } };
    };
    expect(code).toBe(0);
    expect(result.plan.commands.status).toEqual(["orca", "status", "--json"]);
    expect(calls).toEqual(["gh issue view 1059 --json title --jq .title"]);
  });
});
