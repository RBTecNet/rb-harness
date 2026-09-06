import {
  EXECUTOR_STATUSES,
  EXECUTOR_TERMINATIONS,
  type ExecutorStatus,
  type ExecutorTermination,
} from "../operational-v2/contracts.js";
import { canonicalJson } from "../canonical-json.js";
import { isSha256Digest, sha256Canonical } from "../hashing.js";

export const EXECUTOR_OBSERVATION_SCHEMA_V2 = "rb-ralph-executor-observation/v1" as const;

export const EXECUTOR_OBSERVATION_STATES = [
  "NOT_INVOKED",
  "RUNNING",
  "TERMINATED_QUIESCENT",
  "UNKNOWN",
] as const;
export type ExecutorObservationStateV2 = typeof EXECUTOR_OBSERVATION_STATES[number];

export const EXECUTOR_RESULT_ENVELOPE_STATUSES = ["VALID", "INVALID"] as const;
export type ExecutorResultEnvelopeStatusV2 = typeof EXECUTOR_RESULT_ENVELOPE_STATUSES[number];

export const EXECUTOR_BOUNDARY_STATES = ["NOT_CROSSED", "CROSSED"] as const;
export type ExecutorBoundaryStateV2 = typeof EXECUTOR_BOUNDARY_STATES[number];

export const LEASE_OWNERSHIP_STATES = ["VERIFIED_CURRENT_OWNER"] as const;
export type LeaseOwnershipStateV2 = typeof LEASE_OWNERSHIP_STATES[number];

/**
 * The executor boundary returns this value as an untrusted observation.  It
 * is a closed, digest-checked runtime envelope, not a Core capability.
 */
export interface ExecutorObservationEnvelopeV2 {
  readonly schema: typeof EXECUTOR_OBSERVATION_SCHEMA_V2;
  readonly runtimeIdentity: string;
  readonly observationId: string;
  readonly invocationId: string;
  readonly state: ExecutorObservationStateV2;
  readonly observedAt: string;
  readonly status?: ExecutorStatus;
  readonly termination?: ExecutorTermination;
  readonly resultEnvelopeStatus?: ExecutorResultEnvelopeStatusV2;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly startedObservationId?: string;
  readonly safeMetadata: Readonly<Record<string, string>>;
  readonly observationDigest: string;
}

export interface ExecutorObservationInputV2 {
  readonly runtimeIdentity: string;
  readonly observationId: string;
  readonly invocationId: string;
  readonly state: ExecutorObservationStateV2;
  readonly observedAt: string;
  readonly status?: ExecutorStatus;
  readonly termination?: ExecutorTermination;
  readonly resultEnvelopeStatus?: ExecutorResultEnvelopeStatusV2;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly startedObservationId?: string;
  readonly safeMetadata?: Readonly<Record<string, string>>;
}

/** The binding Core adds after validating an envelope against its ledger. */
export interface ExecutorObservationBindingV2 {
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly invocationId: string;
}

/** A trusted record includes the exact Core-owned invocation binding. */
export interface ExecutorObservationRecordV2 extends ExecutorObservationEnvelopeV2, ExecutorObservationBindingV2 {}

/**
 * Opaque at runtime.  The interface is intentionally exportable for carrying
 * a Core result, while the membership check and minting remain in execution.ts.
 */
export interface TrustedExecutorObservationV2 {
  readonly kind: "TRUSTED_EXECUTOR_OBSERVATION";
  readonly record: ExecutorObservationRecordV2;
  readonly runtimeIdentity: string;
  readonly observationId: string;
  readonly invocationId: string;
  readonly state: ExecutorObservationStateV2;
  readonly observedAt: string;
  readonly status?: ExecutorStatus;
  readonly termination?: ExecutorTermination;
  readonly resultEnvelopeStatus?: ExecutorResultEnvelopeStatusV2;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly startedObservationId?: string;
  readonly safeMetadata: Readonly<Record<string, string>>;
  readonly observationDigest: string;
}

export interface NotInvokedProofRecordV2 {
  readonly kind: "NOT_INVOKED";
  readonly proofId: string;
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly invocationId: string;
  readonly runtimeIdentity: string;
  readonly observationId: string;
  readonly observationDigest: string;
}

/** A Core-minted proof that one exact bound invocation was not invoked. */
export interface NotInvokedProofV2 {
  readonly kind: "NOT_INVOKED";
  readonly record: NotInvokedProofRecordV2;
  readonly proofId: string;
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly invocationId: string;
  readonly runtimeIdentity: string;
  readonly observationId: string;
  readonly observationDigest: string;
  toJSON(): NotInvokedProofRecordV2;
}

