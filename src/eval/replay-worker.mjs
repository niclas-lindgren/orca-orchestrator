// Probe adapter shipped with the trusted evaluator, not loaded from the candidate.
// It intentionally exposes only the supported pure-function contracts.
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const [root] = process.argv.slice(2);
const input = JSON.parse(readFileSync(0, "utf8"));
if (!root || !Array.isArray(input.cases)) throw Error("invalid replay worker input");

function moduleAt(relative) {
  return pathToFileURL(join(resolve(root), relative)).href;
}

// Probe modules may differ between versions. Import per kind so missing modules
// fail only their relevant cases and surface a real contract incompatibility.
const imports = new Map();
async function load(relative) {
  if (!imports.has(relative)) imports.set(relative, import(moduleAt(relative)));
  return imports.get(relative);
}

async function probe(item) {
  const { input: data, probe: type } = item;
  if (type === "authority") {
    const { normalizeConfig } = await load("src/config.mjs");
    const { classify } = await load("src/auto/authority.mjs");
    const config = normalizeConfig({ protectedDomains: data.domains ?? [] });
    const finding = classify({
      issue: data.issue, files: data.files ?? null, protectedDomains: config.protectedDomains,
    });
    return { result: finding.result, domains: finding.domains };
  }
  if (type === "qa-findings") {
    const { qaFindingKeys } = await load("src/auto/findings.mjs");
    return { keys: qaFindingKeys(data.checks) };
  }
  if (type === "review-findings") {
    const { reviewFindingKeys } = await load("src/auto/findings.mjs");
    return { keys: reviewFindingKeys({ findings: data.findings, acceptance: data.acceptance }) };
  }
  if (type === "config") {
    const { normalizeConfig } = await load("src/config.mjs");
    try {
      const config = normalizeConfig(data.config);
      return { defaultBranch: config.defaultBranch, stateDir: config.stateDir };
    } catch (error) {
      return { errorCode: error?.code ?? "UNKNOWN" };
    }
  }
  throw Error("unsupported probe");
}

const results = [];
for (const item of input.cases) {
  try {
    results.push({ id: item.id, ok: true, actual: await probe(item) });
  } catch (error) {
    results.push({
      id: item.id, ok: false,
      error: String(error?.code ?? error?.name ?? "PROBE_ERROR").slice(0, 100),
    });
  }
}
process.stdout.write(JSON.stringify({ results }) + "\n");
