import { randomUUID } from "node:crypto";
import type { ExecutionDocument } from "../../types.js";
import type { CheckpointRecord, Finding, RuntimeEntityRef } from "../ralph-runtime/contracts.js";
import { sha256Canonical } from "../ralph-runtime/hashing.js";
import { commitRalphEventV2, type RalphEventStoreV2 } from "../ralph-runtime/operational-b1/index.js";
import {
  acquireLeasedRunV2,
  deriveExecutorReleaseProofV2,
  derivePreExecutorReleaseProofV2,
  revalidateLeaseOwnershipV2,
  refreshLeasedRunV2,
  releaseLeasedRunV2,
  type LeaseRuntimeInputV2,
  type LeasedRunV2,
} from "../ralph-runtime/operational-b2/index.js";
import {
  authorizePostExecutorObservationV2,
  prepareNextAuthorizedInvocationV2,
  type AuthorizedInvocationV2,
} from "../ralph-runtime/operational-b3/index.js";
import {
  ScriptedExecutor,
  assertTrustedExecutorRuntimeV2,
  executeAuthorizedInvocationV2,
  rehydrateTrustedExecutorObservationV2,
  type ScriptedExecutorCorrectionContextV2,
  type TrustedExecutorRuntimeV2,
} from "../ralph-runtime/operational-b4/index.js";
import { attemptArtifactRefV2 } from "../ralph-runtime/operational-b4/artifacts.js";
import type { TrustedExecutorObservationV2 } from "../ralph-runtime/operational-b4/execution-observation.js";
import { observeWorkspaceManifestV2, workspaceManifestCoreJson } from "../ralph-runtime/operational-b4/workspace-manifest.js";
import { captureEvidenceV2 } from "../ralph-runtime/operational-c/index.js";
import { findingDigestV2, readAuditPackageV2, type AuditPackageV2 } from "../ralph-runtime/operational-d/artifacts.js";
import type { TrustedHumanValidationAuthorityV2 } from "../ralph-runtime/operational-d/human.js";
import type { ValidationProcessPolicyV2, ValidationProcessSupervisorV2Like } from "../ralph-runtime/operational-d/process-supervisor.js";
import { validateAttemptV2 } from "../ralph-runtime/operational-d/validation.js";
import { auditAttemptV2, type AuditAttemptV2Result, type TrustedAuditorRuntimeV2 } from "../ralph-runtime/operational-e/index.js";
import {
  correctionContextIdV2,
  createCorrectionContextV2,
  persistCorrectionContextV2,
  readCorrectionContextV2,
  validateCorrectionContextV2,
  type CorrectionContextV2,
} from "../ralph-runtime/operational-f/correction-context.js";
import type { M5BTimeoutPolicyV2 } from "../ralph-runtime/operational-m5b/index.js";
import {
  createRalphEventV2,
  V2_EVENT_ENTITY_KINDS,
  type AttemptStateV2,
  type EventPayloadMapV2,
  type RalphEventTypeV2,
  type RalphEventV2,
  type RalphRuntimeStateV2,
  type UnsignedRalphEventV2,
} from "../ralph-runtime/operational-v2/index.js";

export const BRIDGE_OPERATION_STOP_REASONS_V1 = [
  "TASK_COMPLETE",
  "HUMAN_REQUIRED",
  "RECONCILIATION_REQUIRED",
  "VALIDATION_INFRASTRUCTURE_EXHAUSTED",
  "NOT_AUDITABLE",
  "BUDGET_EXHAUSTED",
  "EXECUTOR_TERMINAL",
  "INTEGRITY_FAILURE",
  "DRIVER_SAFETY_LIMIT",
] as const;
export type BridgeOperationStopReasonV1 = typeof BRIDGE_OPERATION_STOP_REASONS_V1[number];

export interface BridgeExecutorFactoryInputV1 {
  readonly store: RalphEventStoreV2;
  readonly authorizedInvocation: AuthorizedInvocationV2;
  readonly timeoutPolicy: M5BTimeoutPolicyV2;
  readonly correctionContext?: CorrectionContextV2;
}

