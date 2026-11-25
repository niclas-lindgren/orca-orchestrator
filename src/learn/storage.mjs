import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { activeConfig } from "../config.mjs";

export function openLearningDb(repoRoot) {
  const dir = resolve(repoRoot, activeConfig().stateDir);
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "learning.db"));
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 250; BEGIN IMMEDIATE;");
    db.exec(`CREATE TABLE IF NOT EXISTS observations (
      repo TEXT NOT NULL, run_id TEXT NOT NULL, issue INTEGER NOT NULL, head_sha TEXT,
      outcome TEXT NOT NULL, duration_ms INTEGER, cost_usd REAL, payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (repo, run_id));
      CREATE TABLE IF NOT EXISTS findings (
      repo TEXT NOT NULL, run_id TEXT NOT NULL, category TEXT NOT NULL,
      key TEXT NOT NULL, severity TEXT NOT NULL,
      PRIMARY KEY (repo, run_id, category, key),
      FOREIGN KEY (repo, run_id) REFERENCES observations(repo, run_id));
      CREATE INDEX IF NOT EXISTS findings_repo_key ON findings(repo, category, key);
      CREATE TABLE IF NOT EXISTS learning_runs (
      repo TEXT NOT NULL, run_id TEXT NOT NULL, issue INTEGER NOT NULL,
      package_version TEXT NOT NULL, workflow TEXT NOT NULL, review_mode TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (repo, run_id));
      CREATE TABLE IF NOT EXISTS command_events (
      id INTEGER PRIMARY KEY, repo TEXT NOT NULL, run_id TEXT, issue INTEGER,
      package_version TEXT NOT NULL, command TEXT NOT NULL, result_code TEXT NOT NULL,
      duration_ms INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE INDEX IF NOT EXISTS command_events_repo ON command_events(repo, id);`);
    const columns = db.prepare("PRAGMA table_info(findings)").all();
    if (!columns.some((c) => c.name === "disposition"))
      db.exec("ALTER TABLE findings ADD COLUMN disposition TEXT NOT NULL DEFAULT 'unspecified'");
    db.exec("COMMIT");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
