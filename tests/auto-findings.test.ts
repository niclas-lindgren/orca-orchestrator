import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { qaFindingKeys, reviewFindingKeys, UNSPECIFIED_QA, UNSPECIFIED_REVIEW } from "../src/auto/findings.mjs";
import { claimIssue, getRun, MAX_FINDING_REPAIRS, MAX_RUN_REPAIRS, openState, transition } from "../src/auto/state.mjs";

const finding = (over: object = {}) => ({ severity: "P2", file: "src/a.ts", line: 10, summary: "Lease is not checked before publish", failure_scenario: "x", confidence: "high", ...over });

describe("campsty-auto finding keys", () => {
  it("keys a finding by file and wording, not by line, case, spacing or numbers", () => {
    const [a] = reviewFindingKeys({ findings: [finding()] });
    expect(reviewFindingKeys({ findings: [finding({ line: 99, summary: "  lease is NOT checked before publish. " })] })).toEqual([a]);
    expect(reviewFindingKeys({ findings: [finding({ summary: "Step 3 leaks the lease" }), finding({ summary: "Step 7 leaks the lease" })] })).toHaveLength(1);
    expect(reviewFindingKeys({ findings: [finding({ file: "src/b.ts" })] })).not.toEqual([a]);
    expect(reviewFindingKeys({ findings: [finding({ summary: "A different problem" })] })).not.toEqual([a]);
  });

  it("counts blocking findings and unmet criteria only, and never returns an empty list", () => {
    const keys = reviewFindingKeys({ findings: [finding(), finding({ severity: "P3", summary: "nit" })], acceptance: [{ criterion: "It works", status: "UNMET" }, { criterion: "It is fast", status: "MET" }] });
    expect(keys).toHaveLength(2);
    expect(keys.some((k: string) => k.startsWith("criterion:"))).toBe(true);
    expect(reviewFindingKeys({ findings: [finding({ severity: "P3" })], acceptance: [] })).toEqual([UNSPECIFIED_REVIEW]);
  });

  it("keys a failure inside a check by what failed, so a different failure in the same gate gets its own budget", () => {
    const tsOnly = qaFindingKeys([{ name: "gate", status: "FAIL", outputTail: "src/a.ts(10,5): error TS2322: Type x\nsrc/a.ts(40,1): error TS2322: Type y" }]);
    const tsMoved = qaFindingKeys([{ name: "gate", status: "FAIL", outputTail: "src/a.ts(12,9): error TS2322: Type z" }]);
    const otherFile = qaFindingKeys([{ name: "gate", status: "FAIL", outputTail: "src/b.ts(1,1): error TS2322: Type z" }]);
    expect(tsOnly).toHaveLength(1);
    expect(tsMoved).toEqual(tsOnly);
    expect(otherFile).not.toEqual(tsOnly);
    const test = qaFindingKeys([{ name: "gate", status: "FAIL", outputTail: " \u001b[31m FAIL \u001b[39m |node| tests/unit/a.test.ts > does a thing 12ms" }]);
    const sameTest = qaFindingKeys([{ name: "gate", status: "FAIL", outputTail: "FAIL |node| tests/unit/a.test.ts > does a thing 400ms" }]);
    const otherTest = qaFindingKeys([{ name: "gate", status: "FAIL", outputTail: "FAIL |node| tests/unit/a.test.ts > does another thing" }]);
    expect(sameTest).toEqual(test);
    expect(otherTest).not.toEqual(test);
    expect(qaFindingKeys([{ name: "gate", status: "FAIL", outputTail: "make: *** Error 2" }])).toEqual(["qa:gate"]);
  });

  it("keys a QA failure by the failing check, so the same gate failing twice is one finding", () => {
    expect(qaFindingKeys([{ name: "gate", status: "FAIL" }, { name: "security", status: "PASS" }])).toEqual(["qa:gate"]);
    expect(qaFindingKeys([{ name: "gate", status: "TIMEOUT" }, { name: "Security", status: "ERROR" }])).toEqual(["qa:gate", "qa:security"]);
    expect(qaFindingKeys([{ name: "gate", status: "PASS" }])).toEqual([UNSPECIFIED_QA]);
  });
});

