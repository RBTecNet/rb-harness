import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Stats } from "node:fs";
import type { RalphRuntimeFileSystem } from "../event-store.js";
import { validateRalphRunId } from "../event-store.js";
import { canonicalJson } from "../canonical-json.js";
import { isSha256Digest, sha256, sha256Canonical } from "../hashing.js";
import type { RalphRuntimeStateV2, AttemptStateV2 } from "../operational-v2/contracts.js";
import { assertV2RuntimeState } from "../operational-v2/state.js";
import {
  inspectOperationalRunV2,
  type InspectOperationalRunV2Input,
  type InspectOperationalRunV2Result,
  type OperationalRunV2ExternalFacts,
} from "../operational-b1/open.js";
import { persistStateSnapshotV2 } from "../operational-b1/state-snapshot.js";
import { RalphEventStoreV2, type EventStoreV2Options, type LedgerInspectionV2 } from "../operational-b1/event-store.js";
import {
  defaultProcessIdentityProvider,
  type ProcessIdentity,
  type ProcessIdentityInspection,
  type ProcessIdentityProvider,
} from "./process-identity.js";
import type { WorkspaceFingerprintFileSystem } from "../fingerprint.js";
import {
  assertNotInvokedProofV2,
  assertTrustedExecutorObservationV2,
  isNotInvokedProofV2,
} from "../operational-b4/execution.js";
import { readInvocationResultV2, type InvocationResultV2 } from "../operational-b4/invocation-result.js";
import {
  EXECUTOR_BOUNDARY_STATES,
  EXECUTOR_OBSERVATION_STATES,
  type ExecutorObservationStateV2,
  type NotInvokedProofV2,
  type TrustedExecutorObservationV2,
  type LeaseReleaseProofV2 as LeaseReleaseProofContractV2,
  type LeaseReleaseProofRecordV2,
} from "../operational-b4/execution-observation.js";

export type { LeaseReleaseProofRecordV2 } from "../operational-b4/execution-observation.js";

export const RALPH_RUN_LEASE_SCHEMA_V2 = "rb-ralph-run-lease/v1" as const;
export const RALPH_RECOVERY_CLAIM_SCHEMA_V2 = "rb-ralph-recovery-claim/v1" as const;
export const RALPH_RUN_LEASE_HEARTBEAT_DISABLED = "DISABLED" as const;

export const RUN_LEASE_ERROR_CODES = [
  "LEASE_ALREADY_HELD",
  "LEASE_ACQUISITION_NOT_READY",
  "LEASE_DURABILITY_UNKNOWN_REQUIRES_INSPECTION",
  "LEASE_RELEASE_DURABILITY_UNKNOWN_REQUIRES_INSPECTION",
  "LEASE_RELEASE_EXTERNAL_INVOCATION_UNKNOWN",
  "LEASE_RELEASE_PROOF_REQUIRED",
  "LEASE_RELEASE_PROOF_INVALID",
  "LEASE_HANDLE_REQUIRED",
  "LEASE_LOST",
  "LEASE_RECONCILIATION_REQUIRED",
  "LEASE_PATH_UNSAFE",
  "LEASE_FOREIGN_RUN",
  "LEASE_INVALID",
  "LEASE_PUBLICATION_FAILED",
  "LEASE_RELEASE_REJECTED",
  "RECOVERY_ALREADY_HELD",
  "RECOVERY_CLAIM_DURABILITY_UNKNOWN_REQUIRES_INSPECTION",
  "RECOVERY_CLAIM_STALE_REQUIRES_INSPECTION",
  "RECOVERY_CLAIM_RECONCILIATION_REQUIRED",
  "RECOVERY_TARGET_CHANGED",
  "RECOVERY_TARGET_MISSING",
  "RECOVERY_STAGE_UNSAFE",
  "RECOVERY_NOT_INVOKED_PROOF_INVALID",
] as const;
export type RunLeaseErrorCode = typeof RUN_LEASE_ERROR_CODES[number];

export class RalphRunLeaseError extends Error {
  constructor(readonly code: RunLeaseErrorCode, message: string = code, readonly cause?: unknown) {
    super(message);
    this.name = "RalphRunLeaseError";
  }
}

const leaseReleaseProofInternals = new WeakMap<LeaseReleaseProofV2, LeaseReleaseProofRecordV2>();
const LEASE_RELEASE_PROOF_SEAL = Symbol("LeaseReleaseProofV2");

/**
 * Runtime-opaque release authority.  The constructor and seal are kept in
 * this Core lease module; callers can only carry a proof returned by one of
 * the Core derivations below.
 */
export class LeaseReleaseProofV2 implements LeaseReleaseProofContractV2 {
  readonly kind = "CORE_LEASE_RELEASE_PROOF" as const;

  constructor(record: LeaseReleaseProofRecordV2, seal: symbol) {
    if (seal !== LEASE_RELEASE_PROOF_SEAL) throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID");
    leaseReleaseProofInternals.set(this, freezeDeep(record));
    Object.freeze(this);
  }

  get record(): LeaseReleaseProofRecordV2 { return requireLeaseReleaseProof(this); }
  get proofId(): string { return requireLeaseReleaseProof(this).proofId; }
  get runId(): string { return requireLeaseReleaseProof(this).runId; }
  get leaseId(): string { return requireLeaseReleaseProof(this).leaseId; }
  get phaseId(): string | undefined { return requireLeaseReleaseProof(this).phaseId; }
  get taskId(): string | undefined { return requireLeaseReleaseProof(this).taskId; }
  get attemptId(): string | undefined { return requireLeaseReleaseProof(this).attemptId; }
  get invocationId(): string | undefined { return requireLeaseReleaseProof(this).invocationId; }
  get runtimeIdentity(): string | undefined { return requireLeaseReleaseProof(this).runtimeIdentity; }
  get observationId(): string | undefined { return requireLeaseReleaseProof(this).observationId; }
  get observationDigest(): string | undefined { return requireLeaseReleaseProof(this).observationDigest; }
  get externalInvocationState(): ExecutorObservationStateV2 { return requireLeaseReleaseProof(this).externalInvocationState; }
  get semanticEventsDurable(): "DURABLE" { return requireLeaseReleaseProof(this).semanticEventsDurable; }
  get artifactWritesDurable(): "DURABLE" { return requireLeaseReleaseProof(this).artifactWritesDurable; }
  get leaseOwnership(): "VERIFIED_CURRENT_OWNER" { return requireLeaseReleaseProof(this).leaseOwnership; }
  get executorBoundaryState(): "NOT_CROSSED" | "CROSSED" { return requireLeaseReleaseProof(this).executorBoundaryState; }
  get artifactRefs(): readonly string[] { return requireLeaseReleaseProof(this).artifactRefs; }

  toJSON(): LeaseReleaseProofRecordV2 { return this.record; }
}
Object.freeze(LeaseReleaseProofV2.prototype);

export function isLeaseReleaseProofV2(value: unknown): value is LeaseReleaseProofV2 {
  return typeof value === "object" && value !== null && leaseReleaseProofInternals.has(value as LeaseReleaseProofV2);
}

export function assertLeaseReleaseProofV2(value: unknown): asserts value is LeaseReleaseProofV2 {
  if (!isLeaseReleaseProofV2(value)) throw new Error("RALPH_LEASE_RELEASE_PROOF_TRUST_REQUIRED");
}

function requireLeaseReleaseProof(value: LeaseReleaseProofV2): LeaseReleaseProofRecordV2 {
  const record = leaseReleaseProofInternals.get(value);
  if (!record) throw new Error("RALPH_LEASE_RELEASE_PROOF_TRUST_REQUIRED");
  return record;
}

export interface RunLeaseRecordV2 {
  readonly leaseSchema: typeof RALPH_RUN_LEASE_SCHEMA_V2;
  readonly leaseId: string;
  readonly runId: string;
  readonly pid: number;
  readonly processStartIdentity: string;
  readonly hostIdentity: string;
  readonly bootSessionIdentity: string;
  readonly runtimeInstanceId: string;
  readonly acquiredAt: string;
  readonly heartbeat: typeof RALPH_RUN_LEASE_HEARTBEAT_DISABLED;
  readonly renewedAt: null;
  readonly ownerTokenDigest: string;
}

export interface RecoveryClaimV2 {
  readonly recoverySchema: typeof RALPH_RECOVERY_CLAIM_SCHEMA_V2;
  readonly recoveryId: string;
  readonly targetLeaseId: string;
  readonly runId: string;
  readonly recoverer: ProcessIdentity;
  readonly runtimeInstanceId: string;
  readonly acquiredAt: string;
  readonly recoveryTokenDigest: string;
}

export interface RunLeasePathsV2 {
  readonly locksDirectory: string;
  readonly leasePath: string;
  readonly recoveryPath: string;
}

export interface RunLeaseInspectionV2 {
  readonly kind: "ABSENT" | "PRESENT";
  readonly path: string;
  readonly lease?: RunLeaseRecordV2;
}

export interface RecoveryClaimInspectionV2 {
  readonly kind: "ABSENT" | "PRESENT";
  readonly path: string;
  readonly claim?: RecoveryClaimV2;
}

