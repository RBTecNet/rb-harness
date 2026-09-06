import { randomUUID } from "node:crypto";
import type { ExecutionDocument } from "../../../types.js";
import { scopeTokenCoversPath } from "../../../path-ownership.js";
import type { RalphEventStoreV2 } from "../operational-b1/index.js";
import {
  repairStateSnapshotWhileLeasedV2,
  revalidateLeaseOwnershipV2,
  refreshLeasedRunV2,
  releaseLeasedRunV2,
  deriveExecutorReleaseProofV2,
  type LeasedRunV2,
} from "../operational-b2/index.js";
import { commitRalphEventV2 } from "../operational-b1/index.js";
import type { AttemptStateV2, RalphRuntimeStateV2 } from "../operational-v2/contracts.js";
import {
  createRalphEventV2,
  type EventPayloadMapV2,
  type RalphEventTypeV2,
  type RalphEventV2,
  type UnsignedRalphEventV2,
} from "../operational-v2/events.js";
import {
  reopenAuthorizedInvocationV2,
  type ReopenedAuthorizedInvocationV2,
} from "../operational-b3/index.js";
import {
  assertTrustedExecutorObservationV2,
} from "../operational-b4/execution.js";
import type { TrustedExecutorObservationV2 } from "../operational-b4/execution-observation.js";
import {
  attemptArtifactRefV2,
  persistImmutableJsonArtifactV2,
  readImmutableJsonArtifactV2,
} from "../operational-b4/artifacts.js";
import {
  readInvocationResultV2,
  validateInvocationResultV2,
  type InvocationResultV2,
} from "../operational-b4/invocation-result.js";
import {
  observeWorkspaceManifestV2,
  persistWorkspaceAfterManifestV2,
  readWorkspaceAfterManifestV2,
  readWorkspaceBeforeManifestV2,
  workspaceAfterRefV2,
  workspaceBeforeRefV2,
  workspaceManifestCoreJson,
  type WorkspaceManifestBindingV2,
  type WorkspaceManifestObservationV2,
  type WorkspaceManifestV2,
} from "../operational-b4/workspace-manifest.js";
import { canonicalJson } from "../canonical-json.js";
import { isSha256Digest, sha256Canonical } from "../hashing.js";

export const C_EVIDENCE_ERROR_CODES = [
  "C_AUTHORIZATION_REQUIRED",
  "C_EXECUTOR_OBSERVATION_REQUIRED",
  "C_RESULT_ARTIFACT_REQUIRED",
  "C_BEFORE_MANIFEST_REQUIRED",
  "C_WORKSPACE_RECONCILIATION_REQUIRED",
  "C_WORKSPACE_UNSTABLE",
  "C_EVIDENCE_IMMUTABLE_CONFLICT",
  "C_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION",
] as const;
export type CEvidenceErrorCode = typeof C_EVIDENCE_ERROR_CODES[number];

export class RalphCEvidenceError extends Error {
  constructor(readonly code: CEvidenceErrorCode, message: string = code, readonly cause?: unknown) {
    super(message);
    this.name = "RalphCEvidenceError";
  }
}

export const EVIDENCE_CAPTURE_SCHEMA_V2 = "rb-ralph-evidence-capture/v1" as const;

export const EVIDENCE_CHANGE_KINDS = [
  "ADDED",
  "MODIFIED",
  "DELETED",
  "TYPE_CHANGED",
  "MODE_CHANGED",
] as const;
export type EvidenceChangeKindV2 = typeof EVIDENCE_CHANGE_KINDS[number];

export interface EvidenceChangedPathV2 {
  readonly path: string;
  readonly kind: EvidenceChangeKindV2;
}

export interface EvidenceCaptureV2 {
  readonly schema: typeof EVIDENCE_CAPTURE_SCHEMA_V2;
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly invocationId: string;
  readonly workUnitId: string;
  readonly workUnitDigest: string;
  readonly invocationResultRef: string;
  readonly invocationResultDigest: string;
  readonly beforeManifestRef: string;
  readonly beforeManifestDigest: string;
  readonly beforeFingerprint: string;
  readonly afterManifestRef: string;
  readonly afterManifestDigest: string;
  readonly afterFingerprint: string;
  readonly changedPaths: readonly string[];
  readonly changedPathKinds: readonly EvidenceChangedPathV2[];
  readonly outsideScopePaths: readonly string[];
  readonly controlPlaneChangedPaths: readonly string[];
  readonly executorClaims: Readonly<Record<string, string>>;
  readonly capturedAt: string;
  readonly evidenceDigest: string;
}

export function evidenceCaptureRefV2(attemptId: string): string {
  return attemptArtifactRefV2(attemptId, "evidence-capture.json");
}

export function createEvidenceCaptureV2(input: Omit<EvidenceCaptureV2, "schema" | "evidenceDigest">): EvidenceCaptureV2 {
  validateEvidenceCaptureInput(input);
  const base = { schema: EVIDENCE_CAPTURE_SCHEMA_V2, ...input };
  const evidence: EvidenceCaptureV2 = { ...base, evidenceDigest: sha256Canonical(base) };
  validateEvidenceCaptureV2(evidence);
  return evidence;
}

