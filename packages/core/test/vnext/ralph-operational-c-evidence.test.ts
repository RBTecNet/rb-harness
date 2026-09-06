import { chmod, mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
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
  initializeOperationalRunV2,
  RalphEventStoreV2,
  type RunSnapshotV2,
} from "../../src/vnext/ralph-runtime/operational-b1/index.js";
import {
  acquireLeasedRunV2,
  type LeaseRuntimeInputV2,
  type ProcessIdentity,
  type ProcessIdentityProvider,
} from "../../src/vnext/ralph-runtime/operational-b2/index.js";
import { prepareNextAuthorizedInvocationV2 } from "../../src/vnext/ralph-runtime/operational-b3/index.js";
import {
  executeAuthorizedInvocationV2,
  ScriptedExecutor,
  type ScriptedExecutorScenarioV2,
} from "../../src/vnext/ralph-runtime/operational-b4/index.js";
import {
  captureEvidenceV2,
  createEvidenceCaptureV2,
  deriveWorkspaceChangesV2,
  validateEvidenceCaptureV2,
  type EvidenceCaptureV2,
} from "../../src/vnext/ralph-runtime/operational-c/index.js";
import { createWorkspaceManifestV2 } from "../../src/vnext/ralph-runtime/operational-b4/workspace-manifest.js";
import { canonicalJson } from "../../src/vnext/ralph-runtime/canonical-json.js";
import { createWorkspacePolicy, fingerprintWorkspace, nodeWorkspaceFingerprintFileSystem, type WorkspaceFingerprintFileSystem } from "../../src/vnext/ralph-runtime/fingerprint.js";
import { nodeRalphRuntimeFileSystem, type RalphRuntimeFileSystem } from "../../src/vnext/ralph-runtime/event-store.js";
import { sha256, sha256Canonical } from "../../src/vnext/ralph-runtime/hashing.js";

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const ownerIdentity: ProcessIdentity = {
  pid: 53201,
  processStartIdentity: "c-owner-start",
  hostIdentity: "c-host",
  bootSessionIdentity: "c-boot",
};

function identityProvider(): ProcessIdentityProvider {
  return { current: () => ownerIdentity, inspect: () => "MATCH" };
}

function descriptor(schemaVersion: string, descriptorId: string): { readonly schemaVersion: string; readonly descriptorId: string; readonly descriptorDigest: string } {
  const base = { schemaVersion, descriptorId };
  return { ...base, descriptorDigest: sha256Canonical(base) };
}

function task(): Task {
  return {
    id: "T001",
    title: "Capture evidence",
    done: false,
    scope: "src",
    change: "make a fixture workspace change",
    covers: "src",
    dependsOn: [],
    parallelSafe: false,
    acceptanceCriteria: ["the fixture change is observed"],
    validation: ["`printf validation`"],
    expectedEvidence: "workspace diff",
    line: 1,
  };
}

function plan(): ExecutionDocument {
  const phase: Phase = { number: 1, id: "P01", title: "C phase", goal: "capture", dependsOn: [], context: ["test"], tasks: [task()], line: 1 };
  return { contract: "rb-execution/v1", artifactId: "plan-c", title: "C", phases: [phase] };
}

function genesis(document: ExecutionDocument, runId: string): RalphRuntimeStateV2 {
  return createInitialRuntimeStateV2({
    runId,
    phases: document.phases.map((phase) => ({ phaseId: phase.id, taskIds: phase.tasks.map((candidate) => candidate.id) })),
    tasks: document.phases.flatMap((phase) => phase.tasks.map((candidate) => ({ taskId: candidate.id, phaseId: phase.id, dependsOn: candidate.dependsOn }))),
  });
}

function event<TType extends RalphEventTypeV2>(state: RalphRuntimeStateV2, eventType: TType, payload: EventPayloadMapV2[TType], context: { readonly phaseId?: string; readonly taskId?: string; readonly attemptId?: string } = {}): RalphEventV2 {
  const kind = V2_EVENT_ENTITY_KINDS[eventType];
  const entity: RuntimeEntityRef = kind === "run"
    ? { kind, id: state.runId }
    : kind === "workspace"
      ? { kind, id: `${state.runId}:workspace` }
      : kind === "task"
        ? { kind, id: context.taskId ?? "T001" }
        : { kind: "attempt", id: context.attemptId ?? "attempt-c-001" };
  const occurredAt = "2026-09-06T06:00:10.000Z";
  return createRalphEventV2({
    eventId: `c-fixture-${state.lastSequence + 1}-${eventType}`,
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
    correlationId: `${state.runId}:c-fixture`,
    payload,
    previousEventHash: state.lastEventHash,
  } as UnsignedRalphEventV2<TType>) as RalphEventV2;
}

async function append(store: RalphEventStoreV2, state: RalphRuntimeStateV2, next: RalphEventV2, nonce: string): Promise<RalphRuntimeStateV2> {
  return (await commitRalphEventV2({ store, state, event: next, writtenAt: "2026-09-06T06:00:11.000Z", nonce })).state;
}

