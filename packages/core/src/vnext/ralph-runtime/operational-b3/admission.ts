import { randomUUID } from "node:crypto";
import type { ExecutionDocument, Phase, Task } from "../../../types.js";
import { canonicalJson } from "../canonical-json.js";
import { sha256Canonical } from "../hashing.js";
import { fingerprintWorkspace, type WorkspaceFingerprintFileSystem } from "../fingerprint.js";
import type { FingerprintIdentity } from "../contracts.js";
import { expectedAttemptBaseFingerprint } from "../checkpoints.js";
import { commitRalphEventV2 } from "../operational-b1/commit.js";
import { createRalphEventV2, type EventPayloadMapV2, type RalphEventTypeV2, type RalphEventV2, type UnsignedRalphEventV2 } from "../operational-v2/events.js";
import { scheduleNextTask, type SchedulerDecision } from "../operational-v2/scheduler.js";
import type { AttemptStateV2, RalphRuntimeStateV2 } from "../operational-v2/contracts.js";
import { openAttemptsV2 } from "../operational-v2/state.js";
import {
  assertLeasedRunV2,
  refreshLeasedRunV2,
  revalidateLeaseOwnershipV2,
  repairStateSnapshotWhileLeasedV2,
  releaseLeasedRunV2,
  type LeasedRunV2,
  derivePreExecutorReleaseProofV2,
} from "../operational-b2/index.js";
import {
  createInvocationDescriptorV2,
  createWorkUnitV2,
  persistInvocationDescriptorV2,
  persistWorkUnitV2,
  readInvocationDescriptorV2,
  readWorkUnitV2,
  type ArtifactBindingInputV2,
  type InvocationDescriptorV2,
  type WorkUnitV2,
  RalphArtifactError,
} from "./artifacts.js";

export const ADMISSION_ERROR_CODES = [
  "B3_PLAN_IDENTITY_MISMATCH",
  "B3_WORKSPACE_RECONCILIATION_REQUIRED",
  "B3_ATTEMPT_RECONCILIATION_REQUIRED",
  "B3_ARTIFACT_RECONCILIATION_REQUIRED",
  "B3_DISPATCH_BINDING_INVALID",
  "B3_DURABILITY_UNKNOWN_REQUIRES_INSPECTION",
  "B3_LEASE_REQUIRED",
  "B3_AUTHORIZED_INVOCATION_REQUIRED",
] as const;
export type AdmissionErrorCode = typeof ADMISSION_ERROR_CODES[number];

export class RalphAdmissionError extends Error {
  constructor(readonly code: AdmissionErrorCode, message: string = code, readonly cause?: unknown) {
    super(message);
    this.name = "RalphAdmissionError";
  }
}

export interface PrepareNextAuthorizedInvocationV2Input {
  readonly leasedRun: LeasedRunV2;
  readonly plan: ExecutionDocument;
  readonly planIdentity?: string;
  readonly planDigest?: string;
  readonly currentWorkspaceFingerprint?: FingerprintIdentity;
  readonly workspaceFingerprintFileSystem?: WorkspaceFingerprintFileSystem;
  readonly clock?: () => string;
  readonly nonceFactory?: () => string;
  /** Injectable only for tests; the default is CSPRNG-backed. */
  readonly attemptIdFactory?: () => string;
  readonly eventIdFactory?: () => string;
  readonly currentPolicyDigests?: Readonly<Partial<{
    readonly effectiveConfigDigest: string;
    readonly executorProfileDigest: string;
    readonly permissionCapabilityPolicyDigest: string;
    readonly timeoutPolicyDigest: string;
  }>>;
}

export interface AdmittedAttemptV2 {
  readonly kind: "ADMITTED_ATTEMPT";
  readonly attempt: AttemptStateV2;
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
}

const authorizedInvocationInternals = new WeakMap<AuthorizedInvocationV2, {
  readonly descriptor: InvocationDescriptorV2;
  readonly workUnit: WorkUnitV2;
}>();
const AUTHORIZED_INVOCATION_CONSTRUCTION_SEAL = Symbol("AuthorizedInvocationV2");

export class AuthorizedInvocationV2 {
  readonly kind = "AUTHORIZED_INVOCATION" as const;

  constructor(
    descriptor: InvocationDescriptorV2,
    workUnit: WorkUnitV2,
    seal: symbol,
  ) {
    if (seal !== AUTHORIZED_INVOCATION_CONSTRUCTION_SEAL) throw new RalphAdmissionError("B3_AUTHORIZED_INVOCATION_REQUIRED");
    // The sealed M1 capability must remain immutable after it is rehydrated.
    // Otherwise a caller could mutate the visible descriptor/work-unit object
    // and change the binding used by a later executor observation.
    authorizedInvocationInternals.set(this, { descriptor: freezeDeep(descriptor), workUnit: freezeDeep(workUnit) });
  }

  get descriptor(): InvocationDescriptorV2 { return requireAuthorizedInvocationInternals(this).descriptor; }
  get workUnit(): WorkUnitV2 { return requireAuthorizedInvocationInternals(this).workUnit; }

  toJSON(): Readonly<Record<string, unknown>> {
    return { kind: this.kind, descriptor: this.descriptor, workUnit: this.workUnit };
  }
}

export function isAuthorizedInvocationV2(value: unknown): value is AuthorizedInvocationV2 {
  return typeof value === "object" && value !== null && authorizedInvocationInternals.has(value as AuthorizedInvocationV2);
}

export function assertAuthorizedInvocationV2(value: unknown): asserts value is AuthorizedInvocationV2 {
  if (!isAuthorizedInvocationV2(value)) throw new RalphAdmissionError("B3_AUTHORIZED_INVOCATION_REQUIRED");
}

