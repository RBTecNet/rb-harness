import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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
  inspectOperationalRunV2,
  persistStateSnapshotV2,
  readStateSnapshotV2,
  RalphEventStoreV2,
  retryPolicyDescriptorV1,
  type RunSnapshotV2,
} from "../../src/vnext/ralph-runtime/operational-b1/index.js";
import {
  RALPH_RUN_LEASE_SCHEMA_V2,
  RALPH_RUN_LEASE_HEARTBEAT_DISABLED,
  acquireLeasedRunV2,
  inspectRecoveryClaimV2,
  inspectRunLeaseV2,
  leasePathsForStore,
  recoverStaleRunLeaseV2,
  refreshLeasedRunV2,
  repairStateSnapshotWhileLeasedV2,
  releaseLeasedRunV2,
  LinuxProcessIdentityProvider,
  type LeaseRuntimeInputV2,
  type ProcessIdentity,
  type ProcessIdentityProvider,
} from "../../src/vnext/ralph-runtime/operational-b2/index.js";
import { canonicalJson } from "../../src/vnext/ralph-runtime/canonical-json.js";
import { createWorkspacePolicy, fingerprintWorkspace } from "../../src/vnext/ralph-runtime/fingerprint.js";
import { sha256, sha256Canonical } from "../../src/vnext/ralph-runtime/hashing.js";
import { nodeRalphRuntimeFileSystem } from "../../src/vnext/ralph-runtime/event-store.js";
import type { ExecutionDocument, Phase, Task } from "../../src/types.js";
import type { RuntimeEntityRef } from "../../src/vnext/ralph-runtime/contracts.js";

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const RUN_ID = "run-b2";
const TEST_MAX_TASK_ATTEMPTS = 4;
const TEST_VALIDATION_INFRA_RETRIES = 2;

const ownerIdentity: ProcessIdentity = {
  pid: 41001,
  processStartIdentity: "start-owner",
  hostIdentity: "host-a",
  bootSessionIdentity: "boot-a",
};
const recovererIdentity: ProcessIdentity = {
  pid: 41002,
  processStartIdentity: "start-recoverer",
  hostIdentity: "host-a",
  bootSessionIdentity: "boot-a",
};

function provider(current: ProcessIdentity, inspect: (identity: ProcessIdentity) => "MATCH" | "ABSENT" | "START_MISMATCH" | "UNKNOWN" = () => "MATCH"): ProcessIdentityProvider {
  return { current: () => current, inspect };
}

function descriptor(schemaVersion: string, descriptorId: string): { readonly schemaVersion: string; readonly descriptorId: string; readonly descriptorDigest: string } {
  const base = { schemaVersion, descriptorId };
  return { ...base, descriptorDigest: sha256Canonical(base) };
}

function plan(): ExecutionDocument {
  const task: Task = {
    id: "T001",
    title: "B2 task",
    done: false,
    scope: "src",
    change: "implement the B2 task",
    covers: "src",
    dependsOn: [],
    parallelSafe: false,
    acceptanceCriteria: ["T001 produces its declared result"],
    validation: ["`printf validation`"],
    expectedEvidence: "a deterministic evidence reference",
    line: 1,
  };
  const phase: Phase = {
    number: 1,
    id: "P01",
    title: "B2 phase",
    goal: "exercise the lease",
    dependsOn: [],
    context: ["test"],
    tasks: [task],
    line: 1,
  };
  return { contract: "rb-execution/v1", artifactId: "plan-b2", title: "B2", phases: [phase] };
}

function genesis(): RalphRuntimeStateV2 {
  const document = plan();
  return createInitialRuntimeStateV2({
    runId: RUN_ID,
    maxTaskAttemptsPerTask: TEST_MAX_TASK_ATTEMPTS,
    phases: document.phases.map((phase) => ({ phaseId: phase.id, taskIds: phase.tasks.map((task) => task.id) })),
    tasks: document.phases.flatMap((phase) => phase.tasks.map((task) => ({ taskId: task.id, phaseId: phase.id, dependsOn: task.dependsOn }))),
  });
}

