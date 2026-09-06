import { mkdtemp, readFile, rm, symlink, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RuntimeEntityRef, FingerprintIdentity } from "../../src/vnext/ralph-runtime/contracts.js";
import type { ExecutionDocument, Phase, Task } from "../../src/types.js";
import {
  EVENT_SCHEMA_V2,
  OPERATIONAL_CONTRACT_V2,
  STATE_SCHEMA_V2,
  V2_EVENT_ENTITY_KINDS,
  createInitialRuntimeStateV2,
  createRalphEventV2,
  scheduleNextTask,
  type EventPayloadMapV2,
  type RalphEventTypeV2,
  type RalphEventV2,
  type RalphRuntimeStateV2,
  type UnsignedRalphEventV2,
} from "../../src/vnext/ralph-runtime/operational-v2/index.js";
import {
  RALPH_RUN_SNAPSHOT_V2_SCHEMA,
  commitRalphEventV2,
  initializeOperationalRunV2,
  inspectOperationalRunV2,
  RalphEventStoreV2,
  type RunSnapshotV2,
} from "../../src/vnext/ralph-runtime/operational-b1/index.js";
import {
  acquireLeasedRunV2,
  inspectRunLeaseV2,
  releaseLeasedRunV2,
  refreshLeasedRunV2,
  type LeaseRuntimeInputV2,
  type ProcessIdentity,
  type ProcessIdentityProvider,
} from "../../src/vnext/ralph-runtime/operational-b2/index.js";
import {
  ARTIFACT_ERROR_CODES,
  createWorkUnitV2,
  invocationIdForBindingV2,
  persistInvocationDescriptorV2,
  persistWorkUnitV2,
  readInvocationDescriptorV2,
  readWorkUnitV2,
  workUnitPathV2,
  invocationDescriptorPathV2,
} from "../../src/vnext/ralph-runtime/operational-b3/index.js";
import {
  prepareNextAuthorizedInvocationV2,
  type PrepareNextAuthorizedInvocationV2Input,
} from "../../src/vnext/ralph-runtime/operational-b3/index.js";
import { createWorkspacePolicy, fingerprintWorkspace } from "../../src/vnext/ralph-runtime/fingerprint.js";
import { canonicalJson } from "../../src/vnext/ralph-runtime/canonical-json.js";
import { sha256, sha256Canonical } from "../../src/vnext/ralph-runtime/hashing.js";
import { nodeRalphRuntimeFileSystem } from "../../src/vnext/ralph-runtime/event-store.js";

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const RUN_ID = "run-b3";

const ownerIdentity: ProcessIdentity = {
  pid: 52001,
  processStartIdentity: "b3-owner-start",
  hostIdentity: "b3-host",
  bootSessionIdentity: "b3-boot",
};

const secondIdentity: ProcessIdentity = {
  pid: 52002,
  processStartIdentity: "b3-second-start",
  hostIdentity: "b3-host",
  bootSessionIdentity: "b3-boot",
};

function identityProvider(current: ProcessIdentity, inspect: (identity: ProcessIdentity) => "MATCH" | "ABSENT" | "START_MISMATCH" | "UNKNOWN" = () => "MATCH"): ProcessIdentityProvider {
  return { current: () => current, inspect };
}

function descriptor(schemaVersion: string, descriptorId: string): { readonly schemaVersion: string; readonly descriptorId: string; readonly descriptorDigest: string } {
  const base = { schemaVersion, descriptorId };
  return { ...base, descriptorDigest: sha256Canonical(base) };
}

function task(id: string, dependsOn: string[] = []): Task {
  return {
    id,
    title: `Task ${id}`,
    done: false,
    scope: "src",
    change: `make the declared ${id} change`,
    covers: "src",
    dependsOn,
    parallelSafe: false,
    acceptanceCriteria: [`${id} has its declared result`],
    validation: ["`printf validation`"],
    expectedEvidence: "a deterministic evidence reference",
    line: Number(id.slice(1)),
  };
}

function plan(taskList: readonly Task[] = [task("T001")]): ExecutionDocument {
  const phase: Phase = {
    number: 1,
    id: "P01",
    title: "B3 phase",
    goal: "exercise admission",
    dependsOn: [],
    context: ["test"],
    tasks: [...taskList],
    line: 1,
  };
  return { contract: "rb-execution/v1", artifactId: "plan-b3", title: "B3", phases: [phase] };
}

function genesis(document: ExecutionDocument, runId = RUN_ID): RalphRuntimeStateV2 {
  return createInitialRuntimeStateV2({
    runId,
    phases: document.phases.map((phase) => ({ phaseId: phase.id, taskIds: phase.tasks.map((candidate) => candidate.id) })),
    tasks: document.phases.flatMap((phase) => phase.tasks.map((candidate) => ({ taskId: candidate.id, phaseId: phase.id, dependsOn: candidate.dependsOn }))),
  });
}

