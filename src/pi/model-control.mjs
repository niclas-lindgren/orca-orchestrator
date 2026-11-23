// The missing Pi TUI control seam only. Native Orca remains the assignment authority.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, chmodSync, realpathSync } from "node:fs";
import { createServer, createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class ModelControlError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function requireControl(condition, code, message = code) {
  if (!condition) throw new ModelControlError(code, message);
}
export const modelKey = (model) => model ? `${model.provider}/${model.id}` : null;
export function parseModels(value) {
  const models = typeof value === "string" ? value.split(",").map((s) => s.trim()) : value;
  requireControl(Array.isArray(models) && models.length > 0 && models.length <= 16 &&
    models.every((s) => typeof s === "string" && /^[a-zA-Z0-9_.-]+\/[^\s,*?\[\]{}]+$/.test(s) && s.length <= 256) &&
    new Set(models).size === models.length, "POLICY_INVALID", "Use 1–16 unique exact provider/model IDs in preferred order.");
  return [...models];
}
export function providerFailure(message) {
  // Only finalized assistant provider errors enter here, never tool/test output.
  if (message?.role !== "assistant" || message.stopReason !== "error") return null;
  const text = String(message.errorMessage ?? "");
  if (/quota|\b(?:\d+-hour|usage|subscription sharing) limit\b|subscription sharing.*(?:exceed|limit)/i.test(text)) return "quota";
  if (/\b429\b|too many requests|rate[ -]?limit/i.test(text)) return "rate-limit";
  if (/\b50[234]\b|service unavailable|provider unavailable/i.test(text)) return "provider-unavailable";
  return null;
}

export function nativeReader(exec, env = process.env) {
  return async (args) => {
    requireControl(env.ORCA_CLI_COMMAND, "ORCA_UNAVAILABLE", "Use the Orca-provided ORCA_CLI_COMMAND; no guessed executable.");
    const response = await exec(env.ORCA_CLI_COMMAND, [...args, "--environment", "local", "--json"], { timeout: 10_000, maxBuffer: 512_000 });
    let envelope;
    try { envelope = JSON.parse(response.stdout); } catch { /* fail closed below */ }
    requireControl(response.code === 0 && envelope?.ok === true && !response.truncated,
      "ORCA_UNAVAILABLE", "Native Orca could not verify the assignment.");
    return envelope;
  };
}

export async function nativeTarget(read, dispatchId) {
  requireControl(typeof dispatchId === "string" && /^ctx_[\w-]+$/.test(dispatchId), "INVALID_DISPATCH");
  const envelope = await read(["orchestration", "worker-show", "--dispatch", dispatchId, "--full"]);
  const { dispatch: d, worker: w, projection: p, terminal: t, observation: o, terminalResource: resource } = envelope.result ?? {};
  requireControl(d?.id === dispatchId && d.status === "dispatched" && d.capabilityRevokedAt === null &&
    w?.state === "ready" && o?.exactWorker === true && o.status === "live" && p?.liveness?.verdict === "live" &&
    resource?.ownerDispatchId === dispatchId && resource.ownershipState === "owned" && resource.releaseState === "not_requested",
    "DISPATCH_UNAVAILABLE", "Orca must prove an active, exact, owned live dispatch.");
  requireControl(d.hostScope?.kind === "local" && d.hostScope.hostId === "local" && t?.executionHostId === "local" &&
    p.host?.id === "local", "HOST_UNSUPPORTED", "This Pi control seam supports local workers only.");
  requireControl(w.startOptions?.agent === "pi" && p.provider?.id === "pi" && t.agentIdentity === "pi", "NOT_PI");
  requireControl(t.connected === true && t.orphaned === false && t.writable === true &&
    d.assigneeHandle === t.handle && w.agentTerminalHandle === t.handle &&
    d.assigneePaneKey === `${t.tabId}:${t.leafId}` && d.processIncarnation === `${t.ptyId}:${t.incarnationId}` &&
    w.runtimeEpoch === envelope._meta?.runtimeId && resource.endpointId === w.runtimeEpoch &&
    resource.endpointIncarnation === d.processIncarnation && resource.terminalHandle === t.handle &&
    w.worktreeId === t.worktreeId && resource.worktreeId === t.worktreeId && p.taskId === d.taskId && p.runId === d.runId,
    "IDENTITY_MISMATCH");
  const runEnvelope = await read(["orchestration", "run-show", "--id", d.runId, "--full"]);
  const run = runEnvelope.result?.run;
  requireControl(run?.id === d.runId && typeof run.coordinator_handle === "string" &&
    Number.isInteger(run.consumer_generation) && run.consumer_generation > 0 &&
    runEnvelope._meta?.runtimeId === w.runtimeEpoch, "IDENTITY_MISMATCH");
  const identity = {
    dispatchId, taskId: d.taskId, runId: d.runId, generation: run.consumer_generation,
    coordinatorHandle: run.coordinator_handle, terminalHandle: t.handle, paneKey: d.assigneePaneKey,
    incarnation: d.processIncarnation, runtimeEpoch: w.runtimeEpoch, worktreeId: t.worktreeId, cwd: t.worktreePath,
  };
  requireControl(Object.values(identity).every((v) => typeof v === "number" || typeof v === "string" && v.length > 0), "IDENTITY_MISMATCH");
  return identity;
}
export async function coordinatorTarget(read, dispatchId, env = process.env) {
  const current = await read(["orchestration", "run-current"]);
  const identity = await nativeTarget(read, dispatchId);
  requireControl(current.result?.runId === identity.runId, "WRONG_RUN", "Use native run-use for the intended Run first.");
  const caller = await read(["terminal", "show", "--terminal", identity.coordinatorHandle]);
  const t = caller.result?.terminal;
  requireControl(env.ORCA_PANE_KEY && `${t?.tabId}:${t?.leafId}` === env.ORCA_PANE_KEY && t.connected === true &&
    caller._meta?.runtimeId === identity.runtimeEpoch, "NOT_COORDINATOR");
  return identity;
}
export function sameIdentity(a, b) {
  return a && b && Object.keys(b).length === Object.keys(a).length && Object.keys(a).every((key) => a[key] === b[key]);
}
export function receiverIdentity(identity, env, ctx) {
  requireControl(identity.paneKey === env.ORCA_PANE_KEY && identity.worktreeId === env.ORCA_WORKTREE_ID &&
    realpathSync(identity.cwd) === realpathSync(ctx.cwd), "WRONG_RECEIVER");
}

// OS user custody, like the local Orca CLI. This does not isolate mutually untrusted
// processes running as the same user. No network listener, credential reads or registry.
export function endpointPath(paneKey, root = join(tmpdir(), `orca-pi-model-${process.getuid?.()}`)) {
  requireControl(process.platform !== "win32" && typeof process.getuid === "function", "HOST_UNSUPPORTED");
  requireControl(typeof paneKey === "string" && paneKey.length > 0, "WRONG_RECEIVER");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = lstatSync(root);
  requireControl(directory.isDirectory() && !directory.isSymbolicLink() && directory.uid === process.getuid() &&
    (directory.mode & 0o777) === 0o700, "UNSAFE_ENDPOINT");
  const path = join(root, `${createHash("sha256").update(paneKey).digest("hex").slice(0, 24)}.sock`);
  requireControl(Buffer.byteLength(path) < 100, "UNSAFE_ENDPOINT", "Runtime socket path is too long.");
  return path;
}
function checkSocket(path) {
  const stat = lstatSync(path);
  requireControl(stat.isSocket() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600, "UNSAFE_ENDPOINT");
}
const MAX_FRAME = 16_384;
export async function serveControl(path, handle) {
  const clients = new Set();
  const server = createServer((socket) => {
    if (clients.size >= 8) { socket.destroy(); return; }
    clients.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => clients.delete(socket));
    socket.setTimeout(15_000, () => socket.destroy());
    let frame = "", received = false;
    socket.setEncoding("utf8");
    socket.on("data", async (chunk) => {
      if (received) return;
      frame += chunk;
      if (Buffer.byteLength(frame) > MAX_FRAME) { received = true; socket.destroy(); return; }
      if (!frame.includes("\n")) return;
      received = true;
      let result;
      try {
        const request = JSON.parse(frame.trim());
        result = await handle(request);
      } catch (error) {
        result = { ok: false, code: error instanceof ModelControlError ? error.code : "CONTROL_FAILED" };
      }
      socket.end(`${JSON.stringify(result)}\n`);
    });
  });
  // Never unlink an existing endpoint: occupied/stale paths require explicit reconciliation.
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => { server.off("error", reject); resolve(); });
  });
  try { chmodSync(path, 0o600); checkSocket(path); }
  catch (error) { server.close(); throw error; }
  server.on("error", () => {});
  return () => new Promise((resolve) => {
    for (const socket of clients) socket.destroy();
    server.close(() => resolve());
  });
}
export async function callControl(path, request, { signal } = {}) {
  requireControl(!signal?.aborted, "CONTROL_CANCELLED");
  checkSocket(path);
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let frame = "", done = false;
    const fail = () => {
      if (done) return;
      done = true; socket.destroy(); signal?.removeEventListener("abort", fail);
      reject(new ModelControlError("OUTCOME_UNKNOWN", "No acknowledged outcome. Query result/state; never blindly repeat a switch."));
    };
    socket.on("error", fail);
    signal?.addEventListener("abort", fail, { once: true });
    if (signal?.aborted) { fail(); return; }
    socket.setTimeout(15_000, fail);
    socket.on("end", () => { if (!done) fail(); });
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      frame += chunk;
      if (Buffer.byteLength(frame) > MAX_FRAME) { fail(); return; }
      if (!frame.includes("\n")) return;
      try {
        const result = JSON.parse(frame.trim());
        done = true; socket.destroy(); signal?.removeEventListener("abort", fail); resolve(result);
      } catch { fail(); }
    });
  });
}

