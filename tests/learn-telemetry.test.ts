import { DatabaseSync } from "node:sqlite";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeConfig, setActiveConfig } from "../src/config.mjs";
import { openLearningDb, recordObservation, validateObservation, runLearn, learningProposals } from "../src/learn/cli.mjs";
import { createImprovementPacket } from "../src/learn/packet.mjs";
import { captureCommand, EVENT_LIMIT, PACKAGE_VERSION, recordCommandEvent, registerLearningRun, telemetryReport, validateRunContext } from "../src/learn/telemetry.mjs";

let root: string;
const repo = "example/telemetry";
const context = (overrides = {}) => ({ runId: "r1", issue: 1, packageVersion: PACKAGE_VERSION, workflow: "fleet", reviewMode: "delegated", ...overrides });
const observation = (overrides = {}) => validateObservation({ runId: "r1", issue: 1, outcome: "merged", ...overrides }).observation;
const event = (overrides = {}) => ({ runId: "r1", issue: 1, packageVersion: PACKAGE_VERSION, command: "orca review-wait", resultCode: "OK", durationMs: 50, ...overrides });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orca-telemetry-"));
  setActiveConfig(normalizeConfig({ repo, stateDir: ".state", learning: { captureCommands: true } }, { repoRoot: root }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function withDb(fn: (db: DatabaseSync) => void) { const db = openLearningDb(root); try { fn(db); } finally { db.close(); } }

describe("learning context, coverage and measured cohorts", () => {
  it("validates bounded contexts and rejects free-form metadata", () => {
    expect(validateRunContext({ runId: "r1", issue: 1, workflow: "fleet", reviewMode: "delegated" }).context).toEqual(context());
    for (const value of [{ runId: "../bad", issue: 1 }, { runId: "r1", issue: 0 }, { runId: "r1", issue: 1, prompt: "secret" },
      { runId: "r1", issue: 1, workflow: "flow", reviewMode: "delegated" }]) expect(validateRunContext(value).error).toBeTruthy();
  });

  it("counts registered runs without terminal observations without calling them failures", () => withDb((db) => {
    registerLearningRun(db, repo, context());
    registerLearningRun(db, repo, context({ runId: "r2", issue: 2 }));
    recordObservation(db, repo, observation());
    recordObservation(db, repo, observation({ runId: "legacy", issue: 3 }));
    const report = telemetryReport(db, repo);
    expect(report.coverage).toMatchObject({ registeredRuns: 2, withTerminalObservation: 1, withoutTerminalObservation: 1, unregisteredTerminalObservations: 1 });
    expect(report.cohorts).toEqual(expect.arrayContaining([
      expect.objectContaining({ packageVersion: PACKAGE_VERSION, workflow: "fleet", reviewMode: "delegated", terminalRuns: 1, merged: 1, averageDurationMs: null }),
      expect.objectContaining({ packageVersion: "unknown", workflow: "unknown", terminalRuns: 1 }),
    ]));
    expect(telemetryReport(db, "other/repo").coverage.registeredRuns).toBe(0);
  }));

  it("fills unknown context once, preserves version identity and rejects cross-issue evidence", () => withDb((db) => {
    registerLearningRun(db, repo, context({ workflow: "unknown", reviewMode: "unknown" }));
    expect(registerLearningRun(db, repo, context()).ok).toBe(true);
    expect(registerLearningRun(db, repo, context({ reviewMode: "default" })).code).toBe("RUN_CONFLICT");
    expect(registerLearningRun(db, repo, context({ packageVersion: "9.0.0" })).code).toBe("RUN_CONFLICT");
    expect(recordObservation(db, repo, observation({ issue: 2 })).code).toBe("RUN_CONFLICT");
    recordObservation(db, repo, observation());
    expect(registerLearningRun(db, repo, context({ reviewMode: "default" })).code).toBe("ALREADY_TERMINAL");
    recordObservation(db, repo, observation({ runId: "old", issue: 2 }));
    expect(registerLearningRun(db, repo, context({ runId: "old", issue: 2 })).code).toBe("ALREADY_TERMINAL");
  }));

  it("accepts measured zeroes, rejects estimates/free-form fields, and reports sample counts", () => withDb((db) => {
    for (const metrics of [{ reviewRounds: -1 }, { reviewWaitMs: 1.5 }, { prompt: "secret" }, []])
      expect(validateObservation({ runId: "r", issue: 1, outcome: "merged", metrics }).error).toBeTruthy();
    registerLearningRun(db, repo, context());
    recordObservation(db, repo, observation({ metrics: { reviewRounds: 2, coordinatorInterventions: 0 } }));
    recordObservation(db, repo, observation({ runId: "r2" }));
    expect(telemetryReport(db, repo).measuredRunMetrics).toContainEqual({ packageVersion: PACKAGE_VERSION, workflow: "fleet", reviewMode: "delegated",
      metrics: { coordinatorInterventions: { measuredRuns: 1, total: 0 }, reviewRounds: { measuredRuns: 1, total: 2 } } });
  }));

  it("supports start CLI without allowing repo/version injection", () => {
    const input = join(root, "input.json");
    writeFileSync(input, JSON.stringify({ runId: "r1", issue: 1, workflow: "fleet", reviewMode: "default" }));
    expect(runLearn(["start", "--input", input], { repoRoot: root }).code).toBe(0);
    expect(runLearn(["start", "--input", input], { repoRoot: root }).result.alreadyRegistered).toBe(true);
    writeFileSync(input, JSON.stringify({ runId: "r1", issue: 1, packageVersion: "1.0.0" }));
    expect(runLearn(["start", "--input", input], { repoRoot: root }).code).toBe(2);
  });
});

describe("bounded command metadata", () => {
  it("is opt-in and never creates a database when disabled", () => {
    setActiveConfig(normalizeConfig({ repo, stateDir: ".state" }, { repoRoot: root }));
    expect(captureCommand({ repoRoot: root, group: "auto", args: ["claim"], code: 0, result: { ok: true }, durationMs: 1 })).toEqual({ enabled: false });
    expect(existsSync(join(root, ".state", "learning.db"))).toBe(false);
  });

  it("captures allowlisted receipts, registers successful claims and drops all free-form output", () => {
    const result = { ok: true, secret: "do-not-save-this", stdout: "private transcript" };
    const args = ["claim", "--issue", "1", "--run", "r1", "--owner", "private-owner"];
    expect(captureCommand({ repoRoot: root, group: "auto", args, code: 0, result, durationMs: 12.2 }).recorded).toBe(true);
    expect(result).toEqual({ ok: true, secret: "do-not-save-this", stdout: "private transcript" });
    withDb((db) => {
      const rows = db.prepare("SELECT * FROM command_events").all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ run_id: "r1", issue: 1, result_code: "OK", duration_ms: 12 });
      expect(JSON.stringify(rows)).not.toMatch(/do-not-save|private transcript|private-owner/);
      expect(telemetryReport(db, repo).coverage.withoutTerminalObservation).toBe(1);
    });
  });

  it("counts refusals and retries as attempts and keeps uncorrelated browser calls explicit", () => {
    for (const code of ["LEASE_LOST", "REPAIR_LIMIT", "unsafe free text"])
      captureCommand({ repoRoot: root, group: "auto", args: ["repair-record", "--run", "r1", "--issue", "1"], code: 1, result: { ok: false, code }, durationMs: 4 });
    captureCommand({ repoRoot: root, group: "orca", args: ["review-wait", "--page", "private-page"], code: 1, result: { code: "REPLY_TIMEOUT" }, durationMs: 60, env: {} });
    withDb((db) => {
      const groups = telemetryReport(db, repo).commandEvents.groups;
      expect(groups.map((g) => g.resultCode)).toEqual(expect.arrayContaining(["LEASE_LOST", "REPAIR_LIMIT", "OTHER_ERROR", "REPLY_TIMEOUT"]));
      expect(groups.find((g) => g.command === "orca review-wait")).toMatchObject({ uncorrelatedCalls: 1, totalDurationMs: 60 });
    });
  });

  it("correlates explicitly identified browser calls with registered mode without storing page IDs", () => {
    withDb((db) => registerLearningRun(db, repo, context()));
    captureCommand({ repoRoot: root, group: "orca", args: ["review-send", "--page", "sensitive-page"], code: 0, result: { ok: true }, durationMs: 2,
      env: { ORCA_LEARN_RUN_ID: "r1", ORCA_LEARN_ISSUE: "1" } });
    withDb((db) => expect(telemetryReport(db, repo).commandEvents.groups[0]).toMatchObject({ workflow: "fleet", reviewMode: "delegated", uncorrelatedCalls: 0 }));
  });

  it("retains only the most recent event budget per repository", () => withDb((db) => {
    const insert = db.prepare("INSERT INTO command_events(repo,package_version,command,result_code,duration_ms) VALUES(?,?,?,?,?)");
    db.exec("BEGIN");
    for (let i = 0; i <= EVENT_LIMIT; i++) insert.run(repo, PACKAGE_VERSION, "auto renew", "OK", 1);
    insert.run("other/repo", PACKAGE_VERSION, "auto renew", "OK", 1);
    db.exec("COMMIT");
    recordCommandEvent(db, repo, event());
    expect(db.prepare("SELECT COUNT(*) AS n FROM command_events WHERE repo=?").get(repo).n).toBe(EVENT_LIMIT);
    expect(db.prepare("SELECT COUNT(*) AS n FROM command_events WHERE repo=?").get("other/repo").n).toBe(1);
    expect(() => recordCommandEvent(db, repo, event({ resultCode: "secret" }))).toThrow();
  }));

  it("gives up on a busy learning database without changing the delivery result", () => withDb((db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      expect(captureCommand({ repoRoot: root, group: "auto", args: ["renew"], code: 0, result: { ok: true }, durationMs: 1 }).code)
        .toBe("TELEMETRY_UNAVAILABLE");
    } finally { db.exec("ROLLBACK"); }
  }));

  it("does not turn persistence failure into a delivery failure", () => {
    writeFileSync(join(root, ".state"), "not a directory");
    expect(captureCommand({ repoRoot: root, group: "auto", args: ["renew"], code: 0, result: { ok: true }, durationMs: 1 }))
      .toEqual({ enabled: true, recorded: false, code: "TELEMETRY_UNAVAILABLE" });
  });

  it("preserves actual CLI receipts and exit codes with telemetry enabled or unavailable", () => {
    execFileSync("git", ["init", "-q", root]);
    const cli = join(import.meta.dirname, "../bin/orca-orchestrator.mjs");
    const call = () => spawnSync(process.execPath, [cli, "auto", "renew", "--issue", "1", "--owner", "test", "--run", "r1"], { cwd: root, encoding: "utf8" });
    const config = { repo, stateDir: ".state" };
    writeFileSync(join(root, "orca.config.json"), JSON.stringify(config));
    const before = call();
    writeFileSync(join(root, "orca.config.json"), JSON.stringify({ ...config, learning: { captureCommands: true } }));
    const after = call();
    expect(after.status).toBe(before.status);
    expect(JSON.parse(after.stdout)).toEqual(JSON.parse(before.stdout));
    const learning = join(root, ".state", "learning.db");
    expect(existsSync(learning)).toBe(true);
    rmSync(learning);
    writeFileSync(learning, "invalid sqlite");
    const unavailable = call();
    expect(unavailable.status).toBe(before.status);
    expect(JSON.parse(unavailable.stdout)).toEqual(JSON.parse(before.stdout));
    expect(unavailable.stderr).toContain("delivery receipt unchanged");
  });
});

