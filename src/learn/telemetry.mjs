// Local, bounded metadata only. Never retain arguments, output, prompts or credentials.
import { readFileSync } from "node:fs";
import { activeConfig, repoSlug } from "../config.mjs";
import { openLearningDb } from "./storage.mjs";

export const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
export const EVENT_LIMIT = 10_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
const WORKFLOWS = ["flow", "fleet", "unknown"];
const MODES = ["default", "delegated", "unknown"];
const COMMANDS = new Set([
  "auto claim", "auto renew", "auto adopt", "auto release", "auto auth-check",
  "auto repair-record", "auto review-record", "auto review-forget",
  "orca review-open", "orca review-send", "orca review-wait", "orca review-read",
  "orca review-delete", "orca verify-head", "orca cleanup",
]);
// Unknown codes collapse to OTHER_ERROR: never persist free-form error text.
const CODES = new Set(["LEASE_LOST", "PAUSED", "ISSUE_BLOCKED", "PR_HEAD_MISMATCH", "DIRTY_WORKTREE",
  "GITHUB_UNAVAILABLE", "STALE_HEAD", "REPLY_TIMEOUT", "BROWSER_UNAVAILABLE", "BROWSER_CHALLENGE",
  "NOT_OWNER", "REPAIR_LIMIT"]);

export function validateRunContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((k) => !["runId", "issue", "workflow", "reviewMode"].includes(k)) ||
      typeof value.runId !== "string" || !ID.test(value.runId) ||
      !Number.isSafeInteger(value.issue) || value.issue < 1 ||
      !WORKFLOWS.includes(value.workflow ?? "unknown") || !MODES.includes(value.reviewMode ?? "unknown") ||
      (value.reviewMode === "delegated" && value.workflow !== "fleet"))
    return { error: "start needs runId, positive issue, workflow flow|fleet|unknown and reviewMode default|delegated|unknown; no raw metadata" };
  return { context: { runId: value.runId, issue: value.issue, packageVersion: PACKAGE_VERSION,
    workflow: value.workflow ?? "unknown", reviewMode: value.reviewMode ?? "unknown" } };
}

