#!/usr/bin/env node
// Single entry point:
//   orca-orchestrator auto <command> ...    lease, worktree, authority and repair-ledger commands
//   orca-orchestrator orca <command> ...    dispatch, verify-head, cleanup and the ChatGPT review browser
//   orca-orchestrator learn record|report|propose|packet|evaluate   append-only evidence, hypotheses, and pinned replay evaluation
//   orca-orchestrator init                  write a starter orca.config.json in the current repository
//   orca-orchestrator install-skills [--dir <dir>]   copy the shipped skills into the repository (default .agents/skills)
//   orca-orchestrator check-skills   [--dir <dir>]   exit 1 if the installed skills differ from the shipped ones
// The repository is the git repository containing the working directory (a linked worktree resolves
// to its main checkout), and its orca.config.json supplies every repo-specific setting.
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { checkSkills, installSkills } from "../src/skills.mjs";
import { join } from "node:path";
import { CONFIG_FILE, ConfigError, loadConfig, resolveConfigRoot, resolveRepoRoot, setActiveConfig } from "../src/config.mjs";
import { runCommand } from "../src/auto/cli.mjs";
import { main as orcaMain } from "../src/orca/cli.mjs";
import { runLearn } from "../src/learn/cli.mjs";
import { captureCommand } from "../src/learn/telemetry.mjs";
import { runEvaluation } from "../src/eval/replay.mjs";

const STARTER = {
  defaultBranch: "main",
  gate: { command: "npm", args: ["run", "verify"] },
  review: { projectId: "g-p-REPLACE_WITH_CHATGPT_PROJECT_ID", projectName: "REPLACE_WITH_PROJECT_NAME" },
  workerInstructions: ["Follow the repository's AGENTS.md or CLAUDE.md."],
  protectedDomains: [
    {
      id: "example-domain",
      labels: ["example-label"],
      words: ["example-word"],
      paths: ["^path/to/protected/"],
    },
  ],
};

function fail(code, message, exitCode = 2) {
  process.stdout.write(`${JSON.stringify({ ok: false, code, error: message })}\n`);
  process.exitCode = exitCode;
}

const [which, ...rest] = process.argv.slice(2);
const repoRoot = resolveRepoRoot();

if (which === "init") {
  const file = join(repoRoot, CONFIG_FILE);
  if (existsSync(file)) fail("CONFIG_EXISTS", `${file} already exists; edit it directly`);
  else {
    writeFileSync(file, `${JSON.stringify(STARTER, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ ok: true, wrote: file, next: "replace the REPLACE_* values and example domain" })}\n`);
  }
} else if (which === "install-skills" || which === "check-skills") {
  const i = rest.indexOf("--dir");
  // Skills are versioned files: act on the checkout the command runs in (a linked worktree's own tree),
  // never on the main checkout the lease state lives in.
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  const here = top.status === 0 ? top.stdout.trim() : repoRoot;
  const dir = join(here, i >= 0 && rest[i + 1] ? rest[i + 1] : ".agents/skills");
  const receipt = which === "install-skills" ? installSkills(dir) : checkSkills(dir);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  process.exitCode = receipt.ok ? 0 : 1;
} else if (which === "learn" && rest[0] === "evaluate") {
  // Evaluation is independent of repo-specific config: this checkout is the
  // trusted runner and is not necessarily itself an Orca-managed repository.
  const { code, result } = runEvaluation(rest.slice(1));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = code;
} else if (which === "auto" || which === "orca" || which === "learn") {
  try {
    setActiveConfig(loadConfig(resolveConfigRoot(process.cwd(), repoRoot), { repoRoot }));
    const started = performance.now();
    let receipt;
    try {
      receipt = which === "auto" ? runCommand(rest, { repoRoot }) :
        which === "orca" ? orcaMain(rest, { repoRoot }) : runLearn(rest, { repoRoot });
    } finally {
      if (which !== "learn") {
        const telemetry = captureCommand({ repoRoot, group: which, args: rest,
          code: receipt?.code ?? 1, result: receipt?.result, durationMs: performance.now() - started });
        if (telemetry.enabled && (!telemetry.recorded || telemetry.registrationCode))
          process.stderr.write("Orca learning: telemetry incomplete; delivery receipt unchanged.\n");
      }
    }
    process.stdout.write(`${JSON.stringify(receipt.result)}\n`);
    process.exitCode = receipt.code;
  } catch (error) {
    if (error instanceof ConfigError) fail(error.code, error.message);
    else throw error;
  }
} else {
  fail("INVALID_ARGS", "usage: orca-orchestrator <auto|orca|learn|init|install-skills|check-skills> [args]");
}
