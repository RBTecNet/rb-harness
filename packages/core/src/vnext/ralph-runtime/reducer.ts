import type { AttemptState, Finding, PhaseState, RalphRuntimeState, TaskState } from "./contracts.js";
import type { RalphEvent } from "./events.js";
import { deriveAllPhases, assertRunCombination, assertTaskState, canCompleteRun, runHasEligibleWork, runHasKnownBlockingCondition } from "./state.js";
import { transitionFinding } from "./findings.js";
import { assertAttemptBaseFingerprint } from "./checkpoints.js";

export function reduceRalphEvent(state: RalphRuntimeState, event: RalphEvent): RalphRuntimeState {
  if (event.runId !== state.runId) throw new Error("RALPH_REDUCER_FOREIGN_RUN");
  if (event.sequence !== state.lastSequence + 1) throw new Error("RALPH_REDUCER_SEQUENCE_MISMATCH");
  if (event.previousEventHash !== state.lastEventHash) throw new Error("RALPH_REDUCER_HASH_CHAIN_MISMATCH");

  let next: RalphRuntimeState = state;
  switch (event.eventType) {
    case "run.created":
      if (state.disposition !== "CREATED" || state.lastSequence !== 0) throw new Error("RALPH_INVALID_RUN_CREATE");
      if (event.payload.phaseIds.join("\u0000") !== state.phaseIds.join("\u0000") || event.payload.taskIds.join("\u0000") !== state.taskIds.join("\u0000")) {
        throw new Error("RALPH_RUN_CREATE_ENTITY_MISMATCH");
      }
      break;
    case "run.started":
      if (state.disposition !== "CREATED" || state.hold !== "NONE") throw new Error("RALPH_INVALID_RUN_START");
      next = { ...state, disposition: "ACTIVE" };
      break;
    case "run.hold-set":
      if (state.disposition !== "ACTIVE" || state.hold !== "NONE") throw new Error("RALPH_INVALID_RUN_HOLD_SET");
      if (event.payload.hold === "BLOCKED" && (runHasEligibleWork(state) || !runHasKnownBlockingCondition(state))) throw new Error("RALPH_GLOBAL_BLOCKED_PRECONDITION");
      next = { ...state, hold: event.payload.hold };
      break;
    case "run.hold-cleared":
      if (state.disposition !== "ACTIVE" || state.hold === "NONE" || event.payload.previousHold !== state.hold) throw new Error("RALPH_INVALID_RUN_HOLD_CLEAR");
      next = { ...state, hold: "NONE" };
      break;
    case "run.failed":
      if (state.disposition === "COMPLETE" || state.disposition === "FAILED") throw new Error("RALPH_RUN_TERMINAL");
      next = { ...state, disposition: "FAILED", hold: "NONE" };
      break;
    case "run.completed":
      if (state.disposition !== "ACTIVE" || !canCompleteRun(state, event.payload.finalStatePersisted)) throw new Error("RALPH_RUN_COMPLETION_PRECONDITION");
      next = { ...state, disposition: "COMPLETE", hold: "NONE", finalStatePersisted: true };
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
      if (event.payload.finding.status === "RESOLVED" && event.actor !== "CORE") throw new Error("RALPH_AUDITOR_CANNOT_RESOLVE_FINDING");
      next = reduceFindingChange(state, event.payload.finding);
      break;
    case "workspace.checkpointed":
      next = reduceCheckpoint(state, event);
      break;
    case "workspace.drift-detected":
      if (state.disposition !== "ACTIVE") throw new Error("RALPH_DRIFT_OUTSIDE_ACTIVE_RUN");
      next = { ...state, hold: "RECONCILIATION_REQUIRED" };
      break;
  }

  assertRunCombination(next.disposition, next.hold);
  return { ...next, lastSequence: event.sequence, lastEventHash: event.eventHash };
}

function reduceTaskStateChange(state: RalphRuntimeState, event: Extract<RalphEvent, { eventType: "task.state-changed" }>): RalphRuntimeState {
  const current = state.tasks[event.taskId ?? ""];
  if (!current) throw new Error("RALPH_REDUCER_UNKNOWN_TASK");
  if (current.disposition === "COMPLETE" || current.disposition === "FAILED") throw new Error("RALPH_TASK_TERMINAL");
  const candidate: TaskState = { ...current, ...event.payload, findingIds: [...current.findingIds], updatedAt: event.recordedAt };
  assertTaskDispositionTransition(current.disposition, candidate.disposition);
  if (candidate.disposition === "COMPLETE") assertTaskCompletion(state, current, candidate);
  assertTaskState(candidate);
  return { ...state, tasks: { ...state.tasks, [candidate.taskId]: candidate }, phases: deriveAllPhases({ phases: state.phases, tasks: { ...state.tasks, [candidate.taskId]: candidate } }) };
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
  if (!allowed[previous].includes(next)) throw new Error(`RALPH_INVALID_TASK_DISPOSITION_TRANSITION: ${previous}->${next}`);
}

