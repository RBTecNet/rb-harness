import { mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RALPH_EVENT_SCHEMA as RALPH_EVENT_SCHEMA_V1,
  RalphEventStore,
  createRalphEvent as createRalphEventV1,
  eventFileName,
  nodeRalphRuntimeFileSystem,
  type UnsignedRalphEvent as UnsignedRalphEventV1,
} from "../../src/vnext/ralph-runtime/index.js";
import {
  EVENT_SCHEMA_V2,
  OPERATIONAL_CONTRACT_V2,
  STATE_SCHEMA_V2,
  createInitialRuntimeStateV2,
  createRalphEventV2,
  parseValidationSpec,
  type EventPayloadMapV2,
  type RalphEventTypeV2,
  type RalphEventV2,
  type RalphRuntimeStateV2,
  type UnsignedRalphEventV2,
} from "../../src/vnext/ralph-runtime/operational-v2/index.js";
import {
  RALPH_RUN_SNAPSHOT_V2_SCHEMA,
  RALPH_STATE_SNAPSHOT_V2_SCHEMA,
  commitRalphEventV2,
  createRetryPolicyV1,
  createStateSnapshotV2,
  initializeOperationalRunV2,
  inspectOperationalRunV2,
  replayOperationalRunV2,
  persistRunSnapshotV2,
  persistRetryPolicyV1,
  persistStateSnapshotV2,
  readRunSnapshotV2,
  readRetryPolicyV1,
  retryPolicyDescriptorV1,
  readStateSnapshotV2,
  RalphEventStoreV2,
  validateRunSnapshotV2,
  type RunSnapshotV2,
  type RalphRetryPolicyV1,
} from "../../src/vnext/ralph-runtime/operational-b1/index.js";
import { canonicalJson } from "../../src/vnext/ralph-runtime/canonical-json.js";
import { createWorkspacePolicy, fingerprintWorkspace } from "../../src/vnext/ralph-runtime/fingerprint.js";
import { sha256, sha256Canonical } from "../../src/vnext/ralph-runtime/hashing.js";

const RUN_ID = "run-b1";
const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const TEST_MAX_TASK_ATTEMPTS = 4;
const TEST_VALIDATION_INFRA_RETRIES = 2;

type LifecycleEventContext = {
  readonly entityKind: "run" | "task" | "attempt" | "workspace";
  readonly entityId?: string;
  readonly phaseId?: string;
  readonly taskId?: string;
  readonly attemptId?: string;
};

function descriptor(schemaVersion: string, descriptorId: string): { schemaVersion: string; descriptorId: string; descriptorDigest: string } {
  const base = { schemaVersion, descriptorId };
  return { ...base, descriptorDigest: sha256Canonical(base) };
}

function retryPolicyFor(runId: string): RalphRetryPolicyV1 {
  return createRetryPolicyV1({
    runId,
    policyId: "retry-default",
    maxTaskAttemptsPerTask: TEST_MAX_TASK_ATTEMPTS,
    validationInfrastructureRetryLimit: TEST_VALIDATION_INFRA_RETRIES,
  });
}

async function snapshotFor(root: string, runId = RUN_ID): Promise<RunSnapshotV2> {
  const workspacePolicy = createWorkspacePolicy();
  const fingerprint = await fingerprintWorkspace(root, workspacePolicy);
  const config = descriptor("rb-ralph-config/v2", "b1-config");
  return {
    snapshotSchemaVersion: RALPH_RUN_SNAPSHOT_V2_SCHEMA,
    runId,
    eventSchema: EVENT_SCHEMA_V2,
    stateSchema: STATE_SCHEMA_V2,
    operationalContract: OPERATIONAL_CONTRACT_V2,
    projectIdentity: { projectId: "b1-test-project" },
    readyPlanIdentity: "ready-plan-b1",
    readyPlanHash: sha256("ready-plan"),
    readyManifestHash: sha256("ready-manifest"),
    selectedReadyArtifactHashes: { plan: sha256("ready-plan") },
    readinessInspectionDigest: sha256("readiness"),
    effectiveRunConfig: config,
    effectiveConfigDigest: config.descriptorDigest,
    diagnosticsPolicy: descriptor("rb-ralph-diagnostics/v2", "diagnostics-default"),
    environmentPolicy: descriptor("rb-ralph-environment/v2", "environment-default"),
    executorProfile: { profileId: "scripted-b1", kind: "scripted", descriptorDigest: sha256("scripted-profile") },
    executorCapabilities: { requested: ["fixture.effect"], granted: ["fixture.effect"], verified: ["fixture.effect"], readOnlyEnforced: false },
    permissionCapabilityPolicy: descriptor("rb-ralph-capabilities/v2", "scripted-fixture-policy"),
    workspacePolicy,
    initialWorkspaceFingerprint: {
      controlPlaneFingerprint: fingerprint.controlPlaneFingerprint,
      productWorkspaceFingerprint: fingerprint.productWorkspaceFingerprint,
      policyDigest: fingerprint.policyDigest,
      fingerprintDigest: fingerprint.fingerprintDigest,
    },
    retryPolicies: retryPolicyDescriptorV1(retryPolicyFor(runId)),
    timeoutPolicy: descriptor("rb-ralph-timeout/v2", "timeout-default"),
    runtimeIdentity: descriptor("rb-ralph-runtime/v2", "runtime-b1"),
    leasePolicy: descriptor("rb-ralph-lease/v2", "lease-future"),
    createdAt: "2026-09-05T04:00:00.000Z",
  };
}

function genesis(runId = RUN_ID): RalphRuntimeStateV2 {
  return createInitialRuntimeStateV2({ runId, phases: [], tasks: [] });
}

function event<TType extends RalphEventTypeV2>(
  state: RalphRuntimeStateV2,
  eventType: TType,
  payload: EventPayloadMapV2[TType],
): RalphEventV2 {
  return createRalphEventV2({
    eventId: `b1-${state.lastSequence + 1}-${eventType}`,
    eventType,
    schemaVersion: EVENT_SCHEMA_V2,
    runId: state.runId,
    sequence: state.lastSequence + 1,
    occurredAt: `2026-09-05T04:00:${String(state.lastSequence).padStart(2, "0")}.000Z`,
    recordedAt: `2026-09-05T04:00:${String(state.lastSequence).padStart(2, "0")}.100Z`,
    entity: { kind: "run", id: state.runId },
    actor: "CORE",
    causationId: null,
    correlationId: "b1-correlation",
    payload,
    previousEventHash: state.lastEventHash,
  } as UnsignedRalphEventV2<TType>) as RalphEventV2;
}

function runCreated(state: RalphRuntimeStateV2): RalphEventV2 {
  return event(state, "run.created", { phaseIds: state.phaseIds, taskIds: state.taskIds });
}

function runStarted(state: RalphRuntimeStateV2): RalphEventV2 {
  return event(state, "run.started", {});
}

