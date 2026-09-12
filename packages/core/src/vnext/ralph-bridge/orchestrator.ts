import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadProgressiveExecutionAuthority, inspectExactProgressiveReadiness, RalphBridgeAuthorityError, type ProgressiveExecutionAuthorityV1 } from "./plan-authority.js";
import {
  commitRunTerminalEvent,
  genesisFor,
  initializeBridgeRunV1,
  listBridgeRunDescriptors,
  RALPH_BRIDGE_DEFAULT_TIMEOUT_MS_V1,
  type RalphBridgeRunDescriptorV1,
} from "./genesis.js";
import { continueBridgeTaskV1, type BridgeRuntimeFactoriesV1 } from "./operational-loop.js";
import {
  createIsolatedRalphWorkspace,
  inspectHostPublicationOutcome,
  persistRejectedPublication,
  publishAcceptedTaskDelta,
  snapshotHostImplementation,
  snapshotRalphWorkspace,
  RalphBridgeWorkspaceError,
  type BridgeWorkspaceSnapshotV1,
} from "./workspace-publication.js";
import { validateManifestTree } from "../../manifest.js";
import { sha256Canonical } from "../ralph-runtime/hashing.js";
import { RalphEventStoreV2, inspectOperationalRunV2 } from "../ralph-runtime/operational-b1/index.js";
import { readWorkUnitV2 } from "../ralph-runtime/operational-b3/index.js";
import { readWorkspaceBeforeManifestV2, type WorkspaceManifestV2 } from "../ralph-runtime/operational-b4/workspace-manifest.js";
import {
  createHumanValidationRequestV2,
  createOperatorHumanValidationAuthorityV2,
  humanValidationRequestRefV2,
  readValidationRunV2,
  readHumanValidationDecisionV2,
  type HumanValidationDecisionValueV2,
  type HumanValidationRequestV2,
  type TrustedHumanValidationAuthorityV2,
  type ValidationProcessPolicyV2,
  type ValidationProcessSupervisorV2Like,
} from "../ralph-runtime/operational-d/index.js";
import {
  codexFinalizationDiagnosticRefV2,
  createCodexCliExecutorV2,
  createM5BTimeoutPolicyV2,
  readCodexFinalizationDiagnosticV2,
  type M5BTimeoutPolicyV2,
} from "../ralph-runtime/operational-m5b/index.js";
import { createCodexCliAuditorV2 } from "../ralph-runtime/operational-m5d/index.js";
import type { AttemptStateV2, RalphRuntimeStateV2 } from "../ralph-runtime/operational-v2/index.js";
import { acquireLeasedRunV2, releaseLeasedRunV2, type LeaseRuntimeInputV2 } from "../ralph-runtime/operational-b2/index.js";

export const RALPH_BRIDGE_RESULT_STATUSES_V1 = ["COMPLETE", "FAILED", "BLOCKED", "NEEDS_HUMAN", "INCOMPLETE_RESUMABLE"] as const;
export type RalphBridgeResultStatusV1 = typeof RALPH_BRIDGE_RESULT_STATUSES_V1[number];

export interface RalphBridgeResultV1 {
  readonly schema: "rb-ralph-bridge-result/v1";
  readonly runId: string;
  readonly planId: string;
  readonly planPath: string;
  readonly planSha256: string;
  readonly semanticExecutionIdentity: string;
  readonly status: RalphBridgeResultStatusV1;
  readonly completedTaskCount: number;
  readonly remainingTaskCount: number;
  readonly publicationOccurred: boolean;
  readonly runPath: string;
  readonly errorCode?: string;
  readonly guidance?: string;
  readonly pendingHuman?: RalphBridgePendingHumanV1;
}

export interface RalphBridgePendingHumanV1 {
  readonly phaseId: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly validationSpecId: string;
  readonly instruction: string;
  readonly humanRequestRef: string;
  readonly continuationPass: string;
  readonly continuationFail: string;
}

export interface RalphBridgeInvocationV1 {
  readonly humanDecision?: HumanValidationDecisionValueV2;
}

export interface RalphBridgeRuntimeHooksV1 {
  /** Nominal frozen fakes are injected only by deterministic tests. */
  readonly runtimes?: BridgeRuntimeFactoriesV1;
  readonly validationProcessSupervisor?: ValidationProcessSupervisorV2Like;
  readonly validationProcessPolicy?: ValidationProcessPolicyV2;
  readonly clock?: () => string;
  readonly nonceFactory?: () => string;
  readonly eventIdFactory?: () => string;
  readonly attemptIdFactory?: () => string;
  readonly runIdFactory?: (authority: ProgressiveExecutionAuthorityV1) => string;
  readonly afterWorkspaceCreated?: (workspaceRoot: string) => void | Promise<void>;
  readonly beforePublication?: (taskId: string, workspaceRoot: string) => void | Promise<void>;
  /** Test-only crash boundary. No executor or auditor is called. */
  readonly stopAfterInitialization?: boolean;
  /** Test-only crash boundary after durable audit acceptance, before host publication. */
  readonly stopAfterAcceptedTask?: boolean;
}