export interface BridgeAuditorFactoryInputV1 {
  readonly store: RalphEventStoreV2;
  readonly auditPackage: AuditPackageV2;
  readonly timeoutPolicy: M5BTimeoutPolicyV2;
}

export interface BridgeRuntimeFactoriesV1 {
  readonly executor: (input: BridgeExecutorFactoryInputV1) => TrustedExecutorRuntimeV2 | Promise<TrustedExecutorRuntimeV2>;
  readonly auditor: (input: BridgeAuditorFactoryInputV1) => TrustedAuditorRuntimeV2 | Promise<TrustedAuditorRuntimeV2>;
}

export interface ContinueBridgeTaskV1Input {
  readonly lease: LeaseRuntimeInputV2;
  readonly store: RalphEventStoreV2;
  readonly plan: ExecutionDocument;
  readonly planIdentity: string;
  readonly planDigest: string;
  readonly timeoutPolicy: M5BTimeoutPolicyV2;
  readonly runtimes: BridgeRuntimeFactoriesV1;
  readonly validationProcessSupervisor?: ValidationProcessSupervisorV2Like;
  readonly validationProcessPolicy?: ValidationProcessPolicyV2;
  readonly humanAuthority?: TrustedHumanValidationAuthorityV2;
  readonly safetyIterationLimit?: number;
  readonly clock?: () => string;
  readonly nonceFactory?: () => string;
  readonly eventIdFactory?: () => string;
  readonly attemptIdFactory?: () => string;
}

export interface ContinueBridgeTaskV1Result {
  readonly kind: BridgeOperationStopReasonV1;
  readonly state: RalphRuntimeStateV2;
  readonly attempt?: AttemptStateV2;
  readonly audit?: AuditAttemptV2Result;
  readonly correctionContexts: readonly CorrectionContextV2[];
}