function humanLifecycleGenesis(): RalphRuntimeStateV2 {
  return createInitialRuntimeStateV2({
    runId: RUN_ID,
    maxTaskAttemptsPerTask: TEST_MAX_TASK_ATTEMPTS,
    phases: [{ phaseId: "P01", taskIds: ["T001"] }],
    tasks: [{ taskId: "T001", phaseId: "P01", dependsOn: [] }],
  });
}

function humanLifecycleEvent<TType extends RalphEventTypeV2>(
  state: RalphRuntimeStateV2,
  eventType: TType,
  payload: EventPayloadMapV2[TType],
  context: LifecycleEventContext,
): RalphEventV2 {
  return createRalphEventV2({
    eventId: `b1-human-${state.lastSequence + 1}-${eventType}`,
    eventType,
    schemaVersion: EVENT_SCHEMA_V2,
    runId: state.runId,
    sequence: state.lastSequence + 1,
    occurredAt: `2026-09-05T04:10:${String(state.lastSequence).padStart(2, "0")}.000Z`,
    recordedAt: `2026-09-05T04:10:${String(state.lastSequence).padStart(2, "0")}.100Z`,
    entity: { kind: context.entityKind, id: context.entityId ?? context.attemptId ?? context.taskId ?? "workspace-1" },
    ...(context.phaseId === undefined ? {} : { phaseId: context.phaseId }),
    ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
    ...(context.attemptId === undefined ? {} : { attemptId: context.attemptId }),
    actor: "CORE",
    causationId: null,
    correlationId: "b1-human-correlation",
    payload,
    previousEventHash: state.lastEventHash,
  } as UnsignedRalphEventV2<TType>) as RalphEventV2;
}

async function initialized(root: string): Promise<{
  readonly store: RalphEventStoreV2;
  readonly snapshot: RunSnapshotV2;
  readonly genesis: RalphRuntimeStateV2;
  readonly result: Awaited<ReturnType<typeof initializeOperationalRunV2>>;
}> {
  const snapshot = await snapshotFor(root);
  const store = new RalphEventStoreV2({ projectRoot: root, runId: RUN_ID, nonce: () => "b1-nonce" });
  const initial = genesis();
  const result = await initializeOperationalRunV2({
    store,
    snapshot,
    retryPolicy: retryPolicyFor(snapshot.runId),
    genesisState: initial,
    runCreatedEvent: runCreated(initial),
    createdAt: "2026-09-05T04:00:01.000Z",
    nonce: "run-init",
  });
  return { store, snapshot, genesis: initial, result };
}