/** Public V1 front-door orchestration. It never accepts request or PHASES text. */
export async function runProgressiveRalphBridgeV1(
  projectRoot: string,
  hooks: RalphBridgeRuntimeHooksV1 = {},
  invocation: RalphBridgeInvocationV1 = {},
): Promise<RalphBridgeResultV1> {
  const root = resolve(projectRoot);
  let authority: ProgressiveExecutionAuthorityV1;
  try { authority = await loadProgressiveExecutionAuthority(root); }
  catch (error) { return preflightFailure(error); }

  let existing: RalphBridgeRunDescriptorV1 | undefined;
  try {
    existing = (await listBridgeRunDescriptors(root))
      .filter((descriptor) => descriptor.semanticExecutionIdentity === authority.semanticExecutionIdentity)
      .at(-1);
  } catch (error) {
    return authorityFailure(authority, error);
  }
  if (existing) return existingRunResult(root, authority, existing, hooks, invocation);
  if (invocation.humanDecision) {
    return authorityFailure(authority, new Error("RALPH_BRIDGE_HUMAN_CONTINUATION_RUN_REQUIRED"));
  }

  const allOwnedPaths = Object.values(authority.ownedPathsByTask).flat();
  let hostBaseline: BridgeWorkspaceSnapshotV1;
  try { hostBaseline = await snapshotHostImplementation(root, allOwnedPaths); }
  catch (error) { return authorityFailure(authority, error); }
  const runId = hooks.runIdFactory?.(authority) ?? createRunId(authority);
  const bridgeRoot = resolve(root, ".rb-harness", "ralph", "bridge-runs", runId);
  const workspaceRoot = resolve(bridgeRoot, "workspace");
  try {
    await createIsolatedRalphWorkspace(root, workspaceRoot, hostBaseline);
    await hooks.afterWorkspaceCreated?.(workspaceRoot);
  } catch (error) {
    return authorityFailure(authority, error, runId, bridgeRoot);
  }

  let initialized: Awaited<ReturnType<typeof initializeBridgeRunV1>>;
  try {
    initialized = await initializeBridgeRunV1({
      authority,
      workspaceRoot,
      hostBaseline,
      runId,
      ...(hooks.clock ? { createdAt: hooks.clock() } : {}),
      ...(hooks.nonceFactory ? { nonceFactory: hooks.nonceFactory } : {}),
      ...(hooks.eventIdFactory ? { eventIdFactory: hooks.eventIdFactory } : {}),
    });
  } catch (error) {
    return authorityFailure(authority, error, runId, bridgeRoot, "INCOMPLETE_RESUMABLE");
  }
  if (hooks.stopAfterInitialization) {
    return resultFromState(authority, initialized.descriptor, initialized.state, "INCOMPLETE_RESUMABLE", false, "RALPH_BRIDGE_INTERRUPTED_AFTER_INITIALIZATION", "Re-run the same command after inspecting the durable run; V1 will not create a duplicate run.");
  }

  return driveBridgeRun({
    root,
    authority,
    descriptor: initialized.descriptor,
    store: initialized.store,
    lease: initialized.lease,
    timeoutPolicy: initialized.timeoutPolicy,
    state: initialized.state,
    hostBaseline,
    workspaceBaseline: await snapshotRalphWorkspace(workspaceRoot, allOwnedPaths),
    publicationOccurred: false,
    runtimes: hooks.runtimes ?? realCodexFactories(bridgeRoot),
    hooks,
  });
}

interface DriveBridgeRunV1Input {
  readonly root: string;
  readonly authority: ProgressiveExecutionAuthorityV1;
  readonly descriptor: RalphBridgeRunDescriptorV1;
  readonly store: RalphEventStoreV2;
  readonly lease: LeaseRuntimeInputV2;
  readonly timeoutPolicy: M5BTimeoutPolicyV2;
  readonly state: RalphRuntimeStateV2;
  readonly hostBaseline: BridgeWorkspaceSnapshotV1;
  readonly workspaceBaseline: BridgeWorkspaceSnapshotV1;
  readonly publicationOccurred: boolean;
  readonly runtimes: BridgeRuntimeFactoriesV1;
  readonly hooks: RalphBridgeRuntimeHooksV1;
  readonly humanAuthority?: TrustedHumanValidationAuthorityV2;
}