export interface LeaseRuntimeInputV2 {
  readonly projectRoot: string;
  readonly runId: string;
  readonly genesisState: RalphRuntimeStateV2;
  readonly fs?: EventStoreV2Options["fs"];
  readonly externalFacts?: OperationalRunV2ExternalFacts;
  readonly workspaceFingerprintFileSystem?: WorkspaceFingerprintFileSystem;
  /** Explicit continuation mode for a lease reacquired after execution. */
  readonly workspaceComparison?: "REQUIRE_INITIAL" | "ALLOW_POST_EXECUTOR_DRIFT";
  readonly processIdentityProvider?: ProcessIdentityProvider;
  readonly clock?: () => string;
  /** Injectable only for deterministic tests; the default is CSPRNG-backed. */
  readonly ownerTokenFactory?: () => Buffer;
  /** Injectable only for deterministic tests; the default is UUID/CSPRNG-backed. */
  readonly leaseIdFactory?: () => string;
  readonly runtimeInstanceId?: string;
  readonly nonceFactory?: () => string;
}

export interface RecoveryLeaseInputV2 extends LeaseRuntimeInputV2 {
  readonly notInvokedProof?: NotInvokedProofV2;
  readonly recoveryIdFactory?: () => string;
  readonly recoveryTokenFactory?: () => Buffer;
}

export interface LeaseReleaseOptionsV2 {
  /** A sealed Core observation proof; plain objects are not accepted. */
  readonly proof?: LeaseReleaseProofV2;
  /**
   * Retained as a deliberately rejected compatibility surface for callers
   * compiled against the deferred M1 API.  These values are never authority.
   */
  readonly noActiveExternalInvocation?: true;
  readonly semanticWritesDurable?: true;
  readonly artifactWritesDurable?: true;
  readonly noExecutorCapability?: true;
}

export interface SnapshotRepairResultV2 {
  readonly repaired: boolean;
  readonly state: RalphRuntimeStateV2;
  readonly ledger: LedgerInspectionV2;
}

interface LeaseInternals {
  store: RalphEventStoreV2;
  projectRoot: string;
  runId: string;
  genesisState: RalphRuntimeStateV2;
  runSnapshot: NonNullable<InspectOperationalRunV2Result["runSnapshot"]>;
  ledger: NonNullable<InspectOperationalRunV2Result["ledger"]>;
  state: NonNullable<InspectOperationalRunV2Result["state"]>;
  processIdentity: ProcessIdentity;
  lease: RunLeaseRecordV2;
  ownerToken: Buffer;
  ownerTokenDigest: string;
  processIdentityProvider: ProcessIdentityProvider;
  externalFacts?: OperationalRunV2ExternalFacts;
  workspaceFingerprintFileSystem?: WorkspaceFingerprintFileSystem;
  clock: () => string;
  nonceFactory: () => string;
  lifecycle: "HELD" | "LOST" | "RELEASED" | "DURABILITY_UNKNOWN";
}

const leaseInternals = new WeakMap<LeasedRunV2, LeaseInternals>();
const LEASED_RUN_CONSTRUCTION_SEAL = Symbol("LeasedRunV2");

/**
 * Core-owned capability.  The owner token is kept in a private WeakMap and is
 * intentionally absent from enumerable fields, getters and JSON output.
 */
export class LeasedRunV2 {
  readonly kind = "LeasedRunV2" as const;

  /** The second argument is an unexported construction capability. */
  constructor(internal: LeaseInternals, seal: symbol) {
    if (seal !== LEASED_RUN_CONSTRUCTION_SEAL) throw new RalphRunLeaseError("LEASE_HANDLE_REQUIRED");
    leaseInternals.set(this, internal);
  }

  get runId(): string { return requireLeaseInternals(this).runId; }
  get projectRoot(): string { return requireLeaseInternals(this).projectRoot; }
  get store(): RalphEventStoreV2 { return requireLeaseInternals(this).store; }
  get snapshot(): LeaseInternals["runSnapshot"] { return requireLeaseInternals(this).runSnapshot; }
  get state(): LeaseInternals["state"] { return requireLeaseInternals(this).state; }
  get ledger(): LeaseInternals["ledger"] { return requireLeaseInternals(this).ledger; }
  get verifiedLedgerCursor(): { readonly runId: string; readonly lastSequence: number; readonly lastEventHash: string | null } {
    const internal = requireLeaseInternals(this);
    return { runId: internal.runId, lastSequence: internal.ledger.lastSequence, lastEventHash: internal.ledger.lastEventHash };
  }
  get leaseId(): string { return requireLeaseInternals(this).lease.leaseId; }
  get runtimeInstanceId(): string { return requireLeaseInternals(this).lease.runtimeInstanceId; }
  get processIdentity(): ProcessIdentity { return requireLeaseInternals(this).processIdentity; }
  get workspaceFingerprintFileSystem(): WorkspaceFingerprintFileSystem | undefined {
    return requireLeaseInternals(this).workspaceFingerprintFileSystem;
  }
  get leasePath(): string { return leasePathsForStore(requireLeaseInternals(this).store).leasePath; }

  toJSON(): Readonly<Record<string, unknown>> {
    const internal = requireLeaseInternals(this);
    return {
      kind: this.kind,
      runId: internal.runId,
      projectRoot: internal.projectRoot,
      snapshot: internal.runSnapshot,
      state: internal.state,
      verifiedLedgerCursor: this.verifiedLedgerCursor,
      leaseId: internal.lease.leaseId,
      runtimeInstanceId: internal.lease.runtimeInstanceId,
      processIdentity: internal.processIdentity,
    };
  }
}

export function isLeasedRunV2(value: unknown): value is LeasedRunV2 {
  return typeof value === "object" && value !== null && leaseInternals.has(value as LeasedRunV2);
}

export function assertLeasedRunV2(value: unknown): asserts value is LeasedRunV2 {
  if (!isLeasedRunV2(value)) throw new RalphRunLeaseError("LEASE_HANDLE_REQUIRED");
}

export function leasePathsForStore(store: RalphEventStoreV2): RunLeasePathsV2 {
  return leasePathsFromRunDirectory(store.runDirectory);
}

export const runLeasePathsV2 = leasePathsForStore;

export async function inspectRunLeaseV2(store: RalphEventStoreV2): Promise<RunLeaseInspectionV2> {
  const paths = await ensureLocksDirectory(store);
  const lease = await readLeaseRecord(store.fileSystem, paths.leasePath, store.runId);
  return lease === undefined
    ? { kind: "ABSENT", path: paths.leasePath }
    : { kind: "PRESENT", path: paths.leasePath, lease };
}

export const readRunLeaseV2 = inspectRunLeaseV2;

export async function inspectRecoveryClaimV2(store: RalphEventStoreV2): Promise<RecoveryClaimInspectionV2> {
  const paths = await ensureLocksDirectory(store);
  const claim = await readRecoveryClaim(store.fileSystem, paths.recoveryPath, store.runId);
  return claim === undefined
    ? { kind: "ABSENT", path: paths.recoveryPath }
    : { kind: "PRESENT", path: paths.recoveryPath, claim };
}

/**
 * Open B1 read-only, take an exclusive lease, then repeat the complete B1
 * inspection before returning a capability-bearing handle.
 */
export async function acquireLeasedRunV2(input: LeaseRuntimeInputV2): Promise<LeasedRunV2> {
  return acquireLeasedRunInternal(input);
}

export const acquireRunLeaseV2 = acquireLeasedRunV2;

/** Revalidate only operational ownership; it performs no semantic write. */
export async function revalidateLeaseOwnershipV2(leasedRun: LeasedRunV2): Promise<void> {
  const internal = requireActiveLease(leasedRun);
  await verifyLeaseOwnership(internal);
}

export const verifyLeasedRunV2 = revalidateLeaseOwnershipV2;

/** Refresh the post-lease B1 view and replace the handle's verified checkpoint. */
export async function refreshLeasedRunV2(
  leasedRun: LeasedRunV2,
  options: { readonly workspaceComparison?: "REQUIRE_INITIAL" | "ALLOW_POST_EXECUTOR_DRIFT" } = {},
): Promise<LeasedRunV2> {
  const internal = requireActiveLease(leasedRun);
  await verifyLeaseOwnership(internal);
  const inspected = await inspectOperationalRunV2({ ...openInput(internal), workspaceComparison: options.workspaceComparison ?? inferredWorkspaceComparison(internal.state) });
  assertReadyForLease(inspected);
  updateFromInspection(internal, inspected);
  await verifyLeaseOwnership(internal);
  return leasedRun;
}

export const revalidateLeasedRunV2 = refreshLeasedRunV2;

/**
 * B1's read-only opening may identify a recoverable derived snapshot.  B2 is
 * the first boundary allowed to repair it, and only while a verified lease is
 * held.
 */
