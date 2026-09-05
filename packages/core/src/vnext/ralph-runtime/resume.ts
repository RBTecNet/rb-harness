import type { RalphRuntimeState } from "./contracts.js";
import { fingerprintWorkspace, type WorkspaceFingerprint, type WorkspaceFingerprintFileSystem } from "./fingerprint.js";
import { RalphEventStore, type RalphRuntimeFileSystem } from "./event-store.js";
import { readRunSnapshot } from "./run-snapshot.js";
import { replayRalphRuntime, RalphStateSnapshotError } from "./snapshot.js";

export type ResumeDisposition = "READY_TO_RESUME" | "RECONCILIATION_REQUIRED" | "FAILED_INTEGRITY";

export interface RalphResumeInspectionInput {
  readonly projectRoot: string;
  readonly runId: string;
  readonly genesisState: RalphRuntimeState;
  readonly currentProjectIdentity?: Readonly<Record<string, string>>;
  readonly currentPlanIdentity: string;
  readonly currentPlanHash: string;
  readonly currentReadyControlPlaneDigest: string;
  readonly currentEffectiveConfigDigest: string;
  readonly currentExecutorProfileDigest: string;
  readonly currentAuditorProfileDigest: string;
  readonly currentPermissionEnforceDigest: string;
  readonly fs?: RalphRuntimeFileSystem;
  readonly fingerprintFileSystem?: WorkspaceFingerprintFileSystem;
}

export interface ResumeValidationResult {
  readonly disposition: ResumeDisposition;
  readonly issues: readonly string[];
  readonly recoveredSnapshot?: boolean;
  readonly state?: RalphRuntimeState;
  readonly currentFingerprint?: WorkspaceFingerprint;
}

/**
 * Core-owned resume orchestration.  The caller supplies only current external
 * identities; ledger, snapshot, replay and workspace facts are derived here.
 */
export async function inspectRalphResume(input: RalphResumeInspectionInput): Promise<ResumeValidationResult> {
  if (input.genesisState.runId !== input.runId || input.genesisState.lastSequence !== 0 || input.genesisState.lastEventHash !== null) {
    return failed("genesis-state-invalid");
  }
  const store = new RalphEventStore({ projectRoot: input.projectRoot, runId: input.runId, fs: input.fs });
  try {
    await store.ensureLayout();
  } catch (error) {
    return failed(errorCode(error, "runtime-storage-unavailable"));
  }
  let snapshot;
  try {
    snapshot = await readRunSnapshot(store);
  } catch (error) {
    return failed(errorCode(error, "run-snapshot-invalid"));
  }

  let replay;
  try {
    replay = await replayRalphRuntime(store, input.genesisState);
  } catch (error) {
    return failed(errorCode(error, "event-ledger-or-replay-invalid"));
  }

  let currentFingerprint: WorkspaceFingerprint;
  try {
    currentFingerprint = await fingerprintWorkspace(input.projectRoot, snapshot.workspacePolicy, undefined, input.fingerprintFileSystem);
  } catch (error) {
    return failed(errorCode(error, "workspace-fingerprint-invalid"));
  }

  const integrityIssues: string[] = [];
  if (snapshot.runId !== input.runId || replay.state.runId !== input.runId) integrityIssues.push("run-identity-mismatch");
  if (snapshot.snapshotSchemaVersion !== "rb-ralph-run-snapshot/v1" || replay.state.format !== "rb-ralph-runtime-state/v1") integrityIssues.push("runtime-schema-unsupported");
  if (snapshot.workspacePolicy.policyDigest !== currentFingerprint.policyDigest) integrityIssues.push("workspace-policy-integrity-mismatch");
  if (integrityIssues.length > 0) return { disposition: "FAILED_INTEGRITY", issues: integrityIssues };

  const reconciliationIssues: string[] = [];
  if (input.currentProjectIdentity && !sameStringRecord(input.currentProjectIdentity, snapshot.projectIdentity)) reconciliationIssues.push("project-identity-mismatch");
  if (input.currentPlanIdentity !== snapshot.readyPlanIdentity) reconciliationIssues.push("plan-identity-mismatch");
  if (input.currentPlanHash !== snapshot.readyPlanHash) reconciliationIssues.push("plan-hash-mismatch");
  if (input.currentReadyControlPlaneDigest !== snapshot.initialFingerprint.controlPlaneFingerprint) reconciliationIssues.push("control-plane-mismatch");
  if (input.currentEffectiveConfigDigest !== snapshot.effectiveConfigDigest) reconciliationIssues.push("effective-config-mismatch");
  if (input.currentExecutorProfileDigest !== snapshot.executorProfile.descriptorDigest) reconciliationIssues.push("executor-profile-mismatch");
  if (input.currentAuditorProfileDigest !== snapshot.auditorProfile.descriptorDigest) reconciliationIssues.push("auditor-profile-mismatch");
  if (input.currentPermissionEnforceDigest !== snapshot.permissionEnforceDigest) reconciliationIssues.push("permission-enforce-mismatch");

  const expectedWorkspaceFingerprint = replay.state.checkpoints.acceptedCheckpointFingerprint?.fingerprintDigest
    ?? replay.state.checkpoints.runStartFingerprint?.fingerprintDigest
    ?? snapshot.initialFingerprint.fingerprintDigest;
  if (currentFingerprint.fingerprintDigest !== expectedWorkspaceFingerprint) reconciliationIssues.push("workspace-fingerprint-mismatch");
  if (Object.values(replay.state.attempts).some((attempt) => !attempt.closed)) reconciliationIssues.push("incomplete-attempt");
  if (replay.state.hold === "RECONCILIATION_REQUIRED") reconciliationIssues.push("reconciliation-hold");

  return reconciliationIssues.length > 0
    ? { disposition: "RECONCILIATION_REQUIRED", issues: reconciliationIssues, state: replay.state, currentFingerprint, ...(replay.snapshotRecovered ? { recoveredSnapshot: true } : {}) }
    : { disposition: "READY_TO_RESUME", issues: [], state: replay.state, currentFingerprint, ...(replay.snapshotRecovered ? { recoveredSnapshot: true } : {}) };
}

export const validateRalphResume = inspectRalphResume;

function sameStringRecord(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function failed(issue: string): ResumeValidationResult {
  return { disposition: "FAILED_INTEGRITY", issues: [issue] };
}

function errorCode(error: unknown, fallback: string): string {
  if (error instanceof RalphStateSnapshotError) return error.code;
  if (error instanceof Error && error.message) return error.message.split(":", 1)[0] ?? fallback;
  return fallback;
}
