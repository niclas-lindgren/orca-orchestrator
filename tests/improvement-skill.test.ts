import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const skill = readFileSync(join(root, "skills", "orca-improve", "SKILL.md"), "utf8");
const workflow = readFileSync(join(root, ".github", "workflows", "replay.yml"), "utf8");

describe("improvement proposer boundaries", () => {
  it("ships a canonical portable Pi skill", () => {
    expect(skill).toMatch(/^---\nname: orca-improve\ndescription: .+\n---/);
    expect(skill).not.toMatch(/niclas-lindgren|g-p-[0-9a-z]+/);
    expect(skill).toContain("learn packet");
    expect(skill).toContain("gh pr create --draft");
  });

  it("requires independent review and prohibits agent self-authorization", () => {
    expect(skill).toContain("independent reviewer");
    expect(skill).toContain("Never loosen tests or disable checks");
    expect(skill).toMatch(/do not mark the PR ready/i);
    expect(skill).toContain("self-approve");
    expect(skill).toContain("auto-merge");
    expect(skill).toContain("protect");
    expect(skill).toContain("credentials");
  });

  it("requires human input for protected changes and avoids private evidence leaks", () => {
    expect(skill).toMatch(/stop and request human\s+direction/i);
    expect(skill).toMatch(/private\s+project to a public repository/i);
    expect(skill).toContain("No raw transcripts");
    expect(skill).toMatch(/evaluate \*\*exact\*\*/);
  });
});

describe("trusted base-branch replay job", () => {
  it("checks candidate SHA against trusted base evaluator with read-only permissions", () => {
    expect(workflow).toContain("pull_request:");
    expect(workflow).not.toContain("pull_request_target");
    expect(workflow).toMatch(/permissions:\s*\n\s+contents: read/);
    expect(workflow).toContain("name: Contract replay");
    expect(workflow).toContain("trusted/bin/orca-orchestrator.mjs");
    expect(workflow).toContain("trusted/evals/replay-v1.json");
    expect(workflow).toContain("github.event.pull_request.base.sha");
    expect(workflow).toContain("github.event.pull_request.head.sha");
    expect(workflow.match(/persist-credentials: false/g)).toHaveLength(3);
    expect(workflow).not.toMatch(/secrets\.|GITHUB_TOKEN:|id-token: write/);
  });
});
