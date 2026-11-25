// Read-only, aggregate-only handoff from a repository-local learning ledger.
// Never include raw comments, issues, commit IDs, logs, or prompts in a public PR.
import { createHash } from "node:crypto";

const ID = /^(review|qa|workflow|tool|security):([a-z0-9][a-z0-9._:/-]{0,95})$/;
const MAX_OCCURRENCES = 100;
const SUGGESTIONS = Object.freeze({
  review: "Investigate review patterns; test a smaller delivery preflight change.",
  qa: "Investigate a focused regression test or quality gate failure.",
  workflow: "Replay a workflow transition or recovery case before changing the coordinator.",
  tool: "Investigate receipt validation, tool selection, or failure handling.",
  security: "Create a safety test and request a human security decision; do not auto-change policy.",
});

export function validatePacketId(id) {
  return typeof id === "string" ? ID.exec(id) : null;
}

/**
 * Output deliberately contains aggregate facts only; original issue references,
 * SHA IDs and run details remain in the source repository's local state store.
 * Evidence fingerprint is for provenance, NOT a cryptographic proof or authority.
 */
export function createImprovementPacket(db, repo, proposalId, { minOccurrences = 3 } = {}) {
  const parts = validatePacketId(proposalId);
  if (!parts || !Number.isSafeInteger(minOccurrences) ||
      minOccurrences < 2 || minOccurrences > MAX_OCCURRENCES)
    return { ok: false, code: "INVALID_ARGS", error: "invalid proposal id or minOccurrences (2..100)" };
  const [, category, key] = parts;
  const rows = db.prepare(
    "SELECT o.issue, o.run_id, o.head_sha, o.outcome, f.severity " +
    "FROM findings f INNER JOIN observations o " +
    "ON o.repo = f.repo AND o.run_id = f.run_id " +
    "WHERE f.repo = ? AND f.category = ? AND f.key = ? AND f.disposition != 'retracted' " +
    "ORDER BY o.run_id, o.issue"
  ).all(repo, category, key);
  if (rows.length < minOccurrences)
    return { ok: false, code: "INSUFFICIENT_EVIDENCE", error: "too few distinct run observations",
      occurrences: rows.length, required: minOccurrences };
  const issues = new Set(rows.map((row) => row.issue));
  const rank = Math.min(...rows.map((row) => Number(row.severity.slice(1))));
  const sourceDigest = createHash("sha256")
    .update(JSON.stringify({ repo, proposalId, rows })).digest("hex");
  return {
    ok: true,
    schemaVersion: 1,
    kind: "ORCA_IMPROVEMENT_PROPOSAL",
    sourceRepo: repo,
    proposalId,
    evidence: {
      occurrences: rows.length,
      affectedIssues: issues.size,
      highestSeverity: "P" + rank,
      fingerprintSha256: sourceDigest,
    },
    hypothesis: "Recurring " + category + " finding " + key +
      " may indicate a systematic gap. Treat this as a hypothesis, not a proven fix.",
    suggestedInvestigation: SUGGESTIONS[category],
    policy: {
      disposition: "DRAFT_PR_ONLY",
      selfApproval: false,
      autoMerge: false,
      independentEvaluationRequired: true,
      protectedChangesRequireHumanApproval: true,
    },
  };
}
