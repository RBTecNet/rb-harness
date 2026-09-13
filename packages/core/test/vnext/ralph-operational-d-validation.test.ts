import { lstat, mkdtemp, readFile, rm, writeFile, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ExecutionDocument, Phase, Task } from "../../src/types.js";
import {
  EVENT_SCHEMA_V2,
  OPERATIONAL_CONTRACT_V2,
  STATE_SCHEMA_V2,
  V2_EVENT_ENTITY_KINDS,
  createInitialRuntimeStateV2,
  createRalphEventV2,
  type EventPayloadMapV2,
  type RalphEventV2,
  type RalphEventTypeV2,
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
} from "../../src/vnext/ralph-runtime/operational-b4/index.js";
import { captureEvidenceV2 } from "../../src/vnext/ralph-runtime/operational-c/index.js";
import {
  ValidationProcessSupervisorV2,
  createValidationProcessPolicyV2,
  runValidationCommandV2,
  validateValidationEnvironmentPolicyV2,
} from "../../src/vnext/ralph-runtime/operational-d/process-supervisor.js";
import {
  validateAttemptV2,
  type ValidateAttemptV2Result,
} from "../../src/vnext/ralph-runtime/operational-d/validation.js";
import { createValidationSetV2, persistValidationRunV2, persistValidationSetV2, readValidationDiagnosticsV2, readValidationRunV2, readValidationSetV2, readAuditPackageV2 } from "../../src/vnext/ralph-runtime/operational-d/artifacts.js";
import {
  ScriptedHumanValidationAuthorityV2,
  OperatorHumanValidationAuthorityV2,
  createHumanValidationRequestV2,
  createOperatorHumanValidationAuthorityV2,
  humanValidationRequestRefV2,
  isTrustedHumanValidationAuthorityV2,
  obtainTrustedHumanValidationDecisionV2,
  persistTrustedHumanValidationDecisionV2,
  readHumanValidationDecisionV2,
} from "../../src/vnext/ralph-runtime/operational-d/human.js";
import { createWorkspacePolicy, fingerprintWorkspace } from "../../src/vnext/ralph-runtime/fingerprint.js";
import { sha256, sha256Canonical } from "../../src/vnext/ralph-runtime/hashing.js";
import { createWorkspaceManifestV2, readWorkspaceAfterManifestV2 } from "../../src/vnext/ralph-runtime/operational-b4/workspace-manifest.js";
import { bindValidationProjectionRunV1, createValidationProjectionV1 } from "../../src/vnext/ralph-runtime/operational-d/validation-projection.js";

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const OWNER: ProcessIdentity = { pid: 58101, processStartIdentity: "d-start", hostIdentity: "d-host", bootSessionIdentity: "d-boot" };
const IDENTITY_PROVIDER: ProcessIdentityProvider = { current: () => OWNER, inspect: () => "MATCH" };
let nonceOrdinal = 0;
const TEST_MAX_TASK_ATTEMPTS = 4;
const TEST_VALIDATION_INFRA_RETRIES = 2;

function descriptor(schemaVersion: string, descriptorId: string) {
  const base = { schemaVersion, descriptorId };
  return { ...base, descriptorDigest: sha256Canonical(base) };
}

function task(validation: readonly string[], scope = "src"): Task {
  return {
    id: "T001",
    title: "Validate fixture",
    done: false,
    scope,
    change: "make the fixture valid",
    covers: scope,
    dependsOn: [],
    parallelSafe: false,
    acceptanceCriteria: ["the fixture is valid"],
    validation: [...validation],
    expectedEvidence: "workspace diff",
    line: 1,
  };
}

function plan(validation: readonly string[], scope = "src"): ExecutionDocument {
  const phase: Phase = { number: 1, id: "P01", title: "Validation", goal: "validate", dependsOn: [], context: ["test"], tasks: [task(validation, scope)], line: 1 };
  return { contract: "rb-execution/v1", artifactId: "plan-d", title: "D", phases: [phase] };
}

function genesis(document: ExecutionDocument, runId: string, maxTaskAttemptsPerTask = TEST_MAX_TASK_ATTEMPTS): RalphRuntimeStateV2 {
  return createInitialRuntimeStateV2({
    runId,
    maxTaskAttemptsPerTask,
    phases: document.phases.map((phase) => ({ phaseId: phase.id, taskIds: phase.tasks.map((candidate) => candidate.id) })),
    tasks: document.phases.flatMap((phase) => phase.tasks.map((candidate) => ({ taskId: candidate.id, phaseId: phase.id, dependsOn: candidate.dependsOn }))),
  });
}

function event<TType extends RalphEventTypeV2>(state: RalphRuntimeStateV2, eventType: TType, payload: EventPayloadMapV2[TType], context: { readonly phaseId?: string; readonly taskId?: string; readonly attemptId?: string } = {}): RalphEventV2 {
  const kind = V2_EVENT_ENTITY_KINDS[eventType];
  const entity: RuntimeEntityRef = kind === "run"
    ? { kind, id: state.runId }
    : kind === "task"
      ? { kind, id: context.taskId ?? "T001" }
      : { kind: "attempt", id: context.attemptId ?? "attempt-d-001" };
  const now = "2026-09-06T07:00:00.000Z";
  return createRalphEventV2({
    eventId: `d-fixture-${state.lastSequence + 1}-${eventType}`,
    eventType,
    schemaVersion: EVENT_SCHEMA_V2,
    runId: state.runId,
    sequence: state.lastSequence + 1,
    occurredAt: now,
    recordedAt: now,
    entity,
    ...(kind === "attempt" ? { phaseId: context.phaseId ?? "P01", taskId: context.taskId ?? "T001", attemptId: context.attemptId ?? "attempt-d-001" } : kind === "task" ? { phaseId: context.phaseId ?? "P01", taskId: context.taskId ?? "T001" } : {}),
    actor: "CORE",
    causationId: null,
    correlationId: `${state.runId}:d-fixture`,
    payload,
    previousEventHash: state.lastEventHash,
  } as UnsignedRalphEventV2<TType>) as RalphEventV2;
}

async function append(store: RalphEventStoreV2, state: RalphRuntimeStateV2, next: RalphEventV2, nonce: string): Promise<RalphRuntimeStateV2> {
  return (await commitRalphEventV2({ store, state, event: next, writtenAt: "2026-09-06T07:00:01.000Z", nonce })).state;
}

