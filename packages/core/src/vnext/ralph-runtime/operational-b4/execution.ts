import { randomUUID } from "node:crypto";
import type { ExecutionDocument } from "../../../types.js";
import type { RalphEventStoreV2 } from "../operational-b1/index.js";
import {
  repairStateSnapshotWhileLeasedV2,
  revalidateLeaseOwnershipV2,
  refreshLeasedRunV2,
  releaseLeasedRunV2,
  type LeasedRunV2,
} from "../operational-b2/index.js";
import { commitRalphEventV2 } from "../operational-b1/index.js";
import type { AttemptStateV2, RalphRuntimeStateV2 } from "../operational-v2/contracts.js";
import {
  createRalphEventV2,
  type EventPayloadMapV2,
  type RalphEventV2,
  type RalphEventTypeV2,
  type UnsignedRalphEventV2,
} from "../operational-v2/events.js";
import {
  assertAuthorizedInvocationV2,
  assertPostExecutorObservationAuthorizationV2,
  authorizePostExecutorObservationV2,
  postExecutorObservationAuthorizationRecordV2,
  reopenAuthorizedInvocationV2,
  type AuthorizedInvocationV2,
  type PostExecutorObservationAuthorizationV2,
  type ReopenedAuthorizedInvocationV2,
} from "../operational-b3/index.js";
import {
  ExecutorRuntimeError,
  assertObservationForInvocation,
} from "./executor-runtime.js";
import {
  assertTrustedExecutorRuntimeV2,
  type TrustedExecutorRuntimeV2,
} from "./scripted-executor.js";
import {
  validateExecutorObservationEnvelopeV2,
  type ExecutorObservationBindingV2,
  type ExecutorObservationEnvelopeV2,
  type ExecutorObservationRecordV2,
  type ExecutorObservationStateV2,
  type NotInvokedProofV2,
  type TrustedExecutorObservationV2,
  type NotInvokedProofRecordV2,
} from "./execution-observation.js";
import {
  invocationResultRefV2,
  createInvocationResultV2,
  persistInvocationResultV2,
  readInvocationResultV2,
  validateInvocationResultV2,
  type InvocationResultV2,
} from "./invocation-result.js";
import {
  observeWorkspaceManifestV2,
  persistWorkspaceBeforeManifestV2,
  readWorkspaceBeforeManifestV2,
  workspaceBeforeRefV2,
  type WorkspaceManifestV2,
} from "./workspace-manifest.js";
import { canonicalJson } from "../canonical-json.js";
import { isSha256Digest, sha256Canonical } from "../hashing.js";
import {
  attemptArtifactRefV2,
  persistImmutableJsonArtifactV2,
  readImmutableJsonArtifactV2,
  type ArtifactPersistenceResultV2,
  RalphB4ArtifactError,
} from "./artifacts.js";

export const B4_EXECUTION_ERROR_CODES = [
  "B4_AUTHORIZATION_REQUIRED",
  "B4_OBSERVATION_RECONCILIATION_REQUIRED",
  "B4_BASE_MANIFEST_REQUIRED",
  "B4_BASE_MANIFEST_MISMATCH",
  "B4_STARTED_OBSERVATION_REQUIRED",
  "B4_RESULT_OBSERVATION_INVALID",
  "B4_RESULT_IMMUTABLE_CONFLICT",
  "B4_OBSERVATION_RECEIPT_REQUIRED",
  "B4_OBSERVATION_RECEIPT_INVALID",
  "B4_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION",
] as const;
export type B4ExecutionErrorCode = typeof B4_EXECUTION_ERROR_CODES[number];

export class RalphB4ExecutionError extends Error {
  constructor(readonly code: B4ExecutionErrorCode, message: string = code, readonly cause?: unknown) {
    super(message);
    this.name = "RalphB4ExecutionError";
  }
}

export const EXECUTOR_OBSERVATION_RECEIPT_SCHEMA_V2 = "rb-ralph-executor-observation-receipt/v1" as const;

export interface ExecutorObservationReceiptV2 extends ExecutorObservationBindingV2 {
  readonly schema: typeof EXECUTOR_OBSERVATION_RECEIPT_SCHEMA_V2;
  readonly coreBindingDigest: string;
  readonly observation: ExecutorObservationEnvelopeV2;
  readonly receiptDigest: string;
}

const trustedObservationInternals = new WeakMap<TrustedExecutorObservationV2, ExecutorObservationRecordV2>();
const TRUSTED_OBSERVATION_SEAL = Symbol("TrustedExecutorObservationV2");

/**
 * The only trusted-observation implementation.  It is deliberately private
 * to the Core execution module; callers receive only the interface and can
 * carry the resulting capability.
 */
class CoreTrustedExecutorObservationV2 implements TrustedExecutorObservationV2 {
  readonly kind = "TRUSTED_EXECUTOR_OBSERVATION" as const;

  constructor(record: ExecutorObservationRecordV2, seal: symbol) {
    if (seal !== TRUSTED_OBSERVATION_SEAL) throw new Error("RALPH_EXECUTOR_OBSERVATION_CONSTRUCTION_FORBIDDEN");
    trustedObservationInternals.set(this, freezeDeep(record));
    Object.freeze(this);
  }

  get record(): ExecutorObservationRecordV2 { return requireTrustedObservation(this); }
  get runtimeIdentity(): string { return requireTrustedObservation(this).runtimeIdentity; }
  get observationId(): string { return requireTrustedObservation(this).observationId; }
  get invocationId(): string { return requireTrustedObservation(this).invocationId; }
  get state(): ExecutorObservationStateV2 { return requireTrustedObservation(this).state; }
  get observedAt(): string { return requireTrustedObservation(this).observedAt; }
  get status(): TrustedExecutorObservationV2["status"] { return requireTrustedObservation(this).status; }
  get termination(): TrustedExecutorObservationV2["termination"] { return requireTrustedObservation(this).termination; }
  get resultEnvelopeStatus(): TrustedExecutorObservationV2["resultEnvelopeStatus"] { return requireTrustedObservation(this).resultEnvelopeStatus; }
  get exitCode(): TrustedExecutorObservationV2["exitCode"] { return requireTrustedObservation(this).exitCode; }
  get signal(): TrustedExecutorObservationV2["signal"] { return requireTrustedObservation(this).signal; }
  get startedAt(): TrustedExecutorObservationV2["startedAt"] { return requireTrustedObservation(this).startedAt; }
  get finishedAt(): TrustedExecutorObservationV2["finishedAt"] { return requireTrustedObservation(this).finishedAt; }
  get startedObservationId(): TrustedExecutorObservationV2["startedObservationId"] { return requireTrustedObservation(this).startedObservationId; }
  get safeMetadata(): TrustedExecutorObservationV2["safeMetadata"] { return requireTrustedObservation(this).safeMetadata; }
  get observationDigest(): string { return requireTrustedObservation(this).observationDigest; }

  toJSON(): ExecutorObservationRecordV2 { return this.record; }
}
Object.freeze(CoreTrustedExecutorObservationV2.prototype);

const notInvokedProofInternals = new WeakMap<NotInvokedProofV2, NotInvokedProofRecordV2>();
const NOT_INVOKED_PROOF_SEAL = Symbol("NotInvokedProofV2");

class CoreNotInvokedProofV2 implements NotInvokedProofV2 {
  readonly kind = "NOT_INVOKED" as const;

  constructor(record: NotInvokedProofRecordV2, seal: symbol) {
    if (seal !== NOT_INVOKED_PROOF_SEAL) throw new Error("RALPH_NOT_INVOKED_PROOF_CONSTRUCTION_FORBIDDEN");
    notInvokedProofInternals.set(this, freezeDeep(record));
    Object.freeze(this);
  }