export type PrepareNextAuthorizedInvocationV2Result =
  | {
    readonly kind: "AUTHORIZED_NOT_INVOKED";
    readonly outcome: "AUTHORIZED_NOT_INVOKED";
    readonly state: RalphRuntimeStateV2;
    readonly attempt: AdmittedAttemptV2;
    readonly workUnit: WorkUnitV2;
    readonly invocation: InvocationDescriptorV2;
    readonly authorizedInvocation: AuthorizedInvocationV2;
    readonly leaseReleased: true;
  }
  | {
    readonly kind: "ALREADY_AUTHORIZED";
    readonly outcome: "ALREADY_AUTHORIZED";
    readonly state: RalphRuntimeStateV2;
    readonly attempt: AdmittedAttemptV2;
    readonly workUnit: WorkUnitV2;
    readonly invocation: InvocationDescriptorV2;
    readonly authorizedInvocation: AuthorizedInvocationV2;
    readonly leaseReleased: true;
  }
  | {
    readonly kind: "NO_WORK" | "WAITING" | "BLOCKED" | "HOLD" | "RECONCILIATION_REQUIRED";
    readonly outcome: "NO_WORK" | "WAITING" | "BLOCKED" | "HOLD" | "RECONCILIATION_REQUIRED";
    readonly state: RalphRuntimeStateV2;
    readonly decision: SchedulerDecision;
    readonly leaseReleased: boolean;
  };

type PrepareOptions = Omit<PrepareNextAuthorizedInvocationV2Input, "leasedRun" | "plan">;

export function prepareNextAuthorizedInvocationV2(
  input: PrepareNextAuthorizedInvocationV2Input,
): Promise<PrepareNextAuthorizedInvocationV2Result>;
export function prepareNextAuthorizedInvocationV2(
  leasedRun: LeasedRunV2,
  plan: ExecutionDocument,
  options?: PrepareOptions,
): Promise<PrepareNextAuthorizedInvocationV2Result>;
export async function prepareNextAuthorizedInvocationV2(
  inputOrLeasedRun: PrepareNextAuthorizedInvocationV2Input | LeasedRunV2,
  maybePlan?: ExecutionDocument,
  maybeOptions: PrepareOptions = {},
): Promise<PrepareNextAuthorizedInvocationV2Result> {
  const parsedInput: PrepareNextAuthorizedInvocationV2Input = isLeasedRunInput(inputOrLeasedRun)
    ? { ...maybeOptions, leasedRun: inputOrLeasedRun, plan: maybePlan as ExecutionDocument }
    : inputOrLeasedRun;
  assertLeasedRunV2(parsedInput.leasedRun);
  if (!parsedInput.plan) throw new RalphAdmissionError("B3_PLAN_IDENTITY_MISMATCH", "B3_PLAN_IDENTITY_MISMATCH: plan is required");

  const input: PrepareNextAuthorizedInvocationV2Input = {
    ...parsedInput,
    plan: freezeJsonClone(parsedInput.plan),
  };
  const runSnapshotDigest = sha256Canonical(input.leasedRun.snapshot);

  const clock = input.clock ?? (() => new Date().toISOString());
  const nonceFactory = input.nonceFactory ?? randomUUID;
  const eventIdFactory = input.eventIdFactory ?? randomUUID;
  const attemptIdFactory = input.attemptIdFactory ?? randomUUID;
  const planIdentity = input.planIdentity ?? input.plan.artifactId;
  const computedPlanDigest = sha256Canonical(input.plan);
  if (input.planDigest !== undefined && input.planDigest !== computedPlanDigest) {
    throw new RalphAdmissionError("B3_PLAN_IDENTITY_MISMATCH", "B3_PLAN_IDENTITY_MISMATCH: caller plan digest does not match the plan document");
  }
  const planDigest = computedPlanDigest;

  await refreshAndRepair(input.leasedRun, clock, nonceFactory);
  assertRunSnapshotUnchanged(input.leasedRun, runSnapshotDigest);
  assertPlanIdentity(input.leasedRun, input.plan, planIdentity, planDigest);
  assertCurrentPolicies(input.leasedRun, input.currentPolicyDigests);

  let fingerprint = await observeFingerprint(input);
  let fingerprintDecision = admissionFingerprintDecision(input.leasedRun, fingerprint);
  if (!fingerprintDecision.valid) return await finishDecision(input.leasedRun, fingerprintDecision.decision, true);
  await revalidateLeaseOwnershipV2(input.leasedRun);

  let openAttempt = onlyOpenAttempt(input.leasedRun.state);
  if (openAttempt) {
    return await resumeOpenAttempt(input, openAttempt, planIdentity, planDigest, fingerprint, runSnapshotDigest, clock, nonceFactory);
  }

  let decision = schedule(input.leasedRun.state, input.plan, fingerprint);
  if (decision.kind !== "CANDIDATE") return await finishDecision(input.leasedRun, decision, true);

  // The first candidate is advisory.  If a run-start checkpoint is needed,
  // emit it and then discard/recompute the candidate from the refreshed state.
  if (!hasUsableCheckpoint(input.leasedRun.state, fingerprint.fingerprintDigest)) {
    if (expectedAttemptBaseFingerprint(input.leasedRun.state) !== undefined) {
      return await finishDecision(input.leasedRun, {
        kind: "RECONCILIATION_REQUIRED",
        reason: "CHECKPOINT_FINGERPRINT_MISMATCH",
      }, true);
    }
    await revalidateLeaseOwnershipV2(input.leasedRun);
    const checkpointEvent = coreEvent(input.leasedRun.state, "workspace.checkpointed", {
      checkpoint: {
        kind: "runStartFingerprint",
        fingerprintDigest: fingerprint.fingerprintDigest,
        emittedAt: clock(),
      },
    }, {
      eventId: `checkpoint-${input.leasedRun.runId}-${fingerprint.fingerprintDigest.slice("sha256:".length)}`,
      eventIdFactory,
      clock,
      workspace: true,
    });
    await revalidateLeaseOwnershipV2(input.leasedRun);
    await commitAndRefresh(input.leasedRun, checkpointEvent, clock, nonceFactory);
    await refreshAndRepair(input.leasedRun, clock, nonceFactory);
    assertRunSnapshotUnchanged(input.leasedRun, runSnapshotDigest);
    assertPlanIdentity(input.leasedRun, input.plan, planIdentity, planDigest);
    fingerprint = await observeFingerprint(input);
    fingerprintDecision = admissionFingerprintDecision(input.leasedRun, fingerprint);
    if (!fingerprintDecision.valid) return await finishDecision(input.leasedRun, fingerprintDecision.decision, true);
    await revalidateLeaseOwnershipV2(input.leasedRun);
    decision = schedule(input.leasedRun.state, input.plan, fingerprint);
    if (decision.kind !== "CANDIDATE") return await finishDecision(input.leasedRun, decision, true);
  }

  await revalidateLeaseOwnershipV2(input.leasedRun);
  const selected = decision.candidate;
  const phase = input.plan.phases.find((candidate) => candidate.id === selected.phaseId);
  const task = phase?.tasks.find((candidate) => candidate.id === selected.taskId);
  if (!phase || !task) throw new RalphAdmissionError("B3_PLAN_IDENTITY_MISMATCH", "B3_PLAN_IDENTITY_MISMATCH: scheduler candidate is not in the plan");
  assertTaskAdmissible(input.leasedRun.state, phase, task);

  const taskState = input.leasedRun.state.tasks[task.id];
  if (!taskState) throw new RalphAdmissionError("B3_ATTEMPT_RECONCILIATION_REQUIRED");
  const taskBudget = taskState.executorBudget;
  if (!taskBudget || taskState.attemptsUsed >= taskBudget.limit) {
    return await finishDecision(input.leasedRun, { kind: "NO_WORK", reason: "NEW_ATTEMPT_BUDGET_EXHAUSTED" }, true);
  }
  const attemptId = safeCoreId(attemptIdFactory(), "B3_ATTEMPT_RECONCILIATION_REQUIRED");
  const ordinal = taskState.attemptsUsed + 1;
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) throw new RalphAdmissionError("B3_ATTEMPT_RECONCILIATION_REQUIRED");
  const attemptStartedAt = clock();
  const attemptStarted = coreEvent(input.leasedRun.state, "attempt.started", {
    taskId: task.id,
    attemptId,
    ordinal,
    strategyGeneration: 0,
    attemptBaseFingerprint: fingerprint.fingerprintDigest,
    startedAt: attemptStartedAt,
  }, {
    eventId: `attempt-started-${attemptId}`,
    eventIdFactory,
    clock,
    phaseId: phase.id,
    taskId: task.id,
    attemptId,
  });
  await revalidateLeaseOwnershipV2(input.leasedRun);
  await commitAndRefresh(input.leasedRun, attemptStarted, clock, nonceFactory);
  await refreshAndRepair(input.leasedRun, clock, nonceFactory);
  assertRunSnapshotUnchanged(input.leasedRun, runSnapshotDigest);
  const admittedAttempt = requireCurrentAdmittedAttempt(input.leasedRun, attemptId, phase.id, task.id);
  return authorizeAttempt(input, phase, task, admittedAttempt, planIdentity, planDigest, fingerprint, runSnapshotDigest, clock, nonceFactory, eventIdFactory);
}

