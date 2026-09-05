import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RALPH_EVENT_SCHEMA,
  RalphEventStore,
  createInitialRuntimeState,
  createRalphEvent,
  createWorkspacePolicy,
  fingerprintWorkspace,
  nodeRalphRuntimeFileSystem,
  persistImmutableRunSnapshot,
  persistStateSnapshot,
  readRunSnapshot,
  readStateSnapshot,
  replayRalphRuntime,
  validateSnapshotAgainstLedger,
  inspectRalphResume,
  type EventPayloadMap,
  type RalphEvent,
  type RalphEventType,
  type RunSnapshot,
  type UnsignedRalphEvent,
} from "../../src/vnext/ralph-runtime/index.js";

function event<TType extends RalphEventType>(sequence: number, eventType: TType, payload: EventPayloadMap[TType], previousEventHash: string | null): RalphEvent {
  return createRalphEvent({
    eventId: `snapshot-event-${sequence}`,
    eventType,
    schemaVersion: RALPH_EVENT_SCHEMA,
    runId: "run-1",
    sequence,
    occurredAt: `2026-09-05T02:00:${String(sequence).padStart(2, "0")}.000Z`,
    recordedAt: `2026-09-05T02:00:${String(sequence).padStart(2, "0")}.100Z`,
    entity: { kind: "run", id: "run-1" },
    actor: "CORE",
    causationId: null,
    correlationId: "snapshot-correlation",
    payload,
    previousEventHash,
  } as UnsignedRalphEvent<TType>) as RalphEvent;
}

