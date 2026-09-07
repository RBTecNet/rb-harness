import { mkdtemp, rm, writeFile, mkdir, stat, readFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ExecutionDocument, Phase, Task } from "../../src/types.js";
import {
  EVENT_SCHEMA_V2,
  OPERATIONAL_CONTRACT_V2,
  STATE_SCHEMA_V2,
  createInitialRuntimeStateV2,
  createRalphEventV2,
  type EventPayloadMapV2,
  type RalphEventTypeV2,
  type RalphEventV2,
  type RalphRuntimeStateV2,
  type UnsignedRalphEventV2,
} from "../../src/vnext/ralph-runtime/operational-v2/index.js";
import type { RuntimeEntityRef } from "../../src/vnext/ralph-runtime/contracts.js";
import {
  RALPH_RUN_SNAPSHOT_V2_SCHEMA,
  RalphEventStoreV2,
  commitRalphEventV2,
  createRetryPolicyV1,
  initializeOperationalRunV2,
  retryPolicyDescriptorV1,
  type RunSnapshotV2,
} from "../../src/vnext/ralph-runtime/operational-b1/index.js";
import { acquireLeasedRunV2, type LeaseRuntimeInputV2, type ProcessIdentity, type ProcessIdentityProvider } from "../../src/vnext/ralph-runtime/operational-b2/index.js";
import { prepareNextAuthorizedInvocationV2 } from "../../src/vnext/ralph-runtime/operational-b3/index.js";
import { executeAuthorizedInvocationV2, ScriptedExecutor } from "../../src/vnext/ralph-runtime/operational-b4/index.js";
import { captureEvidenceV2 } from "../../src/vnext/ralph-runtime/operational-c/index.js";
import { readAuditPackageV2, validateAttemptV2 } from "../../src/vnext/ralph-runtime/operational-d/index.js";
import {
  auditAttemptV2,
  createAuditInvocationDescriptorV2,
  createAuditResultV2,
  isTrustedAuditorRuntimeV2,
  persistAuditInvocationDescriptorV2,
  persistAuditResultV2,
  readAuditInvocationDescriptorV2,
  ScriptedAuditor,
  type AuditAttemptV2Result,
} from "../../src/vnext/ralph-runtime/operational-e/index.js";
import { createWorkspacePolicy, fingerprintWorkspace } from "../../src/vnext/ralph-runtime/fingerprint.js";
import { sha256, sha256Canonical } from "../../src/vnext/ralph-runtime/hashing.js";

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const OWNER: ProcessIdentity = { pid: 58102, processStartIdentity: "e-start", hostIdentity: "e-host", bootSessionIdentity: "e-boot" };
const IDENTITY_PROVIDER: ProcessIdentityProvider = { current: () => OWNER, inspect: () => "MATCH" };
let nonceOrdinal = 0;
const TEST_MAX_TASK_ATTEMPTS = 4;
const TEST_VALIDATION_INFRA_RETRIES = 2;

function descriptor(schemaVersion: string, descriptorId: string) {
  const base = { schemaVersion, descriptorId };
  return { ...base, descriptorDigest: sha256Canonical(base) };
}

function task(validation: readonly string[]): Task {
  return { id: "T001", title: "Audit fixture", done: false, scope: "src", change: "make fixture valid", covers: "src", dependsOn: [], parallelSafe: false, acceptanceCriteria: ["fixture is valid"], validation: [...validation], expectedEvidence: "workspace diff", line: 1 };
}

function plan(validation: readonly string[]): ExecutionDocument {
  const phase: Phase = { number: 1, id: "P01", title: "Audit", goal: "audit", dependsOn: [], context: ["test"], tasks: [task(validation)], line: 1 };
  return { contract: "rb-execution/v1", artifactId: "plan-e", title: "E", phases: [phase] };
}

function genesis(document: ExecutionDocument, runId: string): RalphRuntimeStateV2 {
  return createInitialRuntimeStateV2({ runId, maxTaskAttemptsPerTask: TEST_MAX_TASK_ATTEMPTS, phases: document.phases.map((phase) => ({ phaseId: phase.id, taskIds: phase.tasks.map((candidate) => candidate.id) })), tasks: document.phases.flatMap((phase) => phase.tasks.map((candidate) => ({ taskId: candidate.id, phaseId: phase.id, dependsOn: candidate.dependsOn }))) });
}