export function validateEvidenceCaptureV2(value: unknown): asserts value is EvidenceCaptureV2 {
  if (!isRecord(value)) throw new RalphCEvidenceError("C_EVIDENCE_IMMUTABLE_CONFLICT", "C_EVIDENCE_IMMUTABLE_CONFLICT: EvidenceCapture is not an object");
  assertExactKeys(value, [
    "schema", "runId", "phaseId", "taskId", "attemptId", "invocationId", "workUnitId", "workUnitDigest",
    "invocationResultRef", "invocationResultDigest", "beforeManifestRef", "beforeManifestDigest", "beforeFingerprint",
    "afterManifestRef", "afterManifestDigest", "afterFingerprint", "changedPaths", "changedPathKinds", "outsideScopePaths",
    "controlPlaneChangedPaths", "executorClaims", "capturedAt", "evidenceDigest",
  ]);
  if (value.schema !== EVIDENCE_CAPTURE_SCHEMA_V2) throw new RalphCEvidenceError("C_EVIDENCE_IMMUTABLE_CONFLICT", "C_EVIDENCE_IMMUTABLE_CONFLICT: schema");
  for (const key of ["runId", "phaseId", "taskId", "attemptId", "invocationId", "workUnitId", "capturedAt"] as const) assertSafeIdentity(value[key]);
  for (const key of ["workUnitDigest", "invocationResultDigest", "beforeManifestDigest", "beforeFingerprint", "afterManifestDigest", "afterFingerprint", "evidenceDigest"] as const) {
    if (!isSha256Digest(value[key])) throw new RalphCEvidenceError("C_EVIDENCE_IMMUTABLE_CONFLICT", `C_EVIDENCE_IMMUTABLE_CONFLICT: ${key}`);
  }
  for (const key of ["invocationResultRef", "beforeManifestRef", "afterManifestRef"] as const) assertSafeArtifactRef(value[key]);
  assertPaths(value.changedPaths);
  if (!Array.isArray(value.changedPathKinds) || value.changedPathKinds.length !== value.changedPaths.length) throw new RalphCEvidenceError("C_EVIDENCE_IMMUTABLE_CONFLICT", "C_EVIDENCE_IMMUTABLE_CONFLICT: changed path kinds");
  for (let index = 0; index < value.changedPathKinds.length; index += 1) {
    const item = value.changedPathKinds[index];
    if (!isRecord(item) || Object.keys(item).some((key) => !["path", "kind"].includes(key)) || item.path !== value.changedPaths[index] || !EVIDENCE_CHANGE_KINDS.includes(item.kind as EvidenceChangeKindV2)) {
      throw new RalphCEvidenceError("C_EVIDENCE_IMMUTABLE_CONFLICT", "C_EVIDENCE_IMMUTABLE_CONFLICT: changed path kind binding");
    }
  }
  assertPaths(value.outsideScopePaths);
  assertPaths(value.controlPlaneChangedPaths);
  validateSafeClaims(value.executorClaims);
  const { evidenceDigest: _ignored, ...base } = value;
  if (sha256Canonical(base) !== value.evidenceDigest) throw new RalphCEvidenceError("C_EVIDENCE_IMMUTABLE_CONFLICT", "C_EVIDENCE_IMMUTABLE_CONFLICT: digest mismatch");
}

export async function readEvidenceCaptureV2(store: RalphEventStoreV2, attemptId: string): Promise<EvidenceCaptureV2 | undefined> {
  return readImmutableJsonArtifactV2({ store, ref: evidenceCaptureRefV2(attemptId), validate: validateEvidenceCaptureV2 });
}

export async function persistEvidenceCaptureV2(
  store: RalphEventStoreV2,
  evidence: EvidenceCaptureV2,
  nonce: string,
): Promise<Awaited<ReturnType<typeof persistImmutableJsonArtifactV2<EvidenceCaptureV2>>>> {
  validateEvidenceCaptureV2(evidence);
  return persistImmutableJsonArtifactV2({ store, ref: evidenceCaptureRefV2(evidence.attemptId), artifact: evidence, validate: validateEvidenceCaptureV2, nonce });
}

export interface CaptureEvidenceV2Input {
  readonly leasedRun: LeasedRunV2;
  readonly plan: ExecutionDocument;
  /** Trusted observation facts produced by the B4 continuation. */
  readonly observation: TrustedExecutorObservationV2;
  readonly attemptId?: string;
  readonly workspaceFingerprintFileSystem?: import("../fingerprint.js").WorkspaceFingerprintFileSystem;
  readonly clock?: () => string;
  readonly nonceFactory?: () => string;
  readonly eventIdFactory?: () => string;
}

export type CaptureEvidenceV2Result =
  | {
    readonly kind: "EVIDENCE_CAPTURED_READY_FOR_VALIDATION";
    readonly outcome: "EVIDENCE_CAPTURED_READY_FOR_VALIDATION";
    readonly state: RalphRuntimeStateV2;
    readonly attempt: AttemptStateV2;
    readonly evidence: EvidenceCaptureV2;
    readonly leaseReleased: true;
  }
  | {
    readonly kind: "CONTROL_PLANE_VIOLATION";
    readonly outcome: "CONTROL_PLANE_VIOLATION";
    readonly state: RalphRuntimeStateV2;
    readonly attempt: AttemptStateV2;
    readonly evidence: EvidenceCaptureV2;
    readonly leaseReleased: true;
  }
  | {
    readonly kind: "RECONCILIATION_REQUIRED";
    readonly outcome: "RECONCILIATION_REQUIRED";
    readonly state: RalphRuntimeStateV2;
    readonly attempt: AttemptStateV2;
    readonly invocationId: string;
    readonly observation: TrustedExecutorObservationV2;
    readonly leaseReleased: false;
  };

