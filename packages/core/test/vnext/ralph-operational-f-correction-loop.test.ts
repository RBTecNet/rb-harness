import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutionDocument, Phase, Task } from "../../src/types.js";
import { createInitialRuntimeStateV2, createRalphEventV2, EVENT_SCHEMA_V2, OPERATIONAL_CONTRACT_V2, STATE_SCHEMA_V2, V2_EVENT_ENTITY_KINDS, type EventPayloadMapV2, type RalphEventTypeV2, type RalphEventV2, type RalphRuntimeStateV2, type UnsignedRalphEventV2 } from "../../src/vnext/ralph-runtime/operational-v2/index.js";
import type { RuntimeEntityRef, Finding } from "../../src/vnext/ralph-runtime/contracts.js";
import { RALPH_RUN_SNAPSHOT_V2_SCHEMA, RalphEventStoreV2, commitRalphEventV2, createRetryPolicyV1, initializeOperationalRunV2, retryPolicyDescriptorV1, type RunSnapshotV2 } from "../../src/vnext/ralph-runtime/operational-b1/index.js";
import { acquireLeasedRunV2, inspectRunLeaseV2, releaseLeasedRunV2, type LeaseRuntimeInputV2, type ProcessIdentity, type ProcessIdentityProvider } from "../../src/vnext/ralph-runtime/operational-b2/index.js";
import { prepareNextAuthorizedInvocationV2 } from "../../src/vnext/ralph-runtime/operational-b3/index.js";
import { ScriptedExecutor } from "../../src/vnext/ralph-runtime/operational-b4/index.js";
import { ScriptedAuditor } from "../../src/vnext/ralph-runtime/operational-e/index.js";
import { continueScriptedRalphRunV2 } from "../../src/vnext/ralph-runtime/operational-f/index.js";
import { createCorrectionContextV2, validateCorrectionContextV2 } from "../../src/vnext/ralph-runtime/operational-f/index.js";
import { createWorkspacePolicy, fingerprintWorkspace } from "../../src/vnext/ralph-runtime/fingerprint.js";
import { sha256, sha256Canonical } from "../../src/vnext/ralph-runtime/hashing.js";

let ordinal = 0;
const OWNER: ProcessIdentity = { pid: 58103, processStartIdentity: "f-start", hostIdentity: "f-host", bootSessionIdentity: "f-boot" };
const IDENTITY_PROVIDER: ProcessIdentityProvider = { current: () => OWNER, inspect: () => "MATCH" };
const TEST_MAX_TASK_ATTEMPTS = 4;
const TEST_VALIDATION_INFRA_RETRIES = 2;

function descriptor(schemaVersion: string, descriptorId: string) { const base = { schemaVersion, descriptorId }; return { ...base, descriptorDigest: sha256Canonical(base) }; }
function task(validation: readonly string[] = ["`test -f src/defective.ts`"]): Task { return { id: "T001", title: "Correction fixture", done: false, scope: "src", change: "correct fixture", covers: "src", dependsOn: [], parallelSafe: false, acceptanceCriteria: ["fixture is corrected"], validation: [...validation], expectedEvidence: "workspace diff", line: 1 }; }
function plan(validation: readonly string[] = ["`test -f src/defective.ts`"]): ExecutionDocument { const phase: Phase = { number: 1, id: "P01", title: "Correction", goal: "close loop", dependsOn: [], context: ["test"], tasks: [task(validation)], line: 1 }; return { contract: "rb-execution/v1", artifactId: "plan-f", title: "F", phases: [phase] }; }
function genesis(document: ExecutionDocument, runId: string, maxTaskAttemptsPerTask = TEST_MAX_TASK_ATTEMPTS): RalphRuntimeStateV2 { return createInitialRuntimeStateV2({ runId, maxTaskAttemptsPerTask, phases: document.phases.map((phase) => ({ phaseId: phase.id, taskIds: phase.tasks.map((candidate) => candidate.id) })), tasks: document.phases.flatMap((phase) => phase.tasks.map((candidate) => ({ taskId: candidate.id, phaseId: phase.id, dependsOn: candidate.dependsOn }))) }); }
function event<TType extends RalphEventTypeV2>(state: RalphRuntimeStateV2, eventType: TType, payload: EventPayloadMapV2[TType], context: { readonly phaseId?: string; readonly taskId?: string; readonly attemptId?: string } = {}): RalphEventV2 {
  const kind = V2_EVENT_ENTITY_KINDS[eventType];
  const entity: RuntimeEntityRef = kind === "run" ? { kind, id: state.runId } : kind === "task" ? { kind, id: context.taskId ?? "T001" } : { kind: "attempt", id: context.attemptId ?? "attempt-f-001" };
  const now = "2026-09-06T07:00:00.000Z";
  return createRalphEventV2({ eventId: `f-fixture-${state.lastSequence + 1}-${eventType}`, eventType, schemaVersion: EVENT_SCHEMA_V2, runId: state.runId, sequence: state.lastSequence + 1, occurredAt: now, recordedAt: now, entity, ...(kind === "attempt" ? { phaseId: context.phaseId ?? "P01", taskId: context.taskId ?? "T001", attemptId: context.attemptId ?? "attempt-f-001" } : kind === "task" ? { phaseId: context.phaseId ?? "P01", taskId: context.taskId ?? "T001" } : {}), actor: "CORE", causationId: null, correlationId: `${state.runId}:f-fixture`, payload, previousEventHash: state.lastEventHash } as UnsignedRalphEventV2<TType>) as RalphEventV2;
}
async function append(store: RalphEventStoreV2, state: RalphRuntimeStateV2, next: RalphEventV2, nonce: string): Promise<RalphRuntimeStateV2> { return (await commitRalphEventV2({ store, state, event: next, writtenAt: "2026-09-06T07:00:01.000Z", nonce })).state; }

