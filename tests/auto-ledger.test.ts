import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommand } from "../src/auto/cli.mjs";
import { MAX_RUN_REPAIRS } from "../src/auto/state.mjs";

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

const NOW = 1_000_000;
let root: string;
let stateDir: string;
let tree: string;
let scratch: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "campsty-ledger-"));
  scratch = mkdtempSync(join(tmpdir(), "campsty-ledger-files-"));
  stateDir = join(root, ".local", "auto");
  tree = join(root, ".worktrees", "issue-9");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  writeFileSync(join(root, "a.txt"), "a");
  git(root, "add", "a.txt");
  git(root, "commit", "-q", "-m", "init");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

const live = (extra: object = {}) => ({ ok: true, issue: { number: 9, state: "OPEN", title: "t", body: "b", labels: [{ name: "priority: P2" }], comments: [], ...extra } });
const claim = (owner = "claude", run = "r1", now = NOW) => runCommand(["claim", "--issue", "9", "--owner", owner, "--run", run], { repoRoot: root, stateDir, now });
const commit = (name: string) => {
  writeFileSync(join(tree, name), name);
  git(tree, "add", name);
  git(tree, "commit", "-q", "-m", name);
  return git(tree, "rev-parse", "HEAD");
};
let n = 0;
const findingsFile = (findings: object[]) => {
  const path = join(scratch, `f${(n += 1)}.json`);
  writeFileSync(path, JSON.stringify(findings));
  return path;
};
const p2 = (over: object = {}) => ({ severity: "P2", file: "src/a.ts", line: 10, summary: "Lease is not checked before publish", ...over });
const record = (head: string, findings: object[], over: { owner?: string; run?: string; now?: number; fetchIssue?: () => object; fetchPr?: (n: number) => object; pr?: string } = {}) =>
  runCommand(["repair-record", "--issue", "9", "--owner", over.owner ?? "claude", "--run", over.run ?? "r1", "--pr", over.pr ?? "50", "--head", head, "--findings-file", findingsFile(findings)], {
    repoRoot: root,
    stateDir,
    now: over.now ?? NOW,
    fetchIssue: over.fetchIssue ?? (() => live()),
    // The pull request is the issue's own and sits at the head being recorded, unless a test says otherwise.
    fetchPr: over.fetchPr ?? ((number: number) => ({ ok: true, pr: { number, state: "OPEN", headRefName: "agent/issue-9", headRefOid: git(tree, "rev-parse", "HEAD"), isCrossRepository: false } })),
  } as never);
const status = () => runCommand(["status", "--issue", "9"], { repoRoot: root, stateDir, now: NOW }).result.runs[0];
const ledger = (pr?: string) => runCommand(["repair-status", "--issue", "9", ...(pr ? ["--pr", pr] : [])], { repoRoot: root, stateDir, now: NOW }).result.prs;

