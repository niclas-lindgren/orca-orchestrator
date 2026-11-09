import { fileURLToPath } from "node:url";

import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const cliPath = fileURLToPath(new URL("../bin/orca-orchestrator.mjs", import.meta.url));
const StatusParams = Type.Object({
  issue: Type.Optional(Type.Integer({ minimum: 1, description: "Limit status to one GitHub issue number" })),
});

type StatusDetails = {
  code: number;
  issue?: number;
  status?: unknown;
};

function parseStatus(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
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
  async function status(cwd: string, issue?: number, signal?: AbortSignal) {
    const args = [cliPath, "auto", "status"];
    if (issue !== undefined) args.push("--issue", String(issue));
    return pi.exec(process.execPath, args, { cwd, signal, timeout: 15_000 });
  }

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
      const issue = input ? Number(input) : undefined;
      if (input && (!Number.isInteger(issue) || issue! < 1)) {
        ctx.ui.notify("Usage: /orca-status [issue-number]", "error");
        return;
      }
      const result = await status(ctx.cwd, issue);
      ctx.ui.notify(conciseOutput(result.stdout, result.stderr), result.code === 0 ? "info" : "error");
    },
  });
}
