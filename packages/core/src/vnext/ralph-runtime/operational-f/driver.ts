import type { ExecutionDocument } from "../../../types.js";
import type { CheckpointRecord, RuntimeEntityRef } from "../contracts.js";
import { sha256Canonical } from "../hashing.js";
import {
  acquireLeasedRunV2,
  derivePreExecutorReleaseProofV2,
  deriveExecutorReleaseProofV2,
  revalidateLeaseOwnershipV2,
  releaseLeasedRunV2,
  refreshLeasedRunV2,
  type LeaseRuntimeInputV2,
  type LeasedRunV2,
} from "../operational-b2/index.js";
import { commitRalphEventV2 } from "../operational-b1/index.js";
import { prepareNextAuthorizedInvocationV2 } from "../operational-b3/index.js";
import {
  executeAuthorizedInvocationV2,
  ScriptedExecutor,
  assertTrustedExecutorRuntimeV2,
  type ScriptedExecutorCorrectionContextV2,
} from "../operational-b4/index.js";
import { attemptArtifactRefV2 } from "../operational-b4/artifacts.js";
import { observeWorkspaceManifestV2, workspaceManifestCoreJson } from "../operational-b4/workspace-manifest.js";
import { captureEvidenceV2 } from "../operational-c/index.js";
import { validateAttemptV2 } from "../operational-d/index.js";
import type { ValidationProcessPolicyV2, ValidationProcessSupervisorV2Like } from "../operational-d/process-supervisor.js";
import type { TrustedExecutorObservationV2 } from "../operational-b4/execution-observation.js";
import {
  createRalphEventV2,
  V2_EVENT_ENTITY_KINDS,
  type EventPayloadMapV2,
  type RalphEventTypeV2,
  type RalphEventV2,
  type UnsignedRalphEventV2,
} from "../operational-v2/events.js";
import type { RalphRuntimeStateV2, AttemptStateV2 } from "../operational-v2/contracts.js";
import {
  createCorrectionContextV2,
  correctionContextIdV2,
  persistCorrectionContextV2,
  readCorrectionContextV2,
  validateCorrectionContextV2,
  type CorrectionContextV2,
} from "./correction-context.js";
import { auditAttemptV2, type AuditAttemptV2Result } from "../operational-e/audit.js";
import { ScriptedAuditor } from "../operational-e/auditor-runtime.js";
import { findingDigestV2 } from "../operational-d/artifacts.js";

