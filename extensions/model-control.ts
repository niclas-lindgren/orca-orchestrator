import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  ModelControlError, requireControl, parseModels, nativeReader, coordinatorTarget,
  endpointPath, serveControl, callControl, createReceiver,
} from "../src/pi/model-control.mjs";

const POLICY = "orca-model-policy";
const Params = Type.Object({
  action: Type.Union([Type.Literal("status"), Type.Literal("switch"), Type.Literal("result")]),
  dispatch: Type.String({ description: "Exact native Pi dispatch ID in the coordinator's bound Run" }),
  sessionId: Type.Optional(Type.String({ description: "Pi session ID returned by status; required for switch/result" })),
  requestId: Type.Optional(Type.String({ description: "Unique durable request ID, at least 8 characters; reuse only to query result" })),
  expectedModel: Type.Optional(Type.String({ description: "Exact provider/model returned by status" })),
  target: Type.Optional(Type.String({ description: "Next exact provider/model in the user-approved order" })),
  reason: Type.Optional(Type.Union([Type.Literal("quota"), Type.Literal("rate-limit"), Type.Literal("provider-unavailable")])),
});

// Policy uses Pi's existing session store, scoped to a native Run and coordinator
// generation. It grants no authority over lifecycle or repository delivery gates.
export async function modelPolicy(pi: ExtensionAPI, ctx: ExtensionContext, identity: any, replacement?: string) {
  const previous = ctx.sessionManager.getBranch().filter((entry: any) => entry.type === "custom" &&
    entry.customType === POLICY && entry.data?.runId === identity.runId &&
    entry.data?.generation === identity.generation && entry.data?.coordinatorHandle === identity.coordinatorHandle).at(-1) as any;
  if (replacement === undefined && previous) return parseModels(previous.data.models);
  requireControl(ctx.hasUI, "POLICY_REQUIRED", "Ask the user to configure /orca-model-policy; no provider order is assumed.");
  const input = replacement ?? await ctx.ui.input(
    `Model order for ${identity.runId} (exact IDs, comma-separated; no default)`, "provider/model, provider/model",
  );
  requireControl(input !== undefined, "POLICY_REQUIRED", "No model policy was approved.");
  const models = parseModels(input);
  for (const selector of models) {
    const slash = selector.indexOf("/");
    requireControl(ctx.modelRegistry.find(selector.slice(0, slash), selector.slice(slash + 1)),
      "MODEL_NOT_FOUND", `Model not in this Pi catalogue: ${selector}`);
  }
  requireControl(await ctx.ui.confirm("Approve this Run's model fallback order?",
    `${models.join(" → ")}\nOnly settled quota/rate-limit/provider-unavailable failures. No automatic request replay, harness changes or global-default changes.`),
  "POLICY_REQUIRED", "The user did not approve a policy.");
  pi.appendEntry(POLICY, { runId: identity.runId, generation: identity.generation,
    coordinatorHandle: identity.coordinatorHandle, models });
  return models;
}

export function registerModelControl(pi: ExtensionAPI) {
  const read = nativeReader((command: string, args: string[], options: any) => pi.exec(command, args, options));
  let receiver: ReturnType<typeof createReceiver> | undefined;
  let close: (() => Promise<void>) | undefined;
  let active = false;
  let startup: Promise<void> = Promise.resolve();

  pi.on("session_start", (_event, ctx) => {
    if (!process.env.ORCA_PANE_KEY || !process.env.ORCA_WORKTREE_ID || !process.env.ORCA_CLI_COMMAND) return;
    active = true;
    receiver = createReceiver({ pi, ctx, read, env: process.env, alive: () => active });
    // No model/provider request is needed to accept control, even after a 429.
    startup = (async () => {
      try {
        close = await serveControl(endpointPath(process.env.ORCA_PANE_KEY), (request: unknown) => receiver!.handle(request));
        if (!active) { await close(); close = undefined; }
      } catch (error) {
        ctx.ui.notify(`Pi model control unavailable: ${error instanceof ModelControlError ? error.code : "ENDPOINT_UNAVAILABLE"}. No endpoint was replaced.`, "warning");
      }
    })();
  });
  pi.on("session_shutdown", async () => {
    active = false;
    await startup;
    await close?.(); close = undefined;
  });
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") receiver?.observe(event.message);
  });
  pi.on("model_select", () => receiver?.observe(undefined));
  // A newly submitted turn waits for an already-started selection. Entry into the
  // setter itself still requires idle/no queued messages. Never abort an active run.
  pi.on("before_agent_start", async () => { await receiver?.wait(); });
  for (const name of ["session_before_switch", "session_before_fork", "session_before_tree", "session_before_compact"] as const) {
    pi.on(name, async (_event, ctx) => {
      if (receiver?.isSwitching()) {
        ctx.ui.notify("Wait for the acknowledged model selection before changing session/context.", "warning");
        return { cancel: true };
      }
    });
  }

  pi.registerTool({
    name: "orca_worker_model",
    label: "Pi worker model control",
    description: "Inspect or change the model of an exact live local Pi dispatch, using native Orca authority. Switch only after a finalized provider availability failure and user-approved Run policy, while Pi is settled. No lifecycle, abort, prompt injection, retries or inference. A selected receipt is not proof that the new provider works. On a lost ACK, query result/state rather than repeating. No configured order: prompts the user.",
    parameters: Params,
    async execute(_id, params, signal, _update, ctx) {
      try {
        requireControl(!signal?.aborted, "CONTROL_CANCELLED");
        const identity = await coordinatorTarget(read, params.dispatch);
        const policy = params.action === "switch" ? await modelPolicy(pi, ctx, identity) : undefined;
        const request = { action: params.action, identity, sessionId: params.sessionId,
          requestId: params.requestId, expectedModel: params.expectedModel, target: params.target, reason: params.reason, policy };
        const result = await callControl(endpointPath(identity.paneKey), request, { signal }) as any;
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result, isError: !result.ok };
      } catch (error) {
        const code = error instanceof ModelControlError ? error.code : "CONTROL_UNAVAILABLE";
        const result = { ok: false, code, message: error instanceof ModelControlError ? error.message : "Control unavailable; inspect native Orca and the endpoint before retrying." };
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result, isError: true };
      }
    },
  });

  pi.registerCommand("orca-model-policy", {
    description: "Approve/replace this native Run's model order: /orca-model-policy dispatch-id [provider/model,provider/model]",
    handler: async (args, ctx) => {
      try {
        const [dispatch, ...order] = args.trim().split(/\s+/);
        const identity = await coordinatorTarget(read, dispatch);
        // An explicit command always asks again, allowing existing policy to change.
        const replacement = order.length ? order.join(" ") : await ctx.ui.input("Replacement model order (exact IDs, comma-separated)");
        requireControl(replacement !== undefined, "POLICY_REQUIRED");
        const models = await modelPolicy(pi, ctx, identity, replacement);
        ctx.ui.notify(`Approved for ${identity.runId}: ${models.join(" → ")}`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof ModelControlError ? `${error.code}: ${error.message}` : "Could not configure model policy.", "error");
      }
    },
  });
}
