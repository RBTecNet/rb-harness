import type {
  AuditResult,
  CheckpointRecord,
  EvidenceRef,
  Finding,
  RuntimeActor,
  RuntimeEntityRef,
  TaskActivity,
  TaskDisposition,
  TaskHold,
  TaskOwner,
  ValidationRef,
} from "../contracts.js";
import { canonicalJson } from "../canonical-json.js";
import { isSha256Digest, sha256 } from "../hashing.js";
import {
  FINDING_STATUSES,
  RUN_HOLDS,
  TASK_ACTIVITIES,
  TASK_DISPOSITIONS,
  TASK_HOLDS,
  TASK_OWNERS,
} from "../contracts.js";
import {
  ATTEMPT_CLOSURE_REASONS,
  AUDITABILITY_CLASSIFICATIONS,
  EVENT_SCHEMA_V2,
  EXECUTOR_STATUSES,
  EXECUTOR_TERMINATIONS,
  VALIDATION_KINDS,
  VALIDATION_OUTCOMES,
  type AttemptClosureReason,
  type DeterministicValidationSummary,
  type ExecutorStatus,
  type ExecutorTermination,
  type ValidationRunRef,
  type ValidationSpecRef,
  type V2AuditReadyPayload,
} from "./contracts.js";

export const RALPH_EVENT_TYPES_V2 = [
  "run.created",
  "run.started",
  "run.hold-set",
  "run.hold-cleared",
  "run.completed",
  "run.failed",
  "task.state-changed",
  "attempt.started",
  "attempt.closed",
  "finding.state-changed",
  "workspace.checkpointed",
  "workspace.drift-detected",
  "executor.dispatch-authorized",
  "executor.started",
  "executor.finished",
  "evidence.capture-started",
  "evidence.captured",
  "validation.started",
  "validation.completed",
  "attempt.human-required",
  "attempt.audit-ready",
  "attempt.reconciliation-required",
  "audit.started",
] as const;
export type RalphEventTypeV2 = typeof RALPH_EVENT_TYPES_V2[number];

export const V2_EVENT_ENTITY_KINDS: Readonly<Record<RalphEventTypeV2, RuntimeEntityRef["kind"]>> = {
  "run.created": "run",
  "run.started": "run",
  "run.hold-set": "run",
  "run.hold-cleared": "run",
  "run.completed": "run",
  "run.failed": "run",
  "task.state-changed": "task",
  "attempt.started": "attempt",
  "attempt.closed": "attempt",
  "finding.state-changed": "finding",
  "workspace.checkpointed": "workspace",
  "workspace.drift-detected": "workspace",
  "executor.dispatch-authorized": "attempt",
  "executor.started": "attempt",
  "executor.finished": "attempt",
  "evidence.capture-started": "attempt",
  "evidence.captured": "attempt",
  "validation.started": "attempt",
  "validation.completed": "attempt",
  "attempt.human-required": "attempt",
  "attempt.audit-ready": "attempt",
  "attempt.reconciliation-required": "attempt",
  "audit.started": "attempt",
};

export interface TaskStateChangePayloadV2 {
  readonly disposition: TaskDisposition;
  readonly activity: TaskActivity;
  readonly owner: TaskOwner;
  readonly hold: TaskHold;
  readonly currentAttemptId?: string;
  readonly evidenceSetId?: string;
  readonly validationSetDigest?: string;
  readonly postExecutorFingerprint?: string;
  readonly acceptedCheckpointFingerprint?: string;
}

export interface ExecutorDispatchAuthorizedPayload {
  readonly invocationId: string;
  readonly workUnitDigest: string;
  readonly attemptBaseFingerprint: string;
  readonly timeoutPolicyDigest: string;
  readonly capabilityPolicyDigest: string;
  readonly authorizedAt: string;
}

export interface ExecutorStartedPayload {
  readonly invocationId: string;
  readonly startedAt: string;
}

export interface ExecutorFinishedPayload {
  readonly invocationId: string;
  readonly status: ExecutorStatus;
  readonly termination: ExecutorTermination;
  readonly finishedAt: string;
}

export interface EvidenceCaptureStartedPayload {
  readonly evidenceCaptureId: string;
  readonly postExecutorFingerprint: string;
  readonly startedAt: string;
}

