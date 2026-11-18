// Single-shot Orca dispatcher.
//
// `tick` wakes once, reconciles what Orca, the dispatch records and the lease
// store already say, and starts at most the free worker capacity from live GitHub
// issues. It installs no timer and runs no loop: an operator-enabled wakeup (a user
// systemd timer or Orca's own wake) calls it. It is disabled until an operator
// config says otherwise. It only starts workers; review, repair, merge and issue
// closure stay with the coordinating `orca-deliver` session.
//
// Every uncertainty fails closed: an unreadable record, an unreachable runtime or a
// start that was never confirmed blocks new dispatch and is reported, never retried.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AUTO_COMMAND } from "../paths.mjs";
import { isPaused } from "../auto/state.mjs";
import { buildDispatchPlan, dispatch, leaseHeldBy } from "./adapter.mjs";
import { nativeNext, workerIsIn, worktreeWorkerStatus } from "./workers.mjs";
import { resolveIssueWorktree } from "../auto/worktrees.mjs";

export const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  maxWorkers: 1,
  dailyStartBudget: 3,
  window: { startHour: 8, endHour: 20, timeZone: "Europe/Oslo" },
  readyLabel: "status:ready",
  excludeLabels: ["status:blocked"],
  owner: "dispatcher",
  agent: "claude",
  leaseTtlMin: 60,
  // Off by default: resuming a dead worker starts an agent without a person
  // present, so an operator must opt in explicitly.
  autoResume: false,
  autoResumeMaxRetries: 2,
});

const STALE_LOCK_MS = 10 * 60_000;
const TERMINAL = ["COMPLETE", "PARKED", "FAILED"];
const dispatcherDir = (stateDir) => join(stateDir, "dispatcher");
export const configFile = (stateDir) => join(stateDir, "dispatcher.json");
export const statusFile = (stateDir) => join(dispatcherDir(stateDir), "status.json");

/** @typedef {(command: string, args: string[], cwd: string) => { status: number | null, stdout: string, stderr: string }} Exec */
/** @type {Exec} */
const defaultExec = (command, args, cwd) => spawnSync(command, args, { cwd, encoding: "utf8" });

function readJson(file) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, "utf8")) };
  } catch (error) {
    return { ok: false, missing: error?.code === "ENOENT" };
  }
}

function execJson(exec, command, args, cwd) {
  const result = exec(command, args, cwd);
  if (result.status !== 0) return { ok: false, error: (result.stderr || result.stdout || "").trim().slice(0, 300) };
  try {
    return { ok: true, value: JSON.parse(result.stdout) };
  } catch {
    return { ok: false, error: "non-JSON output" };
  }
}

// A missing config is the default (disabled). A present but unreadable one stays
// disabled and says why, so a typo never turns dispatch on.
export function loadConfig(stateDir) {
  const read = readJson(configFile(stateDir));
  if (!read.ok) return { config: { ...DEFAULT_CONFIG }, problem: read.missing ? null : "dispatcher.json is not valid JSON" };
  const value = read.value ?? {};
  const retries = Number(value.autoResumeMaxRetries ?? DEFAULT_CONFIG.autoResumeMaxRetries);
  return {
    config: {
      ...DEFAULT_CONFIG,
      ...value,
      window: { ...DEFAULT_CONFIG.window, ...(value.window ?? {}) },
      autoResume: value.autoResume === true,
      autoResumeMaxRetries: Number.isInteger(retries) && retries >= 0 ? retries : DEFAULT_CONFIG.autoResumeMaxRetries,
    },
    problem: null,
  };
}

