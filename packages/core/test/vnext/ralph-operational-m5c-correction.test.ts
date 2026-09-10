import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Deterministic physical Codex transport; it never calls a model. */
const transport = vi.hoisted(() => ({
  runs: 0,
  spawns: 0,
  prompts: [] as string[],
  argvs: [] as string[][],
  cwds: [] as string[],
  threadId: "thr_m5cFreshCorrection0002",
  behavior: (async () => undefined) as (prompt: string, cwd: string) => Promise<void>,
}));

vi.mock("../../src/vnext/ralph-runtime/operational-m5b/codex-sandbox-backend.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/vnext/ralph-runtime/operational-m5b/codex-sandbox-backend.js")>();
  const { sha256Canonical } = await import("../../src/vnext/ralph-runtime/hashing.js");
  const base = {
    backendPath: actual.CODEX_SYSTEM_SANDBOX_BACKEND_PATH_V2,
    resolvedFromPath: actual.CODEX_PARENT_PATH_V2,
    executable: true as const,
    bundledFallbackSelected: false as const,
  };
  return { ...actual, inspectCodexSandboxBackendV2: vi.fn(async () => Object.freeze({ ...base, factsDigest: sha256Canonical(base) })) };
});

vi.mock("../../src/vnext/ralph-runtime/operational-m5b/codex-credential-boundary.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/vnext/ralph-runtime/operational-m5b/codex-credential-boundary.js")>();
  const { sha256Canonical } = await import("../../src/vnext/ralph-runtime/hashing.js");
  const profile = await import("../../src/vnext/ralph-runtime/operational-m5b/codex-permission-profile.js");
  const base = {
    schema: actual.CODEX_CAPABILITY_PROBE_SCHEMA_V2,
    credentialFileBoundary: "DENIED" as const,
    stagingWriteCapability: "PROVEN" as const,
    controlPlaneDenialCapability: "PROVEN" as const,
    networkDenialCapability: "PROVEN" as const,
    shellEnvironmentIsolationCapability: "PROVEN" as const,
    permissionProfileDigest: `sha256:${"c".repeat(64)}`,
    permissionPolicyShapeDigest: profile.CODEX_REQUIRED_PERMISSION_POLICY_SHAPE_V2,
    probeExitCode: 0,
    rootProductWriteCapability: "PROVEN" as const,
    rootSentinelDenialCapability: "PROVEN" as const,
    rootPermissionProfileDigest: `sha256:${"d".repeat(64)}`,
    rootPermissionPolicyShapeDigest: profile.CODEX_REQUIRED_ROOT_PERMISSION_POLICY_SHAPE_V2,
    rootSentinelCount: 3,
    rootAttackCount: 24,
    rootMatrixDigest: `sha256:${"e".repeat(64)}`,
    rootProbeExitCode: 0,
    observedAt: "2026-09-09T12:00:00.000Z",
  };
  return { ...actual, probeCodexPhysicalCapabilityV2: vi.fn(async () => Object.freeze({ ...base, reportDigest: sha256Canonical(base) })) };
});

