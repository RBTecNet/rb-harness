import type { Finding, RalphRuntimeState, TaskState } from "../contracts.js";
import { transitionFinding } from "../findings.js";
import { expectedAttemptBaseFingerprint } from "../checkpoints.js";
import {
  deriveV2Phases,
  assertV2RuntimeState,
  canCompleteRuntimeV2,
  deterministicValidationSummary,
  openAttemptsV2,
  taskDependenciesSatisfiedV2,
} from "./state.js";
import type {
  AttemptStateV2,
  AttemptClosureReason,
  DeterministicValidationSummary,
  RalphRuntimeStateV2 as RuntimeStateV2,
  ValidationRunRef,
} from "./contracts.js";
import { assertTaskState } from "../state.js";
import {
  validateRalphEventV2,
  type RalphEventV2,
} from "./events.js";
import { isAttemptClosureAllowed } from "./attempt-closure.js";

type RalphRuntimeStateV2 = RuntimeStateV2;

/**
 * Pure V2 semantic transition authority.
 *
 * This reducer only consumes an already accepted, hash-verified event.  It
 * has no filesystem, clock, environment, provider, process, or logging
 * dependency.  In particular, EXECUTOR_DISPATCH_AUTHORIZED is represented as
 * state; it never invokes anything.
 */
export function reduceRalphEventV2(state: RuntimeStateV2, event: RalphEventV2): RuntimeStateV2 {
  assertV2RuntimeState(state);
  validateRalphEventV2(event);
  if (event.runId !== state.runId) throw new Error("RALPH_V2_REDUCER_FOREIGN_RUN");
  if (event.schemaVersion !== state.eventSchema) throw new Error("RALPH_V2_REDUCER_SCHEMA_MISMATCH");
  if (event.sequence !== state.lastSequence + 1) throw new Error("RALPH_V2_REDUCER_SEQUENCE_MISMATCH");
  if (event.previousEventHash !== state.lastEventHash) throw new Error("RALPH_V2_REDUCER_HASH_CHAIN_MISMATCH");

  let next: RalphRuntimeStateV2 = state;
  switch (event.eventType) {
    case "run.created":
      next = reduceRunCreated(state, event);
      break;
    case "run.started":
      if (state.disposition !== "CREATED" || state.lastSequence < 1 || state.hold !== "NONE") throw new Error("RALPH_V2_INVALID_RUN_START");
      next = { ...state, disposition: "ACTIVE" };
      break;
    case "run.hold-set":
      if (state.disposition !== "ACTIVE" || state.hold !== "NONE") throw new Error("RALPH_V2_INVALID_RUN_HOLD_SET");
      if (event.payload.hold === "BLOCKED" && (runHasEligibleWorkV2(state) || !runHasKnownBlockingConditionV2(state))) throw new Error("RALPH_V2_GLOBAL_BLOCKED_PRECONDITION");
      next = { ...state, hold: event.payload.hold };
      break;
    case "run.hold-cleared":
      if (event.actor !== "CORE" || state.disposition !== "ACTIVE" || state.hold === "NONE" || event.payload.previousHold !== state.hold) {
        throw new Error("RALPH_V2_INVALID_RUN_HOLD_CLEAR");
      }
      next = event.payload.previousHold === "HUMAN_REQUIRED"
        ? reduceHumanHoldCleared(state, event.recordedAt)
        : { ...state, hold: "NONE" };
      break;
    case "run.completed":
      if (!canCompleteRuntimeV2(state, event.payload.finalStatePersisted)) throw new Error("RALPH_V2_RUN_COMPLETION_PRECONDITION");
      next = { ...state, disposition: "COMPLETE", hold: "NONE", finalStatePersisted: true };
      break;
    case "run.failed":
      if (state.disposition === "COMPLETE" || state.disposition === "FAILED") throw new Error("RALPH_V2_RUN_TERMINAL");
      if (openAttemptsV2(state).length > 0) throw new Error("RALPH_V2_RUN_FAILURE_WITH_OPEN_ATTEMPT");
      next = { ...state, disposition: "FAILED", hold: "NONE" };
      break;
    case "task.state-changed":
      next = reduceTaskStateChange(state, event);
      break;
    case "attempt.started":
      next = reduceAttemptStarted(state, event);
      break;
    case "attempt.closed":
      next = reduceAttemptClosed(state, event);
      break;
    case "finding.state-changed":
      if (event.payload.finding.status === "RESOLVED" && event.actor !== "CORE") throw new Error("RALPH_V2_AUDITOR_CANNOT_RESOLVE_FINDING");
      next = reduceFindingChange(state, event.payload.finding);
      break;
    case "workspace.checkpointed":
      next = reduceCheckpoint(state, event);
      break;
    case "workspace.drift-detected":
      if (state.disposition !== "ACTIVE" || state.hold !== "NONE") throw new Error("RALPH_V2_DRIFT_OUTSIDE_CLEAR_RUN");
      next = { ...state, hold: "RECONCILIATION_REQUIRED" };
      break;
    case "executor.dispatch-authorized":
      next = reduceDispatchAuthorized(state, event);
      break;
    case "executor.started":
      next = reduceExecutorStarted(state, event);
      break;
    case "executor.finished":
      next = reduceExecutorFinished(state, event);
      break;
    case "evidence.capture-started":
      next = reduceEvidenceCaptureStarted(state, event);
      break;
    case "evidence.captured":
      next = reduceEvidenceCaptured(state, event);
      break;
    case "validation.started":
      next = reduceValidationStarted(state, event);
      break;
    case "validation.completed":
      next = reduceValidationCompleted(state, event);
      break;
    case "attempt.human-required":
      next = reduceAttemptHumanRequired(state, event);
      break;
    case "attempt.audit-ready":
      next = reduceAttemptAuditReady(state, event);
      break;
    case "attempt.reconciliation-required":
      next = reduceAttemptReconciliationRequired(state, event);
      break;
    case "audit.started":
      next = reduceAuditStarted(state, event);
      break;
  }

  const committed: RalphRuntimeStateV2 = {
    ...next,
    lastSequence: event.sequence,
    lastEventHash: event.eventHash,
  };
  assertV2RuntimeState(committed);
  return committed;
}