async function createFixture(prefix: string, runId: string): Promise<{ readonly root: string; readonly store: RalphEventStoreV2; readonly genesis: RalphRuntimeStateV2; readonly document: ExecutionDocument }> {
  const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", prefix));
  const document = plan();
  const policy = createWorkspacePolicy();
  const fingerprint = await fingerprintWorkspace(root, policy);
  const config = descriptor("rb-ralph-config/v2", "c-config");
  const snapshot: RunSnapshotV2 = {
    snapshotSchemaVersion: RALPH_RUN_SNAPSHOT_V2_SCHEMA,
    runId,
    eventSchema: EVENT_SCHEMA_V2,
    stateSchema: STATE_SCHEMA_V2,
    operationalContract: OPERATIONAL_CONTRACT_V2,
    projectIdentity: { projectId: "c-test-project" },
    readyPlanIdentity: document.artifactId,
    readyPlanHash: sha256Canonical(document),
    readyManifestHash: sha256("c-ready-manifest"),
    selectedReadyArtifactHashes: { plan: sha256Canonical(document) },
    readinessInspectionDigest: sha256("c-readiness"),
    effectiveRunConfig: config,
    effectiveConfigDigest: config.descriptorDigest,
    diagnosticsPolicy: descriptor("rb-ralph-diagnostics/v2", "c-diagnostics"),
    environmentPolicy: descriptor("rb-ralph-environment/v2", "c-environment"),
    executorProfile: { profileId: "scripted-c", kind: "scripted", descriptorDigest: sha256("c-profile") },
    executorCapabilities: { requested: ["fixture.effect"], granted: ["fixture.effect"], verified: ["fixture.effect"], readOnlyEnforced: false },
    permissionCapabilityPolicy: descriptor("rb-ralph-capabilities/v2", "c-capabilities"),
    workspacePolicy: policy,
    initialWorkspaceFingerprint: { controlPlaneFingerprint: fingerprint.controlPlaneFingerprint, productWorkspaceFingerprint: fingerprint.productWorkspaceFingerprint, policyDigest: fingerprint.policyDigest, fingerprintDigest: fingerprint.fingerprintDigest },
    retryPolicies: descriptor("rb-ralph-retry/v2", "c-retry"),
    timeoutPolicy: descriptor("rb-ralph-timeout/v2", "c-timeout"),
    runtimeIdentity: descriptor("rb-ralph-runtime/v2", "c-runtime"),
    leasePolicy: descriptor("rb-ralph-lease/v2", "c-lease"),
    createdAt: "2026-09-06T06:00:00.000Z",
  };
  const store = new RalphEventStoreV2({ projectRoot: root, runId });
  const initial = genesis(document, runId);
  const initialized = await initializeOperationalRunV2({
    store,
    snapshot,
    genesisState: initial,
    runCreatedEvent: event(initial, "run.created", { phaseIds: initial.phaseIds, taskIds: initial.taskIds }),
    createdAt: "2026-09-06T06:00:01.000Z",
    nonce: "c-init",
  });
  let state = await append(store, initialized.state, event(initialized.state, "run.started", {}), "c-start");
  state = await append(store, state, event(state, "task.state-changed", { disposition: "READY", activity: "IDLE", owner: "NONE", hold: "NONE" }, { phaseId: "P01", taskId: "T001" }), "c-ready");
  return { root, store, genesis: initial, document };
}

function leaseInput(fixture: Awaited<ReturnType<typeof createFixture>>, overrides: Partial<LeaseRuntimeInputV2> = {}): LeaseRuntimeInputV2 {
  return { projectRoot: fixture.root, runId: fixture.store.runId, genesisState: fixture.genesis, processIdentityProvider: identityProvider(), ...overrides };
}

let nonceOrdinal = 0;
function nonce(): string { return `c-${++nonceOrdinal}`; }

function evidenceArtifactPath(fixture: Awaited<ReturnType<typeof createFixture>>): string {
  return join(fixture.store.runDirectory, "attempts", "attempt-c-001", "evidence-capture.json");
}

async function rewriteEvidencePathFields(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  fields: Pick<EvidenceCaptureV2, "changedPaths" | "changedPathKinds" | "outsideScopePaths" | "controlPlaneChangedPaths">,
): Promise<void> {
  const persisted = JSON.parse(await readFile(evidenceArtifactPath(fixture), "utf8")) as Record<string, unknown>;
  const base: Record<string, unknown> = { ...persisted, ...fields };
  delete base.evidenceDigest;
  await writeFile(evidenceArtifactPath(fixture), canonicalJson({ ...base, evidenceDigest: sha256Canonical(base) }));
}