async function resumeOpenAttempt(
  input: PrepareNextAuthorizedInvocationV2Input,
  attempt: AttemptStateV2,
  planIdentity: string,
  planDigest: string,
  fingerprint: FingerprintIdentity,
  runSnapshotDigest: string,
  clock: () => string,
  nonceFactory: () => string,
): Promise<PrepareNextAuthorizedInvocationV2Result> {
  const phase = input.plan.phases.find((candidate) => candidate.id === attempt.phaseId);
  const task = phase?.tasks.find((candidate) => candidate.id === attempt.taskId);
  if (!phase || !task) throw new RalphAdmissionError("B3_ATTEMPT_RECONCILIATION_REQUIRED", "B3_ATTEMPT_RECONCILIATION_REQUIRED: open Attempt is outside the plan");
  assertResumableAttempt(input.leasedRun.state, attempt, phase, task);
  if (attempt.attemptBaseFingerprint !== (expectedAttemptBaseFingerprint(input.leasedRun.state) ?? fingerprint.fingerprintDigest)) {
    return await finishDecision(input.leasedRun, { kind: "RECONCILIATION_REQUIRED", reason: "ATTEMPT_BASE_FINGERPRINT_MISMATCH" }, false);
  }
  if (attempt.stage !== "ADMITTED" && attempt.stage !== "EXECUTOR_DISPATCH_AUTHORIZED") {
    return {
      kind: "RECONCILIATION_REQUIRED",
      outcome: "RECONCILIATION_REQUIRED",
      state: input.leasedRun.state,
      decision: { kind: "RECONCILIATION_REQUIRED", reason: "OPEN_ATTEMPT_STAGE_NOT_OWNED_BY_B3" },
      leaseReleased: false,
    };
  }
  return authorizeAttempt(input, phase, task, attempt, planIdentity, planDigest, fingerprint, runSnapshotDigest, clock, nonceFactory, input.eventIdFactory ?? randomUUID);
}

