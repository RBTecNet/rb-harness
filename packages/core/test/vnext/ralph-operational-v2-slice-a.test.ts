import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RALPH_EVENT_SCHEMA as V1_EVENT_SCHEMA,
  createInitialRuntimeState as createInitialRuntimeStateV1,
  createRalphEvent as createRalphEventV1,
  reduceRalphEvent as reduceRalphEventV1,
  validateRalphEvent as validateRalphEventV1,
  type UnsignedRalphEvent as UnsignedRalphEventV1,
} from "../../src/vnext/ralph-runtime/index.js";
import {
  ATTEMPT_CLOSURE_REASONS,
  ATTEMPT_DISPOSITIONS,
  ATTEMPT_STAGES,
  AUDITABILITY_CLASSIFICATIONS,
  EVENT_SCHEMA_V2,
  OPERATIONAL_CONTRACT_V2,
  RALPH_V2_EVENT_SCHEMA,
  RALPH_V2_OPERATIONAL_CONTRACT,
  RALPH_V2_STATE_SCHEMA,
  RALPH_EVENT_TYPES_V2,
  STATE_SCHEMA_V2,
  V2_EVENT_ENTITY_KINDS,
  assertV2RuntimeState,
  assertV2RunIdentity,
  createInitialRuntimeStateV2,
  createRalphEventV2,
  createV2RunIdentity,
  deterministicValidationSummary,
  parseValidationSpec,
  reduceRalphEventV2,
  replayV2Events,
  scheduleNextTask,
  validateRalphEventV2,
  validateV2EventSequence,
  validationInstructionKind,
  validationSpecsForTask,
  type AttemptStateV2,
  type AttemptClosureReason,
  type EventPayloadMapV2,
  type RalphEventV2,
  type RalphEventTypeV2,
  type RalphRuntimeStateV2,
  type SchedulerDecision,
  type TaskState,
  type UnsignedRalphEventV2,
} from "../../src/vnext/ralph-runtime/operational-v2/index.js";
import type { ExecutionDocument, Phase, Task } from "../../src/types.js";

const RUN_ID = "run-v2";
const PLAN_ID = "plan-v2";

type EventOptions = {
  readonly actor?: "CORE" | "EXECUTOR" | "AUDITOR" | "HUMAN" | "SYSTEM";
  readonly taskId?: string;
  readonly phaseId?: string;
  readonly attemptId?: string;
  readonly findingId?: string;
  readonly workspaceId?: string;
  readonly entityId?: string;
  readonly runId?: string;
  readonly sequence?: number;
  readonly previousEventHash?: string | null;
};

function timestamp(sequence: number, offset: string): string {
  const minute = Math.floor(sequence / 60).toString().padStart(2, "0");
  const second = (sequence % 60).toString().padStart(2, "0");
  return `2026-01-01T00:${minute}:${second}.${offset}Z`;
}

function planTask(
  id: string,
  phaseId: string,
  dependsOn: readonly string[] = [],
  overrides: Partial<Task> = {},
): Task {
  return {
    id,
    title: `Task ${id}`,
    done: false,
    scope: "src",
    change: "implement the task",
    covers: "src",
    dependsOn: [...dependsOn],
    parallelSafe: false,
    acceptanceCriteria: [`${id} produces its declared result`],
    validation: ["`printf validation`"],
    expectedEvidence: "a deterministic evidence reference",
    line: 1,
    ...overrides,
    phaseId,
  } as Task;
}

function planPhase(
  number: number,
  id: string,
  tasks: readonly Task[],
  dependsOn: readonly string[] = [],
): Phase {
  return {
    number,
    id,
    title: `Phase ${id}`,
    goal: `complete ${id}`,
    dependsOn: [...dependsOn],
    context: ["context"],
    tasks: tasks.map((task) => ({ ...task, phaseId: id })),
    line: 1,
  };
}

function executionPlan(phases: readonly Phase[]): ExecutionDocument {
  return {
    contract: "rb-execution/v1",
    artifactId: PLAN_ID,
    title: "Slice A test plan",
    phases: phases.map((phase) => ({ ...phase, tasks: phase.tasks.map((task) => ({ ...task })) })),
  };
}

function singlePlan(overrides: Partial<Task> = {}): ExecutionDocument {
  const task = planTask("T001", "P01", [], overrides);
  return executionPlan([planPhase(1, "P01", [task])]);
}

function createState(plan: ExecutionDocument = singlePlan()): RalphRuntimeStateV2 {
  return createInitialRuntimeStateV2({
    runId: RUN_ID,
    phases: plan.phases.map((phase) => ({ phaseId: phase.id, taskIds: phase.tasks.map((task) => task.id) })),
    tasks: plan.phases.flatMap((phase) => phase.tasks.map((task) => ({
      taskId: task.id,
      phaseId: phase.id,
      dependsOn: [...task.dependsOn],
    }))),
  });
}

function openAttempt(state: RalphRuntimeStateV2): AttemptStateV2 | undefined {
  return Object.values(state.attempts).find((attempt) => attempt.disposition === "OPEN");
}

function contextForEvent<TType extends RalphEventTypeV2>(
  state: RalphRuntimeStateV2,
  eventType: TType,
  payload: EventPayloadMapV2[TType],
  options: EventOptions,
): {
  readonly entity: { readonly kind: "run" | "phase" | "task" | "attempt" | "finding" | "workspace"; readonly id: string };
  readonly phaseId?: string;
  readonly taskId?: string;
  readonly attemptId?: string;
} {
  const kind = V2_EVENT_ENTITY_KINDS[eventType];
  const rawPayload = payload as Record<string, unknown>;
  if (kind === "run") return { entity: { kind, id: options.entityId ?? state.runId } };
  if (kind === "task") {
    const taskId = options.taskId ?? (typeof rawPayload.taskId === "string" ? rawPayload.taskId : "T001");
    return { entity: { kind, id: options.entityId ?? taskId }, phaseId: options.phaseId, taskId };
  }
  if (kind === "attempt") {
    const attempt = openAttempt(state);
    const attemptId = options.attemptId
      ?? (typeof rawPayload.attemptId === "string" ? rawPayload.attemptId : attempt?.attemptId)
      ?? "A001";
    const taskId = options.taskId ?? attempt?.taskId;
    const phaseId = options.phaseId ?? attempt?.phaseId;
    return {
      entity: { kind, id: options.entityId ?? attemptId },
      ...(phaseId === undefined ? {} : { phaseId }),
      ...(taskId === undefined ? {} : { taskId }),
      attemptId,
    };
  }
  if (kind === "finding") {
    const finding = rawPayload.finding as { id?: unknown; phaseId?: unknown; taskId?: unknown } | undefined;
    const findingId = options.findingId ?? (typeof finding?.id === "string" ? finding.id : "F001");
    return {
      entity: { kind, id: options.entityId ?? findingId },
      ...(typeof finding?.phaseId === "string" ? { phaseId: options.phaseId ?? finding.phaseId } : {}),
      ...(typeof finding?.taskId === "string" ? { taskId: options.taskId ?? finding.taskId } : {}),
    };
  }
  return { entity: { kind, id: options.entityId ?? "workspace-1" } };
}

function makeEvent<TType extends RalphEventTypeV2>(
  state: RalphRuntimeStateV2,
  eventType: TType,
  payload: EventPayloadMapV2[TType],
  options: EventOptions = {},
): RalphEventV2 {
  const sequence = options.sequence ?? state.lastSequence + 1;
  const context = contextForEvent(state, eventType, payload, options);
  return createRalphEventV2({
    eventId: `v2-event-${sequence}-${eventType}`,
    eventType,
    schemaVersion: EVENT_SCHEMA_V2,
    runId: options.runId ?? RUN_ID,
    sequence,
    occurredAt: timestamp(sequence, "000"),
    recordedAt: timestamp(sequence, "100"),
    ...context,
    actor: options.actor ?? "CORE",
    causationId: null,
    correlationId: "v2-correlation",
    payload,
    previousEventHash: options.previousEventHash === undefined ? state.lastEventHash : options.previousEventHash,
  } as UnsignedRalphEventV2<TType>) as RalphEventV2;
}

function applyEvent<TType extends RalphEventTypeV2>(
  state: RalphRuntimeStateV2,
  eventType: TType,
  payload: EventPayloadMapV2[TType],
  options: EventOptions = {},
): RalphRuntimeStateV2 {
  return reduceRalphEventV2(state, makeEvent(state, eventType, payload, options));
}

function startedState(plan: ExecutionDocument = singlePlan()): RalphRuntimeStateV2 {
  let state = createState(plan);
  state = applyEvent(state, "run.created", {
    phaseIds: plan.phases.map((phase) => phase.id),
    taskIds: plan.phases.flatMap((phase) => phase.tasks.map((task) => task.id)),
  });
  state = applyEvent(state, "run.started", {});
  return state;
}

function readyState(plan: ExecutionDocument = singlePlan(), taskIds?: readonly string[]): RalphRuntimeStateV2 {
  let state = startedState(plan);
  const ready = taskIds ?? plan.phases.flatMap((phase) => phase.tasks.map((task) => task.id));
  for (const taskId of ready) {
    state = applyEvent(state, "task.state-changed", {
      disposition: "READY",
      activity: "IDLE",
      owner: "NONE",
      hold: "NONE",
    }, { taskId, phaseId: state.tasks[taskId]?.phaseId });
  }
  return state;
}

