import { randomUUID } from "node:crypto";
import type { ExecutionDocument, Phase, Task } from "../../../types.js";
import type { FingerprintIdentity, RuntimeEntityRef } from "../contracts.js";
import { canonicalJson } from "../canonical-json.js";
import { isSha256Digest, sha256Canonical } from "../hashing.js";
import { commitRalphEventV2, readBoundRetryPolicyV1 } from "../operational-b1/index.js";
import {
  repairStateSnapshotWhileLeasedV2,
  assertLeasedRunV2,
  revalidateLeaseOwnershipV2,
  refreshLeasedRunV2,
  releaseLeasedRunV2,
  deriveExecutorReleaseProofV2,
  type LeasedRunV2,
} from "../operational-b2/index.js";
import {
  createWorkUnitV2,
  createInvocationDescriptorV2,
  readInvocationDescriptorV2,
  readWorkUnitV2,
  type ArtifactBindingInputV2,
  type InvocationDescriptorV2,
  type WorkUnitV2,
} from "../operational-b3/index.js";
import {
  attemptArtifactRefV2,
  readImmutableJsonArtifactV2,
} from "../operational-b4/artifacts.js";
import {
  assertTrustedExecutorObservationV2,
} from "../operational-b4/execution.js";
import type { TrustedExecutorObservationV2 } from "../operational-b4/execution-observation.js";
import {
  readInvocationResultV2,
  validateInvocationResultV2,
  type InvocationResultV2,
} from "../operational-b4/invocation-result.js";
import {
  observeWorkspaceManifestV2,
  readWorkspaceAfterManifestV2,
  readWorkspaceBeforeManifestV2,
  workspaceManifestCoreJson,
  type WorkspaceManifestV2,
} from "../operational-b4/workspace-manifest.js";
import {
  captureEvidenceV2,
  readEvidenceCaptureV2,
  validateEvidenceCaptureV2,
  type EvidenceCaptureV2,
} from "../operational-c/index.js";
import {
  type AttemptStateV2,
  type DeterministicValidationSummary,
  type RalphRuntimeStateV2,
  type ValidationRunRef,
  type ValidationSpecRef,
} from "../operational-v2/contracts.js";
import {
  createRalphEventV2,
  type EventPayloadMapV2,
  type RalphEventTypeV2,
  type RalphEventV2,
  type UnsignedRalphEventV2,
} from "../operational-v2/events.js";
import { V2_EVENT_ENTITY_KINDS } from "../operational-v2/events.js";
import {
  deterministicValidationSummary,
} from "../operational-v2/state.js";
import {
  createAuditPackageV2,
  createValidationDiagnosticsV2,
  createValidationRunV2,
  createValidationSetV2,
  findingDigestV2,
  auditPackageIdV2,
  persistAuditPackageV2,
  persistValidationDiagnosticsV2,
  persistValidationRunV2,
  persistValidationSetV2,
  readAuditPackageV2,
  readValidationRunV2,
  readValidationSetV2,
  validateAuditPackageV2,
  validateValidationRunV2,
  validateValidationSetV2,
  validationRunIdV2,
  validationRunToBindingV2,
  validationSetIdV2,
  VALIDATION_INFRASTRUCTURE_STATUSES,
  type AuditPackageV2,
  type ValidationDiagnosticsV2,
  type ValidationInfrastructureStatusV2,
  type ValidationRunV2,
  type ValidationSemanticStatusV2,
  type ValidationSetV2,
} from "./artifacts.js";
import {
  createValidationProcessPolicyV2,
  runValidationCommandV2,
  verifyValidationCwdV2,
  type ValidationProcessPolicyV2,
  type ValidationProcessResultV2,
  type ValidationProcessSupervisorV2Like,
} from "./process-supervisor.js";
import {
  assertTrustedHumanValidationAuthorityV2,
  createHumanValidationRequestV2,
  humanValidationDecisionRefV2,
  humanValidationRequestRefV2,
  obtainTrustedHumanValidationDecisionV2,
  persistTrustedHumanValidationDecisionV2,
  readHumanValidationDecisionV2,
  validateHumanValidationDecisionV2,
  type HumanValidationDecisionV2,
  type ScriptedHumanValidationAuthorityV2,
} from "./human.js";

export const D_VALIDATION_ERROR_CODES = [
  "D_LEASE_REQUIRED",
  "D_ATTEMPT_INVALID",
  "D_PLAN_BINDING_INVALID",
  "D_AUTHORIZATION_ARTIFACT_REQUIRED",
  "D_AUTHORIZATION_ARTIFACT_INVALID",
  "D_EXECUTOR_OBSERVATION_REQUIRED",
  "D_EXECUTOR_RESULT_INVALID",
  "D_EVIDENCE_REQUIRED",
  "D_WORKSPACE_RECONCILIATION_REQUIRED",
  "D_VALIDATION_RUN_RESULT_REQUIRED",
  "D_HUMAN_DECISION_REQUIRED",
  "D_HUMAN_DECISION_BINDING_INVALID",
  "D_VALIDATION_INFRASTRUCTURE_EXHAUSTED",
  "D_VALIDATION_SET_INVALID",
  "D_AUDIT_PACKAGE_INVALID",
  "D_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION",
] as const;
export type DValidationErrorCode = typeof D_VALIDATION_ERROR_CODES[number];

export class RalphDValidationError extends Error {
  constructor(readonly code: DValidationErrorCode, message: string = code, readonly cause?: unknown) {
    super(message);
    this.name = "RalphDValidationError";
  }
}

export interface ValidationRunnerOptionsV2 {
  readonly processSupervisor?: ValidationProcessSupervisorV2Like;
  readonly processPolicy?: ValidationProcessPolicyV2;
  readonly clock?: () => string;
  readonly nonceFactory?: () => string;
  readonly eventIdFactory?: () => string;
}

export interface ValidateAttemptV2Input extends ValidationRunnerOptionsV2 {
  readonly leasedRun: LeasedRunV2;
  readonly plan: ExecutionDocument;
  readonly planIdentity?: string;
  readonly planDigest?: string;
  readonly attemptId?: string;
  /** Sealed B4 fact. D never observes or mints an executor runtime itself. */
  readonly executorObservation?: TrustedExecutorObservationV2;
  /** Alias retained for callers that name the B4 fact `observation`. */
  readonly observation?: TrustedExecutorObservationV2;
  /** M3-only nominal Human authority. Plain decision records are never authority. */
  readonly humanAuthority?: ScriptedHumanValidationAuthorityV2;
  /** Cancellation is an infrastructure fact for COMMAND validation only. */
  readonly validationSignal?: AbortSignal;
  readonly workspaceFingerprintFileSystem?: import("../fingerprint.js").WorkspaceFingerprintFileSystem;
  readonly processPolicy?: ValidationProcessPolicyV2;
}

export type ValidateAttemptV2Result =
  | {
    readonly kind: "HUMAN_REQUIRED";
    readonly outcome: "HUMAN_REQUIRED";
    readonly state: RalphRuntimeStateV2;
    readonly attempt: AttemptStateV2;
    readonly leaseReleased: true;
  }
  | {
    readonly kind: "VALIDATION_READY_FOR_AUDIT";
    readonly outcome: "VALIDATION_READY_FOR_AUDIT";
    readonly state: RalphRuntimeStateV2;
    readonly attempt: AttemptStateV2;
    readonly validationSet: ValidationSetV2;
    readonly auditPackage: AuditPackageV2;
    readonly auditPackageId: string;
    readonly leaseReleased: true;
  }
  | {
    readonly kind: "VALIDATION_INFRASTRUCTURE_EXHAUSTED";
    readonly outcome: "VALIDATION_INFRASTRUCTURE_EXHAUSTED";
    readonly state: RalphRuntimeStateV2;
    readonly attempt: AttemptStateV2;
    readonly leaseReleased: true;
  }
  | {
    readonly kind: "RECONCILIATION_REQUIRED";
    readonly outcome: "RECONCILIATION_REQUIRED";
    readonly state: RalphRuntimeStateV2;
    readonly attempt: AttemptStateV2;
    readonly leaseReleased: false;
  }
  | {
    readonly kind: "CONTROL_PLANE_VIOLATION";
    readonly outcome: "CONTROL_PLANE_VIOLATION";
    readonly state: RalphRuntimeStateV2;
    readonly attempt: AttemptStateV2;
    readonly leaseReleased: true;
  };

/**
 * D's orchestration object is intentionally a validation-only surface.  It
 * has no Executor, Auditor, provider, model, or workspace mutation API.
 */
export class ValidationRunner {
  private readonly options: ValidationRunnerOptionsV2;

  constructor(options: ValidationRunnerOptionsV2 = {}) {
    this.options = { ...options };
  }

  async run(input: Omit<ValidateAttemptV2Input, keyof ValidationRunnerOptionsV2> & Partial<ValidationRunnerOptionsV2>): Promise<ValidateAttemptV2Result> {
    return validateAttemptV2({ ...this.options, ...input });
  }
}