export interface LeaseReleaseProofRecordV2 {
  readonly kind: "CORE_LEASE_RELEASE_PROOF";
  readonly proofId: string;
  readonly runId: string;
  readonly leaseId: string;
  readonly phaseId?: string;
  readonly taskId?: string;
  readonly attemptId?: string;
  readonly invocationId?: string;
  readonly runtimeIdentity?: string;
  readonly observationId?: string;
  readonly observationDigest?: string;
  readonly externalInvocationState: ExecutorObservationStateV2;
  readonly semanticEventsDurable: "DURABLE";
  readonly artifactWritesDurable: "DURABLE";
  readonly leaseOwnership: LeaseOwnershipStateV2;
  readonly executorBoundaryState: ExecutorBoundaryStateV2;
  readonly artifactRefs: readonly string[];
}

/** A Core-minted, lease-bound release capability. */
export interface LeaseReleaseProofV2 {
  readonly kind: "CORE_LEASE_RELEASE_PROOF";
  readonly record: LeaseReleaseProofRecordV2;
  readonly proofId: string;
  readonly runId: string;
  readonly leaseId: string;
  readonly phaseId?: string;
  readonly taskId?: string;
  readonly attemptId?: string;
  readonly invocationId?: string;
  readonly runtimeIdentity?: string;
  readonly observationId?: string;
  readonly observationDigest?: string;
  readonly externalInvocationState: ExecutorObservationStateV2;
  readonly semanticEventsDurable: "DURABLE";
  readonly artifactWritesDurable: "DURABLE";
  readonly leaseOwnership: LeaseOwnershipStateV2;
  readonly executorBoundaryState: ExecutorBoundaryStateV2;
  readonly artifactRefs: readonly string[];
  toJSON(): LeaseReleaseProofRecordV2;
}

/**
 * Build only an untrusted runtime envelope.  This function never creates a
 * trusted observation, a NOT_INVOKED proof, or release authority.
 */
export function buildExecutorObservationEnvelopeV2(input: ExecutorObservationInputV2): ExecutorObservationEnvelopeV2 {
  validateExecutorObservationInputV2(input);
  const base: Omit<ExecutorObservationEnvelopeV2, "observationDigest"> = {
    schema: EXECUTOR_OBSERVATION_SCHEMA_V2,
    runtimeIdentity: input.runtimeIdentity,
    observationId: input.observationId,
    invocationId: input.invocationId,
    state: input.state,
    observedAt: input.observedAt,
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.termination === undefined ? {} : { termination: input.termination }),
    ...(input.resultEnvelopeStatus === undefined ? {} : { resultEnvelopeStatus: input.resultEnvelopeStatus }),
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
    ...(input.finishedAt === undefined ? {} : { finishedAt: input.finishedAt }),
    ...(input.startedObservationId === undefined ? {} : { startedObservationId: input.startedObservationId }),
    safeMetadata: { ...(input.safeMetadata ?? {}) },
  };
  const envelope: ExecutorObservationEnvelopeV2 = {
    ...base,
    observationDigest: sha256Canonical(base),
  };
  validateExecutorObservationEnvelopeV2(envelope);
  return freezeDeep(envelope);
}

export function validateExecutorObservationEnvelopeV2(value: unknown): asserts value is ExecutorObservationEnvelopeV2 {
  if (!isRecord(value)) throw new Error("RALPH_EXECUTOR_OBSERVATION_INVALID");
  assertExactKeys(value, [
    "schema", "runtimeIdentity", "observationId", "invocationId", "state", "observedAt", "status", "termination",
    "resultEnvelopeStatus", "exitCode", "signal", "startedAt", "finishedAt", "startedObservationId", "safeMetadata", "observationDigest",
  ]);
  if (value.schema !== EXECUTOR_OBSERVATION_SCHEMA_V2 || !isSha256Digest(value.observationDigest)) throw new Error("RALPH_EXECUTOR_OBSERVATION_INVALID");
  const { observationDigest: _ignored, ...base } = value;
  if (sha256Canonical(base) !== value.observationDigest) throw new Error("RALPH_EXECUTOR_OBSERVATION_DIGEST_MISMATCH");
  validateExecutorObservationInputV2(value as unknown as ExecutorObservationEnvelopeV2);
}

export function canonicalExecutorObservationV2(value: TrustedExecutorObservationV2): string {
  return canonicalJson(value.record);
}

