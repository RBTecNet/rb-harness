import { sha256Canonical } from "../hashing.js";
import { assertNoCredentialMaterial, RalphCredentialSafetyError } from "../operational-b1/secret-safety.js";
import type { AuditPackageV2 } from "../operational-d/artifacts.js";
import type { ProposedFindingV2 } from "../operational-e/artifacts.js";
import { m4d } from "./contract.js";

export const RALPH_AUDIT_ENVELOPE_BEGIN_V2 = "<<<RALPH-AUDIT-RESULT-V1>>>" as const;
export const RALPH_AUDIT_ENVELOPE_END_V2 = "<<<END-RALPH-AUDIT-RESULT-V1>>>" as const;

export const MAX_AUDIT_PROVIDER_TEXT_BYTES_V2 = 64 * 1024;
export const MAX_AUDIT_ENVELOPE_BYTES_V2 = 16 * 1024;
export const MAX_AUDIT_PROPOSED_FINDINGS_V2 = 8;
export const MAX_AUDIT_RESOLVED_REFS_V2 = 32;
export const MAX_AUDIT_FINDING_TEXT_V2 = 1024;
export const MAX_AUDIT_RATIONALE_V2 = 2048;
export const MAX_AUDIT_SCOPE_ENTRIES_V2 = 8;

const ENVELOPE_KEYS = ["verdict", "proposedFindings", "resolvedFindingRefs", "rationale"] as const;
const FINDING_KEYS = ["criterionId", "structuredFindingKey", "severity", "scope", "expectation", "observed", "remediationHint"] as const;
const SEVERITIES = ["INFO", "LOW", "MEDIUM", "HIGH", "BLOCKER"] as const;
const NUL = String.fromCharCode(0);
const NEWLINE = "\n";

/**
 * The smallest untrusted provider audit proposal. It carries no Finding
 * identity, no Task/Run disposition and no Validation verdict: Core mints
 * Finding identity and decides every disposition from the frozen semantics.
 */
export interface OpenCodeAuditProposalV2 {
  readonly verdict: "ACCEPT" | "REJECT";
  readonly proposedFindings: readonly ProposedFindingV2[];
  readonly resolvedFindingRefs: readonly string[];
  readonly rationale: string;
}

export function auditProposalDigestV2(value: OpenCodeAuditProposalV2): string {
  return sha256Canonical({
    verdict: value.verdict,
    proposedFindings: value.proposedFindings,
    resolvedFindingRefs: value.resolvedFindingRefs,
    rationale: value.rationale,
  });
}

/**
 * Canonical safe extraction. The provider may reason in prose, but exactly one
 * delimited structured response must exist in the observable turn text. Zero,
 * two, or a malformed block fails closed.
 */
export function extractAuditEnvelopeTextV2(assistantText: string): string {
  if (typeof assistantText !== "string") throw m4d("M4D_PROVIDER_ENVELOPE_INVALID", "M4D_PROVIDER_ENVELOPE_INVALID: non-text turn");
  if (Buffer.byteLength(assistantText, "utf8") > MAX_AUDIT_PROVIDER_TEXT_BYTES_V2) throw m4d("M4D_PROVIDER_OUTPUT_LIMIT");
  const first = assistantText.indexOf(RALPH_AUDIT_ENVELOPE_BEGIN_V2);
  const last = assistantText.lastIndexOf(RALPH_AUDIT_ENVELOPE_BEGIN_V2);
  const endFirst = assistantText.indexOf(RALPH_AUDIT_ENVELOPE_END_V2);
  const endLast = assistantText.lastIndexOf(RALPH_AUDIT_ENVELOPE_END_V2);
  if (first < 0 || endFirst < 0) throw m4d("M4D_PROVIDER_ENVELOPE_INVALID", "M4D_PROVIDER_ENVELOPE_INVALID: no structured response");
  if (first !== last || endFirst !== endLast) throw m4d("M4D_PROVIDER_ENVELOPE_INVALID", "M4D_PROVIDER_ENVELOPE_INVALID: ambiguous structured response");
  if (endFirst <= first) throw m4d("M4D_PROVIDER_ENVELOPE_INVALID", "M4D_PROVIDER_ENVELOPE_INVALID: inverted delimiters");
  const body = assistantText.slice(first + RALPH_AUDIT_ENVELOPE_BEGIN_V2.length, endFirst).trim();
  if (Buffer.byteLength(body, "utf8") > MAX_AUDIT_ENVELOPE_BYTES_V2) throw m4d("M4D_PROVIDER_OUTPUT_LIMIT");
  if (!body.startsWith("{") || !body.endsWith("}")) throw m4d("M4D_PROVIDER_ENVELOPE_INVALID", "M4D_PROVIDER_ENVELOPE_INVALID: body is not a JSON object");
  return body;
}

/**
 * Parse and bind one untrusted audit proposal against the exact AuditPackage
 * the Auditor was dispatched with. Unknown fields, provider-chosen Finding
 * identity, foreign resolution references and unbounded text all fail closed.
 */
export function parseOpenCodeAuditProposalV2(assistantText: string, auditPackage: AuditPackageV2): OpenCodeAuditProposalV2 {
  const body = extractAuditEnvelopeTextV2(assistantText);
  let parsed: unknown;
  try { parsed = JSON.parse(body) as unknown; }
  catch (error) { throw m4d("M4D_PROVIDER_ENVELOPE_INVALID", "M4D_PROVIDER_ENVELOPE_INVALID: malformed JSON", error); }
  return validateOpenCodeAuditProposalV2(parsed, auditPackage);
}