export async function validateAttemptV2(input: ValidateAttemptV2Input): Promise<ValidateAttemptV2Result> {
  const clock = input.clock ?? (() => new Date().toISOString());
  const nonceFactory = input.nonceFactory ?? randomUUID;
  const eventIdFactory = input.eventIdFactory ?? randomUUID;
  try {
    assertLeasedRunV2(input.leasedRun);
  } catch (error) {
    throw new RalphDValidationError("D_LEASE_REQUIRED", "D_LEASE_REQUIRED: a live Core lease handle is required", error);
  }
  const observation = input.executorObservation ?? input.observation;
  if (observation !== undefined) assertTrustedExecutorObservationV2(observation);

  await refreshLeasedRunV2(input.leasedRun);
  await repairStateSnapshotWhileLeasedV2(input.leasedRun, { writtenAt: clock(), nonce: nonceFactory() });
  const initialAttempt = findAttempt(input.leasedRun.state, input.attemptId);
  if (!initialAttempt) throw new RalphDValidationError("D_ATTEMPT_INVALID", "D_ATTEMPT_INVALID: open Attempt is required");

  if (initialAttempt.disposition === "CLOSED") {
    if (initialAttempt.closureReason === "CONTROL_PLANE_VIOLATION") {
      await releaseAfterExecutor(input.leasedRun, observation, initialAttempt, input);
      return { kind: "CONTROL_PLANE_VIOLATION", outcome: "CONTROL_PLANE_VIOLATION", state: input.leasedRun.state, attempt: initialAttempt, leaseReleased: true };
    }
    if (initialAttempt.closureReason === "VALIDATION_INFRASTRUCTURE_EXHAUSTED") {
      // A crash may occur after the terminal close and before the lease
      // release.  Replay the durable terminal boundary and release only
      // after re-deriving the same post-executor proof; never rerun Executor
      // or Validation from this state.
      await releaseAfterExecutor(input.leasedRun, observation, initialAttempt, input);
      return { kind: "VALIDATION_INFRASTRUCTURE_EXHAUSTED", outcome: "VALIDATION_INFRASTRUCTURE_EXHAUSTED", state: input.leasedRun.state, attempt: initialAttempt, leaseReleased: true };
    }
    throw new RalphDValidationError("D_ATTEMPT_INVALID", "D_ATTEMPT_INVALID: Attempt is already closed");
  }
  if (initialAttempt.stage === "RECONCILING" || input.leasedRun.state.hold === "RECONCILIATION_REQUIRED") {
    return {
      kind: "RECONCILIATION_REQUIRED",
      outcome: "RECONCILIATION_REQUIRED",
      state: input.leasedRun.state,
      attempt: initialAttempt,
      leaseReleased: false,
    };
  }
  if (!initialAttempt.invocation || !initialAttempt.executorFinished) throw new RalphDValidationError("D_ATTEMPT_INVALID", "D_ATTEMPT_INVALID: executor boundary is incomplete");
  requireObservationForRelease(observation);
  if (observation.invocationId !== initialAttempt.invocation.invocationId || observation.state !== "TERMINATED_QUIESCENT") throw new RalphDValidationError("D_EXECUTOR_OBSERVATION_REQUIRED", "D_EXECUTOR_OBSERVATION_REQUIRED: terminated quiescent observation for this invocation is required");

  const boundary = await revalidateValidationBoundary(input, initialAttempt, observation);
  if (boundary.controlPlaneChanged) {
    if (initialAttempt.disposition === "OPEN") {
      const closed = await commitControlPlaneViolation(input.leasedRun, initialAttempt, clock, nonceFactory, eventIdFactory);
      await releaseAfterExecutor(input.leasedRun, observation, closed, input);
      return { kind: "CONTROL_PLANE_VIOLATION", outcome: "CONTROL_PLANE_VIOLATION", state: input.leasedRun.state, attempt: closed, leaseReleased: true };
    }
    await releaseAfterExecutor(input.leasedRun, observation, initialAttempt, input);
    return { kind: "CONTROL_PLANE_VIOLATION", outcome: "CONTROL_PLANE_VIOLATION", state: input.leasedRun.state, attempt: initialAttempt, leaseReleased: true };
  }
  if (boundary.workspaceDrift) return await reconcileValidation(input.leasedRun, initialAttempt, "C_WORKSPACE_CHANGED_AFTER_EVIDENCE", clock, nonceFactory, eventIdFactory);

  let attempt = input.leasedRun.state.attempts[initialAttempt.attemptId] ?? initialAttempt;
  if (attempt.stage === "RECONCILING") return { kind: "RECONCILIATION_REQUIRED", outcome: "RECONCILIATION_REQUIRED", state: input.leasedRun.state, attempt, leaseReleased: false };

  const workUnit = boundary.workUnit;
  const specs = [...workUnit.validationSpecRefs].sort((left, right) => left.ordinal - right.ordinal || left.validationSpecId.localeCompare(right.validationSpecId));
  const retryPolicy = await readBoundRetryPolicyV1(input.leasedRun.store, input.leasedRun.snapshot);
  const infrastructureRetryLimit = retryPolicy.validationInfrastructureRetryLimit;
  const processPolicy = input.processPolicy ?? createValidationProcessPolicyV2();
  const supervisor = input.processSupervisor;

  for (const spec of specs) {
    attempt = input.leasedRun.state.attempts[attempt.attemptId] ?? attempt;
    assertAttemptSpecBinding(attempt, spec);

    const pending = latestPendingRun(attempt, spec.validationSpecId);
    let recovered: ValidationRunV2 | undefined;
    if (pending) {
      recovered = await readValidationRunV2(input.leasedRun.store, attempt.attemptId, pending.validationRunId);
      if (!recovered) {
        // HUMAN is the one intentionally suspended validation boundary.  Its
        // durable start is completed only after Core validates the external
        // decision and the durable run.hold-cleared proof.  COMMAND/MANUAL
        // boundaries, by contrast, are never rerun after a crash without
        // their immutable result artifact.
        if (spec.kind !== "HUMAN" && spec.kind !== "MANUAL") {
          throw new RalphDValidationError("D_VALIDATION_RUN_RESULT_REQUIRED", "D_VALIDATION_RUN_RESULT_REQUIRED: a durable validation.started boundary cannot be rerun without its result artifact");
        }
      } else {
        assertRunBinding(recovered, input.leasedRun.runId, attempt, spec, pending.validationRunOrdinal);
      }
    }

    let latest = latestRun(attempt, spec.validationSpecId);
    if (recovered) latest = validationRunToRef(recovered);
    let infrastructureFailures = await countInfrastructureFailures(input.leasedRun, attempt, spec.validationSpecId);
    if (latest?.outcome === "INFRASTRUCTURE_FAILURE") {
      // A failed infrastructure run is immutable.  Only a new ValidationRun
      // may retry it; the Executor and EvidenceCapture are never called here.
      while (latest?.outcome === "INFRASTRUCTURE_FAILURE") {
        if (infrastructureFailures > infrastructureRetryLimit) {
          return await exhaustValidationInfrastructure(input, attempt, workUnit, boundary, observation, clock, nonceFactory, eventIdFactory);
        }
        const next = await executeValidationRun(input, attempt, spec, latest.validationRunOrdinal + 1, boundary.invocation, boundary.after, supervisor, processPolicy, observation, clock, nonceFactory, eventIdFactory, "RETRY");
        if (next.kind === "RECONCILIATION_REQUIRED") return next;
        if (next.kind === "HUMAN_REQUIRED") return next;
        if (next.kind === "CONTROL_PLANE_VIOLATION") return next;
        if (next.infrastructureStatus !== "NONE") {
          infrastructureFailures += 1;
          attempt = input.leasedRun.state.attempts[attempt.attemptId] ?? attempt;
          latest = next.ref;
          if (infrastructureFailures > infrastructureRetryLimit) {
            return await exhaustValidationInfrastructure(input, attempt, workUnit, boundary, observation, clock, nonceFactory, eventIdFactory);
          }
          continue;
        }
        latest = next.ref;
        attempt = input.leasedRun.state.attempts[attempt.attemptId] ?? attempt;
      }
    } else if (!latest) {
      if (spec.kind === "HUMAN") {
        const started = pending
          ? attempt
          : await startValidation(input.leasedRun, attempt, spec, 1, clock, nonceFactory, eventIdFactory);
        attempt = started;
        const decision = await maybeMaterializeHumanDecision(input, attempt, spec, clock, nonceFactory, eventIdFactory);
        if (decision.kind === "HUMAN_REQUIRED") return await releaseHumanRequired(input.leasedRun, decision.attempt, observation, input);
        attempt = decision.attempt;
        const materialized = await executeHumanValidationRun(input.leasedRun, attempt, spec, decision.decision, boundary.after, clock, nonceFactory, eventIdFactory);
        attempt = materialized.attempt;
      } else if (spec.kind === "MANUAL") {
        const started = pending
          ? attempt
          : await startValidation(input.leasedRun, attempt, spec, 1, clock, nonceFactory, eventIdFactory);
        const materialized = await executeManualValidationRun(input.leasedRun, started, spec, boundary.after, clock, nonceFactory, eventIdFactory);
        attempt = materialized.attempt;
      } else {
        const executed = await executeValidationRun(input, attempt, spec, 1, boundary.invocation, boundary.after, supervisor, processPolicy, observation, clock, nonceFactory, eventIdFactory, "INITIAL");
        if (executed.kind === "RECONCILIATION_REQUIRED" || executed.kind === "HUMAN_REQUIRED" || executed.kind === "CONTROL_PLANE_VIOLATION") return executed;
        attempt = input.leasedRun.state.attempts[attempt.attemptId] ?? attempt;
        if (executed.infrastructureStatus !== "NONE") {
          infrastructureFailures += 1;
          if (infrastructureFailures > infrastructureRetryLimit) {
            return await exhaustValidationInfrastructure(input, attempt, workUnit, boundary, observation, clock, nonceFactory, eventIdFactory);
          }
          // The loop above is intentionally entered through the immutable
          // latest run; one fresh run is the only possible retry.
          let retry = executed.ref;
          while (retry.outcome === "INFRASTRUCTURE_FAILURE") {
            const next = await executeValidationRun(input, attempt, spec, retry.validationRunOrdinal + 1, boundary.invocation, boundary.after, supervisor, processPolicy, observation, clock, nonceFactory, eventIdFactory, "RETRY");
            if (next.kind === "RECONCILIATION_REQUIRED" || next.kind === "HUMAN_REQUIRED" || next.kind === "CONTROL_PLANE_VIOLATION") return next;
            attempt = input.leasedRun.state.attempts[attempt.attemptId] ?? attempt;
            retry = next.ref;
            if (next.infrastructureStatus !== "NONE") {
              infrastructureFailures += 1;
              if (infrastructureFailures > infrastructureRetryLimit) {
                return await exhaustValidationInfrastructure(input, attempt, workUnit, boundary, observation, clock, nonceFactory, eventIdFactory);
              }
            }
          }
        }
      }
    }
  }

  attempt = input.leasedRun.state.attempts[attempt.attemptId] ?? attempt;
  // Re-observe once after the complete ValidationSet input has been produced.
  // This closes the gap between the last COMMAND close and artifact
  // publication: an unstable workspace is never silently packaged for E.
  const finalManifest = await observeStableManifest(input, attempt, boundary.invocation);
  if (finalManifest.controlPlaneFingerprint !== boundary.after.controlPlaneFingerprint) {
    const closed = await commitControlPlaneViolation(input.leasedRun, attempt, clock, nonceFactory, eventIdFactory);
    await releaseAfterExecutor(input.leasedRun, observation, closed, input);
    return { kind: "CONTROL_PLANE_VIOLATION", outcome: "CONTROL_PLANE_VIOLATION", state: input.leasedRun.state, attempt: closed, leaseReleased: true };
  }
  if (workspaceManifestCoreJson(finalManifest) !== workspaceManifestCoreJson(boundary.after)) {
    return await reconcileValidation(input.leasedRun, attempt, "C_WORKSPACE_CHANGED_AFTER_EVIDENCE", clock, nonceFactory, eventIdFactory);
  }
  const artifacts = await materializeValidationSetAndAuditPackage(input, attempt, workUnit, boundary, clock, nonceFactory, eventIdFactory);
  const readyAttempt = input.leasedRun.state.attempts[attempt.attemptId];
  if (!readyAttempt) throw new RalphDValidationError("D_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION");
  await releaseAfterExecutor(input.leasedRun, observation, readyAttempt, input);
  return {
    kind: "VALIDATION_READY_FOR_AUDIT",
    outcome: "VALIDATION_READY_FOR_AUDIT",
    state: input.leasedRun.state,
    attempt: readyAttempt,
    validationSet: artifacts.validationSet,
    auditPackage: artifacts.auditPackage,
    auditPackageId: artifacts.auditPackageId,
    leaseReleased: true,
  };
}