function reduceAttemptStarted(state: RalphRuntimeState, event: Extract<RalphEvent, { eventType: "attempt.started" }>): RalphRuntimeState {
  const task = state.tasks[event.payload.taskId];
  if (!task) throw new Error("RALPH_ATTEMPT_UNKNOWN_TASK");
  if (event.attemptId !== event.payload.attemptId || task.disposition !== "READY" || task.activity !== "IDLE" || task.hold !== "NONE") throw new Error("RALPH_INVALID_ATTEMPT_START");
  if (state.attempts[event.payload.attemptId]) throw new Error("RALPH_ATTEMPT_DUPLICATE");
  if (event.payload.ordinal !== task.attemptsUsed + 1) throw new Error("RALPH_ATTEMPT_ORDINAL_MISMATCH");
  assertAttemptBaseFingerprint(state, event.payload.attemptBaseFingerprint);
  const attempt: AttemptState = {
    attemptId: event.payload.attemptId,
    taskId: event.payload.taskId,
    ordinal: event.payload.ordinal,
    strategyGeneration: event.payload.strategyGeneration,
    attemptBaseFingerprint: event.payload.attemptBaseFingerprint,
    evidenceRefs: [],
    validationRefs: [],
    openedFindingIds: [],
    resolvedFindingIds: [],
    startedAt: event.payload.startedAt,
    closed: false,
  };
  const nextTask: TaskState = { ...task, activity: "EXECUTING", owner: "EXECUTOR", currentAttemptId: attempt.attemptId, attemptsUsed: task.attemptsUsed + 1, updatedAt: event.recordedAt };
  return {
    ...state,
    tasks: { ...state.tasks, [task.taskId]: nextTask },
    attempts: { ...state.attempts, [attempt.attemptId]: attempt },
    phases: deriveAllPhases({ phases: state.phases, tasks: { ...state.tasks, [task.taskId]: nextTask } }),
  };
}

function reduceAttemptClosed(state: RalphRuntimeState, event: Extract<RalphEvent, { eventType: "attempt.closed" }>): RalphRuntimeState {
  const attempt = state.attempts[event.payload.attemptId];
  if (!attempt || attempt.closed) throw new Error("RALPH_INVALID_ATTEMPT_CLOSE");
  const nextAttempt: AttemptState = {
    ...attempt,
    closed: true,
    finishedAt: event.payload.finishedAt,
    completionReason: event.payload.completionReason,
    evidenceRefs: event.payload.evidenceRefs ?? attempt.evidenceRefs,
    validationRefs: event.payload.validationRefs ?? attempt.validationRefs,
    ...(event.payload.auditResult === undefined ? {} : { auditResult: event.payload.auditResult }),
  };
  return { ...state, attempts: { ...state.attempts, [attempt.attemptId]: nextAttempt } };
}

function assertTaskCompletion(state: RalphRuntimeState, previous: TaskState, candidate: TaskState): void {
  if (previous.disposition === "PENDING") throw new Error("RALPH_TASK_COMPLETION_NOT_READY");
  if (!candidate.currentAttemptId || !candidate.evidenceSetId || !candidate.validationSetDigest || !candidate.postExecutorFingerprint || !candidate.acceptedCheckpointFingerprint) {
    throw new Error("RALPH_TASK_COMPLETION_PROOF_MISSING");
  }
  const attempt = state.attempts[candidate.currentAttemptId];
  if (!attempt || !attempt.closed || !attempt.auditResult || !["PASS", "NOT_APPLICABLE"].includes(attempt.auditResult.result)) throw new Error("RALPH_TASK_COMPLETION_AUDIT_MISSING");
  if (attempt.auditResult.binding.taskId !== candidate.taskId || attempt.auditResult.binding.attemptId !== candidate.currentAttemptId) throw new Error("RALPH_TASK_COMPLETION_AUDIT_IDENTITY_MISMATCH");
  if (attempt.auditResult.binding.evidenceSetId !== candidate.evidenceSetId || attempt.auditResult.binding.validationSetDigest !== candidate.validationSetDigest || attempt.auditResult.binding.postExecutorFingerprint !== candidate.postExecutorFingerprint) {
    throw new Error("RALPH_TASK_COMPLETION_AUDIT_BINDING_MISMATCH");
  }
  if (attempt.validationRefs.some((validation) => validation.result === "FAIL")) throw new Error("RALPH_TASK_COMPLETION_VALIDATION_FAILED");
  if (Object.values(state.findings).some((finding) => finding.taskId === candidate.taskId && finding.severity === "BLOCKER" && !["RESOLVED", "SUPERSEDED"].includes(finding.status))) {
    throw new Error("RALPH_TASK_COMPLETION_BLOCKING_FINDING");
  }
}

function reduceFindingChange(state: RalphRuntimeState, finding: Finding): RalphRuntimeState {
  if (finding.phaseId !== state.phases[finding.phaseId]?.phaseId || !state.tasks[finding.taskId]) throw new Error("RALPH_FINDING_ENTITY_MISMATCH");
  const previous = state.findings[finding.id];
  const nextFinding = previous ? transitionFinding(previous, finding) : finding.status === "OPEN" ? finding : (() => { throw new Error("RALPH_FINDING_MUST_OPEN_FIRST"); })();
  const task = state.tasks[finding.taskId];
  if (!task) throw new Error("RALPH_FINDING_ENTITY_MISMATCH");
  return {
    ...state,
    findings: { ...state.findings, [finding.id]: nextFinding },
    tasks: { ...state.tasks, [task.taskId]: { ...task, findingIds: task.findingIds.includes(finding.id) ? task.findingIds : [...task.findingIds, finding.id] } },
  };
}

function reduceCheckpoint(state: RalphRuntimeState, event: Extract<RalphEvent, { eventType: "workspace.checkpointed" }>): RalphRuntimeState {
  const checkpoint = event.payload.checkpoint;
  return { ...state, checkpoints: { ...state.checkpoints, [checkpoint.kind]: checkpoint } };
}

export function recomputePhaseState(state: RalphRuntimeState): RalphRuntimeState {
  const phases: Readonly<Record<string, PhaseState>> = deriveAllPhases(state);
  return { ...state, phases };
}
