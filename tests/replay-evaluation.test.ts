import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareResults, runEvaluation, validateSuite } from "../src/eval/replay.mjs";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "orca-replay-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const one = (overrides: Record<string, unknown> = {}) => ({
  id: "authority-guard", tier: "safety", probe: "authority",
  input: { domains: [{ id: "billing", labels: ["billing"], words: ["invoice"], paths: [] }],
    issue: { title: "Invoice", body: "", labels: [], comments: [] } },
  expected: { result: "REQUIRES_FOUNDER", domains: ["billing"] },
  ...overrides,
});
const suite = (cases = [one()]) => ({ version: 1, cases });
const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

function checkout(name: string, blocked: boolean) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "tester@example.com");
  git(dir, "config", "user.name", "tester");
  mkdirSync(join(dir, "src", "auto"), { recursive: true });
  writeFileSync(join(dir, "src", "config.mjs"), String.raw`export function normalizeConfig(raw) { return {defaultBranch:raw.defaultBranch ?? 'main',stateDir:raw.stateDir ?? '.local/auto',protectedDomains:raw.protectedDomains ?? []} }`);
  writeFileSync(join(dir, "src", "auto", "authority.mjs"),
    `export function classify() { return {result:'${blocked ? "REQUIRES_FOUNDER" : "CLEAR"}',domains:${blocked ? "['billing']" : "[]"}} }`);
  writeFileSync(join(dir, "src", "auto", "findings.mjs"),
    "export const qaFindingKeys = () => ['qa:unspecified']; export const reviewFindingKeys = () => ['review:unspecified'];");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "test module");
  return { dir, sha: git(dir, "rev-parse", "HEAD") };
}

function evaluate(baseline: ReturnType<typeof checkout>, candidate: ReturnType<typeof checkout>, overrides: Record<string, string> = {}) {
  const file = join(root, "suite.json");
  writeFileSync(file, JSON.stringify(suite()));
  return runEvaluation([
    "--suite", file,
    "--baseline", baseline.dir,
    "--baseline-sha", baseline.sha,
    "--candidate", candidate.dir,
    "--candidate-sha", candidate.sha,
    ...Object.entries(overrides).flatMap(([k, v]) => [k, v]),
  ]);
}

describe("suite validation", () => {
  it("requires an allowlisted, nonempty, uniquely named suite with safety coverage", () => {
    expect(validateSuite(suite()).suite).toBeDefined();
    expect(validateSuite(suite([])).error).toBeTruthy();
    expect(validateSuite(suite([one(), one()])).error).toBeTruthy();
    expect(validateSuite(suite([one({ id: "case", tier: "quality" })])).error).toMatch(/safety/);
    expect(validateSuite(suite([one({ probe: "shell" })])).error).toBeTruthy();
    expect(validateSuite(suite([one({ probe: "head-verification", input: { scenario: "unknown" },
      expected: { ok: false, code: "STALE_HEAD" } })])).error).toBeTruthy();
    expect(validateSuite(suite([one({ expected: { ok: true } })])).error).toBeTruthy();
    expect(validateSuite({ version: 2, cases: [one()] }).error).toBeTruthy();
  });
  it("does not let the candidate define a new expected verdict or arbitrary JS", () => {
    expect(validateSuite(suite([one({ command: "rm -rf" })])).error).toBeTruthy();
    expect(validateSuite(suite([one({ expected: { result: "UNKNOWN", domains: [] } })])).error).toBeTruthy();
  });
});

describe("comparison", () => {
  it("distinguishes a candidate improvement, regression and unresolved case", () => {
    const good = { id: "authority-guard", ok: true, actual: one().expected };
    const bad = { id: "authority-guard", ok: true, actual: { result: "CLEAR", domains: [] } };
    expect(compareResults(suite(), [bad], [good]).cases[0].verdict).toBe("IMPROVED");
    expect(compareResults(suite(), [good], [bad])).toMatchObject({
      eligible: false, counts: { regressions: 1, safetyRegressions: 1 },
    });
    expect(compareResults(suite(), [bad], [bad])).toMatchObject({
      eligible: false, counts: { unresolved: 1, safetyRegressions: 1 },
    });
  });
});

describe("trusted worker integration", () => {
  it("runs the same trusted safety case against two exact commits", () => {
    const old = checkout("old", false);
    const next = checkout("next", true);
    const result = evaluate(old, next);
    expect(result).toMatchObject({
      code: 0, result: {
        ok: true, verdict: "EVAL_PASS", baselineSha: old.sha, candidateSha: next.sha,
        counts: { total: 1, passed: 1, improved: 1, regressions: 0, safetyRegressions: 0 },
        cases: [{ id: "authority-guard", baselinePass: false, candidatePass: true, verdict: "IMPROVED" }],
      },
    });
    expect(result.result.suiteSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a candidate regression even if the baseline passes", () => {
    const old = checkout("old", true);
    const next = checkout("next", false);
    expect(evaluate(old, next)).toMatchObject({
      code: 1, result: {
        ok: false, verdict: "EVAL_FAIL",
        counts: { safetyRegressions: 1, regressions: 1 },
      },
    });
  });

  it("fails closed on mismatched HEAD and dirty worktrees", () => {
    const old = checkout("old", true);
    const next = checkout("next", true);
    const file = join(root, "suite.json");
    writeFileSync(file, JSON.stringify(suite()));
    const invalidSha = runEvaluation(["--suite", file, "--baseline", old.dir,
      "--baseline-sha", "0".repeat(40), "--candidate", next.dir, "--candidate-sha", next.sha]);
    expect(invalidSha.result.code).toBe("BASELINE_INVALID");
    writeFileSync(join(next.dir, "untracked.txt"), "dirty");
    expect(evaluate(old, next).result.code).toBe("CANDIDATE_INVALID");
  });

  it("rejects unknown command flags and missing/oversized suite", () => {
    expect(runEvaluation([]).code).toBe(2);
    expect(runEvaluation(["--suite", "missing"]).code).toBe(2);
    const old = checkout("old", true);
    const next = checkout("next", true);
    const file = join(root, "suite.json");
    writeFileSync(file, "x".repeat(524289));
    expect(runEvaluation(["--suite", file, "--baseline", old.dir,
      "--baseline-sha", old.sha, "--candidate", next.dir, "--candidate-sha", next.sha]).result.error)
      .toMatch(/512 KiB/);
  });

  it("detects edits made by probe code and refuses to promote", () => {
    const old = checkout("old", true);
    const next = checkout("next", true);
    // A candidate module creates an untracked file on import. The evaluator must
    // reject the run after execution, even if all returned answers are correct.
    const marker = join(next.dir, "sentinel.txt");
    writeFileSync(join(next.dir, "src", "auto", "authority.mjs"),
      "import { writeFileSync } from 'node:fs'; writeFileSync(" +
      JSON.stringify(marker) + ",'changed'); " +
      "export const classify = () => ({result:'REQUIRES_FOUNDER',domains:['billing']});");
    git(next.dir, "add", ".");
    git(next.dir, "commit", "-qm", "write a marker on import");
    next.sha = git(next.dir, "rev-parse", "HEAD");
    expect(evaluate(old, next).result.code).toBe("CHECKOUT_CHANGED");
  });
});