export const reduceV2Event = reduceRalphEventV2;

function reduceRunCreated(
  state: RalphRuntimeStateV2,
  event: Extract<RalphEventV2, { eventType: "run.created" }>,
): RalphRuntimeStateV2 {
  if (state.disposition !== "CREATED" || state.lastSequence !== 0 || state.lastEventHash !== null) throw new Error("RALPH_V2_INVALID_RUN_CREATE");
  if (!sameArray(event.payload.phaseIds, state.phaseIds) || !sameArray(event.payload.taskIds, state.taskIds)) throw new Error("RALPH_V2_RUN_CREATE_ENTITY_MISMATCH");
  return state;
}

function reduceTaskStateChange(
  state: RalphRuntimeStateV2,
  event: Extract<RalphEventV2, { eventType: "task.state-changed" }>,
): RalphRuntimeStateV2 {
  const taskId = event.taskId;
  if (!taskId) throw new Error("RALPH_V2_REDUCER_TASK_CONTEXT_MISSING");
  const current = state.tasks[taskId];
  if (!current) throw new Error("RALPH_V2_REDUCER_UNKNOWN_TASK");
  if (state.disposition !== "ACTIVE") throw new Error("RALPH_V2_TASK_CHANGE_RUN_NOT_ACTIVE");
  if (event.phaseId !== undefined && event.phaseId !== current.phaseId) throw new Error("RALPH_V2_TASK_PHASE_RELATION_MISMATCH");
  if (current.disposition === "COMPLETE" || current.disposition === "FAILED") throw new Error("RALPH_V2_TASK_TERMINAL");
  const candidate: TaskState = {
    ...current,
    ...event.payload,
    taskId: current.taskId,
    phaseId: current.phaseId,
    dependsOn: [...current.dependsOn],
    findingIds: [...current.findingIds],
    updatedAt: event.recordedAt,
  };
  assertTaskDispositionTransition(current.disposition, candidate.disposition);
  if (candidate.disposition === "COMPLETE") assertTaskCompletion(state, candidate);
  assertTaskState(candidate);
  assertTaskProjectionAgainstAttempt(state, candidate);
  const tasks = { ...state.tasks, [taskId]: candidate };
  return { ...state, tasks, phases: deriveV2Phases({ phases: state.phases, tasks }) };
}

function assertTaskDispositionTransition(previous: TaskState["disposition"], next: TaskState["disposition"]): void {
  const allowed: Readonly<Record<TaskState["disposition"], readonly TaskState["disposition"][]>> = {
    PENDING: ["PENDING", "READY", "BLOCKED", "PAUSED", "FAILED"],
    READY: ["READY", "COMPLETE", "BLOCKED", "PAUSED", "FAILED"],
    BLOCKED: ["BLOCKED", "READY", "PAUSED", "FAILED"],
    PAUSED: ["PAUSED", "READY", "BLOCKED", "FAILED"],
    COMPLETE: ["COMPLETE"],
    FAILED: ["FAILED"],
  };
  if (!allowed[previous].includes(next)) throw new Error(`RALPH_V2_INVALID_TASK_DISPOSITION_TRANSITION: ${previous}->${next}`);
}

function assertTaskCompletion(state: RalphRuntimeStateV2, candidate: TaskState): void {
  if (!candidate.currentAttemptId || !candidate.evidenceSetId || !candidate.validationSetDigest || !candidate.postExecutorFingerprint || !candidate.acceptedCheckpointFingerprint) {
    throw new Error("RALPH_V2_TASK_COMPLETION_PROOF_MISSING");
  }
  const attempt = state.attempts[candidate.currentAttemptId];
  if (!attempt || attempt.disposition !== "CLOSED" || !attempt.auditPackage || !attempt.evidenceCapture || !attempt.validationSet) throw new Error("RALPH_V2_TASK_COMPLETION_AUDIT_MISSING");
  if (attempt.taskId !== candidate.taskId || attempt.auditPackage.auditPackageId.length === 0) throw new Error("RALPH_V2_TASK_COMPLETION_AUDIT_IDENTITY_MISMATCH");
  if (attempt.validationRuns.some((run) => run.outcome === "FAIL" || run.outcome === "INFRASTRUCTURE_FAILURE")) throw new Error("RALPH_V2_TASK_COMPLETION_VALIDATION_FAILED");
}