function failOnceAfterMarker(marker: string, suffix?: string): RalphRuntimeFileSystem {
  let seen = false;
  let failed = false;
  return {
    ...nodeRalphRuntimeFileSystem,
    writeFile: async (path, data, options) => {
      if (data.toString().includes(marker)) seen = true;
      await nodeRalphRuntimeFileSystem.writeFile(path, data, options);
    },
    fsyncDirectory: async (path) => {
      if (seen && !failed && (suffix === undefined || path.endsWith(suffix))) {
        failed = true;
        throw Object.assign(new Error("injected durability uncertainty"), { code: "EIO" });
      }
      await nodeRalphRuntimeFileSystem.fsyncDirectory(path);
    },
  };
}

async function authorizeAndExecute(fixture: Awaited<ReturnType<typeof createFixture>>, options: { readonly fileSystem?: RalphRuntimeFileSystem; readonly action?: (root: string) => void | Promise<void>; readonly scenarioKind?: ScriptedExecutorScenarioV2["kind"]; readonly safeMetadata?: Readonly<Record<string, string>> } = {}) {
  const leased = await acquireLeasedRunV2(leaseInput(fixture));
  const authorized = await prepareNextAuthorizedInvocationV2({
    leasedRun: leased,
    plan: fixture.document,
    planIdentity: fixture.document.artifactId,
    planDigest: sha256Canonical(fixture.document),
    attemptIdFactory: () => "attempt-c-001",
    eventIdFactory: () => `c-event-${++nonceOrdinal}`,
    nonceFactory: nonce,
    clock: () => "2026-09-06T06:00:20.000Z",
  });
  expect(authorized.kind).toBe("AUTHORIZED_NOT_INVOKED");
  if (authorized.kind !== "AUTHORIZED_NOT_INVOKED") throw new Error("C fixture authorization failed");
  const resumed = await acquireLeasedRunV2(leaseInput(fixture, options.fileSystem === undefined ? {} : { fs: options.fileSystem }));
  const runtime = new ScriptedExecutor({
    clock: () => "2026-09-06T06:00:30.000Z",
    defaultScenario: {
      kind: options.scenarioKind ?? "SUCCESS",
      ...(options.safeMetadata === undefined ? {} : { safeMetadata: options.safeMetadata }),
      fixtureWorkspaceAction: options.action === undefined ? undefined : () => options.action!(fixture.root),
    },
  });
  const executed = await executeAuthorizedInvocationV2({ leasedRun: resumed, plan: fixture.document, runtime, nonceFactory: nonce, eventIdFactory: () => `c-event-${++nonceOrdinal}` });
  expect(executed.kind).toBe("EXECUTOR_FINISHED_READY_FOR_CAPTURE");
  if (executed.kind !== "EXECUTOR_FINISHED_READY_FOR_CAPTURE") throw new Error("C fixture execution failed");
  return { leasedRun: resumed, runtime, authorized, executed };
}

