import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  validationSpecsForTask,
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
  releaseLeasedRunV2,
  type LeaseRuntimeInputV2,
} from "../../src/vnext/ralph-runtime/operational-b2/index.js";
import { prepareNextAuthorizedInvocationV2, readWorkUnitV2 } from "../../src/vnext/ralph-runtime/operational-b3/index.js";
import {
  ScriptedExecutor,
  authoritativeOpenFindingsForTaskV2,
  buildExactCorrectionContextV2,
  createM4BTimeoutPolicyV2,
  createOpenCodeCliExecutorV2,
  deriveDurableCorrectionAuthorityV2,
  executeAuthorizedInvocationV2,
  projectWorkUnitToOpenCodePromptV2,
  readProviderInvocationArtifactSetV2,
  validateExactCorrectionContextForDispatchV2,
} from "../../src/vnext/ralph-runtime/operational-b4/index.js";
import { readOpenCodePromptArtifactV2, readOpenCodeProviderResultV2 } from "../../src/vnext/ralph-runtime/operational-b4/opencode-cli-result.js";
import { captureEvidenceV2 } from "../../src/vnext/ralph-runtime/operational-c/index.js";
import { readAuditPackageV2, runValidationCommandV2, validateAttemptV2 } from "../../src/vnext/ralph-runtime/operational-d/index.js";
import { auditAttemptV2, readAuditResultV2 } from "../../src/vnext/ralph-runtime/operational-e/index.js";
import {
  createAuditTimeoutPolicyV2,
  createOpenCodeCliAuditorV2,
  projectAuditPackageToOpenCodePromptV2,
  readAuditProviderArtifactSetV2,
  readAuditProviderResultV2,
  readAuditProviderSessionBindingV2,
  readAuditProviderTerminalArtifactV2,
} from "../../src/vnext/ralph-runtime/operational-m4d/index.js";
import { persistCorrectionContextV2, readCorrectionContextV2 } from "../../src/vnext/ralph-runtime/operational-f/index.js";
import { createWorkspacePolicy, fingerprintWorkspace } from "../../src/vnext/ralph-runtime/fingerprint.js";
import { sha256, sha256Canonical } from "../../src/vnext/ralph-runtime/hashing.js";

/**
 * M4-D shipped acceptance harness.
 *
 * The new property proved here is a REAL model-bearing Auditor. Exactly three
 * model-bearing calls are authorized:
 *
 *   Auditor 1  real OpenCodeCliAuditorV2 on Attempt 1. Attempt 1 was written
 *              by a genuine ScriptedExecutor so the defect is deterministic and
 *              — critically — invisible to COMMAND validation: the module
 *              exists and loads, so Validation is green and hardNegative is
 *              false. Only a semantic repository inspection can reject it.
 *   Executor   real OpenCodeCliExecutorV2 correction on Attempt 2, driven by
 *              the Core Finding the real Auditor caused.
 *   Auditor 2  real OpenCodeCliAuditorV2 on Attempt 2, in a new session, which
 *              must ACCEPT and explicitly resolve that Finding.
 *
 * Nothing here forces a verdict. If the real Auditor accepts the defective
 * Attempt 1, or omits the open Finding on Attempt 2, this harness fails and is
 * not retried.
 */

const PROFILE = "opencode:cli:opencode-go/deepseek-v4-pro";
const MODEL = "opencode-go/deepseek-v4-pro";
const STATUS_PATH = "src/status.js";
const PLAN_IDENTITY = "plan-m4d-real";
const TASK_ID = "T001";
const EXECUTION_TIMEOUT_MS = 300_000;
const AUDIT_TIMEOUT_MS = 420_000;

if (process.env.RB_RALPH_M4D_REAL_E2E !== "1") {
  throw new Error("M4-D real E2E is opt-in; set RB_RALPH_M4D_REAL_E2E=1 explicitly");
}

/**
 * Three independent acceptance criteria. COMMAND validation can only prove the
 * first two; the third is the semantic criterion the real Auditor must judge.
 */
const ACCEPTANCE_CRITERIA = [
  `${STATUS_PATH} exists in the project`,
  `${STATUS_PATH} is a CommonJS module that loads without a syntax or runtime error`,
  `${STATUS_PATH} sets module.exports to exactly the string "ready" and to nothing else`,
] as const;

const VALIDATION_INSTRUCTIONS = [
  "`node -e \"require('node:fs').accessSync('src/status.js')\"`",
  "`node -e \"require('./src/status.js')\"`",
] as const;

const VALIDATION_SPECS = validationSpecsForTask({ id: TASK_ID, validation: [...VALIDATION_INSTRUCTIONS] }, PLAN_IDENTITY);

function validatorDigestOf(specs: readonly { validationSpecId: string; instruction: string; digest: string }[]): string {
  return sha256Canonical(specs.map((spec) => ({ id: spec.validationSpecId, instruction: spec.instruction, digest: spec.digest })));
}
const VALIDATOR_DIGEST = validatorDigestOf(VALIDATION_SPECS);

/** The deterministic semantic defect the ScriptedExecutor physically writes. */
const DEFECTIVE_STATUS = 'module.exports = "broken";\n';
/** Self-check reference only; destroyed before the run workspace exists. */
const REFERENCE_STATUS = 'module.exports = "ready";\n';

