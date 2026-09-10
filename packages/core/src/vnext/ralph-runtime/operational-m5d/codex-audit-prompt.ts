import { sha256 } from "../hashing.js";
import type { AuditPackageV2 } from "../operational-d/artifacts.js";
import { projectAuditPackageSemanticLinesV2 } from "../operational-m4d/audit-prompt.js";
import {
  MAX_AUDIT_PROPOSED_FINDINGS_V2,
  MAX_AUDIT_RATIONALE_V2,
} from "../operational-m4d/audit-envelope.js";
import { m5d } from "./contract.js";

export const MAX_CODEX_AUDITOR_PROMPT_BYTES_V2 = 64 * 1024;

export interface CodexAuditorPromptV2 {
  readonly text: string;
  readonly promptDigest: string;
  readonly byteLength: number;
}

/** AuditPackage-only projection; callers cannot add or replace prompt text. */
export function projectAuditPackageToCodexPromptV2(auditPackage: AuditPackageV2): CodexAuditorPromptV2 {
  const text = `${[
    ...projectAuditPackageSemanticLinesV2(auditPackage, "READ_ONLY_COMMANDS"),
    "",
    "REQUIRED STRUCTURED RESPONSE",
    "Return exactly the object required by the supplied --output-schema.",
    '- "verdict" is "ACCEPT" only when every acceptance criterion is satisfied.',
    `- "proposedFindings" is empty for ACCEPT and contains 1..${MAX_AUDIT_PROPOSED_FINDINGS_V2} entries for REJECT.`,
    "- Proposed findings contain only criterionId, structuredFindingKey, severity, scope,",
    "  expectation, observed, and optional remediationHint.",
    "- Never emit findingId, id, finalFindingId, lifecycle state, Task state or Run state.",
    "- resolvedFindingRefs may contain only current OPEN Finding refs.",
    "- ACCEPT must explicitly list every current OPEN Finding ref; omission is not resolution.",
    `- rationale is bounded to ${MAX_AUDIT_RATIONALE_V2} characters.`,
    "- The exact structured object must also be your final agent message.",
  ].join("\n")}\n`;
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength === 0 || byteLength > MAX_CODEX_AUDITOR_PROMPT_BYTES_V2) throw m5d("M5D_PROMPT_INVALID", "M5D_PROMPT_INVALID: size");
  return Object.freeze({ text, promptDigest: sha256(text), byteLength });
}
