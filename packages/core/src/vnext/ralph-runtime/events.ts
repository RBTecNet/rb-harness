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
} from "./contracts.js";
import { canonicalJson } from "./canonical-json.js";
import { isSha256Digest, sha256 } from "./hashing.js";

export const RALPH_EVENT_SCHEMA = "rb-ralph-event/v1" as const;

export type RalphEventType =
  | "run.created"
  | "run.started"
  | "run.hold-set"
  | "run.hold-cleared"
  | "run.completed"
  | "run.failed"
  | "task.state-changed"
  | "attempt.started"
  | "attempt.closed"
  | "finding.state-changed"
  | "workspace.checkpointed"
  | "workspace.drift-detected";

export const RALPH_EVENT_TYPES: readonly RalphEventType[] = [
  "run.created", "run.started", "run.hold-set", "run.hold-cleared", "run.completed", "run.failed",
  "task.state-changed", "attempt.started", "attempt.closed", "finding.state-changed",
  "workspace.checkpointed", "workspace.drift-detected",
];

export interface TaskStateChangePayload {
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

export interface EventPayloadMap {
  readonly "run.created": {
    readonly phaseIds: readonly string[];
    readonly taskIds: readonly string[];
  };
  readonly "run.started": Record<string, never>;
  readonly "run.hold-set": {
    readonly hold: "PAUSED" | "BLOCKED" | "HUMAN_REQUIRED" | "PROVIDER_UNAVAILABLE" | "RECONCILIATION_REQUIRED";
    readonly reason: string;
  };
  readonly "run.hold-cleared": { readonly previousHold: string };
  readonly "run.completed": { readonly finalStatePersisted: true };
  readonly "run.failed": { readonly reason: string };
  readonly "task.state-changed": TaskStateChangePayload;
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
    readonly completionReason: "AUDIT_APPROVED" | "AUDIT_REJECTED" | "VALIDATION_FAILED" | "PROVIDER_FAILURE" | "CANCELLED" | "HUMAN_REQUIRED";
    readonly finishedAt: string;
    readonly auditResult?: AuditResult;
    readonly evidenceRefs?: readonly EvidenceRef[];
    readonly validationRefs?: readonly import("./contracts.js").ValidationRef[];
  };
  readonly "finding.state-changed": { readonly finding: Finding };
  readonly "workspace.checkpointed": { readonly checkpoint: CheckpointRecord };
  readonly "workspace.drift-detected": {
    readonly expectedFingerprint: string;
    readonly observedFingerprint: string;
    readonly reason: string;
  };
}

export interface RalphEventEnvelope<TType extends RalphEventType = RalphEventType> {
  readonly eventId: string;
  readonly eventType: TType;
  readonly schemaVersion: typeof RALPH_EVENT_SCHEMA;
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
  readonly payload: EventPayloadMap[TType];
  readonly previousEventHash: string | null;
  readonly eventHash: string;
}

export type RalphEvent = {
  [TType in RalphEventType]: RalphEventEnvelope<TType>
}[RalphEventType];

export type UnsignedRalphEvent<TType extends RalphEventType> = Omit<RalphEventEnvelope<TType>, "eventHash">;

function eventHashInput(event: Omit<RalphEventEnvelope, "eventHash">): string {
  return canonicalJson(event);
}

export function createRalphEvent<TType extends RalphEventType>(
  input: UnsignedRalphEvent<TType>,
): RalphEventEnvelope<TType> {
  const { phaseId, taskId, attemptId, ...required } = input;
  const event = {
    ...required,
    ...(phaseId === undefined ? {} : { phaseId }),
    ...(taskId === undefined ? {} : { taskId }),
    ...(attemptId === undefined ? {} : { attemptId }),
  } as Omit<RalphEventEnvelope<TType>, "eventHash">;
  const result = { ...event, eventHash: sha256(eventHashInput(event)) } as RalphEventEnvelope<TType>;
  validateRalphEvent(result);
  return result;
}