/**
 * C continuation after executor.finished.  This function consumes the sealed
 * observation produced by B4 and captures evidence; it has no executor
 * runtime or observation-minting path of its own.
 */
export async function captureEvidenceV2(input: CaptureEvidenceV2Input): Promise<CaptureEvidenceV2Result> {
  const clock = input.clock ?? (() => new Date().toISOString());
  const nonceFactory = input.nonceFactory ?? randomUUID;
  const eventIdFactory = input.eventIdFactory ?? randomUUID;
  await refreshLeasedRunV2(input.leasedRun, { workspaceComparison: "ALLOW_POST_EXECUTOR_DRIFT" });
  const initialAttempt = findAttempt(input.leasedRun.state, input.attemptId);
  if (!initialAttempt || !initialAttempt.invocation) throw new RalphCEvidenceError("C_AUTHORIZATION_REQUIRED", "C_AUTHORIZATION_REQUIRED: open authorized Attempt is required");
  const invocationId = initialAttempt.invocation.invocationId;
  assertTrustedExecutorObservationV2(input.observation);
  const observation = input.observation;
  if (initialAttempt.stage === "RECONCILING") return reconciliationResult(input.leasedRun.state, initialAttempt, invocationId, observation);
  if (initialAttempt.stage !== "POST_EXECUTOR_CAPTURE" && initialAttempt.stage !== "EVIDENCE_CAPTURING") {
    throw new RalphCEvidenceError("C_AUTHORIZATION_REQUIRED", "C_AUTHORIZATION_REQUIRED: executor.finished is required before EvidenceCapture");
  }
  if (observation.state !== "TERMINATED_QUIESCENT") {
    return await reconcileCapture(input, initialAttempt, invocationId, observation, "C_EXECUTOR_OBSERVATION_NOT_QUIESCENT", clock, nonceFactory, eventIdFactory);
  }

  let reopened: ReopenedAuthorizedInvocationV2;
  try {
    reopened = await reopenAuthorizedInvocationV2({
      leasedRun: input.leasedRun,
      plan: input.plan,
      attemptId: initialAttempt.attemptId,
      requireBaseFingerprint: false,
    });
  } catch (error) {
    if (error instanceof Error && (error.message.includes("WORKSPACE") || error.message.includes("FINGERPRINT") || error.message.includes("ARTIFACT"))) {
      return await reconcileCapture(input, initialAttempt, invocationId, observation, "C_AUTHORIZATION_REVALIDATION_FAILED", clock, nonceFactory, eventIdFactory);
    }
    throw error;
  }

  const before = await readWorkspaceBeforeManifestV2(input.leasedRun.store, reopened.attempt.attemptId);
  if (!before) return await reconcileCapture(input, reopened.attempt, invocationId, observation, "C_BEFORE_MANIFEST_REQUIRED", clock, nonceFactory, eventIdFactory);
  assertManifestBinding(before, manifestBinding(reopened));
  if (before.fingerprintDigest !== reopened.attempt.attemptBaseFingerprint || before.fingerprintDigest !== reopened.workUnit.attemptBaseFingerprint) {
    return await reconcileCapture(input, reopened.attempt, invocationId, observation, "C_BASE_FINGERPRINT_MISMATCH", clock, nonceFactory, eventIdFactory);
  }

  let currentAttempt = findAttempt(input.leasedRun.state, reopened.attempt.attemptId);
  if (!currentAttempt || currentAttempt.disposition !== "OPEN") throw new RalphCEvidenceError("C_AUTHORIZATION_REQUIRED");
  const result = await readInvocationResultV2(input.leasedRun.store, reopened.attempt.attemptId);
  if (!result) return await reconcileCapture(input, reopened.attempt, invocationId, observation, "C_RESULT_ARTIFACT_REQUIRED", clock, nonceFactory, eventIdFactory);
  assertResultBinding(result, reopened, currentAttempt, observation);

  let after: WorkspaceManifestV2;
  let evidence: EvidenceCaptureV2 | undefined = await readEvidenceCaptureV2(input.leasedRun.store, currentAttempt.attemptId);

  if (evidence) {
    assertEvidenceBinding(evidence, reopened, result, before);
    let stable: WorkspaceManifestObservationV2;
    try {
      stable = await stableAfterObservation(input, reopened, clock);
    } catch (error) {
      if (error instanceof RalphCEvidenceError && error.code === "C_WORKSPACE_UNSTABLE") return await reconcileCapture(input, currentAttempt, invocationId, observation, error.code, clock, nonceFactory, eventIdFactory);
      throw error;
    }
    const existingAfter = await requireAfterManifest(input.leasedRun.store, currentAttempt.attemptId, reopened);
    if (evidence.afterManifestRef !== workspaceAfterRefV2(currentAttempt.attemptId)
      || evidence.afterManifestDigest !== existingAfter.manifestDigest
      || evidence.afterFingerprint !== existingAfter.fingerprintDigest) {
      throw new RalphCEvidenceError("C_EVIDENCE_IMMUTABLE_CONFLICT", "C_EVIDENCE_IMMUTABLE_CONFLICT: after-manifest binding conflict");
    }
    if (workspaceManifestCoreJson(stable.manifest) !== workspaceManifestCoreJson(existingAfter)) {
      return await reconcileCapture(input, currentAttempt, invocationId, observation, "C_WORKSPACE_CHANGED_AFTER_EVIDENCE", clock, nonceFactory, eventIdFactory);
    }
    assertEvidenceWorkspaceDerivation(evidence, before, existingAfter, reopened.workUnit.scope, reopened.workUnit.covers);
    after = existingAfter;
  } else {
    let expectedPostFingerprint: string;
    if (currentAttempt.stage === "POST_EXECUTOR_CAPTURE") {
      let preview: WorkspaceManifestObservationV2;
      try {
        preview = await stableAfterObservation(input, reopened, clock);
      } catch (error) {
        if (error instanceof RalphCEvidenceError && error.code === "C_WORKSPACE_UNSTABLE") return await reconcileCapture(input, currentAttempt, invocationId, observation, error.code, clock, nonceFactory, eventIdFactory);
        throw error;
      }
      expectedPostFingerprint = preview.fingerprint.fingerprintDigest;
      const evidenceCaptureId = deterministicEvidenceCaptureId(reopened, before, expectedPostFingerprint);
      const started = coreEvent(input.leasedRun.state, "evidence.capture-started", {
        evidenceCaptureId,
        postExecutorFingerprint: expectedPostFingerprint,
        startedAt: clock(),
      }, { phaseId: reopened.attempt.phaseId, taskId: reopened.attempt.taskId, attemptId: reopened.attempt.attemptId, eventIdFactory, clock });
      await commitCEvidenceEvent(input.leasedRun, started, clock, nonceFactory);
      currentAttempt = findAttempt(input.leasedRun.state, reopened.attempt.attemptId);
      if (!currentAttempt || currentAttempt.stage !== "EVIDENCE_CAPTURING" || !currentAttempt.evidenceCaptureInProgress) throw new RalphCEvidenceError("C_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION");
    } else {
      expectedPostFingerprint = currentAttempt.evidenceCaptureInProgress?.postExecutorFingerprint ?? currentAttempt.postExecutorFingerprint ?? "";
      if (!expectedPostFingerprint) throw new RalphCEvidenceError("C_AUTHORIZATION_REQUIRED", "C_AUTHORIZATION_REQUIRED: capture progress is incomplete");
    }

    let stable: WorkspaceManifestObservationV2;
    try {
      stable = await stableAfterObservation(input, reopened, clock);
    } catch (error) {
      if (error instanceof RalphCEvidenceError && error.code === "C_WORKSPACE_UNSTABLE") return await reconcileCapture(input, currentAttempt, invocationId, observation, error.code, clock, nonceFactory, eventIdFactory);
      throw error;
    }
    if (stable.fingerprint.fingerprintDigest !== expectedPostFingerprint) {
      return await reconcileCapture(input, currentAttempt, invocationId, observation, "C_POST_EXECUTOR_FINGERPRINT_CHANGED", clock, nonceFactory, eventIdFactory);
    }
    const existingAfter = await readWorkspaceAfterManifestV2(input.leasedRun.store, currentAttempt.attemptId);
    if (existingAfter) {
      assertManifestBinding(existingAfter, manifestBinding(reopened));
      if (workspaceManifestCoreJson(existingAfter) !== workspaceManifestCoreJson(stable.manifest)) {
        return await reconcileCapture(input, currentAttempt, invocationId, observation, "C_AFTER_MANIFEST_IMMUTABLE_CONFLICT", clock, nonceFactory, eventIdFactory);
      }
      after = existingAfter;
    } else {
      await revalidateLeaseOwnershipV2(input.leasedRun);
      await persistWorkspaceAfterManifestV2(input.leasedRun.store, stable.manifest, nonceFactory());
      after = await requireAfterManifest(input.leasedRun.store, currentAttempt.attemptId, reopened);
    }
    let critical: WorkspaceManifestObservationV2;
    try {
      critical = await stableAfterObservation(input, reopened, clock);
    } catch (error) {
      if (error instanceof RalphCEvidenceError && error.code === "C_WORKSPACE_UNSTABLE") return await reconcileCapture(input, currentAttempt, invocationId, observation, error.code, clock, nonceFactory, eventIdFactory);
      throw error;
    }
    if (workspaceManifestCoreJson(critical.manifest) !== workspaceManifestCoreJson(after)) {
      return await reconcileCapture(input, currentAttempt, invocationId, observation, "C_WORKSPACE_CHANGED_DURING_CAPTURE", clock, nonceFactory, eventIdFactory);
    }
  }

  if (!evidence) {
    evidence = createEvidenceCaptureV2({
      runId: reopened.invocation.runId,
      phaseId: reopened.invocation.phaseId,
      taskId: reopened.invocation.taskId,
      attemptId: reopened.invocation.attemptId,
      invocationId: reopened.invocation.invocationId,
      workUnitId: reopened.workUnit.workUnitId,
      workUnitDigest: reopened.workUnit.workUnitDigest,
      invocationResultRef: attemptArtifactRefV2(reopened.attempt.attemptId, "invocation-result.json"),
      invocationResultDigest: result.resultDigest,
      beforeManifestRef: workspaceBeforeRefV2(reopened.attempt.attemptId),
      beforeManifestDigest: before.manifestDigest,
      beforeFingerprint: before.fingerprintDigest,
      afterManifestRef: workspaceAfterRefV2(reopened.attempt.attemptId),
      afterManifestDigest: after.manifestDigest,
      afterFingerprint: after.fingerprintDigest,
      ...deriveWorkspaceChangesV2(before, after, reopened.workUnit.scope, reopened.workUnit.covers),
      executorClaims: observation.safeMetadata,
      capturedAt: clock(),
    });
    await revalidateLeaseOwnershipV2(input.leasedRun);
    await persistEvidenceCaptureV2(input.leasedRun.store, evidence, nonceFactory());
    evidence = await readEvidenceCaptureV2(input.leasedRun.store, reopened.attempt.attemptId) ?? evidence;
  }

  currentAttempt = findAttempt(input.leasedRun.state, reopened.attempt.attemptId);
  if (!currentAttempt || currentAttempt.disposition !== "OPEN") throw new RalphCEvidenceError("C_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION");
  if (!currentAttempt.evidenceCapture) {
    if (!currentAttempt.evidenceCaptureInProgress) throw new RalphCEvidenceError("C_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION");
    const captured = coreEvent(input.leasedRun.state, "evidence.captured", {
      evidenceCaptureId: currentAttempt.evidenceCaptureInProgress.evidenceCaptureId,
      evidenceDigest: evidence.evidenceDigest,
      postExecutorFingerprint: currentAttempt.evidenceCaptureInProgress.postExecutorFingerprint,
      capturedAt: evidence.capturedAt,
    }, { phaseId: currentAttempt.phaseId, taskId: currentAttempt.taskId, attemptId: currentAttempt.attemptId, eventIdFactory, clock });
    await commitCEvidenceEvent(input.leasedRun, captured, clock, nonceFactory);
    currentAttempt = findAttempt(input.leasedRun.state, reopened.attempt.attemptId);
    if (!currentAttempt || currentAttempt.disposition !== "OPEN" || !currentAttempt.evidenceCapture) throw new RalphCEvidenceError("C_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION");
  }

  const finalObservation = input.observation;
  if (finalObservation.state !== "TERMINATED_QUIESCENT") {
    return await reconcileCapture(input, currentAttempt, invocationId, finalObservation, "C_EXECUTOR_QUIESCENCE_LOST_BEFORE_RELEASE", clock, nonceFactory, eventIdFactory);
  }
  const refs = [
    attemptArtifactRefV2(currentAttempt.attemptId, "work-unit.json"),
    attemptArtifactRefV2(currentAttempt.attemptId, "invocation.json"),
    attemptArtifactRefV2(currentAttempt.attemptId, "invocation-result.json"),
    workspaceBeforeRefV2(currentAttempt.attemptId),
    workspaceAfterRefV2(currentAttempt.attemptId),
    evidenceCaptureRefV2(currentAttempt.attemptId),
  ];
  const releaseProof = await deriveExecutorReleaseProofV2(input.leasedRun, finalObservation, refs);
  const controlPlaneViolation = evidence.controlPlaneChangedPaths.length > 0;
  if (controlPlaneViolation) {
    const close = coreEvent(input.leasedRun.state, "attempt.closed", {
      attemptId: currentAttempt.attemptId,
      closureReason: "CONTROL_PLANE_VIOLATION",
      finishedAt: evidence.capturedAt,
    }, { phaseId: currentAttempt.phaseId, taskId: currentAttempt.taskId, attemptId: currentAttempt.attemptId, eventIdFactory, clock });
    await commitCEvidenceEvent(input.leasedRun, close, clock, nonceFactory);
    currentAttempt = findAttempt(input.leasedRun.state, currentAttempt.attemptId);
    if (!currentAttempt) throw new RalphCEvidenceError("C_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION");
  }
  await releaseLeasedRunV2(input.leasedRun, { proof: releaseProof });
  return controlPlaneViolation
    ? { kind: "CONTROL_PLANE_VIOLATION", outcome: "CONTROL_PLANE_VIOLATION", state: input.leasedRun.state, attempt: currentAttempt, evidence, leaseReleased: true }
    : { kind: "EVIDENCE_CAPTURED_READY_FOR_VALIDATION", outcome: "EVIDENCE_CAPTURED_READY_FOR_VALIDATION", state: input.leasedRun.state, attempt: currentAttempt, evidence, leaseReleased: true };
}

