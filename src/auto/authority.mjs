// Protected-domain detector for the in-session delivery skills. A repository lists the kinds of
// change that need a human decision before they are committed (pricing, payments, publication,
// irreversible data, ...) in `protectedDomains` of its orca.config.json. This module only DETECTS
// that such work is involved; it never decides that approval was given. An agent shares the owner's
// GitHub credentials, so a comment or label in the owner's name is not proof, and nothing here reads
// one as approval.
//
// Signals are fixed and version-controlled. Strong signals (a protected label, a protected path in
// the pull request, a protected word in the issue title) make the result REQUIRES_FOUNDER. Words
// only in the body or comments are weak: they are reported, but the result stays CLEAR, because an
// issue that merely mentions a domain in a list of things it must not do is not a change in it.
// With no `protectedDomains` configured nothing is ever flagged: configure them.

import { activeConfig } from "../config.mjs";

export const RESULTS = ["CLEAR", "FOUNDER_APPROVED", "REQUIRES_FOUNDER", "CHECK_UNAVAILABLE"];

/** Public read-only view for repository tools that share the configured authority policy. */
export const configuredDomains = () => activeConfig().protectedDomains;

const labelNames = (issue) => (issue.labels ?? []).map((l) => String(typeof l === "string" ? l : l.name).toLowerCase());
const excerpt = (text, match) => {
  const start = Math.max(0, match.index - 30);
  return text.slice(start, match.index + match[0].length + 30).replace(/\s+/g, " ").trim();
};

/**
 * @param {{ issue: { title?: string, body?: string, labels?: any[], comments?: { body?: string }[] }, files?: string[] | null }} input
 * @returns {{ result: "CLEAR" | "REQUIRES_FOUNDER", domains: string[], strong: any[], weak: any[] }}
 */
export function classify({ issue, files = null, protectedDomains = activeConfig().protectedDomains }) {
  const labels = labelNames(issue);
  const strong = [];
  const weak = [];
  const bodyText = [issue.body ?? "", ...(issue.comments ?? []).map((c) => c.body ?? "")].join("\n");
  for (const domain of protectedDomains) {
    for (const label of domain.labels) if (labels.includes(label)) strong.push({ domain: domain.id, kind: "label", evidence: label });
    const title = domain.words.exec(issue.title ?? "");
    if (title) strong.push({ domain: domain.id, kind: "title", evidence: excerpt(issue.title ?? "", title) });
    for (const file of files ?? []) if (domain.paths.some((p) => p.test(file))) strong.push({ domain: domain.id, kind: "path", evidence: file });
    const body = domain.words.exec(bodyText);
    if (body) weak.push({ domain: domain.id, kind: "text", evidence: excerpt(bodyText, body) });
  }
  const domains = [...new Set(strong.map((s) => s.domain))];
  return { result: strong.length ? "REQUIRES_FOUNDER" : "CLEAR", domains, strong, weak };
}