export interface EvidenceCapturedPayload {
  readonly evidenceCaptureId: string;
  readonly evidenceDigest: string;
  readonly postExecutorFingerprint: string;
  readonly capturedAt: string;
}

export interface ValidationStartedPayload {
  readonly validationSpec: ValidationSpecRef;
  readonly validationRunId: string;
  readonly validationRunOrdinal: number;
  readonly startedAt: string;
}

export interface ValidationCompletedPayload {
  readonly validationRun: ValidationRunRef;
}

export interface AttemptRequirementPayload {
  readonly reason: string;
  readonly proofRef: string;
}

export interface AuditStartedPayload {
  readonly auditPackageId: string;
  readonly auditPackageDigest: string;
  readonly startedAt: string;
}

export interface EventPayloadMapV2 {
  readonly "run.created": {
    readonly phaseIds: readonly string[];
    readonly taskIds: readonly string[];
  };
  readonly "run.started": Record<string, never>;
  readonly "run.hold-set": {
    readonly hold: Exclude<import("../contracts.js").RunHold, "NONE">;
    readonly reason: string;
  };
  readonly "run.hold-cleared": {
    readonly previousHold: Exclude<import("../contracts.js").RunHold, "NONE">;
    readonly reason: string;
    readonly proofRef: string;
  };
  readonly "run.completed": { readonly finalStatePersisted: true };
  readonly "run.failed": { readonly reason: string };
  readonly "task.state-changed": TaskStateChangePayloadV2;
  readonly "attempt.started": {
    readonly taskId: string;
    readonly attemptId: string;
    readonly ordinal: number;
    readonly strategyGeneration: number;
    readonly attemptBaseFingerprint: string;
    readonly startedAt: string;
  };
  readonly "attempt.closed": {
    readonly attemptId: string;
    readonly closureReason: AttemptClosureReason;
    readonly finishedAt: string;
  };
  readonly "finding.state-changed": { readonly finding: Finding };
  readonly "workspace.checkpointed": { readonly checkpoint: CheckpointRecord };
  readonly "workspace.drift-detected": {
    readonly expectedFingerprint: string;
    readonly observedFingerprint: string;
    readonly reason: string;
  };
  readonly "executor.dispatch-authorized": ExecutorDispatchAuthorizedPayload;
  readonly "executor.started": ExecutorStartedPayload;
  readonly "executor.finished": ExecutorFinishedPayload;
  readonly "evidence.capture-started": EvidenceCaptureStartedPayload;
  readonly "evidence.captured": EvidenceCapturedPayload;
  readonly "validation.started": ValidationStartedPayload;
  readonly "validation.completed": ValidationCompletedPayload;
  readonly "attempt.human-required": AttemptRequirementPayload;
  readonly "attempt.audit-ready": V2AuditReadyPayload;
  readonly "attempt.reconciliation-required": AttemptRequirementPayload;
  readonly "audit.started": AuditStartedPayload;
}

export interface RalphEventEnvelopeV2<TType extends RalphEventTypeV2 = RalphEventTypeV2> {
  readonly eventId: string;
  readonly eventType: TType;
  readonly schemaVersion: typeof EVENT_SCHEMA_V2;
  readonly runId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly entity: RuntimeEntityRef;
  readonly phaseId?: string;
  readonly taskId?: string;
  readonly attemptId?: string;
  readonly actor: RuntimeActor;
  readonly causationId: string | null;
  readonly correlationId: string;
  readonly payload: EventPayloadMapV2[TType];
  readonly previousEventHash: string | null;
  readonly eventHash: string;
}

export type RalphEventV2 = {
  [TType in RalphEventTypeV2]: RalphEventEnvelopeV2<TType>
}[RalphEventTypeV2];

export type UnsignedRalphEventV2<TType extends RalphEventTypeV2 = RalphEventTypeV2> = Omit<RalphEventEnvelopeV2<TType>, "eventHash">;