  get record(): NotInvokedProofRecordV2 { return requireNotInvokedProof(this); }
  get proofId(): string { return requireNotInvokedProof(this).proofId; }
  get runId(): string { return requireNotInvokedProof(this).runId; }
  get phaseId(): string { return requireNotInvokedProof(this).phaseId; }
  get taskId(): string { return requireNotInvokedProof(this).taskId; }
  get attemptId(): string { return requireNotInvokedProof(this).attemptId; }
  get invocationId(): string { return requireNotInvokedProof(this).invocationId; }
  get runtimeIdentity(): string { return requireNotInvokedProof(this).runtimeIdentity; }
  get observationId(): string { return requireNotInvokedProof(this).observationId; }
  get observationDigest(): string { return requireNotInvokedProof(this).observationDigest; }

  toJSON(): NotInvokedProofRecordV2 { return this.record; }
}
Object.freeze(CoreNotInvokedProofV2.prototype);

export function isTrustedExecutorObservationV2(value: unknown): value is TrustedExecutorObservationV2 {
  return typeof value === "object" && value !== null && trustedObservationInternals.has(value as TrustedExecutorObservationV2);
}

export function assertTrustedExecutorObservationV2(value: unknown): asserts value is TrustedExecutorObservationV2 {
  if (!isTrustedExecutorObservationV2(value)) throw new Error("RALPH_EXECUTOR_OBSERVATION_TRUST_REQUIRED");
}

export function isNotInvokedProofV2(value: unknown): value is NotInvokedProofV2 {
  return typeof value === "object" && value !== null && notInvokedProofInternals.has(value as NotInvokedProofV2);
}

export function assertNotInvokedProofV2(value: unknown): asserts value is NotInvokedProofV2 {
  if (!isNotInvokedProofV2(value)) throw new Error("RALPH_NOT_INVOKED_PROOF_TRUST_REQUIRED");
}

/**
 * Core-only observation boundary.  The runtime supplies an untrusted
 * envelope; this module validates its digest and runtime/invocation identity
 * before attaching the authoritative run/phase/task/attempt binding.
 */
export async function observeTrustedExecutorInvocationV2(
  runtime: TrustedExecutorRuntimeV2,
  authorizedInvocation: AuthorizedInvocationV2,
): Promise<TrustedExecutorObservationV2> {
  assertTrustedExecutorRuntimeV2(runtime);
  const binding = authorizedInvocationObservationBinding(authorizedInvocation);
  const envelope = await runtime.observe(binding.invocationId);
  assertObservationForInvocation(envelope, binding.invocationId);
  return sealTrustedExecutorObservationV2(envelope, binding, runtime.runtimeIdentity);
}

export function executorObservationReceiptRefV2(attemptId: string): string {
  return attemptArtifactRefV2(attemptId, "executor-observation-receipt.json");
}

export function validateExecutorObservationReceiptV2(value: unknown): asserts value is ExecutorObservationReceiptV2 {
  if (!isRecord(value)) throw observationReceiptError("B4_OBSERVATION_RECEIPT_INVALID");
  assertExactReceiptKeys(value, [
    "schema", "runId", "phaseId", "taskId", "attemptId", "invocationId",
    "coreBindingDigest", "observation", "receiptDigest",
  ]);
  if (value.schema !== EXECUTOR_OBSERVATION_RECEIPT_SCHEMA_V2) throw observationReceiptError("B4_OBSERVATION_RECEIPT_INVALID");
  const binding = receiptBinding(value);
  for (const item of Object.values(binding)) assertReceiptIdentity(item);
  const expectedBindingDigest = sha256Canonical(binding);
  if (!isSha256Digest(value.coreBindingDigest) || value.coreBindingDigest !== expectedBindingDigest) {
    throw observationReceiptError("B4_OBSERVATION_RECEIPT_INVALID");
  }
  try { validateExecutorObservationEnvelopeV2(value.observation); }
  catch (error) { throw observationReceiptError("B4_OBSERVATION_RECEIPT_INVALID", error); }
  if (value.observation.invocationId !== binding.invocationId) throw observationReceiptError("B4_OBSERVATION_RECEIPT_INVALID");
  if (!isSha256Digest(value.receiptDigest)) throw observationReceiptError("B4_OBSERVATION_RECEIPT_INVALID");
  const { receiptDigest: _ignored, ...base } = value;
  if (sha256Canonical(base) !== value.receiptDigest) throw observationReceiptError("B4_OBSERVATION_RECEIPT_INVALID");
}

/** Persistable only from the process-local nominal observation capability. */
export async function persistTrustedExecutorObservationReceiptV2(
  store: RalphEventStoreV2,
  observation: TrustedExecutorObservationV2,
  nonce: string,
): Promise<ArtifactPersistenceResultV2<ExecutorObservationReceiptV2>> {
  const record = requireTrustedObservation(observation);
  const binding: ExecutorObservationBindingV2 = {
    runId: record.runId,
    phaseId: record.phaseId,
    taskId: record.taskId,
    attemptId: record.attemptId,
    invocationId: record.invocationId,
  };
  if (binding.runId !== store.runId) throw observationReceiptError("B4_OBSERVATION_RECEIPT_INVALID");
  const observationEnvelope = observationEnvelopeFromRecord(record);
  const base = {
    schema: EXECUTOR_OBSERVATION_RECEIPT_SCHEMA_V2,
    ...binding,
    coreBindingDigest: sha256Canonical(binding),
    observation: observationEnvelope,
  } as const;
  const receipt: ExecutorObservationReceiptV2 = freezeDeep({ ...base, receiptDigest: sha256Canonical(base) });
  validateExecutorObservationReceiptV2(receipt);
  return persistImmutableJsonArtifactV2({
    store,
    ref: executorObservationReceiptRefV2(receipt.attemptId),
    artifact: receipt,
    validate: validateExecutorObservationReceiptV2,
    nonce,
  });
}

export async function readExecutorObservationReceiptV2(
  store: RalphEventStoreV2,
  attemptId: string,
): Promise<ExecutorObservationReceiptV2 | undefined> {
  return readImmutableJsonArtifactV2({
    store,
    ref: executorObservationReceiptRefV2(attemptId),
    validate: validateExecutorObservationReceiptV2,
  });
}

/**
 * Re-seals a trusted observation exclusively from mutually agreeing durable
 * Core authorities. No executor runtime is observed or invoked here.
 */
export async function rehydrateTrustedExecutorObservationV2(input: {
  readonly leasedRun: LeasedRunV2;
  readonly authorization: PostExecutorObservationAuthorizationV2;
}): Promise<TrustedExecutorObservationV2> {
  assertPostExecutorObservationAuthorizationV2(input.authorization);
  await revalidateLeaseOwnershipV2(input.leasedRun);
  const authorization = postExecutorObservationAuthorizationRecordV2(input.authorization);
  const attempt = input.leasedRun.state.attempts[authorization.attemptId];
  if (input.leasedRun.runId !== authorization.runId
    || !attempt || attempt.disposition !== "OPEN" || attempt.stage !== authorization.stage
    || !attempt.invocation || !attempt.executorFinished
    || attempt.phaseId !== authorization.phaseId || attempt.taskId !== authorization.taskId
    || attempt.invocation.invocationId !== authorization.invocationId
    || attempt.executorFinished.invocationId !== authorization.invocationId
    || sha256Canonical(input.leasedRun.snapshot) !== authorization.snapshotDigest) {
    throw new RalphB4ExecutionError("B4_OBSERVATION_RECEIPT_INVALID");
  }
  const receipt = await readExecutorObservationReceiptV2(input.leasedRun.store, authorization.attemptId);
  if (!receipt) throw new RalphB4ExecutionError("B4_OBSERVATION_RECEIPT_REQUIRED");
  const result = await readInvocationResultV2(input.leasedRun.store, authorization.attemptId);
  if (!result) throw new RalphB4ExecutionError("B4_OBSERVATION_RECEIPT_REQUIRED", "B4_OBSERVATION_RECEIPT_REQUIRED: InvocationResult is absent");
  assertReceiptAuthorizationBinding(receipt, authorization);
  assertReceiptResultAndAttemptBinding(receipt, result, attempt);
  return sealTrustedExecutorObservationV2(receipt.observation, receiptBinding(receipt), receipt.observation.runtimeIdentity);
}