export const runEvidenceCaptureV2 = captureEvidenceV2;

async function stableAfterObservation(input: CaptureEvidenceV2Input, reopened: ReopenedAuthorizedInvocationV2, _clock: () => string): Promise<WorkspaceManifestObservationV2> {
  const binding = manifestBinding(reopened);
  const first = await observeWorkspaceManifestV2({
    projectRoot: input.leasedRun.projectRoot,
    policy: input.leasedRun.snapshot.workspacePolicy,
    binding,
    fileSystem: input.workspaceFingerprintFileSystem ?? input.leasedRun.workspaceFingerprintFileSystem,
  });
  const second = await observeWorkspaceManifestV2({
    projectRoot: input.leasedRun.projectRoot,
    policy: input.leasedRun.snapshot.workspacePolicy,
    binding,
    fileSystem: input.workspaceFingerprintFileSystem ?? input.leasedRun.workspaceFingerprintFileSystem,
  });
  if (workspaceManifestCoreJson(first.manifest) !== workspaceManifestCoreJson(second.manifest)) throw new RalphCEvidenceError("C_WORKSPACE_UNSTABLE", "C_WORKSPACE_UNSTABLE: post-executor workspace changed during observation");
  return first;
}

async function requireAfterManifest(store: RalphEventStoreV2, attemptId: string, reopened: ReopenedAuthorizedInvocationV2): Promise<WorkspaceManifestV2> {
  const after = await readWorkspaceAfterManifestV2(store, attemptId);
  if (!after) throw new RalphCEvidenceError("C_WORKSPACE_RECONCILIATION_REQUIRED", "C_WORKSPACE_RECONCILIATION_REQUIRED: after manifest is missing");
  assertManifestBinding(after, manifestBinding(reopened));
  return after;
}

