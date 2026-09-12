import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Deterministic fake stock-Codex process layer.
 *
 * It simulates a real `codex exec` run — process group lifecycle, JSONL
 * transport, several agent messages, command items, the `-o` file, the exit
 * code — and physically mutates the staging projection.  It exercises the
 * genuine CodexCliExecutorV2, its artifacts, the host-derived delta, the
 * deterministic publication and the frozen Core; it is not a parser stub.
 */
const transport = vi.hoisted(() => ({
  runs: 0,
  spawns: 0,
  observedCwds: [] as string[],
  observedArgv: [] as string[][],
  observedPrompts: [] as string[],
  stagingWrites: [] as { readonly path: string; readonly content: string }[],
  stagingDeletes: [] as string[],
  events: undefined as string[] | undefined,
  finalOutput: undefined as string | undefined,
  writeFinalOutput: true,
  exitCode: 0 as number | null,
  signal: null as string | null,
  timedOut: false,
  cancelled: false,
  processAbsent: true,
  settlementObserved: true,
  settlementQuiescent: true,
  settlementVerified: true,
  spawnHook: undefined as ((cwd: string) => Promise<void> | void) | undefined,
  afterRunHook: undefined as ((cwd: string) => Promise<void> | void) | undefined,
  threadId: "thr_m5bDeterministic0001",
}));

/**
 * The shipped capability record is already DENIED, so nothing about the
 * boundary is mocked here.  What IS replaced is the pair of live, non-model
 * physical probes — the system-bwrap inspection and the `codex sandbox`
 * capability probe — because these deterministic suites must run without the
 * stock binary present.  Both are proven unmocked against the real binary in
 * ralph-operational-m5b-inference-gate.test.ts.
 */
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
  // Imported from the profile module, NOT from codex-capability: capability
  // imports this very module, and awaiting it inside the mock factory would
  // deadlock module resolution.
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
    observedAt: "2026-09-09T00:00:00.000Z",
  };
  return { ...actual, probeCodexPhysicalCapabilityV2: vi.fn(async () => Object.freeze({ ...base, reportDigest: sha256Canonical(base) })) };
});

vi.mock("../../src/vnext/ralph-runtime/operational-m5b/codex-process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/vnext/ralph-runtime/operational-m5b/codex-process.js")>();
  const { mkdir: makeDirectory, rm: remove, writeFile: write } = await import("node:fs/promises");
  const { dirname, join: joinPath } = await import("node:path");
  const contract = await import("../../src/vnext/ralph-runtime/operational-m5b/contract.js");
  const { defaultProcessIdentityProvider } = await import("../../src/vnext/ralph-runtime/operational-b2/process-identity.js");
  const ABSENT_PID = 4_194_303;
  return {
    ...actual,
    inspectManagedCodexRuntimeV2: vi.fn(async () => {
      const managed = await import("../../src/vnext/ralph-runtime/operational-m5b/codex-managed-runtime.js");
      return Object.freeze({
        executable: Object.freeze({
          executablePath: contract.CODEX_CLI_NATIVE_EXECUTABLE_PATH_V2,
          executableVersion: contract.CODEX_CLI_EXECUTOR_CLI_VERSION_V2,
          executableSizeBytes: contract.CODEX_CLI_NATIVE_EXECUTABLE_SIZE_BYTES_V2,
          executableSha256: contract.CODEX_CLI_NATIVE_EXECUTABLE_SHA256_V2,
        }),
        // The identity a genuine managed install produces, so the capability
        // binding is exercised rather than bypassed.
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
          payloadDigest: managed.STOCK_CODEX_CLI_RUNTIME.platforms["linux-x86_64"]
            ? (await import("../../src/managed-stock-codex-runtime.js")).managedStockCodexPayloadDigest(managed.STOCK_CODEX_CLI_RUNTIME.platforms["linux-x86_64"]!.payload)
            : "",
          identityDigest: managed.codexManagedRuntimeExpectedIdentityDigestV2(),
        }),
      });
    }),
    runCodexProcessV2: vi.fn(async (input: Parameters<typeof actual.runCodexProcessV2>[0]) => {
      transport.runs += 1;
      transport.observedCwds.push(input.cwd);
      transport.observedArgv.push([...input.argv]);
      transport.observedPrompts.push(input.stdin);
      const host = await defaultProcessIdentityProvider.current();
      const processIdentity = transport.processAbsent
        ? Object.freeze({ ...host, pid: ABSENT_PID, processStartIdentity: `sha256:${"a".repeat(64)}` })
        : host;
      const startedAt = "2026-09-08T00:00:00.000Z";
      transport.spawns += 1;
      await input.onSpawned?.(Object.freeze({
        processIdentity,
        processGroupId: processIdentity.pid,
        containmentKind: "cgroup2",
        containmentStructural: true,
        startedAt,
      }));
      await transport.spawnHook?.(input.cwd);

      for (const entry of transport.stagingWrites) {
        const absolute = joinPath(input.cwd, entry.path);
        await makeDirectory(dirname(absolute), { recursive: true });
        await write(absolute, entry.content, { mode: 0o644 });
      }
      for (const path of transport.stagingDeletes) await remove(joinPath(input.cwd, path), { force: true });

      const finalOutput = transport.finalOutput ?? '{"summary":"created src/status.js"}';
      const outputIndex = input.argv.indexOf("-o");
      if (transport.writeFinalOutput && outputIndex >= 0) await write(input.argv[outputIndex + 1]!, finalOutput, { mode: 0o600 });

      const events = transport.events ?? [
        JSON.stringify({ type: "thread.started", thread_id: transport.threadId }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({ type: "item.completed", item: { id: "item_0", item_type: "reasoning", text: "planning" } }),
        JSON.stringify({ type: "item.completed", item: { id: "item_1", item_type: "agent_message", text: "starting the change" } }),
        JSON.stringify({ type: "item.completed", item: { id: "item_2", item_type: "command_execution", command: "ls", exit_code: 0 } }),
        JSON.stringify({ type: "item.completed", item: { id: "item_3", item_type: "agent_message", text: finalOutput } }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 42, output_tokens: 7 } }),
      ];
      let stdout = "";
      for (const line of events) {
        const chunk = `${line}\n`;
        stdout += chunk;
        input.onStdoutChunk?.(chunk);
      }
      await transport.afterRunHook?.(input.cwd);
      return Object.freeze({
        processIdentity,
        processGroupId: processIdentity.pid,
        containmentKind: "cgroup2",
        containmentStructural: true,
        startedAt,
        finishedAt: "2026-09-08T00:00:05.000Z",
        exitCode: transport.exitCode,
        signal: transport.signal,
        timedOut: transport.timedOut,
        cancelled: transport.cancelled,
        stdout,
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        settlement: Object.freeze({
          observed: transport.settlementObserved,
          quiescent: transport.settlementQuiescent,
          verified: transport.settlementVerified,
          survivors: [],
          containment: { kind: "cgroup2", structural: true, reason: "fixture" },
        }),
      });
    }),
  };
});