/** Derive NOT_INVOKED authority only from a sealed, exactly bound observation. */
export function deriveNotInvokedProofV2(
  observation: TrustedExecutorObservationV2,
  authorizedInvocation: AuthorizedInvocationV2,
): NotInvokedProofV2 {
  assertTrustedExecutorObservationV2(observation);
  const binding = authorizedInvocationObservationBinding(authorizedInvocation);
  assertTrustedObservationBinding(observation, binding);
  if (observation.state !== "NOT_INVOKED") throw new Error("RALPH_NOT_INVOKED_PROOF_STATE_INVALID");
  const proofBase = {
    kind: "NOT_INVOKED" as const,
    runId: binding.runId,
    phaseId: binding.phaseId,
    taskId: binding.taskId,
    attemptId: binding.attemptId,
    invocationId: binding.invocationId,
    runtimeIdentity: observation.runtimeIdentity,
    observationId: observation.observationId,
    observationDigest: observation.observationDigest,
  };
  const record: NotInvokedProofRecordV2 = {
    ...proofBase,
    proofId: `nip-${sha256Canonical(proofBase).slice("sha256:".length)}`,
  };
  return new CoreNotInvokedProofV2(record, NOT_INVOKED_PROOF_SEAL);
}

function sealTrustedExecutorObservationV2(
  envelope: ExecutorObservationEnvelopeV2,
  binding: ExecutorObservationBindingV2,
  runtimeIdentity: string,
): TrustedExecutorObservationV2 {
  validateExecutorObservationEnvelopeV2(envelope);
  assertCoreBinding(binding);
  if (envelope.runtimeIdentity !== runtimeIdentity) throw new ExecutorRuntimeError("B4_EXECUTOR_INVOCATION_ID_INVALID", "B4_EXECUTOR_INVOCATION_ID_INVALID: runtime identity mismatch");
  if (envelope.invocationId !== binding.invocationId) throw new ExecutorRuntimeError("B4_EXECUTOR_INVOCATION_ID_INVALID", "B4_EXECUTOR_INVOCATION_ID_INVALID: observation binding mismatch");
  const record: ExecutorObservationRecordV2 = {
    ...envelope,
    runId: binding.runId,
    phaseId: binding.phaseId,
    taskId: binding.taskId,
    attemptId: binding.attemptId,
    invocationId: binding.invocationId,
  };
  return new CoreTrustedExecutorObservationV2(record, TRUSTED_OBSERVATION_SEAL);
}

/**
 * Reconstruct the observation binding only from the sealed M1 capability.
 * Descriptor/work-unit overlap is checked here so a capability assembled from
 * mismatched durable facts cannot become an observation root.
 */
function authorizedInvocationObservationBinding(authorizedInvocation: AuthorizedInvocationV2): ExecutorObservationBindingV2 {
  assertAuthorizedInvocationV2(authorizedInvocation);
  const descriptor = authorizedInvocation.descriptor;
  const workUnit = authorizedInvocation.workUnit;
  if (descriptor.runId !== workUnit.runId
    || descriptor.phaseId !== workUnit.phaseId
    || descriptor.taskId !== workUnit.taskId
    || descriptor.attemptId !== workUnit.attemptId
    || descriptor.ordinal !== workUnit.ordinal
    || descriptor.workUnitId !== workUnit.workUnitId
    || descriptor.workUnitDigest !== workUnit.workUnitDigest
    || descriptor.executorProfileIdentity !== workUnit.executorProfileIdentity
    || descriptor.executorProfileDigest !== workUnit.executorProfileDigest
    || descriptor.attemptBaseFingerprint !== workUnit.attemptBaseFingerprint
    || descriptor.timeoutPolicyDigest !== workUnit.timeoutPolicyDigest
    || descriptor.capabilityPolicyDigest !== workUnit.capabilityPolicyDigest
    || descriptor.createdAt !== workUnit.createdAt) {
    throw new ExecutorRuntimeError("B4_EXECUTOR_AUTHORIZATION_REQUIRED", "B4_EXECUTOR_AUTHORIZATION_REQUIRED: authorized invocation binding mismatch");
  }
  const binding = {
    runId: descriptor.runId,
    phaseId: descriptor.phaseId,
    taskId: descriptor.taskId,
    attemptId: descriptor.attemptId,
    invocationId: descriptor.invocationId,
  } satisfies ExecutorObservationBindingV2;
  assertCoreBinding(binding);
  return binding;
}

function assertTrustedObservationBinding(observation: TrustedExecutorObservationV2, binding: ExecutorObservationBindingV2): void {
  assertCoreBinding(binding);
  const record = observation.record;
  if (record.runId !== binding.runId || record.phaseId !== binding.phaseId || record.taskId !== binding.taskId || record.attemptId !== binding.attemptId || record.invocationId !== binding.invocationId) {
    throw new Error("RALPH_EXECUTOR_OBSERVATION_BINDING_INVALID");
  }
}

function assertCoreBinding(binding: ExecutorObservationBindingV2): void {
  for (const value of [binding.runId, binding.phaseId, binding.taskId, binding.attemptId, binding.invocationId]) {
    if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\0") || value.includes("/")) {
      throw new Error("RALPH_EXECUTOR_OBSERVATION_BINDING_INVALID");
    }
  }
}

function requireTrustedObservation(value: TrustedExecutorObservationV2): ExecutorObservationRecordV2 {
  const record = trustedObservationInternals.get(value);
  if (!record) throw new Error("RALPH_EXECUTOR_OBSERVATION_TRUST_REQUIRED");
  return record;
}

function requireNotInvokedProof(value: NotInvokedProofV2): NotInvokedProofRecordV2 {
  const record = notInvokedProofInternals.get(value);
  if (!record) throw new Error("RALPH_NOT_INVOKED_PROOF_TRUST_REQUIRED");
  return record;
}

export interface ExecuteAuthorizedInvocationV2Input {
  readonly leasedRun: LeasedRunV2;
  readonly plan: ExecutionDocument;
  readonly runtime: TrustedExecutorRuntimeV2;
  readonly attemptId?: string;
  readonly planIdentity?: string;
  readonly planDigest?: string;
  readonly workspaceFingerprintFileSystem?: import("../fingerprint.js").WorkspaceFingerprintFileSystem;
  readonly clock?: () => string;
  readonly nonceFactory?: () => string;
  readonly eventIdFactory?: () => string;
}