describe("campsty-auto repair counting per finding", () => {
  const T0 = 1_000_000;
  const setup = () => {
    const db = openState(":memory:");
    claimIssue(db, { issue: 4, owner: "a", runId: "r", now: T0 });
    const go = (to: string, extra: object = {}) => transition(db, { issue: 4, owner: "a", runId: "r", to, now: T0, ...extra });
    for (const to of ["PRODUCT_CHECK", "IMPLEMENTING", "VERIFYING"]) go(to);
    // One repair round: out to REPAIR for these findings, worker runs, back to verification.
    const round = (findings: string[], headSha = "h") => {
      const out = go("REPAIR", { headSha, findings });
      if (out.parked) return out;
      go("IMPLEMENTING");
      go("VERIFYING");
      return out;
    };
    return { db, go, round };
  };

  it("allows two repairs of one finding and parks the third, naming it", () => {
    const { db, round } = setup();
    for (let i = 0; i < MAX_FINDING_REPAIRS; i += 1) expect(round(["review:a"])).toMatchObject({ ok: true, run: { state: "REPAIR" } });
    const third = round(["review:a"], "h3");
    expect(third).toMatchObject({ ok: true, parked: true, limit: "FINDING", finding: "review:a", run: { state: "PARKED", stop_reason: "REPAIR_LIMIT", head_sha: "h3", owner: null } });
    expect(getRun(db, 4).attempts).toBe(1 + MAX_FINDING_REPAIRS);
  });

  it("gives separate findings independent budgets, up to the run's own repair budget", () => {
    const { db, round } = setup();
    // More than the old per-run bound of two repairs, each for a different finding.
    for (let i = 0; i < MAX_RUN_REPAIRS; i += 1) expect(round([`review:f${i}`])).toMatchObject({ ok: true, run: { state: "REPAIR" } });
    expect(getRun(db, 4).attempts).toBe(1 + MAX_RUN_REPAIRS);
    expect(round(["review:fresh"])).toMatchObject({ parked: true, limit: "RUN", run: { stop_reason: "REPAIR_LIMIT" } });
  });

  it("counts every finding of a round and parks when any one is spent, without charging the others", () => {
    const { db, round, go } = setup();
    round(["review:a", "review:b"]);
    round(["review:a"]);
    const parked = round(["review:a", "review:c"]);
    expect(parked).toMatchObject({ parked: true, limit: "FINDING", finding: "review:a" });
    const counts = db.prepare("SELECT key, repairs FROM repair_findings WHERE issue = 4 ORDER BY key").all();
    expect(counts).toEqual([{ key: "review:a", repairs: 2 }, { key: "review:b", repairs: 1 }]);
    expect(go("REPAIR").ok).toBe(false);
  });

  it("keeps the counts across a restart and does not carry them to a new run", () => {
    const { db, round } = setup();
    round(["qa:gate"]);
    round(["qa:gate"]);
    // Same store, same run: the counts are in the database, not the process.
    expect(db.prepare("SELECT repairs FROM repair_findings WHERE key = 'qa:gate' AND run_id = 'r'").get()).toEqual({ repairs: 2 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM repair_findings WHERE run_id = 'other'").get()).toEqual({ n: 0 });
  });

  it("falls back to the per-run bound when no finding is named, and never counts for a lost lease", () => {
    const { db, go } = setup();
    expect(go("REPAIR", { headSha: "h1" })).toMatchObject({ ok: true });
    expect(transition(db, { issue: 4, owner: "b", runId: "x", to: "REPAIR", findings: ["review:a"], now: T0 })).toMatchObject({ ok: false, code: "LEASE_LOST" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM repair_findings").get()).toEqual({ n: 0 });
  });
});

describe("campsty-auto repair counting for runs that predate it", () => {
  const T0 = 1_000_000;
  const oldStore = (attempts: number) => {
    const dir = mkdtempSync(join(tmpdir(), "campsty-old-store-"));
    const path = join(dir, "state.db");
    const old = new DatabaseSync(path);
    // The schema as it was before findings were tracked: no repair_findings table.
    old.exec(`CREATE TABLE runs (issue INTEGER PRIMARY KEY, state TEXT NOT NULL, owner TEXT, run_id TEXT, lease_expires_at INTEGER, heartbeat_at INTEGER, head_sha TEXT, attempts INTEGER NOT NULL DEFAULT 0, stop_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    old.prepare("INSERT INTO runs VALUES (4, 'VERIFYING', 'a', 'r', ?, ?, 'h', ?, NULL, ?, ?)").run(T0 + 1e6, T0, attempts, T0, T0);
    old.close();
    return { dir, path };
  };
  const keyed = (db: ReturnType<typeof openState>, headSha = "h2") => transition(db, { issue: 4, owner: "a", runId: "r", to: "REPAIR", headSha, findings: ["review:new"], now: T0 });

  it("keeps the per-run bound for a run that already spent its repairs", () => {
    const { dir, path } = oldStore(3);
    const db = openState(path);
    expect(keyed(db)).toMatchObject({ ok: true, parked: true, limit: "RUN", run: { state: "PARKED", stop_reason: "REPAIR_LIMIT", attempts: 3 } });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("allows the one repair a partly repaired legacy run had left, then holds it to the old bound", () => {
    const { dir, path } = oldStore(2);
    const db = openState(path);
    const go = (to: string) => transition(db, { issue: 4, owner: "a", runId: "r", to, now: T0 });
    expect(keyed(db)).toMatchObject({ ok: true, run: { state: "REPAIR", attempts: 3 } });
    go("IMPLEMENTING");
    go("VERIFYING");
    // A new finding does not reopen the budget the run was started under.
    expect(keyed(db, "h3")).toMatchObject({ parked: true, limit: "RUN" });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("charges one run's repairs once when two connections to the same store race", () => {
    const { dir, path } = oldStore(1);
    const a = openState(path);
    const b = openState(path);
    for (const [db, key] of [[a, "review:x"], [b, "review:x"]] as const) {
      expect(transition(db, { issue: 4, owner: "a", runId: "r", to: "REPAIR", findings: [key], now: T0 })).toMatchObject({ ok: true });
      transition(db, { issue: 4, owner: "a", runId: "r", to: "IMPLEMENTING", now: T0 });
      transition(db, { issue: 4, owner: "a", runId: "r", to: "VERIFYING", now: T0 });
    }
    expect(a.prepare("SELECT repairs FROM repair_findings WHERE key = 'review:x'").get()).toEqual({ repairs: 2 });
    expect(transition(b, { issue: 4, owner: "a", runId: "r", to: "REPAIR", findings: ["review:x"], now: T0 })).toMatchObject({ parked: true, limit: "FINDING" });
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