function descriptorRef(schemaVersion: string, descriptorId: string, descriptorDigest?: string) {
  const base = { schemaVersion, descriptorId };
  return { ...base, descriptorDigest: descriptorDigest ?? sha256Canonical(base) };
}

function task(): Task {
  return {
    id: TASK_ID,
    title: "Create the disposable status module",
    done: false,
    scope: STATUS_PATH,
    change: `Create ${STATUS_PATH} so that it sets module.exports to exactly the string "ready".`,
    covers: STATUS_PATH,
    dependsOn: [],
    parallelSafe: false,
    acceptanceCriteria: [...ACCEPTANCE_CRITERIA],
    validation: [...VALIDATION_INSTRUCTIONS],
    expectedEvidence: `A real workspace delta creating only ${STATUS_PATH}`,
    line: 1,
  };
}

function plan(): ExecutionDocument {
  const phase: Phase = {
    number: 1, id: "P01", title: "Real OpenCode Auditor",
    goal: "Prove one real semantic Auditor rejection and one real Auditor acceptance",
    dependsOn: [], context: ["sacrificial project; no user code or secrets"], tasks: [task()], line: 1,
  };
  return { contract: "rb-execution/v1", artifactId: PLAN_IDENTITY, title: "M4-D real Auditor E2E", phases: [phase] };
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
      : kind === "task" ? { kind, id: context.taskId ?? TASK_ID }
        : { kind: "attempt", id: context.attemptId ?? "attempt-m4d-real" };
  const now = new Date().toISOString();
  return createRalphEventV2({
    eventId: `m4d-real-${randomUUID()}`, eventType, schemaVersion: EVENT_SCHEMA_V2, runId: state.runId,
    sequence: state.lastSequence + 1, occurredAt: now, recordedAt: now, entity,
    ...(context.phaseId === undefined ? {} : { phaseId: context.phaseId }),
    ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
    ...(context.attemptId === undefined ? {} : { attemptId: context.attemptId }),
    actor: "CORE", causationId: null, correlationId: `${state.runId}:m4d-real`, payload, previousEventHash: state.lastEventHash,
  } as UnsignedRalphEventV2<TType>) as RalphEventV2;
}

async function runValidator(cwd: string): Promise<readonly string[]> {
  const failed: string[] = [];
  for (const spec of VALIDATION_SPECS) {
    const result = await runValidationCommandV2({ command: spec.instruction, cwd, expectedProjectRoot: cwd });
    if (result.exitCode !== 0 || result.infrastructureStatus !== "NONE") failed.push(spec.validationSpecId);
  }
  return failed;
}

