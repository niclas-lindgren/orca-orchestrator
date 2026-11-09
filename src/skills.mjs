// Installing the shipped skills into a repository. The skills are copied (not linked) so that agent
// harnesses discover them in the repository, and every copy is byte-compared with the shipped one so a
// stale or hand-edited copy is reported rather than silently diverging.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SHIPPED = fileURLToPath(new URL("../skills", import.meta.url));

export const shippedSkills = () =>
  readdirSync(SHIPPED).filter((name) => statSync(join(SHIPPED, name)).isDirectory() && existsSync(join(SHIPPED, name, "SKILL.md")));

export function installSkills(dir) {
  mkdirSync(dir, { recursive: true });
  const installed = shippedSkills();
  for (const name of installed) cpSync(join(SHIPPED, name), join(dir, name), { recursive: true });
  return { ok: true, dir, installed };
}

export function checkSkills(dir) {
  const missing = [];
  const differing = [];
  for (const name of shippedSkills()) {
    const target = join(dir, name, "SKILL.md");
    if (!existsSync(target)) missing.push(name);
    else if (readFileSync(target, "utf8") !== readFileSync(join(SHIPPED, name, "SKILL.md"), "utf8")) differing.push(name);
  }
  return { ok: !missing.length && !differing.length, dir, missing, differing };
}