async function authorizeAttempt(
  input: PrepareNextAuthorizedInvocationV2Input,
  phase: Phase,
  task: Task,
  attempt: AttemptStateV2,
  planIdentity: string,
  planDigest: string,
  fingerprint: FingerprintIdentity,
  runSnapshotDigest: string,
  clock: () => string,
  nonceFactory: () => string,
  eventIdFactory: () => string,
): Promise<PrepareNextAuthorizedInvocationV2Result> {
  assertRunSnapshotUnchanged(input.leasedRun, runSnapshotDigest);
  const binding: ArtifactBindingInputV2 = {
    runId: input.leasedRun.runId,
    phase,
    task,
    attempt,
    planIdentity,
    planDigest,
    snapshot: input.leasedRun.snapshot,
  };
  const expectedWorkUnit = createWorkUnitV2(binding);

  if (attempt.stage === "EXECUTOR_DISPATCH_AUTHORIZED") {
    const existing = await loadAndValidateAuthorizedArtifacts(input.leasedRun, binding, expectedWorkUnit);
    await revalidateLeaseOwnershipV2(input.leasedRun);
    const currentFingerprint = await observeFingerprint(input);
    assertDispatchFacts(input.leasedRun, attempt, binding, existing.workUnit, existing.invocation, currentFingerprint);
    await refreshLeasedRunV2(input.leasedRun);
    assertRunSnapshotUnchanged(input.leasedRun, runSnapshotDigest);
    const refreshedAttempt = requireAuthorizedAttempt(input.leasedRun, attempt.attemptId, existing.invocation.invocationId);
    const refreshedBinding: ArtifactBindingInputV2 = { ...binding, attempt: refreshedAttempt };
    const refreshedWorkUnit = createWorkUnitV2(refreshedBinding);
    const verified = await loadAndValidateAuthorizedArtifacts(input.leasedRun, refreshedBinding, refreshedWorkUnit);
    const refreshedFingerprint = await observeFingerprint(input);
    assertDispatchFacts(input.leasedRun, refreshedAttempt, refreshedBinding, verified.workUnit, verified.invocation, refreshedFingerprint);
    const authorizedInvocation = createAuthorizedInvocation(verified.invocation, verified.workUnit);
    await revalidateLeaseOwnershipV2(input.leasedRun);
    const releaseProof = await derivePreExecutorReleaseProofV2(input.leasedRun, {
      attemptId: refreshedAttempt.attemptId,
      invocationId: verified.invocation.invocationId,
      artifactRefs: artifactRefsForAttempt(refreshedAttempt.attemptId, ["work-unit.json", "invocation.json"]),
    });
    await releaseLeasedRunV2(input.leasedRun, { proof: releaseProof });
    return {
      kind: "ALREADY_AUTHORIZED",
      outcome: "ALREADY_AUTHORIZED",
      state: input.leasedRun.state,
      attempt: admittedCapability(input.leasedRun, refreshedAttempt),
      workUnit: verified.workUnit,
      invocation: verified.invocation,
      authorizedInvocation,
      leaseReleased: true,
    };
  }

  if (attempt.stage !== "ADMITTED") throw new RalphAdmissionError("B3_ATTEMPT_RECONCILIATION_REQUIRED");
  await revalidateLeaseOwnershipV2(input.leasedRun);
  let workUnit: WorkUnitV2;
  try {
    workUnit = (await persistWorkUnitV2(input.leasedRun.store, expectedWorkUnit, nonceFactory())).artifact;
  } catch (error) {
    throw artifactError(error);
  }

  await revalidateLeaseOwnershipV2(input.leasedRun);
  const invocation = createInvocationDescriptorV2({ ...binding, workUnit });
  try {
    await revalidateLeaseOwnershipV2(input.leasedRun);
    await persistInvocationDescriptorV2(input.leasedRun.store, invocation, nonceFactory());
  } catch (error) {
    throw artifactError(error);
  }

  await refreshAndRepair(input.leasedRun, clock, nonceFactory);
  assertRunSnapshotUnchanged(input.leasedRun, runSnapshotDigest);
  const refreshedAttempt = requireCurrentAdmittedAttempt(input.leasedRun, attempt.attemptId, phase.id, task.id);
  const refreshedBinding: ArtifactBindingInputV2 = { ...binding, attempt: refreshedAttempt };
  const finalArtifacts = await loadAndValidateAuthorizedArtifacts(input.leasedRun, refreshedBinding, expectedWorkUnit);
  await revalidateLeaseOwnershipV2(input.leasedRun);
  const finalFingerprint = await observeFingerprint(input);
  assertDispatchFacts(input.leasedRun, refreshedAttempt, refreshedBinding, finalArtifacts.workUnit, finalArtifacts.invocation, finalFingerprint);

  // Reopen the authoritative RunSnapshot/state immediately before constructing
  // the dispatch event.  The earlier artifact read is advisory with respect to
  // an immutable snapshot replacement race.
  await refreshAndRepair(input.leasedRun, clock, nonceFactory);
  assertRunSnapshotUnchanged(input.leasedRun, runSnapshotDigest);
  const dispatchAttempt = requireCurrentAdmittedAttempt(input.leasedRun, attempt.attemptId, phase.id, task.id);
  const dispatchBinding: ArtifactBindingInputV2 = { ...binding, attempt: dispatchAttempt };
  const dispatchExpectedWorkUnit = createWorkUnitV2(dispatchBinding);
  const dispatchArtifacts = await loadAndValidateAuthorizedArtifacts(input.leasedRun, dispatchBinding, dispatchExpectedWorkUnit);
  await revalidateLeaseOwnershipV2(input.leasedRun);
  const dispatchFingerprint = await observeFingerprint(input);
  assertDispatchFacts(input.leasedRun, dispatchAttempt, dispatchBinding, dispatchArtifacts.workUnit, dispatchArtifacts.invocation, dispatchFingerprint);

  const dispatch = coreEvent(input.leasedRun.state, "executor.dispatch-authorized", {
    invocationId: dispatchArtifacts.invocation.invocationId,
    workUnitDigest: dispatchArtifacts.invocation.workUnitDigest,
    attemptBaseFingerprint: dispatchArtifacts.invocation.attemptBaseFingerprint,
    timeoutPolicyDigest: dispatchArtifacts.invocation.timeoutPolicyDigest,
    capabilityPolicyDigest: dispatchArtifacts.invocation.capabilityPolicyDigest,
    authorizedAt: dispatchArtifacts.invocation.createdAt,
  }, {
    eventId: `dispatch-authorized-${dispatchArtifacts.invocation.invocationId}`,
    eventIdFactory,
    clock,
    phaseId: phase.id,
    taskId: task.id,
    attemptId: attempt.attemptId,
  });
  await revalidateLeaseOwnershipV2(input.leasedRun);
  await commitAndRefresh(input.leasedRun, dispatch, clock, nonceFactory);
  await refreshAndRepair(input.leasedRun, clock, nonceFactory);
  assertRunSnapshotUnchanged(input.leasedRun, runSnapshotDigest);
  const authorizedAttempt = requireAuthorizedAttempt(input.leasedRun, attempt.attemptId, dispatchArtifacts.invocation.invocationId);
  const authorizedBinding: ArtifactBindingInputV2 = { ...dispatchBinding, attempt: authorizedAttempt };
  const authorizedExpectedWorkUnit = createWorkUnitV2(authorizedBinding);
  const authorizedArtifacts = await loadAndValidateAuthorizedArtifacts(input.leasedRun, authorizedBinding, authorizedExpectedWorkUnit);
  await revalidateLeaseOwnershipV2(input.leasedRun);
  const postDispatchFingerprint = await observeFingerprint(input);
  assertDispatchFacts(input.leasedRun, authorizedAttempt, authorizedBinding, authorizedArtifacts.workUnit, authorizedArtifacts.invocation, postDispatchFingerprint);
  await revalidateLeaseOwnershipV2(input.leasedRun);
  assertRunSnapshotUnchanged(input.leasedRun, runSnapshotDigest);
  const releaseProof = await derivePreExecutorReleaseProofV2(input.leasedRun, {
    attemptId: authorizedAttempt.attemptId,
    invocationId: authorizedArtifacts.invocation.invocationId,
    artifactRefs: artifactRefsForAttempt(authorizedAttempt.attemptId, ["work-unit.json", "invocation.json"]),
  });
  await releaseLeasedRunV2(input.leasedRun, { proof: releaseProof });
  const admitted = admittedCapability(input.leasedRun, authorizedAttempt);
  const authorizedInvocation = createAuthorizedInvocation(authorizedArtifacts.invocation, authorizedArtifacts.workUnit);
  return {
    kind: "AUTHORIZED_NOT_INVOKED",
    outcome: "AUTHORIZED_NOT_INVOKED",
    state: input.leasedRun.state,
    attempt: admitted,
    workUnit: authorizedArtifacts.workUnit,
    invocation: authorizedArtifacts.invocation,
    authorizedInvocation,
    leaseReleased: true,
  };
}

