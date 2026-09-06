import type {
  BudgetUsage,
  CheckpointRecord,
  EvidenceRef,
  Finding,
  PhaseState,
  TaskState,
} from "../contracts.js";
import { assertTaskState, deriveAllPhases } from "../state.js";
import { isSha256Digest } from "../hashing.js";
import {
  ATTEMPT_CLOSURE_REASONS,
  ATTEMPT_DISPOSITIONS,
  ATTEMPT_RECOVERY_KINDS,
  ATTEMPT_STAGES,
  AUDITABILITY_CLASSIFICATIONS,
  EVENT_SCHEMA_V2,
  EXECUTOR_STATUSES,
  EXECUTOR_TERMINATIONS,
  FINDING_STATUSES,
  PHASE_ACTIVITIES,
  PHASE_DISPOSITIONS,
  OPERATIONAL_CONTRACT_V2,
  RUN_DISPOSITIONS,
  RUN_HOLDS,
  STATE_SCHEMA_V2,
  TASK_ACTIVITIES,
  TASK_DISPOSITIONS,
  TASK_HOLDS,
  TASK_OWNERS,
  VALIDATION_KINDS,
  VALIDATION_OUTCOMES,
  type AttemptStateV2,
  type DeterministicValidationSummary,
  type RalphRuntimeStateV2,
  type ValidationRunRef,
  type ValidationSpecRef,
} from "./contracts.js";
import { isAttemptClosureAllowed } from "./attempt-closure.js";

export interface InitialPhaseV2 {
  readonly phaseId: string;
  readonly taskIds: readonly string[];
}

export type InitialTaskV2 = Pick<TaskState, "taskId" | "phaseId" | "dependsOn">;

export function createInitialRuntimeStateV2(input: {
  readonly runId: string;
  readonly phases: readonly InitialPhaseV2[];
  readonly tasks: readonly InitialTaskV2[];
}): RalphRuntimeStateV2 {
  assertNonEmptyString(input.runId, "RALPH_V2_INVALID_RUN_ID");
  const phaseIds = input.phases.map((phase) => phase.phaseId);
  const taskIds = input.tasks.map((task) => task.taskId);
  assertUniqueIds(phaseIds, "RALPH_V2_DUPLICATE_PHASE_ID");
  assertUniqueIds(taskIds, "RALPH_V2_DUPLICATE_TASK_ID");

  const phaseIdSet = new Set(phaseIds);
  const taskIdSet = new Set(taskIds);
  for (const phase of input.phases) {
    assertNonEmptyString(phase.phaseId, "RALPH_V2_INVALID_PHASE_ID");
    assertStringArray(phase.taskIds, "RALPH_V2_INVALID_PHASE_TASKS");
    assertUniqueIds(phase.taskIds, "RALPH_V2_DUPLICATE_PHASE_TASK_ID");
    for (const taskId of phase.taskIds) {
      if (!taskIdSet.has(taskId)) throw new Error("RALPH_V2_PHASE_REFERENCES_UNKNOWN_TASK");
    }
  }
  const referencedTaskIds = input.phases.flatMap((phase) => phase.taskIds);
  if (referencedTaskIds.length !== taskIds.length || new Set(referencedTaskIds).size !== taskIds.length) {
    throw new Error("RALPH_V2_TASK_PHASE_MEMBERSHIP_MISMATCH");
  }

  const tasks: Record<string, TaskState> = Object.fromEntries(input.tasks.map((task) => {
    assertNonEmptyString(task.taskId, "RALPH_V2_INVALID_TASK_ID");
    assertNonEmptyString(task.phaseId, "RALPH_V2_INVALID_PHASE_ID");
    if (!phaseIdSet.has(task.phaseId)) throw new Error("RALPH_V2_TASK_REFERENCES_UNKNOWN_PHASE");
    assertStringArray(task.dependsOn, "RALPH_V2_INVALID_TASK_DEPENDENCIES");
    return [task.taskId, {
      taskId: task.taskId,
      phaseId: task.phaseId,
      dependsOn: [...task.dependsOn],
      disposition: "PENDING" as const,
      activity: "IDLE" as const,
      owner: "NONE" as const,
      hold: "NONE" as const,
      attemptsUsed: 0,
      findingIds: [],
      updatedAt: "",
    } satisfies TaskState];
  }));
  const phases: Record<string, PhaseState> = Object.fromEntries(input.phases.map((phase) => [phase.phaseId, {
    phaseId: phase.phaseId,
    taskIds: [...phase.taskIds],
    disposition: "PENDING" as const,
    activity: "IDLE" as const,
  }]));

  const state: RalphRuntimeStateV2 = {
    format: STATE_SCHEMA_V2,
    runId: input.runId,
    eventSchema: EVENT_SCHEMA_V2,
    stateSchema: STATE_SCHEMA_V2,
    operationalContract: OPERATIONAL_CONTRACT_V2,
    disposition: "CREATED",
    hold: "NONE",
    phaseIds,
    taskIds,
    phases,
    tasks,
    attempts: {},
    findings: {},
    checkpoints: {},
    lastSequence: 0,
    lastEventHash: null,
    finalStatePersisted: false,
  };
  assertV2RuntimeState(state);
  return state;
}

export function taskDependenciesSatisfiedV2(
  task: Pick<TaskState, "dependsOn">,
  tasks: Readonly<Record<string, TaskState>>,
): boolean {
  return task.dependsOn.every((dependencyId) => tasks[dependencyId]?.disposition === "COMPLETE");
}

export function openAttemptsV2(state: Pick<RalphRuntimeStateV2, "attempts">): readonly AttemptStateV2[] {
  return Object.values(state.attempts).filter((attempt) => attempt.disposition === "OPEN");
}

export function hasOpenAttemptV2(state: Pick<RalphRuntimeStateV2, "attempts">): boolean {
  return openAttemptsV2(state).length > 0;
}

export function deriveV2Phases(state: Pick<RalphRuntimeStateV2, "phases" | "tasks">): Readonly<Record<string, PhaseState>> {
  return deriveAllPhases({ phases: state.phases, tasks: state.tasks });
}