function event<TType extends RalphEventTypeV2>(state: RalphRuntimeStateV2, eventType: TType, payload: EventPayloadMapV2[TType], context: { readonly phaseId?: string; readonly taskId?: string; readonly attemptId?: string } = {}): RalphEventV2 {
  const kind = { ...({} as Record<RalphEventTypeV2, RuntimeEntityRef["kind"]>) };
  const entityKind = kind[eventType] ?? (eventType === "task.state-changed" ? "task" : eventType === "run.created" || eventType === "run.started" ? "run" : "attempt");
  const entity: RuntimeEntityRef = entityKind === "run" ? { kind: "run", id: state.runId } : entityKind === "task" ? { kind: "task", id: context.taskId ?? "T001" } : { kind: "attempt", id: context.attemptId ?? "attempt-e-001" };
  const now = "2026-09-06T07:00:00.000Z";
  return createRalphEventV2({ eventId: `e-fixture-${state.lastSequence + 1}-${eventType}`, eventType, schemaVersion: EVENT_SCHEMA_V2, runId: state.runId, sequence: state.lastSequence + 1, occurredAt: now, recordedAt: now, entity, ...(entityKind === "attempt" ? { phaseId: context.phaseId ?? "P01", taskId: context.taskId ?? "T001", attemptId: context.attemptId ?? "attempt-e-001" } : entityKind === "task" ? { phaseId: context.phaseId ?? "P01", taskId: context.taskId ?? "T001" } : {}), actor: "CORE", causationId: null, correlationId: `${state.runId}:e-fixture`, payload, previousEventHash: state.lastEventHash } as UnsignedRalphEventV2<TType>) as RalphEventV2;
}

async function append(store: RalphEventStoreV2, state: RalphRuntimeStateV2, next: RalphEventV2, nonce: string): Promise<RalphRuntimeStateV2> {
  return (await commitRalphEventV2({ store, state, event: next, writtenAt: "2026-09-06T07:00:01.000Z", nonce })).state;
}

