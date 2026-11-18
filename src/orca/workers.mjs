// Reading Orca `worker-list` rows. Verified against Orca 1.4.x: a row carries
// `state` (ready|stopped|failed|succeeded), `liveness` (live|exited|unverifiable),
// `workspace` ("<repoId>::<absolute path>"), `dispatchId`, `taskId`, `terminalState`
// and optionally `next`. Older shapes (`workerState`, `resource.worktreeId`) are
// still read so recorded fixtures keep working.
const SETTLED_STATES = ["stopped", "failed", "succeeded", "done", "released", "abandoned"];

export const workspaceOf = (worker) => worker?.workspace ?? worker?.resource?.worktreeId ?? worker?.worktreeId ?? null;

/** True when the worker's workspace is exactly this worktree path. */
export function workerIsIn(worker, worktreePath) {
  const id = workspaceOf(worker);
  return typeof id === "string" && (id === worktreePath || id.endsWith(`::${worktreePath}`));
}

/**
 * "live": Orca says the agent runs. "dead": Orca proves it exited. "unverifiable":
 * Orca cannot prove either way; this is never treated as dead, because silence
 * and unverifiable liveness do not prove exit (Orca's own safety rule).
 */
export function classifyWorker(worker) {
  // `liveness` is Orca's process accounting and the only field that proves exit.
  const liveness = String(worker?.liveness ?? "").toLowerCase();
  if (liveness === "live") return "live";
  if (liveness === "exited") return "dead";
  if (liveness === "unverifiable") return "unverifiable";
  // Legacy hosts (before `liveness`) reported Task state only. Task status is not
  // process accounting, so this fallback is a guess and never overrides liveness.
  const state = String(worker?.workerState ?? worker?.state ?? "").toLowerCase();
  return SETTLED_STATES.includes(state) ? "dead" : "live";
}

/**
 * Orca's own next step for this worker (`worker-list`/`worker-show` `next`), if it
 * gave one. Callers print it verbatim instead of inventing recovery commands.
 */
export const nativeNext = (worker) => (typeof worker?.next === "string" && worker.next.trim() ? worker.next.trim() : null);

/** "none" | "live" | "unverifiable" | "dead" for every worker in one worktree. */
export function worktreeWorkerStatus(workers, worktreePath) {
  const here = workers.filter((worker) => workerIsIn(worker, worktreePath));
  if (here.length === 0) return "none";
  const classes = here.map(classifyWorker);
  if (classes.includes("live")) return "live";
  if (classes.includes("unverifiable")) return "unverifiable";
  return "dead";
}