export const F_DRIVER_STOP_REASONS = [
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
export type FDriverStopReason = typeof F_DRIVER_STOP_REASONS[number];

export interface ContinueScriptedRalphRunV2Input {
  readonly lease: LeaseRuntimeInputV2;
  readonly plan: ExecutionDocument;
  readonly executor: ScriptedExecutor;
  readonly auditor: ScriptedAuditor;
  readonly validationProcessSupervisor?: ValidationProcessSupervisorV2Like;
  readonly validationProcessPolicy?: ValidationProcessPolicyV2;
  /** Host watchdog only; it is not a replacement for the frozen Task budget. */
  readonly safetyIterationLimit?: number;
  readonly clock?: () => string;
  readonly nonceFactory?: () => string;
  readonly eventIdFactory?: () => string;
  readonly attemptIdFactory?: () => string;
}

export interface ContinueScriptedRalphRunV2Result {
  readonly kind: FDriverStopReason;
  readonly outcome: FDriverStopReason;
  readonly state: RalphRuntimeStateV2;
  readonly attempt?: AttemptStateV2;
  readonly audit?: AuditAttemptV2Result;
  readonly correctionContexts: readonly CorrectionContextV2[];
}

/**
 * Internal-only M3 composition driver.  It exposes no CLI and introduces no
 * provider/model dispatch. Every semantic transition still crosses B1.
 */
export async function continueScriptedRalphRunV2(input: ContinueScriptedRalphRunV2Input): Promise<ContinueScriptedRalphRunV2Result> {
  assertTrustedExecutorRuntimeV2(input.executor);
  const clock = input.clock ?? (() => new Date().toISOString());
  let nonceOrdinal = 0;
  const nonceFactory = input.nonceFactory ?? (() => `f-${++nonceOrdinal}`);
  const eventIdFactory = input.eventIdFactory ?? (() => `f-event-${++nonceOrdinal}`);
  const attemptIdFactory = input.attemptIdFactory ?? (() => `f-attempt-${++nonceOrdinal}`);
  const safetyLimit = input.safetyIterationLimit ?? 64;
  if (!Number.isSafeInteger(safetyLimit) || safetyLimit < 1) throw new Error("F_DRIVER_SAFETY_LIMIT_INVALID");
  let state = await readState(input.lease);
  const contexts: CorrectionContextV2[] = [];

  for (let iteration = 0; iteration < safetyLimit; iteration += 1) {
    if (state.disposition === "COMPLETE") return { kind: "TASK_COMPLETE", outcome: "TASK_COMPLETE", state, correctionContexts: contexts };
    const admissionLease = await acquireLeasedRunV2(input.lease);
    let admitted: Awaited<ReturnType<typeof prepareNextAuthorizedInvocationV2>>;
    try {
      admitted = await prepareNextAuthorizedInvocationV2({
        leasedRun: admissionLease,
        plan: input.plan,
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
      if (state.disposition === "COMPLETE") return { kind: "TASK_COMPLETE", outcome: "TASK_COMPLETE", state, correctionContexts: contexts };
      const stop = driverStopForAdmission(admitted.kind, state);
      return { kind: stop, outcome: stop, state, correctionContexts: contexts };
    }

    const admittedAttempt = admitted.attempt.attempt;
    const currentFindings = openFindingsForTask(state, admittedAttempt.taskId);
    let correctionContext: CorrectionContextV2 | undefined;
    if (currentFindings.length > 0) {
      const executionLease = await acquireLeasedRunV2(input.lease);
      let executed: Awaited<ReturnType<typeof executeAuthorizedInvocationV2>>;
      try {
        correctionContext = await ensureCorrectionContext(executionLease, admittedAttempt, state, currentFindings, clock, nonceFactory);
        if (!contexts.some((entry) => entry.contextId === correctionContext!.contextId)) contexts.push(correctionContext);
        const executorContext = toExecutorCorrectionContext(correctionContext);
        input.executor.setCorrectionContext(admitted.invocation.invocationId, executorContext);
        executed = await executeAuthorizedInvocationV2({ leasedRun: executionLease, plan: input.plan, runtime: input.executor, attemptId: admittedAttempt.attemptId, clock, nonceFactory, eventIdFactory });
      } catch (error) {
        await releaseKnownOwnedLeaseBestEffort(executionLease);
        throw error;
      }
      if (executed.kind !== "EXECUTOR_FINISHED_READY_FOR_CAPTURE") {
        const stop = executed.kind === "RECONCILIATION_REQUIRED" ? "RECONCILIATION_REQUIRED" : "EXECUTOR_TERMINAL";
        return { kind: stop, outcome: stop, state: executed.state, attempt: executed.attempt, correctionContexts: contexts };
      }
      const continued = await continueAfterExecutor(input, executionLease, executed, clock, nonceFactory, eventIdFactory);
      state = continued.state;
      if (continued.stop) return { ...continued.stop, correctionContexts: contexts };
      if (continued.audit?.kind === "AUDIT_REJECTED") {
        state = await establishCorrectionBaseline(input.lease, continued.state, admittedAttempt.taskId, executed.observation, clock, nonceFactory, eventIdFactory);
      }
      continue;
    }

    const executionLease = await acquireLeasedRunV2(input.lease);
    let executed: Awaited<ReturnType<typeof executeAuthorizedInvocationV2>>;
    try {
      executed = await executeAuthorizedInvocationV2({ leasedRun: executionLease, plan: input.plan, runtime: input.executor, attemptId: admittedAttempt.attemptId, clock, nonceFactory, eventIdFactory });
    } catch (error) {
      await releaseKnownOwnedLeaseBestEffort(executionLease);
      throw error;
    }
    if (executed.kind !== "EXECUTOR_FINISHED_READY_FOR_CAPTURE") {
      const stop = executed.kind === "RECONCILIATION_REQUIRED" ? "RECONCILIATION_REQUIRED" : "EXECUTOR_TERMINAL";
      return { kind: stop, outcome: stop, state: executed.state, attempt: executed.attempt, correctionContexts: contexts };
    }
    const continued = await continueAfterExecutor(input, executionLease, executed, clock, nonceFactory, eventIdFactory);
    state = continued.state;
    if (continued.stop) return { ...continued.stop, correctionContexts: contexts };
    if (continued.audit?.kind === "AUDIT_REJECTED") {
      state = await establishCorrectionBaseline(input.lease, continued.state, admittedAttempt.taskId, executed.observation, clock, nonceFactory, eventIdFactory);
    }
  }
  return { kind: "DRIVER_SAFETY_LIMIT", outcome: "DRIVER_SAFETY_LIMIT", state, correctionContexts: contexts };
}

async function continueAfterExecutor(
  input: ContinueScriptedRalphRunV2Input,
  leasedRun: LeasedRunV2,
  executed: Awaited<ReturnType<typeof executeAuthorizedInvocationV2>>,
  clock: () => string,
  nonceFactory: () => string,
  eventIdFactory: () => string,
): Promise<{ readonly state: RalphRuntimeStateV2; readonly stop?: Omit<ContinueScriptedRalphRunV2Result, "correctionContexts">; readonly audit?: AuditAttemptV2Result }> {
  if (executed.kind !== "EXECUTOR_FINISHED_READY_FOR_CAPTURE") {
    return { state: executed.state, stop: { kind: executed.kind === "RECONCILIATION_REQUIRED" ? "RECONCILIATION_REQUIRED" : "EXECUTOR_TERMINAL", outcome: executed.kind === "RECONCILIATION_REQUIRED" ? "RECONCILIATION_REQUIRED" : "EXECUTOR_TERMINAL", state: executed.state, attempt: executed.attempt } };
  }
  let captured: Awaited<ReturnType<typeof captureEvidenceV2>>;
  try {
    captured = await captureEvidenceV2({ leasedRun, plan: input.plan, observation: executed.observation, clock, nonceFactory, eventIdFactory });
  } catch (error) {
    await releaseKnownOwnedLeaseBestEffort(leasedRun, executed.observation);
    throw error;
  }
  if (captured.kind !== "EVIDENCE_CAPTURED_READY_FOR_VALIDATION") {
    return { state: captured.state, stop: { kind: captured.kind === "RECONCILIATION_REQUIRED" ? "RECONCILIATION_REQUIRED" : "EXECUTOR_TERMINAL", outcome: captured.kind === "RECONCILIATION_REQUIRED" ? "RECONCILIATION_REQUIRED" : "EXECUTOR_TERMINAL", state: captured.state, attempt: captured.attempt } };
  }
  // C deliberately releases the executor lease after durable evidence. D and
  // E therefore reacquire their own Core lease boundaries; a released B4/C
  // handle must never be reused for a later stage.
  const validationLease = await acquireLeasedRunV2(input.lease);
  let validated: Awaited<ReturnType<typeof validateAttemptV2>>;
  try {
    validated = await validateAttemptV2({ leasedRun: validationLease, plan: input.plan, executorObservation: executed.observation, processSupervisor: input.validationProcessSupervisor, processPolicy: input.validationProcessPolicy, clock, nonceFactory, eventIdFactory });
  } catch (error) {
    await releaseKnownOwnedLeaseBestEffort(validationLease, executed.observation);
    throw error;
  }
  if (validated.kind !== "VALIDATION_READY_FOR_AUDIT") {
    const stop = validated.kind === "HUMAN_REQUIRED"
      ? "HUMAN_REQUIRED"
      : validated.kind === "RECONCILIATION_REQUIRED"
        ? "RECONCILIATION_REQUIRED"
        : validated.kind === "CONTROL_PLANE_VIOLATION"
          ? "INTEGRITY_FAILURE"
          : "VALIDATION_INFRASTRUCTURE_EXHAUSTED";
    return { state: validated.state, stop: { kind: stop, outcome: stop, state: validated.state, attempt: validated.attempt } };
  }
  const auditLease = await acquireLeasedRunV2(input.lease);
  let audited: AuditAttemptV2Result;
  try {
    audited = await auditAttemptV2({ leasedRun: auditLease, plan: input.plan, auditor: input.auditor, executorObservation: executed.observation, clock, nonceFactory, eventIdFactory });
  } catch (error) {
    await releaseKnownOwnedLeaseBestEffort(auditLease, executed.observation);
    throw error;
  }
  if (audited.kind === "AUDIT_ACCEPTED") return { state: audited.state, audit: audited, stop: { kind: "TASK_COMPLETE", outcome: "TASK_COMPLETE", state: audited.state, attempt: audited.attempt, audit: audited } };
  if (audited.kind === "AUDIT_REJECTED") return { state: audited.state, audit: audited };
  return { state: audited.state, stop: { kind: audited.kind === "RECONCILIATION_REQUIRED" ? "RECONCILIATION_REQUIRED" : "NOT_AUDITABLE", outcome: audited.kind === "RECONCILIATION_REQUIRED" ? "RECONCILIATION_REQUIRED" : "NOT_AUDITABLE", state: audited.state, attempt: audited.attempt, audit: audited } };
}

async function ensureCorrectionContext(
  leasedRun: LeasedRunV2,
  attempt: AttemptStateV2,
  state: RalphRuntimeStateV2,
  findings: readonly import("../contracts.js").Finding[],
  clock: () => string,
  nonceFactory: () => string,
): Promise<CorrectionContextV2> {
  const existing = await readCorrectionContextV2(leasedRun.store, attempt.attemptId);
  const sourceRejectedAttempts = Object.values(state.attempts)
    .filter((candidate) => candidate.taskId === attempt.taskId && candidate.disposition === "CLOSED" && candidate.closureReason === "AUDIT_REJECTED" && candidate.auditPackage && candidate.validationSet)
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((candidate) => ({ attemptId: candidate.attemptId, ordinal: candidate.ordinal, closureReason: "AUDIT_REJECTED" as const, auditPackageDigest: candidate.auditPackage!.auditPackageDigest, validationSetDigest: candidate.validationSet!.validationSetDigest }));
  const openFindingRefs = findings.map((finding) => finding.id).sort();
  const openFindings = findings.slice().sort((left, right) => left.id.localeCompare(right.id)).map((finding) => ({ findingId: finding.id, findingDigest: findingDigestV2(finding), criterionId: finding.criterionId, severity: finding.severity, status: finding.status as "OPEN" | "CANDIDATE_RESOLVED" | "HUMAN_PENDING", observed: finding.observed, ...(finding.remediationHint === undefined ? {} : { remediationHint: finding.remediationHint }) }));
  const created = createCorrectionContextV2({ runId: leasedRun.runId, phaseId: attempt.phaseId, taskId: attempt.taskId, currentAttemptId: attempt.attemptId, sourceRejectedAttempts, openFindingRefs, openFindings, baseWorkspaceFingerprint: attempt.attemptBaseFingerprint, createdAt: clock() });
  if (existing) {
    validateCorrectionContextV2(existing);
    // `createdAt` is publication metadata, not identity.  A replay after a
    // crash may have a different wall clock while the Core-derived context
    // binding remains exactly the same.
    if (existing.contextId !== correctionContextIdV2(created)) throw new Error("F_CORRECTION_CONTEXT_IMMUTABLE_CONFLICT");
    return existing;
  }
  await persistCorrectionContextV2(leasedRun.store, created, nonceFactory());
  return await readCorrectionContextV2(leasedRun.store, attempt.attemptId) ?? created;
}

function toExecutorCorrectionContext(context: CorrectionContextV2): ScriptedExecutorCorrectionContextV2 {
  return {
    contextId: context.contextId,
    contextDigest: context.contextDigest,
    taskId: context.taskId,
    attemptId: context.currentAttemptId,
    findingIds: context.openFindingRefs,
    findingDigests: context.openFindings.map((finding) => finding.findingDigest),
    openFindings: context.openFindings.map((finding) => ({ findingId: finding.findingId, findingDigest: finding.findingDigest, criterionId: finding.criterionId, severity: finding.severity, status: finding.status, observed: finding.observed, ...(finding.remediationHint === undefined ? {} : { remediationHint: finding.remediationHint }) })),
  };
}

async function establishCorrectionBaseline(
  leaseInput: LeaseRuntimeInputV2,
  state: RalphRuntimeStateV2,
  taskId: string,
  observation: TrustedExecutorObservationV2,
  clock: () => string,
  nonceFactory: () => string,
  eventIdFactory: () => string,
): Promise<RalphRuntimeStateV2> {
  const leasedRun = await acquireLeasedRunV2(leaseInput);
  try {
  // Bind the baseline to the executor observation that produced this
  // rejection.  A bounded loop may already contain more than one rejected
  // Attempt; choosing the first task match would mint a release proof with
  // artifacts from a different Attempt.
  const attempt = Object.values(leasedRun.state.attempts).find((candidate) => candidate.taskId === taskId
    && candidate.disposition === "CLOSED"
    && candidate.closureReason === "AUDIT_REJECTED"
    && candidate.invocation?.invocationId === observation.invocationId);
  if (!attempt) throw new Error("F_CORRECTION_BASELINE_ATTEMPT_REQUIRED");
  const binding = { runId: leasedRun.runId, phaseId: attempt.phaseId, taskId: attempt.taskId, attemptId: attempt.attemptId, invocationId: attempt.invocation?.invocationId ?? `closed-${attempt.attemptId}` };
  const fileSystem = leasedRun.workspaceFingerprintFileSystem;
  const first = await observeWorkspaceManifestV2({ projectRoot: leasedRun.projectRoot, policy: leasedRun.snapshot.workspacePolicy, binding, fileSystem });
  const second = await observeWorkspaceManifestV2({ projectRoot: leasedRun.projectRoot, policy: leasedRun.snapshot.workspacePolicy, binding, fileSystem });
  if (workspaceManifestCoreJson(first.manifest) !== workspaceManifestCoreJson(second.manifest)) throw new Error("F_CORRECTION_BASELINE_UNSTABLE");
  const current = leasedRun.state.checkpoints.acceptedCheckpointFingerprint;
  if (!current || current.fingerprintDigest !== first.fingerprint.fingerprintDigest) {
    const checkpoint: CheckpointRecord = { kind: "acceptedCheckpointFingerprint", fingerprintDigest: first.fingerprint.fingerprintDigest, emittedAt: clock(), attemptId: attempt.attemptId, evidenceSetId: attempt.evidenceCapture?.evidenceCaptureId };
    const event = coreEvent(leasedRun.state, "workspace.checkpointed", { checkpoint }, { workspace: true, eventIdFactory, clock });
    await commitDriverEvent(leasedRun, event, clock, nonceFactory);
  }
  const releaseRefs = [
    attemptArtifactRefV2(attempt.attemptId, "work-unit.json"),
    attemptArtifactRefV2(attempt.attemptId, "invocation.json"),
    attemptArtifactRefV2(attempt.attemptId, "invocation-result.json"),
    attemptArtifactRefV2(attempt.attemptId, "workspace-before.json"),
    attemptArtifactRefV2(attempt.attemptId, "workspace-after.json"),
    attemptArtifactRefV2(attempt.attemptId, "evidence-capture.json"),
  ];
  const proof = await deriveExecutorReleaseProofV2(leasedRun, observation, releaseRefs);
  await releaseLeasedRunV2(leasedRun, { proof });
  void state;
  return leasedRun.state;
  } catch (error) {
    await releaseKnownOwnedLeaseBestEffort(leasedRun, observation);
    throw error;
  }
}

async function readState(lease: LeaseRuntimeInputV2): Promise<RalphRuntimeStateV2> {
  const leasedRun = await acquireLeasedRunV2(lease);
  try {
    return leasedRun.state;
  } finally {
    // The comparison policy is carried by the sealed lease. An ordinary read
    // failure cannot leave this known-owned, side-effect-free lease stranded.
    await releaseLeasedRunV2(leasedRun);
  }
}

async function releaseKnownOwnedLeaseBestEffort(
  leasedRun: LeasedRunV2,
  observation?: TrustedExecutorObservationV2,
): Promise<void> {
  try {
    const attempt = Object.values(leasedRun.state.attempts).find((candidate) => candidate.disposition === "OPEN");
    if (!attempt?.invocation) {
      await releaseLeasedRunV2(leasedRun);
      return;
    }
    if (observation !== undefined && attempt.executorFinished !== undefined) {
      const proof = await deriveExecutorReleaseProofV2(leasedRun, observation, [
        attemptArtifactRefV2(attempt.attemptId, "work-unit.json"),
        attemptArtifactRefV2(attempt.attemptId, "invocation.json"),
        attemptArtifactRefV2(attempt.attemptId, "invocation-result.json"),
      ]);
      await releaseLeasedRunV2(leasedRun, { proof });
      return;
    }
    if (attempt.stage === "EXECUTOR_DISPATCH_AUTHORIZED" && attempt.executorFinished === undefined) {
      const proof = await derivePreExecutorReleaseProofV2(leasedRun, {
        attemptId: attempt.attemptId,
        invocationId: attempt.invocation!.invocationId,
        artifactRefs: [
          attemptArtifactRefV2(attempt.attemptId, "work-unit.json"),
          attemptArtifactRefV2(attempt.attemptId, "invocation.json"),
        ],
      });
      await releaseLeasedRunV2(leasedRun, { proof });
    }
  } catch {
    // UNKNOWN durability or executor state deliberately remains visible for
    // recovery inspection. This helper only clears leases it can prove owned.
  }
}

function openFindingsForTask(state: RalphRuntimeStateV2, taskId: string): import("../contracts.js").Finding[] {
  return Object.values(state.findings).filter((finding) => finding.taskId === taskId && !["RESOLVED", "SUPERSEDED"].includes(finding.status));
}

function driverStopForAdmission(
  kind: "NO_WORK" | "WAITING" | "BLOCKED" | "HOLD" | "RECONCILIATION_REQUIRED",
  state: RalphRuntimeStateV2,
): FDriverStopReason {
  if (kind === "RECONCILIATION_REQUIRED" || state.hold === "RECONCILIATION_REQUIRED") return "RECONCILIATION_REQUIRED";
  if (kind === "HOLD" && state.hold === "HUMAN_REQUIRED") return "HUMAN_REQUIRED";
  return "BUDGET_EXHAUSTED";
}

async function commitDriverEvent(leasedRun: LeasedRunV2, event: RalphEventV2, clock: () => string, nonceFactory: () => string): Promise<void> {
  await revalidateLeaseOwnershipV2(leasedRun);
  const committed = await commitRalphEventV2({ store: leasedRun.store, state: leasedRun.state, event, writtenAt: clock(), nonce: nonceFactory() });
  if (committed.eventDurability !== "DURABLE") throw new Error("F_EVENT_DURABILITY_UNKNOWN");
  await refreshLeasedRunV2(leasedRun);
}

function coreEvent<TType extends RalphEventTypeV2>(
  state: RalphRuntimeStateV2,
  eventType: TType,
  payload: EventPayloadMapV2[TType],
  context: { readonly phaseId?: string; readonly taskId?: string; readonly attemptId?: string; readonly findingId?: string; readonly workspace?: boolean; readonly eventIdFactory: () => string; readonly clock: () => string },
): RalphEventV2 {
  const kind = V2_EVENT_ENTITY_KINDS[eventType];
  const entity: RuntimeEntityRef = kind === "run" ? { kind, id: state.runId } : kind === "task" ? { kind, id: context.taskId ?? "task" } : kind === "finding" ? { kind, id: context.findingId ?? "finding" } : kind === "workspace" ? { kind, id: `${state.runId}:workspace` } : { kind: "attempt", id: context.attemptId ?? "attempt" };
  return createRalphEventV2({ eventId: context.eventIdFactory(), eventType, schemaVersion: state.eventSchema, runId: state.runId, sequence: state.lastSequence + 1, occurredAt: context.clock(), recordedAt: context.clock(), entity, ...(kind === "attempt" ? { phaseId: context.phaseId, taskId: context.taskId, attemptId: context.attemptId } : kind === "task" ? { phaseId: context.phaseId, taskId: context.taskId } : {}), actor: "CORE", causationId: null, correlationId: `${state.runId}:${context.attemptId ?? eventType}`, payload, previousEventHash: state.lastEventHash } as UnsignedRalphEventV2<TType>) as RalphEventV2;
}