describe("campsty-auto repair ledger for the in-session skills", () => {
  it("records a repair against the exact reviewed head, and repeating it after a context reset changes nothing", () => {
    claim();
    const h1 = commit("one");
    const first = record(h1, [p2()]);
    expect(first).toMatchObject({ code: 0, result: { ok: true, action: "RECORDED", pr: 50, headSha: h1 } });
    const [key] = Object.keys(first.result.counts);
    expect(first.result.counts[key]).toBe(1);
    const again = record(h1, [p2({ line: 99 })]);
    expect(again.result).toMatchObject({ ok: true, action: "ALREADY_RECORDED" });
    expect(again.result.counts[key]).toBe(1);
    expect(ledger("50")).toMatchObject({ 50: { repairs: 1, findings: { [key]: { attempts: 1, heads: [h1] } } } });
  });

  it("allows two repairs of one finding and parks the run on the third, from another head", () => {
    claim();
    const h1 = commit("one");
    expect(record(h1, [p2()]).result.ok).toBe(true);
    const h2 = commit("repair one");
    expect(record(h2, [p2({ summary: "  lease is NOT checked before publish. " })]).result.ok).toBe(true);
    const h3 = commit("repair two");
    const third = record(h3, [p2()]);
    expect(third).toMatchObject({ code: 1, result: { ok: false, code: "REPAIR_LIMIT", limit: "FINDING", parked: true, pr: 50, headSha: h3 } });
    expect(status()).toMatchObject({ state: "PARKED", stop_reason: "REPAIR_LIMIT", owner: null });
    // Nothing was written for the refused attempt.
    expect(ledger("50")[50].repairs).toBe(2);
  });

  it("counts a P3 nit like any other finding, so its repairs are bounded too", () => {
    claim();
    const nit = { severity: "P3", file: "x.ts", summary: "nit" };
    for (let i = 0; i < 2; i += 1) expect(record(commit(`n${i}`), [nit]).result).toMatchObject({ ok: true });
    expect(record(commit("n2"), [nit]).result).toMatchObject({ ok: false, code: "REPAIR_LIMIT" });
  });

  it("keeps separate findings apart and bounds the whole pull request", () => {
    claim();
    for (let i = 0; i < MAX_RUN_REPAIRS; i += 1) expect(record(commit(`c${i + 1}`), [p2({ summary: `Distinct problem number ${"abcdefgh"[i]}` })]).result.ok, `repair ${i}`).toBe(true);
    const over = record(commit("last"), [p2({ summary: "One more unrelated problem" })]);
    expect(over.result).toMatchObject({ ok: false, code: "REPAIR_LIMIT", limit: "RUN", parked: true });
  });

  it("scopes the count to the pull request, so a later slice starts fresh", () => {
    claim();
    record(commit("one"), [p2()]);
    record(commit("two"), [p2()]);
    expect(record(commit("three"), [p2()], { pr: "51" }).result).toMatchObject({ ok: true, action: "RECORDED", pr: 51 });
    expect(Object.keys(ledger())).toEqual(["50", "51"]);
  });

  it("carries the counts to another session that takes the issue over", () => {
    claim();
    record(commit("one"), [p2()]);
    expect(runCommand(["release", "--issue", "9", "--owner", "claude", "--run", "r1"], { repoRoot: root, stateDir, now: NOW }).code).toBe(0);
    // A different client, a different run id, the same issue and pull request.
    expect(claim("pi", "r2", NOW + 10).code).toBe(0);
    expect(record(commit("two"), [p2()], { owner: "pi", run: "r2", now: NOW + 20 }).result).toMatchObject({ ok: true });
    const third = record(commit("three"), [p2()], { owner: "pi", run: "r2", now: NOW + 30 });
    expect(third.result).toMatchObject({ ok: false, code: "REPAIR_LIMIT", limit: "FINDING" });
  });

  it("refuses without the lease, with an expired lease, and records nothing", () => {
    claim();
    const h1 = commit("one");
    expect(record(h1, [p2()], { owner: "pi", run: "x" }).result).toMatchObject({ ok: false, code: "LEASE_LOST" });
    expect(record(h1, [p2()], { run: "wrong" }).result).toMatchObject({ code: "LEASE_LOST" });
    expect(record(h1, [p2()], { now: NOW + 10 * 60 * 60 * 1000 }).result).toMatchObject({ code: "LEASE_LOST" });
    expect(ledger()).toEqual({});
  });

  it("refuses a head that is not the worktree's, and a worktree with uncommitted changes", () => {
    claim();
    const h1 = commit("one");
    commit("two");
    expect(record(h1, [p2()]).result).toMatchObject({ ok: false, code: "STALE_HEAD", expected: h1 });
    const h2 = git(tree, "rev-parse", "HEAD");
    writeFileSync(join(tree, "dirty.txt"), "x");
    expect(record(h2, [p2()]).result).toMatchObject({ ok: false, code: "DIRTY_WORKTREE" });
    expect(ledger()).toEqual({});
  });

  it("refuses when the issue is closed, blocked or cannot be read", () => {
    claim();
    const h1 = commit("one");
    expect(record(h1, [p2()], { fetchIssue: () => live({ state: "CLOSED" }) }).result).toMatchObject({ code: "ISSUE_BLOCKED" });
    expect(record(h1, [p2()], { fetchIssue: () => live({ labels: [{ name: "status:blocked" }] }) }).result).toMatchObject({ code: "ISSUE_BLOCKED", blocked: true });
    expect(record(h1, [p2()], { fetchIssue: () => ({ ok: false, error: "offline" }) }).result).toMatchObject({ code: "GITHUB_UNAVAILABLE" });
    expect(record(h1, [p2()], { fetchIssue: () => { throw new Error("boom"); } }).result).toMatchObject({ code: "GITHUB_UNAVAILABLE" });
    expect(ledger()).toEqual({});
  });

  it("accepts only the issue's own open pull request at the reviewed head, so a new --pr number cannot reset the budget", () => {
    claim();
    const h1 = commit("one");
    const pr = (over: object) => (number: number) => ({ ok: true, pr: { number, state: "OPEN", headRefName: "agent/issue-9", headRefOid: h1, isCrossRepository: false, ...over } });
    expect(record(h1, [p2()], { fetchPr: pr({ headRefName: "agent/issue-10" }) }).result).toMatchObject({ code: "PR_MISMATCH", branch: "agent/issue-10" });
    expect(record(h1, [p2()], { fetchPr: pr({ state: "CLOSED" }) }).result).toMatchObject({ code: "PR_MISMATCH", state: "CLOSED" });
    expect(record(h1, [p2()], { fetchPr: pr({ isCrossRepository: true }) }).result).toMatchObject({ code: "PR_MISMATCH" });
    expect(record(h1, [p2()], { fetchPr: pr({ number: 7 }) }).result).toMatchObject({ code: "PR_MISMATCH" });
    expect(record(h1, [p2()], { fetchPr: pr({ headRefOid: "f".repeat(40) }) }).result).toMatchObject({ code: "PR_HEAD_MISMATCH", prHead: "f".repeat(40) });
    expect(record(h1, [p2()], { fetchPr: () => ({ ok: false, error: "offline" }) }).result).toMatchObject({ code: "GITHUB_UNAVAILABLE" });
    expect(record(h1, [p2()], { fetchPr: () => { throw new Error("boom"); } }).result).toMatchObject({ code: "GITHUB_UNAVAILABLE" });
    expect(ledger()).toEqual({});
  });

  it("counts a retry on the same head as the same attempt, since only a new commit can be reviewed and promoted", () => {
    claim();
    const h1 = commit("one");
    for (let i = 0; i < 5; i += 1) record(h1, [p2()]);
    expect(ledger("50")[50]).toMatchObject({ repairs: 1 });
    // The budget is spent only by repairs that produced a new head.
    const h2 = commit("two");
    record(h2, [p2()]);
    expect(record(commit("three"), [p2()]).result).toMatchObject({ code: "REPAIR_LIMIT" });
  });

  it("starts nothing while paused and rejects malformed arguments", () => {
    claim();
    const h1 = commit("one");
    runCommand(["pause"], { repoRoot: root, stateDir });
    expect(record(h1, [p2()]).result).toMatchObject({ code: "PAUSED" });
    runCommand(["resume"], { repoRoot: root, stateDir });
    expect(record("abc", [p2()]).code).toBe(2);
    expect(record(h1, [p2()], { pr: "0" }).code).toBe(2);
    expect(record(h1, []).code).toBe(2);
    expect(record(h1, [{ severity: "HIGH", file: "a", summary: "b" }]).code).toBe(2);
    expect(runCommand(["repair-record", "--issue", "9", "--owner", "claude", "--run", "r1", "--pr", "50", "--head", h1, "--findings-file", join(scratch, "missing.json")], { repoRoot: root, stateDir, now: NOW }).code).toBe(2);
    expect(runCommand(["repair-record", "--issue", "9", "--owner", "claude", "--run", "r1", "--model", "x"], { repoRoot: root, stateDir, now: NOW }).code).toBe(2);
    expect(ledger()).toEqual({});
  });
});