async function fixture(validation: readonly string[], action?: (root: string) => void | Promise<void>) {
  const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-e-auditor-"));
  const document = plan(validation);
  const policy = createWorkspacePolicy();
  const initialFingerprint = await fingerprintWorkspace(root, policy);
  const config = descriptor("rb-ralph-config/v2", "e-config");
  const snapshot: RunSnapshotV2 = {
    snapshotSchemaVersion: RALPH_RUN_SNAPSHOT_V2_SCHEMA, runId: `run-e-${++nonceOrdinal}`, eventSchema: EVENT_SCHEMA_V2, stateSchema: STATE_SCHEMA_V2, operationalContract: OPERATIONAL_CONTRACT_V2,
    projectIdentity: { projectId: "e-project" }, readyPlanIdentity: document.artifactId, readyPlanHash: sha256Canonical(document), readyManifestHash: sha256("e-ready-manifest"), selectedReadyArtifactHashes: { plan: sha256Canonical(document) }, readinessInspectionDigest: sha256("e-readiness"), effectiveRunConfig: config, effectiveConfigDigest: config.descriptorDigest,
    diagnosticsPolicy: descriptor("rb-ralph-diagnostics/v2", "e-diagnostics"), environmentPolicy: descriptor("rb-ralph-environment/v2", "e-environment"), executorProfile: { profileId: "scripted-e", kind: "scripted", descriptorDigest: sha256("e-profile") }, executorCapabilities: { requested: ["fixture.effect"], granted: ["fixture.effect"], verified: ["fixture.effect"], readOnlyEnforced: false }, permissionCapabilityPolicy: descriptor("rb-ralph-capabilities/v2", "e-capabilities"),
    workspacePolicy: policy, initialWorkspaceFingerprint: { controlPlaneFingerprint: initialFingerprint.controlPlaneFingerprint, productWorkspaceFingerprint: initialFingerprint.productWorkspaceFingerprint, policyDigest: initialFingerprint.policyDigest, fingerprintDigest: initialFingerprint.fingerprintDigest }, retryPolicies: retryPolicyDescriptorV1(createRetryPolicyV1({ runId: `run-e-${nonceOrdinal}`, policyId: "e-retry", maxTaskAttemptsPerTask: TEST_MAX_TASK_ATTEMPTS, validationInfrastructureRetryLimit: TEST_VALIDATION_INFRA_RETRIES })), timeoutPolicy: descriptor("rb-ralph-timeout/v2", "e-timeout"), runtimeIdentity: descriptor("rb-ralph-runtime/v2", "e-runtime"), leasePolicy: descriptor("rb-ralph-lease/v2", "e-lease"), createdAt: "2026-09-06T07:00:00.000Z",
  };
  const store = new RalphEventStoreV2({ projectRoot: root, runId: snapshot.runId });
  const initial = genesis(document, snapshot.runId);
  const retryPolicy = createRetryPolicyV1({ runId: snapshot.runId, policyId: "e-retry", maxTaskAttemptsPerTask: TEST_MAX_TASK_ATTEMPTS, validationInfrastructureRetryLimit: TEST_VALIDATION_INFRA_RETRIES });
  const initialized = await initializeOperationalRunV2({ store, snapshot, retryPolicy, genesisState: initial, runCreatedEvent: event(initial, "run.created", { phaseIds: initial.phaseIds, taskIds: initial.taskIds }), createdAt: "2026-09-06T07:00:00.000Z", nonce: `e-init-${nonceOrdinal}` });
  let state = await append(store, initialized.state, event(initialized.state, "run.started", {}), `e-start-${nonceOrdinal}`);
  state = await append(store, state, event(state, "task.state-changed", { disposition: "READY", activity: "IDLE", owner: "NONE", hold: "NONE" }, { phaseId: "P01", taskId: "T001" }), `e-ready-${nonceOrdinal}`);
  const leaseOptions: LeaseRuntimeInputV2 = { projectRoot: root, runId: snapshot.runId, genesisState: initial, processIdentityProvider: IDENTITY_PROVIDER };
  const admittedLease = await acquireLeasedRunV2(leaseOptions);
  const admitted = await prepareNextAuthorizedInvocationV2({ leasedRun: admittedLease, plan: document, attemptIdFactory: () => "attempt-e-001", nonceFactory: () => `e-${++nonceOrdinal}`, eventIdFactory: () => `e-event-${++nonceOrdinal}`, clock: () => "2026-09-06T07:00:02.000Z" });
  if (admitted.kind !== "AUTHORIZED_NOT_INVOKED") throw new Error(`E fixture admission failed: ${admitted.kind}`);
  const executorLease = await acquireLeasedRunV2(leaseOptions);
  const executor = new ScriptedExecutor({ clock: () => "2026-09-06T07:00:03.000Z", defaultScenario: { kind: "SUCCESS", fixtureWorkspaceAction: action === undefined ? undefined : () => action(root) } });
  const executed = await executeAuthorizedInvocationV2({ leasedRun: executorLease, plan: document, runtime: executor, nonceFactory: () => `e-${++nonceOrdinal}`, eventIdFactory: () => `e-event-${++nonceOrdinal}` });
  if (executed.kind !== "EXECUTOR_FINISHED_READY_FOR_CAPTURE") throw new Error(`E fixture execution failed: ${executed.kind}`);
  const captured = await captureEvidenceV2({ leasedRun: executorLease, plan: document, observation: executed.observation, nonceFactory: () => `e-${++nonceOrdinal}`, eventIdFactory: () => `e-event-${++nonceOrdinal}`, clock: () => "2026-09-06T07:00:04.000Z" });
  if (captured.kind !== "EVIDENCE_CAPTURED_READY_FOR_VALIDATION") throw new Error(`E fixture evidence failed: ${captured.kind}`);
  const validationLease = await acquireLeasedRunV2(leaseOptions);
  const validated = await validateAttemptV2({ leasedRun: validationLease, plan: document, executorObservation: executed.observation, nonceFactory: () => `e-${++nonceOrdinal}`, eventIdFactory: () => `e-event-${++nonceOrdinal}`, clock: () => "2026-09-06T07:00:05.000Z" });
  if (validated.kind !== "VALIDATION_READY_FOR_AUDIT") throw new Error(`E fixture validation failed: ${validated.kind}`);
  return { root, store, document, leaseOptions, observation: executed.observation, executor, validated };
}