export function deterministicValidationSummary(
  specs: readonly ValidationSpecRef[],
  runs: readonly ValidationRunRef[],
): DeterministicValidationSummary {
  let passed = 0;
  let failed = 0;
  let notApplicable = 0;
  let infrastructureFailures = 0;
  for (const run of runs) {
    if (run.outcome === "PASS") passed += 1;
    else if (run.outcome === "FAIL") failed += 1;
    else if (run.outcome === "NOT_APPLICABLE") notApplicable += 1;
    else if (run.outcome === "INFRASTRUCTURE_FAILURE") infrastructureFailures += 1;
  }
  const completed = passed + failed + notApplicable + infrastructureFailures;
  const manualRequired = specs.filter((spec) => spec.kind === "MANUAL").length;
  const humanRequired = specs.filter((spec) => spec.kind === "HUMAN").length;
  return {
    total: Math.max(specs.length, runs.length),
    completed,
    passed,
    failed,
    notApplicable,
    infrastructureFailures,
    manualRequired,
    humanRequired,
    hardNegative: failed > 0,
  };
}

export function canCompleteRuntimeV2(state: RalphRuntimeStateV2, finalStatePersisted = false): boolean {
  return state.disposition === "ACTIVE"
    && state.hold === "NONE"
    && state.phaseIds.every((phaseId) => state.phases[phaseId]?.disposition === "COMPLETE")
    && openAttemptsV2(state).length === 0
    && Object.values(state.tasks).every((task) => task.hold === "NONE" && task.disposition !== "FAILED" && task.disposition !== "BLOCKED")
    && !Object.values(state.findings).some((finding) => finding.severity === "BLOCKER" && !["RESOLVED", "SUPERSEDED"].includes(finding.status))
    && (finalStatePersisted || state.finalStatePersisted);
}

export function assertV2RuntimeState(value: unknown): asserts value is RalphRuntimeStateV2 {
  if (!isRecord(value)) throw new Error("RALPH_V2_STATE_MALFORMED");
  assertExactKeys(value, [
    "format", "runId", "eventSchema", "stateSchema", "operationalContract", "disposition", "hold",
    "phaseIds", "taskIds", "phases", "tasks", "attempts", "findings", "checkpoints", "lastSequence",
    "lastEventHash", "finalStatePersisted",
  ], "RALPH_V2_STATE_UNKNOWN_FIELD");
  if (value.format !== STATE_SCHEMA_V2 || value.stateSchema !== STATE_SCHEMA_V2) throw new Error("RALPH_V2_STATE_UNSUPPORTED_SCHEMA");
  if (value.eventSchema !== EVENT_SCHEMA_V2) throw new Error("RALPH_V2_STATE_EVENT_SCHEMA_MISMATCH");
  if (value.operationalContract !== OPERATIONAL_CONTRACT_V2) throw new Error("RALPH_V2_STATE_OPERATIONAL_CONTRACT_MISMATCH");
  assertNonEmptyString(value.runId, "RALPH_V2_STATE_INVALID_RUN_ID");
  assertEnum(value.disposition, RUN_DISPOSITIONS, "RALPH_V2_STATE_INVALID_RUN_DISPOSITION");
  assertEnum(value.hold, RUN_HOLDS, "RALPH_V2_STATE_INVALID_RUN_HOLD");
  if ((value.disposition === "CREATED" || value.disposition === "COMPLETE" || value.disposition === "FAILED") && value.hold !== "NONE") {
    throw new Error("RALPH_V2_INVALID_RUN_COMBINATION");
  }
  assertStringArray(value.phaseIds, "RALPH_V2_STATE_INVALID_PHASE_IDS");
  assertStringArray(value.taskIds, "RALPH_V2_STATE_INVALID_TASK_IDS");
  assertUniqueIds(value.phaseIds, "RALPH_V2_STATE_DUPLICATE_PHASE_ID");
  assertUniqueIds(value.taskIds, "RALPH_V2_STATE_DUPLICATE_TASK_ID");
  assertRecord(value.phases, "RALPH_V2_STATE_INVALID_PHASE_MAP");
  assertRecord(value.tasks, "RALPH_V2_STATE_INVALID_TASK_MAP");
  assertRecord(value.attempts, "RALPH_V2_STATE_INVALID_ATTEMPT_MAP");
  assertRecord(value.findings, "RALPH_V2_STATE_INVALID_FINDING_MAP");
  assertRecord(value.checkpoints, "RALPH_V2_STATE_INVALID_CHECKPOINT_MAP");
  if (!sameKeySet(Object.keys(value.phases), value.phaseIds) || !sameKeySet(Object.keys(value.tasks), value.taskIds)) {
    throw new Error("RALPH_V2_STATE_IDENTITY_MAP_MISMATCH");
  }
  if (!Number.isSafeInteger(value.lastSequence) || value.lastSequence < 0) throw new Error("RALPH_V2_STATE_INVALID_SEQUENCE");
  if (value.lastSequence === 0 && value.lastEventHash !== null) throw new Error("RALPH_V2_STATE_INVALID_EVENT_HASH");
  if (value.lastSequence > 0 && !isSha256Digest(value.lastEventHash)) throw new Error("RALPH_V2_STATE_INVALID_EVENT_HASH");
  if (typeof value.finalStatePersisted !== "boolean") throw new Error("RALPH_V2_STATE_INVALID_FINAL_STATE");

  for (const phaseId of value.phaseIds) assertPhaseState(value.phases[phaseId], phaseId, value.taskIds);
  const phaseTaskMembership = new Set<string>();
  for (const phase of Object.values(value.phases)) {
    for (const taskId of phase.taskIds) {
      if (phaseTaskMembership.has(taskId)) throw new Error("RALPH_V2_STATE_TASK_IN_MULTIPLE_PHASES");
      phaseTaskMembership.add(taskId);
    }
  }
  if (phaseTaskMembership.size !== value.taskIds.length) throw new Error("RALPH_V2_STATE_TASK_PHASE_MEMBERSHIP_MISMATCH");

  for (const taskId of value.taskIds) assertTaskStateV2(value.tasks[taskId], taskId, value.phases);
  const attempts = Object.values(value.attempts);
  const openAttempts = attempts.filter((attempt) => attempt.disposition === "OPEN");
  if (openAttempts.length > 1) throw new Error("RALPH_V2_SEQUENTIAL_OPEN_ATTEMPT_VIOLATION");
  for (const [attemptId, attempt] of Object.entries(value.attempts)) assertAttemptStateV2(attempt, attemptId, value.tasks, value.phases);

  for (const [findingId, finding] of Object.entries(value.findings)) assertFindingStateV2(finding, findingId, value.tasks, value.phases);
  for (const [checkpointId, checkpoint] of Object.entries(value.checkpoints)) {
    assertCheckpointStateV2(checkpoint, checkpointId, value.attempts);
  }

  for (const task of Object.values(value.tasks)) {
    if (task.currentAttemptId !== undefined) {
      const attempt = value.attempts[task.currentAttemptId];
      if (!attempt || attempt.taskId !== task.taskId) throw new Error("RALPH_V2_TASK_ATTEMPT_RELATION_MISMATCH");
    }
  }
  for (const finding of Object.values(value.findings)) {
    if (!value.tasks[finding.taskId]?.findingIds.includes(finding.id)) throw new Error("RALPH_V2_FINDING_TASK_RELATION_MISMATCH");
  }
  for (const attempt of openAttempts) {
    const task = value.tasks[attempt.taskId];
    if (!task || task.currentAttemptId !== attempt.attemptId) throw new Error("RALPH_V2_OPEN_ATTEMPT_NOT_CURRENT");
    if (attempt.stage === "AWAITING_HUMAN" && value.hold !== "HUMAN_REQUIRED") {
      throw new Error("RALPH_V2_HUMAN_ATTEMPT_RUN_HOLD_MISMATCH");
    }
    assertAttemptTaskProjection(attempt, task);
  }
}

