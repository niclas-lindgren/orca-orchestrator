import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeConfig, setActiveConfig } from "../src/config.mjs";
import { openLearningDb, recordObservation, runLearn, validateObservation } from "../src/learn/cli.mjs";
import { createImprovementPacket, validatePacketId } from "../src/learn/packet.mjs";

let root: string;
const source = "example/hockey-internal";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orca-packet-"));
  setActiveConfig(normalizeConfig({ repo: source, stateDir: ".local/auto" }, { repoRoot: root }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function insert(db: ReturnType<typeof openLearningDb>, repo: string, run: string, issue = 7, category = "review") {
  const observation = validateObservation({
    runId: run, issue, outcome: "failed",
    findings: [{ category, key: "repeated-guard-failure", severity: "P1" }],
    headSha: "a".repeat(40),
  }).observation;
  expect(recordObservation(db, repo, observation).ok).toBe(true);
}

describe("aggregate learning packet", () => {
  it("validates bounded identifiers and never accepts arbitrary instructions", () => {
    expect(validatePacketId("review:repeated-guard-failure")).not.toBeNull();
    for (const id of ["", "../steal", "review:UPPER", "review: key", "text:x",
      "review:a".repeat(120), "review:x\nshell"]) {
      expect(validatePacketId(id)).toBeNull();
    }
  });

  it("does not emit any raw issue IDs, run IDs or commit IDs", () => {
    const db = openLearningDb(root);
    try {
      insert(db, source, "sensitive-run-id-1", 9021);
      insert(db, source, "sensitive-run-id-2", 9022);
      insert(db, source, "sensitive-run-id-3", 9023);
      const packet = createImprovementPacket(db, source, "review:repeated-guard-failure");
      expect(packet).toMatchObject({
        ok: true, schemaVersion: 1, kind: "ORCA_IMPROVEMENT_PROPOSAL",
        sourceRepo: source, evidence: { occurrences: 3, affectedIssues: 3, highestSeverity: "P1" },
        policy: { disposition: "DRAFT_PR_ONLY", selfApproval: false, autoMerge: false,
          independentEvaluationRequired: true, protectedChangesRequireHumanApproval: true },
      });
      expect(packet.evidence.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
      const encoded = JSON.stringify(packet);
      for (const forbidden of ["sensitive-run-id", "9021", "9022", "9023", "a".repeat(40)]) {
        expect(encoded).not.toContain(forbidden);
      }
      expect(createImprovementPacket(db, source, "review:repeated-guard-failure"))
        .toEqual(packet); // deterministic evidence fingerprint
    } finally { db.close(); }
  });

  it("fails closed with insufficient evidence and isolates source repositories", () => {
    const db = openLearningDb(root);
    try {
      insert(db, source, "run-1");
      insert(db, source, "run-2");
      insert(db, "example/other", "run-3");
      expect(createImprovementPacket(db, source, "review:repeated-guard-failure")).toMatchObject({
        ok: false, code: "INSUFFICIENT_EVIDENCE", occurrences: 2, required: 3,
      });
      expect(createImprovementPacket(db, "example/other", "review:repeated-guard-failure"))
        .toMatchObject({ ok: false, code: "INSUFFICIENT_EVIDENCE", occurrences: 1 });
    } finally { db.close(); }
  });

  it("updates the evidence fingerprint when a genuine new run is recorded", () => {
    const db = openLearningDb(root);
    try {
      for (let i = 0; i < 3; i++) insert(db, source, "run-" + i);
      const first = createImprovementPacket(db, source, "review:repeated-guard-failure");
      insert(db, source, "run-3");
      const second = createImprovementPacket(db, source, "review:repeated-guard-failure");
      expect(second.evidence.occurrences).toBe(4);
      expect(second.evidence.fingerprintSha256).not.toBe(first.evidence.fingerprintSha256);
    } finally { db.close(); }
  });

  it("exposes a read-only CLI handoff and rejects missing or invalid arguments", () => {
    const db = openLearningDb(root);
    try {
      for (let i = 0; i < 3; i++) insert(db, source, "run-" + i);
    } finally { db.close(); }
    expect(runLearn(["packet", "--id", "review:repeated-guard-failure"], { repoRoot: root }))
      .toMatchObject({ code: 0, result: { ok: true, evidence: { occurrences: 3 } } });
    expect(runLearn(["packet", "--id", "review:unknown"], { repoRoot: root }))
      .toMatchObject({ code: 1, result: { code: "INSUFFICIENT_EVIDENCE" } });
    for (const flags of [
      ["packet"], ["packet", "--id", "../bad"], ["packet", "--id", "review:x", "--min-occurrences", "0"],
      ["packet", "--id", "review:x", "--min-occurrences", "101"],
      ["packet", "--id", "review:x", "--input", "anything"],
    ]) expect(runLearn(flags, { repoRoot: root }).code).not.toBe(0);
  });
});