function checkpointedReadyState(plan: ExecutionDocument = singlePlan()): RalphRuntimeStateV2 {
  return applyEvent(readyState(plan), "workspace.checkpointed", {
    checkpoint: {
      kind: "runStartFingerprint",
      fingerprintDigest: "fp-base",
      emittedAt: "2026-01-01T00:00:10.000Z",
    },
  });
}

function attemptStartedState(plan: ExecutionDocument = singlePlan(), attemptId = "A001"): RalphRuntimeStateV2 {
  const state = checkpointedReadyState(plan);
  const task = plan.phases[0]!.tasks[0]!;
  return applyEvent(state, "attempt.started", {
    taskId: task.id,
    attemptId,
    ordinal: 1,
    strategyGeneration: 0,
    attemptBaseFingerprint: "fp-base",
    startedAt: "2026-01-01T00:00:20.000Z",
  }, { attemptId, taskId: task.id, phaseId: "P01" });
}

function dispatchAuthorizedState(state: RalphRuntimeStateV2): RalphRuntimeStateV2 {
  const attempt = openAttempt(state)!;
  return applyEvent(state, "executor.dispatch-authorized", {
    invocationId: "invocation-1",
    workUnitDigest: "work-unit-1",
    attemptBaseFingerprint: attempt.attemptBaseFingerprint,
    timeoutPolicyDigest: "timeout-policy-1",
    capabilityPolicyDigest: "capability-policy-1",
    authorizedAt: "2026-01-01T00:00:30.000Z",
  });
}

function executorRunningState(): RalphRuntimeStateV2 {
  const authorized = dispatchAuthorizedState(attemptStartedState());
  return applyEvent(authorized, "executor.started", {
    invocationId: "invocation-1",
    startedAt: "2026-01-01T00:00:40.000Z",
  });
}

function validationStartedState(): RalphRuntimeStateV2 {
  let state = executorRunningState();
  state = applyEvent(state, "executor.finished", {
    invocationId: "invocation-1",
    status: "SUCCEEDED",
    termination: "NORMAL",
    finishedAt: "2026-01-01T00:00:50.000Z",
  });
  state = applyEvent(state, "evidence.capture-started", {
    evidenceCaptureId: "capture-1",
    postExecutorFingerprint: "fp-post",
    startedAt: "2026-01-01T00:01:00.000Z",
  });
  state = applyEvent(state, "evidence.captured", {
    evidenceCaptureId: "capture-1",
    evidenceDigest: "evidence-digest-1",
    postExecutorFingerprint: "fp-post",
    capturedAt: "2026-01-01T00:01:10.000Z",
  });
  const spec = parseValidationSpec("`printf validation`", {
    taskId: "T001",
    planIdentity: PLAN_ID,
    ordinal: 1,
  });
  return applyEvent(state, "validation.started", {
    validationSpec: spec,
    validationRunId: "validation-run-1",
    validationRunOrdinal: 1,
    startedAt: "2026-01-01T00:01:20.000Z",
  });
}

function humanResumeLifecycle(): {
  readonly genesis: RalphRuntimeStateV2;
  readonly events: readonly RalphEventV2[];
  readonly afterHumanRequired: RalphRuntimeStateV2;
  readonly afterClear: RalphRuntimeStateV2;
} {
  const genesis = createState();
  let cursor = genesis;
  const events: RalphEventV2[] = [];
  let afterHumanRequired: RalphRuntimeStateV2 | undefined;

  const append = <TType extends RalphEventTypeV2>(
    eventType: TType,
    payload: EventPayloadMapV2[TType],
    options: EventOptions = {},
  ): void => {
    const event = makeEvent(cursor, eventType, payload, options);
    events.push(event);
    cursor = reduceRalphEventV2(cursor, event);
  };

  append("run.created", { phaseIds: ["P01"], taskIds: ["T001"] });
  append("run.started", {});
  append("task.state-changed", { disposition: "READY", activity: "IDLE", owner: "NONE", hold: "NONE" }, { taskId: "T001", phaseId: "P01" });
  append("workspace.checkpointed", { checkpoint: { kind: "runStartFingerprint", fingerprintDigest: "fp-base", emittedAt: "2026-01-01T00:00:10.000Z" } });
  append("attempt.started", {
    taskId: "T001",
    attemptId: "A001",
    ordinal: 1,
    strategyGeneration: 0,
    attemptBaseFingerprint: "fp-base",
    startedAt: "2026-01-01T00:00:20.000Z",
  }, { attemptId: "A001", taskId: "T001", phaseId: "P01" });
  append("executor.dispatch-authorized", {
    invocationId: "invocation-1",
    workUnitDigest: "work-unit-1",
    attemptBaseFingerprint: "fp-base",
    timeoutPolicyDigest: "timeout-policy-1",
    capabilityPolicyDigest: "capability-policy-1",
    authorizedAt: "2026-01-01T00:00:30.000Z",
  });
  append("executor.started", { invocationId: "invocation-1", startedAt: "2026-01-01T00:00:40.000Z" });
  append("executor.finished", { invocationId: "invocation-1", status: "SUCCEEDED", termination: "NORMAL", finishedAt: "2026-01-01T00:00:50.000Z" });
  append("evidence.capture-started", { evidenceCaptureId: "capture-1", postExecutorFingerprint: "fp-post", startedAt: "2026-01-01T00:01:00.000Z" });
  append("evidence.captured", { evidenceCaptureId: "capture-1", evidenceDigest: "evidence-digest-1", postExecutorFingerprint: "fp-post", capturedAt: "2026-01-01T00:01:10.000Z" });
  const spec = parseValidationSpec("`printf validation`", { taskId: "T001", planIdentity: PLAN_ID, ordinal: 1 });
  append("validation.started", { validationSpec: spec, validationRunId: "validation-run-1", validationRunOrdinal: 1, startedAt: "2026-01-01T00:01:20.000Z" });
  append("attempt.human-required", { reason: "human decision is required", proofRef: "human-request-proof" }, { attemptId: "A001", taskId: "T001", phaseId: "P01" });
  afterHumanRequired = cursor;
  append("run.hold-cleared", { previousHold: "HUMAN_REQUIRED", reason: "human decision was recorded", proofRef: "human-resolution-proof" });

  return {
    genesis,
    events,
    afterHumanRequired: afterHumanRequired!,
    afterClear: cursor,
  };
}

function closeAttempt(state: RalphRuntimeStateV2, closureReason: AttemptClosureReason): RalphRuntimeStateV2 {
  return applyEvent(state, "attempt.closed", {
    attemptId: "A001",
    closureReason,
    finishedAt: "2026-01-01T00:03:00.000Z",
  });
}

function auditReadyState(): {
  readonly state: RalphRuntimeStateV2;
  readonly spec: ReturnType<typeof parseValidationSpec>;
  readonly validationRun: NonNullable<AttemptStateV2["validationRuns"]>[number];
} {
  let state = attemptStartedState();
  state = dispatchAuthorizedState(state);
  state = applyEvent(state, "executor.started", {
    invocationId: "invocation-1",
    startedAt: "2026-01-01T00:00:40.000Z",
  });
  state = applyEvent(state, "executor.finished", {
    invocationId: "invocation-1",
    status: "SUCCEEDED",
    termination: "NORMAL",
    finishedAt: "2026-01-01T00:00:50.000Z",
  });
  state = applyEvent(state, "evidence.capture-started", {
    evidenceCaptureId: "capture-1",
    postExecutorFingerprint: "fp-post",
    startedAt: "2026-01-01T00:01:00.000Z",
  });
  state = applyEvent(state, "evidence.captured", {
    evidenceCaptureId: "capture-1",
    evidenceDigest: "evidence-digest-1",
    postExecutorFingerprint: "fp-post",
    capturedAt: "2026-01-01T00:01:10.000Z",
  });
  const spec = parseValidationSpec("`printf validation`", {
    taskId: "T001",
    planIdentity: PLAN_ID,
    ordinal: 1,
  });
  state = applyEvent(state, "validation.started", {
    validationSpec: spec,
    validationRunId: "validation-run-1",
    validationRunOrdinal: 1,
    startedAt: "2026-01-01T00:01:20.000Z",
  });
  const validationRun = {
    validationRunId: "validation-run-1",
    validationSpecId: spec.validationSpecId,
    validationSpecDigest: spec.digest,
    validationRunOrdinal: 1,
    startedAt: "2026-01-01T00:01:20.000Z",
    endedAt: "2026-01-01T00:01:30.000Z",
    outcome: "PASS" as const,
    exitCode: 0,
    resultDigest: "validation-result-digest-1",
  };
  state = applyEvent(state, "validation.completed", { validationRun });
  const attempt = openAttempt(state)!;
  const validationSummary = deterministicValidationSummary(attempt.validationSpecs, attempt.validationRuns);
  state = applyEvent(state, "attempt.audit-ready", {
    evidenceCaptureId: "capture-1",
    evidenceDigest: "evidence-digest-1",
    validationSetId: "validation-set-1",
    validationSetDigest: "validation-set-digest-1",
    auditPackageId: "audit-package-1",
    auditPackageDigest: "audit-package-digest-1",
    postExecutorFingerprint: "fp-post",
    criterionSetDigest: "criterion-set-digest-1",
    auditability: "AUDITABLE",
    validationSummary,
  });
  return { state, spec, validationRun };
}