export type ExecuteAuthorizedInvocationV2Result =
  | {
    readonly kind: "EXECUTOR_RUNNING";
    readonly outcome: "EXECUTOR_RUNNING";
    readonly state: RalphRuntimeStateV2;
    readonly attempt: AttemptStateV2;
    readonly invocationId: string;
    readonly observation: TrustedExecutorObservationV2;
    readonly notInvokedProof?: NotInvokedProofV2;
    readonly leaseReleased: false;
  }
  | {
    readonly kind: "EXECUTOR_FINISHED_READY_FOR_CAPTURE";
    readonly outcome: "EXECUTOR_FINISHED_READY_FOR_CAPTURE";
    readonly state: RalphRuntimeStateV2;
    readonly attempt: AttemptStateV2;
    readonly invocationId: string;
    readonly observation: TrustedExecutorObservationV2;
    readonly resultArtifact: InvocationResultV2;
    readonly leaseReleased: false;
  }
  | {
    readonly kind: "EVIDENCE_CAPTURE_IN_PROGRESS";
    readonly outcome: "EVIDENCE_CAPTURE_IN_PROGRESS";
    readonly state: RalphRuntimeStateV2;
    readonly attempt: AttemptStateV2;
    readonly invocationId: string;
    readonly leaseReleased: false;
  }
  | {
    readonly kind: "EXECUTOR_UNAVAILABLE" | "EXECUTOR_PROTOCOL_FAILURE" | "EXECUTOR_CANCELLED";
    readonly outcome: "EXECUTOR_UNAVAILABLE" | "EXECUTOR_PROTOCOL_FAILURE" | "EXECUTOR_CANCELLED";
    readonly state: RalphRuntimeStateV2;
    readonly attempt: AttemptStateV2;
    readonly invocationId: string;
    readonly observation: TrustedExecutorObservationV2;
    readonly leaseReleased: true;
  }
  | {
    readonly kind: "RECONCILIATION_REQUIRED";
    readonly outcome: "RECONCILIATION_REQUIRED";
    readonly state: RalphRuntimeStateV2;
    readonly attempt: AttemptStateV2;
    readonly invocationId: string;
    readonly observation: TrustedExecutorObservationV2;
    readonly leaseReleased: false;
  };

/**
 * B4 execution continuation.  It begins with a durable dispatch authorization,
 * observes before invoking, and never invokes from a post-executor/evidence
 * state.  All Ralph facts still cross the B1 coordinator.
 */
export async function executeAuthorizedInvocationV2(input: ExecuteAuthorizedInvocationV2Input): Promise<ExecuteAuthorizedInvocationV2Result> {
  const clock = input.clock ?? (() => new Date().toISOString());
  const nonceFactory = input.nonceFactory ?? randomUUID;
  const eventIdFactory = input.eventIdFactory ?? randomUUID;
  await refreshLeasedRunV2(input.leasedRun);
  const initialAttempt = findAttempt(input.leasedRun.state, input.attemptId);
  if (!initialAttempt) throw new RalphB4ExecutionError("B4_AUTHORIZATION_REQUIRED", "B4_AUTHORIZATION_REQUIRED: no open Attempt");
  if (initialAttempt.stage === "RECONCILING") {
    if (!initialAttempt.invocation) throw new RalphB4ExecutionError("B4_OBSERVATION_RECONCILIATION_REQUIRED");
    const reconciled = await reopenAuthorizedInvocationV2({
      leasedRun: input.leasedRun,
      plan: input.plan,
      attemptId: initialAttempt.attemptId,
      planIdentity: input.planIdentity,
      planDigest: input.planDigest,
      requireBaseFingerprint: false,
    });
    const reconciledObservation = await observeTrustedExecutorInvocationV2(input.runtime, reconciled.authorizedInvocation);
    return reconciliationResult(input.leasedRun, reconciled.attempt, reconciled.attempt.invocation!.invocationId, reconciledObservation);
  }
  if (!initialAttempt.invocation) throw new RalphB4ExecutionError("B4_AUTHORIZATION_REQUIRED", "B4_AUTHORIZATION_REQUIRED: invocation descriptor is missing");
  const invocationId = initialAttempt.invocation.invocationId;

  if (initialAttempt.stage === "EXECUTOR_DISPATCH_AUTHORIZED" || initialAttempt.stage === "EXECUTOR_RUNNING") {
    const terminalReceipt = await readExecutorObservationReceiptV2(input.leasedRun.store, initialAttempt.attemptId);
    if (terminalReceipt) {
      throw new RalphB4ExecutionError(
        "B4_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION",
        "B4_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION: terminal observation receipt exists before executor.finished; Executor recovery must not observe or redispatch",
      );
    }
  }

  if (initialAttempt.stage === "POST_EXECUTOR_CAPTURE") {
    return await finishedBoundaryResult(input, invocationId, clock, nonceFactory);
  }
  if (initialAttempt.stage === "EVIDENCE_CAPTURING") {
    return {
      kind: "EVIDENCE_CAPTURE_IN_PROGRESS",
      outcome: "EVIDENCE_CAPTURE_IN_PROGRESS",
      state: input.leasedRun.state,
      attempt: initialAttempt,
      invocationId,
      leaseReleased: false,
    };
  }
  if (initialAttempt.stage !== "EXECUTOR_DISPATCH_AUTHORIZED" && initialAttempt.stage !== "EXECUTOR_RUNNING") {
    throw new RalphB4ExecutionError("B4_AUTHORIZATION_REQUIRED", "B4_AUTHORIZATION_REQUIRED: Attempt is outside B4");
  }

  let reopened: ReopenedAuthorizedInvocationV2;
  try {
    reopened = await reopenAuthorizedInvocationV2({
      leasedRun: input.leasedRun,
      plan: input.plan,
      attemptId: initialAttempt.attemptId,
      planIdentity: input.planIdentity,
      planDigest: input.planDigest,
      requireBaseFingerprint: false,
    });
  } catch (error) {
    if (error instanceof Error && (error.message.includes("WORKSPACE") || error.message.includes("FINGERPRINT"))) {
      let observationAuthorization: ReopenedAuthorizedInvocationV2;
      try {
        observationAuthorization = await reopenAuthorizedInvocationV2({
          leasedRun: input.leasedRun,
          plan: input.plan,
          attemptId: initialAttempt.attemptId,
          planIdentity: input.planIdentity,
          planDigest: input.planDigest,
          requireBaseFingerprint: false,
        });
      } catch {
        throw error;
      }
      return await reconcileWithoutObservation(input, initialAttempt, invocationId, "B4_BASE_MANIFEST_MISMATCH", observationAuthorization.authorizedInvocation, clock, nonceFactory, eventIdFactory);
    }
    throw error;
  }
  assertAuthorizedInvocationV2(reopened.authorizedInvocation);

  const firstObservation = await observeTrustedExecutorInvocationV2(input.runtime, reopened.authorizedInvocation);
  if (firstObservation.state === "UNKNOWN") {
    return await reconcileUnknown(input, firstObservation, reopened.attempt, reopened.invocation.invocationId, clock, nonceFactory, eventIdFactory);
  }

  let observation = firstObservation;
  let notInvokedProof: NotInvokedProofV2 | undefined;
  if (reopened.attempt.stage === "EXECUTOR_DISPATCH_AUTHORIZED" && observation.state === "NOT_INVOKED") {
    notInvokedProof = deriveNotInvokedProofV2(observation, reopened.authorizedInvocation);
    try {
      await ensureBaseManifest(input, reopened, clock, nonceFactory);
    } catch (error) {
      if (error instanceof RalphB4ExecutionError && error.code === "B4_BASE_MANIFEST_MISMATCH") {
        return await reconcileWithoutObservation(input, reopened.attempt, invocationId, error.code, reopened.authorizedInvocation, clock, nonceFactory, eventIdFactory);
      }
      throw error;
    }
    await revalidateLeaseOwnershipV2(input.leasedRun);
    const preInvokeObservation = await observeTrustedExecutorInvocationV2(input.runtime, reopened.authorizedInvocation);
    if (preInvokeObservation.state !== "NOT_INVOKED") {
      observation = preInvokeObservation;
    } else {
      try {
        await input.runtime.invoke(reopened.authorizedInvocation);
      } catch (error) {
        const afterRejectedInvoke = await observeTrustedExecutorInvocationV2(input.runtime, reopened.authorizedInvocation);
        if (afterRejectedInvoke.state === "NOT_INVOKED" && isProtocolFailure(error)) {
          return await closeBeforeStart(input, reopened.attempt, invocationId, afterRejectedInvoke, "EXECUTOR_PROTOCOL_FAILURE", clock, nonceFactory, eventIdFactory);
        }
        observation = afterRejectedInvoke;
      }
      if (observation === firstObservation || observation.state === "NOT_INVOKED") {
        observation = await observeTrustedExecutorInvocationV2(input.runtime, reopened.authorizedInvocation);
      }
    }
  }

  if (observation.state === "UNKNOWN") return await reconcileUnknown(input, observation, reopened.attempt, invocationId, clock, nonceFactory, eventIdFactory);
  if (observation.state === "NOT_INVOKED") {
    return await reconcileWithoutObservation(input, reopened.attempt, invocationId, "B4_EXECUTOR_REMAINED_NOT_INVOKED_AFTER_DISPATCH", reopened.authorizedInvocation, clock, nonceFactory, eventIdFactory);
  }
  if (observation.state === "RUNNING" || (observation.state === "TERMINATED_QUIESCENT" && observation.startedAt)) {
    const before = await readWorkspaceBeforeManifestV2(input.leasedRun.store, reopened.attempt.attemptId);
    if (!before) return await reconcileWithoutObservation(input, reopened.attempt, invocationId, "B4_BASE_MANIFEST_REQUIRED_AFTER_CROSSING", reopened.authorizedInvocation, clock, nonceFactory, eventIdFactory);
    try {
      assertManifestBinding(before, reopened);
    } catch {
      return await reconcileWithoutObservation(input, reopened.attempt, invocationId, "B4_BASE_MANIFEST_BINDING_CONFLICT", reopened.authorizedInvocation, clock, nonceFactory, eventIdFactory);
    }
    if (before.fingerprintDigest !== reopened.attempt.attemptBaseFingerprint || before.fingerprintDigest !== reopened.workUnit.attemptBaseFingerprint) {
      return await reconcileWithoutObservation(input, reopened.attempt, invocationId, "B4_BASE_MANIFEST_MISMATCH_AFTER_CROSSING", reopened.authorizedInvocation, clock, nonceFactory, eventIdFactory);
    }
  }
  return await continueFromTrustedObservation(input, reopened, observation, notInvokedProof, clock, nonceFactory, eventIdFactory);
}