export const runValidationV2 = validateAttemptV2;
export const runValidation = validateAttemptV2;

async function revalidateValidationBoundary(
  input: ValidateAttemptV2Input,
  attempt: AttemptStateV2,
  observation: TrustedExecutorObservationV2,
): Promise<{
  readonly workUnit: WorkUnitV2;
  readonly invocation: InvocationDescriptorV2;
  readonly result: InvocationResultV2;
  readonly evidence: EvidenceCaptureV2;
  readonly before: WorkspaceManifestV2;
  readonly after: WorkspaceManifestV2;
  readonly current: WorkspaceManifestV2;
  readonly controlPlaneChanged: boolean;
  readonly workspaceDrift: boolean;
}> {
  const phase = input.plan.phases.find((candidate) => candidate.id === attempt.phaseId);
  const task = phase?.tasks.find((candidate) => candidate.id === attempt.taskId);
  if (!phase || !task) throw new RalphDValidationError("D_PLAN_BINDING_INVALID", "D_PLAN_BINDING_INVALID: Attempt is outside the supplied plan");
  const planIdentity = input.planIdentity ?? input.plan.artifactId;
  const planDigest = sha256Canonical(input.plan);
  if (input.planDigest !== undefined && input.planDigest !== planDigest) throw new RalphDValidationError("D_PLAN_BINDING_INVALID");
  if (planIdentity !== input.leasedRun.snapshot.readyPlanIdentity || planDigest !== input.leasedRun.snapshot.readyPlanHash || input.plan.artifactId !== planIdentity) throw new RalphDValidationError("D_PLAN_BINDING_INVALID", "D_PLAN_BINDING_INVALID: plan is not the Ready plan");
  const binding: ArtifactBindingInputV2 = { runId: input.leasedRun.runId, phase, task, attempt, planIdentity, planDigest, snapshot: input.leasedRun.snapshot };
  const expectedWorkUnit = createWorkUnitV2(binding);
  const workUnit = await readWorkUnitV2(input.leasedRun.store, attempt.attemptId);
  const invocation = await readInvocationDescriptorV2(input.leasedRun.store, attempt.attemptId);
  if (!workUnit || !invocation) throw new RalphDValidationError("D_AUTHORIZATION_ARTIFACT_REQUIRED");
  if (canonicalJson(workUnit) !== canonicalJson(expectedWorkUnit)) throw new RalphDValidationError("D_AUTHORIZATION_ARTIFACT_INVALID", "D_AUTHORIZATION_ARTIFACT_INVALID: WorkUnit binding");
  const expectedInvocation = createInvocationDescriptorV2({ ...binding, workUnit: expectedWorkUnit });
  if (!attempt.invocation || canonicalJson(invocation) !== canonicalJson(expectedInvocation) || attempt.invocation.invocationId !== invocation.invocationId || attempt.invocation.workUnitDigest !== workUnit.workUnitDigest) throw new RalphDValidationError("D_AUTHORIZATION_ARTIFACT_INVALID", "D_AUTHORIZATION_ARTIFACT_INVALID: invocation binding");

  const result = await readInvocationResultV2(input.leasedRun.store, attempt.attemptId);
  const evidence = await readEvidenceCaptureV2(input.leasedRun.store, attempt.attemptId);
  const before = await readWorkspaceBeforeManifestV2(input.leasedRun.store, attempt.attemptId);
  const after = await readWorkspaceAfterManifestV2(input.leasedRun.store, attempt.attemptId);
  if (!result) throw new RalphDValidationError("D_EXECUTOR_RESULT_INVALID", "D_EXECUTOR_RESULT_INVALID: invocation-result is missing");
  if (!evidence) throw new RalphDValidationError("D_EVIDENCE_REQUIRED", "D_EVIDENCE_REQUIRED: EvidenceCapture is missing");
  if (!before || !after) throw new RalphDValidationError("D_EVIDENCE_REQUIRED", "D_EVIDENCE_REQUIRED: workspace manifests are missing");
  validateInvocationResultV2(result);
  validateEvidenceCaptureV2(evidence);
  assertManifestBinding(before, input.leasedRun.runId, attempt, invocation);
  assertManifestBinding(after, input.leasedRun.runId, attempt, invocation);
  assertResultBinding(result, input.leasedRun.runId, attempt, observation);
  assertEvidenceBinding(evidence, attempt, invocation, workUnit, result, before, after);
  const current = await observeStableManifest(input, attempt, invocation);
  const controlPlaneChanged = current.controlPlaneFingerprint !== after.controlPlaneFingerprint;
  const workspaceDrift = workspaceManifestCoreJson(current) !== workspaceManifestCoreJson(after);
  return { workUnit, invocation, result, evidence, before, after, current, controlPlaneChanged, workspaceDrift };
}

async function observeStableManifest(input: ValidateAttemptV2Input, attempt: AttemptStateV2, invocation: InvocationDescriptorV2): Promise<WorkspaceManifestV2> {
  const binding = { runId: input.leasedRun.runId, phaseId: attempt.phaseId, taskId: attempt.taskId, attemptId: attempt.attemptId, invocationId: invocation.invocationId };
  const first = await observeWorkspaceManifestV2({ projectRoot: input.leasedRun.projectRoot, policy: input.leasedRun.snapshot.workspacePolicy, binding, fileSystem: input.workspaceFingerprintFileSystem ?? input.leasedRun.workspaceFingerprintFileSystem });
  const second = await observeWorkspaceManifestV2({ projectRoot: input.leasedRun.projectRoot, policy: input.leasedRun.snapshot.workspacePolicy, binding, fileSystem: input.workspaceFingerprintFileSystem ?? input.leasedRun.workspaceFingerprintFileSystem });
  if (workspaceManifestCoreJson(first.manifest) !== workspaceManifestCoreJson(second.manifest)) throw new RalphDValidationError("D_WORKSPACE_RECONCILIATION_REQUIRED", "D_WORKSPACE_RECONCILIATION_REQUIRED: workspace is unstable during validation");
  return first.manifest;
}

async function startValidation(
  leasedRun: LeasedRunV2,
  attempt: AttemptStateV2,
  spec: ValidationSpecRef,
  ordinal: number,
  clock: () => string,
  nonceFactory: () => string,
  eventIdFactory: () => string,
): Promise<AttemptStateV2> {
  const validationRunId = validationRunIdV2(leasedRun.runId, attempt.attemptId, spec, ordinal);
  const event = coreEvent(leasedRun.state, "validation.started", {
    validationSpec: spec,
    validationRunId,
    validationRunOrdinal: ordinal,
    startedAt: clock(),
  }, { phaseId: attempt.phaseId, taskId: attempt.taskId, attemptId: attempt.attemptId, eventIdFactory, clock });
  await commitValidationEvent(leasedRun, event, clock, nonceFactory);
  const next = leasedRun.state.attempts[attempt.attemptId];
  if (!next) throw new RalphDValidationError("D_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION");
  return next;
}

async function executeValidationRun(
  input: ValidateAttemptV2Input,
  attempt: AttemptStateV2,
  spec: ValidationSpecRef,
  ordinal: number,
  invocation: InvocationDescriptorV2,
  preManifest: WorkspaceManifestV2,
  supervisor: ValidationProcessSupervisorV2Like | undefined,
  processPolicy: ValidationProcessPolicyV2,
  observation: TrustedExecutorObservationV2,
  clock: () => string,
  nonceFactory: () => string,
  eventIdFactory: () => string,
  _reason: "INITIAL" | "RETRY",
): Promise<
  | { readonly kind: "COMPLETED"; readonly ref: ValidationRunRef; readonly infrastructureStatus: ValidationInfrastructureStatusV2 }
  | { readonly kind: "RECONCILIATION_REQUIRED"; readonly outcome: "RECONCILIATION_REQUIRED"; readonly state: RalphRuntimeStateV2; readonly attempt: AttemptStateV2; readonly leaseReleased: false }
  | { readonly kind: "HUMAN_REQUIRED"; readonly outcome: "HUMAN_REQUIRED"; readonly state: RalphRuntimeStateV2; readonly attempt: AttemptStateV2; readonly leaseReleased: true }
  | { readonly kind: "CONTROL_PLANE_VIOLATION"; readonly outcome: "CONTROL_PLANE_VIOLATION"; readonly state: RalphRuntimeStateV2; readonly attempt: AttemptStateV2; readonly leaseReleased: true }
