import { chmodSync, lstatSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callControl, coordinatorTarget, createReceiver, endpointPath, nativeReader, nativeTarget, parseModels, providerFailure, serveControl } from "../src/pi/model-control.mjs";
import { modelPolicy, registerModelControl } from "../extensions/model-control.ts";

const roots: string[] = [];
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function root() { const path = mkdtempSync(join(tmpdir(), "pmc-")); roots.push(path); return path; }
function fixture() {
  const cwd = root();
  const t = { handle: "term_worker", tabId: "tab", leafId: "worker", ptyId: "pty", incarnationId: "instance",
    connected: true, writable: true, orphaned: false, executionHostId: "local", agentIdentity: "pi", worktreeId: "repo::" + cwd, worktreePath: cwd };
  const record: any = { ok: true, _meta: { runtimeId: "runtime" }, result: {
    dispatch: { id: "ctx_worker", runId: "run_a", taskId: "task_a", status: "dispatched", capabilityRevokedAt: null,
      assigneeHandle: t.handle, assigneePaneKey: "tab:worker", processIncarnation: "pty:instance", hostScope: { kind: "local", hostId: "local" } },
    worker: { state: "ready", startOptions: { agent: "pi" }, agentTerminalHandle: t.handle, runtimeEpoch: "runtime", worktreeId: t.worktreeId },
    projection: { provider: { id: "pi" }, host: { id: "local" }, taskId: "task_a", runId: "run_a", liveness: { verdict: "live" } },
    terminal: t, observation: { exactWorker: true, status: "live" },
    terminalResource: { ownerDispatchId: "ctx_worker", ownershipState: "owned", releaseState: "not_requested",
      endpointId: "runtime", endpointIncarnation: "pty:instance", terminalHandle: t.handle, worktreeId: t.worktreeId },
  } };
  const run: any = { ok: true, _meta: { runtimeId: "runtime" }, result: { run: { id: "run_a", coordinator_handle: "term_coordinator", consumer_generation: 1 } } };
  const caller: any = { ok: true, _meta: { runtimeId: "runtime" }, result: { terminal: { tabId: "tab", leafId: "coordinator", connected: true } } };
  const read = vi.fn(async (args: string[]) => {
    if (args[1] === "worker-show") return record;
    if (args[1] === "run-show") return run;
    if (args[1] === "run-current") return { ok: true, result: { runId: "run_a" } };
    if (args[0] === "terminal") return caller;
    throw new Error("Unexpected native mutation: " + args.join(" "));
  });
  return { cwd, record, run, caller, read, env: { ORCA_PANE_KEY: "tab:worker", ORCA_WORKTREE_ID: t.worktreeId } };
}
async function receiverFixture() {
  const f = fixture();
  const entries: any[] = [];
  let idle = true, pending = false, sessionId = "pi-session", alive = true;
  const ctx: any = { cwd: f.cwd, model: { provider: "p", id: "first" }, isIdle: () => idle, hasPendingMessages: () => pending,
    modelRegistry: { find: vi.fn((provider, id) => id === "missing" ? undefined : ({ provider, id })) },
    sessionManager: { getSessionId: () => sessionId, getEntries: () => entries, getBranch: () => entries } };
  const pi: any = { getThinkingLevel: () => "medium", appendEntry: vi.fn((customType, data) => entries.push({ type: "custom", customType, data: structuredClone(data) })),
    setModel: vi.fn(async (model) => { ctx.model = model; return true; }) };
  const receiver = createReceiver({ pi, ctx, read: f.read, env: f.env, alive: () => alive });
  const identity = await nativeTarget(f.read, "ctx_worker");
  const request: any = { action: "switch", identity, sessionId, requestId: "request-123", expectedModel: "p/first", target: "q/second", reason: "rate-limit", policy: ["p/first", "q/second", "r/third"] };
  receiver.observe({ role: "assistant", provider: "p", model: "first", stopReason: "error", errorMessage: "429 Too Many Requests" });
  return { ...f, ctx, pi, receiver, identity, request, entries,
    idle: (value: boolean) => { idle = value; }, pending: (value: boolean) => { pending = value; },
    replace: () => { sessionId = "replacement"; }, shutdown: () => { alive = false; } };
}