function reduceAttemptStarted(
  state: RalphRuntimeStateV2,
  event: Extract<RalphEventV2, { eventType: "attempt.started" }>,
): RalphRuntimeStateV2 {
  const payload = event.payload;
  const task = state.tasks[payload.taskId];
  if (!task) throw new Error("RALPH_V2_ATTEMPT_UNKNOWN_TASK");
  if (state.disposition !== "ACTIVE" || state.hold !== "NONE") throw new Error("RALPH_V2_ATTEMPT_START_RUN_NOT_ADMISSIBLE");
  if (event.attemptId !== payload.attemptId || event.taskId !== payload.taskId || (event.phaseId !== undefined && event.phaseId !== task.phaseId)) throw new Error("RALPH_V2_ATTEMPT_START_IDENTITY_MISMATCH");
  if (task.disposition !== "READY" || task.activity !== "IDLE" || task.owner !== "NONE" || task.hold !== "NONE") throw new Error("RALPH_V2_INVALID_ATTEMPT_START");
  if (state.attempts[payload.attemptId]) throw new Error("RALPH_V2_ATTEMPT_DUPLICATE");
  if (openAttemptsV2(state).length > 0) throw new Error("RALPH_V2_SEQUENTIAL_OPEN_ATTEMPT_VIOLATION");
  if (payload.ordinal !== task.attemptsUsed + 1) throw new Error("RALPH_V2_ATTEMPT_ORDINAL_MISMATCH");
  const expectedBase = expectedAttemptBaseFingerprint(state);
  if (expectedBase !== undefined && expectedBase !== payload.attemptBaseFingerprint) throw new Error("RALPH_V2_ATTEMPT_BASE_FINGERPRINT_MISMATCH");
  const attempt: AttemptStateV2 = {
    attemptId: payload.attemptId,
    phaseId: task.phaseId,
    taskId: payload.taskId,
    ordinal: payload.ordinal,
    strategyGeneration: payload.strategyGeneration,
    attemptBaseFingerprint: payload.attemptBaseFingerprint,
    disposition: "OPEN",
    stage: "ADMITTED",
    startedAt: payload.startedAt,
    validationSpecs: [],
    validationRuns: [],
    recovery: { kind: "NONE" },
  };
  const nextTask = {
    ...projectAttemptTask(task, attempt, event.recordedAt),
    attemptsUsed: task.attemptsUsed + 1,
  } satisfies TaskState;
  const tasks = { ...state.tasks, [task.taskId]: nextTask };
  return {
    ...state,
    tasks,
    attempts: { ...state.attempts, [attempt.attemptId]: attempt },
    phases: deriveV2Phases({ phases: state.phases, tasks }),
  };
}

function reduceAttemptClosed(
  state: RalphRuntimeStateV2,
  event: Extract<RalphEventV2, { eventType: "attempt.closed" }>,
): RalphRuntimeStateV2 {
  const attempt = requireOpenAttempt(state, event.attemptId, event);
  const reason = event.payload.closureReason;
  if (!isAttemptClosureAllowed(attempt.stage, reason)) throw new Error(`RALPH_V2_INVALID_CLOSURE_STATE: ${reason}/${attempt.stage}`);
  const nextAttempt: AttemptStateV2 = {
    ...attempt,
    disposition: "CLOSED",
    finishedAt: event.payload.finishedAt,
    closureReason: reason,
    recovery: { kind: "NONE" },
  };
  const task = state.tasks[attempt.taskId];
  if (!task) throw new Error("RALPH_V2_ATTEMPT_TASK_MISSING");
  const taskHold = closureTaskHold(reason, task.hold);
  const nextTask: TaskState = {
    ...task,
    activity: "IDLE",
    owner: "NONE",
    ...(taskHold === "NONE" ? { hold: task.hold } : { hold: taskHold }),
    updatedAt: event.recordedAt,
  };
  const tasks = { ...state.tasks, [task.taskId]: nextTask };
  return {
    ...state,
    attempts: { ...state.attempts, [attempt.attemptId]: nextAttempt },
    tasks,
    phases: deriveV2Phases({ phases: state.phases, tasks }),
  };
}