async function snapshotFor(root: string): Promise<RunSnapshotV2> {
  const workspacePolicy = createWorkspacePolicy();
  const fingerprint = await fingerprintWorkspace(root, workspacePolicy);
  const config = descriptor("rb-ralph-config/v2", "b2-config");
  return {
    snapshotSchemaVersion: RALPH_RUN_SNAPSHOT_V2_SCHEMA,
    runId: RUN_ID,
    eventSchema: EVENT_SCHEMA_V2,
    stateSchema: STATE_SCHEMA_V2,
    operationalContract: OPERATIONAL_CONTRACT_V2,
    projectIdentity: { projectId: "b2-test-project" },
    readyPlanIdentity: "plan-b2",
    readyPlanHash: sha256("ready-plan-b2"),
    readyManifestHash: sha256("ready-manifest-b2"),
    selectedReadyArtifactHashes: { plan: sha256("ready-plan-b2") },
    readinessInspectionDigest: sha256("readiness-b2"),
    effectiveRunConfig: config,
    effectiveConfigDigest: config.descriptorDigest,
    diagnosticsPolicy: descriptor("rb-ralph-diagnostics/v2", "diagnostics-b2"),
    environmentPolicy: descriptor("rb-ralph-environment/v2", "environment-b2"),
    executorProfile: { profileId: "fixture-b2", kind: "scripted", descriptorDigest: sha256("profile-b2") },
    executorCapabilities: { requested: ["fixture.effect"], granted: ["fixture.effect"], verified: ["fixture.effect"], readOnlyEnforced: false },
    permissionCapabilityPolicy: descriptor("rb-ralph-capabilities/v2", "capabilities-b2"),
    workspacePolicy,
    initialWorkspaceFingerprint: {
      controlPlaneFingerprint: fingerprint.controlPlaneFingerprint,
      productWorkspaceFingerprint: fingerprint.productWorkspaceFingerprint,
      policyDigest: fingerprint.policyDigest,
      fingerprintDigest: fingerprint.fingerprintDigest,
    },
    retryPolicies: retryPolicyDescriptorV1(createRetryPolicyV1({ runId: RUN_ID, policyId: "retry-b2", maxTaskAttemptsPerTask: TEST_MAX_TASK_ATTEMPTS, validationInfrastructureRetryLimit: TEST_VALIDATION_INFRA_RETRIES })),
    timeoutPolicy: descriptor("rb-ralph-timeout/v2", "timeout-b2"),
    runtimeIdentity: descriptor("rb-ralph-runtime/v2", "runtime-b2"),
    leasePolicy: descriptor("rb-ralph-lease/v2", "lease-b2"),
    createdAt: "2026-09-05T04:00:00.000Z",
  };
}

function contextFor<TType extends RalphEventTypeV2>(
  state: RalphRuntimeStateV2,
  eventType: TType,
  payload: EventPayloadMapV2[TType],
): { readonly entity: RuntimeEntityRef; readonly phaseId?: string; readonly taskId?: string; readonly attemptId?: string } {
  const kind = V2_EVENT_ENTITY_KINDS[eventType];
  const value = payload as Record<string, unknown>;
  if (kind === "run") return { entity: { kind, id: state.runId } };
  if (kind === "workspace") return { entity: { kind, id: "workspace-b2" } };
  if (kind === "task") return { entity: { kind, id: "T001" }, phaseId: "P01", taskId: "T001" };
  const attemptId = typeof value.attemptId === "string" ? value.attemptId : "A001";
  return { entity: { kind, id: attemptId }, phaseId: "P01", taskId: "T001", attemptId };
}

function event<TType extends RalphEventTypeV2>(state: RalphRuntimeStateV2, eventType: TType, payload: EventPayloadMapV2[TType]): RalphEventV2 {
  const context = contextFor(state, eventType, payload);
  return createRalphEventV2({
    eventId: `b2-${state.lastSequence + 1}-${eventType}`,
    eventType,
    schemaVersion: EVENT_SCHEMA_V2,
    runId: state.runId,
    sequence: state.lastSequence + 1,
    occurredAt: `2026-09-05T04:00:${String(state.lastSequence).padStart(2, "0")}.000Z`,
    recordedAt: `2026-09-05T04:00:${String(state.lastSequence).padStart(2, "0")}.100Z`,
    ...context,
    actor: "CORE",
    causationId: null,
    correlationId: "b2-correlation",
    payload,
    previousEventHash: state.lastEventHash,
  } as UnsignedRalphEventV2<TType>) as RalphEventV2;
}