function withTaskState(
  state: RalphRuntimeStateV2,
  taskId: string,
  patch: Partial<TaskState>,
): RalphRuntimeStateV2 {
  const task = state.tasks[taskId];
  if (!task) throw new Error(`missing task ${taskId}`);
  const tasks = { ...state.tasks, [taskId]: { ...task, ...patch } };
  const next = { ...state, tasks, phases: Object.fromEntries(Object.values(state.phases).map((phase) => {
    const phaseTasks = phase.taskIds.map((id) => tasks[id]).filter((entry): entry is TaskState => entry !== undefined);
    const complete = phaseTasks.length > 0 && phaseTasks.every((entry) => entry.disposition === "COMPLETE");
    const failed = phaseTasks.some((entry) => entry.disposition === "FAILED");
    const active = phaseTasks.some((entry) => entry.activity !== "IDLE");
    const ready = phaseTasks.some((entry) => entry.disposition === "READY" && entry.activity === "IDLE" && entry.hold === "NONE" && entry.owner === "NONE");
    const blocked = phaseTasks.some((entry) => entry.disposition === "BLOCKED" || entry.hold !== "NONE");
    return [phase.phaseId, {
      ...phase,
      disposition: complete ? "COMPLETE" : failed ? "FAILED" : !active && !ready && blocked ? "BLOCKED" : ready ? "READY" : "PENDING",
      activity: active ? "ACTIVE" : "IDLE",
    }];
  })) };
  assertV2RuntimeState(next);
  return next;
}

function expectNoCandidate(decision: SchedulerDecision): void {
  expect(decision.kind).not.toBe("CANDIDATE");
}

describe("RALPH Operational V2 Slice A identities and compatibility", () => {
  it("freezes the three V2 identities and the closed Attempt vocabularies", () => {
    expect(OPERATIONAL_CONTRACT_V2).toBe("rb-ralph-operational/v2");
    expect(EVENT_SCHEMA_V2).toBe("rb-ralph-event/v2");
    expect(STATE_SCHEMA_V2).toBe("rb-ralph-runtime-state/v2");
    expect(RALPH_V2_OPERATIONAL_CONTRACT).toBe(OPERATIONAL_CONTRACT_V2);
    expect(RALPH_V2_EVENT_SCHEMA).toBe(EVENT_SCHEMA_V2);
    expect(RALPH_V2_STATE_SCHEMA).toBe(STATE_SCHEMA_V2);
    expect(ATTEMPT_DISPOSITIONS).toEqual(["OPEN", "CLOSED"]);
    expect(ATTEMPT_STAGES).not.toContain("CLOSED");
    expect(ATTEMPT_STAGES).toEqual([
      "ADMITTED",
      "EXECUTOR_DISPATCH_AUTHORIZED",
      "EXECUTOR_RUNNING",
      "POST_EXECUTOR_CAPTURE",
      "EVIDENCE_CAPTURING",
      "VALIDATING",
      "AWAITING_HUMAN",
      "AWAITING_AUDIT",
      "AUDITING",
      "RECONCILING",
    ]);
    expect(ATTEMPT_CLOSURE_REASONS).not.toContain("VALIDATION_SEMANTIC_FAILURE");
    expect(AUDITABILITY_CLASSIFICATIONS).toEqual(["AUDITABLE", "NOT_AUDITABLE", "RECONCILIATION_REQUIRED"]);
    expect(RALPH_EVENT_TYPES_V2).not.toContain("scheduler.task-selected");
    expect(RALPH_EVENT_TYPES_V2).not.toContain("executor.failed");
  });

  it("binds a V2 Run to event, state, and operational identities", () => {
    const identity = createV2RunIdentity(RUN_ID);
    expect(identity).toEqual({
      runId: RUN_ID,
      eventSchema: EVENT_SCHEMA_V2,
      stateSchema: STATE_SCHEMA_V2,
      operationalContract: OPERATIONAL_CONTRACT_V2,
    });
    expect(() => assertV2RunIdentity({ ...identity, stateSchema: "rb-ralph-runtime-state/v1" })).toThrow();
    const state = createState();
    expect(() => assertV2RuntimeState({ ...state, eventSchema: "rb-ralph-event/v1" })).toThrow();
    expect(() => assertV2RuntimeState({ ...state, stateSchema: "rb-ralph-runtime-state/v1" })).toThrow();
    expect(() => assertV2RuntimeState({ ...state, operationalContract: "rb-ralph-operational/v1" })).toThrow();
  });

  it("keeps V1 replayable while rejecting V1/V2 mixing at both validators", () => {
    let state = createInitialRuntimeStateV1({ runId: "v1-run", phases: [], tasks: [] });
    const first = createRalphEventV1({
      eventId: "v1-created",
      eventType: "run.created",
      schemaVersion: V1_EVENT_SCHEMA,
      runId: "v1-run",
      sequence: 1,
      occurredAt: "2026-01-01T00:00:00.000Z",
      recordedAt: "2026-01-01T00:00:00.100Z",
      entity: { kind: "run", id: "v1-run" },
      actor: "CORE",
      causationId: null,
      correlationId: "v1-correlation",
      payload: { phaseIds: [], taskIds: [] },
      previousEventHash: null,
    });
    validateRalphEventV1(first);
    state = reduceRalphEventV1(state, first);
    const second = createRalphEventV1({
      eventId: "v1-started",
      eventType: "run.started",
      schemaVersion: V1_EVENT_SCHEMA,
      runId: "v1-run",
      sequence: 2,
      occurredAt: "2026-01-01T00:00:01.000Z",
      recordedAt: "2026-01-01T00:00:01.100Z",
      entity: { kind: "run", id: "v1-run" },
      actor: "CORE",
      causationId: null,
      correlationId: "v1-correlation",
      payload: {},
      previousEventHash: first.eventHash,
    });
    state = reduceRalphEventV1(state, second);
    expect(state.disposition).toBe("ACTIVE");

    const v2 = makeEvent(createState(), "run.created", { phaseIds: ["P01"], taskIds: ["T001"] });
    expect(() => validateRalphEventV1(v2 as never)).toThrow("RALPH_EVENT_UNSUPPORTED_SCHEMA");
    expect(() => reduceRalphEventV1(state, v2 as never)).toThrow("RALPH_EVENT_UNSUPPORTED_SCHEMA");
    expect(() => validateRalphEventV2(first as never)).toThrow("RALPH_V2_EVENT_UNSUPPORTED_SCHEMA");
    expect(() => validateV2EventSequence([v2, first as never])).toThrow();
  });

  it("rejects unknown closed-schema fields and event/entity mismatches", () => {
    const state = createState();
    const valid = makeEvent(state, "run.created", { phaseIds: ["P01"], taskIds: ["T001"] });
    expect(() => validateRalphEventV2({ ...valid, unexpected: true })).toThrow("RALPH_V2_EVENT_UNKNOWN_FIELD");
    expect(() => validateRalphEventV2({ ...valid, payload: { phaseIds: ["P01"], taskIds: ["T001"], unexpected: true } })).toThrow("RALPH_V2_EVENT_UNKNOWN_PAYLOAD_FIELD");
    expect(() => validateRalphEventV2({ ...valid, entity: { kind: "task", id: "T001" } })).toThrow("RALPH_V2_EVENT_ENTITY_KIND_MISMATCH");
    expect(() => validateRalphEventV2({ ...valid, entity: { kind: "run", id: "other-run" } })).toThrow("RALPH_V2_EVENT_ENTITY_ID_MISMATCH");

    const closure = makeEvent(state, "attempt.closed", {
      attemptId: "A001",
      closureReason: "AUDIT_ACCEPTED",
      finishedAt: "2026-01-01T00:01:00.000Z",
    }, { attemptId: "A001", taskId: "T001", phaseId: "P01" });
    expect(() => validateRalphEventV2({ ...closure, payload: { ...closure.payload, unexpected: true } })).toThrow("RALPH_V2_EVENT_UNKNOWN_PAYLOAD_FIELD");
    expect(() => validateRalphEventV2({
      ...closure,
      payload: { ...closure.payload, closureReason: "VALIDATION_SEMANTIC_FAILURE" },
    })).toThrow("RALPH_V2_EVENT_INVALID_CLOSURE_REASON");
  });

  it("accepts one independently specified fixture for every V2 event type", () => {
    const state = createState();
    const spec = parseValidationSpec("manual: inspect the result", { taskId: "T001", planIdentity: PLAN_ID, ordinal: 1 });
    const validationRun = {
      validationRunId: "validation-run-1",
      validationSpecId: spec.validationSpecId,
      validationSpecDigest: spec.digest,
      validationRunOrdinal: 1,
      startedAt: "2026-01-01T00:00:20.000Z",
      endedAt: "2026-01-01T00:00:30.000Z",
      outcome: "NOT_APPLICABLE" as const,
      exitCode: null,
      resultDigest: "validation-result-digest-1",
    };
    const finding = {
      id: "F001",
      criterionId: "C001",
      phaseId: "P01",
      taskId: "T001",
      scope: ["src"],
      severity: "LOW" as const,
      status: "OPEN" as const,
      expectation: "the declared result",
      observed: "not observed",
      evidenceRefs: [],
      openedAtAttempt: "A001",
    };
    const payloads: { readonly [TType in RalphEventTypeV2]: EventPayloadMapV2[TType] } = {
      "run.created": { phaseIds: ["P01"], taskIds: ["T001"] },
      "run.started": {},
      "run.hold-set": { hold: "PAUSED", reason: "operator pause" },
      "run.hold-cleared": { previousHold: "PAUSED", reason: "Core proof", proofRef: "proof-1" },
      "run.completed": { finalStatePersisted: true },
      "run.failed": { reason: "terminal infrastructure fact" },
      "task.state-changed": { disposition: "READY", activity: "IDLE", owner: "NONE", hold: "NONE" },
      "attempt.started": { taskId: "T001", attemptId: "A001", ordinal: 1, strategyGeneration: 0, attemptBaseFingerprint: "fp-base", startedAt: "2026-01-01T00:00:10.000Z" },
      "attempt.closed": { attemptId: "A001", closureReason: "AUDIT_ACCEPTED", finishedAt: "2026-01-01T00:00:40.000Z" },
      "finding.state-changed": { finding },
      "workspace.checkpointed": { checkpoint: { kind: "runStartFingerprint", fingerprintDigest: "fp-base", emittedAt: "2026-01-01T00:00:10.000Z" } },
      "workspace.drift-detected": { expectedFingerprint: "fp-base", observedFingerprint: "fp-other", reason: "changed" },
      "executor.dispatch-authorized": { invocationId: "invocation-1", workUnitDigest: "work-unit-1", attemptBaseFingerprint: "fp-base", timeoutPolicyDigest: "timeout-policy-1", capabilityPolicyDigest: "capability-policy-1", authorizedAt: "2026-01-01T00:00:10.000Z" },
      "executor.started": { invocationId: "invocation-1", startedAt: "2026-01-01T00:00:20.000Z" },
      "executor.finished": { invocationId: "invocation-1", status: "SUCCEEDED", termination: "NORMAL", finishedAt: "2026-01-01T00:00:30.000Z" },
      "evidence.capture-started": { evidenceCaptureId: "capture-1", postExecutorFingerprint: "fp-post", startedAt: "2026-01-01T00:00:40.000Z" },
      "evidence.captured": { evidenceCaptureId: "capture-1", evidenceDigest: "evidence-digest-1", postExecutorFingerprint: "fp-post", capturedAt: "2026-01-01T00:00:50.000Z" },
      "validation.started": { validationSpec: spec, validationRunId: "validation-run-1", validationRunOrdinal: 1, startedAt: "2026-01-01T00:01:00.000Z" },
      "validation.completed": { validationRun },
      "attempt.human-required": { reason: "human fact", proofRef: "proof-human" },
      "attempt.audit-ready": { evidenceCaptureId: "capture-1", evidenceDigest: "evidence-digest-1", validationSetId: "validation-set-1", validationSetDigest: "validation-set-digest-1", auditPackageId: "audit-package-1", auditPackageDigest: "audit-package-digest-1", postExecutorFingerprint: "fp-post", criterionSetDigest: "criterion-set-digest-1", auditability: "AUDITABLE", validationSummary: { total: 1, completed: 1, passed: 0, failed: 0, notApplicable: 1, infrastructureFailures: 0, manualRequired: 1, humanRequired: 0, hardNegative: false } },
      "attempt.reconciliation-required": { reason: "reconciliation fact", proofRef: "proof-reconciliation" },
      "audit.started": { auditPackageId: "audit-package-1", auditPackageDigest: "audit-package-digest-1", startedAt: "2026-01-01T00:01:10.000Z" },
    };
    for (const eventType of RALPH_EVENT_TYPES_V2) {
      const options: EventOptions = V2_EVENT_ENTITY_KINDS[eventType] === "attempt"
        ? { attemptId: "A001", taskId: "T001", phaseId: "P01" }
        : {};
      const event = makeEvent(state, eventType, payloads[eventType] as never, options);
      expect(() => validateRalphEventV2(event), eventType).not.toThrow();
    }
  });

  it("enforces persisted Task/Attempt/Phase relations at the reducer boundary", () => {
    const state = attemptStartedState();
    const attempt = openAttempt(state)!;
    const event = makeEvent(state, "executor.dispatch-authorized", {
      invocationId: "invocation-1",
      workUnitDigest: "work-unit-1",
      attemptBaseFingerprint: "fp-base",
      timeoutPolicyDigest: "timeout-policy-1",
      capabilityPolicyDigest: "capability-policy-1",
      authorizedAt: "2026-01-01T00:00:30.000Z",
    }, { attemptId: attempt.attemptId, taskId: "T999", phaseId: attempt.phaseId });
    expect(() => reduceRalphEventV2(state, event)).toThrow("RALPH_V2_ATTEMPT_RELATION_MISMATCH");

    const foreign = makeEvent(state, "run.started", {}, { runId: "other-run", entityId: "other-run" });
    expect(() => reduceRalphEventV2(state, foreign)).toThrow("RALPH_V2_REDUCER_FOREIGN_RUN");
    const gap = makeEvent(state, "run.started", {}, { sequence: state.lastSequence + 2 });
    expect(() => reduceRalphEventV2(state, gap)).toThrow("RALPH_V2_REDUCER_SEQUENCE_MISMATCH");
  });
});

