/**
 * Ralph Operational Core V2 contracts.
 *
 * This module grows beside the frozen Foundation V1.  The Run, Phase, Task,
 * Finding, checkpoint, budget, and ownership dimensions are deliberately
 * reused from ../contracts.ts; only the operational dimensions introduced by
 * the V2 contract live here.
 */

import type {
  AuditResult,
  CheckpointRecord,
  Finding,
  PhaseState,
  RalphRuntimeState,
  TaskState,
} from "../contracts.js";

export {
  FINDING_STATUSES,
  PHASE_ACTIVITIES,
  PHASE_DISPOSITIONS,
  RUN_DISPOSITIONS,
  RUN_HOLDS,
  TASK_ACTIVITIES,
  TASK_DISPOSITIONS,
  TASK_HOLDS,
  TASK_OWNERS,
} from "../contracts.js";

export type {
  AuditResult,
  CheckpointRecord,
  Finding,
  PhaseActivity,
  PhaseDisposition,
  PhaseState,
  RalphRuntimeState,
  RunDisposition,
  RunHold,
  TaskActivity,
  TaskDisposition,
  TaskState,
  TaskHold,
  TaskOwner,
} from "../contracts.js";

export const OPERATIONAL_CONTRACT_V2 = "rb-ralph-operational/v2" as const;
export const EVENT_SCHEMA_V2 = "rb-ralph-event/v2" as const;
export const STATE_SCHEMA_V2 = "rb-ralph-runtime-state/v2" as const;

// Explicit V2 aliases avoid collisions when a caller imports the frozen V1
// barrel and this internal V2 barrel in the same module.
export const RALPH_V2_OPERATIONAL_CONTRACT = OPERATIONAL_CONTRACT_V2;
export const RALPH_V2_EVENT_SCHEMA = EVENT_SCHEMA_V2;
export const RALPH_V2_STATE_SCHEMA = STATE_SCHEMA_V2;
export const RALPH_OPERATIONAL_CONTRACT_V2 = OPERATIONAL_CONTRACT_V2;
export const RALPH_EVENT_SCHEMA_V2 = EVENT_SCHEMA_V2;
export const RALPH_RUNTIME_STATE_SCHEMA_V2 = STATE_SCHEMA_V2;

export const ATTEMPT_DISPOSITIONS = ["OPEN", "CLOSED"] as const;
export type AttemptDisposition = typeof ATTEMPT_DISPOSITIONS[number];

export const ATTEMPT_STAGES = [
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
] as const;
export type AttemptStage = typeof ATTEMPT_STAGES[number];

export const ATTEMPT_CLOSURE_REASONS = [
  "AUDIT_ACCEPTED",
  "AUDIT_REJECTED",
  "EXECUTOR_UNAVAILABLE",
  "EXECUTOR_PROCESS_FAILURE",
  "EXECUTOR_TIMED_OUT",
  "EXECUTOR_CANCELLED",
  "EXECUTOR_PROTOCOL_FAILURE",
  "VALIDATION_INFRASTRUCTURE_EXHAUSTED",
  "CONTROL_PLANE_VIOLATION",
  "RECONCILIATION_REQUIRED",
  "CANCELLED_AT_BOUNDARY",
  "BUDGET_EXHAUSTED",
] as const;
export type AttemptClosureReason = typeof ATTEMPT_CLOSURE_REASONS[number];

export const AUDITABILITY_CLASSIFICATIONS = [
  "AUDITABLE",
  "NOT_AUDITABLE",
  "RECONCILIATION_REQUIRED",
] as const;
export type AuditabilityClassification = typeof AUDITABILITY_CLASSIFICATIONS[number];

export const EXECUTOR_STATUSES = [
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
  "UNAVAILABLE",
] as const;
export type ExecutorStatus = typeof EXECUTOR_STATUSES[number];

export const EXECUTOR_TERMINATIONS = [
  "NORMAL",
  "ERROR",
  "TIMEOUT",
  "CANCELLED",
  "PROVIDER_UNAVAILABLE",
] as const;
export type ExecutorTermination = typeof EXECUTOR_TERMINATIONS[number];

export const VALIDATION_KINDS = ["COMMAND", "MANUAL", "HUMAN"] as const;
export type ValidationKind = typeof VALIDATION_KINDS[number];

export const VALIDATION_OUTCOMES = [
  "PENDING",
  "PASS",
  "FAIL",
  "NOT_APPLICABLE",
  "INFRASTRUCTURE_FAILURE",
] as const;
export type ValidationOutcome = typeof VALIDATION_OUTCOMES[number];

export const ATTEMPT_RECOVERY_KINDS = ["NONE", "HUMAN_REQUIRED", "RECONCILIATION_REQUIRED"] as const;
export type AttemptRecoveryKind = typeof ATTEMPT_RECOVERY_KINDS[number];

export interface V2RunIdentity {
  readonly runId: string;
  readonly eventSchema: typeof EVENT_SCHEMA_V2;
  readonly stateSchema: typeof STATE_SCHEMA_V2;
  readonly operationalContract: typeof OPERATIONAL_CONTRACT_V2;
}