async function driveBridgeRun(input: DriveBridgeRunV1Input): Promise<RalphBridgeResultV1> {
  const { root, authority, descriptor, store, lease, timeoutPolicy, runtimes, hooks } = input;
  const workspaceRoot = descriptor.workspaceRoot;
  const runId = descriptor.runId;
  const allOwnedPaths = Object.values(authority.ownedPathsByTask).flat();
  let state = input.state;
  let hostBaseline = input.hostBaseline;
  let workspaceBaseline = input.workspaceBaseline;
  let publicationOccurred = input.publicationOccurred;
  let humanAuthority = input.humanAuthority;
  const taskCount = authority.operationalPlan.phases.flatMap((phase) => phase.tasks).length;

  for (let taskOrdinal = 0; taskOrdinal <= taskCount; taskOrdinal += 1) {
    const unpublished = await acceptedUnpublishedAttempt(store, state);
    if (unpublished) {
      if (hooks.stopAfterAcceptedTask) {
        return resultFromState(authority, descriptor, state, "INCOMPLETE_RESUMABLE", publicationOccurred,
          "RALPH_BRIDGE_INTERRUPTED_AFTER_AUDIT", "Re-run the same command to publish the already-audited task; Executor and Auditor will not be repeated.");
      }
      const publication = await publishAcceptedBridgeAttempt({
        root, authority, descriptor, store, lease, state, attempt: unpublished,
        hostBaseline, workspaceBaseline, publicationOccurred, hooks,
      });
      if ("result" in publication) return publication.result;
      state = publication.state;
      hostBaseline = publication.hostBaseline;
      workspaceBaseline = publication.workspaceBaseline;
      publicationOccurred = publication.publicationOccurred;
    }

    if (state.taskIds.every((taskId) => state.tasks[taskId]?.disposition === "COMPLETE")) {
      if (state.disposition !== "COMPLETE") state = await commitTerminalWhileLeased(lease, "COMPLETE", hooks);
      return resultFromState(authority, descriptor, state, "COMPLETE", publicationOccurred);
    }

    let lifecycle;
    try {
      lifecycle = await continueBridgeTaskV1({
        lease,
        store,
        plan: authority.operationalPlan,
        planIdentity: authority.selectedPlan.id,
        planDigest: authority.operationalPlanDigest,
        timeoutPolicy,
        runtimes,
        ...(humanAuthority ? { humanAuthority } : {}),
        ...(hooks.validationProcessSupervisor ? { validationProcessSupervisor: hooks.validationProcessSupervisor } : {}),
        ...(hooks.validationProcessPolicy ? { validationProcessPolicy: hooks.validationProcessPolicy } : {}),
        ...(hooks.clock ? { clock: hooks.clock } : {}),
        ...(hooks.nonceFactory ? { nonceFactory: hooks.nonceFactory } : {}),
        ...(hooks.eventIdFactory ? { eventIdFactory: hooks.eventIdFactory } : {}),
        ...(hooks.attemptIdFactory ? { attemptIdFactory: hooks.attemptIdFactory } : {}),
      });
      humanAuthority = undefined;
    } catch (error) {
      return resultFromState(authority, descriptor, state, "INCOMPLETE_RESUMABLE", publicationOccurred, errorCode(error), "Inspect the durable run and re-run the same command; no second run will be created.");
    }
    state = lifecycle.state;
    if (lifecycle.kind === "HUMAN_REQUIRED") {
      let pending: DiscoveredPendingHumanV1;
      try { pending = await discoverPendingHuman(store, state, root); }
      catch (error) { return resultFromState(authority, descriptor, state, "BLOCKED", publicationOccurred, errorCode(error)); }
      return humanRequiredResult(root, authority, descriptor, state, publicationOccurred, pending);
    }
    if (lifecycle.kind !== "TASK_COMPLETE" || !lifecycle.attempt || lifecycle.audit?.kind !== "AUDIT_ACCEPTED") {
      if (!hasOpenAttempt(state) && state.disposition === "ACTIVE") {
        state = await commitTerminalWhileLeased(lease, "FAILED", hooks, `RALPH_BRIDGE_${lifecycle.kind}`);
        return resultFromState(authority, descriptor, state, "FAILED", publicationOccurred, `RALPH_BRIDGE_${lifecycle.kind}`);
      }
      const guidance = lifecycle.kind === "RECONCILIATION_REQUIRED"
        ? await finalizationDiagnosticGuidanceV1(store, state, lifecycle.attempt?.attemptId)
        : undefined;
      return resultFromState(
        authority,
        descriptor,
        state,
        "BLOCKED",
        publicationOccurred,
        `RALPH_BRIDGE_${lifecycle.kind}`,
        guidance ?? "Inspect the preserved durable evidence and workspace before recovery.",
      );
    }
  }
  return resultFromState(authority, descriptor, state, "BLOCKED", publicationOccurred, "RALPH_BRIDGE_DRIVER_SAFETY_LIMIT");
}

async function finalizationDiagnosticGuidanceV1(
  store: RalphEventStoreV2,
  state: RalphRuntimeStateV2,
  attemptId?: string,
): Promise<string | undefined> {
  if (state.hold !== "RECONCILIATION_REQUIRED") return undefined;
  const candidates = Object.values(state.attempts).filter((attempt) =>
    attempt.disposition === "OPEN" && attempt.stage === "RECONCILING" && (attemptId === undefined || attempt.attemptId === attemptId));
  if (candidates.length !== 1) return undefined;
  const attempt = candidates[0]!;
  const diagnostic = await readCodexFinalizationDiagnosticV2(store, attempt.attemptId).catch(() => undefined);
  if (!diagnostic
    || diagnostic.runId !== state.runId
    || diagnostic.phaseId !== attempt.phaseId
    || diagnostic.taskId !== attempt.taskId
    || diagnostic.attemptId !== attempt.attemptId
    || diagnostic.invocationId !== attempt.invocation?.invocationId) return undefined;
  return `M5-B host finalization failed: stage=${diagnostic.stage} code=${diagnostic.m5bCode} diagnostic=${codexFinalizationDiagnosticRefV2(diagnostic.attemptId)}. Inspect preserved evidence; do not redispatch.`;
}