async function fixture(
  validation: readonly string[] | ((root: string) => readonly string[]),
  action?: (root: string) => void | Promise<void>,
  allowCaptureFailure = false,
  retryLimits = { maxTaskAttemptsPerTask: TEST_MAX_TASK_ATTEMPTS, validationInfrastructureRetryLimit: TEST_VALIDATION_INFRA_RETRIES },
  seed?: (root: string) => void | Promise<void>,
  workspacePolicyInput: Parameters<typeof createWorkspacePolicy>[0] = {},
  taskScope = "src",
) {
  const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-d-validation-"));
  await seed?.(root);
  const document = plan(typeof validation === "function" ? validation(root) : validation, taskScope);
  const policy = createWorkspacePolicy(workspacePolicyInput);
  const initialFingerprint = await fingerprintWorkspace(root, policy);
  const config = descriptor("rb-ralph-config/v2", "d-config");
  const snapshot: RunSnapshotV2 = {
    snapshotSchemaVersion: RALPH_RUN_SNAPSHOT_V2_SCHEMA,
    runId: `run-d-${++nonceOrdinal}`,
    eventSchema: EVENT_SCHEMA_V2,
    stateSchema: STATE_SCHEMA_V2,
    operationalContract: OPERATIONAL_CONTRACT_V2,
    projectIdentity: { projectId: "d-project" },
    readyPlanIdentity: document.artifactId,
    readyPlanHash: sha256Canonical(document),
    readyManifestHash: sha256("d-ready-manifest"),
    selectedReadyArtifactHashes: { plan: sha256Canonical(document) },
    readinessInspectionDigest: sha256("d-readiness"),
    effectiveRunConfig: config,
    effectiveConfigDigest: config.descriptorDigest,
    diagnosticsPolicy: descriptor("rb-ralph-diagnostics/v2", "d-diagnostics"),
    environmentPolicy: descriptor("rb-ralph-environment/v2", "d-environment"),
    executorProfile: { profileId: "scripted-d", kind: "scripted", descriptorDigest: sha256("d-profile") },
    executorCapabilities: { requested: ["fixture.effect"], granted: ["fixture.effect"], verified: ["fixture.effect"], readOnlyEnforced: false },
    permissionCapabilityPolicy: descriptor("rb-ralph-capabilities/v2", "d-capabilities"),
    workspacePolicy: policy,
    initialWorkspaceFingerprint: { controlPlaneFingerprint: initialFingerprint.controlPlaneFingerprint, productWorkspaceFingerprint: initialFingerprint.productWorkspaceFingerprint, policyDigest: initialFingerprint.policyDigest, fingerprintDigest: initialFingerprint.fingerprintDigest },
    retryPolicies: retryPolicyDescriptorV1(createRetryPolicyV1({ runId: `run-d-${nonceOrdinal}`, policyId: "d-retry", ...retryLimits })),
    timeoutPolicy: descriptor("rb-ralph-timeout/v2", "d-timeout"),
    runtimeIdentity: descriptor("rb-ralph-runtime/v2", "d-runtime"),
    leasePolicy: descriptor("rb-ralph-lease/v2", "d-lease"),
    createdAt: "2026-09-06T07:00:00.000Z",
  };
  const store = new RalphEventStoreV2({ projectRoot: root, runId: snapshot.runId });
  const retryPolicy = createRetryPolicyV1({ runId: snapshot.runId, policyId: "d-retry", ...retryLimits });
  const initial = genesis(document, snapshot.runId, retryLimits.maxTaskAttemptsPerTask);
  const initialized = await initializeOperationalRunV2({ store, snapshot, retryPolicy, genesisState: initial, runCreatedEvent: event(initial, "run.created", { phaseIds: initial.phaseIds, taskIds: initial.taskIds }), createdAt: "2026-09-06T07:00:00.000Z", nonce: `d-init-${nonceOrdinal}` });
  let state = await append(store, initialized.state, event(initialized.state, "run.started", {}), `d-start-${nonceOrdinal}`);
  state = await append(store, state, event(state, "task.state-changed", { disposition: "READY", activity: "IDLE", owner: "NONE", hold: "NONE" }, { phaseId: "P01", taskId: "T001" }), `d-ready-${nonceOrdinal}`);

  const leaseOptions: LeaseRuntimeInputV2 = { projectRoot: root, runId: snapshot.runId, genesisState: initial, processIdentityProvider: IDENTITY_PROVIDER };
  const admittedLease = await acquireLeasedRunV2(leaseOptions);
  const admitted = await prepareNextAuthorizedInvocationV2({ leasedRun: admittedLease, plan: document, attemptIdFactory: () => "attempt-d-001", nonceFactory: () => `d-${++nonceOrdinal}`, eventIdFactory: () => `d-event-${++nonceOrdinal}`, clock: () => "2026-09-06T07:00:02.000Z" });
  if (admitted.kind !== "AUTHORIZED_NOT_INVOKED") throw new Error(`D fixture admission failed: ${admitted.kind}`);
  const executorLease = await acquireLeasedRunV2(leaseOptions);
  const executor = new ScriptedExecutor({ clock: () => "2026-09-06T07:00:03.000Z", defaultScenario: { kind: "SUCCESS", fixtureWorkspaceAction: action === undefined ? undefined : () => action(root) } });
  const executed = await executeAuthorizedInvocationV2({ leasedRun: executorLease, plan: document, runtime: executor, nonceFactory: () => `d-${++nonceOrdinal}`, eventIdFactory: () => `d-event-${++nonceOrdinal}` });
  if (executed.kind !== "EXECUTOR_FINISHED_READY_FOR_CAPTURE") throw new Error(`D fixture execution failed: ${executed.kind}`);
  const captured = await captureEvidenceV2({ leasedRun: executorLease, plan: document, observation: executed.observation, nonceFactory: () => `d-${++nonceOrdinal}`, eventIdFactory: () => `d-event-${++nonceOrdinal}`, clock: () => "2026-09-06T07:00:04.000Z" });
  if (!allowCaptureFailure && captured.kind !== "EVIDENCE_CAPTURED_READY_FOR_VALIDATION") throw new Error(`D fixture evidence failed: ${captured.kind}`);
  return { root, store, document, initial, leaseOptions, observation: executed.observation, executor, captured };
}

