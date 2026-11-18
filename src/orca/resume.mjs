// Read-only resume/handover report for one issue. It joins what the lease store,
// Git, GitHub and native Orca each know, and says which of the resume scenarios
// applies. It starts nothing and changes nothing: the coordinating session acts on
// the recommendation with the commands in `next`.
import { spawnSync } from "node:child_process";
import { peekConfig } from "../config.mjs";
import { getRun, isPaused, ledgerFor, reviewChatsFor, transfersFor } from "../auto/state.mjs";
import { branchFor, resolveIssueWorktree } from "../auto/worktrees.mjs";
import { classifyWorker, workerIsIn } from "./workers.mjs";

/** @type {(command: string, args: string[], cwd: string) => { status: number | null, stdout: string, stderr: string }} */
const defaultExec = (command, args, cwd) => spawnSync(command, args, { cwd, encoding: "utf8" });

const MAX_LIST = 10;

/**
 * Lines a resumed worker's spec carries so it continues the existing work rather
 * than restarting it. `context` is `report.resumeContext`.
 */
export function resumePreface(context) {
  const lines = ["Resume: this worktree already holds work from an earlier worker or session. Continue from it; do not restart, reset or discard it. Run `git log --oneline` and `git status --short` first."];
  if (context.commitsAheadOfBase?.length) lines.push(`Already committed on the branch (newest first): ${context.commitsAheadOfBase.join("; ")}.`);
  if (context.dirtyPaths?.length) lines.push(`Uncommitted changes present at hand-over: ${context.dirtyPaths.join(", ")}. Review them, then finish or commit them deliberately.`);
  if (context.pr) lines.push(`Pull request #${context.pr.number} (${context.pr.state}) already exists for this branch; pushes update it, do not open another.`);
  if (context.openFindings?.length) lines.push(`Review findings already attempted by an earlier worker (key: attempts): ${context.openFindings.join(", ")}. Do not repeat a fix that did not hold.`);
  return lines;
}

function json(exec, command, args, cwd) {
  const r = exec(command, args, cwd);
  if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || "").trim().slice(0, 300) };
  try {
    return { ok: true, value: JSON.parse(r.stdout) };
  } catch {
    return { ok: false, error: "non-JSON output" };
  }
}