describe("Ralph M4-D — shipped opt-in acceptance: one real Auditor REJECT, one real correction, one real Auditor ACCEPT", () => {
  it("drives a semantic defect past green Validation into a real Auditor rejection, a real correction and a real Auditor acceptance", async () => {
    const report: Record<string, unknown> = {};

    // ── 0. VALIDATOR SELF-CHECK ──────────────────────────────────────────────
    // The point of this milestone is a defect COMMAND validation cannot see.
    // Prove that in a scratch directory destroyed before the run workspace exists.
    const selfCheckRoot = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-m4d-selfcheck-"));
    await mkdir(join(selfCheckRoot, "src"), { recursive: true });
    await writeFile(join(selfCheckRoot, STATUS_PATH), REFERENCE_STATUS);
    const referenceFailures = await runValidator(selfCheckRoot);
    await writeFile(join(selfCheckRoot, STATUS_PATH), DEFECTIVE_STATUS);
    const defectiveFailures = await runValidator(selfCheckRoot);
    await rm(selfCheckRoot, { recursive: true, force: true });

    expect(referenceFailures).toEqual([]);
    // The defect is invisible to the validator: this is the M4-D property.
    expect(defectiveFailures).toEqual([]);
    report.validatorSelfCheck = {
      criteria: ACCEPTANCE_CRITERIA.length,
      commandValidations: VALIDATION_SPECS.length,
      validatorDigest: VALIDATOR_DIGEST,
      referenceImplementationFailures: referenceFailures,
      defectiveImplementationFailures: defectiveFailures,
      defectVisibleToCommandValidation: false,
      referenceDestroyedBeforeExecution: true,
    };

    // ── 1. RUN BOOTSTRAP ─────────────────────────────────────────────────────
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-m4d-real-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "README.md"), "# Disposable Ralph M4-D auditor fixture\n");
    const document = plan();
    const runId = `run-m4d-real-${randomUUID()}`;
    const timeoutPolicy = createM4BTimeoutPolicyV2(EXECUTION_TIMEOUT_MS);
    const auditTimeoutPolicy = createAuditTimeoutPolicyV2(AUDIT_TIMEOUT_MS);
    expect(auditTimeoutPolicy.policyDigest).not.toBe(timeoutPolicy.policyDigest);
    const retryPolicy = createRetryPolicyV1({ runId, policyId: "m4d-real-two-attempts", maxTaskAttemptsPerTask: 2, validationInfrastructureRetryLimit: 0 });
    const workspacePolicy = createWorkspacePolicy({ scopePaths: [STATUS_PATH], coversPaths: [STATUS_PATH] });
    const initialFingerprint = await fingerprintWorkspace(root, workspacePolicy);
    const config = descriptorRef("rb-ralph-config/v2", "m4d-real-config");
    const profileDigest = sha256Canonical({ profileId: PROFILE, model: MODEL, transport: "opencode-cli", transportVersion: "1.18.29" });
    const snapshot: RunSnapshotV2 = {
      snapshotSchemaVersion: RALPH_RUN_SNAPSHOT_V2_SCHEMA, runId, eventSchema: EVENT_SCHEMA_V2, stateSchema: STATE_SCHEMA_V2,
      operationalContract: OPERATIONAL_CONTRACT_V2, projectIdentity: { projectId: "m4d-real-sacrificial-project" },
      readyPlanIdentity: document.artifactId, readyPlanHash: sha256Canonical(document), readyManifestHash: sha256("m4d-real-ready-manifest"),
      selectedReadyArtifactHashes: { plan: sha256Canonical(document) }, readinessInspectionDigest: sha256("m4d-real-readiness"),
      effectiveRunConfig: config, effectiveConfigDigest: config.descriptorDigest,
      diagnosticsPolicy: descriptorRef("rb-ralph-diagnostics/v2", "m4d-real-diagnostics"),
      environmentPolicy: descriptorRef("rb-ralph-environment/v2", "m4d-real-environment-allowlisted-pure"),
      executorProfile: { profileId: PROFILE, kind: "scripted", descriptorDigest: profileDigest },
      executorCapabilities: { requested: ["workspace.write"], granted: ["workspace.write"], verified: ["workspace.write"], readOnlyEnforced: false },
      permissionCapabilityPolicy: descriptorRef("rb-ralph-capabilities/v2", "m4d-real-project-root-only"),
      workspacePolicy,
      initialWorkspaceFingerprint: {
        controlPlaneFingerprint: initialFingerprint.controlPlaneFingerprint, productWorkspaceFingerprint: initialFingerprint.productWorkspaceFingerprint,
        policyDigest: initialFingerprint.policyDigest, fingerprintDigest: initialFingerprint.fingerprintDigest,
      },
      retryPolicies: retryPolicyDescriptorV1(retryPolicy),
      timeoutPolicy: descriptorRef("rb-ralph-timeout/v2", "m4d-real-timeout", timeoutPolicy.policyDigest),
      runtimeIdentity: descriptorRef("rb-ralph-runtime/v2", "m4d-real-runtime"), leasePolicy: descriptorRef("rb-ralph-lease/v2", "m4d-real-lease"),
      createdAt: new Date().toISOString(),
    };
    const bootstrapStore = new RalphEventStoreV2({ projectRoot: root, runId });
    const genesis = createInitialRuntimeStateV2({
      runId, maxTaskAttemptsPerTask: 2,
      phases: document.phases.map((phase) => ({ phaseId: phase.id, taskIds: phase.tasks.map((candidate) => candidate.id) })),
      tasks: document.phases.flatMap((phase) => phase.tasks.map((candidate) => ({ taskId: candidate.id, phaseId: phase.id, dependsOn: candidate.dependsOn }))),
    });
    const initialized = await initializeOperationalRunV2({
      store: bootstrapStore, snapshot, retryPolicy, genesisState: genesis,
      runCreatedEvent: event(genesis, "run.created", { phaseIds: genesis.phaseIds, taskIds: genesis.taskIds }),
      createdAt: new Date().toISOString(), nonce: randomUUID(),
    });
    let state = (await commitRalphEventV2({ store: bootstrapStore, state: initialized.state, event: event(initialized.state, "run.started", {}), writtenAt: new Date().toISOString(), nonce: randomUUID() })).state;
    await commitRalphEventV2({
      store: bootstrapStore, state,
      event: event(state, "task.state-changed", { disposition: "READY", activity: "IDLE", owner: "NONE", hold: "NONE" }, { phaseId: "P01", taskId: TASK_ID }),
      writtenAt: new Date().toISOString(), nonce: randomUUID(),
    });
    const lease: LeaseRuntimeInputV2 = { projectRoot: root, runId, genesisState: genesis, processIdentityProvider: defaultProcessIdentityProvider };
    Object.assign(report, { projectRoot: root, runId, profile: PROFILE, model: MODEL, openCodeVersion: "1.18.29", executionTimeoutMs: EXECUTION_TIMEOUT_MS, auditTimeoutMs: AUDIT_TIMEOUT_MS });

    // ── 2. ATTEMPT 1 — GENUINE SCRIPTED EXECUTOR, SEMANTIC DEFECT ────────────
    const attemptOneId = `attempt-m4d-real-1-${randomUUID()}`;
    const storeOne = new RalphEventStoreV2({ projectRoot: root, runId });
    const admissionOne = await prepareNextAuthorizedInvocationV2({
      leasedRun: await acquireLeasedRunV2({ ...lease, runtimeInstanceId: "m4d-real-admit-1" }),
      plan: document, planIdentity: document.artifactId, planDigest: sha256Canonical(document), attemptIdFactory: () => attemptOneId,
    });
    if (admissionOne.kind !== "AUTHORIZED_NOT_INVOKED") throw new Error(`M4-D real admission 1 failed: ${admissionOne.kind}`);
    const coreOne = admissionOne.authorizedInvocation.descriptor;

    const executorLeaseOne = await acquireLeasedRunV2({ ...lease, runtimeInstanceId: "m4d-real-exec-1" });
    const executedOne = await executeAuthorizedInvocationV2({
      leasedRun: executorLeaseOne, plan: document, planIdentity: document.artifactId, planDigest: sha256Canonical(document),
      attemptId: attemptOneId,
      runtime: new ScriptedExecutor({
        runtimeIdentity: "m4d-real-scripted-defect",
        defaultScenario: { kind: "SUCCESS", exitCode: 0, fixtureWorkspaceAction: async () => { await writeFile(join(root, STATUS_PATH), DEFECTIVE_STATUS); } },
      }),
    });
    if (executedOne.kind !== "EXECUTOR_FINISHED_READY_FOR_CAPTURE") throw new Error(`M4-D real execution 1 failed: ${executedOne.kind}`);
    expect(await readProviderInvocationArtifactSetV2(storeOne, attemptOneId)).toEqual({});

    const capturedOne = await captureEvidenceV2({ leasedRun: executorLeaseOne, plan: document, attemptId: attemptOneId, observation: executedOne.observation });
    if (capturedOne.kind !== "EVIDENCE_CAPTURED_READY_FOR_VALIDATION") throw new Error(`M4-D real evidence 1 failed: ${capturedOne.kind}`);
    expect(capturedOne.evidence.controlPlaneChangedPaths).toEqual([]);
    expect(capturedOne.evidence.changedPaths).toEqual([STATUS_PATH]);
    expect(await readFile(join(root, STATUS_PATH), "utf8")).toBe(DEFECTIVE_STATUS);

    const validatedOne = await validateAttemptV2({
      leasedRun: await acquireLeasedRunV2({ ...lease, runtimeInstanceId: "m4d-real-validate-1" }),
      plan: document, attemptId: attemptOneId, executorObservation: executedOne.observation,
    });
    if (validatedOne.kind !== "VALIDATION_READY_FOR_AUDIT") throw new Error(`M4-D real validation 1 failed: ${validatedOne.kind}`);
    const failedOne = validatedOne.attempt.validationRuns.filter((run) => run.outcome === "FAIL").map((run) => run.validationSpecId);

    // The acceptance property: Evidence is valid, Validation is GREEN, and the
    // Attempt is nevertheless semantically wrong.
    expect(failedOne).toEqual([]);
    expect(validatedOne.validationSet.summary.hardNegative).toBe(false);
    expect(validatedOne.validationSet.summary.failed).toBe(0);
    const durableWorkUnitOne = await readWorkUnitV2(new RalphEventStoreV2({ projectRoot: root, runId }), attemptOneId);
    expect(validatorDigestOf(durableWorkUnitOne!.validationSpecRefs)).toBe(VALIDATOR_DIGEST);

    report.attempt1 = {
      attemptId: attemptOneId, invocationId: coreOne.invocationId, executorRuntime: "ScriptedExecutor",
      modelBearingInvocations: 0, providerInvocationDescriptors: 0, openCodeSessions: 0,
      workspace: DEFECTIVE_STATUS, changedPaths: capturedOne.evidence.changedPaths,
      controlPlaneChangedPaths: capturedOne.evidence.controlPlaneChangedPaths,
      evidenceCaptureId: validatedOne.validationSet.evidenceCaptureId, evidenceDigest: capturedOne.evidence.evidenceDigest,
      validation: validatedOne.validationSet.summary, failedSpecIds: failedOne,
      validatorDigest: validatorDigestOf(durableWorkUnitOne!.validationSpecRefs),
    };

    // ── 3. REAL AUDIT 1 — EXACTLY ONE MODEL-BEARING CALL ────────────────────
    const auditPackageOne = await readAuditPackageV2(new RalphEventStoreV2({ projectRoot: root, runId }), attemptOneId);
    const auditOnePrompt = projectAuditPackageToOpenCodePromptV2(auditPackageOne!);
    const beforeAuditOne = await fingerprintWorkspace(root, workspacePolicy);
    const auditorOne = await createOpenCodeCliAuditorV2({
      store: new RalphEventStoreV2({ projectRoot: root, runId }), timeoutPolicy: auditTimeoutPolicy,
    });
    const auditedOne = await auditAttemptV2({
      leasedRun: await acquireLeasedRunV2({ ...lease, runtimeInstanceId: "m4d-real-audit-1" }),
      plan: document, attemptId: attemptOneId, executorObservation: executedOne.observation, auditor: auditorOne,
    });
    const afterAuditOne = await fingerprintWorkspace(root, workspacePolicy);
    expect(afterAuditOne.fingerprintDigest).toBe(beforeAuditOne.fingerprintDigest);
    expect(afterAuditOne.controlPlaneFingerprint).toBe(beforeAuditOne.controlPlaneFingerprint);
    expect(afterAuditOne.productWorkspaceFingerprint).toBe(beforeAuditOne.productWorkspaceFingerprint);
    expect(await readFile(join(root, STATUS_PATH), "utf8")).toBe(DEFECTIVE_STATUS);
    expect(auditorOne.physicalDispatches).toBe(1);

    // The real Auditor must have rejected on the semantic criterion alone.
    expect(auditedOne.kind).toBe("AUDIT_REJECTED");
    if (auditedOne.kind !== "AUDIT_REJECTED") throw new Error(`M4-D real Audit 1 did not reject: ${auditedOne.kind}`);
    expect(auditedOne.auditResult.verdict).toBe("REJECT");
    expect(auditedOne.auditResult.proposedFindings.length).toBeGreaterThan(0);
    expect(auditedOne.attempt.closureReason).toBe("AUDIT_REJECTED");
    expect(auditedOne.state.tasks[TASK_ID]?.disposition).not.toBe("COMPLETE");

    const openFindings = Object.values(auditedOne.state.findings).filter((finding) => finding.status === "OPEN");
    expect(openFindings).toHaveLength(1);
    const finding = openFindings[0]!;
    expect(finding.id).toMatch(/^finding-[0-9a-f]{64}$/);

    const storeAfterAuditOne = new RalphEventStoreV2({ projectRoot: root, runId });
    const auditOneFacts = await readAuditProviderArtifactSetV2(storeAfterAuditOne, attemptOneId);
    const auditOneProviderResult = await readAuditProviderResultV2(storeAfterAuditOne, attemptOneId);
    expect(auditOneFacts.terminal?.quiescence).toMatchObject({ workerProcessState: "ABSENT", processTreeState: "QUIESCENT" });
    expect(auditOneFacts.terminal?.workspaceFingerprintBefore).toBe(auditOneFacts.terminal?.workspaceFingerprintAfter);
    expect(auditOneFacts.descriptor?.auditInvocationId).toBe(auditedOne.auditInvocation.auditInvocationId);

    report.audit1 = {
      auditInvocationId: auditedOne.auditInvocation.auditInvocationId,
      auditorRuntimeIdentity: auditorOne.runtimeIdentity,
      auditorCoreProfileId: auditorOne.profileId,
      auditorProfileIdentity: auditOneFacts.descriptor?.auditorProfileIdentity,
      openCodeSessionId: auditOneFacts.sessionBinding?.openCodeSessionId,
      openCodeUserMessageId: auditOneFacts.dispatchIntent?.openCodeUserMessageId,
      assistantMessageId: auditOneProviderResult?.assistantMessageId,
      observedModel: auditOneProviderResult?.observedModelSelector,
      promptDigest: auditOneFacts.prompt?.promptDigest,
      promptDigestReconstructedFromAuditPackage: auditOnePrompt.promptDigest,
      promptDigestsMatch: auditOneFacts.prompt?.promptDigest === auditOnePrompt.promptDigest,
      verdict: auditedOne.auditResult.verdict,
      rationale: auditedOne.auditResult.rationale,
      proposedFindings: auditedOne.auditResult.proposedFindings,
      resolvedFindingRefs: auditedOne.auditResult.resolvedFindingRefs,
      coreFindingId: finding.id,
      coreFindingDigest: sha256Canonical(finding),
      coreFindingCriterion: finding.criterionId,
      coreFindingSeverity: finding.severity,
      coreFindingObserved: finding.observed,
      providerSuppliedFindingId: false,
      attemptClosureReason: auditedOne.attempt.closureReason,
      workspaceFingerprintBefore: beforeAuditOne.fingerprintDigest,
      workspaceFingerprintAfter: afterAuditOne.fingerprintDigest,
      workspaceUnchanged: true,
      modelBearingInvocations: 1,
    };

    // ── 4. FRESH-PROCESS BOUNDARY ────────────────────────────────────────────
    const checkpointLease = await acquireLeasedRunV2({ ...lease, runtimeInstanceId: "m4d-real-checkpoint" });
    const observedAfterOne = await fingerprintWorkspace(root, workspacePolicy);
    await commitRalphEventV2({
      store: checkpointLease.store, state: checkpointLease.state,
      event: event(checkpointLease.state, "workspace.checkpointed", {
        checkpoint: {
          kind: "acceptedCheckpointFingerprint", fingerprintDigest: observedAfterOne.fingerprintDigest,
          emittedAt: new Date().toISOString(), attemptId: attemptOneId,
          evidenceSetId: validatedOne.validationSet.evidenceCaptureId,
        },
      }),
      writtenAt: new Date().toISOString(), nonce: randomUUID(),
    });
    await releaseLeasedRunV2(checkpointLease);

    const coldStore = new RalphEventStoreV2({ projectRoot: root, runId });
    const coldAuthority = await deriveDurableCorrectionAuthorityV2(coldStore);
    expect(coldAuthority.attempts.get(attemptOneId)?.closureReason).toBe("AUDIT_REJECTED");
    expect(coldAuthority.findings.get(finding.id)?.status).toBe("OPEN");
    expect(authoritativeOpenFindingsForTaskV2(coldAuthority, TASK_ID).map((item) => item.id)).toEqual([finding.id]);
    expect(await runValidator(root)).toEqual([]);
    expect(await readFile(join(root, STATUS_PATH), "utf8")).toBe(DEFECTIVE_STATUS);
    report.freshProcessBoundary = {
      discardedRuntimeObjects: ["store", "lease", "executor", "auditor", "observer"],
      attempt1ClosureReason: coldAuthority.attempts.get(attemptOneId)?.closureReason,
      attempt1FindingStatus: coldAuthority.findings.get(finding.id)?.status,
      openFindingIds: authoritativeOpenFindingsForTaskV2(coldAuthority, TASK_ID).map((item) => item.id),
      coldValidatorFailures: [], workspaceDefectStillPresent: true,
      duplicateAuditorDispatch: false, auditorDispatchesSoFar: 1,
    };

    // ── 5. ATTEMPT 2 — REAL OPENCODE EXECUTOR CORRECTION ────────────────────
    const attemptTwoId = `attempt-m4d-real-2-${randomUUID()}`;
    const storeTwo = new RalphEventStoreV2({ projectRoot: root, runId });
    const admissionTwo = await prepareNextAuthorizedInvocationV2({
      leasedRun: await acquireLeasedRunV2({ ...lease, runtimeInstanceId: "m4d-real-admit-2" }),
      plan: document, planIdentity: document.artifactId, planDigest: sha256Canonical(document), attemptIdFactory: () => attemptTwoId,
    });
    if (admissionTwo.kind !== "AUTHORIZED_NOT_INVOKED") throw new Error(`M4-D real admission 2 failed: ${admissionTwo.kind}`);
    const coreTwo = admissionTwo.authorizedInvocation.descriptor;

    const context = await buildExactCorrectionContextV2({
      store: storeTwo, runId: coreTwo.runId, phaseId: coreTwo.phaseId, taskId: coreTwo.taskId,
      attemptId: coreTwo.attemptId, baseWorkspaceFingerprint: coreTwo.attemptBaseFingerprint, createdAt: new Date().toISOString(),
    });
    if (!context) throw new Error("M4-D real correction context was not derivable from the durable Auditor Finding");
    await persistCorrectionContextV2(storeTwo, context, randomUUID());
    expect(await readCorrectionContextV2(storeTwo, attemptTwoId)).toEqual(context);
    expect(context.openFindingRefs).toEqual([finding.id]);
    expect(context.sourceRejectedAttempts.map((item) => item.attemptId)).toEqual([attemptOneId]);

    const projectedCorrection = projectWorkUnitToOpenCodePromptV2(admissionTwo.authorizedInvocation.workUnit, context);
    for (const token of ["CORRECTION ATTEMPT", finding.id, finding.criterionId, finding.observed, attemptOneId]) {
      expect(projectedCorrection.text).toContain(token);
    }

    const executorLeaseTwo = await acquireLeasedRunV2({ ...lease, runtimeInstanceId: "m4d-real-exec-2" });
    const executorTwo = await createOpenCodeCliExecutorV2({ store: storeTwo, authorizedInvocation: admissionTwo.authorizedInvocation, timeoutPolicy });
    const executedTwo = await executeAuthorizedInvocationV2({
      leasedRun: executorLeaseTwo, plan: document, planIdentity: document.artifactId, planDigest: sha256Canonical(document),
      attemptId: attemptTwoId, runtime: executorTwo,
    });
    if (executedTwo.kind !== "EXECUTOR_FINISHED_READY_FOR_CAPTURE") throw new Error(`M4-D real execution 2 failed: ${executedTwo.kind}`);
    const executorFactsTwo = await readProviderInvocationArtifactSetV2(storeTwo, attemptTwoId);
    const executorPromptTwo = await readOpenCodePromptArtifactV2(storeTwo, attemptTwoId);
    const executorResultTwo = await readOpenCodeProviderResultV2(storeTwo, attemptTwoId);
    expect(executorFactsTwo.descriptor).toMatchObject({ executorProfileIdentity: PROFILE, modelSelector: MODEL, conformanceState: "MATCH" });
    expect(await validateExactCorrectionContextForDispatchV2({ store: storeTwo, descriptor: executorFactsTwo.descriptor! })).toEqual(context);
    expect(executorResultTwo?.classification).toBe("SUCCEEDED");

    const capturedTwo = await captureEvidenceV2({ leasedRun: executorLeaseTwo, plan: document, attemptId: attemptTwoId, observation: executedTwo.observation });
    if (capturedTwo.kind !== "EVIDENCE_CAPTURED_READY_FOR_VALIDATION") throw new Error(`M4-D real evidence 2 failed: ${capturedTwo.kind}`);
    expect(capturedTwo.evidence.controlPlaneChangedPaths).toEqual([]);
    const attemptTwoWorkspace = await readFile(join(root, STATUS_PATH), "utf8");
    expect(attemptTwoWorkspace).not.toBe(DEFECTIVE_STATUS);

    const validatedTwo = await validateAttemptV2({
      leasedRun: await acquireLeasedRunV2({ ...lease, runtimeInstanceId: "m4d-real-validate-2" }),
      plan: document, attemptId: attemptTwoId, executorObservation: executedTwo.observation,
    });
    if (validatedTwo.kind !== "VALIDATION_READY_FOR_AUDIT") throw new Error(`M4-D real validation 2 failed: ${validatedTwo.kind}`);
    expect(validatedTwo.attempt.validationRuns.filter((run) => run.outcome === "FAIL")).toHaveLength(0);
    expect(validatedTwo.validationSet.evidenceCaptureId).not.toBe(validatedOne.validationSet.evidenceCaptureId);
    // The Finding stays OPEN until a real re-audit resolves it.
    expect((await deriveDurableCorrectionAuthorityV2(new RalphEventStoreV2({ projectRoot: root, runId }))).findings.get(finding.id)?.status).toBe("OPEN");

    report.correction = {
      attemptId: attemptTwoId, invocationId: coreTwo.invocationId, executorRuntime: "OpenCodeCliExecutorV2",
      openCodeSessionId: executorFactsTwo.sessionBinding?.openCodeSessionId,
      correctionContextId: context.contextId, correctionContextDigest: context.contextDigest,
      correctionFindingIds: context.openFindingRefs,
      dispatchedPromptDigest: executorPromptTwo?.promptDigest,
      independentlyReconstructedPromptDigest: projectedCorrection.promptDigest,
      promptDigestsMatch: executorPromptTwo?.promptDigest === projectedCorrection.promptDigest,
      workspaceBefore: DEFECTIVE_STATUS, workspaceAfter: attemptTwoWorkspace,
      changedPaths: capturedTwo.evidence.changedPaths, controlPlaneChangedPaths: capturedTwo.evidence.controlPlaneChangedPaths,
      evidenceCaptureId: validatedTwo.validationSet.evidenceCaptureId, evidenceDigest: capturedTwo.evidence.evidenceDigest,
      validation: validatedTwo.validationSet.summary,
      findingStatusAfterCorrection: "OPEN",
      modelBearingInvocations: 1,
    };

    // ── 6. REAL AUDIT 2 — ACCEPT AND RESOLUTION ─────────────────────────────
    const auditPackageTwo = await readAuditPackageV2(new RalphEventStoreV2({ projectRoot: root, runId }), attemptTwoId);
    expect(auditPackageTwo?.openFindingRefs.map((item) => item.findingId)).toEqual([finding.id]);
    const auditTwoPrompt = projectAuditPackageToOpenCodePromptV2(auditPackageTwo!);
    expect(auditTwoPrompt.text).toContain(finding.id);
    const beforeAuditTwo = await fingerprintWorkspace(root, workspacePolicy);
    const auditorTwo = await createOpenCodeCliAuditorV2({
      store: new RalphEventStoreV2({ projectRoot: root, runId }), timeoutPolicy: auditTimeoutPolicy,
    });
    const auditedTwo = await auditAttemptV2({
      leasedRun: await acquireLeasedRunV2({ ...lease, runtimeInstanceId: "m4d-real-audit-2" }),
      plan: document, attemptId: attemptTwoId, executorObservation: executedTwo.observation, auditor: auditorTwo,
    });
    const afterAuditTwo = await fingerprintWorkspace(root, workspacePolicy);
    expect(afterAuditTwo.fingerprintDigest).toBe(beforeAuditTwo.fingerprintDigest);
    expect(await readFile(join(root, STATUS_PATH), "utf8")).toBe(attemptTwoWorkspace);
    expect(auditorTwo.physicalDispatches).toBe(1);

    expect(auditedTwo.kind).toBe("AUDIT_ACCEPTED");
    if (auditedTwo.kind !== "AUDIT_ACCEPTED") throw new Error(`M4-D real Audit 2 did not accept: ${auditedTwo.kind}`);
    expect(auditedTwo.auditResult.verdict).toBe("ACCEPT");
    expect(auditedTwo.auditResult.resolvedFindingRefs).toEqual([finding.id]);
    expect(auditedTwo.state.findings[finding.id]?.status).toBe("RESOLVED");
    expect(auditedTwo.state.tasks[TASK_ID]?.disposition).toBe("COMPLETE");
    expect(auditedTwo.state.disposition).toBe("COMPLETE");

    const finalStore = new RalphEventStoreV2({ projectRoot: root, runId });
    const auditTwoFacts = await readAuditProviderArtifactSetV2(finalStore, attemptTwoId);
    const auditTwoProviderResult = await readAuditProviderResultV2(finalStore, attemptTwoId);
    const lifecycle = (await finalStore.inspect()).events.flatMap((candidate) =>
      candidate.eventType === "finding.state-changed" && candidate.payload.finding.id === finding.id ? [candidate.payload.finding.status] : []);
    expect(lifecycle).toEqual(["OPEN", "CANDIDATE_RESOLVED", "RESOLVED"]);

    // ── 7. INDEPENDENT ROLE AND SESSION ISOLATION ───────────────────────────
    const auditOneSession = (await readAuditProviderSessionBindingV2(finalStore, attemptOneId))!.openCodeSessionId;
    const auditTwoSession = auditTwoFacts.sessionBinding!.openCodeSessionId;
    const executorSession = executorFactsTwo.sessionBinding!.openCodeSessionId;
    expect(new Set([auditOneSession, auditTwoSession, executorSession]).size).toBe(3);
    expect(auditedTwo.auditInvocation.auditInvocationId).not.toBe(auditedOne.auditInvocation.auditInvocationId);
    expect(auditorOne.runtimeIdentity).toBe(auditorTwo.runtimeIdentity);
    expect(auditorOne.runtimeIdentity).not.toBe(executorFactsTwo.descriptor!.runtimeIdentity);

    report.audit2 = {
      auditInvocationId: auditedTwo.auditInvocation.auditInvocationId,
      auditorRuntimeIdentity: auditorTwo.runtimeIdentity,
      openCodeSessionId: auditTwoSession,
      openCodeUserMessageId: auditTwoFacts.dispatchIntent?.openCodeUserMessageId,
      assistantMessageId: auditTwoProviderResult?.assistantMessageId,
      observedModel: auditTwoProviderResult?.observedModelSelector,
      promptDigest: auditTwoFacts.prompt?.promptDigest,
      promptDigestReconstructedFromAuditPackage: auditTwoPrompt.promptDigest,
      promptDigestsMatch: auditTwoFacts.prompt?.promptDigest === auditTwoPrompt.promptDigest,
      verdict: auditedTwo.auditResult.verdict,
      rationale: auditedTwo.auditResult.rationale,
      resolvedFindingRefs: auditedTwo.auditResult.resolvedFindingRefs,
      findingLifecycle: lifecycle,
      attemptClosureReason: auditedTwo.attempt.closureReason,
      taskDisposition: auditedTwo.state.tasks[TASK_ID]?.disposition,
      runDisposition: auditedTwo.state.disposition,
      workspaceFingerprintBefore: beforeAuditTwo.fingerprintDigest,
      workspaceFingerprintAfter: afterAuditTwo.fingerprintDigest,
      workspaceUnchanged: true,
      modelBearingInvocations: 1,
    };
    report.independentRoleProof = {
      auditor1Session: auditOneSession, executorSession, auditor2Session: auditTwoSession,
      distinctSessions: 3, sessionReuse: false,
      auditor1InvocationId: auditedOne.auditInvocation.auditInvocationId,
      auditor2InvocationId: auditedTwo.auditInvocation.auditInvocationId,
      executorInvocationId: coreTwo.invocationId,
      auditorRuntimeIdentity: auditorOne.runtimeIdentity,
      executorRuntimeIdentity: executorFactsTwo.descriptor!.runtimeIdentity,
      identitiesDistinct: true,
      auditTimeoutPolicyDigest: auditTimeoutPolicy.policyDigest,
      executorTimeoutPolicyDigest: timeoutPolicy.policyDigest,
    };

    // ── 8. COLD REOPEN AND COMPLETED RERUN ──────────────────────────────────
    const reopened = new RalphEventStoreV2({ projectRoot: root, runId });
    const reopenedEvents = (await reopened.inspect()).events;
    const reopenedAuthority = await deriveDurableCorrectionAuthorityV2(reopened);
    expect(reopenedAuthority.attempts.get(attemptOneId)?.closureReason).toBe("AUDIT_REJECTED");
    expect(reopenedAuthority.attempts.get(attemptTwoId)?.closureReason).toBe("AUDIT_ACCEPTED");
    expect(reopenedAuthority.findings.get(finding.id)?.status).toBe("RESOLVED");
    expect(reopenedAuthority.findings.size).toBe(1);
    expect(reopenedEvents.filter((candidate) => candidate.eventType === "attempt.closed")).toHaveLength(2);
    expect(reopenedEvents.filter((candidate) => candidate.eventType === "audit.started")).toHaveLength(2);
    expect(reopenedEvents.filter((candidate) => candidate.eventType === "run.completed")).toHaveLength(1);
    expect(await readAuditResultV2(reopened, attemptOneId)).toBeDefined();
    expect(await readAuditResultV2(reopened, attemptTwoId)).toBeDefined();
    expect(await readAuditProviderTerminalArtifactV2(reopened, attemptOneId)).toBeDefined();
    expect(await readAuditProviderTerminalArtifactV2(reopened, attemptTwoId)).toBeDefined();
    expect(await readOpenCodeProviderResultV2(reopened, attemptOneId)).toBeUndefined();

    const rerun = await prepareNextAuthorizedInvocationV2({
      leasedRun: await acquireLeasedRunV2({ ...lease, runtimeInstanceId: "m4d-real-rerun" }),
      plan: document, planIdentity: document.artifactId, planDigest: sha256Canonical(document),
      attemptIdFactory: () => `attempt-m4d-real-rerun-${randomUUID()}`,
    });
    expect(rerun.kind).not.toBe("AUTHORIZED_NOT_INVOKED");
    const afterRerun = (await new RalphEventStoreV2({ projectRoot: root, runId }).inspect()).events;
    expect(afterRerun.filter((candidate) => candidate.eventType === "audit.started")).toHaveLength(2);
    expect(afterRerun.filter((candidate) => candidate.eventType === "attempt.closed")).toHaveLength(2);
    expect(afterRerun.filter((candidate) => candidate.eventType === "run.completed")).toHaveLength(1);

    for (const attemptId of [attemptOneId, attemptTwoId]) {
      const directory = join(reopened.runDirectory, "attempts", attemptId);
      const files = await readdir(directory);
      const text = (await Promise.all(files.filter((file) => file.endsWith(".json")).map((file) => readFile(join(directory, file), "utf8")))).join("\n");
      expect(text).not.toMatch(/Bearer\s+\S+|-----BEGIN[^-]*PRIVATE KEY-----|(?:api[_-]?key|password|secret)\s*[:=]/i);
    }

    report.coldReopen = {
      attempt1ClosureReason: "AUDIT_REJECTED", attempt2ClosureReason: "AUDIT_ACCEPTED",
      findingStatus: "RESOLVED", findingCount: reopenedAuthority.findings.size,
      taskDisposition: auditedTwo.state.tasks[TASK_ID]?.disposition, runDisposition: auditedTwo.state.disposition,
      auditStartedEvents: 2, attemptClosedEvents: 2, runCompletedEvents: 1,
      duplicateFinding: false, duplicateAuditDispatch: false,
    };
    report.completedRerun = { admission: rerun.kind, newModelBearingCalls: 0, newAttempts: 0, newAuditStarted: 0, newFindings: 0 };
    report.modelBearingCalls = { total: 3, auditor1: 1, executorCorrection: 1, auditor2: 1 };
    report.retriesAndFallbacks = { providerRetries: 0, transportRetries: 0, fallbacks: 0 };
    report.credentialLeakage = false;

    console.log(JSON.stringify(report, null, 2));
  }, 1_800_000);
});
