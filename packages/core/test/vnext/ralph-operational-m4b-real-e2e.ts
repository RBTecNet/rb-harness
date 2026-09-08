import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutionDocument, Phase, Task } from "../../src/types.js";
import type { RuntimeEntityRef } from "../../src/vnext/ralph-runtime/contracts.js";
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
  RalphEventStoreV2,
  commitRalphEventV2,
  createRetryPolicyV1,
  initializeOperationalRunV2,
  retryPolicyDescriptorV1,
  type RunSnapshotV2,
} from "../../src/vnext/ralph-runtime/operational-b1/index.js";
import {
  acquireLeasedRunV2,
  defaultProcessIdentityProvider,
  type LeaseRuntimeInputV2,
} from "../../src/vnext/ralph-runtime/operational-b2/index.js";
import { prepareNextAuthorizedInvocationV2 } from "../../src/vnext/ralph-runtime/operational-b3/index.js";
import {
  createM4BTimeoutPolicyV2,
  createOpenCodeCliExecutorV2,
  executeAuthorizedInvocationV2,
  readProviderInvocationArtifactSetV2,
} from "../../src/vnext/ralph-runtime/operational-b4/index.js";
import { readOpenCodeProviderResultV2 } from "../../src/vnext/ralph-runtime/operational-b4/opencode-cli-result.js";
import { captureEvidenceV2 } from "../../src/vnext/ralph-runtime/operational-c/index.js";
import { validateAttemptV2 } from "../../src/vnext/ralph-runtime/operational-d/index.js";
import { ScriptedAuditor, auditAttemptV2 } from "../../src/vnext/ralph-runtime/operational-e/index.js";
import { createWorkspacePolicy, fingerprintWorkspace } from "../../src/vnext/ralph-runtime/fingerprint.js";
import { sha256, sha256Canonical } from "../../src/vnext/ralph-runtime/hashing.js";

const PROFILE = "opencode:cli:opencode-go/deepseek-v4-pro";
const MODEL = "opencode-go/deepseek-v4-pro";
const EXECUTION_TIMEOUT_MS = 180_000;

if (process.env.RB_RALPH_M4B_REAL_E2E !== "1") {
  throw new Error("M4-B real E2E is opt-in; set RB_RALPH_M4B_REAL_E2E=1 explicitly");
}

function descriptor(schemaVersion: string, descriptorId: string, descriptorDigest?: string) {
  const base = { schemaVersion, descriptorId };
  return { ...base, descriptorDigest: descriptorDigest ?? sha256Canonical(base) };
}

function task(): Task {
  return {
    id: "T001",
    title: "Create deterministic ready status module",
    done: false,
    scope: "src/status.js",
    change: "Create src/status.js exporting exactly: module.exports = \"ready\";",
    covers: "src/status.js",
    dependsOn: [],
    parallelSafe: false,
    acceptanceCriteria: ["Requiring ./src/status.js returns exactly the string ready"],
    validation: ["`node -e 'const s=require(\"./src/status.js\"); if (s !== \"ready\") process.exit(1)'`"],
    expectedEvidence: "A real workspace delta creating only src/status.js with the required CommonJS export",
    line: 1,
  };
}

function plan(): ExecutionDocument {
  const phase: Phase = {
    number: 1,
    id: "P01",
    title: "Real OpenCode Executor",
    goal: "Prove the first real model-bearing Executor through the frozen Ralph Core",
    dependsOn: [],
    context: ["sacrificial project; no user code or secrets"],
    tasks: [task()],
    line: 1,
  };
  return { contract: "rb-execution/v1", artifactId: "plan-m4b-real", title: "M4-B real Executor E2E", phases: [phase] };
}

