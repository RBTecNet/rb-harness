import { mkdtemp, readFile, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RuntimeEntityRef } from "../../src/vnext/ralph-runtime/contracts.js";
import type { ExecutionDocument, Phase, Task } from "../../src/types.js";
import {
  EVENT_SCHEMA_V2,
  OPERATIONAL_CONTRACT_V2,
  STATE_SCHEMA_V2,
  V2_EVENT_ENTITY_KINDS,
  createInitialRuntimeStateV2,
  createRalphEventV2,
  type EventPayloadMapV2,
  type RalphEventTypeV2,
  type RalphEventV2,
  type RalphRuntimeStateV2,
  type UnsignedRalphEventV2,
} from "../../src/vnext/ralph-runtime/operational-v2/index.js";
import {
  RALPH_RUN_SNAPSHOT_V2_SCHEMA,
  commitRalphEventV2,
  createRetryPolicyV1,
  initializeOperationalRunV2,
  RalphEventStoreV2,
  retryPolicyDescriptorV1,
  type RunSnapshotV2,
} from "../../src/vnext/ralph-runtime/operational-b1/index.js";
import {
  acquireLeasedRunV2,
  inspectRunLeaseV2,
  refreshLeasedRunV2,
  deriveExecutorReleaseProofV2,
  isLeaseReleaseProofV2,
  recoverStaleRunLeaseV2,
  releaseLeasedRunV2,
  type LeaseRuntimeInputV2,
  type LeaseReleaseProofV2,
  type ProcessIdentity,
  type ProcessIdentityProvider,
} from "../../src/vnext/ralph-runtime/operational-b2/index.js";
import {
  prepareNextAuthorizedInvocationV2,
} from "../../src/vnext/ralph-runtime/operational-b3/index.js";
import {
  deriveNotInvokedProofV2,
  executeAuthorizedInvocationV2,
  buildExecutorObservationEnvelopeV2,
  isTrustedExecutorRuntimeV2,
  isNotInvokedProofV2,
  isTrustedExecutorObservationV2,
  ScriptedExecutor,
  type NotInvokedProofV2,
  type TrustedExecutorObservationV2,
} from "../../src/vnext/ralph-runtime/operational-b4/index.js";
import { createInvocationResultV2, persistInvocationResultV2 } from "../../src/vnext/ralph-runtime/operational-b4/invocation-result.js";
import { createWorkspacePolicy, fingerprintWorkspace } from "../../src/vnext/ralph-runtime/fingerprint.js";
import { sha256, sha256Canonical } from "../../src/vnext/ralph-runtime/hashing.js";
import { nodeRalphRuntimeFileSystem, type RalphRuntimeFileSystem } from "../../src/vnext/ralph-runtime/event-store.js";

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const TEST_MAX_TASK_ATTEMPTS = 4;
const TEST_VALIDATION_INFRA_RETRIES = 2;

const ownerIdentity: ProcessIdentity = {
  pid: 53101,
  processStartIdentity: "b4-owner-start",
  hostIdentity: "b4-host",
  bootSessionIdentity: "b4-boot",
};

function identityProvider(current: ProcessIdentity = ownerIdentity): ProcessIdentityProvider {
  return { current: () => current, inspect: () => "MATCH" };
}

function task(id = "T001"): Task {
  return {
    id,
    title: `Task ${id}`,
    done: false,
    scope: "src",
    change: `make the declared ${id} change`,
    covers: "src",
    dependsOn: [],
    parallelSafe: false,
    acceptanceCriteria: [`${id} has its declared result`],
    validation: ["`printf validation`"],
    expectedEvidence: "a deterministic evidence reference",
    line: 1,
  };
}

function plan(): ExecutionDocument {
  const phase: Phase = {
    number: 1,
    id: "P01",
    title: "B4 phase",
    goal: "exercise scripted execution",
    dependsOn: [],
    context: ["test"],
    tasks: [task()],
    line: 1,
  };
  return { contract: "rb-execution/v1", artifactId: "plan-b4", title: "B4", phases: [phase] };
}

function descriptor(schemaVersion: string, descriptorId: string): { readonly schemaVersion: string; readonly descriptorId: string; readonly descriptorDigest: string } {
  const base = { schemaVersion, descriptorId };
  return { ...base, descriptorDigest: sha256Canonical(base) };
}

function genesis(document: ExecutionDocument, runId: string): RalphRuntimeStateV2 {
  return createInitialRuntimeStateV2({
    runId,
    maxTaskAttemptsPerTask: TEST_MAX_TASK_ATTEMPTS,
    phases: document.phases.map((phase) => ({ phaseId: phase.id, taskIds: phase.tasks.map((candidate) => candidate.id) })),
    tasks: document.phases.flatMap((phase) => phase.tasks.map((candidate) => ({ taskId: candidate.id, phaseId: phase.id, dependsOn: candidate.dependsOn }))),
  });
}

function event<TType extends RalphEventTypeV2>(
  state: RalphRuntimeStateV2,
  eventType: TType,
  payload: EventPayloadMapV2[TType],
  context: { readonly phaseId?: string; readonly taskId?: string; readonly attemptId?: string } = {},
): RalphEventV2 {
  const kind = V2_EVENT_ENTITY_KINDS[eventType];
  const entity: RuntimeEntityRef = kind === "run"
    ? { kind, id: state.runId }
    : kind === "workspace"
      ? { kind, id: `${state.runId}:workspace` }
      : kind === "task"
        ? { kind, id: context.taskId ?? "T001" }
        : { kind: "attempt", id: context.attemptId ?? "attempt-b4-001" };
  const occurredAt = "2026-09-06T05:00:10.000Z";
  return createRalphEventV2({
    eventId: `b4-fixture-${state.lastSequence + 1}-${eventType}`,
    eventType,
    schemaVersion: EVENT_SCHEMA_V2,
    runId: state.runId,
    sequence: state.lastSequence + 1,
    occurredAt,
    recordedAt: occurredAt,
    entity,
    ...(context.phaseId === undefined ? {} : { phaseId: context.phaseId }),
    ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
    ...(context.attemptId === undefined ? {} : { attemptId: context.attemptId }),
    actor: "CORE",
    causationId: null,
    correlationId: `${state.runId}:b4-fixture`,
    payload,
    previousEventHash: state.lastEventHash,
  } as UnsignedRalphEventV2<TType>) as RalphEventV2;
}

async function append(store: RalphEventStoreV2, state: RalphRuntimeStateV2, next: RalphEventV2, nonce: string): Promise<RalphRuntimeStateV2> {
  return (await commitRalphEventV2({ store, state, event: next, writtenAt: "2026-09-06T05:00:11.000Z", nonce })).state;
}

async function fixtureRoot(prefix: string, runId: string): Promise<{
  readonly root: string;
  readonly store: RalphEventStoreV2;
  readonly genesis: RalphRuntimeStateV2;
  readonly document: ExecutionDocument;
}> {
  const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", prefix));
  const document = plan();
  const workspacePolicy = createWorkspacePolicy();
  const fingerprint = await fingerprintWorkspace(root, workspacePolicy);
  const snapshot: RunSnapshotV2 = {
    snapshotSchemaVersion: RALPH_RUN_SNAPSHOT_V2_SCHEMA,
    runId,
    eventSchema: EVENT_SCHEMA_V2,
    stateSchema: STATE_SCHEMA_V2,
    operationalContract: OPERATIONAL_CONTRACT_V2,
    projectIdentity: { projectId: "b4-test-project" },
    readyPlanIdentity: document.artifactId,
    readyPlanHash: sha256Canonical(document),
    readyManifestHash: sha256("ready-manifest-b4"),
    selectedReadyArtifactHashes: { plan: sha256Canonical(document) },
    readinessInspectionDigest: sha256("readiness-b4"),
    effectiveRunConfig: descriptor("rb-ralph-config/v2", "b4-config"),
    effectiveConfigDigest: descriptor("rb-ralph-config/v2", "b4-config").descriptorDigest,
    diagnosticsPolicy: descriptor("rb-ralph-diagnostics/v2", "b4-diagnostics"),
    environmentPolicy: descriptor("rb-ralph-environment/v2", "b4-environment"),
    executorProfile: { profileId: "scripted-b4", kind: "scripted", descriptorDigest: sha256("profile-b4") },
    executorCapabilities: { requested: ["fixture.effect"], granted: ["fixture.effect"], verified: ["fixture.effect"], readOnlyEnforced: false },
    permissionCapabilityPolicy: descriptor("rb-ralph-capabilities/v2", "b4-capabilities"),
    workspacePolicy,
    initialWorkspaceFingerprint: {
      controlPlaneFingerprint: fingerprint.controlPlaneFingerprint,
      productWorkspaceFingerprint: fingerprint.productWorkspaceFingerprint,
      policyDigest: fingerprint.policyDigest,
      fingerprintDigest: fingerprint.fingerprintDigest,
    },
    retryPolicies: retryPolicyDescriptorV1(createRetryPolicyV1({ runId, policyId: "b4-retry", maxTaskAttemptsPerTask: TEST_MAX_TASK_ATTEMPTS, validationInfrastructureRetryLimit: TEST_VALIDATION_INFRA_RETRIES })),
    timeoutPolicy: descriptor("rb-ralph-timeout/v2", "b4-timeout"),
    runtimeIdentity: descriptor("rb-ralph-runtime/v2", "b4-runtime"),
    leasePolicy: descriptor("rb-ralph-lease/v2", "b4-lease"),
    createdAt: "2026-09-06T05:00:00.000Z",
  };
  const store = new RalphEventStoreV2({ projectRoot: root, runId });
  const initial = genesis(document, runId);
  const initialized = await initializeOperationalRunV2({
    store,
    snapshot,
    retryPolicy: createRetryPolicyV1({ runId, policyId: "b4-retry", maxTaskAttemptsPerTask: TEST_MAX_TASK_ATTEMPTS, validationInfrastructureRetryLimit: TEST_VALIDATION_INFRA_RETRIES }),
    genesisState: initial,
    runCreatedEvent: event(initial, "run.created", { phaseIds: initial.phaseIds, taskIds: initial.taskIds }),
    createdAt: "2026-09-06T05:00:01.000Z",
    nonce: "b4-init",
  });
  let state = await append(store, initialized.state, event(initialized.state, "run.started", {}), "b4-start");
  state = await append(store, state, event(state, "task.state-changed", {
    disposition: "READY",
    activity: "IDLE",
    owner: "NONE",
    hold: "NONE",
  }, { phaseId: "P01", taskId: "T001" }), "b4-ready");
  return { root, store, genesis: initial, document };
}