export async function repairStateSnapshotWhileLeasedV2(
  leasedRun: LeasedRunV2,
  options: {
    readonly writtenAt?: string;
    readonly nonce?: string;
    readonly workspaceComparison?: "REQUIRE_INITIAL" | "ALLOW_POST_EXECUTOR_DRIFT";
  } = {},
): Promise<SnapshotRepairResultV2> {
  const internal = requireActiveLease(leasedRun);
  await verifyLeaseOwnership(internal);
  const inspected = await inspectOperationalRunV2({ ...openInput(internal), workspaceComparison: options.workspaceComparison ?? inferredWorkspaceComparison(internal.state) });
  assertReadyForLease(inspected);
  if (!inspected.state || !inspected.ledger) throw new RalphRunLeaseError("LEASE_RECONCILIATION_REQUIRED", "LEASE_RECONCILIATION_REQUIRED: verified replay is unavailable");
  updateFromInspection(internal, inspected);
  if (!inspected.snapshotRepairRequired) {
    return { repaired: false, state: internal.state, ledger: internal.ledger };
  }

  // This is deliberately immediately adjacent to the derived snapshot write.
  await verifyLeaseOwnership(internal);
  const stableLedger = await internal.store.inspect();
  if (stableLedger.lastSequence !== internal.ledger.lastSequence || stableLedger.lastEventHash !== internal.ledger.lastEventHash) {
    const refreshed = await inspectOperationalRunV2({ ...openInput(internal), workspaceComparison: options.workspaceComparison ?? inferredWorkspaceComparison(internal.state) });
    assertReadyForLease(refreshed);
    if (!refreshed.state || !refreshed.ledger) throw new RalphRunLeaseError("LEASE_RECONCILIATION_REQUIRED");
    updateFromInspection(internal, refreshed);
    if (!refreshed.snapshotRepairRequired) return { repaired: false, state: internal.state, ledger: internal.ledger };
    await verifyLeaseOwnership(internal);
  }

  try {
    await persistStateSnapshotV2(
      internal.store,
      internal.state,
      options.writtenAt ?? internal.clock(),
      options.nonce ?? internal.nonceFactory(),
    );
  } catch (error) {
    throw new RalphRunLeaseError("LEASE_RECONCILIATION_REQUIRED", "LEASE_RECONCILIATION_REQUIRED: derived snapshot repair failed", error);
  }
  const repaired = await internal.store.inspect();
  internal.ledger = repaired;
  return { repaired: true, state: internal.state, ledger: repaired };
}

export const repairStateSnapshotV2 = repairStateSnapshotWhileLeasedV2;

/**
 * Normal release is ownership-checked and never removes semantic state.  A
 * post-authorization release needs explicit proof because this milestone does
 * not infer physical non-invocation from process absence.
 */
export async function releaseLeasedRunV2(
  leasedRun: LeasedRunV2,
  options: LeaseReleaseOptionsV2 = {},
): Promise<void> {
  const internal = requireActiveLease(leasedRun);
  await verifyLeaseOwnership(internal);
  if (hasLegacyReleaseClaims(options)) {
    throw new RalphRunLeaseError("LEASE_RELEASE_REJECTED", "LEASE_RELEASE_REJECTED: caller booleans are not release authority");
  }
  let releaseProof: LeaseReleaseProofV2 | undefined;
  if (options.proof !== undefined) {
    if (!isLeaseReleaseProofV2(options.proof)) throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID");
    releaseProof = options.proof;
  }
  const proofRecord = releaseProof?.record;
  const inspected = await inspectOperationalRunV2({
    ...openInput(internal),
    workspaceComparison: proofRecord?.externalInvocationState === "TERMINATED_QUIESCENT" ? "ALLOW_POST_EXECUTOR_DRIFT" : "REQUIRE_INITIAL",
  });
  assertReadyForLease(inspected);
  updateFromInspection(internal, inspected);
  const openAttempt = Object.values(internal.state.attempts).find((attempt) => attempt.disposition === "OPEN");
  if (openAttempt?.invocation) assertReleaseProof(internal, openAttempt, releaseProof);
  else if (releaseProof !== undefined) assertReleaseProof(internal, undefined, releaseProof);

  await verifyLeaseOwnership(internal);
  const paths = leasePathsForStore(internal.store);
  const current = await readLeaseRecord(internal.store.fileSystem, paths.leasePath, internal.runId);
  if (!current || !sameLeaseOwner(current, internal.lease)) {
    internal.lifecycle = "LOST";
    throw new RalphRunLeaseError("LEASE_LOST");
  }
  try {
    await internal.store.fileSystem.unlink(paths.leasePath);
  } catch (error) {
    if (isMissing(error)) {
      internal.lifecycle = "LOST";
      throw new RalphRunLeaseError("LEASE_LOST", "LEASE_LOST: lease disappeared during release", error);
    }
    throw new RalphRunLeaseError("LEASE_RELEASE_REJECTED", "LEASE_RELEASE_REJECTED: lease removal failed", error);
  }
  try {
    await internal.store.fileSystem.fsyncDirectory(paths.locksDirectory);
  } catch (error) {
    internal.lifecycle = "DURABILITY_UNKNOWN";
    throw new RalphRunLeaseError("LEASE_RELEASE_DURABILITY_UNKNOWN_REQUIRES_INSPECTION", "LEASE_RELEASE_DURABILITY_UNKNOWN_REQUIRES_INSPECTION", error);
  }
  internal.lifecycle = "RELEASED";
}

export const releaseRunLeaseV2 = releaseLeasedRunV2;

/**
 * Derive the only safe B3 release proof.  The facts are observed from the
 * leased Core handle and immutable authorization artifacts; no caller claim
 * can substitute for them.
 */
export async function derivePreExecutorReleaseProofV2(
  leasedRun: LeasedRunV2,
  input: { readonly attemptId: string; readonly invocationId: string; readonly artifactRefs: readonly string[] },
): Promise<LeaseReleaseProofV2> {
  const internal = requireActiveLease(leasedRun);
  await verifyLeaseOwnership(internal);
  const inspected = await inspectOperationalRunV2({ ...openInput(internal), workspaceComparison: "REQUIRE_INITIAL" });
  assertReadyForLease(inspected);
  updateFromInspection(internal, inspected);
  const attempt = internal.state.attempts[input.attemptId];
  if (!attempt || attempt.disposition !== "OPEN" || attempt.stage !== "EXECUTOR_DISPATCH_AUTHORIZED" || attempt.invocation?.invocationId !== input.invocationId || attempt.executorFinished !== undefined) {
    throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID", "LEASE_RELEASE_PROOF_INVALID: B3 boundary is not AUTHORIZED_NOT_INVOKED");
  }
  await assertDurableArtifactRefs(internal, input.artifactRefs, input.attemptId);
  await verifyLeaseOwnership(internal);
  return mintLeaseReleaseProof({
    runId: internal.runId,
    leaseId: internal.lease.leaseId,
    phaseId: attempt.phaseId,
    taskId: attempt.taskId,
    attemptId: input.attemptId,
    invocationId: input.invocationId,
    externalInvocationState: "NOT_INVOKED",
    semanticEventsDurable: "DURABLE",
    artifactWritesDurable: "DURABLE",
    leaseOwnership: "VERIFIED_CURRENT_OWNER",
    executorBoundaryState: "NOT_CROSSED",
    artifactRefs: [...input.artifactRefs],
  });
}

/** Derive a post-executor proof from a sealed runtime observation. */
export async function deriveExecutorReleaseProofV2(
  leasedRun: LeasedRunV2,
  observation: TrustedExecutorObservationV2,
  artifactRefs: readonly string[],
): Promise<LeaseReleaseProofV2> {
  const internal = requireActiveLease(leasedRun);
  assertTrustedExecutorObservationV2(observation);
  if (!observation || observation.state !== "TERMINATED_QUIESCENT") throw new RalphRunLeaseError("LEASE_RELEASE_EXTERNAL_INVOCATION_UNKNOWN");
  const inspected = await inspectOperationalRunV2({ ...openInput(internal), workspaceComparison: "ALLOW_POST_EXECUTOR_DRIFT" });
  assertReadyForLease(inspected);
  updateFromInspection(internal, inspected);
  const attempt = Object.values(internal.state.attempts).find((candidate) => candidate.disposition === "OPEN" && candidate.invocation?.invocationId === observation.invocationId);
  const matchingClosed = Object.values(internal.state.attempts).find((candidate) => candidate.disposition === "CLOSED" && candidate.invocation?.invocationId === observation.invocationId);
  const boundAttempt = attempt ?? matchingClosed;
  if (!boundAttempt || !boundAttempt.invocation || boundAttempt.invocation.invocationId !== observation.invocationId) {
    throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID", "LEASE_RELEASE_PROOF_INVALID: observation is not bound to this Run");
  }
  assertObservationBindingForAttempt(observation, internal.runId, boundAttempt);
  if (!observation.startedAt || !boundAttempt.executorFinished || boundAttempt.executorFinished.invocationId !== observation.invocationId
    || boundAttempt.executorFinished.status !== observation.status
    || boundAttempt.executorFinished.termination !== observation.termination
    || boundAttempt.executorFinished.finishedAt !== observation.finishedAt
    || !hasDurableExecutorFinishedEvent(internal, boundAttempt, observation)) {
    throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID", "LEASE_RELEASE_PROOF_INVALID: executor termination is not a durable Core fact");
  }
  await assertDurableArtifactRefs(internal, artifactRefs, boundAttempt.attemptId);
  await assertDurableInvocationResult(internal, boundAttempt, observation, artifactRefs);
  await verifyLeaseOwnership(internal);
  return mintLeaseReleaseProof({
    runId: internal.runId,
    leaseId: internal.lease.leaseId,
    phaseId: boundAttempt.phaseId,
    taskId: boundAttempt.taskId,
    attemptId: boundAttempt.attemptId,
    invocationId: observation.invocationId,
    runtimeIdentity: observation.runtimeIdentity,
    observationId: observation.observationId,
    observationDigest: observation.observationDigest,
    externalInvocationState: "TERMINATED_QUIESCENT",
    semanticEventsDurable: "DURABLE",
    artifactWritesDurable: "DURABLE",
    leaseOwnership: "VERIFIED_CURRENT_OWNER",
    executorBoundaryState: "CROSSED",
    artifactRefs: [...artifactRefs],
  });
}