async function initialized(root: string): Promise<{
  readonly store: RalphEventStoreV2;
  readonly snapshot: RunSnapshotV2;
  readonly genesis: RalphRuntimeStateV2;
  readonly state: RalphRuntimeStateV2;
}> {
  const snapshot = await snapshotFor(root);
  const store = new RalphEventStoreV2({ projectRoot: root, runId: RUN_ID });
  const initial = genesis();
  const result = await initializeOperationalRunV2({
    store,
    snapshot,
    retryPolicy: createRetryPolicyV1({ runId: RUN_ID, policyId: "retry-b2", maxTaskAttemptsPerTask: TEST_MAX_TASK_ATTEMPTS, validationInfrastructureRetryLimit: TEST_VALIDATION_INFRA_RETRIES }),
    genesisState: initial,
    runCreatedEvent: event(initial, "run.created", { phaseIds: initial.phaseIds, taskIds: initial.taskIds }),
    createdAt: "2026-09-05T04:00:01.000Z",
    nonce: "b2-init",
  });
  return { store, snapshot, genesis: initial, state: result.state };
}

async function activeReady(root: string): Promise<Awaited<ReturnType<typeof initialized>> & { readonly state: RalphRuntimeStateV2 }> {
  const base = await initialized(root);
  let state = base.state;
  const snapshot = base.snapshot;
  for (const [name, payload] of [
    ["run.started", {}],
    ["task.state-changed", { disposition: "READY", activity: "IDLE", owner: "NONE", hold: "NONE" }],
    ["workspace.checkpointed", { checkpoint: { kind: "runStartFingerprint", fingerprintDigest: snapshot.initialWorkspaceFingerprint.fingerprintDigest, emittedAt: "2026-09-05T04:00:02.000Z" } }],
  ] as const) {
    const typed = event(state, name as "run.started" | "task.state-changed" | "workspace.checkpointed", payload as never);
    state = (await commitRalphEventV2({ store: base.store, state, event: typed, writtenAt: "2026-09-05T04:00:02.000Z", nonce: `b2-${name}` })).state;
  }
  return { ...base, state };
}

async function admitted(root: string): Promise<Awaited<ReturnType<typeof activeReady>>> {
  const base = await activeReady(root);
  const started = event(base.state, "attempt.started", {
    taskId: "T001",
    attemptId: "A001",
    ordinal: 1,
    strategyGeneration: 0,
    attemptBaseFingerprint: base.snapshot.initialWorkspaceFingerprint.fingerprintDigest,
    startedAt: "2026-09-05T04:00:03.000Z",
  });
  const committed = await commitRalphEventV2({ store: base.store, state: base.state, event: started, writtenAt: "2026-09-05T04:00:03.000Z", nonce: "b2-attempt" });
  return { ...base, state: committed.state };
}

async function dispatchAuthorized(root: string): Promise<Awaited<ReturnType<typeof admitted>>> {
  const base = await admitted(root);
  const authorized = event(base.state, "executor.dispatch-authorized", {
    invocationId: "inv-b2",
    workUnitDigest: sha256("work-b2"),
    attemptBaseFingerprint: base.snapshot.initialWorkspaceFingerprint.fingerprintDigest,
    timeoutPolicyDigest: base.snapshot.timeoutPolicy.descriptorDigest,
    capabilityPolicyDigest: base.snapshot.permissionCapabilityPolicy.descriptorDigest,
    authorizedAt: "2026-09-05T04:00:04.000Z",
  });
  const committed = await commitRalphEventV2({ store: base.store, state: base.state, event: authorized, writtenAt: "2026-09-05T04:00:04.000Z", nonce: "b2-dispatch" });
  return { ...base, state: committed.state };
}

function leaseInput(root: string, genesisState: RalphRuntimeStateV2, identityProvider: ProcessIdentityProvider, overrides: Partial<LeaseRuntimeInputV2> = {}): LeaseRuntimeInputV2 {
  return {
    projectRoot: root,
    runId: RUN_ID,
    genesisState,
    processIdentityProvider: identityProvider,
    externalFacts: { workspaceFingerprint: undefined },
    ...overrides,
  };
}

async function acquireOwner(root: string, base: { readonly genesis: RalphRuntimeStateV2 }, identityProvider: ProcessIdentityProvider) {
  return acquireLeasedRunV2(leaseInput(root, base.genesis, identityProvider, { externalFacts: undefined }));
}