async function bootstrap(validation: readonly string[] = ["`test -f src/defective.ts`"], retryLimits = { maxTaskAttemptsPerTask: TEST_MAX_TASK_ATTEMPTS, validationInfrastructureRetryLimit: TEST_VALIDATION_INFRA_RETRIES }) {
  const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-f-loop-"));
  await mkdir(join(root, "src"), { recursive: true });
  const document = plan(validation);
  const policy = createWorkspacePolicy();
  const initialFingerprint = await fingerprintWorkspace(root, policy);
  const config = descriptor("rb-ralph-config/v2", "f-config");
  const snapshot: RunSnapshotV2 = {
    snapshotSchemaVersion: RALPH_RUN_SNAPSHOT_V2_SCHEMA, runId: `run-f-${++ordinal}`, eventSchema: EVENT_SCHEMA_V2, stateSchema: STATE_SCHEMA_V2, operationalContract: OPERATIONAL_CONTRACT_V2,
    projectIdentity: { projectId: "f-project" }, readyPlanIdentity: document.artifactId, readyPlanHash: sha256Canonical(document), readyManifestHash: sha256("f-ready"), selectedReadyArtifactHashes: { plan: sha256Canonical(document) }, readinessInspectionDigest: sha256("f-readiness"), effectiveRunConfig: config, effectiveConfigDigest: config.descriptorDigest,
    diagnosticsPolicy: descriptor("rb-ralph-diagnostics/v2", "f-diagnostics"), environmentPolicy: descriptor("rb-ralph-environment/v2", "f-environment"), executorProfile: { profileId: "scripted-f", kind: "scripted", descriptorDigest: sha256("f-profile") }, executorCapabilities: { requested: ["fixture.effect"], granted: ["fixture.effect"], verified: ["fixture.effect"], readOnlyEnforced: false }, permissionCapabilityPolicy: descriptor("rb-ralph-capabilities/v2", "f-capabilities"), workspacePolicy: policy, initialWorkspaceFingerprint: { controlPlaneFingerprint: initialFingerprint.controlPlaneFingerprint, productWorkspaceFingerprint: initialFingerprint.productWorkspaceFingerprint, policyDigest: initialFingerprint.policyDigest, fingerprintDigest: initialFingerprint.fingerprintDigest }, retryPolicies: retryPolicyDescriptorV1(createRetryPolicyV1({ runId: `run-f-${ordinal}`, policyId: "f-retry", ...retryLimits })), timeoutPolicy: descriptor("rb-ralph-timeout/v2", "f-timeout"), runtimeIdentity: descriptor("rb-ralph-runtime/v2", "f-runtime"), leasePolicy: descriptor("rb-ralph-lease/v2", "f-lease"), createdAt: "2026-09-06T07:00:00.000Z",
  };
  const store = new RalphEventStoreV2({ projectRoot: root, runId: snapshot.runId });
  const retryPolicy = createRetryPolicyV1({ runId: snapshot.runId, policyId: "f-retry", ...retryLimits });
  const initial = genesis(document, snapshot.runId, retryLimits.maxTaskAttemptsPerTask);
  const initialized = await initializeOperationalRunV2({ store, snapshot, retryPolicy, genesisState: initial, runCreatedEvent: event(initial, "run.created", { phaseIds: initial.phaseIds, taskIds: initial.taskIds }), createdAt: "2026-09-06T07:00:00.000Z", nonce: `f-init-${ordinal}` });
  let state = await append(store, initialized.state, event(initialized.state, "run.started", {}), `f-start-${ordinal}`);
  state = await append(store, state, event(state, "task.state-changed", { disposition: "READY", activity: "IDLE", owner: "NONE", hold: "NONE" }, { phaseId: "P01", taskId: "T001" }), `f-ready-${ordinal}`);
  const lease: LeaseRuntimeInputV2 = { projectRoot: root, runId: snapshot.runId, genesisState: initial, processIdentityProvider: IDENTITY_PROVIDER };
  const createExecutor = () => new ScriptedExecutor({ clock: () => "2026-09-06T07:00:03.000Z", defaultScenario: { kind: "SUCCESS", fixtureWorkspaceAction: async (context) => {
    if (context.correctionContext) {
      expect(context.correctionContext.findingIds).toHaveLength(1);
      expect(context.correctionContext.openFindings[0]?.findingId).toBe(context.correctionContext.findingIds[0]);
      const persisted = JSON.parse(await readFile(join(root, ".rb-harness", "ralph", "runs", snapshot.runId, "attempts", context.attemptId, "correction-context.json"), "utf8")) as { readonly contextId: string; readonly contextDigest: string; readonly openFindingRefs: readonly string[] };
      expect(persisted.contextId).toBe(context.correctionContext.contextId);
      expect(persisted.contextDigest).toBe(context.correctionContext.contextDigest);
      expect(persisted.openFindingRefs).toEqual(context.correctionContext.findingIds);
      await writeFile(join(root, "src", "defective.ts"), "export const corrected = true;\n");
    } else {
      await writeFile(join(root, "src", "defective.ts"), "export const corrected = false;\n");
    }
  } } });
  const executor = createExecutor();
  return { root, document, lease, executor, createExecutor };
}