> {
  let currentAttempt = input.leasedRun.state.attempts[attempt.attemptId] ?? attempt;
  if (!currentAttempt.validationRuns.some((run) => run.validationSpecId === spec.validationSpecId && run.validationRunOrdinal === ordinal)) currentAttempt = await startValidation(input.leasedRun, currentAttempt, spec, ordinal, clock, nonceFactory, eventIdFactory);
  const pending = currentAttempt.validationRuns.find((run) => run.validationSpecId === spec.validationSpecId && run.validationRunOrdinal === ordinal);
  if (!pending) throw new RalphDValidationError("D_VALIDATION_RUN_RESULT_REQUIRED");
  const existing = await readValidationRunV2(input.leasedRun.store, currentAttempt.attemptId, pending.validationRunId);
  if (existing) {
    assertRunBinding(existing, input.leasedRun.runId, currentAttempt, spec, ordinal);
    return { kind: "COMPLETED", ref: validationRunToRef(existing), infrastructureStatus: existing.infrastructureStatus };
  }

  let processResult: ValidationProcessResultV2;
  try {
    await verifyValidationCwdV2(input.leasedRun.projectRoot, input.leasedRun.projectRoot);
    processResult = normalizeProcessResult(await runValidationCommandV2({ command: spec.instruction, cwd: input.leasedRun.projectRoot, expectedProjectRoot: input.leasedRun.projectRoot, policy: processPolicy, signal: input.validationSignal, supervisor }), clock);
  } catch {
    const now = clock();
    processResult = { stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, exitCode: null, signal: null, infrastructureStatus: "RUNNER_PROTOCOL_FAILURE", timedOut: false, cancelled: false, startedAt: now, finishedAt: now };
  }
  const postManifest = await observeStableManifest(input, currentAttempt, invocation);
  if (postManifest.controlPlaneFingerprint !== preManifest.controlPlaneFingerprint) {
    const closed = await commitControlPlaneViolation(input.leasedRun, currentAttempt, clock, nonceFactory, eventIdFactory);
    await releaseAfterExecutor(input.leasedRun, observation, closed, input);
    return { kind: "CONTROL_PLANE_VIOLATION", outcome: "CONTROL_PLANE_VIOLATION", state: input.leasedRun.state, attempt: closed, leaseReleased: true };
  }
  if (workspaceManifestCoreJson(postManifest) !== workspaceManifestCoreJson(preManifest)) {
    return await reconcileValidation(input.leasedRun, currentAttempt, "C_WORKSPACE_CHANGED_AFTER_EVIDENCE", clock, nonceFactory, eventIdFactory);
  }
  const infrastructureStatus = normalizeInfrastructureStatus(processResult.infrastructureStatus);
  const diagnosticRefs: string[] = [];
  const diagnosticDigests: string[] = [];
  if (processResult.stdout.length > 0 || processResult.stderr.length > 0 || processResult.stdoutTruncated || processResult.stderrTruncated) {
    const stdout = boundDiagnostic(processResult.stdout);
    const stderr = boundDiagnostic(processResult.stderr);
    const diagnostics = createValidationDiagnosticsV2({
      runId: input.leasedRun.runId,
      phaseId: currentAttempt.phaseId,
      taskId: currentAttempt.taskId,
      attemptId: currentAttempt.attemptId,
      validationRunId: pending.validationRunId,
      stdout: stdout.value,
      stderr: stderr.value,
      stdoutTruncated: processResult.stdoutTruncated || stdout.truncated,
      stderrTruncated: processResult.stderrTruncated || stderr.truncated,
      capturedAt: processResult.finishedAt,
    });
    await persistValidationDiagnosticsV2(input.leasedRun.store, diagnostics, nonceFactory());
    diagnosticRefs.push(attemptArtifactRefV2(currentAttempt.attemptId, `validation-diagnostics-${pending.validationRunId}.json`));
    diagnosticDigests.push(diagnostics.diagnosticsDigest);
  }
  const semanticStatus = semanticStatusForCommand(processResult, infrastructureStatus);
  const run = createValidationRunV2({
    runId: input.leasedRun.runId,
    phaseId: currentAttempt.phaseId,
    taskId: currentAttempt.taskId,
    attemptId: currentAttempt.attemptId,
    validationSpecId: spec.validationSpecId,
    validationSpecDigest: spec.digest,
    validationRunId: pending.validationRunId,
    validationRunOrdinal: ordinal,
    kind: "COMMAND",
    instruction: spec.instruction,
        // The reducer binds validation.completed to the exact timestamp in
        // validation.started.  The process supervisor's own start time is
        // intentionally not promoted to lifecycle authority.
        startedAt: pending.startedAt,
    finishedAt: processResult.finishedAt,
    semanticStatus,
    infrastructureStatus,
    outcome: outcomeFor(semanticStatus, infrastructureStatus),
    exitCode: processResult.exitCode,
    signal: processResult.signal,
    timedOut: processResult.timedOut,
    cancelled: processResult.cancelled,
    diagnosticRefs,
    diagnosticDigests,
    preValidationFingerprint: preManifest.fingerprintDigest,
    postValidationFingerprint: postManifest.fingerprintDigest,
  });
  await persistValidationRunV2(input.leasedRun.store, run, nonceFactory());
  const ref = validationRunToRef(run);
  return { kind: "COMPLETED", ref, infrastructureStatus };
}

async function executeHumanValidationRun(
  leasedRun: LeasedRunV2,
  attempt: AttemptStateV2,
  spec: ValidationSpecRef,
  decision: HumanValidationDecisionV2 | undefined,
  postManifest: WorkspaceManifestV2,
  clock: () => string,
  nonceFactory: () => string,
  eventIdFactory: () => string,
): Promise<{ readonly attempt: AttemptStateV2; readonly ref: ValidationRunRef }> {
  const pending = attempt.validationRuns.find((run) => run.validationSpecId === spec.validationSpecId && run.outcome === "PENDING");
  if (!pending) throw new RalphDValidationError("D_VALIDATION_RUN_RESULT_REQUIRED");
  const existing = await readValidationRunV2(leasedRun.store, attempt.attemptId, pending.validationRunId);
  if (existing) {
    assertRunBinding(existing, leasedRun.runId, attempt, spec, pending.validationRunOrdinal);
    return { attempt: leasedRun.state.attempts[attempt.attemptId] ?? attempt, ref: validationRunToRef(existing) };
  }
  if (!decision) throw new RalphDValidationError("D_HUMAN_DECISION_REQUIRED", "D_HUMAN_DECISION_REQUIRED: a Core-validated Human decision is required");
  assertHumanDecisionBinding(decision, leasedRun.runId, attempt, spec);
  const run = createValidationRunV2({
    runId: leasedRun.runId,
    phaseId: attempt.phaseId,
    taskId: attempt.taskId,
    attemptId: attempt.attemptId,
    validationSpecId: spec.validationSpecId,
    validationSpecDigest: spec.digest,
    validationRunId: pending.validationRunId,
    validationRunOrdinal: pending.validationRunOrdinal,
    kind: "HUMAN",
    instruction: spec.instruction,
    startedAt: pending.startedAt,
    finishedAt: decision.decidedAt,
    semanticStatus: decision.decision,
    infrastructureStatus: "NONE",
    outcome: decision.decision,
    exitCode: null,
    signal: null,
    timedOut: false,
    cancelled: false,
    diagnosticRefs: [humanValidationDecisionRefV2(attempt.attemptId, spec.validationSpecId)],
    diagnosticDigests: [decision.decisionDigest],
    preValidationFingerprint: postManifest.fingerprintDigest,
    postValidationFingerprint: postManifest.fingerprintDigest,
  });
  await persistValidationRunV2(leasedRun.store, run, nonceFactory());
  return { attempt: leasedRun.state.attempts[attempt.attemptId] ?? attempt, ref: validationRunToRef(run) };
}

async function executeManualValidationRun(
  leasedRun: LeasedRunV2,
  attempt: AttemptStateV2,
  spec: ValidationSpecRef,
  postManifest: WorkspaceManifestV2,
  clock: () => string,
  nonceFactory: () => string,
  eventIdFactory: () => string,
): Promise<{ readonly attempt: AttemptStateV2; readonly ref: ValidationRunRef }> {
  // MANUAL is deliberately represented as an immutable, unproven result. It
  // has no process boundary and can never be promoted to PASS by omission.
  const currentAttempt = leasedRun.state.attempts[attempt.attemptId] ?? attempt;
  const pending = latestPendingRun(currentAttempt, spec.validationSpecId);
  if (!pending) throw new RalphDValidationError("D_VALIDATION_RUN_RESULT_REQUIRED");
  const existing = await readValidationRunV2(leasedRun.store, currentAttempt.attemptId, pending.validationRunId);
  if (existing) {
    assertRunBinding(existing, leasedRun.runId, currentAttempt, spec, pending.validationRunOrdinal);
    return { attempt: leasedRun.state.attempts[currentAttempt.attemptId] ?? currentAttempt, ref: validationRunToRef(existing) };
  }
  const finishedAt = clock();
  const run = createValidationRunV2({
    runId: leasedRun.runId,
    phaseId: currentAttempt.phaseId,
    taskId: currentAttempt.taskId,
    attemptId: currentAttempt.attemptId,
    validationSpecId: spec.validationSpecId,
    validationSpecDigest: spec.digest,
    validationRunId: pending.validationRunId,
    validationRunOrdinal: pending.validationRunOrdinal,
    kind: "MANUAL",
    instruction: spec.instruction,
    startedAt: pending.startedAt,
    finishedAt,
    semanticStatus: "UNPROVEN",
    infrastructureStatus: "NONE",
    outcome: "NOT_APPLICABLE",
    exitCode: null,
    signal: null,
    timedOut: false,
    cancelled: false,
    diagnosticRefs: [],
    diagnosticDigests: [],
    preValidationFingerprint: postManifest.fingerprintDigest,
    postValidationFingerprint: postManifest.fingerprintDigest,
  });
  await persistValidationRunV2(leasedRun.store, run, nonceFactory());
  return { attempt: leasedRun.state.attempts[currentAttempt.attemptId] ?? currentAttempt, ref: validationRunToRef(run) };
}