vi.mock("../../src/vnext/ralph-runtime/operational-m5b/codex-process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/vnext/ralph-runtime/operational-m5b/codex-process.js")>();
  const contract = await import("../../src/vnext/ralph-runtime/operational-m5b/contract.js");
  const managed = await import("../../src/vnext/ralph-runtime/operational-m5b/codex-managed-runtime.js");
  const stock = await import("../../src/managed-stock-codex-runtime.js");
  const { defaultProcessIdentityProvider } = await import("../../src/vnext/ralph-runtime/operational-b2/process-identity.js");
  return {
    ...actual,
    inspectManagedCodexRuntimeV2: vi.fn(async () => Object.freeze({
      executable: Object.freeze({
        executablePath: contract.CODEX_CLI_NATIVE_EXECUTABLE_PATH_V2,
        executableVersion: contract.CODEX_CLI_EXECUTOR_CLI_VERSION_V2,
        executableSizeBytes: contract.CODEX_CLI_NATIVE_EXECUTABLE_SIZE_BYTES_V2,
        executableSha256: contract.CODEX_CLI_NATIVE_EXECUTABLE_SHA256_V2,
      }),
      managedRuntime: Object.freeze({
        schema: managed.CODEX_MANAGED_RUNTIME_SCHEMA_V2,
        kind: managed.MANAGED_STOCK_CODEX_RUNTIME_KIND,
        runtimeId: managed.CODEX_MANAGED_RUNTIME_V2.id,
        upstreamVersion: managed.CODEX_MANAGED_RUNTIME_V2.upstreamVersion,
        rbRevision: managed.CODEX_MANAGED_RUNTIME_V2.rbRevision,
        version: managed.CODEX_MANAGED_RUNTIME_V2.version,
        transport: "codex-exec" as const,
        executablePath: contract.CODEX_CLI_NATIVE_EXECUTABLE_PATH_V2,
        executableSizeBytes: contract.CODEX_CLI_NATIVE_EXECUTABLE_SIZE_BYTES_V2,
        executableSha256: contract.CODEX_CLI_NATIVE_EXECUTABLE_SHA256_V2.replace(/^sha256:/, ""),
        reportedIdentity: managed.CODEX_MANAGED_RUNTIME_V2.expectedIdentity,
        payloadEntryCount: 6,
        payloadDigest: stock.managedStockCodexPayloadDigest(managed.STOCK_CODEX_CLI_RUNTIME.platforms["linux-x86_64"]!.payload),
        identityDigest: managed.codexManagedRuntimeExpectedIdentityDigestV2(),
      }),
    })),
    runCodexProcessV2: vi.fn(async (input: Parameters<typeof actual.runCodexProcessV2>[0]) => {
      transport.runs += 1;
      transport.spawns += 1;
      transport.prompts.push(input.stdin);
      transport.argvs.push([...input.argv]);
      transport.cwds.push(input.cwd);
      const host = await defaultProcessIdentityProvider.current();
      const processIdentity = Object.freeze({ ...host, pid: 4_194_301, processStartIdentity: `sha256:${"a".repeat(64)}` });
      await input.onSpawned?.(Object.freeze({
        processIdentity,
        processGroupId: processIdentity.pid,
        containmentKind: "cgroup2",
        containmentStructural: true,
        startedAt: "2026-09-09T12:00:01.000Z",
      }));
      await transport.behavior(input.stdin, input.cwd);
      const result = '{"summary":"workspace correction attempted; Core decides outcomes"}';
      const outputIndex = input.argv.indexOf("-o");
      await writeFile(input.argv[outputIndex + 1]!, result, { mode: 0o600 });
      const lines = [
        JSON.stringify({ type: "thread.started", thread_id: transport.threadId }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({ type: "item.completed", item: { id: "item_1", item_type: "command_execution", command: "inspect and edit package.json", exit_code: 0 } }),
        JSON.stringify({ type: "item.completed", item: { id: "item_2", item_type: "agent_message", text: result } }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20 } }),
      ];
      let stdout = "";
      for (const line of lines) {
        const chunk = `${line}\n`;
        stdout += chunk;
        input.onStdoutChunk?.(chunk);
      }
      return Object.freeze({
        processIdentity,
        processGroupId: processIdentity.pid,
        containmentKind: "cgroup2",
        containmentStructural: true,
        startedAt: "2026-09-09T12:00:01.000Z",
        finishedAt: "2026-09-09T12:00:02.000Z",
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
        stdout,
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        settlement: Object.freeze({
          observed: true,
          quiescent: true,
          verified: true,
          survivors: [],
          containment: { kind: "cgroup2", structural: true, reason: "fixture" },
        }),
      });
    }),
  };
});