describe("RALPH Operational V2 event schema and Attempt lifecycle", () => {
  it("accepts the complete synthetic operational vocabulary through the V2 envelope", () => {
    const lifecycle = auditReadyState();
    const state = lifecycle.state;
    expect(state.attempts.A001?.stage).toBe("AWAITING_AUDIT");
    expect(state.attempts.A001?.disposition).toBe("OPEN");
    expect(state.lastSequence).toBe(13);
    expect(state.lastEventHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("replays the full lifecycle deterministically and preserves the last observable stage on close", () => {
    const lifecycle = auditReadyState();
    let state = lifecycle.state;
    state = applyEvent(state, "audit.started", {
      auditPackageId: "audit-package-1",
      auditPackageDigest: "audit-package-digest-1",
      startedAt: "2026-01-01T00:02:00.000Z",
    }, { actor: "AUDITOR" });
    expect(state.attempts.A001?.stage).toBe("AUDITING");
    expect(state.tasks.T001).toMatchObject({ disposition: "READY", activity: "AUDITING", owner: "AUDITOR", hold: "NONE" });
    state = applyEvent(state, "attempt.closed", {
      attemptId: "A001",
      closureReason: "AUDIT_ACCEPTED",
      finishedAt: "2026-01-01T00:02:10.000Z",
    });
    expect(state.attempts.A001).toMatchObject({ disposition: "CLOSED", stage: "AUDITING", closureReason: "AUDIT_ACCEPTED" });
    expect(state.tasks.T001).toMatchObject({ activity: "IDLE", owner: "NONE", hold: "NONE", currentAttemptId: "A001" });

    const replayed = replayV2Events(createState(), buildEventsFromState(state));
    expect(replayed).toEqual(state);
  });

  it("enforces lifecycle ordering and terminality", () => {
    let state = attemptStartedState();
    const dispatchPayload = {
      invocationId: "invocation-1",
      workUnitDigest: "work-unit-1",
      attemptBaseFingerprint: "fp-base",
      timeoutPolicyDigest: "timeout-policy-1",
      capabilityPolicyDigest: "capability-policy-1",
      authorizedAt: "2026-01-01T00:00:30.000Z",
    };
    expect(() => applyEvent(state, "executor.started", { invocationId: "invocation-1", startedAt: "2026-01-01T00:00:40.000Z" })).toThrow("RALPH_V2_EXECUTOR_STARTED_BEFORE_AUTHORIZATION");
    expect(() => applyEvent(state, "executor.finished", { invocationId: "invocation-1", status: "SUCCEEDED", termination: "NORMAL", finishedAt: "2026-01-01T00:00:50.000Z" })).toThrow("RALPH_V2_EXECUTOR_FINISHED_BEFORE_STARTED");
    expect(() => applyEvent(state, "validation.started", {
      validationSpec: parseValidationSpec("`printf validation`", { taskId: "T001", planIdentity: PLAN_ID, ordinal: 1 }),
      validationRunId: "validation-run-1",
      validationRunOrdinal: 1,
      startedAt: "2026-01-01T00:01:00.000Z",
    })).toThrow("RALPH_V2_VALIDATION_STARTED_STAGE_INVALID");
    expect(() => applyEvent(state, "audit.started", { auditPackageId: "package", auditPackageDigest: "digest", startedAt: "2026-01-01T00:01:00.000Z" })).toThrow("RALPH_V2_AUDIT_STARTED_BEFORE_AUDIT_READY");

    state = applyEvent(state, "executor.dispatch-authorized", dispatchPayload);
    expect(() => applyEvent(state, "executor.finished", { invocationId: "invocation-1", status: "SUCCEEDED", termination: "NORMAL", finishedAt: "2026-01-01T00:00:50.000Z" })).toThrow("RALPH_V2_EXECUTOR_FINISHED_BEFORE_STARTED");
    state = applyEvent(state, "executor.started", { invocationId: "invocation-1", startedAt: "2026-01-01T00:00:40.000Z" });
    state = applyEvent(state, "executor.finished", { invocationId: "invocation-1", status: "SUCCEEDED", termination: "NORMAL", finishedAt: "2026-01-01T00:00:50.000Z" });
    expect(() => applyEvent(state, "evidence.captured", { evidenceCaptureId: "capture-1", evidenceDigest: "digest", postExecutorFingerprint: "fp-post", capturedAt: "2026-01-01T00:01:10.000Z" })).toThrow("RALPH_V2_CAPTURE_COMPLETED_BEFORE_START");
  });

  it("enforces closureReason × AttemptStage through real reducer transitions and state validation", () => {
    const auditing = () => applyEvent(auditReadyState().state, "audit.started", {
      auditPackageId: "audit-package-1",
      auditPackageDigest: "audit-package-digest-1",
      startedAt: "2026-01-01T00:02:00.000Z",
    }, { actor: "AUDITOR" });
    const auditReasons = ["AUDIT_ACCEPTED", "AUDIT_REJECTED"] as const;
    for (const closureReason of auditReasons) {
      const closed = closeAttempt(auditing(), closureReason);
      expect(closed.attempts.A001).toMatchObject({ disposition: "CLOSED", stage: "AUDITING", closureReason });
      for (const incompatible of [attemptStartedState(), validationStartedState(), auditReadyState().state]) {
        expect(() => closeAttempt(incompatible, closureReason)).toThrow("RALPH_V2_INVALID_CLOSURE_STATE");
      }
    }

    const validationExhausted = closeAttempt(validationStartedState(), "VALIDATION_INFRASTRUCTURE_EXHAUSTED");
    expect(validationExhausted.attempts.A001).toMatchObject({ disposition: "CLOSED", stage: "VALIDATING", closureReason: "VALIDATION_INFRASTRUCTURE_EXHAUSTED" });
    expect(validationExhausted.tasks.T001?.hold).toBe("RETRY_BUDGET_EXHAUSTED");
    expect(() => closeAttempt(attemptStartedState(), "VALIDATION_INFRASTRUCTURE_EXHAUSTED")).toThrow("RALPH_V2_INVALID_CLOSURE_STATE");
    expect(() => closeAttempt(executorRunningState(), "VALIDATION_INFRASTRUCTURE_EXHAUSTED")).toThrow("RALPH_V2_INVALID_CLOSURE_STATE");
    expect(() => closeAttempt(auditReadyState().state, "VALIDATION_INFRASTRUCTURE_EXHAUSTED")).toThrow("RALPH_V2_INVALID_CLOSURE_STATE");

    expect(closeAttempt(attemptStartedState(), "EXECUTOR_UNAVAILABLE").attempts.A001).toMatchObject({ disposition: "CLOSED", stage: "ADMITTED" });
    expect(closeAttempt(dispatchAuthorizedState(attemptStartedState()), "EXECUTOR_UNAVAILABLE").attempts.A001).toMatchObject({ disposition: "CLOSED", stage: "EXECUTOR_DISPATCH_AUTHORIZED" });
    expect(() => closeAttempt(auditReadyState().state, "EXECUTOR_UNAVAILABLE")).toThrow("RALPH_V2_INVALID_CLOSURE_STATE");

    for (const closureReason of ["CONTROL_PLANE_VIOLATION", "RECONCILIATION_REQUIRED"] as const) {
      expect(closeAttempt(attemptStartedState(), closureReason).attempts.A001).toMatchObject({ disposition: "CLOSED", closureReason });
      expect(closeAttempt(auditReadyState().state, closureReason).attempts.A001).toMatchObject({ disposition: "CLOSED", stage: "AWAITING_AUDIT", closureReason });
    }

    const validClosed = closeAttempt(attemptStartedState(), "EXECUTOR_UNAVAILABLE");
    expect(() => assertV2RuntimeState({
      ...validClosed,
      attempts: { ...validClosed.attempts, A001: { ...validClosed.attempts.A001!, closureReason: "AUDIT_ACCEPTED" } },
    })).toThrow("RALPH_V2_INVALID_CLOSURE_STATE");
  });

  it("rejects audit-ready without complete typed references", () => {
    const state = attemptStartedState();
    expect(() => applyEvent(state, "attempt.audit-ready", {
      evidenceCaptureId: "capture-1",
      evidenceDigest: "evidence-digest-1",
      validationSetId: "validation-set-1",
      validationSetDigest: "validation-set-digest-1",
      auditPackageId: "audit-package-1",
      auditPackageDigest: "audit-package-digest-1",
      postExecutorFingerprint: "fp-post",
      criterionSetDigest: "criterion-set-digest-1",
      auditability: "AUDITABLE",
      validationSummary: {
        total: 0,
        completed: 0,
        passed: 0,
        failed: 0,
        notApplicable: 0,
        infrastructureFailures: 0,
        manualRequired: 0,
        humanRequired: 0,
        hardNegative: false,
      },
    })).toThrow("RALPH_V2_AUDIT_READY_STAGE_INVALID");
  });

  it("keeps AWAITING_AUDIT at the exact pre-Auditor Task boundary", () => {
    const lifecycle = auditReadyState();
    const state = lifecycle.state;
    expect(state.attempts.A001).toMatchObject({ disposition: "OPEN", stage: "AWAITING_AUDIT", recovery: { kind: "NONE" } });
    expect(state.tasks.T001).toMatchObject({
      disposition: "READY",
      activity: "IDLE",
      owner: "NONE",
      hold: "NONE",
      currentAttemptId: "A001",
    });
    expect(() => assertV2RuntimeState({
      ...state,
      tasks: { ...state.tasks, T001: { ...state.tasks.T001!, activity: "AUDITING", owner: "AUDITOR" } },
    })).toThrow("RALPH_V2_AWAITING_AUDIT_TASK_BOUNDARY_INVALID");

    const audited = applyEvent(state, "audit.started", {
      auditPackageId: "audit-package-1",
      auditPackageDigest: "audit-package-digest-1",
      startedAt: "2026-01-01T00:02:00.000Z",
    }, { actor: "AUDITOR" });
    expect(audited.tasks.T001).toMatchObject({ activity: "AUDITING", owner: "AUDITOR" });
  });

  it("resumes the same Attempt atomically when a HUMAN_REQUIRED hold is cleared", () => {
    let human = applyEvent(validationStartedState(), "attempt.human-required", {
      reason: "external human evidence is required",
      proofRef: "proof-human-1",
    });
    expect(human).toMatchObject({ hold: "HUMAN_REQUIRED" });
    expect(human.attempts.A001).toMatchObject({ disposition: "OPEN", stage: "AWAITING_HUMAN", recovery: { kind: "HUMAN_REQUIRED", proofRef: "proof-human-1" } });
    expect(human.tasks.T001).toMatchObject({ disposition: "READY", activity: "IDLE", owner: "NONE", hold: "HUMAN_REQUIRED" });
    human = applyEvent(human, "run.hold-cleared", { previousHold: "HUMAN_REQUIRED", reason: "Core verified the human handoff", proofRef: "clear-proof-human-1" });
    expect(human.hold).toBe("NONE");
    expect(human.attempts.A001).toMatchObject({ disposition: "OPEN", stage: "VALIDATING" });
    expect(human.attempts.A001?.recovery).toEqual({ kind: "NONE" });
    expect(human.tasks.T001).toMatchObject({ disposition: "READY", activity: "VALIDATING", owner: "CORE", hold: "NONE", currentAttemptId: "A001" });
    expect(human.attempts.A001?.validationRuns).toHaveLength(1);
    expect(human.attempts.A001?.validationSet).toBeUndefined();
    expect(human.attempts.A001?.auditPackage).toBeUndefined();
    expect(human.tasks.T001?.disposition).not.toBe("COMPLETE");
    expect(() => applyEvent(human, "run.hold-cleared", { previousHold: "HUMAN_REQUIRED", reason: "arbitrary", proofRef: "proof" })).toThrow("RALPH_V2_INVALID_RUN_HOLD_CLEAR");

    let reconciliation = applyEvent(attemptStartedState(), "attempt.reconciliation-required", {
      reason: "workspace observation is ambiguous",
      proofRef: "proof-reconciliation-1",
    });
    expect(reconciliation).toMatchObject({ hold: "RECONCILIATION_REQUIRED" });
    expect(reconciliation.attempts.A001).toMatchObject({ disposition: "OPEN", stage: "RECONCILING", recovery: { kind: "RECONCILIATION_REQUIRED", proofRef: "proof-reconciliation-1" } });
    expect(reconciliation.tasks.T001).toMatchObject({ activity: "RECONCILING", owner: "CORE", hold: "WORKSPACE_DRIFT" });
    reconciliation = applyEvent(reconciliation, "run.hold-cleared", { previousHold: "RECONCILIATION_REQUIRED", reason: "Core verified reconciliation proof", proofRef: "clear-proof-reconciliation-1" });
    expect(reconciliation.hold).toBe("NONE");
    expect(reconciliation.attempts.A001?.stage).toBe("RECONCILING");
    expect(reconciliation.tasks.T001).toMatchObject({ activity: "RECONCILING", owner: "CORE", hold: "WORKSPACE_DRIFT" });
  });

  it("resumes the validated human lifecycle through one replayable event", () => {
    const lifecycle = humanResumeLifecycle();
    const held = lifecycle.afterHumanRequired;
    const cleared = lifecycle.afterClear;

    expect(held).toMatchObject({ hold: "HUMAN_REQUIRED" });
    expect(held.attempts.A001).toMatchObject({
      disposition: "OPEN",
      stage: "AWAITING_HUMAN",
      recovery: { kind: "HUMAN_REQUIRED", proofRef: "human-request-proof" },
    });
    expect(held.tasks.T001).toMatchObject({
      disposition: "READY",
      activity: "IDLE",
      owner: "NONE",
      hold: "HUMAN_REQUIRED",
      currentAttemptId: "A001",
    });

    expect(() => assertV2RuntimeState({ ...held, hold: "NONE" })).toThrow("RALPH_V2_HUMAN_ATTEMPT_RUN_HOLD_MISMATCH");
    expect(() => assertV2RuntimeState(cleared)).not.toThrow();
    expect(cleared).toMatchObject({ hold: "NONE" });
    expect(cleared.attempts.A001).toMatchObject({
      disposition: "OPEN",
      stage: "VALIDATING",
      recovery: { kind: "NONE" },
    });
    expect(cleared.attempts.A001?.recovery).toEqual({ kind: "NONE" });
    expect(cleared.attempts.A001?.recovery).not.toHaveProperty("proofRef");
    expect(() => assertV2RuntimeState({
      ...cleared,
      attempts: { ...cleared.attempts, A001: { ...cleared.attempts.A001!, recovery: { kind: "NONE", proofRef: "duplicated-clear-proof" } } },
    } as RalphRuntimeStateV2)).toThrow("RALPH_V2_NONE_RECOVERY_HAS_DETAILS");
    expect(cleared.tasks.T001).toMatchObject({
      disposition: "READY",
      activity: "VALIDATING",
      owner: "CORE",
      hold: "NONE",
      currentAttemptId: "A001",
    });
    expect(cleared.attempts.A001?.attemptId).toBe(held.attempts.A001?.attemptId);
    expect(cleared.attempts.A001?.validationRuns).toEqual(held.attempts.A001?.validationRuns);
  });

  it("does not synthesize a validation result or downstream completion while resuming", () => {
    const lifecycle = humanResumeLifecycle();
    const cleared = lifecycle.afterClear;
    const attempt = cleared.attempts.A001!;
    const eventTypes = lifecycle.events.map((event) => event.eventType);

    expect(attempt.disposition).toBe("OPEN");
    expect(attempt.validationRuns).toHaveLength(1);
    expect(attempt.validationRuns[0]?.outcome).toBe("PENDING");
    expect(attempt.validationSet).toBeUndefined();
    expect(attempt.auditPackage).toBeUndefined();
    expect(cleared.tasks.T001?.disposition).not.toBe("COMPLETE");
    expect(eventTypes).not.toContain("validation.completed");
    expect(eventTypes).not.toContain("attempt.audit-ready");
    expect(eventTypes).not.toContain("audit.started");
    expect(eventTypes).not.toContain("attempt.closed");
    expect(eventTypes).not.toContain("run.completed");
  });

  it("preserves generic non-human hold clearing without changing Attempt or Task", () => {
    let held = applyEvent(validationStartedState(), "run.hold-set", { hold: "PAUSED", reason: "operator pause" });
    const attemptBefore = held.attempts.A001;
    const taskBefore = held.tasks.T001;
    held = applyEvent(held, "run.hold-cleared", { previousHold: "PAUSED", reason: "operator resumed", proofRef: "pause-clear-proof" });

    expect(held.hold).toBe("NONE");
    expect(held.attempts.A001).toEqual(attemptBefore);
    expect(held.tasks.T001).toEqual(taskBefore);
    expect(held.attempts.A001?.stage).toBe("VALIDATING");
    expect(held.tasks.T001).toMatchObject({ activity: "VALIDATING", owner: "CORE", hold: "NONE" });
  });

  it("clears a global HUMAN_REQUIRED hold when there is no OPEN Attempt", () => {
    let held = applyEvent(startedState(), "run.hold-set", { hold: "HUMAN_REQUIRED", reason: "global human decision" });
    expect(() => assertV2RuntimeState(held)).not.toThrow();
    const attemptsBefore = held.attempts;
    const tasksBefore = held.tasks;
    held = applyEvent(held, "run.hold-cleared", {
      previousHold: "HUMAN_REQUIRED",
      reason: "global human decision resolved",
      proofRef: "global-human-clear-proof",
    });

    expect(held.hold).toBe("NONE");
    expect(held.attempts).toEqual(attemptsBefore);
    expect(held.tasks).toEqual(tasksBefore);
    expect(openAttempt(held)).toBeUndefined();
  });

  it("clears a global HUMAN_REQUIRED hold without resuming a mid-flight EXECUTOR_RUNNING Attempt", () => {
    let held = applyEvent(executorRunningState(), "run.hold-set", { hold: "HUMAN_REQUIRED", reason: "global human decision" });
    const attemptBefore = held.attempts.A001;
    const taskBefore = held.tasks.T001;
    held = applyEvent(held, "run.hold-cleared", {
      previousHold: "HUMAN_REQUIRED",
      reason: "global human decision resolved",
      proofRef: "mid-flight-human-clear-proof",
    });

    expect(held.hold).toBe("NONE");
    expect(held.attempts.A001).toEqual(attemptBefore);
    expect(held.tasks.T001).toEqual(taskBefore);
    expect(held.attempts.A001?.stage).toBe("EXECUTOR_RUNNING");
    expect(held.tasks.T001).toMatchObject({ disposition: "READY", activity: "EXECUTING", owner: "EXECUTOR", hold: "NONE" });
  });

  it("clears the remaining global HUMAN_REQUIRED hold after the former human Attempt is closed", () => {
    const held = applyEvent(validationStartedState(), "attempt.human-required", {
      reason: "external human evidence is required",
      proofRef: "human-request-proof",
    });
    const closed = closeAttempt(held, "BUDGET_EXHAUSTED");
    expect(closed).toMatchObject({ hold: "HUMAN_REQUIRED" });
    expect(closed.attempts.A001).toMatchObject({
      disposition: "CLOSED",
      stage: "AWAITING_HUMAN",
      closureReason: "BUDGET_EXHAUSTED",
      recovery: { kind: "NONE" },
    });
    expect(closed.tasks.T001).toMatchObject({ activity: "IDLE", owner: "NONE", hold: "HUMAN_REQUIRED", currentAttemptId: "A001" });

    const attemptBefore = closed.attempts.A001;
    const taskBefore = closed.tasks.T001;
    const cleared = applyEvent(closed, "run.hold-cleared", {
      previousHold: "HUMAN_REQUIRED",
      reason: "closed human Attempt no longer needs a Run hold",
      proofRef: "closed-human-clear-proof",
    });

    expect(cleared.hold).toBe("NONE");
    expect(cleared.attempts.A001).toEqual(attemptBefore);
    expect(cleared.tasks.T001).toEqual(taskBefore);
    expect(cleared.attempts.A001?.disposition).toBe("CLOSED");
    expect(cleared.attempts.A001?.stage).toBe("AWAITING_HUMAN");
    expect(cleared.tasks.T001?.activity).not.toBe("VALIDATING");
    expect(openAttempt(cleared)).toBeUndefined();
  });

  it("fails closed for every invalid HUMAN_REQUIRED resume precondition", () => {
    const clearPayload = { previousHold: "HUMAN_REQUIRED" as const, reason: "human resolved", proofRef: "clear-proof" };

    const wrongStage = applyEvent(validationStartedState(), "run.hold-set", { hold: "HUMAN_REQUIRED", reason: "global human hold" });
    const wrongStageAttempt = wrongStage.attempts.A001;
    const wrongStageTask = wrongStage.tasks.T001;
    const globallyCleared = applyEvent(wrongStage, "run.hold-cleared", clearPayload);
    expect(globallyCleared.hold).toBe("NONE");
    expect(globallyCleared.attempts.A001).toEqual(wrongStageAttempt);
    expect(globallyCleared.tasks.T001).toEqual(wrongStageTask);

    const human = humanResumeLifecycle().afterHumanRequired;
    const currentAttemptMismatch = {
      ...human,
      tasks: { ...human.tasks, T001: { ...human.tasks.T001!, currentAttemptId: "A999" } },
    } as RalphRuntimeStateV2;
    expect(() => applyEvent(currentAttemptMismatch, "run.hold-cleared", clearPayload)).toThrow("RALPH_V2_TASK_ATTEMPT_RELATION_MISMATCH");

    const taskHoldMismatch = {
      ...human,
      tasks: { ...human.tasks, T001: { ...human.tasks.T001!, hold: "NONE" } },
    } as RalphRuntimeStateV2;
    expect(() => applyEvent(taskHoldMismatch, "run.hold-cleared", clearPayload)).toThrow("RALPH_V2_HUMAN_ATTEMPT_TASK_PROJECTION_INVALID");

    expect(() => applyEvent(validationStartedState(), "run.hold-cleared", clearPayload)).toThrow("RALPH_V2_INVALID_RUN_HOLD_CLEAR");
    expect(() => applyEvent(human, "run.hold-cleared", { ...clearPayload, previousHold: "PAUSED" })).toThrow("RALPH_V2_INVALID_RUN_HOLD_CLEAR");
    expect(() => applyEvent(human, "run.hold-cleared", clearPayload, { actor: "HUMAN" })).toThrow("RALPH_V2_INVALID_RUN_HOLD_CLEAR");
    expect(() => applyEvent(human, "run.hold-cleared", { ...clearPayload, proofRef: "" })).toThrow("RALPH_V2_EVENT_INVALID_PAYLOAD");
    expect(() => applyEvent(human, "run.hold-cleared", { previousHold: "HUMAN_REQUIRED", reason: "human resolved" } as never)).toThrow("RALPH_V2_EVENT_MISSING_PAYLOAD_FIELD: proofRef");
  });

  it("replays the durable event sequence to the identical post-clear state", () => {
    const lifecycle = humanResumeLifecycle();
    validateV2EventSequence(lifecycle.events, RUN_ID);
    const replayed = replayV2Events(lifecycle.genesis, lifecycle.events);

    expect(replayed).toEqual(lifecycle.afterClear);
    expect(replayV2Events(lifecycle.genesis, lifecycle.events)).toEqual(replayed);
    expect(replayed.lastSequence).toBe(13);
    expect(replayed.lastEventHash).toBe(lifecycle.events[lifecycle.events.length - 1]?.eventHash);
  });
});

describe("RALPH Operational V2 ValidationSpec descriptors", () => {
  it("preserves COMMAND, MANUAL, and HUMAN declarations without inventing argv", () => {
    const command = parseValidationSpec("`npm test`", { taskId: "T001", planIdentity: PLAN_ID, ordinal: 1 });
    const manual = parseValidationSpec("manual: inspect the rendered result", { taskId: "T001", planIdentity: PLAN_ID, ordinal: 2 });
    const human = parseValidationSpec("human: attach the external approval", { taskId: "T001", planIdentity: PLAN_ID, ordinal: 3 });
    expect(command).toMatchObject({ kind: "COMMAND", instruction: "npm test", sourceTaskId: "T001", sourcePlanIdentity: PLAN_ID });
    expect(manual).toMatchObject({ kind: "MANUAL", instruction: "inspect the rendered result" });
    expect(human).toMatchObject({ kind: "HUMAN", instruction: "attach the external approval" });
    expect(command).not.toHaveProperty("argv");
    expect(manual).not.toHaveProperty("command");
    expect(human).not.toHaveProperty("command");
    expect(validationInstructionKind("manual: inspect")).toBe("MANUAL");
    const descriptors = validationSpecsForTask({ id: "T001", validation: ["`npm test`", "manual: inspect"] }, PLAN_ID);
    expect(descriptors.map((descriptor) => descriptor.ordinal)).toEqual([1, 2]);
    expect(descriptors[0]?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("RALPH Operational V2 pure sequential Scheduler", () => {
  it("selects the first eligible Task in validated document order and returns at most one", () => {
    const plan = executionPlan([planPhase(1, "P01", [
      planTask("T001", "P01", [], { parallelSafe: true }),
      planTask("T002", "P01", [], { parallelSafe: true }),
    ])]);
    const state = readyState(plan);
    const decision = scheduleNextTask({ plan, state });
    expect(decision).toEqual({
      kind: "CANDIDATE",
      reason: "FIRST_ELIGIBLE_TASK_IN_PLAN_ORDER",
      candidate: { taskId: "T001", phaseId: "P01", reason: "FIRST_ELIGIBLE_TASK_IN_PLAN_ORDER", parallelSafe: true },
    });
    expect(decision.kind === "CANDIDATE" ? decision.candidate.taskId : undefined).toBe("T001");
  });

  it("waits on incomplete dependencies and distinguishes terminal dependency failure", () => {
    const plan = executionPlan([planPhase(1, "P01", [
      planTask("T001", "P01"),
      planTask("T002", "P01", ["T001"]),
    ])]);
    const pending = readyState(plan, ["T002"]);
    expect(scheduleNextTask({ plan, state: pending })).toMatchObject({ kind: "WAITING" });
    const failed = withTaskState(pending, "T001", { disposition: "FAILED", activity: "IDLE", owner: "NONE", hold: "NONE" });
    expect(scheduleNextTask({ plan, state: failed })).toMatchObject({ kind: "BLOCKED" });
  });

  it("enforces sequential phase dependencies and never treats plan done:true as runtime completion", () => {
    const plan = executionPlan([
      planPhase(1, "P01", [planTask("T001", "P01", [], { done: true })]),
      planPhase(2, "P02", [planTask("T002", "P02")], ["P01"]),
    ]);
    const state = readyState(plan, ["T001", "T002"]);
    expect(scheduleNextTask({ plan, state })).toMatchObject({ kind: "CANDIDATE", candidate: { taskId: "T001" } });
    const phaseTwoReady = withTaskState(state, "T001", { disposition: "COMPLETE", activity: "IDLE", owner: "NONE", hold: "NONE" });
    expect(scheduleNextTask({ plan, state: phaseTwoReady })).toMatchObject({ kind: "CANDIDATE", candidate: { taskId: "T002", phaseId: "P02" } });
    expect(phaseTwoReady.disposition).toBe("ACTIVE");
    expect(phaseTwoReady.tasks.T001?.disposition).toBe("COMPLETE");
  });

  it("separates the sequential phase barrier from explicit phase dependencies", () => {
    const independentPhases = executionPlan([
      planPhase(1, "P01", [planTask("T001", "P01", [], { parallelSafe: true })]),
      planPhase(2, "P02", [planTask("T002", "P02", [], { parallelSafe: true })]),
    ]);
    const phaseOneIncomplete = readyState(independentPhases, ["T002"]);
    expect(independentPhases.phases[1]?.dependsOn).toEqual([]);
    expect(scheduleNextTask({ plan: independentPhases, state: phaseOneIncomplete })).toEqual({
      kind: "WAITING",
      reason: "PREVIOUS_PHASE_INCOMPLETE",
      phaseId: "P02",
      dependencyId: "P01",
    });

    const phaseOneComplete = withTaskState(phaseOneIncomplete, "T001", {
      disposition: "COMPLETE",
      activity: "IDLE",
      owner: "NONE",
      hold: "NONE",
    });
    expect(scheduleNextTask({ plan: independentPhases, state: phaseOneComplete })).toEqual({
      kind: "CANDIDATE",
      reason: "FIRST_ELIGIBLE_TASK_IN_PLAN_ORDER",
      candidate: { taskId: "T002", phaseId: "P02", reason: "FIRST_ELIGIBLE_TASK_IN_PLAN_ORDER", parallelSafe: true },
    });

    for (const terminalState of ["FAILED", "BLOCKED"] as const) {
      const phaseOneTerminal = withTaskState(phaseOneIncomplete, "T001", terminalState === "FAILED"
        ? { disposition: "FAILED", activity: "IDLE", owner: "NONE", hold: "NONE" }
        : { disposition: "BLOCKED", activity: "IDLE", owner: "NONE", hold: "DEPENDENCY_UNAVAILABLE" });
      expect(scheduleNextTask({ plan: independentPhases, state: phaseOneTerminal })).toEqual({
        kind: "BLOCKED",
        reason: "PREVIOUS_PHASE_TERMINALLY_UNAVAILABLE",
        phaseId: "P02",
        dependencyId: "P01",
      });
    }

    const explicitDependency = executionPlan([
      planPhase(1, "P01", [planTask("T001", "P01", [], { parallelSafe: true })]),
      planPhase(2, "P02", [planTask("T002", "P02", [], { parallelSafe: true })], ["P01"]),
    ]);
    const explicitDependencySatisfied = withTaskState(readyState(explicitDependency), "T001", {
      disposition: "COMPLETE",
      activity: "IDLE",
      owner: "NONE",
      hold: "NONE",
    });
    expect(explicitDependency.phases[1]?.dependsOn).toEqual(["P01"]);
    expect(scheduleNextTask({ plan: explicitDependency, state: explicitDependencySatisfied })).toMatchObject({
      kind: "CANDIDATE",
      candidate: { taskId: "T002", phaseId: "P02", parallelSafe: true },
    });

    const threePhases = executionPlan([
      planPhase(1, "P01", [planTask("T001", "P01", [], { parallelSafe: true })]),
      planPhase(2, "P02", [planTask("T002", "P02", [], { parallelSafe: true })]),
      planPhase(3, "P03", [planTask("T003", "P03", [], { parallelSafe: true })]),
    ]);
    const phaseTwoIncomplete = withTaskState(readyState(threePhases, ["T003"]), "T001", {
      disposition: "COMPLETE",
      activity: "IDLE",
      owner: "NONE",
      hold: "NONE",
    });
    expect(scheduleNextTask({ plan: threePhases, state: phaseTwoIncomplete })).toMatchObject({
      kind: "WAITING",
      reason: "PREVIOUS_PHASE_INCOMPLETE",
      phaseId: "P03",
      dependencyId: "P02",
    });
    expectNoCandidate(scheduleNextTask({ plan: threePhases, state: phaseTwoIncomplete }));
  });

  it("blocks on Run/task holds, busy ownership, terminal tasks, and exhausted budget", () => {
    const plan = singlePlan();
    const state = readyState(plan);
    const runHeld = applyEvent(state, "run.hold-set", { hold: "PAUSED", reason: "operator pause" });
    expectNoCandidate(scheduleNextTask({ plan, state: runHeld }));
    expect(scheduleNextTask({ plan, state: runHeld })).toMatchObject({ kind: "HOLD", hold: "PAUSED" });
    expect(scheduleNextTask({ plan, state: withTaskState(state, "T001", { hold: "HUMAN_REQUIRED" }) })).toMatchObject({ kind: "HOLD", hold: "HUMAN_REQUIRED" });
    expect(scheduleNextTask({ plan, state: withTaskState(state, "T001", { activity: "VALIDATING", owner: "CORE" }) })).toMatchObject({ kind: "HOLD", reason: "TASK_NOT_IDLE_OR_UNOWNED" });
    expect(scheduleNextTask({ plan, state: withTaskState(state, "T001", { owner: "CORE" }) })).toMatchObject({ kind: "HOLD", reason: "TASK_NOT_IDLE_OR_UNOWNED" });
    expectNoCandidate(scheduleNextTask({ plan, state: withTaskState(state, "T001", { disposition: "COMPLETE" }) }));
    expectNoCandidate(scheduleNextTask({ plan, state: withTaskState(state, "T001", { disposition: "FAILED" }) }));
    expect(scheduleNextTask({ plan, state, budget: { exhausted: true, reason: "attempt retry budget exhausted" } })).toMatchObject({ kind: "NO_WORK", reason: "attempt retry budget exhausted" });
  });

  it("returns reconciliation decisions for runtime, control-plane, and workspace mismatches", () => {
    const plan = singlePlan();
    const state = readyState(plan);
    expect(scheduleNextTask({ plan, state, runtimeIntegrity: { valid: false, reason: "ledger mismatch" } })).toMatchObject({ kind: "RECONCILIATION_REQUIRED", reason: "ledger mismatch" });
    expect(scheduleNextTask({ plan, state, runtimeIntegrityFacts: { valid: true, controlPlaneValid: false, reason: "control plane changed" } })).toMatchObject({ kind: "RECONCILIATION_REQUIRED", reason: "control plane changed" });
    expect(scheduleNextTask({ plan, state, admissionFacts: { valid: true, admissionValid: false, reason: "admission facts stale" } })).toMatchObject({ kind: "RECONCILIATION_REQUIRED", reason: "admission facts stale" });
    expect(scheduleNextTask({ plan, state, fingerprintComparison: { valid: false, reason: "workspace fingerprint changed" } })).toMatchObject({ kind: "RECONCILIATION_REQUIRED", reason: "workspace fingerprint changed" });
    expect(scheduleNextTask({ plan, state, workspaceComparison: { valid: true, checkpointValid: false, reason: "checkpoint mismatch" } })).toMatchObject({ kind: "RECONCILIATION_REQUIRED", reason: "checkpoint mismatch" });
  });

  it("does not select work when the Run is not active or a phase is still pending", () => {
    const plan = executionPlan([
      planPhase(1, "P01", [planTask("T001", "P01")]),
      planPhase(2, "P02", [planTask("T002", "P02")], ["P01"]),
    ]);
    const created = createState(plan);
    expect(scheduleNextTask({ plan, state: created })).toMatchObject({ kind: "NO_WORK", reason: "RUN_NOT_ACTIVE" });
    const pendingPhase = startedState(plan);
    expect(scheduleNextTask({ plan, state: pendingPhase })).toMatchObject({ kind: "WAITING" });
    const completedFirst = withTaskState(readyState(plan, ["T001", "T002"]), "T001", { disposition: "COMPLETE", activity: "IDLE", owner: "NONE", hold: "NONE" });
    expect(scheduleNextTask({ plan, state: completedFirst })).toMatchObject({ kind: "CANDIDATE", candidate: { taskId: "T002", phaseId: "P02" } });
  });

  it("uses the global OPEN Attempt barrier, including AWAITING_AUDIT, before Task eligibility", () => {
    const plan = singlePlan();
    const stages: readonly AttemptStageForScheduler[] = ["ADMITTED", "VALIDATING", "AUDITING", "AWAITING_AUDIT"];
    for (const stage of stages) {
      let state: RalphRuntimeStateV2;
      if (stage === "ADMITTED") state = attemptStartedState(plan);
      else if (stage === "AWAITING_AUDIT") state = auditReadyState().state;
      else if (stage === "VALIDATING") {
        const ready = dispatchAuthorizedState(attemptStartedState(plan));
        const started = applyEvent(ready, "executor.started", { invocationId: "invocation-1", startedAt: "2026-01-01T00:00:40.000Z" });
        const finished = applyEvent(started, "executor.finished", { invocationId: "invocation-1", status: "SUCCEEDED", termination: "NORMAL", finishedAt: "2026-01-01T00:00:50.000Z" });
        const captureStarted = applyEvent(finished, "evidence.capture-started", { evidenceCaptureId: "capture-1", postExecutorFingerprint: "fp-post", startedAt: "2026-01-01T00:01:00.000Z" });
        const captured = applyEvent(captureStarted, "evidence.captured", { evidenceCaptureId: "capture-1", evidenceDigest: "evidence-digest-1", postExecutorFingerprint: "fp-post", capturedAt: "2026-01-01T00:01:10.000Z" });
        state = applyEvent(captured, "validation.started", {
          validationSpec: parseValidationSpec("`printf validation`", { taskId: "T001", planIdentity: PLAN_ID, ordinal: 1 }),
          validationRunId: "validation-run-1",
          validationRunOrdinal: 1,
          startedAt: "2026-01-01T00:01:20.000Z",
        });
      } else {
        const ready = auditReadyState().state;
        state = applyEvent(ready, "audit.started", { auditPackageId: "audit-package-1", auditPackageDigest: "audit-package-digest-1", startedAt: "2026-01-01T00:02:00.000Z" }, { actor: "AUDITOR" });
      }
      expect(openAttempt(state)?.stage).toBe(stage);
      const decision = scheduleNextTask({ plan, state });
      expectNoCandidate(decision);
      expect(decision).toMatchObject({ kind: "WAITING", reason: "OPEN_ATTEMPT_BARRIER" });
    }
  });
});

type AttemptStageForScheduler = "ADMITTED" | "VALIDATING" | "AUDITING" | "AWAITING_AUDIT";

async function sourceFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFiles(path));
    else if (entry.name.endsWith(".ts")) result.push(path);
  }
  return result;
}

describe("RALPH Operational V2 Slice A execution boundary", () => {
  it("contains no process, provider, filesystem, or executable dispatch path", async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/vnext/ralph-runtime/operational-v2");
    const files = await sourceFiles(root);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source, file).not.toMatch(/node:fs|node:child_process|child_process|ExecutorRuntime|\bspawn\s*\(|\bexecFile(?:Sync)?\s*\(|startNextTask|runNextTask|executeCandidate|dispatchCandidate/);
    }
  });
});

function buildEventsFromState(state: RalphRuntimeStateV2): readonly RalphEventV2[] {
  // The replay test uses the authoritative state only to select a deterministic
  // fixture sequence; each event is rebuilt from the same explicit payloads.
  let cursor = createState();
  const events: RalphEventV2[] = [];
  const push = <TType extends RalphEventTypeV2>(type: TType, payload: EventPayloadMapV2[TType], options: EventOptions = {}) => {
    const event = makeEvent(cursor, type, payload, options);
    events.push(event);
    cursor = reduceRalphEventV2(cursor, event);
  };
  push("run.created", { phaseIds: ["P01"], taskIds: ["T001"] });
  push("run.started", {});
  push("task.state-changed", { disposition: "READY", activity: "IDLE", owner: "NONE", hold: "NONE" }, { taskId: "T001", phaseId: "P01" });
  push("workspace.checkpointed", { checkpoint: { kind: "runStartFingerprint", fingerprintDigest: "fp-base", emittedAt: "2026-01-01T00:00:10.000Z" } });
  push("attempt.started", { taskId: "T001", attemptId: "A001", ordinal: 1, strategyGeneration: 0, attemptBaseFingerprint: "fp-base", startedAt: "2026-01-01T00:00:20.000Z" }, { taskId: "T001", phaseId: "P01", attemptId: "A001" });
  push("executor.dispatch-authorized", { invocationId: "invocation-1", workUnitDigest: "work-unit-1", attemptBaseFingerprint: "fp-base", timeoutPolicyDigest: "timeout-policy-1", capabilityPolicyDigest: "capability-policy-1", authorizedAt: "2026-01-01T00:00:30.000Z" });
  push("executor.started", { invocationId: "invocation-1", startedAt: "2026-01-01T00:00:40.000Z" });
  push("executor.finished", { invocationId: "invocation-1", status: "SUCCEEDED", termination: "NORMAL", finishedAt: "2026-01-01T00:00:50.000Z" });
  push("evidence.capture-started", { evidenceCaptureId: "capture-1", postExecutorFingerprint: "fp-post", startedAt: "2026-01-01T00:01:00.000Z" });
  push("evidence.captured", { evidenceCaptureId: "capture-1", evidenceDigest: "evidence-digest-1", postExecutorFingerprint: "fp-post", capturedAt: "2026-01-01T00:01:10.000Z" });
  const spec = parseValidationSpec("`printf validation`", { taskId: "T001", planIdentity: PLAN_ID, ordinal: 1 });
  push("validation.started", { validationSpec: spec, validationRunId: "validation-run-1", validationRunOrdinal: 1, startedAt: "2026-01-01T00:01:20.000Z" });
  push("validation.completed", { validationRun: { validationRunId: "validation-run-1", validationSpecId: spec.validationSpecId, validationSpecDigest: spec.digest, validationRunOrdinal: 1, startedAt: "2026-01-01T00:01:20.000Z", endedAt: "2026-01-01T00:01:30.000Z", outcome: "PASS", exitCode: 0, resultDigest: "validation-result-digest-1" } });
  push("attempt.audit-ready", { evidenceCaptureId: "capture-1", evidenceDigest: "evidence-digest-1", validationSetId: "validation-set-1", validationSetDigest: "validation-set-digest-1", auditPackageId: "audit-package-1", auditPackageDigest: "audit-package-digest-1", postExecutorFingerprint: "fp-post", criterionSetDigest: "criterion-set-digest-1", auditability: "AUDITABLE", validationSummary: { total: 1, completed: 1, passed: 1, failed: 0, notApplicable: 0, infrastructureFailures: 0, manualRequired: 0, humanRequired: 0, hardNegative: false } });
  push("audit.started", { auditPackageId: "audit-package-1", auditPackageDigest: "audit-package-digest-1", startedAt: "2026-01-01T00:02:00.000Z" }, { actor: "AUDITOR" });
  push("attempt.closed", { attemptId: "A001", closureReason: "AUDIT_ACCEPTED", finishedAt: "2026-01-01T00:02:10.000Z" });
  expect(cursor).toEqual(state);
  return events;
}
