// Trusted, deterministic replay controller. It compares two immutable, clean
// Git checkouts against one caller-supplied (trusted) suite. No benchmark score is
// accepted from the candidate implementation or used as a merge authorization.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHA = /^[0-9a-f]{40}$/;
const ID = /^[a-z][a-z0-9._-]{0,79}$/;
const PROBES = new Set(["authority", "qa-findings", "review-findings", "config"]);
const TIERS = new Set(["safety", "quality"]);
const MAX_SUITE_BYTES = 512 * 1024;
const MAX_CASES = 200;
const WORKER = fileURLToPath(new URL("./replay-worker.mjs", import.meta.url));

const refusal = (code, error) => ({ code: 1, result: { ok: false, code, error } });
const invalid = (error) => ({ code: 2, result: { ok: false, code: "INVALID_ARGS", error } });
const plain = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const onlyKeys = (value, keys) => Object.keys(value).every((k) => keys.includes(k));

function hasJsonShape(value, kind) {
  if (!plain(value)) return false;
  if (kind === "authority")
    return onlyKeys(value, ["result", "domains"]) &&
      ["CLEAR", "REQUIRES_FOUNDER"].includes(value.result) &&
      Array.isArray(value.domains) && value.domains.every((v) => typeof v === "string");
  if (kind === "qa-findings" || kind === "review-findings")
    return onlyKeys(value, ["keys"]) && Array.isArray(value.keys) &&
      value.keys.every((v) => typeof v === "string");
  if (kind === "config")
    return (onlyKeys(value, ["defaultBranch", "stateDir"]) &&
      typeof value.defaultBranch === "string" && typeof value.stateDir === "string") ||
      (onlyKeys(value, ["errorCode"]) && value.errorCode === "CONFIG_INVALID");
  return false;
}

/** A suite is trusted test data, not code. The candidate checkout never supplies it. */
export function validateSuite(value) {
  if (!plain(value) || !onlyKeys(value, ["version", "cases"]) ||
      value.version !== 1 || !Array.isArray(value.cases) ||
      value.cases.length < 1 || value.cases.length > MAX_CASES)
    return { error: "suite must have version 1 and 1-200 cases" };
  const ids = new Set();
  let safety = 0;
  for (const item of value.cases) {
    if (!plain(item) || !onlyKeys(item, ["id", "tier", "probe", "input", "expected"]) ||
        typeof item.id !== "string" || !ID.test(item.id) || ids.has(item.id) ||
        !TIERS.has(item.tier) || !PROBES.has(item.probe) ||
        !plain(item.input) || !hasJsonShape(item.expected, item.probe))
      return { error: "invalid or duplicate case id, tier, probe, input, or expected" };
    if (item.tier === "safety") safety++;
    ids.add(item.id);
  }
  if (safety === 0) return { error: "suite must include at least one safety case" };
  return { suite: value };
}

function parseFlags(argv) {
  if (argv.length % 2) return { error: "expected flag/value pairs" };
  const keys = ["--suite", "--baseline", "--baseline-sha", "--candidate", "--candidate-sha"];
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!keys.includes(key) || flags[key] || typeof argv[i + 1] !== "string" ||
        !argv[i + 1] || argv[i + 1].startsWith("--"))
      return { error: "invalid, duplicate, or missing flag " + key };
    flags[key] = argv[i + 1];
  }
  if (keys.some((key) => !flags[key])) return { error: "required: " + keys.join(", ") };
  if (!SHA.test(flags["--baseline-sha"]) || !SHA.test(flags["--candidate-sha"]))
    return { error: "baseline and candidate must have full lowercase 40-character commit SHAs" };
  return { flags };
}

function execGit(cwd, args) {
  const output = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH ?? "" },
  });
  return output.status === 0 ? (output.stdout ?? "").trim() : null;
}