describe("review dispositions and compatible migration", () => {
  it("excludes retractions from proposals and packets but retains downgraded findings at their reported final severity", () => withDb((db) => {
    for (const [i, disposition] of ["retracted", "downgraded", "fixed", "open"].entries()) {
      recordObservation(db, repo, observation({ runId: `r${i}`, findings: [{ category: "review", key: "same", severity: "P2", disposition }] }));
    }
    expect(learningProposals(db, repo, { minOccurrences: 4 }).proposals).toEqual([]);
    expect(createImprovementPacket(db, repo, "review:same", { minOccurrences: 4 }).code).toBe("INSUFFICIENT_EVIDENCE");
    expect(createImprovementPacket(db, repo, "review:same", { minOccurrences: 3 }).evidence.occurrences).toBe(3);
    expect(telemetryReport(db, repo).findingDispositions).toHaveLength(4);
  }));

  it("migrates old rows without rewriting immutable payloads or claiming a disposition", () => {
    const db = openLearningDb(root);
    const legacy = observation({ findings: [{ category: "review", key: "old", severity: "P2" }] });
    recordObservation(db, repo, legacy);
    db.exec("ALTER TABLE findings DROP COLUMN disposition");
    db.close();
    withDb((migrated) => {
      expect(recordObservation(migrated, repo, legacy)).toMatchObject({ ok: true, alreadyRecorded: true });
      expect(migrated.prepare("SELECT disposition FROM findings").all()).toEqual([{ disposition: "unspecified" }]);
      expect(telemetryReport(migrated, repo).cohorts[0].packageVersion).toBe("unknown");
    });
  });
});