function validateExecutorObservationInputV2(input: ExecutorObservationInputV2 | ExecutorObservationEnvelopeV2): void {
  if (!isRecord(input)) throw new Error("RALPH_EXECUTOR_OBSERVATION_INVALID");
  assertSafeIdentity(input.runtimeIdentity, "RALPH_EXECUTOR_OBSERVATION_INVALID");
  assertSafeIdentity(input.observationId, "RALPH_EXECUTOR_OBSERVATION_INVALID");
  assertSafeIdentity(input.invocationId, "RALPH_EXECUTOR_OBSERVATION_INVALID");
  assertSafeIdentity(input.observedAt, "RALPH_EXECUTOR_OBSERVATION_INVALID");
  if (!EXECUTOR_OBSERVATION_STATES.includes(input.state)) throw new Error("RALPH_EXECUTOR_OBSERVATION_STATE_INVALID");
  if (input.status !== undefined && !EXECUTOR_STATUSES.includes(input.status)) throw new Error("RALPH_EXECUTOR_OBSERVATION_STATUS_INVALID");
  if (input.termination !== undefined && !EXECUTOR_TERMINATIONS.includes(input.termination)) throw new Error("RALPH_EXECUTOR_OBSERVATION_TERMINATION_INVALID");
  if (input.resultEnvelopeStatus !== undefined && !EXECUTOR_RESULT_ENVELOPE_STATUSES.includes(input.resultEnvelopeStatus)) throw new Error("RALPH_EXECUTOR_OBSERVATION_RESULT_INVALID");
  validateObservationShape(input);
  validateSafeMetadata(input.safeMetadata ?? {});
}

function validateObservationShape(input: Pick<ExecutorObservationInputV2, "state" | "status" | "termination" | "resultEnvelopeStatus" | "startedAt" | "finishedAt" | "startedObservationId">): void {
  const hasStarted = input.startedAt !== undefined;
  const hasFinished = input.finishedAt !== undefined;
  if (input.state === "NOT_INVOKED") {
    if (input.status !== undefined || input.termination !== undefined || input.resultEnvelopeStatus !== undefined || hasStarted || hasFinished || input.startedObservationId !== undefined) {
      throw new Error("RALPH_EXECUTOR_OBSERVATION_NOT_INVOKED_SHAPE_INVALID");
    }
    return;
  }
  if (input.state === "RUNNING") {
    if (!hasStarted || hasFinished || input.status !== undefined || input.termination !== undefined || input.resultEnvelopeStatus !== undefined) {
      throw new Error("RALPH_EXECUTOR_OBSERVATION_RUNNING_SHAPE_INVALID");
    }
    if (input.startedObservationId !== undefined) assertSafeIdentity(input.startedObservationId, "RALPH_EXECUTOR_OBSERVATION_INVALID");
    return;
  }
  if (input.state === "UNKNOWN") {
    if (input.status !== undefined || input.termination !== undefined || input.resultEnvelopeStatus !== undefined || hasStarted || hasFinished || input.startedObservationId !== undefined) {
      throw new Error("RALPH_EXECUTOR_OBSERVATION_UNKNOWN_SHAPE_INVALID");
    }
    return;
  }
  if (!input.status || !input.termination || !input.resultEnvelopeStatus || !hasFinished) throw new Error("RALPH_EXECUTOR_OBSERVATION_TERMINATED_SHAPE_INVALID");
  if (input.resultEnvelopeStatus === "VALID" && input.status === "UNAVAILABLE") throw new Error("RALPH_EXECUTOR_OBSERVATION_UNAVAILABLE_RESULT_INVALID");
  if (input.startedAt !== undefined) assertSafeIdentity(input.startedAt, "RALPH_EXECUTOR_OBSERVATION_INVALID");
  if (input.finishedAt !== undefined) assertSafeIdentity(input.finishedAt, "RALPH_EXECUTOR_OBSERVATION_INVALID");
  if (input.startedObservationId !== undefined) assertSafeIdentity(input.startedObservationId, "RALPH_EXECUTOR_OBSERVATION_INVALID");
}

function assertSafeIdentity(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\0") || value.includes("/")) throw new Error(code);
}

function validateSafeMetadata(value: Readonly<Record<string, string>>): void {
  if (!isRecord(value)) throw new Error("RALPH_EXECUTOR_OBSERVATION_METADATA_INVALID");
  for (const [key, item] of Object.entries(value)) {
    assertSafeIdentity(key, "RALPH_EXECUTOR_OBSERVATION_METADATA_INVALID");
    if (typeof item !== "string" || item.length > 512 || /(?:Bearer\s+\S+|-----BEGIN[^-]*PRIVATE KEY-----|(?:api[_-]?key|password|secret)\s*[:=])/i.test(item)) {
      throw new Error("RALPH_EXECUTOR_OBSERVATION_METADATA_INVALID");
    }
  }
}

function assertExactKeys(value: object, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new Error(`RALPH_EXECUTOR_OBSERVATION_UNKNOWN_FIELD_${unknown.sort().join(",")}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function freezeDeep<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  return value;
}
