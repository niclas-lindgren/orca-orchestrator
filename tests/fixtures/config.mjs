import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeConfig, setActiveConfig } from "../../src/config.mjs";

// The camping-booking example config doubles as the realistic fixture for the ported tests.
const raw = JSON.parse(readFileSync(join(process.cwd(), "examples", "camping-booking.orca.config.json"), "utf8"));

export function useFixtureConfig(overrides = {}, repoRoot = "/repo") {
  const config = normalizeConfig({ ...raw, ...overrides }, { repoRoot });
  setActiveConfig(config);
  return config;
}