export function validateRalphEvent(event: unknown): asserts event is RalphEvent {
  if (!event || typeof event !== "object") throw new Error("RALPH_EVENT_MALFORMED");
  const candidate = event as Partial<RalphEventEnvelope>;
  assertExactKeys(candidate, [
    "eventId", "eventType", "schemaVersion", "runId", "sequence", "occurredAt", "recordedAt",
    "entity", "phaseId", "taskId", "attemptId", "actor", "causationId", "correlationId",
    "payload", "previousEventHash", "eventHash",
  ], "RALPH_EVENT_UNKNOWN_FIELD");
  if (candidate.schemaVersion !== RALPH_EVENT_SCHEMA) throw new Error("RALPH_EVENT_UNSUPPORTED_SCHEMA");
  if (typeof candidate.eventId !== "string" || candidate.eventId.length === 0) throw new Error("RALPH_EVENT_INVALID_ID");
  if (typeof candidate.eventType !== "string" || !RALPH_EVENT_TYPES.includes(candidate.eventType as RalphEventType)) throw new Error("RALPH_EVENT_INVALID_TYPE");
  if (typeof candidate.runId !== "string" || candidate.runId.length === 0) throw new Error("RALPH_EVENT_INVALID_RUN");
  const sequence = candidate.sequence;
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1) throw new Error("RALPH_EVENT_INVALID_SEQUENCE");
  if (typeof candidate.occurredAt !== "string" || typeof candidate.recordedAt !== "string") throw new Error("RALPH_EVENT_INVALID_TIME");
  if (!candidate.entity || typeof candidate.entity !== "object" || Array.isArray(candidate.entity)) throw new Error("RALPH_EVENT_INVALID_ENTITY");
  assertExactKeys(candidate.entity, ["kind", "id"], "RALPH_EVENT_UNKNOWN_ENTITY_FIELD");
  if (typeof candidate.entity.id !== "string" || !["run", "phase", "task", "attempt", "finding", "workspace"].includes(candidate.entity.kind)) throw new Error("RALPH_EVENT_INVALID_ENTITY");
  if (typeof candidate.actor !== "string" || !["CORE", "EXECUTOR", "AUDITOR", "HUMAN", "SYSTEM"].includes(candidate.actor) || typeof candidate.correlationId !== "string") throw new Error("RALPH_EVENT_INVALID_ACTOR_OR_CORRELATION");
  assertOptionalStringFields(candidate as Record<string, unknown>, ["phaseId", "taskId", "attemptId"]);
  if (candidate.causationId !== null && typeof candidate.causationId !== "string") throw new Error("RALPH_EVENT_INVALID_CAUSATION");
  if (candidate.payload === undefined) throw new Error("RALPH_EVENT_MISSING_PAYLOAD");
  validateEventPayload(candidate.eventType as RalphEventType, candidate.payload);
  if (candidate.previousEventHash !== null && !isSha256Digest(candidate.previousEventHash)) throw new Error("RALPH_EVENT_INVALID_PREVIOUS_HASH");
  if (!isSha256Digest(candidate.eventHash)) throw new Error("RALPH_EVENT_INVALID_HASH");
  const { eventHash: _ignored, ...unsigned } = candidate as RalphEventEnvelope;
  if (sha256(eventHashInput(unsigned)) !== candidate.eventHash) throw new Error("RALPH_EVENT_HASH_MISMATCH");
}

export function canonicalEventBytes(event: RalphEvent): Buffer {
  validateRalphEvent(event);
  return Buffer.from(canonicalJson(event), "utf8");
}

export function unsignedEventHash(event: Omit<RalphEventEnvelope, "eventHash">): string {
  return sha256(eventHashInput(event));
}

