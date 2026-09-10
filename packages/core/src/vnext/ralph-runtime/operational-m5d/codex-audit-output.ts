import { canonicalJson } from "../canonical-json.js";
import { sha256, sha256Canonical } from "../hashing.js";
import { assertNoCredentialMaterial, RalphCredentialSafetyError } from "../operational-b1/secret-safety.js";
import type { AuditPackageV2 } from "../operational-d/artifacts.js";
import type { ProposedFindingV2 } from "../operational-e/artifacts.js";
import {
  MAX_AUDIT_FINDING_TEXT_V2,
  MAX_AUDIT_PROPOSED_FINDINGS_V2,
  MAX_AUDIT_RATIONALE_V2,
  MAX_AUDIT_RESOLVED_REFS_V2,
  MAX_AUDIT_SCOPE_ENTRIES_V2,
} from "../operational-m4d/audit-envelope.js";
import { m5d, type RalphM5DError } from "./contract.js";

const FINDING_PROPERTIES = Object.freeze({
  criterionId: Object.freeze({ type: "string", pattern: "^criterion:[1-9][0-9]{0,2}$" }),
  structuredFindingKey: Object.freeze({ type: "string", pattern: "^[a-z0-9][a-z0-9._:-]{0,63}$" }),
  severity: Object.freeze({ type: "string", enum: Object.freeze(["INFO", "LOW", "MEDIUM", "HIGH", "BLOCKER"]) }),
  scope: Object.freeze({ type: "array", minItems: 1, maxItems: MAX_AUDIT_SCOPE_ENTRIES_V2, items: Object.freeze({ type: "string", minLength: 1, maxLength: 256 }) }),
  expectation: Object.freeze({ type: "string", minLength: 1, maxLength: MAX_AUDIT_FINDING_TEXT_V2 }),
  observed: Object.freeze({ type: "string", minLength: 1, maxLength: MAX_AUDIT_FINDING_TEXT_V2 }),
  remediationHint: Object.freeze({ type: "string", maxLength: MAX_AUDIT_FINDING_TEXT_V2 }),
});

/** Exact provider-side schema. Finding identity and Core state are absent. */
export const CODEX_AUDIT_OUTPUT_SCHEMA_V2 = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze(["verdict", "proposedFindings", "resolvedFindingRefs", "rationale"]),
  properties: Object.freeze({
    verdict: Object.freeze({ type: "string", enum: Object.freeze(["ACCEPT", "REJECT"]) }),
    proposedFindings: Object.freeze({
      type: "array", maxItems: MAX_AUDIT_PROPOSED_FINDINGS_V2,
      items: Object.freeze({
        type: "object", additionalProperties: false,
        required: Object.freeze(["criterionId", "structuredFindingKey", "severity", "scope", "expectation", "observed", "remediationHint"]),
        properties: FINDING_PROPERTIES,
      }),
    }),
    resolvedFindingRefs: Object.freeze({ type: "array", maxItems: MAX_AUDIT_RESOLVED_REFS_V2, items: Object.freeze({ type: "string", pattern: "^finding-[0-9a-f]{64}$" }) }),
    rationale: Object.freeze({ type: "string", minLength: 1, maxLength: MAX_AUDIT_RATIONALE_V2 }),
  }),
});

export function codexAuditOutputSchemaJsonV2(): string { return `${JSON.stringify(CODEX_AUDIT_OUTPUT_SCHEMA_V2, null, 2)}\n`; }

export interface CodexAuditProposalV2 {
  readonly verdict: "ACCEPT" | "REJECT";
  readonly proposedFindings: readonly ProposedFindingV2[];
  readonly resolvedFindingRefs: readonly string[];
  readonly rationale: string;
}

export interface CodexAuditStructuredOutputV2 {
  readonly proposal: CodexAuditProposalV2;
  readonly canonicalJson: string;
  readonly proposalDigest: string;
}

export function validateExactCodexAuditOutputV2(raw: string, auditPackage: AuditPackageV2): CodexAuditStructuredOutputV2 {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 64 * 1024) throw m5d("M5D_PROVIDER_OUTPUT_LIMIT");
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch (error) { throw m5d("M5D_PROVIDER_RESULT_INVALID", "M5D_PROVIDER_RESULT_INVALID: malformed JSON", error); }
  const proposal = validateCodexAuditProposalV2(parsed, auditPackage);
  const canonical = canonicalJson({ verdict: proposal.verdict, proposedFindings: proposal.proposedFindings, resolvedFindingRefs: proposal.resolvedFindingRefs, rationale: proposal.rationale });
  return Object.freeze({ proposal, canonicalJson: canonical, proposalDigest: sha256(canonical) });
}