export const runAuthorizedInvocationV2 = executeAuthorizedInvocationV2;
export const executeScriptedInvocationV2 = executeAuthorizedInvocationV2;

async function continueFromTrustedObservation(
  input: ExecuteAuthorizedInvocationV2Input,
  reopened: ReopenedAuthorizedInvocationV2,
  observation: TrustedExecutorObservationV2,
  notInvokedProof: NotInvokedProofV2 | undefined,
  clock: () => string,
  nonceFactory: () => string,
  eventIdFactory: () => string,
): Promise<ExecuteAuthorizedInvocationV2Result> {
  const currentAttempt = findAttempt(input.leasedRun.state, reopened.attempt.attemptId);
  if (!currentAttempt || currentAttempt.disposition !== "OPEN" || !currentAttempt.invocation) throw new RalphB4ExecutionError("B4_AUTHORIZATION_REQUIRED");
  if (observation.state === "RUNNING") {
    if (!observation.startedAt) throw new RalphB4ExecutionError("B4_STARTED_OBSERVATION_REQUIRED");
    await commitStartedIfNeeded(input, currentAttempt, observation, clock, nonceFactory, eventIdFactory);
    const runningAttempt = findAttempt(input.leasedRun.state, currentAttempt.attemptId);
    if (!runningAttempt || runningAttempt.disposition !== "OPEN") throw new RalphB4ExecutionError("B4_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION");
    return {
      kind: "EXECUTOR_RUNNING",
      outcome: "EXECUTOR_RUNNING",
      state: input.leasedRun.state,
      attempt: runningAttempt,
      invocationId: observation.invocationId,
      observation,
      ...(notInvokedProof === undefined ? {} : { notInvokedProof }),
      leaseReleased: false,
    };
  }

  if (observation.state !== "TERMINATED_QUIESCENT") return await reconcileUnknown(input, observation, currentAttempt, observation.invocationId, clock, nonceFactory, eventIdFactory);
  if (!observation.status || !observation.termination || !observation.finishedAt) throw new RalphB4ExecutionError("B4_RESULT_OBSERVATION_INVALID");
  if (!observation.startedAt) {
    if (observation.status === "UNAVAILABLE") return await closeBeforeStart(input, currentAttempt, observation.invocationId, observation, "EXECUTOR_UNAVAILABLE", clock, nonceFactory, eventIdFactory);
    if (observation.status === "CANCELLED") return await closeBeforeStart(input, currentAttempt, observation.invocationId, observation, "EXECUTOR_CANCELLED", clock, nonceFactory, eventIdFactory);
    return await reconcileWithoutObservation(input, currentAttempt, observation.invocationId, "B4_TERMINATED_WITHOUT_TRUSTED_START", reopened.authorizedInvocation, clock, nonceFactory, eventIdFactory);
  }
  await commitStartedIfNeeded(input, currentAttempt, observation, clock, nonceFactory, eventIdFactory);
  const startedAttempt = findAttempt(input.leasedRun.state, currentAttempt.attemptId);
  if (!startedAttempt || startedAttempt.disposition !== "OPEN") throw new RalphB4ExecutionError("B4_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION");
  // Crash-safe terminal ordering: trusted receipt, InvocationResult, then the
  // executor.finished event. A later stage can never exist without both
  // immutable artifacts unless durable authority was externally damaged.
  await persistTrustedExecutorObservationReceiptV2(input.leasedRun.store, observation, nonceFactory());
  const result = await persistOrReuseResult(input.leasedRun.store, startedAttempt, observation, nonceFactory);
  await commitFinishedIfNeeded(input, startedAttempt, observation, clock, nonceFactory, eventIdFactory);
  const finishedAttempt = findAttempt(input.leasedRun.state, currentAttempt.attemptId);
  if (!finishedAttempt) throw new RalphB4ExecutionError("B4_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION");
  return {
    kind: "EXECUTOR_FINISHED_READY_FOR_CAPTURE",
    outcome: "EXECUTOR_FINISHED_READY_FOR_CAPTURE",
    state: input.leasedRun.state,
    attempt: finishedAttempt,
    invocationId: observation.invocationId,
    observation,
    resultArtifact: result,
    leaseReleased: false,
  };
}

async function finishedBoundaryResult(
  input: ExecuteAuthorizedInvocationV2Input,
  invocationId: string,
  _clock: () => string,
  _nonceFactory: () => string,
): Promise<ExecuteAuthorizedInvocationV2Result> {
  const attempt = findAttempt(input.leasedRun.state, input.attemptId);
  if (!attempt || attempt.stage !== "POST_EXECUTOR_CAPTURE" || !attempt.executorFinished) throw new RalphB4ExecutionError("B4_AUTHORIZATION_REQUIRED");
  const authorization = await authorizePostExecutorObservationV2({
    leasedRun: input.leasedRun,
    plan: input.plan,
    attemptId: attempt.attemptId,
    planIdentity: input.planIdentity,
    planDigest: input.planDigest,
  });
  const observation = await rehydrateTrustedExecutorObservationV2({ leasedRun: input.leasedRun, authorization });
  const result = await readInvocationResultV2(input.leasedRun.store, attempt.attemptId);
  if (!result) throw new RalphB4ExecutionError("B4_BASE_MANIFEST_REQUIRED", "B4_BASE_MANIFEST_REQUIRED: executor result artifact is missing");
  assertResultMatchesFinished(input.leasedRun.runId, attempt, result, observation);
  return {
    kind: "EXECUTOR_FINISHED_READY_FOR_CAPTURE",
    outcome: "EXECUTOR_FINISHED_READY_FOR_CAPTURE",
    state: input.leasedRun.state,
    attempt,
    invocationId,
    observation,
    resultArtifact: result,
    leaseReleased: false,
  };
}