/** One sequential task lifecycle, composed entirely from frozen Core stages. */
export async function continueBridgeTaskV1(input: ContinueBridgeTaskV1Input): Promise<ContinueBridgeTaskV1Result> {
  const clock = input.clock ?? (() => new Date().toISOString());
  const nonceFactory = input.nonceFactory ?? randomUUID;
  const eventIdFactory = input.eventIdFactory ?? randomUUID;
  const attemptIdFactory = input.attemptIdFactory ?? randomUUID;
  const safetyLimit = input.safetyIterationLimit ?? 64;
  if (!Number.isSafeInteger(safetyLimit) || safetyLimit < 1) throw new Error("RALPH_BRIDGE_DRIVER_SAFETY_LIMIT_INVALID");
  const initialLease = await acquireLeasedRunV2(input.lease);
  let state = initialLease.state;
  let preacquiredPostExecutorLease = hasPostExecutorOpenAttempt(state) ? initialLease : undefined;
  if (!preacquiredPostExecutorLease) await releaseKnownOwnedLeaseBestEffort(initialLease);
  let humanAuthority = input.humanAuthority;
  const contexts: CorrectionContextV2[] = [];

  for (let iteration = 0; iteration < safetyLimit; iteration += 1) {
    const resumed = await resumePostExecutorBoundary(input, state, contexts, clock, nonceFactory, eventIdFactory, preacquiredPostExecutorLease, humanAuthority);
    preacquiredPostExecutorLease = undefined;
    if (resumed) {
      humanAuthority = undefined;
      state = resumed.state;
      if (resumed.kind === "AUDIT_REJECTED") {
        state = await establishCorrectionBaseline(input.lease, resumed.attempt.taskId, resumed.observation, clock, nonceFactory, eventIdFactory);
        continue;
      }
      return resumed.result;
    }
    const admissionLease = await acquireLeasedRunV2(input.lease);
    let admitted: Awaited<ReturnType<typeof prepareNextAuthorizedInvocationV2>>;
    try {
      admitted = await prepareNextAuthorizedInvocationV2({
        leasedRun: admissionLease,
        plan: input.plan,
        planIdentity: input.planIdentity,
        planDigest: input.planDigest,
        attemptIdFactory,
        nonceFactory,
        eventIdFactory,
        clock,
      });
    } catch (error) {
      await releaseKnownOwnedLeaseBestEffort(admissionLease);
      throw error;
    }
    state = admitted.state;
    if (admitted.kind !== "AUTHORIZED_NOT_INVOKED" && admitted.kind !== "ALREADY_AUTHORIZED") {
      return { kind: stopForAdmission(admitted.kind, state), state, correctionContexts: contexts };
    }

    const admittedAttempt = admitted.attempt.attempt;
    const findings = openFindingsForTask(state, admittedAttempt.taskId);
    let correctionContext: CorrectionContextV2 | undefined;
    const executionLease = await acquireLeasedRunV2(input.lease);
    let executed: Awaited<ReturnType<typeof executeAuthorizedInvocationV2>>;
    try {
      if (findings.length > 0) {
        correctionContext = await ensureCorrectionContext(executionLease, admittedAttempt, state, findings, clock, nonceFactory);
        if (!contexts.some((entry) => entry.contextId === correctionContext!.contextId)) contexts.push(correctionContext);
      }
      const runtime = await input.runtimes.executor({
        store: input.store,
        authorizedInvocation: admitted.authorizedInvocation,
        timeoutPolicy: input.timeoutPolicy,
        ...(correctionContext ? { correctionContext } : {}),
      });
      assertTrustedExecutorRuntimeV2(runtime);
      if (correctionContext && runtime instanceof ScriptedExecutor) {
        runtime.setCorrectionContext(admitted.invocation.invocationId, toScriptedCorrectionContext(correctionContext));
      }
      executed = await executeAuthorizedInvocationV2({
        leasedRun: executionLease,
        plan: input.plan,
        runtime,
        attemptId: admittedAttempt.attemptId,
        planIdentity: input.planIdentity,
        planDigest: input.planDigest,
        clock,
        nonceFactory,
        eventIdFactory,
      });
    } catch (error) {
      await releaseKnownOwnedLeaseBestEffort(executionLease);
      throw error;
    }
    if (executed.kind !== "EXECUTOR_FINISHED_READY_FOR_CAPTURE") {
      const kind = executed.kind === "RECONCILIATION_REQUIRED" ? "RECONCILIATION_REQUIRED" : "EXECUTOR_TERMINAL";
      return { kind, state: executed.state, attempt: executed.attempt, correctionContexts: contexts };
    }

    let captured: Awaited<ReturnType<typeof captureEvidenceV2>>;
    try {
      captured = await captureEvidenceV2({ leasedRun: executionLease, plan: input.plan, observation: executed.observation, clock, nonceFactory, eventIdFactory });
    } catch (error) {
      await releaseKnownOwnedLeaseBestEffort(executionLease, executed.observation);
      throw error;
    }
    if (captured.kind !== "EVIDENCE_CAPTURED_READY_FOR_VALIDATION") {
      const kind = captured.kind === "RECONCILIATION_REQUIRED" ? "RECONCILIATION_REQUIRED" : "EXECUTOR_TERMINAL";
      return { kind, state: captured.state, attempt: captured.attempt, correctionContexts: contexts };
    }

    const validationLease = await acquireLeasedRunV2(input.lease);
    let validated: Awaited<ReturnType<typeof validateAttemptV2>>;
    try {
      validated = await validateAttemptV2({
        leasedRun: validationLease,
        plan: input.plan,
        planIdentity: input.planIdentity,
        planDigest: input.planDigest,
        executorObservation: executed.observation,
        ...(humanAuthority ? { humanAuthority } : {}),
        processSupervisor: input.validationProcessSupervisor,
        processPolicy: input.validationProcessPolicy,
        clock,
        nonceFactory,
        eventIdFactory,
      });
    } catch (error) {
      await releaseKnownOwnedLeaseBestEffort(validationLease, executed.observation);
      throw error;
    }
    humanAuthority = undefined;
    if (validated.kind !== "VALIDATION_READY_FOR_AUDIT") {
      const kind: BridgeOperationStopReasonV1 = validated.kind === "HUMAN_REQUIRED"
        ? "HUMAN_REQUIRED"
        : validated.kind === "RECONCILIATION_REQUIRED"
          ? "RECONCILIATION_REQUIRED"
          : validated.kind === "CONTROL_PLANE_VIOLATION"
            ? "INTEGRITY_FAILURE"
            : "VALIDATION_INFRASTRUCTURE_EXHAUSTED";
      return { kind, state: validated.state, attempt: validated.attempt, correctionContexts: contexts };
    }

    const auditor = await input.runtimes.auditor({ store: input.store, auditPackage: validated.auditPackage, timeoutPolicy: input.timeoutPolicy });
    const auditLease = await acquireLeasedRunV2(input.lease);
    let audited: AuditAttemptV2Result;
    try {
      audited = await auditAttemptV2({ leasedRun: auditLease, plan: input.plan, auditor, executorObservation: executed.observation, clock, nonceFactory, eventIdFactory });
    } catch (error) {
      await releaseKnownOwnedLeaseBestEffort(auditLease, executed.observation);
      throw error;
    }
    state = audited.state;
    if (audited.kind === "AUDIT_ACCEPTED") {
      return { kind: "TASK_COMPLETE", state, attempt: audited.attempt, audit: audited, correctionContexts: contexts };
    }
    if (audited.kind !== "AUDIT_REJECTED") {
      const kind = audited.kind === "RECONCILIATION_REQUIRED" ? "RECONCILIATION_REQUIRED" : "NOT_AUDITABLE";
      return { kind, state, attempt: audited.attempt, audit: audited, correctionContexts: contexts };
    }
    state = await establishCorrectionBaseline(input.lease, admittedAttempt.taskId, executed.observation, clock, nonceFactory, eventIdFactory);
  }
  return { kind: "DRIVER_SAFETY_LIMIT", state, correctionContexts: contexts };
}