describe("Ralph Operational Core V2 — C EvidenceCapture", () => {
  it("captures immutable before/after evidence and derives changed paths independently", async () => {
    const fixture = await createFixture("rb-ralph-c-happy-", "run-c-happy");
    try {
      const execution = await authorizeAndExecute(fixture, { action: async (root) => {
        const beforeBytes = await readFile(join(fixture.store.runDirectory, "attempts", "attempt-c-001", "workspace-before.json"), "utf8");
        expect(beforeBytes).toContain("rb-ralph-workspace-manifest/v1");
        await mkdir(join(root, "src"), { recursive: true });
        await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
      } });
      const persistedBefore = JSON.parse(await readFile(join(fixture.store.runDirectory, "attempts", "attempt-c-001", "workspace-before.json"), "utf8")) as { readonly fingerprintDigest: string };
      expect(persistedBefore.fingerprintDigest).toBe(execution.authorized.workUnit.attemptBaseFingerprint);
      const result = await captureEvidenceV2({ leasedRun: execution.leasedRun, plan: fixture.document, observation: execution.executed.observation, nonceFactory: nonce, eventIdFactory: () => `c-event-${++nonceOrdinal}`, clock: () => "2026-09-06T06:00:40.000Z" });
      expect(result.kind).toBe("EVIDENCE_CAPTURED_READY_FOR_VALIDATION");
      if (result.kind !== "EVIDENCE_CAPTURED_READY_FOR_VALIDATION") throw new Error("C fixture capture failed");
      expect(result.evidence.schema).toBe("rb-ralph-evidence-capture/v1");
      expect(result.evidence.changedPaths).toContain("src/a.ts");
      expect(result.evidence.outsideScopePaths).toHaveLength(0);
      expect(result.evidence.controlPlaneChangedPaths).toHaveLength(0);
      const events = (await fixture.store.inspect()).events;
      const names = events.map((candidate) => candidate.eventType);
      expect(names).toContain("evidence.capture-started");
      expect(names).toContain("evidence.captured");
      expect(names).not.toContain("validation.started");
      expect(events.find((candidate) => candidate.eventType === "evidence.capture-started")!.sequence).toBeLessThan(events.find((candidate) => candidate.eventType === "evidence.captured")!.sequence);
      expect(await readFile(join(fixture.store.runDirectory, "attempts", "attempt-c-001", "evidence-capture.json"), "utf8")).toContain("rb-ralph-evidence-capture/v1");
      const resumedLease = await acquireLeasedRunV2(leaseInput(fixture));
      const resumedCapture = await captureEvidenceV2({ leasedRun: resumedLease, plan: fixture.document, observation: execution.executed.observation, nonceFactory: nonce, eventIdFactory: () => `c-event-${++nonceOrdinal}` });
      expect(resumedCapture.kind).toBe("EVIDENCE_CAPTURED_READY_FOR_VALIDATION");
      expect(execution.runtime.getInvocationAttempts(execution.authorized.invocation.invocationId)).toBe(1);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("uses the Core manifest diff for changedPaths and preserves false executor claims as claims", async () => {
    const fixture = await createFixture("rb-ralph-c-claims-vs-reality-", "run-c-claims-vs-reality");
    try {
      const execution = await authorizeAndExecute(fixture, {
        safeMetadata: { changedPath: "src/fake.ts" },
        action: async (root) => {
          await mkdir(join(root, "src"), { recursive: true });
          await writeFile(join(root, "src", "a.ts"), "actual workspace change\n");
        },
      });
      const result = await captureEvidenceV2({ leasedRun: execution.leasedRun, plan: fixture.document, observation: execution.executed.observation, nonceFactory: nonce, eventIdFactory: () => `c-event-${++nonceOrdinal}` });
      expect(result.kind).toBe("EVIDENCE_CAPTURED_READY_FOR_VALIDATION");
      if (result.kind !== "EVIDENCE_CAPTURED_READY_FOR_VALIDATION") throw new Error("claims-vs-reality fixture did not capture");
      expect(result.evidence.changedPaths).toContain("src/a.ts");
      expect(result.evidence.changedPaths).not.toContain("src/fake.ts");
      expect(result.evidence.executorClaims).toMatchObject({ changedPath: "src/fake.ts" });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects product-path Evidence resume tampering and accepts the matching immutable cache idempotently", async () => {
    const fixture = await createFixture("rb-ralph-c-resume-product-tamper-", "run-c-resume-product-tamper");
    try {
      const faulty = failOnceAfterMarker("rb-ralph-evidence-capture/v1", "/attempts/attempt-c-001");
      const execution = await authorizeAndExecute(fixture, {
        fileSystem: faulty,
        action: async (root) => {
          await mkdir(join(root, "src"), { recursive: true });
          await writeFile(join(root, "src", "a.ts"), "authoritative product change\n");
        },
      });
      await expect(captureEvidenceV2({ leasedRun: execution.leasedRun, plan: fixture.document, observation: execution.executed.observation, nonceFactory: nonce, eventIdFactory: () => `c-event-${++nonceOrdinal}` }))
        .rejects.toMatchObject({ code: "B4_ARTIFACT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION" });
      expect(execution.leasedRun.state.attempts["attempt-c-001"]?.stage).toBe("EVIDENCE_CAPTURING");
      const beforeBytes = await readFile(join(fixture.store.runDirectory, "attempts", "attempt-c-001", "workspace-before.json"), "utf8");
      const afterBytes = await readFile(join(fixture.store.runDirectory, "attempts", "attempt-c-001", "workspace-after.json"), "utf8");
      expect(beforeBytes).toContain("rb-ralph-workspace-manifest/v1");
      expect(afterBytes).toContain("rb-ralph-workspace-manifest/v1");
      const correctEvidence = await readFile(evidenceArtifactPath(fixture), "utf8");

      await rewriteEvidencePathFields(fixture, {
        changedPaths: [],
        changedPathKinds: [],
        outsideScopePaths: [],
        controlPlaneChangedPaths: [],
      });
      await expect(captureEvidenceV2({ leasedRun: execution.leasedRun, plan: fixture.document, observation: execution.executed.observation, nonceFactory: nonce, eventIdFactory: () => `c-event-${++nonceOrdinal}` }))
        .rejects.toMatchObject({
          code: "C_EVIDENCE_IMMUTABLE_CONFLICT",
          message: expect.stringContaining("derived workspace evidence does not match authoritative manifests"),
        });
      let events = (await fixture.store.inspect()).events;
      expect(events.some((candidate) => candidate.eventType === "evidence.captured")).toBe(false);
      expect(events.some((candidate) => candidate.eventType === "validation.started")).toBe(false);

      await writeFile(evidenceArtifactPath(fixture), correctEvidence);
      const resumed = await captureEvidenceV2({ leasedRun: execution.leasedRun, plan: fixture.document, observation: execution.executed.observation, nonceFactory: nonce, eventIdFactory: () => `c-event-${++nonceOrdinal}` });
      expect(resumed.kind).toBe("EVIDENCE_CAPTURED_READY_FOR_VALIDATION");
      if (resumed.kind !== "EVIDENCE_CAPTURED_READY_FOR_VALIDATION") throw new Error("matching Evidence cache did not resume");
      expect(resumed.evidence.changedPathKinds).toContainEqual({ path: "src/a.ts", kind: "ADDED" });
      expect(execution.runtime.getInvocationAttempts(execution.authorized.invocation.invocationId)).toBe(1);
      events = (await fixture.store.inspect()).events;
      expect(events.filter((candidate) => candidate.eventType === "evidence.captured")).toHaveLength(1);
      expect(events.some((candidate) => candidate.eventType === "validation.started")).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects Evidence resume that omits an authoritative .rb control-plane change", async () => {
    const fixture = await createFixture("rb-ralph-c-resume-control-omit-", "run-c-resume-control-omit");
    try {
      const faulty = failOnceAfterMarker("rb-ralph-evidence-capture/v1", "/attempts/attempt-c-001");
      const execution = await authorizeAndExecute(fixture, {
        fileSystem: faulty,
        action: async (root) => {
          await mkdir(join(root, ".rb"), { recursive: true });
          await writeFile(join(root, ".rb", "tampered.txt"), "authoritative control-plane change\n");
        },
      });
      await expect(captureEvidenceV2({ leasedRun: execution.leasedRun, plan: fixture.document, observation: execution.executed.observation, nonceFactory: nonce, eventIdFactory: () => `c-event-${++nonceOrdinal}` }))
        .rejects.toMatchObject({ code: "B4_ARTIFACT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION" });
      expect(execution.leasedRun.state.attempts["attempt-c-001"]?.stage).toBe("EVIDENCE_CAPTURING");
      await rewriteEvidencePathFields(fixture, {
        changedPaths: [],
        changedPathKinds: [],
        outsideScopePaths: [],
        controlPlaneChangedPaths: [],
      });

      await expect(captureEvidenceV2({ leasedRun: execution.leasedRun, plan: fixture.document, observation: execution.executed.observation, nonceFactory: nonce, eventIdFactory: () => `c-event-${++nonceOrdinal}` }))
        .rejects.toMatchObject({ code: "C_EVIDENCE_IMMUTABLE_CONFLICT" });
      const events = (await fixture.store.inspect()).events;
      expect(events.some((candidate) => candidate.eventType === "evidence.captured")).toBe(false);
      expect(events.some((candidate) => candidate.eventType === "validation.started")).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects Evidence resume that erases only the .rb control-plane classification", async () => {
    const fixture = await createFixture("rb-ralph-c-resume-control-classification-", "run-c-resume-control-classification");
    try {
      const faulty = failOnceAfterMarker("rb-ralph-evidence-capture/v1", "/attempts/attempt-c-001");
      const execution = await authorizeAndExecute(fixture, {
        fileSystem: faulty,
        action: async (root) => {
          await mkdir(join(root, ".rb"), { recursive: true });
          await writeFile(join(root, ".rb", "tampered.txt"), "classified control-plane change\n");
        },
      });
      await expect(captureEvidenceV2({ leasedRun: execution.leasedRun, plan: fixture.document, observation: execution.executed.observation, nonceFactory: nonce, eventIdFactory: () => `c-event-${++nonceOrdinal}` }))
        .rejects.toMatchObject({ code: "B4_ARTIFACT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION" });
      const correct = JSON.parse(await readFile(evidenceArtifactPath(fixture), "utf8")) as EvidenceCaptureV2;
      expect(correct.changedPathKinds).toContainEqual({ path: ".rb/tampered.txt", kind: "ADDED" });
      expect(correct.controlPlaneChangedPaths).toEqual([".rb", ".rb/tampered.txt"]);
      await rewriteEvidencePathFields(fixture, {
        changedPaths: correct.changedPaths,
        changedPathKinds: correct.changedPathKinds,
        outsideScopePaths: correct.outsideScopePaths,
        controlPlaneChangedPaths: [],
      });

      await expect(captureEvidenceV2({ leasedRun: execution.leasedRun, plan: fixture.document, observation: execution.executed.observation, nonceFactory: nonce, eventIdFactory: () => `c-event-${++nonceOrdinal}` }))
        .rejects.toMatchObject({ code: "C_EVIDENCE_IMMUTABLE_CONFLICT" });
      const events = (await fixture.store.inspect()).events;
      expect(events.some((candidate) => candidate.eventType === "evidence.captured")).toBe(false);
      expect(events.some((candidate) => candidate.eventType === "validation.started")).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects every overlapping result/executor.finished mismatch before evidence is captured", async () => {
    for (const [field, value] of [
      ["status", "FAILED"],
      ["termination", "ERROR"],
      ["finishedAt", "2026-09-06T06:09:59.000Z"],
    ] as const) {
      const fixture = await createFixture(`rb-ralph-c-result-mismatch-${field}-`, `run-c-result-mismatch-${field}`);
      try {
        const execution = await authorizeAndExecute(fixture);
        const resultPath = join(fixture.store.runDirectory, "attempts", "attempt-c-001", "invocation-result.json");
        const persisted = JSON.parse(await readFile(resultPath, "utf8")) as Record<string, unknown>;
        const { resultDigest: _ignored, ...base } = { ...persisted, [field]: value };
        await writeFile(resultPath, canonicalJson({ ...base, resultDigest: sha256Canonical(base) }));
        await expect(executeAuthorizedInvocationV2({ leasedRun: execution.leasedRun, plan: fixture.document, runtime: execution.runtime, nonceFactory: nonce, eventIdFactory: () => `c-event-${++nonceOrdinal}` }))
          .rejects.toMatchObject({ code: "B4_RESULT_IMMUTABLE_CONFLICT" });
        await expect(captureEvidenceV2({ leasedRun: execution.leasedRun, plan: fixture.document, observation: execution.executed.observation, nonceFactory: nonce, eventIdFactory: () => `c-event-${++nonceOrdinal}` }))
          .rejects.toMatchObject({ code: "C_RESULT_ARTIFACT_REQUIRED" });
        const events = (await fixture.store.inspect()).events;
        expect(events.some((candidate) => candidate.eventType === "evidence.captured")).toBe(false);
        expect(events.some((candidate) => candidate.eventType === "validation.started")).toBe(false);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    }
  });

  it("rejects a direct C call when result and trusted observation agree but Attempt.executorFinished disagrees", async () => {
    const fixture = await createFixture("rb-ralph-c-attempt-binding-", "run-c-attempt-binding");
    try {
      const execution = await authorizeAndExecute(fixture);
      const invocationId = execution.authorized.invocation.invocationId;
      const alternateRuntime = new ScriptedExecutor({ runtimeIdentity: "c-alternate-runtime", clock: () => "2026-09-06T06:09:30.000Z" });
      alternateRuntime.seedObservation(invocationId, {
        state: "TERMINATED_QUIESCENT",
        status: "FAILED",
        termination: "ERROR",
        resultEnvelopeStatus: "VALID",
        exitCode: 1,
        signal: null,
        startedAt: "2026-09-06T06:09:29.000Z",
        finishedAt: "2026-09-06T06:09:30.000Z",
      });
      const deepExecution = await import("../../src/vnext/ralph-runtime/operational-b4/execution.js");
      const alternateObservation = await deepExecution.observeTrustedExecutorInvocationV2(alternateRuntime, execution.authorized.authorizedInvocation);
      expect(alternateObservation.status).toBe("FAILED");

      const resultPath = join(fixture.store.runDirectory, "attempts", "attempt-c-001", "invocation-result.json");
      const persisted = JSON.parse(await readFile(resultPath, "utf8")) as Record<string, unknown>;
      const base: Record<string, unknown> = {
        ...persisted,
        status: alternateObservation.status,
        termination: alternateObservation.termination,
        exitCode: alternateObservation.exitCode ?? null,
        signal: alternateObservation.signal ?? null,
        startedAt: alternateObservation.startedAt,
        finishedAt: alternateObservation.finishedAt,
      };
      delete base.resultDigest;
      await writeFile(resultPath, canonicalJson({ ...base, resultDigest: sha256Canonical(base) }));

      await expect(captureEvidenceV2({
        leasedRun: execution.leasedRun,
        plan: fixture.document,
        observation: alternateObservation,
        nonceFactory: nonce,
        eventIdFactory: () => `c-event-${++nonceOrdinal}`,
      })).rejects.toMatchObject({ code: "C_RESULT_ARTIFACT_REQUIRED" });
      const events = (await fixture.store.inspect()).events;
      expect(events.some((candidate) => candidate.eventType === "evidence.captured")).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("detects .rb control-plane mutation independently and closes only with the frozen reason", async () => {
    const fixture = await createFixture("rb-ralph-c-control-", "run-c-control");
    try {
      const execution = await authorizeAndExecute(fixture, { action: async (root) => { await mkdir(join(root, ".rb"), { recursive: true }); await writeFile(join(root, ".rb", "tampered.txt"), "executor mutation\n"); } });
      const result = await captureEvidenceV2({ leasedRun: execution.leasedRun, plan: fixture.document, observation: execution.executed.observation, nonceFactory: nonce, eventIdFactory: () => `c-event-${++nonceOrdinal}` });
      expect(result.kind).toBe("CONTROL_PLANE_VIOLATION");
      if (result.kind !== "CONTROL_PLANE_VIOLATION") throw new Error("control-plane fixture did not close");
      expect(result.evidence.controlPlaneChangedPaths).toContain(".rb/tampered.txt");
      const events = (await fixture.store.inspect()).events;
      expect(events.find((candidate) => candidate.eventType === "attempt.closed")?.payload).toMatchObject({ closureReason: "CONTROL_PLANE_VIOLATION" });
      expect(events.map((candidate) => candidate.eventType)).not.toContain("validation.started");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("records outside-Scope changes as anomalies without treating Scope/Covers as a sandbox", async () => {
    const fixture = await createFixture("rb-ralph-c-scope-", "run-c-scope");
    try {
      const execution = await authorizeAndExecute(fixture, { action: async (root) => { await mkdir(join(root, "docs"), { recursive: true }); await writeFile(join(root, "docs", "out.txt"), "outside declared ownership\n"); } });
      const result = await captureEvidenceV2({ leasedRun: execution.leasedRun, plan: fixture.document, observation: execution.executed.observation, nonceFactory: nonce, eventIdFactory: () => `c-event-${++nonceOrdinal}` });
      expect(result.kind).toBe("EVIDENCE_CAPTURED_READY_FOR_VALIDATION");
      if (result.kind === "EVIDENCE_CAPTURED_READY_FOR_VALIDATION") expect(result.evidence.outsideScopePaths).toContain("docs/out.txt");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("retains evidence for nonzero, timeout, cancellation, and protocol-invalid post-start termination", async () => {
    for (const [kind, runId] of [
      ["FAILED", "run-c-failed"],
      ["TIMEOUT", "run-c-timeout"],
      ["CANCELLED", "run-c-cancelled"],
      ["MALFORMED_RESULT", "run-c-invalid-envelope"],
    ] as const) {
      const fixture = await createFixture(`rb-ralph-c-${kind.toLowerCase()}-`, runId);
      try {
        const execution = await authorizeAndExecute(fixture, { scenarioKind: kind, action: async (root) => { await mkdir(join(root, "src"), { recursive: true }); await writeFile(join(root, "src", "termination.txt"), kind); } });
        const result = await captureEvidenceV2({ leasedRun: execution.leasedRun, plan: fixture.document, observation: execution.executed.observation, nonceFactory: nonce, eventIdFactory: () => `c-event-${++nonceOrdinal}` });
        expect(result.kind).toBe("EVIDENCE_CAPTURED_READY_FOR_VALIDATION");
        expect((await fixture.store.inspect()).events.map((candidate) => candidate.eventType)).toContain("evidence.captured");
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    }
  }, 30_000);

  it("derives ADDED/MODIFIED/DELETED/TYPE_CHANGED/MODE_CHANGED deterministically from manifests", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-c-diff-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "a.ts"), "a\n");
      await writeFile(join(root, "src", "b.ts"), "b\n");
      await writeFile(join(root, "src", "d.ts"), "d\n");
      await writeFile(join(root, "src", "e.ts"), "e\n");
      const policy = createWorkspacePolicy();
      const binding = { runId: "run-c-diff", phaseId: "P01", taskId: "T001", attemptId: "attempt-c-diff", invocationId: "inv-c-diff" };
      const before = createWorkspaceManifestV2(binding, await fingerprintWorkspace(root, policy));
      await writeFile(join(root, "src", "a.ts"), "changed\n");
      await unlink(join(root, "src", "b.ts"));
      await unlink(join(root, "src", "d.ts"));
      await mkdir(join(root, "src", "d.ts"));
      await chmod(join(root, "src", "e.ts"), 0o600);
      await writeFile(join(root, "src", "c.ts"), "c\n");
      const after = createWorkspaceManifestV2(binding, await fingerprintWorkspace(root, policy));
      const changes = deriveWorkspaceChangesV2(before, after, "src", "src");
      expect(changes.changedPathKinds).toEqual(expect.arrayContaining([
        { path: "src/a.ts", kind: "MODIFIED" },
        { path: "src/b.ts", kind: "DELETED" },
        { path: "src/c.ts", kind: "ADDED" },
        { path: "src/d.ts", kind: "TYPE_CHANGED" },
        { path: "src/e.ts", kind: "MODE_CHANGED" },
      ]));
      expect(changes.changedPaths).toEqual([...changes.changedPaths].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires stable post-workspace evidence and resumes capture without a second execution", async () => {
    const fixture = await createFixture("rb-ralph-c-unstable-", "run-c-unstable");
    try {
      const execution = await authorizeAndExecute(fixture);
      let rootReads = 0;
      const changingFs: WorkspaceFingerprintFileSystem = {
        ...nodeWorkspaceFingerprintFileSystem,
        readdir: async (path) => {
          if (resolve(path) === resolve(fixture.root)) rootReads += 1;
          if (rootReads === 2 && resolve(path) === resolve(fixture.root)) {
            await mkdir(join(fixture.root, "drift"), { recursive: true });
            await writeFile(join(fixture.root, "drift", "during-capture.txt"), "drift\n");
            rootReads += 1;
          }
          return nodeWorkspaceFingerprintFileSystem.readdir(path);
        },
      };
      const unstable = await captureEvidenceV2({ leasedRun: execution.leasedRun, plan: fixture.document, observation: execution.executed.observation, workspaceFingerprintFileSystem: changingFs, nonceFactory: nonce, eventIdFactory: () => `c-event-${++nonceOrdinal}` });
      expect(unstable.kind).toBe("RECONCILIATION_REQUIRED");
      expect(execution.runtime.getInvocationAttempts(execution.authorized.invocation.invocationId)).toBe(1);
      expect((await fixture.store.inspect()).events.map((candidate) => candidate.eventType)).toContain("attempt.reconciliation-required");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }

    const resumeFixture = await createFixture("rb-ralph-c-resume-", "run-c-resume");
    try {
      const faulty = failOnceAfterMarker("rb-ralph-evidence-capture/v1", "/attempts/attempt-c-001");
      const execution = await authorizeAndExecute(resumeFixture, { fileSystem: faulty, action: async (root) => { await mkdir(join(root, "src"), { recursive: true }); await writeFile(join(root, "src", "resume.ts"), "resume\n"); } });
      await expect(captureEvidenceV2({ leasedRun: execution.leasedRun, plan: resumeFixture.document, observation: execution.executed.observation, nonceFactory: nonce, eventIdFactory: () => `c-event-${++nonceOrdinal}` })).rejects.toMatchObject({ code: "B4_ARTIFACT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION" });
      const afterUncertainArtifact = await resumeFixture.store.inspect();
      expect(afterUncertainArtifact.events.filter((candidate) => candidate.eventType === "evidence.captured")).toHaveLength(0);
      const startedCaptureId = afterUncertainArtifact.events.find((candidate) => candidate.eventType === "evidence.capture-started")?.payload.evidenceCaptureId;
      const resumed = await captureEvidenceV2({ leasedRun: execution.leasedRun, plan: resumeFixture.document, observation: execution.executed.observation, nonceFactory: nonce, eventIdFactory: () => `c-event-${++nonceOrdinal}` });
      expect(resumed.kind).toBe("EVIDENCE_CAPTURED_READY_FOR_VALIDATION");
      expect(execution.runtime.getInvocationAttempts(execution.authorized.invocation.invocationId)).toBe(1);
      const events = (await resumeFixture.store.inspect()).events;
      expect(events.filter((candidate) => candidate.eventType === "evidence.capture-started")).toHaveLength(1);
      expect(events.filter((candidate) => candidate.eventType === "evidence.captured")).toHaveLength(1);
      expect(events.find((candidate) => candidate.eventType === "evidence.capture-started")?.payload.evidenceCaptureId).toBe(startedCaptureId);
      expect(events.map((candidate) => candidate.eventType)).not.toContain("validation.started");
    } finally {
      await rm(resumeFixture.root, { recursive: true, force: true });
    }
  });

  it("keeps the EvidenceCapture schema closed and immutable", async () => {
    const base = {
      runId: "run-c-schema",
      phaseId: "P01",
      taskId: "T001",
      attemptId: "attempt-c-schema",
      invocationId: "inv-c-schema",
      workUnitId: "wu-c-schema",
      workUnitDigest: sha256("work-unit"),
      invocationResultRef: "attempts/attempt-c-schema/invocation-result.json",
      invocationResultDigest: sha256("result"),
      beforeManifestRef: "attempts/attempt-c-schema/workspace-before.json",
      beforeManifestDigest: sha256("before-manifest"),
      beforeFingerprint: sha256("before-fingerprint"),
      afterManifestRef: "attempts/attempt-c-schema/workspace-after.json",
      afterManifestDigest: sha256("after-manifest"),
      afterFingerprint: sha256("after-fingerprint"),
      changedPaths: ["src/a.ts"],
      changedPathKinds: [{ path: "src/a.ts", kind: "MODIFIED" as const }],
      outsideScopePaths: [],
      controlPlaneChangedPaths: [],
      executorClaims: { bounded: "true" },
      capturedAt: "2026-09-06T06:00:50.000Z",
    };
    const evidence = createEvidenceCaptureV2(base);
    expect(evidence.evidenceDigest).toMatch(/^sha256:/);
    expect(Object.keys(evidence)).toContain("evidenceDigest");
    expect(() => createEvidenceCaptureV2({ ...base, changedPaths: ["../escape"] })).toThrow();
    const withUnknown = { ...evidence, unsafe: "field" } as unknown as EvidenceCaptureV2;
    expect(() => validateEvidenceCaptureV2(withUnknown)).toThrow("unknown fields");
  });

  it("binds capture identity to the authoritative attempt and post fingerprint", async () => {
    const source = await readFile(resolve(TEST_DIRECTORY, "../../src/vnext/ralph-runtime/operational-c/evidence.ts"), "utf8");
    expect(source).toContain("const evidenceCaptureId = deterministicEvidenceCaptureId(reopened, before, expectedPostFingerprint);");
    expect(source).not.toContain("const evidenceCaptureId = randomUUID();");
  });
});