describe("native Orca authority (read, never reimplement lifecycle)", () => {
  it("uses the exact native assignment and bound coordinator", async () => {
    const f = fixture();
    const identity = await coordinatorTarget(f.read, "ctx_worker", { ORCA_PANE_KEY: "tab:coordinator" });
    expect(identity).toMatchObject({ dispatchId: "ctx_worker", taskId: "task_a", runId: "run_a", generation: 1, incarnation: "pty:instance" });
    expect(f.read.mock.calls.every(([args]) => ["worker-show", "run-show", "run-current", "show"].includes(args[1]))).toBe(true);
    await expect(coordinatorTarget(f.read, "ctx_worker", { ORCA_PANE_KEY: "wrong" })).rejects.toMatchObject({ code: "NOT_COORDINATOR" });
  });
  it.each([
    ["revoked", (f: any) => { f.record.result.dispatch.capabilityRevokedAt = "now"; }],
    ["settled", (f: any) => { f.record.result.dispatch.status = "completed"; }],
    ["unverifiable", (f: any) => { f.record.result.projection.liveness.verdict = "unverifiable"; }],
    ["released", (f: any) => { f.record.result.terminalResource.releaseState = "released"; }],
    ["reassigned", (f: any) => { f.record.result.terminalResource.ownerDispatchId = "ctx_new"; }],
    ["wrong host", (f: any) => { f.record.result.terminal.executionHostId = "remote"; }],
    ["wrong process", (f: any) => { f.record.result.terminal.incarnationId = "replacement"; }],
    ["runtime restarted", (f: any) => { f.record._meta.runtimeId = "new-runtime"; }],
    ["non-Pi", (f: any) => { f.record.result.worker.startOptions.agent = "claude"; }],
    ["run moved", (f: any) => { f.run._meta.runtimeId = "new-runtime"; }],
  ])("rejects %s native evidence", async (_name, change) => {
    const f = fixture(); change(f);
    await expect(nativeTarget(f.read, "ctx_worker")).rejects.toThrow();
  });
  it("does not guess an executable or swallow native failure", async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: '{"ok":false}' }));
    await expect(nativeReader(exec, {})(["status"])).rejects.toMatchObject({ code: "ORCA_UNAVAILABLE" });
    expect(exec).not.toHaveBeenCalled();
    await expect(nativeReader(exec, { ORCA_CLI_COMMAND: "/native/orca" })(["status"])).rejects.toThrow();
    expect(exec.mock.calls[0].slice(0, 2)).toEqual(["/native/orca", ["status", "--environment", "local", "--json"]]);
  });
});

