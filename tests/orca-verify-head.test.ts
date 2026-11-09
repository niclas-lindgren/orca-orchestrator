import { describe, expect, it } from "vitest";
import { main, parseArgs } from "../src/orca/cli.mjs";
import { verifyHead } from "../src/orca/verify-head.mjs";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const pr = { number: 123, state: "OPEN", isDraft: false, baseRefName: "main",
  headRefName: "agent/issue-55", headRefOid: HEAD,
  url: "https://github.com/niclas-lindgren/camping-booking/pull/123" };
const reply = (stdout: string, status = 0) =>
  ({ status, stdout, stderr: status ? "command failed" : "" });

type Exec = (command: string, args: string[], cwd: string) =>
  { status: number | null; stdout: string; stderr: string };
function fixture(opts: {
  firstPR?: Record<string, unknown>;
  secondPR?: Record<string, unknown>;
  branch?: string;
  head?: string;
  status?: string;
  fetchStatus?: number;
  trackingBase?: string;
  remoteBase?: string[];
  verifyStatus?: number;
} = {}) {
  const calls: string[] = [];
  let views = 0;
  let lsRemotes = 0;
  const exec: Exec = (command, args, cwd) => {
    calls.push(command + " " + args.join(" ") + " @ " + cwd);
    if (command === "gh" && args[0] === "pr") {
      views++;
      return reply(JSON.stringify(views === 1 ? (opts.firstPR ?? pr) : (opts.secondPR ?? pr)));
    }
    if (command === "npm") return reply("verification output", opts.verifyStatus ?? 0);
    if (command === "gh" && args[0] === "api") {
      calls.push("api-path " + args[1]);
      const bases = opts.remoteBase ?? [BASE, BASE];
      return reply(bases[Math.min(lsRemotes++, bases.length - 1)] + "\n");
    }
    if (args[0] === "branch") return reply(opts.branch ?? pr.headRefName);
    if (args[0] === "rev-parse") return reply(args[1] === "refs/remotes/origin/main" ?
      (opts.trackingBase ?? BASE) : (opts.head ?? HEAD));
    if (args[0] === "fetch") return reply("", opts.fetchStatus ?? 0);
    if (args[0] === "status") return reply(opts.status ?? "");
    throw new Error("Unexpected command: " + command + " " + args.join(" "));
  };
  return { calls, exec, run: () => verifyHead({ repoRoot: "/repo", issue: 55, pr: 123, exec }) };
}

describe("Orca coordinator verify-head", () => {
  it("independently runs verify on the clean exact PR head and checks it again", () => {
    const f = fixture();
    expect(f.run()).toMatchObject({ ok: true, head: HEAD, verified: "npm run verify" });
    expect(f.calls.filter(call => call.startsWith("npm run verify"))).toEqual([
      "npm run verify @ /repo/.worktrees/issue-55",
    ]);
    expect(f.calls.filter(call => call.startsWith("gh pr view"))).toHaveLength(2);
  });
  it("reads the base from the repository named by the PR URL", () => {
    const f = fixture();
    f.run();
    expect(f.calls).toContain("api-path repos/niclas-lindgren/camping-booking/git/ref/heads/main");
  });
  it("refuses when the PR URL or base lookup is unusable", () => {
    expect(fixture({ firstPR: { ...pr, url: "https://example.test/x" } }).run()).toMatchObject({ code: "PR_UNREADABLE" });
    expect(fixture({ remoteBase: ["not-a-sha"] }).run()).toMatchObject({ code: "PR_UNREADABLE" });
  });
  it("blocks a stale local head or dirty worktree before verification", () => {
    for (const opts of [{ head: "c".repeat(40) }, { status: " M src/foo.ts" }]) {
      const f = fixture(opts);
      expect(f.run().ok).toBe(false);
      expect(f.calls.some(call => call.startsWith("npm"))).toBe(false);
    }
  });
  it("refuses draft, incorrect target or wrong issue branch", () => {
    for (const change of [{ isDraft: true }, { baseRefName: "develop" }, { headRefName: "agent/issue-99" }]) {
      const f = fixture({ firstPR: { ...pr, ...change } });
      expect(f.run()).toMatchObject({ ok: false, code: "PR_NOT_ELIGIBLE" });
      expect(f.calls.some(call => call.startsWith("npm"))).toBe(false);
    }
  });
  it("requires a refreshed matching base", () => {
    expect(fixture({ fetchStatus: 1 }).run()).toMatchObject({ ok: false, code: "BASE_FETCH_FAILED" });
    expect(fixture({ trackingBase: "c".repeat(40) }).run()).toMatchObject({ ok: false, code: "STALE_BASE" });
  });
  it("fails closed on a nonzero test/lint/quality gate", () => {
    expect(fixture({ verifyStatus: 1 }).run()).toMatchObject({ ok: false, code: "VERIFICATION_FAILED" });
  });
  it("invalidates verification if head or base moves during the run", () => {
    expect(fixture({ secondPR: { ...pr, headRefOid: "c".repeat(40) } }).run().ok).toBe(false);
    expect(fixture({ remoteBase: [BASE, "d".repeat(40)] }).run().ok).toBe(false);
  });
  it("validates CLI flags and routes to the coordinator without looking up issue title", () => {
    const args = ["verify-head", "--issue", "55", "--owner", "claude", "--run", "r", "--pr", "123"];
    expect(parseArgs(args)).toMatchObject({ command: "verify-head", issue: 55, pr: 123 });
    expect(parseArgs(args.slice(0, -2)).error).toBe("--pr must be a positive integer");
    const f = fixture();
    expect(main(args, { repoRoot: "/repo", exec: f.exec })).toMatchObject({
      code: 0, result: { ok: true, head: HEAD },
    });
    expect(f.calls.some(call => call.startsWith("gh issue view"))).toBe(false);
  });
});
