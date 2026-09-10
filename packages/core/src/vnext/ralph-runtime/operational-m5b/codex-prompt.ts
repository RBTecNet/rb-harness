import { sha256 } from "../hashing.js";
import type { WorkUnitV2 } from "../operational-b3/index.js";
import { validateCorrectionContextV2, type CorrectionContextV2 } from "../operational-f/correction-context.js";
import { M5B_LIMITS_V2, RalphM5BError } from "./contract.js";
import { assertCodexCorrectionPromptBindingV2 } from "./codex-correction.js";

export interface CodexExecutorPromptV2 {
  readonly text: string;
  readonly promptDigest: string;
  readonly byteLength: number;
}

/**
 * Project the Core WorkUnit into the single stdin prompt.
 *
 * The prompt describes the work; it is never a security boundary.  Every
 * control-plane guarantee in M5-B is physical: the provider runs in an
 * isolated projection that simply does not contain a Core-owned root, and
 * only a validated delta is ever published.
 */
export function projectWorkUnitToCodexPromptV2(
  workUnit: WorkUnitV2,
  correctionContext?: CorrectionContextV2,
): CodexExecutorPromptV2 {
  const lines = [
    "You are executing exactly one unit of work inside the current working directory.",
    "",
    `Task: ${bounded(workUnit.title)}`,
    `Goal: ${bounded(workUnit.goal)}`,
    `Change: ${bounded(workUnit.change)}`,
    `Owned paths (scope): ${bounded(workUnit.scope)}`,
    `Owned paths (covers): ${bounded(workUnit.covers)}`,
    "",
    "Acceptance criteria:",
    ...workUnit.acceptanceCriteria.map((criterion, index) => `  ${index + 1}. ${bounded(criterion)}`),
    "",
    "Expected evidence:",
    `  ${bounded(workUnit.expectedEvidence)}`,
    "",
    "Rules:",
    "  - Modify only the owned paths listed above, inside the current working directory.",
    "  - Make the smallest change that satisfies the acceptance criteria.",
    "  - Do not claim success, completion or validation: the host decides those.",
    "  - Return the required structured JSON result as your final message.",
    ...(correctionContext === undefined ? [] : projectCodexCorrectionSectionV2(workUnit, correctionContext)),
  ];
  const text = `${lines.join("\n")}\n`;
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > M5B_LIMITS_V2.promptMaxBytes) throw new RalphM5BError("M5B_PROVIDER_OUTPUT_LIMIT", "M5B_PROVIDER_OUTPUT_LIMIT: prompt");
  return Object.freeze({ text, promptDigest: sha256(text), byteLength });
}

/**
 * Deterministic, bounded projection of the exact durable correction
 * authority.  The ordinary M5-B prefix is untouched byte-for-byte.
 */
export function projectCodexCorrectionSectionV2(
  workUnit: WorkUnitV2,
  correctionContext: CorrectionContextV2,
): readonly string[] {
  validateCorrectionContextV2(correctionContext);
  assertCodexCorrectionPromptBindingV2(correctionContext, workUnit);
  if (correctionContext.openFindings.length === 0 || correctionContext.openFindings.length > 32) {
    throw new RalphM5BError("M5B_PROVIDER_OUTPUT_LIMIT", "M5C_CORRECTION_PROMPT_FINDING_SET_INVALID");
  }

  const sources = correctionContext.sourceRejectedAttempts.flatMap((source) => [
    `  - Attempt ID: ${bounded(source.attemptId)}`,
    `    ordinal: ${source.ordinal}`,
    `    closureReason: ${source.closureReason}`,
  ]);
  const findings = correctionContext.openFindings.flatMap((finding) => {
    const validation = workUnit.validationSpecRefs.find((spec) => spec.validationSpecId === finding.criterionId);
    return [
      `  - Finding ID: ${finding.findingId}`,
      `    criterionId: ${finding.criterionId}`,
      `    severity: ${finding.severity}`,
      `    status: ${finding.status}`,
      `    observed failure: ${finding.observed}`,
      `    remediationHint: ${finding.remediationHint ?? "(none provided)"}`,
      ...(validation === undefined ? [] : [
        `    failing validation [${validation.kind}]: ${validation.instruction}`,
      ]),
    ];
  });

  return [
    "",
    "CORRECTION ATTEMPT",
    `Correction context ID: ${correctionContext.contextId}`,
    `Correction context digest: ${correctionContext.contextDigest}`,
    "Source rejected Attempt IDs:",
    ...sources,
    "Authoritative OPEN Findings:",
    ...findings,
    "",
    "Correction rules:",
    "  - Inspect the current staged product state before changing it; it contains the rejected work.",
    "  - Correct the actual Finding described above, not merely its symptom.",
    "  - Act only on these authoritative Findings, never on the Attempt ordinal.",
    "  - Do not mark any Finding resolved.",
    "  - Do not claim Validation PASS.",
    "  - Do not claim Audit ACCEPT.",
    "  - Do not commit or push.",
    "  - Core independently validates and audits every result.",
  ];
}

function bounded(value: string): string {
  if (typeof value !== "string") throw new RalphM5BError("M5B_PROFILE_BINDING_INVALID", "M5B_PROFILE_BINDING_INVALID: work unit text");
  return value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value;
}