async function reconcileCapture(
  input: CaptureEvidenceV2Input,
  attempt: AttemptStateV2,
  invocationId: string,
  observation: TrustedExecutorObservationV2,
  reason: string,
  clock: () => string,
  nonceFactory: () => string,
  eventIdFactory: () => string,
): Promise<CaptureEvidenceV2Result> {
  if (attempt.stage === "RECONCILING") return reconciliationResult(input.leasedRun.state, attempt, invocationId, observation);
  const event = coreEvent(input.leasedRun.state, "attempt.reconciliation-required", {
    reason,
    proofRef: `evidence-observation-${observation.observationId}`,
  }, { phaseId: attempt.phaseId, taskId: attempt.taskId, attemptId: attempt.attemptId, eventIdFactory, clock });
  await commitCEvidenceEvent(input.leasedRun, event, clock, nonceFactory);
  const next = input.leasedRun.state.attempts[attempt.attemptId];
  if (!next) throw new RalphCEvidenceError("C_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION");
  return reconciliationResult(input.leasedRun.state, next, invocationId, observation);
}

function reconciliationResult(state: RalphRuntimeStateV2, attempt: AttemptStateV2, invocationId: string, observation: TrustedExecutorObservationV2): CaptureEvidenceV2Result {
  return { kind: "RECONCILIATION_REQUIRED", outcome: "RECONCILIATION_REQUIRED", state, attempt, invocationId, observation, leaseReleased: false };
}