import { RalphEventStoreV2 } from "../../src/vnext/ralph-runtime/operational-b1/index.js";
import { acquireLeasedRunV2 } from "../../src/vnext/ralph-runtime/operational-b2/index.js";
import { executeAuthorizedInvocationV2 } from "../../src/vnext/ralph-runtime/operational-b4/index.js";
import {
  assertTrustedExecutorRuntimeV2,
  isTrustedExecutorRuntimeV2,
} from "../../src/vnext/ralph-runtime/operational-b4/scripted-executor.js";
import { captureEvidenceV2 } from "../../src/vnext/ralph-runtime/operational-c/index.js";
import { validateAttemptV2 } from "../../src/vnext/ralph-runtime/operational-d/index.js";
import { ScriptedAuditor, auditAttemptV2 } from "../../src/vnext/ralph-runtime/operational-e/index.js";
import {
  createCorrectionContextV2,
  persistCorrectionContextV2,
} from "../../src/vnext/ralph-runtime/operational-f/correction-context.js";
import { fingerprintWorkspace } from "../../src/vnext/ralph-runtime/fingerprint.js";
import { sha256 } from "../../src/vnext/ralph-runtime/hashing.js";
import {
  CODEX_CLI_EXECUTOR_PROFILE_V2,
  CODEX_CLI_EXECUTOR_REQUESTED_MODEL_V2,
  RalphM5BError,
} from "../../src/vnext/ralph-runtime/operational-m5b/contract.js";
import {
  CodexCliExecutorV2,
  createCodexCliExecutorV2,
  isTrustedCodexCliExecutorV2,
} from "../../src/vnext/ralph-runtime/operational-m5b/codex-cli-executor.js";
import {
  RALPH_CODEX_FINALIZATION_DIAGNOSTIC_SCHEMA_V2,
  codexFinalizationDiagnosticRefV2,
  persistCodexFinalizationDiagnosticV2,
  readCodexFinalizationDiagnosticV2,
  readCodexInvocationArtifactSetV2,
  readCodexProviderDescriptorV2,
  sealCodexArtifactV2,
  validateCodexFinalizationDiagnosticV2,
  type CodexFinalizationDiagnosticV2,
} from "../../src/vnext/ralph-runtime/operational-m5b/codex-artifacts.js";
import { readCodexPublicationReceiptV2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-publication.js";
import { CODEX_PROJECTION_EXCLUDED_ROOTS_V2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-projection.js";
import {
  admitM5BAttemptV2,
  bootstrapM5BRunV2,
  type M5BFixtureV2,
} from "./fixtures/ralph-m5b-fixture.js";
import {
  runProgressiveRalphBridgeV1,
  type BridgeRuntimeFactoriesV1,
} from "../../src/vnext/ralph-bridge/index.js";
import { createReadyBridgeFixture } from "./fixtures/progressive-ready-bridge-fixture.js";

const STATUS_SOURCE = 'module.exports = "ready";\n';
const disposable: M5BFixtureV2[] = [];
const disposableBridgeRoots: string[] = [];

async function fixture(options: Parameters<typeof bootstrapM5BRunV2>[0] = {}): Promise<M5BFixtureV2> {
  const created = await bootstrapM5BRunV2(options);
  disposable.push(created);
  return created;
}

async function executeOnce(current: M5BFixtureV2) {
  const { admitted } = await admitM5BAttemptV2(current);
  const executorLease = await acquireLeasedRunV2(current.leaseInput);
  const executor = await createCodexCliExecutorV2({
    store: current.store,
    authorizedInvocation: admitted.authorizedInvocation,
    timeoutPolicy: current.timeoutPolicy,
    stagingBase: current.stagingBase,
  });
  const executed = await executeAuthorizedInvocationV2({
    leasedRun: executorLease,
    plan: current.plan,
    planIdentity: current.plan.artifactId,
    planDigest: current.planDigest,
    attemptId: current.attemptId,
    runtime: executor,
  });
  return { admitted, executed, executor, executorLease };
}

beforeEach(() => {
  transport.runs = 0;
  transport.spawns = 0;
  transport.observedCwds = [];
  transport.observedArgv = [];
  transport.observedPrompts = [];
  transport.stagingWrites = [{ path: "src/status.js", content: STATUS_SOURCE }];
  transport.stagingDeletes = [];
  transport.events = undefined;
  transport.finalOutput = undefined;
  transport.writeFinalOutput = true;
  transport.exitCode = 0;
  transport.signal = null;
  transport.timedOut = false;
  transport.cancelled = false;
  transport.processAbsent = true;
  transport.settlementObserved = true;
  transport.settlementQuiescent = true;
  transport.settlementVerified = true;
  transport.spawnHook = undefined;
  transport.afterRunHook = undefined;
  transport.threadId = "thr_m5bDeterministic0001";
});

afterEach(async () => {
  for (const created of disposable.splice(0)) {
    await rm(created.projectRoot, { recursive: true, force: true });
    await rm(created.stagingBase, { recursive: true, force: true });
  }
  await Promise.all(disposableBridgeRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Ralph M5-B — CodexCliExecutorV2 trust root", () => {
  it("admits only a genuine sealed Codex Executor into the trusted union", async () => {
    const current = await fixture();
    const { admitted } = await admitM5BAttemptV2(current);
    const executor = await createCodexCliExecutorV2({
      store: current.store,
      authorizedInvocation: admitted.authorizedInvocation,
      timeoutPolicy: current.timeoutPolicy,
      stagingBase: current.stagingBase,
    });
    expect(isTrustedCodexCliExecutorV2(executor)).toBe(true);
    expect(isTrustedExecutorRuntimeV2(executor)).toBe(true);
    expect(Object.isFrozen(executor)).toBe(true);

    const shapes: unknown[] = [
      { kind: "EXECUTOR_RUNTIME", runtimeIdentity: "codex-cli-runtime-v2", invoke: async () => undefined, observe: async () => undefined, requestCancel: async () => undefined },
      JSON.parse(JSON.stringify({ kind: "EXECUTOR_RUNTIME", runtimeIdentity: "codex-cli-runtime-v2" })),
      Object.create(CodexCliExecutorV2.prototype),
      Object.assign(Object.create(CodexCliExecutorV2.prototype), { kind: "EXECUTOR_RUNTIME", runtimeIdentity: "codex-cli-runtime-v2" }),
      new Proxy(executor, {}),
    ];
    for (const shape of shapes) {
      expect(isTrustedCodexCliExecutorV2(shape)).toBe(false);
      expect(isTrustedExecutorRuntimeV2(shape)).toBe(false);
      expect(() => assertTrustedExecutorRuntimeV2(shape)).toThrow(/B4_EXECUTOR_AUTHORIZATION_REQUIRED/);
    }
    class ForgedCodexExecutor extends CodexCliExecutorV2 {}
    expect(() => new ForgedCodexExecutor({} as never, Symbol("forged"))).toThrow(/B4_EXECUTOR_AUTHORIZATION_REQUIRED/);
    expect(() => Reflect.construct(CodexCliExecutorV2, [{}, Symbol("forged")])).toThrow(/B4_EXECUTOR_AUTHORIZATION_REQUIRED/);
    expect(() => new (CodexCliExecutorV2 as unknown as new (a: unknown, b: unknown) => unknown)({}, Symbol("forged"))).toThrow(/B4_EXECUTOR_AUTHORIZATION_REQUIRED/);
    expect(isTrustedCodexCliExecutorV2(structuredClone({ kind: "EXECUTOR_RUNTIME" }))).toBe(false);
  });
});

describe("Ralph M5-B — one fresh exec through the frozen Core", () => {
  it("projects, dispatches once, derives a host delta and publishes it canonically", async () => {
    const current = await fixture();
    const { admitted, executed, executorLease } = await executeOnce(current);
    expect(executed.kind).toBe("EXECUTOR_FINISHED_READY_FOR_CAPTURE");
    if (executed.kind !== "EXECUTOR_FINISHED_READY_FOR_CAPTURE") throw new Error(executed.kind);
    expect(transport.runs).toBe(1);

    // The provider never receives the canonical project root.
    const staging = transport.observedCwds[0]!;
    expect(staging).not.toBe(current.projectRoot);
    expect(staging.startsWith(`${current.projectRoot}/`)).toBe(false);
    expect(current.projectRoot.startsWith(`${staging}/`)).toBe(false);
    for (const excluded of CODEX_PROJECTION_EXCLUDED_ROOTS_V2) expect(existsSync(join(staging, excluded))).toBe(false);
    // The legacy sandbox is gone: the boundary is the named permission
    // profile, selected through `-c default_permissions`.
    expect(transport.observedArgv[0]).not.toContain("--sandbox");
    expect(transport.observedArgv[0]).toContain('default_permissions="ralph_m5b"');
    expect(transport.observedArgv[0]!.some((token) => token.startsWith("permissions.ralph_m5b="))).toBe(true);
    expect(transport.observedArgv[0]).toContain("--ignore-user-config");
    expect(transport.observedArgv[0]).toContain("--ignore-rules");
    expect(transport.observedArgv[0]).not.toContain("resume");

    const artifacts = await readCodexInvocationArtifactSetV2(current.store, current.attemptId);
    expect(artifacts.descriptor).toMatchObject({
      executorProfileIdentity: CODEX_CLI_EXECUTOR_PROFILE_V2,
      provider: "openai",
      transport: "codex-cli-exec",
      requestedModel: CODEX_CLI_EXECUTOR_REQUESTED_MODEL_V2,
      reasoningEffort: "xhigh",
      observedModelState: "UNAVAILABLE",
      observedModel: null,
      correctionContextSupported: false,
      correctionContextRef: null,
      correctionContextDigest: null,
    });
    expect(artifacts.threadBinding?.threadId).toBe(transport.threadId);
    expect(artifacts.processReceipt?.processGroupId).toBeGreaterThan(0);
    expect(artifacts.providerResult).toMatchObject({ classification: "SUCCEEDED", terminalKind: "TURN_COMPLETED", actualExitCode: 0, agentMessageCount: 2 });
    expect(artifacts.terminal).toMatchObject({ status: "SUCCEEDED", termination: "NORMAL" });
    expect(artifacts.finalizationDiagnostic).toBeUndefined();
    expect(artifacts.workspaceDelta?.entries.map((entry) => `${entry.operation} ${entry.path}`)).toEqual(["CREATE src/status.js"]);

    const publication = await readCodexPublicationReceiptV2(current.store, current.attemptId);
    expect(publication).toMatchObject({ appliedCount: 1, deltaDigest: artifacts.workspaceDelta!.deltaDigest });
    expect(await readFile(join(current.projectRoot, "src/status.js"), "utf8")).toBe(STATUS_SOURCE);
    expect(await readFile(join(current.projectRoot, ".rb-harness/canary.txt"), "utf8")).toBe("control-plane canary\n");

    // No provider text is persisted anywhere in the Attempt artifacts.
    const directory = join(current.store.runDirectory, "attempts", current.attemptId);
    const persisted = (await Promise.all((await readdir(directory)).filter((file) => file.endsWith(".json")).map((file) => readFile(join(directory, file), "utf8")))).join("\n");
    expect(persisted).not.toMatch(/Bearer\s+\S+|-----BEGIN[^-]*PRIVATE KEY-----|(?:api[_-]?key|password|secret)\s*[:=]/i);
    expect(persisted).not.toContain("starting the change");

    // C consumes the still-held B4 lease and releases it; D and E then take
    // their own Core lease boundaries.
    const captured = await captureEvidenceV2({ leasedRun: executorLease, plan: current.plan, attemptId: current.attemptId, observation: executed.observation });
    expect(captured.kind).toBe("EVIDENCE_CAPTURED_READY_FOR_VALIDATION");
    if (captured.kind !== "EVIDENCE_CAPTURED_READY_FOR_VALIDATION") throw new Error(captured.kind);
    expect(captured.evidence.changedPaths).toEqual(["src/status.js"]);
    expect(captured.evidence.controlPlaneChangedPaths).toEqual([]);

    const validated = await validateAttemptV2({ leasedRun: await acquireLeasedRunV2(current.leaseInput), plan: current.plan, attemptId: current.attemptId, executorObservation: executed.observation });
    expect(validated.kind).toBe("VALIDATION_READY_FOR_AUDIT");
    if (validated.kind !== "VALIDATION_READY_FOR_AUDIT") throw new Error(validated.kind);
    expect(validated.validationSet.summary).toMatchObject({ passed: 1, failed: 0 });

    const auditor = new ScriptedAuditor({ defaultDecision: { verdict: "ACCEPT", rationale: "deterministic validation and Evidence are green" } });
    const audited = await auditAttemptV2({ leasedRun: await acquireLeasedRunV2(current.leaseInput), plan: current.plan, attemptId: current.attemptId, executorObservation: executed.observation, auditor });
    expect(audited.kind).toBe("AUDIT_ACCEPTED");
    expect(audited.state.tasks.T001?.disposition).toBe("COMPLETE");
    expect(audited.state.disposition).toBe("COMPLETE");
    expect(audited.state.hold).toBe("NONE");
    expect(admitted.authorizedInvocation.descriptor.invocationId).toMatch(/^inv-/);

    // A completed Run reinvoked adds no model-bearing call and no Attempt.
    const rerunLease = await acquireLeasedRunV2(current.leaseInput);
    expect(Object.keys(rerunLease.state.attempts)).toHaveLength(1);
    expect(rerunLease.state.disposition).toBe("COMPLETE");
    expect(transport.runs).toBe(1);
  }, 120_000);

  it("binds the LAST completed agent message, never the first", async () => {
    const current = await fixture();
    transport.finalOutput = '{"summary":"created src/status.js"}';
    transport.events = [
      JSON.stringify({ type: "thread.started", thread_id: transport.threadId }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { id: "a", item_type: "agent_message", text: '{"summary":"an earlier message that is not final"}' } }),
      JSON.stringify({ type: "item.completed", item: { id: "b", item_type: "agent_message", text: '{"summary":"created src/status.js"}' } }),
      JSON.stringify({ type: "turn.completed" }),
    ];
    const { executed } = await executeOnce(current);
    expect(executed.kind).toBe("EXECUTOR_FINISHED_READY_FOR_CAPTURE");
    const artifacts = await readCodexInvocationArtifactSetV2(current.store, current.attemptId);
    expect(artifacts.providerResult).toMatchObject({ classification: "SUCCEEDED" });
    expect(artifacts.providerResult?.finalAgentMessageDigest).toBe(sha256('{"summary":"created src/status.js"}'));
  }, 60_000);

  it("fails closed when only an earlier agent message matches the -o output", async () => {
    const current = await fixture();
    transport.finalOutput = '{"summary":"created src/status.js"}';
    transport.events = [
      JSON.stringify({ type: "thread.started", thread_id: transport.threadId }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { id: "a", item_type: "agent_message", text: '{"summary":"created src/status.js"}' } }),
      JSON.stringify({ type: "item.completed", item: { id: "b", item_type: "agent_message", text: '{"summary":"a later message that diverges"}' } }),
      JSON.stringify({ type: "turn.completed" }),
    ];
    const { executed } = await executeOnce(current);
    const artifacts = await readCodexInvocationArtifactSetV2(current.store, current.attemptId);
    expect(artifacts.providerResult?.classification).toBe("FAILED");
    expect(artifacts.workspaceDelta).toBeUndefined();
    expect(existsSync(join(current.projectRoot, "src/status.js"))).toBe(false);
    expect(executed.kind).toBe("EXECUTOR_FINISHED_READY_FOR_CAPTURE");
  }, 60_000);
});

describe("Ralph M5-B — the JSONL stream is never workspace authority", () => {
  it("publishes nothing when the command stream claims a write the host cannot see", async () => {
    const current = await fixture();
    transport.stagingWrites = [];
    transport.events = [
      JSON.stringify({ type: "thread.started", thread_id: transport.threadId }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { id: "c", item_type: "command_execution", command: "cat > src/status.js", exit_code: 0 } }),
      JSON.stringify({ type: "item.completed", item: { id: "f", item_type: "file_change", changes: [{ path: "src/status.js", kind: "add" }] } }),
      JSON.stringify({ type: "item.completed", item: { id: "m", item_type: "agent_message", text: '{"summary":"created src/status.js"}' } }),
      JSON.stringify({ type: "turn.completed" }),
    ];
    await executeOnce(current);
    const artifacts = await readCodexInvocationArtifactSetV2(current.store, current.attemptId);
    expect(artifacts.providerResult?.classification).toBe("SUCCEEDED");
    expect(artifacts.providerResult?.commandExecutionCount).toBe(1);
    expect(artifacts.workspaceDelta?.entryCount).toBe(0);
    expect(existsSync(join(current.projectRoot, "src/status.js"))).toBe(false);
  }, 60_000);

  it("detects a real host mutation the command stream never mentioned", async () => {
    const current = await fixture();
    transport.events = [
      JSON.stringify({ type: "thread.started", thread_id: transport.threadId }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { id: "m", item_type: "agent_message", text: '{"summary":"created src/status.js"}' } }),
      JSON.stringify({ type: "turn.completed" }),
    ];
    await executeOnce(current);
    const artifacts = await readCodexInvocationArtifactSetV2(current.store, current.attemptId);
    expect(artifacts.providerResult?.commandExecutionCount).toBe(0);
    expect(artifacts.workspaceDelta?.entries.map((entry) => entry.path)).toEqual(["src/status.js"]);
    expect(await readFile(join(current.projectRoot, "src/status.js"), "utf8")).toBe(STATUS_SOURCE);
  }, 60_000);
});

