import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutionDocument, Phase, Task } from "../../src/types.js";
import type { Finding, RuntimeEntityRef } from "../../src/vnext/ralph-runtime/contracts.js";
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
  readInvocationResultV2,
  readProviderInvocationArtifactSetV2,
  validateExactCorrectionContextForDispatchV2,
} from "../../src/vnext/ralph-runtime/operational-b4/index.js";
import { readOpenCodePromptArtifactV2, readOpenCodeProviderResultV2 } from "../../src/vnext/ralph-runtime/operational-b4/opencode-cli-result.js";
import { captureEvidenceV2 } from "../../src/vnext/ralph-runtime/operational-c/index.js";
import { runValidationCommandV2, validateAttemptV2 } from "../../src/vnext/ralph-runtime/operational-d/index.js";
import { ScriptedAuditor, auditAttemptV2 } from "../../src/vnext/ralph-runtime/operational-e/index.js";
import { persistCorrectionContextV2, readCorrectionContextV2 } from "../../src/vnext/ralph-runtime/operational-f/index.js";
import { createWorkspacePolicy, fingerprintWorkspace } from "../../src/vnext/ralph-runtime/fingerprint.js";
import { sha256, sha256Canonical } from "../../src/vnext/ralph-runtime/hashing.js";

/**
 * M4-C shipped acceptance harness.
 *
 * The canonical acceptance composition is deterministic on the defect side and
 * real on the correction side:
 *
 *   Attempt 1 — genuine ScriptedExecutor writes a real, deterministic defect
 *               into the fixture workspace through its legitimate fixture
 *               action. No provider, no session, no model.
 *   Attempt 2 — genuine OpenCodeCliExecutorV2 performs exactly one real
 *               model-bearing invocation, driven only by the durable Core
 *               Finding that Attempt 1 produced.
 *
 * The earlier two-real-inference scenario was removed on purpose. It asked the
 * provider to make an accidental mistake on Attempt 1, so a provider that
 * implemented every criterion correctly failed the milestone. "The provider did
 * not make a mistake" is not "the M4-C correction path failed"; only a
 * deterministic defect can prove the correction path.
 *
 * This harness never edits the workspace itself: the defect is written by the
 * Executor, and the correction is written by the model.
 */

const PROFILE = "opencode:cli:opencode-go/deepseek-v4-pro";
const MODEL = "opencode-go/deepseek-v4-pro";
const COUNTER_PATH = "src/counter.js";
const PLAN_IDENTITY = "plan-m4c-real";
const TASK_ID = "T001";
const EXECUTION_TIMEOUT_MS = 300_000;

if (process.env.RB_RALPH_M4C_REAL_E2E !== "1") {
  throw new Error("M4-C real E2E is opt-in; set RB_RALPH_M4C_REAL_E2E=1 explicitly");
}

/**
 * Eight independent deterministic criteria. Criterion 8 is the correction
 * criterion: it is fully stated in the Task, and it is the only one a counter
 * whose reset() restores 0 can fail.
 */
const ACCEPTANCE_CRITERIA = [
  `${COUNTER_PATH} exports a function named createCounter`,
  "createCounter(n) returns a counter whose value() is exactly n",
  "createCounter() called with no argument returns a counter whose value() is exactly 0",
  "increment() increases the counter by exactly 1 and returns the new value",
  "decrement() decreases the counter by exactly 1 and returns the new value",
  "two counters created separately never share state",
  "reset() returns exactly the number value() reports immediately afterwards",
  "reset() restores the ORIGINAL initial value the counter was created with, never 0",
] as const;

const VALIDATION_INSTRUCTIONS = [
  "`node -e \"const m=require('./src/counter.js'); if (typeof m.createCounter !== 'function') process.exit(1)\"`",
  "`node -e \"const {createCounter}=require('./src/counter.js'); if (createCounter(7).value() !== 7) process.exit(1)\"`",
  "`node -e \"const {createCounter}=require('./src/counter.js'); if (createCounter().value() !== 0) process.exit(1)\"`",
  "`node -e \"const {createCounter}=require('./src/counter.js'); const c=createCounter(7); if (c.increment() !== 8 || c.value() !== 8) process.exit(1)\"`",
  "`node -e \"const {createCounter}=require('./src/counter.js'); const c=createCounter(7); if (c.decrement() !== 6 || c.value() !== 6) process.exit(1)\"`",
  "`node -e \"const {createCounter}=require('./src/counter.js'); const a=createCounter(7); const b=createCounter(7); a.increment(); if (a.value() !== 8 || b.value() !== 7) process.exit(1)\"`",
  "`node -e \"const {createCounter}=require('./src/counter.js'); const c=createCounter(7); c.increment(); const r=c.reset(); if (r !== c.value()) process.exit(1)\"`",
  "`node -e \"const {createCounter}=require('./src/counter.js'); const c=createCounter(7); c.increment(); c.increment(); c.reset(); if (c.value() !== 7) process.exit(1)\"`",
] as const;

/** The one criterion the deterministic Attempt 1 defect must fail. */
const RESET_SPEC_ID = `${TASK_ID}:validation:8`;

const VALIDATION_SPECS = validationSpecsForTask({ id: TASK_ID, validation: [...VALIDATION_INSTRUCTIONS] }, PLAN_IDENTITY);

