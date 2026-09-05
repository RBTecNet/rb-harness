import type { Finding, FindingStatus } from "./contracts.js";

const ALLOWED_FINDING_TRANSITIONS: Readonly<Record<FindingStatus, readonly FindingStatus[]>> = {
  OPEN: ["CANDIDATE_RESOLVED", "SUPERSEDED", "HUMAN_PENDING"],
  CANDIDATE_RESOLVED: ["RESOLVED", "SUPERSEDED", "HUMAN_PENDING", "OPEN"],
  RESOLVED: [],
  SUPERSEDED: [],
  HUMAN_PENDING: ["OPEN", "RESOLVED", "SUPERSEDED"],
};

export function transitionFinding(previous: Finding, next: Finding): Finding {
  if (previous.id !== next.id || previous.taskId !== next.taskId || previous.phaseId !== next.phaseId) throw new Error("RALPH_FINDING_IDENTITY_MUTATION");
  if (previous.status === next.status) return next;
  if (!ALLOWED_FINDING_TRANSITIONS[previous.status].includes(next.status)) throw new Error(`RALPH_INVALID_FINDING_TRANSITION: ${previous.status}->${next.status}`);
  if (next.status === "RESOLVED") assertResolutionProof(previous, next);
  if (next.status === "SUPERSEDED" && !next.supersedesFindingId) throw new Error("RALPH_SUPERSEDED_FINDING_MISSING_REPLACEMENT");
  return next;
}

function assertResolutionProof(previous: Finding, next: Finding): void {
  if (!next.resolutionEvidenceDigest || !next.resolutionAuditId || !next.resolutionValidationSetDigest || !next.resolutionCriterionResult) {
    throw new Error("RALPH_FINDING_RESOLUTION_PROOF_MISSING");
  }
  if (next.resolutionCriterionResult !== "PASS" && next.resolutionCriterionResult !== "NOT_APPLICABLE") {
    throw new Error("RALPH_FINDING_RESOLUTION_CRITERION_NOT_PASS");
  }
  if (previous.evidenceRefs.some((reference) => reference.digest === next.resolutionEvidenceDigest)) {
    throw new Error("RALPH_FINDING_RESOLUTION_EVIDENCE_NOT_NEW");
  }
  if (!next.evidenceRefs.some((reference) => reference.digest === next.resolutionEvidenceDigest)) {
    throw new Error("RALPH_FINDING_RESOLUTION_EVIDENCE_NOT_BOUND");
  }
}

export function canAuditorProposeFindingResolution(finding: Finding): boolean {
  return finding.status === "OPEN" || finding.status === "CANDIDATE_RESOLVED" || finding.status === "HUMAN_PENDING";
}
