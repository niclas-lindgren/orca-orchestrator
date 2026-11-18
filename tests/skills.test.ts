// The skills are the operating procedure; these tests pin the safety rules that review found easy to
// lose when the text is edited.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const read = (name: string) => readFileSync(join(root, "skills", name, "SKILL.md"), "utf8");
const flow = read("orca-flow");
const fleet = read("orca-fleet");

describe("skill front matter", () => {
  it.each(["orca-flow", "orca-fleet"])("%s has a portable name matching its directory", (name) => {
    expect(read(name)).toMatch(new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n---`));
  });

  it.each([
    ["orca-flow", flow],
    ["orca-fleet", fleet],
  ])("%s names no specific repository, project or product", (_name, text) => {
    expect(text).not.toMatch(/hockey|campsty|camping|region-viken|niclas-lindgren\/(?!orca)|RVV|season/i);
  });
});

describe("native Orca boundary", () => {
  it.each([
    ["orca-flow", flow],
    ["orca-fleet", fleet],
  ])("%s loads the native contract and bans repository wrappers", (_name, text) => {
    expect(text).toContain("skills get orchestration --full");
    expect(text).toContain("orca_guard");
    expect(text).toMatch(/Never use `npm run auto`, `npm run orca`/);
    expect(text).not.toMatch(/npm run auto --|npm run orca --|npx orca-orchestrator\s+(auto|orca)/);
  });

  it("uses native worktree lifecycle in the single flow", () => {
    expect(flow).toMatch(/worktree create/);
    expect(flow).toMatch(/--branch "agent\/issue-\$ISSUE"/);
    expect(flow).toMatch(/worktree rm --delete-branch/);
    expect(flow).toMatch(/Never use raw `git worktree remove`, `git branch -D`/);
  });

  it("uses native run, task, worker and retry lifecycle in the fleet", () => {
    for (const command of ["run-create", "task-create", "worker-start", "worker-show", "worker-stop", "worker-abandon", "worker-release"]) {
      expect(fleet).toContain(command);
    }
    expect(fleet).toContain("--retry-of");
    expect(fleet).toContain("--retry-request");
    expect(fleet).toMatch(/same Task/i);
    expect(fleet).toMatch(/three failed starts/i);
  });
});

describe("orca-flow safety", () => {
  it("fails preflight before claim when native Orca, adapter, browser or GitHub is unavailable", () => {
    expect(flow).toMatch(/Fail closed before claiming anything/);
    expect(flow).toMatch(/Missing adapter, unavailable Orca, missing config, or failed GitHub auth means stop before claim/i);
  });

  it("keeps leases alive and stops mutation on lease loss", () => {
    expect(flow).toContain("GUARD auto claim");
    expect(flow).toContain("GUARD auto renew");
    expect(flow).toMatch(/every 10 minutes/);
    expect(flow).toMatch(/Lease loss stops all mutation immediately/);
  });

  it("requires authority before implementation and merge", () => {
    expect(flow).toContain("GUARD auto auth-check");
    expect(flow).toContain("--phase plan");
    expect(flow).toContain("--phase merge --pr PR");
    expect(flow).toContain("founder-resume");
    expect(flow).toMatch(/silence as approval/);
  });

  it("requires fresh review of each exact head and records repairs", () => {
    for (const command of ["review-open", "review-send", "review-wait", "review-read", "repair-record"]) expect(flow).toContain(command);
    expect(flow).toMatch(/new review chat.*new head/i);
    expect(flow).toMatch(/Silence, timeout, stale SHA, or ambiguous output is not approval/);
  });

  it("places exact-head verification after review and CI", () => {
    const review = flow.indexOf("## Fresh independent review");
    const verify = flow.indexOf("GUARD orca verify-head");
    expect(review).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(review);
    expect(flow).toContain("--match-head-commit");
    expect(flow).toMatch(/head changes after verification, verify again/i);
  });

  it("deletes only chats created by the run", () => {
    expect(flow).toMatch(/review-delete --page PAGE --message-file FILE/);
    expect(flow).toMatch(/mismatch must refuse deletion/i);
  });
});

describe("orca-fleet safety", () => {
  it("limits concurrency and keeps one durable task and worker per issue", () => {
    expect(fleet).toMatch(/up to three independent issues/i);
    expect(fleet).toMatch(/For each issue create one durable Task/);
    expect(fleet).toMatch(/Start at most three workers/);
    expect(fleet).toMatch(/one worker per issue/i);
  });

  it("claims and authorizes every issue before launch", () => {
    const claim = fleet.indexOf("GUARD auto claim");
    const start = fleet.indexOf("orchestration worker-start");
    expect(claim).toBeGreaterThan(-1);
    expect(claim).toBeLessThan(start);
    expect(fleet).toContain("GUARD auto auth-check");
    expect(fleet).toMatch(/claim nothing/i);
  });

  it("binds native receipts durably and fails closed on ambiguity", () => {
    expect(fleet).toContain("GUARD auto bind-native");
    expect(fleet).toMatch(/--native-run NATIVE_RUN --task TASK_ID --dispatch DISPATCH_ID/);
    expect(fleet).toContain("--dispatch pending:START_REQUEST");
    const launch = fleet.slice(fleet.indexOf("## Start one worker per issue"));
    expect(launch.indexOf("--dispatch pending:START_REQUEST")).toBeLessThan(launch.indexOf("orchestration worker-start"));
    expect(fleet).toContain("--phase plan");
    expect(fleet).toContain("--phase merge --pr PR");
    expect(fleet).toMatch(/provisional binding blocks takeover/i);
    expect(fleet).toMatch(/Ambiguity means leave the applicable old or provisional binding intact and stop/);
  });

  it("does not infer worker failure from silence or use raw detached workers", () => {
    expect(fleet).toMatch(/Do not infer failure from silence/);
    expect(fleet).toMatch(/unverifiable worker is still potentially active/i);
    expect(fleet).toMatch(/Never use .*raw background shells, ad-hoc PTYs, or detached agents/i);
  });

  it("serializes fresh review, exact-head verification and merge", () => {
    expect(fleet).toMatch(/Parallelism ends at review/);
    expect(fleet).toMatch(/one issue at a time/);
    expect(fleet).toContain("GUARD orca verify-head");
    expect(fleet).toContain("--match-head-commit");
  });

  it("unbinds the exact dispatch before guarded native cleanup", () => {
    const unbind = fleet.indexOf("GUARD auto unbind-native");
    const cleanup = fleet.indexOf("GUARD orca cleanup");
    const release = fleet.indexOf("GUARD auto release");
    expect(unbind).toBeGreaterThan(-1);
    expect(cleanup).toBeGreaterThan(unbind);
    expect(release).toBeGreaterThan(cleanup);
    expect(fleet).toMatch(/worktree rm --delete-branch/);
  });
});

describe("agent package distribution", () => {
  const readJson = (relativePath: string) => JSON.parse(readFileSync(join(root, relativePath), "utf8"));

  it("exposes the same canonical skills without a second copy", () => {
    const marketplace = readJson(".claude-plugin/marketplace.json");
    const plugin = readJson(".claude-plugin/plugin.json");
    const pkg = readJson("package.json");
    expect(marketplace.plugins).toEqual(expect.arrayContaining([expect.objectContaining({ name: pkg.name, source: "./" })]));
    expect(plugin.name).toBe(pkg.name);
    expect(plugin).not.toHaveProperty("version");
    expect(pkg.pi.skills).toContain("./skills");
  });

  it("ships installed-package Pi and Claude guard adapters", () => {
    const pkg = readJson("package.json");
    const mcp = readJson(".mcp.json");
    const extension = readFileSync(join(root, "extensions", "orca.ts"), "utf8");
    const server = readFileSync(join(root, "bin", "orca-orchestrator-mcp.mjs"), "utf8");
    expect(pkg.files).toEqual(expect.arrayContaining([".claude-plugin", ".mcp.json", "bin", "extensions", "skills"]));
    expect(extension).toContain('name: "orca_guard"');
    expect(server).toContain('name: "orca_guard"');
    expect(mcp.mcpServers["orca-orchestrator"].args[0]).toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(mcp.mcpServers["orca-orchestrator"].env.ORCA_REPO_ROOT).toBe("${CLAUDE_PROJECT_DIR}");
  });

  it("uses only native commands and flags that exist", () => {
    const fleet = read("orca-fleet");
    const flow = read("orca-flow");
    for (const text of [fleet, flow]) {
      // `orca runtime status` was never a command; readiness is `orca status --json`.
      expect(text).not.toContain('"$ORCA" runtime status');
    }
    // run-show takes --id, not --run.
    expect(fleet).toContain('orchestration run-show --id "$NATIVE_RUN"');
    expect(fleet).not.toContain("run-show --run");
    // Creation flags are rejected for an existing worktree, so the fleet start passes none.
    const start = fleet.slice(fleet.indexOf("--task \"$TASK_ID\""));
    const block = start.slice(0, start.indexOf("--json"));
    for (const flag of ["--name", "--setup", "--repo", "--base-branch", "--display-name", "--comment"]) {
      expect(block).not.toContain(flag);
    }
  });
});