/**
 * Conservative stale recovery.  It claims recovery exclusively, reopens the
 * ledger/state after the claim, proves owner staleness and only removes the
 * lease for the two safe pre-dispatch stages (or a trusted non-invocation
 * proof for the authorization stage).
 */
export async function recoverStaleRunLeaseV2(input: RecoveryLeaseInputV2): Promise<{ readonly kind: "RECOVERED"; readonly leasedRun: LeasedRunV2; readonly targetLeaseId: string }> {
  assertV2RuntimeState(input.genesisState);
  const provider = input.processIdentityProvider ?? defaultProcessIdentityProvider;
  const initialInspectInput = toInspectInput(input);
  const initialPre = await inspectOperationalRunV2(initialInspectInput);
  const workspaceComparison = input.workspaceComparison ?? inferredWorkspaceComparison(initialPre.state);
  const pre = workspaceComparison === input.workspaceComparison
    ? initialPre
    : await inspectOperationalRunV2({ ...initialInspectInput, workspaceComparison });
  assertReadyForLease(pre);
  const store = pre.store;
  const paths = await ensureLocksDirectory(store);
  const target = await readLeaseRecord(store.fileSystem, paths.leasePath, input.runId);
  const effectiveInput = { ...input, workspaceComparison };
  if (!target) return { kind: "RECOVERED", leasedRun: await acquireLeasedRunV2(effectiveInput), targetLeaseId: "NONE" };

  const recoverer = await provider.current();
  const recoveryId = nonEmptyFactory(input.recoveryIdFactory ?? randomUUID, "RECOVERY_ID_INVALID");
  const recoveryToken = tokenFromFactory(input.recoveryTokenFactory ?? (() => randomBytes(32)), "RECOVERY_TOKEN_INVALID");
  const recoveryRuntimeInstanceId = nonEmptyFactory(() => input.runtimeInstanceId ?? randomUUID(), "RECOVERY_RUNTIME_INSTANCE_ID_INVALID");
  const recoveryAcquiredAt = (input.clock ?? (() => new Date().toISOString()))();
  const claim: RecoveryClaimV2 = {
    recoverySchema: RALPH_RECOVERY_CLAIM_SCHEMA_V2,
    recoveryId,
    targetLeaseId: target.leaseId,
    runId: input.runId,
    recoverer,
    runtimeInstanceId: recoveryRuntimeInstanceId,
    acquiredAt: recoveryAcquiredAt,
    recoveryTokenDigest: sha256(recoveryToken),
  };
  validateRecoveryClaim(claim, input.runId);
  await publishRecoveryClaim(store.fileSystem, paths, claim, input.nonceFactory ?? randomUUID);

  let fresh: LeasedRunV2 | undefined;
  try {
    const claimed = await readRecoveryClaim(store.fileSystem, paths.recoveryPath, input.runId);
    if (!claimed || claimed.recoveryId !== claim.recoveryId || claimed.targetLeaseId !== target.leaseId) {
      throw new RalphRunLeaseError("RECOVERY_TARGET_CHANGED");
    }

    const currentTarget = await readLeaseRecord(store.fileSystem, paths.leasePath, input.runId);
    if (!currentTarget || currentTarget.leaseId !== target.leaseId || currentTarget.ownerTokenDigest !== target.ownerTokenDigest) {
      throw new RalphRunLeaseError("RECOVERY_TARGET_CHANGED");
    }
    await proveOwnerStale(provider, currentTarget);

    const authoritative = await inspectOperationalRunV2(toAuthoritativeInspectInput(effectiveInput));
    assertReadyForLease(authoritative);
    const attempt = authoritative.state ? Object.values(authoritative.state.attempts).find((candidate) => candidate.disposition === "OPEN") : undefined;
    assertSafeRecoveryStage(attempt, input.notInvokedProof, input.runId);

    // Recheck both claim target and owner directly beside the destructive step.
    const finalTarget = await readLeaseRecord(store.fileSystem, paths.leasePath, input.runId);
    if (!finalTarget || finalTarget.leaseId !== target.leaseId || finalTarget.ownerTokenDigest !== target.ownerTokenDigest) {
      throw new RalphRunLeaseError("RECOVERY_TARGET_CHANGED");
    }
    await proveOwnerStale(provider, finalTarget);
    try {
      await store.fileSystem.unlink(paths.leasePath);
    } catch (error) {
      if (isMissing(error)) throw new RalphRunLeaseError("RECOVERY_TARGET_MISSING", "RECOVERY_TARGET_MISSING", error);
      throw new RalphRunLeaseError("RECOVERY_TARGET_CHANGED", "RECOVERY_TARGET_CHANGED: stale lease removal failed", error);
    }
    try {
      await store.fileSystem.fsyncDirectory(paths.locksDirectory);
    } catch (error) {
      throw new RalphRunLeaseError("LEASE_DURABILITY_UNKNOWN_REQUIRES_INSPECTION", "LEASE_DURABILITY_UNKNOWN_REQUIRES_INSPECTION", error);
    }

    fresh = await acquireLeasedRunInternal(effectiveInput, { ownedRecoveryClaim: claim });
    await releaseRecoveryClaim(store.fileSystem, paths, claim, recoveryToken, provider);
    return { kind: "RECOVERED", leasedRun: fresh, targetLeaseId: target.leaseId };
  } catch (error) {
    // Once the old lease was removed or a new lease was acquired, an unknown
    // claim state must remain visible for inspection rather than being erased.
    if (!fresh && !(error instanceof RalphRunLeaseError && [
      "LEASE_DURABILITY_UNKNOWN_REQUIRES_INSPECTION",
      "RECOVERY_TARGET_CHANGED",
      "RECOVERY_TARGET_MISSING",
    ].includes(error.code))) {
      await releaseRecoveryClaimBestEffort(store.fileSystem, paths, claim, recoveryToken, provider);
    }
    throw error;
  }
}

export const recoverRunLeaseV2 = recoverStaleRunLeaseV2;

async function acquireLeasedRunInternal(
  input: LeaseRuntimeInputV2,
  options: { readonly ownedRecoveryClaim?: RecoveryClaimV2 } = {},
): Promise<LeasedRunV2> {
  assertV2RuntimeState(input.genesisState);
  validateRalphRunId(input.runId);
  const provider = input.processIdentityProvider ?? defaultProcessIdentityProvider;
  const initialInspectInput = toInspectInput(input);
  const initialPre = await inspectOperationalRunV2(initialInspectInput);
  const workspaceComparison = input.workspaceComparison ?? inferredWorkspaceComparison(initialPre.state);
  const pre = workspaceComparison === input.workspaceComparison
    ? initialPre
    : await inspectOperationalRunV2({ ...initialInspectInput, workspaceComparison });
  assertReadyForLease(pre);
  const store = pre.store;
  const paths = await ensureLocksDirectory(store);
  await assertRecoveryClaimAvailable(store.fileSystem, paths, input.runId, provider, options.ownedRecoveryClaim);
  const existing = await readLeaseRecord(store.fileSystem, paths.leasePath, input.runId);
  if (existing) throw new RalphRunLeaseError("LEASE_ALREADY_HELD");

  const processIdentity = await provider.current();
  validateAcquiredProcessIdentity(processIdentity);
  const ownerToken = tokenFromFactory(input.ownerTokenFactory ?? (() => randomBytes(32)), "OWNER_TOKEN_INVALID");
  const runtimeInstanceId = nonEmptyFactory(() => input.runtimeInstanceId ?? randomUUID(), "RUNTIME_INSTANCE_ID_INVALID");
  const lease: RunLeaseRecordV2 = {
    leaseSchema: RALPH_RUN_LEASE_SCHEMA_V2,
    leaseId: nonEmptyFactory(input.leaseIdFactory ?? randomUUID, "LEASE_ID_INVALID"),
    runId: input.runId,
    pid: processIdentity.pid,
    processStartIdentity: processIdentity.processStartIdentity,
    hostIdentity: processIdentity.hostIdentity,
    bootSessionIdentity: processIdentity.bootSessionIdentity,
    runtimeInstanceId,
    acquiredAt: (input.clock ?? (() => new Date().toISOString()))(),
    heartbeat: RALPH_RUN_LEASE_HEARTBEAT_DISABLED,
    renewedAt: null,
    ownerTokenDigest: sha256(ownerToken),
  };
  validateLeaseRecord(lease, input.runId);
  await publishLease(store.fileSystem, paths, lease, input.nonceFactory ?? randomUUID);

  let post: InspectOperationalRunV2Result;
  try {
    post = await inspectOperationalRunV2(toAuthoritativeInspectInput({ ...input, workspaceComparison }));
    assertReadyForLease(post);
    if (!post.runSnapshot || !post.ledger || !post.state) throw new RalphRunLeaseError("LEASE_RECONCILIATION_REQUIRED");
    const actual = await readLeaseRecord(store.fileSystem, paths.leasePath, input.runId);
    if (!actual || !sameLeaseOwner(actual, lease)) throw new RalphRunLeaseError("LEASE_LOST");
    const ownership = await provider.inspect(leaseToIdentity(lease));
    if (ownership !== "MATCH") throw ownership === "UNKNOWN"
      ? new RalphRunLeaseError("LEASE_RECONCILIATION_REQUIRED")
      : new RalphRunLeaseError("LEASE_LOST");
  } catch (error) {
    await releaseOwnedLeaseBestEffort(store.fileSystem, paths, lease);
    throw error;
  }

  const internal: LeaseInternals = {
    store: post.store,
    projectRoot: post.store.projectRoot,
    runId: input.runId,
    genesisState: freezeDeep(input.genesisState),
    runSnapshot: freezeDeep(post.runSnapshot),
    ledger: freezeDeep(post.ledger),
    state: freezeDeep(post.state),
    processIdentity: freezeDeep(processIdentity),
    lease: freezeDeep(lease),
    ownerToken: Buffer.from(ownerToken),
    ownerTokenDigest: lease.ownerTokenDigest,
    processIdentityProvider: provider,
    externalFacts: input.externalFacts,
    workspaceFingerprintFileSystem: input.workspaceFingerprintFileSystem,
    clock: input.clock ?? (() => new Date().toISOString()),
    nonceFactory: input.nonceFactory ?? randomUUID,
    lifecycle: "HELD",
  };
  return new LeasedRunV2(internal, LEASED_RUN_CONSTRUCTION_SEAL);
}

