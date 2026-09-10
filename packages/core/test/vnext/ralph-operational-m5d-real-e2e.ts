import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RalphEventStoreV2, commitRalphEventV2 } from "../../src/vnext/ralph-runtime/operational-b1/index.js";
import { acquireLeasedRunV2, releaseLeasedRunV2 } from "../../src/vnext/ralph-runtime/operational-b2/index.js";
import { ScriptedExecutor, buildExactCorrectionContextV2, executeAuthorizedInvocationV2 } from "../../src/vnext/ralph-runtime/operational-b4/index.js";
import { captureEvidenceV2 } from "../../src/vnext/ralph-runtime/operational-c/index.js";
import { readAuditPackageV2, validateAttemptV2 } from "../../src/vnext/ralph-runtime/operational-d/index.js";
import { auditAttemptV2 } from "../../src/vnext/ralph-runtime/operational-e/index.js";
import { persistCorrectionContextV2 } from "../../src/vnext/ralph-runtime/operational-f/index.js";
import { fingerprintWorkspace } from "../../src/vnext/ralph-runtime/fingerprint.js";
import { sha256Canonical } from "../../src/vnext/ralph-runtime/hashing.js";
import {
  CODEX_CLI_CAPABILITY_RECORD_V2,
  assertCodexRealInferenceGateV2,
} from "../../src/vnext/ralph-runtime/operational-m5b/codex-capability.js";
import { assertCodexPhysicalCapabilityV2, probeCodexPhysicalCapabilityV2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-credential-boundary.js";
import { createCodexCliExecutorV2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-cli-executor.js";
import { readCodexInvocationArtifactSetV2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-artifacts.js";
import { inspectManagedCodexRuntimeV2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-process.js";
import { readCodexPublicationReceiptV2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-publication.js";
import { inspectCodexSandboxBackendV2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-sandbox-backend.js";
import {
  M5D_RETENTION_NOTICE_V2,
  assertCodexAuditorPhysicalCapabilityV2,
  buildCodexAuditAcceptanceReceiptV2,
  createCodexCliAuditorV2,
  probeCodexAuditorPhysicalCapabilityV2,
  readCodexAuditArtifactSetV2,
  writeCodexAuditAcceptanceReceiptV2,
} from "../../src/vnext/ralph-runtime/operational-m5d/index.js";
import { admitM5BAttemptV2, bootstrapM5BRunV2, m5bEvent } from "./fixtures/ralph-m5b-fixture.js";

const EXECUTION_TIMEOUT_MS = 600_000;

async function checkpointRejectedWorkspace(projectRoot: string, runId: string, leaseInput: Parameters<typeof acquireLeasedRunV2>[0], workspacePolicy: Parameters<typeof fingerprintWorkspace>[1], attemptId: string): Promise<void> {
  const leased = await acquireLeasedRunV2({ ...leaseInput, runtimeInstanceId: `m5d-checkpoint-${attemptId}` });
  try {
    const observed = await fingerprintWorkspace(projectRoot, workspacePolicy);
    await commitRalphEventV2({
      store: leased.store,
      state: leased.state,
      event: m5bEvent(leased.state, "workspace.checkpointed", { checkpoint: { kind: "acceptedCheckpointFingerprint", fingerprintDigest: observed.fingerprintDigest, emittedAt: new Date().toISOString(), attemptId, evidenceSetId: leased.state.attempts[attemptId]?.evidenceCapture?.evidenceCaptureId } }),
      writtenAt: new Date().toISOString(), nonce: `m5d-checkpoint-${runId}`,
    });
  } finally { await releaseLeasedRunV2(leased); }
}

describe("Ralph M5-D — opt-in real managed Codex Auditor closed loop", () => {
  it("uses exactly two fresh Codex Auditor calls around one fresh Codex correction", async () => {
    expect(process.platform).toBe("linux"); expect(process.arch).toBe("x64");
    assertCodexRealInferenceGateV2(CODEX_CLI_CAPABILITY_RECORD_V2);
    const { executable, managedRuntime } = await inspectManagedCodexRuntimeV2(180_000);
    expect(executable).toMatchObject({ executablePath: "/home/bruno/.local/libexec/rb-harness/codex-cli/0.153.4-rb.1/bin/codex", executableVersion: "0.153.4" });
    expect(managedRuntime).toMatchObject({ kind: "stock-codex-cli-managed", version: "0.153.4-rb.1", upstreamVersion: "0.153.4" });
    const backend = await inspectCodexSandboxBackendV2(); expect(backend).toMatchObject({ backendPath: "/usr/bin/bwrap", bundledFallbackSelected: false });
    const auditProbe = await probeCodexAuditorPhysicalCapabilityV2({ deadlineMs: 300_000 }); assertCodexAuditorPhysicalCapabilityV2(auditProbe);
    const correctionProbe = await probeCodexPhysicalCapabilityV2({ deadlineMs: 300_000 }); assertCodexPhysicalCapabilityV2(correctionProbe);

    // Retained regardless of any later model result. No cleanup follows this point.
    const fixture = await bootstrapM5BRunV2({
      deadlineMs: EXECUTION_TIMEOUT_MS,
      maxTaskAttemptsPerTask: 2,
      scope: "src/status.js", covers: "src/status.js", scopePaths: ["src/status.js"], coversPaths: ["src/status.js"],
      title: "Export the exact ready status",
      change: 'Make src/status.js export exactly: module.exports = "ready";',
      acceptanceCriteria: ['src/status.js must export exactly: module.exports = "ready";'],
      validation: ["`test -f src/status.js`", "`node -e 'require(\"./src/status.js\")'`"],
      expectedEvidence: "A bounded src/status.js modification satisfying the exact semantic export criterion",
    });
    const attemptOneId = `attempt-m5d-real-a1-${Date.now()}`;
    const attemptTwoId = `attempt-m5d-real-a2-${Date.now()}`;

    // Attempt 1: genuine ScriptedExecutor introduces a semantic defect while
    // deliberately insufficient deterministic validation stays green.
    await admitM5BAttemptV2(fixture, attemptOneId);
    const executorLeaseOne = await acquireLeasedRunV2({ ...fixture.leaseInput, runtimeInstanceId: "m5d-real-scripted-a1" });
    const executedOne = await executeAuthorizedInvocationV2({
      leasedRun: executorLeaseOne, plan: fixture.plan, planIdentity: fixture.plan.artifactId, planDigest: fixture.planDigest, attemptId: attemptOneId,
      runtime: new ScriptedExecutor({ defaultScenario: { kind: "SUCCESS", fixtureWorkspaceAction: async () => writeFile(join(fixture.projectRoot, "src/status.js"), 'module.exports = "broken";\n') } }),
    });
    if (executedOne.kind !== "EXECUTOR_FINISHED_READY_FOR_CAPTURE") throw new Error(executedOne.kind);
    const capturedOne = await captureEvidenceV2({ leasedRun: executorLeaseOne, plan: fixture.plan, attemptId: attemptOneId, observation: executedOne.observation });
    if (capturedOne.kind !== "EVIDENCE_CAPTURED_READY_FOR_VALIDATION") throw new Error(capturedOne.kind);
    const validatedOne = await validateAttemptV2({ leasedRun: await acquireLeasedRunV2({ ...fixture.leaseInput, runtimeInstanceId: "m5d-real-validate-a1" }), plan: fixture.plan, attemptId: attemptOneId, executorObservation: executedOne.observation });
    if (validatedOne.kind !== "VALIDATION_READY_FOR_AUDIT") throw new Error(validatedOne.kind);
    expect(validatedOne.validationSet.summary).toMatchObject({ total: 2, passed: 2, failed: 0, hardNegative: false });
    const packageOne = await readAuditPackageV2(fixture.store, attemptOneId); if (!packageOne) throw new Error("Attempt 1 AuditPackage missing");

    // === MODEL CALL 1/3: fresh managed Codex Auditor ===
    const auditorOne = await createCodexCliAuditorV2({ store: new RalphEventStoreV2({ projectRoot: fixture.projectRoot, runId: fixture.runId }), auditPackage: packageOne, timeoutPolicy: fixture.timeoutPolicy, ioBase: fixture.stagingBase });
    const auditedOne = await auditAttemptV2({ leasedRun: await acquireLeasedRunV2({ ...fixture.leaseInput, runtimeInstanceId: "m5d-real-auditor-a1" }), plan: fixture.plan, attemptId: attemptOneId, executorObservation: executedOne.observation, auditor: auditorOne });
    if (auditedOne.kind !== "AUDIT_REJECTED") throw new Error(`M5-D Auditor 1 returned ${auditedOne.kind}; retry forbidden`);
    expect(auditorOne.physicalDispatches).toBe(1);
    const finding = Object.values(auditedOne.state.findings)[0]; if (!finding) throw new Error("Codex Auditor did not propose a Core-mintable Finding");
    expect(finding).toMatchObject({ status: "OPEN", openedAtAttempt: attemptOneId });
    expect(finding.expectation.toLowerCase()).toContain("ready"); expect(finding.observed.toLowerCase()).toContain("broken");
    const auditOneArtifacts = await readCodexAuditArtifactSetV2(fixture.store, attemptOneId);
    expect(auditOneArtifacts.providerResult?.proposal.verdict).toBe("REJECT");
    expect(auditOneArtifacts.providerResult?.proposal.proposedFindings).toHaveLength(1);
    expect(auditOneArtifacts.providerResult?.workspaceFingerprintBefore).toBe(auditOneArtifacts.providerResult?.workspaceFingerprintAfter);
    expect(auditOneArtifacts.providerResult?.productWorkspaceFingerprintBefore).toBe(auditOneArtifacts.providerResult?.productWorkspaceFingerprintAfter);
    expect(auditOneArtifacts.providerResult?.controlPlaneFingerprintBefore).toBe(auditOneArtifacts.providerResult?.controlPlaneFingerprintAfter);
    await checkpointRejectedWorkspace(fixture.projectRoot, fixture.runId, fixture.leaseInput, fixture.snapshot.workspacePolicy, attemptOneId);

    // Fresh runtime boundary: reconstruct only from durable state.
    const storeTwo = new RalphEventStoreV2({ projectRoot: fixture.projectRoot, runId: fixture.runId });
    const coldBeforeCorrection = await acquireLeasedRunV2({ ...fixture.leaseInput, runtimeInstanceId: "m5d-real-cold-a2" });
    expect(coldBeforeCorrection.state.attempts[attemptOneId]?.closureReason).toBe("AUDIT_REJECTED");
    expect(coldBeforeCorrection.state.findings[finding.id]?.status).toBe("OPEN");
    await releaseLeasedRunV2(coldBeforeCorrection);

    const admittedTwo = (await admitM5BAttemptV2(fixture, attemptTwoId)).admitted;
    const coreTwo = admittedTwo.authorizedInvocation.descriptor;
    const context = await buildExactCorrectionContextV2({ store: storeTwo, runId: coreTwo.runId, phaseId: coreTwo.phaseId, taskId: coreTwo.taskId, attemptId: coreTwo.attemptId, baseWorkspaceFingerprint: coreTwo.attemptBaseFingerprint, createdAt: new Date().toISOString() });
    if (!context) throw new Error("CorrectionContext missing");
    await persistCorrectionContextV2(storeTwo, context, "m5d-real-correction-context");
    expect(context.openFindingRefs).toEqual([finding.id]); expect(context.openFindings[0]?.observed.toLowerCase()).toContain("broken");

    // === MODEL CALL 2/3: frozen M5-C fresh managed Codex correction ===
    const codexCorrection = await createCodexCliExecutorV2({ store: storeTwo, authorizedInvocation: admittedTwo.authorizedInvocation, timeoutPolicy: fixture.timeoutPolicy, stagingBase: fixture.stagingBase });
    const executorLeaseTwo = await acquireLeasedRunV2({ ...fixture.leaseInput, runtimeInstanceId: "m5d-real-correction-a2" });
    const executedTwo = await executeAuthorizedInvocationV2({ leasedRun: executorLeaseTwo, plan: fixture.plan, planIdentity: fixture.plan.artifactId, planDigest: fixture.planDigest, attemptId: attemptTwoId, runtime: codexCorrection });
    if (executedTwo.kind !== "EXECUTOR_FINISHED_READY_FOR_CAPTURE") throw new Error(`M5-D correction returned ${executedTwo.kind}; retry forbidden`);
    expect((await readFile(join(fixture.projectRoot, "src/status.js"), "utf8")).trim()).toBe('module.exports = "ready";');
    const correctionArtifacts = await readCodexInvocationArtifactSetV2(storeTwo, attemptTwoId);
    const publication = await readCodexPublicationReceiptV2(storeTwo, attemptTwoId);
    expect(correctionArtifacts.workspaceDelta?.entries.map((entry) => `${entry.operation} ${entry.path}`)).toEqual(["MODIFY src/status.js"]);
    expect(correctionArtifacts.descriptor).toMatchObject({ correctionContextSupported: true, correctionContextDigest: context.contextDigest, managedRuntimeVersion: "0.153.4-rb.1", requestedModel: "gpt-5.6-sol" });
    expect(publication?.appliedCount).toBe(1);
    const capturedTwo = await captureEvidenceV2({ leasedRun: executorLeaseTwo, plan: fixture.plan, attemptId: attemptTwoId, observation: executedTwo.observation });
    if (capturedTwo.kind !== "EVIDENCE_CAPTURED_READY_FOR_VALIDATION") throw new Error(capturedTwo.kind);
    const validatedTwo = await validateAttemptV2({ leasedRun: await acquireLeasedRunV2({ ...fixture.leaseInput, runtimeInstanceId: "m5d-real-validate-a2" }), plan: fixture.plan, attemptId: attemptTwoId, executorObservation: executedTwo.observation });
    if (validatedTwo.kind !== "VALIDATION_READY_FOR_AUDIT") throw new Error(validatedTwo.kind);
    expect(validatedTwo.validationSet.summary).toMatchObject({ total: 2, passed: 2, failed: 0, hardNegative: false });
    expect(validatedTwo.state.findings[finding.id]?.status).toBe("OPEN");
    const packageTwo = await readAuditPackageV2(storeTwo, attemptTwoId); if (!packageTwo) throw new Error("Attempt 2 AuditPackage missing");
    expect(packageTwo.openFindingRefs.map((entry) => entry.findingId)).toEqual([finding.id]);

    // === MODEL CALL 3/3: a different fresh managed Codex Auditor ===
    const auditorTwo = await createCodexCliAuditorV2({ store: new RalphEventStoreV2({ projectRoot: fixture.projectRoot, runId: fixture.runId }), auditPackage: packageTwo, timeoutPolicy: fixture.timeoutPolicy, ioBase: fixture.stagingBase });
    const auditedTwo = await auditAttemptV2({ leasedRun: await acquireLeasedRunV2({ ...fixture.leaseInput, runtimeInstanceId: "m5d-real-auditor-a2" }), plan: fixture.plan, attemptId: attemptTwoId, executorObservation: executedTwo.observation, auditor: auditorTwo });
    if (auditedTwo.kind !== "AUDIT_ACCEPTED") throw new Error(`M5-D Auditor 2 returned ${auditedTwo.kind}; retry forbidden`);
    expect(auditorTwo.physicalDispatches).toBe(1);
    const auditTwoArtifacts = await readCodexAuditArtifactSetV2(storeTwo, attemptTwoId);
    expect(auditTwoArtifacts.providerResult?.proposal).toMatchObject({ verdict: "ACCEPT", proposedFindings: [], resolvedFindingRefs: [finding.id] });
    expect(auditTwoArtifacts.providerResult?.workspaceFingerprintBefore).toBe(auditTwoArtifacts.providerResult?.workspaceFingerprintAfter);
    expect(auditTwoArtifacts.providerResult?.productWorkspaceFingerprintBefore).toBe(auditTwoArtifacts.providerResult?.productWorkspaceFingerprintAfter);
    expect(auditTwoArtifacts.providerResult?.controlPlaneFingerprintBefore).toBe(auditTwoArtifacts.providerResult?.controlPlaneFingerprintAfter);
    expect(auditedTwo.state.findings[finding.id]?.status).toBe("RESOLVED");
    expect(auditedTwo.state.attempts[attemptOneId]?.closureReason).toBe("AUDIT_REJECTED");
    expect(auditedTwo.state.attempts[attemptTwoId]?.closureReason).toBe("AUDIT_ACCEPTED");
    expect(auditedTwo.state.tasks.T001?.disposition).toBe("COMPLETE"); expect(auditedTwo.state.disposition).toBe("COMPLETE");

    const threads = [auditOneArtifacts.threadBinding!.threadId, correctionArtifacts.threadBinding!.threadId, auditTwoArtifacts.threadBinding!.threadId];
    expect(new Set(threads).size).toBe(3);
    expect(auditorOne.runtimeIdentity).not.toBe(auditorTwo.runtimeIdentity);

    // Cold reopen plus completed rerun with a newly constructed Auditor:
    // terminal Core state returns without invoke(), so model-call delta is 0.
    const coldStore = new RalphEventStoreV2({ projectRoot: fixture.projectRoot, runId: fixture.runId });
    const cold = await acquireLeasedRunV2({ ...fixture.leaseInput, runtimeInstanceId: "m5d-real-cold-complete" });
    const coldReopenIdentical = cold.state.attempts[attemptOneId]?.closureReason === "AUDIT_REJECTED" && cold.state.attempts[attemptTwoId]?.closureReason === "AUDIT_ACCEPTED" && cold.state.findings[finding.id]?.status === "RESOLVED" && cold.state.tasks.T001?.disposition === "COMPLETE" && cold.state.disposition === "COMPLETE";
    await releaseLeasedRunV2(cold); expect(coldReopenIdentical).toBe(true);
    const replayAuditor = await createCodexCliAuditorV2({ store: coldStore, auditPackage: packageTwo, timeoutPolicy: fixture.timeoutPolicy, ioBase: fixture.stagingBase });
    const eventCountBefore = (await coldStore.inspect()).events.length;
    const rerun = await auditAttemptV2({ leasedRun: await acquireLeasedRunV2({ ...fixture.leaseInput, runtimeInstanceId: "m5d-real-completed-rerun" }), plan: fixture.plan, attemptId: attemptTwoId, auditor: replayAuditor });
    expect(rerun.kind).toBe("AUDIT_ACCEPTED"); expect(replayAuditor.physicalDispatches).toBe(0);
    expect((await coldStore.inspect()).events.length).toBe(eventCountBefore);

    const events = (await coldStore.inspect()).events;
    const findingLifecycle = events.flatMap((event) => event.eventType === "finding.state-changed" && event.payload.finding.id === finding.id ? [event.payload.finding.status] : []);
    expect(findingLifecycle).toEqual(["OPEN", "CANDIDATE_RESOLVED", "RESOLVED"]);
    const attemptArtifacts = (await Promise.all([attemptOneId, attemptTwoId].map(async (attemptId) => {
      const directory = join(coldStore.runDirectory, "attempts", attemptId);
      return (await Promise.all((await readdir(directory)).filter((file) => file.endsWith(".json")).map((file) => readFile(join(directory, file), "utf8")))).join("\n");
    }))).join("\n");
    const credentialLeakage = /Bearer\s+\S+|-----BEGIN[^-]*PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]/i.test(attemptArtifacts);
    expect(credentialLeakage).toBe(false);

    const receipt = buildCodexAuditAcceptanceReceiptV2({
      runId: fixture.runId, phaseId: "P01", taskId: "T001", attemptOneId, attemptTwoId,
      acceptanceCriteriaDigest: sha256Canonical(fixture.plan.phases[0]!.tasks[0]!.acceptanceCriteria),
      attemptOneValidationSetDigest: validatedOne.validationSet.setDigest, attemptOneValidationHardNegative: false,
      auditorOneRuntimeIdentity: auditorOne.runtimeIdentity, auditorOneProfileDigest: auditorOne.profileDigest,
      auditorOneCapabilityDigest: auditOneArtifacts.descriptor!.capabilityDigest, auditorOneThreadId: threads[0]!,
      auditorOneWorkspaceFingerprintBefore: auditOneArtifacts.providerResult!.workspaceFingerprintBefore, auditorOneWorkspaceFingerprintAfter: auditOneArtifacts.providerResult!.workspaceFingerprintAfter,
      auditorOneProductFingerprintBefore: auditOneArtifacts.providerResult!.productWorkspaceFingerprintBefore, auditorOneProductFingerprintAfter: auditOneArtifacts.providerResult!.productWorkspaceFingerprintAfter,
      auditorOneControlFingerprintBefore: auditOneArtifacts.providerResult!.controlPlaneFingerprintBefore, auditorOneControlFingerprintAfter: auditOneArtifacts.providerResult!.controlPlaneFingerprintAfter,
      auditorOneVerdict: "REJECT", auditorOneProposalDigest: auditOneArtifacts.providerResult!.proposalDigest,
      coreFindingId: finding.id, coreFindingDigest: context.openFindings[0]!.findingDigest, attemptOneClosure: "AUDIT_REJECTED", freshRuntimeBoundary: true,
      correctionContextDigest: context.contextDigest, correctionProviderDescriptorDigest: correctionArtifacts.descriptor!.descriptorDigest,
      correctionThreadId: threads[1]!, correctionDeltaDigest: correctionArtifacts.workspaceDelta!.deltaDigest,
      correctionDeltaEntries: correctionArtifacts.workspaceDelta!.entries.map((entry) => `${entry.operation} ${entry.path}`), correctionPublicationDigest: publication!.receiptDigest,
      attemptTwoValidationSetDigest: validatedTwo.validationSet.setDigest, attemptTwoValidationHardNegative: false,
      auditorTwoRuntimeIdentity: auditorTwo.runtimeIdentity, auditorTwoProfileDigest: auditorTwo.profileDigest,
      auditorTwoCapabilityDigest: auditTwoArtifacts.descriptor!.capabilityDigest, auditorTwoThreadId: threads[2]!,
      auditorTwoWorkspaceFingerprintBefore: auditTwoArtifacts.providerResult!.workspaceFingerprintBefore, auditorTwoWorkspaceFingerprintAfter: auditTwoArtifacts.providerResult!.workspaceFingerprintAfter,
      auditorTwoProductFingerprintBefore: auditTwoArtifacts.providerResult!.productWorkspaceFingerprintBefore, auditorTwoProductFingerprintAfter: auditTwoArtifacts.providerResult!.productWorkspaceFingerprintAfter,
      auditorTwoControlFingerprintBefore: auditTwoArtifacts.providerResult!.controlPlaneFingerprintBefore, auditorTwoControlFingerprintAfter: auditTwoArtifacts.providerResult!.controlPlaneFingerprintAfter,
      auditorTwoVerdict: "ACCEPT", auditorTwoProposalDigest: auditTwoArtifacts.providerResult!.proposalDigest,
      resolvedFindingRefs: [finding.id], findingLifecycle: ["OPEN", "CANDIDATE_RESOLVED", "RESOLVED"], attemptTwoClosure: "AUDIT_ACCEPTED", taskState: "COMPLETE", runState: "COMPLETE",
      managedRuntimeKind: "stock-codex-cli-managed", managedRuntimeVersion: "0.153.4-rb.1", managedRuntimeIdentityDigest: managedRuntime.identityDigest,
      requestedModel: "gpt-5.6-sol", sandboxBackendPath: "/usr/bin/bwrap", auditorPermissionShapeDigest: auditOneArtifacts.descriptor!.permissionPolicyShapeDigest,
      auditorModelCallCount: 2, executorCorrectionModelCallCount: 1, totalModelCallCount: 3, distinctThreadCount: 3,
      retryCount: 0, fallbackCount: 0, credentialLeakage: false, coldReopenIdentical: true, completedRerunModelCallDelta: 0,
      retainedProjectRoot: fixture.projectRoot, retainedRunDirectory: coldStore.runDirectory, retainedStagingBase: fixture.stagingBase,
      platform: "linux-x86_64", unqualifiedPlatforms: ["WSL2", "linux ARM", "macOS ARM", "macOS x64"], observedAt: new Date().toISOString(),
    });
    const written = await writeCodexAuditAcceptanceReceiptV2(receipt);
    expect(existsSync(fixture.projectRoot)).toBe(true); expect(existsSync(coldStore.runDirectory)).toBe(true); expect(existsSync(fixture.stagingBase)).toBe(true); expect(existsSync(written.path)).toBe(true);

    console.log(JSON.stringify({
      stage: "m5d-real-managed-codex-auditor", authorized: true, retention: M5D_RETENTION_NOTICE_V2,
      retainedProjectRoot: fixture.projectRoot, retainedRunDirectory: coldStore.runDirectory, retainedStagingBase: fixture.stagingBase,
      acceptanceReceiptPath: written.path, acceptanceReceiptDigest: written.receiptDigest, acceptanceReceiptFileDigest: written.fileDigest,
      runId: fixture.runId, attemptOneId, attemptTwoId, acceptanceCriterion: fixture.plan.phases[0]!.tasks[0]!.acceptanceCriteria[0],
      attemptOneValidation: validatedOne.validationSet.summary, auditorOneRuntimeIdentity: auditorOne.runtimeIdentity, auditorOneThreadId: threads[0],
      auditorOneWorkspaceBefore: auditOneArtifacts.providerResult!.workspaceFingerprintBefore, auditorOneWorkspaceAfter: auditOneArtifacts.providerResult!.workspaceFingerprintAfter,
      auditorOneVerdict: "REJECT", auditorOneProposal: auditOneArtifacts.providerResult!.proposal.proposedFindings,
      coreFindingId: finding.id, coreFindingDigest: context.openFindings[0]!.findingDigest, attemptOneClosure: "AUDIT_REJECTED", freshRuntimeBoundary: true,
      correctionInvocationId: coreTwo.invocationId, correctionThreadId: threads[1], correctionContextDigest: context.contextDigest,
      correctionDelta: correctionArtifacts.workspaceDelta!.entries.map((entry) => `${entry.operation} ${entry.path}`), correctionValidation: validatedTwo.validationSet.summary,
      auditorTwoRuntimeIdentity: auditorTwo.runtimeIdentity, auditorTwoThreadId: threads[2],
      auditorTwoWorkspaceBefore: auditTwoArtifacts.providerResult!.workspaceFingerprintBefore, auditorTwoWorkspaceAfter: auditTwoArtifacts.providerResult!.workspaceFingerprintAfter,
      auditorTwoVerdict: "ACCEPT", resolvedFindingRefs: [finding.id], findingLifecycle,
      attemptTwoClosure: "AUDIT_ACCEPTED", taskState: "COMPLETE", runState: "COMPLETE",
      totalModelCalls: 3, auditorCalls: 2, correctionCalls: 1, distinctThreadCount: 3, retries: 0, fallbacks: 0,
      credentialLeakage, coldReopenIdentical, completedRerunModelCallDelta: 0, managedRuntimeVersion: managedRuntime.version,
      managedRuntimeIdentityDigest: managedRuntime.identityDigest, requestedModel: "gpt-5.6-sol", platform: "linux-x86_64",
    }));
  });
});
