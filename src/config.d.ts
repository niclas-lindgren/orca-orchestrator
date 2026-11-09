export interface GateConfig {
  command: string;
  args: string[];
  label: string;
}

export interface ReviewConfig {
  projectId: string;
  projectName: string;
}

export interface ProtectedDomain {
  id: string;
  labels: string[];
  words: RegExp;
  paths: RegExp[];
}

export interface OrcaConfig {
  repo?: string;
  defaultBranch: string;
  stateDir: string;
  gate?: GateConfig;
  review?: ReviewConfig;
  workerInstructions: string[];
  protectedDomains: ProtectedDomain[];
  repoRoot: string;
  origin: string | null;
}

export const CONFIG_FILE: "orca.config.json";

export class ConfigError extends Error {
  code: string;
  constructor(code: string, message: string);
}

export function normalizeConfig(raw: unknown, options?: { repoRoot?: string; origin?: string | null }): OrcaConfig;
export function resolveRepoRoot(cwd?: string): string;
export function resolveConfigRoot(cwd?: string, repoRoot?: string): string;
export function loadConfig(configRoot: string, options?: { repoRoot?: string }): OrcaConfig;
export function setActiveConfig(config: OrcaConfig): void;
export function activateRepositoryConfig(cwd?: string): OrcaConfig;
export function activeConfig(): OrcaConfig;
export function requireSetting<T = unknown>(path: string): T;
export function repoSlug(config?: OrcaConfig, cwd?: string): string;
export function peekConfig(): OrcaConfig | null;