export const validateV2RuntimeState = assertV2RuntimeState;

function assertPhaseState(value: unknown, key: string, taskIds: readonly string[]): asserts value is PhaseState {
  if (!isRecord(value)) throw new Error("RALPH_V2_STATE_INVALID_PHASE");
  assertExactKeys(value, ["phaseId", "taskIds", "disposition", "activity"], "RALPH_V2_STATE_UNKNOWN_PHASE_FIELD");
  if (value.phaseId !== key) throw new Error("RALPH_V2_STATE_PHASE_ID_MISMATCH");
  assertStringArray(value.taskIds, "RALPH_V2_STATE_INVALID_PHASE_TASKS");
  assertUniqueIds(value.taskIds, "RALPH_V2_STATE_DUPLICATE_PHASE_TASK");
  if (value.taskIds.some((taskId) => !taskIds.includes(taskId))) throw new Error("RALPH_V2_STATE_UNKNOWN_PHASE_TASK");
  assertEnum(value.disposition, PHASE_DISPOSITIONS, "RALPH_V2_STATE_INVALID_PHASE_DISPOSITION");
  assertEnum(value.activity, PHASE_ACTIVITIES, "RALPH_V2_STATE_INVALID_PHASE_ACTIVITY");
}

function assertTaskStateV2(value: unknown, key: string, phases: Readonly<Record<string, PhaseState>>): asserts value is TaskState {
  if (!isRecord(value)) throw new Error("RALPH_V2_STATE_INVALID_TASK");
  assertExactKeys(value, [
    "taskId", "phaseId", "dependsOn", "disposition", "activity", "owner", "hold", "currentAttemptId",
    "attemptsUsed", "executorBudget", "strategyResetBudget", "auditorRetryBudget", "providerAvailabilityBudget",
    "evidenceSetId", "validationSetDigest", "postExecutorFingerprint", "acceptedCheckpointFingerprint", "findingIds", "updatedAt",
  ], "RALPH_V2_STATE_UNKNOWN_TASK_FIELD");
  if (value.taskId !== key || typeof value.phaseId !== "string" || phases[value.phaseId] === undefined) throw new Error("RALPH_V2_STATE_TASK_IDENTITY_INVALID");
  assertStringArray(value.dependsOn, "RALPH_V2_STATE_INVALID_TASK_DEPENDENCIES");
  assertEnum(value.disposition, TASK_DISPOSITIONS, "RALPH_V2_STATE_INVALID_TASK_DISPOSITION");
  assertEnum(value.activity, TASK_ACTIVITIES, "RALPH_V2_STATE_INVALID_TASK_ACTIVITY");
  assertEnum(value.owner, TASK_OWNERS, "RALPH_V2_STATE_INVALID_TASK_OWNER");
  assertEnum(value.hold, TASK_HOLDS, "RALPH_V2_STATE_INVALID_TASK_HOLD");
  if (value.currentAttemptId !== undefined) assertNonEmptyString(value.currentAttemptId, "RALPH_V2_STATE_INVALID_CURRENT_ATTEMPT");
  if (!Number.isSafeInteger(value.attemptsUsed) || value.attemptsUsed < 0) throw new Error("RALPH_V2_STATE_INVALID_ATTEMPTS_USED");
  assertOptionalBudget(value.executorBudget);
  assertOptionalBudget(value.strategyResetBudget);
  assertOptionalBudget(value.auditorRetryBudget);
  assertOptionalBudget(value.providerAvailabilityBudget);
  for (const field of ["evidenceSetId", "validationSetDigest", "postExecutorFingerprint", "acceptedCheckpointFingerprint"] as const) {
    if (value[field] !== undefined) assertNonEmptyString(value[field], "RALPH_V2_STATE_INVALID_TASK_REFERENCE");
  }
  assertStringArray(value.findingIds, "RALPH_V2_STATE_INVALID_TASK_FINDINGS");
  if (typeof value.updatedAt !== "string") throw new Error("RALPH_V2_STATE_INVALID_TASK_TIMESTAMP");
  assertTaskState(value as TaskState);
}