async function maybeMaterializeHumanDecision(
  input: ValidateAttemptV2Input,
  attempt: AttemptStateV2,
  spec: ValidationSpecRef,
  clock: () => string,
  nonceFactory: () => string,
  eventIdFactory: () => string,
): Promise<{ readonly kind: "HUMAN_REQUIRED"; readonly attempt: AttemptStateV2 } | { readonly kind: "DECISION"; readonly attempt: AttemptStateV2; readonly decision: HumanValidationDecisionV2 }> {
  const inspected = await input.leasedRun.store.inspect();
  const requestProofRef = humanValidationRequestRefV2(input.leasedRun.runId, attempt.attemptId, spec.validationSpecId);
  const hasRequest = inspected.events.some((event) => event.eventType === "attempt.human-required"
    && event.attemptId === attempt.attemptId
    && event.payload.proofRef === requestProofRef);
  if (attempt.stage === "VALIDATING" && !hasRequest) {
    const request = coreEvent(input.leasedRun.state, "attempt.human-required", {
      reason: "Human validation decision is required",
      proofRef: requestProofRef,
    }, { phaseId: attempt.phaseId, taskId: attempt.taskId, attemptId: attempt.attemptId, eventIdFactory, clock });
    await commitValidationEvent(input.leasedRun, request, clock, nonceFactory);
    attempt = input.leasedRun.state.attempts[attempt.attemptId] ?? attempt;
  }
  if (attempt.stage === "AWAITING_HUMAN") {
    if (!input.humanAuthority) return { kind: "HUMAN_REQUIRED", attempt };
    try { assertTrustedHumanValidationAuthorityV2(input.humanAuthority); }
    catch (error) { throw new RalphDValidationError("D_HUMAN_DECISION_BINDING_INVALID", "D_HUMAN_AUTHORITY_TRUST_REQUIRED", error); }
    const request = createHumanValidationRequestV2({
      runId: input.leasedRun.runId,
      phaseId: attempt.phaseId,
      taskId: attempt.taskId,
      attemptId: attempt.attemptId,
      validationSpecId: spec.validationSpecId,
      validationSpecDigest: spec.digest,
    });
    const trustedDecision = await obtainTrustedHumanValidationDecisionV2(input.humanAuthority, request);
    await persistTrustedHumanValidationDecisionV2(input.leasedRun.store, trustedDecision, nonceFactory());
    await commitHumanHoldClear(input.leasedRun, attempt, spec, clock, nonceFactory, eventIdFactory);
  }
  const decision = await readHumanValidationDecisionV2(input.leasedRun.store, attempt.attemptId, spec.validationSpecId);
  if (!decision) {
    if (attempt.stage !== "AWAITING_HUMAN") throw new RalphDValidationError("D_HUMAN_DECISION_REQUIRED", "D_HUMAN_DECISION_REQUIRED: resumed HUMAN validation has no Core-validated decision artifact");
    return { kind: "HUMAN_REQUIRED", attempt };
  }
  validateHumanDecision(decision, input.leasedRun.runId, attempt, spec);
  await assertDurableHumanClear(input.leasedRun, attempt, spec);
  return { kind: "DECISION", attempt: input.leasedRun.state.attempts[attempt.attemptId] ?? attempt, decision };
}

async function releaseHumanRequired(
  leasedRun: LeasedRunV2,
  attempt: AttemptStateV2,
  observation: TrustedExecutorObservationV2,
  input: ValidateAttemptV2Input,
): Promise<ValidateAttemptV2Result> {
  await releaseAfterExecutor(leasedRun, observation, attempt, input);
  return { kind: "HUMAN_REQUIRED", outcome: "HUMAN_REQUIRED", state: leasedRun.state, attempt, leaseReleased: true };
}

async function materializeValidationSetAndAuditPackage(
  input: ValidateAttemptV2Input,
  attempt: AttemptStateV2,
  workUnit: WorkUnitV2,
  boundary: Awaited<ReturnType<typeof revalidateValidationBoundary>>,
  clock: () => string,
  nonceFactory: () => string,
  eventIdFactory: () => string,
): Promise<{ readonly validationSet: ValidationSetV2; readonly auditPackage: AuditPackageV2; readonly auditPackageId: string }> {
  const runs: ValidationRunV2[] = [];
  const pendingCompletions: Array<{ readonly ref: ValidationRunRef; readonly run: ValidationRunV2 }> = [];
  for (const ref of attempt.validationRuns) {
    const run = await readValidationRunV2(input.leasedRun.store, attempt.attemptId, ref.validationRunId);
    if (!run) throw new RalphDValidationError("D_VALIDATION_SET_INVALID", "D_VALIDATION_SET_INVALID: ValidationRun artifact missing");
    const spec = workUnit.validationSpecRefs.find((candidate) => candidate.validationSpecId === ref.validationSpecId);
    if (!spec) throw new RalphDValidationError("D_VALIDATION_SET_INVALID", "D_VALIDATION_SET_INVALID: ValidationRun references an unknown ValidationSpec");
    assertRunBinding(run, input.leasedRun.runId, attempt, spec, ref.validationRunOrdinal);
    if (spec.kind === "HUMAN") await assertHumanRunMaterialization(input, attempt, spec, run);
    if (ref.outcome === "PENDING") {
      pendingCompletions.push({ ref, run });
    } else if (run.runDigest !== ref.resultDigest || run.outcome !== ref.outcome) {
      throw new RalphDValidationError("D_VALIDATION_SET_INVALID", "D_VALIDATION_SET_INVALID: state/artifact run digest mismatch");
    }
    runs.push(run);
  }
  runs.sort((left, right) => specOrdinal(workUnit.validationSpecRefs, left.validationSpecId) - specOrdinal(workUnit.validationSpecRefs, right.validationSpecId) || left.validationRunOrdinal - right.validationRunOrdinal || left.validationRunId.localeCompare(right.validationRunId));
  const completedRefs = runs.map(validationRunToRef);
  const summary = deterministicValidationSummary(workUnit.validationSpecRefs, completedRefs);
  const existingSet = await readValidationSetV2(input.leasedRun.store, attempt.attemptId);
  const evidenceCaptureId = attempt.evidenceCapture?.evidenceCaptureId;
  if (!evidenceCaptureId || !attempt.evidenceCapture) throw new RalphDValidationError("D_EVIDENCE_REQUIRED");
  const setInput = {
    runId: input.leasedRun.runId,
    phaseId: attempt.phaseId,
    taskId: attempt.taskId,
    attemptId: attempt.attemptId,
    evidenceCaptureId,
    evidenceDigest: attempt.evidenceCapture.evidenceDigest,
    postExecutorFingerprint: boundary.after.fingerprintDigest,
    validationRunRefs: runs.map(validationRunToBindingV2),
    summary,
    hardNegative: summary.hardNegative,
    manualUnprovenSpecIds: workUnit.validationSpecRefs.filter((spec) => spec.kind === "MANUAL").map((spec) => spec.validationSpecId),
    humanValidationSpecIds: workUnit.validationSpecRefs.filter((spec) => spec.kind === "HUMAN").map((spec) => spec.validationSpecId),
  } as const;
  const expectedValidationSet = createValidationSetV2(setInput);
  const validationSet = existingSet ?? expectedValidationSet;
  validateValidationSetV2(validationSet);
  if (existingSet && canonicalJson(existingSet) !== canonicalJson(expectedValidationSet)) throw new RalphDValidationError("D_VALIDATION_SET_INVALID", "D_VALIDATION_SET_INVALID: immutable ValidationSet conflict");
  if (!existingSet) await persistValidationSetV2(input.leasedRun.store, validationSet, nonceFactory());

  // The immutable ValidationSet is the durable barrier for all completed
  // ValidationRuns.  Only after that artifact is present may the reducer be
  // told that its matching validation.started entries completed.  This order
  // makes a crash between result persistence and event commit replayable.
  for (const pendingCompletion of pendingCompletions.sort((left, right) => (
    specOrdinal(workUnit.validationSpecRefs, left.run.validationSpecId) - specOrdinal(workUnit.validationSpecRefs, right.run.validationSpecId)
      || left.run.validationRunOrdinal - right.run.validationRunOrdinal
      || left.run.validationRunId.localeCompare(right.run.validationRunId)
  ))) {
    const currentAttempt = input.leasedRun.state.attempts[attempt.attemptId];
    const currentRef = currentAttempt?.validationRuns.find((candidate) => candidate.validationRunId === pendingCompletion.ref.validationRunId);
    if (!currentRef) throw new RalphDValidationError("D_VALIDATION_RUN_RESULT_REQUIRED");
    if (currentRef.outcome === "PENDING") {
      const event = coreEvent(input.leasedRun.state, "validation.completed", {
        validationRun: validationRunToRef(pendingCompletion.run),
      }, { phaseId: attempt.phaseId, taskId: attempt.taskId, attemptId: attempt.attemptId, eventIdFactory, clock });
      await commitValidationEvent(input.leasedRun, event, clock, nonceFactory);
    } else if (currentRef.outcome !== pendingCompletion.run.outcome || currentRef.resultDigest !== pendingCompletion.run.runDigest) {
      throw new RalphDValidationError("D_VALIDATION_RUN_RESULT_REQUIRED", "D_VALIDATION_RUN_RESULT_REQUIRED: conflicting completed ValidationRun");
    }
  }

  const completedAttempt = input.leasedRun.state.attempts[attempt.attemptId];
  if (!completedAttempt || completedAttempt.validationRuns.some((run) => run.outcome === "PENDING")) {
    throw new RalphDValidationError("D_VALIDATION_RUN_RESULT_REQUIRED");
  }
  const completedEvidence = completedAttempt.evidenceCapture;
  if (!completedEvidence) throw new RalphDValidationError("D_EVIDENCE_REQUIRED");

  const openFindingRefs = Object.values(input.leasedRun.state.findings)
    .filter((finding) => finding.taskId === completedAttempt.taskId && !["RESOLVED", "SUPERSEDED"].includes(finding.status))
    .map((finding) => ({ findingId: finding.id, findingDigest: findingDigestV2(finding), status: finding.status as "OPEN" | "CANDIDATE_RESOLVED" | "HUMAN_PENDING", severity: finding.severity }))
    .sort((left, right) => left.findingId.localeCompare(right.findingId));
  const missingValidation = workUnit.validationSpecRefs.length === 0;
  const auditInput = {
    runId: input.leasedRun.runId,
    phaseId: completedAttempt.phaseId,
    taskId: completedAttempt.taskId,
    attemptId: completedAttempt.attemptId,
    workUnitId: workUnit.workUnitId,
    workUnitDigest: workUnit.workUnitDigest,
    evidenceCaptureId,
    evidenceDigest: completedEvidence.evidenceDigest,
    validationSetId: validationSetIdV2(input.leasedRun.runId, completedAttempt.attemptId, { evidenceCaptureId, evidenceDigest: completedEvidence.evidenceDigest }, runs),
    validationSetDigest: validationSet.setDigest,
    acceptanceCriteria: [...workUnit.acceptanceCriteria],
    constraints: {
      planIdentity: workUnit.planIdentity,
      taskTitle: workUnit.title,
      scope: workUnit.scope,
      covers: workUnit.covers,
      expectedEvidence: workUnit.expectedEvidence,
    },
    relevantContext: [`attempt-ordinal:${completedAttempt.ordinal}`, `strategy-generation:${completedAttempt.strategyGeneration}`, ...(summary.hardNegative ? ["deterministic-hard-negative"] : []), ...(missingValidation ? ["validation-missing"] : [])],
    openFindingRefs,
    workspaceFingerprint: boundary.after.fingerprintDigest,
    postExecutorFingerprint: boundary.after.fingerprintDigest,
    auditability: missingValidation || summary.infrastructureFailures > 0 || summary.manualRequired > 0 ? "NOT_AUDITABLE" as const : "AUDITABLE" as const,
    validationSummary: summary,
  } as const;
  const existingPackage = await readAuditPackageV2(input.leasedRun.store, attempt.attemptId);
  const expectedAuditPackage = createAuditPackageV2(auditInput);
  const auditPackage = existingPackage ?? expectedAuditPackage;
  validateAuditPackageV2(auditPackage);
  if (existingPackage && canonicalJson(existingPackage) !== canonicalJson(expectedAuditPackage)) throw new RalphDValidationError("D_AUDIT_PACKAGE_INVALID", "D_AUDIT_PACKAGE_INVALID: immutable AuditPackage conflict");
  if (!existingPackage) await persistAuditPackageV2(input.leasedRun.store, auditPackage, nonceFactory());
  const auditPackageId = auditPackageIdV2(auditInput);
  const current = input.leasedRun.state.attempts[completedAttempt.attemptId];
  if (!current) throw new RalphDValidationError("D_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION");
  if (current.stage !== "AWAITING_AUDIT") {
    const ready = coreEvent(input.leasedRun.state, "attempt.audit-ready", {
      evidenceCaptureId,
      evidenceDigest: completedEvidence.evidenceDigest,
      validationSetId: auditPackage.validationSetId,
      validationSetDigest: validationSet.setDigest,
      auditPackageId,
      auditPackageDigest: auditPackage.packageDigest,
      postExecutorFingerprint: boundary.after.fingerprintDigest,
      criterionSetDigest: sha256Canonical({ acceptanceCriteria: workUnit.acceptanceCriteria }),
      auditability: auditPackage.auditability,
      validationSummary: summary,
    }, { phaseId: completedAttempt.phaseId, taskId: completedAttempt.taskId, attemptId: completedAttempt.attemptId, eventIdFactory, clock });
    await commitValidationEvent(input.leasedRun, ready, clock, nonceFactory);
  }
  return { validationSet, auditPackage, auditPackageId };
}