const PAYLOAD_KEYS: Readonly<Record<RalphEventType, readonly string[]>> = {
  "run.created": ["phaseIds", "taskIds"],
  "run.started": [],
  "run.hold-set": ["hold", "reason"],
  "run.hold-cleared": ["previousHold"],
  "run.completed": ["finalStatePersisted"],
  "run.failed": ["reason"],
  "task.state-changed": [
    "disposition", "activity", "owner", "hold", "currentAttemptId", "evidenceSetId",
    "validationSetDigest", "postExecutorFingerprint", "acceptedCheckpointFingerprint",
  ],
  "attempt.started": ["taskId", "attemptId", "ordinal", "strategyGeneration", "attemptBaseFingerprint", "startedAt"],
  "attempt.closed": ["attemptId", "completionReason", "finishedAt", "auditResult", "evidenceRefs", "validationRefs"],
  "finding.state-changed": ["finding"],
  "workspace.checkpointed": ["checkpoint"],
  "workspace.drift-detected": ["expectedFingerprint", "observedFingerprint", "reason"],
};

function validateEventPayload(eventType: RalphEventType, payload: unknown): void {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("RALPH_EVENT_INVALID_PAYLOAD");
  assertExactKeys(payload, PAYLOAD_KEYS[eventType], "RALPH_EVENT_UNKNOWN_PAYLOAD_FIELD");
  const value = payload as Record<string, unknown>;
  switch (eventType) {
    case "run.created":
      assertStringArray(value.phaseIds, "RALPH_EVENT_INVALID_PAYLOAD");
      assertStringArray(value.taskIds, "RALPH_EVENT_INVALID_PAYLOAD");
      return;
    case "run.started":
      return;
    case "run.hold-set":
      if (!["PAUSED", "BLOCKED", "HUMAN_REQUIRED", "PROVIDER_UNAVAILABLE", "RECONCILIATION_REQUIRED"].includes(String(value.hold)) || typeof value.reason !== "string") throw new Error("RALPH_EVENT_INVALID_PAYLOAD");
      return;
    case "run.hold-cleared":
      if (typeof value.previousHold !== "string") throw new Error("RALPH_EVENT_INVALID_PAYLOAD");
      return;
    case "run.completed":
      if (value.finalStatePersisted !== true) throw new Error("RALPH_EVENT_INVALID_PAYLOAD");
      return;
    case "run.failed":
      if (typeof value.reason !== "string") throw new Error("RALPH_EVENT_INVALID_PAYLOAD");
      return;
    case "task.state-changed":
      if (!["PENDING", "READY", "COMPLETE", "FAILED", "BLOCKED", "PAUSED"].includes(String(value.disposition))
        || !["IDLE", "EXECUTING", "CAPTURING_EVIDENCE", "VALIDATING", "AUDITING", "CORRECTING", "INTEGRATING", "RECONCILING"].includes(String(value.activity))
        || !["NONE", "EXECUTOR", "CORE", "AUDITOR", "HUMAN"].includes(String(value.owner))
        || !["NONE", "HUMAN_REQUIRED", "PROVIDER_UNAVAILABLE", "DEPENDENCY_UNAVAILABLE", "WORKSPACE_DRIFT", "RETRY_BUDGET_EXHAUSTED", "CANCELLED_AT_BOUNDARY"].includes(String(value.hold))) throw new Error("RALPH_EVENT_INVALID_PAYLOAD");
      assertOptionalStringFields(value, ["currentAttemptId", "evidenceSetId", "validationSetDigest", "postExecutorFingerprint", "acceptedCheckpointFingerprint"]);
      return;
    case "attempt.started":
      if (typeof value.taskId !== "string" || typeof value.attemptId !== "string" || typeof value.ordinal !== "number" || !Number.isSafeInteger(value.ordinal) || value.ordinal < 1
        || typeof value.strategyGeneration !== "number" || !Number.isSafeInteger(value.strategyGeneration) || value.strategyGeneration < 0
        || typeof value.attemptBaseFingerprint !== "string" || typeof value.startedAt !== "string") throw new Error("RALPH_EVENT_INVALID_PAYLOAD");
      return;
    case "attempt.closed":
      if (typeof value.attemptId !== "string" || typeof value.completionReason !== "string" || typeof value.finishedAt !== "string") throw new Error("RALPH_EVENT_INVALID_PAYLOAD");
      if (value.auditResult !== undefined) assertAuditResultShape(value.auditResult);
      if (value.evidenceRefs !== undefined) assertEvidenceRefsShape(value.evidenceRefs);
      if (value.validationRefs !== undefined) assertValidationRefsShape(value.validationRefs);
      return;
    case "finding.state-changed":
      assertFindingShape(value.finding);
      return;
    case "workspace.checkpointed":
      assertCheckpointShape(value.checkpoint);
      return;
    case "workspace.drift-detected":
      if (typeof value.expectedFingerprint !== "string" || typeof value.observedFingerprint !== "string" || typeof value.reason !== "string") throw new Error("RALPH_EVENT_INVALID_PAYLOAD");
      return;
  }
}