function toInspectInput(input: LeaseRuntimeInputV2): InspectOperationalRunV2Input {
  return {
    projectRoot: input.projectRoot,
    runId: input.runId,
    genesisState: input.genesisState,
    ...(input.fs === undefined ? {} : { fs: input.fs }),
    ...(input.externalFacts === undefined ? {} : { externalFacts: input.externalFacts }),
    ...(input.workspaceFingerprintFileSystem === undefined ? {} : { workspaceFingerprintFileSystem: input.workspaceFingerprintFileSystem }),
    ...(input.workspaceComparison === undefined ? {} : { workspaceComparison: input.workspaceComparison }),
  };
}

function inferredWorkspaceComparison(state: RalphRuntimeStateV2 | undefined): "REQUIRE_INITIAL" | "ALLOW_POST_EXECUTOR_DRIFT" {
  const postExecutorStages = new Set(["EXECUTOR_RUNNING", "POST_EXECUTOR_CAPTURE", "EVIDENCE_CAPTURING", "RECONCILING"]);
  const hasPostExecutorAttempt = state !== undefined && Object.values(state.attempts).some((attempt) => attempt.disposition === "OPEN" && postExecutorStages.has(attempt.stage));
  return hasPostExecutorAttempt ? "ALLOW_POST_EXECUTOR_DRIFT" : "REQUIRE_INITIAL";
}

function openInput(internal: LeaseInternals): InspectOperationalRunV2Input {
  const base: InspectOperationalRunV2Input = {
    projectRoot: internal.projectRoot,
    runId: internal.runId,
    genesisState: internal.genesisState,
    fs: internal.store.fileSystem,
    ...(internal.externalFacts === undefined ? {} : { externalFacts: internal.externalFacts }),
    ...(internal.workspaceFingerprintFileSystem === undefined ? {} : { workspaceFingerprintFileSystem: internal.workspaceFingerprintFileSystem }),
  };
  return authoritativeInspectInput(base);
}

function toAuthoritativeInspectInput(input: LeaseRuntimeInputV2): InspectOperationalRunV2Input {
  return authoritativeInspectInput(toInspectInput(input));
}

function authoritativeInspectInput(input: InspectOperationalRunV2Input): InspectOperationalRunV2Input {
  if (input.externalFacts?.workspaceFingerprint === undefined) return input;
  return {
    ...input,
    externalFacts: { ...input.externalFacts, workspaceFingerprint: undefined },
  };
}

function assertReadyForLease(result: InspectOperationalRunV2Result): asserts result is InspectOperationalRunV2Result & {
  readonly outcome: "READY_FOR_LEASE";
  readonly runSnapshot: NonNullable<InspectOperationalRunV2Result["runSnapshot"]>;
  readonly ledger: NonNullable<InspectOperationalRunV2Result["ledger"]>;
  readonly state: NonNullable<InspectOperationalRunV2Result["state"]>;
} {
  if (result.outcome !== "READY_FOR_LEASE" || !result.runSnapshot || !result.ledger || !result.state) {
    throw new RalphRunLeaseError("LEASE_ACQUISITION_NOT_READY", `LEASE_ACQUISITION_NOT_READY: ${result.issues.join(",") || result.outcome}`);
  }
}

function updateFromInspection(internal: LeaseInternals, result: InspectOperationalRunV2Result & {
  readonly runSnapshot: NonNullable<InspectOperationalRunV2Result["runSnapshot"]>;
  readonly ledger: NonNullable<InspectOperationalRunV2Result["ledger"]>;
  readonly state: NonNullable<InspectOperationalRunV2Result["state"]>;
}): void {
  internal.store = result.store;
  internal.runSnapshot = freezeDeep(result.runSnapshot);
  internal.ledger = freezeDeep(result.ledger);
  internal.state = freezeDeep(result.state);
}

function requireLeaseInternals(leasedRun: LeasedRunV2): LeaseInternals {
  const internal = leaseInternals.get(leasedRun);
  if (!internal) throw new RalphRunLeaseError("LEASE_HANDLE_REQUIRED");
  return internal;
}

function requireActiveLease(leasedRun: LeasedRunV2): LeaseInternals {
  assertLeasedRunV2(leasedRun);
  const internal = requireLeaseInternals(leasedRun);
  if (internal.lifecycle !== "HELD") {
    throw new RalphRunLeaseError(internal.lifecycle === "DURABILITY_UNKNOWN" ? "LEASE_RECONCILIATION_REQUIRED" : "LEASE_LOST");
  }
  return internal;
}

async function verifyLeaseOwnership(internal: LeaseInternals): Promise<void> {
  const paths = leasePathsForStore(internal.store);
  let current: RunLeaseRecordV2 | undefined;
  try {
    current = await readLeaseRecord(internal.store.fileSystem, paths.leasePath, internal.runId);
  } catch (error) {
    throw markLeaseLost(internal, error);
  }
  if (!current || !sameLeaseOwner(current, internal.lease)) throw markLeaseLost(internal);
  let inspection: ProcessIdentityInspection;
  try {
    inspection = await internal.processIdentityProvider.inspect(leaseToIdentity(current));
  } catch (error) {
    throw new RalphRunLeaseError("LEASE_RECONCILIATION_REQUIRED", "LEASE_RECONCILIATION_REQUIRED: process identity inspection failed", error);
  }
  if (inspection === "UNKNOWN") throw new RalphRunLeaseError("LEASE_RECONCILIATION_REQUIRED");
  if (inspection !== "MATCH") throw markLeaseLost(internal);
}

function validateAcquiredProcessIdentity(identity: ProcessIdentity): void {
  if (!isRecord(identity) || !Number.isSafeInteger(identity.pid) || identity.pid < 1
    || typeof identity.processStartIdentity !== "string" || identity.processStartIdentity.length === 0
    || typeof identity.hostIdentity !== "string" || identity.hostIdentity.length === 0
    || typeof identity.bootSessionIdentity !== "string" || identity.bootSessionIdentity.length === 0) {
    throw new RalphRunLeaseError("LEASE_PUBLICATION_FAILED", "LEASE_PUBLICATION_FAILED: process identity is invalid");
  }
}

function markLeaseLost(internal: LeaseInternals, cause?: unknown): RalphRunLeaseError {
  internal.lifecycle = "LOST";
  return new RalphRunLeaseError("LEASE_LOST", "LEASE_LOST", cause);
}

async function ensureLocksDirectory(store: RalphEventStoreV2): Promise<RunLeasePathsV2> {
  await store.ensureLayout();
  const paths = leasePathsForStore(store);
  await ensureDirectory(store.fileSystem, paths.locksDirectory);
  return paths;
}

function leasePathsFromRunDirectory(runDirectory: string): RunLeasePathsV2 {
  const locksDirectory = join(runDirectory, "locks");
  return { locksDirectory, leasePath: join(locksDirectory, "lease.json"), recoveryPath: join(locksDirectory, "recovery.json") };
}

async function ensureDirectory(fileSystem: RalphRuntimeFileSystem, path: string): Promise<void> {
  let stats: Stats | undefined;
  try {
    stats = await fileSystem.lstat(path);
  } catch (error) {
    if (!isMissing(error)) throw new RalphRunLeaseError("LEASE_PATH_UNSAFE", "LEASE_PATH_UNSAFE: locks directory cannot be inspected", error);
    try {
      await fileSystem.mkdir(path, { recursive: false, mode: 0o700 });
    } catch (mkdirError) {
      if (!isExisting(mkdirError)) throw new RalphRunLeaseError("LEASE_PATH_UNSAFE", "LEASE_PATH_UNSAFE: locks directory cannot be created", mkdirError);
      try { stats = await fileSystem.lstat(path); }
      catch (lstatError) { throw new RalphRunLeaseError("LEASE_PATH_UNSAFE", "LEASE_PATH_UNSAFE: locks directory race", lstatError); }
    }
    if (stats === undefined) {
      try { stats = await fileSystem.lstat(path); }
      catch (lstatError) { throw new RalphRunLeaseError("LEASE_PATH_UNSAFE", "LEASE_PATH_UNSAFE: locks directory disappeared", lstatError); }
    }
  }
  if (!stats || stats.isSymbolicLink() || !stats.isDirectory() || modeOf(stats) !== 0o700) {
    throw new RalphRunLeaseError("LEASE_PATH_UNSAFE", `LEASE_PATH_UNSAFE: ${path}`);
  }
}