function snapshot(): RunSnapshot {
  const workspacePolicy = createWorkspacePolicy();
  return {
    snapshotSchemaVersion: "rb-ralph-run-snapshot/v1",
    runId: "run-1",
    projectIdentity: { projectId: "project-1" },
    readyPlanIdentity: "plan-1",
    readyPlanHash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    readyManifestHash: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    selectedReadyArtifactHashes: {},
    readinessInspectionDigest: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
    effectiveRunConfig: { schemaVersion: "rb-test-config/v1", descriptorId: "foundation-test", descriptorDigest: "sha256:4444444444444444444444444444444444444444444444444444444444444444" },
    effectiveConfigDigest: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
    executorProfile: { profileId: "executor-profile", providerId: "none-yet", modelId: "none-yet", descriptorDigest: "sha256:5555555555555555555555555555555555555555555555555555555555555555" },
    auditorProfile: { profileId: "auditor-profile", providerId: "none-yet", modelId: "none-yet", descriptorDigest: "sha256:6666666666666666666666666666666666666666666666666666666666666666" },
    executorCapabilities: { requested: [], granted: [], verified: [], readOnlyEnforced: false },
    auditorCapabilities: { requested: ["filesystem.read"], granted: ["filesystem.read"], verified: ["filesystem.read"], readOnlyEnforced: true },
    permissionEnforceDigest: "sha256:7777777777777777777777777777777777777777777777777777777777777777",
    workspacePolicy,
    initialFingerprint: { controlPlaneFingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", productWorkspaceFingerprint: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", policyDigest: workspacePolicy.policyDigest, fingerprintDigest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" },
    retryPolicy: { schemaVersion: "rb-test-retry/v1", descriptorId: "retry-default", descriptorDigest: "sha256:8888888888888888888888888888888888888888888888888888888888888888" },
    timeoutPolicy: { schemaVersion: "rb-test-timeout/v1", descriptorId: "timeout-default", descriptorDigest: "sha256:9999999999999999999999999999999999999999999999999999999999999999" },
    parallelismPolicy: { schemaVersion: "rb-test-parallel/v1", descriptorId: "serial", descriptorDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    runtimeVersion: "1.1.0",
    createdAt: "2026-09-05T02:00:00.000Z",
  };
}

describe("Ralph Runtime snapshot and resume foundation", () => {
  it("replays a committed event after a lagging snapshot and rejects an ahead snapshot", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-snapshot-"));
    try {
      const store = new RalphEventStore({ projectRoot: root, runId: "run-1" });
      const first = event(1, "run.created", { phaseIds: [], taskIds: [] }, null);
      const second = event(2, "run.started", {}, first.eventHash);
      await store.append(first);
      await store.append(second);
      const genesis = createInitialRuntimeState({ runId: "run-1", phases: [], tasks: [] });
      const afterFirst = { ...genesis, lastSequence: 1, lastEventHash: first.eventHash };
      await persistStateSnapshot(store, afterFirst, "2026-09-05T02:01:00.000Z", "snapshot-1");
      const replay = await replayRalphRuntime(store, genesis);
      expect(replay.snapshotUsed).toBe(true);
      expect(replay.state.disposition).toBe("ACTIVE");
      expect(replay.state.lastSequence).toBe(2);

      const stored = await readStateSnapshot(store);
      if (!stored) throw new Error("snapshot missing");
      const ahead = { ...stored, lastSequence: 3 };
      expect(() => validateSnapshotAgainstLedger(ahead, { events: [first, second], lastSequence: 2, lastEventHash: second.eventHash })).toThrow("RALPH_STATE_SNAPSHOT_AHEAD");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists the Run Snapshot immutably and rejects credentials", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-run-snapshot-"));
    try {
      const runSnapshot = snapshot();
      const store = new RalphEventStore({ projectRoot: root, runId: "run-1" });
      expect(await persistImmutableRunSnapshot(store, runSnapshot, "run-snapshot-1")).toBe("created");
      expect(await persistImmutableRunSnapshot(store, runSnapshot, "run-snapshot-2")).toBe("already-present");
      const loaded = await readRunSnapshot(store);
      expect(loaded).toEqual(runSnapshot);
      await expect(persistImmutableRunSnapshot(store, { ...runSnapshot, readyPlanHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, "run-snapshot-3")).rejects.toThrow("RALPH_RUN_SNAPSHOT_IMMUTABLE_VIOLATION");
      await expect(persistImmutableRunSnapshot(store, { ...runSnapshot, effectiveRunConfig: { apiKey: "secret" } as never }, "run-snapshot-4")).rejects.toThrow("RALPH_RUN_SNAPSHOT_CREDENTIAL_FIELD");
      await expect(persistImmutableRunSnapshot(store, { ...runSnapshot, effectiveRunConfig: { schemaVersion: "v1", descriptorId: "innocent", descriptorDigest: runSnapshot.effectiveConfigDigest, note: "Bearer secret-value" } as never }, "run-snapshot-5")).rejects.toThrow("RALPH_RUN_SNAPSHOT_CREDENTIAL_VALUE");
      await expect(persistImmutableRunSnapshot(store, { ...runSnapshot, effectiveRunConfig: { schemaVersion: "v1", descriptorId: "innocent", descriptorDigest: runSnapshot.effectiveConfigDigest, pem: "-----BEGIN PRIVATE KEY-----" } as never }, "run-snapshot-6")).rejects.toThrow("RALPH_RUN_SNAPSHOT_CREDENTIAL_VALUE");
      await expect(persistImmutableRunSnapshot(store, { ...runSnapshot, rawConfig: { arbitrary: true } } as never, "run-snapshot-7")).rejects.toThrow("RALPH_RUN_SNAPSHOT_UNKNOWN_FIELD");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an older state checkpoint usable when snapshot temp durability fails", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-state-crash-"));
    try {
      const state = createInitialRuntimeState({ runId: "run-1", phases: [], tasks: [] });
      const failingFs = { ...nodeRalphRuntimeFileSystem, fsyncFile: async () => { throw new Error("crash during snapshot temp"); } };
      const store = new RalphEventStore({ projectRoot: root, runId: "run-1" });
      await expect(persistStateSnapshot(store, state, "2026-09-05T02:04:00.000Z", "state-crash", failingFs)).rejects.toThrow("crash during snapshot temp");
      expect(await readStateSnapshot(store)).toBeUndefined();
      await persistStateSnapshot(store, state, "2026-09-05T02:04:01.000Z", "state-ok");
      expect(await readStateSnapshot(store)).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rebuilds from an intact ledger when the state snapshot is corrupt", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-snapshot-recovery-"));
    try {
      const store = new RalphEventStore({ projectRoot: root, runId: "run-1" });
      const first = event(1, "run.created", { phaseIds: [], taskIds: [] }, null);
      await store.append(first);
      const genesis = createInitialRuntimeState({ runId: "run-1", phases: [], tasks: [] });
      await persistStateSnapshot(store, { ...genesis, lastSequence: 1, lastEventHash: first.eventHash }, "2026-09-05T02:05:00.000Z", "recovery-state");
      await writeFile(resolve(store.runDirectory, "state", "current.json"), "{corrupt");
      const replay = await replayRalphRuntime(store, genesis);
      expect(replay.snapshotRecovered).toBe(true);
      expect(replay.snapshotUsed).toBe(false);
      expect(replay.state.lastSequence).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("orchestrates resume facts in Core and returns typed reconciliation outcomes", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-resume-"));
    try {
      const baseSnapshot = snapshot();
      const current = await fingerprintWorkspace(root, baseSnapshot.workspacePolicy);
      const initialFingerprint = {
        controlPlaneFingerprint: current.controlPlaneFingerprint,
        productWorkspaceFingerprint: current.productWorkspaceFingerprint,
        policyDigest: current.policyDigest,
        fingerprintDigest: current.fingerprintDigest,
      };
      const runSnapshot = { ...baseSnapshot, initialFingerprint };
      const store = new RalphEventStore({ projectRoot: root, runId: "run-1" });
      await persistImmutableRunSnapshot(store, runSnapshot, "resume-snapshot");
      const genesisState = createInitialRuntimeState({ runId: "run-1", phases: [], tasks: [] });
      const base = {
        projectRoot: root,
        runId: "run-1",
        genesisState,
        currentPlanIdentity: "plan-1",
        currentPlanHash: runSnapshot.readyPlanHash,
        currentReadyControlPlaneDigest: initialFingerprint.controlPlaneFingerprint,
        currentEffectiveConfigDigest: runSnapshot.effectiveConfigDigest,
        currentExecutorProfileDigest: runSnapshot.executorProfile.descriptorDigest,
        currentAuditorProfileDigest: runSnapshot.auditorProfile.descriptorDigest,
        currentPermissionEnforceDigest: runSnapshot.permissionEnforceDigest,
      };
      expect(await inspectRalphResume(base)).toMatchObject({ disposition: "READY_TO_RESUME", issues: [] });
      expect(await inspectRalphResume({ ...base, currentPlanHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })).toMatchObject({ disposition: "RECONCILIATION_REQUIRED", issues: ["plan-hash-mismatch"] });
      await writeFile(resolve(store.eventsDirectory, "000000000001.json"), "{not-an-event");
      expect(await inspectRalphResume(base)).toMatchObject({ disposition: "FAILED_INTEGRITY", issues: ["RALPH_EVENT_LEDGER_MALFORMED_JSON"] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