async function publishAcceptedBridgeAttempt(input: {
  readonly root: string;
  readonly authority: ProgressiveExecutionAuthorityV1;
  readonly descriptor: RalphBridgeRunDescriptorV1;
  readonly store: RalphEventStoreV2;
  readonly lease: LeaseRuntimeInputV2;
  readonly state: RalphRuntimeStateV2;
  readonly attempt: AttemptStateV2;
  readonly hostBaseline: BridgeWorkspaceSnapshotV1;
  readonly workspaceBaseline: BridgeWorkspaceSnapshotV1;
  readonly publicationOccurred: boolean;
  readonly hooks: RalphBridgeRuntimeHooksV1;
}): Promise<{
  readonly state: RalphRuntimeStateV2;
  readonly hostBaseline: BridgeWorkspaceSnapshotV1;
  readonly workspaceBaseline: BridgeWorkspaceSnapshotV1;
  readonly publicationOccurred: boolean;
} | { readonly result: RalphBridgeResultV1 }> {
  const { root, authority, descriptor, store, lease, attempt, hooks } = input;
  const allOwnedPaths = Object.values(authority.ownedPathsByTask).flat();
  await hooks.beforePublication?.(attempt.taskId, descriptor.workspaceRoot);
  try {
    const published = await publishAcceptedTaskDelta({
      projectRoot: root,
      workspaceRoot: descriptor.workspaceRoot,
      runDirectory: store.runDirectory,
      runId: descriptor.runId,
      planId: authority.selectedPlan.id,
      taskId: attempt.taskId,
      attemptId: attempt.attemptId,
      taskOwnedPaths: authority.ownedPathsByTask[attempt.taskId] ?? [],
      allOwnedPaths,
      expectedHostBaseline: input.hostBaseline,
      workspaceBaseline: input.workspaceBaseline,
      revalidateReadiness: async () => {
        await inspectExactProgressiveReadiness(root);
        const tree = await validateManifestTree(root);
        if (!tree.valid) throw new RalphBridgeAuthorityError("RALPH_BRIDGE_MANIFEST_STALE_BEFORE_PUBLICATION");
        const current = await loadProgressiveExecutionAuthority(root);
        if (current.semanticExecutionIdentity !== authority.semanticExecutionIdentity
          || current.operationalPlanDigest !== authority.operationalPlanDigest
          || current.selectedPlan.sha256 !== authority.selectedPlan.sha256) {
          throw new RalphBridgeAuthorityError("RALPH_BRIDGE_AUTHORITY_CHANGED_BEFORE_PUBLICATION");
        }
        return current.readinessDigest;
      },
      ...(hooks.clock ? { clock: hooks.clock } : {}),
    });
    return {
      state: input.state,
      hostBaseline: published.hostBaseline,
      workspaceBaseline: published.workspaceBaseline,
      publicationOccurred: input.publicationOccurred || published.receipt.delta.length > 0,
    };
  } catch (error) {
    let state = input.state;
    const durable = await inspectOperationalRunV2({
      projectRoot: descriptor.workspaceRoot,
      runId: descriptor.runId,
      genesisState: genesisFor(authority.operationalPlan, descriptor.runId),
      workspaceComparison: "ALLOW_POST_EXECUTOR_DRIFT",
    }).catch(() => undefined);
    if (durable?.state) state = durable.state;
    const candidate = await snapshotRalphWorkspace(descriptor.workspaceRoot, allOwnedPaths).catch(() => undefined);
    await persistRejectedPublication({
      runDirectory: store.runDirectory,
      runId: descriptor.runId,
      planId: authority.selectedPlan.id,
      taskId: attempt.taskId,
      attemptId: attempt.attemptId,
      readinessDigest: authority.readinessDigest,
      hostBaseline: input.hostBaseline,
      workspaceBaseline: input.workspaceBaseline,
      ...(candidate ? { workspaceCandidate: candidate } : {}),
      reason: errorCode(error),
      ...(hooks.clock ? { clock: hooks.clock } : {}),
    }).catch(() => undefined);
    if (!hasOpenAttempt(state) && state.disposition === "ACTIVE") {
      state = await commitTerminalWhileLeased(lease, "FAILED", hooks, errorCode(error)).catch(() => state);
    }
    return { result: resultFromState(authority, descriptor, state, "FAILED", input.publicationOccurred, errorCode(error)) };
  }
}

async function acceptedUnpublishedAttempt(store: RalphEventStoreV2, state: RalphRuntimeStateV2): Promise<AttemptStateV2 | undefined> {
  const accepted = Object.values(state.attempts)
    .filter((attempt) => attempt.disposition === "CLOSED" && attempt.closureReason === "AUDIT_ACCEPTED")
    .sort((left, right) => left.ordinal - right.ordinal);
  for (const attempt of accepted) {
    const exists = await readFile(resolve(store.runDirectory, "attempts", attempt.attemptId, "host-publication.json"), "utf8")
      .then(() => true)
      .catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error));
    if (!exists) return attempt;
  }
  return undefined;
}

export interface DiscoveredPendingHumanV1 {
  readonly request: HumanValidationRequestV2;
  readonly display: RalphBridgePendingHumanV1;
}

