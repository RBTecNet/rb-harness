import type { SemanticKey } from "./identity.js";
import type { AcceptedRecommendationProof } from "./ir.js";

const EVIDENCE_MINIMUM_CHARACTERS = 12;
const EVIDENCE_MINIMUM_TOKENS = 2;
const EVIDENCE_MINIMUM_TOKEN_CHARACTERS = 10;

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
 * Conservative request authority proof: a meaningful, contiguous phrase must
 * occur in the request. Short incidental substrings and single-token claims
 * deliberately do not establish authority.
 */
export function requestEvidenceIsVerified(originalRequest: string, evidence: string): boolean {
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