type ResumedBoundaryV1 =
  | { readonly kind: "RETURN"; readonly state: RalphRuntimeStateV2; readonly result: ContinueBridgeTaskV1Result }
  | { readonly kind: "AUDIT_REJECTED"; readonly state: RalphRuntimeStateV2; readonly attempt: AttemptStateV2; readonly observation: TrustedExecutorObservationV2 };

/** Resume only durable post-executor work. It never constructs a runtime or a dispatch capability. */
async function resumePostExecutorBoundary(
  input: ContinueBridgeTaskV1Input,
  state: RalphRuntimeStateV2,
  contexts: readonly CorrectionContextV2[],
  clock: () => string,
  nonceFactory: () => string,
  eventIdFactory: () => string,
  preacquiredLease?: LeasedRunV2,
  humanAuthority?: TrustedHumanValidationAuthorityV2,
): Promise<ResumedBoundaryV1 | undefined> {
  const attempt = Object.values(state.attempts).find((candidate) => candidate.disposition === "OPEN");
  if (!attempt || !["POST_EXECUTOR_CAPTURE", "EVIDENCE_CAPTURING", "VALIDATING", "AWAITING_HUMAN", "AWAITING_AUDIT", "AUDITING"].includes(attempt.stage)) {
    return undefined;
  }

  const leasedRun = preacquiredLease ?? await acquireLeasedRunV2(input.lease);
  let observation: TrustedExecutorObservationV2;
  try {
    const authorization = await authorizePostExecutorObservationV2({
      leasedRun,
      plan: input.plan,
      attemptId: attempt.attemptId,
      planIdentity: input.planIdentity,
      planDigest: input.planDigest,
    });
    observation = await rehydrateTrustedExecutorObservationV2({ leasedRun, authorization });
  } catch (error) {
    await releaseKnownOwnedLeaseBestEffort(leasedRun);
    throw error;
  }

  let current = leasedRun.state.attempts[attempt.attemptId] ?? attempt;
  let retainedLease: LeasedRunV2 | undefined = leasedRun;
  if (current.stage === "POST_EXECUTOR_CAPTURE" || current.stage === "EVIDENCE_CAPTURING") {
    let captured: Awaited<ReturnType<typeof captureEvidenceV2>>;
    try {
      captured = await captureEvidenceV2({ leasedRun, plan: input.plan, observation, clock, nonceFactory, eventIdFactory });
    } catch (error) {
      await releaseKnownOwnedLeaseBestEffort(leasedRun, observation);
      throw error;
    }
    if (captured.kind !== "EVIDENCE_CAPTURED_READY_FOR_VALIDATION") {
      const kind = captured.kind === "RECONCILIATION_REQUIRED" ? "RECONCILIATION_REQUIRED" : "EXECUTOR_TERMINAL";
      return { kind: "RETURN", state: captured.state, result: { kind, state: captured.state, attempt: captured.attempt, correctionContexts: contexts } };
    }
    current = captured.attempt;
    retainedLease = undefined;
  }

  let readyForAudit: AuditPackageV2 | undefined;
  const afterCapture = current.stage === "VALIDATING" || current.stage === "AWAITING_HUMAN";
  if (afterCapture) {
    const validationLease = retainedLease ?? await acquireLeasedRunV2(input.lease);
    let validated: Awaited<ReturnType<typeof validateAttemptV2>>;
    try {
      validated = await validateAttemptV2({
        leasedRun: validationLease,
        plan: input.plan,
        planIdentity: input.planIdentity,
        planDigest: input.planDigest,
        executorObservation: observation,
        ...(humanAuthority ? { humanAuthority } : {}),
        processSupervisor: input.validationProcessSupervisor,
        processPolicy: input.validationProcessPolicy,
        clock,
        nonceFactory,
        eventIdFactory,
      });
    } catch (error) {
      await releaseKnownOwnedLeaseBestEffort(validationLease, observation);
      throw error;
    }
    retainedLease = undefined;
    if (validated.kind !== "VALIDATION_READY_FOR_AUDIT") {
      const kind: BridgeOperationStopReasonV1 = validated.kind === "HUMAN_REQUIRED"
        ? "HUMAN_REQUIRED"
        : validated.kind === "RECONCILIATION_REQUIRED"
          ? "RECONCILIATION_REQUIRED"
          : validated.kind === "CONTROL_PLANE_VIOLATION"
            ? "INTEGRITY_FAILURE"
            : "VALIDATION_INFRASTRUCTURE_EXHAUSTED";
      return { kind: "RETURN", state: validated.state, result: { kind, state: validated.state, attempt: validated.attempt, correctionContexts: contexts } };
    }
    state = validated.state;
    current = validated.attempt;
    readyForAudit = validated.auditPackage;
  } else {
    state = retainedLease?.state ?? await readState(input.lease);
    current = state.attempts[attempt.attemptId] ?? attempt;
  }

  if (current.stage !== "AWAITING_AUDIT" && current.stage !== "AUDITING") {
    throw new Error("RALPH_BRIDGE_POST_EXECUTOR_STAGE_RECONCILIATION_REQUIRED");
  }
  const auditPackage = readyForAudit ?? await readAuditPackageV2(input.store, current.attemptId);
  if (!auditPackage) throw new Error("RALPH_BRIDGE_AUDIT_PACKAGE_REQUIRED");
  const auditor = await input.runtimes.auditor({ store: input.store, auditPackage, timeoutPolicy: input.timeoutPolicy });
  const auditLease = retainedLease ?? await acquireLeasedRunV2(input.lease);
  let audited: AuditAttemptV2Result;
  try {
    audited = await auditAttemptV2({ leasedRun: auditLease, plan: input.plan, auditor, executorObservation: observation, clock, nonceFactory, eventIdFactory });
  } catch (error) {
    await releaseKnownOwnedLeaseBestEffort(auditLease, observation);
    throw error;
  }
  if (audited.kind === "AUDIT_ACCEPTED") {
    return { kind: "RETURN", state: audited.state, result: { kind: "TASK_COMPLETE", state: audited.state, attempt: audited.attempt, audit: audited, correctionContexts: contexts } };
  }
  if (audited.kind === "AUDIT_REJECTED") {
    return { kind: "AUDIT_REJECTED", state: audited.state, attempt: audited.attempt, observation };
  }
  const kind = audited.kind === "RECONCILIATION_REQUIRED" ? "RECONCILIATION_REQUIRED" : "NOT_AUDITABLE";
  return { kind: "RETURN", state: audited.state, result: { kind, state: audited.state, attempt: audited.attempt, audit: audited, correctionContexts: contexts } };
}

