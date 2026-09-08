import type { WorkUnitV2 } from "../operational-b3/index.js";
import { validateWorkUnitV2 } from "../operational-b3/index.js";
import { sha256 } from "../hashing.js";
import type { CorrectionContextV2 } from "../operational-f/correction-context.js";
import { validateCorrectionContextV2 } from "../operational-f/correction-context.js";
import { RalphM4BError } from "./opencode-cli-contract.js";
import { RalphM4CError } from "./opencode-cli-correction.js";

export const MAX_OPENCODE_EXECUTOR_PROMPT_BYTES_V2 = 64 * 1024;
export const MAX_OPENCODE_CORRECTION_FINDINGS_V2 = 32;

export interface OpenCodeCliExecutorPromptV2 {
  readonly text: string;
  readonly promptDigest: string;
  readonly byteLength: number;
}

/**
 * Deterministic WorkUnit-only prompt projection. There is no override seam.
 *
 * When — and only when — Core has proven an exact durable CorrectionContext
 * for this Attempt, a bounded correction section derived solely from that
 * validated authority is appended. The base WorkUnit projection is unchanged
 * byte for byte, so a base Attempt keeps its frozen M4-B prompt digest.
 */
export function projectWorkUnitToOpenCodePromptV2(
  workUnit: WorkUnitV2,
  correctionContext?: CorrectionContextV2,
): OpenCodeCliExecutorPromptV2 {
  validateWorkUnitV2(workUnit);
  const validation = workUnit.validationSpecRefs
    .map((spec) => `${spec.ordinal}. [${spec.kind}] ${spec.instruction}`)
    .join("\n");
  const criteria = workUnit.acceptanceCriteria.map((criterion, index) => `${index + 1}. ${criterion}`).join("\n");
  const text = [
    "You are the implementation Executor for one authorized Ralph WorkUnit.",
    "Implement the requested change in the exact project workspace. Inspect existing files as needed.",
    "",
    `Task: ${workUnit.title}`,
    `Goal: ${workUnit.goal}`,
    `Required change: ${workUnit.change}`,
    `Scope: ${workUnit.scope}`,
    `Covers: ${workUnit.covers}`,
    "Acceptance criteria:",
    criteria || "(none)",
    `Expected evidence: ${workUnit.expectedEvidence}`,
    "Validation instructions (informational; Core executes and decides them):",
    validation || "(none)",
    "",
    "Constraints:",
    "- Work only inside the current project root.",
    "- Do not modify .rb/**, .rb-harness/**, or .git/**.",
    "- Do not commit or push.",
    "- Do not decide Validation PASS or Audit ACCEPT.",
    "- Do not resolve Findings or mark a Task or Run complete.",
    "- Your final textual response is informational only; workspace evidence is authoritative.",
    ...(correctionContext === undefined ? [] : projectCorrectionSectionV2(correctionContext, workUnit)),
  ].join("\n");
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength === 0 || byteLength > MAX_OPENCODE_EXECUTOR_PROMPT_BYTES_V2) {
    throw new RalphM4BError("M4B_PROVIDER_RESULT_INVALID", "M4B_PROMPT_SIZE_INVALID");
  }
  return Object.freeze({ text, promptDigest: sha256(text), byteLength });
}

/**
 * The correction section is a pure function of the validated CorrectionContext.
 * It never consults the Attempt ordinal: an Attempt with no proven Finding
 * receives no correction input at all.
 */
export function projectCorrectionSectionV2(correctionContext: CorrectionContextV2, workUnit: WorkUnitV2): readonly string[] {
  validateCorrectionContextV2(correctionContext);
  if (correctionContext.taskId !== workUnit.taskId
    || correctionContext.currentAttemptId !== workUnit.attemptId
    || correctionContext.runId !== workUnit.runId
    || correctionContext.phaseId !== workUnit.phaseId) {
    throw new RalphM4CError("M4C_CORRECTION_PROMPT_PROJECTION_INVALID", "M4C_CORRECTION_PROMPT_PROJECTION_INVALID: context is not bound to this WorkUnit");
  }
  if (correctionContext.openFindings.length === 0 || correctionContext.openFindings.length > MAX_OPENCODE_CORRECTION_FINDINGS_V2) {
    throw new RalphM4CError("M4C_CORRECTION_PROMPT_PROJECTION_INVALID", "M4C_CORRECTION_PROMPT_PROJECTION_INVALID: unbounded or empty Finding set");
  }

  const sources = correctionContext.sourceRejectedAttempts
    .map((source) => `${source.ordinal}. ${source.attemptId}`)
    .join("\n");
  const findings = correctionContext.openFindings.flatMap((finding, index) => {
    // The criterion identifies one authorized validation spec. Restating that
    // exact instruction keeps the correction input actionable without adding
    // any authority beyond the WorkUnit already dispatched with this Attempt.
    const spec = workUnit.validationSpecRefs.find((candidate) => candidate.validationSpecId === finding.criterionId);
    return [
      `${index + 1}. Finding ${finding.findingId}`,
      `   Criterion: ${finding.criterionId}`,
      `   Severity: ${finding.severity}`,
      `   Status: ${finding.status}`,
      `   Observed failure: ${finding.observed}`,
      ...(spec === undefined ? [] : [`   Failing validation [${spec.kind}]: ${spec.instruction}`]),
      `   Remediation hint: ${finding.remediationHint ?? "(none provided)"}`,
    ];
  });

  return [
    "",
    "CORRECTION ATTEMPT",
    "This is a correction Attempt. A previous Attempt for this Task was audited and rejected.",
    `Correction context: ${correctionContext.contextId}`,
    "Rejected source Attempts:",
    sources || "(none)",
    "",
    "The following Findings are the authoritative correction input. They are open Core",
    "Findings recorded against this Task; correct the actual issue each one describes.",
    ...findings,
    "",
    "Correction requirements:",
    "- Inspect the current workspace before changing anything; it already contains the rejected work.",
    "- Correct the real defect each Finding above describes, not only its symptom.",
    "- Findings are the authoritative correction input for this Attempt.",
    "- Do not infer what to do from the Attempt number; act only on the Findings above.",
    "- Do not mark any Finding resolved; you have no Finding authority.",
    "- Do not claim Validation PASS.",
    "- Do not claim Audit ACCEPT.",
    "- Do not commit or push.",
    "- Core independently revalidates and reaudits this workspace after you finish.",
  ];
}