export function validateCodexAuditProposalV2(value: unknown, auditPackage: AuditPackageV2): CodexAuditProposalV2 {
  const item = requireRecord(value, "proposal");
  exact(item, ["verdict", "proposedFindings", "resolvedFindingRefs", "rationale"], "proposal");
  if (item.verdict !== "ACCEPT" && item.verdict !== "REJECT") throw invalid("verdict");
  if (!Array.isArray(item.proposedFindings) || item.proposedFindings.length > MAX_AUDIT_PROPOSED_FINDINGS_V2) throw invalid("findings");
  if (!Array.isArray(item.resolvedFindingRefs) || item.resolvedFindingRefs.length > MAX_AUDIT_RESOLVED_REFS_V2) throw invalid("resolution refs");
  text(item.rationale, MAX_AUDIT_RATIONALE_V2, "rationale", true);
  const findings = item.proposedFindings.map((finding) => validateFinding(finding, auditPackage));
  const findingKeys = new Set<string>();
  for (const finding of findings) {
    const key = `${finding.criterionId}:${finding.structuredFindingKey}`;
    if (findingKeys.has(key)) throw invalid("duplicate finding");
    findingKeys.add(key);
  }
  const allowedRefs = new Set(auditPackage.openFindingRefs.map((finding) => finding.findingId));
  const seenRefs = new Set<string>();
  const resolvedFindingRefs: string[] = [];
  for (const reference of item.resolvedFindingRefs) {
    if (typeof reference !== "string" || !allowedRefs.has(reference) || seenRefs.has(reference)) throw invalid("foreign/duplicate resolution ref");
    seenRefs.add(reference);
    resolvedFindingRefs.push(reference);
  }
  if (item.verdict === "ACCEPT" && findings.length !== 0) throw invalid("ACCEPT findings");
  if (item.verdict === "REJECT" && findings.length === 0) throw invalid("REJECT without finding");
  // Completeness of an ACCEPT proposal is deliberately not decided here.
  // The frozen Core compares this exact subset with every current OPEN
  // Finding and turns an incomplete proposal into an effective rejection.
  const result = Object.freeze({
    verdict: item.verdict,
    proposedFindings: Object.freeze(findings),
    resolvedFindingRefs: Object.freeze(resolvedFindingRefs),
    rationale: item.rationale as string,
  });
  credentialSafe(result);
  return result;
}

export function codexAuditProposalDigestV2(proposal: CodexAuditProposalV2): string {
  return sha256Canonical({ verdict: proposal.verdict, proposedFindings: proposal.proposedFindings, resolvedFindingRefs: proposal.resolvedFindingRefs, rationale: proposal.rationale });
}

export function assertCodexAuditFinalMessageV2(finalAgentMessage: string | null, output: CodexAuditStructuredOutputV2): void {
  if (finalAgentMessage === null) throw invalid("missing final agent_message");
  let parsed: unknown;
  try { parsed = JSON.parse(finalAgentMessage.trim()) as unknown; } catch { throw invalid("final agent_message JSON"); }
  if (canonicalJson(parsed) !== output.canonicalJson) throw invalid("last agent_message differs from -o");
}

function validateFinding(value: unknown, auditPackage: AuditPackageV2): ProposedFindingV2 {
  const item = requireRecord(value, "finding");
  // findingId/id/finalFindingId and every Core lifecycle field are rejected
  // here as unknown fields before Core can mint an AuditResult.
  exact(item, ["criterionId", "structuredFindingKey", "severity", "scope", "expectation", "observed", "remediationHint"], "finding");
  if (typeof item.criterionId !== "string" || !/^criterion:[1-9][0-9]{0,2}$/.test(item.criterionId)) throw invalid("criterionId");
  const ordinal = Number(item.criterionId.slice("criterion:".length));
  if (ordinal < 1 || ordinal > auditPackage.acceptanceCriteria.length) throw invalid("criterionId binding");
  if (typeof item.structuredFindingKey !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,63}$/.test(item.structuredFindingKey)) throw invalid("finding key");
  if (typeof item.severity !== "string" || !["INFO", "LOW", "MEDIUM", "HIGH", "BLOCKER"].includes(item.severity)) throw invalid("severity");
  if (!Array.isArray(item.scope) || item.scope.length < 1 || item.scope.length > MAX_AUDIT_SCOPE_ENTRIES_V2) throw invalid("scope");
  const scope = item.scope.map((entry) => { text(entry, 256, "scope", true); if ((entry as string).includes("\n")) throw invalid("scope newline"); return entry as string; });
  text(item.expectation, MAX_AUDIT_FINDING_TEXT_V2, "expectation", true);
  text(item.observed, MAX_AUDIT_FINDING_TEXT_V2, "observed", true);
  if (item.remediationHint !== undefined) text(item.remediationHint, MAX_AUDIT_FINDING_TEXT_V2, "remediationHint", false);
  return Object.freeze({
    criterionId: item.criterionId,
    structuredFindingKey: item.structuredFindingKey,
    severity: item.severity as ProposedFindingV2["severity"],
    scope: Object.freeze(scope),
    expectation: item.expectation as string,
    observed: item.observed as string,
    ...(item.remediationHint === undefined ? {} : { remediationHint: item.remediationHint as string }),
  });
}

function exact(item: Record<string, unknown>, keys: readonly string[], field: string): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(item).filter((key) => !allowed.has(key));
  const missing = keys.filter((key) => key !== "remediationHint" && !(key in item));
  if (unknown.length || missing.length) throw invalid(`${field} fields ${unknown.join(",")} ${missing.join(",")}`);
}
function text(value: unknown, max: number, field: string, nonempty: boolean): void {
  if (typeof value !== "string" || value.length > max || value.includes("\0") || (nonempty && value.length === 0)) throw invalid(field);
}
function credentialSafe(value: unknown): void {
  try { assertNoCredentialMaterial(value, "M5D_PROVIDER_CREDENTIAL_MATERIAL"); }
  catch (error) { if (error instanceof RalphCredentialSafetyError) throw m5d("M5D_PROVIDER_CREDENTIAL_MATERIAL", undefined, error); throw error; }
}
function invalid(field: string): RalphM5DError { return m5d("M5D_PROVIDER_RESULT_INVALID", `M5D_PROVIDER_RESULT_INVALID: ${field}`); }
function requireRecord(value: unknown, field: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(field); return value as Record<string, unknown>; }