async function runAudit(value: Awaited<ReturnType<typeof fixture>>, auditor: ScriptedAuditor): Promise<AuditAttemptV2Result> {
  const lease = await acquireLeasedRunV2(value.leaseOptions);
  return auditAttemptV2({ leasedRun: lease, plan: value.document, auditor, executorObservation: value.observation, nonceFactory: () => `e-${++nonceOrdinal}`, eventIdFactory: () => `e-event-${++nonceOrdinal}`, clock: () => "2026-09-06T07:00:06.000Z" });
}

describe("Ralph Operational Core V2 — E Auditor and Findings", () => {
  it("accepts a valid immutable package and completes Task/Run through the reducer", async () => {
    const value = await fixture(["`true`"]);
    try {
      const auditor = new ScriptedAuditor({ defaultDecision: { verdict: "ACCEPT", rationale: "all criteria pass" } });
      const result = await runAudit(value, auditor);
      expect(result.kind).toBe("AUDIT_ACCEPTED");
      expect(result.state.tasks.T001?.disposition).toBe("COMPLETE");
      expect(result.state.disposition).toBe("COMPLETE");
      expect(auditor.totalInvocations).toBe(1);
      const events = (await value.store.inspect()).events.map((candidate) => candidate.eventType);
      expect(events.indexOf("audit.started")).toBeLessThan(events.indexOf("attempt.closed"));
      expect(events.indexOf("audit.started")).toBeGreaterThan(events.indexOf("attempt.audit-ready"));
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("rejects with a Core-owned stable Finding ID", async () => {
    const value = await fixture(["`true`"]);
    try {
      const auditor = new ScriptedAuditor({ defaultDecision: { verdict: "REJECT", proposedFindings: [{ criterionId: "F-criterion", structuredFindingKey: "F1", severity: "BLOCKER", scope: ["src"], expectation: "fixture exists", observed: "fixture is missing", remediationHint: "create fixture" }], rationale: "F1" } });
      const result = await runAudit(value, auditor);
      expect(result.kind).toBe("AUDIT_REJECTED");
      expect(result.attempt.closureReason).toBe("AUDIT_REJECTED");
      expect(Object.values(result.state.findings)).toHaveLength(1);
      const finding = Object.values(result.state.findings)[0]!;
      expect(finding.status).toBe("OPEN");
      expect(finding.id).toMatch(/^finding-[0-9a-f]{64}$/);
      expect(finding.id).not.toBe("F1");
      expect(finding.id).toBe(`finding-${sha256Canonical({ taskId: "T001", criterionId: "F-criterion", structuredFindingKey: "F1" }).slice("sha256:".length)}`);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("keeps deterministic red authoritative over a malicious ACCEPT", async () => {
    const value = await fixture(["`test -f missing.fixture`"]);
    try {
      const result = await runAudit(value, new ScriptedAuditor({ defaultDecision: { verdict: "ACCEPT", rationale: "malicious override" } }));
      expect(result.kind).toBe("AUDIT_REJECTED");
      expect(result.state.tasks.T001?.disposition).not.toBe("COMPLETE");
      expect(result.state.disposition).not.toBe("COMPLETE");
      expect(result.state.attempts["attempt-e-001"]?.closureReason).toBe("AUDIT_REJECTED");
      expect(Object.values(result.state.findings).some((finding) => finding.severity === "BLOCKER")).toBe(true);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("rejects structural, cloned, and prototype-spoofed Auditor authorities", async () => {
    const fake = { kind: "AUDITOR_RUNTIME", runtimeIdentity: "fake", profileId: "fake", profileDigest: "sha256:fake", invoke: async () => ({ verdict: "ACCEPT", proposedFindings: [], resolvedFindingRefs: [], rationale: "", metadata: {} }) };
    expect(isTrustedAuditorRuntimeV2(fake)).toBe(false);
    expect(isTrustedAuditorRuntimeV2(JSON.parse(JSON.stringify(new ScriptedAuditor())))).toBe(false);
    const spoof = Object.create(ScriptedAuditor.prototype);
    expect(isTrustedAuditorRuntimeV2(spoof)).toBe(false);
  });

  it("rejects a structural fake at the real auditAttemptV2 authority boundary before any audit side effect", async () => {
    const value = await fixture(["`true`"]);
    try {
      const before = (await value.store.inspect()).events;
      const leasedRun = await acquireLeasedRunV2(value.leaseOptions);
      const fake = { kind: "AUDITOR_RUNTIME", runtimeIdentity: "fake", profileId: "fake", profileDigest: sha256("fake"), invoke: async () => ({ verdict: "ACCEPT", proposedFindings: [], resolvedFindingRefs: [], rationale: "forged", metadata: {} }) };
      await expect(auditAttemptV2({ leasedRun, plan: value.document, auditor: fake as never, executorObservation: value.observation })).rejects.toMatchObject({ code: "E_AUDITOR_TRUST_REQUIRED" });
      const after = (await value.store.inspect()).events;
      expect(after).toHaveLength(before.length);
      expect(after.filter((candidate) => candidate.eventType === "audit.started")).toHaveLength(0);
      expect(after.filter((candidate) => candidate.eventType === "finding.state-changed")).toHaveLength(0);
      expect(after.filter((candidate) => candidate.eventType === "attempt.closed")).toHaveLength(0);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("keeps the Auditor process-free and persists immutable descriptor/result before closure", async () => {
    const productionDirectory = resolve(TEST_DIRECTORY, "../../src/vnext/ralph-runtime/operational-e");
    const sources = await Promise.all(["audit.ts", "artifacts.ts", "auditor-runtime.ts", "index.ts"].map((name) => readFile(join(productionDirectory, name), "utf8")));
    const productionSource = sources.join("\n");
    expect(productionSource).not.toMatch(/node:child_process|from\s+["'][^"']*(?:openai|anthropic|claude|codex|opencode|deepseek|minimax)[^"']*["']/i);
    expect(productionSource).not.toMatch(/\b(?:spawn|exec|execFile|fork)\s*\(/);
    const value = await fixture(["`true`"]);
    try {
      const result = await runAudit(value, new ScriptedAuditor({ defaultDecision: { verdict: "ACCEPT" } }));
      expect(result.kind).toBe("AUDIT_ACCEPTED");
      if (result.kind !== "AUDIT_ACCEPTED") throw new Error("valid audit did not accept");
      const events = (await value.store.inspect()).events;
      const auditStarted = events.findIndex((candidate) => candidate.eventType === "audit.started");
      const closed = events.findIndex((candidate) => candidate.eventType === "attempt.closed");
      expect(auditStarted).toBeGreaterThanOrEqual(0);
      expect(closed).toBeGreaterThan(auditStarted);
      const descriptor = await readAuditInvocationDescriptorV2(value.store, "attempt-e-001");
      expect(descriptor?.auditInvocationId).toBe(result.auditInvocation.auditInvocationId);
      const descriptorFile = join(value.store.runDirectory, "attempts", "attempt-e-001", "audit-invocation.json");
      const resultFile = join(value.store.runDirectory, "attempts", "attempt-e-001", "audit-result.json");
      expect((await stat(descriptorFile)).mode & 0o777).toBe(0o600);
      expect((await stat(resultFile)).mode & 0o777).toBe(0o600);
      const { resultDigest: _resultDigest, ...resultBase } = result.auditResult;
      const alteredResult = { ...resultBase, rationale: "tampered", resultDigest: sha256Canonical({ ...resultBase, rationale: "tampered" }) };
      await expect(persistAuditResultV2(value.store, alteredResult, "e-tampered-result")).rejects.toThrow();
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("releases after an Auditor crash and resumes the same durable audit identity without reinvoking a completed result", async () => {
    const value = await fixture(["`true`"]);
    try {
      let crash = true;
      const auditor = new ScriptedAuditor({ decide: () => {
        if (crash) { crash = false; throw new Error("simulated auditor crash"); }
        return { verdict: "ACCEPT", proposedFindings: [], resolvedFindingRefs: [], rationale: "resumed", metadata: {} };
      } });
      await expect(runAudit(value, auditor)).rejects.toMatchObject({ code: "E_AUDITOR_RESULT_INVALID" });
      const afterCrashEvents = (await value.store.inspect()).events;
      expect(afterCrashEvents.filter((candidate) => candidate.eventType === "audit.started")).toHaveLength(1);
      const firstDescriptor = await readAuditInvocationDescriptorV2(value.store, "attempt-e-001");
      expect(firstDescriptor).toBeDefined();
      const resumed = await runAudit(value, auditor);
      expect(resumed.kind).toBe("AUDIT_ACCEPTED");
      if (resumed.kind !== "AUDIT_ACCEPTED") throw new Error("audit did not resume to accept");
      expect(resumed.auditInvocation.auditInvocationId).toBe(firstDescriptor?.auditInvocationId);
      expect(auditor.totalInvocations).toBe(2);
      const events = (await value.store.inspect()).events;
      expect(events.filter((candidate) => candidate.eventType === "audit.started")).toHaveLength(1);
      expect(events.findIndex((candidate) => candidate.eventType === "audit.started")).toBeLessThan(events.findIndex((candidate) => candidate.eventType === "attempt.closed"));
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("replays an accepted terminal boundary without reinvoking Auditor or duplicating completion events", async () => {
    const value = await fixture(["`true`"]);
    try {
      const auditor = new ScriptedAuditor({ defaultDecision: { verdict: "ACCEPT", rationale: "replayable" } });
      const first = await runAudit(value, auditor);
      expect(first.kind).toBe("AUDIT_ACCEPTED");
      if (first.kind !== "AUDIT_ACCEPTED") throw new Error("audit did not accept");
      const replay = await runAudit(value, auditor);
      expect(replay.kind).toBe("AUDIT_ACCEPTED");
      if (replay.kind !== "AUDIT_ACCEPTED") throw new Error("accepted boundary did not replay");
      expect(replay.auditInvocation.auditInvocationId).toBe(first.auditInvocation.auditInvocationId);
      expect(auditor.totalInvocations).toBe(1);
      const events = (await value.store.inspect()).events;
      expect(events.filter((candidate) => candidate.eventType === "audit.started")).toHaveLength(1);
      expect(events.filter((candidate) => candidate.eventType === "attempt.closed")).toHaveLength(1);
      expect(events.filter((candidate) => candidate.eventType === "run.completed")).toHaveLength(1);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("detects an Auditor-side workspace mutation at the Core audit boundary", async () => {
    const value = await fixture(["`true`"]);
    try {
      const result = await runAudit(value, new ScriptedAuditor({ decide: () => {
        writeFileSync(join(value.root, "auditor-mutation"), "forbidden");
        return { verdict: "ACCEPT", proposedFindings: [], resolvedFindingRefs: [], rationale: "should not complete", metadata: {} };
      } }));
      expect(result.kind).toBe("RECONCILIATION_REQUIRED");
      expect(result.state.tasks.T001?.disposition).not.toBe("COMPLETE");
      expect((await value.store.inspect()).events.map((candidate) => candidate.eventType)).not.toContain("attempt.closed");
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("rejects an Auditor attempt to inject a final Finding identity at the real result boundary", async () => {
    const value = await fixture(["`true`"]);
    try {
      const attacker = new ScriptedAuditor({ decide: () => ({
        verdict: "REJECT",
        proposedFindings: [{ findingId: "attacker-controls-id", criterionId: "criterion", structuredFindingKey: "F1", severity: "BLOCKER", scope: ["src"], expectation: "safe", observed: "unsafe" }] as never,
        resolvedFindingRefs: [], rationale: "attempted id injection", metadata: {},
      }) });
      await expect(runAudit(value, attacker)).rejects.toMatchObject({ code: "E_AUDITOR_RESULT_INVALID" });
      const events = (await value.store.inspect()).events;
      expect(events.filter((candidate) => candidate.eventType === "finding.state-changed")).toHaveLength(0);
      expect(events.filter((candidate) => candidate.eventType === "attempt.closed")).toHaveLength(0);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("rejects a durable AuditResult that is not bound to the exact AuditPackage", async () => {
    const value = await fixture(["`true`"]);
    try {
      const crashing = new ScriptedAuditor({ decide: () => { throw new Error("descriptor-only crash"); } });
      await expect(runAudit(value, crashing)).rejects.toMatchObject({ code: "E_AUDITOR_RESULT_INVALID" });
      const descriptor = await readAuditInvocationDescriptorV2(value.store, "attempt-e-001");
      const auditPackage = await readAuditPackageV2(value.store, "attempt-e-001");
      if (!descriptor || !auditPackage) throw new Error("audit fixture binding missing");
      const wrong = createAuditResultV2({
        runId: descriptor.runId, phaseId: descriptor.phaseId, taskId: descriptor.taskId, attemptId: descriptor.attemptId,
        auditInvocationId: descriptor.auditInvocationId, auditPackageId: descriptor.auditPackageId, auditPackageDigest: sha256("wrong-package"),
        verdict: "ACCEPT", proposedFindings: [], resolvedFindingRefs: [], rationale: "wrong package", metadata: {}, startedAt: descriptor.startedAt, finishedAt: "2026-09-06T07:00:07.000Z",
      });
      await persistAuditResultV2(value.store, wrong, "e-wrong-package");
      const before = (await value.store.inspect()).events;
      await expect(runAudit(value, new ScriptedAuditor({ defaultDecision: { verdict: "ACCEPT" } }))).rejects.toMatchObject({ code: "E_AUDITOR_RESULT_BINDING_INVALID" });
      const after = (await value.store.inspect()).events;
      expect(after).toHaveLength(before.length);
      expect(after.filter((candidate) => candidate.eventType === "finding.state-changed")).toHaveLength(0);
      expect(after.filter((candidate) => candidate.eventType === "attempt.closed")).toHaveLength(0);
      expect(wrong.auditPackageDigest).not.toBe(auditPackage.packageDigest);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("blocks the accepted projection when its Core boundary invariants are violated", async () => {
    const value = await fixture(["`true`"]);
    try {
      const auditor = new ScriptedAuditor({ defaultDecision: { verdict: "ACCEPT" } });
      const auditPackage = await readAuditPackageV2(value.store, "attempt-e-001");
      const attempt = value.validated.state.attempts["attempt-e-001"];
      if (!auditPackage || !attempt?.auditPackage) throw new Error("accepted-boundary fixture missing");
      const descriptor = createAuditInvocationDescriptorV2({
        runId: value.store.runId, phaseId: attempt.phaseId, taskId: attempt.taskId, attemptId: attempt.attemptId,
        auditPackageId: attempt.auditPackage.auditPackageId, auditPackageDigest: auditPackage.packageDigest,
        auditorIdentity: auditor.runtimeIdentity, auditorProfileId: auditor.profileId, auditorProfileDigest: auditor.profileDigest, startedAt: "2026-09-06T07:00:06.000Z",
      });
      await persistAuditInvocationDescriptorV2(value.store, descriptor, "e-accept-boundary-descriptor");
      await persistAuditResultV2(value.store, createAuditResultV2({
        runId: value.store.runId, phaseId: attempt.phaseId, taskId: attempt.taskId, attemptId: attempt.attemptId,
        auditInvocationId: descriptor.auditInvocationId, auditPackageId: descriptor.auditPackageId, auditPackageDigest: descriptor.auditPackageDigest,
        verdict: "REJECT", proposedFindings: [], resolvedFindingRefs: [], rationale: "cannot project as accepted", metadata: {}, startedAt: descriptor.startedAt, finishedAt: "2026-09-06T07:00:07.000Z",
      }), "e-accept-boundary-result");
      const leasedRun = await acquireLeasedRunV2(value.leaseOptions);
      let state = leasedRun.state;
      expect(state.lastSequence).toBe((await value.store.inspect()).lastSequence);
      state = await append(value.store, state, event(state, "audit.started", { auditPackageId: descriptor.auditPackageId, auditPackageDigest: descriptor.auditPackageDigest, startedAt: descriptor.startedAt }, { phaseId: attempt.phaseId, taskId: attempt.taskId, attemptId: attempt.attemptId }), "e-accept-boundary-started");
      state = await append(value.store, state, event(state, "attempt.closed", { attemptId: attempt.attemptId, closureReason: "AUDIT_ACCEPTED", finishedAt: "2026-09-06T07:00:08.000Z" }, { phaseId: attempt.phaseId, taskId: attempt.taskId, attemptId: attempt.attemptId }), "e-accept-boundary-closed");
      await expect(auditAttemptV2({ leasedRun, plan: value.document, auditor, executorObservation: value.observation })).rejects.toMatchObject({ code: "E_AUDITOR_RESULT_BINDING_INVALID" });
      const events = (await value.store.inspect()).events;
      expect(events.filter((candidate) => candidate.eventType === "task.state-changed" && candidate.payload.disposition === "COMPLETE")).toHaveLength(0);
      expect(events.filter((candidate) => candidate.eventType === "run.completed")).toHaveLength(0);
      expect(state.tasks.T001?.disposition).not.toBe("COMPLETE");
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("prevents deterministic red from reaching AUDIT_ACCEPTED projection even with a bound ACCEPT result", async () => {
    const value = await fixture(["`test -f missing.fixture`"]);
    try {
      const auditor = new ScriptedAuditor({ defaultDecision: { verdict: "ACCEPT" } });
      const auditPackage = await readAuditPackageV2(value.store, "attempt-e-001");
      const attempt = value.validated.state.attempts["attempt-e-001"];
      if (!auditPackage || !attempt?.auditPackage) throw new Error("hard-negative fixture missing");
      expect(auditPackage.validationSummary.hardNegative).toBe(true);
      const descriptor = createAuditInvocationDescriptorV2({ runId: value.store.runId, phaseId: attempt.phaseId, taskId: attempt.taskId, attemptId: attempt.attemptId, auditPackageId: attempt.auditPackage.auditPackageId, auditPackageDigest: auditPackage.packageDigest, auditorIdentity: auditor.runtimeIdentity, auditorProfileId: auditor.profileId, auditorProfileDigest: auditor.profileDigest, startedAt: "2026-09-06T07:00:06.000Z" });
      await persistAuditInvocationDescriptorV2(value.store, descriptor, "e-hard-negative-descriptor");
      await persistAuditResultV2(value.store, createAuditResultV2({ runId: value.store.runId, phaseId: attempt.phaseId, taskId: attempt.taskId, attemptId: attempt.attemptId, auditInvocationId: descriptor.auditInvocationId, auditPackageId: descriptor.auditPackageId, auditPackageDigest: descriptor.auditPackageDigest, verdict: "ACCEPT", proposedFindings: [], resolvedFindingRefs: [], rationale: "malicious accept", metadata: {}, startedAt: descriptor.startedAt, finishedAt: "2026-09-06T07:00:07.000Z" }), "e-hard-negative-result");
      const leasedRun = await acquireLeasedRunV2(value.leaseOptions);
      let state = leasedRun.state;
      expect(state.lastSequence).toBe((await value.store.inspect()).lastSequence);
      state = await append(value.store, state, event(state, "audit.started", { auditPackageId: descriptor.auditPackageId, auditPackageDigest: descriptor.auditPackageDigest, startedAt: descriptor.startedAt }, { phaseId: attempt.phaseId, taskId: attempt.taskId, attemptId: attempt.attemptId }), "e-hard-negative-started");
      await append(value.store, state, event(state, "attempt.closed", { attemptId: attempt.attemptId, closureReason: "AUDIT_ACCEPTED", finishedAt: "2026-09-06T07:00:08.000Z" }, { phaseId: attempt.phaseId, taskId: attempt.taskId, attemptId: attempt.attemptId }), "e-hard-negative-closed");
      await expect(auditAttemptV2({ leasedRun, plan: value.document, auditor, executorObservation: value.observation })).rejects.toMatchObject({ code: "E_AUDITOR_RESULT_BINDING_INVALID" });
      const events = (await value.store.inspect()).events;
      expect(events.filter((candidate) => candidate.eventType === "attempt.closed" && candidate.payload.closureReason === "AUDIT_ACCEPTED")).toHaveLength(1);
      expect(events.filter((candidate) => candidate.eventType === "task.state-changed" && candidate.payload.disposition === "COMPLETE")).toHaveLength(0);
      expect(events.filter((candidate) => candidate.eventType === "run.completed")).toHaveLength(0);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });
});