export function registerLearningRun(db, repo, context) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const prior = db.prepare("SELECT * FROM learning_runs WHERE repo = ? AND run_id = ?").get(repo, context.runId);
    const terminal = db.prepare("SELECT 1 FROM observations WHERE repo = ? AND run_id = ?").get(repo, context.runId);
    if (terminal && (!prior || (context.workflow !== "unknown" && context.workflow !== prior.workflow) ||
        (context.reviewMode !== "unknown" && context.reviewMode !== prior.review_mode))) {
      db.exec("ROLLBACK");
      return { ok: false, code: "ALREADY_TERMINAL" };
    }
    if (prior) {
      // Claim capture may register unknown mode before the coordinator supplies it.
      if (prior.issue !== context.issue || prior.package_version !== context.packageVersion ||
          (prior.workflow !== "unknown" && context.workflow !== "unknown" && prior.workflow !== context.workflow) ||
          (prior.review_mode !== "unknown" && context.reviewMode !== "unknown" && prior.review_mode !== context.reviewMode)) {
        db.exec("ROLLBACK");
        return { ok: false, code: "RUN_CONFLICT" };
      }
      db.prepare("UPDATE learning_runs SET workflow = ?, review_mode = ? WHERE repo = ? AND run_id = ?")
        .run(prior.workflow === "unknown" ? context.workflow : prior.workflow,
          prior.review_mode === "unknown" ? context.reviewMode : prior.review_mode, repo, context.runId);
    } else {
      db.prepare("INSERT INTO learning_runs(repo,run_id,issue,package_version,workflow,review_mode) VALUES(?,?,?,?,?,?)")
        .run(repo, context.runId, context.issue, context.packageVersion, context.workflow, context.reviewMode);
    }
    db.exec("COMMIT");
    return { ok: true, runId: context.runId, alreadyRegistered: Boolean(prior) };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function recordCommandEvent(db, repo, event) {
  if (!COMMANDS.has(event.command) || typeof event.packageVersion !== "string" || !VERSION.test(event.packageVersion) ||
      (event.runId !== null && (typeof event.runId !== "string" || !ID.test(event.runId))) ||
      (event.issue !== null && (!Number.isSafeInteger(event.issue) || event.issue < 1)) ||
      !Number.isSafeInteger(event.durationMs) || event.durationMs < 0 ||
      !["OK", "OTHER_ERROR", "EXCEPTION", ...CODES].includes(event.resultCode))
    throw new Error("invalid telemetry event");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO command_events(repo,run_id,issue,package_version,command,result_code,duration_ms) VALUES(?,?,?,?,?,?,?)")
      .run(repo, event.runId, event.issue, event.packageVersion, event.command, event.resultCode, event.durationMs);
    db.prepare("DELETE FROM command_events WHERE repo = ? AND id NOT IN (SELECT id FROM command_events WHERE repo = ? ORDER BY id DESC LIMIT ?)")
      .run(repo, repo, EVENT_LIMIT);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

// Returns diagnostic metadata only; never changes the command receipt or exit code.
export function captureCommand({ repoRoot, group, args, code, result, durationMs, env = process.env }) {
  if (activeConfig().learning?.captureCommands !== true || !COMMANDS.has(`${group} ${args[0]}`)) return { enabled: false };
  let db;
  try {
    const flag = (name) => { const i = args.indexOf(`--${name}`); return i < 0 ? null : args[i + 1]; };
    const rawRun = flag("run") ?? env.ORCA_LEARN_RUN_ID;
    const rawIssue = flag("issue") ?? env.ORCA_LEARN_ISSUE;
    const runId = typeof rawRun === "string" && ID.test(rawRun) ? rawRun : null;
    const issue = Number.isSafeInteger(Number(rawIssue)) && Number(rawIssue) > 0 ? Number(rawIssue) : null;
    const repo = repoSlug();
    db = openLearningDb(repoRoot);
    const resultCode = result === undefined ? "EXCEPTION" : code === 0 && result?.ok !== false ? "OK" : CODES.has(result?.code) ? result.code : "OTHER_ERROR";
    recordCommandEvent(db, repo, { command: `${group} ${args[0]}`, packageVersion: PACKAGE_VERSION,
      runId, issue, resultCode, durationMs: Math.max(0, Math.round(durationMs)) });
    let registration;
    if (group === "auto" && ["claim", "adopt"].includes(args[0]) && resultCode === "OK" && runId && issue)
      registration = registerLearningRun(db, repo, { runId, issue, packageVersion: PACKAGE_VERSION, workflow: "unknown", reviewMode: "unknown" });
    return { enabled: true, recorded: true, ...(registration?.ok === false ? { registrationCode: registration.code } : {}) };
  } catch {
    return { enabled: true, recorded: false, code: "TELEMETRY_UNAVAILABLE" };
  } finally {
    // Even a close failure must not replace the delivery command's result.
    try { db?.close(); } catch { /* best-effort telemetry only */ }
  }
}

export function telemetryReport(db, repo) {
  const coverage = db.prepare(`SELECT COUNT(*) AS registeredRuns,
    COALESCE(SUM(CASE WHEN o.run_id IS NOT NULL THEN 1 ELSE 0 END),0) AS withTerminalObservation,
    COALESCE(SUM(CASE WHEN o.run_id IS NULL THEN 1 ELSE 0 END),0) AS withoutTerminalObservation
    FROM learning_runs r LEFT JOIN observations o ON o.repo=r.repo AND o.run_id=r.run_id AND o.issue=r.issue
    WHERE r.repo=?`).get(repo);
  const unregistered = db.prepare(`SELECT COUNT(*) AS count FROM observations o LEFT JOIN learning_runs r
    ON r.repo=o.repo AND r.run_id=o.run_id AND r.issue=o.issue WHERE o.repo=? AND r.run_id IS NULL`).get(repo).count;
  const cohorts = db.prepare(`SELECT COALESCE(r.package_version,'unknown') AS packageVersion,
    COALESCE(r.workflow,'unknown') AS workflow, COALESCE(r.review_mode,'unknown') AS reviewMode,
    COUNT(*) AS terminalRuns, SUM(CASE WHEN o.outcome='merged' THEN 1 ELSE 0 END) AS merged,
    SUM(CASE WHEN o.outcome='blocked' THEN 1 ELSE 0 END) AS blocked,
    SUM(CASE WHEN o.outcome='failed' THEN 1 ELSE 0 END) AS failed,
    COUNT(o.duration_ms) AS measuredDurations, ROUND(AVG(o.duration_ms)) AS averageDurationMs
    FROM observations o LEFT JOIN learning_runs r ON r.repo=o.repo AND r.run_id=o.run_id AND r.issue=o.issue
    WHERE o.repo=? GROUP BY 1,2,3 ORDER BY 1,2,3`).all(repo);
  const events = db.prepare(`SELECT e.package_version AS packageVersion,
    COALESCE(r.workflow,'unknown') AS workflow, COALESCE(r.review_mode,'unknown') AS reviewMode,
    e.command, e.result_code AS resultCode, COUNT(*) AS calls, SUM(e.duration_ms) AS totalDurationMs,
    SUM(CASE WHEN r.run_id IS NULL THEN 1 ELSE 0 END) AS uncorrelatedCalls
    FROM command_events e LEFT JOIN learning_runs r ON r.repo=e.repo AND r.run_id=e.run_id AND r.issue=e.issue
    WHERE e.repo=? GROUP BY 1,2,3,4,5 ORDER BY 1,2,3,4,5`).all(repo);
  const metricNames = ["reviewRounds", "reviewWaitMs", "coordinatorInterventions", "leaseLosses", "adoptions"];
  // Aggregate in SQLite instead of loading every immutable payload into memory.
  const metricColumns = metricNames.map((name) =>
    `COUNT(json_extract(o.payload,'$.metrics.${name}')) AS ${name}Count, SUM(json_extract(o.payload,'$.metrics.${name}')) AS ${name}Total`).join(",");
  const metrics = db.prepare(`SELECT COALESCE(r.package_version,'unknown') AS packageVersion,
    COALESCE(r.workflow,'unknown') AS workflow, COALESCE(r.review_mode,'unknown') AS reviewMode,
    ${metricColumns} FROM observations o LEFT JOIN learning_runs r ON r.repo=o.repo AND r.run_id=o.run_id AND r.issue=o.issue
    WHERE o.repo=? GROUP BY 1,2,3 ORDER BY 1,2,3`).all(repo);
  const metricGroups = metrics.map((row) => ({ packageVersion: row.packageVersion, workflow: row.workflow, reviewMode: row.reviewMode,
    metrics: Object.fromEntries(metricNames.filter((name) => row[`${name}Count`] > 0).map((name) =>
      [name, { measuredRuns: row[`${name}Count`], total: row[`${name}Total`] }])) }));
  const dispositions = db.prepare("SELECT disposition, COUNT(*) AS findings FROM findings WHERE repo=? GROUP BY disposition ORDER BY disposition").all(repo);
  return { coverage: { ...coverage, unregisteredTerminalObservations: unregistered,
    scope: "registered runs only; missing observations may be active, transferred, interrupted or omitted; not a fleet-wide denominator" },
    cohorts, commandEvents: { retentionLimit: EVENT_LIMIT, scope: "retained command attempts, not unique review rounds or defects", groups: events },
    measuredRunMetrics: metricGroups, findingDispositions: dispositions };
}