async function runD(value: Awaited<ReturnType<typeof fixture>>, options: Partial<Parameters<typeof validateAttemptV2>[0]> = {}): Promise<ValidateAttemptV2Result> {
  const lease = await acquireLeasedRunV2(value.leaseOptions);
  return validateAttemptV2({ leasedRun: lease, plan: value.document, executorObservation: value.observation, nonceFactory: () => `d-${++nonceOrdinal}`, eventIdFactory: () => `d-event-${++nonceOrdinal}`, clock: () => "2026-09-06T07:00:05.000Z", ...options });
}

describe("Ralph Operational Core V2 — D Validation", () => {
  it.each([
    ["npm run build", "dist/index.js", "dist"],
    ["npm run tsbuild", ".tsbuildinfo", ".tsbuildinfo"],
    ["npm test", "coverage/coverage.json", "coverage"],
    ["npm run tool", ".vite/cache.bin", ".vite"],
    ["npm run tool", ".cache/cache.bin", ".cache"],
  ] as const)("runs %s in an ephemeral projection and discards validation-only %s", async (command, generatedPath, generatedRoot) => {
    const value = await fixture([`\`${command}\``], async (root) => {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src/app.ts"), "export const authority = 'executor';\n");
    }, false, undefined, seedMajor4NpmProject);
    let projectionRoot = "";
    let projectedBytes = "";
    const delegate = new ValidationProcessSupervisorV2();
    try {
      const evidenceManifest = await readWorkspaceAfterManifestV2(value.store, "attempt-d-001");
      if (!evidenceManifest) throw new Error("missing Evidence manifest");
      const result = await runD(value, { processSupervisor: { run: async (input) => {
        projectionRoot = input.cwd;
        const processResult = await delegate.run(input);
        projectedBytes = await readFile(join(input.cwd, generatedPath), "utf8");
        return processResult;
      } } });
      expect(result.kind).toBe("VALIDATION_READY_FOR_AUDIT");
      if (result.kind !== "VALIDATION_READY_FOR_AUDIT") throw new Error("Major-4 validation did not reach AuditPackage");
      expect(projectedBytes.length).toBeGreaterThan(0);
      expect(await readFile(join(value.root, "src/app.ts"), "utf8")).toBe("export const authority = 'executor';\n");
      await expect(lstat(join(value.root, generatedRoot))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(projectionRoot)).rejects.toMatchObject({ code: "ENOENT" });
      expect(result.auditPackage.workspaceFingerprint).toBe(evidenceManifest.fingerprintDigest);
      expect(result.auditPackage.postExecutorFingerprint).toBe(evidenceManifest.fingerprintDigest);
      expect((await fingerprintWorkspace(value.root)).fingerprintDigest).toBe(evidenceManifest.fingerprintDigest);
      expect(evidenceManifest.productWorkspaceEntries.find((entry) => entry.path === "src/app.ts")?.contentHash).toBe(sha256("export const authority = 'executor';\n"));
    } finally { await rm(value.root, { recursive: true, force: true }); }
  }, 30_000);

  it("keeps a validation rewrite in the projection and never promotes it into AuditPackage authority", async () => {
    const value = await fixture(["`echo MALICIOUS > src/app.ts`"], async (root) => {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src/app.ts"), "ORIGINAL\n");
    });
    let projected = "";
    let projectionRoot = "";
    const delegate = new ValidationProcessSupervisorV2();
    try {
      const result = await runD(value, { processSupervisor: { run: async (input) => {
        projectionRoot = input.cwd;
        const processResult = await delegate.run(input);
        projected = await readFile(join(input.cwd, "src/app.ts"), "utf8");
        return processResult;
      } } });
      expect(result.kind).toBe("VALIDATION_READY_FOR_AUDIT");
      expect(projected).toBe("MALICIOUS\n");
      expect(await readFile(join(value.root, "src/app.ts"), "utf8")).toBe("ORIGINAL\n");
      await expect(lstat(projectionRoot)).rejects.toMatchObject({ code: "ENOENT" });
      const evidenceManifest = await readWorkspaceAfterManifestV2(value.store, "attempt-d-001");
      expect(evidenceManifest?.productWorkspaceEntries.find((entry) => entry.path === "src/app.ts")?.contentHash).toBe(sha256("ORIGINAL\n"));
      expect((await fingerprintWorkspace(value.root)).fingerprintDigest).toBe(evidenceManifest?.fingerprintDigest);
      if (result.kind === "VALIDATION_READY_FOR_AUDIT") expect(result.auditPackage.workspaceFingerprint).toBe(evidenceManifest?.fingerprintDigest);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  }, 30_000);

  it("makes the real canonical candidate path inaccessible inside validation", async () => {
    const value = await fixture((root) => [`\`if test -e '${root}'; then exit 41; fi; (printf MALICIOUS > '${root}/src/app.ts') 2>/dev/null && exit 42 || true\``], async (root) => {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src/app.ts"), "ORIGINAL\n");
    });
    try {
      const result = await runD(value);
      expect(result.kind).toBe("VALIDATION_READY_FOR_AUDIT");
      expect(await readFile(join(value.root, "src/app.ts"), "utf8")).toBe("ORIGINAL\n");
    } finally { await rm(value.root, { recursive: true, force: true }); }
  }, 30_000);

  it("preserves Executor-created dist while validation rewrites only its disposable projection", async () => {
    const value = await fixture(["`printf validation-version > dist/index.js`"], async (root) => {
      await mkdir(join(root, "src"), { recursive: true });
      await mkdir(join(root, "dist"), { recursive: true });
      await writeFile(join(root, "src/app.ts"), "source\n");
      await writeFile(join(root, "dist/index.js"), "executor-version\n");
    }, false, undefined, undefined, { scopePaths: ["dist/index.js"] }, "src dist");
    let projected = "";
    const delegate = new ValidationProcessSupervisorV2();
    try {
      const result = await runD(value, { processSupervisor: { run: async (input) => {
        const processResult = await delegate.run(input);
        projected = await readFile(join(input.cwd, "dist/index.js"), "utf8");
        return processResult;
      } } });
      expect(result.kind).toBe("VALIDATION_READY_FOR_AUDIT");
      expect(projected).toBe("validation-version");
      expect(await readFile(join(value.root, "dist/index.js"), "utf8")).toBe("executor-version\n");
      const publicationCandidate = await fingerprintWorkspace(value.root, { scopePaths: ["dist/index.js"] });
      if (result.kind === "VALIDATION_READY_FOR_AUDIT") expect(publicationCandidate.fingerprintDigest).toBe(result.auditPackage.workspaceFingerprint);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  }, 30_000);

  it("runs trusted COMMAND text as one shell command and produces a durable ValidationSet/AuditPackage", async () => {
    const value = await fixture(["`test -f src/a.ts`"], async (root) => {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
    });
    try {
      const result = await runD(value);
      expect(result.kind).toBe("VALIDATION_READY_FOR_AUDIT");
      if (result.kind !== "VALIDATION_READY_FOR_AUDIT") throw new Error("D command did not reach audit boundary");
      expect(result.validationSet.summary).toMatchObject({ total: 1, completed: 1, passed: 1, failed: 0, hardNegative: false });
      expect(result.auditPackage.schema).toBe("rb-ralph-audit-package/v1");
      expect((await readValidationSetV2(value.store, "attempt-d-001"))?.setDigest).toBe(result.validationSet.setDigest);
      expect((await readAuditPackageV2(value.store, "attempt-d-001"))?.packageDigest).toBe(result.auditPackage.packageDigest);
      expect((await value.store.inspect()).events.map((candidate) => candidate.eventType)).toContain("validation.completed");
      expect((await value.store.inspect()).events.map((candidate) => candidate.eventType)).toContain("attempt.audit-ready");
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("classifies a normal non-zero COMMAND exit as semantic FAIL, never infrastructure red", async () => {
    const value = await fixture(["`test -f src/missing.ts`"]);
    try {
      const result = await runD(value);
      expect(result.kind).toBe("VALIDATION_READY_FOR_AUDIT");
      if (result.kind === "VALIDATION_READY_FOR_AUDIT") expect(result.validationSet.summary).toMatchObject({ failed: 1, infrastructureFailures: 0, hardNegative: true });
      const run = await readValidationRunV2(value.store, "attempt-d-001", (result as Extract<ValidateAttemptV2Result, { kind: "VALIDATION_READY_FOR_AUDIT" }>).validationSet.validationRunRefs[0]!.validationRunId);
      expect(run).toMatchObject({ semanticStatus: "FAIL", infrastructureStatus: "NONE", outcome: "FAIL" });
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("keeps MANUAL unproven and does not start an Auditor", async () => {
    const value = await fixture(["manual: inspect the fixture"]);
    try {
      const result = await runD(value);
      expect(result.kind).toBe("VALIDATION_READY_FOR_AUDIT");
      if (result.kind === "VALIDATION_READY_FOR_AUDIT") {
        expect(result.validationSet.summary).toMatchObject({ notApplicable: 1, manualRequired: 1, passed: 0 });
        expect(result.auditPackage.auditability).toBe("NOT_AUDITABLE");
      }
      const names = (await value.store.inspect()).events.map((candidate) => candidate.eventType);
      expect(names).not.toContain("audit.started");
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("fails closed when the WorkUnit has no ValidationSpec", async () => {
    const value = await fixture([]);
    try {
      const result = await runD(value);
      expect(result.kind).toBe("VALIDATION_READY_FOR_AUDIT");
      if (result.kind === "VALIDATION_READY_FOR_AUDIT") {
        expect(result.validationSet.summary).toMatchObject({ total: 0, completed: 0, passed: 0, failed: 0, hardNegative: false });
        expect(result.auditPackage.auditability).toBe("NOT_AUDITABLE");
        expect(result.auditPackage.relevantContext).toContain("validation-missing");
      }
      const names = (await value.store.inspect()).events.map((candidate) => candidate.eventType);
      expect(names).not.toContain("audit.started");
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("materializes a Human result only after the durable hold-clear and resumes the same Attempt", async () => {
    const value = await fixture(["human: operator decision"]);
    try {
      const first = await runD(value);
      expect(first.kind).toBe("HUMAN_REQUIRED");
      if (first.kind !== "HUMAN_REQUIRED") throw new Error("Human hold was not reached");
      expect(first.attempt.stage).toBe("AWAITING_HUMAN");
      const spec = first.attempt.validationSpecs[0]!;
      const authority = new ScriptedHumanValidationAuthorityV2({ authorityId: "human-d-pass", defaultDecision: "PASS", clock: () => "2026-09-06T07:00:06.000Z" });
      const resumed = await runD(value, { humanAuthority: authority });
      expect(resumed.kind).toBe("VALIDATION_READY_FOR_AUDIT");
      expect(resumed.attempt.attemptId).toBe(first.attempt.attemptId);
      const decision = await readHumanValidationDecisionV2(value.store, first.attempt.attemptId, spec.validationSpecId);
      expect(decision?.humanRequestRef).toBe(humanValidationRequestRefV2(value.store.runId, first.attempt.attemptId, spec.validationSpecId));
      if (resumed.kind === "VALIDATION_READY_FOR_AUDIT") {
        const humanRun = await readValidationRunV2(value.store, resumed.attempt.attemptId, resumed.validationSet.validationRunRefs[0]!.validationRunId);
        expect(humanRun).toMatchObject({ kind: "HUMAN", semanticStatus: "PASS", infrastructureStatus: "NONE", outcome: "PASS", diagnosticDigests: [decision?.decisionDigest] });
        expect(humanRun?.diagnosticRefs[0]).toContain("human-validation-decision-");
      }
      const events = (await value.store.inspect()).events;
      const names = events.map((candidate) => candidate.eventType);
      expect(names).toContain("run.hold-cleared");
      expect(events.find((candidate) => candidate.eventType === "run.hold-cleared")?.payload.proofRef).toBe(humanValidationRequestRefV2(value.store.runId, first.attempt.attemptId, spec.validationSpecId));
      expect(names).not.toContain("attempt.closed");
    } finally { await rm(value.root, { recursive: true, force: true }); }
  }, 30_000);

  it("binds nominal OPERATOR_HUMAN authority to one exact request and resumes from a durable decision without asking again", async () => {
    const value = await fixture(["human: check keyboard and touch flows"]);
    try {
      const first = await runD(value);
      expect(first.kind).toBe("HUMAN_REQUIRED");
      if (first.kind !== "HUMAN_REQUIRED") throw new Error("Human hold was not reached");
      const spec = first.attempt.validationSpecs[0]!;
      const request = createHumanValidationRequestV2({
        runId: value.store.runId,
        phaseId: first.attempt.phaseId,
        taskId: first.attempt.taskId,
        attemptId: first.attempt.attemptId,
        validationSpecId: spec.validationSpecId,
        validationSpecDigest: spec.digest,
      });
      const authority = createOperatorHumanValidationAuthorityV2({
        authorityId: "operator-d-exact",
        request,
        decision: "PASS",
        decidedAt: "2026-09-06T07:00:06.000Z",
      });
      expect(isTrustedHumanValidationAuthorityV2(authority)).toBe(true);
      expect(authority.identity).toMatchObject({ kind: "OPERATOR_HUMAN", authorityId: "operator-d-exact", requestDigest: sha256Canonical(request) });
      expect(isTrustedHumanValidationAuthorityV2({ identity: authority.identity, decide: authority.decide.bind(authority) })).toBe(false);
      expect(isTrustedHumanValidationAuthorityV2(JSON.parse(JSON.stringify(authority)))).toBe(false);
      expect(() => new OperatorHumanValidationAuthorityV2({ authorityId: "provider-lookalike", request, decision: "PASS", decidedAt: "2026-09-06T07:00:06.000Z" }, {}))
        .toThrow("D_HUMAN_AUTHORITY_TRUST_REQUIRED");
      expect(isTrustedHumanValidationAuthorityV2(Object.create(OperatorHumanValidationAuthorityV2.prototype))).toBe(false);
      const differentRequest = createHumanValidationRequestV2({
        runId: request.runId,
        phaseId: request.phaseId,
        taskId: request.taskId,
        attemptId: request.attemptId,
        validationSpecId: request.validationSpecId,
        validationSpecDigest: sha256("different-spec"),
      });
      await expect(obtainTrustedHumanValidationDecisionV2(authority, differentRequest))
        .rejects.toThrow("D_HUMAN_AUTHORITY_REQUEST_MISMATCH");
      expect(await readHumanValidationDecisionV2(value.store, request.attemptId, request.validationSpecId)).toBeUndefined();

      // Persisting the trusted decision models a crash before hold clearing.
      const decision = await obtainTrustedHumanValidationDecisionV2(authority, request);
      await persistTrustedHumanValidationDecisionV2(value.store, decision, `d-${++nonceOrdinal}`);
      await expect(persistTrustedHumanValidationDecisionV2(value.store, JSON.parse(JSON.stringify(decision)), `d-${++nonceOrdinal}`))
        .rejects.toThrow("D_HUMAN_DECISION_TRUST_REQUIRED");
      const resumed = await runD(value);
      expect(resumed.kind).toBe("VALIDATION_READY_FOR_AUDIT");
      expect(resumed.attempt.attemptId).toBe(first.attempt.attemptId);
      const persisted = await readHumanValidationDecisionV2(value.store, request.attemptId, request.validationSpecId);
      expect(persisted).toMatchObject({ decision: "PASS", authority: { kind: "OPERATOR_HUMAN", requestDigest: sha256Canonical(request) } });
      const events = (await value.store.inspect()).events;
      expect(events.filter((event) => event.eventType === "attempt.human-required")).toHaveLength(1);
      expect(events.filter((event) => event.eventType === "run.hold-cleared")).toHaveLength(1);
      expect(events.filter((event) => event.eventType === "validation.completed")).toHaveLength(1);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  }, 30_000);

  it("rejects a forged Human PASS and accepts genuine nominal PASS/FAIL controls", async () => {
    const forged = await fixture(["human: operator decision"]);
    try {
      const first = await runD(forged);
      expect(first.kind).toBe("HUMAN_REQUIRED");
      const spec = first.attempt.validationSpecs[0]!;
      const fake = {
        decision: "PASS",
        proofRef: "i-made-this-up",
        evidenceRef: "no-such-artifact",
        runId: forged.store.runId,
        phaseId: "P01",
        taskId: "T001",
        attemptId: first.attempt.attemptId,
        validationSpecId: spec.validationSpecId,
        validationSpecDigest: spec.digest,
      };
      const attempted = await runD(forged, { humanDecision: fake } as unknown as Partial<Parameters<typeof validateAttemptV2>[0]>);
      expect(attempted.kind).toBe("HUMAN_REQUIRED");
      expect(attempted.attempt.stage).toBe("AWAITING_HUMAN");
      expect(await readHumanValidationDecisionV2(forged.store, first.attempt.attemptId, spec.validationSpecId)).toBeUndefined();
      expect(await readAuditPackageV2(forged.store, first.attempt.attemptId)).toBeUndefined();
      const events = (await forged.store.inspect()).events;
      expect(events.some((candidate) => candidate.eventType === "run.hold-cleared")).toBe(false);
      expect(events.some((candidate) => candidate.eventType === "validation.completed" && candidate.payload.validationRun.outcome === "PASS")).toBe(false);
      expect(events.some((candidate) => candidate.eventType === "audit.started")).toBe(false);
      expect(events.some((candidate) => candidate.eventType === "attempt.closed" && candidate.payload.closureReason === "AUDIT_ACCEPTED")).toBe(false);
      expect(attempted.state.tasks.T001?.disposition).not.toBe("COMPLETE");

      const genuineAuthority = new ScriptedHumanValidationAuthorityV2({ authorityId: "human-nominal-control", defaultDecision: "PASS" });
      const structuralFake = { identity: genuineAuthority.identity, decide: genuineAuthority.decide.bind(genuineAuthority) };
      const clone = JSON.parse(JSON.stringify(genuineAuthority));
      const prototypeSpoof = Object.create(ScriptedHumanValidationAuthorityV2.prototype);
      expect(isTrustedHumanValidationAuthorityV2(genuineAuthority)).toBe(true);
      expect(isTrustedHumanValidationAuthorityV2(structuralFake)).toBe(false);
      expect(isTrustedHumanValidationAuthorityV2(clone)).toBe(false);
      expect(isTrustedHumanValidationAuthorityV2(prototypeSpoof)).toBe(false);
      await expect(runD(forged, { humanAuthority: structuralFake as never })).rejects.toMatchObject({ code: "D_HUMAN_DECISION_BINDING_INVALID" });
      const afterFakeAuthority = (await forged.store.inspect()).events;
      expect(afterFakeAuthority.some((candidate) => candidate.eventType === "run.hold-cleared")).toBe(false);
      expect(afterFakeAuthority.some((candidate) => candidate.eventType === "attempt.audit-ready")).toBe(false);
    } finally { await rm(forged.root, { recursive: true, force: true }); }

    for (const expected of ["PASS", "FAIL"] as const) {
      const genuine = await fixture(["human: operator decision"]);
      try {
        const first = await runD(genuine);
        const resumed = await runD(genuine, { humanAuthority: new ScriptedHumanValidationAuthorityV2({ authorityId: `human-d-${expected.toLowerCase()}`, defaultDecision: expected, clock: () => "2026-09-06T07:00:06.000Z" }) });
        expect(resumed.kind).toBe("VALIDATION_READY_FOR_AUDIT");
        if (resumed.kind !== "VALIDATION_READY_FOR_AUDIT") throw new Error("Human decision did not materialize");
        const run = await readValidationRunV2(genuine.store, resumed.attempt.attemptId, resumed.validationSet.validationRunRefs[0]!.validationRunId);
        expect(run).toMatchObject({ kind: "HUMAN", semanticStatus: expected, outcome: expected });
        expect(resumed.attempt.attemptId).toBe(first.attempt.attemptId);
      } finally { await rm(genuine.root, { recursive: true, force: true }); }
    }
  }, 30_000);

  it("retries infrastructure failure on the same Attempt with a new ValidationRun and never invokes Executor", async () => {
    const value = await fixture(["`test -f src/a.ts`"], undefined, false, { maxTaskAttemptsPerTask: 4, validationInfrastructureRetryLimit: 1 });
    try {
      let calls = 0;
      const supervisor = { run: async () => {
        calls += 1;
        return { stdout: "", stderr: "runner unavailable", stdoutTruncated: false, stderrTruncated: false, exitCode: null, signal: null, infrastructureStatus: "SPAWN_FAILURE" as const, timedOut: false, cancelled: false, startedAt: "2026-09-06T07:00:05.000Z", finishedAt: "2026-09-06T07:00:05.100Z" };
      } };
      const result = await runD(value, { processSupervisor: supervisor });
      expect(result.kind).toBe("VALIDATION_INFRASTRUCTURE_EXHAUSTED");
      expect(calls).toBe(2);
      expect(value.executor.totalInvocationAttempts).toBe(1);
      expect(result.attempt.attemptId).toBe("attempt-d-001");
      expect(result.attempt.validationRuns).toHaveLength(2);
      expect(result.attempt.validationRuns.every((run) => run.outcome === "INFRASTRUCTURE_FAILURE")).toBe(true);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("takes Validation infrastructure retries only from RetryPolicy and ignores a caller widening attempt", async () => {
    const retrying = await fixture(["`true`"], undefined, false, { maxTaskAttemptsPerTask: 3, validationInfrastructureRetryLimit: 1 });
    try {
      let calls = 0;
      const result = await runD(retrying, { processSupervisor: { run: async () => {
        calls += 1;
        return calls === 1
          ? { stdout: "", stderr: "infra", stdoutTruncated: false, stderrTruncated: false, exitCode: null, signal: null, infrastructureStatus: "SPAWN_FAILURE" as const, timedOut: false, cancelled: false, startedAt: "2026-09-06T07:00:05.000Z", finishedAt: "2026-09-06T07:00:05.100Z" }
          : { stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, exitCode: 0, signal: null, infrastructureStatus: "NONE" as const, timedOut: false, cancelled: false, startedAt: "2026-09-06T07:00:05.200Z", finishedAt: "2026-09-06T07:00:05.300Z" };
      } } });
      expect(result.kind).toBe("VALIDATION_READY_FOR_AUDIT");
      expect(calls).toBe(2);
      expect(retrying.executor.totalInvocationAttempts).toBe(1);
      expect(result.attempt.validationRuns).toHaveLength(2);
    } finally { await rm(retrying.root, { recursive: true, force: true }); }

    const nonRetrying = await fixture(["`true`"], undefined, false, { maxTaskAttemptsPerTask: 3, validationInfrastructureRetryLimit: 0 });
    try {
      let calls = 0;
      const callerAttempt = {
        processSupervisor: { run: async () => {
          calls += 1;
          return { stdout: "", stderr: "infra", stdoutTruncated: false, stderrTruncated: false, exitCode: null, signal: null, infrastructureStatus: "SPAWN_FAILURE" as const, timedOut: false, cancelled: false, startedAt: "2026-09-06T07:00:05.000Z", finishedAt: "2026-09-06T07:00:05.100Z" };
        } },
        validationInfrastructureBudget: 99,
      } as unknown as Partial<Parameters<typeof validateAttemptV2>[0]>;
      const result = await runD(nonRetrying, callerAttempt);
      expect(result.kind).toBe("VALIDATION_INFRASTRUCTURE_EXHAUSTED");
      expect(calls).toBe(1);
      expect(nonRetrying.executor.totalInvocationAttempts).toBe(1);
    } finally { await rm(nonRetrying.root, { recursive: true, force: true }); }
  });

  it("bounds diagnostics, protects .rb through workspace reconciliation, and rejects unsafe environments", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-d-process-"));
    try {
      const supervisor = new ValidationProcessSupervisorV2({ policy: createValidationProcessPolicyV2({ maxOutputBytes: 32, timeoutMs: 2_000 }) });
      const output = await runDirectValidationCommand(root, "printf '0123456789012345678901234567890123456789'", { supervisor });
      expect(output.infrastructureStatus).toBe("NONE");
      expect(output.stdout.length).toBeLessThanOrEqual(32);
      expect(output.stdoutTruncated).toBe(true);
      expect(() => validateValidationEnvironmentPolicyV2({ allowedKeys: ["API_KEY"], inheritedKeys: [], explicit: {}, policyDigest: "sha256:bad" })).toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("classifies timeout and cancellation as bounded infrastructure outcomes and never treats either as semantic FAIL", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-d-termination-"));
    try {
      const timeout = await runDirectValidationCommand(root, "sleep 1", { supervisor: new ValidationProcessSupervisorV2({ policy: createValidationProcessPolicyV2({ timeoutMs: 30, killGraceMs: 20, maxOutputBytes: 64 }) }) });
      expect(timeout.infrastructureStatus).toBe("TIMEOUT");
      expect(timeout.timedOut).toBe(true);
      expect(timeout.cancelled).toBe(false);
      const controller = new AbortController();
      const pending = runDirectValidationCommand(root, "sleep 1", { signal: controller.signal, supervisor: new ValidationProcessSupervisorV2({ policy: createValidationProcessPolicyV2({ timeoutMs: 2_000, killGraceMs: 20, maxOutputBytes: 64 }) }) });
      setTimeout(() => controller.abort(), 20);
      const cancelled = await pending;
      expect(cancelled.infrastructureStatus).toBe("CANCELLED");
      expect(cancelled.timedOut).toBe(false);
      expect(cancelled.cancelled).toBe(true);
      const nonQuiescent = await runDirectValidationCommand(root, "(sleep 0.2; printf leaked > descendant-leak) >/dev/null 2>&1 & exit 0", { supervisor: new ValidationProcessSupervisorV2({ policy: createValidationProcessPolicyV2({ timeoutMs: 2_000, killGraceMs: 50, maxOutputBytes: 64 }) }) });
      expect(nonQuiescent.infrastructureStatus).toBe("NONE");
      expect(nonQuiescent.timedOut).toBe(false);
      expect(nonQuiescent.cancelled).toBe(false);
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 300));
      await expect(readFile(resolve(root, "descendant-leak"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("normalizes contradictory supervisor facts as runner protocol failure", async () => {
    const value = await fixture(["`true`"], undefined, false, { maxTaskAttemptsPerTask: 4, validationInfrastructureRetryLimit: 0 });
    try {
      const result = await runD(value, {
        processSupervisor: {
          run: async () => ({
            stdout: "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
            exitCode: null,
            signal: null,
            infrastructureStatus: "NONE" as const,
            timedOut: true,
            cancelled: false,
            startedAt: "2026-09-06T07:00:05.000Z",
            finishedAt: "2026-09-06T07:00:05.100Z",
          }),
        },
      });
      expect(result.kind).toBe("VALIDATION_INFRASTRUCTURE_EXHAUSTED");
      const ref = result.attempt.validationRuns[0]!;
      const run = await readValidationRunV2(value.store, result.attempt.attemptId, ref.validationRunId);
      expect(run).toMatchObject({ infrastructureStatus: "RUNNER_PROTOCOL_FAILURE", semanticStatus: "UNPROVEN", outcome: "INFRASTRUCTURE_FAILURE" });
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("persists bounded diagnostics and binds ValidationSet order/digest before validation.completed", async () => {
    const value = await fixture(["`printf diagnostic-output`", "`true`"]);
    try {
      const result = await runD(value, {
        processSupervisor: { run: async (input) => ({ stdout: input.command.includes("diagnostic") ? "x".repeat(9_000) : "", stderr: "y".repeat(9_000), stdoutTruncated: false, stderrTruncated: false, exitCode: 0, signal: null, infrastructureStatus: "NONE" as const, timedOut: false, cancelled: false, startedAt: "2026-09-06T07:00:05.000Z", finishedAt: "2026-09-06T07:00:05.100Z" }) },
      });
      expect(result.kind).toBe("VALIDATION_READY_FOR_AUDIT");
      if (result.kind !== "VALIDATION_READY_FOR_AUDIT") throw new Error("ValidationSet was not materialized");
      expect(result.validationSet.validationRunRefs).toHaveLength(2);
      expect(result.validationSet.validationRunRefs.map((ref) => ref.validationRunOrdinal)).toEqual([1, 1]);
      const firstRun = await readValidationRunV2(value.store, "attempt-d-001", result.validationSet.validationRunRefs[0]!.validationRunId);
      expect(firstRun?.diagnosticRefs).toHaveLength(1);
      const diagnostics = await readValidationDiagnosticsV2(value.store, "attempt-d-001", firstRun!.validationRunId);
      expect(diagnostics?.stdout.length).toBe(4_096);
      expect(diagnostics?.stderr.length).toBe(4_096);
      expect(diagnostics?.stdoutTruncated).toBe(true);
      expect(diagnostics?.stderrTruncated).toBe(true);
      const { runDigest: _runDigest, ...runBase } = firstRun!;
      const alteredRun = { ...runBase, instruction: "tampered", runDigest: sha256Canonical({ ...runBase, instruction: "tampered" }) };
      await expect(persistValidationRunV2(value.store, alteredRun, "d-tampered-run")).rejects.toThrow();
      const events = (await value.store.inspect()).events;
      expect(events.findIndex((candidate) => candidate.eventType === "validation.completed")).toBeGreaterThan(events.findIndex((candidate) => candidate.eventType === "validation.started"));
      expect(events.findIndex((candidate) => candidate.eventType === "attempt.audit-ready")).toBeGreaterThan(events.findIndex((candidate) => candidate.eventType === "validation.completed"));
      const setFile = join(value.store.runDirectory, "attempts", "attempt-d-001", "validation-set.json");
      expect((await stat(setFile)).mode & 0o777).toBe(0o600);
      const packageFile = join(value.store.runDirectory, "attempts", "attempt-d-001", "audit-package.json");
      expect((await stat(packageFile)).mode & 0o777).toBe(0o600);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("rejects a ValidationSet candidate containing an unstable PENDING ValidationRun", async () => {
    const value = await fixture(["`true`"]);
    try {
      const attempt = value.captured.attempt;
      const evidence = attempt.evidenceCapture;
      if (!evidence) throw new Error("evidence fixture missing");
      const pendingInput = {
        runId: value.store.runId,
        phaseId: attempt.phaseId,
        taskId: attempt.taskId,
        attemptId: attempt.attemptId,
        evidenceCaptureId: evidence.evidenceCaptureId,
        evidenceDigest: evidence.evidenceDigest,
        postExecutorFingerprint: evidence.postExecutorFingerprint,
        validationRunRefs: [{ validationRunId: "pending-run", validationSpecId: "T001:validation:1", validationSpecDigest: sha256("pending-spec"), validationRunOrdinal: 1, artifactRef: `attempts/${attempt.attemptId}/validation-run-pending-run.json`, runDigest: sha256("pending-run") }],
        summary: { total: 1, completed: 0, passed: 0, failed: 0, notApplicable: 0, infrastructureFailures: 0, manualRequired: 0, humanRequired: 0, hardNegative: false },
        hardNegative: false,
        manualUnprovenSpecIds: [],
        humanValidationSpecIds: [],
      } as const;
      expect(() => createValidationSetV2(pendingInput)).toThrow(/pending ValidationRuns/);
      const forged = { schema: "rb-ralph-validation-set/v1", ...pendingInput, setDigest: sha256Canonical({ schema: "rb-ralph-validation-set/v1", ...pendingInput }) } as never;
      await expect(persistValidationSetV2(value.store, forged, "d-pending-set")).rejects.toThrow();
      expect(await readValidationSetV2(value.store, attempt.attemptId)).toBeUndefined();
      expect(await readAuditPackageV2(value.store, attempt.attemptId)).toBeUndefined();
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("fails closed when an adversarial supervisor reaches product or control-plane paths on the canonical candidate", async () => {
    const product = await fixture(["`true`"]);
    try {
      const productResult = await runD(product, { processSupervisor: { run: async () => {
        await writeFile(join(product.root, "unexpected-product-change"), "mutation");
        return { stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, exitCode: 0, signal: null, infrastructureStatus: "NONE" as const, timedOut: false, cancelled: false, startedAt: "2026-09-06T07:00:05.000Z", finishedAt: "2026-09-06T07:00:05.100Z" };
      } } });
      expect(productResult.kind).toBe("RECONCILIATION_REQUIRED");
      await rm(product.root, { recursive: true, force: true });

      const control = await fixture(["`true`"]);
      try {
        const controlResult = await runD(control, { processSupervisor: { run: async () => {
          await mkdir(join(control.root, ".rb"), { recursive: true });
          await writeFile(join(control.root, ".rb/validation-mutated"), "mutation");
          return { stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, exitCode: 0, signal: null, infrastructureStatus: "NONE" as const, timedOut: false, cancelled: false, startedAt: "2026-09-06T07:00:05.000Z", finishedAt: "2026-09-06T07:00:05.100Z" };
        } } });
        expect(controlResult.kind).toBe("CONTROL_PLANE_VIOLATION");
        expect(controlResult.attempt.closureReason).toBe("CONTROL_PLANE_VIOLATION");
        expect((await control.store.inspect()).events.map((candidate) => candidate.eventType)).not.toContain("attempt.audit-ready");
      } finally { await rm(control.root, { recursive: true, force: true }); }
    } finally {
      await rm(product.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("closes fail-closed after a durable validation.started boundary has no result", async () => {
    const value = await fixture(["`test -f src/a.ts`"], undefined, false, { maxTaskAttemptsPerTask: 4, validationInfrastructureRetryLimit: 0 });
    try {
      const lease = await acquireLeasedRunV2(value.leaseOptions);
      let calls = 0;
      const result = await validateAttemptV2({ leasedRun: lease, plan: value.document, executorObservation: value.observation, processSupervisor: { run: async () => { calls += 1; throw new Error("runner crashed"); } }, nonceFactory: () => `d-${++nonceOrdinal}`, eventIdFactory: () => `d-event-${++nonceOrdinal}`, clock: () => "2026-09-06T07:00:05.000Z" });
      expect(result.kind).toBe("VALIDATION_INFRASTRUCTURE_EXHAUSTED");
      expect(calls).toBe(1);
      const events = (await value.store.inspect()).events;
      expect(events.filter((candidate) => candidate.eventType === "validation.started")).toHaveLength(1);
      expect(events.filter((candidate) => candidate.eventType === "validation.completed")).toHaveLength(1);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });
});

async function seedMajor4NpmProject(root: string): Promise<void> {
  const packageJson = {
    name: "major-4-validation-projection",
    version: "1.0.0",
    private: true,
    packageManager: "npm@10.8.2",
    scripts: {
      build: "node -e \"const f=require('node:fs');f.mkdirSync('dist',{recursive:true});f.writeFileSync('dist/index.js','validation-dist\\n')\"",
      tsbuild: "node -e \"require('node:fs').writeFileSync('.tsbuildinfo','validation-tsbuild\\n')\"",
      test: "node -e \"const f=require('node:fs');f.mkdirSync('coverage',{recursive:true});f.writeFileSync('coverage/coverage.json','{}\\n')\"",
      tool: "node -e \"const f=require('node:fs');for(const d of ['.vite','.cache']){f.mkdirSync(d,{recursive:true});f.writeFileSync(d+'/cache.bin','cache\\n')}\"",
    },
  };
  await writeFile(join(root, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  await writeFile(join(root, "package-lock.json"), `${JSON.stringify({
    name: packageJson.name,
    version: packageJson.version,
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name: packageJson.name, version: packageJson.version } },
  }, null, 2)}\n`);
}

async function runDirectValidationCommand(
  candidateRoot: string,
  command: string,
  options: { readonly supervisor?: ValidationProcessSupervisorV2; readonly signal?: AbortSignal },
) {
  const binding = {
    runId: "direct-validation-run",
    phaseId: "direct-validation-phase",
    taskId: "direct-validation-task",
    attemptId: `direct-validation-attempt-${++nonceOrdinal}`,
    invocationId: `direct-validation-invocation-${nonceOrdinal}`,
  } as const;
  const spec = {
    validationSpecId: `direct-validation-spec-${nonceOrdinal}`,
    ordinal: 1,
    kind: "COMMAND" as const,
    instruction: command,
    digest: sha256Canonical({ command, ordinal: nonceOrdinal }),
    sourceTaskId: binding.taskId,
    sourcePlanIdentity: "direct-validation-plan",
  };
  const fingerprint = await fingerprintWorkspace(candidateRoot);
  const manifest = createWorkspaceManifestV2(binding, fingerprint);
  const projection = await createValidationProjectionV1({
    canonicalCandidateRoot: candidateRoot,
    boundaryManifest: manifest,
    evidenceCaptureId: `direct-validation-evidence-${nonceOrdinal}`,
    evidenceDigest: sha256Canonical({ evidence: nonceOrdinal }),
    validationSpecs: [spec],
  });
  const validationBinding = {
    runId: binding.runId,
    phaseId: binding.phaseId,
    taskId: binding.taskId,
    attemptId: binding.attemptId,
    validationSpecId: spec.validationSpecId,
    validationRunId: `direct-validation-result-${nonceOrdinal}`,
  };
  try {
    return await runValidationCommandV2({
      command,
      cwd: projection.authority.projectionRoot,
      expectedProjectRoot: projection.authority.projectionRoot,
      signal: options.signal,
      supervisor: options.supervisor,
      validationBinding,
      validationProjection: bindValidationProjectionRunV1(projection.authority, { ...validationBinding, validationSpecDigest: spec.digest }),
    });
  } finally { await projection.cleanup(); }
}