export function createRalphEventV2<TType extends RalphEventTypeV2>(
  input: UnsignedRalphEventV2<TType>,
): RalphEventEnvelopeV2<TType> {
  const { phaseId, taskId, attemptId, ...required } = input;
  const event = {
    ...required,
    ...(phaseId === undefined ? {} : { phaseId }),
    ...(taskId === undefined ? {} : { taskId }),
    ...(attemptId === undefined ? {} : { attemptId }),
  } as Omit<RalphEventEnvelopeV2<TType>, "eventHash">;
  const result = { ...event, eventHash: sha256(canonicalJson(event)) } as RalphEventEnvelopeV2<TType>;
  validateRalphEventV2(result);
  return result;
}

export function validateRalphEventV2(event: unknown): asserts event is RalphEventV2 {
  if (!isRecord(event)) throw new Error("RALPH_V2_EVENT_MALFORMED");
  assertExactKeys(event, [
    "eventId", "eventType", "schemaVersion", "runId", "sequence", "occurredAt", "recordedAt", "entity",
    "phaseId", "taskId", "attemptId", "actor", "causationId", "correlationId", "payload", "previousEventHash", "eventHash",
  ], "RALPH_V2_EVENT_UNKNOWN_FIELD");
  if (event.schemaVersion !== EVENT_SCHEMA_V2) throw new Error("RALPH_V2_EVENT_UNSUPPORTED_SCHEMA");
  assertNonEmptyString(event.eventId, "RALPH_V2_EVENT_INVALID_ID");
  if (typeof event.eventType !== "string" || !RALPH_EVENT_TYPES_V2.includes(event.eventType as RalphEventTypeV2)) throw new Error("RALPH_V2_EVENT_INVALID_TYPE");
  assertNonEmptyString(event.runId, "RALPH_V2_EVENT_INVALID_RUN");
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) throw new Error("RALPH_V2_EVENT_INVALID_SEQUENCE");
  assertNonEmptyString(event.occurredAt, "RALPH_V2_EVENT_INVALID_TIME");
  assertNonEmptyString(event.recordedAt, "RALPH_V2_EVENT_INVALID_TIME");
  if (!isRecord(event.entity)) throw new Error("RALPH_V2_EVENT_INVALID_ENTITY");
  assertExactKeys(event.entity, ["kind", "id"], "RALPH_V2_EVENT_UNKNOWN_ENTITY_FIELD");
  if (typeof event.entity.kind !== "string" || !["run", "phase", "task", "attempt", "finding", "workspace"].includes(event.entity.kind)) throw new Error("RALPH_V2_EVENT_INVALID_ENTITY");
  assertNonEmptyString(event.entity.id, "RALPH_V2_EVENT_INVALID_ENTITY");
  for (const field of ["phaseId", "taskId", "attemptId"] as const) {
    if (event[field] !== undefined) assertNonEmptyString(event[field], "RALPH_V2_EVENT_INVALID_CONTEXT");
  }
  if (typeof event.actor !== "string" || !["CORE", "EXECUTOR", "AUDITOR", "HUMAN", "SYSTEM"].includes(event.actor)) throw new Error("RALPH_V2_EVENT_INVALID_ACTOR");
  if (event.causationId !== null && typeof event.causationId !== "string") throw new Error("RALPH_V2_EVENT_INVALID_CAUSATION");
  if (event.causationId === "") throw new Error("RALPH_V2_EVENT_INVALID_CAUSATION");
  assertNonEmptyString(event.correlationId, "RALPH_V2_EVENT_INVALID_CORRELATION");
  if (event.previousEventHash !== null && !isSha256Digest(event.previousEventHash)) throw new Error("RALPH_V2_EVENT_INVALID_PREVIOUS_HASH");
  if (!isSha256Digest(event.eventHash)) throw new Error("RALPH_V2_EVENT_INVALID_HASH");
  assertPayload(event.eventType as RalphEventTypeV2, event.payload);
  assertEventEntityCompatibility(event as Partial<RalphEventEnvelopeV2>);
  const { eventHash: _ignored, ...unsigned } = event as RalphEventEnvelopeV2;
  if (sha256(canonicalJson(unsigned)) !== event.eventHash) throw new Error("RALPH_V2_EVENT_HASH_MISMATCH");
}

export const validateV2Event = validateRalphEventV2;
export const createV2Event = createRalphEventV2;

export function canonicalEventBytesV2(event: RalphEventV2): Buffer {
  validateRalphEventV2(event);
  return Buffer.from(canonicalJson(event), "utf8");
}

