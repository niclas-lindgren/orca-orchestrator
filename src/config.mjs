// Per-repository configuration. Everything that differs between repositories lives in
// `orca.config.json` at the repository root; the tools themselves hold no repo-specific
// constants. A CLI process loads the config once (`loadConfig` + `setActiveConfig`) and the
// modules read it through `activeConfig()`; tests can pass their own object to `setActiveConfig`.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const CONFIG_FILE = "orca.config.json";

export class ConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
  }
}

const DEFAULTS = Object.freeze({
  defaultBranch: "main",
  stateDir: ".local/auto",
  workerInstructions: [],
  protectedDomains: [],
});

/** Repository root for `cwd`. A linked worktree resolves to the main checkout. */
export function resolveRepoRoot(cwd = process.cwd()) {
  const r = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8" });
  if (r.status !== 0) return resolve(cwd);
  const common = r.stdout.trim();
  return common.endsWith("/.git") ? dirname(common) : resolve(cwd);
}

const stemPattern = (stems) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${stems.join("|")})`, "iu");

function compileDomain(def, index) {
  const where = `protectedDomains[${index}]`;
  if (!def || typeof def.id !== "string" || !def.id) throw new ConfigError("CONFIG_INVALID", `${where}.id must be a non-empty string`);
  const list = (key) => {
    const value = def[key] ?? [];
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      throw new ConfigError("CONFIG_INVALID", `${where}.${key} must be an array of strings`);
    }
    return value;
  };
  const words = list("words");
  const paths = list("paths");
  try {
    return {
      id: def.id,
      labels: list("labels").map((l) => l.toLowerCase()),
      words: words.length ? stemPattern(words) : /(?!)/u,
      paths: paths.map((p) => new RegExp(p)),
    };
  } catch (error) {
    throw new ConfigError("CONFIG_INVALID", `${where} has an invalid pattern: ${error.message}`);
  }
}

/** Validate a parsed config object and apply defaults. */
export function normalizeConfig(raw, { repoRoot = ".", origin = null } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError("CONFIG_INVALID", "config must be a JSON object");
  const config = { ...DEFAULTS, ...raw };
  const str = (key, value) => {
    if (typeof value !== "string" || !value.trim()) throw new ConfigError("CONFIG_INVALID", `${key} must be a non-empty string`);
    return value;
  };
  config.defaultBranch = str("defaultBranch", config.defaultBranch);
  config.stateDir = str("stateDir", config.stateDir);
  if (config.repo !== undefined) config.repo = str("repo", config.repo);
  if (config.gate !== undefined) {
    const gate = config.gate;
    if (!gate || typeof gate.command !== "string" || !Array.isArray(gate.args) || gate.args.some((a) => typeof a !== "string")) {
      throw new ConfigError("CONFIG_INVALID", "gate must be { command: string, args: string[] }");
    }
    config.gate = Object.freeze({ command: gate.command, args: Object.freeze([...gate.args]), label: [gate.command, ...gate.args].join(" ") });
  }
  if (config.review !== undefined) {
    str("review.projectId", config.review?.projectId);
    str("review.projectName", config.review?.projectName);
    config.review = Object.freeze({ ...config.review });
  }
  if (!Array.isArray(config.workerInstructions) || config.workerInstructions.some((l) => typeof l !== "string")) {
    throw new ConfigError("CONFIG_INVALID", "workerInstructions must be an array of strings");
  }
  if (!Array.isArray(config.protectedDomains)) throw new ConfigError("CONFIG_INVALID", "protectedDomains must be an array");
  config.protectedDomains = config.protectedDomains.map(compileDomain);
  config.repoRoot = repoRoot;
  config.origin = origin;
  return Object.freeze(config);
}

export function loadConfig(repoRoot) {
  const file = join(repoRoot, CONFIG_FILE);
  if (!existsSync(file)) {
    throw new ConfigError("CONFIG_MISSING", `${file} not found. Create it (see docs/configuration.md in orca-orchestrator).`);
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new ConfigError("CONFIG_INVALID", `${file} is not valid JSON: ${error.message}`);
  }
  return normalizeConfig(raw, { repoRoot, origin: file });
}

let active = null;
export function setActiveConfig(config) {
  active = config;
}
export function activeConfig() {
  if (!active) throw new ConfigError("CONFIG_NOT_LOADED", "no orca config is active; load one with loadConfig() first");
  return active;
}

/** A setting that some commands need and others do not; fail with a precise code when absent. */
export function requireSetting(key) {
  const config = activeConfig();
  const value = key.split(".").reduce((o, k) => o?.[k], config);
  if (value === undefined) throw new ConfigError("CONFIG_INCOMPLETE", `${CONFIG_FILE} must define "${key}" for this command`);
  return value;
}

/** `owner/name` for GitHub calls: the config value, else the origin remote. */
export function repoSlug(config = activeConfig(), cwd = config.repoRoot) {
  if (config.repo) return config.repo;
  const r = spawnSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8" });
  const match = r.status === 0 ? /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\s*$/.exec(r.stdout.trim()) : null;
  if (!match) throw new ConfigError("CONFIG_INCOMPLETE", `cannot determine the GitHub repository; set "repo" in ${CONFIG_FILE}`);
  return match[1];
}

/** The active config if one is loaded, else null. */
export function peekConfig() {
  return active;
}