function hasPostExecutorOpenAttempt(state: RalphRuntimeStateV2): boolean {
  return Object.values(state.attempts).some((attempt) => attempt.disposition === "OPEN"
    && ["POST_EXECUTOR_CAPTURE", "EVIDENCE_CAPTURING", "VALIDATING", "AWAITING_HUMAN", "AWAITING_AUDIT", "AUDITING"].includes(attempt.stage));
}

async function ensureCorrectionContext(
  leasedRun: LeasedRunV2,
  attempt: AttemptStateV2,
  state: RalphRuntimeStateV2,
  findings: readonly Finding[],
  clock: () => string,
  nonceFactory: () => string,
): Promise<CorrectionContextV2> {
  const existing = await readCorrectionContextV2(leasedRun.store, attempt.attemptId);
  const sourceRejectedAttempts = Object.values(state.attempts)
    .filter((candidate) => candidate.taskId === attempt.taskId && candidate.disposition === "CLOSED" && candidate.closureReason === "AUDIT_REJECTED" && candidate.auditPackage && candidate.validationSet)
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((candidate) => ({ attemptId: candidate.attemptId, ordinal: candidate.ordinal, closureReason: "AUDIT_REJECTED" as const, auditPackageDigest: candidate.auditPackage!.auditPackageDigest, validationSetDigest: candidate.validationSet!.validationSetDigest }));
  const openFindingRefs = findings.map((finding) => finding.id).sort();
  const openFindings = findings.slice().sort((left, right) => left.id.localeCompare(right.id)).map((finding) => ({
    findingId: finding.id,
    findingDigest: findingDigestV2(finding),
    criterionId: finding.criterionId,
    severity: finding.severity,
    status: finding.status as "OPEN" | "CANDIDATE_RESOLVED" | "HUMAN_PENDING",
    observed: finding.observed,
    ...(finding.remediationHint === undefined ? {} : { remediationHint: finding.remediationHint }),
  }));
  const created = createCorrectionContextV2({
    runId: leasedRun.runId,
    phaseId: attempt.phaseId,
    taskId: attempt.taskId,
    currentAttemptId: attempt.attemptId,
    sourceRejectedAttempts,
    openFindingRefs,
    openFindings,
    baseWorkspaceFingerprint: attempt.attemptBaseFingerprint,
    createdAt: clock(),
  });
  if (existing) {
    validateCorrectionContextV2(existing);
    if (existing.contextId !== correctionContextIdV2(created)) throw new Error("RALPH_BRIDGE_CORRECTION_CONTEXT_IMMUTABLE_CONFLICT");
    return existing;
  }
  await persistCorrectionContextV2(leasedRun.store, created, nonceFactory());
  return await readCorrectionContextV2(leasedRun.store, attempt.attemptId) ?? created;
}