function assertAttemptStateV2(
  value: unknown,
  key: string,
  tasks: Readonly<Record<string, TaskState>>,
  phases: Readonly<Record<string, PhaseState>>,
): asserts value is AttemptStateV2 {
  if (!isRecord(value)) throw new Error("RALPH_V2_STATE_INVALID_ATTEMPT");
  assertExactKeys(value, [
    "attemptId", "phaseId", "taskId", "ordinal", "strategyGeneration", "attemptBaseFingerprint", "disposition", "stage",
    "startedAt", "finishedAt", "closureReason", "invocation", "executorFinished", "evidenceCaptureInProgress", "evidenceCapture",
    "validationSpecs", "validationRuns", "validationSet", "auditPackage", "postExecutorFingerprint", "criterionSetDigest",
    "auditability", "validationSummary", "recovery",
  ], "RALPH_V2_STATE_UNKNOWN_ATTEMPT_FIELD");
  if (value.attemptId !== key || typeof value.taskId !== "string" || typeof value.phaseId !== "string") throw new Error("RALPH_V2_STATE_ATTEMPT_IDENTITY_INVALID");
  const task = tasks[value.taskId];
  if (!task || task.phaseId !== value.phaseId || phases[value.phaseId] === undefined) throw new Error("RALPH_V2_STATE_ATTEMPT_RELATION_INVALID");
  if (!Number.isSafeInteger(value.ordinal) || value.ordinal < 1 || !Number.isSafeInteger(value.strategyGeneration) || value.strategyGeneration < 0) throw new Error("RALPH_V2_STATE_ATTEMPT_ORDINAL_INVALID");
  if (value.ordinal > task.attemptsUsed) throw new Error("RALPH_V2_STATE_ATTEMPT_USAGE_MISMATCH");
  assertNonEmptyString(value.attemptBaseFingerprint, "RALPH_V2_STATE_ATTEMPT_FINGERPRINT_INVALID");
  assertEnum(value.disposition, ATTEMPT_DISPOSITIONS, "RALPH_V2_STATE_INVALID_ATTEMPT_DISPOSITION");
  // ATTEMPT_STAGES intentionally does not contain CLOSED.
  assertEnum(value.stage, ATTEMPT_STAGES, "RALPH_V2_STATE_INVALID_ATTEMPT_STAGE");
  assertNonEmptyString(value.startedAt, "RALPH_V2_STATE_ATTEMPT_TIMESTAMP_INVALID");
  if (value.finishedAt !== undefined) assertNonEmptyString(value.finishedAt, "RALPH_V2_STATE_ATTEMPT_TIMESTAMP_INVALID");
  if (value.closureReason !== undefined) assertEnum(value.closureReason, ATTEMPT_CLOSURE_REASONS, "RALPH_V2_STATE_INVALID_CLOSURE_REASON");
  if (value.disposition === "OPEN" && (value.finishedAt !== undefined || value.closureReason !== undefined)) throw new Error("RALPH_V2_OPEN_ATTEMPT_HAS_CLOSURE");
  if (value.disposition === "CLOSED" && (value.finishedAt === undefined || value.closureReason === undefined)) throw new Error("RALPH_V2_CLOSED_ATTEMPT_MISSING_CLOSURE");
  if (value.disposition === "CLOSED" && value.closureReason !== undefined && !isAttemptClosureAllowed(value.stage, value.closureReason)) throw new Error("RALPH_V2_INVALID_CLOSURE_STATE");
  if (value.invocation !== undefined) assertInvocation(value.invocation);
  if (value.invocation !== undefined && value.invocation.attemptBaseFingerprint !== value.attemptBaseFingerprint) throw new Error("RALPH_V2_INVOCATION_BASE_FINGERPRINT_MISMATCH");
  if (value.executorFinished !== undefined) assertExecutorFinished(value.executorFinished);
  if (value.evidenceCaptureInProgress !== undefined) {
    if (!isRecord(value.evidenceCaptureInProgress)) throw new Error("RALPH_V2_STATE_INVALID_CAPTURE_PROGRESS");
    assertExactKeys(value.evidenceCaptureInProgress, ["evidenceCaptureId", "postExecutorFingerprint", "startedAt"], "RALPH_V2_STATE_UNKNOWN_CAPTURE_PROGRESS_FIELD");
    assertNonEmptyString(value.evidenceCaptureInProgress.evidenceCaptureId, "RALPH_V2_STATE_INVALID_CAPTURE_PROGRESS");
    assertNonEmptyString(value.evidenceCaptureInProgress.postExecutorFingerprint, "RALPH_V2_STATE_INVALID_CAPTURE_PROGRESS");
    assertNonEmptyString(value.evidenceCaptureInProgress.startedAt, "RALPH_V2_STATE_INVALID_CAPTURE_PROGRESS");
    if (value.postExecutorFingerprint !== undefined && value.postExecutorFingerprint !== value.evidenceCaptureInProgress.postExecutorFingerprint) throw new Error("RALPH_V2_CAPTURE_FINGERPRINT_MISMATCH");
  }
  if (value.evidenceCapture !== undefined) assertEvidenceCapture(value.evidenceCapture);
  if (!Array.isArray(value.validationSpecs) || !Array.isArray(value.validationRuns)) throw new Error("RALPH_V2_STATE_INVALID_VALIDATION_COLLECTION");
  for (const spec of value.validationSpecs) assertValidationSpec(spec);
  for (const run of value.validationRuns) assertValidationRun(run);
  if (value.validationSet !== undefined) assertValidationSet(value.validationSet);
  if (value.auditPackage !== undefined) assertAuditPackage(value.auditPackage);
  for (const field of ["postExecutorFingerprint", "criterionSetDigest"] as const) {
    if (value[field] !== undefined) assertNonEmptyString(value[field], "RALPH_V2_STATE_INVALID_ATTEMPT_REFERENCE");
  }
  if (value.auditability !== undefined) assertEnum(value.auditability, AUDITABILITY_CLASSIFICATIONS, "RALPH_V2_STATE_INVALID_AUDITABILITY");
  if (value.validationSummary !== undefined) assertValidationSummary(value.validationSummary);
  assertRecovery(value.recovery);
  if (value.disposition === "CLOSED" && value.recovery.kind !== "NONE") throw new Error("RALPH_V2_CLOSED_ATTEMPT_HAS_RECOVERY");
  assertAttemptLifecycleShape(value as AttemptStateV2);
}

