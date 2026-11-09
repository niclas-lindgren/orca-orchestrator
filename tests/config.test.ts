import { describe, expect, it } from "vitest";
import { ConfigError, normalizeConfig, requireSetting, setActiveConfig } from "../src/config.mjs";
import { classify } from "../src/auto/authority.mjs";

describe("config", () => {
  it("applies defaults and freezes the result", () => {
    const config = normalizeConfig({ gate: { command: "make", args: ["check"] } });
    expect(config.defaultBranch).toBe("main");
    expect(config.stateDir).toBe(".local/auto");
    expect(config.gate.label).toBe("make check");
    expect(Object.isFrozen(config)).toBe(true);
  });
  it.each([
    [{ gate: { command: "make" } }, /gate must be/],
    [{ review: { projectId: "g-p-1" } }, /review.projectName/],
    [{ protectedDomains: [{ id: "x", paths: ["("] }] }, /invalid pattern/],
    [{ protectedDomains: [{ labels: [] }] }, /id must be/],
    [{ workerInstructions: "no" }, /workerInstructions/],
    ["not an object", /JSON object/],
  ])("rejects an invalid config %#", (raw, message) => {
    expect(() => normalizeConfig(raw as never)).toThrow(message);
  });
  it("names the missing setting when a command needs one", () => {
    setActiveConfig(normalizeConfig({}));
    expect(() => requireSetting("gate")).toThrow(ConfigError);
    expect(() => requireSetting("review.projectId")).toThrow(/must define "review.projectId"/);
  });
  it("flags nothing when no protected domains are configured", () => {
    setActiveConfig(normalizeConfig({}));
    const issue = { title: "Change the refund window", body: "", labels: [{ name: "pricing" }], comments: [] };
    expect(classify({ issue })).toMatchObject({ result: "CLEAR", domains: [] });
  });
  it("flags a configured domain by label, title word and path", () => {
    const cfg = normalizeConfig({
      protectedDomains: [{ id: "billing", labels: ["Billing"], words: ["invoice"], paths: ["^src/billing/"] }],
    });
    setActiveConfig(cfg);
    expect(classify({ issue: { title: "x", labels: [{ name: "billing" }], comments: [] } }).domains).toEqual(["billing"]);
    expect(classify({ issue: { title: "Fix invoice rounding", labels: [], comments: [] } }).domains).toEqual(["billing"]);
    expect(classify({ issue: { title: "x", labels: [], comments: [] }, files: ["src/billing/a.ts"] }).domains).toEqual(["billing"]);
    expect(classify({ issue: { title: "x", body: "mentions an invoice", labels: [], comments: [] } })).toMatchObject({ result: "CLEAR" });
  });
});

describe("config root", () => {
  it("prefers a linked worktree's own config and keeps state in the main checkout", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { loadConfig, resolveConfigRoot, resolveRepoRoot } = await import("../src/config.mjs");
    const main = realpathSync(mkdtempSync(join(tmpdir(), "cfgroot-")));
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
    try {
      git(main, "init", "-q", "-b", "main");
      git(main, "config", "user.email", "t@example.com");
      git(main, "config", "user.name", "t");
      writeFileSync(join(main, "a.txt"), "a");
      git(main, "add", "a.txt");
      git(main, "commit", "-q", "-m", "init");
      const wt = join(main, ".worktrees", "issue-1");
      mkdirSync(join(main, ".worktrees"));
      git(main, "worktree", "add", "-q", "-b", "agent/issue-1", wt);
      // No config anywhere: the main checkout is the fallback.
      expect(resolveConfigRoot(wt, resolveRepoRoot(wt))).toBe(main);
      writeFileSync(join(wt, "orca.config.json"), JSON.stringify({ defaultBranch: "trunk" }));
      expect(resolveRepoRoot(wt)).toBe(main);
      expect(resolveConfigRoot(wt, main)).toBe(wt);
      const config = loadConfig(resolveConfigRoot(wt, main), { repoRoot: main });
      expect(config.defaultBranch).toBe("trunk");
      expect(config.repoRoot).toBe(main);
    } finally {
      rmSync(main, { recursive: true, force: true });
    }
  });
});