async function commitCEvidenceEvent(leasedRun: LeasedRunV2, event: RalphEventV2, clock: () => string, nonceFactory: () => string): Promise<void> {
  await revalidateLeaseOwnershipV2(leasedRun);
  let committed;
  try {
    committed = await commitRalphEventV2({ store: leasedRun.store, state: leasedRun.state, event, writtenAt: clock(), nonce: nonceFactory() });
  } catch (error) {
    if (error instanceof Error && error.message.includes("DURABILITY_UNKNOWN")) throw new RalphCEvidenceError("C_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION", error.message, error);
    throw error;
  }
  if (committed.eventDurability !== "DURABLE") throw new RalphCEvidenceError("C_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION");
  try {
    if (committed.snapshotStatus !== "CURRENT") await repairStateSnapshotWhileLeasedV2(leasedRun, { writtenAt: clock(), nonce: nonceFactory(), workspaceComparison: "ALLOW_POST_EXECUTOR_DRIFT" });
    await refreshLeasedRunV2(leasedRun, { workspaceComparison: "ALLOW_POST_EXECUTOR_DRIFT" });
  } catch (error) {
    throw new RalphCEvidenceError("C_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION", "C_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION: replay/refresh failed", error);
  }
}

function coreEvent<TType extends RalphEventTypeV2>(
  state: RalphRuntimeStateV2,
  eventType: TType,
  payload: EventPayloadMapV2[TType],
  context: { readonly phaseId: string; readonly taskId: string; readonly attemptId: string; readonly eventIdFactory: () => string; readonly clock: () => string },
): RalphEventV2 {
  const occurredAt = context.clock();
  return createRalphEventV2({
    eventId: `c-${eventType}-${context.attemptId}-${context.eventIdFactory()}`,
    eventType,
    schemaVersion: "rb-ralph-event/v2",
    runId: state.runId,
    sequence: state.lastSequence + 1,
    occurredAt,
    recordedAt: occurredAt,
    entity: { kind: "attempt", id: context.attemptId },
    phaseId: context.phaseId,
    taskId: context.taskId,
    attemptId: context.attemptId,
    actor: "CORE",
    causationId: null,
    correlationId: `${state.runId}:${context.attemptId}`,
    payload,
    previousEventHash: state.lastEventHash,
  } as UnsignedRalphEventV2<TType>) as RalphEventV2;
}

function deterministicEvidenceCaptureId(reopened: ReopenedAuthorizedInvocationV2, before: WorkspaceManifestV2, postExecutorFingerprint: string): string {
  return `evidence-${sha256Canonical({ runId: reopened.invocation.runId, attemptId: reopened.invocation.attemptId, invocationId: reopened.invocation.invocationId, before: before.fingerprintDigest, postExecutorFingerprint }).slice("sha256:".length)}`;
}

function assertResultBinding(result: InvocationResultV2, reopened: ReopenedAuthorizedInvocationV2, attempt: AttemptStateV2, observation: TrustedExecutorObservationV2): void {
  validateInvocationResultV2(result);
  const executorFinished = attempt.executorFinished;
  if (result.runId !== reopened.invocation.runId
    || result.phaseId !== reopened.invocation.phaseId
    || result.taskId !== reopened.invocation.taskId
    || result.attemptId !== reopened.invocation.attemptId
    || !executorFinished
    || result.invocationId !== executorFinished.invocationId
    || result.status !== executorFinished.status
    || result.termination !== executorFinished.termination
    || result.finishedAt !== executorFinished.finishedAt
    || result.invocationId !== observation.invocationId
    || observation.record.runId !== reopened.invocation.runId
    || observation.record.phaseId !== reopened.invocation.phaseId
    || observation.record.taskId !== reopened.invocation.taskId
    || observation.record.attemptId !== reopened.invocation.attemptId
    || result.resultEnvelopeStatus !== observation.resultEnvelopeStatus
    || result.status !== observation.status
    || result.termination !== observation.termination
    || result.exitCode !== (observation.exitCode ?? null)
    || result.signal !== (observation.signal ?? null)
    || result.startedAt !== observation.startedAt
    || result.finishedAt !== observation.finishedAt) {
    throw new RalphCEvidenceError("C_RESULT_ARTIFACT_REQUIRED", "C_RESULT_ARTIFACT_REQUIRED: invocation-result does not bind to trusted termination");
  }
}

