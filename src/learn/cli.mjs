// Append-only, repository-scoped delivery observations and proposal-only learning.
// No agent execution, policy changes, issue creation, or automatic promotion happens here.
import { readFileSync, statSync } from "node:fs";
import { repoSlug } from "../config.mjs";
import { openLearningDb } from "./storage.mjs";
import { registerLearningRun, validateRunContext, telemetryReport } from "./telemetry.mjs";
export { openLearningDb } from "./storage.mjs";
import { createImprovementPacket } from "./packet.mjs";

const OUTCOMES = new Set(["merged", "blocked", "failed"]);
const CATEGORIES = new Set(["review", "qa", "workflow", "tool", "security"]);
const SEVERITIES = new Set(["P1", "P2", "P3"]);
const KEY = /^[a-z0-9][a-z0-9._:/-]{0,95}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA = /^[0-9a-f]{40}$/;
const MAX_INPUT_BYTES = 65_536;
const MAX_FINDINGS = 100;

function allowedKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function validateObservation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { error: "observation must be a JSON object" };
  if (!allowedKeys(value, ["runId", "issue", "headSha", "outcome", "durationMs", "costUsd", "metrics", "findings"]))
    return { error: "observation contains unsupported fields (never submit raw logs or transcripts)" };
  if (typeof value.runId !== "string" || !RUN_ID.test(value.runId))
    return { error: "runId must be an ASCII identifier of 1-128 characters" };
  if (!Number.isSafeInteger(value.issue) || value.issue < 1)
    return { error: "issue must be a positive integer" };
  if (value.headSha !== undefined && value.headSha !== null && (typeof value.headSha !== "string" || !SHA.test(value.headSha)))
    return { error: "headSha must be a lowercase 40-character SHA, or null" };
  if (!OUTCOMES.has(value.outcome)) return { error: "outcome must be merged, blocked, or failed" };
  if (value.durationMs !== undefined && value.durationMs !== null &&
      (!Number.isSafeInteger(value.durationMs) || value.durationMs < 0))
    return { error: "durationMs must be a non-negative integer, or null" };
  if (value.costUsd !== undefined && value.costUsd !== null &&
      (typeof value.costUsd !== "number" || !Number.isFinite(value.costUsd) || value.costUsd < 0))
    return { error: "costUsd must be non-negative and finite, or null" };
  if (value.metrics !== undefined && (!value.metrics || typeof value.metrics !== "object" || Array.isArray(value.metrics) ||
      !allowedKeys(value.metrics, ["reviewRounds", "reviewWaitMs", "coordinatorInterventions", "leaseLosses", "adoptions"]) ||
      Object.values(value.metrics).some((n) => !Number.isSafeInteger(n) || n < 0)))
    return { error: "metrics must contain only measured non-negative integer reviewRounds, reviewWaitMs, coordinatorInterventions, leaseLosses or adoptions" };
  const findings = value.findings ?? [];
  if (!Array.isArray(findings) || findings.length > MAX_FINDINGS)
    return { error: "findings must be an array of at most 100 entries" };
  const unique = new Map();
  for (const finding of findings) {
    if (!finding || typeof finding !== "object" || Array.isArray(finding) ||
        !allowedKeys(finding, ["category", "key", "severity", "disposition"]) ||
        !CATEGORIES.has(finding.category) || typeof finding.key !== "string" ||
        !KEY.test(finding.key) || !SEVERITIES.has(finding.severity) ||
        (finding.disposition !== undefined && !["fixed", "retracted", "downgraded", "open", "unspecified"].includes(finding.disposition)))
      return { error: "each finding needs category, stable lowercase key, severity P1|P2|P3 and optional disposition fixed|retracted|downgraded|open|unspecified" };
    const id = finding.category + ":" + finding.key;
    if (unique.has(id) && (unique.get(id).severity !== finding.severity ||
        unique.get(id).disposition !== finding.disposition))
      return { error: "duplicate finding has conflicting severity or disposition" };
    unique.set(id, { category: finding.category, key: finding.key, severity: finding.severity,
      ...(finding.disposition === undefined ? {} : { disposition: finding.disposition }) });
  }
  const normalized = {
    runId: value.runId,
    issue: value.issue,
    headSha: value.headSha ?? null,
    outcome: value.outcome,
    durationMs: value.durationMs ?? null,
    costUsd: value.costUsd ?? null,
    ...(value.metrics === undefined ? {} : { metrics: Object.fromEntries(Object.entries(value.metrics).sort(([a], [b]) => a.localeCompare(b))) }),
    findings: [...unique.values()].sort((a, b) =>
      (a.category + ":" + a.key).localeCompare(b.category + ":" + b.key)),
  };
  return { observation: normalized };
}