function genesis(document: ExecutionDocument, runId: string): RalphRuntimeStateV2 {
  return createInitialRuntimeStateV2({
    runId,
    maxTaskAttemptsPerTask: 1,
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
  const entity: RuntimeEntityRef = kind === "run" ? { kind, id: state.runId }
    : kind === "workspace" ? { kind, id: `${state.runId}:workspace` }
      : kind === "task" ? { kind, id: context.taskId ?? "T001" }
        : { kind: "attempt", id: context.attemptId ?? "attempt-m4b-real" };
  const now = new Date().toISOString();
  return createRalphEventV2({
    eventId: `m4b-real-${randomUUID()}`,
    eventType,
    schemaVersion: EVENT_SCHEMA_V2,
    runId: state.runId,
    sequence: state.lastSequence + 1,
    occurredAt: now,
    recordedAt: now,
    entity,
    ...(context.phaseId === undefined ? {} : { phaseId: context.phaseId }),
    ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
    ...(context.attemptId === undefined ? {} : { attemptId: context.attemptId }),
    actor: "CORE",
    causationId: null,
    correlationId: `${state.runId}:m4b-real`,
    payload,
    previousEventHash: state.lastEventHash,
  } as UnsignedRalphEventV2<TType>) as RalphEventV2;
}

async function append(store: RalphEventStoreV2, state: RalphRuntimeStateV2, next: RalphEventV2): Promise<RalphRuntimeStateV2> {
  return (await commitRalphEventV2({ store, state, event: next, writtenAt: new Date().toISOString(), nonce: randomUUID() })).state;
}

describe("Ralph M4-B — opt-in real sacrificial OpenCode CLI Executor", () => {
  it("drives one exact provider invocation through Evidence, COMMAND Validation and ScriptedAudit", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-m4b-real-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "README.md"), "# Disposable Ralph M4-B executor fixture\n");
    const document = plan();
    const runId = `run-m4b-real-${randomUUID()}`;
    const attemptId = `attempt-m4b-real-${randomUUID()}`;
    const timeoutPolicy = createM4BTimeoutPolicyV2(EXECUTION_TIMEOUT_MS);
    const retryPolicy = createRetryPolicyV1({ runId, policyId: "m4b-real-no-retry", maxTaskAttemptsPerTask: 1, validationInfrastructureRetryLimit: 0 });
    const workspacePolicy = createWorkspacePolicy({ scopePaths: ["src/status.js"], coversPaths: ["src/status.js"] });
    const initialFingerprint = await fingerprintWorkspace(root, workspacePolicy);
    const config = descriptor("rb-ralph-config/v2", "m4b-real-config");
    const profileDigest = sha256Canonical({ profileId: PROFILE, model: MODEL, transport: "opencode-cli", transportVersion: "1.18.29" });
    const snapshot: RunSnapshotV2 = {
      snapshotSchemaVersion: RALPH_RUN_SNAPSHOT_V2_SCHEMA,
      runId,
      eventSchema: EVENT_SCHEMA_V2,
      stateSchema: STATE_SCHEMA_V2,
      operationalContract: OPERATIONAL_CONTRACT_V2,
      projectIdentity: { projectId: "m4b-real-sacrificial-project" },
      readyPlanIdentity: document.artifactId,
      readyPlanHash: sha256Canonical(document),
      readyManifestHash: sha256("m4b-real-ready-manifest"),
      selectedReadyArtifactHashes: { plan: sha256Canonical(document) },
      readinessInspectionDigest: sha256("m4b-real-readiness"),
      effectiveRunConfig: config,
      effectiveConfigDigest: config.descriptorDigest,
      diagnosticsPolicy: descriptor("rb-ralph-diagnostics/v2", "m4b-real-diagnostics"),
      environmentPolicy: descriptor("rb-ralph-environment/v2", "m4b-real-environment-allowlisted-pure"),
      executorProfile: { profileId: PROFILE, kind: "scripted", descriptorDigest: profileDigest },
      executorCapabilities: { requested: ["workspace.write"], granted: ["workspace.write"], verified: ["workspace.write"], readOnlyEnforced: false },
      permissionCapabilityPolicy: descriptor("rb-ralph-capabilities/v2", "m4b-real-project-root-only"),
      workspacePolicy,
      initialWorkspaceFingerprint: {
        controlPlaneFingerprint: initialFingerprint.controlPlaneFingerprint,
        productWorkspaceFingerprint: initialFingerprint.productWorkspaceFingerprint,
        policyDigest: initialFingerprint.policyDigest,
        fingerprintDigest: initialFingerprint.fingerprintDigest,
      },
      retryPolicies: retryPolicyDescriptorV1(retryPolicy),
      timeoutPolicy: descriptor("rb-ralph-timeout/v2", "m4b-real-timeout", timeoutPolicy.policyDigest),
      runtimeIdentity: descriptor("rb-ralph-runtime/v2", "m4b-real-runtime"),
      leasePolicy: descriptor("rb-ralph-lease/v2", "m4b-real-lease"),
      createdAt: new Date().toISOString(),
    };
    const store = new RalphEventStoreV2({ projectRoot: root, runId });
    const initial = genesis(document, runId);
    const initialized = await initializeOperationalRunV2({
      store,
      snapshot,
      retryPolicy,
      genesisState: initial,
      runCreatedEvent: event(initial, "run.created", { phaseIds: initial.phaseIds, taskIds: initial.taskIds }),
      createdAt: new Date().toISOString(),
      nonce: randomUUID(),
    });
    let state = await append(store, initialized.state, event(initialized.state, "run.started", {}));
    state = await append(store, state, event(state, "task.state-changed", {
      disposition: "READY", activity: "IDLE", owner: "NONE", hold: "NONE",
    }, { phaseId: "P01", taskId: "T001" }));

    const leaseInput: LeaseRuntimeInputV2 = { projectRoot: root, runId, genesisState: initial, processIdentityProvider: defaultProcessIdentityProvider };
    const admissionLease = await acquireLeasedRunV2(leaseInput);
    const admitted = await prepareNextAuthorizedInvocationV2({
      leasedRun: admissionLease,
      plan: document,
      planIdentity: document.artifactId,
      planDigest: sha256Canonical(document),
      attemptIdFactory: () => attemptId,
    });
    expect(admitted.kind).toBe("AUTHORIZED_NOT_INVOKED");
    if (admitted.kind !== "AUTHORIZED_NOT_INVOKED") throw new Error(`real M4-B admission failed: ${admitted.kind}`);

    const executorLease = await acquireLeasedRunV2(leaseInput);
    const executor = await createOpenCodeCliExecutorV2({ store, authorizedInvocation: admitted.authorizedInvocation, timeoutPolicy });
    const executed = await executeAuthorizedInvocationV2({
      leasedRun: executorLease,
      plan: document,
      planIdentity: document.artifactId,
      planDigest: sha256Canonical(document),
      attemptId,
      runtime: executor,
    });
    expect(executed.kind).toBe("EXECUTOR_FINISHED_READY_FOR_CAPTURE");
    if (executed.kind !== "EXECUTOR_FINISHED_READY_FOR_CAPTURE") throw new Error(`real M4-B execution failed closed: ${executed.kind}`);

    const artifacts = await readProviderInvocationArtifactSetV2(store, attemptId);
    const physicalResult = await readOpenCodeProviderResultV2(store, attemptId);
    expect(artifacts.descriptor).toMatchObject({ executorProfileIdentity: PROFILE, modelSelector: MODEL, conformanceState: "MATCH" });
    expect(artifacts.sessionBinding?.openCodeSessionId).toMatch(/^ses_/);
    expect(artifacts.terminal).toMatchObject({ status: "SUCCEEDED", termination: "NORMAL" });
    expect(physicalResult).toMatchObject({ classification: "SUCCEEDED", observedModelSelector: MODEL });
    expect(executed.observation.state).toBe("TERMINATED_QUIESCENT");
    expect(executed.resultArtifact).toMatchObject({ status: "SUCCEEDED", termination: "NORMAL" });

    const captured = await captureEvidenceV2({
      leasedRun: executorLease,
      plan: document,
      attemptId,
      observation: executed.observation,
    });
    expect(captured.kind).toBe("EVIDENCE_CAPTURED_READY_FOR_VALIDATION");
    if (captured.kind !== "EVIDENCE_CAPTURED_READY_FOR_VALIDATION") throw new Error(`real M4-B Evidence failed: ${captured.kind}`);
    expect(captured.evidence.changedPaths).toContain("src/status.js");
    expect(captured.evidence.controlPlaneChangedPaths).toEqual([]);
    expect(await readFile(join(root, "src/status.js"), "utf8")).toBe("module.exports = \"ready\";\n");

    const validationLease = await acquireLeasedRunV2(leaseInput);
    const validated = await validateAttemptV2({
      leasedRun: validationLease,
      plan: document,
      attemptId,
      executorObservation: executed.observation,
    });
    expect(validated.kind).toBe("VALIDATION_READY_FOR_AUDIT");
    if (validated.kind !== "VALIDATION_READY_FOR_AUDIT") throw new Error(`real M4-B Validation failed: ${validated.kind}`);
    expect(validated.validationSet.summary).toMatchObject({ passed: 1, failed: 0, hardNegative: false });

    const auditor = new ScriptedAuditor({ defaultDecision: { verdict: "ACCEPT", rationale: "deterministic validation and Evidence are green" } });
    const auditLease = await acquireLeasedRunV2(leaseInput);
    const audited = await auditAttemptV2({
      leasedRun: auditLease,
      plan: document,
      attemptId,
      executorObservation: executed.observation,
      auditor,
    });
    expect(audited.kind).toBe("AUDIT_ACCEPTED");
    expect(audited.attempt.closureReason).toBe("AUDIT_ACCEPTED");
    expect(audited.state.tasks.T001?.disposition).toBe("COMPLETE");
    expect(audited.state.disposition).toBe("COMPLETE");
    expect(auditor.totalInvocations).toBe(1);

    const providerDirectory = join(store.runDirectory, "attempts", attemptId);
    const persistedFiles = await readdir(providerDirectory);
    const persistedText = (await Promise.all(persistedFiles.filter((file) => file.endsWith(".json")).map((file) => readFile(join(providerDirectory, file), "utf8")))).join("\n");
    expect(persistedText).not.toMatch(/Bearer\s+\S+|-----BEGIN[^-]*PRIVATE KEY-----|(?:api[_-]?key|password|secret)\s*[:=]/i);

    const inspected = await store.inspect();
    const executorFinished = inspected.events.findIndex((candidate) => candidate.eventType === "executor.finished");
    const validationCompleted = inspected.events.findIndex((candidate) => candidate.eventType === "validation.completed");
    const auditStarted = inspected.events.findIndex((candidate) => candidate.eventType === "audit.started");
    const auditAccepted = inspected.events.findIndex((candidate) => candidate.eventType === "attempt.closed" && candidate.payload.closureReason === "AUDIT_ACCEPTED");
    const runCompleted = inspected.events.findIndex((candidate) => candidate.eventType === "run.completed");
    expect(executorFinished).toBeGreaterThan(-1);
    expect(validationCompleted).toBeGreaterThan(executorFinished);
    expect(auditStarted).toBeGreaterThan(validationCompleted);
    expect(auditAccepted).toBeGreaterThan(auditStarted);
    expect(runCompleted).toBeGreaterThan(auditAccepted);

    console.log(JSON.stringify({
      projectRoot: root,
      runId,
      attemptId,
      coreInvocationId: admitted.authorizedInvocation.descriptor.invocationId,
      openCodeSessionId: artifacts.sessionBinding?.openCodeSessionId,
      profile: PROFILE,
      model: MODEL,
      modelBearingInvocations: 1,
      changedPaths: captured.evidence.changedPaths,
      evidence: captured.kind,
      validation: validated.validationSet.summary,
      audit: audited.kind,
      attemptClosure: audited.attempt.closureReason,
      taskState: audited.state.tasks.T001?.disposition,
      runState: audited.state.disposition,
      fallback: false,
      retry: false,
      credentialLeakage: false,
    }));
  });
});