function checkCheckout(path, sha) {
  let dir;
  try {
    dir = realpathSync(resolve(path));
    if (!statSync(dir).isDirectory()) throw Error("not a directory");
  } catch {
    return { error: "checkout does not exist or is unreadable" };
  }
  const root = execGit(dir, ["rev-parse", "--show-toplevel"]);
  if (!root) return { error: "not a Git checkout" };
  try {
    if (realpathSync(root) !== dir) return { error: "path must be the checkout root" };
  } catch {
    return { error: "Git root is unreadable" };
  }
  const head = execGit(dir, ["rev-parse", "HEAD"]);
  if (head !== sha) return { error: "HEAD is not the requested immutable commit" };
  const dirty = execGit(dir, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (dirty === null || dirty !== "") return { error: "checkout is dirty or Git status failed" };
  return { dir };
}

function stable(value) {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object")
    return "{" + Object.keys(value).sort().map((key) =>
      JSON.stringify(key) + ":" + stable(value[key])).join(",") + "}";
  return JSON.stringify(value);
}

function runProbes(dir, cases, { exec = spawnSync } = {}) {
  const proc = exec(process.execPath, [WORKER, dir], {
    input: JSON.stringify({ cases }),
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
    // Never forward ambient tokens or credentials to experiment code.
    env: { PATH: process.env.PATH ?? "", CI: "true", NO_COLOR: "1" },
  });
  if (proc.status !== 0) return { error: "probe worker failed (" +
    (proc.error?.code ?? proc.status ?? "unknown") + ")" };
  let data;
  try { data = JSON.parse(proc.stdout); }
  catch { return { error: "probe worker returned invalid JSON" }; }
  if (!plain(data) || !Array.isArray(data.results) || data.results.length !== cases.length)
    return { error: "probe worker returned missing or extra results" };
  if (data.results.some((row, i) =>
    !plain(row) || row.id !== cases[i].id || typeof row.ok !== "boolean" ||
    (row.ok && !plain(row.actual)) || (!row.ok && typeof row.error !== "string")))
    return { error: "probe worker returned malformed or mismatched results" };
  return { results: data.results };
}

/** An immutable replay verdict; zero safety regressions alone is never sufficient for promotion. */
export function compareResults(suite, baseline, candidate) {
  const rows = suite.cases.map((c, i) => {
    const old = baseline[i];
    const next = candidate[i];
    const baselinePass = old.ok && stable(old.actual) === stable(c.expected);
    const candidatePass = next.ok && stable(next.actual) === stable(c.expected);
    const verdict = candidatePass
      ? baselinePass ? "PASS" : "IMPROVED"
      : baselinePass ? "REGRESSION" : "UNRESOLVED";
    return {
      id: c.id, tier: c.tier, probe: c.probe, baselinePass, candidatePass, verdict,
      ...(candidatePass ? {} : { candidateResult: next.ok ? next.actual : { error: next.error } }),
    };
  });
  const counts = {
    total: rows.length,
    passed: rows.filter((x) => x.candidatePass).length,
    improved: rows.filter((x) => x.verdict === "IMPROVED").length,
    regressions: rows.filter((x) => x.verdict === "REGRESSION").length,
    safetyRegressions: rows.filter((x) => x.tier === "safety" && !x.candidatePass).length,
    unresolved: rows.filter((x) => x.verdict === "UNRESOLVED").length,
  };
  return { counts, cases: rows, eligible: counts.passed === counts.total };
}

/** Trusted evaluator must run outside both candidate and baseline checkouts. */
export function runEvaluation(argv, { evaluate = runProbes } = {}) {
  const parsed = parseFlags(argv);
  if (parsed.error) return invalid(parsed.error);
  const flags = parsed.flags;
  let bytes;
  try {
    if (statSync(flags["--suite"]).size > MAX_SUITE_BYTES)
      return invalid("suite exceeds the 512 KiB limit");
    bytes = readFileSync(flags["--suite"]);
  } catch {
    return invalid("suite is missing or unreadable");
  }
  let raw;
  try { raw = JSON.parse(bytes.toString("utf8")); }
  catch { return invalid("suite must be valid JSON"); }
  const checked = validateSuite(raw);
  if (checked.error) return invalid(checked.error);
  const baseline = checkCheckout(flags["--baseline"], flags["--baseline-sha"]);
  const candidate = checkCheckout(flags["--candidate"], flags["--candidate-sha"]);
  if (baseline.error) return refusal("BASELINE_INVALID", baseline.error);
  if (candidate.error) return refusal("CANDIDATE_INVALID", candidate.error);
  if (baseline.dir === candidate.dir)
    return invalid("baseline and candidate must be distinct checkout directories");
  const suiteHash = createHash("sha256").update(bytes).digest("hex");
  const before = { baselineSha: flags["--baseline-sha"], candidateSha: flags["--candidate-sha"] };
  const old = evaluate(baseline.dir, checked.suite.cases);
  if (old.error) return refusal("BASELINE_PROBE_FAILED", old.error);
  const next = evaluate(candidate.dir, checked.suite.cases);
  if (next.error) return refusal("CANDIDATE_PROBE_FAILED", next.error);
  // A probe must not change a checkout, even without changing the head commit.
  if (checkCheckout(baseline.dir, before.baselineSha).error ||
      checkCheckout(candidate.dir, before.candidateSha).error)
    return refusal("CHECKOUT_CHANGED", "checkout changed during replay");
  const compared = compareResults(checked.suite, old.results, next.results);
  const result = {
    ok: compared.eligible,
    verdict: compared.eligible ? "EVAL_PASS" : "EVAL_FAIL",
    ...before, suiteSha256: suiteHash,
    ...compared,
    note: "Contract replay only; this does not benchmark real agent delivery or authorize merge.",
  };
  return { code: result.ok ? 0 : 1, result };
}