async function ensureBaseManifest(
  input: ExecuteAuthorizedInvocationV2Input,
  reopened: ReopenedAuthorizedInvocationV2,
  _clock: () => string,
  nonceFactory: () => string,
): Promise<WorkspaceManifestV2> {
  const existing = await readWorkspaceBeforeManifestV2(input.leasedRun.store, reopened.attempt.attemptId);
  if (existing) {
    assertManifestBinding(existing, reopened);
    if (existing.fingerprintDigest !== reopened.attempt.attemptBaseFingerprint) throw new RalphB4ExecutionError("B4_BASE_MANIFEST_MISMATCH");
    const current = await observeWorkspaceManifestV2({
      projectRoot: input.leasedRun.projectRoot,
      policy: input.leasedRun.snapshot.workspacePolicy,
      binding: manifestBinding(reopened),
      fileSystem: input.workspaceFingerprintFileSystem ?? input.leasedRun.workspaceFingerprintFileSystem,
    });
    if (current.fingerprint.fingerprintDigest !== existing.fingerprintDigest || canonicalJson(current.manifest) !== canonicalJson(existing)) throw new RalphB4ExecutionError("B4_BASE_MANIFEST_MISMATCH");
    return existing;
  }
  const observed = await observeWorkspaceManifestV2({
    projectRoot: input.leasedRun.projectRoot,
    policy: input.leasedRun.snapshot.workspacePolicy,
    binding: manifestBinding(reopened),
    fileSystem: input.workspaceFingerprintFileSystem ?? input.leasedRun.workspaceFingerprintFileSystem,
  });
  if (observed.fingerprint.fingerprintDigest !== reopened.attempt.attemptBaseFingerprint) throw new RalphB4ExecutionError("B4_BASE_MANIFEST_MISMATCH", "B4_BASE_MANIFEST_MISMATCH: manifest does not equal WorkUnit attemptBaseFingerprint");
  await revalidateLeaseOwnershipV2(input.leasedRun);
  try {
    await persistWorkspaceBeforeManifestV2(input.leasedRun.store, observed.manifest, nonceFactory());
  } catch (error) {
    if (error instanceof Error && error.message.includes("DURABILITY_UNKNOWN")) throw error;
    throw error;
  }
  const persisted = await readWorkspaceBeforeManifestV2(input.leasedRun.store, reopened.attempt.attemptId);
  if (!persisted) throw new RalphB4ExecutionError("B4_BASE_MANIFEST_REQUIRED");
  assertManifestBinding(persisted, reopened);
  if (persisted.fingerprintDigest !== reopened.attempt.attemptBaseFingerprint) throw new RalphB4ExecutionError("B4_BASE_MANIFEST_MISMATCH");
  return persisted;
}

async function persistOrReuseResult(
  store: RalphEventStoreV2,
  attempt: AttemptStateV2,
  observation: TrustedExecutorObservationV2,
  nonceFactory: () => string,
): Promise<InvocationResultV2> {
  if (!attempt.invocation || !observation.startedAt || !observation.finishedAt || !observation.status || !observation.termination || !observation.resultEnvelopeStatus) throw new RalphB4ExecutionError("B4_RESULT_OBSERVATION_INVALID");
  const expected = createInvocationResultV2({
    runId: store.runId,
    phaseId: attempt.phaseId,
    taskId: attempt.taskId,
    attemptId: attempt.attemptId,
    invocationId: observation.invocationId,
    resultEnvelopeStatus: observation.resultEnvelopeStatus,
    status: observation.status,
    termination: observation.termination,
    exitCode: observation.exitCode ?? null,
    signal: observation.signal ?? null,
    startedAt: observation.startedAt,
    finishedAt: observation.finishedAt,
    startedObservationRef: observation.startedObservationId ?? observation.observationId,
    finishedObservationRef: observation.observationId,
    diagnosticRefs: [],
    safeMetadata: observation.safeMetadata,
  });
  const existing = await readInvocationResultV2(store, attempt.attemptId);
  if (existing) {
    assertResultMatchesObservation(existing, expected);
    return existing;
  }
  await persistInvocationResultV2(store, expected, nonceFactory());
  const persisted = await readInvocationResultV2(store, attempt.attemptId);
  if (!persisted) throw new RalphB4ExecutionError("B4_RESULT_OBSERVATION_INVALID", "B4_RESULT_OBSERVATION_INVALID: result artifact was not readable after publication");
  assertResultMatchesObservation(persisted, expected);
  return persisted;
}

async function commitStartedIfNeeded(
  input: ExecuteAuthorizedInvocationV2Input,
  attempt: AttemptStateV2,
  observation: TrustedExecutorObservationV2,
  clock: () => string,
  nonceFactory: () => string,
  eventIdFactory: () => string,
): Promise<void> {
  if (attempt.stage !== "EXECUTOR_DISPATCH_AUTHORIZED") return;
  if (!observation.startedAt) throw new RalphB4ExecutionError("B4_STARTED_OBSERVATION_REQUIRED");
  const event = coreEvent(input.leasedRun.state, "executor.started", {
    invocationId: attempt.invocation?.invocationId ?? observation.invocationId,
    startedAt: observation.startedAt,
  }, { phaseId: attempt.phaseId, taskId: attempt.taskId, attemptId: attempt.attemptId, eventIdFactory, clock });
  await commitB4Event(input.leasedRun, event, clock, nonceFactory, observation);
}

async function commitFinishedIfNeeded(
  input: ExecuteAuthorizedInvocationV2Input,
  attempt: AttemptStateV2,
  observation: TrustedExecutorObservationV2,
  clock: () => string,
  nonceFactory: () => string,
  eventIdFactory: () => string,
): Promise<void> {
  const current = findAttempt(input.leasedRun.state, attempt.attemptId);
  if (!current || !current.invocation || !observation.status || !observation.termination || !observation.finishedAt) throw new RalphB4ExecutionError("B4_RESULT_OBSERVATION_INVALID");
  if (current.stage !== "EXECUTOR_RUNNING") {
    if (current.stage === "POST_EXECUTOR_CAPTURE" && current.executorFinished?.invocationId === observation.invocationId && current.executorFinished.status === observation.status && current.executorFinished.termination === observation.termination && current.executorFinished.finishedAt === observation.finishedAt) return;
    throw new RalphB4ExecutionError("B4_OBSERVATION_RECONCILIATION_REQUIRED");
  }
  const event = coreEvent(input.leasedRun.state, "executor.finished", {
    invocationId: observation.invocationId,
    status: observation.status,
    termination: observation.termination,
    finishedAt: observation.finishedAt,
  }, { phaseId: current.phaseId, taskId: current.taskId, attemptId: current.attemptId, eventIdFactory, clock });
  await commitB4Event(input.leasedRun, event, clock, nonceFactory, observation);
}