function leaseInput(fixture: Awaited<ReturnType<typeof fixtureRoot>>, overrides: Partial<LeaseRuntimeInputV2> = {}): LeaseRuntimeInputV2 {
  return {
    projectRoot: fixture.root,
    runId: fixture.store.runId,
    genesisState: fixture.genesis,
    processIdentityProvider: identityProvider(),
    ...overrides,
  };
}

function failOnceAfterMarker(marker: string, directorySuffix?: string): RalphRuntimeFileSystem {
  let markerSeen = false;
  let failed = false;
  return {
    ...nodeRalphRuntimeFileSystem,
    writeFile: async (path, data, options) => {
      if (data.toString().includes(marker)) markerSeen = true;
      await nodeRalphRuntimeFileSystem.writeFile(path, data, options);
    },
    fsyncDirectory: async (path) => {
      if (markerSeen && !failed && (directorySuffix === undefined || path.endsWith(directorySuffix))) {
        failed = true;
        throw Object.assign(new Error("injected durability uncertainty"), { code: "EIO" });
      }
      await nodeRalphRuntimeFileSystem.fsyncDirectory(path);
    },
  };
}

let nonceOrdinal = 0;
function nonce(): string { return `b4-${++nonceOrdinal}`; }

async function authorize(fixture: Awaited<ReturnType<typeof fixtureRoot>>, resumedFileSystem?: RalphRuntimeFileSystem) {
  const leased = await acquireLeasedRunV2(leaseInput(fixture));
  const result = await prepareNextAuthorizedInvocationV2({
    leasedRun: leased,
    plan: fixture.document,
    planIdentity: fixture.document.artifactId,
    planDigest: sha256Canonical(fixture.document),
    attemptIdFactory: () => "attempt-b4-001",
    eventIdFactory: () => `b4-event-${++nonceOrdinal}`,
    nonceFactory: nonce,
    clock: () => "2026-09-06T05:00:20.000Z",
  });
  expect(result.kind).toBe("AUTHORIZED_NOT_INVOKED");
  if (result.kind !== "AUTHORIZED_NOT_INVOKED") throw new Error("B4 fixture authorization failed");
  const resumed = await acquireLeasedRunV2(leaseInput(fixture, resumedFileSystem === undefined ? {} : { fs: resumedFileSystem }));
  return { resumed, result };
}

