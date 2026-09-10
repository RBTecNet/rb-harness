import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CODEX_CLI_CAPABILITY_RECORD_V2,
  assertCodexRealInferenceGateV2,
} from "../../src/vnext/ralph-runtime/operational-m5b/codex-capability.js";
import { assertCodexPhysicalCapabilityV2, probeCodexPhysicalCapabilityV2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-credential-boundary.js";
import { inspectCodexSandboxBackendV2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-sandbox-backend.js";
import { inspectManagedCodexRuntimeV2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-process.js";
import { createCodexCliExecutorV2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-cli-executor.js";
import { readCodexInvocationArtifactSetV2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-artifacts.js";
import { projectWorkUnitToCodexPromptV2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-prompt.js";
import { readCodexPublicationReceiptV2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-publication.js";
import { CODEX_PROJECTION_EXCLUDED_ROOTS_V2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-projection.js";
import {
  M5C_RETENTION_NOTICE_V2,
  buildCodexCorrectionAcceptanceReceiptV2,
  writeCodexCorrectionAcceptanceReceiptV2,
} from "../../src/vnext/ralph-runtime/operational-m5b/codex-correction-acceptance-receipt.js";
import {
  RalphEventStoreV2,
  commitRalphEventV2,
} from "../../src/vnext/ralph-runtime/operational-b1/index.js";
import {
  acquireLeasedRunV2,
  releaseLeasedRunV2,
} from "../../src/vnext/ralph-runtime/operational-b2/index.js";
import {
  ScriptedExecutor,
  buildExactCorrectionContextV2,
  deriveDurableCorrectionAuthorityV2,
  executeAuthorizedInvocationV2,
} from "../../src/vnext/ralph-runtime/operational-b4/index.js";
import { captureEvidenceV2 } from "../../src/vnext/ralph-runtime/operational-c/index.js";
import { validateAttemptV2 } from "../../src/vnext/ralph-runtime/operational-d/index.js";
import { ScriptedAuditor, auditAttemptV2 } from "../../src/vnext/ralph-runtime/operational-e/index.js";
import { persistCorrectionContextV2 } from "../../src/vnext/ralph-runtime/operational-f/index.js";
import { fingerprintWorkspace } from "../../src/vnext/ralph-runtime/fingerprint.js";
import { sha256Canonical } from "../../src/vnext/ralph-runtime/hashing.js";
import {
  admitM5BAttemptV2,
  bootstrapM5BRunV2,
  m5bEvent,
  type M5BFixtureV2,
} from "./fixtures/ralph-m5b-fixture.js";

if (process.env.RB_RALPH_M5C_REAL_E2E !== "1") {
  throw new Error("M5-C real E2E is opt-in; set RB_RALPH_M5C_REAL_E2E=1 explicitly");
}

const EXPECTED = Object.freeze({ name: "rb-m5c-probe", private: true });
const DEFECTIVE = Object.freeze({ name: "wrong-name", private: true });
const EXECUTION_TIMEOUT_MS = 900_000;

async function checkpointRejectedWorkspace(fixture: M5BFixtureV2, attemptId: string): Promise<void> {
  const leased = await acquireLeasedRunV2({ ...fixture.leaseInput, runtimeInstanceId: "m5c-real-checkpoint" });
  try {
    const fingerprint = await fingerprintWorkspace(fixture.projectRoot, fixture.snapshot.workspacePolicy);
    await commitRalphEventV2({
      store: leased.store,
      state: leased.state,
      event: m5bEvent(leased.state, "workspace.checkpointed", {
        checkpoint: {
          kind: "acceptedCheckpointFingerprint",
          fingerprintDigest: fingerprint.fingerprintDigest,
          emittedAt: new Date().toISOString(),
          attemptId,
          evidenceSetId: leased.state.attempts[attemptId]?.evidenceCapture?.evidenceCaptureId,
        },
      }),
      writtenAt: new Date().toISOString(),
      nonce: "m5c-real-checkpoint",
    });
  } finally {
    await releaseLeasedRunV2(leased);
  }
}

describe("Ralph M5-C — opt-in real managed Codex correction", () => {
  it("uses exactly one fresh managed codex exec after every deterministic and physical gate", async () => {
    // These are the last in-process, non-model gates. Any failure throws from
    // this single test before a disposable Run or model-bearing call exists.
    expect(process.platform).toBe("linux");
    expect(process.arch).toBe("x64");
    assertCodexRealInferenceGateV2(CODEX_CLI_CAPABILITY_RECORD_V2);
    const { executable, managedRuntime } = await inspectManagedCodexRuntimeV2(180_000);
    expect(executable.executableVersion).toBe("0.153.4");
    expect(managedRuntime).toMatchObject({
      kind: "stock-codex-cli-managed",
      version: "0.153.4-rb.1",
      upstreamVersion: "0.153.4",
      transport: "codex-exec",
    });
    const backend = await inspectCodexSandboxBackendV2();
    expect(backend).toMatchObject({ backendPath: "/usr/bin/bwrap", bundledFallbackSelected: false });
    const probe = await probeCodexPhysicalCapabilityV2({ deadlineMs: 300_000 });
    assertCodexPhysicalCapabilityV2(probe);
    expect(probe).toMatchObject({
      credentialFileBoundary: "DENIED",
      stagingWriteCapability: "PROVEN",
      controlPlaneDenialCapability: "PROVEN",
      rootProductWriteCapability: "PROVEN",
      rootSentinelDenialCapability: "PROVEN",
    });

    // From this point onward the fixture is deliberately retained even if a
    // post-call assertion fails, so independent audit never loses evidence.
    const fixture = await bootstrapM5BRunV2({
      deadlineMs: EXECUTION_TIMEOUT_MS,
      maxTaskAttemptsPerTask: 2,
      scope: "package.json",
      covers: "package.json",
      scopePaths: ["package.json"],
      coversPaths: ["package.json"],
      title: "Correct the rejected root package manifest",
      change: `Make root package.json equal ${JSON.stringify(EXPECTED)}`,
      acceptanceCriteria: ["package.json has name rb-m5c-probe and private true"],
      validation: ["`node -e 'const p=require(\"./package.json\"); if (p.name !== \"rb-m5c-probe\" || p.private !== true) process.exit(1)'`"],
      expectedEvidence: "A real MODIFY package.json delta correcting the rejected Finding",
    });
    const attemptOneId = `attempt-m5c-real-a1-${Date.now()}`;
    const attemptTwoId = `attempt-m5c-real-a2-${Date.now()}`;

    // Attempt 1 is a genuine ScriptedExecutor and consumes no Codex call.
    const admittedOne = (await admitM5BAttemptV2(fixture, attemptOneId)).admitted;
    const executorLeaseOne = await acquireLeasedRunV2({ ...fixture.leaseInput, runtimeInstanceId: "m5c-real-scripted-a1" });
    const scripted = new ScriptedExecutor({ defaultScenario: {
      kind: "SUCCESS",
      fixtureWorkspaceAction: async () => writeFile(join(fixture.projectRoot, "package.json"), `${JSON.stringify(DEFECTIVE, null, 2)}\n`),
    } });
    const executedOne = await executeAuthorizedInvocationV2({
      leasedRun: executorLeaseOne,
      plan: fixture.plan,
      planIdentity: fixture.plan.artifactId,
      planDigest: fixture.planDigest,
      attemptId: attemptOneId,
      runtime: scripted,
    });
    if (executedOne.kind !== "EXECUTOR_FINISHED_READY_FOR_CAPTURE") throw new Error(`M5C Attempt 1: ${executedOne.kind}`);
    const capturedOne = await captureEvidenceV2({ leasedRun: executorLeaseOne, plan: fixture.plan, attemptId: attemptOneId, observation: executedOne.observation });
    if (capturedOne.kind !== "EVIDENCE_CAPTURED_READY_FOR_VALIDATION") throw new Error(capturedOne.kind);
    const validatedOne = await validateAttemptV2({
      leasedRun: await acquireLeasedRunV2({ ...fixture.leaseInput, runtimeInstanceId: "m5c-real-validate-a1" }),
      plan: fixture.plan,
      attemptId: attemptOneId,
      executorObservation: executedOne.observation,
    });
    if (validatedOne.kind !== "VALIDATION_READY_FOR_AUDIT") throw new Error(validatedOne.kind);
    expect(validatedOne.validationSet.summary).toMatchObject({ passed: 0, failed: 1, hardNegative: true });
    const auditedOne = await auditAttemptV2({
      leasedRun: await acquireLeasedRunV2({ ...fixture.leaseInput, runtimeInstanceId: "m5c-real-audit-a1" }),
      plan: fixture.plan,
      attemptId: attemptOneId,
      executorObservation: executedOne.observation,
      auditor: new ScriptedAuditor({ defaultDecision: { verdict: "REJECT", proposedFindings: [], resolvedFindingRefs: [], rationale: "the exact package-name criterion failed" } }),
    });
    if (auditedOne.kind !== "AUDIT_REJECTED") throw new Error(auditedOne.kind);
    const finding = Object.values(auditedOne.state.findings)[0];
    if (!finding) throw new Error("M5C Core did not create the deterministic Finding");
    expect(finding).toMatchObject({ status: "OPEN", severity: "BLOCKER", openedAtAttempt: attemptOneId });
    expect(finding.observed).toContain(finding.criterionId);
    expect(await readFile(join(fixture.projectRoot, "package.json"), "utf8")).toContain("wrong-name");
    await checkpointRejectedWorkspace(fixture, attemptOneId);

    // Fresh-process boundary: all Attempt-1 runtime objects above are no
    // longer used. A new store and leases reconstruct the rejection, Finding
    // and defective product from durable state only.
    const storeTwo = new RalphEventStoreV2({ projectRoot: fixture.projectRoot, runId: fixture.runId });
    const coldBeforeTwo = await acquireLeasedRunV2({ ...fixture.leaseInput, runtimeInstanceId: "m5c-real-cold-before-a2" });
    expect(coldBeforeTwo.state.attempts[attemptOneId]?.closureReason).toBe("AUDIT_REJECTED");
    expect(coldBeforeTwo.state.findings[finding.id]?.status).toBe("OPEN");
    await releaseLeasedRunV2(coldBeforeTwo);

    const admittedTwo = (await admitM5BAttemptV2(fixture, attemptTwoId)).admitted;
    const coreTwo = admittedTwo.authorizedInvocation.descriptor;
    const context = await buildExactCorrectionContextV2({
      store: storeTwo,
      runId: coreTwo.runId,
      phaseId: coreTwo.phaseId,
      taskId: coreTwo.taskId,
      attemptId: coreTwo.attemptId,
      baseWorkspaceFingerprint: coreTwo.attemptBaseFingerprint,
      createdAt: new Date().toISOString(),
    });
    if (!context) throw new Error("M5C durable correction authority was not derivable");
    await persistCorrectionContextV2(storeTwo, context, "m5c-real-context");
    expect(context.openFindingRefs).toEqual([finding.id]);
    expect(context.sourceRejectedAttempts.map((attempt) => attempt.attemptId)).toEqual([attemptOneId]);

    // Independently prove exact provider input before the only model-bearing
    // dispatch. This pure projection is the text the Executor must dispatch.
    const projected = projectWorkUnitToCodexPromptV2(admittedTwo.authorizedInvocation.workUnit, context);
    for (const field of [
      context.contextId, context.contextDigest, attemptOneId, finding.id, finding.criterionId,
      finding.severity, "status: OPEN", finding.observed, finding.remediationHint!,
      "failing validation [COMMAND]", "Do not mark any Finding resolved",
      "Do not claim Validation PASS", "Do not claim Audit ACCEPT", "Do not commit or push",
    ]) expect(projected.text).toContain(field);

    // === EXACTLY ONE authorized model-bearing crossing: fresh codex exec ===
    const executorLeaseTwo = await acquireLeasedRunV2({ ...fixture.leaseInput, runtimeInstanceId: "m5c-real-codex-a2" });
    const codex = await createCodexCliExecutorV2({
      store: storeTwo,
      authorizedInvocation: admittedTwo.authorizedInvocation,
      timeoutPolicy: fixture.timeoutPolicy,
      stagingBase: fixture.stagingBase,
    });
    const executedTwo = await executeAuthorizedInvocationV2({
      leasedRun: executorLeaseTwo,
      plan: fixture.plan,
      planIdentity: fixture.plan.artifactId,
      planDigest: fixture.planDigest,
      attemptId: attemptTwoId,
      runtime: codex,
    });
    if (executedTwo.kind !== "EXECUTOR_FINISHED_READY_FOR_CAPTURE") throw new Error(`M5C real Codex correction failed closed: ${executedTwo.kind}`);

    const artifacts = await readCodexInvocationArtifactSetV2(storeTwo, attemptTwoId);
    const publication = await readCodexPublicationReceiptV2(storeTwo, attemptTwoId);
    expect(artifacts.descriptor).toMatchObject({
      correctionContextSupported: true,
      correctionContextRef: `attempts/${attemptTwoId}/correction-context.json`,
      correctionContextDigest: context.contextDigest,
      managedRuntimeKind: "stock-codex-cli-managed",
      managedRuntimeVersion: "0.153.4-rb.1",
      requestedModel: "gpt-5.6-sol",
      stagingRootWritable: true,
      sandboxBackendPath: "/usr/bin/bwrap",
      legacySandboxMode: "NONE",
    });
    expect(artifacts.descriptor?.managedRuntimeIdentityDigest).toBe(managedRuntime.identityDigest);
    expect(artifacts.prompt?.promptDigest).toBe(projected.promptDigest);
    expect(artifacts.workspaceDelta?.entries.map((entry) => `${entry.operation} ${entry.path}`)).toEqual(["MODIFY package.json"]);
    expect(publication?.appliedCount).toBe(1);
    expect(artifacts.providerResult).toMatchObject({ classification: "SUCCEEDED", terminalKind: "TURN_COMPLETED", actualExitCode: 0 });
    expect(artifacts.terminal).toMatchObject({ status: "SUCCEEDED", termination: "NORMAL" });
    expect(artifacts.threadBinding?.threadId).toBeTruthy();
    expect(JSON.parse(await readFile(join(fixture.projectRoot, "package.json"), "utf8"))).toEqual(EXPECTED);
    for (const root of CODEX_PROJECTION_EXCLUDED_ROOTS_V2) {
      expect(await readFile(join(fixture.projectRoot, root, "canary.txt"), "utf8")).toBe("control-plane canary\n");
    }

    // Success, publication, Evidence and green Validation leave the Finding
    // OPEN. Only the existing re-Audit below has resolution authority.
    expect((await deriveDurableCorrectionAuthorityV2(storeTwo)).findings.get(finding.id)?.status).toBe("OPEN");
    const capturedTwo = await captureEvidenceV2({ leasedRun: executorLeaseTwo, plan: fixture.plan, attemptId: attemptTwoId, observation: executedTwo.observation });
    if (capturedTwo.kind !== "EVIDENCE_CAPTURED_READY_FOR_VALIDATION") throw new Error(capturedTwo.kind);
    expect((await deriveDurableCorrectionAuthorityV2(storeTwo)).findings.get(finding.id)?.status).toBe("OPEN");
    const validatedTwo = await validateAttemptV2({
      leasedRun: await acquireLeasedRunV2({ ...fixture.leaseInput, runtimeInstanceId: "m5c-real-validate-a2" }),
      plan: fixture.plan,
      attemptId: attemptTwoId,
      executorObservation: executedTwo.observation,
    });
    if (validatedTwo.kind !== "VALIDATION_READY_FOR_AUDIT") throw new Error(validatedTwo.kind);
    expect(validatedTwo.validationSet.summary).toMatchObject({ passed: 1, failed: 0, hardNegative: false });
    expect((await deriveDurableCorrectionAuthorityV2(storeTwo)).findings.get(finding.id)?.status).toBe("OPEN");
    expect(capturedTwo.evidence.evidenceDigest).not.toBe(capturedOne.evidence.evidenceDigest);
    expect(validatedTwo.validationSet.setDigest).not.toBe(validatedOne.validationSet.setDigest);

    const auditedTwo = await auditAttemptV2({
      leasedRun: await acquireLeasedRunV2({ ...fixture.leaseInput, runtimeInstanceId: "m5c-real-audit-a2" }),
      plan: fixture.plan,
      attemptId: attemptTwoId,
      executorObservation: executedTwo.observation,
      auditor: new ScriptedAuditor({ defaultDecision: {
        verdict: "ACCEPT",
        proposedFindings: [],
        resolvedFindingRefs: [finding.id],
        rationale: "the same deterministic package-name criterion is now green",
      } }),
    });
    if (auditedTwo.kind !== "AUDIT_ACCEPTED") throw new Error(auditedTwo.kind);
    expect(auditedTwo.state.findings[finding.id]?.status).toBe("RESOLVED");
    expect(auditedTwo.state.tasks.T001?.disposition).toBe("COMPLETE");
    expect(auditedTwo.state.disposition).toBe("COMPLETE");
    expect(auditedTwo.state.hold).toBe("NONE");

    // Cold reopen and completed rerun: no second process or inference.
    const coldStore = new RalphEventStoreV2({ projectRoot: fixture.projectRoot, runId: fixture.runId });
    const cold = await acquireLeasedRunV2({ ...fixture.leaseInput, runtimeInstanceId: "m5c-real-cold-complete" });
    const coldReopenIdentical = cold.state.attempts[attemptOneId]?.closureReason === "AUDIT_REJECTED"
      && cold.state.attempts[attemptTwoId]?.closureReason === "AUDIT_ACCEPTED"
      && cold.state.findings[finding.id]?.status === "RESOLVED"
      && cold.state.tasks.T001?.disposition === "COMPLETE"
      && cold.state.disposition === "COMPLETE";
    await releaseLeasedRunV2(cold);
    expect(coldReopenIdentical).toBe(true);
    await expect(codex.invoke(admittedTwo.authorizedInvocation)).rejects.toThrow(/M5B_REDISPATCH_FORBIDDEN/);

    const events = (await coldStore.inspect()).events;
    expect(events.flatMap((event) => event.eventType === "finding.state-changed" && event.payload.finding.id === finding.id
      ? [event.payload.finding.status] : [])).toEqual(["OPEN", "CANDIDATE_RESOLVED", "RESOLVED"]);
    const controlPlaneCanariesIntact = await Promise.all(CODEX_PROJECTION_EXCLUDED_ROOTS_V2.map(async (root) =>
      (await readFile(join(fixture.projectRoot, root, "canary.txt"), "utf8")) === "control-plane canary\n"));
    const attemptArtifacts = (await Promise.all([attemptOneId, attemptTwoId].map(async (attemptId) => {
      const directory = join(coldStore.runDirectory, "attempts", attemptId);
      return (await Promise.all((await readdir(directory)).filter((file) => file.endsWith(".json")).map((file) => readFile(join(directory, file), "utf8")))).join("\n");
    }))).join("\n");
    const credentialLeakage = /Bearer\s+\S+|-----BEGIN[^-]*PRIVATE KEY-----|(?:api[_-]?key|password|secret)\s*[:=]/i.test(attemptArtifacts);
    expect(credentialLeakage).toBe(false);

    const receipt = buildCodexCorrectionAcceptanceReceiptV2({
      runId: fixture.runId,
      phaseId: coreTwo.phaseId,
      taskId: coreTwo.taskId,
      rejectedAttemptId: attemptOneId,
      correctionAttemptId: attemptTwoId,
      rejectedAttemptClosure: "AUDIT_REJECTED",
      correctionAttemptClosure: "AUDIT_ACCEPTED",
      findingId: finding.id,
      findingDigest: context.openFindings[0]!.findingDigest,
      findingFinalStatus: "RESOLVED",
      correctionContextRef: artifacts.descriptor!.correctionContextRef!,
      correctionContextDigest: context.contextDigest,
      providerDescriptorDigest: artifacts.descriptor!.descriptorDigest,
      promptDigest: artifacts.prompt!.promptDigest,
      threadId: artifacts.threadBinding!.threadId,
      managedRuntimeKind: managedRuntime.kind,
      managedRuntimeVersion: managedRuntime.version,
      managedRuntimeIdentityDigest: managedRuntime.identityDigest,
      requestedModel: artifacts.descriptor!.requestedModel,
      sandboxBackendPath: artifacts.descriptor!.sandboxBackendPath,
      permissionProfileDigest: artifacts.descriptor!.permissionProfileDigest,
      capabilityBindingDigest: artifacts.descriptor!.capabilityBindingDigest,
      stagingRootWritable: true,
      rootSentinelManifestDigest: artifacts.descriptor!.rootSentinelManifestDigest,
      deltaDigest: artifacts.workspaceDelta!.deltaDigest,
      deltaEntries: artifacts.workspaceDelta!.entries.map((entry) => `${entry.operation} ${entry.path}`),
      publicationDigest: publication!.receiptDigest,
      rejectedEvidenceDigest: capturedOne.evidence.evidenceDigest,
      correctionEvidenceDigest: capturedTwo.evidence.evidenceDigest,
      rejectedValidationSetDigest: validatedOne.validationSet.setDigest,
      correctionValidationSetDigest: validatedTwo.validationSet.setDigest,
      validationTransition: "FAIL_TO_PASS",
      taskState: "COMPLETE",
      runState: "COMPLETE",
      runHold: "NONE",
      providerInvocationCount: 1,
      retryCount: 0,
      fallbackCount: 0,
      completedRerunProviderCallDelta: 0,
      coldReopenIdentical: true,
      controlPlaneCanariesIntact: controlPlaneCanariesIntact.every(Boolean) as true,
      credentialLeakage: false,
      retainedProjectRoot: fixture.projectRoot,
      retainedRunDirectory: coldStore.runDirectory,
      retainedStagingBase: fixture.stagingBase,
      platform: "linux-x86_64",
      unqualifiedPlatforms: ["WSL2", "macOS arm64", "macOS x64", "linux arm64"],
      observedAt: new Date().toISOString(),
    });
    const written = await writeCodexCorrectionAcceptanceReceiptV2(receipt);
    expect(existsSync(fixture.projectRoot)).toBe(true);
    expect(existsSync(coldStore.runDirectory)).toBe(true);
    expect(existsSync(fixture.stagingBase)).toBe(true);

    console.log(JSON.stringify({
      stage: "m5c-real-correction",
      authorized: true,
      retention: M5C_RETENTION_NOTICE_V2,
      retainedProjectRoot: fixture.projectRoot,
      retainedRunDirectory: coldStore.runDirectory,
      retainedStagingBase: fixture.stagingBase,
      acceptanceReceiptPath: written.path,
      acceptanceReceiptDigest: written.receiptDigest,
      acceptanceReceiptFileDigest: written.fileDigest,
      runId: fixture.runId,
      rejectedAttemptId: attemptOneId,
      correctionAttemptId: attemptTwoId,
      findingId: finding.id,
      findingDigest: context.openFindings[0]!.findingDigest,
      correctionContextDigest: context.contextDigest,
      providerDescriptorDigest: artifacts.descriptor?.descriptorDigest,
      promptDigest: artifacts.prompt?.promptDigest,
      threadId: artifacts.threadBinding?.threadId,
      managedRuntimeVersion: managedRuntime.version,
      managedRuntimeIdentityDigest: managedRuntime.identityDigest,
      requestedModel: artifacts.descriptor?.requestedModel,
      deltaEntries: artifacts.workspaceDelta?.entries.map((entry) => `${entry.operation} ${entry.path}`),
      deltaDigest: artifacts.workspaceDelta?.deltaDigest,
      publicationDigest: publication?.receiptDigest,
      validationTransition: "FAIL_TO_PASS",
      findingFinalStatus: auditedTwo.state.findings[finding.id]?.status,
      taskState: auditedTwo.state.tasks.T001?.disposition,
      runState: auditedTwo.state.disposition,
      runHold: auditedTwo.state.hold,
      modelBearingCalls: 1,
      retry: false,
      fallback: false,
      completedRerunProviderCallDelta: 0,
      credentialLeakage,
      platform: "linux-x86_64",
      unqualifiedPlatforms: ["WSL2", "macOS arm64", "macOS x64", "linux arm64"],
      receiptInputDigest: sha256Canonical({ context: context.contextDigest, descriptor: artifacts.descriptor?.descriptorDigest, prompt: artifacts.prompt?.promptDigest }),
    }));
  });
});