export function unsignedEventHashV2(event: UnsignedRalphEventV2): string {
  return sha256(canonicalJson(event));
}

const PAYLOAD_SCHEMA: Readonly<Record<RalphEventTypeV2, { readonly required: readonly string[]; readonly optional: readonly string[] }>> = {
  "run.created": { required: ["phaseIds", "taskIds"], optional: [] },
  "run.started": { required: [], optional: [] },
  "run.hold-set": { required: ["hold", "reason"], optional: [] },
  "run.hold-cleared": { required: ["previousHold", "reason", "proofRef"], optional: [] },
  "run.completed": { required: ["finalStatePersisted"], optional: [] },
  "run.failed": { required: ["reason"], optional: [] },
  "task.state-changed": { required: ["disposition", "activity", "owner", "hold"], optional: ["currentAttemptId", "evidenceSetId", "validationSetDigest", "postExecutorFingerprint", "acceptedCheckpointFingerprint"] },
  "attempt.started": { required: ["taskId", "attemptId", "ordinal", "strategyGeneration", "attemptBaseFingerprint", "startedAt"], optional: [] },
  "attempt.closed": { required: ["attemptId", "closureReason", "finishedAt"], optional: [] },
  "finding.state-changed": { required: ["finding"], optional: [] },
  "workspace.checkpointed": { required: ["checkpoint"], optional: [] },
  "workspace.drift-detected": { required: ["expectedFingerprint", "observedFingerprint", "reason"], optional: [] },
  "executor.dispatch-authorized": { required: ["invocationId", "workUnitDigest", "attemptBaseFingerprint", "timeoutPolicyDigest", "capabilityPolicyDigest", "authorizedAt"], optional: [] },
  "executor.started": { required: ["invocationId", "startedAt"], optional: [] },
  "executor.finished": { required: ["invocationId", "status", "termination", "finishedAt"], optional: [] },
  "evidence.capture-started": { required: ["evidenceCaptureId", "postExecutorFingerprint", "startedAt"], optional: [] },
  "evidence.captured": { required: ["evidenceCaptureId", "evidenceDigest", "postExecutorFingerprint", "capturedAt"], optional: [] },
  "validation.started": { required: ["validationSpec", "validationRunId", "validationRunOrdinal", "startedAt"], optional: [] },
  "validation.completed": { required: ["validationRun"], optional: [] },
  "attempt.human-required": { required: ["reason", "proofRef"], optional: [] },
  "attempt.audit-ready": { required: ["evidenceCaptureId", "evidenceDigest", "validationSetId", "validationSetDigest", "auditPackageId", "auditPackageDigest", "postExecutorFingerprint", "criterionSetDigest", "auditability", "validationSummary"], optional: [] },
  "attempt.reconciliation-required": { required: ["reason", "proofRef"], optional: [] },
  "audit.started": { required: ["auditPackageId", "auditPackageDigest", "startedAt"], optional: [] },
};