export function recordObservation(db, repo, observation) {
  const payload = JSON.stringify(observation);
  db.exec("BEGIN IMMEDIATE");
  try {
    const context = db.prepare("SELECT issue FROM learning_runs WHERE repo = ? AND run_id = ?").get(repo, observation.runId);
    if (context && context.issue !== observation.issue) {
      db.exec("ROLLBACK");
      return { ok: false, code: "RUN_CONFLICT", error: "run registration belongs to another issue" };
    }
    const prior = db.prepare("SELECT payload FROM observations WHERE repo = ? AND run_id = ?")
      .get(repo, observation.runId);
    if (prior) {
      db.exec("ROLLBACK");
      return prior.payload === payload
        ? { ok: true, alreadyRecorded: true, runId: observation.runId }
        : { ok: false, code: "RUN_CONFLICT", error: "runId already has different immutable evidence" };
    }
    db.prepare("INSERT INTO observations(repo,run_id,issue,head_sha,outcome,duration_ms,cost_usd,payload) VALUES(?,?,?,?,?,?,?,?)")
      .run(repo, observation.runId, observation.issue, observation.headSha, observation.outcome,
        observation.durationMs, observation.costUsd, payload);
    const insert = db.prepare("INSERT INTO findings(repo,run_id,category,key,severity,disposition) VALUES(?,?,?,?,?,?)");
    for (const finding of observation.findings)
      insert.run(repo, observation.runId, finding.category, finding.key, finding.severity, finding.disposition ?? "unspecified");
    db.exec("COMMIT");
    return { ok: true, alreadyRecorded: false, runId: observation.runId };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function learningReport(db, repo, { limit = 50 } = {}) {
  const summary = db.prepare(
    "SELECT COUNT(*) AS runs, " +
    "COALESCE(SUM(CASE WHEN outcome = 'merged' THEN 1 ELSE 0 END), 0) AS merged, " +
    "COALESCE(SUM(CASE WHEN outcome = 'blocked' THEN 1 ELSE 0 END), 0) AS blocked, " +
    "COALESCE(SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END), 0) AS failed, " +
    "ROUND(AVG(duration_ms)) AS averageDurationMs, " +
    "ROUND(AVG(cost_usd), 4) AS averageCostUsd " +
    "FROM observations WHERE repo = ?"
  ).get(repo);
  const rows = db.prepare(
    "SELECT f.category, f.key, COUNT(*) AS occurrences, COUNT(DISTINCT o.issue) AS issues, " +
    "MIN(CASE f.severity WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END) AS severityRank " +
    "FROM findings f INNER JOIN observations o ON o.repo = f.repo AND o.run_id = f.run_id " +
    "WHERE f.repo = ? AND f.disposition != 'retracted' GROUP BY f.category, f.key " +
    "ORDER BY occurrences DESC, severityRank ASC, f.category ASC, f.key ASC LIMIT ?"
  ).all(repo, limit);
  return {
    repo,
    summary: {
      runs: summary.runs,
      merged: summary.merged,
      blocked: summary.blocked,
      failed: summary.failed,
      averageDurationMs: summary.averageDurationMs,
      averageCostUsd: summary.averageCostUsd,
    },
    telemetry: telemetryReport(db, repo),
    recurringFindings: rows.map((r) => ({
      category: r.category, key: r.key, occurrences: r.occurrences,
      affectedIssues: r.issues, highestSeverity: "P" + r.severityRank,
    })),
  };
}

const ACTIONS = {
  review: "Investigate review patterns; strengthen preflight checks and focused regression tests.",
  qa: "Add or improve focused tests for the recurring failure before changing implementation strategy.",
  workflow: "Check orchestration transitions and recovery scenarios in a deterministic replay harness.",
  tool: "Investigate tool invocation and receipt validation, including ambiguous outcomes.",
  security: "Add an adversarial safety regression case and require independent human review.",
};

export function learningProposals(db, repo, { minOccurrences = 3, limit = 10 } = {}) {
  // Read-only: these are evidence-linked hypotheses, never executable instructions.
  const report = learningReport(db, repo, { limit: 500 });
  const ranked = report.recurringFindings
    .filter((r) => r.occurrences >= minOccurrences)
    .map((r) => ({
      id: r.category + ":" + r.key,
      evidence: r,
      score: r.occurrences * (4 - Number(r.highestSeverity.slice(1))),
      hypothesis: "Recurring " + r.category + " finding " + r.key +
        " may indicate a systematic gap; validate on fixed and held-out tasks.",
      suggestedInvestigation: ACTIONS[r.category],
      disposition: "PROPOSAL_ONLY",
    }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);
  return { repo, minOccurrences, proposals: ranked, autoApplied: false };
}

function invalid(error) {
  return { code: 2, result: { ok: false, code: "INVALID_ARGS", error } };
}

function flagsFrom(args, keys) {
  if (args.length % 2) return { error: "flags require values" };
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!keys.includes(key) || flags[key] !== undefined || !args[i + 1] ||
        args[i + 1].startsWith("--")) return { error: "unknown, duplicate, or missing flag: " + key };
    flags[key] = args[i + 1];
  }
  return { flags };
}

export function runLearn(argv, { repoRoot }) {
  const [command, ...rest] = argv;
  if (!["start", "record", "report", "propose", "packet"].includes(command))
    return invalid("usage: learn <start --input file|record --input file|report|propose [--min-occurrences N]|packet --id category:key [--min-occurrences N]>");
  const parsed = flagsFrom(rest, ["start", "record"].includes(command) ? ["--input"] :
    command === "packet" ? ["--id", "--min-occurrences"] :
    command === "propose" ? ["--min-occurrences"] : []);
  if (parsed.error) return invalid(parsed.error);
  const flags = parsed.flags;
  if (["start", "record"].includes(command) && !flags["--input"])
    return invalid(`${command} requires --input <json-file>`);
  if (command === "packet" && !flags["--id"])
    return invalid("packet requires --id <category:key>");
  let observation;
  if (["start", "record"].includes(command)) {
    try {
      if (statSync(flags["--input"]).size > MAX_INPUT_BYTES)
        return invalid("input exceeds 64 KiB; never record logs or transcripts");
      const read = JSON.parse(readFileSync(flags["--input"], "utf8"));
      const parsedObservation = command === "start" ? validateRunContext(read) : validateObservation(read);
      if (parsedObservation.error) return invalid(parsedObservation.error);
      observation = parsedObservation.observation ?? parsedObservation.context;
    } catch {
      return invalid("input must be a readable JSON file");
    }
  }
  const minimum = flags["--min-occurrences"] === undefined ? 3 : Number(flags["--min-occurrences"]);
  if (!Number.isSafeInteger(minimum) || minimum < 2 || minimum > 100)
    return invalid("--min-occurrences must be an integer between 2 and 100");
  let db;
  try {
    const repo = repoSlug();
    db = openLearningDb(repoRoot);
    if (["start", "record"].includes(command)) {
      const result = command === "start" ? registerLearningRun(db, repo, observation) : recordObservation(db, repo, observation);
      return { code: result.ok ? 0 : 1, result: { ...result, repo } };
    }
    const result = command === "report" ? learningReport(db, repo) :
      command === "packet" ? createImprovementPacket(db, repo, flags["--id"], { minOccurrences: minimum }) :
      learningProposals(db, repo, { minOccurrences: minimum });
    return { code: result.ok === false ? 1 : 0, result: command === "packet" ? result : { ok: true, ...result } };
  } catch (error) {
    return { code: 1, result: { ok: false, code: "LEARN_UNAVAILABLE", error: String(error?.message ?? error) } };
  } finally {
    db?.close();
  }
}