function inspectBranch(exec, path, branch, base) {
  const git = (args) => {
    const r = exec("git", args, path);
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const head = git(["rev-parse", "HEAD"]);
  const status = git(["status", "--porcelain", "--untracked-files=all"]);
  const log = git(["log", "--format=%h %s", `${base}..HEAD`]);
  const upstream = git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
  const unpushed = upstream === null ? null : git(["rev-list", "--count", `origin/${branch}..HEAD`]);
  return {
    head,
    readable: head !== null && status !== null,
    dirtyPaths: status ? status.split("\n").map((l) => l.slice(3)).slice(0, MAX_LIST) : [],
    commitsAheadOfBase: log ? log.split("\n").slice(0, MAX_LIST) : [],
    pushed: upstream !== null,
    unpushedCommits: unpushed === null ? null : Number(unpushed),
  };
}

/**
 * @param {{ repoRoot: string, issue: number, db: import("node:sqlite").DatabaseSync, stateDir: string, exec?: typeof defaultExec, now?: number }} options
 */
export function resumeReport({ repoRoot, issue, db, stateDir, exec = defaultExec, now = Date.now() }) {
  const branch = branchFor(issue);
  const errors = [];
  const base = peekConfig()?.defaultBranch ?? "main";
  const run = getRun(db, issue);
  const leaseLive = Boolean(run && run.owner !== null && run.lease_expires_at !== null && run.lease_expires_at > now);
  const binding = run?.native_dispatch_id
    ? { runId: run.native_run_id, taskId: run.native_task_id, dispatchId: run.native_dispatch_id, worktree: run.native_worktree, provisional: run.native_dispatch_id.startsWith("pending:") }
    : null;

  const found = resolveIssueWorktree(repoRoot, issue, exec);
  if (!found.ok && found.code === "WORKTREE_DISCOVERY_FAILED") errors.push(`worktree discovery: ${found.error}`);
  const worktree = found.ok ? { path: found.path, id: null, ...inspectBranch(exec, found.path, branch, base) } : null;
  if (worktree && !worktree.readable) errors.push(`worktree ${worktree.path} is not readable by git`);
  if (worktree) {
    const shown = json(exec, "orca", ["worktree", "show", "--worktree", `path:${worktree.path}`, "--json"], repoRoot);
    const id = shown.ok ? shown.value?.result?.worktree?.id : null;
    worktree.id = typeof id === "string" ? id : null;
  }
  const branchExists = exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot).status === 0;

  const prList = json(exec, "gh", ["pr", "list", "--head", branch, "--state", "all", "--json", "number,state,headRefOid,isDraft"], repoRoot);
  if (!prList.ok) errors.push(`gh pr list: ${prList.error}`);
  const prs = prList.ok ? prList.value : [];

  const listed = json(exec, "orca", ["orchestration", "worker-list", "--include-remote", "--json"], repoRoot);
  if (!listed.ok) errors.push(`orca worker-list: ${listed.error}`);
  const all = listed.ok ? (listed.value.result?.workers ?? listed.value.workers ?? []) : [];
  const workers = all
    .filter((w) => (worktree && workerIsIn(w, worktree.path)) || (binding && w.dispatchId === binding.dispatchId))
    .map((w) => ({ dispatchId: w.dispatchId, taskId: w.taskId ?? null, state: w.state ?? null, liveness: w.liveness ?? null, class: classifyWorker(w), terminalState: w.terminalState ?? null, agent: w.agent ?? null }));
  const bound = binding ? workers.find((w) => w.dispatchId === binding.dispatchId) ?? null : null;

  const ledger = ledgerFor(db, { issue });
  const attempts = {};
  for (const r of ledger) attempts[r.key] = (attempts[r.key] ?? 0) + 1;
  const openFindings = Object.entries(attempts).map(([k, n]) => `${k}: ${n}`).slice(0, MAX_LIST);
  const activePr = prs.find((p) => String(p.state).toUpperCase() === "OPEN") ?? prs[0] ?? null;
  const resumeContext = {
    commitsAheadOfBase: worktree?.commitsAheadOfBase ?? [],
    dirtyPaths: worktree?.dirtyPaths ?? [],
    pr: activePr ? { number: activePr.number, state: String(activePr.state).toLowerCase() } : null,
    openFindings,
  };

  const recommendation = recommend({ run, leaseLive, binding, bound, worktree, branchExists, prs, workers, errors, paused: isPaused(stateDir) });
  return {
    ok: true,
    issue,
    branch,
    recommendation: recommendation.code,
    reason: recommendation.reason,
    next: recommendation.next(worktree, binding),
    lease: run ? { state: run.state, owner: run.owner, runId: run.run_id, live: leaseLive, expiresAt: run.lease_expires_at, expiredFromState: run.expired_from_state, stopReason: run.stop_reason, attempts: run.attempts } : null,
    binding,
    worktree,
    branchExists,
    prs,
    workers,
    transfers: run ? transfersFor(db, issue).map(({ kind, from_owner, from_run_id, to_owner, to_run_id, from_state, to_state, recorded_at }) => ({ kind, from_owner, from_run_id, to_owner, to_run_id, from_state, to_state, recorded_at })) : [],
    // Chats opened by earlier runs. Delete each only with the guarded review-delete and its first message; then `auto review-forget`.
    reviewChats: reviewChatsFor(db, issue),
    resumeContext,
    specPreface: resumePreface(resumeContext),
    errors,
  };
}

const NATIVE = "ORCA orchestration";