function reduceDispatchAuthorized(
  state: RalphRuntimeStateV2,
  event: Extract<RalphEventV2, { eventType: "executor.dispatch-authorized" }>,
): RalphRuntimeStateV2 {
  const attempt = requireOpenAttempt(state, event.attemptId, event);
  assertAttemptContext(event, attempt);
  if (attempt.stage !== "ADMITTED") throw new Error("RALPH_V2_DISPATCH_AUTHORIZATION_STAGE_INVALID");
  if (attempt.invocation) throw new Error("RALPH_V2_INVOCATION_ALREADY_AUTHORIZED");
  if (event.payload.attemptBaseFingerprint !== attempt.attemptBaseFingerprint) throw new Error("RALPH_V2_DISPATCH_BASE_FINGERPRINT_MISMATCH");
  const nextAttempt: AttemptStateV2 = {
    ...attempt,
    stage: "EXECUTOR_DISPATCH_AUTHORIZED",
    invocation: {
      invocationId: event.payload.invocationId,
      workUnitDigest: event.payload.workUnitDigest,
      attemptBaseFingerprint: event.payload.attemptBaseFingerprint,
      timeoutPolicyDigest: event.payload.timeoutPolicyDigest,
      capabilityPolicyDigest: event.payload.capabilityPolicyDigest,
      authorizedAt: event.payload.authorizedAt,
    },
  };
  return replaceOpenAttempt(state, nextAttempt, event.recordedAt);
}

function reduceExecutorStarted(
  state: RalphRuntimeStateV2,
  event: Extract<RalphEventV2, { eventType: "executor.started" }>,
): RalphRuntimeStateV2 {
  const attempt = requireOpenAttempt(state, event.attemptId, event);
  assertAttemptContext(event, attempt);
  if (attempt.stage !== "EXECUTOR_DISPATCH_AUTHORIZED" || !attempt.invocation) throw new Error("RALPH_V2_EXECUTOR_STARTED_BEFORE_AUTHORIZATION");
  if (event.payload.invocationId !== attempt.invocation.invocationId) throw new Error("RALPH_V2_INVOCATION_ID_MISMATCH");
  return replaceOpenAttempt(state, { ...attempt, stage: "EXECUTOR_RUNNING" }, event.recordedAt);
}

function reduceExecutorFinished(
  state: RalphRuntimeStateV2,
  event: Extract<RalphEventV2, { eventType: "executor.finished" }>,
): RalphRuntimeStateV2 {
  const attempt = requireOpenAttempt(state, event.attemptId, event);
  assertAttemptContext(event, attempt);
  if (attempt.stage !== "EXECUTOR_RUNNING" || !attempt.invocation) throw new Error("RALPH_V2_EXECUTOR_FINISHED_BEFORE_STARTED");
  if (event.payload.invocationId !== attempt.invocation.invocationId) throw new Error("RALPH_V2_INVOCATION_ID_MISMATCH");
  const nextAttempt: AttemptStateV2 = {
    ...attempt,
    stage: "POST_EXECUTOR_CAPTURE",
    executorFinished: {
      invocationId: event.payload.invocationId,
      status: event.payload.status,
      termination: event.payload.termination,
      finishedAt: event.payload.finishedAt,
    },
  };
  return replaceOpenAttempt(state, nextAttempt, event.recordedAt);
}

function reduceEvidenceCaptureStarted(
  state: RalphRuntimeStateV2,
  event: Extract<RalphEventV2, { eventType: "evidence.capture-started" }>,
): RalphRuntimeStateV2 {
  const attempt = requireOpenAttempt(state, event.attemptId, event);
  assertAttemptContext(event, attempt);
  if (attempt.stage !== "POST_EXECUTOR_CAPTURE" || !attempt.executorFinished) throw new Error("RALPH_V2_CAPTURE_STARTED_STAGE_INVALID");
  if (attempt.evidenceCaptureInProgress || attempt.evidenceCapture) throw new Error("RALPH_V2_CAPTURE_ALREADY_STARTED");
  const nextAttempt: AttemptStateV2 = {
    ...attempt,
    stage: "EVIDENCE_CAPTURING",
    postExecutorFingerprint: event.payload.postExecutorFingerprint,
    evidenceCaptureInProgress: {
      evidenceCaptureId: event.payload.evidenceCaptureId,
      postExecutorFingerprint: event.payload.postExecutorFingerprint,
      startedAt: event.payload.startedAt,
    },
  };
  return replaceOpenAttempt(state, nextAttempt, event.recordedAt);
}

function reduceEvidenceCaptured(
  state: RalphRuntimeStateV2,
  event: Extract<RalphEventV2, { eventType: "evidence.captured" }>,
): RalphRuntimeStateV2 {
  const attempt = requireOpenAttempt(state, event.attemptId, event);
  assertAttemptContext(event, attempt);
  const progress = attempt.evidenceCaptureInProgress;
  if (attempt.stage !== "EVIDENCE_CAPTURING" || !progress) throw new Error("RALPH_V2_CAPTURE_COMPLETED_BEFORE_START");
  if (progress.evidenceCaptureId !== event.payload.evidenceCaptureId || progress.postExecutorFingerprint !== event.payload.postExecutorFingerprint) throw new Error("RALPH_V2_CAPTURE_IDENTITY_MISMATCH");
  const nextAttempt: AttemptStateV2 = {
    ...attempt,
    evidenceCapture: {
      evidenceCaptureId: event.payload.evidenceCaptureId,
      evidenceDigest: event.payload.evidenceDigest,
      postExecutorFingerprint: event.payload.postExecutorFingerprint,
    },
    postExecutorFingerprint: event.payload.postExecutorFingerprint,
  };
  delete (nextAttempt as { evidenceCaptureInProgress?: unknown }).evidenceCaptureInProgress;
  // The last observable stage remains EVIDENCE_CAPTURING until the explicit
  // validation.started fact.  No implicit lifecycle fact is invented here.
  return replaceOpenAttempt(state, nextAttempt, event.recordedAt);
}