async function waitForProcStatCommand(pid: number, command: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const closingCommand = stat.lastIndexOf(")");
      const openingCommand = stat.indexOf("(");
      if (openingCommand >= 0 && closingCommand > openingCommand && stat.slice(openingCommand + 1, closingCommand) === command) return stat;
    } catch {
      // The child may need one scheduler turn before procfs exposes the entry.
    }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error(`process command was not observed in procfs: ${command}`);
}

describe("Ralph Operational Core V2 — B2 run lease", () => {
  it("gives exactly one winner to two concurrent acquisition attempts and types the loser", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b2-race-"));
    try {
      const base = await initialized(root);
      const identityProvider = provider(ownerIdentity);
      const results = await Promise.allSettled([
        acquireOwner(root, base, identityProvider),
        acquireOwner(root, base, identityProvider),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      expect(rejected?.reason).toMatchObject({ code: "LEASE_ALREADY_HELD" });
      const winner = results.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireOwner>>> => result.status === "fulfilled")?.value;
      expect(winner?.leaseId).toBeTruthy();
      await releaseLeasedRunV2(winner!);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists only the owner-token digest, enforces ownership on release, and allows the owner to release", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b2-token-"));
    try {
      const base = await initialized(root);
      const raw = Buffer.from("owner-token-that-stays-in-memory-32", "utf8");
      const leased = await acquireLeasedRunV2(leaseInput(root, base.genesis, provider(ownerIdentity), {
        ownerTokenFactory: () => raw,
        externalFacts: undefined,
      }));
      const bytes = await readFile(leased.leasePath);
      expect(bytes.toString("utf8")).not.toContain(raw.toString("utf8"));
      const stored = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      expect(stored.leaseSchema).toBe(RALPH_RUN_LEASE_SCHEMA_V2);
      expect(stored.ownerTokenDigest).toBe(sha256(raw));
      expect(stored.heartbeat).toBe(RALPH_RUN_LEASE_HEARTBEAT_DISABLED);
      expect(stored.renewedAt).toBeNull();

      await expect(releaseLeasedRunV2({} as never)).rejects.toMatchObject({ code: "LEASE_HANDLE_REQUIRED" });
      await expect(releaseLeasedRunV2(leased, { noActiveExternalInvocation: true })).rejects.toMatchObject({ code: "LEASE_RELEASE_REJECTED" });
      await releaseLeasedRunV2(leased);
      expect((await inspectRunLeaseV2(leased.store)).kind).toBe("ABSENT");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not let a caller widen pre-executor workspace comparison", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b2-workspace-authority-"));
    try {
      const base = await initialized(root);
      await writeFile(resolve(root, "caller-drift.txt"), "caller drift\n");
      const attemptedWidening = {
        ...leaseInput(root, base.genesis, provider(ownerIdentity), { externalFacts: undefined }),
        workspaceComparison: "ALLOW_POST_EXECUTOR_DRIFT",
      } as unknown as LeaseRuntimeInputV2;
      await expect(acquireLeasedRunV2(attemptedWidening)).rejects.toMatchObject({ code: "LEASE_ACQUISITION_NOT_READY" });
      const store = new RalphEventStoreV2({ projectRoot: root, runId: RUN_ID });
      expect((await inspectRunLeaseV2(store)).kind).toBe("ABSENT");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a previously valid handle after another owner takes the lease", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b2-non-owner-"));
    try {
      const base = await initialized(root);
      const first = await acquireOwner(root, base, provider(ownerIdentity));
      await unlink(first.leasePath);
      const second = await acquireOwner(root, base, provider(recovererIdentity));
      await expect(releaseLeasedRunV2(first)).rejects.toMatchObject({ code: "LEASE_LOST" });
      await releaseLeasedRunV2(second);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not turn PID-only or unknown host identity into a stale-lease proof", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b2-identity-"));
    try {
      const base = await initialized(root);
      const lease = await acquireOwner(root, base, provider(ownerIdentity));
      const pidOnlyProvider = provider(recovererIdentity, () => "UNKNOWN");
      await expect(recoverStaleRunLeaseV2(leaseInput(root, base.genesis, pidOnlyProvider))).rejects.toMatchObject({ code: "LEASE_RECONCILIATION_REQUIRED" });
      expect((await inspectRunLeaseV2(lease.store)).kind).toBe("PRESENT");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses stale recovery for a live MATCH owner without changing the lease", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b2-live-owner-"));
    try {
      const base = await initialized(root);
      const realProvider = new LinuxProcessIdentityProvider();
      const leasePath = leasePathsForStore(base.store).leasePath;
      const unlinks: string[] = [];
      const fs = {
        ...nodeRalphRuntimeFileSystem,
        unlink: async (path: string) => {
          unlinks.push(path);
          await nodeRalphRuntimeFileSystem.unlink(path);
        },
      };
      const owner = await acquireLeasedRunV2(leaseInput(root, base.genesis, realProvider, { fs, externalFacts: undefined }));
      const leaseBefore = await readFile(leasePath);
      const eventsBefore = (await owner.store.inspect()).events;
      unlinks.length = 0;

      await expect(recoverStaleRunLeaseV2(leaseInput(root, base.genesis, realProvider, { fs, externalFacts: undefined }))).rejects.toMatchObject({ code: "LEASE_ALREADY_HELD" });

      expect(await readFile(leasePath)).toEqual(leaseBefore);
      expect((await owner.store.inspect()).events).toEqual(eventsBefore);
      expect(unlinks).not.toContain(leasePath);
      expect((await inspectRecoveryClaimV2(owner.store)).kind).toBe("ABSENT");
      await releaseLeasedRunV2(owner);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the real Linux provider host-first gate for a foreign shared-storage lease", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b2-host-"));
    try {
      const base = await initialized(root);
      const realProvider = new LinuxProcessIdentityProvider();
      const local = await realProvider.current();
      const foreignIdentity: ProcessIdentity = {
        pid: 2_000_000_000,
        processStartIdentity: "foreign-process-start",
        hostIdentity: `${local.hostIdentity}-foreign-host`,
        bootSessionIdentity: "arbitrary-foreign-boot",
      };
      const owner = await acquireOwner(root, base, provider(foreignIdentity));
      expect(await realProvider.inspect(foreignIdentity)).toBe("UNKNOWN");
      await expect(recoverStaleRunLeaseV2(leaseInput(root, base.genesis, realProvider))).rejects.toMatchObject({ code: "LEASE_RECONCILIATION_REQUIRED" });
      expect((await inspectRunLeaseV2(owner.store)).kind).toBe("PRESENT");
      expect((await inspectRecoveryClaimV2(owner.store)).kind).toBe("ABSENT");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows same-host stale recovery after reboot when the old PID is absent", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b2-reboot-"));
    try {
      const base = await initialized(root);
      const realProvider = new LinuxProcessIdentityProvider();
      const local = await realProvider.current();
      const oldOwnerIdentity: ProcessIdentity = {
        pid: 2_000_000_001,
        processStartIdentity: "old-process-start",
        hostIdentity: local.hostIdentity,
        bootSessionIdentity: "old-boot-session",
      };
      expect(oldOwnerIdentity.bootSessionIdentity).not.toBe(local.bootSessionIdentity);
      const owner = await acquireOwner(root, base, provider(oldOwnerIdentity));
      expect(await realProvider.inspect(oldOwnerIdentity)).toBe("ABSENT");

      const recovered = await recoverStaleRunLeaseV2(leaseInput(root, base.genesis, realProvider));
      expect(recovered.kind).toBe("RECOVERED");
      expect(recovered.targetLeaseId).toBe(owner.leaseId);
      await releaseLeasedRunV2(recovered.leasedRun);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parses a real proc stat command with spaces and parentheses", async () => {
    const realProvider = new LinuxProcessIdentityProvider();
    const local = await realProvider.current();
    const command = "a) b (c d)";
    const child = spawn(process.execPath, ["-e", `process.title = ${JSON.stringify(command)}; process.stdout.write("ready"); setInterval(() => {}, 1000);`], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        child.once("error", rejectReady);
        child.stdout?.once("data", () => resolveReady());
      });
      if (child.pid === undefined) throw new Error("child process did not expose a PID");
      const stat = await waitForProcStatCommand(child.pid, command);
      const closingCommand = stat.lastIndexOf(")");
      const suffixFields = stat.slice(closingCommand + 1).trim().split(/\s+/);
      const sessionId = suffixFields[3];
      const startTime = suffixFields[19];
      expect(sessionId).toBeTruthy();
      expect(startTime).toBeTruthy();

      const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
      const identity: ProcessIdentity = {
        pid: child.pid,
        processStartIdentity: sha256(`rb-linux-process-start:${child.pid}:${startTime}`),
        hostIdentity: local.hostIdentity,
        bootSessionIdentity: sha256(`rb-linux-boot-session:${bootId}:${sessionId}`),
      };
      expect(identity.processStartIdentity).toBe(sha256(`rb-linux-process-start:${child.pid}:${suffixFields[19]}`));
      expect(identity.bootSessionIdentity).toBe(sha256(`rb-linux-boot-session:${bootId}:${suffixFields[3]}`));
      expect(await realProvider.inspect(identity)).toBe("MATCH");
    } finally {
      await new Promise<void>((resolveExit) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolveExit();
          return;
        }
        child.once("exit", () => resolveExit());
        child.kill("SIGTERM");
      });
    }
  });

  it("does not return a handle when post-publication identity revalidation is UNKNOWN", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b2-post-"));
    try {
      const base = await initialized(root);
      let inspections = 0;
      const uncertainIdentity = provider(ownerIdentity, () => inspections++ === 0 ? "UNKNOWN" : "MATCH");
      await expect(acquireOwner(root, base, uncertainIdentity)).rejects.toMatchObject({ code: "LEASE_RECONCILIATION_REQUIRED" });
      expect((await inspectRunLeaseV2(base.store)).kind).toBe("ABSENT");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("handles process-start mismatch as PID reuse and can recover only with the strong mismatch result", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b2-start-"));
    try {
      const base = await initialized(root);
      const lease = await acquireOwner(root, base, provider(ownerIdentity));
      const staleProvider = provider(recovererIdentity, (identity) => identity.processStartIdentity === ownerIdentity.processStartIdentity ? "START_MISMATCH" : "MATCH");
      const recovered = await recoverStaleRunLeaseV2(leaseInput(root, base.genesis, staleProvider));
      expect(recovered.kind).toBe("RECOVERED");
      expect(recovered.targetLeaseId).toBe(lease.leaseId);
      await releaseLeasedRunV2(recovered.leasedRun);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers a positively absent owner for no-Attempt and ADMITTED states", async () => {
    for (const setup of [initialized, admitted]) {
      const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", `rb-ralph-b2-safe-${setup.name}-`));
      try {
        const base = await setup(root);
        const owner = await acquireOwner(root, base, provider(ownerIdentity));
        const staleProvider = provider(recovererIdentity, (identity) => identity.processStartIdentity === ownerIdentity.processStartIdentity ? "ABSENT" : "MATCH");
        const recovered = await recoverStaleRunLeaseV2(leaseInput(root, base.genesis, staleProvider));
        expect(recovered.kind).toBe("RECOVERED");
        await releaseLeasedRunV2(recovered.leasedRun);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("requires reconciliation for EXECUTOR_DISPATCH_AUTHORIZED without NOT_INVOKED proof", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b2-authorized-"));
    try {
      const base = await dispatchAuthorized(root);
      const owner = await acquireOwner(root, base, provider(ownerIdentity));
      const staleProvider = provider(recovererIdentity, (identity) => identity.processStartIdentity === ownerIdentity.processStartIdentity ? "ABSENT" : "MATCH");
      await expect(recoverStaleRunLeaseV2(leaseInput(root, base.genesis, staleProvider))).rejects.toMatchObject({ code: "LEASE_RECONCILIATION_REQUIRED" });
      expect((await inspectRunLeaseV2(owner.store)).kind).toBe("PRESENT");
      expect((await inspectRecoveryClaimV2(owner.store)).kind).toBe("ABSENT");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("gives exactly one recovery claim winner", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b2-recovery-race-"));
    try {
      const base = await initialized(root);
      const owner = await acquireOwner(root, base, provider(ownerIdentity));
      const staleProvider = provider(recovererIdentity, (identity) => identity.processStartIdentity === ownerIdentity.processStartIdentity ? "ABSENT" : "MATCH");
      const results = await Promise.allSettled([
        recoverStaleRunLeaseV2(leaseInput(root, base.genesis, staleProvider)),
        recoverStaleRunLeaseV2(leaseInput(root, base.genesis, staleProvider)),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      const loser = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      expect(["RECOVERY_ALREADY_HELD", "LEASE_ALREADY_HELD"]).toContain(loser?.reason?.code);
      const winner = results.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof recoverStaleRunLeaseV2>>> => result.status === "fulfilled")?.value;
      expect(winner?.targetLeaseId).toBe(owner.leaseId);
      await releaseLeasedRunV2(winner!.leasedRun);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinked lock paths and preserves the bounded runtime path", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b2-path-"));
    const outside = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b2-outside-"));
    try {
      const base = await initialized(root);
      const paths = leasePathsForStore(base.store);
      await symlink(outside, paths.locksDirectory);
      await expect(acquireOwner(root, base, provider(ownerIdentity))).rejects.toMatchObject({ code: "LEASE_PATH_UNSAFE" });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("classifies link-then-lock-fsync uncertainty as inspection-required", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b2-unknown-"));
    try {
      const base = await initialized(root);
      const locks = leasePathsForStore(base.store).locksDirectory;
      let fail = true;
      const uncertainFs = {
        ...nodeRalphRuntimeFileSystem,
        fsyncDirectory: async (path: string) => {
          if (path === locks && fail) {
            fail = false;
            throw new Error("locks-fsync-unknown");
          }
          await nodeRalphRuntimeFileSystem.fsyncDirectory(path);
        },
      };
      const input = leaseInput(root, base.genesis, provider(ownerIdentity), { fs: uncertainFs, externalFacts: undefined });
      await expect(acquireLeasedRunV2(input)).rejects.toMatchObject({ code: "LEASE_DURABILITY_UNKNOWN_REQUIRES_INSPECTION" });
      const inspectedStore = new RalphEventStoreV2({ projectRoot: root, runId: RUN_ID, fs: uncertainFs });
      expect((await inspectRunLeaseV2(inspectedStore)).kind).toBe("PRESENT");
      await expect(acquireLeasedRunV2(input)).rejects.toMatchObject({ code: "LEASE_ALREADY_HELD" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("repairs a derived snapshot only under lease, while read-only B1 opening leaves it unchanged", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b2-repair-"));
    try {
      const base = await initialized(root);
      let current = base.state;
      const started = event(current, "run.started", {});
      current = (await commitRalphEventV2({ store: base.store, state: current, event: started, writtenAt: "2026-09-05T04:00:05.000Z", nonce: "b2-repair-start" })).state;
      await persistStateSnapshotV2(base.store, base.state, "2026-09-05T04:00:05.100Z", "b2-repair-lagging");
      const before = await readFile(resolve(base.store.runDirectory, "state", "current.json"), "utf8");
      const opened = await inspectOperationalRunV2({ projectRoot: root, runId: RUN_ID, genesisState: base.genesis, externalFacts: { workspaceFingerprint: base.snapshot.initialWorkspaceFingerprint } });
      expect(opened.snapshotRepairRequired).toBe(true);
      expect(await readFile(resolve(base.store.runDirectory, "state", "current.json"), "utf8")).toBe(before);

      const leased = await acquireOwner(root, base, provider(ownerIdentity));
      const repaired = await repairStateSnapshotWhileLeasedV2(leased, { writtenAt: "2026-09-05T04:00:06.000Z", nonce: "b2-repair-current" });
      expect(repaired.repaired).toBe(true);
      expect((await readStateSnapshotV2(leased.store))?.lastSequence).toBe(current.lastSequence);
      await releaseLeasedRunV2(leased);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops critical operations after lease loss and does not run a heartbeat", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b2-loss-"));
    try {
      const base = await initialized(root);
      const leased = await acquireOwner(root, base, provider(ownerIdentity));
      await unlink(leased.leasePath);
      await expect(refreshLeasedRunV2(leased)).rejects.toMatchObject({ code: "LEASE_LOST" });
      await expect(releaseLeasedRunV2(leased)).rejects.toMatchObject({ code: "LEASE_LOST" });
      expect(JSON.stringify(leased)).not.toContain("ownerToken");
      expect(JSON.stringify(leased)).not.toContain("heartbeatTimer");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads the intended B2 production files and proves there is no execution/provider surface", async () => {
    const files = ["process-identity.ts", "run-lease.ts", "index.ts"].map((file) => resolve(TEST_DIRECTORY, "../../src/vnext/ralph-runtime/operational-b2", file));
    const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
    expect(source.length).toBeGreaterThan(0);
    expect(source).not.toMatch(/node:child_process|\b(?:spawn|exec|execFile|fork)\s*\(|\b(?:ExecutorRuntime|ScriptedExecutor|ValidationRunner)\b|\b(?:Codex|Claude|OpenCode|OpenAI|Anthropic|DeepSeek|MiniMax)\b|provider\s+registry|model\s+API|executor\.started/i);
  });
});
