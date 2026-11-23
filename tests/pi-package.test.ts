import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const extension = readFileSync(join(root, "extensions", "orca.ts"), "utf8");
const mcp = readFileSync(join(root, "bin", "orca-orchestrator-mcp.mjs"), "utf8");

describe("Pi package", () => {
  it("declares the extension, canonical skills and host peer dependencies", () => {
    expect(pkg.keywords).toContain("pi-package");
    expect(pkg.pi).toEqual({ extensions: ["./extensions/orca.ts"], skills: ["./skills"] });
    expect(pkg.peerDependencies).toMatchObject({
      "@earendil-works/pi-coding-agent": "*",
      typebox: "*",
    });
    expect(pkg.files).toEqual(expect.arrayContaining([".claude-plugin", ".mcp.json", "extensions", "skills", "CHANGELOG.md"]));
  });

  it("keeps status read-only and exposes only allowlisted bundled guards", () => {
    expect(extension).toContain('name: "orca_status"');
    expect(extension).toContain('name: "orca_guard"');
    expect(extension).toContain('const args = [cliPath, "auto", "status"]');
    expect(extension).toContain("timeout: 15_000");
    expect(extension).toContain("output.slice(0, 20_000)");
    expect(extension).toContain("ALLOWED[params.group].has(params.command)");
    expect(extension).toContain("[cliPath, params.group, params.command");
    expect(extension).toContain('"bind-native", "unbind-native"');
    expect(extension).toContain('"review-send", "review-wait", "review-read", "review-delete"');
    expect(extension).not.toContain("npm run");
  });

  it("loads the Pi-only model seam and routes provider failures to one canonical reference", () => {
    expect(extension).toContain('registerModelControl(pi)');
    expect(pkg.files).toContain("src");
    const flow = readFileSync(join(root, "skills/orca-flow/SKILL.md"), "utf8");
    const reference = readFileSync(join(root, "skills/orca-flow/references/model-control.md"), "utf8");
    expect(flow).toContain("references/model-control.md");
    expect(reference).toContain("If native Orca provides dispatch-addressed live Pi model control, use it.");
    expect(reference).toContain("There is no default provider order.");
    expect(reference).toContain("does not sandbox mutually untrusted processes");
    expect(reference).toContain("never starts/stops/retries workers");
  });

  it("bounds and cancels Claude MCP guard subprocesses", () => {
    expect(mcp).toContain("COMMAND_TIMEOUT_MS");
    expect(mcp).toContain('method === "notifications/cancelled"');
    expect(mcp).toContain("process.kill(-child.pid");
    expect(mcp).toContain('error(id, -32800');
  });
});