async function snapshotFor(root: string, document: ExecutionDocument, runId = RUN_ID): Promise<RunSnapshotV2> {
  const workspacePolicy = createWorkspacePolicy();
  const fingerprint = await fingerprintWorkspace(root, workspacePolicy);
  const config = descriptor("rb-ralph-config/v2", "b3-config");
  return {
    snapshotSchemaVersion: RALPH_RUN_SNAPSHOT_V2_SCHEMA,
    runId,
    eventSchema: EVENT_SCHEMA_V2,
    stateSchema: STATE_SCHEMA_V2,
    operationalContract: OPERATIONAL_CONTRACT_V2,
    projectIdentity: { projectId: "b3-test-project" },
    readyPlanIdentity: document.artifactId,
    readyPlanHash: sha256Canonical(document),
    readyManifestHash: sha256("ready-manifest-b3"),
    selectedReadyArtifactHashes: { plan: sha256Canonical(document) },
    readinessInspectionDigest: sha256("readiness-b3"),
    effectiveRunConfig: config,
    effectiveConfigDigest: config.descriptorDigest,
    diagnosticsPolicy: descriptor("rb-ralph-diagnostics/v2", "diagnostics-b3"),
    environmentPolicy: descriptor("rb-ralph-environment/v2", "environment-b3"),
    executorProfile: { profileId: "fixture-b3", kind: "scripted", descriptorDigest: sha256("profile-b3") },
    executorCapabilities: { requested: ["fixture.effect"], granted: ["fixture.effect"], verified: ["fixture.effect"], readOnlyEnforced: false },
    permissionCapabilityPolicy: descriptor("rb-ralph-capabilities/v2", "capabilities-b3"),
    workspacePolicy,
    initialWorkspaceFingerprint: {
      controlPlaneFingerprint: fingerprint.controlPlaneFingerprint,
      productWorkspaceFingerprint: fingerprint.productWorkspaceFingerprint,
      policyDigest: fingerprint.policyDigest,
      fingerprintDigest: fingerprint.fingerprintDigest,
    },
    retryPolicies: descriptor("rb-ralph-retry/v2", "retry-b3"),
    timeoutPolicy: descriptor("rb-ralph-timeout/v2", "timeout-b3"),
    runtimeIdentity: descriptor("rb-ralph-runtime/v2", "runtime-b3"),
    leasePolicy: descriptor("rb-ralph-lease/v2", "lease-b3"),
    createdAt: "2026-09-05T05:00:00.000Z",
  };
}

function event<TType extends RalphEventTypeV2>(
  state: RalphRuntimeStateV2,
  eventType: TType,
  payload: EventPayloadMapV2[TType],
  context: { readonly phaseId?: string; readonly taskId?: string; readonly attemptId?: string } = {},
): RalphEventV2 {
  const kind = V2_EVENT_ENTITY_KINDS[eventType];
  const payloadRecord = payload as Record<string, unknown>;
  const taskId = context.taskId ?? (typeof payloadRecord.taskId === "string" ? payloadRecord.taskId : undefined);
  const attemptId = context.attemptId ?? (typeof payloadRecord.attemptId === "string" ? payloadRecord.attemptId : undefined);
  const phaseId = context.phaseId ?? (taskId || attemptId ? "P01" : undefined);
  const entity: RuntimeEntityRef = kind === "run"
    ? { kind, id: state.runId }
    : kind === "workspace"
      ? { kind, id: `${state.runId}:workspace` }
      : kind === "task"
        ? { kind, id: taskId ?? "T001" }
        : kind === "attempt"
          ? { kind, id: attemptId ?? "attempt-b3" }
          : { kind, id: taskId ?? "entity-b3" };
  const occurredAt = "2026-09-05T05:00:10.000Z";
  return createRalphEventV2({
    eventId: `b3-fixture-${state.lastSequence + 1}-${eventType}`,
    eventType,
    schemaVersion: EVENT_SCHEMA_V2,
    runId: state.runId,
    sequence: state.lastSequence + 1,
    occurredAt,
    recordedAt: occurredAt,
    entity,
    ...(phaseId === undefined ? {} : { phaseId }),
    ...(taskId === undefined ? {} : { taskId }),
    ...(attemptId === undefined ? {} : { attemptId }),
    actor: "CORE",
    causationId: null,
    correlationId: `${state.runId}:b3-fixture`,
    payload,
    previousEventHash: state.lastEventHash,
  } as UnsignedRalphEventV2<TType>) as RalphEventV2;
}

async function append(
  store: RalphEventStoreV2,
  state: RalphRuntimeStateV2,
  next: RalphEventV2,
  nonce: string,
): Promise<RalphRuntimeStateV2> {
  return (await commitRalphEventV2({ store, state, event: next, writtenAt: "2026-09-05T05:00:11.000Z", nonce })).state;
}