async function establishCorrectionBaseline(
  leaseInput: LeaseRuntimeInputV2,
  taskId: string,
  observation: TrustedExecutorObservationV2,
  clock: () => string,
  nonceFactory: () => string,
  eventIdFactory: () => string,
): Promise<RalphRuntimeStateV2> {
  const leasedRun = await acquireLeasedRunV2(leaseInput);
  try {
    const attempt = Object.values(leasedRun.state.attempts).find((candidate) => candidate.taskId === taskId
      && candidate.disposition === "CLOSED" && candidate.closureReason === "AUDIT_REJECTED"
      && candidate.invocation?.invocationId === observation.invocationId);
    if (!attempt) throw new Error("RALPH_BRIDGE_CORRECTION_BASELINE_ATTEMPT_REQUIRED");
    const binding = { runId: leasedRun.runId, phaseId: attempt.phaseId, taskId: attempt.taskId, attemptId: attempt.attemptId, invocationId: attempt.invocation?.invocationId ?? `closed-${attempt.attemptId}` };
    const first = await observeWorkspaceManifestV2({ projectRoot: leasedRun.projectRoot, policy: leasedRun.snapshot.workspacePolicy, binding, fileSystem: leasedRun.workspaceFingerprintFileSystem });
    const second = await observeWorkspaceManifestV2({ projectRoot: leasedRun.projectRoot, policy: leasedRun.snapshot.workspacePolicy, binding, fileSystem: leasedRun.workspaceFingerprintFileSystem });
    if (workspaceManifestCoreJson(first.manifest) !== workspaceManifestCoreJson(second.manifest)) throw new Error("RALPH_BRIDGE_CORRECTION_BASELINE_UNSTABLE");
    const current = leasedRun.state.checkpoints.acceptedCheckpointFingerprint;
    if (!current || current.fingerprintDigest !== first.fingerprint.fingerprintDigest) {
      const checkpoint: CheckpointRecord = { kind: "acceptedCheckpointFingerprint", fingerprintDigest: first.fingerprint.fingerprintDigest, emittedAt: clock(), attemptId: attempt.attemptId, evidenceSetId: attempt.evidenceCapture?.evidenceCaptureId };
      await commitDriverEvent(leasedRun, coreEvent(leasedRun.state, "workspace.checkpointed", { checkpoint }, { workspace: true, eventIdFactory, clock }), clock, nonceFactory);
    }
    const refs = ["work-unit.json", "invocation.json", "invocation-result.json", "workspace-before.json", "workspace-after.json", "evidence-capture.json"]
      .map((name) => attemptArtifactRefV2(attempt.attemptId, name));
    const proof = await deriveExecutorReleaseProofV2(leasedRun, observation, refs);
    await releaseLeasedRunV2(leasedRun, { proof });
    return leasedRun.state;
  } catch (error) {
    await releaseKnownOwnedLeaseBestEffort(leasedRun, observation);
    throw error;
  }
}