function reduceValidationStarted(
  state: RalphRuntimeStateV2,
  event: Extract<RalphEventV2, { eventType: "validation.started" }>,
): RalphRuntimeStateV2 {
  const attempt = requireOpenAttempt(state, event.attemptId, event);
  assertAttemptContext(event, attempt);
  if ((attempt.stage !== "EVIDENCE_CAPTURING" && attempt.stage !== "VALIDATING") || !attempt.evidenceCapture) throw new Error("RALPH_V2_VALIDATION_STARTED_STAGE_INVALID");
  const spec = event.payload.validationSpec;
  if (spec.sourceTaskId !== attempt.taskId) throw new Error("RALPH_V2_VALIDATION_SPEC_TASK_MISMATCH");
  const existingSpec = attempt.validationSpecs.find((entry) => entry.validationSpecId === spec.validationSpecId);
  if (existingSpec && existingSpec.digest !== spec.digest) throw new Error("RALPH_V2_VALIDATION_SPEC_MUTATION");
  const validationSpecs = existingSpec ? attempt.validationSpecs : [...attempt.validationSpecs, spec];
  if (attempt.validationRuns.some((run) => run.validationRunId === event.payload.validationRunId)) throw new Error("RALPH_V2_VALIDATION_RUN_DUPLICATE");
  const previousOrdinals = attempt.validationRuns.filter((run) => run.validationSpecId === spec.validationSpecId).map((run) => run.validationRunOrdinal);
  const expectedOrdinal = previousOrdinals.length === 0 ? 1 : Math.max(...previousOrdinals) + 1;
  if (event.payload.validationRunOrdinal !== expectedOrdinal) throw new Error("RALPH_V2_VALIDATION_RETRY_ORDINAL_MISMATCH");
  const validationRun: ValidationRunRef = {
    validationRunId: event.payload.validationRunId,
    validationSpecId: spec.validationSpecId,
    validationSpecDigest: spec.digest,
    validationRunOrdinal: event.payload.validationRunOrdinal,
    startedAt: event.payload.startedAt,
    outcome: "PENDING",
  };
  const nextAttempt: AttemptStateV2 = {
    ...attempt,
    stage: "VALIDATING",
    validationSpecs,
    validationRuns: [...attempt.validationRuns, validationRun],
  };
  return replaceOpenAttempt(state, nextAttempt, event.recordedAt);
}

function reduceValidationCompleted(
  state: RalphRuntimeStateV2,
  event: Extract<RalphEventV2, { eventType: "validation.completed" }>,
): RalphRuntimeStateV2 {
  const attempt = requireOpenAttempt(state, event.attemptId, event);
  assertAttemptContext(event, attempt);
  if (attempt.stage !== "VALIDATING") throw new Error("RALPH_V2_VALIDATION_COMPLETED_STAGE_INVALID");
  const completed = event.payload.validationRun;
  const index = attempt.validationRuns.findIndex((run) => run.validationRunId === completed.validationRunId);
  const previous = attempt.validationRuns[index];
  if (index < 0 || !previous || previous.outcome !== "PENDING") throw new Error("RALPH_V2_VALIDATION_RUN_NOT_PENDING");
  if (previous.validationSpecId !== completed.validationSpecId || previous.validationSpecDigest !== completed.validationSpecDigest || previous.validationRunOrdinal !== completed.validationRunOrdinal || previous.startedAt !== completed.startedAt) throw new Error("RALPH_V2_VALIDATION_RUN_IDENTITY_MISMATCH");
  const validationRuns = [...attempt.validationRuns];
  validationRuns[index] = completed;
  return replaceOpenAttempt(state, { ...attempt, validationRuns }, event.recordedAt);
}

function reduceAttemptHumanRequired(
  state: RalphRuntimeStateV2,
  event: Extract<RalphEventV2, { eventType: "attempt.human-required" }>,
): RalphRuntimeStateV2 {
  const attempt = requireOpenAttempt(state, event.attemptId, event);
  assertAttemptContext(event, attempt);
  if (state.hold !== "NONE") throw new Error("RALPH_V2_ATTEMPT_HUMAN_HOLD_CONFLICT");
  if (attempt.stage === "AUDITING" || attempt.stage === "AWAITING_AUDIT") throw new Error("RALPH_V2_HUMAN_REQUIREMENT_STAGE_INVALID");
  const nextAttempt: AttemptStateV2 = {
    ...attempt,
    stage: "AWAITING_HUMAN",
    recovery: { kind: "HUMAN_REQUIRED", reason: event.payload.reason, proofRef: event.payload.proofRef },
  };
  const withAttempt = replaceOpenAttempt(state, nextAttempt, event.recordedAt);
  return { ...withAttempt, hold: "HUMAN_REQUIRED" };
}