describe("Ralph M5-B — physical terminal, quiescence and result validity", () => {
  it("refuses a terminal turn whose actual child exit was not zero", async () => {
    const current = await fixture();
    transport.exitCode = 7;
    await executeOnce(current);
    const artifacts = await readCodexInvocationArtifactSetV2(current.store, current.attemptId);
    expect(artifacts.providerResult).toMatchObject({ classification: "FAILED", actualExitCode: 7 });
    expect(artifacts.workspaceDelta).toBeUndefined();
    expect(existsSync(join(current.projectRoot, "src/status.js"))).toBe(false);
  }, 60_000);

  it("refuses a result without a positive quiescence observation", async () => {
    const current = await fixture();
    transport.settlementQuiescent = false;
    const { executed } = await executeOnce(current);
    expect(executed.kind).toBe("RECONCILIATION_REQUIRED");
    const artifacts = await readCodexInvocationArtifactSetV2(current.store, current.attemptId);
    expect(artifacts.terminal).toBeUndefined();
    expect(existsSync(join(current.projectRoot, "src/status.js"))).toBe(false);
  }, 60_000);

  it("refuses turn.failed, an error event, a missing thread and a duplicated thread", async () => {
    for (const events of [
      [JSON.stringify({ type: "thread.started", thread_id: "thr_m5bDeterministic0001" }), JSON.stringify({ type: "turn.failed", error: { message: "provider refused" } })],
      [JSON.stringify({ type: "thread.started", thread_id: "thr_m5bDeterministic0001" }), JSON.stringify({ type: "error", message: "transport failure" })],
      [JSON.stringify({ type: "turn.started" }), JSON.stringify({ type: "turn.completed" })],
      [JSON.stringify({ type: "thread.started", thread_id: "thr_a" }), JSON.stringify({ type: "thread.started", thread_id: "thr_b" }), JSON.stringify({ type: "turn.completed" })],
    ]) {
      const current = await fixture();
      transport.events = events;
      await executeOnce(current);
      const artifacts = await readCodexInvocationArtifactSetV2(current.store, current.attemptId);
      expect(artifacts.providerResult?.classification).toBe("FAILED");
      expect(artifacts.workspaceDelta).toBeUndefined();
      expect(existsSync(join(current.projectRoot, "src/status.js"))).toBe(false);
      transport.events = undefined;
    }
  }, 120_000);

  it("refuses a malformed, schema-invalid, missing or credential-bearing -o output", async () => {
    for (const setup of [
      () => { transport.finalOutput = "{not json"; },
      () => { transport.finalOutput = '{"summary":"ok","verdict":"ACCEPT"}'; },
      () => { transport.writeFinalOutput = false; },
      () => { transport.finalOutput = JSON.stringify({ summary: "Authorization: Bearer sk-forbidden-material-value" }); },
    ]) {
      const current = await fixture();
      setup();
      transport.events = [
        JSON.stringify({ type: "thread.started", thread_id: transport.threadId }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({ type: "item.completed", item: { id: "m", item_type: "agent_message", text: transport.finalOutput ?? "{}" } }),
        JSON.stringify({ type: "turn.completed" }),
      ];
      await executeOnce(current);
      const artifacts = await readCodexInvocationArtifactSetV2(current.store, current.attemptId);
      expect(artifacts.providerResult?.classification).toBe("FAILED");
      expect(existsSync(join(current.projectRoot, "src/status.js"))).toBe(false);
      transport.finalOutput = undefined;
      transport.writeFinalOutput = true;
      transport.events = undefined;
    }
  }, 120_000);
});

describe("Ralph M5-B — delta and publication safety", () => {
  it("refuses an unexpected provider delta path and publishes nothing", async () => {
    const current = await fixture();
    transport.stagingWrites = [
      { path: "src/status.js", content: STATUS_SOURCE },
      { path: "src/unexpected.js", content: "module.exports = 0;\n" },
    ];
    const { executed } = await executeOnce(current);
    const artifacts = await readCodexInvocationArtifactSetV2(current.store, current.attemptId);
    expect(executed.kind).toBe("RECONCILIATION_REQUIRED");
    expect(executed.state).toMatchObject({ disposition: "ACTIVE", hold: "RECONCILIATION_REQUIRED" });
    expect(artifacts.providerResult).toMatchObject({ classification: "SUCCEEDED", terminalKind: "TURN_COMPLETED", actualExitCode: 0 });
    expect(artifacts.finalizationDiagnostic).toMatchObject({
      schema: RALPH_CODEX_FINALIZATION_DIAGNOSTIC_SCHEMA_V2,
      stage: "DELTA_DERIVATION",
      m5bCode: "M5B_DELTA_OUT_OF_SCOPE",
      providerResultDigest: artifacts.providerResult?.resultDigest,
    });
    expect(artifacts.terminal).toBeUndefined();
    expect(artifacts.workspaceDelta).toBeUndefined();
    expect(await readCodexPublicationReceiptV2(current.store, current.attemptId)).toBeUndefined();
    expect(existsSync(join(current.projectRoot, "src/status.js"))).toBe(false);
    expect(existsSync(join(current.projectRoot, "src/unexpected.js"))).toBe(false);

    const diagnostic = artifacts.finalizationDiagnostic!;
    expect(Object.keys(diagnostic).sort()).toEqual([
      "attemptId", "diagnosticDigest", "invocationId", "m5bCode", "phaseId", "providerResultDigest", "recordedAt", "runId", "schema", "stage", "taskId",
    ]);
    expect((await persistCodexFinalizationDiagnosticV2(current.store, diagnostic, "same-diagnostic")).publishDisposition).toBe("ALREADY_PRESENT");
    const { diagnosticDigest: _ignored, ...base } = diagnostic;
    const conflict = sealCodexArtifactV2<CodexFinalizationDiagnosticV2>({ ...base, recordedAt: "2026-09-08T00:00:06.000Z" }, "diagnosticDigest");
    await expect(persistCodexFinalizationDiagnosticV2(current.store, conflict, "conflicting-diagnostic"))
      .rejects.toMatchObject({ code: "B4_ARTIFACT_IMMUTABLE_CONFLICT" });
  }, 60_000);

  it("validates a closed diagnostic schema and rejects every malformed or foreign binding", async () => {
    const current = await fixture();
    transport.stagingWrites = [
      { path: "src/status.js", content: STATUS_SOURCE },
      { path: "src/unexpected.js", content: "module.exports = 0;\n" },
    ];
    await executeOnce(current);
    const artifacts = await readCodexInvocationArtifactSetV2(current.store, current.attemptId);
    const diagnostic = artifacts.finalizationDiagnostic!;
    const { diagnosticDigest: _ignored, ...base } = diagnostic;
    const reseal = (changes: Record<string, unknown>): CodexFinalizationDiagnosticV2 =>
      sealCodexArtifactV2<CodexFinalizationDiagnosticV2>({ ...base, ...changes }, "diagnosticDigest");

    expect(() => validateCodexFinalizationDiagnosticV2(diagnostic)).not.toThrow();
    for (const malformed of [
      reseal({ stage: "ARBITRARY_STAGE" }),
      reseal({ m5bCode: "ARBITRARY_M5B_CODE" }),
      reseal({ recordedAt: "not-an-iso-time" }),
      sealCodexArtifactV2<CodexFinalizationDiagnosticV2>({ ...base, cause: "forbidden" }, "diagnosticDigest"),
      { ...diagnostic, diagnosticDigest: `sha256:${"0".repeat(64)}` },
      (() => {
        const { stage: _missing, ...missing } = base;
        return sealCodexArtifactV2<CodexFinalizationDiagnosticV2>(missing, "diagnosticDigest");
      })(),
    ]) expect(() => validateCodexFinalizationDiagnosticV2(malformed)).toThrow();

    for (const foreign of [
      reseal({ runId: "foreign-run" }),
      reseal({ phaseId: "foreign-phase" }),
      reseal({ taskId: "foreign-task" }),
      reseal({ attemptId: "foreign-attempt" }),
      reseal({ invocationId: "foreign-invocation" }),
      reseal({ providerResultDigest: `sha256:${"f".repeat(64)}` }),
    ]) await expect(persistCodexFinalizationDiagnosticV2(current.store, foreign, `foreign-${foreign.diagnosticDigest.slice(-8)}`)).rejects.toBeDefined();
  }, 60_000);

  it("rethrows the original typed failure while excluding its poisoned message from durable evidence", async () => {
    const poison = "M5B_ERROR_MESSAGE_POISON_91c4";
    const current = await fixture();
    transport.stagingWrites = [
      { path: "src/status.js", content: STATUS_SOURCE },
      { path: `src/${poison}.js`, content: "module.exports = 0;\n" },
    ];
    const { admitted } = await admitM5BAttemptV2(current);
    const executor = await createCodexCliExecutorV2({
      store: current.store,
      authorizedInvocation: admitted.authorizedInvocation,
      timeoutPolicy: current.timeoutPolicy,
      stagingBase: current.stagingBase,
    });
    const caught = await executor.invoke(admitted.authorizedInvocation).then(() => undefined, (error: unknown) => error);
    expect(caught).toBeInstanceOf(RalphM5BError);
    expect(caught).toMatchObject({ m5bCode: "M5B_DELTA_OUT_OF_SCOPE" });
    expect((caught as Error).message).toContain(poison);

    const diagnostic = await readCodexFinalizationDiagnosticV2(current.store, current.attemptId);
    expect(diagnostic).toMatchObject({ stage: "DELTA_DERIVATION", m5bCode: "M5B_DELTA_OUT_OF_SCOPE" });
    const diagnosticSource = await readFile(resolve(current.store.runDirectory, codexFinalizationDiagnosticRefV2(current.attemptId)), "utf8");
    expect(diagnosticSource).not.toContain(poison);
    expect(diagnosticSource).not.toContain("message");
    expect(diagnosticSource).not.toContain("stack");
    expect(diagnosticSource).not.toContain("cause");
  }, 60_000);

  it("does not replace the original typed ambiguity when diagnostic persistence fails", async () => {
    const current = await fixture();
    transport.stagingWrites = [
      { path: "src/status.js", content: STATUS_SOURCE },
      { path: "src/unexpected.js", content: "module.exports = 0;\n" },
    ];
    const { admitted } = await admitM5BAttemptV2(current);
    const executor = await createCodexCliExecutorV2({
      store: current.store,
      authorizedInvocation: admitted.authorizedInvocation,
      timeoutPolicy: current.timeoutPolicy,
      stagingBase: current.stagingBase,
      // The provider result has physical timestamps, but the diagnostic seal
      // rejects this host timestamp and therefore cannot become durable.
      clock: () => "not-an-iso-time",
    });
    const caught = await executor.invoke(admitted.authorizedInvocation).then(() => undefined, (error: unknown) => error);
    expect(caught).toBeInstanceOf(RalphM5BError);
    expect(caught).toMatchObject({ m5bCode: "M5B_DELTA_OUT_OF_SCOPE" });
    expect(await readCodexFinalizationDiagnosticV2(current.store, current.attemptId)).toBeUndefined();
  }, 60_000);

  it("refuses a provider attempt to reach a Core-owned root through the projection", async () => {
    const current = await fixture();
    transport.stagingWrites = [
      { path: "src/status.js", content: STATUS_SOURCE },
      { path: ".rb-harness/injected.txt", content: "provider injection\n" },
    ];
    await executeOnce(current);
    const artifacts = await readCodexInvocationArtifactSetV2(current.store, current.attemptId);
    expect(artifacts.workspaceDelta).toBeUndefined();
    expect(existsSync(join(current.projectRoot, ".rb-harness/injected.txt"))).toBe(false);
    expect(await readFile(join(current.projectRoot, ".rb-harness/canary.txt"), "utf8")).toBe("control-plane canary\n");
  }, 60_000);

  it("fails closed when the canonical workspace drifts before publication", async () => {
    const current = await fixture();
    transport.afterRunHook = async () => {
      await writeFile(join(current.projectRoot, "README.md"), "# drifted by an unrelated writer\n");
    };
    const { executed } = await executeOnce(current);
    expect(executed.kind).toBe("RECONCILIATION_REQUIRED");
    const artifacts = await readCodexInvocationArtifactSetV2(current.store, current.attemptId);
    expect(artifacts.workspaceDelta).toBeDefined();
    expect(artifacts.finalizationDiagnostic).toMatchObject({ stage: "WORKSPACE_PUBLICATION", m5bCode: "M5B_CANONICAL_DRIFT" });
    expect(await readCodexPublicationReceiptV2(current.store, current.attemptId)).toBeUndefined();
    expect(existsSync(join(current.projectRoot, "src/status.js"))).toBe(false);
  }, 60_000);

  it("does not diagnose ordinary FAILED, TIMED_OUT or CANCELLED provider results", async () => {
    const scenarios = [
      { classification: "FAILED", setup: () => { transport.exitCode = 7; } },
      { classification: "TIMED_OUT", setup: () => { transport.timedOut = true; } },
      { classification: "CANCELLED", setup: () => { transport.cancelled = true; } },
    ] as const;
    for (const scenario of scenarios) {
      const current = await fixture();
      scenario.setup();
      const { executed } = await executeOnce(current);
      expect(executed.kind).toBe("EXECUTOR_FINISHED_READY_FOR_CAPTURE");
      const artifacts = await readCodexInvocationArtifactSetV2(current.store, current.attemptId);
      expect(artifacts.providerResult?.classification).toBe(scenario.classification);
      expect(artifacts.terminal?.status).toBe(scenario.classification);
      expect(artifacts.finalizationDiagnostic).toBeUndefined();
      transport.exitCode = 0;
      transport.timedOut = false;
      transport.cancelled = false;
    }
  }, 120_000);
});

describe("Ralph M5-B — dispatch ordering, ambiguity and redispatch", () => {
  it("never reports NOT_INVOKED once a dispatch intent is durable, and refuses a second dispatch", async () => {
    const current = await fixture();
    const { admitted } = await admitM5BAttemptV2(current);
    const executor = await createCodexCliExecutorV2({
      store: current.store,
      authorizedInvocation: admitted.authorizedInvocation,
      timeoutPolicy: current.timeoutPolicy,
      stagingBase: current.stagingBase,
    });
    const invocationId = admitted.authorizedInvocation.descriptor.invocationId;
    expect((await executor.observe(invocationId)).state).toBe("NOT_INVOKED");
    await executor.invoke(admitted.authorizedInvocation);
    expect((await executor.observe(invocationId)).state).toBe("TERMINATED_QUIESCENT");
    await expect(executor.invoke(admitted.authorizedInvocation)).rejects.toThrow(/M5B_REDISPATCH_FORBIDDEN/);
    expect(transport.runs).toBe(1);
  }, 60_000);

  it("reports UNKNOWN — never NOT_INVOKED — when the process is gone without a durable terminal", async () => {
    const current = await fixture();
    const { admitted } = await admitM5BAttemptV2(current);
    const executor = await createCodexCliExecutorV2({
      store: current.store,
      authorizedInvocation: admitted.authorizedInvocation,
      timeoutPolicy: current.timeoutPolicy,
      stagingBase: current.stagingBase,
    });
    const invocationId = admitted.authorizedInvocation.descriptor.invocationId;
    // Crash between the durable dispatch intent and any durable terminal.
    transport.spawnHook = () => { throw new Error("host crashed after the process receipt"); };
    await expect(executor.invoke(admitted.authorizedInvocation)).rejects.toThrow();
    const observation = await executor.observe(invocationId);
    expect(observation.state).toBe("UNKNOWN");
    expect(observation.state).not.toBe("NOT_INVOKED");
    await expect(executor.invoke(admitted.authorizedInvocation)).rejects.toThrow(/M5B_REDISPATCH_FORBIDDEN/);
    expect(transport.runs).toBe(1);
  }, 60_000);

  it("refuses a non-authoritative CorrectionContext before any descriptor, projection or process exists", async () => {
    const current = await fixture();
    const { admitted } = await admitM5BAttemptV2(current);
    const fingerprint = await fingerprintWorkspace(current.projectRoot, current.snapshot.workspacePolicy);
    const context = createCorrectionContextV2({
      runId: current.runId,
      phaseId: "P01",
      taskId: "T001",
      currentAttemptId: current.attemptId,
      sourceRejectedAttempts: [],
      openFindingRefs: [],
      openFindings: [],
      baseWorkspaceFingerprint: fingerprint.fingerprintDigest,
      createdAt: "2026-09-08T00:00:00.000Z",
    });
    await persistCorrectionContextV2(current.store, context, "nonce-correction");
    const executor = await createCodexCliExecutorV2({
      store: current.store,
      authorizedInvocation: admitted.authorizedInvocation,
      timeoutPolicy: current.timeoutPolicy,
      stagingBase: current.stagingBase,
    });
    await expect(executor.invoke(admitted.authorizedInvocation)).rejects.toThrow(/M4C_CORRECTION_FINDING_SET_INCOMPLETE/);
    expect(await readCodexProviderDescriptorV2(current.store, current.attemptId)).toBeUndefined();
    expect((await executor.observe(admitted.authorizedInvocation.descriptor.invocationId)).state).toBe("NOT_INVOKED");
    expect(transport.runs).toBe(0);
  }, 60_000);
});

describe("Ralph M5-B — crash windows and cold reopen", () => {
  it("continues publication mechanically after a partial publication, without redispatch", async () => {
    const current = await fixture({ scope: "src/status.js src/second.js", covers: "src/status.js src/second.js" });
    transport.stagingWrites = [
      { path: "src/status.js", content: STATUS_SOURCE },
      { path: "src/second.js", content: "module.exports = 2;\n" },
    ];
    await executeOnce(current);
    const artifacts = await readCodexInvocationArtifactSetV2(current.store, current.attemptId);
    expect(artifacts.workspaceDelta?.entryCount).toBe(2);

    // Simulate a crash between two applied entries: the publication intent is
    // durable, one file is on disk, the receipt was never written.
    await unlink(join(current.store.runDirectory, "attempts", current.attemptId, "codex-publication-receipt.json"));
    await unlink(join(current.projectRoot, "src/second.js"));
    const { publishCodexWorkspaceDeltaV2 } = await import("../../src/vnext/ralph-runtime/operational-m5b/codex-publication.js");
    let ordinal = 0;
    const recovered = await publishCodexWorkspaceDeltaV2({
      store: current.store,
      delta: artifacts.workspaceDelta!,
      workspacePolicy: current.snapshot.workspacePolicy,
      clock: () => "2026-09-08T00:00:09.000Z",
      nonceFactory: () => `recover-${++ordinal}`,
    });
    expect(recovered.deltaDigest).toBe(artifacts.workspaceDelta!.deltaDigest);
    expect(await readFile(join(current.projectRoot, "src/second.js"), "utf8")).toBe("module.exports = 2;\n");
    expect(transport.runs).toBe(1);
  }, 60_000);

  it("reproduces the same durable state from a cold reopen without a new Codex call", async () => {
    const current = await fixture();
    const { executed } = await executeOnce(current);
    expect(executed.kind).toBe("EXECUTOR_FINISHED_READY_FOR_CAPTURE");
    const before = await readCodexInvocationArtifactSetV2(current.store, current.attemptId);
    const beforePublication = await readCodexPublicationReceiptV2(current.store, current.attemptId);

    const { RalphEventStoreV2 } = await import("../../src/vnext/ralph-runtime/operational-b1/index.js");
    const reopened = new RalphEventStoreV2({ projectRoot: current.projectRoot, runId: current.runId });
    const after = await readCodexInvocationArtifactSetV2(reopened, current.attemptId);
    expect(after.descriptor?.descriptorDigest).toBe(before.descriptor?.descriptorDigest);
    expect(after.threadBinding?.threadId).toBe(before.threadBinding?.threadId);
    expect(after.providerResult?.resultDigest).toBe(before.providerResult?.resultDigest);
    expect(after.terminal?.terminalDigest).toBe(before.terminal?.terminalDigest);
    expect(after.workspaceDelta?.deltaDigest).toBe(before.workspaceDelta?.deltaDigest);
    expect((await readCodexPublicationReceiptV2(reopened, current.attemptId))?.receiptDigest).toBe(beforePublication?.receiptDigest);
    expect(transport.runs).toBe(1);
  }, 60_000);

  it("keeps every crash window ordered and never duplicates a provider call", async () => {
    const stages: { readonly name: string; readonly hook: "spawn" | "after"; readonly expected: readonly string[] }[] = [
      { name: "crash between the process receipt and thread.started", hook: "spawn", expected: ["codex-provider-descriptor.json", "codex-projection-manifest.json", "codex-prompt.json", "codex-dispatch-intent.json", "codex-process-receipt.json"] },
      { name: "crash after the provider stream but before publication", hook: "after", expected: ["codex-provider-descriptor.json", "codex-dispatch-intent.json", "codex-process-receipt.json", "codex-thread-binding.json"] },
    ];
    for (const stage of stages) {
      const current = await fixture();
      const { admitted } = await admitM5BAttemptV2(current);
      const executor = await createCodexCliExecutorV2({
        store: current.store,
        authorizedInvocation: admitted.authorizedInvocation,
        timeoutPolicy: current.timeoutPolicy,
        stagingBase: current.stagingBase,
      });
      if (stage.hook === "spawn") transport.spawnHook = () => { throw new Error(stage.name); };
      else transport.afterRunHook = () => { throw new Error(stage.name); };
      await expect(executor.invoke(admitted.authorizedInvocation)).rejects.toThrow();
      const files = await readdir(join(current.store.runDirectory, "attempts", current.attemptId));
      for (const expected of stage.expected) expect(files, `${stage.name}: ${expected}`).toContain(expected);
      expect(files).not.toContain("codex-terminal.json");
      expect(files).not.toContain("codex-publication-receipt.json");
      expect((await executor.observe(admitted.authorizedInvocation.descriptor.invocationId)).state).toBe("UNKNOWN");
      await expect(executor.invoke(admitted.authorizedInvocation)).rejects.toThrow(/M5B_REDISPATCH_FORBIDDEN/);
      expect(transport.runs).toBe(1);
      transport.runs = 0;
      transport.spawnHook = undefined;
      transport.afterRunHook = undefined;
    }
  }, 120_000);
});

/**
 * Root-level product scope, driven through the whole Executor with a mocked
 * TRANSPORT only: the projection, the write-root plan, the permission
 * profile, the sentinels, the host delta and the publication are all the real
 * shipped code.  This is the MAJOR the remediation closes — a WorkUnit whose
 * authoritative product lives at the workspace root used to be refused
 * outright.
 */
describe("Ralph M5-B — root-level product scope end to end", () => {
  const PACKAGE_JSON = '{\n  "name": "rb-m5b-probe",\n  "private": true\n}\n';
  const INDEX_HTML = "<!doctype html>\n<title>M5-B fixture</title>\n";
  const SERVER_JS = "export {};\n";

  async function rootFixture(overrides: Parameters<typeof bootstrapM5BRunV2>[0] = {}) {
    return fixture({
      scope: "package.json",
      covers: "package.json",
      title: "Create the root package manifest",
      change: 'Create package.json at the workspace root with exactly {"name":"rb-m5b-probe","private":true}',
      acceptanceCriteria: ["package.json parses as JSON with name rb-m5b-probe and private true"],
      validation: ["`node -e 'const p=require(\"./package.json\"); if (p.name !== \"rb-m5b-probe\" || p.private !== true) process.exit(1)'`"],
      expectedEvidence: "A real workspace delta creating only package.json at the workspace root",
      ...overrides,
    });
  }

  it("publishes a root product file created under a writable staging root", async () => {
    transport.stagingWrites = [{ path: "package.json", content: PACKAGE_JSON }];
    transport.finalOutput = '{"summary":"created package.json"}';
    const current = await rootFixture();
    const { executed } = await executeOnce(current);
    expect(executed.kind).toBe("EXECUTOR_FINISHED_READY_FOR_CAPTURE");

    const artifacts = await readCodexInvocationArtifactSetV2(current.store, current.attemptId);
    // The descriptor records the root-scope binding explicitly, so a non-root
    // profile can never be replayed as this Attempt.
    expect(artifacts.descriptor?.stagingRootWritable).toBe(true);
    expect(artifacts.descriptor?.rootSentinelManifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(artifacts.projectionManifest?.stagingRootWritable).toBe(true);
    expect(artifacts.projectionManifest?.sentinels.map((entry) => entry.path)).toEqual([...CODEX_PROJECTION_EXCLUDED_ROOTS_V2].sort());
    expect(artifacts.workspaceDelta?.entries.map((entry) => `${entry.operation} ${entry.path}`)).toEqual(["CREATE package.json"]);

    const publication = await readCodexPublicationReceiptV2(current.store, current.attemptId);
    expect(publication?.appliedCount).toBe(1);
    expect(await readFile(join(current.projectRoot, "package.json"), "utf8")).toBe(PACKAGE_JSON);
    expect(JSON.parse(await readFile(join(current.projectRoot, "package.json"), "utf8"))).toEqual({ name: "rb-m5b-probe", private: true });
    // Every Core-owned canary is byte-identical: no sentinel content was ever
    // handled, published or overwritten.
    for (const controlRoot of CODEX_PROJECTION_EXCLUDED_ROOTS_V2) {
      expect(await readFile(join(current.projectRoot, controlRoot, "canary.txt"), "utf8")).toBe("control-plane canary\n");
    }
  }, 120_000);

  it("finalizes and publishes the real T001 shape while discarding empty runtime-like directories", async () => {
    transport.stagingWrites = [
      { path: "package.json", content: PACKAGE_JSON },
      { path: "public/index.html", content: INDEX_HTML },
      { path: "server.js", content: SERVER_JS },
    ];
    transport.finalOutput = '{"summary":"created the T001 application files"}';
    transport.afterRunHook = async (cwd) => {
      await mkdir(join(cwd, ".agents"));
      await mkdir(join(cwd, ".codex"));
    };
    const current = await rootFixture({
      scope: "package.json public/index.html server.js",
      covers: "package.json public/index.html server.js",
      scopePaths: ["package.json", "public/index.html", "server.js"],
      coversPaths: ["package.json", "public/index.html", "server.js"],
      title: "Create the T001 application files",
      change: "Create package.json, public/index.html and server.js",
      acceptanceCriteria: ["All three authorized application files exist"],
      validation: ["`node -e 'for (const p of [\"package.json\",\"public/index.html\",\"server.js\"]) require(\"fs\").accessSync(p)'`"],
      expectedEvidence: "A three-entry file delta and a successful terminal artifact",
    });
    const { admitted, executed, executor } = await executeOnce(current);
    expect(executed.kind).toBe("EXECUTOR_FINISHED_READY_FOR_CAPTURE");

    const artifacts = await readCodexInvocationArtifactSetV2(current.store, current.attemptId);
    expect(artifacts.providerResult).toMatchObject({ classification: "SUCCEEDED", terminalKind: "TURN_COMPLETED", actualExitCode: 0 });
    expect(artifacts.workspaceDelta?.entryCount).toBe(3);
    expect(artifacts.workspaceDelta?.entries.map((entry) => `${entry.operation} ${entry.path}`)).toEqual([
      "CREATE package.json",
      "CREATE public/index.html",
      "CREATE server.js",
    ]);
    expect(artifacts.terminal).toMatchObject({
      status: "SUCCEEDED",
      termination: "NORMAL",
      quiescence: { processState: "ABSENT", processTreeState: "QUIESCENT" },
    });
    expect((await executor.observe(admitted.authorizedInvocation.descriptor.invocationId)).state).toBe("TERMINATED_QUIESCENT");

    expect(await readFile(join(current.projectRoot, "package.json"), "utf8")).toBe(PACKAGE_JSON);
    expect(await readFile(join(current.projectRoot, "public/index.html"), "utf8")).toBe(INDEX_HTML);
    expect(await readFile(join(current.projectRoot, "server.js"), "utf8")).toBe(SERVER_JS);
    expect(existsSync(join(current.projectRoot, ".agents"))).toBe(false);
    expect(existsSync(join(current.projectRoot, ".codex"))).toBe(false);
    expect((await readCodexPublicationReceiptV2(current.store, current.attemptId))?.appliedCount).toBe(3);
  }, 120_000);

  it("carries the whole Attempt to COMPLETE through Evidence, Validation and Audit", async () => {
    transport.stagingWrites = [{ path: "package.json", content: PACKAGE_JSON }];
    transport.finalOutput = '{"summary":"created package.json"}';
    const current = await rootFixture();
    const { executed, executorLease } = await executeOnce(current);
    if (executed.kind !== "EXECUTOR_FINISHED_READY_FOR_CAPTURE") throw new Error(executed.kind);

    const captured = await captureEvidenceV2({ leasedRun: executorLease, plan: current.plan, attemptId: current.attemptId, observation: executed.observation });
    expect(captured.kind).toBe("EVIDENCE_CAPTURED_READY_FOR_VALIDATION");
    if (captured.kind !== "EVIDENCE_CAPTURED_READY_FOR_VALIDATION") throw new Error(captured.kind);
    expect(captured.evidence.controlPlaneChangedPaths).toEqual([]);

    const validated = await validateAttemptV2({ leasedRun: await acquireLeasedRunV2(current.leaseInput), plan: current.plan, attemptId: current.attemptId, executorObservation: executed.observation });
    expect(validated.kind).toBe("VALIDATION_READY_FOR_AUDIT");

    const auditor = new ScriptedAuditor({ defaultDecision: { verdict: "ACCEPT", rationale: "root product published exactly in scope" } });
    const audited = await auditAttemptV2({ leasedRun: await acquireLeasedRunV2(current.leaseInput), plan: current.plan, attemptId: current.attemptId, executorObservation: executed.observation, auditor });
    expect(audited.kind).toBe("AUDIT_ACCEPTED");
    expect(audited.state.disposition).toBe("COMPLETE");
    expect(transport.runs).toBe(1);
  }, 120_000);

  it("publishes nothing when the provider also writes an out-of-scope root file", async () => {
    // Physical capability let it write both; publishable authority covers one.
    // The WHOLE delta is refused rather than partially applied.
    transport.stagingWrites = [
      { path: "package.json", content: PACKAGE_JSON },
      { path: "secret.txt", content: "not covered\n" },
    ];
    transport.finalOutput = '{"summary":"created package.json"}';
    const current = await rootFixture();
    const { executed } = await executeOnce(current);
    expect(executed.kind).toBe("RECONCILIATION_REQUIRED");
    const artifacts = await readCodexInvocationArtifactSetV2(current.store, current.attemptId);
    expect(artifacts.providerResult).toMatchObject({ classification: "SUCCEEDED", terminalKind: "TURN_COMPLETED", actualExitCode: 0 });
    expect(artifacts.finalizationDiagnostic).toMatchObject({
      stage: "DELTA_DERIVATION",
      m5bCode: "M5B_DELTA_OUT_OF_SCOPE",
      providerResultDigest: artifacts.providerResult?.resultDigest,
    });
    expect(artifacts.terminal).toBeUndefined();
    expect(artifacts.workspaceDelta).toBeUndefined();
    expect(existsSync(join(current.projectRoot, "package.json"))).toBe(false);
    expect(existsSync(join(current.projectRoot, "secret.txt"))).toBe(false);
    expect(await readCodexPublicationReceiptV2(current.store, current.attemptId)).toBeUndefined();
  }, 120_000);

  it("fails closed and publishes nothing when a sentinel is disturbed", async () => {
    transport.stagingWrites = [{ path: "package.json", content: PACKAGE_JSON }];
    transport.finalOutput = '{"summary":"created package.json"}';
    transport.afterRunHook = async (cwd) => {
      // Simulate a provider that got past the physical denial: the host check
      // is the second, independent line and must still refuse.
      const { chmod: setMode, writeFile: write } = await import("node:fs/promises");
      await setMode(join(cwd, ".rb-harness"), 0o700);
      await write(join(cwd, ".rb-harness", "smuggled.txt"), "x\n");
    };
    const current = await rootFixture();
    const { executed } = await executeOnce(current);
    expect(executed.kind).toBe("RECONCILIATION_REQUIRED");
    const artifacts = await readCodexInvocationArtifactSetV2(current.store, current.attemptId);
    expect(artifacts.finalizationDiagnostic).toMatchObject({
      stage: "SENTINEL_VERIFICATION",
      m5bCode: "M5B_SENTINEL_VIOLATED",
      providerResultDigest: artifacts.providerResult?.resultDigest,
    });
    expect(artifacts.terminal).toBeUndefined();
    expect(artifacts.workspaceDelta).toBeUndefined();
    expect(existsSync(join(current.projectRoot, "package.json"))).toBe(false);
    expect(await readCodexPublicationReceiptV2(current.store, current.attemptId)).toBeUndefined();
    for (const controlRoot of CODEX_PROJECTION_EXCLUDED_ROOTS_V2) {
      expect(await readFile(join(current.projectRoot, controlRoot, "canary.txt"), "utf8")).toBe("control-plane canary\n");
    }
  }, 120_000);

  it("modifies and deletes root product files the scope covers", async () => {
    transport.stagingWrites = [{ path: "README.md", content: "# rewritten\n" }];
    transport.stagingDeletes = ["go.sum"];
    transport.finalOutput = '{"summary":"updated the root product"}';
    const current = await rootFixture({
      scope: "README.md go.sum",
      covers: "README.md go.sum",
      scopePaths: ["README.md", "go.sum"],
      coversPaths: ["README.md", "go.sum"],
      extraProductFiles: { "go.sum": "old\n" },
    });
    const { executed } = await executeOnce(current);
    expect(executed.kind).toBe("EXECUTOR_FINISHED_READY_FOR_CAPTURE");
    const artifacts = await readCodexInvocationArtifactSetV2(current.store, current.attemptId);
    expect(artifacts.workspaceDelta?.entries.map((entry) => `${entry.operation} ${entry.path}`)).toEqual(["MODIFY README.md", "DELETE go.sum"]);
    expect(await readFile(join(current.projectRoot, "README.md"), "utf8")).toBe("# rewritten\n");
    expect(existsSync(join(current.projectRoot, "go.sum"))).toBe(false);
  }, 120_000);

  it("reproduces an identical root-scope Attempt from a cold reopen with no new call", async () => {
    transport.stagingWrites = [{ path: "package.json", content: PACKAGE_JSON }];
    transport.finalOutput = '{"summary":"created package.json"}';
    const current = await rootFixture();
    await executeOnce(current);
    const before = await readCodexInvocationArtifactSetV2(current.store, current.attemptId);
    const callsAfterFirst = transport.runs;

    const reopened = new (Object.getPrototypeOf(current.store).constructor as new (input: { projectRoot: string; runId: string }) => typeof current.store)({
      projectRoot: current.projectRoot,
      runId: current.runId,
    });
    const after = await readCodexInvocationArtifactSetV2(reopened, current.attemptId);
    expect(after.descriptor?.descriptorDigest).toBe(before.descriptor?.descriptorDigest);
    expect(after.workspaceDelta?.deltaDigest).toBe(before.workspaceDelta?.deltaDigest);
    expect(after.terminal?.terminalDigest).toBe(before.terminal?.terminalDigest);
    expect(after.projectionManifest?.sentinelDigest).toBe(before.projectionManifest?.sentinelDigest);
    expect(transport.runs).toBe(callsAfterFirst);
  }, 120_000);
});

describe("Ralph M5-B — durable host-finalization diagnostics", () => {
  it("surfaces only sealed diagnostic facts across a cold bridge reopen without redispatch", async () => {
    const bridge = await createReadyBridgeFixture({ taskCount: 1 });
    disposableBridgeRoots.push(bridge.root);
    const runId = "finalization-diagnostic";
    const bridgeRunRoot = resolve(bridge.root, ".rb-harness/ralph/bridge-runs", runId);
    const workspaceRoot = resolve(bridgeRunRoot, "workspace");
    const stagingBase = resolve(bridgeRunRoot, "provider-staging");
    const poison = "M5B_POISON_NEVER_PERSIST_7f3a";
    transport.stagingWrites = [
      { path: "src/first.txt", content: "first\n" },
      { path: `src/${poison}.txt`, content: "not authorized\n" },
    ];
    transport.finalOutput = '{"summary":"created src/first.txt"}';

    let executorFactoryCalls = 0;
    let auditorFactoryCalls = 0;
    const first = await runProgressiveRalphBridgeV1(bridge.root, {
      ...bridgeIds(runId),
      runtimes: {
        executor: async ({ store, authorizedInvocation, timeoutPolicy }) => {
          executorFactoryCalls += 1;
          return createCodexCliExecutorV2({ store, authorizedInvocation, timeoutPolicy, stagingBase });
        },
        auditor: () => {
          auditorFactoryCalls += 1;
          return new ScriptedAuditor({ defaultDecision: { verdict: "ACCEPT", rationale: "must not run" } });
        },
      },
    });

    expect(first).toMatchObject({
      runId,
      status: "BLOCKED",
      errorCode: "RALPH_BRIDGE_RECONCILIATION_REQUIRED",
      publicationOccurred: false,
    });
    expect(executorFactoryCalls).toBe(1);
    expect(auditorFactoryCalls).toBe(0);
    expect(transport.runs).toBe(1);

    const store = new RalphEventStoreV2({ projectRoot: workspaceRoot, runId });
    const statePath = resolve(store.runDirectory, "state/current.json");
    const stateSource = await readFile(statePath, "utf8");
    const stateEnvelope = JSON.parse(stateSource) as { readonly state: { readonly attempts: Readonly<Record<string, { readonly stage: string }>> } };
    const attemptIds = Object.keys(stateEnvelope.state.attempts);
    expect(attemptIds).toHaveLength(1);
    const attemptId = attemptIds[0]!;
    const artifacts = await readCodexInvocationArtifactSetV2(store, attemptId);
    const diagnosticRef = codexFinalizationDiagnosticRefV2(attemptId);
    const expectedGuidance = `M5-B host finalization failed: stage=DELTA_DERIVATION code=M5B_DELTA_OUT_OF_SCOPE diagnostic=${diagnosticRef}. Inspect preserved evidence; do not redispatch.`;
    expect(first.guidance).toBe(expectedGuidance);
    expect(artifacts.providerResult).toMatchObject({ classification: "SUCCEEDED", terminalKind: "TURN_COMPLETED", actualExitCode: 0 });
    expect(artifacts.finalizationDiagnostic).toMatchObject({
      runId,
      taskId: "T001",
      attemptId,
      providerResultDigest: artifacts.providerResult?.resultDigest,
      stage: "DELTA_DERIVATION",
      m5bCode: "M5B_DELTA_OUT_OF_SCOPE",
    });
    expect(artifacts.terminal).toBeUndefined();
    expect(artifacts.workspaceDelta).toBeUndefined();
    expect(await readCodexPublicationReceiptV2(store, attemptId)).toBeUndefined();
    const beforeEvents = (await store.inspect()).events;
    const diagnosticSource = await readFile(resolve(store.runDirectory, diagnosticRef), "utf8");
    for (const durableOrPublic of [diagnosticSource, JSON.stringify(first), first.guidance ?? "", JSON.stringify(beforeEvents), stateSource]) {
      expect(durableOrPublic).not.toContain(poison);
    }

    let reopenedExecutorCalls = 0;
    let reopenedAuditorCalls = 0;
    const secondProcessRuntimes: BridgeRuntimeFactoriesV1 = {
      executor: () => {
        reopenedExecutorCalls += 1;
        throw new Error("executor must not be constructed while inspecting reconciliation");
      },
      auditor: () => {
        reopenedAuditorCalls += 1;
        throw new Error("auditor must not be constructed while inspecting reconciliation");
      },
    };
    const reopened = await runProgressiveRalphBridgeV1(bridge.root, { runtimes: secondProcessRuntimes });
    const reopenedStore = new RalphEventStoreV2({ projectRoot: workspaceRoot, runId });
    const reopenedArtifacts = await readCodexInvocationArtifactSetV2(reopenedStore, attemptId);
    expect(reopened).toMatchObject({
      runId,
      status: "BLOCKED",
      errorCode: "RALPH_BRIDGE_RECONCILIATION_REQUIRED",
      guidance: expectedGuidance,
      publicationOccurred: false,
    });
    expect(reopenedArtifacts.finalizationDiagnostic).toEqual(artifacts.finalizationDiagnostic);
    expect((await reopenedStore.inspect()).events).toEqual(beforeEvents);
    expect(reopenedExecutorCalls).toBe(0);
    expect(reopenedAuditorCalls).toBe(0);
    expect(transport.runs).toBe(1);
    expect(await readdir(resolve(bridge.root, ".rb-harness/ralph/bridge-runs"))).toEqual([runId]);
  }, 180_000);
});

function bridgeIds(runId: string) {
  let ordinal = 0;
  return {
    runIdFactory: () => runId,
    nonceFactory: () => `diagnostic-nonce-${++ordinal}`,
    eventIdFactory: () => `diagnostic-event-${++ordinal}`,
    attemptIdFactory: () => `diagnostic-attempt-${++ordinal}`,
  };
}