async function readState(lease: LeaseRuntimeInputV2): Promise<RalphRuntimeStateV2> {
  const leasedRun = await acquireLeasedRunV2(lease);
  try { return leasedRun.state; }
  finally { await releaseLeasedRunV2(leasedRun); }
}

async function releaseKnownOwnedLeaseBestEffort(leasedRun: LeasedRunV2, observation?: TrustedExecutorObservationV2): Promise<void> {
  try {
    const attempt = Object.values(leasedRun.state.attempts).find((candidate) => candidate.disposition === "OPEN");
    if (!attempt?.invocation) return await releaseLeasedRunV2(leasedRun);
    if (observation && attempt.executorFinished) {
      const proof = await deriveExecutorReleaseProofV2(leasedRun, observation, [
        attemptArtifactRefV2(attempt.attemptId, "work-unit.json"),
        attemptArtifactRefV2(attempt.attemptId, "invocation.json"),
        attemptArtifactRefV2(attempt.attemptId, "invocation-result.json"),
      ]);
      return await releaseLeasedRunV2(leasedRun, { proof });
    }
    if (attempt.stage === "EXECUTOR_DISPATCH_AUTHORIZED" && !attempt.executorFinished) {
      const proof = await derivePreExecutorReleaseProofV2(leasedRun, {
        attemptId: attempt.attemptId,
        invocationId: attempt.invocation.invocationId,
        artifactRefs: [attemptArtifactRefV2(attempt.attemptId, "work-unit.json"), attemptArtifactRefV2(attempt.attemptId, "invocation.json")],
      });
      await releaseLeasedRunV2(leasedRun, { proof });
    }
  } catch {
    // Ambiguous executor/durability state intentionally remains recoverable.
  }
}