function assertExactKeys(value: object, allowed: readonly string[], code: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new Error(`${code}: ${unknown.sort().join(",")}`);
}

function assertStringArray(value: unknown, code: string): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(code);
}

function assertOptionalStringFields(value: Record<string, unknown>, fields: readonly string[]): void {
  if (fields.some((field) => value[field] !== undefined && typeof value[field] !== "string")) throw new Error("RALPH_EVENT_INVALID_PAYLOAD");
}

function assertAuditResultShape(value: unknown): asserts value is AuditResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RALPH_EVENT_INVALID_AUDIT_RESULT");
  assertExactKeys(value, ["auditId", "binding", "result", "criteria", "issuedAt"], "RALPH_EVENT_UNKNOWN_AUDIT_FIELD");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.auditId !== "string" || typeof candidate.issuedAt !== "string" || !["PASS", "FAIL", "UNPROVEN", "HUMAN_PENDING", "NOT_APPLICABLE"].includes(String(candidate.result))) throw new Error("RALPH_EVENT_INVALID_AUDIT_RESULT");
  assertBindingShape(candidate.binding);
  if (!Array.isArray(candidate.criteria)) throw new Error("RALPH_EVENT_INVALID_AUDIT_RESULT");
  for (const criterion of candidate.criteria) {
    if (!criterion || typeof criterion !== "object" || Array.isArray(criterion)) throw new Error("RALPH_EVENT_INVALID_AUDIT_CRITERION");
    assertExactKeys(criterion, ["criterionId", "result", "evidenceRefs", "findingIds"], "RALPH_EVENT_UNKNOWN_AUDIT_CRITERION_FIELD");
    const item = criterion as Record<string, unknown>;
    if (typeof item.criterionId !== "string" || !["PASS", "FAIL", "UNPROVEN", "NOT_APPLICABLE"].includes(String(item.result))) throw new Error("RALPH_EVENT_INVALID_AUDIT_CRITERION");
    assertEvidenceRefsShape(item.evidenceRefs);
    assertStringArray(item.findingIds, "RALPH_EVENT_INVALID_AUDIT_CRITERION");
  }
}

function assertBindingShape(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RALPH_EVENT_INVALID_AUDIT_BINDING");
  assertExactKeys(value, ["runId", "phaseId", "taskId", "attemptId", "auditReviewOrdinal", "evidenceSetId", "evidenceDigest", "validationSetDigest", "postExecutorFingerprint", "criterionSetVersion", "criterionSetDigest", "auditorProfileDigest"], "RALPH_EVENT_UNKNOWN_AUDIT_BINDING_FIELD");
  const candidate = value as Record<string, unknown>;
  for (const key of ["runId", "phaseId", "taskId", "attemptId", "evidenceSetId", "evidenceDigest", "validationSetDigest", "postExecutorFingerprint", "criterionSetVersion", "criterionSetDigest", "auditorProfileDigest"]) {
    if (typeof candidate[key] !== "string") throw new Error("RALPH_EVENT_INVALID_AUDIT_BINDING");
  }
  if (typeof candidate.auditReviewOrdinal !== "number" || !Number.isSafeInteger(candidate.auditReviewOrdinal) || candidate.auditReviewOrdinal < 1) throw new Error("RALPH_EVENT_INVALID_AUDIT_BINDING");
}