export async function discoverPendingHuman(store: RalphEventStoreV2, state: RalphRuntimeStateV2, projectRoot: string): Promise<DiscoveredPendingHumanV1> {
  const openAttempts = Object.values(state.attempts).filter((attempt) => attempt.disposition === "OPEN");
  const attempts = openAttempts.filter((attempt) => attempt.stage === "AWAITING_HUMAN");
  if (state.hold !== "HUMAN_REQUIRED" || openAttempts.length !== 1 || attempts.length !== 1) {
    throw new Error("RALPH_BRIDGE_HUMAN_PENDING_BOUNDARY_AMBIGUOUS");
  }
  const attempt = attempts[0]!;
  const workUnit = await readWorkUnitV2(store, attempt.attemptId);
  if (!workUnit
    || workUnit.runId !== state.runId
    || workUnit.phaseId !== attempt.phaseId
    || workUnit.taskId !== attempt.taskId
    || workUnit.attemptId !== attempt.attemptId) {
    throw new Error("RALPH_BRIDGE_HUMAN_REQUEST_RECONSTRUCTION_FAILED");
  }

  // Operational-D intentionally leaves reducer ValidationRunRefs at PENDING
  // until the complete ValidationSet barrier is materialized.  Discovery must
  // therefore resolve each started ref against its immutable result artifact
  // before deciding which (if any) Human boundary is still open.
  const unresolvedHumans: Array<{ readonly ref: typeof attempt.validationRuns[number]; readonly spec: typeof workUnit.validationSpecRefs[number] }> = [];
  for (const ref of attempt.validationRuns) {
    const matchingSpecs = workUnit.validationSpecRefs.filter((candidate) =>
      candidate.validationSpecId === ref.validationSpecId && candidate.digest === ref.validationSpecDigest);
    if (matchingSpecs.length !== 1) throw new Error("RALPH_BRIDGE_HUMAN_REQUEST_RECONSTRUCTION_FAILED");
    const spec = matchingSpecs[0]!;

    let artifact;
    try { artifact = await readValidationRunV2(store, attempt.attemptId, ref.validationRunId); }
    catch { throw new Error("RALPH_BRIDGE_HUMAN_PENDING_BOUNDARY_AMBIGUOUS"); }

    if (!artifact) {
      // A missing result is only an admissible unresolved boundary for a
      // Human validation.  COMMAND and MANUAL refs must never be skipped or
      // redispatched from this discovery path.
      if (ref.outcome === "PENDING" && spec.kind === "HUMAN") {
        unresolvedHumans.push({ ref, spec });
        continue;
      }
      throw new Error("RALPH_BRIDGE_HUMAN_PENDING_BOUNDARY_AMBIGUOUS");
    }

    // Validate the complete immutable result binding.  In particular, a
    // pending reducer ref may be materially resolved by this artifact, but a
    // foreign, stale, or tampered artifact must fail closed.
    if (artifact.runId !== state.runId
      || artifact.phaseId !== attempt.phaseId
      || artifact.taskId !== attempt.taskId
      || artifact.attemptId !== attempt.attemptId
      || artifact.validationRunId !== ref.validationRunId
      || artifact.validationSpecId !== spec.validationSpecId
      || artifact.validationSpecDigest !== spec.digest
      || artifact.validationRunOrdinal !== ref.validationRunOrdinal
      || artifact.kind !== spec.kind
      || artifact.instruction !== spec.instruction
      || artifact.startedAt !== ref.startedAt
      || (ref.endedAt !== undefined && ref.endedAt !== artifact.finishedAt)
      || (ref.exitCode !== undefined && ref.exitCode !== artifact.exitCode)
      || (ref.resultDigest !== undefined && ref.resultDigest !== artifact.runDigest)
      || (ref.outcome !== "PENDING" && (ref.outcome !== artifact.outcome || ref.resultDigest !== artifact.runDigest))) {
      throw new Error("RALPH_BRIDGE_HUMAN_PENDING_BOUNDARY_AMBIGUOUS");
    }
  }

  if (unresolvedHumans.length !== 1) throw new Error("RALPH_BRIDGE_HUMAN_PENDING_BOUNDARY_AMBIGUOUS");
  const { spec } = unresolvedHumans[0]!;
  const request = createHumanValidationRequestV2({
    runId: state.runId,
    phaseId: attempt.phaseId,
    taskId: attempt.taskId,
    attemptId: attempt.attemptId,
    validationSpecId: spec.validationSpecId,
    validationSpecDigest: spec.digest,
  });
  const inspected = await store.inspect();
  const proof = inspected.events.filter((event) => event.eventType === "attempt.human-required"
    && event.runId === state.runId
    && event.phaseId === attempt.phaseId
    && event.taskId === attempt.taskId
    && event.attemptId === attempt.attemptId && event.payload.proofRef === request.humanRequestRef);
  if (proof.length !== 1 || request.humanRequestRef !== humanValidationRequestRefV2(state.runId, attempt.attemptId, spec.validationSpecId)) {
    throw new Error("RALPH_BRIDGE_HUMAN_REQUEST_PROOF_MISMATCH");
  }
  return {
    request,
    display: {
      phaseId: attempt.phaseId,
      taskId: attempt.taskId,
      taskTitle: workUnit.title,
      validationSpecId: spec.validationSpecId,
      instruction: spec.instruction,
      humanRequestRef: request.humanRequestRef,
      continuationPass: `rb-harness --ralph --project ${shellDisplay(projectRoot)} --human-decision pass`,
      continuationFail: `rb-harness --ralph --project ${shellDisplay(projectRoot)} --human-decision fail`,
    },
  };
}

function humanRequiredResult(
  root: string,
  authority: ProgressiveExecutionAuthorityV1,
  descriptor: RalphBridgeRunDescriptorV1,
  state: RalphRuntimeStateV2,
  publicationOccurred: boolean,
  pending: DiscoveredPendingHumanV1,
): RalphBridgeResultV1 {
  const result = resultFromState(authority, descriptor, state, "NEEDS_HUMAN", publicationOccurred,
    "RALPH_BRIDGE_HUMAN_EVIDENCE_REQUIRED",
    `Perform the requested check, then continue the same run with: rb-harness --ralph --project ${shellDisplay(root)} --human-decision pass (or --human-decision fail).`);
  return Object.freeze({ ...result, pendingHuman: pending.display });
}