export interface ReopenAuthorizedInvocationV2Input {
  readonly leasedRun: LeasedRunV2;
  readonly plan: ExecutionDocument;
  readonly attemptId?: string;
  readonly planIdentity?: string;
  readonly planDigest?: string;
  /** Defaults to true for the pre-executor dispatch boundary. */
  readonly requireBaseFingerprint?: boolean;
}

export interface ReopenedAuthorizedInvocationV2 {
  readonly kind: "REOPENED_AUTHORIZED_INVOCATION";
  readonly attempt: AttemptStateV2;
  readonly workUnit: WorkUnitV2;
  readonly invocation: InvocationDescriptorV2;
  readonly authorizedInvocation: AuthorizedInvocationV2;
}

/**
 * Rehydrates a durable B3 authorization without re-running scheduling and
 * without releasing the caller's lease.  B4 uses this to cross the executor
 * boundary only after replay and artifact binding have been revalidated.
 */
export async function reopenAuthorizedInvocationV2(input: ReopenAuthorizedInvocationV2Input): Promise<ReopenedAuthorizedInvocationV2> {
  assertLeasedRunV2(input.leasedRun);
  if (!input.plan) throw new RalphAdmissionError("B3_PLAN_IDENTITY_MISMATCH", "B3_PLAN_IDENTITY_MISMATCH: plan is required");
  const initialAttempt = input.attemptId === undefined ? onlyOpenAttempt(input.leasedRun.state) : input.leasedRun.state.attempts[input.attemptId];
  await refreshLeasedRunV2(input.leasedRun);
  const attempt = input.attemptId === undefined ? onlyOpenAttempt(input.leasedRun.state) : input.leasedRun.state.attempts[input.attemptId];
  if (!attempt || attempt.disposition !== "OPEN" || !["EXECUTOR_DISPATCH_AUTHORIZED", "EXECUTOR_RUNNING", "POST_EXECUTOR_CAPTURE", "EVIDENCE_CAPTURING", "RECONCILING"].includes(attempt.stage)) {
    throw new RalphAdmissionError("B3_AUTHORIZED_INVOCATION_REQUIRED", "B3_AUTHORIZED_INVOCATION_REQUIRED: durable dispatch authorization is required");
  }
  const phase = input.plan.phases.find((candidate) => candidate.id === attempt.phaseId);
  const task = phase?.tasks.find((candidate) => candidate.id === attempt.taskId);
  if (!phase || !task) throw new RalphAdmissionError("B3_ATTEMPT_RECONCILIATION_REQUIRED");
  const planIdentity = input.planIdentity ?? input.plan.artifactId;
  const planDigest = sha256Canonical(input.plan);
  if (input.planDigest !== undefined && input.planDigest !== planDigest) throw new RalphAdmissionError("B3_PLAN_IDENTITY_MISMATCH");
  assertPlanIdentity(input.leasedRun, input.plan, planIdentity, planDigest);
  const binding: ArtifactBindingInputV2 = {
    runId: input.leasedRun.runId,
    phase,
    task,
    attempt,
    planIdentity,
    planDigest,
    snapshot: input.leasedRun.snapshot,
  };
  const expectedWorkUnit = createWorkUnitV2(binding);
  const artifacts = await loadAndValidateAuthorizedArtifacts(input.leasedRun, binding, expectedWorkUnit);
  if (input.requireBaseFingerprint !== false && attempt.stage === "EXECUTOR_DISPATCH_AUTHORIZED") {
    const currentFingerprint = await fingerprintWorkspace(
      input.leasedRun.projectRoot,
      input.leasedRun.snapshot.workspacePolicy,
      undefined,
      input.leasedRun.workspaceFingerprintFileSystem,
    );
    if (currentFingerprint.fingerprintDigest !== attempt.attemptBaseFingerprint) throw new RalphAdmissionError("B3_WORKSPACE_RECONCILIATION_REQUIRED");
  }
  await revalidateLeaseOwnershipV2(input.leasedRun);
  return {
    kind: "REOPENED_AUTHORIZED_INVOCATION",
    attempt,
    workUnit: artifacts.workUnit,
    invocation: artifacts.invocation,
    authorizedInvocation: createAuthorizedInvocation(artifacts.invocation, artifacts.workUnit),
  };
}

