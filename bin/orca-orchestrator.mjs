#!/usr/bin/env node
// Single entry point:
//   orca-orchestrator auto <command> ...    lease, worktree, authority and repair-ledger commands
//   orca-orchestrator orca <command> ...    dispatch, verify-head, cleanup and the ChatGPT review browser
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
} else if (which === "auto" || which === "orca") {
  try {
    setActiveConfig(loadConfig(resolveConfigRoot(process.cwd(), repoRoot), { repoRoot }));
    const { code, result } = which === "auto" ? runCommand(rest, { repoRoot }) : orcaMain(rest, { repoRoot });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = code;
  } catch (error) {
    if (error instanceof ConfigError) fail(error.code, error.message);
    else throw error;
  }
} else {
  fail("INVALID_ARGS", "usage: orca-orchestrator <auto|orca|init|install-skills|check-skills> [args]");
}
