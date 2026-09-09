import { sha256 } from "../hashing.js";
import type { WorkUnitV2 } from "../operational-b3/index.js";
import { M5B_LIMITS_V2, RalphM5BError } from "./contract.js";

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
export function projectWorkUnitToCodexPromptV2(workUnit: WorkUnitV2): CodexExecutorPromptV2 {
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
  ];
  const text = `${lines.join("\n")}\n`;
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > M5B_LIMITS_V2.promptMaxBytes) throw new RalphM5BError("M5B_PROVIDER_OUTPUT_LIMIT", "M5B_PROVIDER_OUTPUT_LIMIT: prompt");
  return Object.freeze({ text, promptDigest: sha256(text), byteLength });
}

function bounded(value: string): string {
  if (typeof value !== "string") throw new RalphM5BError("M5B_PROFILE_BINDING_INVALID", "M5B_PROFILE_BINDING_INVALID: work unit text");
  return value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value;
}