function shellDisplay(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export async function inspectRalphBridgeStatusV1(projectRoot: string): Promise<{
  readonly state: "no run" | "active" | "terminal";
  readonly latestRunId?: string;
  readonly latestStatus?: string;
  readonly selectedPlanId?: string;
  readonly pendingHuman?: RalphBridgePendingHumanV1;
}> {
  const descriptors = await listBridgeRunDescriptors(resolve(projectRoot));
  const latest = descriptors.at(-1);
  if (!latest) return { state: "no run" };
  const snapshot = await readFile(resolve(latest.runDirectory, "state", "current.json"), "utf8")
    .then((source) => JSON.parse(source) as { readonly state?: RalphRuntimeStateV2 })
    .catch(() => undefined);
  const disposition = snapshot?.state?.disposition ?? "INCOMPLETE_INITIALIZATION";
  const publication = await inspectHostPublicationOutcome(latest.runDirectory).catch(() => undefined);
  const latestStatus = publication === undefined ? "INTEGRITY_FAILURE"
    : publication.rejected ? "FAILED"
      : snapshot?.state?.hold === "HUMAN_REQUIRED" ? "NEEDS_HUMAN" : disposition;
  const pendingHuman = snapshot?.state?.hold === "HUMAN_REQUIRED"
    ? await discoverPendingHuman(new RalphEventStoreV2({ projectRoot: latest.workspaceRoot, runId: latest.runId }), snapshot.state, resolve(projectRoot))
      .then((pending) => pending.display)
      .catch(() => undefined)
    : undefined;
  return {
    state: latestStatus === "COMPLETE" || latestStatus === "FAILED" ? "terminal" : "active",
    latestRunId: latest.runId,
    latestStatus,
    selectedPlanId: latest.plan.id,
    ...(pendingHuman ? { pendingHuman } : {}),
  };
}

export function formatRalphBridgeResultV1(result: RalphBridgeResultV1): string {
  return [
    `Ralph: ${result.status}`,
    `Run: ${result.runId}`,
    `Plan: ${result.planId} (${result.planPath}, ${result.planSha256})`,
    `Tasks: ${result.completedTaskCount} complete, ${result.remainingTaskCount} remaining`,
    `Publication: ${result.publicationOccurred ? "YES" : "NO"}`,
    `Evidence: ${result.runPath}`,
    ...(result.pendingHuman ? [
      `Pending Human: ${result.pendingHuman.phaseId}/${result.pendingHuman.taskId} — ${result.pendingHuman.taskTitle}`,
      `Validation: ${result.pendingHuman.validationSpecId}`,
      `Instruction: ${result.pendingHuman.instruction}`,
      `Human request: ${result.pendingHuman.humanRequestRef}`,
      `Continue PASS: ${result.pendingHuman.continuationPass}`,
      `Continue FAIL: ${result.pendingHuman.continuationFail}`,
    ] : []),
    ...(result.errorCode ? [`Code: ${result.errorCode}`] : []),
    ...(result.guidance ? [`Guidance: ${result.guidance}`] : []),
  ].join("\n");
}

async function existingRunResult(
  root: string,
  authority: ProgressiveExecutionAuthorityV1,
  descriptor: RalphBridgeRunDescriptorV1,
  hooks: RalphBridgeRuntimeHooksV1,
  invocation: RalphBridgeInvocationV1,
): Promise<RalphBridgeResultV1> {
  if (descriptor.plan.operationalDigest !== authority.operationalPlanDigest || descriptor.plan.sha256 !== authority.selectedPlan.sha256) {
    return resultFromCounts(authority, descriptor, "BLOCKED", 0, authority.operationalPlan.phases.flatMap((phase) => phase.tasks).length, false, "RALPH_BRIDGE_EXISTING_RUN_AUTHORITY_MISMATCH");
  }
  const store = new RalphEventStoreV2({ projectRoot: descriptor.workspaceRoot, runId: descriptor.runId });
  const genesisState = genesisFor(authority.operationalPlan, descriptor.runId);
  const opened = await inspectOperationalRunV2({ projectRoot: descriptor.workspaceRoot, runId: descriptor.runId, genesisState, workspaceComparison: "ALLOW_POST_EXECUTOR_DRIFT" });
  if (!opened.state || opened.outcome === "FAILED_INTEGRITY" || opened.outcome === "RECONCILIATION_REQUIRED") {
    return resultFromCounts(authority, descriptor, "BLOCKED", 0, genesisState.taskIds.length, false, opened.issues[0] ?? "RALPH_BRIDGE_EXISTING_RUN_INTEGRITY_FAILURE");
  }
  let publication;
  try { publication = await inspectHostPublicationOutcome(store.runDirectory); }
  catch (error) {
    return resultFromState(authority, descriptor, opened.state, "BLOCKED", false, errorCode(error));
  }
  if (publication?.rejected) {
    return resultFromState(authority, descriptor, opened.state, "FAILED", publication.publicationOccurred, publication.rejected.reason);
  }
  if (opened.state.hold === "RECONCILIATION_REQUIRED") {
    const guidance = await finalizationDiagnosticGuidanceV1(store, opened.state);
    return resultFromState(
      authority,
      descriptor,
      opened.state,
      "BLOCKED",
      publication.publicationOccurred,
      "RALPH_BRIDGE_RECONCILIATION_REQUIRED",
      guidance ?? "Inspect the preserved durable evidence and workspace before recovery.",
    );
  }
  const acceptedPendingPublication = opened.state.disposition === "COMPLETE" && !invocation.humanDecision
    ? await acceptedUnpublishedAttempt(store, opened.state)
    : undefined;
  if ((opened.state.disposition === "COMPLETE" || opened.state.disposition === "FAILED") && !acceptedPendingPublication) {
    if (invocation.humanDecision) {
      return resultFromState(authority, descriptor, opened.state, "FAILED", publication.publicationOccurred, "RALPH_BRIDGE_HUMAN_CONTINUATION_TERMINAL_RUN");
    }
    return resultFromState(authority, descriptor, opened.state, opened.state.disposition, publication.publicationOccurred);
  }
  if (!invocation.humanDecision
    && opened.state.hold !== "HUMAN_REQUIRED"
    && Object.keys(opened.state.attempts).length === 0) {
    return resultFromState(authority, descriptor, opened.state, "INCOMPLETE_RESUMABLE", publication.publicationOccurred,
      "RALPH_BRIDGE_EXISTING_INCOMPLETE_RUN", "Inspect the durable run and workspace; the bridge will not create a second same-plan run.");
  }

  let pending: DiscoveredPendingHumanV1 | undefined;
  let humanAuthority: TrustedHumanValidationAuthorityV2 | undefined;
  if (opened.state.hold === "HUMAN_REQUIRED" || invocation.humanDecision) {
    try { pending = await discoverPendingHuman(store, opened.state, root); }
    catch (error) {
      return resultFromState(authority, descriptor, opened.state, "FAILED", publication.publicationOccurred,
        invocation.humanDecision ? errorCode(error) : "RALPH_BRIDGE_HUMAN_PENDING_BOUNDARY_AMBIGUOUS");
    }
    let persisted;
    try { persisted = await readHumanValidationDecisionV2(store, pending.request.attemptId, pending.request.validationSpecId); }
    catch (error) {
      return resultFromState(authority, descriptor, opened.state, "FAILED", publication.publicationOccurred,
        "RALPH_BRIDGE_HUMAN_DECISION_INTEGRITY_FAILURE", error instanceof Error ? error.message : String(error));
    }
    if (invocation.humanDecision && persisted && persisted.decision !== invocation.humanDecision) {
      return resultFromState(authority, descriptor, opened.state, "FAILED", publication.publicationOccurred, "RALPH_BRIDGE_HUMAN_DECISION_IMMUTABLE_CONFLICT");
    }
    if (invocation.humanDecision && !persisted) {
      humanAuthority = createOperatorHumanValidationAuthorityV2({
        authorityId: "rb-harness-cli-operator",
        request: pending.request,
        decision: invocation.humanDecision,
        decidedAt: hooks.clock?.() ?? new Date().toISOString(),
      });
    } else if (!persisted) {
      return humanRequiredResult(root, authority, descriptor, opened.state, publication.publicationOccurred, pending);
    }
  }

  let baselines: { readonly host: BridgeWorkspaceSnapshotV1; readonly workspace: BridgeWorkspaceSnapshotV1 };
  try { baselines = await recoverBridgeBaselines(root, descriptor, store, opened.state, Object.values(authority.ownedPathsByTask).flat()); }
  catch (error) { return resultFromState(authority, descriptor, opened.state, "BLOCKED", publication.publicationOccurred, errorCode(error)); }
  return driveBridgeRun({
    root,
    authority,
    descriptor,
    store,
    lease: { projectRoot: descriptor.workspaceRoot, runId: descriptor.runId, genesisState },
    timeoutPolicy: createM5BTimeoutPolicyV2(RALPH_BRIDGE_DEFAULT_TIMEOUT_MS_V1),
    state: opened.state,
    hostBaseline: baselines.host,
    workspaceBaseline: baselines.workspace,
    publicationOccurred: publication.publicationOccurred,
    runtimes: hooks.runtimes ?? realCodexFactories(resolve(root, ".rb-harness", "ralph", "bridge-runs", descriptor.runId)),
    hooks,
    ...(humanAuthority ? { humanAuthority } : {}),
  });
}

async function recoverBridgeBaselines(
  root: string,
  descriptor: RalphBridgeRunDescriptorV1,
  store: RalphEventStoreV2,
  state: RalphRuntimeStateV2,
  allOwnedPaths: readonly string[],
): Promise<{ readonly host: BridgeWorkspaceSnapshotV1; readonly workspace: BridgeWorkspaceSnapshotV1 }> {
  const open = Object.values(state.attempts).find((attempt) => attempt.disposition === "OPEN" && attempt.executorFinished);
  const pendingPublication = open ? undefined : await acceptedUnpublishedAttempt(store, state);
  const sourceAttempt = open ?? pendingPublication;
  if (!sourceAttempt) {
    return {
      host: await snapshotHostImplementation(root, allOwnedPaths),
      workspace: await snapshotRalphWorkspace(descriptor.workspaceRoot, allOwnedPaths),
    };
  }
  const manifest = await readWorkspaceBeforeManifestV2(store, sourceAttempt.attemptId);
  if (!manifest) throw new Error("RALPH_BRIDGE_PUBLICATION_BASELINE_REQUIRED");
  const baseline = bridgeSnapshotFromWorkspaceManifest(manifest);
  if (sourceAttempt.attemptBaseFingerprint !== manifest.fingerprintDigest) throw new Error("RALPH_BRIDGE_PUBLICATION_BASELINE_MISMATCH");
  return { host: baseline, workspace: baseline };
}

function bridgeSnapshotFromWorkspaceManifest(manifest: WorkspaceManifestV2): BridgeWorkspaceSnapshotV1 {
  const files = Object.fromEntries(manifest.productWorkspaceEntries
    .filter((entry) => entry.kind === "file" && entry.contentHash !== undefined && entry.size !== undefined)
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => [entry.path, Object.freeze({
      path: entry.path,
      sha256: entry.contentHash!,
      size: entry.size!,
      mode: entry.mode & 0o777,
    })]));
  return Object.freeze({ files: Object.freeze(files), digest: sha256Canonical(files) });
}