// The first matching rule wins; every uncertainty stops before any worker starts.
function recommend({ run, leaseLive, binding, bound, worktree, branchExists, prs, workers, errors, paused }) {
  const none = () => [];
  const merged = prs.some((p) => String(p.state).toUpperCase() === "MERGED");
  if (errors.length) return { code: "UNRELIABLE", reason: "a source could not be read; resolve it and run the report again before acting", next: none };
  if (paused) return { code: "PAUSED", reason: "operator pause is set; claim and adopt refuse", next: none };
  if (run && ["COMPLETE", "PARKED", "NEEDS_DECISION"].includes(run.state)) return { code: "RUN_TERMINAL", reason: `run is ${run.state}${run.stop_reason ? ` (${run.stop_reason})` : ""}; a person must decide`, next: none };
  if (merged) return { code: "CLEANUP", reason: "a pull request for this branch is merged", next: () => ["GUARD orca cleanup --issue <n>"] };
  if (leaseLive) return { code: "LEASE_LIVE", reason: `lease is held by ${run.owner} until expiry; wait, or ask the holder to run \`auto handover\``, next: none };
  const adopt = run ? [`GUARD auto adopt --issue <n> --owner NEW_OWNER --run NEW_RUN --from-run ${run.run_id} --ttl-min 30`] : ["GUARD auto claim --issue <n> --owner OWNER --run RUN_ID --ttl-min 30"];
  const live = workers.filter((w) => w.class === "live");
  const unverifiable = workers.filter((w) => w.class === "unverifiable");
  if (live.length) {
    return { code: "ATTACH_LIVE_WORKER", reason: "a worker is still running in this worktree; do not start another", next: () => [...adopt, `${NATIVE} worker-show --dispatch ${live[0].dispatchId} --json`, `${NATIVE} send --to dispatch:${live[0].dispatchId} --subject resume --body "<new coordinator, current state>"`] };
  }
  if (unverifiable.length) {
    return { code: "WORKER_UNVERIFIABLE", reason: "Orca cannot prove the worker exited; do not start, stop or abandon on silence", next: () => unverifiable.map((w) => `${NATIVE} worker-show --dispatch ${w.dispatchId} --json`) };
  }
  if (worktree) {
    const sel = worktree.id ? `id:${worktree.id}` : `path:${worktree.path}`;
    if (binding && bound?.class === "dead") {
      return {
        code: "RESTART_WORKER_ON_SAME_TASK",
        reason: "the bound worker provably exited; retry on the same Task in the existing worktree",
        next: () => [...adopt, `GUARD auto unbind-native --issue <n> --owner NEW_OWNER --run NEW_RUN --dispatch ${binding.dispatchId}`, `GUARD auto bind-native ... --task ${binding.taskId} --dispatch pending:<REQ> --worktree ${sel}`, `${NATIVE} worker-start --task ${binding.taskId} --retry-of ${binding.dispatchId} --worktree ${sel} --agent <agent> --retry-request <REQ>  # spec preface: specPreface`],
      };
    }
    if (binding) {
      return { code: "BINDING_UNRESOLVED", reason: "a native binding exists but Orca lists no worker for it; inspect before unbinding", next: () => [`${NATIVE} worker-show --dispatch ${binding.dispatchId} --json`] };
    }
    return {
      code: "LAUNCH_WORKER_IN_EXISTING_WORKTREE",
      reason: "the worktree exists with no worker; launch an agent in it rather than editing from the coordinator",
      next: () => [...adopt, `${NATIVE} worker-start --spec "<buildTaskSpec + specPreface>" --worktree ${sel} --agent <agent>`],
    };
  }
  if (branchExists) return { code: "RECREATE_WORKTREE_FOR_BRANCH", reason: "the branch exists but no worktree is registered for it; native behaviour of `worktree create` on an existing branch is unverified, inspect the receipt", next: () => [...adopt, `ORCA worktree create --branch <branch> --issue <n> --parent-worktree current --json`] };
  return { code: "START_FRESH", reason: "no worktree, branch, worker or PR for this issue", next: () => adopt };
}