async function loadAndValidateAuthorizedArtifacts(
  leasedRun: LeasedRunV2,
  binding: ArtifactBindingInputV2,
  expectedWorkUnit: WorkUnitV2,
): Promise<{ readonly workUnit: WorkUnitV2; readonly invocation: InvocationDescriptorV2 }> {
  let workUnit: WorkUnitV2 | undefined;
  let invocation: InvocationDescriptorV2 | undefined;
  try {
    workUnit = await readWorkUnitV2(leasedRun.store, binding.attempt.attemptId);
    invocation = await readInvocationDescriptorV2(leasedRun.store, binding.attempt.attemptId);
  } catch (error) {
    throw artifactError(error);
  }
  if (!workUnit || !invocation) throw new RalphAdmissionError("B3_ARTIFACT_RECONCILIATION_REQUIRED", "B3_ARTIFACT_RECONCILIATION_REQUIRED: authorized artifacts are incomplete");
  if (canonicalJson(workUnit) !== canonicalJson(expectedWorkUnit)) throw new RalphAdmissionError("B3_ARTIFACT_RECONCILIATION_REQUIRED", "B3_ARTIFACT_RECONCILIATION_REQUIRED: WorkUnit binding conflict");
  const expectedInvocation = createInvocationDescriptorV2({ ...binding, workUnit: expectedWorkUnit });
  if (canonicalJson(invocation) !== canonicalJson(expectedInvocation)) throw new RalphAdmissionError("B3_ARTIFACT_RECONCILIATION_REQUIRED", "B3_ARTIFACT_RECONCILIATION_REQUIRED: invocation binding conflict");
  return { workUnit, invocation };
}

function assertPlanIdentity(leasedRun: LeasedRunV2, plan: ExecutionDocument, planIdentity: string, planDigest: string): void {
  if (planIdentity !== leasedRun.snapshot.readyPlanIdentity || planDigest !== leasedRun.snapshot.readyPlanHash || plan.artifactId !== planIdentity) {
    throw new RalphAdmissionError("B3_PLAN_IDENTITY_MISMATCH", "B3_PLAN_IDENTITY_MISMATCH: current plan is not the captured Ready plan");
  }
}

function assertRunSnapshotUnchanged(leasedRun: LeasedRunV2, expectedDigest: string): void {
  if (sha256Canonical(leasedRun.snapshot) !== expectedDigest) {
    throw new RalphAdmissionError("B3_PLAN_IDENTITY_MISMATCH", "B3_PLAN_IDENTITY_MISMATCH: RunSnapshot changed during authorization");
  }
}

function assertCurrentPolicies(leasedRun: LeasedRunV2, facts: PrepareNextAuthorizedInvocationV2Input["currentPolicyDigests"]): void {
  if (!facts) return;
  const expected = {
    effectiveConfigDigest: leasedRun.snapshot.effectiveConfigDigest,
    executorProfileDigest: leasedRun.snapshot.executorProfile.descriptorDigest,
    permissionCapabilityPolicyDigest: leasedRun.snapshot.permissionCapabilityPolicy.descriptorDigest,
    timeoutPolicyDigest: leasedRun.snapshot.timeoutPolicy.descriptorDigest,
  };
  for (const key of Object.keys(facts) as (keyof typeof expected)[]) {
    if (facts[key] !== undefined && facts[key] !== expected[key]) throw new RalphAdmissionError("B3_PLAN_IDENTITY_MISMATCH", `B3_PLAN_IDENTITY_MISMATCH: policy ${key} changed`);
  }
}

async function observeFingerprint(input: PrepareNextAuthorizedInvocationV2Input): Promise<FingerprintIdentity> {
  const observed = await fingerprintWorkspace(
    input.leasedRun.projectRoot,
    input.leasedRun.snapshot.workspacePolicy,
    undefined,
    input.workspaceFingerprintFileSystem ?? input.leasedRun.workspaceFingerprintFileSystem,
  );
  const identity: FingerprintIdentity = {
    controlPlaneFingerprint: observed.controlPlaneFingerprint,
    productWorkspaceFingerprint: observed.productWorkspaceFingerprint,
    policyDigest: observed.policyDigest,
    fingerprintDigest: observed.fingerprintDigest,
  };
  if (input.currentWorkspaceFingerprint && canonicalJson(input.currentWorkspaceFingerprint) !== canonicalJson(identity)) {
    throw new RalphAdmissionError("B3_WORKSPACE_RECONCILIATION_REQUIRED", "B3_WORKSPACE_RECONCILIATION_REQUIRED: caller observation differs from recomputation");
  }
  return identity;
}

function admissionFingerprintDecision(leasedRun: LeasedRunV2, observed: FingerprintIdentity): { readonly valid: boolean; readonly decision: SchedulerDecision } {
  if (observed.policyDigest !== leasedRun.snapshot.workspacePolicy.policyDigest) {
    return { valid: false, decision: { kind: "RECONCILIATION_REQUIRED", reason: "WORKSPACE_POLICY_MISMATCH" } };
  }
  if (observed.controlPlaneFingerprint !== leasedRun.snapshot.initialWorkspaceFingerprint.controlPlaneFingerprint) {
    return { valid: false, decision: { kind: "RECONCILIATION_REQUIRED", reason: "CONTROL_PLANE_DRIFT" } };
  }
  const expected = expectedAttemptBaseFingerprint(leasedRun.state) ?? leasedRun.snapshot.initialWorkspaceFingerprint.fingerprintDigest;
  if (observed.fingerprintDigest !== expected) {
    return { valid: false, decision: { kind: "RECONCILIATION_REQUIRED", reason: "WORKSPACE_DRIFT_REQUIRES_RECONCILIATION" } };
  }
  return { valid: true, decision: { kind: "NO_WORK", reason: "FINGERPRINT_VALID" } };
}

function hasUsableCheckpoint(state: RalphRuntimeStateV2, fingerprintDigest: string): boolean {
  return (state.checkpoints.acceptedCheckpointFingerprint?.fingerprintDigest === fingerprintDigest)
    || (state.checkpoints.runStartFingerprint?.fingerprintDigest === fingerprintDigest);
}

