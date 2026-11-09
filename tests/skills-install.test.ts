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