function assertEvidenceRefsShape(value: unknown): asserts value is readonly EvidenceRef[] {
  if (!Array.isArray(value)) throw new Error("RALPH_EVENT_INVALID_EVIDENCE_REFS");
  for (const reference of value) {
    if (!reference || typeof reference !== "object" || Array.isArray(reference)) throw new Error("RALPH_EVENT_INVALID_EVIDENCE_REF");
    assertExactKeys(reference, ["evidenceId", "evidenceSetId", "digest", "kind", "provenance", "integrity", "storageRef", "capturedAt"], "RALPH_EVENT_UNKNOWN_EVIDENCE_FIELD");
  }
}

function assertValidationRefsShape(value: unknown): asserts value is readonly ValidationRef[] {
  if (!Array.isArray(value)) throw new Error("RALPH_EVENT_INVALID_VALIDATION_REFS");
  for (const reference of value) {
    if (!reference || typeof reference !== "object" || Array.isArray(reference)) throw new Error("RALPH_EVENT_INVALID_VALIDATION_REF");
    assertExactKeys(reference, ["validationId", "validatorIdentity", "args", "workingDirectory", "startedAt", "endedAt", "exitCode", "stdoutRef", "stderrRef", "affectedScope", "result", "cacheIdentity"], "RALPH_EVENT_UNKNOWN_VALIDATION_FIELD");
  }
}

function assertCheckpointShape(value: unknown): asserts value is CheckpointRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RALPH_EVENT_INVALID_CHECKPOINT");
  assertExactKeys(value, ["kind", "fingerprintDigest", "emittedAt", "attemptId", "evidenceSetId"], "RALPH_EVENT_UNKNOWN_CHECKPOINT_FIELD");
  const candidate = value as Record<string, unknown>;
  if (!["runStartFingerprint", "attemptBaseFingerprint", "postExecutorFingerprint", "acceptedCheckpointFingerprint"].includes(String(candidate.kind)) || typeof candidate.fingerprintDigest !== "string" || typeof candidate.emittedAt !== "string") throw new Error("RALPH_EVENT_INVALID_CHECKPOINT");
  assertOptionalStringFields(candidate, ["attemptId", "evidenceSetId"]);
}

function assertFindingShape(value: unknown): asserts value is Finding {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RALPH_EVENT_INVALID_FINDING");
  assertExactKeys(value, ["id", "criterionId", "phaseId", "taskId", "scope", "severity", "status", "expectation", "observed", "evidenceRefs", "remediationHint", "openedAtAttempt", "resolvedAtAttempt", "rootCauseGroup", "supersedesFindingId", "resolutionEvidenceDigest", "resolutionAuditId", "resolutionValidationSetDigest", "resolutionCriterionResult"], "RALPH_EVENT_UNKNOWN_FINDING_FIELD");
  const candidate = value as Record<string, unknown>;
  for (const key of ["id", "criterionId", "phaseId", "taskId", "expectation", "observed", "openedAtAttempt"]) if (typeof candidate[key] !== "string") throw new Error("RALPH_EVENT_INVALID_FINDING");
  assertStringArray(candidate.scope, "RALPH_EVENT_INVALID_FINDING");
  assertEvidenceRefsShape(candidate.evidenceRefs);
  if (!["INFO", "LOW", "MEDIUM", "HIGH", "BLOCKER"].includes(String(candidate.severity)) || !["OPEN", "CANDIDATE_RESOLVED", "RESOLVED", "SUPERSEDED", "HUMAN_PENDING"].includes(String(candidate.status))) throw new Error("RALPH_EVENT_INVALID_FINDING");
  assertOptionalStringFields(candidate, ["remediationHint", "resolvedAtAttempt", "rootCauseGroup", "supersedesFindingId", "resolutionEvidenceDigest", "resolutionAuditId", "resolutionValidationSetDigest", "resolutionCriterionResult"]);
}