async function commitHumanHoldClear(
  leasedRun: LeasedRunV2,
  attempt: AttemptStateV2,
  spec: ValidationSpecRef,
  clock: () => string,
  nonceFactory: () => string,
  eventIdFactory: () => string,
): Promise<void> {
  const event = coreEvent(leasedRun.state, "run.hold-cleared", {
    previousHold: "HUMAN_REQUIRED",
    reason: "Core validated Human validation decision",
    proofRef: humanValidationRequestRefV2(leasedRun.runId, attempt.attemptId, spec.validationSpecId),
  }, { eventIdFactory, clock });
  await commitValidationEvent(leasedRun, event, clock, nonceFactory);
}

async function assertDurableHumanClear(leasedRun: LeasedRunV2, attempt: AttemptStateV2, spec: ValidationSpecRef): Promise<void> {
  const inspected = await leasedRun.store.inspect();
  const events = inspected.events;
  const requestProofRef = humanValidationRequestRefV2(leasedRun.runId, attempt.attemptId, spec.validationSpecId);
  const humanRequired = [...events].reverse().find((event) => event.eventType === "attempt.human-required"
    && event.attemptId === attempt.attemptId
    && event.payload.proofRef === requestProofRef);
  const clear = [...events].reverse().find((event) => event.eventType === "run.hold-cleared"
    && event.payload.previousHold === "HUMAN_REQUIRED"
    && event.payload.proofRef === requestProofRef
    && (!humanRequired || event.sequence > humanRequired.sequence));
  if (!clear || !humanRequired || clear.sequence <= humanRequired.sequence) throw new RalphDValidationError("D_HUMAN_DECISION_BINDING_INVALID", "D_HUMAN_DECISION_BINDING_INVALID: durable run.hold-cleared proof is missing");
}

async function materializeTerminalValidationSet(
  input: ValidateAttemptV2Input,
  attempt: AttemptStateV2,
  workUnit: WorkUnitV2,
  boundary: Awaited<ReturnType<typeof revalidateValidationBoundary>>,
  clock: () => string,
  nonceFactory: () => string,
  eventIdFactory: () => string,
): Promise<void> {
  const runs: ValidationRunV2[] = [];
  const pendingCompletions: Array<{ readonly ref: ValidationRunRef; readonly run: ValidationRunV2 }> = [];
  for (const ref of attempt.validationRuns) {
    const run = await readValidationRunV2(input.leasedRun.store, attempt.attemptId, ref.validationRunId);
    if (!run) throw new RalphDValidationError("D_VALIDATION_RUN_RESULT_REQUIRED", "D_VALIDATION_RUN_RESULT_REQUIRED: terminal ValidationRun artifact is missing");
    const spec = workUnit.validationSpecRefs.find((candidate) => candidate.validationSpecId === ref.validationSpecId);
    if (!spec) throw new RalphDValidationError("D_VALIDATION_SET_INVALID", "D_VALIDATION_SET_INVALID: terminal ValidationRun references an unknown ValidationSpec");
    assertRunBinding(run, input.leasedRun.runId, attempt, spec, ref.validationRunOrdinal);
    if (spec.kind === "HUMAN") await assertHumanRunMaterialization(input, attempt, spec, run);
    if (ref.outcome === "PENDING") {
      pendingCompletions.push({ ref, run });
    } else if (run.runDigest !== ref.resultDigest || run.outcome !== ref.outcome) {
      throw new RalphDValidationError("D_VALIDATION_SET_INVALID", "D_VALIDATION_SET_INVALID: terminal state/artifact run digest mismatch");
    }
    runs.push(run);
  }
  runs.sort((left, right) => specOrdinal(workUnit.validationSpecRefs, left.validationSpecId) - specOrdinal(workUnit.validationSpecRefs, right.validationSpecId) || left.validationRunOrdinal - right.validationRunOrdinal || left.validationRunId.localeCompare(right.validationRunId));
  const evidenceCapture = attempt.evidenceCapture;
  if (!evidenceCapture) throw new RalphDValidationError("D_EVIDENCE_REQUIRED");
  const completedRefs = runs.map(validationRunToRef);
  const summary = deterministicValidationSummary(workUnit.validationSpecRefs, completedRefs);
  const setInput = {
    runId: input.leasedRun.runId,
    phaseId: attempt.phaseId,
    taskId: attempt.taskId,
    attemptId: attempt.attemptId,
    evidenceCaptureId: evidenceCapture.evidenceCaptureId,
    evidenceDigest: evidenceCapture.evidenceDigest,
    postExecutorFingerprint: boundary.after.fingerprintDigest,
    validationRunRefs: runs.map(validationRunToBindingV2),
    summary,
    hardNegative: summary.hardNegative,
    manualUnprovenSpecIds: workUnit.validationSpecRefs.filter((spec) => spec.kind === "MANUAL").map((spec) => spec.validationSpecId),
    humanValidationSpecIds: workUnit.validationSpecRefs.filter((spec) => spec.kind === "HUMAN").map((spec) => spec.validationSpecId),
  } as const;
  const existingSet = await readValidationSetV2(input.leasedRun.store, attempt.attemptId);
  const expectedValidationSet = createValidationSetV2(setInput);
  const validationSet = existingSet ?? expectedValidationSet;
  validateValidationSetV2(validationSet);
  if (existingSet && canonicalJson(existingSet) !== canonicalJson(expectedValidationSet)) throw new RalphDValidationError("D_VALIDATION_SET_INVALID", "D_VALIDATION_SET_INVALID: immutable terminal ValidationSet conflict");
  if (!existingSet) await persistValidationSetV2(input.leasedRun.store, validationSet, nonceFactory());

  for (const pendingCompletion of pendingCompletions.sort((left, right) => (
    specOrdinal(workUnit.validationSpecRefs, left.run.validationSpecId) - specOrdinal(workUnit.validationSpecRefs, right.run.validationSpecId)
      || left.run.validationRunOrdinal - right.run.validationRunOrdinal
      || left.run.validationRunId.localeCompare(right.run.validationRunId)
  ))) {
    const currentAttempt = input.leasedRun.state.attempts[attempt.attemptId];
    const currentRef = currentAttempt?.validationRuns.find((candidate) => candidate.validationRunId === pendingCompletion.ref.validationRunId);
    if (!currentRef) throw new RalphDValidationError("D_VALIDATION_RUN_RESULT_REQUIRED");
    if (currentRef.outcome === "PENDING") {
      const event = coreEvent(input.leasedRun.state, "validation.completed", {
        validationRun: validationRunToRef(pendingCompletion.run),
      }, { phaseId: attempt.phaseId, taskId: attempt.taskId, attemptId: attempt.attemptId, eventIdFactory, clock });
      await commitValidationEvent(input.leasedRun, event, clock, nonceFactory);
    } else if (currentRef.outcome !== pendingCompletion.run.outcome || currentRef.resultDigest !== pendingCompletion.run.runDigest) {
      throw new RalphDValidationError("D_VALIDATION_RUN_RESULT_REQUIRED", "D_VALIDATION_RUN_RESULT_REQUIRED: conflicting terminal ValidationRun");
    }
  }
}