function assertEvidenceBinding(evidence: EvidenceCaptureV2, reopened: ReopenedAuthorizedInvocationV2, result: InvocationResultV2, before: WorkspaceManifestV2): void {
  if (evidence.runId !== reopened.invocation.runId || evidence.phaseId !== reopened.invocation.phaseId || evidence.taskId !== reopened.invocation.taskId || evidence.attemptId !== reopened.invocation.attemptId || evidence.invocationId !== reopened.invocation.invocationId || evidence.workUnitId !== reopened.workUnit.workUnitId || evidence.workUnitDigest !== reopened.workUnit.workUnitDigest || evidence.invocationResultRef !== attemptArtifactRefV2(reopened.attempt.attemptId, "invocation-result.json") || evidence.invocationResultDigest !== result.resultDigest || evidence.beforeManifestRef !== workspaceBeforeRefV2(reopened.attempt.attemptId) || evidence.beforeManifestDigest !== before.manifestDigest || evidence.beforeFingerprint !== before.fingerprintDigest) {
    throw new RalphCEvidenceError("C_EVIDENCE_IMMUTABLE_CONFLICT", "C_EVIDENCE_IMMUTABLE_CONFLICT: EvidenceCapture binding conflict");
  }
}

function assertEvidenceWorkspaceDerivation(
  evidence: EvidenceCaptureV2,
  before: WorkspaceManifestV2,
  after: WorkspaceManifestV2,
  scope: string,
  covers: string,
): void {
  const persisted = {
    changedPaths: evidence.changedPaths,
    changedPathKinds: evidence.changedPathKinds,
    outsideScopePaths: evidence.outsideScopePaths,
    controlPlaneChangedPaths: evidence.controlPlaneChangedPaths,
  };
  const authoritative = deriveWorkspaceChangesV2(before, after, scope, covers);
  if (canonicalJson(persisted) !== canonicalJson(authoritative)) {
    throw new RalphCEvidenceError(
      "C_EVIDENCE_IMMUTABLE_CONFLICT",
      "C_EVIDENCE_IMMUTABLE_CONFLICT: derived workspace evidence does not match authoritative manifests",
    );
  }
}

function assertManifestBinding(manifest: WorkspaceManifestV2, binding: WorkspaceManifestBindingV2): void {
  if (manifest.runId !== binding.runId || manifest.phaseId !== binding.phaseId || manifest.taskId !== binding.taskId || manifest.attemptId !== binding.attemptId || manifest.invocationId !== binding.invocationId) throw new RalphCEvidenceError("C_WORKSPACE_RECONCILIATION_REQUIRED", "C_WORKSPACE_RECONCILIATION_REQUIRED: manifest binding conflict");
}

function manifestBinding(reopened: ReopenedAuthorizedInvocationV2): WorkspaceManifestBindingV2 {
  return {
    runId: reopened.invocation.runId,
    phaseId: reopened.invocation.phaseId,
    taskId: reopened.invocation.taskId,
    attemptId: reopened.invocation.attemptId,
    invocationId: reopened.invocation.invocationId,
  };
}

interface ComparableWorkspaceEntry {
  readonly path: string;
  readonly plane: "control" | "product";
  readonly kind: string;
  readonly mode: number | null;
  readonly size?: number;
  readonly contentHash?: string;
  readonly target?: string;
  readonly policyRule?: string;
}

export function deriveWorkspaceChangesV2(before: WorkspaceManifestV2, after: WorkspaceManifestV2, scope: string, covers: string): {
  readonly changedPaths: readonly string[];
  readonly changedPathKinds: readonly EvidenceChangedPathV2[];
  readonly outsideScopePaths: readonly string[];
  readonly controlPlaneChangedPaths: readonly string[];
} {
  const left = manifestEntries(before);
  const right = manifestEntries(after);
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort(comparePath);
  const changedPathKinds: EvidenceChangedPathV2[] = [];
  for (const path of paths) {
    const oldEntry = left.get(path);
    const newEntry = right.get(path);
    const kind = changeKind(oldEntry, newEntry);
    if (kind) changedPathKinds.push({ path, kind });
  }
  const changedPaths = changedPathKinds.map((entry) => entry.path);
  const controlPlaneChangedPaths = changedPaths.filter((path) => path === ".rb" || path.startsWith(".rb/")).sort(comparePath);
  const ownership = [...tokenizeOwnership(scope), ...tokenizeOwnership(covers)];
  const outsideScopePaths = changedPaths.filter((path) => !controlPlaneChangedPaths.includes(path) && !ownership.some((token) => scopeTokenCoversPath(token, path))).sort(comparePath);
  return { changedPaths, changedPathKinds, outsideScopePaths, controlPlaneChangedPaths };
}