describe("settled Pi model selection", () => {
  it("changes only the selected model, acknowledges readback and preserves session/task/worktree/history", async () => {
    const f = await receiverFixture();
    f.entries.push({ type: "message", message: { role: "user", content: "existing history" } });
    const result = await f.receiver.handle(f.request);
    expect(result).toMatchObject({ ok: true, sessionId: "pi-session", model: "q/second", identity: f.identity,
      receipt: { requestId: "request-123", outcome: "selected", oldModel: "p/first", target: "q/second", thinkingLevel: "medium" } });
    expect(f.ctx.cwd).toBe(f.cwd);
    expect(f.entries[0].message.content).toBe("existing history");
    expect(f.entries.filter((e) => e.customType === "orca-model-switch").map((e) => e.data.outcome)).toEqual(["pending", "selected"]);
    expect(f.pi.setModel).toHaveBeenCalledExactlyOnceWith({ provider: "q", id: "second" });
    expect(f.pi.setModel.mock.calls[0]).toHaveLength(1); // no persist/default options
  });
  it.each(["active request", "queued message"])("rejects %s without aborting or setting", async (kind) => {
    const f = await receiverFixture();
    if (kind === "active request") f.idle(false); else f.pending(true);
    await expect(f.receiver.handle(f.request)).rejects.toMatchObject({ code: "WORKER_BUSY" });
    expect(f.pi.setModel).not.toHaveBeenCalled();
  });
  it.each([
    ["session", "SESSION_CHANGED", (f: any) => f.replace()],
    ["model", "MODEL_CHANGED", (f: any) => { f.ctx.model.id = "changed"; }],
    ["dispatch", "IDENTITY_MISMATCH", (f: any) => { f.request.identity = { ...f.identity, taskId: "other" }; }],
    ["pane", "WRONG_RECEIVER", (f: any) => { f.env.ORCA_PANE_KEY = "other"; }],
    ["worktree", "WRONG_RECEIVER", (f: any) => { f.env.ORCA_WORKTREE_ID = "other"; }],
    ["coordinator generation", "IDENTITY_MISMATCH", (f: any) => { f.run.result.run.consumer_generation++; }],
  ])("rejects changed %s", async (_name, code, change) => {
    const f = await receiverFixture(); change(f);
    await expect(f.receiver.handle(f.request)).rejects.toMatchObject({ code });
    expect(f.pi.setModel).not.toHaveBeenCalled();
  });
  it("rejects unknown models and unauthenticated targets without claiming inference", async () => {
    const f = await receiverFixture();
    f.request.target = "q/missing"; f.request.policy[1] = "q/missing";
    await expect(f.receiver.handle(f.request)).rejects.toMatchObject({ code: "MODEL_NOT_FOUND" });
    f.request.target = "q/second"; f.request.policy[1] = "q/second";
    f.pi.setModel.mockResolvedValue(false);
    expect(await f.receiver.handle(f.request)).toMatchObject({ ok: false, model: "p/first", receipt: { outcome: "rejected", code: "AUTH_UNAVAILABLE" } });
  });
  it("reconciles a dropped ACK by request ID and never replays the setter", async () => {
    const f = await receiverFixture();
    await f.receiver.handle(f.request); // pretend client lost this response
    expect(await f.receiver.handle({ ...f.request, action: "result" })).toMatchObject({ receipt: { outcome: "selected" }, model: "q/second" });
    expect(await f.receiver.handle(f.request)).toMatchObject({ receipt: { outcome: "selected" } });
    expect(f.pi.setModel).toHaveBeenCalledTimes(1);
    await expect(f.receiver.handle({ ...f.request, target: "r/third" })).rejects.toMatchObject({ code: "REQUEST_ID_REUSED" });
  });
  it("makes setter exceptions after mutation unknown, not retryable success/failure", async () => {
    const f = await receiverFixture();
    f.pi.setModel.mockImplementation(async (model) => { f.ctx.model = model; throw new Error("private auth detail"); });
    const result = await f.receiver.handle(f.request);
    expect(result).toMatchObject({ ok: false, model: "q/second", receipt: { outcome: "unknown", code: "SETTER_FAILED" } });
    expect(JSON.stringify(result)).not.toContain("private auth detail");
    await f.receiver.handle(f.request);
    expect(f.pi.setModel).toHaveBeenCalledTimes(1);
  });
  it("does not attribute a previous provider's error to the new model after reload", async () => {
    const f = await receiverFixture();
    f.entries.push({ type: "message", message: { role: "assistant", provider: "p", model: "first", stopReason: "error", errorMessage: "429" } });
    await f.receiver.handle(f.request);
    const reloaded = createReceiver({ pi: f.pi, ctx: f.ctx, read: f.read, env: f.env });
    expect(reloaded.state().lastFailure).toBeNull();
    await expect(reloaded.handle({ ...f.request, requestId: "request-new", expectedModel: "q/second", target: "r/third" })).rejects.toMatchObject({ code: "INELIGIBLE_FAILURE" });
  });
  it("does not acknowledge selection if the final receipt cannot be persisted", async () => {
    const f = await receiverFixture();
    const append = f.pi.appendEntry.getMockImplementation();
    f.pi.appendEntry.mockImplementation((type, data) => {
      if (data.outcome !== "pending") throw new Error("storage unavailable");
      return append(type, data);
    });
    expect(await f.receiver.handle(f.request)).toMatchObject({ ok: false, model: "q/second", receipt: { outcome: "unknown", code: "RECEIPT_UNAVAILABLE" } });
    expect(f.receiver.isSwitching()).toBe(false);
    expect(await f.receiver.handle({ ...f.request, action: "result" })).toMatchObject({ receipt: { outcome: "pending" } });
  });
  it("preserves pending intent across reload instead of blindly repeating", async () => {
    const f = await receiverFixture();
    f.pi.setModel.mockImplementation(async () => { throw new Error("outage"); });
    await f.receiver.handle(f.request);
    f.entries.pop(); // crash after persisted pending, before final receipt
    const reloaded = createReceiver({ pi: f.pi, ctx: f.ctx, read: f.read, env: f.env });
    expect(await reloaded.handle(f.request)).toMatchObject({ ok: false, receipt: { outcome: "pending" } });
    expect(f.pi.setModel).toHaveBeenCalledTimes(1);
  });
  it("serializes switches, exposes a turn barrier, and refuses a concurrent request", async () => {
    const f = await receiverFixture();
    let finish!: () => void;
    f.pi.setModel.mockImplementation(async (model) => { await new Promise<void>((r) => { finish = r; }); f.ctx.model = model; return true; });
    const first = f.receiver.handle(f.request);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    let settled = false;
    const barrier = f.receiver.wait().then(() => { settled = true; });
    expect(settled).toBe(false);
    await expect(f.receiver.handle({ ...f.request, requestId: "request-456" })).rejects.toMatchObject({ code: "WORKER_BUSY" });
    finish(); await first; await barrier;
    expect(settled).toBe(true);
  });
  it("does not acknowledge a revoked assignment or replaced session after setter await", async () => {
    const f = await receiverFixture();
    f.pi.setModel.mockImplementation(async (model) => { f.ctx.model = model; f.record.result.dispatch.capabilityRevokedAt = "now"; return true; });
    expect(await f.receiver.handle(f.request)).toMatchObject({ ok: false, receipt: { outcome: "unknown" } });
  });
});