export function validateOpenCodeAuditProposalV2(value: unknown, auditPackage: AuditPackageV2): OpenCodeAuditProposalV2 {
  const record = requireRecord(value, "envelope");
  assertExactKeys(record, ENVELOPE_KEYS, "envelope");
  if (record.verdict !== "ACCEPT" && record.verdict !== "REJECT") throw invalid("verdict");
  if (!Array.isArray(record.proposedFindings) || record.proposedFindings.length > MAX_AUDIT_PROPOSED_FINDINGS_V2) throw invalid("proposedFindings");
  if (!Array.isArray(record.resolvedFindingRefs) || record.resolvedFindingRefs.length > MAX_AUDIT_RESOLVED_REFS_V2) throw invalid("resolvedFindingRefs");
  assertBoundedText(record.rationale, MAX_AUDIT_RATIONALE_V2, "rationale");
  if ((record.rationale as string).length === 0) throw invalid("rationale");

  const proposedFindings = record.proposedFindings.map((finding) => validateProposedFinding(finding, auditPackage));
  const keys = new Set<string>();
  for (const finding of proposedFindings) {
    const key = `${finding.criterionId} ${finding.structuredFindingKey}`;
    if (keys.has(key)) throw invalid("duplicate proposed finding");
    keys.add(key);
  }

  const allowed = new Set(auditPackage.openFindingRefs.map((finding) => finding.findingId));
  const seen = new Set<string>();
  const resolvedFindingRefs: string[] = [];
  for (const reference of record.resolvedFindingRefs) {
    if (typeof reference !== "string" || !allowed.has(reference)) throw invalid("resolution reference is not an open package Finding");
    if (seen.has(reference)) throw invalid("duplicate resolution reference");
    seen.add(reference);
    resolvedFindingRefs.push(reference);
  }

  // The frozen Core acceptance invariants are restated here so a contradictory
  // proposal never reaches reconciliation as a half-valid ACCEPT.
  if (record.verdict === "ACCEPT" && proposedFindings.length > 0) throw invalid("ACCEPT carries proposed Findings");
  if (record.verdict === "REJECT" && proposedFindings.length === 0) throw invalid("REJECT carries no proposed Finding");

  const result: OpenCodeAuditProposalV2 = Object.freeze({
    verdict: record.verdict,
    proposedFindings: Object.freeze(proposedFindings),
    resolvedFindingRefs: Object.freeze(resolvedFindingRefs),
    rationale: record.rationale as string,
  });
  assertCredentialSafe(result);
  return result;
}

function validateProposedFinding(value: unknown, auditPackage: AuditPackageV2): ProposedFindingV2 {
  const record = requireRecord(value, "proposed finding");
  // A provider-supplied `findingId`/`id` is an unknown field here, so provider
  // Finding identity is rejected before Core ever sees the proposal.
  assertExactKeys(record, FINDING_KEYS, "proposed finding");
  const criterionId = record.criterionId;
  if (typeof criterionId !== "string" || !/^criterion:[1-9][0-9]{0,2}$/.test(criterionId)) throw invalid("criterionId");
  const ordinal = Number(criterionId.slice("criterion:".length));
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > auditPackage.acceptanceCriteria.length) throw invalid("criterionId is not an AuditPackage acceptance criterion");
  const structuredFindingKey = record.structuredFindingKey;
  if (typeof structuredFindingKey !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,63}$/.test(structuredFindingKey)) throw invalid("structuredFindingKey");
  if (!(SEVERITIES as readonly unknown[]).includes(record.severity)) throw invalid("severity");
  if (!Array.isArray(record.scope) || record.scope.length < 1 || record.scope.length > MAX_AUDIT_SCOPE_ENTRIES_V2) throw invalid("scope");
  const scope = record.scope.map((entry) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 256 || entry.includes(NUL) || entry.includes(NEWLINE)) throw invalid("scope entry");
    return entry;
  });
  assertBoundedText(record.expectation, MAX_AUDIT_FINDING_TEXT_V2, "expectation");
  assertBoundedText(record.observed, MAX_AUDIT_FINDING_TEXT_V2, "observed");
  if ((record.expectation as string).length === 0 || (record.observed as string).length === 0) throw invalid("empty finding text");
  if (record.remediationHint !== undefined) assertBoundedText(record.remediationHint, MAX_AUDIT_FINDING_TEXT_V2, "remediationHint");
  return Object.freeze({
    criterionId,
    structuredFindingKey,
    severity: record.severity as ProposedFindingV2["severity"],
    scope: Object.freeze(scope),
    expectation: record.expectation as string,
    observed: record.observed as string,
    ...(record.remediationHint === undefined ? {} : { remediationHint: record.remediationHint as string }),
    // `rootCauseGroup` is Core-derived, never provider-supplied.
    rootCauseGroup: `audit:${auditPackage.taskId}`,
  });
}

function assertBoundedText(value: unknown, max: number, field: string): void {
  if (typeof value !== "string" || value.length > max || value.includes(NUL)) throw invalid(field);
}

function assertExactKeys(record: Record<string, unknown>, keys: readonly string[], field: string): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw invalid(`${field} unknown fields ${unknown.sort().join(",")}`);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(field);
  return value as Record<string, unknown>;
}

function assertCredentialSafe(value: unknown): void {
  try { assertNoCredentialMaterial(value, "M4D_PROVIDER_CREDENTIAL_MATERIAL"); }
  catch (error) {
    if (error instanceof RalphCredentialSafetyError) throw m4d("M4D_PROVIDER_CREDENTIAL_MATERIAL", "M4D_PROVIDER_CREDENTIAL_MATERIAL", error);
    throw error;
  }
}

function invalid(field: string): Error {
  return m4d("M4D_PROVIDER_ENVELOPE_INVALID", `M4D_PROVIDER_ENVELOPE_INVALID: ${field}`);
}