function manifestEntries(manifest: WorkspaceManifestV2): Map<string, ComparableWorkspaceEntry> {
  const result = new Map<string, ComparableWorkspaceEntry>();
  for (const entry of manifest.controlPlaneEntries) result.set(entry.path, { ...entry, plane: "control" });
  for (const entry of manifest.productWorkspaceEntries) result.set(entry.path, { ...entry, plane: "product" });
  for (const entry of manifest.excludedRoots) result.set(entry.path, {
    path: entry.path,
    plane: "product",
    kind: entry.kind,
    mode: entry.mode,
    policyRule: entry.policyRule,
  });
  return result;
}

function changeKind(oldEntry: ComparableWorkspaceEntry | undefined, newEntry: ComparableWorkspaceEntry | undefined): EvidenceChangeKindV2 | undefined {
  if (!oldEntry && newEntry) return "ADDED";
  if (oldEntry && !newEntry) return "DELETED";
  if (!oldEntry || !newEntry) return undefined;
  if (oldEntry.kind !== newEntry.kind || oldEntry.plane !== newEntry.plane) return "TYPE_CHANGED";
  if (oldEntry.mode !== newEntry.mode) return "MODE_CHANGED";
  if (canonicalJson(oldEntry) !== canonicalJson(newEntry)) return "MODIFIED";
  return undefined;
}

function tokenizeOwnership(value: string | readonly string[]): readonly string[] {
  if (typeof value === "string") return value.split(/[\s,\n]+/).map((token) => token.trim()).filter(Boolean);
  return value.flatMap((item) => tokenizeOwnership(item));
}

function findAttempt(state: RalphRuntimeStateV2, attemptId: string | undefined): AttemptStateV2 | undefined {
  if (attemptId) return state.attempts[attemptId];
  return Object.values(state.attempts).find((attempt) => attempt.disposition === "OPEN");
}

function assertSafeIdentity(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\0") || value.includes("/")) throw new RalphCEvidenceError("C_EVIDENCE_IMMUTABLE_CONFLICT", "C_EVIDENCE_IMMUTABLE_CONFLICT: unsafe identity");
}

function assertSafeArtifactRef(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^attempts\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new RalphCEvidenceError("C_EVIDENCE_IMMUTABLE_CONFLICT", "C_EVIDENCE_IMMUTABLE_CONFLICT: unsafe artifact reference");
}

function assertPaths(value: unknown): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.some((path) => typeof path !== "string" || path.length === 0 || path.startsWith("/") || path.split("/").includes("..") || path.includes("\0"))) throw new RalphCEvidenceError("C_EVIDENCE_IMMUTABLE_CONFLICT", "C_EVIDENCE_IMMUTABLE_CONFLICT: unsafe changed path");
  for (let index = 1; index < value.length; index += 1) if (comparePath(value[index - 1]!, value[index]!) >= 0) throw new RalphCEvidenceError("C_EVIDENCE_IMMUTABLE_CONFLICT", "C_EVIDENCE_IMMUTABLE_CONFLICT: paths are not sorted");
}

function validateSafeClaims(value: unknown): asserts value is Readonly<Record<string, string>> {
  if (!isRecord(value)) throw new RalphCEvidenceError("C_EVIDENCE_IMMUTABLE_CONFLICT", "C_EVIDENCE_IMMUTABLE_CONFLICT: claims are not bounded metadata");
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(key) || typeof item !== "string" || item.length > 512 || /(?:Bearer\s+\S+|-----BEGIN[^-]*PRIVATE KEY-----|(?:api[_-]?key|password|secret)\s*[:=])/i.test(item)) throw new RalphCEvidenceError("C_EVIDENCE_IMMUTABLE_CONFLICT", "C_EVIDENCE_IMMUTABLE_CONFLICT: unsafe executor claim");
  }
}

function validateEvidenceCaptureInput(input: Omit<EvidenceCaptureV2, "schema" | "evidenceDigest">): void {
  for (const key of ["runId", "phaseId", "taskId", "attemptId", "invocationId", "workUnitId", "capturedAt"] as const) assertSafeIdentity(input[key]);
  for (const key of ["workUnitDigest", "invocationResultDigest", "beforeManifestDigest", "beforeFingerprint", "afterManifestDigest", "afterFingerprint"] as const) {
    if (!isSha256Digest(input[key])) throw new RalphCEvidenceError("C_EVIDENCE_IMMUTABLE_CONFLICT", `C_EVIDENCE_IMMUTABLE_CONFLICT: ${key}`);
  }
  assertSafeArtifactRef(input.invocationResultRef);
  assertSafeArtifactRef(input.beforeManifestRef);
  assertSafeArtifactRef(input.afterManifestRef);
  assertPaths(input.changedPaths);
  if (!Array.isArray(input.changedPathKinds) || input.changedPathKinds.length !== input.changedPaths.length) throw new RalphCEvidenceError("C_EVIDENCE_IMMUTABLE_CONFLICT");
  assertPaths(input.outsideScopePaths);
  assertPaths(input.controlPlaneChangedPaths);
  validateSafeClaims(input.executorClaims);
}

function assertExactKeys(value: object, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new RalphCEvidenceError("C_EVIDENCE_IMMUTABLE_CONFLICT", `C_EVIDENCE_IMMUTABLE_CONFLICT: unknown fields ${unknown.sort().join(",")}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function comparePath(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}