async function initialized(root: string, document = plan(), runId = RUN_ID): Promise<{
  readonly store: RalphEventStoreV2;
  readonly snapshot: RunSnapshotV2;
  readonly genesis: RalphRuntimeStateV2;
  readonly state: RalphRuntimeStateV2;
  readonly plan: ExecutionDocument;
}> {
  const snapshot = await snapshotFor(root, document, runId);
  const store = new RalphEventStoreV2({ projectRoot: root, runId });
  const initial = genesis(document, runId);
  const result = await initializeOperationalRunV2({
    store,
    snapshot,
    genesisState: initial,
    runCreatedEvent: event(initial, "run.created", { phaseIds: initial.phaseIds, taskIds: initial.taskIds }),
    createdAt: "2026-09-05T05:00:01.000Z",
    nonce: "b3-init",
  });
  return { store, snapshot, genesis: initial, state: result.state, plan: document };
}

async function activeReady(
  root: string,
  document = plan(),
  checkpoint = true,
  runId = RUN_ID,
): Promise<Awaited<ReturnType<typeof initialized>>> {
  const base = await initialized(root, document, runId);
  let state = await append(base.store, base.state, event(base.state, "run.started", {}), "b3-run-started");
  for (const candidate of document.phases[0]?.tasks ?? []) {
    state = await append(base.store, state, event(state, "task.state-changed", {
      disposition: "READY",
      activity: "IDLE",
      owner: "NONE",
      hold: "NONE",
    }, { phaseId: "P01", taskId: candidate.id }), `b3-ready-${candidate.id}`);
  }
  if (checkpoint) {
    state = await append(base.store, state, event(state, "workspace.checkpointed", {
      checkpoint: {
        kind: "runStartFingerprint",
        fingerprintDigest: base.snapshot.initialWorkspaceFingerprint.fingerprintDigest,
        emittedAt: "2026-09-05T05:00:02.000Z",
      },
    }), "b3-checkpoint");
  }
  return { ...base, state };
}

function leaseInput(
  fixture: Awaited<ReturnType<typeof initialized>>,
  processIdentityProvider: ProcessIdentityProvider = identityProvider(ownerIdentity),
  overrides: Partial<LeaseRuntimeInputV2> = {},
): LeaseRuntimeInputV2 {
  return {
    projectRoot: fixture.store.projectRoot,
    runId: fixture.store.runId,
    genesisState: fixture.genesis,
    processIdentityProvider,
    externalFacts: undefined,
    ...overrides,
  };
}

async function acquire(
  fixture: Awaited<ReturnType<typeof initialized>>,
  processIdentityProvider: ProcessIdentityProvider = identityProvider(ownerIdentity),
  overrides: Partial<LeaseRuntimeInputV2> = {},
) {
  return acquireLeasedRunV2(leaseInput(fixture, processIdentityProvider, overrides));
}

function nonceFactory(prefix: string): () => string {
  let ordinal = 0;
  return () => `${prefix}-${++ordinal}`;
}

function prepareInput(
  leasedRun: Awaited<ReturnType<typeof acquire>>,
  document: ExecutionDocument,
  options: Partial<Omit<PrepareNextAuthorizedInvocationV2Input, "leasedRun" | "plan">> = {},
): PrepareNextAuthorizedInvocationV2Input {
  return {
    leasedRun,
    plan: document,
    planIdentity: document.artifactId,
    planDigest: sha256Canonical(document),
    clock: () => "2026-09-05T05:00:20.000Z",
    nonceFactory: nonceFactory("b3-artifact"),
    ...options,
  };
}

function eventTypes(events: readonly RalphEventV2[]): readonly string[] {
  return events.map((candidate) => candidate.eventType);
}