function toScriptedCorrectionContext(context: CorrectionContextV2): ScriptedExecutorCorrectionContextV2 {
  return {
    contextId: context.contextId,
    contextDigest: context.contextDigest,
    taskId: context.taskId,
    attemptId: context.currentAttemptId,
    findingIds: context.openFindingRefs,
    findingDigests: context.openFindings.map((finding) => finding.findingDigest),
    openFindings: context.openFindings.map((finding) => ({
      findingId: finding.findingId, findingDigest: finding.findingDigest, criterionId: finding.criterionId,
      severity: finding.severity, status: finding.status, observed: finding.observed,
      ...(finding.remediationHint === undefined ? {} : { remediationHint: finding.remediationHint }),
    })),
  };
}

function openFindingsForTask(state: RalphRuntimeStateV2, taskId: string): Finding[] {
  return Object.values(state.findings).filter((finding) => finding.taskId === taskId && !["RESOLVED", "SUPERSEDED"].includes(finding.status));
}

function stopForAdmission(kind: "NO_WORK" | "WAITING" | "BLOCKED" | "HOLD" | "RECONCILIATION_REQUIRED", state: RalphRuntimeStateV2): BridgeOperationStopReasonV1 {
  if (kind === "RECONCILIATION_REQUIRED" || state.hold === "RECONCILIATION_REQUIRED") return "RECONCILIATION_REQUIRED";
  if (kind === "HOLD" && state.hold === "HUMAN_REQUIRED") return "HUMAN_REQUIRED";
  return "BUDGET_EXHAUSTED";
}

async function commitDriverEvent(leasedRun: LeasedRunV2, event: RalphEventV2, clock: () => string, nonceFactory: () => string): Promise<void> {
  await revalidateLeaseOwnershipV2(leasedRun);
  const committed = await commitRalphEventV2({ store: leasedRun.store, state: leasedRun.state, event, writtenAt: clock(), nonce: nonceFactory() });
  if (committed.eventDurability !== "DURABLE") throw new Error("RALPH_BRIDGE_EVENT_DURABILITY_UNKNOWN");
  await refreshLeasedRunV2(leasedRun);
}

function coreEvent<TType extends RalphEventTypeV2>(
  state: RalphRuntimeStateV2,
  eventType: TType,
  payload: EventPayloadMapV2[TType],
  context: { readonly phaseId?: string; readonly taskId?: string; readonly attemptId?: string; readonly findingId?: string; readonly workspace?: boolean; readonly eventIdFactory: () => string; readonly clock: () => string },
): RalphEventV2 {
  const kind = V2_EVENT_ENTITY_KINDS[eventType];
  const entity: RuntimeEntityRef = kind === "run" ? { kind, id: state.runId }
    : kind === "task" ? { kind, id: context.taskId ?? "task" }
      : kind === "finding" ? { kind, id: context.findingId ?? "finding" }
        : kind === "workspace" ? { kind, id: `${state.runId}:workspace` }
          : { kind: "attempt", id: context.attemptId ?? "attempt" };
  return createRalphEventV2({
    eventId: context.eventIdFactory(), eventType, schemaVersion: state.eventSchema, runId: state.runId,
    sequence: state.lastSequence + 1, occurredAt: context.clock(), recordedAt: context.clock(), entity,
    ...(kind === "attempt" ? { phaseId: context.phaseId, taskId: context.taskId, attemptId: context.attemptId }
      : kind === "task" ? { phaseId: context.phaseId, taskId: context.taskId } : {}),
    actor: "CORE", causationId: null, correlationId: `${state.runId}:${context.attemptId ?? eventType}`,
    payload, previousEventHash: state.lastEventHash,
  } as UnsignedRalphEventV2<TType>) as RalphEventV2;
}

export function bridgeOperationBindingDigest(input: Pick<ContinueBridgeTaskV1Input, "planIdentity" | "planDigest">): string {
  return sha256Canonical(input);
}