async function exhaustValidationInfrastructure(
  input: ValidateAttemptV2Input,
  attempt: AttemptStateV2,
  workUnit: WorkUnitV2,
  boundary: Awaited<ReturnType<typeof revalidateValidationBoundary>>,
  observation: TrustedExecutorObservationV2,
  clock: () => string,
  nonceFactory: () => string,
  eventIdFactory: () => string,
): Promise<ValidateAttemptV2Result> {
  await materializeTerminalValidationSet(input, attempt, workUnit, boundary, clock, nonceFactory, eventIdFactory);
  const close = coreEvent(input.leasedRun.state, "attempt.closed", { attemptId: attempt.attemptId, closureReason: "VALIDATION_INFRASTRUCTURE_EXHAUSTED", finishedAt: clock() }, { phaseId: attempt.phaseId, taskId: attempt.taskId, attemptId: attempt.attemptId, eventIdFactory, clock });
  await commitValidationEvent(input.leasedRun, close, clock, nonceFactory);
  const closed = input.leasedRun.state.attempts[attempt.attemptId];
  if (!closed) throw new RalphDValidationError("D_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION");
  await releaseAfterExecutor(input.leasedRun, observation, closed, input);
  return { kind: "VALIDATION_INFRASTRUCTURE_EXHAUSTED", outcome: "VALIDATION_INFRASTRUCTURE_EXHAUSTED", state: input.leasedRun.state, attempt: closed, leaseReleased: true };
}

async function reconcileValidation(
  leasedRun: LeasedRunV2,
  attempt: AttemptStateV2,
  reason: string,
  clock: () => string,
  nonceFactory: () => string,
  eventIdFactory: () => string,
): Promise<Extract<ValidateAttemptV2Result, { readonly kind: "RECONCILIATION_REQUIRED" }>> {
  if (attempt.stage !== "RECONCILING") {
    const event = coreEvent(leasedRun.state, "attempt.reconciliation-required", { reason, proofRef: `validation-reconciliation-${sha256Canonical({ runId: leasedRun.runId, attemptId: attempt.attemptId, reason }).slice("sha256:".length)}` }, { phaseId: attempt.phaseId, taskId: attempt.taskId, attemptId: attempt.attemptId, eventIdFactory, clock });
    await commitValidationEvent(leasedRun, event, clock, nonceFactory);
  }
  const next = leasedRun.state.attempts[attempt.attemptId];
  if (!next) throw new RalphDValidationError("D_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION");
  return { kind: "RECONCILIATION_REQUIRED", outcome: "RECONCILIATION_REQUIRED", state: leasedRun.state, attempt: next, leaseReleased: false };
}

async function commitControlPlaneViolation(
  leasedRun: LeasedRunV2,
  attempt: AttemptStateV2,
  clock: () => string,
  nonceFactory: () => string,
  eventIdFactory: () => string,
): Promise<AttemptStateV2> {
  const close = coreEvent(leasedRun.state, "attempt.closed", { attemptId: attempt.attemptId, closureReason: "CONTROL_PLANE_VIOLATION", finishedAt: clock() }, { phaseId: attempt.phaseId, taskId: attempt.taskId, attemptId: attempt.attemptId, eventIdFactory, clock });
  await commitValidationEvent(leasedRun, close, clock, nonceFactory);
  const next = leasedRun.state.attempts[attempt.attemptId];
  if (!next) throw new RalphDValidationError("D_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION");
  return next;
}

async function releaseAfterExecutor(inputLeasedRun: LeasedRunV2, observation: TrustedExecutorObservationV2 | undefined, attempt: AttemptStateV2, _input: ValidateAttemptV2Input): Promise<void> {
  requireObservationForRelease(observation);
  const refs = [
    attemptArtifactRefV2(attempt.attemptId, "work-unit.json"),
    attemptArtifactRefV2(attempt.attemptId, "invocation.json"),
    attemptArtifactRefV2(attempt.attemptId, "invocation-result.json"),
    attemptArtifactRefV2(attempt.attemptId, "workspace-before.json"),
    attemptArtifactRefV2(attempt.attemptId, "workspace-after.json"),
    attemptArtifactRefV2(attempt.attemptId, "evidence-capture.json"),
  ];
  const proof = await deriveExecutorReleaseProofV2(inputLeasedRun, observation, refs);
  await releaseLeasedRunV2(inputLeasedRun, { proof });
}

async function commitValidationEvent(leasedRun: LeasedRunV2, event: RalphEventV2, clock: () => string, nonceFactory: () => string): Promise<void> {
  await revalidateLeaseOwnershipV2(leasedRun);
  let committed;
  try {
    committed = await commitRalphEventV2({ store: leasedRun.store, state: leasedRun.state, event, writtenAt: clock(), nonce: nonceFactory() });
  } catch (error) {
    if (error instanceof Error && error.message.includes("DURABILITY_UNKNOWN")) throw new RalphDValidationError("D_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION", error.message, error);
    throw error;
  }
  if (committed.eventDurability !== "DURABLE") throw new RalphDValidationError("D_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION");
  try {
    if (committed.snapshotStatus !== "CURRENT") await repairStateSnapshotWhileLeasedV2(leasedRun, { writtenAt: clock(), nonce: nonceFactory() });
    await refreshLeasedRunV2(leasedRun);
  } catch (error) {
    throw new RalphDValidationError("D_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION", "D_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION: durable validation event cannot be replayed", error);
  }
}

function coreEvent<TType extends RalphEventTypeV2>(
  state: RalphRuntimeStateV2,
  eventType: TType,
  payload: EventPayloadMapV2[TType],
  context: { readonly phaseId?: string; readonly taskId?: string; readonly attemptId?: string; readonly eventIdFactory: () => string; readonly clock: () => string },
): RalphEventV2 {
  const kind = V2_EVENT_ENTITY_KINDS[eventType];
  const entity: RuntimeEntityRef = kind === "run"
    ? { kind, id: state.runId }
    : kind === "task"
      ? { kind, id: context.taskId ?? "task" }
      : kind === "workspace"
        ? { kind, id: `${state.runId}:workspace` }
        : { kind: "attempt", id: context.attemptId ?? "attempt" };
  return createRalphEventV2({
    eventId: context.eventIdFactory(),
    eventType,
    schemaVersion: state.eventSchema,
    runId: state.runId,
    sequence: state.lastSequence + 1,
    occurredAt: context.clock(),
    recordedAt: context.clock(),
    entity,
    ...(kind === "attempt" ? { phaseId: context.phaseId, taskId: context.taskId, attemptId: context.attemptId } : kind === "task" ? { taskId: context.taskId } : {}),
    actor: "CORE",
    causationId: null,
    correlationId: `${state.runId}:${context.attemptId ?? eventType}`,
    payload,
    previousEventHash: state.lastEventHash,
  } as UnsignedRalphEventV2<TType>) as RalphEventV2;
}

function findAttempt(state: RalphRuntimeStateV2, attemptId: string | undefined): AttemptStateV2 | undefined {
  if (attemptId) return state.attempts[attemptId];
  return Object.values(state.attempts).find((attempt) => attempt.disposition === "OPEN");
}

function latestPendingRun(attempt: AttemptStateV2, specId: string): ValidationRunRef | undefined {
  return attempt.validationRuns.filter((run) => run.validationSpecId === specId && run.outcome === "PENDING").sort((left, right) => right.validationRunOrdinal - left.validationRunOrdinal)[0];
}

function latestRun(attempt: AttemptStateV2, specId: string): ValidationRunRef | undefined {
  return attempt.validationRuns.filter((run) => run.validationSpecId === specId && run.outcome !== "PENDING").sort((left, right) => right.validationRunOrdinal - left.validationRunOrdinal)[0];
}

function assertAttemptSpecBinding(attempt: AttemptStateV2, spec: ValidationSpecRef): void {
  const existing = attempt.validationSpecs.find((candidate) => candidate.validationSpecId === spec.validationSpecId);
  if (existing && canonicalJson(existing) !== canonicalJson(spec)) throw new RalphDValidationError("D_PLAN_BINDING_INVALID", "D_PLAN_BINDING_INVALID: ValidationSpec changed");
}

function assertRunBinding(run: ValidationRunV2, runId: string, attempt: AttemptStateV2, spec: ValidationSpecRef, ordinal: number): void {
  if (run.runId !== runId || run.phaseId !== attempt.phaseId || run.taskId !== attempt.taskId || run.attemptId !== attempt.attemptId || run.validationSpecId !== spec.validationSpecId || run.validationSpecDigest !== spec.digest || run.validationRunOrdinal !== ordinal || run.kind !== spec.kind || run.instruction !== spec.instruction) throw new RalphDValidationError("D_VALIDATION_RUN_RESULT_REQUIRED", "D_VALIDATION_RUN_RESULT_REQUIRED: ValidationRun binding conflict");
}

function assertResultBinding(result: InvocationResultV2, runId: string, attempt: AttemptStateV2, observation: TrustedExecutorObservationV2): void {
  if (result.runId !== runId || result.phaseId !== attempt.phaseId || result.taskId !== attempt.taskId || result.attemptId !== attempt.attemptId || result.invocationId !== attempt.invocation?.invocationId || !attempt.executorFinished || result.status !== attempt.executorFinished.status || result.termination !== attempt.executorFinished.termination || result.finishedAt !== attempt.executorFinished.finishedAt || observation.record.runId !== result.runId || observation.record.phaseId !== result.phaseId || observation.record.taskId !== result.taskId || observation.record.attemptId !== result.attemptId || observation.invocationId !== result.invocationId || result.resultEnvelopeStatus !== observation.resultEnvelopeStatus || result.status !== observation.status || result.termination !== observation.termination || result.exitCode !== (observation.exitCode ?? null) || result.signal !== (observation.signal ?? null) || result.startedAt !== observation.startedAt || result.finishedAt !== observation.finishedAt) throw new RalphDValidationError("D_EXECUTOR_RESULT_INVALID", "D_EXECUTOR_RESULT_INVALID: invocation-result is not the trusted executor result");
}