describe("Ralph Operational Core V2 — B3 admission and dispatch authorization", () => {
  it("recomputes the candidate under lease and stops at AUTHORIZED_NOT_INVOKED", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b3-endpoint-"));
    try {
      const fixture = await activeReady(root, plan(), false);
      const leased = await acquire(fixture);
      const result = await prepareNextAuthorizedInvocationV2(prepareInput(leased, fixture.plan, {
        attemptIdFactory: () => "attempt-core-b3",
        eventIdFactory: () => "event-core-b3",
      }));

      expect(result.kind).toBe("AUTHORIZED_NOT_INVOKED");
      if (result.kind !== "AUTHORIZED_NOT_INVOKED") throw new Error("test narrowing");
      expect(result.outcome).toBe("AUTHORIZED_NOT_INVOKED");
      expect(result.attempt.attempt.attemptId).toBe("attempt-core-b3");
      expect(result.attempt.attempt.ordinal).toBe(1);
      expect(result.attempt.attempt.stage).toBe("EXECUTOR_DISPATCH_AUTHORIZED");
      expect(result.leaseReleased).toBe(true);
      expect(result.authorizedInvocation.kind).toBe("AUTHORIZED_INVOCATION");
      expect(result.invocation.invocationId).toBe(invocationIdForBindingV2({
        runId: fixture.store.runId,
        phase: fixture.plan.phases[0]!,
        task: fixture.plan.phases[0]!.tasks[0]!,
        attempt: result.attempt.attempt,
        planIdentity: fixture.plan.artifactId,
        planDigest: sha256Canonical(fixture.plan),
        snapshot: fixture.snapshot,
        workUnit: result.workUnit,
      }));

      const inspected = await fixture.store.inspect();
      expect(eventTypes(inspected.events)).toContain("workspace.checkpointed");
      expect(eventTypes(inspected.events)).toContain("attempt.started");
      expect(eventTypes(inspected.events)).toContain("executor.dispatch-authorized");
      expect(eventTypes(inspected.events)).not.toContain("executor.started");
      expect(await readWorkUnitV2(fixture.store, result.attempt.attempt.attemptId)).toEqual(result.workUnit);
      expect(await readInvocationDescriptorV2(fixture.store, result.attempt.attempt.attemptId)).toEqual(result.invocation);

      const resumed = await acquire(fixture);
      const resumedResult = await prepareNextAuthorizedInvocationV2(prepareInput(resumed, fixture.plan, {
        attemptIdFactory: () => { throw new Error("must not create another Attempt"); },
      }));
      expect(resumedResult.kind).toBe("ALREADY_AUTHORIZED");
      if (resumedResult.kind !== "ALREADY_AUTHORIZED") throw new Error("test narrowing");
      expect(resumedResult.attempt.attempt.attemptId).toBe(result.attempt.attempt.attemptId);
      expect(resumedResult.invocation.invocationId).toBe(result.invocation.invocationId);
      expect((await fixture.store.inspect()).events.filter((candidate) => candidate.eventType === "attempt.started")).toHaveLength(1);
      expect((await fixture.store.inspect()).events.filter((candidate) => candidate.eventType === "executor.dispatch-authorized")).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a RunSnapshot replacement before dispatch authorization", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b3-snapshot-race-"));
    try {
      const fixture = await activeReady(root);
      const snapshotPath = join(fixture.store.runDirectory, "run-snapshot.json");
      let changed = false;
      const fs = {
        ...nodeRalphRuntimeFileSystem,
        readFile: async (path: string) => {
          const bytes = await nodeRalphRuntimeFileSystem.readFile(path);
          if (!changed && path.endsWith("/work-unit.json")) {
            changed = true;
            const snapshot = JSON.parse((await nodeRalphRuntimeFileSystem.readFile(snapshotPath)).toString("utf8")) as Record<string, unknown>;
            await nodeRalphRuntimeFileSystem.writeFile(
              snapshotPath,
              Buffer.from(canonicalJson({ ...snapshot, createdAt: "2026-09-05T05:00:21.000Z" }), "utf8"),
              { flag: "w", mode: 0o600 },
            );
          }
          return bytes;
        },
      };
      const leased = await acquire(fixture, identityProvider(ownerIdentity), { fs });
      await expect(prepareNextAuthorizedInvocationV2(prepareInput(leased, fixture.plan, {
        attemptIdFactory: () => "attempt-snapshot-race",
      }))).rejects.toMatchObject({ code: "B3_PLAN_IDENTITY_MISMATCH" });
      expect((await fixture.store.inspect()).events.filter((candidate) => candidate.eventType === "executor.dispatch-authorized")).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not trust a caller-supplied digest for a changed plan document", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b3-plan-digest-"));
    try {
      const fixture = await activeReady(root);
      const leased = await acquire(fixture);
      const changedPlan = { ...fixture.plan, title: "changed after Ready" };
      await expect(prepareNextAuthorizedInvocationV2(prepareInput(leased, changedPlan, {
        planDigest: sha256Canonical(fixture.plan),
        attemptIdFactory: () => "must-not-admit",
      }))).rejects.toMatchObject({ code: "B3_PLAN_IDENTITY_MISMATCH" });
      expect((await fixture.store.inspect()).events.filter((candidate) => candidate.eventType === "attempt.started")).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discards an advisory pre-lease candidate after another runtime changes state", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b3-toctou-"));
    try {
      const document = plan([task("T001"), task("T002")]);
      const fixture = await activeReady(root, document, true);
      const advisoryFingerprint = fixture.snapshot.initialWorkspaceFingerprint;
      const advisory = scheduleNextTask({
        plan: document,
        state: fixture.state,
        runtimeIntegrityFacts: { valid: true, controlPlaneValid: true, admissionValid: true },
        fingerprintComparison: { valid: true, checkpointValid: true, expectedFingerprint: advisoryFingerprint.fingerprintDigest, observedFingerprint: advisoryFingerprint.fingerprintDigest },
      });
      expect(advisory.kind).toBe("CANDIDATE");
      if (advisory.kind !== "CANDIDATE") throw new Error("test narrowing");
      expect(advisory.candidate.taskId).toBe("T001");

      const runtimeB = await acquire(fixture, identityProvider(ownerIdentity));
      const changed = event(runtimeB.state, "task.state-changed", {
        disposition: "PAUSED",
        activity: "IDLE",
        owner: "NONE",
        hold: "NONE",
      }, { phaseId: "P01", taskId: "T001" });
      await append(runtimeB.store, runtimeB.state, changed, "b3-pause-t001");
      await refreshLeasedRunV2(runtimeB);
      await releaseLeasedRunV2(runtimeB);

      const runtimeA = await acquire(fixture, identityProvider(secondIdentity));
      const result = await prepareNextAuthorizedInvocationV2(prepareInput(runtimeA, document, { attemptIdFactory: () => "attempt-t002" }));
      expect(result.kind).toBe("AUTHORIZED_NOT_INVOKED");
      if (result.kind !== "AUTHORIZED_NOT_INVOKED") throw new Error("test narrowing");
      expect(result.attempt.taskId).toBe("T002");
      expect(result.attempt.attempt.attemptId).toBe("attempt-t002");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("inherits Scheduler dependency barriers instead of admitting a blocked dependent Task", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b3-dependency-"));
    try {
      const document = plan([task("T001"), task("T002", ["T001"])]);
      const fixture = await activeReady(root, document, true);
      const leased = await acquire(fixture);
      const result = await prepareNextAuthorizedInvocationV2(prepareInput(leased, document, { attemptIdFactory: () => "attempt-dependency" }));
      expect(result.kind).toBe("AUTHORIZED_NOT_INVOKED");
      if (result.kind !== "AUTHORIZED_NOT_INVOKED") throw new Error("test narrowing");
      expect(result.attempt.taskId).toBe("T001");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resumes ADMITTED with the same Attempt and reuses immutable artifacts", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b3-resume-"));
    try {
      const fixture = await activeReady(root);
      let failInvocation = true;
      const fs = {
        ...nodeRalphRuntimeFileSystem,
        writeFile: async (path: string, data: string | Buffer, options?: { readonly flag?: string; readonly mode?: number }) => {
          if (failInvocation && path.includes("/invocation.json")) {
            failInvocation = false;
            const error = Object.assign(new Error("injected invocation write failure"), { code: "EIO" });
            throw error;
          }
          await nodeRalphRuntimeFileSystem.writeFile(path, data, options);
        },
      };
      const first = await acquire(fixture, identityProvider(ownerIdentity), { fs });
      await expect(prepareNextAuthorizedInvocationV2(prepareInput(first, fixture.plan, { attemptIdFactory: () => "attempt-resume" }))).rejects.toMatchObject({ code: "ARTIFACT_PERSISTENCE_FAILED" });
      expect((await fixture.store.inspect()).events.filter((candidate) => candidate.eventType === "attempt.started")).toHaveLength(1);
      expect((await fixture.store.inspect()).events.filter((candidate) => candidate.eventType === "executor.dispatch-authorized")).toHaveLength(0);
      await releaseLeasedRunV2(first);

      const second = await acquire(fixture, identityProvider(secondIdentity), { fs });
      const result = await prepareNextAuthorizedInvocationV2(prepareInput(second, fixture.plan, {
        attemptIdFactory: () => { throw new Error("must reuse the open Attempt"); },
      }));
      expect(result.kind).toBe("AUTHORIZED_NOT_INVOKED");
      if (result.kind !== "AUTHORIZED_NOT_INVOKED") throw new Error("test narrowing");
      expect(result.attempt.attempt.attemptId).toBe("attempt-resume");
      expect(result.attempt.attempt.ordinal).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists attempt.started before WorkUnit and invocation, and keeps artifacts immutable", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b3-order-"));
    try {
      const fixture = await activeReady(root);
      const writes: string[] = [];
      const fs = {
        ...nodeRalphRuntimeFileSystem,
        writeFile: async (path: string, data: string | Buffer, options?: { readonly flag?: string; readonly mode?: number }) => {
          if (path.includes("/events/")) writes.push("event");
          if (path.includes("/work-unit.json")) writes.push("work-unit");
          if (path.includes("/invocation.json")) writes.push("invocation");
          await nodeRalphRuntimeFileSystem.writeFile(path, data, options);
        },
      };
      const leased = await acquire(fixture, identityProvider(ownerIdentity), { fs });
      const result = await prepareNextAuthorizedInvocationV2(prepareInput(leased, fixture.plan, { attemptIdFactory: () => "attempt-order" }));
      expect(result.kind).toBe("AUTHORIZED_NOT_INVOKED");
      expect(writes.indexOf("event")).toBeLessThan(writes.indexOf("work-unit"));
      expect(writes.indexOf("work-unit")).toBeLessThan(writes.indexOf("invocation"));

      if (result.kind !== "AUTHORIZED_NOT_INVOKED") throw new Error("test narrowing");
      const conflicting = {
        ...result.workUnit,
        title: "divergent immutable descriptor",
      };
      const { workUnitDigest: _ignored, ...withoutDigest } = conflicting;
      const conflictWithDigest = { ...conflicting, workUnitDigest: sha256Canonical(withoutDigest) };
      await expect(persistWorkUnitV2(fixture.store, conflictWithDigest, "b3-conflict")).rejects.toMatchObject({ code: "ARTIFACT_IMMUTABLE_CONFLICT" });
      const invocationConflict = { ...result.invocation, timeoutPolicyDigest: sha256("different-timeout-policy") };
      await expect(persistInvocationDescriptorV2(fixture.store, invocationConflict, "b3-invocation-conflict")).rejects.toMatchObject({ code: "ARTIFACT_IMMUTABLE_CONFLICT" });
      expect(await readWorkUnitV2(fixture.store, result.workUnit.attemptId)).toEqual(result.workUnit);
      expect(await readInvocationDescriptorV2(fixture.store, result.workUnit.attemptId)).toEqual(result.invocation);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops on lease loss before the first B3 critical boundary", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b3-loss-"));
    try {
      const fixture = await activeReady(root);
      const leased = await acquire(fixture);
      await nodeRalphRuntimeFileSystem.unlink(leased.leasePath);
      await expect(prepareNextAuthorizedInvocationV2(prepareInput(leased, fixture.plan, { attemptIdFactory: () => "must-not-admit" }))).rejects.toMatchObject({ code: "LEASE_LOST" });
      expect((await fixture.store.inspect()).events).toHaveLength(4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when a valid replacement lease is installed under the old B3 handle", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b3-replaced-lease-"));
    try {
      const fixture = await activeReady(root);
      const oldHandle = await acquire(fixture, identityProvider(ownerIdentity));
      const oldLeaseId = oldHandle.leaseId;
      await unlink(oldHandle.leasePath);
      const replacement = await acquire(fixture, identityProvider(secondIdentity));
      const replacementBytes = await readFile(replacement.leasePath);
      expect(replacement.leaseId).not.toBe(oldLeaseId);

      await expect(prepareNextAuthorizedInvocationV2(prepareInput(oldHandle, fixture.plan, {
        attemptIdFactory: () => "must-not-admit-replaced-lease",
      }))).rejects.toMatchObject({ code: "LEASE_LOST" });

      expect(await readFile(replacement.leasePath)).toEqual(replacementBytes);
      expect(JSON.parse(replacementBytes.toString("utf8")).leaseId).toBe(replacement.leaseId);
      expect((await fixture.store.inspect()).events).toHaveLength(4);
      expect((await fixture.store.inspect()).events.filter((candidate) => candidate.eventType === "attempt.started")).toHaveLength(0);
      expect((await fixture.store.inspect()).events.filter((candidate) => candidate.eventType === "executor.dispatch-authorized")).toHaveLength(0);
      expect(await readWorkUnitV2(fixture.store, "must-not-admit-replaced-lease")).toBeUndefined();
      expect(await readInvocationDescriptorV2(fixture.store, "must-not-admit-replaced-lease")).toBeUndefined();
      await releaseLeasedRunV2(replacement);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("revalidates lease ownership immediately before dispatch authorization", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b3-loss-dispatch-"));
    try {
      const fixture = await activeReady(root);
      let leasePath = "";
      const fs = {
        ...nodeRalphRuntimeFileSystem,
        readFile: async (path: string) => {
          const bytes = await nodeRalphRuntimeFileSystem.readFile(path);
          if (path.endsWith("/invocation.json")) {
            await nodeRalphRuntimeFileSystem.unlink(leasePath);
          }
          return bytes;
        },
      };
      const leased = await acquire(fixture, identityProvider(ownerIdentity), { fs });
      leasePath = leased.leasePath;
      await expect(prepareNextAuthorizedInvocationV2(prepareInput(leased, fixture.plan, {
        attemptIdFactory: () => "attempt-loss-dispatch",
      }))).rejects.toMatchObject({ code: "LEASE_LOST" });
      expect((await fixture.store.inspect()).events.filter((candidate) => candidate.eventType === "executor.dispatch-authorized")).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("gives one authoritative path to two independent runtimes", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b3-race-"));
    try {
      const fixture = await activeReady(root);
      const locks = join(fixture.store.runDirectory, "locks");
      let paused = false;
      let enteredResolve: (() => void) | undefined;
      const entered = new Promise<void>((resolveEntered) => { enteredResolve = resolveEntered; });
      let releaseGate: (() => void) | undefined;
      const gate = new Promise<void>((resolveGate) => { releaseGate = resolveGate; });
      const fs = {
        ...nodeRalphRuntimeFileSystem,
        fsyncDirectory: async (path: string) => {
          if (path === locks && !paused) {
            paused = true;
            enteredResolve?.();
            await gate;
          }
          await nodeRalphRuntimeFileSystem.fsyncDirectory(path);
        },
      };
      const attempt = async (identity: ProcessIdentity, attemptId: string) => {
        try {
          const leased = await acquire(fixture, identityProvider(identity), { fs });
          return await prepareNextAuthorizedInvocationV2(prepareInput(leased, fixture.plan, { attemptIdFactory: () => attemptId }));
        } catch (error) {
          return error;
        }
      };
      const first = attempt(ownerIdentity, "attempt-race-a");
      const second = attempt(secondIdentity, "attempt-race-b");
      await entered;
      releaseGate?.();
      const results = await Promise.all([first, second]);
      expect(results.filter((result) => result && typeof result === "object" && "kind" in result && (result as { readonly kind?: unknown }).kind === "AUTHORIZED_NOT_INVOKED")).toHaveLength(1);
      const errors = results.filter((result) => result instanceof Error);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ code: "LEASE_ALREADY_HELD" });
      const inspected = await fixture.store.inspect();
      expect(inspected.events.filter((candidate) => candidate.eventType === "attempt.started")).toHaveLength(1);
      expect(inspected.events.filter((candidate) => candidate.eventType === "executor.dispatch-authorized")).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops on UNKNOWN attempt.started publication without creating artifacts", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b3-unknown-attempt-"));
    try {
      const fixture = await activeReady(root);
      let failed = false;
      const events = join(fixture.store.runDirectory, "events");
      const fs = {
        ...nodeRalphRuntimeFileSystem,
        fsyncDirectory: async (path: string) => {
          if (path === events && !failed) {
            failed = true;
            throw new Error("attempt event durability unknown");
          }
          await nodeRalphRuntimeFileSystem.fsyncDirectory(path);
        },
      };
      const leased = await acquire(fixture, identityProvider(ownerIdentity), { fs });
      await expect(prepareNextAuthorizedInvocationV2(prepareInput(leased, fixture.plan, { attemptIdFactory: () => "attempt-unknown" }))).rejects.toMatchObject({ code: "RALPH_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION" });
      expect(await readWorkUnitV2(fixture.store, "attempt-unknown")).toBeUndefined();
      expect((await fixture.store.inspect()).events.filter((candidate) => candidate.eventType === "executor.dispatch-authorized")).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops on UNKNOWN WorkUnit publication without writing invocation", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b3-unknown-workunit-"));
    try {
      const fixture = await activeReady(root);
      let failed = false;
      const fs = {
        ...nodeRalphRuntimeFileSystem,
        fsyncDirectory: async (path: string) => {
          if (path.endsWith("/attempt-unknown-workunit") && !failed) {
            failed = true;
            throw new Error("WorkUnit durability unknown");
          }
          await nodeRalphRuntimeFileSystem.fsyncDirectory(path);
        },
      };
      const leased = await acquire(fixture, identityProvider(ownerIdentity), { fs });
      await expect(prepareNextAuthorizedInvocationV2(prepareInput(leased, fixture.plan, { attemptIdFactory: () => "attempt-unknown-workunit" }))).rejects.toMatchObject({ code: "ARTIFACT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION" });
      expect(await readInvocationDescriptorV2(fixture.store, "attempt-unknown-workunit")).toBeUndefined();
      expect((await fixture.store.inspect()).events.filter((candidate) => candidate.eventType === "executor.dispatch-authorized")).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops on UNKNOWN invocation publication without dispatch authorization", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b3-unknown-invocation-"));
    try {
      const fixture = await activeReady(root);
      let attemptDirectoryFsyncs = 0;
      const attemptDirectory = join(fixture.store.runDirectory, "attempts", "attempt-unknown-invocation");
      const fs = {
        ...nodeRalphRuntimeFileSystem,
        fsyncDirectory: async (path: string) => {
          if (path === attemptDirectory) {
            attemptDirectoryFsyncs += 1;
            if (attemptDirectoryFsyncs === 3) throw new Error("invocation durability unknown");
          }
          await nodeRalphRuntimeFileSystem.fsyncDirectory(path);
        },
      };
      const leased = await acquire(fixture, identityProvider(ownerIdentity), { fs });
      await expect(prepareNextAuthorizedInvocationV2(prepareInput(leased, fixture.plan, { attemptIdFactory: () => "attempt-unknown-invocation" }))).rejects.toMatchObject({ code: "ARTIFACT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION" });
      expect(await readWorkUnitV2(fixture.store, "attempt-unknown-invocation")).toBeTruthy();
      expect((await fixture.store.inspect()).events.filter((candidate) => candidate.eventType === "executor.dispatch-authorized")).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops on UNKNOWN dispatch publication and requires ledger inspection", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b3-unknown-dispatch-"));
    try {
      const fixture = await activeReady(root);
      let eventDirectoryFsyncs = 0;
      const events = join(fixture.store.runDirectory, "events");
      const fs = {
        ...nodeRalphRuntimeFileSystem,
        fsyncDirectory: async (path: string) => {
          if (path === events) {
            eventDirectoryFsyncs += 1;
            if (eventDirectoryFsyncs === 3) throw new Error("dispatch durability unknown");
          }
          await nodeRalphRuntimeFileSystem.fsyncDirectory(path);
        },
      };
      const leased = await acquire(fixture, identityProvider(ownerIdentity), { fs });
      await expect(prepareNextAuthorizedInvocationV2(prepareInput(leased, fixture.plan, { attemptIdFactory: () => "attempt-unknown-dispatch" }))).rejects.toMatchObject({ code: "RALPH_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION" });
      const reopened = await inspectOperationalRunV2({ projectRoot: root, runId: RUN_ID, genesisState: fixture.genesis });
      expect(reopened.outcome).toBe("READY_FOR_LEASE");
      expect(reopened.state?.attempts["attempt-unknown-dispatch"]?.stage).toBe("EXECUTOR_DISPATCH_AUTHORIZED");
      expect(reopened.ledger?.events.filter((candidate) => candidate.eventType === "executor.dispatch-authorized")).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports release durability uncertainty after authorization instead of claiming a clean endpoint", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b3-release-unknown-"));
    try {
      const fixture = await activeReady(root);
      const locks = join(fixture.store.runDirectory, "locks");
      let lockFsyncs = 0;
      const fs = {
        ...nodeRalphRuntimeFileSystem,
        fsyncDirectory: async (path: string) => {
          if (path === locks) {
            lockFsyncs += 1;
            if (lockFsyncs === 3) throw new Error("lease release durability unknown");
          }
          await nodeRalphRuntimeFileSystem.fsyncDirectory(path);
        },
      };
      const leased = await acquire(fixture, identityProvider(ownerIdentity), { fs });
      await expect(prepareNextAuthorizedInvocationV2(prepareInput(leased, fixture.plan, { attemptIdFactory: () => "attempt-release-unknown" }))).rejects.toMatchObject({ code: "LEASE_RELEASE_DURABILITY_UNKNOWN_REQUIRES_INSPECTION" });
      expect((await fixture.store.inspect()).events.filter((candidate) => candidate.eventType === "executor.dispatch-authorized")).toHaveLength(1);
      await expect(inspectRunLeaseV2(leased.store)).resolves.toMatchObject({ kind: "ABSENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects artifact symlink targets and keeps the bounded attempt path", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b3-path-"));
    const outside = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b3-outside-"));
    try {
      const fixture = await activeReady(root);
      const leased = await acquire(fixture);
      const result = await prepareNextAuthorizedInvocationV2(prepareInput(leased, fixture.plan, { attemptIdFactory: () => "attempt-path" }));
      expect(result.kind).toBe("AUTHORIZED_NOT_INVOKED");
      if (result.kind !== "AUTHORIZED_NOT_INVOKED") throw new Error("test narrowing");
      expect(() => workUnitPathV2(fixture.store, "../escape")).toThrow();
      await unlink(workUnitPathV2(fixture.store, result.workUnit.attemptId));
      await symlink(outside, workUnitPathV2(fixture.store, result.workUnit.attemptId));
      await expect(readWorkUnitV2(fixture.store, "attempt-path")).rejects.toMatchObject({ code: "ARTIFACT_PATH_UNSAFE" });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("uses restricted immutable artifact schemas and never persists secret material", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-b3-security-"));
    try {
      const fixture = await activeReady(root);
      const leased = await acquire(fixture);
      const result = await prepareNextAuthorizedInvocationV2(prepareInput(leased, fixture.plan, { attemptIdFactory: () => "attempt-security" }));
      expect(result.kind).toBe("AUTHORIZED_NOT_INVOKED");
      if (result.kind !== "AUTHORIZED_NOT_INVOKED") throw new Error("test narrowing");
      const workUnitBytes = await readFile(workUnitPathV2(fixture.store, result.workUnit.attemptId), "utf8");
      const invocationBytes = await readFile(invocationDescriptorPathV2(fixture.store, result.invocation.attemptId), "utf8");
      expect(workUnitBytes).toBe(canonicalJson(JSON.parse(workUnitBytes)));
      expect(invocationBytes).toBe(canonicalJson(JSON.parse(invocationBytes)));
      expect(workUnitBytes).not.toMatch(/Bearer|api[_-]?key|password|private key|ownerToken/i);
      expect(invocationBytes).not.toMatch(/Bearer|api[_-]?key|password|private key|ownerToken/i);
      expect(ARTIFACT_ERROR_CODES).toContain("ARTIFACT_IMMUTABLE_CONFLICT");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads every intended B2+B3 production file and proves the no-execution boundary", async () => {
    const files = [
      "../../src/vnext/ralph-runtime/operational-b2/process-identity.ts",
      "../../src/vnext/ralph-runtime/operational-b2/run-lease.ts",
      "../../src/vnext/ralph-runtime/operational-b2/index.ts",
      "../../src/vnext/ralph-runtime/operational-b3/artifacts.ts",
      "../../src/vnext/ralph-runtime/operational-b3/admission.ts",
      "../../src/vnext/ralph-runtime/operational-b3/index.ts",
    ].map((file) => resolve(TEST_DIRECTORY, file));
    const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
    expect(source.length).toBeGreaterThan(0);
    expect(source).not.toMatch(/node:child_process|\b(?:spawn|exec|execFile|fork)\s*\(|\b(?:ExecutorRuntime|ScriptedExecutor|ValidationRunner)\b|\b(?:Codex|Claude|OpenCode|OpenAI|Anthropic|DeepSeek|MiniMax)\b|provider\s+registry|model\s+API|executor\.started/i);
  });
});