async function closeBeforeStart(
  input: ExecuteAuthorizedInvocationV2Input,
  attempt: AttemptStateV2,
  invocationId: string,
  observation: TrustedExecutorObservationV2,
  reason: "EXECUTOR_UNAVAILABLE" | "EXECUTOR_PROTOCOL_FAILURE" | "EXECUTOR_CANCELLED",
  clock: () => string,
  nonceFactory: () => string,
  eventIdFactory: () => string,
): Promise<ExecuteAuthorizedInvocationV2Result> {
  if (attempt.stage !== "EXECUTOR_DISPATCH_AUTHORIZED" && attempt.stage !== "ADMITTED") throw new RalphB4ExecutionError("B4_OBSERVATION_RECONCILIATION_REQUIRED");
  const event = coreEvent(input.leasedRun.state, "attempt.closed", {
    attemptId: attempt.attemptId,
    closureReason: reason,
    finishedAt: observation.finishedAt ?? clock(),
  }, { phaseId: attempt.phaseId, taskId: attempt.taskId, attemptId: attempt.attemptId, eventIdFactory, clock });
  await commitB4Event(input.leasedRun, event, clock, nonceFactory);
  await releaseLeasedRunV2(input.leasedRun);
  const closed = input.leasedRun.state.attempts[attempt.attemptId];
  if (!closed) throw new RalphB4ExecutionError("B4_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION");
  return {
    kind: reason === "EXECUTOR_UNAVAILABLE" ? "EXECUTOR_UNAVAILABLE" : reason === "EXECUTOR_PROTOCOL_FAILURE" ? "EXECUTOR_PROTOCOL_FAILURE" : "EXECUTOR_CANCELLED",
    outcome: reason === "EXECUTOR_UNAVAILABLE" ? "EXECUTOR_UNAVAILABLE" : reason === "EXECUTOR_PROTOCOL_FAILURE" ? "EXECUTOR_PROTOCOL_FAILURE" : "EXECUTOR_CANCELLED",
    state: input.leasedRun.state,
    attempt: closed,
    invocationId,
    observation,
    leaseReleased: true,
  };
}

async function reconcileUnknown(
  input: ExecuteAuthorizedInvocationV2Input,
  observation: TrustedExecutorObservationV2,
  attempt: AttemptStateV2,
  invocationId: string,
  clock: () => string,
  nonceFactory: () => string,
  eventIdFactory: string | (() => string),
): Promise<ExecuteAuthorizedInvocationV2Result> {
  if (attempt.stage !== "EXECUTOR_DISPATCH_AUTHORIZED" && attempt.stage !== "EXECUTOR_RUNNING") {
    return reconciliationResult(input.leasedRun, attempt, invocationId, observation);
  }
  const event = coreEvent(input.leasedRun.state, "attempt.reconciliation-required", {
    reason: `EXECUTOR_OBSERVATION_${observation.observationId}_UNKNOWN`,
    proofRef: `executor-observation-${observation.observationId}`,
  }, { phaseId: attempt.phaseId, taskId: attempt.taskId, attemptId: attempt.attemptId, eventIdFactory: typeof eventIdFactory === "function" ? eventIdFactory : () => eventIdFactory, clock });
  // Recording ambiguity is safe even if a physical side effect happened in
  // the crash window; the event does not claim that the workspace is stable.
  await commitB4Event(input.leasedRun, event, clock, nonceFactory, observation);
  const next = input.leasedRun.state.attempts[attempt.attemptId];
  if (!next) throw new RalphB4ExecutionError("B4_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION");
  return { kind: "RECONCILIATION_REQUIRED", outcome: "RECONCILIATION_REQUIRED", state: input.leasedRun.state, attempt: next, invocationId, observation, leaseReleased: false };
}

async function reconcileWithoutObservation(
  input: ExecuteAuthorizedInvocationV2Input,
  attempt: AttemptStateV2,
  invocationId: string,
  reason: string,
  authorizedInvocation: AuthorizedInvocationV2,
  clock: () => string,
  nonceFactory: () => string,
  eventIdFactory: () => string,
): Promise<ExecuteAuthorizedInvocationV2Result> {
  const event = coreEvent(input.leasedRun.state, "attempt.reconciliation-required", {
    reason,
    proofRef: `core-reconciliation-${attempt.attemptId}`,
  }, { phaseId: attempt.phaseId, taskId: attempt.taskId, attemptId: attempt.attemptId, eventIdFactory, clock });
  await commitB4Event(input.leasedRun, event, clock, nonceFactory);
  const next = input.leasedRun.state.attempts[attempt.attemptId];
  if (!next) throw new RalphB4ExecutionError("B4_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION");
  const observation = await observeTrustedExecutorInvocationV2(input.runtime, authorizedInvocation);
  return { kind: "RECONCILIATION_REQUIRED", outcome: "RECONCILIATION_REQUIRED", state: input.leasedRun.state, attempt: next, invocationId, observation, leaseReleased: false };
}

function reconciliationResult(
  stateful: LeasedRunV2,
  attempt: AttemptStateV2,
  invocationId: string,
  observation: TrustedExecutorObservationV2 | undefined,
): ExecuteAuthorizedInvocationV2Result {
  if (!observation) {
    // The reducer only permits the recovery boundary after an observation; a
    // resumed already-reconciling Attempt is returned without inventing one.
    throw new RalphB4ExecutionError("B4_OBSERVATION_RECONCILIATION_REQUIRED");
  }
  return { kind: "RECONCILIATION_REQUIRED", outcome: "RECONCILIATION_REQUIRED", state: stateful.state, attempt, invocationId, observation, leaseReleased: false };
}

async function commitB4Event(
  leasedRun: LeasedRunV2,
  event: RalphEventV2,
  clock: () => string,
  nonceFactory: () => string,
  executorObservation?: TrustedExecutorObservationV2,
): Promise<void> {
  await revalidateLeaseOwnershipV2(leasedRun);
  let committed;
  try {
    committed = await commitRalphEventV2({ store: leasedRun.store, state: leasedRun.state, event, writtenAt: clock(), nonce: nonceFactory() });
  } catch (error) {
    if (error instanceof Error && error.message.includes("DURABILITY_UNKNOWN")) throw new RalphB4ExecutionError("B4_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION", error.message, error);
    throw error;
  }
  if (committed.eventDurability !== "DURABLE") throw new RalphB4ExecutionError("B4_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION");
  try {
    if (committed.snapshotStatus !== "CURRENT") {
      await repairStateSnapshotWhileLeasedV2(leasedRun, { writtenAt: clock(), nonce: nonceFactory(), ...(executorObservation === undefined ? {} : { executorObservation }) });
    }
    await refreshLeasedRunV2(leasedRun, executorObservation === undefined ? {} : { executorObservation });
  } catch (error) {
    throw new RalphB4ExecutionError("B4_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION", "B4_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION: state refresh failed", error);
  }
}

function coreEvent<TType extends RalphEventTypeV2>(
  state: RalphRuntimeStateV2,
  eventType: TType,
  payload: EventPayloadMapV2[TType],
  context: { readonly phaseId: string; readonly taskId: string; readonly attemptId: string; readonly eventIdFactory: () => string; readonly clock: () => string },
) {
  const occurredAt = context.clock();
  return createRalphEventV2({
    eventId: `b4-${eventType}-${context.attemptId}-${context.eventIdFactory()}`,
    eventType,
    schemaVersion: "rb-ralph-event/v2",
    runId: state.runId,
    sequence: state.lastSequence + 1,
    occurredAt,
    recordedAt: occurredAt,
    entity: { kind: "attempt", id: context.attemptId },
    phaseId: context.phaseId,
    taskId: context.taskId,
    attemptId: context.attemptId,
    actor: "CORE",
    causationId: null,
    correlationId: `${state.runId}:${context.attemptId}`,
    payload,
    previousEventHash: state.lastEventHash,
  } as UnsignedRalphEventV2<TType>);
}

