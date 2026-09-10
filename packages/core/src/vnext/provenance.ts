import type { SemanticKey } from "./identity.js";
import type { AcceptedRecommendationProof } from "./ir.js";

const EVIDENCE_MINIMUM_CHARACTERS = 12;
const EVIDENCE_MINIMUM_TOKENS = 2;
const EVIDENCE_MINIMUM_TOKEN_CHARACTERS = 10;

export interface RequestEvidenceCatalog {
  readonly candidates: readonly string[];
}

/** Canonicalize presentation variance without discarding the authored evidence phrase. */
export function canonicalEvidenceText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function comparableEvidenceText(value: string): string {
  return canonicalEvidenceText(value).toLowerCase();
}

function evidenceTokens(value: string): readonly string[] {
  return value.match(/[\p{L}\p{N}]+(?:[._-][\p{L}\p{N}]+)*/gu) ?? [];
}

/**
 * Derive the complete, ordered request-evidence authority from the Run-owned
 * request. Each non-empty physical/logical line is one selectable source
 * fragment. Candidate identity is exact after Core-owned source
 * canonicalization; provider output is never canonicalized into membership.
 */
export function requestEvidenceCatalog(originalRequest: string): RequestEvidenceCatalog {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const line of originalRequest.normalize("NFKC").split(/\r\n|[\n\r\u2028\u2029]/u)) {
    const candidate = line.trim().replace(/\s+/gu, " ");
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    candidates.push(candidate);
  }
  return Object.freeze({ candidates: Object.freeze(candidates) });
}

/** Exact membership in the Core-owned request evidence catalog. */
export function requestEvidenceIsVerified(originalRequest: string, evidence: string): boolean {
  return requestEvidenceCatalog(originalRequest).candidates.includes(evidence);
}

/**
 * Legacy conservative substring matcher retained only for Progressive Init
 * surfaces that have not adopted the closed P1 provider contract.
 */
export function legacyRequestEvidenceIsVerified(originalRequest: string, evidence: string): boolean {
  const request = comparableEvidenceText(originalRequest);
  const candidate = comparableEvidenceText(evidence);
  const tokens = evidenceTokens(candidate);
  return candidate.length >= EVIDENCE_MINIMUM_CHARACTERS
    && tokens.length >= EVIDENCE_MINIMUM_TOKENS
    && tokens.reduce((total, token) => total + token.length, 0) >= EVIDENCE_MINIMUM_TOKEN_CHARACTERS
    && request.includes(candidate);
}

export function userAnswerIsVerified(
  answers: Readonly<Record<string, string>>,
  questionKey: SemanticKey | string,
): boolean {
  return Boolean(answers[questionKey]?.trim());
}

export function acceptedRecommendationIsVerified(
  accepted: Readonly<Record<string, AcceptedRecommendationProof>>,
  questionKey: SemanticKey | string,
): boolean {
  const proof = accepted[questionKey];
  return Boolean(proof?.value.trim())
    && (proof?.acceptanceMode === "blank-interactive" || proof?.acceptanceMode === "non-interactive-policy");
}
