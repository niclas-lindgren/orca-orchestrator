import type { ProtectedDomain } from "../config.mjs";

export type AuthorityResult = "CLEAR" | "REQUIRES_FOUNDER";
export type AuthoritySignal = {
  domain: string;
  kind: "label" | "title" | "path" | "text";
  evidence: string;
};
export type AuthorityIssue = {
  title?: string;
  body?: string;
  labels?: Array<string | { name?: string }>;
  comments?: Array<{ body?: string }>;
};
export type Classification = {
  result: AuthorityResult;
  domains: string[];
  strong: AuthoritySignal[];
  weak: AuthoritySignal[];
};

export const RESULTS: readonly ["CLEAR", "FOUNDER_APPROVED", "REQUIRES_FOUNDER", "CHECK_UNAVAILABLE"];
export function configuredDomains(): ProtectedDomain[];
export function classify(input: {
  issue: AuthorityIssue;
  files?: string[] | null;
  protectedDomains?: ProtectedDomain[];
}): Classification;