async function readLeaseRecord(fileSystem: RalphRuntimeFileSystem, path: string, runId: string): Promise<RunLeaseRecordV2 | undefined> {
  let stats: Stats;
  try { stats = await fileSystem.lstat(path); }
  catch (error) {
    if (isMissing(error)) return undefined;
    throw new RalphRunLeaseError("LEASE_PATH_UNSAFE", "LEASE_PATH_UNSAFE: lease cannot be inspected", error);
  }
  if (stats.isSymbolicLink() || !stats.isFile() || modeOf(stats) !== 0o600) throw new RalphRunLeaseError("LEASE_PATH_UNSAFE", `LEASE_PATH_UNSAFE: ${path}`);
  let bytes: Buffer;
  try { bytes = await fileSystem.readFile(path); }
  catch (error) { throw new RalphRunLeaseError("LEASE_INVALID", "LEASE_INVALID: lease disappeared during inspection", error); }
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch (error) { throw new RalphRunLeaseError("LEASE_INVALID", "LEASE_INVALID: malformed lease JSON", error); }
  try { validateLeaseRecord(parsed, runId); }
  catch (error) {
    if (error instanceof RalphRunLeaseError) throw error;
    throw new RalphRunLeaseError("LEASE_INVALID", "LEASE_INVALID: lease schema invalid", error);
  }
  if (bytes.toString("utf8") !== canonicalJson(parsed)) throw new RalphRunLeaseError("LEASE_INVALID", "LEASE_INVALID: lease is not canonical");
  return parsed;
}

async function readRecoveryClaim(fileSystem: RalphRuntimeFileSystem, path: string, runId: string): Promise<RecoveryClaimV2 | undefined> {
  let stats: Stats;
  try { stats = await fileSystem.lstat(path); }
  catch (error) {
    if (isMissing(error)) return undefined;
    throw new RalphRunLeaseError("RECOVERY_CLAIM_RECONCILIATION_REQUIRED", "RECOVERY_CLAIM_RECONCILIATION_REQUIRED: claim cannot be inspected", error);
  }
  if (stats.isSymbolicLink() || !stats.isFile() || modeOf(stats) !== 0o600) throw new RalphRunLeaseError("RECOVERY_CLAIM_RECONCILIATION_REQUIRED");
  let bytes: Buffer;
  try { bytes = await fileSystem.readFile(path); }
  catch (error) { throw new RalphRunLeaseError("RECOVERY_CLAIM_RECONCILIATION_REQUIRED", "RECOVERY_CLAIM_RECONCILIATION_REQUIRED: claim disappeared", error); }
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch (error) { throw new RalphRunLeaseError("RECOVERY_CLAIM_RECONCILIATION_REQUIRED", "RECOVERY_CLAIM_RECONCILIATION_REQUIRED: malformed claim", error); }
  try { validateRecoveryClaim(parsed, runId); }
  catch (error) {
    if (error instanceof RalphRunLeaseError) throw error;
    throw new RalphRunLeaseError("RECOVERY_CLAIM_RECONCILIATION_REQUIRED", "RECOVERY_CLAIM_RECONCILIATION_REQUIRED: claim schema invalid", error);
  }
  if (bytes.toString("utf8") !== canonicalJson(parsed)) throw new RalphRunLeaseError("RECOVERY_CLAIM_RECONCILIATION_REQUIRED");
  return parsed;
}

async function publishLease(fileSystem: RalphRuntimeFileSystem, paths: RunLeasePathsV2, lease: RunLeaseRecordV2, nonceFactory: () => string): Promise<void> {
  const temporary = join(paths.locksDirectory, `.lease.json.tmp-${safeNonce(nonceFactory)}`);
  const bytes = Buffer.from(canonicalJson(lease), "utf8");
  try {
    await fileSystem.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await fileSystem.fsyncFile(temporary);
  } catch (error) {
    throw new RalphRunLeaseError("LEASE_PUBLICATION_FAILED", "LEASE_PUBLICATION_FAILED: lease staging failed", error);
  }
  try {
    await fileSystem.link(temporary, paths.leasePath);
  } catch (error) {
    if (isExisting(error)) {
      await unlinkTemporaryBestEffort(fileSystem, temporary);
      throw new RalphRunLeaseError("LEASE_ALREADY_HELD");
    }
    throw new RalphRunLeaseError("LEASE_PUBLICATION_FAILED", "LEASE_PUBLICATION_FAILED: exclusive lease publication failed", error);
  }
  try {
    await fileSystem.fsyncDirectory(paths.locksDirectory);
  } catch (error) {
    throw new RalphRunLeaseError("LEASE_DURABILITY_UNKNOWN_REQUIRES_INSPECTION", "LEASE_DURABILITY_UNKNOWN_REQUIRES_INSPECTION", error);
  }
  try {
    await fileSystem.unlink(temporary);
    await fileSystem.fsyncDirectory(paths.locksDirectory);
  } catch (error) {
    throw new RalphRunLeaseError("LEASE_DURABILITY_UNKNOWN_REQUIRES_INSPECTION", "LEASE_DURABILITY_UNKNOWN_REQUIRES_INSPECTION", error);
  }
}

async function publishRecoveryClaim(
  fileSystem: RalphRuntimeFileSystem,
  paths: RunLeasePathsV2,
  claim: RecoveryClaimV2,
  nonceFactory: () => string,
): Promise<void> {
  const temporary = join(paths.locksDirectory, `.recovery.json.tmp-${safeNonce(nonceFactory)}`);
  const bytes = Buffer.from(canonicalJson(claim), "utf8");
  try {
    await fileSystem.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await fileSystem.fsyncFile(temporary);
    await fileSystem.link(temporary, paths.recoveryPath);
  } catch (error) {
    if (isExisting(error)) {
      await unlinkTemporaryBestEffort(fileSystem, temporary);
      throw new RalphRunLeaseError("RECOVERY_ALREADY_HELD");
    }
    throw new RalphRunLeaseError("RECOVERY_CLAIM_RECONCILIATION_REQUIRED", "RECOVERY_CLAIM_RECONCILIATION_REQUIRED: claim publication failed", error);
  }
  try {
    await fileSystem.fsyncDirectory(paths.locksDirectory);
  } catch (error) {
    throw new RalphRunLeaseError("RECOVERY_CLAIM_DURABILITY_UNKNOWN_REQUIRES_INSPECTION", "RECOVERY_CLAIM_DURABILITY_UNKNOWN_REQUIRES_INSPECTION", error);
  }
  try {
    await fileSystem.unlink(temporary);
    await fileSystem.fsyncDirectory(paths.locksDirectory);
  } catch (error) {
    throw new RalphRunLeaseError("RECOVERY_CLAIM_DURABILITY_UNKNOWN_REQUIRES_INSPECTION", "RECOVERY_CLAIM_DURABILITY_UNKNOWN_REQUIRES_INSPECTION", error);
  }
}

async function assertRecoveryClaimAvailable(
  fileSystem: RalphRuntimeFileSystem,
  paths: RunLeasePathsV2,
  runId: string,
  provider: ProcessIdentityProvider,
  ownedClaim?: RecoveryClaimV2,
): Promise<void> {
  const claim = await readRecoveryClaim(fileSystem, paths.recoveryPath, runId);
  if (!claim) return;
  if (ownedClaim && claim.recoveryId === ownedClaim.recoveryId && claim.targetLeaseId === ownedClaim.targetLeaseId) return;
  const status = await provider.inspect(claim.recoverer);
  if (status === "MATCH") throw new RalphRunLeaseError("RECOVERY_ALREADY_HELD");
  if (status === "UNKNOWN") throw new RalphRunLeaseError("RECOVERY_CLAIM_RECONCILIATION_REQUIRED");
  throw new RalphRunLeaseError("RECOVERY_CLAIM_STALE_REQUIRES_INSPECTION");
}

async function proveOwnerStale(provider: ProcessIdentityProvider, lease: RunLeaseRecordV2): Promise<void> {
  const status = await provider.inspect(leaseToIdentity(lease));
  if (status === "MATCH") throw new RalphRunLeaseError("LEASE_ALREADY_HELD");
  if (status === "UNKNOWN") throw new RalphRunLeaseError("LEASE_RECONCILIATION_REQUIRED");
  if (status !== "ABSENT" && status !== "START_MISMATCH") throw new RalphRunLeaseError("LEASE_RECONCILIATION_REQUIRED");
}

function mintLeaseReleaseProof(input: Omit<LeaseReleaseProofRecordV2, "kind" | "proofId">): LeaseReleaseProofV2 {
  validateLeaseReleaseProofInput(input);
  const proofBase = { kind: "CORE_LEASE_RELEASE_PROOF" as const, ...input, artifactRefs: [...input.artifactRefs] };
  const record: LeaseReleaseProofRecordV2 = {
    ...proofBase,
    proofId: `lrp-${sha256Canonical(proofBase).slice("sha256:".length)}`,
  };
  return new LeaseReleaseProofV2(record, LEASE_RELEASE_PROOF_SEAL);
}