function reduceHumanHoldCleared(
  state: RalphRuntimeStateV2,
  recordedAt: string,
): RalphRuntimeStateV2 {
  const openAttempts = openAttemptsV2(state);
  if (openAttempts.length > 1) throw new Error("RALPH_V2_SEQUENTIAL_OPEN_ATTEMPT_VIOLATION");

  // HUMAN_REQUIRED is also a valid global RunHold.  Only an open Attempt that
  // explicitly claims the human boundary is eligible for the Attempt-bound
  // resume; all other valid states retain the historical Run-only clear.
  const humanAttempt = openAttempts[0];
  if (!humanAttempt) return { ...state, hold: "NONE" };
  if (humanAttempt.stage !== "AWAITING_HUMAN") return { ...state, hold: "NONE" };
  if (humanAttempt.recovery.kind !== "HUMAN_REQUIRED") {
    throw new Error("RALPH_V2_HUMAN_RESUME_ATTEMPT_INVALID");
  }

  const task = state.tasks[humanAttempt.taskId];
  if (!task
    || task.currentAttemptId !== humanAttempt.attemptId
    || task.disposition !== "READY"
    || task.activity !== "IDLE"
    || task.owner !== "NONE"
    || task.hold !== "HUMAN_REQUIRED") {
    throw new Error("RALPH_V2_HUMAN_RESUME_TASK_INVALID");
  }

  // The clear is one durable ledger fact.  Reuse the normal VALIDATING
  // projection without copying its proof into unlabelled NONE recovery state.
  const resumedAttempt: AttemptStateV2 = {
    ...humanAttempt,
    stage: "VALIDATING",
    recovery: { kind: "NONE" },
  };
  const withAttempt = replaceOpenAttempt(state, resumedAttempt, recordedAt);
  return { ...withAttempt, hold: "NONE" };
}

function reduceAttemptAuditReady(
  state: RalphRuntimeStateV2,
  event: Extract<RalphEventV2, { eventType: "attempt.audit-ready" }>,
): RalphRuntimeStateV2 {
  const attempt = requireOpenAttempt(state, event.attemptId, event);
  assertAttemptContext(event, attempt);
  if (state.hold !== "NONE") throw new Error("RALPH_V2_AUDIT_READY_WITH_RUN_HOLD");
  if (attempt.stage !== "VALIDATING" && attempt.stage !== "EVIDENCE_CAPTURING") throw new Error("RALPH_V2_AUDIT_READY_STAGE_INVALID");
  if (!attempt.evidenceCapture) throw new Error("RALPH_V2_AUDIT_READY_EVIDENCE_MISSING");
  if (attempt.validationRuns.some((run) => run.outcome === "PENDING")) throw new Error("RALPH_V2_AUDIT_READY_VALIDATION_PENDING");
  const payload = event.payload;
  if (attempt.evidenceCapture.evidenceCaptureId !== payload.evidenceCaptureId
    || attempt.evidenceCapture.evidenceDigest !== payload.evidenceDigest
    || attempt.evidenceCapture.postExecutorFingerprint !== payload.postExecutorFingerprint) throw new Error("RALPH_V2_AUDIT_READY_EVIDENCE_MISMATCH");
  const expectedSummary = deterministicValidationSummary(attempt.validationSpecs, attempt.validationRuns);
  if (!sameValidationSummary(expectedSummary, payload.validationSummary)) throw new Error("RALPH_V2_AUDIT_READY_VALIDATION_SUMMARY_MISMATCH");
  const nextAttempt: AttemptStateV2 = {
    ...attempt,
    stage: "AWAITING_AUDIT",
    evidenceCapture: { ...attempt.evidenceCapture },
    validationSet: { validationSetId: payload.validationSetId, validationSetDigest: payload.validationSetDigest },
    auditPackage: { auditPackageId: payload.auditPackageId, auditPackageDigest: payload.auditPackageDigest },
    postExecutorFingerprint: payload.postExecutorFingerprint,
    criterionSetDigest: payload.criterionSetDigest,
    auditability: payload.auditability,
    validationSummary: payload.validationSummary,
    recovery: { kind: "NONE" },
  };
  const withAttempt = replaceOpenAttempt(state, nextAttempt, event.recordedAt);
  // This is the normative pre-Auditor boundary: no AUDITOR owner/activity.
  return withExactAwaitingAuditTask(withAttempt, nextAttempt, event.recordedAt);
}

function reduceAttemptReconciliationRequired(
  state: RalphRuntimeStateV2,
  event: Extract<RalphEventV2, { eventType: "attempt.reconciliation-required" }>,
): RalphRuntimeStateV2 {
  const attempt = requireOpenAttempt(state, event.attemptId, event);
  assertAttemptContext(event, attempt);
  if (state.hold !== "NONE") throw new Error("RALPH_V2_ATTEMPT_RECONCILIATION_HOLD_CONFLICT");
  const nextAttempt: AttemptStateV2 = {
    ...attempt,
    stage: "RECONCILING",
    recovery: { kind: "RECONCILIATION_REQUIRED", reason: event.payload.reason, proofRef: event.payload.proofRef },
  };
  const withAttempt = replaceOpenAttempt(state, nextAttempt, event.recordedAt);
  return { ...withAttempt, hold: "RECONCILIATION_REQUIRED" };
}

