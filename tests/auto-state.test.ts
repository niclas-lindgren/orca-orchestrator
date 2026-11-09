import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimIssue,
  getRun,
  MAX_ATTEMPTS,
  openState,
  recoverExpired,
  releaseLease,
  renewLease,
  transition,
} from "../src/auto/state.mjs";

const dirs: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "orca-auto-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const T0 = 1_000_000;

describe("orca-auto state", () => {
  it("adds the scope columns to a store created before they existed", () => {
    const path = join(tmp(), "state.db");
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE runs (issue INTEGER PRIMARY KEY, state TEXT NOT NULL, owner TEXT, run_id TEXT, lease_expires_at INTEGER, heartbeat_at INTEGER, head_sha TEXT, attempts INTEGER NOT NULL DEFAULT 0, stop_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
    old.exec("INSERT INTO runs (issue, state, created_at, updated_at) VALUES (7, 'EXPIRED', 1, 1)");
    old.close();
    const db = openState(path);
    expect(getRun(db, 7)).toMatchObject({ scope_fingerprint: null, comments_acked: null });
    db.close();
    openState(path).close();
  });

  it("refuses an exclusive claim while another issue holds a live lease", () => {
    const db = openState(":memory:");
    expect(claimIssue(db, { issue: 1, owner: "a", runId: "r1", ttlMs: 100, now: T0, exclusive: true }).ok).toBe(true);
    expect(claimIssue(db, { issue: 2, owner: "b", runId: "r2", now: T0 + 50, exclusive: true })).toMatchObject({ ok: false, code: "BUSY", holding: [1] });
    expect(db.prepare("SELECT 1 FROM runs WHERE issue = 2").get()).toBeUndefined();
    // The holder may re-claim its own issue, and a lapsed lease frees the slot.
    expect(claimIssue(db, { issue: 1, owner: "a", runId: "r1", now: T0 + 50, exclusive: true }).ok).toBe(true);
    expect(claimIssue(db, { issue: 2, owner: "b", runId: "r2", now: T0 + 50 + 31 * 60_000, exclusive: true }).ok).toBe(true);
  });

  it("rejects a second owner while the lease is live and allows takeover after expiry", () => {
    const db = openState(":memory:");
    expect(claimIssue(db, { issue: 7, owner: "a", runId: "r1", ttlMs: 100, now: T0 }).ok).toBe(true);
    const conflict = claimIssue(db, { issue: 7, owner: "b", runId: "r2", now: T0 + 50 });
    expect(conflict).toMatchObject({ ok: false, code: "LEASE_CONFLICT", holder: "a" });
    expect(claimIssue(db, { issue: 7, owner: "b", runId: "r2", now: T0 + 100 }).ok).toBe(true);
    expect(renewLease(db, { issue: 7, owner: "a", runId: "r1", now: T0 + 101 })).toMatchObject({ code: "LEASE_LOST" });
  });

  it("only lets the lease owner transition, and only along the state machine", () => {
    const db = openState(":memory:");
    claimIssue(db, { issue: 1, owner: "a", runId: "r", now: T0 });
    expect(transition(db, { issue: 1, owner: "b", runId: "r", to: "PRODUCT_CHECK", now: T0 })).toMatchObject({ code: "LEASE_LOST" });
    expect(transition(db, { issue: 1, owner: "a", runId: "r", to: "MERGED", now: T0 })).toMatchObject({
      code: "INVALID_TRANSITION",
      from: "CLAIMED",
    });
    for (const to of ["PRODUCT_CHECK", "IMPLEMENTING", "VERIFYING"]) {
      expect(transition(db, { issue: 1, owner: "a", runId: "r", to, headSha: "abc", now: T0 }).ok).toBe(true);
    }
    expect(getRun(db, 1)).toMatchObject({ state: "VERIFYING", head_sha: "abc", attempts: 1 });
  });

  it("does not let a repairing run skip back to VERIFYING without a worker", () => {
    const db = openState(":memory:");
    claimIssue(db, { issue: 6, owner: "a", runId: "r", now: T0 });
    for (const to of ["PRODUCT_CHECK", "IMPLEMENTING", "VERIFYING", "REPAIR"]) transition(db, { issue: 6, owner: "a", runId: "r", to, headSha: "h", now: T0 });
    expect(transition(db, { issue: 6, owner: "a", runId: "r", to: "VERIFYING", now: T0 })).toMatchObject({ ok: false, code: "INVALID_TRANSITION", from: "REPAIR" });
  });

  it("parks a run whose repairs exceed the attempt bound and frees the slot", () => {
    const db = openState(":memory:");
    claimIssue(db, { issue: 4, owner: "a", runId: "r", now: T0 });
    const go = (to: string, headSha?: string) => transition(db, { issue: 4, owner: "a", runId: "r", to, headSha, now: T0 });
    for (const to of ["PRODUCT_CHECK", "IMPLEMENTING", "VERIFYING"]) go(to);
    for (const sha of ["h1", "h2"]) {
      expect(go("REPAIR", sha)).toMatchObject({ ok: true, run: { state: "REPAIR" } });
      // A repair worker's launch is the attempt REPAIR already counted.
      const before = getRun(db, 4).attempts;
      expect(go("IMPLEMENTING")).toMatchObject({ ok: true, run: { state: "IMPLEMENTING", attempts: before } });
      go("VERIFYING");
    }
    expect(getRun(db, 4)).toMatchObject({ state: "VERIFYING", attempts: MAX_ATTEMPTS });
    const parked = go("REPAIR", "h3");
    expect(parked).toMatchObject({ ok: true, parked: true, run: { state: "PARKED", stop_reason: "REPAIR_LIMIT", head_sha: "h3", attempts: MAX_ATTEMPTS } });
    expect(getRun(db, 4)).toMatchObject({ owner: null, lease_expires_at: null, run_id: "r" });
    expect(claimIssue(db, { issue: 4, owner: "a", runId: "r", now: T0 + 1 })).toMatchObject({ code: "ISSUE_TERMINAL" });
    expect(claimIssue(db, { issue: 5, owner: "b", runId: "r5", exclusive: true, now: T0 })).toMatchObject({ ok: true });
  });

  it("keeps a parked issue from being claimed again", () => {
    const db = openState(":memory:");
    claimIssue(db, { issue: 2, owner: "a", runId: "r", now: T0 });
    transition(db, { issue: 2, owner: "a", runId: "r", to: "PARKED", stopReason: "NEEDS_DECISION", now: T0 });
    expect(claimIssue(db, { issue: 2, owner: "a", runId: "r", now: T0 + 1 })).toMatchObject({ code: "ISSUE_TERMINAL" });
  });

  it("marks lapsed active runs EXPIRED, keeping head and attempts, and lets another owner recover", () => {
    const db = openState(":memory:");
    claimIssue(db, { issue: 3, owner: "a", runId: "r", ttlMs: 10, now: T0 });
    transition(db, { issue: 3, owner: "a", runId: "r", to: "PRODUCT_CHECK", now: T0 });
    transition(db, { issue: 3, owner: "a", runId: "r", to: "IMPLEMENTING", headSha: "deadbeef", now: T0 });
    expect(recoverExpired(db, { now: T0 + 5 })).toEqual([]);
    expect(recoverExpired(db, { now: T0 + 10 })).toEqual([3]);
    expect(getRun(db, 3)).toMatchObject({ state: "EXPIRED", stop_reason: "LEASE_EXPIRED", head_sha: "deadbeef", attempts: 1 });
    expect(claimIssue(db, { issue: 3, owner: "b", runId: "r2", now: T0 + 11 }).ok).toBe(true);
  });

  it("release is owner-checked and keeps recorded state", () => {
    const db = openState(":memory:");
    claimIssue(db, { issue: 4, owner: "a", runId: "r", now: T0 });
    expect(releaseLease(db, { issue: 4, owner: "b", runId: "r" })).toMatchObject({ code: "NOT_OWNER" });
    expect(releaseLease(db, { issue: 4, owner: "a", runId: "r", now: T0 }).ok).toBe(true);
    expect(claimIssue(db, { issue: 4, owner: "b", runId: "r2", now: T0 + 1 }).ok).toBe(true);
  });

  it("does not let a second run with the same owner label take over a live lease", () => {
    const db = openState(":memory:");
    claimIssue(db, { issue: 5, owner: "claude", runId: "A", now: T0 });
    expect(claimIssue(db, { issue: 5, owner: "claude", runId: "B", now: T0 + 1 })).toMatchObject({
      ok: false,
      code: "LEASE_CONFLICT",
    });
    expect(renewLease(db, { issue: 5, owner: "claude", runId: "B", now: T0 + 1 })).toMatchObject({ code: "LEASE_LOST" });
    expect(releaseLease(db, { issue: 5, owner: "claude", runId: "B" })).toMatchObject({ code: "NOT_OWNER" });
    expect(claimIssue(db, { issue: 5, owner: "claude", runId: "A", now: T0 + 2 }).ok).toBe(true);
    expect(getRun(db, 5)?.run_id).toBe("A");
  });

  it("parks an expired NEEDS_DECISION run instead of resetting it", () => {
    const db = openState(":memory:");
    claimIssue(db, { issue: 6, owner: "a", runId: "r", ttlMs: 10, now: T0 });
    transition(db, { issue: 6, owner: "a", runId: "r", to: "PRODUCT_CHECK", now: T0 });
    transition(db, { issue: 6, owner: "a", runId: "r", to: "NEEDS_DECISION", now: T0 });
    // Even before recovery runs, a lapsed decision wait is not claimable.
    expect(claimIssue(db, { issue: 6, owner: "b", runId: "r2", now: T0 + 20 })).toMatchObject({
      code: "ISSUE_TERMINAL",
      state: "NEEDS_DECISION",
    });
    expect(recoverExpired(db, { now: T0 + 20 })).toEqual([6]);
    expect(getRun(db, 6)).toMatchObject({ state: "PARKED", stop_reason: "NEEDS_DECISION" });
    expect(claimIssue(db, { issue: 6, owner: "b", runId: "r2", now: T0 + 21 }).ok).toBe(false);
  });

  it("keeps a pending decision when the same run re-claims while its lease is live", () => {
    const db = openState(":memory:");
    claimIssue(db, { issue: 8, owner: "a", runId: "r", now: T0 });
    transition(db, { issue: 8, owner: "a", runId: "r", to: "PRODUCT_CHECK", now: T0 });
    transition(db, { issue: 8, owner: "a", runId: "r", to: "NEEDS_DECISION", now: T0 });
    expect(claimIssue(db, { issue: 8, owner: "a", runId: "r", now: T0 + 1 }).ok).toBe(true);
    expect(getRun(db, 8)?.state).toBe("NEEDS_DECISION");
  });

  it("lets exactly one of several simultaneous processes claim an issue", async () => {
    const dbPath = join(tmp(), "state.db");
    openState(dbPath).close();
    const stateModule = resolve(process.cwd(), "src/auto/state.mjs");
    const script = `
      import { openState, claimIssue } from ${JSON.stringify(stateModule)};
      const db = openState(process.argv[1]);
      const r = claimIssue(db, { issue: 99, owner: process.argv[2], runId: process.argv[2] });
      process.stdout.write(JSON.stringify({ ok: r.ok, code: r.code ?? null }));
    `;
    const run = (owner: string) =>
      new Promise<{ ok: boolean; code: string | null }>((res, rej) => {
        const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", script, dbPath, owner]);
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.on("error", rej);
        child.on("close", (code) => (code === 0 ? res(JSON.parse(out)) : rej(new Error(`exit ${code}`))));
      });
    const results = await Promise.all(["a", "b", "c", "d", "e"].map(run));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => r.code === "LEASE_CONFLICT")).toHaveLength(4);
    const db = openState(dbPath);
    expect(getRun(db, 99)?.owner).toMatch(/^[a-e]$/);
  }, 30_000);
});