function validateLeaseReleaseProofInput(input: Omit<LeaseReleaseProofRecordV2, "kind" | "proofId">): void {
  assertSafeLeaseIdentity(input.runId);
  assertSafeLeaseIdentity(input.leaseId);
  for (const value of [input.phaseId, input.taskId, input.attemptId, input.invocationId, input.runtimeIdentity, input.observationId]) {
    if (value !== undefined) assertSafeLeaseIdentity(value);
  }
  if (input.observationDigest !== undefined && !isSha256Digest(input.observationDigest)) throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID");
  if (!EXECUTOR_OBSERVATION_STATES.includes(input.externalInvocationState)) throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID");
  if (input.semanticEventsDurable !== "DURABLE" || input.artifactWritesDurable !== "DURABLE" || input.leaseOwnership !== "VERIFIED_CURRENT_OWNER") {
    throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID");
  }
  if (!EXECUTOR_BOUNDARY_STATES.includes(input.executorBoundaryState)) throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID");
  for (const ref of input.artifactRefs) assertSafeArtifactRef(ref);
  if (input.attemptId !== undefined && input.artifactRefs.some((ref) => ref.split("/")[1] !== input.attemptId)) throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID");
  if (input.externalInvocationState !== "NOT_INVOKED"
    && (!input.phaseId || !input.taskId || !input.attemptId || !input.invocationId || !input.runtimeIdentity || !input.observationId || !input.observationDigest)) {
    throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID");
  }
  if (input.externalInvocationState === "NOT_INVOKED" && (!input.phaseId || !input.taskId || !input.attemptId || !input.invocationId)) {
    throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID");
  }
  if (input.externalInvocationState === "NOT_INVOKED" && input.executorBoundaryState !== "NOT_CROSSED") throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID");
  if (input.externalInvocationState === "TERMINATED_QUIESCENT" && input.executorBoundaryState !== "CROSSED") throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID");
  if ((input.externalInvocationState === "RUNNING" || input.externalInvocationState === "UNKNOWN") && input.executorBoundaryState !== "CROSSED") throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID");
}

function assertObservationBindingForAttempt(observation: TrustedExecutorObservationV2, runId: string, attempt: AttemptStateV2): void {
  if (!attempt.invocation || observation.record.runId !== runId || observation.record.phaseId !== attempt.phaseId || observation.record.taskId !== attempt.taskId || observation.record.attemptId !== attempt.attemptId || observation.record.invocationId !== attempt.invocation.invocationId) {
    throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID", "LEASE_RELEASE_PROOF_INVALID: observation binding mismatch");
  }
}

function hasDurableExecutorFinishedEvent(internal: LeaseInternals, attempt: AttemptStateV2, observation: TrustedExecutorObservationV2): boolean {
  return internal.ledger.events.some((event) => event.eventType === "executor.finished"
    && event.attemptId === attempt.attemptId
    && event.phaseId === attempt.phaseId
    && event.taskId === attempt.taskId
    && event.payload.invocationId === observation.invocationId
    && event.payload.status === observation.status
    && event.payload.termination === observation.termination
    && event.payload.finishedAt === observation.finishedAt);
}

async function assertDurableInvocationResult(
  internal: LeaseInternals,
  attempt: AttemptStateV2,
  observation: TrustedExecutorObservationV2,
  artifactRefs: readonly string[],
): Promise<void> {
  const resultRef = `attempts/${attempt.attemptId}/invocation-result.json`;
  if (!artifactRefs.includes(resultRef)) {
    throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID", "LEASE_RELEASE_PROOF_INVALID: invocation-result durability fact is missing");
  }
  let result: InvocationResultV2 | undefined;
  try {
    result = await readInvocationResultV2(internal.store, attempt.attemptId);
  } catch (error) {
    throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID", "LEASE_RELEASE_PROOF_INVALID: invocation-result cannot be verified", error);
  }
  if (!result
    || result.runId !== internal.runId
    || result.phaseId !== attempt.phaseId
    || result.taskId !== attempt.taskId
    || result.attemptId !== attempt.attemptId
    || result.invocationId !== observation.invocationId
    || result.resultEnvelopeStatus !== observation.resultEnvelopeStatus
    || result.status !== observation.status
    || result.termination !== observation.termination
    || result.exitCode !== (observation.exitCode ?? null)
    || result.signal !== (observation.signal ?? null)
    || result.startedAt !== observation.startedAt
    || result.finishedAt !== observation.finishedAt) {
    throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID", "LEASE_RELEASE_PROOF_INVALID: invocation-result is not consistent with durable termination facts");
  }
}

function assertSafeLeaseIdentity(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\0") || value.includes("/")) {
    throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID");
  }
}

function assertSafeArtifactRef(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^attempts\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID");
  }
}

function assertSafeRecoveryStage(attempt: AttemptStateV2 | undefined, proof: NotInvokedProofV2 | undefined, runId: string): void {
  if (!attempt) return;
  if (attempt.stage === "ADMITTED") return;
  if (attempt.stage === "EXECUTOR_DISPATCH_AUTHORIZED") {
    if (!proof || !isNotInvokedProofV2(proof)) {
      throw new RalphRunLeaseError("LEASE_RECONCILIATION_REQUIRED", "LEASE_RECONCILIATION_REQUIRED: NOT_INVOKED proof is required");
    }
    try { assertNotInvokedProofV2(proof); } catch (error) { throw new RalphRunLeaseError("LEASE_RECONCILIATION_REQUIRED", "LEASE_RECONCILIATION_REQUIRED: NOT_INVOKED proof is not Core-owned", error); }
    const record = proof.record;
    if (record.attemptId !== attempt.attemptId || record.runId !== runId || record.phaseId !== attempt.phaseId || record.taskId !== attempt.taskId || record.invocationId !== attempt.invocation?.invocationId) {
      throw new RalphRunLeaseError("LEASE_RECONCILIATION_REQUIRED", "LEASE_RECONCILIATION_REQUIRED: NOT_INVOKED proof binding mismatch");
    }
    return;
  }
  throw new RalphRunLeaseError("LEASE_RECONCILIATION_REQUIRED", "LEASE_RECONCILIATION_REQUIRED: recovery stage is unsafe");
}