describe("Ralph Operational Core V2 — F correction loop", () => {
  it("uses the canonical Task Attempt budget as the semantic loop bound before the host watchdog", async () => {
    const value = await bootstrap(["`test -f src/defective.ts`"], { maxTaskAttemptsPerTask: 2, validationInfrastructureRetryLimit: 0 });
    try {
      const auditor = new ScriptedAuditor({ defaultDecision: {
        verdict: "REJECT",
        proposedFindings: [{ criterionId: "criterion", structuredFindingKey: "F1", severity: "BLOCKER", scope: ["src"], expectation: "fixture must be corrected", observed: "still rejected", remediationHint: "retry" }],
        resolvedFindingRefs: [],
        rationale: "reject until the canonical budget is exhausted",
      } });
      const result = await continueScriptedRalphRunV2({
        lease: value.lease,
        plan: value.document,
        executor: value.executor,
        auditor,
        clock: () => "2026-09-06T07:00:05.000Z",
        nonceFactory: () => `f-budget-${++ordinal}`,
        eventIdFactory: () => `f-budget-event-${++ordinal}`,
        attemptIdFactory: () => `attempt-f-budget-${++ordinal}`,
        safetyIterationLimit: 8,
      });
      expect(result.kind).toBe("BUDGET_EXHAUSTED");
      expect(result.kind).not.toBe("DRIVER_SAFETY_LIMIT");
      expect(result.state.tasks.T001?.attemptsUsed).toBe(2);
      expect(result.state.tasks.T001?.executorBudget?.limit).toBe(2);
      expect(Object.values(result.state.attempts)).toHaveLength(2);
      expect(value.executor.totalInvocationAttempts).toBe(2);
      const events = (await new RalphEventStoreV2({ projectRoot: value.root, runId: value.lease.runId }).inspect()).events;
      expect(events.filter((candidate) => candidate.eventType === "attempt.started")).toHaveLength(2);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  }, 15_000);

  it("runs REJECT → Finding → new Attempt → correction context → revalidation → ACCEPT → COMPLETE", async () => {
    const value = await bootstrap();
    try {
      const auditor = new ScriptedAuditor({ decide: (auditPackage) => auditPackage.openFindingRefs.length === 0
        ? { verdict: "REJECT", proposedFindings: [{ criterionId: "criterion", structuredFindingKey: "F1", severity: "BLOCKER", scope: ["src"], expectation: "fixture must be corrected", observed: "fixture is defective", remediationHint: "correct fixture" }], resolvedFindingRefs: [], rationale: "F1", metadata: {} }
        : { verdict: "ACCEPT", proposedFindings: [], resolvedFindingRefs: auditPackage.openFindingRefs.map((finding) => finding.findingId), rationale: "corrected", metadata: {} } });
      const result = await continueScriptedRalphRunV2({ lease: value.lease, plan: value.document, executor: value.executor, auditor, clock: () => "2026-09-06T07:00:05.000Z", nonceFactory: () => `f-${++ordinal}`, eventIdFactory: () => `f-event-${++ordinal}`, attemptIdFactory: () => `attempt-f-${++ordinal}`, safetyIterationLimit: 8 });
      expect(result.kind).toBe("TASK_COMPLETE");
      expect(result.state.disposition).toBe("COMPLETE");
      expect(result.state.tasks.T001?.disposition).toBe("COMPLETE");
      expect(Object.values(result.state.attempts)).toHaveLength(2);
      expect(Object.values(result.state.attempts).sort((left, right) => left.ordinal - right.ordinal).map((attempt) => attempt.closureReason)).toEqual(["AUDIT_REJECTED", "AUDIT_ACCEPTED"]);
      const findings = Object.values(result.state.findings);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.status).toBe("RESOLVED");
      expect(result.correctionContexts).toHaveLength(1);
      expect(result.correctionContexts[0]?.openFindingRefs).toEqual([findings[0]?.id]);
      expect(findings[0]?.id).toBe(`finding-${sha256Canonical({ taskId: "T001", criterionId: "criterion", structuredFindingKey: "F1" }).slice("sha256:".length)}`);
      const firstFindingEvent = (await new RalphEventStoreV2({ projectRoot: value.root, runId: value.lease.runId }).inspect()).events.find((candidate) => candidate.eventType === "finding.state-changed");
      expect(result.correctionContexts[0]?.openFindings[0]?.findingDigest).toBe(sha256Canonical(firstFindingEvent?.payload.finding));
      expect(value.executor.totalInvocationAttempts).toBe(2);
      expect(await readFile(join(value.root, "src", "defective.ts"), "utf8")).toContain("true");
      const events = (await new RalphEventStoreV2({ projectRoot: value.root, runId: value.lease.runId }).inspect()).events;
      const index = (type: string) => events.findIndex((candidate) => candidate.eventType === type);
      expect(index("attempt.closed")).toBeGreaterThan(index("finding.state-changed"));
      expect(index("run.completed")).toBeGreaterThan(index("task.state-changed"));
      const secondAuditStarted = events.map((candidate) => candidate.eventType).lastIndexOf("audit.started");
      const resolvedFinding = events.findIndex((candidate) => candidate.eventType === "finding.state-changed" && candidate.payload.finding.status === "RESOLVED");
      expect(resolvedFinding).toBeGreaterThan(secondAuditStarted);
      expect(events.flatMap((candidate) => candidate.eventType === "finding.state-changed" && candidate.payload.finding.id === findings[0]?.id
        ? [candidate.payload.finding.status]
        : []))
        .toEqual(["OPEN", "CANDIDATE_RESOLVED", "RESOLVED"]);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  }, 15_000);

  it("keeps deterministic red authoritative through the complete driver even when ScriptedAuditor says ACCEPT", async () => {
    const value = await bootstrap(["`test -f src/never-created.ts`"]);
    try {
      const auditor = new ScriptedAuditor({ defaultDecision: { verdict: "ACCEPT", rationale: "malicious override" } });
      const result = await continueScriptedRalphRunV2({ lease: value.lease, plan: value.document, executor: value.executor, auditor, clock: () => "2026-09-06T07:00:05.000Z", nonceFactory: () => `f-negative-${++ordinal}`, eventIdFactory: () => `f-negative-event-${++ordinal}`, attemptIdFactory: () => `attempt-f-negative-${++ordinal}`, safetyIterationLimit: 2 });
      expect(result.kind).toBe("DRIVER_SAFETY_LIMIT");
      expect(result.state.disposition).not.toBe("COMPLETE");
      expect(result.state.tasks.T001?.disposition).not.toBe("COMPLETE");
      expect(Object.values(result.state.attempts)).toHaveLength(2);
      expect(Object.values(result.state.attempts).every((attempt) => attempt.closureReason === "AUDIT_REJECTED")).toBe(true);
      expect(Object.values(result.state.findings).some((finding) => finding.severity === "BLOCKER" && finding.status === "OPEN")).toBe(true);
      expect(auditor.totalInvocations).toBe(2);
      const events = (await new RalphEventStoreV2({ projectRoot: value.root, runId: value.lease.runId }).inspect()).events;
      expect(events.some((candidate) => candidate.eventType === "attempt.closed" && candidate.payload.closureReason === "AUDIT_ACCEPTED")).toBe(false);
      expect(events.some((candidate) => candidate.eventType === "run.completed")).toBe(false);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  }, 15_000);

  it("stops before Auditor on HUMAN_REQUIRED and retries validation infrastructure on the same Attempt without rerunning Executor", async () => {
    const human = await bootstrap(["human: operator decision"]);
    try {
      const auditor = new ScriptedAuditor({ defaultDecision: { verdict: "ACCEPT" } });
      const result = await continueScriptedRalphRunV2({ lease: human.lease, plan: human.document, executor: human.executor, auditor, clock: () => "2026-09-06T07:00:05.000Z", nonceFactory: () => `f-human-${++ordinal}`, eventIdFactory: () => `f-human-event-${++ordinal}`, attemptIdFactory: () => `attempt-f-human-${++ordinal}`, safetyIterationLimit: 1 });
      expect(result.kind).toBe("HUMAN_REQUIRED");
      expect(result.attempt?.stage).toBe("AWAITING_HUMAN");
      expect(result.state.hold).toBe("HUMAN_REQUIRED");
      expect(auditor.totalInvocations).toBe(0);
      expect(human.executor.totalInvocationAttempts).toBe(1);
    } finally { await rm(human.root, { recursive: true, force: true }); }

    const infra = await bootstrap(["`true`"], { maxTaskAttemptsPerTask: 4, validationInfrastructureRetryLimit: 0 });
    try {
      let validationCalls = 0;
      const auditor = new ScriptedAuditor({ defaultDecision: { verdict: "ACCEPT" } });
      const result = await continueScriptedRalphRunV2({ lease: infra.lease, plan: infra.document, executor: infra.executor, auditor, validationProcessSupervisor: { run: async () => { validationCalls += 1; return { stdout: "", stderr: "infra", stdoutTruncated: false, stderrTruncated: false, exitCode: null, signal: null, infrastructureStatus: "SPAWN_FAILURE" as const, timedOut: false, cancelled: false, startedAt: "2026-09-06T07:00:05.000Z", finishedAt: "2026-09-06T07:00:05.100Z" }; } }, clock: () => "2026-09-06T07:00:05.000Z", nonceFactory: () => `f-infra-${++ordinal}`, eventIdFactory: () => `f-infra-event-${++ordinal}`, attemptIdFactory: () => `attempt-f-infra-${++ordinal}`, safetyIterationLimit: 4 });
      expect(result.kind).toBe("VALIDATION_INFRASTRUCTURE_EXHAUSTED");
      expect(result.attempt?.closureReason).toBe("VALIDATION_INFRASTRUCTURE_EXHAUSTED");
      expect(validationCalls).toBe(1);
      expect(infra.executor.totalInvocationAttempts).toBe(1);
      expect(auditor.totalInvocations).toBe(0);
    } finally { await rm(infra.root, { recursive: true, force: true }); }
  }, 15_000);

  it("keeps correction context identity stable across replay timestamps", () => {
    const base = {
      runId: "run-f-context",
      phaseId: "P01",
      taskId: "T001",
      currentAttemptId: "attempt-f-context",
      sourceRejectedAttempts: [{ attemptId: "attempt-f-old", ordinal: 1, closureReason: "AUDIT_REJECTED" as const, auditPackageDigest: sha256Canonical("package"), validationSetDigest: sha256Canonical("set") }],
      openFindingRefs: ["finding-f1"],
      openFindings: [{ findingId: "finding-f1", findingDigest: sha256Canonical("finding"), criterionId: "criterion", severity: "BLOCKER" as const, status: "OPEN" as const, observed: "defective" }],
      baseWorkspaceFingerprint: sha256Canonical("workspace"),
    };
    const first = createCorrectionContextV2({ ...base, createdAt: "2026-09-06T07:00:00.000Z" });
    const replay = createCorrectionContextV2({ ...base, createdAt: "2026-09-06T08:00:00.000Z" });
    expect(replay.contextId).toBe(first.contextId);
    expect(replay.contextDigest).not.toBe(first.contextDigest);
    validateCorrectionContextV2(replay);
  });

  it("keeps an OPEN Finding when the next Auditor omits it without explicit resolution", async () => {
    const value = await bootstrap();
    try {
      const auditor = new ScriptedAuditor({ decide: (auditPackage) => auditPackage.openFindingRefs.length === 0
        ? { verdict: "REJECT", proposedFindings: [{ criterionId: "criterion", structuredFindingKey: "F1", severity: "BLOCKER", scope: ["src"], expectation: "fixture corrected", observed: "defective" }], resolvedFindingRefs: [], rationale: "open F1", metadata: {} }
        : { verdict: "ACCEPT", proposedFindings: [], resolvedFindingRefs: [], rationale: "omits F1", metadata: {} } });
      const result = await continueScriptedRalphRunV2({ lease: value.lease, plan: value.document, executor: value.executor, auditor, clock: () => "2026-09-06T07:00:05.000Z", nonceFactory: () => `f-omit-${++ordinal}`, eventIdFactory: () => `f-omit-event-${++ordinal}`, attemptIdFactory: () => `attempt-f-omit-${++ordinal}`, safetyIterationLimit: 2 });
      const f1Id = `finding-${sha256Canonical({ taskId: "T001", criterionId: "criterion", structuredFindingKey: "F1" }).slice("sha256:".length)}`;
      expect(result.state.findings[f1Id]?.status).toBe("OPEN");
      expect(result.state.tasks.T001?.disposition).not.toBe("COMPLETE");
      const events = (await new RalphEventStoreV2({ projectRoot: value.root, runId: value.lease.runId }).inspect()).events;
      expect(events.filter((candidate) => candidate.eventType === "finding.state-changed" && candidate.entity.id === f1Id && candidate.payload.finding.status === "RESOLVED")).toHaveLength(0);
      expect(events.filter((candidate) => candidate.eventType === "attempt.closed" && candidate.payload.closureReason === "AUDIT_ACCEPTED")).toHaveLength(0);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  }, 15_000);

  it("converges across fresh driver, Executor, and Auditor objects after a rejected durable boundary", async () => {
    const value = await bootstrap();
    const createAuditor = () => new ScriptedAuditor({ decide: (auditPackage) => auditPackage.openFindingRefs.length === 0
      ? { verdict: "REJECT", proposedFindings: [{ criterionId: "criterion", structuredFindingKey: "F1", severity: "BLOCKER", scope: ["src"], expectation: "fixture must be corrected", observed: "fixture is defective", remediationHint: "correct fixture" }], resolvedFindingRefs: [], rationale: "F1", metadata: {} }
      : { verdict: "ACCEPT", proposedFindings: [], resolvedFindingRefs: auditPackage.openFindingRefs.map((finding) => finding.findingId), rationale: "corrected", metadata: {} } });
    const invocationCounts: number[] = [];
    try {
      const sessionAExecutor = value.createExecutor();
      const sessionA = await continueScriptedRalphRunV2({
        lease: { ...value.lease, runtimeInstanceId: "fresh-session-a" }, plan: value.document, executor: sessionAExecutor, auditor: createAuditor(),
        clock: () => "2026-09-06T07:00:05.000Z", nonceFactory: () => `f-fresh-a-${++ordinal}`, eventIdFactory: () => `f-fresh-a-event-${++ordinal}`, attemptIdFactory: () => `attempt-f-fresh-${++ordinal}`, safetyIterationLimit: 1,
      });
      invocationCounts.push(sessionAExecutor.totalInvocationAttempts);
      expect(sessionA.kind).toBe("DRIVER_SAFETY_LIMIT");
      const firstAttempt = Object.values(sessionA.state.attempts)[0]!;
      const frozenRejectedAttempt = JSON.stringify(firstAttempt);
      expect(firstAttempt.closureReason).toBe("AUDIT_REJECTED");
      expect(Object.values(sessionA.state.findings)[0]?.status).toBe("OPEN");
      expect((await inspectRunLeaseV2(new RalphEventStoreV2({ projectRoot: value.root, runId: value.lease.runId }))).kind).toBe("ABSENT");

      const sessionBExecutor = value.createExecutor();
      const sessionB = await continueScriptedRalphRunV2({
        lease: { ...value.lease, runtimeInstanceId: "fresh-session-b" }, plan: value.document, executor: sessionBExecutor, auditor: createAuditor(),
        clock: () => "2026-09-06T07:00:06.000Z", nonceFactory: () => `f-fresh-b-${++ordinal}`, eventIdFactory: () => `f-fresh-b-event-${++ordinal}`, attemptIdFactory: () => `attempt-f-fresh-${++ordinal}`, safetyIterationLimit: 1,
      });
      invocationCounts.push(sessionBExecutor.totalInvocationAttempts);
      expect(sessionB.kind).toBe("TASK_COMPLETE");
      const attempts = Object.values(sessionB.state.attempts).sort((left, right) => left.ordinal - right.ordinal);
      expect(attempts).toHaveLength(2);
      expect(attempts[1]?.attemptId).not.toBe(firstAttempt.attemptId);
      expect(JSON.stringify(attempts[0])).toBe(frozenRejectedAttempt);
      expect(attempts.map((attempt) => attempt.closureReason)).toEqual(["AUDIT_REJECTED", "AUDIT_ACCEPTED"]);
      expect(Object.values(sessionB.state.findings)[0]?.status).toBe("RESOLVED");
      expect(sessionB.correctionContexts).toHaveLength(1);

      const sessionCExecutor = value.createExecutor();
      const sessionC = await continueScriptedRalphRunV2({
        lease: { ...value.lease, runtimeInstanceId: "fresh-session-c" }, plan: value.document, executor: sessionCExecutor, auditor: createAuditor(), safetyIterationLimit: 1,
      });
      invocationCounts.push(sessionCExecutor.totalInvocationAttempts);
      expect(sessionC.kind).toBe("TASK_COMPLETE");
      expect(Object.values(sessionC.state.attempts)).toHaveLength(2);
      expect(invocationCounts).toEqual([1, 1, 0]);
      expect((await inspectRunLeaseV2(new RalphEventStoreV2({ projectRoot: value.root, runId: value.lease.runId }))).kind).toBe("ABSENT");
    } finally { await rm(value.root, { recursive: true, force: true }); }
  }, 20_000);

  it("releases a known-owned read/admission lease when ordinary driver input fails after acquisition", async () => {
    const value = await bootstrap();
    try {
      const input: Record<string, unknown> = {
        lease: value.lease,
        executor: value.createExecutor(),
        auditor: new ScriptedAuditor({ defaultDecision: { verdict: "ACCEPT" } }),
        safetyIterationLimit: 1,
      };
      Object.defineProperty(input, "plan", { enumerable: true, get: () => { throw new Error("F_INJECTED_AFTER_ACQUIRE"); } });
      await expect(continueScriptedRalphRunV2(input as unknown as Parameters<typeof continueScriptedRalphRunV2>[0])).rejects.toThrow("F_INJECTED_AFTER_ACQUIRE");
      const store = new RalphEventStoreV2({ projectRoot: value.root, runId: value.lease.runId });
      expect((await inspectRunLeaseV2(store)).kind).toBe("ABSENT");
      const fresh = await acquireLeasedRunV2({ ...value.lease, runtimeInstanceId: "fresh-after-failure" });
      await releaseLeasedRunV2(fresh);
      expect((await inspectRunLeaseV2(store)).kind).toBe("ABSENT");
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });
});