describe("Ralph Operational Core V2 — B4 scripted executor", () => {
  it("uses a nominal ScriptedExecutor root even through a deep-imported observation bridge", async () => {
    const fixture = await fixtureRoot("rb-ralph-b4-runtime-authority-", "run-b4-runtime-authority");
    try {
      const authorized = await authorize(fixture);
      const invocationId = authorized.result.invocation.invocationId;
      const fakeRuntime = {
        kind: "EXECUTOR_RUNTIME" as const,
        runtimeIdentity: "attacker-runtime",
        observe: async () => buildExecutorObservationEnvelopeV2({
          runtimeIdentity: "attacker-runtime",
          observationId: "attacker-observation",
          invocationId,
          state: "NOT_INVOKED",
          observedAt: "2026-09-06T05:00:30.000Z",
        }),
        invoke: async () => ({ invocationId, runtimeIdentity: "attacker-runtime", acceptedAt: "2026-09-06T05:00:30.000Z", physicalStart: "NOT_STARTED" as const }),
        requestCancel: async () => ({ requestId: "attacker-cancel", invocationId, runtimeIdentity: "attacker-runtime", requestedAt: "2026-09-06T05:00:30.000Z", requestState: "ISSUED" as const }),
      };
      expect(isTrustedExecutorRuntimeV2(fakeRuntime)).toBe(false);

      const deepExecution = await import("../../src/vnext/ralph-runtime/operational-b4/execution.js");
      await expect(deepExecution.observeTrustedExecutorInvocationV2(fakeRuntime as never, authorized.result.authorizedInvocation))
        .rejects.toMatchObject({ code: "B4_EXECUTOR_AUTHORIZATION_REQUIRED" });

      const realRuntime = new ScriptedExecutor({ runtimeIdentity: "real-scripted-runtime" });
      expect(isTrustedExecutorRuntimeV2(realRuntime)).toBe(true);
      expect(isTrustedExecutorRuntimeV2(JSON.parse(JSON.stringify(realRuntime)))).toBe(false);
      expect(isTrustedExecutorRuntimeV2(Object.create(Object.getPrototypeOf(realRuntime)))).toBe(false);
      const trusted = await deepExecution.observeTrustedExecutorInvocationV2(realRuntime, authorized.result.authorizedInvocation);
      expect(isTrustedExecutorObservationV2(trusted)).toBe(true);
      expect(trusted.state).toBe("NOT_INVOKED");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("crosses the boundary only after a trusted NOT_INVOKED observation and reaches POST_EXECUTOR_CAPTURE", async () => {
    const fixture = await fixtureRoot("rb-ralph-b4-success-", "run-b4-success");
    try {
      const authorized = await authorize(fixture);
      const physicalOrder: string[] = [];
      let startedSeenDuringPhysicalStart = false;
      const runtime = new ScriptedExecutor({
        runtimeIdentity: "scripted-b4-test",
        clock: () => "2026-09-06T05:00:30.000Z",
        defaultScenario: {
          kind: "SUCCESS",
          fixtureWorkspaceAction: async () => {
            physicalOrder.push("physical-start");
            startedSeenDuringPhysicalStart = (await fixture.store.inspect()).events.some((candidate) => candidate.eventType === "executor.started");
            await mkdir(join(fixture.root, "src"), { recursive: true });
            await writeFile(join(fixture.root, "src", "a.ts"), "export const a = 1;\n");
          },
        },
      });
      const observationBefore = await runtime.observe(authorized.result.invocation.invocationId);
      expect(observationBefore.state).toBe("NOT_INVOKED");
      const outcome = await executeAuthorizedInvocationV2({
        leasedRun: authorized.resumed,
        plan: fixture.document,
        runtime,
        nonceFactory: nonce,
        eventIdFactory: () => `b4-event-${++nonceOrdinal}`,
        clock: () => "2026-09-06T05:00:31.000Z",
      });
      expect(outcome.kind).toBe("EXECUTOR_FINISHED_READY_FOR_CAPTURE");
      expect(runtime.getInvocationAttempts(authorized.result.invocation.invocationId)).toBe(1);
      expect(physicalOrder).toEqual(["physical-start"]);
      expect(startedSeenDuringPhysicalStart).toBe(false);
      const events = (await fixture.store.inspect()).events;
      expect(events.map((candidate) => candidate.eventType)).toContain("executor.started");
      expect(events.map((candidate) => candidate.eventType)).toContain("executor.finished");
      expect(events.find((candidate) => candidate.eventType === "executor.started")!.sequence)
        .toBeLessThan(events.find((candidate) => candidate.eventType === "executor.finished")!.sequence);
      expect(await readFile(join(fixture.store.runDirectory, "attempts", "attempt-b4-001", "invocation-result.json"), "utf8")).toContain("rb-ralph-executor-result/v1");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("never redispatches RUNNING or UNKNOWN and uses the frozen reconciliation transition", async () => {
    const fixture = await fixtureRoot("rb-ralph-b4-recovery-", "run-b4-recovery");
    try {
      const authorized = await authorize(fixture);
      const running = new ScriptedExecutor({ defaultScenario: { kind: "RUNNING" } });
      const first = await executeAuthorizedInvocationV2({ leasedRun: authorized.resumed, plan: fixture.document, runtime: running, nonceFactory: nonce, eventIdFactory: () => `b4-event-${++nonceOrdinal}` });
      expect(first.kind).toBe("EXECUTOR_RUNNING");
      expect(running.getInvocationAttempts(authorized.result.invocation.invocationId)).toBe(1);
      await expect(running.invoke(authorized.result.authorizedInvocation)).rejects.toMatchObject({ code: "B4_EXECUTOR_REDISPATCH_FORBIDDEN" });
      const resumedRunning = await executeAuthorizedInvocationV2({ leasedRun: authorized.resumed, plan: fixture.document, runtime: running, nonceFactory: nonce, eventIdFactory: () => `b4-event-${++nonceOrdinal}` });
      expect(resumedRunning.kind).toBe("EXECUTOR_RUNNING");
      expect(running.getInvocationAttempts(authorized.result.invocation.invocationId)).toBe(1);

      const unknownFixture = await fixtureRoot("rb-ralph-b4-unknown-", "run-b4-unknown");
      try {
        const unknownAuthorized = await authorize(unknownFixture);
        const unknown = new ScriptedExecutor({ defaultScenario: { kind: "UNKNOWN" } });
        const unknownOutcome = await executeAuthorizedInvocationV2({ leasedRun: unknownAuthorized.resumed, plan: unknownFixture.document, runtime: unknown, nonceFactory: nonce, eventIdFactory: () => `b4-event-${++nonceOrdinal}` });
        expect(unknownOutcome.kind).toBe("RECONCILIATION_REQUIRED");
        expect(unknown.getInvocationAttempts(unknownAuthorized.result.invocation.invocationId)).toBe(0);
        await expect(unknown.invoke(unknownAuthorized.result.authorizedInvocation)).rejects.toMatchObject({ code: "B4_EXECUTOR_REDISPATCH_FORBIDDEN" });
        expect(unknown.getInvocationAttempts(unknownAuthorized.result.invocation.invocationId)).toBe(0);
        expect((await unknownFixture.store.inspect()).events.map((candidate) => candidate.eventType)).toContain("attempt.reconciliation-required");
      } finally {
        await rm(unknownFixture.root, { recursive: true, force: true });
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("derives post-executor release only from quiescence and rejects active/unknown observations", async () => {
    const fixture = await fixtureRoot("rb-ralph-b4-release-", "run-b4-release");
    try {
      const authorized = await authorize(fixture);
      const runtime = new ScriptedExecutor({ defaultScenario: { kind: "RUNNING" } });
      const outcome = await executeAuthorizedInvocationV2({ leasedRun: authorized.resumed, plan: fixture.document, runtime, nonceFactory: nonce, eventIdFactory: () => `b4-event-${++nonceOrdinal}` });
      expect(outcome.kind).toBe("EXECUTOR_RUNNING");
      if (outcome.kind !== "EXECUTOR_RUNNING") throw new Error("B4 running fixture did not remain running");
      await expect(deriveExecutorReleaseProofV2(authorized.resumed, outcome.observation, [])).rejects.toMatchObject({ code: "LEASE_RELEASE_EXTERNAL_INVOCATION_UNKNOWN" });

      const finishedFixture = await fixtureRoot("rb-ralph-b4-release-finished-", "run-b4-release-finished");
      try {
        const finishedAuthorized = await authorize(finishedFixture);
        const finishedRuntime = new ScriptedExecutor({ defaultScenario: { kind: "SUCCESS" } });
        const finished = await executeAuthorizedInvocationV2({ leasedRun: finishedAuthorized.resumed, plan: finishedFixture.document, runtime: finishedRuntime, nonceFactory: nonce, eventIdFactory: () => `b4-event-${++nonceOrdinal}` });
        expect(finished.kind).toBe("EXECUTOR_FINISHED_READY_FOR_CAPTURE");
        if (finished.kind !== "EXECUTOR_FINISHED_READY_FOR_CAPTURE") throw new Error("B4 finished fixture did not finish");
        const finishedArtifactRefs = [
          "attempts/attempt-b4-001/work-unit.json",
          "attempts/attempt-b4-001/invocation.json",
          "attempts/attempt-b4-001/invocation-result.json",
        ];
        const forgedFinishedObservation = {
          kind: "TRUSTED_EXECUTOR_OBSERVATION" as const,
          record: finished.observation.record,
          runtimeIdentity: finished.observation.runtimeIdentity,
          observationId: finished.observation.observationId,
          invocationId: finished.observation.invocationId,
          state: finished.observation.state,
          observedAt: finished.observation.observedAt,
          status: finished.observation.status,
          termination: finished.observation.termination,
          resultEnvelopeStatus: finished.observation.resultEnvelopeStatus,
          exitCode: finished.observation.exitCode,
          signal: finished.observation.signal,
          startedAt: finished.observation.startedAt,
          finishedAt: finished.observation.finishedAt,
          startedObservationId: finished.observation.startedObservationId,
          safeMetadata: finished.observation.safeMetadata,
          observationDigest: finished.observation.observationDigest,
        } as unknown as TrustedExecutorObservationV2;
        expect(isTrustedExecutorObservationV2(forgedFinishedObservation)).toBe(false);
        await expect(deriveExecutorReleaseProofV2(finishedAuthorized.resumed, forgedFinishedObservation, finishedArtifactRefs))
          .rejects.toThrow("RALPH_EXECUTOR_OBSERVATION_TRUST_REQUIRED");
        const result = await deriveExecutorReleaseProofV2(finishedAuthorized.resumed, finished.observation, finishedArtifactRefs);
        expect(result.record.externalInvocationState).toBe("TERMINATED_QUIESCENT");
        expect(isLeaseReleaseProofV2(JSON.parse(JSON.stringify(result)))).toBe(false);
        await expect(releaseLeasedRunV2(finishedAuthorized.resumed, { proof: JSON.parse(JSON.stringify(result)) as LeaseReleaseProofV2 })).rejects.toMatchObject({ code: "LEASE_RELEASE_PROOF_INVALID" });
        const otherFixture = await fixtureRoot("rb-ralph-b4-release-cross-binding-", "run-b4-release-cross-binding");
        try {
          const otherAuthorized = await authorize(otherFixture);
          await expect(() => deriveNotInvokedProofV2(finished.observation, otherAuthorized.result.authorizedInvocation))
            .toThrow("RALPH_EXECUTOR_OBSERVATION_BINDING_INVALID");
          await expect(releaseLeasedRunV2(otherAuthorized.resumed, { proof: result })).rejects.toMatchObject({ code: "LEASE_RELEASE_PROOF_INVALID" });
          expect((await inspectRunLeaseV2(otherFixture.store)).kind).toBe("PRESENT");
        } finally {
          await rm(otherFixture.root, { recursive: true, force: true });
        }
        await releaseLeasedRunV2(finishedAuthorized.resumed, { proof: result });
      } finally {
        await rm(finishedFixture.root, { recursive: true, force: true });
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("requires a durable matching executor.finished ledger anchor before post-executor release", async () => {
    const fixture = await fixtureRoot("rb-ralph-b4-release-anchor-", "run-b4-release-anchor");
    try {
      const authorized = await authorize(fixture);
      const runtime = new ScriptedExecutor({
        runtimeIdentity: "release-anchor-runtime",
        clock: () => "2026-09-06T05:01:30.000Z",
        defaultScenario: { kind: "SUCCESS" },
      });
      await runtime.invoke(authorized.result.authorizedInvocation);
      const deepExecution = await import("../../src/vnext/ralph-runtime/operational-b4/execution.js");
      const observation = await deepExecution.observeTrustedExecutorInvocationV2(runtime, authorized.result.authorizedInvocation);
      expect(observation.state).toBe("TERMINATED_QUIESCENT");
      if (observation.state !== "TERMINATED_QUIESCENT" || !observation.startedAt || !observation.finishedAt || !observation.status || !observation.termination || !observation.resultEnvelopeStatus) {
        throw new Error("release anchor observation was not terminal");
      }

      // Keep this permanent test coupled to both independent Core facts.  The
      // behavioral half below proves that a missing ledger event is refused;
      // this contract check also makes removal of either cross-check a test
      // failure rather than an unobserved weakening of the anchor.
      const releaseSource = await readFile(resolve(TEST_DIRECTORY, "../../src/vnext/ralph-runtime/operational-b2/run-lease.ts"), "utf8");
      expect(releaseSource).toContain("boundAttempt.executorFinished");
      expect(releaseSource).toContain("hasDurableExecutorFinishedEvent(internal, boundAttempt, observation)");

      const attemptId = authorized.result.attempt.attempt.attemptId;
      // The fixture's store is a separate facade instance from the leased
      // handle. Refresh its verified cursor before the first direct commit.
      await fixture.store.inspect();
      await refreshLeasedRunV2(authorized.resumed);
      const startedState = authorized.resumed.state;
      const started = event(startedState, "executor.started", {
        invocationId: observation.invocationId,
        startedAt: observation.startedAt,
      }, { phaseId: "P01", taskId: "T001", attemptId });
      await append(fixture.store, startedState, started, nonce());
      await refreshLeasedRunV2(authorized.resumed);

      const result = createInvocationResultV2({
        runId: fixture.store.runId,
        phaseId: "P01",
        taskId: "T001",
        attemptId,
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
      await persistInvocationResultV2(fixture.store, result, nonce());
      const refs = [
        `attempts/${attemptId}/work-unit.json`,
        `attempts/${attemptId}/invocation.json`,
        `attempts/${attemptId}/invocation-result.json`,
      ];

      await expect(deriveExecutorReleaseProofV2(authorized.resumed, observation, refs))
        .rejects.toMatchObject({ code: "LEASE_RELEASE_PROOF_INVALID" });
      expect((await fixture.store.inspect()).events.some((candidate) => candidate.eventType === "executor.finished")).toBe(false);

      const finished = event(authorized.resumed.state, "executor.finished", {
        invocationId: observation.invocationId,
        status: observation.status,
        termination: observation.termination,
        finishedAt: observation.finishedAt,
      }, { phaseId: "P01", taskId: "T001", attemptId });
      await append(fixture.store, authorized.resumed.state, finished, nonce());
      await refreshLeasedRunV2(authorized.resumed);

      const proof = await deriveExecutorReleaseProofV2(authorized.resumed, observation, refs);
      expect(proof.record.externalInvocationState).toBe("TERMINATED_QUIESCENT");
      await releaseLeasedRunV2(authorized.resumed, { proof });
      expect((await inspectRunLeaseV2(fixture.store)).kind).toBe("ABSENT");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("recovers a start crash, persists started before result/finish, and never repeats the invocation", async () => {
    const fixture = await fixtureRoot("rb-ralph-b4-crash-", "run-b4-crash");
    try {
      const authorized = await authorize(fixture);
      const runtime = new ScriptedExecutor({ defaultScenario: { kind: "START_THEN_CRASH" } });
      const outcome = await executeAuthorizedInvocationV2({ leasedRun: authorized.resumed, plan: fixture.document, runtime, nonceFactory: nonce, eventIdFactory: () => `b4-event-${++nonceOrdinal}` });
      expect(outcome.kind).toBe("EXECUTOR_FINISHED_READY_FOR_CAPTURE");
      expect(runtime.getInvocationAttempts(authorized.result.invocation.invocationId)).toBe(1);
      const events = (await fixture.store.inspect()).events;
      const started = events.find((candidate) => candidate.eventType === "executor.started");
      const finished = events.find((candidate) => candidate.eventType === "executor.finished");
      expect(started).toBeDefined();
      expect(finished).toBeDefined();
      expect(started!.sequence).toBeLessThan(finished!.sequence);
      const resumed = await executeAuthorizedInvocationV2({ leasedRun: authorized.resumed, plan: fixture.document, runtime, nonceFactory: nonce, eventIdFactory: () => `b4-event-${++nonceOrdinal}` });
      expect(resumed.kind).toBe("EXECUTOR_FINISHED_READY_FOR_CAPTURE");
      expect(runtime.getInvocationAttempts(authorized.result.invocation.invocationId)).toBe(1);
      expect((await fixture.store.inspect()).events.filter((candidate) => candidate.eventType === "executor.started")).toHaveLength(1);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("closes unavailable, protocol-invalid, and pre-start cancellation without started/finished", async () => {
    for (const [prefix, runId, scenario, expected] of [
      ["rb-ralph-b4-unavailable-", "run-b4-unavailable", { kind: "UNAVAILABLE_BEFORE_START" as const }, "EXECUTOR_UNAVAILABLE" as const],
      ["rb-ralph-b4-protocol-", "run-b4-protocol", { kind: "PROTOCOL_FAILURE_BEFORE_START" as const }, "EXECUTOR_PROTOCOL_FAILURE" as const],
    ] as const) {
      const fixture = await fixtureRoot(prefix, runId);
      try {
        const authorized = await authorize(fixture);
        const runtime = new ScriptedExecutor({ defaultScenario: scenario });
        const outcome = await executeAuthorizedInvocationV2({ leasedRun: authorized.resumed, plan: fixture.document, runtime, nonceFactory: nonce, eventIdFactory: () => `b4-event-${++nonceOrdinal}` });
        expect(outcome.kind).toBe(expected);
        expect(runtime.getInvocationAttempts(authorized.result.invocation.invocationId)).toBe(expected === "EXECUTOR_PROTOCOL_FAILURE" ? 1 : 1);
        const events = (await fixture.store.inspect()).events;
        expect(events.some((candidate) => candidate.eventType === "executor.started")).toBe(false);
        expect(events.some((candidate) => candidate.eventType === "executor.finished")).toBe(false);
        expect(events.find((candidate) => candidate.eventType === "attempt.closed")?.payload).toMatchObject({ closureReason: expected });
        expect((await inspectRunLeaseV2(fixture.store)).kind).toBe("ABSENT");
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    }

    const cancelledFixture = await fixtureRoot("rb-ralph-b4-cancel-before-start-", "run-b4-cancel-before-start");
    try {
      const authorized = await authorize(cancelledFixture);
      const runtime = new ScriptedExecutor({ defaultScenario: { kind: "SUCCESS" } });
      await runtime.requestCancel(authorized.result.invocation.invocationId);
      const outcome = await executeAuthorizedInvocationV2({ leasedRun: authorized.resumed, plan: cancelledFixture.document, runtime, nonceFactory: nonce, eventIdFactory: () => `b4-event-${++nonceOrdinal}` });
      expect(outcome.kind).toBe("EXECUTOR_CANCELLED");
      expect(runtime.getInvocationAttempts(authorized.result.invocation.invocationId)).toBe(0);
      const events = (await cancelledFixture.store.inspect()).events;
      expect(events.some((candidate) => candidate.eventType === "executor.started")).toBe(false);
      expect(events.some((candidate) => candidate.eventType === "executor.finished")).toBe(false);
    } finally {
      await rm(cancelledFixture.root, { recursive: true, force: true });
    }
  });

  it("keeps post-start protocol-invalid, timeout, and cancellation facts honest", async () => {
    const malformedFixture = await fixtureRoot("rb-ralph-b4-malformed-", "run-b4-malformed");
    try {
      const authorized = await authorize(malformedFixture);
      const runtime = new ScriptedExecutor({ defaultScenario: { kind: "MALFORMED_RESULT" } });
      const outcome = await executeAuthorizedInvocationV2({ leasedRun: authorized.resumed, plan: malformedFixture.document, runtime, nonceFactory: nonce, eventIdFactory: () => `b4-event-${++nonceOrdinal}` });
      expect(outcome.kind).toBe("EXECUTOR_FINISHED_READY_FOR_CAPTURE");
      if (outcome.kind === "EXECUTOR_FINISHED_READY_FOR_CAPTURE") expect(outcome.resultArtifact.resultEnvelopeStatus).toBe("INVALID");
      expect((await malformedFixture.store.inspect()).events.filter((candidate) => candidate.eventType === "executor.finished")).toHaveLength(1);
    } finally {
      await rm(malformedFixture.root, { recursive: true, force: true });
    }

    const timeoutFixture = await fixtureRoot("rb-ralph-b4-timeout-", "run-b4-timeout");
    try {
      const authorized = await authorize(timeoutFixture);
      const runtime = new ScriptedExecutor({ defaultScenario: { kind: "TIMEOUT" } });
      const outcome = await executeAuthorizedInvocationV2({ leasedRun: authorized.resumed, plan: timeoutFixture.document, runtime, nonceFactory: nonce, eventIdFactory: () => `b4-event-${++nonceOrdinal}` });
      expect(outcome.kind).toBe("EXECUTOR_FINISHED_READY_FOR_CAPTURE");
      expect((await timeoutFixture.store.inspect()).events.find((candidate) => candidate.eventType === "executor.finished")?.payload).toMatchObject({ status: "TIMED_OUT", termination: "TIMEOUT" });
    } finally {
      await rm(timeoutFixture.root, { recursive: true, force: true });
    }

    const cancelFixture = await fixtureRoot("rb-ralph-b4-cancel-", "run-b4-cancel");
    try {
      const authorized = await authorize(cancelFixture);
      const runtime = new ScriptedExecutor({ defaultScenario: { kind: "RUNNING" } });
      const running = await executeAuthorizedInvocationV2({ leasedRun: authorized.resumed, plan: cancelFixture.document, runtime, nonceFactory: nonce, eventIdFactory: () => `b4-event-${++nonceOrdinal}` });
      expect(running.kind).toBe("EXECUTOR_RUNNING");
      await runtime.requestCancel(authorized.result.invocation.invocationId);
      const finished = await executeAuthorizedInvocationV2({ leasedRun: authorized.resumed, plan: cancelFixture.document, runtime, nonceFactory: nonce, eventIdFactory: () => `b4-event-${++nonceOrdinal}` });
      expect(finished.kind).toBe("EXECUTOR_FINISHED_READY_FOR_CAPTURE");
      expect(runtime.getInvocationAttempts(authorized.result.invocation.invocationId)).toBe(1);
      expect((await cancelFixture.store.inspect()).events.find((candidate) => candidate.eventType === "executor.finished")?.payload).toMatchObject({ status: "CANCELLED", termination: "CANCELLED" });
    } finally {
      await rm(cancelFixture.root, { recursive: true, force: true });
    }
  });

  it("requires quiescence after timeout/cancel and rejects the exact P10 caller lie", async () => {
    for (const [prefix, runId, scenario] of [
      ["rb-ralph-b4-timeout-unknown-", "run-b4-timeout-unknown", { kind: "TIMEOUT" as const, quiescence: "UNKNOWN" as const }],
      ["rb-ralph-b4-cancel-unknown-", "run-b4-cancel-unknown", { kind: "RUNNING" as const, quiescence: "UNKNOWN" as const }],
    ] as const) {
      const fixture = await fixtureRoot(prefix, runId);
      try {
        const authorized = await authorize(fixture);
        const runtime = new ScriptedExecutor({ defaultScenario: scenario });
        const first = await executeAuthorizedInvocationV2({ leasedRun: authorized.resumed, plan: fixture.document, runtime, nonceFactory: nonce, eventIdFactory: () => `b4-event-${++nonceOrdinal}` });
        if (scenario.kind === "RUNNING") {
          expect(first.kind).toBe("EXECUTOR_RUNNING");
          await runtime.requestCancel(authorized.result.invocation.invocationId);
          const afterCancel = await executeAuthorizedInvocationV2({ leasedRun: authorized.resumed, plan: fixture.document, runtime, nonceFactory: nonce, eventIdFactory: () => `b4-event-${++nonceOrdinal}` });
          expect(afterCancel.kind).toBe("RECONCILIATION_REQUIRED");
        } else {
          expect(first.kind).toBe("RECONCILIATION_REQUIRED");
        }
        expect(runtime.getInvocationAttempts(authorized.result.invocation.invocationId)).toBe(1);
        expect((await fixture.store.inspect()).events.map((candidate) => candidate.eventType)).toContain("attempt.reconciliation-required");
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    }

    const fixture = await fixtureRoot("rb-ralph-b4-proof-", "run-b4-proof");
    try {
      const authorized = await authorize(fixture);
      const runtime = new ScriptedExecutor({ defaultScenario: { kind: "RUNNING" } });
      const running = await executeAuthorizedInvocationV2({ leasedRun: authorized.resumed, plan: fixture.document, runtime, nonceFactory: nonce, eventIdFactory: () => `b4-event-${++nonceOrdinal}` });
      expect(running.kind).toBe("EXECUTOR_RUNNING");
      if (running.kind !== "EXECUTOR_RUNNING") throw new Error("P10 fixture did not remain running");
      await expect(deriveExecutorReleaseProofV2(authorized.resumed, running.observation, ["attempts/attempt-b4-001/work-unit.json"]))
        .rejects.toMatchObject({ code: "LEASE_RELEASE_EXTERNAL_INVOCATION_UNKNOWN" });
      const forgedReleaseRecord = {
        kind: "CORE_LEASE_RELEASE_PROOF" as const,
        proofId: "lrp-forged-p10",
        runId: fixture.store.runId,
        leaseId: authorized.resumed.leaseId,
        phaseId: "P01",
        taskId: "T001",
        attemptId: authorized.result.attempt.attempt.attemptId,
        invocationId: authorized.result.invocation.invocationId,
        runtimeIdentity: running.observation.runtimeIdentity,
        observationId: running.observation.observationId,
        observationDigest: running.observation.observationDigest,
        externalInvocationState: "TERMINATED_QUIESCENT" as const,
        semanticEventsDurable: "DURABLE",
        artifactWritesDurable: "DURABLE",
        leaseOwnership: "VERIFIED_CURRENT_OWNER",
        executorBoundaryState: "CROSSED" as const,
        artifactRefs: ["attempts/attempt-b4-001/work-unit.json"],
      };
      const forgedRelease = {
        record: forgedReleaseRecord,
        ...forgedReleaseRecord,
        toJSON: () => forgedReleaseRecord,
      } as unknown as LeaseReleaseProofV2;
      await expect(releaseLeasedRunV2(authorized.resumed, { proof: forgedRelease }))
        .rejects.toMatchObject({ code: "LEASE_RELEASE_PROOF_INVALID" });
      expect(isLeaseReleaseProofV2(forgedRelease)).toBe(false);
      expect((await inspectRunLeaseV2(fixture.store)).kind).toBe("PRESENT");
      const stillRunning = await runtime.observe(authorized.result.invocation.invocationId);
      expect(stillRunning.state).toBe("RUNNING");

      const unknownFixture = await fixtureRoot("rb-ralph-b4-release-unknown-", "run-b4-release-unknown");
      try {
        const unknownAuthorized = await authorize(unknownFixture);
        const unknownRuntime = new ScriptedExecutor({ defaultScenario: { kind: "UNKNOWN" } });
        const unknownOutcome = await executeAuthorizedInvocationV2({ leasedRun: unknownAuthorized.resumed, plan: unknownFixture.document, runtime: unknownRuntime, nonceFactory: nonce, eventIdFactory: () => `b4-event-${++nonceOrdinal}` });
        expect(unknownOutcome.kind).toBe("RECONCILIATION_REQUIRED");
        if (unknownOutcome.kind !== "RECONCILIATION_REQUIRED") throw new Error("unknown fixture did not reconcile");
        await expect(deriveExecutorReleaseProofV2(unknownAuthorized.resumed, unknownOutcome.observation, []))
          .rejects.toMatchObject({ code: "LEASE_RELEASE_EXTERNAL_INVOCATION_UNKNOWN" });
      } finally {
        await rm(unknownFixture.root, { recursive: true, force: true });
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects forged NOT_INVOKED observation/proof and stale recovery cannot steal a running lease", async () => {
    const fixture = await fixtureRoot("rb-ralph-b4-not-invoked-forgery-", "run-b4-not-invoked-forgery");
    try {
      const authorized = await authorize(fixture);
      const runtime = new ScriptedExecutor({ defaultScenario: { kind: "RUNNING" } });
      const running = await executeAuthorizedInvocationV2({ leasedRun: authorized.resumed, plan: fixture.document, runtime, nonceFactory: nonce, eventIdFactory: () => `b4-event-${++nonceOrdinal}` });
      expect(running.kind).toBe("EXECUTOR_RUNNING");
      if (running.kind !== "EXECUTOR_RUNNING") throw new Error("NOT_INVOKED forgery fixture did not run");
      const actualNotInvokedProof = running.notInvokedProof;
      if (!actualNotInvokedProof) throw new Error("NOT_INVOKED proof was not returned");
      expect(isTrustedExecutorObservationV2(JSON.parse(JSON.stringify(running.observation)))).toBe(false);
      expect(isNotInvokedProofV2(JSON.parse(JSON.stringify(actualNotInvokedProof)))).toBe(false);

      const fakeRuntime = {
        kind: "EXECUTOR_RUNTIME" as const,
        runtimeIdentity: "forged-not-invoked-runtime",
        observe: async () => buildExecutorObservationEnvelopeV2({
          runtimeIdentity: "forged-not-invoked-runtime",
          observationId: "forged-not-invoked-observation",
          invocationId: authorized.result.invocation.invocationId,
          state: "NOT_INVOKED",
          observedAt: "2026-09-06T05:00:35.000Z",
        }),
        invoke: async () => ({ invocationId: authorized.result.invocation.invocationId, runtimeIdentity: "forged-not-invoked-runtime", acceptedAt: "2026-09-06T05:00:35.000Z", physicalStart: "NOT_STARTED" as const }),
        requestCancel: async () => ({ requestId: "forged-cancel", invocationId: authorized.result.invocation.invocationId, runtimeIdentity: "forged-not-invoked-runtime", requestedAt: "2026-09-06T05:00:35.000Z", requestState: "ISSUED" as const }),
      };
      const deepExecution = await import("../../src/vnext/ralph-runtime/operational-b4/execution.js");
      expect(isTrustedExecutorRuntimeV2(fakeRuntime)).toBe(false);
      await expect(deepExecution.observeTrustedExecutorInvocationV2(fakeRuntime as never, authorized.result.authorizedInvocation))
        .rejects.toMatchObject({ code: "B4_EXECUTOR_AUTHORIZATION_REQUIRED" });

      const forgedObservationRecord = {
        ...running.observation.record,
        state: "NOT_INVOKED" as const,
      } as unknown as TrustedExecutorObservationV2["record"];
      delete (forgedObservationRecord as unknown as Record<string, unknown>).startedAt;
      delete (forgedObservationRecord as unknown as Record<string, unknown>).startedObservationId;
      const forgedObservation = {
        kind: "TRUSTED_EXECUTOR_OBSERVATION" as const,
        record: forgedObservationRecord,
        runtimeIdentity: running.observation.runtimeIdentity,
        observationId: running.observation.observationId,
        invocationId: running.observation.invocationId,
        state: "NOT_INVOKED" as const,
        observedAt: running.observation.observedAt,
        safeMetadata: running.observation.safeMetadata,
        observationDigest: running.observation.observationDigest,
      } as unknown as TrustedExecutorObservationV2;
      expect(isTrustedExecutorObservationV2(forgedObservation)).toBe(false);
      expect(() => deriveNotInvokedProofV2(forgedObservation, authorized.result.authorizedInvocation))
        .toThrow("RALPH_EXECUTOR_OBSERVATION_TRUST_REQUIRED");

      const forgedProofRecord = {
        kind: "NOT_INVOKED" as const,
        proofId: "nip-forged",
        runId: fixture.store.runId,
        phaseId: "P01",
        taskId: "T001",
        attemptId: authorized.result.attempt.attempt.attemptId,
        invocationId: authorized.result.invocation.invocationId,
        runtimeIdentity: running.observation.runtimeIdentity,
        observationId: running.observation.observationId,
        observationDigest: running.observation.observationDigest,
      };
      const forgedProof = {
        kind: "NOT_INVOKED" as const,
        record: forgedProofRecord,
        toJSON: () => forgedProofRecord,
      } as unknown as NotInvokedProofV2;
      expect(isNotInvokedProofV2(forgedProof)).toBe(false);
      const recoveryIdentity: ProcessIdentity = { ...ownerIdentity, pid: ownerIdentity.pid + 1, processStartIdentity: "recovery-process" };
      const staleProvider: ProcessIdentityProvider = {
        current: () => recoveryIdentity,
        inspect: (identity) => identity.pid === ownerIdentity.pid ? "START_MISMATCH" : "MATCH",
      };
      await expect(recoverStaleRunLeaseV2({
        ...leaseInput(fixture, { processIdentityProvider: staleProvider }),
        notInvokedProof: forgedProof,
        runtimeInstanceId: "recovery-runtime",
        recoveryIdFactory: () => "recovery-forged-nip",
        recoveryTokenFactory: () => Buffer.from("recovery-token-16"),
        nonceFactory: () => "recovery-nonce",
      })).rejects.toMatchObject({ code: "LEASE_RECONCILIATION_REQUIRED" });
      expect((await inspectRunLeaseV2(fixture.store)).kind).toBe("PRESENT");
      await expect(runtime.invoke(authorized.result.authorizedInvocation)).rejects.toMatchObject({ code: "B4_EXECUTOR_REDISPATCH_FORBIDDEN" });
      expect(runtime.getInvocationAttempts(authorized.result.invocation.invocationId)).toBe(1);
      expect((await runtime.observe(authorized.result.invocation.invocationId)).state).toBe("RUNNING");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a structural NOT_INVOKED proof at EXECUTOR_DISPATCH_AUTHORIZED after stale-owner proof", async () => {
    const fixture = await fixtureRoot("rb-ralph-b4-not-invoked-stage-forgery-", "run-b4-not-invoked-stage-forgery");
    try {
      const authorized = await authorize(fixture);
      const attempt = authorized.resumed.state.attempts[authorized.result.attempt.attempt.attemptId];
      expect(attempt?.disposition).toBe("OPEN");
      expect(attempt?.stage).toBe("EXECUTOR_DISPATCH_AUTHORIZED");

      const runtime = new ScriptedExecutor({ runtimeIdentity: "stage-forgery-runtime", clock: () => "2026-09-06T05:00:35.000Z" });
      const deepExecution = await import("../../src/vnext/ralph-runtime/operational-b4/execution.js");
      const observation = await deepExecution.observeTrustedExecutorInvocationV2(runtime, authorized.result.authorizedInvocation);
      expect(observation.state).toBe("NOT_INVOKED");
      const genuineProof = deriveNotInvokedProofV2(observation, authorized.result.authorizedInvocation);
      const forgedRecord = { ...genuineProof.record };
      const forgedProof = {
        ...forgedRecord,
        record: forgedRecord,
        toJSON: () => forgedRecord,
      } as unknown as NotInvokedProofV2;
      expect(isNotInvokedProofV2(forgedProof)).toBe(false);
      expect(forgedProof.record).toEqual(genuineProof.record);

      const recoveryIdentity: ProcessIdentity = { ...ownerIdentity, pid: ownerIdentity.pid + 1, processStartIdentity: "stage-forgery-recovery" };
      let staleOwnerInspections = 0;
      const staleProvider: ProcessIdentityProvider = {
        current: () => recoveryIdentity,
        inspect: (identity) => {
          if (identity.pid === ownerIdentity.pid) {
            staleOwnerInspections += 1;
            return "START_MISMATCH";
          }
          return "MATCH";
        },
      };
      await expect(recoverStaleRunLeaseV2({
        ...leaseInput(fixture, { processIdentityProvider: staleProvider }),
        notInvokedProof: forgedProof,
        runtimeInstanceId: "stage-forgery-recovery-runtime",
        recoveryIdFactory: () => "stage-forgery-recovery",
        recoveryTokenFactory: () => Buffer.from("stage-forgery-token"),
        nonceFactory: () => "stage-forgery-nonce",
      })).rejects.toMatchObject({
        code: "LEASE_RECONCILIATION_REQUIRED",
        message: expect.stringContaining("NOT_INVOKED proof is required"),
      });
      expect(staleOwnerInspections).toBeGreaterThan(0);
      expect((await inspectRunLeaseV2(fixture.store)).kind).toBe("PRESENT");
      expect(runtime.getInvocationAttempts(authorized.result.invocation.invocationId)).toBe(0);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("recovers at EXECUTOR_DISPATCH_AUTHORIZED with a genuine sealed NOT_INVOKED proof", async () => {
    const fixture = await fixtureRoot("rb-ralph-b4-not-invoked-stage-genuine-", "run-b4-not-invoked-stage-genuine");
    try {
      const authorized = await authorize(fixture);
      const attempt = authorized.resumed.state.attempts[authorized.result.attempt.attempt.attemptId];
      expect(attempt?.disposition).toBe("OPEN");
      expect(attempt?.stage).toBe("EXECUTOR_DISPATCH_AUTHORIZED");

      const runtime = new ScriptedExecutor({ runtimeIdentity: "stage-genuine-runtime", clock: () => "2026-09-06T05:00:36.000Z" });
      const deepExecution = await import("../../src/vnext/ralph-runtime/operational-b4/execution.js");
      const observation = await deepExecution.observeTrustedExecutorInvocationV2(runtime, authorized.result.authorizedInvocation);
      const genuineProof = deriveNotInvokedProofV2(observation, authorized.result.authorizedInvocation);
      expect(observation.state).toBe("NOT_INVOKED");
      expect(isNotInvokedProofV2(genuineProof)).toBe(true);

      const recoveryIdentity: ProcessIdentity = { ...ownerIdentity, pid: ownerIdentity.pid + 2, processStartIdentity: "stage-genuine-recovery" };
      const staleProvider: ProcessIdentityProvider = {
        current: () => recoveryIdentity,
        inspect: (identity) => identity.pid === ownerIdentity.pid ? "START_MISMATCH" : "MATCH",
      };
      const recovered = await recoverStaleRunLeaseV2({
        ...leaseInput(fixture, { processIdentityProvider: staleProvider }),
        notInvokedProof: genuineProof,
        runtimeInstanceId: "stage-genuine-recovery-runtime",
        recoveryIdFactory: () => "stage-genuine-recovery",
        recoveryTokenFactory: () => Buffer.from("stage-genuine-token"),
        nonceFactory: () => "stage-genuine-nonce",
      });
      expect(recovered.kind).toBe("RECOVERED");
      expect(recovered.leasedRun.processIdentity).toEqual(recoveryIdentity);
      expect(recovered.leasedRun.state.attempts[authorized.result.attempt.attempt.attemptId]?.stage).toBe("EXECUTOR_DISPATCH_AUTHORIZED");
      expect(runtime.getInvocationAttempts(authorized.result.invocation.invocationId)).toBe(0);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("stops when executor.started durability is unknown and never advances to finish", async () => {
    const fixture = await fixtureRoot("rb-ralph-b4-start-durability-", "run-b4-start-durability");
    try {
      const faultyFileSystem = failOnceAfterMarker('"eventType":"executor.started"');
      const authorized = await authorize(fixture, faultyFileSystem);
      const runtime = new ScriptedExecutor({ defaultScenario: { kind: "SUCCESS" } });
      await expect(executeAuthorizedInvocationV2({ leasedRun: authorized.resumed, plan: fixture.document, runtime, nonceFactory: nonce, eventIdFactory: () => `b4-event-${++nonceOrdinal}` })).rejects.toMatchObject({ code: "B4_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION" });
      expect(runtime.getInvocationAttempts(authorized.result.invocation.invocationId)).toBe(1);
      const events = (await fixture.store.inspect()).events;
      expect(events.filter((candidate) => candidate.eventType === "executor.started")).toHaveLength(1);
      expect(events.filter((candidate) => candidate.eventType === "executor.finished")).toHaveLength(0);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("stops when invocation-result durability is unknown before executor.finished", async () => {
    const fixture = await fixtureRoot("rb-ralph-b4-result-durability-", "run-b4-result-durability");
    try {
      const faultyFileSystem = failOnceAfterMarker("rb-ralph-executor-result/v1", "/attempts/attempt-b4-001");
      const authorized = await authorize(fixture, faultyFileSystem);
      const runtime = new ScriptedExecutor({ defaultScenario: { kind: "SUCCESS" } });
      await expect(executeAuthorizedInvocationV2({ leasedRun: authorized.resumed, plan: fixture.document, runtime, nonceFactory: nonce, eventIdFactory: () => `b4-event-${++nonceOrdinal}` })).rejects.toMatchObject({ code: "B4_ARTIFACT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION" });
      const events = (await fixture.store.inspect()).events;
      expect(events.filter((candidate) => candidate.eventType === "executor.started")).toHaveLength(1);
      expect(events.filter((candidate) => candidate.eventType === "executor.finished")).toHaveLength(0);
      expect(runtime.getInvocationAttempts(authorized.result.invocation.invocationId)).toBe(1);
      await expect(releaseLeasedRunV2(authorized.resumed)).rejects.toMatchObject({ code: "LEASE_RELEASE_PROOF_REQUIRED" });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps production authority surfaces on an explicit reviewed export allowlist", async () => {
    const surfaces = {
      b2: await import("../../src/vnext/ralph-runtime/operational-b2/index.js"),
      b2RunLease: await import("../../src/vnext/ralph-runtime/operational-b2/run-lease.js"),
      b3: await import("../../src/vnext/ralph-runtime/operational-b3/index.js"),
      b3Admission: await import("../../src/vnext/ralph-runtime/operational-b3/admission.js"),
      b4: await import("../../src/vnext/ralph-runtime/operational-b4/index.js"),
      b4Execution: await import("../../src/vnext/ralph-runtime/operational-b4/execution.js"),
      b4Observation: await import("../../src/vnext/ralph-runtime/operational-b4/execution-observation.js"),
      b4Runtime: await import("../../src/vnext/ralph-runtime/operational-b4/executor-runtime.js"),
      b4Scripted: await import("../../src/vnext/ralph-runtime/operational-b4/scripted-executor.js"),
      m4aArtifacts: await import("../../src/vnext/ralph-runtime/operational-b4/provider-invocation-artifacts.js"),
      m4aObserver: await import("../../src/vnext/ralph-runtime/operational-b4/opencode-cli-observer.js"),
      c: await import("../../src/vnext/ralph-runtime/operational-c/index.js"),
      cEvidence: await import("../../src/vnext/ralph-runtime/operational-c/evidence.js"),
      root: await import("../../src/vnext/ralph-runtime/index.js"),
    };
    const reviewedExports: Record<string, readonly string[]> = {
      b2: [
        "LeaseReleaseProofV2", "LeasedRunV2", "LinuxProcessIdentityProvider", "PROCESS_IDENTITY_INSPECTIONS", "ProcessIdentityError",
        "RALPH_RECOVERY_CLAIM_SCHEMA_V2", "RALPH_RUN_LEASE_HEARTBEAT_DISABLED", "RALPH_RUN_LEASE_SCHEMA_V2", "RUN_LEASE_ERROR_CODES", "RalphRunLeaseError",
        "acquireLeasedRunV2", "acquireRunLeaseV2", "assertLeaseReleaseProofV2", "assertLeasedRunV2", "defaultProcessIdentityProvider",
        "deriveExecutorReleaseProofV2", "derivePreExecutorReleaseProofV2", "inspectRecoveryClaimV2", "inspectRunLeaseV2", "isLeaseReleaseProofV2",
        "isLeasedRunV2", "leasePathsForStore", "nodeProcessIdentityProvider", "readRunLeaseV2", "recoverRunLeaseV2", "recoverStaleRunLeaseV2",
        "refreshLeasedRunV2", "releaseLeasedRunV2", "releaseRunLeaseV2", "repairStateSnapshotV2", "repairStateSnapshotWhileLeasedV2",
        "revalidateLeaseOwnershipV2", "revalidateLeasedRunV2", "runLeasePathsV2", "verifyLeasedRunV2",
      ],
      b2RunLease: [
        "LeaseReleaseProofV2", "LeasedRunV2", "RALPH_RECOVERY_CLAIM_SCHEMA_V2", "RALPH_RUN_LEASE_HEARTBEAT_DISABLED", "RALPH_RUN_LEASE_SCHEMA_V2",
        "RUN_LEASE_ERROR_CODES", "RalphRunLeaseError", "acquireLeasedRunV2", "acquireRunLeaseV2", "assertLeaseReleaseProofV2", "assertLeasedRunV2",
        "deriveExecutorReleaseProofV2", "derivePreExecutorReleaseProofV2", "inspectRecoveryClaimV2", "inspectRunLeaseV2", "isLeaseReleaseProofV2",
        "isLeasedRunV2", "leasePathsForStore", "readRunLeaseV2", "recoverRunLeaseV2", "recoverStaleRunLeaseV2", "refreshLeasedRunV2",
        "releaseLeasedRunV2", "releaseRunLeaseV2", "repairStateSnapshotV2", "repairStateSnapshotWhileLeasedV2", "revalidateLeaseOwnershipV2",
        "revalidateLeasedRunV2", "runLeasePathsV2", "verifyLeasedRunV2",
      ],
      b3: [
        "ADMISSION_ERROR_CODES", "ARTIFACT_ERROR_CODES", "AuthorizedInvocationV2", "RALPH_INVOCATION_SCHEMA_V2", "RALPH_WORK_UNIT_SCHEMA_V2",
        "RalphAdmissionError", "RalphArtifactError", "assertAuthorizedInvocationV2", "createInvocationDescriptorV2", "createWorkUnitV2",
        "invocationBindingV2", "invocationDescriptorPathV2", "invocationIdForBindingV2", "isAuthorizedInvocationV2", "persistInvocationDescriptorV2",
        "persistWorkUnitV2", "prepareNextAuthorizedInvocationV2", "readInvocationDescriptorV2", "readWorkUnitV2", "reopenAuthorizedInvocationV2",
        "validateInvocationDescriptorV2", "validateWorkUnitV2", "workUnitPathV2",
      ],
      b3Admission: ["ADMISSION_ERROR_CODES", "AuthorizedInvocationV2", "RalphAdmissionError", "assertAuthorizedInvocationV2", "isAuthorizedInvocationV2", "prepareNextAuthorizedInvocationV2", "reopenAuthorizedInvocationV2"],
      b4: [
        "B4_ARTIFACT_ERROR_CODES", "B4_EXECUTION_ERROR_CODES", "EXECUTOR_BOUNDARY_STATES", "EXECUTOR_OBSERVATION_SCHEMA_V2", "EXECUTOR_OBSERVATION_STATES",
        "EXECUTOR_RESULT_ENVELOPE_STATUSES", "EXECUTOR_RUNTIME_ERROR_CODES", "ExecutorRuntimeError", "ExecutorRuntimeV2", "LEASE_OWNERSHIP_STATES", "M4A_ERROR_CODES", "M4B_ERROR_CODES", "M4B_TIMEOUT_POLICY_SCHEMA_V2",
        "OPENCODE_CLI_CONFORMANCE_STATES_V2", "OPENCODE_CLI_EXECUTOR_MODEL_ID_V2", "OPENCODE_CLI_EXECUTOR_MODEL_V2", "OPENCODE_CLI_EXECUTOR_PATH_V2", "OPENCODE_CLI_EXECUTOR_PROFILE_V2", "OPENCODE_CLI_EXECUTOR_PROVIDER_V2", "OPENCODE_CLI_EXECUTOR_TRANSPORT_VERSION_V2", "OPENCODE_SESSION_ACTIVITY_STATES_V2", "OPENCODE_SESSION_IDENTITY_STATES_V2", "OPENCODE_SESSION_MESSAGE_STATES_V2", "OPENCODE_SESSION_MODEL_STATES_V2",
        "OPENCODE_SESSION_RESULT_STATES_V2", "OpenCodeCliExecutorV2", "OpenCodeCliInvocationObserverV2", "PROVIDER_PROCESS_TREE_STATES_V2", "PROVIDER_TERMINAL_PROCESS_STATES_V2",
        "RALPH_EXECUTOR_RESULT_SCHEMA_V2", "RALPH_PROVIDER_DISPATCH_INTENT_SCHEMA_V2", "RALPH_PROVIDER_INVOCATION_DESCRIPTOR_SCHEMA_V2",
        "RALPH_PROVIDER_SESSION_BINDING_SCHEMA_V2", "RALPH_PROVIDER_TERMINAL_SCHEMA_V2", "RALPH_PROVIDER_WORKER_RECEIPT_SCHEMA_V2",
        "RALPH_WORKSPACE_MANIFEST_SCHEMA_V2", "RalphB4ArtifactError", "RalphB4ExecutionError", "RalphM4AError", "RalphM4BError", "SCRIPTED_SCENARIO_KINDS",
        "ScriptedExecutor", "assertNotInvokedProofV2", "assertObservationForInvocation", "assertRuntimeObservation", "assertSafeArtifactRefV2",
        "assertTrustedExecutorObservationV2", "assertTrustedExecutorRuntimeV2", "assertTrustedOpenCodeCliExecutorV2", "assertTrustedOpenCodeCliInvocationObserverV2", "attemptArtifactPathV2", "attemptArtifactRefV2",
        "buildExecutorObservationEnvelopeV2", "canonicalExecutorObservationV2", "createInvocationResultV2", "createProviderDispatchIntentV2",
        "createProviderInvocationDescriptorV2", "createProviderSessionBindingV2", "createProviderTerminalArtifactV2", "createProviderWorkerReceiptV2",
        "createM4BTimeoutPolicyV2", "createOpenCodeCliExecutorV2", "createWorkspaceManifestV2", "deriveNotInvokedProofV2",
        "ensureAttemptArtifactDirectoryV2", "executeAuthorizedInvocationV2", "executeScriptedInvocationV2", "invocationResultRefV2", "isNotInvokedProofV2",
        "isQuiescentObservation", "isTrustedExecutorObservationV2", "isTrustedExecutorRuntimeV2", "isTrustedOpenCodeCliExecutorV2", "isTrustedOpenCodeCliInvocationObserverV2", "loadExactConformanceRecordV2", "observationState", "observeWorkspaceManifestV2",
        "persistImmutableJsonArtifactV2", "persistInvocationResultV2", "persistProviderDispatchIntentV2", "persistProviderInvocationDescriptorV2",
        "persistProviderSessionBindingV2", "persistProviderTerminalArtifactV2", "persistProviderWorkerReceiptV2", "persistWorkspaceAfterManifestV2", "persistWorkspaceBeforeManifestV2",
        "providerDispatchIntentRefV2", "providerInvocationDescriptorRefV2", "providerSessionBindingRefV2", "providerTerminalRefV2", "providerWorkerReceiptRefV2",
        "readImmutableJsonArtifactV2", "readInvocationResultV2", "readProviderDispatchIntentV2", "readProviderInvocationArtifactSetV2",
        "readProviderInvocationDescriptorV2", "readProviderSessionBindingV2", "readProviderTerminalArtifactV2", "readProviderWorkerReceiptV2",
        "readWorkspaceAfterManifestV2", "readWorkspaceBeforeManifestV2", "runAuthorizedInvocationV2", "validateExecutorObservationEnvelopeV2", "validateInvocationResultV2",
        "validateProviderDispatchIntentV2", "validateProviderInvocationDescriptorV2", "validateProviderSessionBindingV2", "validateProviderTerminalArtifactV2",
        "validateM4BTimeoutPolicyV2", "validateProviderWorkerReceiptV2", "validateWorkspaceManifestV2", "workspaceAfterRefV2", "workspaceBeforeRefV2",
        "workspaceManifestCoreJson", "workspaceManifestEntries",
        // M4-C correction admission and the correction-aware prompt projection.
        "M4C_ERROR_CODES", "MAX_OPENCODE_CORRECTION_FINDINGS_V2", "MAX_OPENCODE_EXECUTOR_PROMPT_BYTES_V2", "RalphM4CError",
        "authoritativeOpenFindingsForTaskV2", "authoritativeRejectedAttemptsForTaskV2", "buildExactCorrectionContextV2",
        "deriveDurableCorrectionAuthorityV2", "projectCorrectionSectionV2", "projectWorkUnitToOpenCodePromptV2",
        "validateExactCorrectionContextForDispatchV2",
      ],
      b4Execution: [
        "B4_EXECUTION_ERROR_CODES", "RalphB4ExecutionError", "assertNotInvokedProofV2", "assertTrustedExecutorObservationV2", "deriveNotInvokedProofV2",
        "executeAuthorizedInvocationV2", "executeScriptedInvocationV2", "isNotInvokedProofV2", "isTrustedExecutorObservationV2",
        "observeTrustedExecutorInvocationV2", "runAuthorizedInvocationV2",
      ],
      b4Observation: [
        "EXECUTOR_BOUNDARY_STATES", "EXECUTOR_OBSERVATION_SCHEMA_V2", "EXECUTOR_OBSERVATION_STATES", "EXECUTOR_RESULT_ENVELOPE_STATUSES",
        "LEASE_OWNERSHIP_STATES", "buildExecutorObservationEnvelopeV2", "canonicalExecutorObservationV2", "validateExecutorObservationEnvelopeV2",
      ],
      b4Runtime: ["EXECUTOR_RUNTIME_ERROR_CODES", "ExecutorRuntimeError", "ExecutorRuntimeV2", "assertObservationForInvocation", "assertRuntimeObservation", "isQuiescentObservation", "observationState"],
      b4Scripted: ["SCRIPTED_SCENARIO_KINDS", "ScriptedExecutor", "assertTrustedExecutorRuntimeV2", "isTrustedExecutorRuntimeV2"],
      m4aArtifacts: [
        "M4A_ERROR_CODES", "OPENCODE_CLI_CONFORMANCE_STATES_V2", "PROVIDER_TERMINAL_PROCESS_STATES_V2", "RALPH_PROVIDER_DISPATCH_INTENT_SCHEMA_V2",
        "RALPH_PROVIDER_INVOCATION_DESCRIPTOR_SCHEMA_V2", "RALPH_PROVIDER_SESSION_BINDING_SCHEMA_V2", "RALPH_PROVIDER_TERMINAL_SCHEMA_V2",
        "RALPH_PROVIDER_WORKER_RECEIPT_SCHEMA_V2", "RalphM4AError", "createProviderDispatchIntentV2", "createProviderInvocationDescriptorV2",
        "createProviderSessionBindingV2", "createProviderTerminalArtifactV2", "createProviderWorkerReceiptV2", "persistProviderDispatchIntentV2",
        "persistProviderInvocationDescriptorV2", "persistProviderSessionBindingV2", "persistProviderTerminalArtifactV2", "persistProviderWorkerReceiptV2",
        "providerDispatchIntentRefV2", "providerInvocationDescriptorRefV2", "providerSessionBindingRefV2", "providerTerminalRefV2",
        "providerWorkerReceiptRefV2", "readProviderDispatchIntentV2", "readProviderInvocationArtifactSetV2", "readProviderInvocationDescriptorV2",
        "readProviderSessionBindingV2", "readProviderTerminalArtifactV2", "readProviderWorkerReceiptV2", "validateProviderDispatchIntentV2",
        "validateProviderInvocationDescriptorV2", "validateProviderSessionBindingV2", "validateProviderTerminalArtifactV2", "validateProviderWorkerReceiptV2",
      ],
      m4aObserver: [
        "OPENCODE_SESSION_ACTIVITY_STATES_V2", "OPENCODE_SESSION_IDENTITY_STATES_V2", "OPENCODE_SESSION_MESSAGE_STATES_V2", "OPENCODE_SESSION_MODEL_STATES_V2",
        "OPENCODE_SESSION_RESULT_STATES_V2", "OpenCodeCliInvocationObserverV2", "PROVIDER_PROCESS_TREE_STATES_V2",
        "assertTrustedOpenCodeCliInvocationObserverV2", "isTrustedOpenCodeCliInvocationObserverV2",
      ],
      c: ["C_EVIDENCE_ERROR_CODES", "EVIDENCE_CAPTURE_SCHEMA_V2", "EVIDENCE_CHANGE_KINDS", "RalphCEvidenceError", "captureEvidenceV2", "createEvidenceCaptureV2", "deriveWorkspaceChangesV2", "evidenceCaptureRefV2", "persistEvidenceCaptureV2", "readEvidenceCaptureV2", "runEvidenceCaptureV2", "validateEvidenceCaptureV2"],
      cEvidence: ["C_EVIDENCE_ERROR_CODES", "EVIDENCE_CAPTURE_SCHEMA_V2", "EVIDENCE_CHANGE_KINDS", "RalphCEvidenceError", "captureEvidenceV2", "createEvidenceCaptureV2", "deriveWorkspaceChangesV2", "evidenceCaptureRefV2", "persistEvidenceCaptureV2", "readEvidenceCaptureV2", "runEvidenceCaptureV2", "validateEvidenceCaptureV2"],
      root: [
        "B4_ARTIFACT_ERROR_CODES", "B4_EXECUTION_ERROR_CODES", "C_EVIDENCE_ERROR_CODES", "EVIDENCE_CAPTURE_SCHEMA_V2", "EVIDENCE_CHANGE_KINDS",
        "EXECUTOR_BOUNDARY_STATES", "EXECUTOR_OBSERVATION_SCHEMA_V2", "EXECUTOR_OBSERVATION_STATES", "EXECUTOR_RESULT_ENVELOPE_STATUSES",
        "EXECUTOR_RUNTIME_ERROR_CODES", "ExecutorRuntimeError", "ExecutorRuntimeV2", "FINDING_STATUSES", "LEASE_OWNERSHIP_STATES", "M4A_ERROR_CODES", "M4B_ERROR_CODES", "M4B_TIMEOUT_POLICY_SCHEMA_V2",
        "OPENCODE_CLI_CONFORMANCE_STATES_V2", "OPENCODE_CLI_EXECUTOR_MODEL_ID_V2", "OPENCODE_CLI_EXECUTOR_MODEL_V2", "OPENCODE_CLI_EXECUTOR_PATH_V2", "OPENCODE_CLI_EXECUTOR_PROFILE_V2", "OPENCODE_CLI_EXECUTOR_PROVIDER_V2", "OPENCODE_CLI_EXECUTOR_TRANSPORT_VERSION_V2", "OPENCODE_SESSION_ACTIVITY_STATES_V2", "OPENCODE_SESSION_IDENTITY_STATES_V2", "OPENCODE_SESSION_MESSAGE_STATES_V2", "OPENCODE_SESSION_MODEL_STATES_V2",
        "OPENCODE_SESSION_RESULT_STATES_V2", "OpenCodeCliExecutorV2", "OpenCodeCliInvocationObserverV2", "PROVIDER_PROCESS_TREE_STATES_V2", "PROVIDER_TERMINAL_PROCESS_STATES_V2", "PHASE_ACTIVITIES",
        "PHASE_DISPOSITIONS", "RALPH_EVENT_DIGITS", "RALPH_EVENT_MAX", "RALPH_EVENT_SCHEMA", "RALPH_EVENT_TYPES", "RALPH_EXECUTOR_RESULT_SCHEMA_V2",
        "RALPH_PROVIDER_DISPATCH_INTENT_SCHEMA_V2", "RALPH_PROVIDER_INVOCATION_DESCRIPTOR_SCHEMA_V2", "RALPH_PROVIDER_SESSION_BINDING_SCHEMA_V2",
        "RALPH_PROVIDER_TERMINAL_SCHEMA_V2", "RALPH_PROVIDER_WORKER_RECEIPT_SCHEMA_V2", "RALPH_STATE_SNAPSHOT_SCHEMA", "RALPH_WORKSPACE_MANIFEST_SCHEMA_V2",
        "RUN_DISPOSITIONS", "RUN_HOLDS", "RalphB4ArtifactError", "RalphB4ExecutionError", "RalphCEvidenceError", "RalphEventStore", "RalphEventStoreError",
        "RalphM4AError", "RalphM4BError", "RalphStateSnapshotError", "SCRIPTED_SCENARIO_KINDS",
        "ScriptedExecutor", "TASK_ACTIVITIES", "TASK_DISPOSITIONS", "TASK_HOLDS", "TASK_OWNERS", "WORKSPACE_CONTROL_PLANE_ROOT", "WORKSPACE_FINGERPRINT_FORMAT", "WORKSPACE_FORBIDDEN_ROOTS", "activeTaskIds",
        "assertAttemptBaseFingerprint", "assertAuditBinding", "assertNotInvokedProofV2", "assertObservationForInvocation", "assertRunCombination",
        "assertRuntimeObservation", "assertSafeArtifactRefV2", "assertSha256Digest", "assertTaskState", "assertTrustedExecutorObservationV2",
        "assertTrustedExecutorRuntimeV2", "assertTrustedOpenCodeCliExecutorV2", "assertTrustedOpenCodeCliInvocationObserverV2", "attemptArtifactPathV2", "attemptArtifactRefV2", "auditMayApprove", "buildExecutorObservationEnvelopeV2",
        "canAuditorProposeFindingResolution", "canCompleteCurrentBudgetedOperation", "canCompleteRun", "canStartBudgetedOperation", "canonicalEventBytes",
        "canonicalExecutorObservationV2", "canonicalJson", "canonicalJsonBytes", "captureEvidenceV2", "commitRalphEvent", "createEvidenceCaptureV2",
        "createInitialRuntimeState", "createInvocationResultV2", "createProviderDispatchIntentV2", "createProviderInvocationDescriptorV2",
        "createProviderSessionBindingV2", "createProviderTerminalArtifactV2", "createProviderWorkerReceiptV2", "createRalphEvent", "createStateSnapshot",
        "createM4BTimeoutPolicyV2", "createOpenCodeCliExecutorV2", "createWorkspaceManifestV2", "createWorkspacePolicy",
        "deriveAllPhases", "deriveBudgetUsage", "deriveLocalBlockingRunHold", "deriveNotInvokedProofV2", "derivePhaseState", "deriveWorkspaceChangesV2",
        "ensureAttemptArtifactDirectoryV2", "ensureRalphRuntimeLayout", "eventFileName", "evidenceCaptureRefV2", "executeAuthorizedInvocationV2",
        "executeScriptedInvocationV2", "expectedAttemptBaseFingerprint", "fingerprintWorkspace", "inspectRalphResume", "invocationResultRefV2", "isEventFileName",
        "isEventTempFileName", "isNotInvokedProofV2", "isQuiescentObservation", "isSha256Digest", "isTrustedExecutorObservationV2",
        "isTrustedExecutorRuntimeV2", "isTrustedOpenCodeCliExecutorV2", "isTrustedOpenCodeCliInvocationObserverV2", "isWorkspaceControlPlanePath", "isWorkspaceForbiddenPath", "loadExactConformanceRecordV2", "nodeRalphRuntimeFileSystem", "nodeWorkspaceFingerprintFileSystem", "observationState", "observeWorkspaceManifestV2",
        "persistEvidenceCaptureV2", "persistImmutableJsonArtifactV2", "persistImmutableRunSnapshot", "persistInvocationResultV2", "persistProviderDispatchIntentV2",
        "persistProviderInvocationDescriptorV2", "persistProviderSessionBindingV2", "persistProviderTerminalArtifactV2", "persistProviderWorkerReceiptV2", "persistStateSnapshot",
        "persistWorkspaceAfterManifestV2", "persistWorkspaceBeforeManifestV2", "phaseHasActiveTask", "phaseHasExecutableReadyTask", "phaseProgress",
        "projectPhase", "projectPhases", "projectRun", "projectTask", "projectTasks", "readEvidenceCaptureV2", "readImmutableJsonArtifactV2",
        "providerDispatchIntentRefV2", "providerInvocationDescriptorRefV2", "providerSessionBindingRefV2", "providerTerminalRefV2", "providerWorkerReceiptRefV2",
        "readInvocationResultV2", "readProviderDispatchIntentV2", "readProviderInvocationArtifactSetV2", "readProviderInvocationDescriptorV2",
        "readProviderSessionBindingV2", "readProviderTerminalArtifactV2", "readProviderWorkerReceiptV2", "readRunSnapshot", "readRuntimeFile", "readStateSnapshot", "readWorkspaceAfterManifestV2", "readWorkspaceBeforeManifestV2",
        "recomputePhaseState", "reduceRalphEvent", "replayFromRecords", "replayRalphRuntime", "resolveRalphRunDirectory", "runAuthorizedInvocationV2",
        "runEvidenceCaptureV2", "runHasEligibleWork", "runHasKnownBlockingCondition", "sha256", "sha256Canonical", "taskDependenciesSatisfied",
        "taskIsActive", "taskIsExecutableReady", "transitionFinding", "unsignedEventHash", "validateAuditBinding", "validateEvidenceCaptureV2",
        "validateExecutorObservationEnvelopeV2", "validateInvocationResultV2", "validateProviderDispatchIntentV2", "validateProviderInvocationDescriptorV2",
        "validateProviderSessionBindingV2", "validateProviderTerminalArtifactV2", "validateProviderWorkerReceiptV2", "validateRalphEvent", "validateRalphResume", "validateRalphRunId",
        "validateM4BTimeoutPolicyV2", "validateRunSnapshot", "validateSnapshotAgainstLedger", "validateWorkspaceManifestV2", "workspaceAfterRefV2", "workspaceBeforeRefV2",
        "workspaceManifestCoreJson", "workspaceManifestEntries", "writeAtomicRuntimeFile", "writeExclusiveRuntimeFile",
        // M4-C correction admission and the correction-aware prompt projection.
        "M4C_ERROR_CODES", "MAX_OPENCODE_CORRECTION_FINDINGS_V2", "MAX_OPENCODE_EXECUTOR_PROMPT_BYTES_V2", "RalphM4CError",
        "authoritativeOpenFindingsForTaskV2", "authoritativeRejectedAttemptsForTaskV2", "buildExactCorrectionContextV2",
        "deriveDurableCorrectionAuthorityV2", "projectCorrectionSectionV2", "projectWorkUnitToOpenCodePromptV2",
        "validateExactCorrectionContextForDispatchV2",
      ],
    };
    for (const [surface, module] of Object.entries(surfaces)) {
      expect(Object.keys(module).sort(), `${surface} export surface changed`).toEqual([...reviewedExports[surface]!].sort());
    }
  });

  it("structurally proves legacy M2/C stays process/provider-free and M4 uses only reviewed OpenCode boundaries", async () => {
    const roots = [
      resolve(TEST_DIRECTORY, "../../src/vnext/ralph-runtime/operational-b4"),
      resolve(TEST_DIRECTORY, "../../src/vnext/ralph-runtime/operational-c"),
    ];
    const entries = (await Promise.all(roots.map(async (root) => (await readdir(root, { recursive: true })).filter((entry) => entry.endsWith(".ts")).map((entry) => join(root, entry))))).flat().sort();
    expect(entries.length).toBeGreaterThan(0);
    const sources = await Promise.all(entries.map(async (entry) => ({ entry, source: await readFile(entry, "utf8") })));
    const m4Files = new Set([
      "provider-invocation-artifacts.ts", "opencode-cli-observer.ts", "opencode-cli-contract.ts", "opencode-cli-executor.ts",
      "opencode-cli-observable-turn.ts", "opencode-cli-process.ts", "opencode-cli-prompt.ts", "opencode-cli-result.ts", "opencode-cli-session-inspector.ts",
      "opencode-cli-transport-safety.ts", "opencode-cli-worker.ts", "provider-process-tree-inspector.ts", "scripted-executor.ts",
    ]);
    const legacySource = sources.filter(({ entry }) => !m4Files.has(entry.split("/").at(-1) ?? "")).map((item) => item.source).join("\n");
    for (const pattern of [/from\s+["']node:child_process["']/, /\b(?:spawn|exec|execFile|fork)\s*\(/, /provider\s+registry/i, /model\s+API/i]) {
      expect(legacySource).not.toMatch(pattern);
    }
    const processFiles = sources.filter(({ source }) => /from\s+["']node:child_process["']/.test(source)).map(({ entry }) => entry.split("/").at(-1));
    expect(processFiles).toEqual(["opencode-cli-process.ts"]);
    const m4aFiles = new Set(["provider-invocation-artifacts.ts", "opencode-cli-observer.ts"]);
    expect(legacySource).not.toMatch(/\b(?:Codex|Claude|OpenCode|OpenAI|Anthropic|DeepSeek|MiniMax)\b/);
    const m4aSource = sources.filter(({ entry }) => m4aFiles.has(entry.split("/").at(-1) ?? "")).map((item) => item.source).join("\n");
    expect(m4aSource).toContain("OpenCode");
    expect(m4aSource).not.toMatch(/\b(?:Codex|Claude|OpenAI|Anthropic|DeepSeek|MiniMax)\b/);
    expect(m4aSource).not.toMatch(/vnext\/providers\/(?!opencode\/profiles)/);
    const m4bSource = sources.filter(({ entry }) => m4Files.has(entry.split("/").at(-1) ?? "") && !m4aFiles.has(entry.split("/").at(-1) ?? "")).map((item) => item.source).join("\n");
    expect(m4bSource).toContain("OpenCode");
    expect(m4bSource).not.toMatch(/\b(?:Codex|Claude|OpenAI|Anthropic|MiniMax)\b/);
    expect(m4bSource).not.toMatch(/provider\s+registry|zen\/v1|openai\.com|anthropic\.com/i);
  });
});