export interface ExecutorInvocationRef {
  readonly invocationId: string;
  readonly workUnitDigest: string;
  readonly attemptBaseFingerprint: string;
  readonly timeoutPolicyDigest: string;
  readonly capabilityPolicyDigest: string;
  readonly authorizedAt: string;
}

export interface ExecutorFinishedObservation {
  readonly invocationId: string;
  readonly status: ExecutorStatus;
  readonly termination: ExecutorTermination;
  readonly finishedAt: string;
}

/** A typed placeholder.  Physical evidence is intentionally a later slice. */
export interface EvidenceCaptureRef {
  readonly evidenceCaptureId: string;
  readonly evidenceDigest: string;
  readonly postExecutorFingerprint: string;
}

/** A typed placeholder.  Physical ValidationSet persistence is a later slice. */
export interface ValidationSetRef {
  readonly validationSetId: string;
  readonly validationSetDigest: string;
}

/** A typed placeholder.  Physical AuditPackage persistence is a later slice. */
export interface AuditPackageRef {
  readonly auditPackageId: string;
  readonly auditPackageDigest: string;
}

export interface ValidationSpecRef {
  readonly validationSpecId: string;
  readonly ordinal: number;
  readonly kind: ValidationKind;
  /** The original declarative command/manual/human instruction. */
  readonly instruction: string;
  readonly digest: string;
  readonly sourceTaskId: string;
  readonly sourcePlanIdentity: string;
}

export interface ValidationRunRef {
  readonly validationRunId: string;
  readonly validationSpecId: string;
  readonly validationSpecDigest: string;
  readonly validationRunOrdinal: number;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly outcome: ValidationOutcome;
  readonly exitCode?: number | null;
  readonly resultDigest?: string;
}

export interface DeterministicValidationSummary {
  readonly total: number;
  readonly completed: number;
  readonly passed: number;
  readonly failed: number;
  readonly notApplicable: number;
  readonly infrastructureFailures: number;
  readonly manualRequired: number;
  readonly humanRequired: number;
  readonly hardNegative: boolean;
}

export interface AttemptRecoveryState {
  readonly kind: AttemptRecoveryKind;
  readonly reason?: string;
  readonly proofRef?: string;
}

export interface V2AuditReadyPayload {
  readonly evidenceCaptureId: string;
  readonly evidenceDigest: string;
  readonly validationSetId: string;
  readonly validationSetDigest: string;
  readonly auditPackageId: string;
  readonly auditPackageDigest: string;
  readonly postExecutorFingerprint: string;
  readonly criterionSetDigest: string;
  readonly auditability: AuditabilityClassification;
  readonly validationSummary: DeterministicValidationSummary;
}

export interface AttemptStateV2 {
  readonly attemptId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly ordinal: number;
  readonly strategyGeneration: number;
  readonly attemptBaseFingerprint: string;
  readonly disposition: AttemptDisposition;
  /** For CLOSED Attempts this remains the last observable stage. */
  readonly stage: AttemptStage;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly closureReason?: AttemptClosureReason;
  readonly invocation?: ExecutorInvocationRef;
  readonly executorFinished?: ExecutorFinishedObservation;
  readonly evidenceCaptureInProgress?: {
    readonly evidenceCaptureId: string;
    readonly postExecutorFingerprint: string;
    readonly startedAt: string;
  };
  readonly evidenceCapture?: EvidenceCaptureRef;
  readonly validationSpecs: readonly ValidationSpecRef[];
  readonly validationRuns: readonly ValidationRunRef[];
  readonly validationSet?: ValidationSetRef;
  readonly auditPackage?: AuditPackageRef;
  readonly postExecutorFingerprint?: string;
  readonly criterionSetDigest?: string;
  readonly auditability?: AuditabilityClassification;
  readonly validationSummary?: DeterministicValidationSummary;
  readonly recovery: AttemptRecoveryState;
}

export interface RalphRuntimeStateV2 {
  readonly format: typeof STATE_SCHEMA_V2;
  readonly runId: string;
  readonly eventSchema: typeof EVENT_SCHEMA_V2;
  readonly stateSchema: typeof STATE_SCHEMA_V2;
  readonly operationalContract: typeof OPERATIONAL_CONTRACT_V2;
  // These dimensions are the Foundation authorities, reused by reference.
  readonly disposition: import("../contracts.js").RunDisposition;
  readonly hold: import("../contracts.js").RunHold;
  readonly phaseIds: readonly string[];
  readonly taskIds: readonly string[];
  readonly phases: Readonly<Record<string, PhaseState>>;
  readonly tasks: Readonly<Record<string, TaskState>>;
  readonly attempts: Readonly<Record<string, AttemptStateV2>>;
  readonly findings: Readonly<Record<string, Finding>>;
  readonly checkpoints: Readonly<Record<string, CheckpointRecord>>;
  readonly lastSequence: number;
  readonly lastEventHash: string | null;
  readonly finalStatePersisted: boolean;
}

// A concise alias for consumers that describe the value as a runtime state.
export type RuntimeStateV2 = RalphRuntimeStateV2;

// Keep these imports type-visible in generated declarations without creating a
// second runtime authority for the Foundation dimensions.
export type _V1RuntimeState = RalphRuntimeState;
export type _V1AuditResult = AuditResult;