function assertEvidenceBinding(evidence: EvidenceCaptureV2, attempt: AttemptStateV2, invocation: InvocationDescriptorV2, workUnit: WorkUnitV2, result: InvocationResultV2, before: WorkspaceManifestV2, after: WorkspaceManifestV2): void {
  if (evidence.runId !== result.runId || evidence.phaseId !== attempt.phaseId || evidence.taskId !== attempt.taskId || evidence.attemptId !== attempt.attemptId || evidence.invocationId !== invocation.invocationId || evidence.workUnitId !== workUnit.workUnitId || evidence.workUnitDigest !== workUnit.workUnitDigest || evidence.invocationResultDigest !== result.resultDigest || evidence.beforeFingerprint !== before.fingerprintDigest || evidence.afterFingerprint !== after.fingerprintDigest || attempt.evidenceCapture?.evidenceDigest !== evidence.evidenceDigest || attempt.evidenceCapture?.postExecutorFingerprint !== after.fingerprintDigest) throw new RalphDValidationError("D_EVIDENCE_REQUIRED", "D_EVIDENCE_REQUIRED: EvidenceCapture binding conflict");
}

function assertManifestBinding(manifest: WorkspaceManifestV2, runId: string, attempt: AttemptStateV2, invocation: InvocationDescriptorV2): void {
  if (manifest.runId !== runId || manifest.phaseId !== attempt.phaseId || manifest.taskId !== attempt.taskId || manifest.attemptId !== attempt.attemptId || manifest.invocationId !== invocation.invocationId) throw new RalphDValidationError("D_EVIDENCE_REQUIRED", "D_EVIDENCE_REQUIRED: workspace manifest binding conflict");
}

function requireObservationForRelease(value: TrustedExecutorObservationV2 | undefined): asserts value is TrustedExecutorObservationV2 {
  if (!value) throw new RalphDValidationError("D_EXECUTOR_OBSERVATION_REQUIRED");
}

async function countInfrastructureFailures(leasedRun: LeasedRunV2, attempt: AttemptStateV2, validationSpecId: string): Promise<number> {
  let failures = 0;
  for (const ref of attempt.validationRuns.filter((candidate) => candidate.validationSpecId === validationSpecId)) {
    const artifact = await readValidationRunV2(leasedRun.store, attempt.attemptId, ref.validationRunId);
    if (artifact?.outcome === "INFRASTRUCTURE_FAILURE") failures += 1;
  }
  return failures;
}

function semanticStatusForCommand(result: ValidationProcessResultV2, infrastructure: ValidationInfrastructureStatusV2): ValidationSemanticStatusV2 {
  if (infrastructure !== "NONE") return "UNPROVEN";
  return result.exitCode === 0 && result.signal === null ? "PASS" : "FAIL";
}

function outcomeFor(semantic: ValidationSemanticStatusV2, infrastructure: ValidationInfrastructureStatusV2): "PASS" | "FAIL" | "NOT_APPLICABLE" | "INFRASTRUCTURE_FAILURE" {
  if (infrastructure !== "NONE") return "INFRASTRUCTURE_FAILURE";
  if (semantic === "PASS") return "PASS";
  if (semantic === "FAIL") return "FAIL";
  return "NOT_APPLICABLE";
}

function normalizeInfrastructureStatus(value: unknown): ValidationInfrastructureStatusV2 {
  return typeof value === "string" && ["NONE", "SPAWN_FAILURE", "PROCESS_SUPERVISION_FAILURE", "UNKNOWN_TERMINATION", "RUNNER_PROTOCOL_FAILURE", "TIMEOUT", "CANCELLED"].includes(value)
    ? value as ValidationInfrastructureStatusV2
    : "RUNNER_PROTOCOL_FAILURE";
}

function normalizeProcessResult(value: unknown, clock: () => string): ValidationProcessResultV2 {
  if (!isRecord(value)
    || typeof value.stdout !== "string"
    || typeof value.stderr !== "string"
    || value.stdout.length > 1_048_576
    || value.stderr.length > 1_048_576
    || typeof value.stdoutTruncated !== "boolean"
    || typeof value.stderrTruncated !== "boolean"
    || (value.exitCode !== null && (!Number.isSafeInteger(value.exitCode) || (value.exitCode as number) < -1))
    || (value.signal !== null && (typeof value.signal !== "string" || value.signal.length === 0 || value.signal.length > 64))
    || typeof value.infrastructureStatus !== "string"
    || !VALIDATION_INFRASTRUCTURE_STATUSES.includes(value.infrastructureStatus as ValidationInfrastructureStatusV2)
    || typeof value.timedOut !== "boolean"
    || typeof value.cancelled !== "boolean"
    || typeof value.startedAt !== "string"
    || typeof value.finishedAt !== "string"
    || (value.exitCode !== null && value.signal !== null)) {
    const now = clock();
    return { stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, exitCode: null, signal: null, infrastructureStatus: "RUNNER_PROTOCOL_FAILURE", timedOut: false, cancelled: false, startedAt: now, finishedAt: now };
  }
  const infrastructureStatus = value.infrastructureStatus as ValidationInfrastructureStatusV2;
  const hasTermination = value.exitCode !== null || value.signal !== null;
  const contradictoryInfrastructureFacts = (infrastructureStatus === "NONE" && (value.timedOut || value.cancelled))
    || (infrastructureStatus === "TIMEOUT" && (!value.timedOut || value.cancelled))
    || (infrastructureStatus === "CANCELLED" && (!value.cancelled || value.timedOut))
    || (infrastructureStatus !== "TIMEOUT" && value.timedOut)
    || (infrastructureStatus !== "CANCELLED" && value.cancelled);
  if (contradictoryInfrastructureFacts) {
    const now = clock();
    return { stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, exitCode: null, signal: null, infrastructureStatus: "RUNNER_PROTOCOL_FAILURE", timedOut: false, cancelled: false, startedAt: now, finishedAt: now };
  }
  if (infrastructureStatus === "NONE" && !hasTermination && !value.timedOut && !value.cancelled) {
    return {
      stdout: value.stdout,
      stderr: value.stderr,
      stdoutTruncated: value.stdoutTruncated,
      stderrTruncated: value.stderrTruncated,
      exitCode: value.exitCode as number | null,
      signal: value.signal,
      infrastructureStatus: "UNKNOWN_TERMINATION",
      timedOut: false,
      cancelled: false,
      startedAt: value.startedAt,
      finishedAt: value.finishedAt,
    };
  }
  return {
    stdout: value.stdout,
    stderr: value.stderr,
    stdoutTruncated: value.stdoutTruncated,
    stderrTruncated: value.stderrTruncated,
    exitCode: value.exitCode as number | null,
    signal: value.signal,
    infrastructureStatus,
    timedOut: value.timedOut,
    cancelled: value.cancelled,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
  };
}

function boundDiagnostic(value: string): { readonly value: string; readonly truncated: boolean } {
  const max = 4_096;
  if (value.length <= max) return { value, truncated: false };
  return { value: value.slice(0, max), truncated: true };
}

function validationRunToRef(run: ValidationRunV2): ValidationRunRef {
  return {
    validationRunId: run.validationRunId,
    validationSpecId: run.validationSpecId,
    validationSpecDigest: run.validationSpecDigest,
    validationRunOrdinal: run.validationRunOrdinal,
    startedAt: run.startedAt,
    endedAt: run.finishedAt,
    outcome: run.outcome,
    exitCode: run.exitCode,
    resultDigest: run.runDigest,
  };
}

function specOrdinal(specs: readonly ValidationSpecRef[], specId: string): number {
  return specs.find((spec) => spec.validationSpecId === specId)?.ordinal ?? Number.MAX_SAFE_INTEGER;
}

async function assertHumanRunMaterialization(
  input: ValidateAttemptV2Input,
  attempt: AttemptStateV2,
  spec: ValidationSpecRef,
  run: ValidationRunV2,
): Promise<void> {
  const decision = await readHumanValidationDecisionV2(input.leasedRun.store, attempt.attemptId, spec.validationSpecId);
  if (!decision) throw new RalphDValidationError("D_HUMAN_DECISION_REQUIRED", "D_HUMAN_DECISION_REQUIRED: Human ValidationRun has no decision artifact");
  validateHumanDecision(decision, input.leasedRun.runId, attempt, spec);
  await assertDurableHumanClear(input.leasedRun, attempt, spec);
  if (run.semanticStatus !== decision.decision
    || run.outcome !== decision.decision
    || run.infrastructureStatus !== "NONE"
    || run.finishedAt !== decision.decidedAt
    || run.diagnosticRefs.length !== 1
    || run.diagnosticRefs[0] !== humanValidationDecisionRefV2(attempt.attemptId, spec.validationSpecId)
    || run.diagnosticDigests.length !== 1
    || run.diagnosticDigests[0] !== decision.decisionDigest) {
    throw new RalphDValidationError("D_HUMAN_DECISION_BINDING_INVALID", "D_HUMAN_DECISION_BINDING_INVALID: Human ValidationRun does not match the durable decision");
  }
}

function validateHumanDecision(decision: HumanValidationDecisionV2, runId: string, attempt: AttemptStateV2, spec: ValidationSpecRef): void {
  validateHumanValidationDecisionV2(decision);
  assertHumanDecisionBinding(decision, runId, attempt, spec);
}

function assertHumanDecisionBinding(decision: HumanValidationDecisionV2, runId: string, attempt: AttemptStateV2, spec: ValidationSpecRef): void {
  const requestRef = humanValidationRequestRefV2(runId, attempt.attemptId, spec.validationSpecId);
  if (decision.runId !== runId || decision.phaseId !== attempt.phaseId || decision.taskId !== attempt.taskId || decision.attemptId !== attempt.attemptId || decision.validationSpecId !== spec.validationSpecId || decision.validationSpecDigest !== spec.digest || decision.humanRequestRef !== requestRef) throw new RalphDValidationError("D_HUMAN_DECISION_BINDING_INVALID");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