function zonedParts(ms, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

export function insideWindow(ms, window) {
  const { hour } = zonedParts(ms, window.timeZone);
  return hour >= window.startHour && hour < window.endHour;
}

function ledgerFile(stateDir) {
  return join(dispatcherDir(stateDir), "ledger.json");
}

function readAttempts(stateDir, day) {
  const read = readJson(ledgerFile(stateDir));
  // An unreadable ledger counts as spent: the budget must not reset by corruption.
  if (!read.ok) return read.missing ? 0 : Number.POSITIVE_INFINITY;
  const { day: storedDay, attempts } = read.value ?? {};
  if (!Number.isInteger(attempts) || attempts < 0 || typeof storedDay !== "string") return Number.POSITIVE_INFINITY;
  return storedDay === day ? attempts : 0;
}

function writeAtomic(file, text) {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

// Counts the attempt before any claim, so a crash after the start still spends it.
function recordAttempt(stateDir, day) {
  writeAtomic(ledgerFile(stateDir), `${JSON.stringify({ day, attempts: readAttempts(stateDir, day) + 1 })}\n`);
}

// Durable global lock. It is stale only when it is old AND its process is gone, so
// a slow tick never loses exclusivity to a live one. A stale lock is moved aside by
// rename and the moved file is checked to be the one that was inspected; if a newer
// owner's lock was moved by mistake it is put back. A running tick re-checks that the
// lock is still its own before each claim (the fence) and refreshes it.
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function lockMtime(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function acquireLock(stateDir, now) {
  const file = join(dispatcherDir(stateDir), "tick.lock");
  mkdirSync(dispatcherDir(stateDir), { recursive: true });
  const token = randomUUID();
  const body = (at) => `${JSON.stringify({ token, pid: process.pid, at })}\n`;
  const create = () => {
    try {
      writeFileSync(file, body(now), { flag: "wx" });
      return true;
    } catch (error) {
      if (error?.code === "EEXIST") return false;
      throw error;
    }
  };
  const handle = () => ({
    ok: true,
    release: () => releaseLock(file, token),
    // False once another tick has replaced the lock; otherwise refreshes it.
    holds: (at) => {
      const held = readJson(file);
      if (!held.ok || held.value?.token !== token) return false;
      writeAtomic(file, body(at));
      return true;
    },
  });
  if (create()) return handle();
  const held = readJson(file);
  const inspected = held.ok ? held.value : null;
  // An unreadable lock is not evidence of a dead owner: only its age counts then.
  const old = inspected ? !(now - Number(inspected.at) < STALE_LOCK_MS) : !(now - lockMtime(file) < STALE_LOCK_MS);
  if (!old || (inspected && processAlive(inspected.pid))) return { ok: false };
  const moved = `${file}.stale-${token}`;
  try {
    renameSync(file, moved);
  } catch {
    return { ok: false };
  }
  const movedBody = readJson(moved);
  const same = inspected ? movedBody.ok && movedBody.value?.token === inspected.token : !movedBody.ok;
  if (!same) {
    // A newer owner's lock was moved by mistake: put it back unless yet another one exists.
    try {
      linkSync(moved, file);
    } catch {
      // Another lock already stands; the moved file is discarded below.
    }
    rmSync(moved, { force: true });
    return { ok: false };
  }
  rmSync(moved, { force: true });
  return create() ? handle() : { ok: false };
}

function releaseLock(file, token) {
  const held = readJson(file);
  if (held.ok && held.value?.token === token) rmSync(file, { force: true });
}

function readDispatchRecords(stateDir) {
  const dir = join(stateDir, "orca-dispatch");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^issue-\d+\.json$/.test(name))
    .map((name) => {
      const issue = Number(name.slice("issue-".length, -".json".length));
      const read = readJson(join(dir, name));
      return { issue, record: read.ok ? read.value : null };
    });
}

// Native Orca may place the issue worktree anywhere; ask Git where it is and fall
// back to the legacy path only when Git cannot say (worktree-show then fails closed).
function worktreeFor(repoRoot, issue, exec) {
  const found = resolveIssueWorktree(repoRoot, issue, exec);
  return found.ok ? found.path : undefined;
}

// "live": a matching worker Orca says runs. "unverifiable": liveness unproven, never
// treated as finished. "finished": all matching workers provably exited. "unknown":
// nothing identifies the worker.
function workerStatus(workers, worktree) {
  const status = worktreeWorkerStatus(workers, worktree);
  return status === "none" ? "unknown" : status === "dead" ? "finished" : status;
}

/**
 * Reads Orca, the dispatch records and the lease store and classifies every issue
 * the dispatcher has touched. `reliable: false` means a source could not be read,
 * and nothing new may be dispatched on that tick.
 */
export function reconcile({ repoRoot, stateDir, exec, now }) {
  const auto = [...AUTO_COMMAND];
  const lease = execJson(exec, auto[0], [...auto.slice(1), "status"], repoRoot);
  const workersRead = execJson(exec, "orca", ["orchestration", "worker-list", "--include-remote", "--json"], repoRoot);
  const reliable = lease.ok && workersRead.ok;
  const leases = lease.ok ? (lease.value.runs ?? []) : [];
  const workers = workersRead.ok ? (workersRead.value.result?.workers ?? workersRead.value.workers ?? []) : [];
  const buckets = { active: [], review: [], ambiguous: [], orphanClaims: [], otherOwners: [] };

  const records = readDispatchRecords(stateDir);
  for (const { issue, record } of records) {
    const state = record?.state;
    if (state === "not-started") continue;
    if (state !== "started") {
      buckets.ambiguous.push({ issue, state: state ?? "unreadable" });
      continue;
    }
    const worktree = buildDispatchPlan({ issue, title: "", owner: record.owner, runId: record.runId, repoRoot, stateDir, worktree: worktreeFor(repoRoot, issue, exec) }).worktree;
    const entry = { issue, owner: record.owner, runId: record.runId };
    // Orca's own next step for this worker, if it gave one.
    const mine = workers.find((w) => workerIsIn(w, worktree));
    if (mine && nativeNext(mine)) entry.nativeNext = nativeNext(mine);
    const status = workersRead.ok ? workerStatus(workers, worktree) : "unreadable";
    // A worker Orca no longer lists is finished only when the lease store says the
    // issue reached a terminal state; otherwise it cannot be told from a lost worker.
    const terminalLease = leases.some((run) => run.issue === issue && TERMINAL.includes(run.state));
    if (status === "live") buckets.active.push(entry);
    else if (status === "finished" || (status === "unknown" && terminalLease)) buckets.review.push(entry);
    else buckets.ambiguous.push({ issue, state: status === "unknown" ? "started-worker-unidentified" : "started-unverifiable" });
  }

  const recorded = new Set(records.map((r) => r.issue));
  for (const run of leases) {
    if (TERMINAL.includes(run.state) || run.lease_expires_at <= now) continue;
    if (recorded.has(run.issue)) continue;
    if (run.owner === "dispatcher") buckets.orphanClaims.push({ issue: run.issue, runId: run.run_id, owner: run.owner });
    else buckets.otherOwners.push(run.issue);
  }
  // Expired claims by the dispatcher with no dispatch record never reached a start.
  const expiredOrphans = leases.filter(
    (run) => run.owner === "dispatcher" && !TERMINAL.includes(run.state) && run.lease_expires_at <= now && !recorded.has(run.issue),
  );
  return { reliable, leases, buckets, expiredOrphans, errors: [lease.ok ? null : `lease store: ${lease.error}`, workersRead.ok ? null : `orca: ${workersRead.error}`].filter(Boolean) };
}

const PRIORITY = /priority:\s*P(\d)/i;
export function priorityOf(labels) {
  for (const label of labels) {
    const match = PRIORITY.exec(label);
    if (match) return Number(match[1]);
  }
  return 9;
}

export function blockersOf(body) {
  const numbers = new Set();
  for (const line of String(body ?? "").split("\n")) {
    if (!/\b(depends on|blocked by)\b/i.test(line)) continue;
    for (const match of line.matchAll(/#(\d+)/g)) numbers.add(Number(match[1]));
  }
  return [...numbers];
}

// Live GitHub read. Anything unreadable excludes the issue and says why.
export function selectCandidates({ exec, repoRoot, config, claimedIssues }) {
  const listed = execJson(exec, "gh", ["issue", "list", "--state", "open", "--label", config.readyLabel, "--limit", "100", "--json", "number,title,labels,body"], repoRoot);
  if (!listed.ok) return { ok: false, error: `gh issue list: ${listed.error}`, candidates: [], skipped: [] };
  const candidates = [];
  const skipped = [];
  for (const issue of listed.value) {
    const labels = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name));
    if (claimedIssues.has(issue.number)) {
      skipped.push({ issue: issue.number, reason: "already claimed or dispatched" });
      continue;
    }
    if (labels.some((label) => config.excludeLabels.includes(label))) {
      skipped.push({ issue: issue.number, reason: "excluded label" });
      continue;
    }
    const open = blockersOf(issue.body).filter((dep) => {
      const view = execJson(exec, "gh", ["issue", "view", String(dep), "--json", "state"], repoRoot);
      return !view.ok || view.value.state !== "CLOSED";
    });
    if (open.length) {
      skipped.push({ issue: issue.number, reason: `blocked by ${open.map((n) => `#${n}`).join(", ")}` });
      continue;
    }
    // A branch with any PR means the scope was already delivered or is in review.
    const prs = execJson(exec, "gh", ["pr", "list", "--head", `agent/issue-${issue.number}`, "--state", "all", "--json", "number"], repoRoot);
    if (!prs.ok || prs.value.length > 0) {
      skipped.push({ issue: issue.number, reason: prs.ok ? "delivery PR exists" : "delivery state unreadable" });
      continue;
    }
    candidates.push({ issue: issue.number, title: issue.title, priority: priorityOf(labels) });
  }
  // Priority orders the work; a P0 sorts first. Ties go to the older issue.
  candidates.sort((a, b) => a.priority - b.priority || a.issue - b.issue);
  return { ok: true, candidates, skipped };
}

function buildStatusView({ at, outcome, recon, dispatched, skipped, errors, config }) {
  return {
    at: new Date(at).toISOString(),
    outcome,
    enabled: config.enabled,
    autoResume: config.autoResume,
    active: recon?.buckets.active ?? [],
    review: recon?.buckets.review ?? [],
    recoverableFailures: recon?.buckets.ambiguous ?? [],
    orphanClaims: recon?.buckets.orphanClaims ?? [],
    dispatched,
    skipped,
    errors,
  };
}

/**
 * One wake. Returns the report it also writes to `.local/auto/dispatcher/status.json`.
 * @param {{ repoRoot: string, stateDir: string, exec?: Exec, now?: () => number, newRunId?: () => string }} options
 */
export function tick({ repoRoot, stateDir, exec = defaultExec, now = Date.now, newRunId = randomUUID }) {
  const at = now();
  const { config, problem } = loadConfig(stateDir);
  const finish = (outcome, extra = {}) => {
    const view = buildStatusView({ at, outcome, recon: extra.recon, dispatched: extra.dispatched ?? [], skipped: extra.skipped ?? [], errors: extra.errors ?? [], config });
    try {
      writeAtomic(statusFile(stateDir), `${JSON.stringify(view)}\n`);
    } catch {
      // The report is still returned; a read-only state dir must not hide it.
    }
    return { ok: !["TICK_LOCKED"].includes(outcome), ...view };
  };

  if (problem) return finish("CONFIG_INVALID", { errors: [problem] });
  if (!config.enabled) return finish("DISABLED");
  const lock = acquireLock(stateDir, at);
  if (!lock.ok) return finish("TICK_LOCKED");
  try {
    const recon = reconcile({ repoRoot, stateDir, exec, now: at });
    const errors = [...recon.errors];
    const auto = [...AUTO_COMMAND];

    // Renewing keeps a live worker's lease from expiring under it. An orphan claim
    // (no dispatch record) never reached a start, so an expired one is safe to free.
    let renewalFailed = false;
    for (const worker of recon.buckets.active) {
      const renewed = execJson(exec, auto[0], [...auto.slice(1), "renew", "--issue", String(worker.issue), "--owner", worker.owner, "--run", worker.runId, "--ttl-min", String(config.leaseTtlMin)], repoRoot);
      if (!renewed.ok) {
        renewalFailed = true;
        errors.push(`renew #${worker.issue}: ${renewed.error}`);
      }
    }
    for (const orphan of recon.expiredOrphans) {
      execJson(exec, auto[0], [...auto.slice(1), "release", "--issue", String(orphan.issue), "--owner", orphan.owner, "--run", orphan.run_id], repoRoot);
    }

    if (!recon.reliable || renewalFailed) return finish("RECONCILE_UNRELIABLE", { recon, errors });
    if (isPaused(stateDir)) return finish("PAUSED", { recon, errors });
    if (!insideWindow(at, config.window)) return finish("OUTSIDE_WINDOW", { recon, errors });
    const day = zonedParts(at, config.window.timeZone).day;
    if (readAttempts(stateDir, day) >= config.dailyStartBudget) return finish("BUDGET_EXHAUSTED", { recon, errors });
    // Ambiguous records and unexpired orphan claims occupy capacity: fail closed.
    const used = recon.buckets.active.length + recon.buckets.ambiguous.length + recon.buckets.orphanClaims.length;
    if (used >= config.maxWorkers) return finish("AT_CAPACITY", { recon, errors });

    const claimedIssues = new Set([
      ...readDispatchRecords(stateDir).map((r) => r.issue),
      ...recon.leases.filter((run) => !TERMINAL.includes(run.state) && run.lease_expires_at > at).map((run) => run.issue),
      ...recon.leases.filter((run) => run.state === "COMPLETE").map((run) => run.issue),
    ]);
    const selection = selectCandidates({ exec, repoRoot, config, claimedIssues });
    if (!selection.ok) return finish("GITHUB_UNAVAILABLE", { recon, errors: [...errors, selection.error] });

    const dispatched = [];
    const skipped = [...selection.skipped];
    let free = config.maxWorkers - used;
    for (const candidate of selection.candidates) {
      if (free <= 0) break;
      if (readAttempts(stateDir, day) >= config.dailyStartBudget) break;
      if (!lock.holds(now())) {
        errors.push("tick lock was replaced; stopping");
        break;
      }
      recordAttempt(stateDir, day);
      const runId = newRunId();
      const claim = execJson(exec, auto[0], [...auto.slice(1), "claim", "--issue", String(candidate.issue), "--owner", config.owner, "--run", runId, "--ttl-min", String(config.leaseTtlMin)], repoRoot);
      if (!claim.ok) {
        skipped.push({ issue: candidate.issue, reason: "claim refused" });
        continue;
      }
      const plan = buildDispatchPlan({ issue: candidate.issue, title: candidate.title, owner: config.owner, runId, repoRoot, stateDir, agent: config.agent, worktree: worktreeFor(repoRoot, candidate.issue, exec) });
      const readLeaseRuns = () => execJson(exec, auto[0], [...auto.slice(1), "status", "--issue", String(candidate.issue)], repoRoot).value?.runs ?? [];
      const receipt = dispatch(plan, { exec, cwd: plan.worktree, readLeaseRuns, now });
      if (receipt.ok) {
        dispatched.push({ issue: candidate.issue, runId });
        free -= 1;
        continue;
      }
      // Before the record exists nothing started: free the lease so the issue and
      // unrelated work stay eligible. With a record, the start is ambiguous and the
      // lease and record stay for the operator.
      if (!existsSync(plan.recordFile)) {
        execJson(exec, auto[0], [...auto.slice(1), "release", "--issue", String(candidate.issue), "--owner", config.owner, "--run", runId], repoRoot);
        const reason = receipt.code === "AUTHORITY_NOT_PERMITTED" ? `awaiting founder (${receipt.verdict ?? "unknown"})` : receipt.code;
        skipped.push({ issue: candidate.issue, reason });
        if (receipt.code === "ORCA_UNREACHABLE") break;
      } else {
        errors.push(`#${candidate.issue}: ${receipt.code}; record kept, reconcile by hand`);
        break;
      }
    }
    // Nothing is dispatched twice: the claim, the lease and the dispatch record each
    // refuse a second start before the worker is created.
    if (dispatched.length) return finish("DISPATCHED", { recon, dispatched, skipped, errors });

    // A dead worker whose issue has no pull request is resumed only when the
    // operator opted in. Every uncertainty (ambiguous record, unexpired lease,
    // unreadable state) skips the issue instead of starting an agent.
    if (config.autoResume) {
      const resumed = autoResume({ repoRoot, stateDir, exec, at, config, recon, free });
      errors.push(...resumed.errors);
      skipped.push(...resumed.skipped);
      if (resumed.dispatched.length) return finish("AUTO_RESUMED", { recon, dispatched: resumed.dispatched, skipped, errors });
    }
    return finish("IDLE", { recon, dispatched, skipped, errors });
  } finally {
    lock.release();
  }
}

/**
 * Resumes dead workers for issues the dispatcher itself dispatched and that have
 * no pull request yet. The run is adopted by the new fenced identity first (the
 * expired lease alone cannot authorize a second worker), then Orca retries the
 * same Task in the existing worktree. Retries are bounded and recorded on the
 * dispatch record, so a restart does not reset them.
 */
function autoResume({ repoRoot, stateDir, exec, at, config, recon, free }) {
  const auto = [...AUTO_COMMAND];
  const dispatched = [];
  const skipped = [];
  const errors = [];
  let capacity = free;
  for (const entry of recon.buckets.review) {
    if (capacity <= 0) break;
    const issue = entry.issue;
    if (entry.owner !== config.owner) continue;
    const recordFile = join(stateDir, "orca-dispatch", `issue-${issue}.json`);
    const read = readJson(recordFile);
    const record = read.ok ? read.value : null;
    if (typeof record?.autoResumeStopped === "string") {
      skipped.push({ issue, reason: `auto-resume stopped after ${record.autoResumeStopped}; a person decides` });
      continue;
    }
    const retries = Number(record?.resumeRetries ?? 0);
    if (!Number.isInteger(retries) || retries >= config.autoResumeMaxRetries) {
      skipped.push({ issue, reason: retries >= config.autoResumeMaxRetries ? `auto-resume retries exhausted (${retries})` : "dispatch record unreadable" });
      continue;
    }
    const dispatchId = record?.dispatchReceipt?.dispatchId;
    const taskId = record?.dispatchReceipt?.taskId;
    if (typeof dispatchId !== "string" || typeof taskId !== "string") {
      skipped.push({ issue, reason: "dispatch receipt has no Task to retry" });
      continue;
    }
    // Delivered or in review means the dead worker is not a lost cause.
    const prs = execJson(exec, "gh", ["pr", "list", "--head", `agent/issue-${issue}`, "--state", "all", "--json", "number"], repoRoot);
    if (!prs.ok) {
      skipped.push({ issue, reason: "delivery state unreadable" });
      continue;
    }
    if (prs.value.length > 0) {
      skipped.push({ issue, reason: "delivery PR exists" });
      continue;
    }
    // `--jq .title` prints the title as plain text, not JSON.
    const viewed = exec("gh", ["issue", "view", String(issue), "--json", "title", "--jq", ".title"], repoRoot);
    const title = (viewed.stdout ?? "").trim();
    if (viewed.status !== 0 || !title) {
      skipped.push({ issue, reason: "issue unreadable" });
      continue;
    }
    const runId = randomUUID();
    const adopt = execJson(exec, auto[0], [...auto.slice(1), "adopt", "--issue", String(issue), "--owner", config.owner, "--run", runId, "--from-run", entry.runId, "--ttl-min", String(config.leaseTtlMin)], repoRoot);
    if (!adopt.ok) {
      skipped.push({ issue, reason: `adopt refused: ${adopt.error}` });
      continue;
    }
    const plan = buildDispatchPlan({ issue, title, owner: config.owner, runId, repoRoot, stateDir, agent: config.agent, retryOf: { taskId, dispatchId } });
    const readLeaseRuns = () => execJson(exec, auto[0], [...auto.slice(1), "status", "--issue", String(issue)], repoRoot).value?.runs ?? [];
    const receipt = dispatch(plan, { exec, cwd: plan.worktree, readLeaseRuns, now: () => at, resumeFromRunId: entry.runId });
    // The attempt is counted whether or not it started, and a refused start is
    // permanent: Orca circuit-breaks a retry chain after three failed starts and
    // a person alone may reopen it, so the dispatcher must not keep trying.
    if (receipt.ok) {
      writeAtomic(recordFile, `${JSON.stringify({ ...record, runId, resumeRetries: retries + 1 })}\n`);
      dispatched.push({ issue, runId, resumedFrom: entry.runId, retryOf: dispatchId });
      capacity -= 1;
      continue;
    }
    errors.push(`auto-resume #${issue}: ${receipt.code}`);
    writeAtomic(recordFile, `${JSON.stringify({ ...record, resumeRetries: retries + 1, autoResumeStopped: receipt.code })}\n`);
    // Nothing started: put the run back so a person or the next tick sees it.
    execJson(exec, auto[0], [...auto.slice(1), "handover", "--issue", String(issue), "--owner", config.owner, "--run", runId], repoRoot);
    if (receipt.code === "ORCA_UNREACHABLE") break;
  }
  return { dispatched, skipped, errors };
}

export function readStatus(stateDir) {
  const read = readJson(statusFile(stateDir));
  const { config, problem } = loadConfig(stateDir);
  return { ok: true, enabled: config.enabled && !problem, paused: isPaused(stateDir), configProblem: problem, last: read.ok ? read.value : null };
}

export { leaseHeldBy };
