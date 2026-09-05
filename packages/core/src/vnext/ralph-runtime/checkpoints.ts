import type { RalphRuntimeState } from "./contracts.js";

export function expectedAttemptBaseFingerprint(state: Pick<RalphRuntimeState, "checkpoints">): string | undefined {
  return state.checkpoints.acceptedCheckpointFingerprint?.fingerprintDigest
    ?? state.checkpoints.runStartFingerprint?.fingerprintDigest;
}

export function assertAttemptBaseFingerprint(state: Pick<RalphRuntimeState, "checkpoints">, observedFingerprint: string): void {
  const expected = expectedAttemptBaseFingerprint(state);
  if (!expected) throw new Error("RALPH_ATTEMPT_BASE_CHECKPOINT_MISSING");
  if (observedFingerprint !== expected) throw new Error("RALPH_ATTEMPT_BASE_FINGERPRINT_MISMATCH");
}
