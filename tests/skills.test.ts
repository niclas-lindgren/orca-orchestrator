// The skills are the operating procedure; these tests pin the safety rules that review found easy to
// lose when the text is edited.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(join(__dirname, "..", "skills", name, "SKILL.md"), "utf8");
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

describe("orca-flow", () => {
  it("routes the ChatGPT review through review-* and bans other browsers", () => {
    expect(flow).toMatch(/review-(open|send|wait)/);
    expect(flow).toMatch(/Chrome DevTools/i);
  });
  it("requires fresh review contexts, a final fresh pass, lease renewal and a handoff on takeover", () => {
    expect(flow).toMatch(/fresh context/i);
    expect(flow).toMatch(/final fresh-reviewer pass/i);
    expect(flow).toMatch(/auto -- renew/);
    for (const code of ["LEASE_CONFLICT", "DIRTY_WORKTREE", "HANDOFF"]) expect(flow).toContain(code);
  });
  it("renews before long waits and before verify-head", () => {
    expect(flow).toMatch(/after every `review-wait` returns/);
    expect(flow).toMatch(/immediately\s+before `verify-head`/);
    expect(flow).toContain("LEASE_LOST");
  });
  it("limits same-chat follow-ups to polling, consults and challenges", () => {
    expect(flow).toMatch(/only for polling an\s+incomplete reply/);
  });
  it("polls CI in bounded rounds with a lease renewal", () => {
    expect(flow).toMatch(/timeout 600 gh pr checks <pr> --watch --fail-fast/);
    expect(flow).not.toMatch(/Wait for `gh pr checks <pr> --watch/);
  });
  it("places the final fresh-reviewer pass before verify-head", () => {
    const finalPass = flow.search(/final fresh-reviewer pass/i);
    const verify = flow.indexOf("npm run orca -- verify-head");
    expect(finalPass).toBeGreaterThan(-1);
    expect(finalPass).toBeLessThan(verify);
  });
  it("deletes only chats whose first message it sent", () => {
    expect(flow).toMatch(/review-delete[^\n]*--message-file/);
    expect(flow).toMatch(/NOT_A_FLOW_CHAT/);
  });
});

describe("orca-fleet", () => {
  it("defers to orca-flow on every safety rule", () => {
    expect(fleet).toMatch(/`orca-flow` wins/);
  });
  it("registers each issue worktree as a child of the coordinator's worktree, after dispatch", () => {
    expect(fleet).toMatch(/--parent-worktree/);
    expect(fleet.indexOf("npm run orca -- dispatch")).toBeLessThan(fleet.indexOf("orca worktree set"));
  });
  it("makes the conformance preflight stop the fleet before any claim", () => {
    expect(fleet).toMatch(/Checks 1-3 are mandatory/);
    expect(fleet).toMatch(/claim nothing/);
    expect(fleet).toMatch(/check 4 never blocks the run/);
  });
  it("invalidates review on any rebase", () => {
    expect(fleet).toMatch(/Any rebase produces a new head and invalidates every earlier review/);
  });
  it("keeps every claimed lease alive and bounds foreground commands", () => {
    expect(fleet).toMatch(/renew \*\*every\*\* claimed issue/);
    expect(fleet).toMatch(/never let more than 15 minutes pass/);
    expect(fleet).toMatch(/timeout 300/);
  });
  it("stops process groups and the Orca worker on lease loss before a handoff", () => {
    expect(fleet).toMatch(/setsid/);
    expect(fleet).toMatch(/kill -TERM -<pgid>/);
    expect(fleet).toMatch(/`worker-stop`/);
    expect(fleet).toMatch(/Ordinary gate, CI or review failure[^\n]*keep the lease/);
  });
  it("fails closed on chat cleanup when first-message matching is not enforced", () => {
    expect(fleet).toMatch(/Fail closed/);
    expect(fleet).toMatch(/Never substitute a manual `review-read` comparison/);
  });
  it("never reverts a tracked lease store", () => {
    expect(fleet).toMatch(/git ls-files \.local\/auto/);
  });
  it("carries the dispatch recovery table and refuses to delete a record blindly", () => {
    expect(fleet).toMatch(/DISPATCH_RECORD_EXISTS/);
    expect(fleet).toMatch(/Never delete it because `worker-list` shows no worker/);
  });
});
