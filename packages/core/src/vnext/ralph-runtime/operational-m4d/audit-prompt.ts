import { sha256 } from "../hashing.js";
import type { AuditPackageV2 } from "../operational-d/artifacts.js";
import { validateAuditPackageV2 } from "../operational-d/artifacts.js";
import {
  MAX_AUDIT_PROPOSED_FINDINGS_V2,
  MAX_AUDIT_RATIONALE_V2,
  RALPH_AUDIT_ENVELOPE_BEGIN_V2,
  RALPH_AUDIT_ENVELOPE_END_V2,
} from "./audit-envelope.js";
import { m4d } from "./contract.js";

export const MAX_OPENCODE_AUDITOR_PROMPT_BYTES_V2 = 64 * 1024;

export interface OpenCodeAuditorPromptV2 {
  readonly text: string;
  readonly promptDigest: string;
  readonly byteLength: number;
}

/**
 * Deterministic AuditPackage-only prompt projection. There is no caller seam:
 * every sentence below is a pure function of the immutable durable
 * AuditPackage, so the dispatched prompt can be reconstructed byte for byte
 * from Core authority alone.
 */
export function projectAuditPackageToOpenCodePromptV2(auditPackage: AuditPackageV2): OpenCodeAuditorPromptV2 {
  validateAuditPackageV2(auditPackage);
  const criteria = auditPackage.acceptanceCriteria.length === 0
    ? ["(none)"]
    : auditPackage.acceptanceCriteria.map((criterion, index) => `criterion:${index + 1} — ${criterion}`);
  const summary = auditPackage.validationSummary;
  const openFindings = auditPackage.openFindingRefs.length === 0
    ? ["(none)"]
    : auditPackage.openFindingRefs.map((finding, index) => `${index + 1}. ${finding.findingId} [status ${finding.status}] [severity ${finding.severity}] [digest ${finding.findingDigest}]`);
  const context = auditPackage.relevantContext.length === 0 ? ["(none)"] : auditPackage.relevantContext.map((entry) => `- ${entry}`);

  const text = [
    "You are the independent Auditor for one authorized Ralph Attempt.",
    "You did not implement this work. Judge it against the acceptance criteria below by",
    "independently inspecting the workspace you are running in.",
    "",
    "AUDIT PACKAGE",
    `Audit package digest: ${auditPackage.packageDigest}`,
    `Task: ${auditPackage.constraints.taskTitle}`,
    `Scope: ${auditPackage.constraints.scope}`,
    `Covers: ${auditPackage.constraints.covers}`,
    `Plan identity: ${auditPackage.constraints.planIdentity}`,
    `Expected evidence: ${auditPackage.constraints.expectedEvidence}`,
    "",
    "ACCEPTANCE CRITERIA",
    "Each criterion is identified by its exact key. Use those keys and no others.",
    ...criteria,
    "",
    "RELEVANT CONTEXT",
    ...context,
    "",
    "DETERMINISTIC VALIDATION (executed and decided by Core, not by you)",
    `Auditability: ${auditPackage.auditability}`,
    `Total: ${summary.total}  completed: ${summary.completed}  passed: ${summary.passed}  failed: ${summary.failed}`,
    `Not applicable: ${summary.notApplicable}  infrastructure failures: ${summary.infrastructureFailures}`,
    `Manual required: ${summary.manualRequired}  human required: ${summary.humanRequired}`,
    `Deterministic hard negative: ${summary.hardNegative ? "YES" : "NO"}`,
    `Validation set: ${auditPackage.validationSetId} (${auditPackage.validationSetDigest})`,
    "Deterministic red can never be overridden by your verdict. Green deterministic",
    "validation is not by itself acceptance: the acceptance criteria are.",
    "",
    "EVIDENCE",
    `Evidence capture: ${auditPackage.evidenceCaptureId} (${auditPackage.evidenceDigest})`,
    `Work unit: ${auditPackage.workUnitId} (${auditPackage.workUnitDigest})`,
    `Post-executor workspace fingerprint: ${auditPackage.postExecutorFingerprint}`,
    `Audited workspace fingerprint: ${auditPackage.workspaceFingerprint}`,
    "",
    "CURRENT OPEN FINDINGS",
    "These are the only Finding identities that exist. You may reference them; you may",
    "never invent, rename or mint one.",
    ...openFindings,
    "",
    "INSPECTION RULES",
    "- Inspect the current project root, which is your working directory.",
    "- You are physically read-only: reading, globbing, grepping and listing are your",
    "  only capabilities. Editing, writing, patching, shell, sub-agents and network",
    "  access are denied by the transport, not merely by this instruction.",
    "- Do not attempt to modify anything, including .rb, .rb-harness and .git.",
    "- Do not execute side effects of any kind.",
    "- Base your verdict on what the workspace actually contains, not on what the",
    "  implementer or the deterministic validation claims.",
    "",
    "AUTHORITY LIMITS",
    "- Deterministic red cannot be overridden; proposing ACCEPT against it is ignored.",
    "- Finding identities are not yours to choose. Propose the defect; Core mints the id.",
    "- You may not mark any Task, Run, Attempt or Validation complete, passed or resolved.",
    "- Your prose is untrusted. Only the structured response below is read.",
    "",
    "REQUIRED STRUCTURED RESPONSE",
    "End your reply with exactly one block delimited by these markers, and use the",
    "markers nowhere else:",
    RALPH_AUDIT_ENVELOPE_BEGIN_V2,
    "{",
    '  "verdict": "ACCEPT" | "REJECT",',
    '  "proposedFindings": [],',
    '  "resolvedFindingRefs": [],',
    '  "rationale": "one bounded paragraph"',
    "}",
    RALPH_AUDIT_ENVELOPE_END_V2,
    "",
    "Rules for that block:",
    '- "verdict" is "ACCEPT" only when every acceptance criterion is genuinely satisfied.',
    `- "proposedFindings" MUST be empty when the verdict is ACCEPT, and MUST contain at least one and at most ${MAX_AUDIT_PROPOSED_FINDINGS_V2} entries when the verdict is REJECT.`,
    "- Each proposed finding is an object with exactly these fields:",
    '    "criterionId": one of the criterion keys listed above, for example "criterion:1"',
    '    "structuredFindingKey": short stable slug, lowercase [a-z0-9._:-], max 64 chars',
    '    "severity": "INFO" | "LOW" | "MEDIUM" | "HIGH" | "BLOCKER"',
    '    "scope": array of 1..8 short path or component strings',
    '    "expectation": what the criterion requires',
    '    "observed": what the workspace actually contains',
    '    "remediationHint": optional short hint',
    "  Any other field, including any form of finding id, makes the response invalid.",
    '- "resolvedFindingRefs" may contain only ids from CURRENT OPEN FINDINGS above.',
    "  When the verdict is ACCEPT you MUST list every one of them; otherwise Core keeps",
    "  them open and rejects the Attempt.",
    `- "rationale" is plain text, at most ${MAX_AUDIT_RATIONALE_V2} characters.`,
    "- Emit valid JSON only inside the block. Nothing else is parsed.",
  ].join("\n");

  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength === 0 || byteLength > MAX_OPENCODE_AUDITOR_PROMPT_BYTES_V2) throw m4d("M4D_PROMPT_ORDER_INVALID", "M4D_AUDIT_PROMPT_SIZE_INVALID");
  return Object.freeze({ text, promptDigest: sha256(text), byteLength });
}