/** Byte identity of the acceptance validator, independent of any Attempt. */
function validatorDigestOf(specs: readonly { validationSpecId: string; instruction: string; digest: string }[]): string {
  return sha256Canonical(specs.map((spec) => ({ id: spec.validationSpecId, instruction: spec.instruction, digest: spec.digest })));
}
const VALIDATOR_DIGEST = validatorDigestOf(VALIDATION_SPECS);

/**
 * The defect the ScriptedExecutor physically writes. reset() restores 0 rather
 * than the original initial value: a real, single-criterion semantic defect.
 */
const DEFECTIVE_COUNTER = `"use strict";

function createCounter(initial) {
  const start = typeof initial === "number" ? initial : 0;
  let current = start;
  return {
    value() { return current; },
    increment() { current += 1; return current; },
    decrement() { current -= 1; return current; },
    reset() { current = 0; return current; },
  };
}

module.exports = { createCounter };
`;

/**
 * Self-check reference only. It proves the validator can pass, and it is
 * destroyed with its scratch directory before any Executor runs. It never
 * exists inside the run workspace, so no model ever receives or modifies it.
 */
const REFERENCE_COUNTER = DEFECTIVE_COUNTER.replace("reset() { current = 0; return current; }", "reset() { current = start; return current; }");

function descriptorRef(schemaVersion: string, descriptorId: string, descriptorDigest?: string) {
  const base = { schemaVersion, descriptorId };
  return { ...base, descriptorDigest: descriptorDigest ?? sha256Canonical(base) };
}

function task(): Task {
  return {
    id: TASK_ID,
    title: "Create the disposable counter factory module",
    done: false,
    scope: COUNTER_PATH,
    change: `Create ${COUNTER_PATH} exporting a createCounter factory that satisfies every acceptance criterion.`,
    covers: COUNTER_PATH,
    dependsOn: [],
    parallelSafe: false,
    acceptanceCriteria: [...ACCEPTANCE_CRITERIA],
    validation: [...VALIDATION_INSTRUCTIONS],
    expectedEvidence: `A real workspace delta creating only ${COUNTER_PATH}`,
    line: 1,
  };
}

function plan(): ExecutionDocument {
  const phase: Phase = {
    number: 1, id: "P01", title: "Real OpenCode correction loop",
    goal: "Prove one real Finding-caused correction through the frozen Ralph Core",
    dependsOn: [], context: ["sacrificial project; no user code or secrets"], tasks: [task()], line: 1,
  };
  return { contract: "rb-execution/v1", artifactId: PLAN_IDENTITY, title: "M4-C real correction E2E", phases: [phase] };
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
        : { kind: "attempt", id: context.attemptId ?? "attempt-m4c-real" };
  const now = new Date().toISOString();
  return createRalphEventV2({
    eventId: `m4c-real-${randomUUID()}`, eventType, schemaVersion: EVENT_SCHEMA_V2, runId: state.runId,
    sequence: state.lastSequence + 1, occurredAt: now, recordedAt: now, entity,
    ...(context.phaseId === undefined ? {} : { phaseId: context.phaseId }),
    ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
    ...(context.attemptId === undefined ? {} : { attemptId: context.attemptId }),
    actor: "CORE", causationId: null, correlationId: `${state.runId}:m4c-real`, payload, previousEventHash: state.lastEventHash,
  } as UnsignedRalphEventV2<TType>) as RalphEventV2;
}

/** REJECT while real deterministic red exists; ACCEPT and resolve once it is gone. */
function auditorFor(facts: { readonly failedSpecIds: readonly string[]; readonly openFindings: readonly Finding[] }): ScriptedAuditor {
  return facts.failedSpecIds.length > 0
    ? new ScriptedAuditor({ defaultDecision: { verdict: "REJECT", proposedFindings: [], resolvedFindingRefs: [], rationale: "deterministic validation is red" } })
    : new ScriptedAuditor({
      defaultDecision: {
        verdict: "ACCEPT", proposedFindings: [],
        resolvedFindingRefs: facts.openFindings.map((finding) => finding.id),
        rationale: "deterministic validation is green and the open Finding is revalidated",
      },
    });
}

/**
 * Run the acceptance validator exactly the way Core runs it: the same Core
 * process supervisor, the same parsed instruction, one real child process per
 * criterion.
 */
async function runValidator(cwd: string): Promise<readonly string[]> {
  const failed: string[] = [];
  for (const spec of VALIDATION_SPECS) {
    const result = await runValidationCommandV2({ command: spec.instruction, cwd, expectedProjectRoot: cwd });
    if (result.exitCode !== 0 || result.infrastructureStatus !== "NONE") failed.push(spec.validationSpecId);
  }
  return failed;
}

