import { fileURLToPath } from "node:url";

import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const cliPath = fileURLToPath(new URL("../bin/orca-orchestrator.mjs", import.meta.url));
const StatusParams = Type.Object({
  issue: Type.Optional(Type.Integer({ minimum: 1, description: "Limit status to one GitHub issue number" })),
});
const GuardParams = Type.Object({
  group: Type.Union([Type.Literal("auto"), Type.Literal("orca")], {
    description: "Repository guard command group",
  }),
  command: Type.String({ description: "Allowed guard command" }),
  args: Type.Optional(Type.Array(Type.String(), {
    description: "Flag/value arguments, for example [\"--issue\", \"42\", \"--owner\", \"pi\", \"--run\", \"r1\"]",
  })),
});

const ALLOWED = {
  auto: new Set([
    "status", "claim", "renew", "release", "recover", "pause", "resume",
    "auth-check", "founder-status", "founder-resume", "repair-record", "repair-status",
    "bind-native", "unbind-native",
  ]),
  orca: new Set(["verify-head", "cleanup", "review-open", "review-send", "review-wait", "review-read", "review-delete"]),
} as const;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type StatusDetails = {
  code: number;
  issue?: number;
  status?: JsonValue;
};

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ["boolean", "number", "string"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object") return Object.values(value).every(isJsonValue);
  return false;
}

function parseStatus(stdout: string): JsonValue | undefined {
  try {
    const value: unknown = JSON.parse(stdout);
    return isJsonValue(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function conciseOutput(stdout: string, stderr: string): string {
  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  if (!output) return "Orca status returned no output.";
  return output.length > 20_000 ? `${output.slice(0, 20_000)}\n… output truncated` : output;
}

export default function (pi: ExtensionAPI) {
  function status(cwd: string, issue?: number, signal?: AbortSignal) {
    const args = [cliPath, "auto", "status"];
    if (issue !== undefined) args.push("--issue", String(issue));
    return pi.exec(process.execPath, args, { cwd, signal, timeout: 15_000 });
  }

  pi.registerTool(
    defineTool({
      name: "orca_guard",
      label: "Orca repository guard",
      description:
        "Run an allowlisted repository delivery guard from the installed Pi package. Native Orca owns orchestration and worktrees; this tool retains leases, authority, repair, review, exact-head, and cleanup safeguards without a repository-local npm dependency.",
      parameters: GuardParams,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        if (!ALLOWED[params.group].has(params.command)) {
          return {
            content: [{ type: "text", text: `Command ${params.group} ${params.command} is not exposed by orca_guard.` }],
            details: { code: 2, group: params.group, command: params.command },
            isError: true,
          };
        }
        const result = await pi.exec(process.execPath, [cliPath, params.group, params.command, ...(params.args ?? [])], {
          cwd: ctx.cwd,
          signal,
          timeout: 30 * 60_000,
        });
        return {
          content: [{ type: "text", text: conciseOutput(result.stdout, result.stderr) }],
          details: { code: result.code, group: params.group, command: params.command, result: parseStatus(result.stdout) },
          isError: result.code !== 0,
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "orca_status",
      label: "Orca status",
      description:
        "Read Orca lease, pause, and issue-run status for the current repository. This is read-only and uses the repository's orca.config.json.",
      parameters: StatusParams,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const result = await status(ctx.cwd, params.issue, signal);
        const details: StatusDetails = {
          code: result.code,
          issue: params.issue,
          status: parseStatus(result.stdout),
        };
        return {
          content: [{ type: "text", text: conciseOutput(result.stdout, result.stderr) }],
          details,
          isError: result.code !== 0,
        };
      },
    }),
  );

  pi.registerCommand("orca-status", {
    description: "Show Orca lease and run status for this repository",
    handler: async (args: string, ctx: ExtensionContext) => {
      const input = args.trim();
      const parsedIssue = Number(input);
      const issue = input ? parsedIssue : undefined;
      if (input && (!Number.isInteger(parsedIssue) || parsedIssue < 1)) {
        ctx.ui.notify("Usage: /orca-status [issue-number]", "error");
        return;
      }
      const result = await status(ctx.cwd, issue);
      ctx.ui.notify(conciseOutput(result.stdout, result.stderr), result.code === 0 ? "info" : "error");
    },
  });
}
