import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeConfig, setActiveConfig } from "../src/config.mjs";
import {
  learningProposals, learningReport, openLearningDb, recordObservation,
  runLearn, validateObservation,
} from "../src/learn/cli.mjs";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orca-learn-"));
  setActiveConfig(normalizeConfig({ repo: "example/campsty", stateDir: ".local/auto" }, { repoRoot: root }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const sha = "a".repeat(40);
function observation(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    issue: 12,
    headSha: sha,
    outcome: "merged",
    durationMs: 120_000,
    costUsd: 1.25,
    findings: [{ category: "review", key: "tenant-isolation", severity: "P1" }],
    ...overrides,
  };
}
function recordFile(value: unknown) {
  const path = join(root, "input.json");
  writeFileSync(path, JSON.stringify(value));
  return runLearn(["record", "--input", path], { repoRoot: root });
}

describe("orca-learn validation", () => {
  it("rejects unstructured data and raw transcripts rather than storing arbitrary fields", () => {
    for (const invalid of [
      observation({ transcript: "secret" }),
      observation({ runId: "../bad" }),
      observation({ issue: 0 }),
      observation({ headSha: "incomplete" }),
      observation({ outcome: "approved" }),
      observation({ durationMs: -1 }),
      observation({ costUsd: Infinity }),
      observation({ findings: [{ category: "review", key: "UPPER", severity: "P1" }] }),
      observation({ findings: [{ category: "review", key: "a", severity: "P4" }] }),
    ]) expect(validateObservation(invalid).error).toBeTruthy();
  });

  it("canonicalizes duplicate finding keys without double counting", () => {
    const result = validateObservation(observation({
      findings: [
        { category: "qa", key: "gates", severity: "P2" },
        { category: "qa", key: "gates", severity: "P2" },
      ],
    }));
    expect(result.observation?.findings).toEqual([{ category: "qa", key: "gates", severity: "P2" }]);
    expect(validateObservation(observation({
      findings: [
        { category: "qa", key: "gates", severity: "P1" },
        { category: "qa", key: "gates", severity: "P2" },
      ],
    })).error).toMatch(/conflicting/);
  });
});

describe("orca-learn persistence and proposals", () => {
  it("records a run once and rejects evidence changes for the same run id", () => {
    expect(recordFile(observation()).result).toMatchObject({ ok: true, alreadyRecorded: false });
    expect(recordFile(observation()).result).toMatchObject({ ok: true, alreadyRecorded: true });
    const conflict = recordFile(observation({ outcome: "failed" }));
    expect(conflict).toMatchObject({ code: 1, result: { ok: false, code: "RUN_CONFLICT" } });
    expect(runLearn(["report"], { repoRoot: root }).result.summary).toMatchObject({
      runs: 1, merged: 1, failed: 0,
    });
  });

  it("reports recurrence and proposes investigation without making changes", () => {
    for (let i = 1; i <= 3; i++) {
      const result = recordFile(observation({ runId: "run-" + i, issue: 10 + i }));
      expect(result.code).toBe(0);
    }
    const report = runLearn(["report"], { repoRoot: root });
    expect(report.result.recurringFindings).toEqual([{
      category: "review", key: "tenant-isolation",
      occurrences: 3, affectedIssues: 3, highestSeverity: "P1",
    }]);
    const proposals = runLearn(["propose"], { repoRoot: root });
    expect(proposals.result).toMatchObject({
      autoApplied: false,
      proposals: [{ id: "review:tenant-isolation", disposition: "PROPOSAL_ONLY", score: 9 }],
    });
    expect(runLearn(["propose", "--min-occurrences", "4"], { repoRoot: root }).result.proposals).toEqual([]);
  });

  it("isolates data by configured repository even when the state directory is shared", () => {
    const db = openLearningDb(root);
    try {
      const checked = validateObservation(observation());
      expect(recordObservation(db, "example/campsty", checked.observation).ok).toBe(true);
      expect(learningReport(db, "example/campsty").summary.runs).toBe(1);
      expect(learningReport(db, "example/hockey-flow").summary.runs).toBe(0);
      expect(learningProposals(db, "example/hockey-flow").proposals).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("keeps unmeasured duration and cost out of averages", () => {
    expect(recordFile(observation({ durationMs: undefined, costUsd: undefined })).code).toBe(0);
    expect(runLearn(["report"], { repoRoot: root }).result.summary).toMatchObject({
      runs: 1, averageDurationMs: null, averageCostUsd: null,
    });
  });

  it("reports empty history without inventing baselines", () => {
    expect(runLearn(["report"], { repoRoot: root }).result.summary).toMatchObject({
      runs: 0, merged: 0, failed: 0, averageDurationMs: null, averageCostUsd: null,
    });
    expect(runLearn(["propose"], { repoRoot: root }).result.proposals).toEqual([]);
  });

  it("fails closed on malformed CLI flags, invalid source or oversized file", () => {
    expect(runLearn(["record"], { repoRoot: root }).code).toBe(2);
    expect(runLearn(["record", "--input", "no-such-file"], { repoRoot: root }).code).toBe(2);
    expect(runLearn(["report", "--input", "x"], { repoRoot: root }).code).toBe(2);
    expect(runLearn(["propose", "--min-occurrences", "0"], { repoRoot: root }).code).toBe(2);
    expect(runLearn(["propose", "--min-occurrences", "abc"], { repoRoot: root }).code).toBe(2);
    expect(runLearn(["unknown"], { repoRoot: root }).code).toBe(2);
    const path = join(root, "large.json");
    writeFileSync(path, "x".repeat(65_537));
    expect(runLearn(["record", "--input", path], { repoRoot: root }).result.error).toMatch(/64 KiB/);
  });
});