import type { Finding } from "../../src/vnext/ralph-runtime/contracts.js";
import {
  RalphEventStoreV2,
  commitRalphEventV2,
} from "../../src/vnext/ralph-runtime/operational-b1/index.js";
import {
  acquireLeasedRunV2,
  releaseLeasedRunV2,
} from "../../src/vnext/ralph-runtime/operational-b2/index.js";
import { prepareNextAuthorizedInvocationV2 } from "../../src/vnext/ralph-runtime/operational-b3/index.js";
import {
  ScriptedExecutor,
  buildExactCorrectionContextV2,
  deriveDurableCorrectionAuthorityV2,
  executeAuthorizedInvocationV2,
} from "../../src/vnext/ralph-runtime/operational-b4/index.js";
import { captureEvidenceV2 } from "../../src/vnext/ralph-runtime/operational-c/index.js";
import { validateAttemptV2 } from "../../src/vnext/ralph-runtime/operational-d/index.js";
import { ScriptedAuditor, auditAttemptV2 } from "../../src/vnext/ralph-runtime/operational-e/index.js";
import {
  createCorrectionContextV2,
  persistCorrectionContextV2,
  type CorrectionContextV2,
} from "../../src/vnext/ralph-runtime/operational-f/index.js";
import { fingerprintWorkspace } from "../../src/vnext/ralph-runtime/fingerprint.js";
import { sha256, sha256Canonical } from "../../src/vnext/ralph-runtime/hashing.js";
import { createCodexCliExecutorV2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-cli-executor.js";
import {
  persistCodexProviderResultV2,
  persistCodexThreadBindingV2,
  readCodexInvocationArtifactSetV2,
  sealCodexArtifactV2,
  type CodexProviderResultV2,
  type CodexThreadBindingV2,
} from "../../src/vnext/ralph-runtime/operational-m5b/codex-artifacts.js";
import {
  resolveExactCodexCorrectionContextV2,
  validateExactCodexCorrectionDescriptorV2,
} from "../../src/vnext/ralph-runtime/operational-m5b/codex-correction.js";
import { projectWorkUnitToCodexPromptV2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-prompt.js";
import { readCodexPublicationReceiptV2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-publication.js";
import { CODEX_PROJECTION_EXCLUDED_ROOTS_V2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-projection.js";
import {
  admitM5BAttemptV2,
  bootstrapM5BRunV2,
  m5bEvent,
  type M5BFixtureV2,
} from "./fixtures/ralph-m5b-fixture.js";

const EXPECTED = Object.freeze({ name: "rb-m5c-probe", private: true });
const DEFECTIVE = Object.freeze({ name: "wrong-name", private: true });
const disposables: M5BFixtureV2[] = [];

beforeEach(() => {
  transport.runs = 0;
  transport.spawns = 0;
  transport.prompts = [];
  transport.argvs = [];
  transport.cwds = [];
  transport.threadId = "thr_m5cFreshCorrection0002";
  transport.behavior = async () => undefined;
});

afterEach(async () => {
  for (const fixture of disposables.splice(0)) {
    await rm(fixture.projectRoot, { recursive: true, force: true });
    await rm(fixture.stagingBase, { recursive: true, force: true });
  }
});

async function fixture(label: string, maxTaskAttemptsPerTask = 2): Promise<M5BFixtureV2> {
  const value = await bootstrapM5BRunV2({
    maxTaskAttemptsPerTask,
    scope: "package.json",
    covers: "package.json",
    scopePaths: ["package.json"],
    coversPaths: ["package.json"],
    title: `M5-C root correction ${label}`,
    change: `Make root package.json equal ${JSON.stringify(EXPECTED)}`,
    acceptanceCriteria: ["package.json has name rb-m5c-probe and private true"],
    validation: ["`node -e 'const p=require(\"./package.json\"); if (p.name !== \"rb-m5c-probe\" || p.private !== true) process.exit(1)'`"],
    expectedEvidence: "A bounded MODIFY package.json delta correcting the exact rejected Finding",
  });
  disposables.push(value);
  return value;
}

async function checkpointRejectedWorkspace(value: M5BFixtureV2, attemptId: string): Promise<void> {
  const leased = await acquireLeasedRunV2({ ...value.leaseInput, runtimeInstanceId: `m5c-checkpoint-${attemptId}` });
  try {
    const observed = await fingerprintWorkspace(value.projectRoot, value.snapshot.workspacePolicy);
    await commitRalphEventV2({
      store: leased.store,
      state: leased.state,
      event: m5bEvent(leased.state, "workspace.checkpointed", {
        checkpoint: {
          kind: "acceptedCheckpointFingerprint",
          fingerprintDigest: observed.fingerprintDigest,
          emittedAt: "2026-09-09T12:10:00.000Z",
          attemptId,
          evidenceSetId: leased.state.attempts[attemptId]?.evidenceCapture?.evidenceCaptureId,
        },
      }),
      writtenAt: "2026-09-09T12:10:00.000Z",
      nonce: `m5c-checkpoint-${attemptId}`,
    });
  } finally {
    await releaseLeasedRunV2(leased);
  }
}

interface RejectedStage {
  readonly fixture: M5BFixtureV2;
  readonly attemptId: string;
  readonly invocationId: string;
  readonly evidenceId: string;
  readonly evidenceDigest: string;
  readonly validationSetDigest: string;
  readonly finding: Finding;
}

async function deterministicRejectedAttempt(value: M5BFixtureV2, label: string): Promise<RejectedStage> {
  const attemptId = `attempt-m5c-${label}-a1`;
  const { admitted } = await admitM5BAttemptV2(value, attemptId);
  const executorLease = await acquireLeasedRunV2({ ...value.leaseInput, runtimeInstanceId: `m5c-scripted-${label}` });
  const executor = new ScriptedExecutor({
    defaultScenario: {
      kind: "SUCCESS",
      fixtureWorkspaceAction: async () => writeFile(join(value.projectRoot, "package.json"), `${JSON.stringify(DEFECTIVE, null, 2)}\n`),
    },
  });
  const executed = await executeAuthorizedInvocationV2({
    leasedRun: executorLease,
    plan: value.plan,
    planIdentity: value.plan.artifactId,
    planDigest: value.planDigest,
    attemptId,
    runtime: executor,
  });
  if (executed.kind !== "EXECUTOR_FINISHED_READY_FOR_CAPTURE") throw new Error(`M5C deterministic execution: ${executed.kind}`);
  const captured = await captureEvidenceV2({ leasedRun: executorLease, plan: value.plan, attemptId, observation: executed.observation });
  if (captured.kind !== "EVIDENCE_CAPTURED_READY_FOR_VALIDATION") throw new Error(captured.kind);
  const validated = await validateAttemptV2({
    leasedRun: await acquireLeasedRunV2({ ...value.leaseInput, runtimeInstanceId: `m5c-validation-${label}` }),
    plan: value.plan,
    attemptId,
    executorObservation: executed.observation,
  });
  if (validated.kind !== "VALIDATION_READY_FOR_AUDIT") throw new Error(validated.kind);
  expect(validated.validationSet.summary).toMatchObject({ passed: 0, failed: 1, hardNegative: true });
  const audited = await auditAttemptV2({
    leasedRun: await acquireLeasedRunV2({ ...value.leaseInput, runtimeInstanceId: `m5c-audit-${label}` }),
    plan: value.plan,
    attemptId,
    executorObservation: executed.observation,
    auditor: new ScriptedAuditor({ defaultDecision: { verdict: "REJECT", proposedFindings: [], resolvedFindingRefs: [], rationale: "exact package name validation failed" } }),
  });
  if (audited.kind !== "AUDIT_REJECTED") throw new Error(audited.kind);
  const findings = Object.values(audited.state.findings);
  expect(findings).toHaveLength(1);
  expect(audited.attempt.closureReason).toBe("AUDIT_REJECTED");
  expect(audited.state.tasks.T001?.disposition).not.toBe("COMPLETE");
  await checkpointRejectedWorkspace(value, attemptId);
  return {
    fixture: value,
    attemptId,
    invocationId: admitted.authorizedInvocation.descriptor.invocationId,
    evidenceId: validated.validationSet.evidenceCaptureId,
    evidenceDigest: captured.evidence.evidenceDigest,
    validationSetDigest: validated.validationSet.setDigest,
    finding: findings[0]!,
  };
}

interface CorrectionStage extends RejectedStage {
  readonly attemptTwoId: string;
  readonly store: RalphEventStoreV2;
  readonly authorizedInvocation: Awaited<ReturnType<typeof admitM5BAttemptV2>>["admitted"]["authorizedInvocation"];
  readonly context: CorrectionContextV2;
}

async function correctionStage(label: string, persist = true): Promise<CorrectionStage> {
  const value = await fixture(label);
  const first = await deterministicRejectedAttempt(value, label);
  // Fresh runtime objects reconstruct only from the durable run and product.
  const store = new RalphEventStoreV2({ projectRoot: value.projectRoot, runId: value.runId });
  const attemptTwoId = `attempt-m5c-${label}-a2`;
  const { admitted } = await admitM5BAttemptV2(value, attemptTwoId);
  const core = admitted.authorizedInvocation.descriptor;
  const context = await buildExactCorrectionContextV2({
    store,
    runId: core.runId,
    phaseId: core.phaseId,
    taskId: core.taskId,
    attemptId: core.attemptId,
    baseWorkspaceFingerprint: core.attemptBaseFingerprint,
    createdAt: "2026-09-09T12:11:00.000Z",
  });
  if (!context) throw new Error("M5C correction context missing");
  if (persist) await persistCorrectionContextV2(store, context, `m5c-context-${label}`);
  return { ...first, attemptTwoId, store, authorizedInvocation: admitted.authorizedInvocation, context };
}

function rebuild(context: CorrectionContextV2, overrides: Partial<Parameters<typeof createCorrectionContextV2>[0]>): CorrectionContextV2 {
  return createCorrectionContextV2({
    runId: context.runId,
    phaseId: context.phaseId,
    taskId: context.taskId,
    currentAttemptId: context.currentAttemptId,
    sourceRejectedAttempts: context.sourceRejectedAttempts,
    openFindingRefs: context.openFindingRefs,
    openFindings: context.openFindings,
    baseWorkspaceFingerprint: context.baseWorkspaceFingerprint,
    createdAt: context.createdAt,
    ...overrides,
  });
}

describe("Ralph M5-C — real Finding-driven Codex correction consumer (deterministic)", () => {
  it("M5C-1/M5C-2/M5C-6/M5C-7/M5C-8/M5C-9/M5C-10/M5C-11: drives Scripted reject → fresh Codex correction → Core accept", async () => {
    const stage = await correctionStage("loop");
    const { fixture: value, finding, context } = stage;
    expect(finding).toMatchObject({ status: "OPEN", severity: "BLOCKER", taskId: "T001" });
    expect(finding.observed).toContain(finding.criterionId);
    expect(finding.remediationHint).toContain("Correct the deterministic validation failure");
    expect(await readFile(join(value.projectRoot, "package.json"), "utf8")).toContain("wrong-name");

    const projected = projectWorkUnitToCodexPromptV2(stage.authorizedInvocation.workUnit, context);
    for (const exact of [
      "CORRECTION ATTEMPT", context.contextId, context.contextDigest, stage.attemptId,
      finding.id, finding.criterionId, finding.severity, "status: OPEN", finding.observed, finding.remediationHint!,
      "failing validation [COMMAND]", "Do not mark any Finding resolved", "Do not claim Validation PASS",
      "Do not claim Audit ACCEPT", "Do not commit or push", "Core independently validates and audits",
    ]) expect(projected.text).toContain(exact);
    const ordinary = projectWorkUnitToCodexPromptV2(stage.authorizedInvocation.workUnit);
    expect(projected.text.startsWith(ordinary.text.slice(0, -1))).toBe(true);
    expect(projected.promptDigest).not.toBe(ordinary.promptDigest);

    // The fake transport corrects only if the actual durable Finding reached
    // provider stdin. It never consults the Attempt ordinal.
    transport.behavior = async (prompt, cwd) => {
      const exactAuthority = [finding.id, finding.criterionId, finding.observed, finding.remediationHint!, context.contextDigest, stage.attemptId];
      if (exactAuthority.every((fragment) => prompt.includes(fragment))) {
        await writeFile(join(cwd, "package.json"), `${JSON.stringify(EXPECTED, null, 2)}\n`);
      }
    };
    const executorLease = await acquireLeasedRunV2({ ...value.leaseInput, runtimeInstanceId: "m5c-codex-a2" });
    const executor = await createCodexCliExecutorV2({
      store: stage.store,
      authorizedInvocation: stage.authorizedInvocation,
      timeoutPolicy: value.timeoutPolicy,
      stagingBase: value.stagingBase,
    });
    const executed = await executeAuthorizedInvocationV2({
      leasedRun: executorLease,
      plan: value.plan,
      planIdentity: value.plan.artifactId,
      planDigest: value.planDigest,
      attemptId: stage.attemptTwoId,
      runtime: executor,
    });
    if (executed.kind !== "EXECUTOR_FINISHED_READY_FOR_CAPTURE") throw new Error(executed.kind);
    expect(transport.runs).toBe(1);
    expect(transport.spawns).toBe(1);
    expect(transport.prompts).toEqual([projected.text]);
    expect(transport.argvs[0]?.[0]).toBe("exec");
    for (const forbidden of ["resume", "fork", "--last"]) expect(transport.argvs[0]).not.toContain(forbidden);
    expect(transport.cwds[0]).not.toBe(value.projectRoot);

    const artifacts = await readCodexInvocationArtifactSetV2(stage.store, stage.attemptTwoId);
    expect(artifacts.descriptor).toMatchObject({
      correctionContextSupported: true,
      correctionContextRef: `attempts/${stage.attemptTwoId}/correction-context.json`,
      correctionContextDigest: context.contextDigest,
      requestedModel: "gpt-5.6-sol",
      managedRuntimeVersion: "0.153.4-rb.1",
      stagingRootWritable: true,
      legacySandboxMode: "NONE",
    });
    expect(artifacts.prompt?.promptDigest).toBe(projected.promptDigest);
    expect(artifacts.threadBinding?.threadId).toBe(transport.threadId);
    expect(artifacts.workspaceDelta?.entries.map((entry) => `${entry.operation} ${entry.path}`)).toEqual(["MODIFY package.json"]);
    expect((await readCodexPublicationReceiptV2(stage.store, stage.attemptTwoId))?.appliedCount).toBe(1);
    for (const root of CODEX_PROJECTION_EXCLUDED_ROOTS_V2) {
      expect(await readFile(join(value.projectRoot, root, "canary.txt"), "utf8")).toBe("control-plane canary\n");
    }
    expect(JSON.parse(await readFile(join(value.projectRoot, "package.json"), "utf8"))).toEqual(EXPECTED);

    // M5C-9: provider and Executor have no Finding resolution authority.
    expect((await deriveDurableCorrectionAuthorityV2(stage.store)).findings.get(finding.id)?.status).toBe("OPEN");
    const captured = await captureEvidenceV2({ leasedRun: executorLease, plan: value.plan, attemptId: stage.attemptTwoId, observation: executed.observation });
    if (captured.kind !== "EVIDENCE_CAPTURED_READY_FOR_VALIDATION") throw new Error(captured.kind);
    expect((await deriveDurableCorrectionAuthorityV2(stage.store)).findings.get(finding.id)?.status).toBe("OPEN");
    const validated = await validateAttemptV2({
      leasedRun: await acquireLeasedRunV2({ ...value.leaseInput, runtimeInstanceId: "m5c-validation-a2" }),
      plan: value.plan,
      attemptId: stage.attemptTwoId,
      executorObservation: executed.observation,
    });
    if (validated.kind !== "VALIDATION_READY_FOR_AUDIT") throw new Error(validated.kind);
    expect(validated.validationSet.summary).toMatchObject({ passed: 1, failed: 0, hardNegative: false });
    expect((await deriveDurableCorrectionAuthorityV2(stage.store)).findings.get(finding.id)?.status).toBe("OPEN");
    // M5C-10: every evidence identity is Attempt-bound and newly captured.
    expect(validated.validationSet.evidenceCaptureId).not.toBe(stage.evidenceId);
    expect(captured.evidence.evidenceDigest).not.toBe(stage.evidenceDigest);
    expect(validated.validationSet.setDigest).not.toBe(stage.validationSetDigest);

    const audited = await auditAttemptV2({
      leasedRun: await acquireLeasedRunV2({ ...value.leaseInput, runtimeInstanceId: "m5c-audit-a2" }),
      plan: value.plan,
      attemptId: stage.attemptTwoId,
      executorObservation: executed.observation,
      auditor: new ScriptedAuditor({ defaultDecision: {
        verdict: "ACCEPT",
        proposedFindings: [],
        resolvedFindingRefs: [finding.id],
        rationale: "the exact failing criterion is now green",
      } }),
    });
    if (audited.kind !== "AUDIT_ACCEPTED") throw new Error(audited.kind);
    expect(audited.state.findings[finding.id]?.status).toBe("RESOLVED");
    expect(audited.attempt.closureReason).toBe("AUDIT_ACCEPTED");
    expect(audited.state.tasks.T001?.disposition).toBe("COMPLETE");
    expect(audited.state.disposition).toBe("COMPLETE");
    expect(audited.state.hold).toBe("NONE");

    const cold = await acquireLeasedRunV2({ ...value.leaseInput, runtimeInstanceId: "m5c-cold-complete" });
    try {
      expect(cold.state.attempts[stage.attemptId]?.closureReason).toBe("AUDIT_REJECTED");
      expect(cold.state.attempts[stage.attemptTwoId]?.closureReason).toBe("AUDIT_ACCEPTED");
      expect(cold.state.findings[finding.id]?.status).toBe("RESOLVED");
      expect(cold.state.tasks.T001?.disposition).toBe("COMPLETE");
      expect(cold.state.disposition).toBe("COMPLETE");
    } finally {
      await releaseLeasedRunV2(cold);
    }
    const callsBeforeRerun = transport.runs;
    await expect(executor.invoke(stage.authorizedInvocation)).rejects.toThrow(/M5B_REDISPATCH_FORBIDDEN/);
    expect(transport.runs - callsBeforeRerun).toBe(0);

    const events = (await stage.store.inspect()).events;
    expect(events.flatMap((event) => event.eventType === "finding.state-changed" && event.payload.finding.id === finding.id
      ? [event.payload.finding.status] : [])).toEqual(["OPEN", "CANDIDATE_RESOLVED", "RESOLVED"]);
    expect(events.filter((event) => event.eventType === "executor.finished").map((event) => event.attemptId)).toEqual([stage.attemptId, stage.attemptTwoId]);
    const persisted = (await Promise.all((await readdir(join(stage.store.runDirectory, "attempts", stage.attemptTwoId)))
      .filter((file) => file.endsWith(".json"))
      .map((file) => readFile(join(stage.store.runDirectory, "attempts", stage.attemptTwoId, file), "utf8")))).join("\n");
    expect(persisted).not.toMatch(/Bearer\s+\S+|-----BEGIN[^-]*PRIVATE KEY-----|(?:api[_-]?key|password|secret)\s*[:=]/i);

    // A result sealed for Attempt 2 cannot be republished under Attempt 1.
    const result = artifacts.providerResult!;
    const { resultDigest: _resultDigest, ...resultBase } = result;
    const foreignResult = sealCodexArtifactV2<CodexProviderResultV2>({
      ...resultBase,
      attemptId: stage.attemptId,
      invocationId: stage.invocationId,
      descriptorDigest: sha256("ordinary-attempt-descriptor"),
      dispatchIntentDigest: sha256("ordinary-attempt-intent"),
      threadBindingDigest: sha256("ordinary-attempt-thread"),
    }, "resultDigest");
    await expect(persistCodexProviderResultV2(stage.store, foreignResult, "m5c-result-reuse"))
      .rejects.toThrow(/M5C_ATTEMPT_RESULT_BINDING_INVALID/);
  }, 90_000);

  it("M5C-2: an ordinal-2 Attempt with an OPEN Finding but no context fails before every provider side effect", async () => {
    const stage = await correctionStage("missing", false);
    await expect(resolveExactCodexCorrectionContextV2({ store: stage.store, authorizedInvocation: stage.authorizedInvocation }))
      .rejects.toMatchObject({ m4cCode: "M4C_CORRECTION_CONTEXT_REQUIRED" });
    const executor = await createCodexCliExecutorV2({
      store: stage.store,
      authorizedInvocation: stage.authorizedInvocation,
      timeoutPolicy: stage.fixture.timeoutPolicy,
      stagingBase: stage.fixture.stagingBase,
    });
    await expect(executor.invoke(stage.authorizedInvocation))
      .rejects.toMatchObject({ m4cCode: "M4C_CORRECTION_CONTEXT_REQUIRED" });
    expect(await readCodexInvocationArtifactSetV2(stage.store, stage.attemptTwoId)).toEqual({});
    expect(transport.runs).toBe(0);
    expect(transport.spawns).toBe(0);
  }, 60_000);

  const mutations: readonly [string, string, (stage: CorrectionStage) => CorrectionContextV2][] = [
    ["M5C-1 omitted OPEN Finding", "M4C_CORRECTION_FINDING_SET_INCOMPLETE", (stage) => rebuild(stage.context, { openFindingRefs: [], openFindings: [] })],
    ["M5C-3 foreign Finding", "M4C_CORRECTION_FINDING_SET_INCOMPLETE", (stage) => rebuild(stage.context, {
      openFindingRefs: ["finding-foreign"],
      openFindings: [{ ...stage.context.openFindings[0]!, findingId: "finding-foreign" }],
    })],
    ["M5C-4 Finding digest mismatch", "M4C_CORRECTION_FINDING_DIGEST_MISMATCH", (stage) => rebuild(stage.context, {
      openFindings: [{ ...stage.context.openFindings[0]!, findingDigest: sha256("foreign-finding") }],
    })],
    ["M5C-5 stale Finding status", "M4C_CORRECTION_FINDING_BINDING_INVALID", (stage) => rebuild(stage.context, {
      openFindings: [{ ...stage.context.openFindings[0]!, status: "CANDIDATE_RESOLVED" }],
    })],
    ["altered observed", "M4C_CORRECTION_FINDING_BINDING_INVALID", (stage) => rebuild(stage.context, {
      openFindings: [{ ...stage.context.openFindings[0]!, observed: "different observed failure" }],
    })],
    ["altered remediationHint", "M4C_CORRECTION_FINDING_BINDING_INVALID", (stage) => rebuild(stage.context, {
      openFindings: [{ ...stage.context.openFindings[0]!, remediationHint: "different remediation" }],
    })],
    ["source rejected Attempt mismatch", "M4C_CORRECTION_SOURCE_ATTEMPT_INVALID", (stage) => rebuild(stage.context, {
      sourceRejectedAttempts: [{ ...stage.context.sourceRejectedAttempts[0]!, attemptId: "attempt-foreign-rejected" }],
    })],
    ["foreign CorrectionContext", "M4C_CORRECTION_CONTEXT_BINDING_INVALID", (stage) => rebuild(stage.context, { runId: "run-foreign" })],
  ];

  it.each(mutations)("%s fails with %s before descriptor, staging and process", async (label, code, mutate) => {
    const stage = await correctionStage(`negative-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`, false);
    await persistCorrectionContextV2(stage.store, mutate(stage), `m5c-negative-${code}`);
    await expect(resolveExactCodexCorrectionContextV2({ store: stage.store, authorizedInvocation: stage.authorizedInvocation }))
      .rejects.toMatchObject({ m4cCode: code });
    const executor = await createCodexCliExecutorV2({
      store: stage.store,
      authorizedInvocation: stage.authorizedInvocation,
      timeoutPolicy: stage.fixture.timeoutPolicy,
      stagingBase: stage.fixture.stagingBase,
    });
    await expect(executor.invoke(stage.authorizedInvocation)).rejects.toMatchObject({ m4cCode: code });
    expect(await readCodexInvocationArtifactSetV2(stage.store, stage.attemptTwoId)).toEqual({});
    expect(transport.runs).toBe(0);
    expect(transport.spawns).toBe(0);
  }, 60_000);

  it("rejects a context digest mismatch and a schema-forbidden RESOLVED Finding before dispatch", async () => {
    const stage = await correctionStage("digest-tamper");
    const path = join(stage.store.runDirectory, "attempts", stage.attemptTwoId, "correction-context.json");
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, `${JSON.stringify({ ...raw, contextDigest: sha256("tampered-context") })}\n`);
    await expect(resolveExactCodexCorrectionContextV2({ store: stage.store, authorizedInvocation: stage.authorizedInvocation }))
      .rejects.toThrow(/F_CORRECTION_CONTEXT_INVALID/);
    const executor = await createCodexCliExecutorV2({
      store: stage.store,
      authorizedInvocation: stage.authorizedInvocation,
      timeoutPolicy: stage.fixture.timeoutPolicy,
      stagingBase: stage.fixture.stagingBase,
    });
    await expect(executor.invoke(stage.authorizedInvocation)).rejects.toThrow(/F_CORRECTION_CONTEXT_INVALID/);
    expect(await readCodexInvocationArtifactSetV2(stage.store, stage.attemptTwoId)).toEqual({});
    expect(transport.runs).toBe(0);

    const resolved = { ...stage.context, openFindings: [{ ...stage.context.openFindings[0]!, status: "RESOLVED" }] };
    expect(() => createCorrectionContextV2({
      runId: resolved.runId,
      phaseId: resolved.phaseId,
      taskId: resolved.taskId,
      currentAttemptId: resolved.currentAttemptId,
      sourceRejectedAttempts: resolved.sourceRejectedAttempts,
      openFindingRefs: resolved.openFindingRefs,
      openFindings: resolved.openFindings as never,
      baseWorkspaceFingerprint: resolved.baseWorkspaceFingerprint,
      createdAt: resolved.createdAt,
    })).toThrow(/F_CORRECTION_CONTEXT_INVALID/);
  }, 60_000);

  it("M5C-6: a Codex descriptor that loses or alters context binding is not dispatchable", async () => {
    const stage = await correctionStage("descriptor-binding");
    transport.behavior = async (prompt, cwd) => {
      if (prompt.includes(stage.finding.id)) await writeFile(join(cwd, "package.json"), `${JSON.stringify(EXPECTED)}\n`);
    };
    const executor = await createCodexCliExecutorV2({
      store: stage.store,
      authorizedInvocation: stage.authorizedInvocation,
      timeoutPolicy: stage.fixture.timeoutPolicy,
      stagingBase: stage.fixture.stagingBase,
    });
    await executor.invoke(stage.authorizedInvocation);
    const descriptor = (await readCodexInvocationArtifactSetV2(stage.store, stage.attemptTwoId)).descriptor!;
    expect(await validateExactCodexCorrectionDescriptorV2({ store: stage.store, descriptor })).toEqual(stage.context);
    for (const mutation of [
      { correctionContextSupported: false, correctionContextRef: null, correctionContextDigest: null },
      { correctionContextDigest: sha256("wrong-context") },
      { correctionContextRef: `attempts/${stage.attemptTwoId}/foreign-context.json` },
    ] as const) {
      await expect(validateExactCodexCorrectionDescriptorV2({ store: stage.store, descriptor: { ...descriptor, ...mutation } }))
        .rejects.toMatchObject({ m4cCode: "M4C_CORRECTION_DESCRIPTOR_BINDING_INVALID" });
    }
  }, 60_000);

  it("M5C-8: one physical thread identity cannot bind two Attempts", async () => {
    const stage = await correctionStage("thread-reuse");
    function thread(attemptId: string, invocationId: string): CodexThreadBindingV2 {
      return sealCodexArtifactV2<CodexThreadBindingV2>({
        schema: "rb-ralph-codex-thread-binding/v1",
        runId: stage.fixture.runId,
        phaseId: "P01",
        taskId: "T001",
        attemptId,
        invocationId,
        descriptorRef: `attempts/${attemptId}/codex-provider-descriptor.json`,
        descriptorDigest: sha256(`descriptor-${attemptId}`),
        dispatchIntentRef: `attempts/${attemptId}/codex-dispatch-intent.json`,
        dispatchIntentDigest: sha256(`intent-${attemptId}`),
        processReceiptRef: `attempts/${attemptId}/codex-process-receipt.json`,
        processReceiptDigest: sha256(`process-${attemptId}`),
        threadId: "thr_m5cForbiddenReuse",
        boundAt: "2026-09-09T12:20:00.000Z",
      }, "bindingDigest");
    }
    await persistCodexThreadBindingV2(stage.store, thread(stage.attemptId, stage.invocationId), "m5c-thread-one");
    await expect(persistCodexThreadBindingV2(
      stage.store,
      thread(stage.attemptTwoId, stage.authorizedInvocation.descriptor.invocationId),
      "m5c-thread-two",
    )).rejects.toThrow(/M5C_FRESH_THREAD_REQUIRED/);
    expect(transport.runs).toBe(0);
  }, 60_000);

  it("M5C-12: exhausted frozen Attempt budget admits no correction Attempt or Codex side effect", async () => {
    const value = await fixture("budget", 1);
    const first = await deterministicRejectedAttempt(value, "budget");
    expect(first.finding.status).toBe("OPEN");
    const admitted = await prepareNextAuthorizedInvocationV2({
      leasedRun: await acquireLeasedRunV2({ ...value.leaseInput, runtimeInstanceId: "m5c-budget-admit" }),
      plan: value.plan,
      planIdentity: value.plan.artifactId,
      planDigest: value.planDigest,
      attemptIdFactory: () => "attempt-m5c-budget-a2",
    });
    expect(admitted.kind).not.toBe("AUTHORIZED_NOT_INVOKED");
    expect(transport.runs).toBe(0);
    expect(transport.spawns).toBe(0);
  }, 60_000);
});