function schedule(state: RalphRuntimeStateV2, plan: ExecutionDocument, fingerprint: FingerprintIdentity): SchedulerDecision {
  return scheduleNextTask({
    plan,
    state,
    runtimeIntegrityFacts: { valid: true, controlPlaneValid: true, admissionValid: true },
    fingerprintComparison: { valid: true, checkpointValid: true, expectedFingerprint: fingerprint.fingerprintDigest, observedFingerprint: fingerprint.fingerprintDigest },
  });
}

function assertTaskAdmissible(state: RalphRuntimeStateV2, phase: Phase, task: Task): void {
  const taskState = state.tasks[task.id];
  const phaseState = state.phases[phase.id];
  if (!taskState || !phaseState || taskState.phaseId !== phase.id || !phaseState.taskIds.includes(task.id)) throw new RalphAdmissionError("B3_ATTEMPT_RECONCILIATION_REQUIRED");
  if (taskState.disposition !== "READY" || taskState.activity !== "IDLE" || taskState.owner !== "NONE" || taskState.hold !== "NONE") throw new RalphAdmissionError("B3_ATTEMPT_RECONCILIATION_REQUIRED", "B3_ATTEMPT_RECONCILIATION_REQUIRED: Task changed after scheduling");
  if (task.dependsOn.some((dependencyId) => state.tasks[dependencyId]?.disposition !== "COMPLETE")) throw new RalphAdmissionError("B3_ATTEMPT_RECONCILIATION_REQUIRED", "B3_ATTEMPT_RECONCILIATION_REQUIRED: Task dependency changed");
}

function assertResumableAttempt(state: RalphRuntimeStateV2, attempt: AttemptStateV2, phase: Phase, task: Task): void {
  const taskState = state.tasks[task.id];
  const phaseState = state.phases[phase.id];
  if (!taskState || !phaseState || taskState.phaseId !== phase.id || !phaseState.taskIds.includes(task.id)) {
    throw new RalphAdmissionError("B3_ATTEMPT_RECONCILIATION_REQUIRED");
  }
  if (taskState.currentAttemptId !== attempt.attemptId || taskState.disposition !== "READY" || taskState.hold !== "NONE") {
    throw new RalphAdmissionError("B3_ATTEMPT_RECONCILIATION_REQUIRED", "B3_ATTEMPT_RECONCILIATION_REQUIRED: open Attempt projection changed");
  }
  if (task.dependsOn.some((dependencyId) => state.tasks[dependencyId]?.disposition !== "COMPLETE")) {
    throw new RalphAdmissionError("B3_ATTEMPT_RECONCILIATION_REQUIRED", "B3_ATTEMPT_RECONCILIATION_REQUIRED: open Attempt dependency changed");
  }
}

function onlyOpenAttempt(state: RalphRuntimeStateV2): AttemptStateV2 | undefined {
  const attempts = openAttemptsV2(state);
  return attempts.length === 1 ? attempts[0] : undefined;
}

function requireCurrentAdmittedAttempt(stateful: LeasedRunV2, attemptId: string, phaseId: string, taskId: string): AttemptStateV2 {
  const attempt = stateful.state.attempts[attemptId];
  if (!attempt || attempt.disposition !== "OPEN" || attempt.stage !== "ADMITTED" || attempt.phaseId !== phaseId || attempt.taskId !== taskId) {
    throw new RalphAdmissionError("B3_ATTEMPT_RECONCILIATION_REQUIRED", "B3_ATTEMPT_RECONCILIATION_REQUIRED: attempt admission was not replayed as ADMITTED");
  }
  return attempt;
}

function requireAuthorizedAttempt(stateful: LeasedRunV2, attemptId: string, invocationId: string): AttemptStateV2 {
  const attempt = stateful.state.attempts[attemptId];
  if (!attempt || attempt.disposition !== "OPEN" || attempt.stage !== "EXECUTOR_DISPATCH_AUTHORIZED" || attempt.invocation?.invocationId !== invocationId) {
    throw new RalphAdmissionError("B3_DISPATCH_BINDING_INVALID", "B3_DISPATCH_BINDING_INVALID: reducer did not project authorization");
  }
  return attempt;
}

function admittedCapability(stateful: LeasedRunV2, attempt: AttemptStateV2): AdmittedAttemptV2 {
  return Object.freeze({ kind: "ADMITTED_ATTEMPT", attempt: Object.freeze(attempt), runId: stateful.runId, phaseId: attempt.phaseId, taskId: attempt.taskId });
}

function assertDispatchFacts(
  stateful: LeasedRunV2,
  attempt: AttemptStateV2,
  binding: ArtifactBindingInputV2,
  workUnit: WorkUnitV2,
  invocation: InvocationDescriptorV2,
  fingerprint: FingerprintIdentity,
): void {
  if (binding.runId !== stateful.runId || binding.phase.id !== attempt.phaseId || binding.task.id !== attempt.taskId || binding.attempt.attemptId !== attempt.attemptId) {
    throw new RalphAdmissionError("B3_DISPATCH_BINDING_INVALID");
  }
  let expectedWorkUnit: WorkUnitV2;
  let expectedInvocation: InvocationDescriptorV2;
  try {
    expectedWorkUnit = createWorkUnitV2(binding);
    expectedInvocation = createInvocationDescriptorV2({ ...binding, workUnit: expectedWorkUnit });
  } catch (error) {
    throw new RalphAdmissionError("B3_DISPATCH_BINDING_INVALID", "B3_DISPATCH_BINDING_INVALID: expected authorization binding is invalid", error);
  }
  if (canonicalJson(workUnit) !== canonicalJson(expectedWorkUnit)) {
    throw new RalphAdmissionError("B3_DISPATCH_BINDING_INVALID", "B3_DISPATCH_BINDING_INVALID: WorkUnit binding mismatch");
  }
  if (canonicalJson(invocation) !== canonicalJson(expectedInvocation)) {
    throw new RalphAdmissionError("B3_DISPATCH_BINDING_INVALID");
  }
  if (attempt.invocation && (
    attempt.invocation.invocationId !== invocation.invocationId
    || attempt.invocation.workUnitDigest !== invocation.workUnitDigest
    || attempt.invocation.attemptBaseFingerprint !== invocation.attemptBaseFingerprint
    || attempt.invocation.timeoutPolicyDigest !== invocation.timeoutPolicyDigest
    || attempt.invocation.capabilityPolicyDigest !== invocation.capabilityPolicyDigest
  )) throw new RalphAdmissionError("B3_DISPATCH_BINDING_INVALID");
  if (fingerprint.fingerprintDigest !== attempt.attemptBaseFingerprint) throw new RalphAdmissionError("B3_WORKSPACE_RECONCILIATION_REQUIRED", "B3_WORKSPACE_RECONCILIATION_REQUIRED: base fingerprint changed");
}

