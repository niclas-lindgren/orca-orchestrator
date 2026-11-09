import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkSkills, installSkills, shippedSkills } from "../src/skills.mjs";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "skills-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("skills install", () => {
  it("ships orca-flow and orca-fleet", () => {
    expect(shippedSkills().sort()).toEqual(["orca-fleet", "orca-flow"]);
  });
  it("copies every shipped skill and then checks clean", () => {
    expect(installSkills(dir)).toMatchObject({ ok: true });
    expect(checkSkills(dir)).toMatchObject({ ok: true, missing: [], differing: [] });
  });
  it("reports a missing skill and a hand-edited one", () => {
    installSkills(dir);
    writeFileSync(join(dir, "orca-flow", "SKILL.md"), `${readFileSync(join(dir, "orca-flow", "SKILL.md"), "utf8")}\nedit\n`);
    rmSync(join(dir, "orca-fleet"), { recursive: true });
    expect(checkSkills(dir)).toEqual({ ok: false, dir, missing: ["orca-fleet"], differing: ["orca-flow"] });
  });
});

describe("skills install in a linked worktree", () => {
  it("writes into the worktree it runs in, not the main checkout", async () => {
    const { execFileSync } = await import("node:child_process");
    const { existsSync, mkdirSync, realpathSync } = await import("node:fs");
    const bin = join(process.cwd(), "bin", "orca-orchestrator.mjs");
    const main = realpathSync(mkdtempSync(join(tmpdir(), "wt-install-")));
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
    try {
      git(main, "init", "-q", "-b", "main");
      git(main, "config", "user.email", "t@example.com");
      git(main, "config", "user.name", "t");
      writeFileSync(join(main, "a.txt"), "a");
      git(main, "add", "a.txt");
      git(main, "commit", "-q", "-m", "init");
      mkdirSync(join(main, ".worktrees"));
      const wt = join(main, ".worktrees", "issue-1");
      git(main, "worktree", "add", "-q", "-b", "agent/issue-1", wt);
      const out = JSON.parse(execFileSync("node", [bin, "install-skills"], { cwd: wt, encoding: "utf8" }));
      expect(realpathSync(out.dir)).toBe(join(wt, ".agents", "skills"));
      expect(existsSync(join(wt, ".agents", "skills", "orca-flow", "SKILL.md"))).toBe(true);
      expect(existsSync(join(main, ".agents"))).toBe(false);
    } finally {
      rmSync(main, { recursive: true, force: true });
    }
  });
});