describe("explicit configurable policy; no fallback engine", () => {
  it("has no provider-order default and accepts exact IDs including slash-bearing model IDs", () => {
    expect(parseModels("vendor/nested/model,other/model")).toEqual(["vendor/nested/model", "other/model"]);
    for (const bad of [undefined, [], ["p/m", "p/m"], ["p/*"], ["model"], ["p/m: high"]]) expect(() => parseModels(bad)).toThrow();
  });
  it.each([undefined, "test failed", "review rejected", "401 unauthorized", "context length exceeded"])("never treats %s as eligible provider failure", (text) => {
    expect(providerFailure({ role: "assistant", stopReason: "error", errorMessage: text })).toBeNull();
    expect(providerFailure({ role: "toolResult", stopReason: "error", errorMessage: "429" })).toBeNull();
  });
  it.each([["429 Too Many Requests", "rate-limit"], ["You've hit your 5-hour limit", "quota"], ["Subscription Sharing quota exceeded", "quota"], ["503 service unavailable", "provider-unavailable"]])("classifies %s", (text, reason) => {
    expect(providerFailure({ role: "assistant", stopReason: "error", errorMessage: text })).toBe(reason);
  });
  it("enforces next-only order, no wrapping, and never falls back on code failure", async () => {
    const f = await receiverFixture();
    await expect(f.receiver.handle({ ...f.request, policy: undefined })).rejects.toMatchObject({ code: "POLICY_INVALID" });
    await expect(f.receiver.handle({ ...f.request, target: "r/third" })).rejects.toMatchObject({ code: "POLICY_TARGET" });
    await expect(f.receiver.handle({ ...f.request, policy: ["q/second", "p/first"] })).rejects.toMatchObject({ code: "POLICY_EXHAUSTED" });
    f.receiver.observe({ role: "assistant", stopReason: "error", errorMessage: "tests failed" });
    await expect(f.receiver.handle(f.request)).rejects.toMatchObject({ code: "INELIGIBLE_FAILURE" });
    expect(f.pi.setModel).not.toHaveBeenCalled();
  });
  it("prompts and confirms absent policy, restores it for the same Run, and permits explicit changes", async () => {
    const f = await receiverFixture();
    f.ctx.hasUI = true;
    f.ctx.ui = { input: vi.fn(async () => "p/first,q/second"), confirm: vi.fn(async () => true) };
    expect(await modelPolicy(f.pi, f.ctx, f.identity)).toEqual(["p/first", "q/second"]);
    expect(f.ctx.ui.input).toHaveBeenCalledTimes(1);
    await modelPolicy(f.pi, f.ctx, f.identity);
    expect(f.ctx.ui.input).toHaveBeenCalledTimes(1);
    expect(await modelPolicy(f.pi, f.ctx, f.identity, "q/second,p/first")).toEqual(["q/second", "p/first"]);
    expect(f.ctx.ui.confirm).toHaveBeenCalledTimes(2);
    await modelPolicy(f.pi, f.ctx, { ...f.identity, generation: 2 });
    expect(f.ctx.ui.input).toHaveBeenCalledTimes(2);
  });
  it("requires a human answer rather than inventing defaults in headless/cancelled mode", async () => {
    const f = await receiverFixture();
    f.ctx.hasUI = false;
    await expect(modelPolicy(f.pi, f.ctx, f.identity)).rejects.toMatchObject({ code: "POLICY_REQUIRED" });
    f.ctx.hasUI = true; f.ctx.ui = { input: async () => "p/first,q/second", confirm: async () => false };
    await expect(modelPolicy(f.pi, f.ctx, f.identity)).rejects.toMatchObject({ code: "POLICY_REQUIRED" });
    expect(f.entries).toHaveLength(0);
  });
});