async function refreshAndRepair(
  leasedRun: LeasedRunV2,
  clock: () => string,
  nonceFactory: () => string,
): Promise<void> {
  await refreshLeasedRunV2(leasedRun);
  await repairStateSnapshotWhileLeasedV2(leasedRun, { writtenAt: clock(), nonce: nonceFactory() });
}

async function commitAndRefresh(
  leasedRun: LeasedRunV2,
  event: RalphEventV2,
  clock: () => string,
  nonceFactory: () => string,
): Promise<void> {
  await revalidateLeaseOwnershipV2(leasedRun);
  try {
    await commitRalphEventV2({
      store: leasedRun.store,
      state: leasedRun.state,
      event,
      writtenAt: clock(),
      nonce: nonceFactory(),
    });
  } catch (error) {
    if (hasUnknownDurability(error)) throw error;
    throw error;
  }
  await refreshLeasedRunV2(leasedRun);
}

async function finishDecision(
  leasedRun: LeasedRunV2,
  decision: SchedulerDecision,
  release: boolean,
): Promise<PrepareNextAuthorizedInvocationV2Result> {
  if (release) await releaseLeasedRunV2(leasedRun);
  const normalizedDecision: Exclude<SchedulerDecision, { readonly kind: "CANDIDATE" }> = decision.kind === "CANDIDATE"
    ? { kind: "RECONCILIATION_REQUIRED", reason: "CANDIDATE_NOT_A_TERMINAL_DECISION" }
    : decision;
  const kind = normalizedDecision.kind;
  return {
    kind,
    outcome: kind,
    state: leasedRun.state,
    decision: normalizedDecision,
    leaseReleased: release,
  };
}

function coreEvent<TType extends RalphEventTypeV2>(
  state: RalphRuntimeStateV2,
  eventType: TType,
  payload: EventPayloadMapV2[TType],
  context: {
    readonly eventId: string;
    readonly eventIdFactory: () => string;
    readonly clock: () => string;
    readonly phaseId?: string;
    readonly taskId?: string;
    readonly attemptId?: string;
    readonly workspace?: boolean;
  },
) {
  const occurredAt = context.clock();
  const eventId = context.eventId || context.eventIdFactory();
  const entity = context.workspace
    ? { kind: "workspace" as const, id: `${state.runId}:workspace` }
    : { kind: "attempt" as const, id: context.attemptId ?? (context.taskId ?? state.runId) };
  return createRalphEventV2({
    eventId,
    eventType,
    schemaVersion: "rb-ralph-event/v2",
    runId: state.runId,
    sequence: state.lastSequence + 1,
    occurredAt,
    recordedAt: occurredAt,
    entity,
    ...(context.workspace ? {} : { phaseId: context.phaseId, taskId: context.taskId, attemptId: context.attemptId }),
    actor: "CORE",
    causationId: null,
    correlationId: `${state.runId}:${context.attemptId ?? "run"}`,
    payload,
    previousEventHash: state.lastEventHash,
  } as UnsignedRalphEventV2<TType>);
}

function isLeasedRunInput(value: PrepareNextAuthorizedInvocationV2Input | LeasedRunV2): value is LeasedRunV2 {
  return typeof value === "object" && value !== null && "kind" in value && (value as { readonly kind?: unknown }).kind === "LeasedRunV2";
}

function requireAuthorizedInvocationInternals(value: AuthorizedInvocationV2): {
  readonly descriptor: InvocationDescriptorV2;
  readonly workUnit: WorkUnitV2;
} {
  const internal = authorizedInvocationInternals.get(value);
  if (!internal) throw new RalphAdmissionError("B3_AUTHORIZED_INVOCATION_REQUIRED");
  return internal;
}

function createAuthorizedInvocation(descriptor: InvocationDescriptorV2, workUnit: WorkUnitV2): AuthorizedInvocationV2 {
  return new AuthorizedInvocationV2(descriptor, workUnit, AUTHORIZED_INVOCATION_CONSTRUCTION_SEAL);
}

function artifactRefsForAttempt(attemptId: string, names: readonly string[]): readonly string[] {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(attemptId) || names.some((name) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name))) {
    throw new RalphAdmissionError("B3_ARTIFACT_RECONCILIATION_REQUIRED", "B3_ARTIFACT_RECONCILIATION_REQUIRED: unsafe artifact reference");
  }
  return names.map((name) => `attempts/${attemptId}/${name}`);
}

function freezeJsonClone<T>(value: T): T {
  const clone = JSON.parse(canonicalJson(value)) as T;
  return freezeDeep(clone);
}

function freezeDeep<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  return value;
}

function safeCoreId(value: string, code: AdmissionErrorCode): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new RalphAdmissionError(code, `${code}: Core identity is unsafe`);
  return value;
}

function artifactError(error: unknown): Error {
  if (error instanceof RalphArtifactError) return error;
  if (hasUnknownDurability(error)) return error instanceof Error ? error : new RalphAdmissionError("B3_DURABILITY_UNKNOWN_REQUIRES_INSPECTION");
  return error instanceof Error ? error : new RalphAdmissionError("B3_ARTIFACT_RECONCILIATION_REQUIRED", "B3_ARTIFACT_RECONCILIATION_REQUIRED", error);
}

function hasUnknownDurability(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && typeof (error as { readonly code?: unknown }).code === "string" && String((error as { readonly code: string }).code).includes("UNKNOWN_REQUIRES_INSPECTION"));
}
