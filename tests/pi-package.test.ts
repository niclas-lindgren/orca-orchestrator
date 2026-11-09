import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const extension = readFileSync(join(root, "extensions", "orca.ts"), "utf8");

describe("Pi package", () => {
  it("declares the extension, canonical skills and host peer dependencies", () => {
    expect(pkg.keywords).toContain("pi-package");
    expect(pkg.pi).toEqual({ extensions: ["./extensions/orca.ts"], skills: ["./skills"] });
    expect(pkg.peerDependencies).toMatchObject({
      "@earendil-works/pi-coding-agent": "*",
      typebox: "*",
    });
    expect(pkg.files).toEqual(expect.arrayContaining(["extensions", "skills", "CHANGELOG.md"]));
  });

  it("keeps the Pi-native tool read-only and bounded", () => {
    expect(extension).toContain('name: "orca_status"');
    expect(extension).toContain('const args = [cliPath, "auto", "status"]');
    expect(extension).toContain("timeout: 15_000");
    expect(extension).toContain("output.slice(0, 20_000)");
    expect(extension).not.toContain('"review-delete"');
    expect(extension).not.toContain('"claim"');
  });
});
