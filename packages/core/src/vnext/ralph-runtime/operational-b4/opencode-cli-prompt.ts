import type { WorkUnitV2 } from "../operational-b3/index.js";
import { validateWorkUnitV2 } from "../operational-b3/index.js";
import { sha256 } from "../hashing.js";
import { RalphM4BError } from "./opencode-cli-contract.js";

export const MAX_OPENCODE_EXECUTOR_PROMPT_BYTES_V2 = 64 * 1024;

export interface OpenCodeCliExecutorPromptV2 {
  readonly text: string;
  readonly promptDigest: string;
  readonly byteLength: number;
}

/** Deterministic WorkUnit-only prompt projection. There is no override seam. */
export function projectWorkUnitToOpenCodePromptV2(workUnit: WorkUnitV2): OpenCodeCliExecutorPromptV2 {
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
  ].join("\n");
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength === 0 || byteLength > MAX_OPENCODE_EXECUTOR_PROMPT_BYTES_V2) {
    throw new RalphM4BError("M4B_PROVIDER_RESULT_INVALID", "M4B_PROMPT_SIZE_INVALID");
  }
  return Object.freeze({ text, promptDigest: sha256(text), byteLength });
}
