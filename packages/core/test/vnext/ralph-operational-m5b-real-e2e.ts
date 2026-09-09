import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireLeasedRunV2 } from "../../src/vnext/ralph-runtime/operational-b2/index.js";
import { executeAuthorizedInvocationV2 } from "../../src/vnext/ralph-runtime/operational-b4/index.js";
import { captureEvidenceV2 } from "../../src/vnext/ralph-runtime/operational-c/index.js";
import { validateAttemptV2 } from "../../src/vnext/ralph-runtime/operational-d/index.js";
import { ScriptedAuditor, auditAttemptV2 } from "../../src/vnext/ralph-runtime/operational-e/index.js";
import { RalphEventStoreV2 } from "../../src/vnext/ralph-runtime/operational-b1/index.js";
import { fingerprintWorkspace } from "../../src/vnext/ralph-runtime/fingerprint.js";
import {
  CODEX_CLI_EXECUTOR_PROFILE_V2,
  CODEX_CLI_EXECUTOR_REQUESTED_MODEL_V2,
  CODEX_CLI_NATIVE_EXECUTABLE_PATH_V2,
} from "../../src/vnext/ralph-runtime/operational-m5b/contract.js";
import {
  CODEX_CLI_CAPABILITY_RECORD_V2,
  assertCodexRealInferenceGateV2,
} from "../../src/vnext/ralph-runtime/operational-m5b/codex-capability.js";
import { assertCodexPhysicalCapabilityV2, probeCodexPhysicalCapabilityV2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-credential-boundary.js";
import { inspectCodexSandboxBackendV2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-sandbox-backend.js";
import { inspectManagedCodexRuntimeV2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-process.js";
import { assertCodexManagedRuntimeV2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-managed-runtime.js";
import { createCodexCliExecutorV2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-cli-executor.js";
import { readCodexInvocationArtifactSetV2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-artifacts.js";
import { readCodexPublicationReceiptV2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-publication.js";
import { CODEX_PROJECTION_EXCLUDED_ROOTS_V2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-projection.js";
import {
  M5B_RETENTION_NOTICE_V2,
  buildCodexAcceptanceReceiptV2,
  writeCodexAcceptanceReceiptV2,
} from "../../src/vnext/ralph-runtime/operational-m5b/codex-acceptance-receipt.js";
import { admitM5BAttemptV2, bootstrapM5BRunV2 } from "./fixtures/ralph-m5b-fixture.js";

if (process.env.RB_RALPH_M5B_REAL_E2E !== "1") {
  throw new Error("M5-B real E2E is opt-in; set RB_RALPH_M5B_REAL_E2E=1 explicitly");
}

const EXECUTION_TIMEOUT_MS = 600_000;

/**
 * The acceptance task deliberately targets a ROOT-LEVEL product file.
 *
 * The previous acceptance only ever wrote `src/status.js`, which a read-only
 * staging root already permitted — it could not have shown the MAJOR fixed.
 * `package.json` exercises root write authority, sentinel control-plane
 * protection, host delta scope enforcement and sealed publication with no
 * source-subdirectory loophole anywhere in the path.
 */
const PACKAGE_JSON_NAME = "rb-m5b-probe";

describe("Ralph M5-B — opt-in real stock Codex CLI Executor", () => {
  it("verifies the exact managed stock runtime identity", async () => {
    const { executable, managedRuntime } = await inspectManagedCodexRuntimeV2(120_000);
    expect(executable).toMatchObject({
      executablePath: CODEX_CLI_NATIVE_EXECUTABLE_PATH_V2,
      executableVersion: "0.153.4",
      executableSizeBytes: 258_659_424,
    });
    expect(managedRuntime).toMatchObject({
      kind: "stock-codex-cli-managed",
      version: "0.153.4-rb.1",
      upstreamVersion: "0.153.4",
      rbRevision: "rb.1",
      transport: "codex-exec",
      reportedIdentity: "codex-cli 0.153.4",
    });
    // A global Codex upgrade must be unable to reach this Executor at all.
    expect(managedRuntime.executablePath).toContain("/.local/libexec/rb-harness/codex-cli/0.153.4-rb.1/");
    expect(managedRuntime.executablePath).not.toContain("/.nvm/");
    console.log(JSON.stringify({ stage: "managed-runtime-identity", ...managedRuntime }));
  }, 180_000);

  it("requires the system bwrap under the pinned parent PATH", async () => {
    const backend = await inspectCodexSandboxBackendV2();
    expect(backend).toMatchObject({ backendPath: "/usr/bin/bwrap", bundledFallbackSelected: false });
    console.log(JSON.stringify({ stage: "sandbox-backend", ...backend }));
  }, 60_000);

  it("probes the physical capability boundary without reading a credential byte", async () => {
    const report = await probeCodexPhysicalCapabilityV2({ deadlineMs: 300_000 });
    // Metadata only: the probe opens and immediately closes the handle. It
    // never reads, prints or hashes credential content.
    console.log(JSON.stringify({ stage: "capability-probe", ...report }));
    expect(report.credentialFileBoundary).toBe("DENIED");
    expect(report.stagingWriteCapability).toBe("PROVEN");
    expect(report.controlPlaneDenialCapability).toBe("PROVEN");
    expect(report.networkDenialCapability).toBe("PROVEN");
    expect(report.shellEnvironmentIsolationCapability).toBe("PROVEN");
    // The root-scope attack matrix, exercised without a model.
    expect(report.rootProductWriteCapability).toBe("PROVEN");
    expect(report.rootSentinelDenialCapability).toBe("PROVEN");
    expect(report.rootAttackCount).toBe(CODEX_PROJECTION_EXCLUDED_ROOTS_V2.length * 8);
    expect(() => assertCodexPhysicalCapabilityV2(report)).not.toThrow();
  }, 600_000);

  it("drives exactly one fresh root-scope codex exec through Evidence, Validation and ScriptedAudit", async () => {
    // Hard gate: unless the provider tool sandbox is physically denied the
    // credential file, zero model-bearing calls are authorized. The Executor
    // cannot be constructed, so no `codex exec` can be spawned from here.
    if (CODEX_CLI_CAPABILITY_RECORD_V2.credentialFileSandboxBoundary !== "DENIED") {
      const blocked = await bootstrapM5BRunV2({ deadlineMs: EXECUTION_TIMEOUT_MS });
      try {
        const { admitted } = await admitM5BAttemptV2(blocked);
        await expect(createCodexCliExecutorV2({
          store: blocked.store,
          authorizedInvocation: admitted.authorizedInvocation,
          timeoutPolicy: blocked.timeoutPolicy,
          stagingBase: blocked.stagingBase,
        })).rejects.toThrow(/M5B_CREDENTIAL_FILE_BOUNDARY_UNSAFE/);
        console.log(JSON.stringify({
          stage: "real-inference",
          authorized: false,
          modelBearingCalls: 0,
          reason: `credential-file boundary is ${CODEX_CLI_CAPABILITY_RECORD_V2.credentialFileSandboxBoundary}`,
        }));
      } finally {
        await rm(blocked.projectRoot, { recursive: true, force: true });
        await rm(blocked.stagingBase, { recursive: true, force: true });
      }
      return;
    }

    // A brand-new disposable canonical project: README.md, src/ and one
    // control-plane canary per Core-owned root.
    const fixture = await bootstrapM5BRunV2({
      deadlineMs: EXECUTION_TIMEOUT_MS,
      scope: "package.json",
      covers: "package.json",
      title: "Create the root package manifest",
      change: `Create package.json at the workspace root containing exactly {"name":"${PACKAGE_JSON_NAME}","private":true}`,
      acceptanceCriteria: [`package.json parses as JSON with name ${PACKAGE_JSON_NAME} and private true`],
      validation: [`\`node -e 'const p=require("./package.json"); if (p.name !== "${PACKAGE_JSON_NAME}" || p.private !== true) process.exit(1)'\``],
      expectedEvidence: "A real workspace delta creating only package.json at the workspace root",
    });
    const canonicalPre = await fingerprintWorkspace(fixture.projectRoot, fixture.snapshot.workspacePolicy);
    const { admitted } = await admitM5BAttemptV2(fixture);
    const executorLease = await acquireLeasedRunV2(fixture.leaseInput);
    const managedRuntime = await assertCodexManagedRuntimeV2({ probeTimeoutMs: 120_000 });
    const executor = await createCodexCliExecutorV2({
      store: fixture.store,
      authorizedInvocation: admitted.authorizedInvocation,
      timeoutPolicy: fixture.timeoutPolicy,
      stagingBase: fixture.stagingBase,
    });
    const executed = await executeAuthorizedInvocationV2({
      leasedRun: executorLease,
      plan: fixture.plan,
      planIdentity: fixture.plan.artifactId,
      planDigest: fixture.planDigest,
      attemptId: fixture.attemptId,
      runtime: executor,
    });
    expect(executed.kind).toBe("EXECUTOR_FINISHED_READY_FOR_CAPTURE");
    if (executed.kind !== "EXECUTOR_FINISHED_READY_FOR_CAPTURE") throw new Error(`real M5-B execution failed closed: ${executed.kind}`);

    const artifacts = await readCodexInvocationArtifactSetV2(fixture.store, fixture.attemptId);
    const publication = await readCodexPublicationReceiptV2(fixture.store, fixture.attemptId);
    expect(artifacts.descriptor).toMatchObject({
      executorProfileIdentity: CODEX_CLI_EXECUTOR_PROFILE_V2,
      requestedModel: CODEX_CLI_EXECUTOR_REQUESTED_MODEL_V2,
      observedModelState: "UNAVAILABLE",
      legacySandboxMode: "NONE",
      permissionProfileName: "ralph_m5b",
      sandboxBackendPath: "/usr/bin/bwrap",
      managedRuntimeKind: "stock-codex-cli-managed",
      managedRuntimeVersion: "0.153.4-rb.1",
      // The root-scope binding this whole remediation exists to make possible.
      stagingRootWritable: true,
    });
    expect(artifacts.descriptor?.managedRuntimeIdentityDigest).toBe(managedRuntime.identityDigest);
    expect(artifacts.projectionManifest?.sentinels.map((entry) => entry.path)).toEqual([...CODEX_PROJECTION_EXCLUDED_ROOTS_V2].sort());
    expect(artifacts.providerResult).toMatchObject({ classification: "SUCCEEDED", terminalKind: "TURN_COMPLETED", actualExitCode: 0 });

    // Exactly the root product the scope covers, and nothing beside it.
    expect(artifacts.workspaceDelta?.entries.map((entry) => `${entry.operation} ${entry.path}`)).toEqual(["CREATE package.json"]);
    expect(publication?.appliedCount).toBe(1);
    const manifest = JSON.parse(await readFile(join(fixture.projectRoot, "package.json"), "utf8")) as Record<string, unknown>;
    expect(manifest.name).toBe(PACKAGE_JSON_NAME);
    expect(manifest.private).toBe(true);
    // No sentinel path ever reached the delta or the publication.
    for (const entry of artifacts.workspaceDelta?.entries ?? []) {
      expect(CODEX_PROJECTION_EXCLUDED_ROOTS_V2).not.toContain(entry.path.split("/")[0]);
    }
    for (const controlRoot of CODEX_PROJECTION_EXCLUDED_ROOTS_V2) {
      expect(await readFile(join(fixture.projectRoot, controlRoot, "canary.txt"), "utf8")).toBe("control-plane canary\n");
    }

    const captured = await captureEvidenceV2({ leasedRun: executorLease, plan: fixture.plan, attemptId: fixture.attemptId, observation: executed.observation });
    expect(captured.kind).toBe("EVIDENCE_CAPTURED_READY_FOR_VALIDATION");
    if (captured.kind !== "EVIDENCE_CAPTURED_READY_FOR_VALIDATION") throw new Error(captured.kind);
    expect(captured.evidence.controlPlaneChangedPaths).toEqual([]);

    const validated = await validateAttemptV2({ leasedRun: await acquireLeasedRunV2(fixture.leaseInput), plan: fixture.plan, attemptId: fixture.attemptId, executorObservation: executed.observation });
    expect(validated.kind).toBe("VALIDATION_READY_FOR_AUDIT");
    if (validated.kind !== "VALIDATION_READY_FOR_AUDIT") throw new Error(validated.kind);

    const auditor = new ScriptedAuditor({ defaultDecision: { verdict: "ACCEPT", rationale: "deterministic validation and Evidence are green" } });
    const audited = await auditAttemptV2({ leasedRun: await acquireLeasedRunV2(fixture.leaseInput), plan: fixture.plan, attemptId: fixture.attemptId, executorObservation: executed.observation, auditor });
    expect(audited.kind).toBe("AUDIT_ACCEPTED");
    if (audited.kind !== "AUDIT_ACCEPTED") throw new Error(audited.kind);
    expect(audited.state.disposition).toBe("COMPLETE");

    const directory = join(fixture.store.runDirectory, "attempts", fixture.attemptId);
    const persisted = (await Promise.all((await readdir(directory)).filter((file) => file.endsWith(".json")).map((file) => readFile(join(directory, file), "utf8")))).join("\n");
    expect(persisted).not.toMatch(/Bearer\s+\S+|-----BEGIN[^-]*PRIVATE KEY-----|(?:api[_-]?key|password|secret)\s*[:=]/i);

    // A cold reopen must reproduce the same durable state with no new call.
    const reopened = new RalphEventStoreV2({ projectRoot: fixture.projectRoot, runId: fixture.runId });
    const reread = await readCodexInvocationArtifactSetV2(reopened, fixture.attemptId);
    const coldReopenIdentical = reread.descriptor?.descriptorDigest === artifacts.descriptor?.descriptorDigest
      && reread.workspaceDelta?.deltaDigest === artifacts.workspaceDelta?.deltaDigest
      && reread.terminal?.terminalDigest === artifacts.terminal?.terminalDigest;
    expect(coldReopenIdentical).toBe(true);
    // A completed rerun adds no provider call: redispatch is refused outright.
    await expect(executor.invoke(admitted.authorizedInvocation)).rejects.toThrow(/M5B_REDISPATCH_FORBIDDEN/);

    const canonicalPost = await fingerprintWorkspace(fixture.projectRoot, fixture.snapshot.workspacePolicy);

    // The bounded, credential-scanned, digest-sealed acceptance receipt. It is
    // refused unless it is consistent with the durable Run it describes.
    const receipt = buildCodexAcceptanceReceiptV2({
      runId: fixture.runId,
      phaseId: admitted.authorizedInvocation.descriptor.phaseId,
      taskId: admitted.authorizedInvocation.descriptor.taskId,
      attemptId: fixture.attemptId,
      invocationId: admitted.authorizedInvocation.descriptor.invocationId,
      managedRuntimeKind: managedRuntime.kind,
      managedRuntimeVersion: managedRuntime.version,
      managedRuntimeIdentityDigest: managedRuntime.identityDigest,
      permissionProfileName: artifacts.descriptor!.permissionProfileName,
      permissionProfileDigest: artifacts.descriptor!.permissionProfileDigest,
      permissionPolicyShapeDigest: artifacts.descriptor!.permissionPolicyShapeDigest,
      capabilityRecordDigest: artifacts.descriptor!.capabilityRecordDigest,
      capabilityBindingDigest: artifacts.descriptor!.capabilityBindingDigest,
      sandboxBackendPath: artifacts.descriptor!.sandboxBackendPath,
      legacySandboxMode: artifacts.descriptor!.legacySandboxMode,
      requestedModel: artifacts.descriptor!.requestedModel,
      observedModelState: artifacts.descriptor!.observedModelState,
      observedModel: artifacts.descriptor!.observedModel,
      threadId: artifacts.threadBinding!.threadId,
      scopeToken: "package.json",
      stagingRootWritable: artifacts.descriptor!.stagingRootWritable,
      writeRootPlanDigest: artifacts.descriptor!.writeRootPlanDigest,
      rootSentinelManifestDigest: artifacts.descriptor!.rootSentinelManifestDigest,
      sentinelPostCheck: "INTACT",
      projectionManifestDigest: artifacts.projectionManifest!.manifestDigest,
      promptDigest: artifacts.prompt!.promptDigest,
      actualExitCode: artifacts.providerResult!.actualExitCode,
      actualSignal: artifacts.providerResult!.actualSignal,
      terminalKind: artifacts.providerResult!.terminalKind,
      terminalStatus: artifacts.terminal!.status,
      termination: artifacts.terminal!.termination,
      processState: artifacts.terminal!.quiescence.processState,
      processTreeState: artifacts.terminal!.quiescence.processTreeState,
      settlementQuiescent: artifacts.terminal!.quiescence.settlementQuiescent,
      deltaDigest: artifacts.workspaceDelta!.deltaDigest,
      deltaEntries: artifacts.workspaceDelta!.entries.map((entry) => `${entry.operation} ${entry.path}`),
      publicationDigest: publication!.receiptDigest,
      publicationAppliedCount: publication!.appliedCount,
      canonicalPreFingerprint: canonicalPre.fingerprintDigest,
      canonicalPostFingerprint: canonicalPost.fingerprintDigest,
      canonicalPreControlPlaneFingerprint: canonicalPre.controlPlaneFingerprint,
      canonicalPostControlPlaneFingerprint: canonicalPost.controlPlaneFingerprint,
      controlPlaneCanariesIntact: canonicalPre.controlPlaneFingerprint === canonicalPost.controlPlaneFingerprint,
      evidenceDigest: captured.evidence.evidenceDigest,
      validationSetDigest: validated.validationSet.setDigest,
      auditResultDigest: audited.auditResult.resultDigest,
      attemptClosure: "AUDIT_ACCEPTED",
      taskState: audited.state.tasks[admitted.authorizedInvocation.descriptor.taskId]!.disposition,
      runState: audited.state.disposition,
      providerInvocationCount: 1,
      retryCount: 0,
      fallbackCount: 0,
      coldReopenIdentical,
      completedRerunProviderCallDelta: 0,
      retainedProjectRoot: fixture.projectRoot,
      retainedRunDirectory: fixture.store.runDirectory,
      observedAt: new Date().toISOString(),
    });
    const written = await writeCodexAcceptanceReceiptV2(receipt);

    // The disposable run is deliberately RETAINED. An independent audit must
    // be able to reconstruct this accepted physical run without any new
    // inference, and that is impossible once /tmp has been cleaned.
    expect(existsSync(fixture.projectRoot)).toBe(true);
    expect(existsSync(fixture.store.runDirectory)).toBe(true);

    console.log(JSON.stringify({
      stage: "real-inference",
      authorized: true,
      retention: M5B_RETENTION_NOTICE_V2,
      retainedProjectRoot: fixture.projectRoot,
      retainedRunDirectory: fixture.store.runDirectory,
      retainedStagingBase: fixture.stagingBase,
      acceptanceReceiptPath: written.path,
      acceptanceReceiptDigest: written.receiptDigest,
      acceptanceReceiptFileDigest: written.fileDigest,
      runId: fixture.runId,
      attemptId: fixture.attemptId,
      coreInvocationId: admitted.authorizedInvocation.descriptor.invocationId,
      threadId: artifacts.threadBinding?.threadId,
      managedRuntimeIdentityDigest: managedRuntime.identityDigest,
      managedRuntimePath: managedRuntime.executablePath,
      requestedModel: CODEX_CLI_EXECUTOR_REQUESTED_MODEL_V2,
      observedModelState: "UNAVAILABLE",
      modelBearingCalls: 1,
      retry: false,
      fallback: false,
      scopeToken: "package.json",
      stagingRootWritable: artifacts.descriptor?.stagingRootWritable,
      writeRootPlanDigest: artifacts.descriptor?.writeRootPlanDigest,
      rootSentinelManifestDigest: artifacts.descriptor?.rootSentinelManifestDigest,
      promptDigest: artifacts.prompt?.promptDigest,
      permissionProfileDigest: artifacts.descriptor?.permissionProfileDigest,
      permissionPolicyShapeDigest: artifacts.descriptor?.permissionPolicyShapeDigest,
      capabilityBindingDigest: artifacts.descriptor?.capabilityBindingDigest,
      sandboxBackendPath: artifacts.descriptor?.sandboxBackendPath,
      legacySandboxMode: artifacts.descriptor?.legacySandboxMode,
      actualExitCode: artifacts.providerResult?.actualExitCode,
      terminalKind: artifacts.providerResult?.terminalKind,
      projectionManifestDigest: artifacts.projectionManifest?.manifestDigest,
      deltaEntries: artifacts.workspaceDelta?.entries.map((entry) => `${entry.operation} ${entry.path}`),
      deltaDigest: artifacts.workspaceDelta?.deltaDigest,
      publicationDigest: publication?.receiptDigest,
      evidenceDigest: captured.evidence.evidenceDigest,
      validationSetDigest: validated.validationSet.setDigest,
      auditResultDigest: audited.auditResult.resultDigest,
      audit: audited.kind,
      runState: audited.state.disposition,
      coldReopenIdentical,
      credentialLeakage: false,
    }));
  }, EXECUTION_TIMEOUT_MS + 300_000);
});