function realCodexFactories(bridgeRoot: string): BridgeRuntimeFactoriesV1 {
  return {
    executor: ({ store, authorizedInvocation, timeoutPolicy }) => createCodexCliExecutorV2({
      store,
      authorizedInvocation,
      timeoutPolicy,
      stagingBase: resolve(bridgeRoot, "provider-staging"),
    }),
    auditor: ({ store, auditPackage, timeoutPolicy }) => createCodexCliAuditorV2({
      store,
      auditPackage,
      timeoutPolicy,
      ioBase: resolve(bridgeRoot, "auditor-io"),
    }),
  };
}

function preflightFailure(error: unknown): RalphBridgeResultV1 {
  return {
    schema: "rb-ralph-bridge-result/v1",
    runId: "none",
    planId: "none",
    planPath: "none",
    planSha256: "none",
    semanticExecutionIdentity: "none",
    status: "FAILED",
    completedTaskCount: 0,
    remainingTaskCount: 0,
    publicationOccurred: false,
    runPath: "none",
    errorCode: errorCode(error),
  };
}

function authorityFailure(
  authority: ProgressiveExecutionAuthorityV1,
  error: unknown,
  runId = "none",
  runPath = "none",
  status: RalphBridgeResultStatusV1 = "FAILED",
): RalphBridgeResultV1 {
  return {
    schema: "rb-ralph-bridge-result/v1",
    runId,
    planId: authority.selectedPlan.id,
    planPath: authority.selectedPlan.path,
    planSha256: authority.selectedPlan.sha256,
    semanticExecutionIdentity: authority.semanticExecutionIdentity,
    status,
    completedTaskCount: 0,
    remainingTaskCount: authority.operationalPlan.phases.flatMap((phase) => phase.tasks).length,
    publicationOccurred: false,
    runPath,
    errorCode: errorCode(error),
  };
}