describe("Ralph Operational Core V2 — Slice B1 storage", () => {
  it("publishes the immutable RetryPolicy before RunSnapshot/run.created and cold-replays its Task budget", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b1-retry-policy-"));
    try {
      const publications: string[] = [];
      const fs = {
        ...nodeRalphRuntimeFileSystem,
        link: async (existingPath: string, newPath: string) => {
          publications.push(newPath);
          return nodeRalphRuntimeFileSystem.link(existingPath, newPath);
        },
      };
      const snapshot = await snapshotFor(root);
      const retryPolicy = retryPolicyFor(snapshot.runId);
      const initial = humanLifecycleGenesis();
      const store = new RalphEventStoreV2({ projectRoot: root, runId: snapshot.runId, fs });
      const initializedResult = await initializeOperationalRunV2({
        store,
        snapshot,
        retryPolicy,
        genesisState: initial,
        runCreatedEvent: humanLifecycleEvent(initial, "run.created", { phaseIds: initial.phaseIds, taskIds: initial.taskIds }, { entityKind: "run", entityId: RUN_ID }),
        createdAt: "2026-09-05T04:00:00.000Z",
        nonce: "retry-policy-order",
      });
      const retryIndex = publications.findIndex((path) => path.endsWith("/retry-policy.json"));
      const snapshotIndex = publications.findIndex((path) => path.endsWith("/run-snapshot.json"));
      const eventIndex = publications.findIndex((path) => path.includes("/events/"));
      expect(retryIndex).toBeGreaterThanOrEqual(0);
      expect(snapshotIndex).toBeGreaterThan(retryIndex);
      expect(eventIndex).toBeGreaterThan(snapshotIndex);
      expect((await stat(resolve(store.runDirectory, "retry-policy.json"))).mode & 0o7777).toBe(0o600);
      expect(await readRetryPolicyV1(store)).toEqual(retryPolicy);
      expect(initializedResult.state.tasks.T001?.executorBudget).toEqual({ used: 0, limit: TEST_MAX_TASK_ATTEMPTS, remaining: TEST_MAX_TASK_ATTEMPTS, exhausted: false, exceeded: false });

      const coldGenesis = humanLifecycleGenesis();
      const opened = await inspectOperationalRunV2({ projectRoot: root, runId: RUN_ID, genesisState: coldGenesis, externalFacts: { workspaceFingerprint: snapshot.initialWorkspaceFingerprint } });
      expect(opened.outcome).toBe("READY_FOR_LEASE");
      expect(opened.retryPolicy).toEqual(retryPolicy);
      expect(opened.state?.tasks.T001?.executorBudget).toEqual(coldGenesis.tasks.T001?.executorBudget);
      expect(await persistRetryPolicyV1(store, retryPolicy, "retry-policy-idempotent")).toBe("already-present");
      await expect(persistRetryPolicyV1(store, createRetryPolicyV1({ ...retryPolicy, maxTaskAttemptsPerTask: TEST_MAX_TASK_ATTEMPTS + 1 }), "retry-policy-conflict")).rejects.toMatchObject({ code: "RALPH_V2_RETRY_POLICY_IMMUTABLE_CONFLICT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when RetryPolicy is missing, symlinked, or does not match RunSnapshot", async () => {
    const missingRoot = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b1-retry-missing-"));
    try {
      const snapshot = await snapshotFor(missingRoot);
      const store = new RalphEventStoreV2({ projectRoot: missingRoot, runId: RUN_ID });
      await persistRunSnapshotV2(store, snapshot, "missing-policy-snapshot");
      const opened = await inspectOperationalRunV2({ projectRoot: missingRoot, runId: RUN_ID, genesisState: genesis() });
      expect(opened.outcome).toBe("FAILED_INTEGRITY");
      expect(opened.issues).toContain("RALPH_V2_RETRY_POLICY_MISSING");
    } finally {
      await rm(missingRoot, { recursive: true, force: true });
    }

    const unsafeRoot = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b1-retry-unsafe-"));
    try {
      const store = new RalphEventStoreV2({ projectRoot: unsafeRoot, runId: RUN_ID });
      await store.ensureLayout();
      const target = resolve(unsafeRoot, "outside-policy.json");
      await writeFile(target, canonicalJson(retryPolicyFor(RUN_ID)), { mode: 0o600 });
      await symlink(target, resolve(store.runDirectory, "retry-policy.json"));
      await expect(readRetryPolicyV1(store)).rejects.toMatchObject({ code: "RALPH_V2_RETRY_POLICY_PATH_UNSAFE" });
    } finally {
      await rm(unsafeRoot, { recursive: true, force: true });
    }

    const mismatchRoot = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b1-retry-mismatch-"));
    try {
      const { store, snapshot } = await initialized(mismatchRoot);
      const different = createRetryPolicyV1({ runId: RUN_ID, policyId: "retry-default", maxTaskAttemptsPerTask: TEST_MAX_TASK_ATTEMPTS + 1, validationInfrastructureRetryLimit: TEST_VALIDATION_INFRA_RETRIES });
      await writeFile(resolve(store.runDirectory, "retry-policy.json"), canonicalJson(different), { mode: 0o600 });
      const opened = await inspectOperationalRunV2({ projectRoot: mismatchRoot, runId: RUN_ID, genesisState: genesis(), externalFacts: { workspaceFingerprint: snapshot.initialWorkspaceFingerprint } });
      expect(opened.outcome).toBe("FAILED_INTEGRITY");
      expect(opened.issues).toContain("RALPH_V2_RETRY_POLICY_SNAPSHOT_MISMATCH");
    } finally {
      await rm(mismatchRoot, { recursive: true, force: true });
    }
  });

  it("physically persists and cold-replays the human resume without duplicating proofRef", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b1-human-resume-"));
    try {
      const initial = humanLifecycleGenesis();
      const snapshot = await snapshotFor(root);
      const store = new RalphEventStoreV2({ projectRoot: root, runId: RUN_ID, nonce: () => "b1-human-resume" });
      const runCreated = humanLifecycleEvent(initial, "run.created", { phaseIds: initial.phaseIds, taskIds: initial.taskIds }, { entityKind: "run", entityId: RUN_ID });
      const initializedResult = await initializeOperationalRunV2({
        store,
        snapshot,
        retryPolicy: retryPolicyFor(snapshot.runId),
        genesisState: initial,
        runCreatedEvent: runCreated,
        createdAt: "2026-09-05T04:10:00.000Z",
        nonce: "b1-human-init",
      });
      let state = initializedResult.state;
      const events: RalphEventV2[] = [runCreated];

      const push = async <TType extends RalphEventTypeV2>(
        eventType: TType,
        payload: EventPayloadMapV2[TType],
        context: LifecycleEventContext,
      ): Promise<void> => {
        const nextEvent = humanLifecycleEvent(state, eventType, payload, context);
        const committed = await commitRalphEventV2({
          store,
          state,
          event: nextEvent,
          writtenAt: nextEvent.recordedAt,
          nonce: `b1-human-${nextEvent.sequence}`,
        });
        events.push(nextEvent);
        state = committed.state;
      };

      await push("run.started", {}, { entityKind: "run", entityId: RUN_ID });
      await push("task.state-changed", { disposition: "READY", activity: "IDLE", owner: "NONE", hold: "NONE" }, {
        entityKind: "task",
        entityId: "T001",
        taskId: "T001",
        phaseId: "P01",
      });
      await push("workspace.checkpointed", {
        checkpoint: { kind: "runStartFingerprint", fingerprintDigest: "fp-base", emittedAt: "2026-09-05T04:10:03.000Z" },
      }, { entityKind: "workspace", entityId: "workspace-1" });
      await push("attempt.started", {
        taskId: "T001",
        attemptId: "A001",
        ordinal: 1,
        strategyGeneration: 0,
        attemptBaseFingerprint: "fp-base",
        startedAt: "2026-09-05T04:10:04.000Z",
      }, { entityKind: "attempt", entityId: "A001", attemptId: "A001", taskId: "T001", phaseId: "P01" });
      await push("executor.dispatch-authorized", {
        invocationId: "invocation-1",
        workUnitDigest: "work-unit-1",
        attemptBaseFingerprint: "fp-base",
        timeoutPolicyDigest: "timeout-policy-1",
        capabilityPolicyDigest: "capability-policy-1",
        authorizedAt: "2026-09-05T04:10:05.000Z",
      }, { entityKind: "attempt", entityId: "A001", attemptId: "A001", taskId: "T001", phaseId: "P01" });
      await push("executor.started", { invocationId: "invocation-1", startedAt: "2026-09-05T04:10:06.000Z" }, {
        entityKind: "attempt", entityId: "A001", attemptId: "A001", taskId: "T001", phaseId: "P01",
      });
      await push("executor.finished", {
        invocationId: "invocation-1",
        status: "SUCCEEDED",
        termination: "NORMAL",
        finishedAt: "2026-09-05T04:10:07.000Z",
      }, { entityKind: "attempt", entityId: "A001", attemptId: "A001", taskId: "T001", phaseId: "P01" });
      await push("evidence.capture-started", {
        evidenceCaptureId: "capture-1",
        postExecutorFingerprint: "fp-post",
        startedAt: "2026-09-05T04:10:08.000Z",
      }, { entityKind: "attempt", entityId: "A001", attemptId: "A001", taskId: "T001", phaseId: "P01" });
      await push("evidence.captured", {
        evidenceCaptureId: "capture-1",
        evidenceDigest: "evidence-digest-1",
        postExecutorFingerprint: "fp-post",
        capturedAt: "2026-09-05T04:10:09.000Z",
      }, { entityKind: "attempt", entityId: "A001", attemptId: "A001", taskId: "T001", phaseId: "P01" });
      const spec = parseValidationSpec("`printf validation`", { taskId: "T001", planIdentity: "plan-b1-human", ordinal: 1 });
      await push("validation.started", {
        validationSpec: spec,
        validationRunId: "validation-run-1",
        validationRunOrdinal: 1,
        startedAt: "2026-09-05T04:10:10.000Z",
      }, { entityKind: "attempt", entityId: "A001", attemptId: "A001", taskId: "T001", phaseId: "P01" });
      await push("attempt.human-required", {
        reason: "human decision is required",
        proofRef: "human-request-proof",
      }, { entityKind: "attempt", entityId: "A001", attemptId: "A001", taskId: "T001", phaseId: "P01" });
      await push("run.hold-cleared", {
        previousHold: "HUMAN_REQUIRED",
        reason: "human decision was recorded",
        proofRef: "human-resolution-proof",
      }, { entityKind: "run", entityId: RUN_ID });

      expect(state).toMatchObject({ hold: "NONE" });
      expect(state.attempts.A001).toMatchObject({ disposition: "OPEN", stage: "VALIDATING", recovery: { kind: "NONE" } });
      expect(state.attempts.A001?.recovery).not.toHaveProperty("proofRef");
      expect(state.tasks.T001).toMatchObject({ activity: "VALIDATING", owner: "CORE", hold: "NONE", currentAttemptId: "A001" });

      const reopened = new RalphEventStoreV2({ projectRoot: root, runId: RUN_ID });
      await unlink(resolve(reopened.runDirectory, "state", "current.json"));
      const replayed = await replayOperationalRunV2(reopened, initial);
      expect(replayed.snapshotUsed).toBe(false);
      expect(replayed.snapshotRepairRequired).toBe(true);
      expect(replayed.state).toEqual(state);
      expect(replayed.state.attempts.A001?.stage).toBe("VALIDATING");
      expect(replayed.state.tasks.T001).toMatchObject({ activity: "VALIDATING", owner: "CORE", hold: "NONE" });

      const opened = await inspectOperationalRunV2({
        projectRoot: root,
        runId: RUN_ID,
        genesisState: initial,
        externalFacts: { workspaceFingerprint: snapshot.initialWorkspaceFingerprint },
      });
      expect(opened.outcome).toBe("READY_FOR_LEASE");
      expect(opened.state).toEqual(state);
      const ledger = await reopened.inspect();
      expect(ledger.events).toHaveLength(events.length);
      expect(ledger.lastSequence).toBe(13);
      const clearEvent = ledger.events.at(-1);
      expect(clearEvent?.eventType).toBe("run.hold-cleared");
      if (clearEvent?.eventType === "run.hold-cleared") expect(clearEvent.payload.proofRef).toBe("human-resolution-proof");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("proves the mechanical ledger extraction preserves V1 bytes and duplicate semantics", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b1-v1-proof-"));
    try {
      const store = new RalphEventStore({ projectRoot: root, runId: "v1-proof" });
      const first = createRalphEventV1({
        eventId: "v1-proof-event",
        eventType: "run.created",
        schemaVersion: RALPH_EVENT_SCHEMA_V1,
        runId: "v1-proof",
        sequence: 1,
        occurredAt: "2026-09-05T03:59:00.000Z",
        recordedAt: "2026-09-05T03:59:00.100Z",
        entity: { kind: "run", id: "v1-proof" },
        actor: "CORE",
        causationId: null,
        correlationId: "v1-proof-correlation",
        payload: { phaseIds: [], taskIds: [] },
        previousEventHash: null,
      } as UnsignedRalphEventV1<"run.created">);
      expect((await store.append(first)).committed).toBe(true);
      expect((await store.append(first)).committed).toBe(false);
      expect(await readFile(resolve(store.eventsDirectory, "000000000001.json"), "utf8")).toBe(canonicalJson(first));
      expect((await store.inspect()).lastEventHash).toBe(first.eventHash);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("initializes in snapshot → run.created → state snapshot order and opens read-only", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b1-init-"));
    try {
      const { store, snapshot, result } = await initialized(root);
      expect(result.initialization).toBe("COMPLETE");
      expect(result.eventDurability).toBe("DURABLE");
      expect(result.publishDisposition).toBe("PUBLISHED_BY_THIS_CALL");
      expect(await readRunSnapshotV2(store)).toEqual(snapshot);
      expect((await readdir(store.eventsDirectory)).filter((name) => /^\d{12}\.json$/.test(name))).toEqual(["000000000001.json"]);
      const storedEvent = JSON.parse(await readFile(resolve(store.eventsDirectory, "000000000001.json"), "utf8")) as RalphEventV2;
      expect(storedEvent.eventType).toBe("run.created");
      const stateSnapshot = await readStateSnapshotV2(store);
      expect(stateSnapshot?.snapshotSchemaVersion).toBe(RALPH_STATE_SNAPSHOT_V2_SCHEMA);
      expect(stateSnapshot?.lastSequence).toBe(1);

      const opened = await inspectOperationalRunV2({
        projectRoot: root,
        runId: RUN_ID,
        genesisState: result.state === undefined ? genesis() : (result.state.lastSequence === 1 ? genesis() : genesis()),
        externalFacts: { workspaceFingerprint: snapshot.initialWorkspaceFingerprint },
      });
      expect(opened.outcome).toBe("READY_FOR_LEASE");
      expect(opened.state?.lastSequence).toBe(1);
      expect(opened.snapshotRepairRequired).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes canonical V2 event bytes and preserves the verified cursor", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b1-ledger-"));
    try {
      const { store, result } = await initialized(root);
      const second = runStarted(result.state);
      const committed = await commitRalphEventV2({ store, state: result.state, event: second, writtenAt: "2026-09-05T04:01:00.000Z", nonce: "second" });
      expect(committed.snapshotStatus).toBe("CURRENT");
      expect(committed.eventDurability).toBe("DURABLE");
      expect(committed.publishDisposition).toBe("PUBLISHED_BY_THIS_CALL");
      expect("eventCommitted" in committed).toBe(false);
      expect(store.verifiedCursor).toMatchObject({ runId: RUN_ID, lastSequence: 2, lastEventHash: second.eventHash });
      const bytes = await readFile(resolve(store.eventsDirectory, "000000000002.json"), "utf8");
      expect(bytes).toBe(canonicalJson(second));
      expect((await store.inspect()).lastSequence).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects reducer-invalid events before physical append", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b1-preflight-"));
    try {
      const { store, result } = await initialized(root);
      const invalid = event(result.state, "run.completed", { finalStatePersisted: true });
      await expect(commitRalphEventV2({ store, state: result.state, event: invalid, writtenAt: "2026-09-05T04:02:00.000Z", nonce: "invalid" })).rejects.toThrow("RALPH_V2_RUN_COMPLETION_PRECONDITION");
      expect((await store.inspect()).lastSequence).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a committed event authoritative when state snapshot durability fails", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b1-commit-crash-"));
    try {
      const { store, result } = await initialized(root);
      const failingSnapshotFs = { ...nodeRalphRuntimeFileSystem, fsyncFile: async () => { throw new Error("snapshot-fsync-crash"); } };
      const second = runStarted(result.state);
      const commit = await commitRalphEventV2({ store, state: result.state, event: second, writtenAt: "2026-09-05T04:03:00.000Z", nonce: "snapshot-crash", snapshotFileSystem: failingSnapshotFs });
      expect(commit.eventDurability).toBe("DURABLE");
      expect(commit.publishDisposition).toBe("PUBLISHED_BY_THIS_CALL");
      expect(commit.snapshotStatus).toBe("STALE_OR_FAILED");
      expect(commit.snapshotRecoveryRequired).toBe(true);
      expect((await store.inspect()).lastSequence).toBe(2);
      const opened = await inspectOperationalRunV2({ projectRoot: root, runId: RUN_ID, genesisState: genesis(), externalFacts: { workspaceFingerprint: (await snapshotFor(root)).initialWorkspaceFingerprint } });
      expect(opened.outcome).toBe("READY_FOR_LEASE");
      expect(opened.state?.lastSequence).toBe(2);
      expect(opened.snapshotRepairRequired).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an already-present event durable when state snapshot persistence fails", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b1-idempotent-snapshot-crash-"));
    try {
      const { store, snapshot, genesis: initial, result } = await initialized(root);
      const second = runStarted(result.state);
      const firstAppend = await store.append(second);
      expect(firstAppend.eventDurability).toBe("DURABLE");
      expect(firstAppend.publishDisposition).toBe("PUBLISHED_BY_THIS_CALL");
      expect("committed" in firstAppend).toBe(false);

      const freshStore = new RalphEventStoreV2({ projectRoot: root, runId: RUN_ID });
      const failingSnapshotFs = { ...nodeRalphRuntimeFileSystem, fsyncFile: async () => { throw new Error("idempotent-snapshot-fsync-crash"); } };
      const retry = await commitRalphEventV2({
        store: freshStore,
        state: result.state,
        event: second,
        writtenAt: "2026-09-05T04:03:30.000Z",
        nonce: "idempotent-snapshot-crash",
        snapshotFileSystem: failingSnapshotFs,
      });
      expect(retry.eventDurability).toBe("DURABLE");
      expect(retry.publishDisposition).toBe("ALREADY_PRESENT");
      expect(retry.snapshotStatus).toBe("STALE_OR_FAILED");
      expect(retry.snapshotRecoveryRequired).toBe(true);
      expect("eventCommitted" in retry).toBe(false);
      expect((await freshStore.inspect()).lastSequence).toBe(2);

      const opened = await inspectOperationalRunV2({
        projectRoot: root,
        runId: RUN_ID,
        genesisState: initial,
        externalFacts: { workspaceFingerprint: snapshot.initialWorkspaceFingerprint },
      });
      expect(opened.outcome).toBe("READY_FOR_LEASE");
      expect(opened.ledger?.lastSequence).toBe(2);
      expect(opened.state).toEqual(retry.state);
      expect(opened.state?.lastEventHash).toBe(second.eventHash);
      expect(opened.snapshotUsed).toBe(true);
      expect(opened.snapshotRepairRequired).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers lagging, missing, corrupt and bad-hash state snapshots in memory", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b1-snapshot-recovery-"));
    try {
      const { store, snapshot, result } = await initialized(root);
      const second = runStarted(result.state);
      const afterSecond = (await commitRalphEventV2({ store, state: result.state, event: second, writtenAt: "2026-09-05T04:04:00.000Z", nonce: "tail" })).state;
      await persistStateSnapshotV2(store, result.state, "2026-09-05T04:04:01.000Z", "lagging");
      let opened = await inspectOperationalRunV2({ projectRoot: root, runId: RUN_ID, genesisState: genesis(), externalFacts: { workspaceFingerprint: snapshot.initialWorkspaceFingerprint } });
      expect(opened.outcome).toBe("READY_FOR_LEASE");
      expect(opened.snapshotUsed).toBe(true);
      expect(opened.state?.lastSequence).toBe(2);
      expect(opened.snapshotRepairRequired).toBe(true);

      await unlink(resolve(store.runDirectory, "state", "current.json"));
      opened = await inspectOperationalRunV2({ projectRoot: root, runId: RUN_ID, genesisState: genesis(), externalFacts: { workspaceFingerprint: snapshot.initialWorkspaceFingerprint } });
      expect(opened.outcome).toBe("READY_FOR_LEASE");
      expect(opened.snapshotUsed).toBe(false);
      expect(opened.snapshotRepairRequired).toBe(true);

      await persistStateSnapshotV2(store, result.state, "2026-09-05T04:04:01.500Z", "lagging-again");
      await writeFile(resolve(store.runDirectory, "state", "current.json"), "{corrupt");
      opened = await inspectOperationalRunV2({ projectRoot: root, runId: RUN_ID, genesisState: genesis(), externalFacts: { workspaceFingerprint: snapshot.initialWorkspaceFingerprint } });
      expect(opened.snapshotRecovered).toBe(true);
      expect(opened.state?.lastSequence).toBe(2);
      expect(await readFile(resolve(store.runDirectory, "state", "current.json"), "utf8")).toBe("{corrupt");

      const valid = createStateSnapshotV2(afterSecond, "2026-09-05T04:04:02.000Z");
      await writeFile(resolve(store.runDirectory, "state", "current.json"), canonicalJson({ ...valid, stateHash: sha256("wrong-state-hash") }));
      opened = await inspectOperationalRunV2({ projectRoot: root, runId: RUN_ID, genesisState: genesis(), externalFacts: { workspaceFingerprint: snapshot.initialWorkspaceFingerprint } });
      expect(opened.outcome).toBe("READY_FOR_LEASE");
      expect(opened.snapshotRecovered).toBe(true);
      expect(opened.state?.lastSequence).toBe(2);
      expect(await readFile(resolve(store.runDirectory, "state", "current.json"), "utf8")).toBe(canonicalJson({ ...valid, stateHash: sha256("wrong-state-hash") }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies publication uncertainty and forces inspection before reuse", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b1-unknown-durability-"));
    try {
      const { store, result } = await initialized(root);
      const second = runStarted(result.state);
      const uncertainStore = new RalphEventStoreV2({
        projectRoot: root,
        runId: RUN_ID,
        fs: {
          ...nodeRalphRuntimeFileSystem,
          fsyncDirectory: async (path: string) => {
            if (path === store.eventsDirectory) throw new Error("event-directory-fsync-unknown");
            return nodeRalphRuntimeFileSystem.fsyncDirectory(path);
          },
        },
      });
      await expect(uncertainStore.append(second)).rejects.toMatchObject({
        code: "RALPH_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION",
        eventDurability: "UNKNOWN_REQUIRES_INSPECTION",
        requiresInspection: true,
      });
      expect(uncertainStore.verifiedCursor).toBeUndefined();
      await expect(uncertainStore.append(second)).rejects.toMatchObject({
        code: "RALPH_EVENT_DURABILITY_INSPECTION_REQUIRED",
        eventDurability: "UNKNOWN_REQUIRES_INSPECTION",
        requiresInspection: true,
      });

      const reopened = new RalphEventStoreV2({ projectRoot: root, runId: RUN_ID });
      const inspection = await reopened.inspect();
      expect(inspection.lastSequence).toBe(2);
      const reconciled = await reopened.append(second);
      expect(reconciled.eventDurability).toBe("DURABLE");
      expect(reconciled.publishDisposition).toBe("ALREADY_PRESENT");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed for an ahead or wrong-position state snapshot", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b1-snapshot-integrity-"));
    try {
      const { store, snapshot, result } = await initialized(root);
      const current = await readStateSnapshotV2(store);
      if (!current) throw new Error("state snapshot missing");
      await writeFile(resolve(store.runDirectory, "state", "current.json"), canonicalJson({ ...current, lastSequence: 2 }));
      let opened = await inspectOperationalRunV2({ projectRoot: root, runId: RUN_ID, genesisState: genesis(), externalFacts: { workspaceFingerprint: snapshot.initialWorkspaceFingerprint } });
      expect(opened.outcome).toBe("FAILED_INTEGRITY");
      expect(opened.issues).toContain("RALPH_V2_STATE_SNAPSHOT_AHEAD");

      const valid = createStateSnapshotV2(result.state, "2026-09-05T04:05:00.000Z");
      await writeFile(resolve(store.runDirectory, "state", "current.json"), canonicalJson({ ...valid, lastEventHash: sha256("wrong-position") }));
      opened = await inspectOperationalRunV2({ projectRoot: root, runId: RUN_ID, genesisState: genesis(), externalFacts: { workspaceFingerprint: snapshot.initialWorkspaceFingerprint } });
      expect(opened.outcome).toBe("FAILED_INTEGRITY");
      expect(opened.issues).toContain("RALPH_V2_STATE_SNAPSHOT_HASH_POSITION_MISMATCH");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enforces immutable V2 RunSnapshot identity and scripted-only profile", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b1-run-snapshot-"));
    try {
      const snapshot = await snapshotFor(root);
      const store = new RalphEventStoreV2({ projectRoot: root, runId: RUN_ID });
      expect(await persistRunSnapshotV2(store, snapshot, "snapshot-a")).toBe("created");
      expect(await persistRunSnapshotV2(store, snapshot, "snapshot-b")).toBe("already-present");
      await expect(persistRunSnapshotV2(store, { ...snapshot, readyPlanHash: sha256("different-plan") }, "snapshot-c")).rejects.toThrow("RALPH_V2_RUN_SNAPSHOT_IMMUTABLE_VIOLATION");
      expect(() => validateRunSnapshotV2({ ...snapshot, executorProfile: { profileId: "real", kind: "production", descriptorDigest: snapshot.executorProfile.descriptorDigest } })).toThrow("RALPH_V2_RUN_SNAPSHOT_EXECUTOR_PROFILE_UNSUPPORTED");
      expect(() => validateRunSnapshotV2({ ...snapshot, rawConfig: { arbitrary: true } })).toThrow("RALPH_V2_RUN_SNAPSHOT_UNKNOWN_FIELD");
      expect((await readRunSnapshotV2(store)).eventSchema).toBe(EVENT_SCHEMA_V2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not classify an idempotent run.created retry as incomplete", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b1-idempotent-init-"));
    try {
      const { store, snapshot, genesis: initial } = await initialized(root);
      const retry = await initializeOperationalRunV2({
        store,
        snapshot,
        retryPolicy: retryPolicyFor(snapshot.runId),
        genesisState: initial,
        runCreatedEvent: runCreated(initial),
        createdAt: "2026-09-05T04:06:15.000Z",
        nonce: "idempotent-retry",
      });
      expect(retry.initialization).toBe("COMPLETE");
      expect(retry.eventDurability).toBe("DURABLE");
      expect(retry.publishDisposition).toBe("ALREADY_PRESENT");
      expect(retry.commit.snapshotStatus).toBe("CURRENT");
      expect((await store.inspect()).lastSequence).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects V1/V2 physical family mixing in both facades", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b1-family-"));
    try {
      const snapshot = await snapshotFor(root);
      const v2Store = new RalphEventStoreV2({ projectRoot: root, runId: RUN_ID });
      await persistRunSnapshotV2(v2Store, snapshot, "family-v2");
      const v1Store = new RalphEventStore({ projectRoot: root, runId: RUN_ID });
      const v1Event = createRalphEventV1({
        eventId: "v1-event",
        eventType: "run.created",
        schemaVersion: RALPH_EVENT_SCHEMA_V1,
        runId: RUN_ID,
        sequence: 1,
        occurredAt: "2026-09-05T04:06:00.000Z",
        recordedAt: "2026-09-05T04:06:00.100Z",
        entity: { kind: "run", id: RUN_ID },
        actor: "CORE",
        causationId: null,
        correlationId: "v1-correlation",
        payload: { phaseIds: [], taskIds: [] },
        previousEventHash: null,
      } as UnsignedRalphEventV1<"run.created">);
      await expect(v1Store.append(v1Event)).rejects.toThrow("RALPH_V1_RUN_SCHEMA_FAMILY_MISMATCH");
      await writeFile(resolve(v2Store.eventsDirectory, "000000000001.json"), canonicalJson(v1Event));
      await expect(v2Store.inspectPhysicalLedgerForOpen()).rejects.toThrow("RALPH_V2_EVENT_UNSUPPORTED_SCHEMA");

      const otherRoot = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b1-family-v1-"));
      try {
        const other = new RalphEventStoreV2({ projectRoot: otherRoot, runId: RUN_ID });
        await other.ensureLayout();
        await writeFile(resolve(other.runDirectory, "run-snapshot.json"), JSON.stringify({ snapshotSchemaVersion: "rb-ralph-run-snapshot/v1", runId: RUN_ID }));
        const v2Event = runCreated(genesis());
        await expect(other.append(v2Event)).rejects.toThrow("RALPH_V2_WRONG_RUN_FAMILY");
      } finally {
        await rm(otherRoot, { recursive: true, force: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not create a V2 RunSnapshot over an existing V1 ledger", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b1-family-birth-"));
    try {
      const v1Store = new RalphEventStore({ projectRoot: root, runId: RUN_ID });
      const v1Event = createRalphEventV1({
        eventId: "v1-birth-event",
        eventType: "run.created",
        schemaVersion: RALPH_EVENT_SCHEMA_V1,
        runId: RUN_ID,
        sequence: 1,
        occurredAt: "2026-09-05T04:06:30.000Z",
        recordedAt: "2026-09-05T04:06:30.100Z",
        entity: { kind: "run", id: RUN_ID },
        actor: "CORE",
        causationId: null,
        correlationId: "v1-birth-correlation",
        payload: { phaseIds: [], taskIds: [] },
        previousEventHash: null,
      } as UnsignedRalphEventV1<"run.created">);
      await v1Store.append(v1Event);
      const v2Store = new RalphEventStoreV2({ projectRoot: root, runId: RUN_ID });
      await expect(persistRunSnapshotV2(v2Store, await snapshotFor(root), "v2-over-v1")).rejects.toThrow();
      expect(await readFile(resolve(v1Store.eventsDirectory, "000000000001.json"), "utf8")).toBe(canonicalJson(v1Event));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps physical V2 publication exclusive under identical and divergent races", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b1-concurrency-"));
    try {
      const snapshot = await snapshotFor(root);
      const storeA = new RalphEventStoreV2({ projectRoot: root, runId: RUN_ID, nonce: () => "a" });
      const storeB = new RalphEventStoreV2({ projectRoot: root, runId: RUN_ID, nonce: () => "b" });
      await persistRetryPolicyV1(storeA, retryPolicyFor(RUN_ID), "concurrency-policy");
      await Promise.all([persistRunSnapshotV2(storeA, snapshot, "same-a"), persistRunSnapshotV2(storeB, snapshot, "same-b")]);
      const first = runCreated(genesis());
      const identical = await Promise.all([storeA.append(first), storeB.append(first)]);
      expect(identical.filter((entry) => entry.publishDisposition === "PUBLISHED_BY_THIS_CALL")).toHaveLength(1);
      expect(identical.filter((entry) => entry.publishDisposition === "ALREADY_PRESENT")).toHaveLength(1);

      const divergentRoot = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b1-concurrency-fork-"));
      try {
        const divergentSnapshot = await snapshotFor(divergentRoot);
        const left = new RalphEventStoreV2({ projectRoot: divergentRoot, runId: RUN_ID, nonce: () => "left" });
        const right = new RalphEventStoreV2({ projectRoot: divergentRoot, runId: RUN_ID, nonce: () => "right" });
        await persistRetryPolicyV1(left, retryPolicyFor(RUN_ID), "divergent-policy");
        const differentSnapshot = { ...divergentSnapshot, readyManifestHash: sha256("different-manifest") };
        const snapshotResults = await Promise.allSettled([
          persistRunSnapshotV2(left, divergentSnapshot, "divergent-snapshot-left"),
          persistRunSnapshotV2(right, differentSnapshot, "divergent-snapshot-right"),
        ]);
        expect(snapshotResults.filter((entry) => entry.status === "fulfilled" && entry.value === "created")).toHaveLength(1);
        expect(snapshotResults.filter((entry) => entry.status === "rejected")).toHaveLength(1);
        const different = event(genesis(), "run.created", { phaseIds: ["different"], taskIds: [] });
        const results = await Promise.allSettled([left.append(first), right.append(different)]);
        expect(results.filter((entry) => entry.status === "fulfilled" && entry.value.publishDisposition === "PUBLISHED_BY_THIS_CALL")).toHaveLength(1);
        expect(results.filter((entry) => entry.status === "rejected")).toHaveLength(1);
        expect(results.find((entry) => entry.status === "rejected")?.reason.message).toContain("RALPH_EVENT_SEQUENCE_FORK");
      } finally {
        await rm(divergentRoot, { recursive: true, force: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves the 100000-event ceiling without rollover", async () => {
    expect(eventFileName(100000)).toBe("000000100000.json");
    expect(() => eventFileName(100001)).toThrow("RALPH_INVALID_EVENT_SEQUENCE");
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b1-capacity-"));
    try {
      const snapshot = await snapshotFor(root);
      const store = new RalphEventStoreV2({ projectRoot: root, runId: RUN_ID });
      await persistRetryPolicyV1(store, retryPolicyFor(RUN_ID), "capacity-policy");
      await persistRunSnapshotV2(store, snapshot, "capacity-snapshot");
      const overCapacity = createRalphEventV2({
        eventId: "over-capacity",
        eventType: "run.started",
        schemaVersion: EVENT_SCHEMA_V2,
        runId: RUN_ID,
        sequence: 100001,
        occurredAt: "2026-09-05T04:10:00.000Z",
        recordedAt: "2026-09-05T04:10:00.100Z",
        entity: { kind: "run", id: RUN_ID },
        actor: "CORE",
        causationId: null,
        correlationId: "capacity",
        payload: {},
        previousEventHash: null,
      });
      await expect(store.append(overCapacity)).rejects.toThrow("RALPH_EVENT_LEDGER_CAPACITY_EXCEEDED");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns explicit incomplete initialization and external-drift outcomes", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b1-open-outcomes-"));
    try {
      const snapshot = await snapshotFor(root);
      const store = new RalphEventStoreV2({ projectRoot: root, runId: RUN_ID });
      await store.ensureLayout();
      let opened = await inspectOperationalRunV2({ projectRoot: root, runId: RUN_ID, genesisState: genesis() });
      expect(opened.outcome).toBe("INCOMPLETE_INITIALIZATION");

      await persistRetryPolicyV1(store, retryPolicyFor(snapshot.runId), "open-retry-policy");
      await persistRunSnapshotV2(store, snapshot, "open-snapshot");
      opened = await inspectOperationalRunV2({ projectRoot: root, runId: RUN_ID, genesisState: genesis(), externalFacts: { workspaceFingerprint: snapshot.initialWorkspaceFingerprint } });
      expect(opened.outcome).toBe("INCOMPLETE_INITIALIZATION");
      expect(opened.issues).toContain("RALPH_V2_RUN_CREATED_MISSING");

      const initializedResult = await initializeOperationalRunV2({ store, snapshot, retryPolicy: retryPolicyFor(snapshot.runId), genesisState: genesis(), runCreatedEvent: runCreated(genesis()), createdAt: "2026-09-05T04:07:00.000Z", nonce: "open-event" });
      expect(initializedResult.initialization).toBe("COMPLETE");
      opened = await inspectOperationalRunV2({ projectRoot: root, runId: RUN_ID, genesisState: genesis(), externalFacts: { readyPlanHash: sha256("changed"), workspaceFingerprint: snapshot.initialWorkspaceFingerprint } });
      expect(opened.outcome).toBe("RECONCILIATION_REQUIRED");
      expect(opened.issues).toContain("ready-plan-hash-mismatch");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a rehashed hash-chain fork and ignores validity claims supplied by callers", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b1-mutation-guard-"));
    try {
      const { store, snapshot, result } = await initialized(root);
      const second = runStarted(result.state);
      await commitRalphEventV2({ store, state: result.state, event: second, writtenAt: "2026-09-05T04:08:00.000Z", nonce: "chain" });
      const unsigned = { ...second, previousEventHash: sha256("unrelated-chain") };
      const { eventHash: _ignored, ...withoutHash } = unsigned;
      await writeFile(resolve(store.eventsDirectory, "000000000002.json"), canonicalJson({ ...withoutHash, eventHash: sha256(canonicalJson(withoutHash)) }));
      let opened = await inspectOperationalRunV2({
        projectRoot: root,
        runId: RUN_ID,
        genesisState: genesis(),
        externalFacts: { workspaceFingerprint: snapshot.initialWorkspaceFingerprint },
      });
      expect(opened.outcome).toBe("FAILED_INTEGRITY");
      expect(opened.issues).toContain("RALPH_EVENT_LEDGER_HASH_CHAIN_MISMATCH");

      await writeFile(resolve(store.eventsDirectory, "000000000002.json"), "{invalid-ledger");
      opened = await inspectOperationalRunV2({
        projectRoot: root,
        runId: RUN_ID,
        genesisState: genesis(),
        externalFacts: { workspaceFingerprint: snapshot.initialWorkspaceFingerprint },
        ledgerValid: true,
      } as InspectOperationalRunV2InputWithProbe);
      expect(opened.outcome).toBe("FAILED_INTEGRITY");
      expect(opened.issues).toContain("RALPH_EVENT_LEDGER_MALFORMED_JSON");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects credential-bearing snapshot attempts before any durable write", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b1-secret-"));
    try {
      const snapshot = await snapshotFor(root);
      expect(() => validateRunSnapshotV2({ ...snapshot, effectiveRunConfig: { apiKey: "secret" } })).toThrow("RALPH_V2_RUN_SNAPSHOT_CREDENTIAL_FIELD");
      const store = new RalphEventStoreV2({ projectRoot: root, runId: RUN_ID });
      await expect(persistRunSnapshotV2(store, { ...snapshot, effectiveRunConfig: { schemaVersion: "rb-config/v2", descriptorId: "safe-looking", descriptorDigest: snapshot.effectiveConfigDigest, note: "Bearer raw-secret" } as never }, "secret-value")).rejects.toThrow("RALPH_V2_RUN_SNAPSHOT_CREDENTIAL_VALUE");
      await persistRunSnapshotV2(store, snapshot, "secret-valid");
      await expect(store.append(event(genesis(), "run.failed", { reason: "Bearer raw-secret" }))).rejects.toThrow("RALPH_V2_EVENT_CREDENTIAL_VALUE");
      expect((await store.inspectPhysicalLedgerForOpen()).lastSequence).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves the verified-tail O(1)-ish append path for V2", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b1-cursor-"));
    try {
      const snapshot = await snapshotFor(root);
      let readdirCount = 0;
      let eventReadCount = 0;
      const countedFs = {
        ...nodeRalphRuntimeFileSystem,
        readdir: async (path: string) => { readdirCount += 1; return nodeRalphRuntimeFileSystem.readdir(path); },
        readFile: async (path: string) => { if (path.includes("/events/")) eventReadCount += 1; return nodeRalphRuntimeFileSystem.readFile(path); },
      };
      const store = new RalphEventStoreV2({ projectRoot: root, runId: RUN_ID, fs: countedFs, nonce: () => "cursor" });
      await persistRetryPolicyV1(store, retryPolicyFor(RUN_ID), "cursor-policy");
      await persistRunSnapshotV2(store, snapshot, "cursor-snapshot");
      let previousEventHash: string | null = null;
      for (let sequence = 1; sequence <= 8; sequence += 1) {
        const current: RalphEventV2 = createRalphEventV2({
          eventId: `cursor-${sequence}`,
          eventType: "run.started",
          schemaVersion: EVENT_SCHEMA_V2,
          runId: RUN_ID,
          sequence,
          occurredAt: `2026-09-05T04:09:${String(sequence).padStart(2, "0")}.000Z`,
          recordedAt: `2026-09-05T04:09:${String(sequence).padStart(2, "0")}.100Z`,
          entity: { kind: "run", id: RUN_ID },
          actor: "CORE",
          causationId: null,
          correlationId: "cursor",
          payload: {},
          previousEventHash,
        });
        await store.append(current);
        previousEventHash = current.eventHash;
      }
      expect(readdirCount).toBe(1);
      expect(eventReadCount).toBe(7);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses no replace-capable rename for immutable event publication", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b1-no-overwrite-"));
    try {
      const { snapshot, result } = await initialized(root);
      let renameCalled = false;
      const guardedFs = {
        ...nodeRalphRuntimeFileSystem,
        rename: async () => { renameCalled = true; throw new Error("event publication attempted replace"); },
      };
      const store = new RalphEventStoreV2({ projectRoot: root, runId: RUN_ID, fs: guardedFs, nonce: () => "no-overwrite" });
      const second = runStarted(result.state);
      expect((await store.append(second)).publishDisposition).toBe("PUBLISHED_BY_THIS_CALL");
      expect(renameCalled).toBe(false);
      expect(JSON.parse(await readFile(resolve(store.eventsDirectory, "000000000002.json"), "utf8"))).toEqual(second);
      expect((await readRunSnapshotV2(store)).runId).toBe(snapshot.runId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps V2 event crash windows non-semantic and quarantinable", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b1-event-crash-"));
    try {
      const snapshot = await snapshotFor(root);
      const baseStore = new RalphEventStoreV2({ projectRoot: root, runId: RUN_ID });
      await persistRetryPolicyV1(baseStore, retryPolicyFor(RUN_ID), "crash-policy");
      await persistRunSnapshotV2(baseStore, snapshot, "crash-snapshot");
      const first = runCreated(genesis());
      const beforeTemp = new RalphEventStoreV2({
        projectRoot: root,
        runId: RUN_ID,
        fs: { ...nodeRalphRuntimeFileSystem, writeFile: async () => { throw new Error("before-event-temp"); } },
      });
      await expect(beforeTemp.append(first)).rejects.toThrow("before-event-temp");
      expect((await baseStore.inspectPhysicalLedgerForOpen()).lastSequence).toBe(0);

      const duringTemp = new RalphEventStoreV2({
        projectRoot: root,
        runId: RUN_ID,
        fs: { ...nodeRalphRuntimeFileSystem, fsyncFile: async () => { throw new Error("during-event-temp"); } },
      });
      await expect(duringTemp.append(first)).rejects.toThrow("during-event-temp");
      expect((await baseStore.inspectPhysicalLedgerForOpen()).lastSequence).toBe(0);
      expect(await baseStore.quarantineTemporaryFiles()).toHaveLength(1);

      const afterPublish = new RalphEventStoreV2({
        projectRoot: root,
        runId: RUN_ID,
        fs: { ...nodeRalphRuntimeFileSystem, fsyncDirectory: async () => { throw new Error("after-event-publish"); } },
      });
      await expect(afterPublish.append(first)).rejects.toMatchObject({
        code: "RALPH_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION",
        eventDurability: "UNKNOWN_REQUIRES_INSPECTION",
        requiresInspection: true,
      });
      expect((await baseStore.inspectPhysicalLedgerForOpen()).lastSequence).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("has no executable/provider boundary in B1 source", async () => {
    const sourceFiles = [
      resolve(TEST_DIRECTORY, "../../src/vnext/ralph-runtime/durable-ledger.ts"),
      ...["event-store.ts", "run-snapshot.ts", "state-snapshot.ts", "commit.ts", "initialization.ts", "open.ts", "index.ts", "secret-safety.ts"]
        .map((file) => resolve(TEST_DIRECTORY, "../../src/vnext/ralph-runtime/operational-b1", file)),
    ];
    const source = (await Promise.all(sourceFiles.map((file) => readFile(file, "utf8")))).join("\n");
    expect(source.length).toBeGreaterThan(0);
    expect(source).not.toMatch(/node:child_process|\b(?:spawn|exec|execFile|fork)\s*\(|\b(?:ExecutorRuntime|ScriptedExecutor|ValidationRunner)\b|\b(?:Codex|Claude|OpenCode|OpenAI|Anthropic|DeepSeek|MiniMax)\b|provider\s+registry|model\s+API|\b(?:acquireLease|recoverLease|releaseLease)\b|\blease\s+(?:acquisition|recovery|release)\b/i);
  });
});

type InspectOperationalRunV2InputWithProbe = Parameters<typeof inspectOperationalRunV2>[0] & { readonly ledgerValid: true };