function findAttempt(state: RalphRuntimeStateV2, attemptId: string | undefined): AttemptStateV2 | undefined {
  if (attemptId) return state.attempts[attemptId];
  return Object.values(state.attempts).find((attempt) => attempt.disposition === "OPEN");
}

function manifestBinding(reopened: ReopenedAuthorizedInvocationV2): { readonly runId: string; readonly phaseId: string; readonly taskId: string; readonly attemptId: string; readonly invocationId: string } {
  return {
    runId: reopened.invocation.runId,
    phaseId: reopened.invocation.phaseId,
    taskId: reopened.invocation.taskId,
    attemptId: reopened.invocation.attemptId,
    invocationId: reopened.invocation.invocationId,
  };
}

function assertManifestBinding(manifest: WorkspaceManifestV2, reopened: ReopenedAuthorizedInvocationV2): void {
  const binding = manifestBinding(reopened);
  if (manifest.runId !== binding.runId || manifest.phaseId !== binding.phaseId || manifest.taskId !== binding.taskId || manifest.attemptId !== binding.attemptId || manifest.invocationId !== binding.invocationId) throw new RalphB4ExecutionError("B4_BASE_MANIFEST_MISMATCH");
}

function assertResultMatchesObservation(existing: InvocationResultV2, expected: InvocationResultV2): void {
  const comparable = (value: InvocationResultV2) => {
    const { resultDigest: _digest, startedObservationRef: _started, finishedObservationRef: _finished, ...rest } = value;
    return rest;
  };
  validateInvocationResultV2(existing);
  if (canonicalJson(comparable(existing)) !== canonicalJson(comparable(expected))) throw new RalphB4ExecutionError("B4_RESULT_IMMUTABLE_CONFLICT", "B4_RESULT_IMMUTABLE_CONFLICT: a different result exists for the invocation");
}

function assertResultMatchesFinished(runId: string, attempt: AttemptStateV2, result: InvocationResultV2, observation: TrustedExecutorObservationV2): void {
  validateInvocationResultV2(result);
  const finished = attempt.executorFinished;
  const invocation = attempt.invocation;
  if (!finished || !invocation
    || result.runId !== runId
    || result.phaseId !== attempt.phaseId
    || result.taskId !== attempt.taskId
    || result.attemptId !== attempt.attemptId
    || result.invocationId !== invocation.invocationId
    || result.invocationId !== finished.invocationId
    || result.invocationId !== observation.invocationId
    || finished.invocationId !== observation.invocationId
    || result.status !== finished.status
    || result.status !== observation.status
    || result.termination !== finished.termination
    || result.termination !== observation.termination
    || result.finishedAt !== finished.finishedAt
    || result.finishedAt !== observation.finishedAt
    || observation.record.runId !== runId
    || observation.record.phaseId !== attempt.phaseId
    || observation.record.taskId !== attempt.taskId
    || observation.record.attemptId !== attempt.attemptId
    || observation.record.invocationId !== invocation.invocationId
    || observation.state !== "TERMINATED_QUIESCENT"
    || result.resultEnvelopeStatus !== observation.resultEnvelopeStatus
    || result.exitCode !== (observation.exitCode ?? null)
    || result.signal !== (observation.signal ?? null)
    || result.startedAt !== observation.startedAt) {
    throw new RalphB4ExecutionError("B4_RESULT_IMMUTABLE_CONFLICT", "B4_RESULT_IMMUTABLE_CONFLICT: invocation-result and executor.finished disagree");
  }
}

function observationEnvelopeFromRecord(record: ExecutorObservationRecordV2): ExecutorObservationEnvelopeV2 {
  const {
    runId: _runId,
    phaseId: _phaseId,
    taskId: _taskId,
    attemptId: _attemptId,
    ...envelope
  } = record;
  validateExecutorObservationEnvelopeV2(envelope);
  return freezeDeep(envelope);
}

function receiptBinding(value: Record<string, unknown> | ExecutorObservationReceiptV2): ExecutorObservationBindingV2 {
  return {
    runId: value.runId as string,
    phaseId: value.phaseId as string,
    taskId: value.taskId as string,
    attemptId: value.attemptId as string,
    invocationId: value.invocationId as string,
  };
}

function assertReceiptAuthorizationBinding(
  receipt: ExecutorObservationReceiptV2,
  authorization: ReturnType<typeof postExecutorObservationAuthorizationRecordV2>,
): void {
  if (receipt.runId !== authorization.runId
    || receipt.phaseId !== authorization.phaseId
    || receipt.taskId !== authorization.taskId
    || receipt.attemptId !== authorization.attemptId
    || receipt.invocationId !== authorization.invocationId) {
    throw new RalphB4ExecutionError("B4_OBSERVATION_RECEIPT_INVALID", "B4_OBSERVATION_RECEIPT_INVALID: B3 authorization binding mismatch");
  }
}

function assertReceiptResultAndAttemptBinding(
  receipt: ExecutorObservationReceiptV2,
  result: InvocationResultV2,
  attempt: AttemptStateV2,
): void {
  validateExecutorObservationReceiptV2(receipt);
  validateInvocationResultV2(result);
  const observation = receipt.observation;
  const finished = attempt.executorFinished;
  const expectedStartedRef = observation.startedObservationId ?? observation.observationId;
  if (!finished || observation.state !== "TERMINATED_QUIESCENT"
    || result.runId !== receipt.runId || result.phaseId !== receipt.phaseId
    || result.taskId !== receipt.taskId || result.attemptId !== receipt.attemptId
    || result.invocationId !== receipt.invocationId || observation.invocationId !== receipt.invocationId
    || result.resultEnvelopeStatus !== observation.resultEnvelopeStatus
    || result.status !== observation.status || result.termination !== observation.termination
    || result.exitCode !== (observation.exitCode ?? null) || result.signal !== (observation.signal ?? null)
    || result.startedAt !== observation.startedAt || result.finishedAt !== observation.finishedAt
    || result.startedObservationRef !== expectedStartedRef || result.finishedObservationRef !== observation.observationId
    || canonicalJson(result.safeMetadata) !== canonicalJson(observation.safeMetadata)
    || finished.invocationId !== receipt.invocationId
    || finished.status !== result.status || finished.termination !== result.termination
    || finished.finishedAt !== result.finishedAt) {
    throw new RalphB4ExecutionError("B4_OBSERVATION_RECEIPT_INVALID", "B4_OBSERVATION_RECEIPT_INVALID: receipt, InvocationResult, and executor.finished disagree");
  }
}

function assertExactReceiptKeys(value: object, allowed: readonly string[]): void {
  const expected = new Set(allowed);
  if (Object.keys(value).length !== expected.size || Object.keys(value).some((key) => !expected.has(key))) {
    throw observationReceiptError("B4_OBSERVATION_RECEIPT_INVALID");
  }
}

function assertReceiptIdentity(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(value)) {
    throw observationReceiptError("B4_OBSERVATION_RECEIPT_INVALID");
  }
}

function observationReceiptError(message: string, cause?: unknown): RalphB4ArtifactError {
  return new RalphB4ArtifactError("B4_ARTIFACT_INVALID", message, cause);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProtocolFailure(error: unknown): boolean {
  return error instanceof ExecutorRuntimeError && error.code === "B4_EXECUTOR_PROTOCOL_FAILURE_BEFORE_START";
}

function freezeDeep<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  return value;
}
