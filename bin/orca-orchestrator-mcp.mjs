#!/usr/bin/env node
// Dependency-free MCP adapter for Claude Code. It exposes the same allowlisted
// repository guards as the Pi extension while native Orca owns orchestration,
// workers and worktrees.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("./orca-orchestrator.mjs", import.meta.url));
const cwd = process.env.ORCA_REPO_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const allowed = {
  auto: new Set([
    "status", "claim", "renew", "release", "recover", "pause", "resume",
    "auth-check", "founder-resume", "repair-record", "repair-status",
    "bind-native", "unbind-native", "handover", "adopt",
  ]),
  orca: new Set(["verify-head", "resume-report", "cleanup", "review-open", "review-send", "review-wait", "review-read", "review-delete"]),
};

const tool = {
  name: "orca_guard",
  description: "Run an allowlisted Orca repository delivery guard. Native Orca owns orchestration and worktrees; this adapter retains leases, authority, repair, review, exact-head, and cleanup safeguards without a repository-local npm dependency.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["group", "command"],
    properties: {
      group: { type: "string", enum: ["auto", "orca"] },
      command: { type: "string" },
      args: { type: "array", items: { type: "string" }, default: [] },
    },
  },
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

const active = new Map();
const COMMAND_TIMEOUT_MS = 30 * 60_000;

function run(id, group, command, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, group, command, ...args], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const key = String(id);
    const state = { child, cancelled: false, timedOut: false };
    active.set(key, state);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const append = (current, chunk) => (current + chunk).slice(-20_000);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      active.delete(key);
      resolve(value);
    };
    const terminate = () => {
      state.cancelled = true;
      if (process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
      } else child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) {
          if (process.platform !== "win32" && child.pid) {
            try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
          } else child.kill("SIGKILL");
        }
      }, 2_000).unref();
    };
    state.terminate = terminate;
    const timer = setTimeout(() => {
      state.timedOut = true;
      terminate();
    }, COMMAND_TIMEOUT_MS);
    timer.unref();
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", (cause) => finish({ code: 1, stdout, stderr: `${stderr}\n${cause.message}`.trim(), cancelled: state.cancelled, timedOut: state.timedOut }));
    child.on("close", (code) => finish({ code: code ?? 1, stdout, stderr, cancelled: state.cancelled, timedOut: state.timedOut }));
  });
}

async function handle(message) {
  if (!message || message.jsonrpc !== "2.0") return;
  const { id, method, params = {} } = message;
  if (method === "notifications/initialized") return;
  if (method === "notifications/cancelled") {
    active.get(String(params.requestId))?.terminate();
    return;
  }
  if (method === "initialize") {
    result(id, {
      protocolVersion: params.protocolVersion ?? "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "orca-orchestrator", version: "0.3.0" },
    });
    return;
  }
  if (method === "ping") {
    result(id, {});
    return;
  }
  if (method === "tools/list") {
    result(id, { tools: [tool] });
    return;
  }
  if (method !== "tools/call") {
    if (id !== undefined) error(id, -32601, `Method not found: ${method}`);
    return;
  }
  if (params.name !== "orca_guard") {
    error(id, -32602, `Unknown tool: ${params.name ?? ""}`);
    return;
  }
  const input = params.arguments ?? {};
  const group = input.group;
  const command = input.command;
  const args = input.args ?? [];
  if (!allowed[group]?.has(command) || !Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    result(id, { content: [{ type: "text", text: "Invalid or unavailable orca_guard command." }], isError: true });
    return;
  }
  const receipt = await run(id, group, command, args);
  if (receipt.cancelled) {
    error(id, -32800, receipt.timedOut ? "Orca guard command timed out" : "Orca guard command cancelled");
    return;
  }
  const text = [receipt.stdout.trim(), receipt.stderr.trim()].filter(Boolean).join("\n") || "Orca guard returned no output.";
  result(id, { content: [{ type: "text", text }], isError: receipt.code !== 0 });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      void handle(JSON.parse(line));
    } catch (cause) {
      process.stderr.write(`Invalid MCP message: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    }
  }
});