function assertReleaseProof(
  internal: LeaseInternals,
  attempt: AttemptStateV2 | undefined,
  proof: LeaseReleaseProofV2 | undefined,
): void {
  if (!proof || !isLeaseReleaseProofV2(proof)) throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_REQUIRED", "LEASE_RELEASE_PROOF_REQUIRED: a sealed Core proof is required");
  try { assertLeaseReleaseProofV2(proof); }
  catch (error) { throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID", "LEASE_RELEASE_PROOF_INVALID", error); }
  const record = proof.record;
  if (record.runId !== internal.runId || record.leaseId !== internal.lease.leaseId || record.leaseOwnership !== "VERIFIED_CURRENT_OWNER") {
    throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID", "LEASE_RELEASE_PROOF_INVALID: proof owner binding mismatch");
  }
  if (record.semanticEventsDurable !== "DURABLE" || record.artifactWritesDurable !== "DURABLE") {
    throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID", "LEASE_RELEASE_PROOF_INVALID: durability is unresolved");
  }
  if (record.externalInvocationState === "RUNNING" || record.externalInvocationState === "UNKNOWN") {
    throw new RalphRunLeaseError("LEASE_RELEASE_EXTERNAL_INVOCATION_UNKNOWN");
  }
  if (record.attemptId !== undefined && record.artifactRefs.some((ref) => ref.split("/")[1] !== record.attemptId)) {
    throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID", "LEASE_RELEASE_PROOF_INVALID: artifact binding mismatch");
  }
  if (!attempt) {
    if (record.externalInvocationState !== "TERMINATED_QUIESCENT" || record.attemptId === undefined) {
      throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID", "LEASE_RELEASE_PROOF_INVALID: Attempt binding is missing");
    }
    return;
  }
  if (record.attemptId !== attempt.attemptId || record.invocationId !== attempt.invocation?.invocationId) {
    throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID", "LEASE_RELEASE_PROOF_INVALID: Attempt/invocation binding mismatch");
  }
  if (record.phaseId !== undefined && record.phaseId !== attempt.phaseId || record.taskId !== undefined && record.taskId !== attempt.taskId) {
    throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID", "LEASE_RELEASE_PROOF_INVALID: phase/task binding mismatch");
  }
  if (record.externalInvocationState === "NOT_INVOKED") {
    if (attempt.stage !== "EXECUTOR_DISPATCH_AUTHORIZED" || attempt.executorFinished !== undefined || record.executorBoundaryState !== "NOT_CROSSED") {
      throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID", "LEASE_RELEASE_PROOF_INVALID: NOT_INVOKED proof does not match the dispatch boundary");
    }
    return;
  }
  if (record.externalInvocationState === "TERMINATED_QUIESCENT" && record.executorBoundaryState !== "CROSSED") {
    throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID", "LEASE_RELEASE_PROOF_INVALID: terminated proof has not crossed the executor boundary");
  }
}

async function assertDurableArtifactRefs(internal: LeaseInternals, refs: readonly string[], expectedAttemptId?: string): Promise<void> {
  if (refs.length === 0) throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID", "LEASE_RELEASE_PROOF_INVALID: no artifact durability facts");
  for (const ref of refs) {
    if (!/^attempts\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(ref)) {
      throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID", "LEASE_RELEASE_PROOF_INVALID: artifact reference is unsafe");
    }
    const attemptId = ref.split("/")[1];
    if (!attemptId) throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID", "LEASE_RELEASE_PROOF_INVALID: artifact reference is unsafe");
    if (expectedAttemptId !== undefined && attemptId !== expectedAttemptId) throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID", "LEASE_RELEASE_PROOF_INVALID: artifact does not belong to the proved Attempt");
    for (const directory of [join(internal.store.runDirectory, "attempts"), join(internal.store.runDirectory, "attempts", attemptId)]) {
      let directoryStats: Stats;
      try { directoryStats = await internal.store.fileSystem.lstat(directory); }
      catch (error) { throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID", "LEASE_RELEASE_PROOF_INVALID: artifact directory is not durable", error); }
      if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory() || modeOf(directoryStats) !== 0o700) {
        throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID", "LEASE_RELEASE_PROOF_INVALID: artifact directory path is unsafe");
      }
    }
    const path = join(internal.store.runDirectory, ref);
    let stats: Stats;
    try { stats = await internal.store.fileSystem.lstat(path); }
    catch (error) { throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID", "LEASE_RELEASE_PROOF_INVALID: artifact is not durable", error); }
    if (stats.isSymbolicLink() || !stats.isFile() || modeOf(stats) !== 0o600) {
      throw new RalphRunLeaseError("LEASE_RELEASE_PROOF_INVALID", "LEASE_RELEASE_PROOF_INVALID: artifact path is unsafe");
    }
  }
}

function hasLegacyReleaseClaims(options: LeaseReleaseOptionsV2): boolean {
  return options.noActiveExternalInvocation === true
    || options.semanticWritesDurable === true
    || options.artifactWritesDurable === true
    || options.noExecutorCapability === true;
}

async function releaseRecoveryClaim(
  fileSystem: RalphRuntimeFileSystem,
  paths: RunLeasePathsV2,
  claim: RecoveryClaimV2,
  token: Buffer,
  provider: ProcessIdentityProvider,
): Promise<void> {
  const current = await readRecoveryClaim(fileSystem, paths.recoveryPath, claim.runId);
  if (!current || current.recoveryId !== claim.recoveryId || current.recoveryTokenDigest !== sha256(token)) {
    throw new RalphRunLeaseError("RECOVERY_CLAIM_RECONCILIATION_REQUIRED");
  }
  const status = await provider.inspect(current.recoverer);
  if (status !== "MATCH") throw new RalphRunLeaseError("RECOVERY_CLAIM_RECONCILIATION_REQUIRED");
  try { await fileSystem.unlink(paths.recoveryPath); }
  catch (error) { throw new RalphRunLeaseError("RECOVERY_CLAIM_RECONCILIATION_REQUIRED", "RECOVERY_CLAIM_RECONCILIATION_REQUIRED: claim release failed", error); }
  try { await fileSystem.fsyncDirectory(paths.locksDirectory); }
  catch (error) { throw new RalphRunLeaseError("RECOVERY_CLAIM_DURABILITY_UNKNOWN_REQUIRES_INSPECTION", "RECOVERY_CLAIM_DURABILITY_UNKNOWN_REQUIRES_INSPECTION", error); }
}

async function releaseRecoveryClaimBestEffort(
  fileSystem: RalphRuntimeFileSystem,
  paths: RunLeasePathsV2,
  claim: RecoveryClaimV2,
  token: Buffer,
  provider: ProcessIdentityProvider,
): Promise<void> {
  try { await releaseRecoveryClaim(fileSystem, paths, claim, token, provider); } catch { /* conservative claim remains if release is uncertain */ }
}

async function releaseOwnedLeaseBestEffort(fileSystem: RalphRuntimeFileSystem, paths: RunLeasePathsV2, lease: RunLeaseRecordV2): Promise<void> {
  try {
    const current = await readLeaseRecord(fileSystem, paths.leasePath, lease.runId);
    if (!current || !sameLeaseOwner(current, lease)) return;
    await fileSystem.unlink(paths.leasePath);
    await fileSystem.fsyncDirectory(paths.locksDirectory);
  } catch {
    // A failed cleanup is intentionally not turned into an absent claim.
  }
}

async function unlinkTemporaryBestEffort(fileSystem: RalphRuntimeFileSystem, path: string): Promise<void> {
  try { await fileSystem.unlink(path); } catch { /* target ownership remains authoritative */ }
}

function validateLeaseRecord(value: unknown, runId: string): asserts value is RunLeaseRecordV2 {
  if (!isRecord(value)) throw new RalphRunLeaseError("LEASE_INVALID");
  assertExactKeys(value, [
    "leaseSchema", "leaseId", "runId", "pid", "processStartIdentity", "hostIdentity", "bootSessionIdentity",
    "runtimeInstanceId", "acquiredAt", "heartbeat", "renewedAt", "ownerTokenDigest",
  ], "LEASE_INVALID");
  if (value.leaseSchema !== RALPH_RUN_LEASE_SCHEMA_V2 || value.runId !== runId) throw new RalphRunLeaseError(value.runId === runId ? "LEASE_INVALID" : "LEASE_FOREIGN_RUN");
  if (!Number.isSafeInteger(value.pid) || value.pid < 1) throw new RalphRunLeaseError("LEASE_INVALID");
  for (const key of ["leaseId", "processStartIdentity", "hostIdentity", "bootSessionIdentity", "runtimeInstanceId", "acquiredAt"] as const) assertNonEmptyString(value[key], "LEASE_INVALID");
  if (value.heartbeat !== RALPH_RUN_LEASE_HEARTBEAT_DISABLED || value.renewedAt !== null || !isSha256Digest(value.ownerTokenDigest)) throw new RalphRunLeaseError("LEASE_INVALID");
}

function validateRecoveryClaim(value: unknown, runId: string): asserts value is RecoveryClaimV2 {
  if (!isRecord(value)) throw new RalphRunLeaseError("RECOVERY_CLAIM_RECONCILIATION_REQUIRED");
  assertExactKeys(value, ["recoverySchema", "recoveryId", "targetLeaseId", "runId", "recoverer", "runtimeInstanceId", "acquiredAt", "recoveryTokenDigest"], "RECOVERY_CLAIM_RECONCILIATION_REQUIRED");
  if (value.recoverySchema !== RALPH_RECOVERY_CLAIM_SCHEMA_V2 || value.runId !== runId) throw new RalphRunLeaseError("RECOVERY_CLAIM_RECONCILIATION_REQUIRED");
  for (const key of ["recoveryId", "targetLeaseId", "runtimeInstanceId", "acquiredAt"] as const) assertNonEmptyString(value[key], "RECOVERY_CLAIM_RECONCILIATION_REQUIRED");
  if (!isSha256Digest(value.recoveryTokenDigest)) throw new RalphRunLeaseError("RECOVERY_CLAIM_RECONCILIATION_REQUIRED");
  validateProcessIdentity(value.recoverer);
}

function validateProcessIdentity(value: unknown): asserts value is ProcessIdentity {
  if (!isRecord(value)) throw new RalphRunLeaseError("RECOVERY_CLAIM_RECONCILIATION_REQUIRED");
  assertExactKeys(value, ["pid", "processStartIdentity", "hostIdentity", "bootSessionIdentity"], "RECOVERY_CLAIM_RECONCILIATION_REQUIRED");
  if (!Number.isSafeInteger(value.pid) || value.pid < 1) throw new RalphRunLeaseError("RECOVERY_CLAIM_RECONCILIATION_REQUIRED");
  for (const key of ["processStartIdentity", "hostIdentity", "bootSessionIdentity"] as const) assertNonEmptyString(value[key], "RECOVERY_CLAIM_RECONCILIATION_REQUIRED");
}

function leaseToIdentity(lease: RunLeaseRecordV2): ProcessIdentity {
  return {
    pid: lease.pid,
    processStartIdentity: lease.processStartIdentity,
    hostIdentity: lease.hostIdentity,
    bootSessionIdentity: lease.bootSessionIdentity,
  };
}

function sameLeaseOwner(left: RunLeaseRecordV2, right: RunLeaseRecordV2): boolean {
  return left.runId === right.runId
    && left.leaseId === right.leaseId
    && left.runtimeInstanceId === right.runtimeInstanceId
    && left.ownerTokenDigest === right.ownerTokenDigest
    && left.pid === right.pid
    && left.processStartIdentity === right.processStartIdentity
    && left.hostIdentity === right.hostIdentity
    && left.bootSessionIdentity === right.bootSessionIdentity;
}

function tokenFromFactory(factory: () => Buffer, code: string): Buffer {
  const token = factory();
  if (!Buffer.isBuffer(token) || token.length < 16) throw new RalphRunLeaseError("LEASE_PUBLICATION_FAILED", code);
  return Buffer.from(token);
}

function nonEmptyFactory(factory: () => string, code: string): string {
  const value = factory();
  if (typeof value !== "string" || value.length === 0 || value.includes("/")) throw new RalphRunLeaseError("LEASE_PUBLICATION_FAILED", code);
  return value;
}

function safeNonce(factory: () => string): string {
  const value = factory();
  return typeof value === "string" && /^[A-Za-z0-9._-]+$/.test(value) ? value : randomUUID();
}

function assertExactKeys(value: object, allowed: readonly string[], code: RunLeaseErrorCode): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new RalphRunLeaseError(code, `${code}: ${unknown.sort().join(",")}`);
}

function assertNonEmptyString(value: unknown, code: RunLeaseErrorCode): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new RalphRunLeaseError(code);
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function modeOf(stats: Stats): number { return stats.mode & 0o7777; }

function freezeDeep<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  return value;
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { readonly code?: unknown }).code === "ENOENT");
}

function isExisting(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { readonly code?: unknown }).code === "EEXIST");
}
