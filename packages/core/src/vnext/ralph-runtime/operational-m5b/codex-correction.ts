import type { WorkUnitV2 } from "../operational-b3/index.js";
import {
  RalphM4CError,
  validateExactCorrectionContextForDispatchV2,
} from "../operational-b4/opencode-cli-correction.js";
import {
  correctionContextRefV2,
  readCorrectionContextV2,
  type CorrectionContextV2,
} from "../operational-f/correction-context.js";
import type { RalphEventStoreV2 } from "../operational-b1/index.js";
import type { AuthorizedInvocationV2 } from "../operational-b3/index.js";
import type { CodexProviderDescriptorV2 } from "./codex-artifacts.js";

/**
 * M5-C consumes the frozen provider-neutral M4-C correction authority.  This
 * module is only a structural adapter between Codex's physical descriptor and
 * the already-proven durable validator; it owns no Finding lifecycle rules.
 */

type ExactCorrectionDescriptorV2 = Parameters<typeof validateExactCorrectionContextForDispatchV2>[0]["descriptor"];

interface CodexCorrectionBindingV2 {
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly baseWorkspaceFingerprint: string;
  readonly correctionContextRef: string | null;
  readonly correctionContextDigest: string | null;
}

function asExactCorrectionDescriptorV2(value: CodexCorrectionBindingV2): ExactCorrectionDescriptorV2 {
  // The shared validator intentionally reads only this provider-neutral
  // binding.  No OpenCode session or transport fact is manufactured here.
  return value as unknown as ExactCorrectionDescriptorV2;
}

/**
 * Resolve and fully validate the durable context before Codex projection,
 * descriptor persistence, process creation or model inference.
 */
export async function resolveExactCodexCorrectionContextV2(input: {
  readonly store: RalphEventStoreV2;
  readonly authorizedInvocation: AuthorizedInvocationV2;
}): Promise<CorrectionContextV2 | undefined> {
  const core = input.authorizedInvocation.descriptor;
  const workUnit = input.authorizedInvocation.workUnit;
  const durable = await readCorrectionContextV2(input.store, core.attemptId);
  return validateExactCorrectionContextForDispatchV2({
    store: input.store,
    descriptor: asExactCorrectionDescriptorV2({
      runId: core.runId,
      phaseId: core.phaseId,
      taskId: core.taskId,
      attemptId: core.attemptId,
      baseWorkspaceFingerprint: workUnit.attemptBaseFingerprint,
      correctionContextRef: durable ? correctionContextRefV2(core.attemptId) : null,
      correctionContextDigest: durable?.contextDigest ?? null,
    }),
  });
}

/** Revalidate both durable authority and the exact Codex descriptor binding. */
export async function validateExactCodexCorrectionDescriptorV2(input: {
  readonly store: RalphEventStoreV2;
  readonly descriptor: CodexProviderDescriptorV2;
}): Promise<CorrectionContextV2 | undefined> {
  return validateExactCorrectionContextForDispatchV2({
    store: input.store,
    descriptor: asExactCorrectionDescriptorV2(input.descriptor),
  });
}

/** Exact prompt binding shared by tests and the Executor. */
export function assertCodexCorrectionPromptBindingV2(
  context: CorrectionContextV2 | undefined,
  workUnit: WorkUnitV2,
): void {
  if (context === undefined) return;
  if (context.runId !== workUnit.runId
    || context.phaseId !== workUnit.phaseId
    || context.taskId !== workUnit.taskId
    || context.currentAttemptId !== workUnit.attemptId
    || context.baseWorkspaceFingerprint !== workUnit.attemptBaseFingerprint) {
    throw new RalphM4CError("M4C_CORRECTION_PROMPT_PROJECTION_INVALID", "M5C_CORRECTION_PROMPT_BINDING_INVALID");
  }
}