function assertAttemptLifecycleShape(attempt: AttemptStateV2): void {
  const stage = attempt.stage;
  const requiresInvocation = [
    "EXECUTOR_DISPATCH_AUTHORIZED",
    "EXECUTOR_RUNNING",
    "POST_EXECUTOR_CAPTURE",
    "EVIDENCE_CAPTURING",
    "VALIDATING",
    "AWAITING_AUDIT",
    "AUDITING",
  ].includes(stage);
  if (requiresInvocation && attempt.invocation === undefined) throw new Error("RALPH_V2_STAGE_INVOCATION_MISSING");
  if (attempt.executorFinished !== undefined) {
    if (attempt.invocation === undefined || attempt.executorFinished.invocationId !== attempt.invocation.invocationId) {
      throw new Error("RALPH_V2_EXECUTOR_OBSERVATION_INVOCATION_MISMATCH");
    }
  }
  if (["POST_EXECUTOR_CAPTURE", "EVIDENCE_CAPTURING", "VALIDATING", "AWAITING_AUDIT", "AUDITING"].includes(stage)
    && attempt.executorFinished === undefined) throw new Error("RALPH_V2_STAGE_EXECUTOR_OBSERVATION_MISSING");
  if (stage === "ADMITTED" && (attempt.invocation !== undefined || attempt.executorFinished !== undefined || attempt.evidenceCaptureInProgress !== undefined || attempt.evidenceCapture !== undefined || attempt.validationSpecs.length > 0 || attempt.validationRuns.length > 0)) {
    throw new Error("RALPH_V2_ADMITTED_ATTEMPT_HAS_DOWNSTREAM_STATE");
  }
  if (stage === "EXECUTOR_DISPATCH_AUTHORIZED" && attempt.executorFinished !== undefined) throw new Error("RALPH_V2_AUTHORIZED_ATTEMPT_ALREADY_FINISHED");
  if (stage === "EXECUTOR_RUNNING" && attempt.executorFinished !== undefined) throw new Error("RALPH_V2_RUNNING_ATTEMPT_ALREADY_FINISHED");

  if (attempt.evidenceCaptureInProgress !== undefined) {
    if (stage !== "EVIDENCE_CAPTURING" || attempt.evidenceCapture !== undefined) throw new Error("RALPH_V2_CAPTURE_PROGRESS_STATE_INVALID");
  }
  if (attempt.evidenceCapture !== undefined) {
    if (attempt.executorFinished === undefined) throw new Error("RALPH_V2_EVIDENCE_BEFORE_EXECUTOR_FINISH");
    if (attempt.postExecutorFingerprint !== attempt.evidenceCapture.postExecutorFingerprint) throw new Error("RALPH_V2_EVIDENCE_FINGERPRINT_MISMATCH");
  }
  if ((stage === "EVIDENCE_CAPTURING" || stage === "VALIDATING" || stage === "AWAITING_AUDIT" || stage === "AUDITING") && attempt.evidenceCapture === undefined && attempt.evidenceCaptureInProgress === undefined) {
    throw new Error("RALPH_V2_STAGE_EVIDENCE_MISSING");
  }
  if (stage === "VALIDATING" && attempt.evidenceCapture === undefined) throw new Error("RALPH_V2_VALIDATING_EVIDENCE_MISSING");
  if ((stage === "AWAITING_AUDIT" || stage === "AUDITING") && (
    attempt.evidenceCapture === undefined
    || attempt.validationSet === undefined
    || attempt.auditPackage === undefined
    || attempt.postExecutorFingerprint === undefined
    || attempt.criterionSetDigest === undefined
    || attempt.auditability === undefined
    || attempt.validationSummary === undefined
    || attempt.validationRuns.some((run) => run.outcome === "PENDING")
  )) throw new Error("RALPH_V2_AUDIT_BOUNDARY_STATE_INVALID");
  if (attempt.disposition === "OPEN" && stage === "AWAITING_HUMAN" && attempt.recovery.kind !== "HUMAN_REQUIRED") throw new Error("RALPH_V2_HUMAN_RECOVERY_STATE_INVALID");
  if (attempt.disposition === "OPEN" && stage === "RECONCILING" && attempt.recovery.kind !== "RECONCILIATION_REQUIRED") throw new Error("RALPH_V2_RECONCILIATION_STATE_INVALID");
  if (attempt.disposition === "OPEN" && stage !== "AWAITING_HUMAN" && stage !== "RECONCILING" && attempt.recovery.kind !== "NONE") throw new Error("RALPH_V2_UNEXPECTED_RECOVERY_STATE");

  const specs = new Map<string, ValidationSpecRef>();
  for (const spec of attempt.validationSpecs) {
    if (specs.has(spec.validationSpecId)) throw new Error("RALPH_V2_DUPLICATE_VALIDATION_SPEC");
    if (spec.sourceTaskId !== attempt.taskId) throw new Error("RALPH_V2_VALIDATION_SPEC_TASK_MISMATCH");
    specs.set(spec.validationSpecId, spec);
  }
  const runIds = new Set<string>();
  for (const run of attempt.validationRuns) {
    if (runIds.has(run.validationRunId)) throw new Error("RALPH_V2_DUPLICATE_VALIDATION_RUN");
    runIds.add(run.validationRunId);
    const spec = specs.get(run.validationSpecId);
    if (!spec || spec.digest !== run.validationSpecDigest) throw new Error("RALPH_V2_VALIDATION_RUN_SPEC_MISMATCH");
  }
  if (attempt.validationSummary !== undefined) {
    const expected = deterministicValidationSummary(attempt.validationSpecs, attempt.validationRuns);
    if (!sameValidationSummary(expected, attempt.validationSummary)) throw new Error("RALPH_V2_VALIDATION_SUMMARY_STATE_MISMATCH");
  }
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

function assertAttemptTaskProjection(attempt: AttemptStateV2, task: TaskState): void {
  if (attempt.stage === "ADMITTED" || attempt.stage === "EXECUTOR_DISPATCH_AUTHORIZED" || attempt.stage === "EXECUTOR_RUNNING") {
    if (task.activity !== "EXECUTING" || task.owner !== "EXECUTOR") throw new Error("RALPH_V2_ATTEMPT_TASK_PROJECTION_INVALID");
  } else if (attempt.stage === "POST_EXECUTOR_CAPTURE" || attempt.stage === "EVIDENCE_CAPTURING") {
    if (task.activity !== "CAPTURING_EVIDENCE" || task.owner !== "CORE") throw new Error("RALPH_V2_ATTEMPT_TASK_PROJECTION_INVALID");
  } else if (attempt.stage === "VALIDATING") {
    if (task.activity !== "VALIDATING" || task.owner !== "CORE") throw new Error("RALPH_V2_ATTEMPT_TASK_PROJECTION_INVALID");
  } else if (attempt.stage === "AWAITING_HUMAN") {
    if (task.activity !== "IDLE" || task.owner !== "NONE" || task.hold !== "HUMAN_REQUIRED") throw new Error("RALPH_V2_HUMAN_ATTEMPT_TASK_PROJECTION_INVALID");
  } else if (attempt.stage === "AWAITING_AUDIT") {
    if (task.disposition !== "READY" || task.activity !== "IDLE" || task.owner !== "NONE" || task.hold !== "NONE" || task.currentAttemptId !== attempt.attemptId) {
      throw new Error("RALPH_V2_AWAITING_AUDIT_TASK_BOUNDARY_INVALID");
    }
  } else if (attempt.stage === "AUDITING") {
    if (task.activity !== "AUDITING" || task.owner !== "AUDITOR") throw new Error("RALPH_V2_AUDITING_TASK_PROJECTION_INVALID");
  } else if (attempt.stage === "RECONCILING") {
    if (task.activity !== "RECONCILING" || task.owner !== "CORE" || task.hold !== "WORKSPACE_DRIFT") throw new Error("RALPH_V2_RECONCILING_TASK_PROJECTION_INVALID");
  }
  if (task.owner === "AUDITOR" && attempt.stage !== "AUDITING") throw new Error("RALPH_V2_AUDITOR_ASSIGNED_BEFORE_AUDIT_STARTED");
}

function assertInvocation(value: unknown): void {
  if (!isRecord(value)) throw new Error("RALPH_V2_STATE_INVALID_INVOCATION");
  assertExactKeys(value, ["invocationId", "workUnitDigest", "attemptBaseFingerprint", "timeoutPolicyDigest", "capabilityPolicyDigest", "authorizedAt"], "RALPH_V2_STATE_UNKNOWN_INVOCATION_FIELD");
  for (const key of ["invocationId", "workUnitDigest", "attemptBaseFingerprint", "timeoutPolicyDigest", "capabilityPolicyDigest", "authorizedAt"] as const) assertNonEmptyString(value[key], "RALPH_V2_STATE_INVALID_INVOCATION");
}

function assertExecutorFinished(value: unknown): void {
  if (!isRecord(value)) throw new Error("RALPH_V2_STATE_INVALID_EXECUTOR_FINISHED");
  assertExactKeys(value, ["invocationId", "status", "termination", "finishedAt"], "RALPH_V2_STATE_UNKNOWN_EXECUTOR_FINISHED_FIELD");
  assertNonEmptyString(value.invocationId, "RALPH_V2_STATE_INVALID_EXECUTOR_FINISHED");
  assertEnum(value.status, EXECUTOR_STATUSES, "RALPH_V2_STATE_INVALID_EXECUTOR_FINISHED");
  assertEnum(value.termination, EXECUTOR_TERMINATIONS, "RALPH_V2_STATE_INVALID_EXECUTOR_FINISHED");
  assertNonEmptyString(value.finishedAt, "RALPH_V2_STATE_INVALID_EXECUTOR_FINISHED");
}

function assertEvidenceCapture(value: unknown): void {
  if (!isRecord(value)) throw new Error("RALPH_V2_STATE_INVALID_EVIDENCE_CAPTURE");
  assertExactKeys(value, ["evidenceCaptureId", "evidenceDigest", "postExecutorFingerprint"], "RALPH_V2_STATE_UNKNOWN_EVIDENCE_CAPTURE_FIELD");
  for (const key of ["evidenceCaptureId", "evidenceDigest", "postExecutorFingerprint"] as const) assertNonEmptyString(value[key], "RALPH_V2_STATE_INVALID_EVIDENCE_CAPTURE");
}

function assertValidationSet(value: unknown): void {
  if (!isRecord(value)) throw new Error("RALPH_V2_STATE_INVALID_VALIDATION_SET");
  assertExactKeys(value, ["validationSetId", "validationSetDigest"], "RALPH_V2_STATE_UNKNOWN_VALIDATION_SET_FIELD");
  assertNonEmptyString(value.validationSetId, "RALPH_V2_STATE_INVALID_VALIDATION_SET");
  assertNonEmptyString(value.validationSetDigest, "RALPH_V2_STATE_INVALID_VALIDATION_SET");
}

function assertAuditPackage(value: unknown): void {
  if (!isRecord(value)) throw new Error("RALPH_V2_STATE_INVALID_AUDIT_PACKAGE");
  assertExactKeys(value, ["auditPackageId", "auditPackageDigest"], "RALPH_V2_STATE_UNKNOWN_AUDIT_PACKAGE_FIELD");
  assertNonEmptyString(value.auditPackageId, "RALPH_V2_STATE_INVALID_AUDIT_PACKAGE");
  assertNonEmptyString(value.auditPackageDigest, "RALPH_V2_STATE_INVALID_AUDIT_PACKAGE");
}

function assertFindingStateV2(
  value: unknown,
  key: string,
  tasks: Readonly<Record<string, TaskState>>,
  phases: Readonly<Record<string, PhaseState>>,
): asserts value is Finding {
  if (!isRecord(value)) throw new Error("RALPH_V2_STATE_INVALID_FINDING");
  assertExactKeys(value, [
    "id", "criterionId", "phaseId", "taskId", "scope", "severity", "status", "expectation", "observed", "evidenceRefs",
    "remediationHint", "openedAtAttempt", "resolvedAtAttempt", "rootCauseGroup", "supersedesFindingId", "resolutionEvidenceDigest",
    "resolutionAuditId", "resolutionValidationSetDigest", "resolutionCriterionResult",
  ], "RALPH_V2_STATE_UNKNOWN_FINDING_FIELD");
  if (value.id !== key || typeof value.phaseId !== "string" || typeof value.taskId !== "string" || !phases[value.phaseId] || !tasks[value.taskId] || tasks[value.taskId]?.phaseId !== value.phaseId) {
    throw new Error("RALPH_V2_STATE_FINDING_RELATION_INVALID");
  }
  for (const field of ["id", "criterionId", "phaseId", "taskId", "expectation", "observed", "openedAtAttempt"] as const) assertNonEmptyString(value[field], "RALPH_V2_STATE_INVALID_FINDING");
  assertStringArray(value.scope, "RALPH_V2_STATE_INVALID_FINDING");
  assertEnum(value.severity, ["INFO", "LOW", "MEDIUM", "HIGH", "BLOCKER"], "RALPH_V2_STATE_INVALID_FINDING");
  assertEnum(value.status, FINDING_STATUSES, "RALPH_V2_STATE_INVALID_FINDING");
  assertEvidenceRefsState(value.evidenceRefs);
  for (const field of ["remediationHint", "resolvedAtAttempt", "rootCauseGroup", "supersedesFindingId", "resolutionEvidenceDigest", "resolutionAuditId", "resolutionValidationSetDigest"] as const) {
    if (value[field] !== undefined) assertNonEmptyString(value[field], "RALPH_V2_STATE_INVALID_FINDING");
  }
  if (value.resolutionCriterionResult !== undefined) assertEnum(value.resolutionCriterionResult, ["PASS", "NOT_APPLICABLE"], "RALPH_V2_STATE_INVALID_FINDING");
}

function assertEvidenceRefsState(value: unknown): asserts value is readonly EvidenceRef[] {
  if (!Array.isArray(value)) throw new Error("RALPH_V2_STATE_INVALID_EVIDENCE_REFS");
  for (const item of value) {
    if (!isRecord(item)) throw new Error("RALPH_V2_STATE_INVALID_EVIDENCE_REF");
    assertExactKeys(item, ["evidenceId", "evidenceSetId", "digest", "kind", "provenance", "integrity", "storageRef", "capturedAt"], "RALPH_V2_STATE_UNKNOWN_EVIDENCE_FIELD");
    for (const field of ["evidenceId", "evidenceSetId", "digest", "storageRef", "capturedAt"] as const) assertNonEmptyString(item[field], "RALPH_V2_STATE_INVALID_EVIDENCE_REF");
    assertEnum(item.kind, ["workspace-diff", "command-result", "test-result", "provider-output", "validation-artifact", "snapshot", "log"], "RALPH_V2_STATE_INVALID_EVIDENCE_REF");
    assertEnum(item.provenance, ["CORE", "EXECUTOR", "AUDITOR", "SYSTEM"], "RALPH_V2_STATE_INVALID_EVIDENCE_REF");
    assertEnum(item.integrity, ["VERIFIED", "UNVERIFIED"], "RALPH_V2_STATE_INVALID_EVIDENCE_REF");
  }
}

function assertCheckpointStateV2(
  value: unknown,
  key: string,
  attempts: Readonly<Record<string, AttemptStateV2>>,
): asserts value is CheckpointRecord {
  if (!isRecord(value)) throw new Error("RALPH_V2_STATE_INVALID_CHECKPOINT");
  assertExactKeys(value, ["kind", "fingerprintDigest", "emittedAt", "attemptId", "evidenceSetId"], "RALPH_V2_STATE_UNKNOWN_CHECKPOINT_FIELD");
  assertEnum(value.kind, ["runStartFingerprint", "attemptBaseFingerprint", "postExecutorFingerprint", "acceptedCheckpointFingerprint"], "RALPH_V2_STATE_INVALID_CHECKPOINT");
  if (key !== value.kind) throw new Error("RALPH_V2_STATE_CHECKPOINT_IDENTITY_INVALID");
  assertNonEmptyString(value.fingerprintDigest, "RALPH_V2_STATE_INVALID_CHECKPOINT");
  assertNonEmptyString(value.emittedAt, "RALPH_V2_STATE_INVALID_CHECKPOINT");
  if (value.attemptId !== undefined) {
    assertNonEmptyString(value.attemptId, "RALPH_V2_STATE_INVALID_CHECKPOINT");
    if (!attempts[value.attemptId]) throw new Error("RALPH_V2_STATE_CHECKPOINT_ATTEMPT_UNKNOWN");
  }
  if (value.evidenceSetId !== undefined) assertNonEmptyString(value.evidenceSetId, "RALPH_V2_STATE_INVALID_CHECKPOINT");
}

function assertValidationSpec(value: unknown): asserts value is ValidationSpecRef {
  if (!isRecord(value)) throw new Error("RALPH_V2_STATE_INVALID_VALIDATION_SPEC");
  assertExactKeys(value, ["validationSpecId", "ordinal", "kind", "instruction", "digest", "sourceTaskId", "sourcePlanIdentity"], "RALPH_V2_STATE_UNKNOWN_VALIDATION_SPEC_FIELD");
  assertNonEmptyString(value.validationSpecId, "RALPH_V2_STATE_INVALID_VALIDATION_SPEC");
  assertPositiveInteger(value.ordinal, "RALPH_V2_STATE_INVALID_VALIDATION_SPEC");
  assertEnum(value.kind, VALIDATION_KINDS, "RALPH_V2_STATE_INVALID_VALIDATION_SPEC");
  for (const key of ["instruction", "digest", "sourceTaskId", "sourcePlanIdentity"] as const) assertNonEmptyString(value[key], "RALPH_V2_STATE_INVALID_VALIDATION_SPEC");
}

function assertValidationRun(value: unknown): asserts value is ValidationRunRef {
  if (!isRecord(value)) throw new Error("RALPH_V2_STATE_INVALID_VALIDATION_RUN");
  assertExactKeys(value, ["validationRunId", "validationSpecId", "validationSpecDigest", "validationRunOrdinal", "startedAt", "endedAt", "outcome", "exitCode", "resultDigest"], "RALPH_V2_STATE_UNKNOWN_VALIDATION_RUN_FIELD");
  for (const key of ["validationRunId", "validationSpecId", "validationSpecDigest", "startedAt"] as const) assertNonEmptyString(value[key], "RALPH_V2_STATE_INVALID_VALIDATION_RUN");
  assertPositiveInteger(value.validationRunOrdinal, "RALPH_V2_STATE_INVALID_VALIDATION_RUN");
  assertEnum(value.outcome, VALIDATION_OUTCOMES, "RALPH_V2_STATE_INVALID_VALIDATION_RUN");
  if (value.endedAt !== undefined) assertNonEmptyString(value.endedAt, "RALPH_V2_STATE_INVALID_VALIDATION_RUN");
  if (value.exitCode !== undefined && value.exitCode !== null && (!Number.isSafeInteger(value.exitCode))) throw new Error("RALPH_V2_STATE_INVALID_VALIDATION_RUN");
  if (value.resultDigest !== undefined) assertNonEmptyString(value.resultDigest, "RALPH_V2_STATE_INVALID_VALIDATION_RUN");
  if (value.outcome === "PENDING" && value.endedAt !== undefined) throw new Error("RALPH_V2_PENDING_VALIDATION_RUN_ENDED");
  if (value.outcome !== "PENDING" && value.endedAt === undefined) throw new Error("RALPH_V2_COMPLETED_VALIDATION_RUN_MISSING_END");
}

function assertValidationSummary(value: unknown): asserts value is DeterministicValidationSummary {
  if (!isRecord(value)) throw new Error("RALPH_V2_STATE_INVALID_VALIDATION_SUMMARY");
  assertExactKeys(value, ["total", "completed", "passed", "failed", "notApplicable", "infrastructureFailures", "manualRequired", "humanRequired", "hardNegative"], "RALPH_V2_STATE_UNKNOWN_VALIDATION_SUMMARY_FIELD");
  for (const key of ["total", "completed", "passed", "failed", "notApplicable", "infrastructureFailures", "manualRequired", "humanRequired"] as const) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error("RALPH_V2_STATE_INVALID_VALIDATION_SUMMARY");
  }
  if (typeof value.hardNegative !== "boolean") throw new Error("RALPH_V2_STATE_INVALID_VALIDATION_SUMMARY");
}