describe("private local endpoint, not generic RPC", () => {
  it("switches during a simulated current-provider outage over the real socket without inference", async () => {
    const f = await receiverFixture();
    const path = endpointPath(f.env.ORCA_PANE_KEY, f.cwd);
    closers.push(await serveControl(path, f.receiver.handle));
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(await callControl(path, { action: "status", identity: f.identity })).toMatchObject({ sessionId: "pi-session", model: "p/first", lastFailure: "rate-limit" });
    expect(await callControl(path, f.request)).toMatchObject({ ok: true, receipt: { outcome: "selected" } });
    expect(await callControl(path, { action: "abort", identity: f.identity })).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    expect(f.pi.setModel).toHaveBeenCalledTimes(1);
  });
  it("rejects unsafe/symlink directories and refuses to replace an existing endpoint", async () => {
    const directory = root(); chmodSync(directory, 0o755);
    expect(() => endpointPath("pane", directory)).toThrow();
    chmodSync(directory, 0o700);
    const link = join(root(), "link"); symlinkSync(directory, link);
    expect(() => endpointPath("pane", link)).toThrow();
    const path = endpointPath("pane", directory);
    closers.push(await serveControl(path, async () => ({ ok: true })));
    await expect(serveControl(path, async () => ({ ok: true }))).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(await callControl(path, {})).toEqual({ ok: true });
  });
  it("respects cancellation before send and treats cancellation after send as ambiguous", async () => {
    const path = endpointPath("pane", root());
    let received = false, finish!: () => void;
    closers.push(await serveControl(path, async () => {
      received = true;
      await new Promise<void>((resolve) => { finish = resolve; });
      return { ok: true };
    }));
    await expect(callControl(path, {}, { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "CONTROL_CANCELLED" });
    expect(received).toBe(false);
    const controller = new AbortController();
    const pending = callControl(path, {}, { signal: controller.signal });
    await vi.waitFor(() => expect(received).toBe(true));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    finish();
  });
  it("bounds malformed/oversized input and reports a lost response as unknown", async () => {
    const path = endpointPath("pane", root());
    closers.push(await serveControl(path, async () => { throw new Error("secret"); }));
    expect(await callControl(path, {})).toEqual({ ok: false, code: "CONTROL_FAILED" });
    await expect(callControl(path, { oversized: "x".repeat(20_000) })).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  });
});

describe("real Pi SDK integration (isolated storage; no providers contacted)", () => {
  it("uses real extension context, registry, setter and persisted model-change history", async () => {
    const sdkPath = process.env.PI_MODEL_CONTROL_SDK;
    const sdk = sdkPath ? await import(/* @vite-ignore */ pathToFileURL(sdkPath).href) : await import("@earendil-works/pi-coding-agent");
    const { ModelRuntime, SettingsManager, SessionManager, DefaultResourceLoader, createAgentSession } = sdk;
    const f = fixture();
    vi.stubEnv("ORCA_PANE_KEY", ""); // never bind this test SDK to the real coordinator's pane
    const runtime = await ModelRuntime.create({ authPath: join(f.cwd, "test-auth.json"), modelsPath: null,
      modelsStorePath: join(f.cwd, "test-catalog.json"), allowModelNetwork: false, refreshOnCreate: false });
    for (const provider of ["fixture-a", "fixture-b"]) runtime.registerProvider(provider, {
      api: "openai-completions", apiKey: "non-secret-test-only", baseUrl: "http://127.0.0.1:1",
      models: [{ id: "one", name: "fixture", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    });
    const settings = SettingsManager.inMemory({ defaultProvider: "fixture-a", defaultModel: "one", compaction: { enabled: false }, retry: { enabled: false } });
    const settingsBefore = JSON.stringify(settings.getSettings());
    const manager = SessionManager.create(f.cwd, join(f.cwd, "sessions"));
    manager.appendMessage({ role: "user", content: "retain this history", timestamp: Date.now() });
    let receiver: any;
    const loader = new DefaultResourceLoader({ cwd: f.cwd, agentDir: f.cwd, settingsManager: settings,
      additionalExtensionPaths: [join(import.meta.dirname, "..", "extensions", "orca.ts")],
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [(pi: any) => pi.on("session_start", (_event: any, ctx: any) => {
        receiver = createReceiver({ pi, ctx, read: f.read, env: f.env });
      })] });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    expect(loader.getExtensions().extensions.flatMap((extension: any) => [...extension.tools.keys()])).toContain("orca_worker_model");
    const { session } = await createAgentSession({ cwd: f.cwd, agentDir: f.cwd, modelRuntime: runtime,
      model: runtime.getModel("fixture-a", "one"), resourceLoader: loader, settingsManager: settings,
      sessionManager: manager, noTools: "builtin" });
    try {
      await session.bindExtensions({ mode: "print" });
      expect(receiver).toBeDefined();
      expect(session.getAllTools().map((tool: any) => tool.name)).toContain("orca_worker_model");
      const id = manager.getSessionId();
      const identity = await nativeTarget(f.read, "ctx_worker");
      receiver.observe({ role: "assistant", provider: "fixture-a", model: "one", stopReason: "error", errorMessage: "429" });
      const path = endpointPath(f.env.ORCA_PANE_KEY, f.cwd);
      closers.push(await serveControl(path, receiver.handle));
      const result = await callControl(path, { action: "switch", identity, sessionId: id, requestId: "sdk-request-1",
        expectedModel: "fixture-a/one", target: "fixture-b/one", reason: "rate-limit", policy: ["fixture-a/one", "fixture-b/one"] });
      expect(result).toMatchObject({ ok: true, sessionId: id, model: "fixture-b/one" });
      expect(session.model.provider).toBe("fixture-b");
      expect(manager.getSessionId()).toBe(id);
      expect(manager.getBranch().some((e: any) => e.type === "model_change" && e.provider === "fixture-b" && e.modelId === "one")).toBe(true);
      expect(manager.getBranch().some((e: any) => e.type === "message" && e.message.content === "retain this history")).toBe(true);
      expect(JSON.stringify(settings.getSettings())).toBe(settingsBefore);
      const restored = SessionManager.open(manager.getSessionFile());
      expect(restored.getSessionId()).toBe(id);
      expect(restored.getBranch().filter((e: any) => e.type === "custom" && e.customType === "orca-model-switch").at(-1).data.outcome).toBe("selected");
    } finally { session.dispose(); }
  }, 30_000);
});

describe("Pi extension wiring", () => {
  it("starts no background resources at factory load and exposes no lifecycle tool", () => {
    const handlers = new Map();
    const pi: any = { on: vi.fn((name, fn) => handlers.set(name, fn)), registerTool: vi.fn(), registerCommand: vi.fn() };
    registerModelControl(pi);
    expect(pi.registerTool.mock.calls[0][0].name).toBe("orca_worker_model");
    expect(pi.registerCommand.mock.calls[0][0]).toBe("orca-model-policy");
    expect([...handlers.keys()]).toEqual(expect.arrayContaining(["session_start", "session_shutdown", "before_agent_start", "session_before_compact"]));
    expect(pi.on.mock.calls.every(([name]) => name !== "agent_end")).toBe(true); // not a settled signal
  });
});