function resultFromState(
  authority: ProgressiveExecutionAuthorityV1,
  descriptor: RalphBridgeRunDescriptorV1,
  state: RalphRuntimeStateV2,
  status: RalphBridgeResultStatusV1,
  publicationOccurred: boolean,
  error?: string,
  guidance?: string,
): RalphBridgeResultV1 {
  const complete = state.taskIds.filter((taskId) => state.tasks[taskId]?.disposition === "COMPLETE").length;
  return resultFromCounts(authority, descriptor, status, complete, state.taskIds.length - complete, publicationOccurred, error, guidance);
}

function resultFromCounts(
  authority: ProgressiveExecutionAuthorityV1,
  descriptor: RalphBridgeRunDescriptorV1,
  status: RalphBridgeResultStatusV1,
  completedTaskCount: number,
  remainingTaskCount: number,
  publicationOccurred: boolean,
  errorCodeValue?: string,
  guidance?: string,
): RalphBridgeResultV1 {
  return {
    schema: "rb-ralph-bridge-result/v1",
    runId: descriptor.runId,
    planId: descriptor.plan.id,
    planPath: descriptor.plan.path,
    planSha256: descriptor.plan.sha256,
    semanticExecutionIdentity: descriptor.semanticExecutionIdentity,
    status,
    completedTaskCount,
    remainingTaskCount,
    publicationOccurred,
    runPath: descriptor.runDirectory,
    ...(errorCodeValue ? { errorCode: errorCodeValue } : {}),
    ...(guidance ? { guidance } : {}),
  };
}

function createRunId(authority: ProgressiveExecutionAuthorityV1): string {
  return `ralph-${authority.semanticExecutionIdentity.slice(-16)}-${randomUUID().replaceAll("-", "")}`;
}

function hasOpenAttempt(state: RalphRuntimeStateV2): boolean {
  return Object.values(state.attempts).some((attempt) => attempt.disposition === "OPEN");
}

async function commitTerminalWhileLeased(
  leaseInput: LeaseRuntimeInputV2,
  disposition: "COMPLETE" | "FAILED",
  hooks: RalphBridgeRuntimeHooksV1,
  reason?: string,
): Promise<RalphRuntimeStateV2> {
  const leased = await acquireLeasedRunV2(leaseInput);
  try {
    return await commitRunTerminalEvent({
      store: leased.store,
      state: leased.state,
      disposition,
      ...(reason ? { reason } : {}),
      ...(hooks.clock ? { clock: hooks.clock } : {}),
      ...(hooks.nonceFactory ? { nonceFactory: hooks.nonceFactory } : {}),
      ...(hooks.eventIdFactory ? { eventIdFactory: hooks.eventIdFactory } : {}),
    });
  } finally {
    await releaseLeasedRunV2(leased);
  }
}

function errorCode(error: unknown): string {
  if (error instanceof RalphBridgeAuthorityError || error instanceof RalphBridgeWorkspaceError) return error.code;
  if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") return (error as { code: string }).code;
  return error instanceof Error ? error.message.split(":", 1)[0]! : "RALPH_BRIDGE_UNKNOWN_FAILURE";
}