function reduceAuditStarted(
  state: RalphRuntimeStateV2,
  event: Extract<RalphEventV2, { eventType: "audit.started" }>,
): RalphRuntimeStateV2 {
  const attempt = requireOpenAttempt(state, event.attemptId, event);
  assertAttemptContext(event, attempt);
  if (state.hold !== "NONE") throw new Error("RALPH_V2_AUDIT_STARTED_WITH_RUN_HOLD");
  if (attempt.stage !== "AWAITING_AUDIT" || !attempt.auditPackage) throw new Error("RALPH_V2_AUDIT_STARTED_BEFORE_AUDIT_READY");
  if (attempt.auditPackage.auditPackageId !== event.payload.auditPackageId || attempt.auditPackage.auditPackageDigest !== event.payload.auditPackageDigest) throw new Error("RALPH_V2_AUDIT_PACKAGE_MISMATCH");
  const nextAttempt: AttemptStateV2 = { ...attempt, stage: "AUDITING" };
  return replaceOpenAttempt(state, nextAttempt, event.recordedAt);
}

function reduceFindingChange(state: RalphRuntimeStateV2, finding: Finding): RalphRuntimeStateV2 {
  if (state.disposition !== "ACTIVE") throw new Error("RALPH_V2_FINDING_CHANGE_RUN_NOT_ACTIVE");
  if (!state.phases[finding.phaseId] || !state.tasks[finding.taskId] || state.tasks[finding.taskId]?.phaseId !== finding.phaseId) throw new Error("RALPH_V2_FINDING_ENTITY_MISMATCH");
  const previous = state.findings[finding.id];
  const nextFinding = previous ? transitionFinding(previous, finding) : finding.status === "OPEN" ? finding : (() => { throw new Error("RALPH_V2_FINDING_MUST_OPEN_FIRST"); })();
  const task = state.tasks[finding.taskId];
  if (!task) throw new Error("RALPH_V2_FINDING_ENTITY_MISMATCH");
  return {
    ...state,
    findings: { ...state.findings, [finding.id]: nextFinding },
    tasks: { ...state.tasks, [task.taskId]: { ...task, findingIds: task.findingIds.includes(finding.id) ? task.findingIds : [...task.findingIds, finding.id] } },
  };
}

function reduceCheckpoint(
  state: RalphRuntimeStateV2,
  event: Extract<RalphEventV2, { eventType: "workspace.checkpointed" }>,
): RalphRuntimeStateV2 {
  const checkpoint = event.payload.checkpoint;
  if (state.disposition !== "ACTIVE") throw new Error("RALPH_V2_CHECKPOINT_RUN_NOT_ACTIVE");
  if (checkpoint.attemptId !== undefined && !state.attempts[checkpoint.attemptId]) throw new Error("RALPH_V2_CHECKPOINT_ATTEMPT_UNKNOWN");
  return { ...state, checkpoints: { ...state.checkpoints, [checkpoint.kind]: checkpoint } };
}

function requireOpenAttempt(
  state: RalphRuntimeStateV2,
  attemptId: string | undefined,
  event: { readonly attemptId?: string },
): AttemptStateV2 {
  if (!attemptId || event.attemptId !== attemptId) throw new Error("RALPH_V2_ATTEMPT_CONTEXT_MISSING");
  const attempt = state.attempts[attemptId];
  if (!attempt || attempt.disposition !== "OPEN") throw new Error("RALPH_V2_ATTEMPT_NOT_OPEN");
  return attempt;
}

function assertAttemptContext(event: { readonly attemptId?: string; readonly taskId?: string; readonly phaseId?: string }, attempt: AttemptStateV2): void {
  if (event.attemptId !== attempt.attemptId || (event.taskId !== undefined && event.taskId !== attempt.taskId) || (event.phaseId !== undefined && event.phaseId !== attempt.phaseId)) throw new Error("RALPH_V2_ATTEMPT_RELATION_MISMATCH");
}

function replaceOpenAttempt(state: RalphRuntimeStateV2, attempt: AttemptStateV2, recordedAt: string): RalphRuntimeStateV2 {
  if (attempt.disposition !== "OPEN") throw new Error("RALPH_V2_INTERNAL_CLOSED_OPEN_REPLACEMENT");
  const task = state.tasks[attempt.taskId];
  if (!task) throw new Error("RALPH_V2_ATTEMPT_TASK_MISSING");
  const nextTask = projectAttemptTask(task, attempt, recordedAt);
  const tasks = { ...state.tasks, [task.taskId]: nextTask };
  return { ...state, attempts: { ...state.attempts, [attempt.attemptId]: attempt }, tasks, phases: deriveV2Phases({ phases: state.phases, tasks }) };
}