const RECEIPT = "orca-model-switch";
export function createReceiver({ pi, ctx, read, env, alive = () => true }) {
  const failureFor = (message) => {
    const reason = providerFailure(message);
    return reason && message.provider && message.model ? { reason, model: `${message.provider}/${message.model}` } : null;
  };
  let busy = false, failure = failureFor(ctx.sessionManager.getBranch().filter((e) => e.type === "message" && e.message?.role === "assistant").at(-1)?.message), release;
  let switching = Promise.resolve();
  const lastFailure = () => failure?.model === modelKey(ctx.model) ? failure.reason : null;
  const state = () => ({ sessionId: ctx.sessionManager.getSessionId(), model: modelKey(ctx.model),
    thinkingLevel: pi.getThinkingLevel(), idle: ctx.isIdle() && !ctx.hasPendingMessages(), lastFailure: lastFailure() });
  const receipts = () => ctx.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === RECEIPT);
  const requireSession = (request) => requireControl(alive() && request.sessionId === state().sessionId, "SESSION_CHANGED");
  async function validate(request) {
    requireControl(request && ["status", "switch", "result"].includes(request.action), "INVALID_REQUEST");
    requireControl(request.identity && typeof request.identity === "object", "IDENTITY_MISMATCH");
    receiverIdentity(request.identity, env, ctx);
    const current = await nativeTarget(read, request.identity.dispatchId);
    requireControl(alive() && sameIdentity(request.identity, current), "IDENTITY_MISMATCH");
  }
  async function handle(request) {
    await validate(request);
    const identity = request.identity;
    if (request.action === "status") return { ok: true, identity, ...state() };
    requireSession(request);
    requireControl(typeof request.requestId === "string" && /^[\w-]{8,128}$/.test(request.requestId), "INVALID_REQUEST_ID");
    const prior = receipts().filter((e) => e.data?.requestId === request.requestId).at(-1)?.data;
    if (request.action === "result") return { ok: true, identity, ...state(), receipt: prior ?? { outcome: "unknown", requestId: request.requestId } };
    const fingerprint = createHash("sha256").update(JSON.stringify({ identity, sessionId: request.sessionId,
      expectedModel: request.expectedModel, target: request.target, reason: request.reason, policy: request.policy })).digest("hex");
    if (prior) {
      requireControl(prior.fingerprint === fingerprint, "REQUEST_ID_REUSED");
      return { ok: prior.outcome === "selected", identity, ...state(), receipt: prior };
    }
    requireControl(!busy && state().idle, "WORKER_BUSY", "Wait for Pi to settle; this endpoint never aborts/replays work.");
    requireControl(request.expectedModel === state().model, "MODEL_CHANGED");
    const policy = parseModels(request.policy);
    const index = policy.indexOf(state().model);
    requireControl(lastFailure() && request.reason === lastFailure(), "INELIGIBLE_FAILURE", "Only a finalized quota/rate-limit/provider-unavailable error permits fallback.");
    requireControl(index >= 0 && index + 1 < policy.length, "POLICY_EXHAUSTED", "Ask the user to revise the policy; no wrapping or harness fallback.");
    requireControl(request.target === policy[index + 1], "POLICY_TARGET", "Only the next user-approved model is eligible.");
    const slash = request.target.indexOf("/");
    const model = ctx.modelRegistry.find(request.target.slice(0, slash), request.target.slice(slash + 1));
    requireControl(model && modelKey(model) === request.target, "MODEL_NOT_FOUND");
    busy = true;
    switching = new Promise((resolve) => { release = resolve; });
    const before = state();
    const receipt = { requestId: request.requestId, fingerprint, identity, sessionId: before.sessionId,
      oldModel: before.model, target: request.target, reason: request.reason, outcome: "pending" };
    let attempted = false;
    try {
      // Persist intent before the possibly asynchronous setter. Reload/crash => pending/unknown,
      // not permission to replay. Pi owns the actual model-change history.
      pi.appendEntry(RECEIPT, { ...receipt });
      requireSession(request);
      requireControl(state().idle && state().model === request.expectedModel, "WORKER_BUSY");
      attempted = true;
      const success = await pi.setModel(model);
      requireSession(request);
      if (!success) {
        receipt.outcome = state().model === before.model ? "rejected" : "unknown";
        receipt.code = "AUTH_UNAVAILABLE";
      } else {
        const current = await nativeTarget(read, identity.dispatchId);
        requireControl(sameIdentity(identity, current), "IDENTITY_MISMATCH");
        requireSession(request);
        requireControl(state().model === request.target, "MODEL_CHANGED");
        receipt.outcome = "selected";
        failure = null;
      }
    } catch (error) {
      receipt.outcome = attempted ? "unknown" : "rejected";
      receipt.code = error instanceof ModelControlError ? error.code : "SETTER_FAILED";
    } finally {
      try {
        if (alive()) {
          receipt.model = state().model;
          receipt.thinkingLevel = pi.getThinkingLevel();
          try { pi.appendEntry(RECEIPT, { ...receipt }); }
          catch { receipt.outcome = "unknown"; receipt.code = "RECEIPT_UNAVAILABLE"; }
        }
      } finally { busy = false; release(); }
    }
    return { ok: receipt.outcome === "selected", identity, ...state(), receipt };
  }
  return { handle, wait: () => switching, isSwitching: () => busy,
    observe(message) { failure = failureFor(message); }, state };
}
