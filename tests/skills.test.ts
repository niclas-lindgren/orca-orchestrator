// The skills are the operating procedure; these tests pin the safety rules that review found easy to
// lose when the text is edited.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const read = (name: string) => readFileSync(join(root, "skills", name, "SKILL.md"), "utf8");
const flow = read("orca-flow");
const fleet = read("orca-fleet");
const harnessMigration = () => readFileSync(join(root, "skills", "orca-flow", "references", "harness-migration.md"), "utf8");

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

  it("requires the Pi worker harness independently of the model choice", () => {
    expect(flow).toContain("## Worker harness");
    expect(flow).toMatch(/Every worker launch and retry uses the Pi harness/);
    expect(flow).toMatch(/Pi is unavailable.*stop and report/);
    expect(flow).toMatch(/Quota or provider failures.*do not authorize a harness switch/);
    expect(flow).toMatch(/--model.*only when the user/);
    expect(fleet).toContain("../orca-flow/SKILL.md#worker-harness");
    for (const text of [flow, fleet]) {
      expect(text).toContain("--agent pi");
      expect(text).not.toMatch(/--agent (?:"?\$AGENT"?|AGENT|<agent>|claude|codex)/);
    }
  });

  it("routes in-flight harness changes to one shared migration procedure", () => {
    expect(flow).toContain("references/harness-migration.md");
    const migration = harnessMigration();
    expect(migration).toContain("references/recovery-and-cleanup.md");
    expect(migration).toMatch(/does not transfer.*conversation history/i);
    expect(migration).toMatch(/stop_unknown.*stop and report/);
    expect(migration).toMatch(/abandon.*does not prove.*exit/i);
    expect(migration).toMatch(/uncommitted changes/);
    expect(migration).toMatch(/completed successfully/);
    expect(migration).toMatch(/follow-up Task/);
    expect(migration).toMatch(/circuit breaker/);
  });

  it("fences the old worker and binds provisionally before launching Pi", () => {
    const migration = harnessMigration();
    const stop = migration.indexOf("orchestration worker-stop");
    const unbind = migration.indexOf("GUARD auto unbind-native");
    const pending = migration.indexOf("--dispatch pending:START_REQUEST");
    const start = migration.indexOf("orchestration worker-start");
    const final = migration.indexOf("--dispatch NEW_DISPATCH");
    expect(stop).toBeGreaterThan(-1);
    expect(unbind).toBeGreaterThan(stop);
    expect(pending).toBeGreaterThan(unbind);
    expect(start).toBeGreaterThan(pending);
    expect(final).toBeGreaterThan(start);
    expect(migration).toContain('--retry-of "$OLD_DISPATCH"');
    expect(migration).toContain('--worktree "$WORKTREE_SELECTOR"');
    expect(migration).toContain("--agent pi");
    expect(migration).toMatch(/same.*--retry-request/);
    expect(migration).toMatch(/Confirm.*Pi.*receipt/);
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

describe("orca-fleet delegated review", () => {
  const delegated = () => readFileSync(join(root, "skills", "orca-fleet", "references", "delegated-review.md"), "utf8");

  it("is opt-in and leaves the default coordinator review path in place", () => {
    expect(fleet).toContain("references/delegated-review.md");
    expect(fleet).toMatch(/This section is the default/);
    expect(fleet).toMatch(/chose \[delegated review\].*before launching workers/);
    expect(delegated()).toMatch(/A worker never opts itself in/);
    expect(delegated()).toMatch(/fall back to the default coordinator-reviewed path/);
  });

  it("keeps lease, authority, verification and merge decisions with the coordinator", () => {
    const text = delegated();
    expect(text).toMatch(/must not claim, renew, adopt, release or `founder-resume`/);
    for (const kept of ["`auth-check`", "`verify-head`", "the merge", "CI"]) expect(text).toContain(kept);
    expect(text).toMatch(/A worker's report is a claim, not approval/);
    expect(text).toMatch(/Delegation moves the review \*iterations\*, never the \*decision\*/);
  });

  it("reviews each exact head in a new chat, stops on ambiguity and bounds the loop with the repair ledger", () => {
    const text = delegated();
    for (const command of ["review-open", "review-send", "review-wait", "review-read", "review-record", "repair-record"]) expect(text).toContain(command);
    expect(text).toMatch(/new\*\* review chat for the \*\*new\*\* head/);
    expect(text).toMatch(/Silence, timeout, a stale or different SHA, or ambiguous output is \*\*not approval\*\*/);
    expect(text).toMatch(/On \*\*every other result\*\*.*\*\*stop immediately\*\*/);
    expect(text).toMatch(/never use more than three rounds/);
    expect(text).toMatch(/One review round at a time across the whole fleet/);
  });

  it("requires an explicit exclusive slot for probes and all worker/coordinator browser operations", () => {
    const text = delegated();
    expect(text).toMatch(/Before round 1.*explicit review-slot grant.*review-open/);
    expect(text).toContain("guard commands do not provide a cross-worker browser lock");
    expect(text).toContain("**every browser operation**");
    for (const operation of ["round-0 probe", "review rounds and disputes", "coordinator acceptance reads", "chat cleanup"]) expect(text).toContain(operation);
    expect(text).toContain("waits for an explicit grant naming its dispatch");
    expect(text).toContain("Asking alone is not a grant");
    expect(text).toContain("Hold the slot through the entire probe or review/dispute exchange");
    expect(text).toContain("coordinator must also reserve the slot");
    expect(text).toContain("silence or timeout is not release");
  });

  it("allows repairs only after a successful exact-head ledger receipt and stops on every refusal", () => {
    const text = delegated();
    expect(text).toContain("Repair only after `repair-record` succeeds (`ok: true`, action `RECORDED` or `ALREADY_RECORDED`)");
    expect(text).toContain("for the exact issue, PR and reviewed head");
    expect(text).toMatch(/On \*\*every other result\*\*, error, timeout or unreadable receipt, \*\*stop immediately\*\*/);
    expect(text).toContain("do not edit, commit or push a repair");
    for (const refusal of ["LEASE_LOST", "PAUSED", "ISSUE_BLOCKED", "PR_HEAD_MISMATCH", "DIRTY_WORKTREE", "GITHUB_UNAVAILABLE"]) expect(text).toContain(refusal);
  });

  it("requires coordinator eligibility and authority checks before authorizing each exact-head review", () => {
    const text = delegated();
    expect(fleet).toContain("Before the round-0 probe or each review round");
    expect(fleet).toContain("completes the handoff checks and steps 1 and 2");
    expect(text).toContain("ensure the PR is open, non-draft and current, renew the lease and repeat plan authority");
    expect(text).toContain("exact issue, PR, dispatch and current head");
    expect(text).toContain("**not review authorization**");
    expect(text).toContain("A new head requires renewed coordinator authorization");
    expect(text).toContain("A previous round's grant cannot be reused");
  });

  it("stops on unsuccessful review recording and independently checks durable final chat provenance", () => {
    const text = delegated();
    expect(text).toContain("--url CHAT_URL --page PAGE_ID --head HEAD");
    expect(text).toContain("Require a successful `ok: true` receipt before continuing to wait, read, dispute or repair");
    expect(text).toMatch(/On any refusal.*error, timeout or ambiguous recording result, stop immediately/);
    expect(text).toContain("chat URL, page id, exact first message and receipt");
    expect(text).toContain("Independently inspect `GUARD orca resume-report --issue ISSUE`");
    expect(text).toContain("`reviewChats` must contain the final chat");
    expect(text).toContain("matching `url`, `page_id`, `head_sha`, `owner` and `run_id`");
    expect(text).toContain("A missing or mismatched durable record is **not approved**");
  });

  it("provides complete review and repair commands and requires full dispute history", () => {
    const text = delegated();
    expect(text).toContain("GUARD orca review-send --page PAGE_ID --message-file MESSAGE_FILE");
    expect(text).toContain("GUARD orca review-wait --page PAGE_ID");
    expect(text).toContain("GUARD auto repair-record --issue ISSUE --owner OWNER --run RUN_ID --pr PR --head REVIEWED_HEAD --findings-file FILE");
    expect(text).toContain("check the successful receipt's `pr` and `headSha`");
    expect(text).toContain("`review-read` returns only the latest assistant reply");
    expect(text).toContain("**insufficient to verify dispute history**");
    expect(text).toContain("inspect the complete exchange");
    expect(text).toContain("If the full history is unavailable or cannot be matched to the recorded chat, treat the review as **not approved**");
  });

  it("surfaces reviewer disputes and does not let the worker steer the verdict", () => {
    const text = delegated();
    expect(text).toMatch(/Every disagreement is reported to the coordinator verbatim/);
    expect(text).toMatch(/did not explicitly retract or downgrade stays open/);
    expect(text).toMatch(/must not steer the verdict/);
  });

  it("accepts a verdict only from the recorded chat on the exact head", () => {
    const text = delegated();
    expect(text).toMatch(/reviewed SHA == final head == PR head/);
    expect(text).toMatch(/from the recorded chat itself/);
    expect(text).toMatch(/Any later commit invalidates the review/);
    expect(text).toMatch(/treat it as \*\*not approved\*\*/);
    const accept = text.indexOf("## What the coordinator does with it");
    expect(accept).toBeGreaterThan(-1);
    expect(text.indexOf("auth-check --phase merge", accept)).toBeLessThan(text.indexOf("verify-head", accept));
    expect(text).toContain("--match-head-commit");
  });

  it("names no specific repository or product", () => {
    expect(delegated()).not.toMatch(/hockey|campsty|camping|region-viken|niclas-lindgren\/(?!orca)|RVV|season/i);
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