function projectAttemptTask(task: TaskState, attempt: AttemptStateV2, updatedAt: string): TaskState {
  const common = { ...task, currentAttemptId: attempt.attemptId, updatedAt };
  switch (attempt.stage) {
    case "ADMITTED":
    case "EXECUTOR_DISPATCH_AUTHORIZED":
    case "EXECUTOR_RUNNING":
      return { ...common, disposition: "READY", activity: "EXECUTING", owner: "EXECUTOR", hold: "NONE" };
    case "POST_EXECUTOR_CAPTURE":
    case "EVIDENCE_CAPTURING":
      return { ...common, disposition: "READY", activity: "CAPTURING_EVIDENCE", owner: "CORE", hold: "NONE" };
    case "VALIDATING":
      return { ...common, disposition: "READY", activity: "VALIDATING", owner: "CORE", hold: "NONE" };
    case "AWAITING_HUMAN":
      return { ...common, disposition: "READY", activity: "IDLE", owner: "NONE", hold: "HUMAN_REQUIRED" };
    case "AWAITING_AUDIT":
      return { ...common, disposition: "READY", activity: "IDLE", owner: "NONE", hold: "NONE" };
    case "AUDITING":
      return { ...common, disposition: "READY", activity: "AUDITING", owner: "AUDITOR", hold: "NONE" };
    case "RECONCILING":
      return { ...common, disposition: "READY", activity: "RECONCILING", owner: "CORE", hold: "WORKSPACE_DRIFT" };
  }
}

function withExactAwaitingAuditTask(state: RalphRuntimeStateV2, attempt: AttemptStateV2, updatedAt: string): RalphRuntimeStateV2 {
  const task = state.tasks[attempt.taskId];
  if (!task) throw new Error("RALPH_V2_ATTEMPT_TASK_MISSING");
  const nextTask: TaskState = { ...task, disposition: "READY", activity: "IDLE", owner: "NONE", hold: "NONE", currentAttemptId: attempt.attemptId, updatedAt };
  const tasks = { ...state.tasks, [task.taskId]: nextTask };
  return { ...state, tasks, phases: deriveV2Phases({ phases: state.phases, tasks }) };
}

function assertTaskProjectionAgainstAttempt(state: RalphRuntimeStateV2, task: TaskState): void {
  if (task.currentAttemptId === undefined) {
    if (task.activity === "AUDITING" || task.owner === "AUDITOR") throw new Error("RALPH_V2_AUDITOR_ASSIGNED_WITHOUT_AUDIT");
    return;
  }
  const attempt = state.attempts[task.currentAttemptId];
  if (!attempt) throw new Error("RALPH_V2_TASK_CURRENT_ATTEMPT_UNKNOWN");
  if (attempt.disposition === "CLOSED") {
    if (task.activity !== "IDLE" || task.owner !== "NONE") throw new Error("RALPH_V2_CLOSED_ATTEMPT_TASK_ACTIVE");
    return;
  }
  const projected = projectAttemptTask(task, attempt, task.updatedAt);
  if (task.disposition !== projected.disposition || task.activity !== projected.activity || task.owner !== projected.owner || task.hold !== projected.hold) {
    throw new Error("RALPH_V2_TASK_ATTEMPT_PROJECTION_MISMATCH");
  }
}

function closureTaskHold(reason: AttemptClosureReason, existing: TaskState["hold"]): TaskState["hold"] {
  if (existing !== "NONE") return existing;
  switch (reason) {
    case "EXECUTOR_UNAVAILABLE": return "PROVIDER_UNAVAILABLE";
    case "VALIDATION_INFRASTRUCTURE_EXHAUSTED": return "RETRY_BUDGET_EXHAUSTED";
    case "CONTROL_PLANE_VIOLATION":
    case "RECONCILIATION_REQUIRED": return "WORKSPACE_DRIFT";
    case "CANCELLED_AT_BOUNDARY": return "CANCELLED_AT_BOUNDARY";
    default: return "NONE";
  }
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameValidationSummary(left: DeterministicValidationSummary, right: DeterministicValidationSummary): boolean {
  return left.total === right.total
    && left.completed === right.completed
    && left.passed === right.passed
    && left.failed === right.failed
    && left.notApplicable === right.notApplicable
    && left.infrastructureFailures === right.infrastructureFailures
    && left.manualRequired === right.manualRequired
    && left.humanRequired === right.humanRequired
    && left.hardNegative === right.hardNegative;
}

function runHasEligibleWorkV2(state: RalphRuntimeStateV2): boolean {
  return Object.values(state.tasks).some((task) =>
    task.activity !== "IDLE"
    || (task.disposition === "READY"
      && task.activity === "IDLE"
      && task.owner === "NONE"
      && task.hold === "NONE"
      && taskDependenciesSatisfiedV2(task, state.tasks)));
}

function runHasKnownBlockingConditionV2(state: RalphRuntimeStateV2): boolean {
  return Object.values(state.tasks).some((task) => task.disposition === "BLOCKED" || task.hold !== "NONE");
}

// The V1 structural type is intentionally referenced only for the reused
// Task dimension; this keeps declarations explicit without changing V1 code.
export type V1StateShapeReference = RalphRuntimeState;