function assertRecovery(value: unknown): void {
  if (!isRecord(value)) throw new Error("RALPH_V2_STATE_INVALID_RECOVERY");
  assertExactKeys(value, ["kind", "reason", "proofRef"], "RALPH_V2_STATE_UNKNOWN_RECOVERY_FIELD");
  assertEnum(value.kind, ATTEMPT_RECOVERY_KINDS, "RALPH_V2_STATE_INVALID_RECOVERY");
  if (value.reason !== undefined) assertNonEmptyString(value.reason, "RALPH_V2_STATE_INVALID_RECOVERY");
  if (value.proofRef !== undefined) assertNonEmptyString(value.proofRef, "RALPH_V2_STATE_INVALID_RECOVERY");
  if (value.kind === "NONE" && (value.reason !== undefined || value.proofRef !== undefined)) throw new Error("RALPH_V2_NONE_RECOVERY_HAS_DETAILS");
  if (value.kind !== "NONE" && (value.reason === undefined || value.proofRef === undefined)) throw new Error("RALPH_V2_RECOVERY_PROOF_MISSING");
}

function assertOptionalBudget(value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error("RALPH_V2_STATE_INVALID_BUDGET");
  assertExactKeys(value, ["used", "limit", "remaining", "exhausted", "exceeded"], "RALPH_V2_STATE_UNKNOWN_BUDGET_FIELD");
  for (const key of ["used", "limit", "remaining"] as const) {
    if (typeof value[key] !== "number" || !Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error("RALPH_V2_STATE_INVALID_BUDGET");
  }
  if (typeof value.exhausted !== "boolean" || typeof value.exceeded !== "boolean") throw new Error("RALPH_V2_STATE_INVALID_BUDGET");
  if (value.remaining !== Math.max(value.limit - value.used, 0) || value.exhausted !== value.used >= value.limit || value.exceeded !== value.used > value.limit) throw new Error("RALPH_V2_STATE_INVALID_BUDGET");
}

function assertExactKeys(value: object, allowed: readonly string[], code: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new Error(`${code}: ${unknown.sort().join(",")}`);
}

function assertRecord(value: unknown, code: string): asserts value is Record<string, any> {
  if (!isRecord(value)) throw new Error(code);
}

function assertStringArray(value: unknown, code: string): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) throw new Error(code);
}

function assertUniqueIds(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) throw new Error(code);
}

function assertNonEmptyString(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new Error(code);
}

function assertPositiveInteger(value: unknown, code: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(code);
}

function assertEnum<T extends readonly string[]>(value: unknown, values: T, code: string): asserts value is T[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new Error(code);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sameKeySet(keys: readonly string[], expected: readonly string[]): boolean {
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}
