import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareResults, validateSuite } from "../src/eval/replay.mjs";

const root = join(import.meta.dirname, "..");

describe("the shipped replay corpus", () => {
  it("is a valid suite, covers safety boundaries and passes against the actual Orca implementation", () => {
    const suite = JSON.parse(readFileSync(join(root, "evals", "replay-v1.json"), "utf8"));
    expect(validateSuite(suite).error).toBeUndefined();
    expect(suite.cases.filter((item: { tier: string }) => item.tier === "safety").length).toBeGreaterThanOrEqual(5);
    const executed = spawnSync(process.execPath, [join(root, "src", "eval", "replay-worker.mjs"), root], {
      input: JSON.stringify({ cases: suite.cases }),
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
      env: { PATH: process.env.PATH ?? "", CI: "true", NO_COLOR: "1" },
    });
    expect(executed.status, executed.stderr).toBe(0);
    const output = JSON.parse(executed.stdout);
    expect(output.results).toHaveLength(suite.cases.length);
    const evaluation = compareResults(suite, output.results, output.results);
    expect(evaluation.eligible, JSON.stringify(evaluation.cases.filter((c) => !c.candidatePass))).toBe(true);
    expect(evaluation.counts).toMatchObject({ safetyRegressions: 0, regressions: 0, passed: suite.cases.length });
  });
});