describe("Ralph M4-C — shipped opt-in acceptance: deterministic defect, one real OpenCode correction", () => {
  it("drives ScriptedExecutor defect → Core Finding → exactly one real OpenCode correction invocation → ACCEPT", async () => {
    const report: Record<string, unknown> = {};

    // ── 0. VALIDATOR SELF-CHECK ──────────────────────────────────────────────
    // Proved in a scratch directory that is destroyed before any Executor runs.
    // The run workspace never contains a correct reference implementation.
    const selfCheckRoot = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-m4c-selfcheck-"));
    await mkdir(join(selfCheckRoot, "src"), { recursive: true });
    await writeFile(join(selfCheckRoot, COUNTER_PATH), REFERENCE_COUNTER);
    const referenceFailures = await runValidator(selfCheckRoot);
    await writeFile(join(selfCheckRoot, COUNTER_PATH), DEFECTIVE_COUNTER);
    const defectiveFailures = await runValidator(selfCheckRoot);
    await rm(selfCheckRoot, { recursive: true, force: true });

    expect(referenceFailures).toEqual([]);
    expect(defectiveFailures).toEqual([RESET_SPEC_ID]);
    report.validatorSelfCheck = {
      criteria: VALIDATION_SPECS.length,
      validatorDigest: VALIDATOR_DIGEST,
      referenceImplementationFailures: referenceFailures,
      defectiveImplementationFailures: defectiveFailures,
      referenceDestroyedBeforeExecution: true,
      referenceEverInRunWorkspace: false,
    };

    // ── 1. RUN BOOTSTRAP ─────────────────────────────────────────────────────
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-m4c-real-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "README.md"), "# Disposable Ralph M4-C correction fixture\n");
    const document = plan();
    const runId = `run-m4c-real-${randomUUID()}`;
    const timeoutPolicy = createM4BTimeoutPolicyV2(EXECUTION_TIMEOUT_MS);
    const retryPolicy = createRetryPolicyV1({ runId, policyId: "m4c-real-two-attempts", maxTaskAttemptsPerTask: 2, validationInfrastructureRetryLimit: 0 });
    const workspacePolicy = createWorkspacePolicy({ scopePaths: [COUNTER_PATH], coversPaths: [COUNTER_PATH] });
    const initialFingerprint = await fingerprintWorkspace(root, workspacePolicy);
    const config = descriptorRef("rb-ralph-config/v2", "m4c-real-config");
    const profileDigest = sha256Canonical({ profileId: PROFILE, model: MODEL, transport: "opencode-cli", transportVersion: "1.18.29" });
    const snapshot: RunSnapshotV2 = {
      snapshotSchemaVersion: RALPH_RUN_SNAPSHOT_V2_SCHEMA, runId, eventSchema: EVENT_SCHEMA_V2, stateSchema: STATE_SCHEMA_V2,
      operationalContract: OPERATIONAL_CONTRACT_V2, projectIdentity: { projectId: "m4c-real-sacrificial-project" },
      readyPlanIdentity: document.artifactId, readyPlanHash: sha256Canonical(document), readyManifestHash: sha256("m4c-real-ready-manifest"),
      selectedReadyArtifactHashes: { plan: sha256Canonical(document) }, readinessInspectionDigest: sha256("m4c-real-readiness"),
      effectiveRunConfig: config, effectiveConfigDigest: config.descriptorDigest,
      diagnosticsPolicy: descriptorRef("rb-ralph-diagnostics/v2", "m4c-real-diagnostics"),
      environmentPolicy: descriptorRef("rb-ralph-environment/v2", "m4c-real-environment-allowlisted-pure"),
      executorProfile: { profileId: PROFILE, kind: "scripted", descriptorDigest: profileDigest },
      executorCapabilities: { requested: ["workspace.write"], granted: ["workspace.write"], verified: ["workspace.write"], readOnlyEnforced: false },
      permissionCapabilityPolicy: descriptorRef("rb-ralph-capabilities/v2", "m4c-real-project-root-only"),
      workspacePolicy,
      initialWorkspaceFingerprint: {
        controlPlaneFingerprint: initialFingerprint.controlPlaneFingerprint, productWorkspaceFingerprint: initialFingerprint.productWorkspaceFingerprint,
        policyDigest: initialFingerprint.policyDigest, fingerprintDigest: initialFingerprint.fingerprintDigest,
      },
      retryPolicies: retryPolicyDescriptorV1(retryPolicy),
      timeoutPolicy: descriptorRef("rb-ralph-timeout/v2", "m4c-real-timeout", timeoutPolicy.policyDigest),
      runtimeIdentity: descriptorRef("rb-ralph-runtime/v2", "m4c-real-runtime"), leasePolicy: descriptorRef("rb-ralph-lease/v2", "m4c-real-lease"),
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
    Object.assign(report, { projectRoot: root, runId, profile: PROFILE, model: MODEL, openCodeVersion: "1.18.29" });

    // ── 2. ATTEMPT 1 — GENUINE SCRIPTED EXECUTOR, DETERMINISTIC DEFECT ───────
    const attemptOneId = `attempt-m4c-real-1-${randomUUID()}`;
    const storeOne = new RalphEventStoreV2({ projectRoot: root, runId });
    const admissionOne = await prepareNextAuthorizedInvocationV2({
      leasedRun: await acquireLeasedRunV2({ ...lease, runtimeInstanceId: "m4c-real-admit-1" }),
      plan: document, planIdentity: document.artifactId, planDigest: sha256Canonical(document), attemptIdFactory: () => attemptOneId,
    });
    expect(admissionOne.kind).toBe("AUTHORIZED_NOT_INVOKED");
    if (admissionOne.kind !== "AUTHORIZED_NOT_INVOKED") throw new Error(`M4-C real admission 1 failed: ${admissionOne.kind}`);
    const coreOne = admissionOne.authorizedInvocation.descriptor;

    // A base Attempt carries no correction authority at all.
    expect(await buildExactCorrectionContextV2({
      store: storeOne, runId: coreOne.runId, phaseId: coreOne.phaseId, taskId: coreOne.taskId,
      attemptId: coreOne.attemptId, baseWorkspaceFingerprint: coreOne.attemptBaseFingerprint, createdAt: new Date().toISOString(),
    })).toBeUndefined();

    // The Executor itself writes the defect through its legitimate fixture
    // action. Neither the harness nor the validator ever touches the workspace.
    const executorLeaseOne = await acquireLeasedRunV2({ ...lease, runtimeInstanceId: "m4c-real-exec-1" });
    const scriptedExecutor = new ScriptedExecutor({
      runtimeIdentity: "m4c-real-scripted-defect",
      defaultScenario: {
        kind: "SUCCESS", exitCode: 0,
        fixtureWorkspaceAction: async () => { await writeFile(join(root, COUNTER_PATH), DEFECTIVE_COUNTER); },
      },
    });
    const executedOne = await executeAuthorizedInvocationV2({
      leasedRun: executorLeaseOne, plan: document, planIdentity: document.artifactId, planDigest: sha256Canonical(document),
      attemptId: attemptOneId, runtime: scriptedExecutor,
    });
    expect(executedOne.kind).toBe("EXECUTOR_FINISHED_READY_FOR_CAPTURE");
    if (executedOne.kind !== "EXECUTOR_FINISHED_READY_FOR_CAPTURE") throw new Error(`M4-C real execution 1 failed: ${executedOne.kind}`);
    expect(executedOne.observation.state).toBe("TERMINATED_QUIESCENT");

    // No provider surface whatsoever on the scripted Attempt.
    const artifactsOne = await readProviderInvocationArtifactSetV2(storeOne, attemptOneId);
    expect(artifactsOne).toEqual({});
    expect(await readOpenCodeProviderResultV2(storeOne, attemptOneId)).toBeUndefined();
    expect(await readOpenCodePromptArtifactV2(storeOne, attemptOneId)).toBeUndefined();
    report.attempt1 = {
      attemptId: attemptOneId, invocationId: coreOne.invocationId, executorRuntime: "ScriptedExecutor",
      providerInvocationDescriptors: 0, openCodeSessions: 0, providerResults: 0, providerTerminals: 0,
      modelBearingInvocations: 0, correctionContextRef: null,
    };

    const capturedOne = await captureEvidenceV2({ leasedRun: executorLeaseOne, plan: document, attemptId: attemptOneId, observation: executedOne.observation });
    expect(capturedOne.kind).toBe("EVIDENCE_CAPTURED_READY_FOR_VALIDATION");
    if (capturedOne.kind !== "EVIDENCE_CAPTURED_READY_FOR_VALIDATION") throw new Error(`M4-C real evidence 1 failed: ${capturedOne.kind}`);
    expect(capturedOne.evidence.controlPlaneChangedPaths).toEqual([]);
    expect(capturedOne.evidence.changedPaths).toEqual([COUNTER_PATH]);
    const attemptOneWorkspace = await readFile(join(root, COUNTER_PATH), "utf8");
    expect(attemptOneWorkspace).toBe(DEFECTIVE_COUNTER);

    const validatedOne = await validateAttemptV2({
      leasedRun: await acquireLeasedRunV2({ ...lease, runtimeInstanceId: "m4c-real-validate-1" }),
      plan: document, attemptId: attemptOneId, executorObservation: executedOne.observation,
    });
    expect(validatedOne.kind).toBe("VALIDATION_READY_FOR_AUDIT");
    if (validatedOne.kind !== "VALIDATION_READY_FOR_AUDIT") throw new Error(`M4-C real validation 1 failed: ${validatedOne.kind}`);
    const failedOne = validatedOne.attempt.validationRuns.filter((run) => run.outcome === "FAIL").map((run) => run.validationSpecId);
    const passedOne = validatedOne.attempt.validationRuns.filter((run) => run.outcome === "PASS").map((run) => run.validationSpecId);

    // The acceptance property: exactly one criterion is red, and it is the
    // reset-restores-the-original-initial-value criterion.
    expect(failedOne).toEqual([RESET_SPEC_ID]);
    expect(passedOne).toHaveLength(VALIDATION_SPECS.length - 1);

    // The validator Core actually ran is byte-identical to the self-checked one.
    const durableWorkUnitOne = await readWorkUnitV2(new RalphEventStoreV2({ projectRoot: root, runId }), attemptOneId);
    expect(durableWorkUnitOne).toBeDefined();
    expect(validatorDigestOf(durableWorkUnitOne!.validationSpecRefs)).toBe(VALIDATOR_DIGEST);

    report.attempt1Evidence = {
      evidenceCaptureId: validatedOne.validationSet.evidenceCaptureId, evidenceDigest: capturedOne.evidence.evidenceDigest,
      changedPaths: capturedOne.evidence.changedPaths, controlPlaneChangedPaths: capturedOne.evidence.controlPlaneChangedPaths,
      workspace: attemptOneWorkspace, defectWrittenBy: "ScriptedExecutor fixtureWorkspaceAction",
      validation: validatedOne.validationSet.summary, passedSpecIds: passedOne, failedSpecIds: failedOne,
      validatorDigest: validatorDigestOf(durableWorkUnitOne!.validationSpecRefs),
    };

    const auditedOne = await auditAttemptV2({
      leasedRun: await acquireLeasedRunV2({ ...lease, runtimeInstanceId: "m4c-real-audit-1" }),
      plan: document, attemptId: attemptOneId, executorObservation: executedOne.observation,
      auditor: auditorFor({ failedSpecIds: failedOne, openFindings: [] }),
    });
    expect(auditedOne.kind).toBe("AUDIT_REJECTED");
    expect(auditedOne.attempt.closureReason).toBe("AUDIT_REJECTED");
    expect(auditedOne.state.tasks[TASK_ID]?.disposition).not.toBe("COMPLETE");

    // Core minted the Finding itself; the Auditor proposed nothing.
    const openFindings = Object.values(auditedOne.state.findings).filter((finding) => finding.status === "OPEN");
    expect(openFindings).toHaveLength(1);
    const finding = openFindings[0]!;
    expect(finding.criterionId).toBe(RESET_SPEC_ID);
    report.attempt1Audit = { kind: auditedOne.kind, closureReason: auditedOne.attempt.closureReason, taskDisposition: auditedOne.state.tasks[TASK_ID]?.disposition };
    report.finding = {
      findingId: finding.id, findingDigest: sha256Canonical(finding), criterionId: finding.criterionId,
      severity: finding.severity, status: finding.status, observed: finding.observed, remediationHint: finding.remediationHint,
      handcrafted: false, proposedByAuditor: false,
    };

    // ── 3. FRESH-PROCESS BOUNDARY ────────────────────────────────────────────
    // Every Attempt 1 runtime object is discarded here. Nothing below reads
    // them: the correction authority is re-derived from the durable ledger, and
    // the defect is re-observed by real child processes.
    const checkpointLease = await acquireLeasedRunV2({ ...lease, runtimeInstanceId: "m4c-real-checkpoint" });
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
    // The deterministic defect survives the boundary, re-observed out of process.
    const coldFailures = await runValidator(root);
    expect(coldFailures).toEqual([RESET_SPEC_ID]);
    expect(await readOpenCodeProviderResultV2(coldStore, attemptOneId)).toBeUndefined();
    report.freshProcessBoundary = {
      discardedRuntimeObjects: ["store", "lease", "executor", "auditor", "driver", "observer"],
      attempt1ClosureReason: coldAuthority.attempts.get(attemptOneId)?.closureReason,
      attempt1FindingStatus: coldAuthority.findings.get(finding.id)?.status,
      openFindingIds: authoritativeOpenFindingsForTaskV2(coldAuthority, TASK_ID).map((item) => item.id),
      workspaceDefectStillPresent: true, coldValidatorFailures: coldFailures,
      attempt1ProviderExecution: 0, duplicateProviderExecution: false,
    };

    // ── 4. ATTEMPT 2 — REAL OPENCODE CORRECTION (ONE MODEL-BEARING CALL) ─────
    const attemptTwoId = `attempt-m4c-real-2-${randomUUID()}`;
    const storeTwo = new RalphEventStoreV2({ projectRoot: root, runId });
    const admissionTwo = await prepareNextAuthorizedInvocationV2({
      leasedRun: await acquireLeasedRunV2({ ...lease, runtimeInstanceId: "m4c-real-admit-2" }),
      plan: document, planIdentity: document.artifactId, planDigest: sha256Canonical(document), attemptIdFactory: () => attemptTwoId,
    });
    expect(admissionTwo.kind).toBe("AUTHORIZED_NOT_INVOKED");
    if (admissionTwo.kind !== "AUTHORIZED_NOT_INVOKED") throw new Error(`M4-C real admission 2 failed: ${admissionTwo.kind}`);
    const coreTwo = admissionTwo.authorizedInvocation.descriptor;

    const context = await buildExactCorrectionContextV2({
      store: storeTwo, runId: coreTwo.runId, phaseId: coreTwo.phaseId, taskId: coreTwo.taskId,
      attemptId: coreTwo.attemptId, baseWorkspaceFingerprint: coreTwo.attemptBaseFingerprint, createdAt: new Date().toISOString(),
    });
    if (!context) throw new Error("M4-C real correction context was not derivable from the durable Finding authority");
    await persistCorrectionContextV2(storeTwo, context, randomUUID());
    const durableContext = await readCorrectionContextV2(storeTwo, attemptTwoId);
    expect(durableContext).toEqual(context);
    expect(context.openFindingRefs).toEqual([finding.id]);
    expect(context.sourceRejectedAttempts.map((item) => item.attemptId)).toEqual([attemptOneId]);
    const correctionFinding = context.openFindings.find((item) => item.findingId === finding.id);
    expect(correctionFinding).toMatchObject({
      findingId: finding.id, criterionId: RESET_SPEC_ID, severity: finding.severity, status: "OPEN", observed: finding.observed,
    });

    // The prompt carries the actual Finding BEFORE any dispatch.
    const projected = projectWorkUnitToOpenCodePromptV2(admissionTwo.authorizedInvocation.workUnit, context);
    const failingInstruction = VALIDATION_SPECS.find((spec) => spec.validationSpecId === RESET_SPEC_ID)!.instruction;
    for (const token of ["CORRECTION ATTEMPT", finding.id, finding.criterionId, finding.severity, "Status: OPEN", finding.observed, failingInstruction, attemptOneId]) {
      expect(projected.text).toContain(token);
    }
    if (finding.remediationHint) expect(projected.text).toContain(finding.remediationHint);
    report.correctionContext = {
      contextId: context.contextId, contextDigest: context.contextDigest,
      openFindingRefs: context.openFindingRefs, findingDigests: context.openFindings.map((item) => item.findingDigest),
      criterionId: RESET_SPEC_ID, severity: finding.severity, status: "OPEN",
      observed: finding.observed, remediationHint: finding.remediationHint,
      sourceRejectedAttempts: context.sourceRejectedAttempts.map((item) => item.attemptId),
    };

    const executorLeaseTwo = await acquireLeasedRunV2({ ...lease, runtimeInstanceId: "m4c-real-exec-2" });
    const executorTwo = await createOpenCodeCliExecutorV2({ store: storeTwo, authorizedInvocation: admissionTwo.authorizedInvocation, timeoutPolicy });
    const executedTwo = await executeAuthorizedInvocationV2({
      leasedRun: executorLeaseTwo, plan: document, planIdentity: document.artifactId, planDigest: sha256Canonical(document),
      attemptId: attemptTwoId, runtime: executorTwo,
    });
    expect(executedTwo.kind).toBe("EXECUTOR_FINISHED_READY_FOR_CAPTURE");
    if (executedTwo.kind !== "EXECUTOR_FINISHED_READY_FOR_CAPTURE") throw new Error(`M4-C real execution 2 failed: ${executedTwo.kind}`);
    expect(executedTwo.observation.state).toBe("TERMINATED_QUIESCENT");

    const artifactsTwo = await readProviderInvocationArtifactSetV2(storeTwo, attemptTwoId);
    const promptTwo = await readOpenCodePromptArtifactV2(storeTwo, attemptTwoId);
    const resultTwo = await readOpenCodeProviderResultV2(storeTwo, attemptTwoId);
    expect(artifactsTwo.descriptor).toMatchObject({ executorProfileIdentity: PROFILE, modelSelector: MODEL, conformanceState: "MATCH" });
    expect(artifactsTwo.descriptor?.correctionContextDigest).toBe(context.contextDigest);
    expect(await validateExactCorrectionContextForDispatchV2({ store: storeTwo, descriptor: artifactsTwo.descriptor! })).toEqual(context);
    expect(resultTwo).toMatchObject({ classification: "SUCCEEDED", observedModelSelector: MODEL });

    // Prompt causality: reconstruct the prompt independently from the durable
    // WorkUnit and the durable CorrectionContext, read through a fresh store.
    const causalityStore = new RalphEventStoreV2({ projectRoot: root, runId });
    const durableWorkUnitTwo = await readWorkUnitV2(causalityStore, attemptTwoId);
    const durableContextTwo = await readCorrectionContextV2(causalityStore, attemptTwoId);
    expect(durableWorkUnitTwo).toBeDefined();
    expect(durableContextTwo).toBeDefined();
    const reconstructed = projectWorkUnitToOpenCodePromptV2(durableWorkUnitTwo!, durableContextTwo!);
    expect(reconstructed.promptDigest).toBe(promptTwo?.promptDigest);
    expect(reconstructed.promptDigest).toBe(projected.promptDigest);
    for (const token of ["CORRECTION ATTEMPT", finding.id, finding.criterionId, finding.severity, "Status: OPEN", finding.observed, failingInstruction, attemptOneId]) {
      expect(reconstructed.text).toContain(token);
    }
    // The validator dispatched with the correction Attempt is byte-identical.
    expect(validatorDigestOf(durableWorkUnitTwo!.validationSpecRefs)).toBe(VALIDATOR_DIGEST);
    expect(durableWorkUnitTwo!.validationSpecRefs).toEqual(durableWorkUnitOne!.validationSpecRefs);

    // A genuinely new dedicated session, never Attempt 1's conversation.
    expect(artifactsTwo.sessionBinding?.openCodeSessionId).toBeDefined();
    expect(artifactsTwo.terminal).toBeDefined();

    // The Finding is still OPEN after the provider physically succeeded.
    expect((await deriveDurableCorrectionAuthorityV2(new RalphEventStoreV2({ projectRoot: root, runId }))).findings.get(finding.id)?.status).toBe("OPEN");

    const capturedTwo = await captureEvidenceV2({ leasedRun: executorLeaseTwo, plan: document, attemptId: attemptTwoId, observation: executedTwo.observation });
    expect(capturedTwo.kind).toBe("EVIDENCE_CAPTURED_READY_FOR_VALIDATION");
    if (capturedTwo.kind !== "EVIDENCE_CAPTURED_READY_FOR_VALIDATION") throw new Error(`M4-C real evidence 2 failed: ${capturedTwo.kind}`);
    expect(capturedTwo.evidence.controlPlaneChangedPaths).toEqual([]);
    const attemptTwoWorkspace = await readFile(join(root, COUNTER_PATH), "utf8");
    // The model, not the harness, produced the corrective delta.
    expect(attemptTwoWorkspace).not.toBe(DEFECTIVE_COUNTER);

    const validatedTwo = await validateAttemptV2({
      leasedRun: await acquireLeasedRunV2({ ...lease, runtimeInstanceId: "m4c-real-validate-2" }),
      plan: document, attemptId: attemptTwoId, executorObservation: executedTwo.observation,
    });
    expect(validatedTwo.kind).toBe("VALIDATION_READY_FOR_AUDIT");
    if (validatedTwo.kind !== "VALIDATION_READY_FOR_AUDIT") throw new Error(`M4-C real validation 2 failed: ${validatedTwo.kind}`);
    const failedTwo = validatedTwo.attempt.validationRuns.filter((run) => run.outcome === "FAIL").map((run) => run.validationSpecId);
    const passedTwo = validatedTwo.attempt.validationRuns.filter((run) => run.outcome === "PASS").map((run) => run.validationSpecId);

    // Entirely new Evidence and ValidationSet, nothing reused from Attempt 1.
    expect(validatedTwo.validationSet.evidenceCaptureId).not.toBe(validatedOne.validationSet.evidenceCaptureId);
    expect(validatedTwo.validationSet.setDigest).not.toBe(validatedOne.validationSet.setDigest);
    expect(capturedTwo.evidence.evidenceDigest).not.toBe(capturedOne.evidence.evidenceDigest);
    // The causal transition: the same criterion goes FAIL → PASS.
    expect(failedTwo).toEqual([]);
    expect(passedTwo).toContain(RESET_SPEC_ID);
    expect(passedTwo).toHaveLength(VALIDATION_SPECS.length);

    report.attempt2 = {
      attemptId: attemptTwoId, invocationId: coreTwo.invocationId, executorRuntime: "OpenCodeCliExecutorV2",
      openCodeSessionId: artifactsTwo.sessionBinding?.openCodeSessionId,
      conformanceState: artifactsTwo.descriptor?.conformanceState,
      correctionContextDigest: artifactsTwo.descriptor?.correctionContextDigest,
      dispatchedPromptDigest: promptTwo?.promptDigest,
      independentlyReconstructedPromptDigest: reconstructed.promptDigest,
      promptDigestsMatch: reconstructed.promptDigest === promptTwo?.promptDigest,
      workspace: attemptTwoWorkspace, changedPaths: capturedTwo.evidence.changedPaths,
      controlPlaneChangedPaths: capturedTwo.evidence.controlPlaneChangedPaths,
      evidenceCaptureId: validatedTwo.validationSet.evidenceCaptureId, evidenceDigest: capturedTwo.evidence.evidenceDigest,
      validation: validatedTwo.validationSet.summary, passedSpecIds: passedTwo, failedSpecIds: failedTwo,
      resetCriterionAttempt1: "FAIL", resetCriterionAttempt2: "PASS",
      validatorDigest: validatorDigestOf(durableWorkUnitTwo!.validationSpecRefs), validatorUnchanged: true,
    };

    const auditedTwo = await auditAttemptV2({
      leasedRun: await acquireLeasedRunV2({ ...lease, runtimeInstanceId: "m4c-real-audit-2" }),
      plan: document, attemptId: attemptTwoId, executorObservation: executedTwo.observation,
      auditor: auditorFor({ failedSpecIds: failedTwo, openFindings: Object.values(validatedTwo.state.findings).filter((item) => item.status !== "RESOLVED" && item.status !== "SUPERSEDED") }),
    });
    expect(auditedTwo.kind).toBe("AUDIT_ACCEPTED");
    expect(auditedTwo.attempt.closureReason).toBe("AUDIT_ACCEPTED");
    expect(auditedTwo.state.findings[finding.id]?.status).toBe("RESOLVED");
    expect(auditedTwo.state.tasks[TASK_ID]?.disposition).toBe("COMPLETE");
    expect(auditedTwo.state.disposition).toBe("COMPLETE");
    expect(auditedTwo.state.hold).toBe("NONE");

    const events = (await new RalphEventStoreV2({ projectRoot: root, runId }).inspect()).events;
    const lifecycle = events.flatMap((candidate) => candidate.eventType === "finding.state-changed" && candidate.payload.finding.id === finding.id
      ? [candidate.payload.finding.status] : []);
    expect(lifecycle).toEqual(["OPEN", "CANDIDATE_RESOLVED", "RESOLVED"]);
    report.attempt2Audit = {
      kind: auditedTwo.kind, closureReason: auditedTwo.attempt.closureReason, findingLifecycle: lifecycle,
      resolvedByExecutor: false, taskDisposition: auditedTwo.state.tasks[TASK_ID]?.disposition,
      runDisposition: auditedTwo.state.disposition, runHold: auditedTwo.state.hold,
    };

    // ── 5. COLD REOPEN ───────────────────────────────────────────────────────
    const reopened = new RalphEventStoreV2({ projectRoot: root, runId });
    const reopenedEvents = (await reopened.inspect()).events;
    const attemptIds = [attemptOneId, attemptTwoId];
    const providerResults = await Promise.all(attemptIds.map((id) => readOpenCodeProviderResultV2(reopened, id)));
    const providerSets = await Promise.all(attemptIds.map((id) => readProviderInvocationArtifactSetV2(reopened, id)));
    const invocationResults = await Promise.all(attemptIds.map((id) => readInvocationResultV2(reopened, id)));
    const reopenedAuthority = await deriveDurableCorrectionAuthorityV2(reopened);

    expect(reopenedAuthority.attempts.get(attemptOneId)?.closureReason).toBe("AUDIT_REJECTED");
    expect(reopenedAuthority.attempts.get(attemptTwoId)?.closureReason).toBe("AUDIT_ACCEPTED");
    expect(reopenedAuthority.findings.get(finding.id)?.status).toBe("RESOLVED");
    expect(reopenedAuthority.findings.size).toBe(1);
    // Exactly one model-bearing invocation in the whole Run: Attempt 2 only.
    expect(providerSets[0]).toEqual({});
    expect(providerResults[0]).toBeUndefined();
    expect(providerResults[1]?.classification).toBe("SUCCEEDED");
    expect(providerSets[1]?.descriptor).toBeDefined();
    expect(providerSets[1]?.sessionBinding?.openCodeSessionId).toBe(artifactsTwo.sessionBinding?.openCodeSessionId);
    expect(providerSets[1]?.terminal).toBeDefined();
    expect(invocationResults.filter((item) => item !== undefined)).toHaveLength(2);
    expect(reopenedEvents.filter((candidate) => candidate.eventType === "executor.started")).toHaveLength(2);
    expect(reopenedEvents.filter((candidate) => candidate.eventType === "executor.finished")).toHaveLength(2);
    expect(reopenedEvents.filter((candidate) => candidate.eventType === "attempt.closed")).toHaveLength(2);
    expect(reopenedEvents.filter((candidate) => candidate.eventType === "run.completed")).toHaveLength(1);

    // ── 6. COMPLETED RERUN ───────────────────────────────────────────────────
    const rerun = await prepareNextAuthorizedInvocationV2({
      leasedRun: await acquireLeasedRunV2({ ...lease, runtimeInstanceId: "m4c-real-rerun" }),
      plan: document, planIdentity: document.artifactId, planDigest: sha256Canonical(document),
      attemptIdFactory: () => `attempt-m4c-real-rerun-${randomUUID()}`,
    });
    expect(rerun.kind).not.toBe("AUTHORIZED_NOT_INVOKED");
    const afterRerun = (await new RalphEventStoreV2({ projectRoot: root, runId }).inspect()).events;
    expect(afterRerun.filter((candidate) => candidate.eventType === "executor.started")).toHaveLength(2);
    expect(afterRerun.filter((candidate) => candidate.eventType === "executor.finished")).toHaveLength(2);
    expect(afterRerun.filter((candidate) => candidate.eventType === "attempt.closed")).toHaveLength(2);
    expect(afterRerun.filter((candidate) => candidate.eventType === "run.completed")).toHaveLength(1);
    const afterRerunAuthority = await deriveDurableCorrectionAuthorityV2(new RalphEventStoreV2({ projectRoot: root, runId }));
    expect(afterRerunAuthority.findings.size).toBe(1);
    expect(await readOpenCodeProviderResultV2(new RalphEventStoreV2({ projectRoot: root, runId }), attemptOneId)).toBeUndefined();

    // Credential safety across every persisted artifact of both Attempts.
    for (const attemptId of attemptIds) {
      const directory = join(reopened.runDirectory, "attempts", attemptId);
      const files = await readdir(directory);
      const text = (await Promise.all(files.filter((file) => file.endsWith(".json")).map((file) => readFile(join(directory, file), "utf8")))).join("\n");
      expect(text).not.toMatch(/Bearer\s+\S+|-----BEGIN[^-]*PRIVATE KEY-----|(?:api[_-]?key|password|secret)\s*[:=]/i);
    }

    report.coldReopen = {
      runDisposition: auditedTwo.state.disposition, taskDisposition: auditedTwo.state.tasks[TASK_ID]?.disposition,
      attempt1ClosureReason: reopenedAuthority.attempts.get(attemptOneId)?.closureReason,
      attempt2ClosureReason: reopenedAuthority.attempts.get(attemptTwoId)?.closureReason,
      findingStatus: reopenedAuthority.findings.get(finding.id)?.status, findingCount: reopenedAuthority.findings.size,
      modelBearingInvocationsTotal: 1, attempt1ProviderArtifacts: 0,
      attempt2DedicatedSessions: 1, attempt2ProviderResults: 1, attempt2ProviderTerminals: 1, attempt2InvocationResults: 1,
      duplicateFinding: false, duplicateProviderExecution: false,
    };
    report.completedRerun = {
      admission: rerun.kind, providerDispatchDelta: 0, newAttempts: 0, newSessions: 0, newFindings: 0,
      newProviderResults: 0, newProviderTerminals: 0, newExecutorStarted: 0, newRunCompleted: 0,
    };
    report.providerInvocationCount = { total: 1, attempt1: 0, attempt2: 1 };
    report.retryFallback = { retries: 0, fallbacks: 0 };
    report.credentialLeakage = false;

    console.log(JSON.stringify(report, null, 2));
  }, 900_000);
});