function assertPayload(eventType: RalphEventTypeV2, payload: unknown): void {
  if (!isRecord(payload)) throw new Error("RALPH_V2_EVENT_INVALID_PAYLOAD");
  const schema = PAYLOAD_SCHEMA[eventType];
  assertExactKeys(payload, [...schema.required, ...schema.optional], "RALPH_V2_EVENT_UNKNOWN_PAYLOAD_FIELD");
  for (const key of schema.required) if (!(key in payload)) throw new Error(`RALPH_V2_EVENT_MISSING_PAYLOAD_FIELD: ${key}`);
  const value = payload as Record<string, unknown>;
  switch (eventType) {
    case "run.created":
      assertStringArray(value.phaseIds, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      assertStringArray(value.taskIds, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      return;
    case "run.started":
      return;
    case "run.hold-set":
      assertRunHold(value.hold, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      assertNonEmptyString(value.reason, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      return;
    case "run.hold-cleared":
      assertRunHold(value.previousHold, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      assertNonEmptyString(value.reason, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      assertNonEmptyString(value.proofRef, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      return;
    case "run.completed":
      if (value.finalStatePersisted !== true) throw new Error("RALPH_V2_EVENT_INVALID_PAYLOAD");
      return;
    case "run.failed":
      assertNonEmptyString(value.reason, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      return;
    case "task.state-changed":
      assertEnum(value.disposition, TASK_DISPOSITIONS, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      assertEnum(value.activity, TASK_ACTIVITIES, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      assertEnum(value.owner, TASK_OWNERS, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      assertEnum(value.hold, TASK_HOLDS, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      assertOptionalStrings(value, schema.optional);
      return;
    case "attempt.started":
      assertNonEmptyString(value.taskId, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      assertNonEmptyString(value.attemptId, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      assertPositiveInteger(value.ordinal, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      if (typeof value.strategyGeneration !== "number" || !Number.isSafeInteger(value.strategyGeneration) || value.strategyGeneration < 0) throw new Error("RALPH_V2_EVENT_INVALID_PAYLOAD");
      assertNonEmptyString(value.attemptBaseFingerprint, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      assertNonEmptyString(value.startedAt, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      return;
    case "attempt.closed":
      assertNonEmptyString(value.attemptId, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      assertEnum(value.closureReason, ATTEMPT_CLOSURE_REASONS, "RALPH_V2_EVENT_INVALID_CLOSURE_REASON");
      assertNonEmptyString(value.finishedAt, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      return;
    case "finding.state-changed":
      assertFinding(value.finding);
      return;
    case "workspace.checkpointed":
      assertCheckpoint(value.checkpoint);
      return;
    case "workspace.drift-detected":
      assertNonEmptyString(value.expectedFingerprint, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      assertNonEmptyString(value.observedFingerprint, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      assertNonEmptyString(value.reason, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      return;
    case "executor.dispatch-authorized":
      for (const key of schema.required) assertNonEmptyString(value[key], "RALPH_V2_EVENT_INVALID_PAYLOAD");
      return;
    case "executor.started":
      assertNonEmptyString(value.invocationId, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      assertNonEmptyString(value.startedAt, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      return;
    case "executor.finished":
      assertNonEmptyString(value.invocationId, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      assertEnum(value.status, EXECUTOR_STATUSES, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      assertEnum(value.termination, EXECUTOR_TERMINATIONS, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      assertNonEmptyString(value.finishedAt, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      return;
    case "evidence.capture-started":
      assertNonEmptyString(value.evidenceCaptureId, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      assertNonEmptyString(value.postExecutorFingerprint, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      assertNonEmptyString(value.startedAt, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      return;
    case "evidence.captured":
      assertNonEmptyString(value.evidenceCaptureId, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      assertDigestLike(value.evidenceDigest, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      assertNonEmptyString(value.postExecutorFingerprint, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      assertNonEmptyString(value.capturedAt, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      return;
    case "validation.started":
      assertValidationSpec(value.validationSpec);
      assertNonEmptyString(value.validationRunId, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      assertPositiveInteger(value.validationRunOrdinal, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      assertNonEmptyString(value.startedAt, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      return;
    case "validation.completed":
      assertValidationRun(value.validationRun, true);
      return;
    case "attempt.human-required":
    case "attempt.reconciliation-required":
      assertNonEmptyString(value.reason, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      assertNonEmptyString(value.proofRef, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      return;
    case "attempt.audit-ready":
      assertAuditReady(value);
      return;
    case "audit.started":
      assertNonEmptyString(value.auditPackageId, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      assertDigestLike(value.auditPackageDigest, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      assertNonEmptyString(value.startedAt, "RALPH_V2_EVENT_INVALID_PAYLOAD");
      return;
  }
}

function assertEventEntityCompatibility(event: Partial<RalphEventEnvelopeV2>): void {
  const eventType = event.eventType as RalphEventTypeV2;
  const entity = event.entity;
  if (!entity || entity.kind !== V2_EVENT_ENTITY_KINDS[eventType]) throw new Error("RALPH_V2_EVENT_ENTITY_KIND_MISMATCH");
  if (entity.kind === "run") {
    if (entity.id !== event.runId) throw new Error("RALPH_V2_EVENT_ENTITY_ID_MISMATCH");
    if (event.phaseId !== undefined || event.taskId !== undefined || event.attemptId !== undefined) throw new Error("RALPH_V2_EVENT_RUN_CONTEXT_INVALID");
  }
  if (entity.kind === "task") {
    if (event.taskId === undefined || entity.id !== event.taskId) throw new Error("RALPH_V2_EVENT_TASK_ID_MISMATCH");
  }
  if (entity.kind === "attempt") {
    if (event.attemptId === undefined || entity.id !== event.attemptId) throw new Error("RALPH_V2_EVENT_ATTEMPT_ID_MISMATCH");
    if (event.phaseId === undefined || event.taskId === undefined) throw new Error("RALPH_V2_EVENT_ATTEMPT_CONTEXT_MISSING");
  }
  if (entity.kind === "finding") {
    const rawPayload: unknown = event.payload;
    const payloadRecord = isRecord(rawPayload) ? rawPayload : undefined;
    const rawFinding: unknown = payloadRecord?.finding;
    const finding = isRecord(rawFinding) ? rawFinding : undefined;
    if (!finding || entity.id !== finding.id) throw new Error("RALPH_V2_EVENT_FINDING_ID_MISMATCH");
    if (event.phaseId !== undefined && event.phaseId !== finding.phaseId) throw new Error("RALPH_V2_EVENT_FINDING_PHASE_MISMATCH");
    if (event.taskId !== undefined && event.taskId !== finding.taskId) throw new Error("RALPH_V2_EVENT_FINDING_TASK_MISMATCH");
  }
  const rawPayload: unknown = event.payload;
  const payload = isRecord(rawPayload) ? rawPayload : undefined;
  if (eventType === "attempt.started" && payload) {
    if (event.attemptId !== payload.attemptId || event.taskId !== payload.taskId) throw new Error("RALPH_V2_EVENT_ATTEMPT_PAYLOAD_ID_MISMATCH");
  }
  if (eventType === "attempt.closed" && payload && event.attemptId !== payload.attemptId) throw new Error("RALPH_V2_EVENT_ATTEMPT_PAYLOAD_ID_MISMATCH");
  const rawSpec: unknown = payload?.validationSpec;
  if (eventType === "validation.started" && payload && isRecord(rawSpec) && event.taskId !== rawSpec.sourceTaskId) throw new Error("RALPH_V2_EVENT_VALIDATION_TASK_MISMATCH");
}

function assertAuditReady(value: Record<string, unknown>): void {
  for (const key of ["evidenceCaptureId", "validationSetId", "auditPackageId", "evidenceDigest", "validationSetDigest", "auditPackageDigest", "postExecutorFingerprint", "criterionSetDigest"] as const) assertNonEmptyString(value[key], "RALPH_V2_EVENT_INVALID_AUDIT_READY");
  assertEnum(value.auditability, AUDITABILITY_CLASSIFICATIONS, "RALPH_V2_EVENT_INVALID_AUDIT_READY");
  assertValidationSummary(value.validationSummary);
  if (value.auditability === "RECONCILIATION_REQUIRED") throw new Error("RALPH_V2_EVENT_AUDIT_READY_RECONCILIATION");
}

function assertValidationSpec(value: unknown): asserts value is ValidationSpecRef {
  if (!isRecord(value)) throw new Error("RALPH_V2_EVENT_INVALID_VALIDATION_SPEC");
  assertExactKeys(value, ["validationSpecId", "ordinal", "kind", "instruction", "digest", "sourceTaskId", "sourcePlanIdentity"], "RALPH_V2_EVENT_UNKNOWN_VALIDATION_SPEC_FIELD");
  assertNonEmptyString(value.validationSpecId, "RALPH_V2_EVENT_INVALID_VALIDATION_SPEC");
  assertPositiveInteger(value.ordinal, "RALPH_V2_EVENT_INVALID_VALIDATION_SPEC");
  assertEnum(value.kind, VALIDATION_KINDS, "RALPH_V2_EVENT_INVALID_VALIDATION_SPEC");
  for (const key of ["instruction", "digest", "sourceTaskId", "sourcePlanIdentity"] as const) assertNonEmptyString(value[key], "RALPH_V2_EVENT_INVALID_VALIDATION_SPEC");
}

function assertValidationRun(value: unknown, completed: boolean): asserts value is ValidationRunRef {
  if (!isRecord(value)) throw new Error("RALPH_V2_EVENT_INVALID_VALIDATION_RUN");
  assertExactKeys(value, ["validationRunId", "validationSpecId", "validationSpecDigest", "validationRunOrdinal", "startedAt", "endedAt", "outcome", "exitCode", "resultDigest"], "RALPH_V2_EVENT_UNKNOWN_VALIDATION_RUN_FIELD");
  for (const key of ["validationRunId", "validationSpecId", "validationSpecDigest", "startedAt"] as const) assertNonEmptyString(value[key], "RALPH_V2_EVENT_INVALID_VALIDATION_RUN");
  assertPositiveInteger(value.validationRunOrdinal, "RALPH_V2_EVENT_INVALID_VALIDATION_RUN");
  assertEnum(value.outcome, VALIDATION_OUTCOMES, "RALPH_V2_EVENT_INVALID_VALIDATION_RUN");
  if (value.endedAt !== undefined) assertNonEmptyString(value.endedAt, "RALPH_V2_EVENT_INVALID_VALIDATION_RUN");
  if (value.exitCode !== undefined && value.exitCode !== null && !Number.isSafeInteger(value.exitCode)) throw new Error("RALPH_V2_EVENT_INVALID_VALIDATION_RUN");
  if (value.resultDigest !== undefined) assertDigestLike(value.resultDigest, "RALPH_V2_EVENT_INVALID_VALIDATION_RUN");
  if (completed && (value.outcome === "PENDING" || value.endedAt === undefined)) throw new Error("RALPH_V2_EVENT_INCOMPLETE_VALIDATION_RUN");
  if (!completed && (value.outcome !== "PENDING" || value.endedAt !== undefined)) throw new Error("RALPH_V2_EVENT_STARTED_VALIDATION_RUN_NOT_PENDING");
}

function assertValidationSummary(value: unknown): asserts value is DeterministicValidationSummary {
  if (!isRecord(value)) throw new Error("RALPH_V2_EVENT_INVALID_VALIDATION_SUMMARY");
  assertExactKeys(value, ["total", "completed", "passed", "failed", "notApplicable", "infrastructureFailures", "manualRequired", "humanRequired", "hardNegative"], "RALPH_V2_EVENT_UNKNOWN_VALIDATION_SUMMARY_FIELD");
  for (const key of ["total", "completed", "passed", "failed", "notApplicable", "infrastructureFailures", "manualRequired", "humanRequired"] as const) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error("RALPH_V2_EVENT_INVALID_VALIDATION_SUMMARY");
  }
  if (typeof value.hardNegative !== "boolean") throw new Error("RALPH_V2_EVENT_INVALID_VALIDATION_SUMMARY");
}

function assertFinding(value: unknown): asserts value is Finding {
  if (!isRecord(value)) throw new Error("RALPH_V2_EVENT_INVALID_FINDING");
  assertExactKeys(value, ["id", "criterionId", "phaseId", "taskId", "scope", "severity", "status", "expectation", "observed", "evidenceRefs", "remediationHint", "openedAtAttempt", "resolvedAtAttempt", "rootCauseGroup", "supersedesFindingId", "resolutionEvidenceDigest", "resolutionAuditId", "resolutionValidationSetDigest", "resolutionCriterionResult"], "RALPH_V2_EVENT_UNKNOWN_FINDING_FIELD");
  for (const key of ["id", "criterionId", "phaseId", "taskId", "expectation", "observed", "openedAtAttempt"] as const) assertNonEmptyString(value[key], "RALPH_V2_EVENT_INVALID_FINDING");
  assertStringArray(value.scope, "RALPH_V2_EVENT_INVALID_FINDING");
  assertEnum(value.severity, ["INFO", "LOW", "MEDIUM", "HIGH", "BLOCKER"], "RALPH_V2_EVENT_INVALID_FINDING");
  assertEnum(value.status, FINDING_STATUSES, "RALPH_V2_EVENT_INVALID_FINDING");
  assertEvidenceRefs(value.evidenceRefs);
  for (const key of ["remediationHint", "resolvedAtAttempt", "rootCauseGroup", "supersedesFindingId", "resolutionEvidenceDigest", "resolutionAuditId", "resolutionValidationSetDigest"] as const) if (value[key] !== undefined) assertNonEmptyString(value[key], "RALPH_V2_EVENT_INVALID_FINDING");
  if (value.resolutionCriterionResult !== undefined) assertEnum(value.resolutionCriterionResult, ["PASS", "NOT_APPLICABLE"], "RALPH_V2_EVENT_INVALID_FINDING");
}

function assertEvidenceRefs(value: unknown): asserts value is readonly EvidenceRef[] {
  if (!Array.isArray(value)) throw new Error("RALPH_V2_EVENT_INVALID_EVIDENCE_REFS");
  for (const item of value) {
    if (!isRecord(item)) throw new Error("RALPH_V2_EVENT_INVALID_EVIDENCE_REF");
    assertExactKeys(item, ["evidenceId", "evidenceSetId", "digest", "kind", "provenance", "integrity", "storageRef", "capturedAt"], "RALPH_V2_EVENT_UNKNOWN_EVIDENCE_FIELD");
    for (const key of ["evidenceId", "evidenceSetId", "digest", "storageRef", "capturedAt"] as const) assertNonEmptyString(item[key], "RALPH_V2_EVENT_INVALID_EVIDENCE_REF");
    assertEnum(item.kind, ["workspace-diff", "command-result", "test-result", "provider-output", "validation-artifact", "snapshot", "log"], "RALPH_V2_EVENT_INVALID_EVIDENCE_REF");
    assertEnum(item.provenance, ["CORE", "EXECUTOR", "AUDITOR", "SYSTEM"], "RALPH_V2_EVENT_INVALID_EVIDENCE_REF");
    assertEnum(item.integrity, ["VERIFIED", "UNVERIFIED"], "RALPH_V2_EVENT_INVALID_EVIDENCE_REF");
  }
}

function assertCheckpoint(value: unknown): asserts value is CheckpointRecord {
  if (!isRecord(value)) throw new Error("RALPH_V2_EVENT_INVALID_CHECKPOINT");
  assertExactKeys(value, ["kind", "fingerprintDigest", "emittedAt", "attemptId", "evidenceSetId"], "RALPH_V2_EVENT_UNKNOWN_CHECKPOINT_FIELD");
  assertEnum(value.kind, ["runStartFingerprint", "attemptBaseFingerprint", "postExecutorFingerprint", "acceptedCheckpointFingerprint"], "RALPH_V2_EVENT_INVALID_CHECKPOINT");
  assertNonEmptyString(value.fingerprintDigest, "RALPH_V2_EVENT_INVALID_CHECKPOINT");
  assertNonEmptyString(value.emittedAt, "RALPH_V2_EVENT_INVALID_CHECKPOINT");
  assertOptionalStrings(value, ["attemptId", "evidenceSetId"]);
}

function assertRunHold(value: unknown, code: string): void {
  assertEnum(value, RUN_HOLDS.filter((hold) => hold !== "NONE"), code);
}

function assertOptionalStrings(value: Record<string, unknown>, fields: readonly string[]): void {
  for (const field of fields) if (value[field] !== undefined) assertNonEmptyString(value[field], "RALPH_V2_EVENT_INVALID_OPTIONAL_FIELD");
}

function assertStringArray(value: unknown, code: string): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) throw new Error(code);
}

function assertNonEmptyString(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new Error(code);
}

function assertDigestLike(value: unknown, code: string): void {
  // The V1 Foundation accepts opaque fingerprint labels in synthetic tests;
  // V2 requires a non-empty typed digest reference but does not force a hash
  // algorithm on future artifact stores.  sha256 values remain first-class.
  assertNonEmptyString(value, code);
}

function assertPositiveInteger(value: unknown, code: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(code);
}

function assertEnum<T extends readonly string[]>(value: unknown, values: T, code: string): asserts value is T[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new Error(code);
}

function assertExactKeys(value: object, allowed: readonly string[], code: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new Error(`${code}: ${unknown.sort().join(",")}`);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

// Keep the imported Foundation shapes in the declaration surface.  V2 event
// payloads use their typed references and do not create a second dimension.
export type V2AuditResultPlaceholder = AuditResult;
export type V2ValidationRefPlaceholder = ValidationRef;
