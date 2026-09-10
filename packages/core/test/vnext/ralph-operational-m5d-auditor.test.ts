import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nodeRalphRuntimeFileSystem, type RalphRuntimeFileSystem } from "../../src/vnext/ralph-runtime/event-store.js";

const transport = vi.hoisted(() => ({
  runs: 0,
  threadId: "thr_m5d_auditor_0001",
  response: {} as Record<string, unknown>,
  earlierMessages: [] as string[],
  workspaceMutation: null as null | { path: string; content: string },
  throwBeforeSpawn: false,
  throwAfterSpawn: false,
  throwAfterThread: false,
  settlement: { observed: true, quiescent: true, verified: true },
}));

vi.mock("../../src/vnext/ralph-runtime/operational-m5b/codex-sandbox-backend.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/vnext/ralph-runtime/operational-m5b/codex-sandbox-backend.js")>();
  const { sha256Canonical } = await import("../../src/vnext/ralph-runtime/hashing.js");
  const base = { backendPath: "/usr/bin/bwrap", resolvedFromPath: "/usr/bin:/bin", executable: true as const, bundledFallbackSelected: false as const };
  return { ...actual, inspectCodexSandboxBackendV2: vi.fn(async () => Object.freeze({ ...base, factsDigest: sha256Canonical(base) })) };
});

vi.mock("../../src/vnext/ralph-runtime/operational-m5d/codex-audit-capability.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/vnext/ralph-runtime/operational-m5d/codex-audit-capability.js")>();
  const profileModule = await import("../../src/vnext/ralph-runtime/operational-m5d/codex-audit-permission-profile.js");
  const { sha256Canonical } = await import("../../src/vnext/ralph-runtime/hashing.js");
  const profile = profileModule.buildCodexAuditorPermissionProfileV2({ productWorkspace: "/tmp/m5d-capability", codexHome: "/home/fixture/.codex", codexRuntimeReadRoot: "/opt/codex-runtime" });
  const base = {
    schema: actual.CODEX_AUDITOR_CAPABILITY_PROBE_SCHEMA_V2,
    productSourceRead: "PROVEN" as const, productWriteDenied: "PROVEN" as const,
    productDeleteDenied: "PROVEN" as const, productRenameDenied: "PROVEN" as const,
    credentialOpenCloseDenied: "PROVEN" as const, rbHarnessReadWriteDenied: "PROVEN" as const,
    rbReadWriteDenied: "PROVEN" as const, gitReadWriteDenied: "PROVEN" as const,
    networkDenied: "PROVEN" as const, codexHomeEnvironmentAbsent: "PROVEN" as const,
    workspaceImmutable: "PROVEN" as const, permissionProfileDigest: profile.profileDigest,
    permissionPolicyShapeDigest: profileModule.codexAuditorPermissionPolicyShapeDigestV2(profile),
    probeExitCode: 0, matrixDigest: `sha256:${"a".repeat(64)}`, observedAt: "2026-09-09T12:00:00.000Z",
  };
  return { ...actual, probeCodexAuditorPhysicalCapabilityV2: vi.fn(async () => Object.freeze({ ...base, reportDigest: sha256Canonical(base) })) };
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
      executable: Object.freeze({ executablePath: contract.CODEX_CLI_NATIVE_EXECUTABLE_PATH_V2, executableVersion: contract.CODEX_CLI_EXECUTOR_CLI_VERSION_V2, executableSizeBytes: contract.CODEX_CLI_NATIVE_EXECUTABLE_SIZE_BYTES_V2, executableSha256: contract.CODEX_CLI_NATIVE_EXECUTABLE_SHA256_V2 }),
      managedRuntime: Object.freeze({ schema: managed.CODEX_MANAGED_RUNTIME_SCHEMA_V2, kind: managed.MANAGED_STOCK_CODEX_RUNTIME_KIND, runtimeId: managed.CODEX_MANAGED_RUNTIME_V2.id, upstreamVersion: managed.CODEX_MANAGED_RUNTIME_V2.upstreamVersion, rbRevision: managed.CODEX_MANAGED_RUNTIME_V2.rbRevision, version: managed.CODEX_MANAGED_RUNTIME_V2.version, transport: "codex-exec" as const, executablePath: contract.CODEX_CLI_NATIVE_EXECUTABLE_PATH_V2, executableSizeBytes: contract.CODEX_CLI_NATIVE_EXECUTABLE_SIZE_BYTES_V2, executableSha256: contract.CODEX_CLI_NATIVE_EXECUTABLE_SHA256_V2.replace(/^sha256:/, ""), reportedIdentity: managed.CODEX_MANAGED_RUNTIME_V2.expectedIdentity, payloadEntryCount: 6, payloadDigest: stock.managedStockCodexPayloadDigest(managed.STOCK_CODEX_CLI_RUNTIME.platforms["linux-x86_64"]!.payload), identityDigest: managed.codexManagedRuntimeExpectedIdentityDigestV2() }),
    })),
    runCodexProcessV2: vi.fn(async (input: Parameters<typeof actual.runCodexProcessV2>[0]) => {
      transport.runs += 1;
      if (transport.throwBeforeSpawn) throw new Error("fixture crash before process receipt");
      const host = await defaultProcessIdentityProvider.current();
      const processIdentity = Object.freeze({ ...host, pid: 4_195_301 + transport.runs, processStartIdentity: `sha256:${String(transport.runs).padStart(64, "b")}`.slice(0, 71) });
      const startedAt = "2026-09-09T12:00:01.000Z";
      await input.onSpawned?.(Object.freeze({ processIdentity, processGroupId: processIdentity.pid, containmentKind: "cgroup2", containmentStructural: true, startedAt }));
      await input.onBeforeStdin?.();
      if (transport.throwAfterSpawn) throw new Error("fixture crash after process receipt");
      if (transport.workspaceMutation) await writeFile(join(input.cwd, transport.workspaceMutation.path), transport.workspaceMutation.content);
      const output = JSON.stringify(transport.response);
      const outputIndex = input.argv.indexOf("-o");
      await writeFile(input.argv[outputIndex + 1]!, output, { mode: 0o600 });
      const events = [
        { type: "thread.started", thread_id: transport.threadId },
        { type: "turn.started" },
        ...transport.earlierMessages.map((text, index) => ({ type: "item.completed", item: { id: `early-${index}`, item_type: "agent_message", text } })),
        { type: "item.completed", item: { id: "final", item_type: "agent_message", text: output } },
        { type: "turn.completed", usage: { input_tokens: 80, output_tokens: 20 } },
      ];
      const stdout = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
      input.onStdoutChunk?.(stdout);
      if (transport.throwAfterThread) throw new Error("fixture crash after thread binding");
      return Object.freeze({ processIdentity, processGroupId: processIdentity.pid, containmentKind: "cgroup2", containmentStructural: true, startedAt, finishedAt: "2026-09-09T12:00:02.000Z", exitCode: 0, signal: null, timedOut: false, cancelled: false, stdout, stderr: "", stdoutTruncated: false, stderrTruncated: false, settlement: Object.freeze({ ...transport.settlement, survivors: [], containment: { kind: "cgroup2", structural: true, reason: "fixture" } }) });
    }),
  };
});

import { RalphEventStoreV2, commitRalphEventV2 } from "../../src/vnext/ralph-runtime/operational-b1/index.js";
import { acquireLeasedRunV2, releaseLeasedRunV2, type ProcessIdentityProvider } from "../../src/vnext/ralph-runtime/operational-b2/index.js";
import { ScriptedExecutor, executeAuthorizedInvocationV2 } from "../../src/vnext/ralph-runtime/operational-b4/index.js";
import { captureEvidenceV2 } from "../../src/vnext/ralph-runtime/operational-c/index.js";
import { readAuditPackageV2, validateAttemptV2, type AuditPackageV2 } from "../../src/vnext/ralph-runtime/operational-d/index.js";
import { auditAttemptV2, isTrustedAuditorRuntimeV2, readAuditResultV2 } from "../../src/vnext/ralph-runtime/operational-e/index.js";
import { canonicalJson } from "../../src/vnext/ralph-runtime/canonical-json.js";
import { sha256Canonical } from "../../src/vnext/ralph-runtime/hashing.js";
import { fingerprintWorkspace } from "../../src/vnext/ralph-runtime/fingerprint.js";
import {
  buildCodexPermissionProfileV2,
} from "../../src/vnext/ralph-runtime/operational-m5b/codex-permission-profile.js";
import {
  RALPH_CODEX_THREAD_BINDING_SCHEMA_V2,
  sealCodexArtifactV2,
  type CodexThreadBindingV2,
} from "../../src/vnext/ralph-runtime/operational-m5b/codex-artifacts.js";
import { ensureAttemptArtifactDirectoryV2 } from "../../src/vnext/ralph-runtime/operational-b4/artifacts.js";
import {
  CODEX_AUDIT_OUTPUT_SCHEMA_V2,
  CodexCliAuditorV2,
  RALPH_CODEX_AUDIT_PROVIDER_RESULT_SCHEMA_V2,
  assertCodexAuditFinalMessageV2,
  assertCodexAuditThreadIsFreshV2,
  assertCodexAuditorPermissionProfileV2,
  buildCodexAuditorPermissionProfileV2,
  buildCodexAuditorExecArgvV2,
  codexAuditorRuntimeIdentityV2,
  createCodexCliAuditorV2,
  isGenuineCodexCliAuditorV2,
  readCodexAuditArtifactSetV2,
  projectAuditPackageToCodexPromptV2,
  sealCodexAuditArtifactV2,
  validateCodexAuditProviderResultV2,
  validateCodexAuditTerminalArtifactV2,
  validateExactCodexAuditOutputV2,
  type CodexAuditProviderResultV2,
  type CodexAuditTerminalArtifactV2,
} from "../../src/vnext/ralph-runtime/operational-m5d/index.js";
import { bootstrapM5BRunV2, admitM5BAttemptV2, m5bEvent, type M5BFixtureV2 } from "./fixtures/ralph-m5b-fixture.js";

const ABSENT: ProcessIdentityProvider = { current: async () => ({ pid: 1, processStartIdentity: "x", hostIdentity: "h", bootSessionIdentity: "b" }), inspect: async () => "ABSENT" as const };
const disposables: M5BFixtureV2[] = [];

beforeEach(() => {
  transport.runs = 0;
  transport.threadId = "thr_m5d_auditor_0001";
  transport.response = { verdict: "REJECT", proposedFindings: [{ criterionId: "criterion:1", structuredFindingKey: "status-export-mismatch", severity: "HIGH", scope: ["src/status.js"], expectation: "requiring src/status.js returns ready", observed: "src/status.js exports broken", remediationHint: "export ready" }], resolvedFindingRefs: [], rationale: "The semantic acceptance criterion is not satisfied." };
  transport.earlierMessages = [];
  transport.workspaceMutation = null;
  transport.throwBeforeSpawn = false;
  transport.throwAfterSpawn = false;
  transport.throwAfterThread = false;
  transport.settlement = { observed: true, quiescent: true, verified: true };
});
afterEach(async () => { for (const item of disposables.splice(0)) { await rm(item.projectRoot, { recursive: true, force: true }); await rm(item.stagingBase, { recursive: true, force: true }); } });

interface Prepared {
  fixture: M5BFixtureV2;
  attemptId: string;
  observation: import("../../src/vnext/ralph-runtime/operational-b4/execution-observation.js").TrustedExecutorObservationV2;
  auditPackage: AuditPackageV2;
}

async function prepare(validation = "`node -e 'require(\"./src/status.js\")'`"): Promise<Prepared> {
  const fixture = await bootstrapM5BRunV2({ maxTaskAttemptsPerTask: 3, validation: [validation], acceptanceCriteria: ["Requiring ./src/status.js returns exactly the string ready"] });
  disposables.push(fixture);
  const attemptId = fixture.attemptId;
  await admitM5BAttemptV2(fixture, attemptId);
  const executorLease = await acquireLeasedRunV2(fixture.leaseInput);
  const executed = await executeAuthorizedInvocationV2({ leasedRun: executorLease, plan: fixture.plan, planIdentity: fixture.plan.artifactId, planDigest: fixture.planDigest, attemptId, runtime: new ScriptedExecutor({ defaultScenario: { kind: "SUCCESS", fixtureWorkspaceAction: async () => writeFile(join(fixture.projectRoot, "src/status.js"), 'module.exports = "broken";\n') } }) });
  if (executed.kind !== "EXECUTOR_FINISHED_READY_FOR_CAPTURE") throw new Error(executed.kind);
  const captured = await captureEvidenceV2({ leasedRun: executorLease, plan: fixture.plan, attemptId, observation: executed.observation });
  if (captured.kind !== "EVIDENCE_CAPTURED_READY_FOR_VALIDATION") throw new Error(captured.kind);
  const validated = await validateAttemptV2({ leasedRun: await acquireLeasedRunV2(fixture.leaseInput), plan: fixture.plan, attemptId, executorObservation: executed.observation });
  if (validated.kind !== "VALIDATION_READY_FOR_AUDIT") throw new Error(validated.kind);
  const auditPackage = await readAuditPackageV2(fixture.store, attemptId);
  if (!auditPackage) throw new Error("missing AuditPackage");
  return { fixture, attemptId, observation: executed.observation, auditPackage };
}

async function auditor(prepared: Prepared, fs?: RalphRuntimeFileSystem): Promise<CodexCliAuditorV2> {
  return createCodexCliAuditorV2({ store: new RalphEventStoreV2({ projectRoot: prepared.fixture.projectRoot, runId: prepared.fixture.runId, ...(fs ? { fs } : {}) }), auditPackage: prepared.auditPackage, timeoutPolicy: prepared.fixture.timeoutPolicy, ioBase: prepared.fixture.stagingBase, processIdentityProvider: ABSENT, clock: () => "2026-09-09T12:00:03.000Z", nonceFactory: () => `m5d-${Math.random().toString(16).slice(2)}` });
}

async function coreAudit(prepared: Prepared, runtime: CodexCliAuditorV2, fs?: RalphRuntimeFileSystem) {
  return auditAttemptV2({ leasedRun: await acquireLeasedRunV2({ ...prepared.fixture.leaseInput, ...(fs ? { fs } : {}), runtimeInstanceId: `m5d-audit-${Math.random().toString(16).slice(2)}` }), plan: prepared.fixture.plan, attemptId: prepared.attemptId, executorObservation: prepared.observation, auditor: runtime, clock: () => "2026-09-09T12:00:04.000Z" });
}

async function prepareSecondAttempt(prepared: Prepared): Promise<Prepared> {
  const checkpointLease = await acquireLeasedRunV2({ ...prepared.fixture.leaseInput, runtimeInstanceId: `m5d-checkpoint-${Math.random()}` });
  try {
    const observed = await fingerprintWorkspace(prepared.fixture.projectRoot, prepared.fixture.snapshot.workspacePolicy);
    await commitRalphEventV2({
      store: checkpointLease.store,
      state: checkpointLease.state,
      event: m5bEvent(checkpointLease.state, "workspace.checkpointed", { checkpoint: {
        kind: "acceptedCheckpointFingerprint", fingerprintDigest: observed.fingerprintDigest,
        emittedAt: "2026-09-09T12:00:05.000Z", attemptId: prepared.attemptId,
        evidenceSetId: checkpointLease.state.attempts[prepared.attemptId]?.evidenceCapture?.evidenceCaptureId,
      } }),
      writtenAt: "2026-09-09T12:00:05.000Z", nonce: `m5d-checkpoint-${Math.random()}`,
    });
  } finally { await releaseLeasedRunV2(checkpointLease); }
  const attemptId = `attempt-m5d-second-${Math.random().toString(16).slice(2)}`;
  await admitM5BAttemptV2(prepared.fixture, attemptId);
  const executorLease = await acquireLeasedRunV2({ ...prepared.fixture.leaseInput, runtimeInstanceId: `m5d-second-executor-${Math.random()}` });
  const executed = await executeAuthorizedInvocationV2({ leasedRun: executorLease, plan: prepared.fixture.plan, planIdentity: prepared.fixture.plan.artifactId, planDigest: prepared.fixture.planDigest, attemptId, runtime: new ScriptedExecutor({ defaultScenario: { kind: "SUCCESS", fixtureWorkspaceAction: async () => writeFile(join(prepared.fixture.projectRoot, "src/status.js"), 'module.exports = "ready";\n') } }) });
  if (executed.kind !== "EXECUTOR_FINISHED_READY_FOR_CAPTURE") throw new Error(executed.kind);
  const captured = await captureEvidenceV2({ leasedRun: executorLease, plan: prepared.fixture.plan, attemptId, observation: executed.observation });
  if (captured.kind !== "EVIDENCE_CAPTURED_READY_FOR_VALIDATION") throw new Error(captured.kind);
  const validated = await validateAttemptV2({ leasedRun: await acquireLeasedRunV2({ ...prepared.fixture.leaseInput, runtimeInstanceId: `m5d-second-validation-${Math.random()}` }), plan: prepared.fixture.plan, attemptId, executorObservation: executed.observation });
  if (validated.kind !== "VALIDATION_READY_FOR_AUDIT") throw new Error(validated.kind);
  const auditPackage = await readAuditPackageV2(prepared.fixture.store, attemptId);
  if (!auditPackage) throw new Error("missing second AuditPackage");
  return { fixture: prepared.fixture, attemptId, observation: executed.observation, auditPackage };
}

function failOnePublish(predicate: (target: string, source: string) => Promise<boolean> | boolean): RalphRuntimeFileSystem {
  let armed = true;
  return {
    ...nodeRalphRuntimeFileSystem,
    link: async (source, target) => {
      if (armed && await predicate(target, source)) {
        armed = false;
        await nodeRalphRuntimeFileSystem.unlink(source).catch(() => undefined);
        throw Object.assign(new Error(`fixture publication crash: ${target}`), { code: "EIO" });
      }
      await nodeRalphRuntimeFileSystem.link(source, target);
    },
  };
}

function eventPublishFailure(eventType: string): RalphRuntimeFileSystem {
  return failOnePublish(async (target, source) => {
    if (!target.includes("/events/") || !target.endsWith(".json")) return false;
    try { return (JSON.parse((await nodeRalphRuntimeFileSystem.readFile(source)).toString("utf8")) as { eventType?: string }).eventType === eventType; }
    catch { return false; }
  });
}

describe("Ralph M5-D — nominal trust, identity and physical profile", () => {
  it("M5D-1 rejects every structural/prototype/clone/subclass/Reflect/Proxy/cast fake", async () => {
    const p = await prepare(); const genuine = await auditor(p);
    expect(isGenuineCodexCliAuditorV2(genuine)).toBe(true); expect(isTrustedAuditorRuntimeV2(genuine)).toBe(true); expect(Object.isFrozen(genuine)).toBe(true);
    const fakes = [
      { kind: "AUDITOR_RUNTIME", runtimeIdentity: genuine.runtimeIdentity, profileId: genuine.profileId, profileDigest: genuine.profileDigest, invoke: genuine.invoke },
      JSON.parse(JSON.stringify(genuine)), structuredClone(genuine), Object.create(CodexCliAuditorV2.prototype), new Proxy(genuine, {}),
    ];
    for (const fake of fakes) expect(isTrustedAuditorRuntimeV2(fake as CodexCliAuditorV2)).toBe(false);
    expect(() => Reflect.construct(CodexCliAuditorV2 as unknown as new (...args: unknown[]) => CodexCliAuditorV2, [{}, Symbol("fake")])).toThrow(/M5D_AUDITOR_AUTHORITY_REQUIRED/);
    class Subclass extends CodexCliAuditorV2 { constructor() { super({} as never, Symbol("fake")); } }
    expect(() => new Subclass()).toThrow(/M5D_AUDITOR_AUTHORITY_REQUIRED/);
  });

  it("M5D-2/M5D-3/M5D-5 refuses Executor profile reuse, every WRITE, and loss of CODEX_HOME deny", () => {
    const audit = buildCodexAuditorPermissionProfileV2({ productWorkspace: "/tmp/m5d-workspace", codexHome: "/home/fixture/.codex", codexRuntimeReadRoot: "/opt/codex-runtime" });
    const executor = buildCodexPermissionProfileV2({ stagingWorkspace: "/tmp/m5d-workspace", writableRoots: ["src"], codexHome: "/home/fixture/.codex", codexRuntimeReadRoot: "/opt/codex-runtime" });
    expect(() => assertCodexAuditorPermissionProfileV2(executor)).toThrow(/M5D_PERMISSION_PROFILE_INVALID/);
    const widenBase = { ...audit, filesystem: audit.filesystem.map((entry) => entry.role === "PRODUCT_WORKSPACE" ? { ...entry, access: "write" } : entry) }; const { profileDigest: _one, ...widen } = widenBase;
    expect(() => assertCodexAuditorPermissionProfileV2({ ...widen, profileDigest: sha256Canonical(widen) })).toThrow(/M5D_PERMISSION_PROFILE_INVALID/);
    const removedBase = { ...audit, filesystem: audit.filesystem.filter((entry) => entry.role !== "CODEX_HOME") }; const { profileDigest: _two, ...removed } = removedBase;
    expect(() => assertCodexAuditorPermissionProfileV2({ ...removed, profileDigest: sha256Canonical(removed) })).toThrow(/M5D_PERMISSION_PROFILE_INVALID/);
    expect(audit.filesystem.some((entry) => entry.access === ("write" as never))).toBe(false);
  });

  it("binds role, managed runtime, capability/profile, model, AuditPackage and timeout without Executor collision", async () => {
    const p = await prepare(); const a = await auditor(p);
    expect(a.runtimeIdentity).toMatch(/^codex-cli-auditor-[0-9a-f]{64}$/);
    expect(a.runtimeIdentity).not.toBe("codex-cli-runtime-v2");
    const internals = { kind: "stock-codex-cli-managed", version: "0.153.4-rb.1", identityDigest: `sha256:${"b".repeat(64)}` } as never;
    expect(codexAuditorRuntimeIdentityV2({ managedRuntime: internals, permissionProfileDigest: `sha256:${"1".repeat(64)}`, capabilityDigest: `sha256:${"2".repeat(64)}`, auditPackage: p.auditPackage, timeoutPolicyDigest: p.fixture.timeoutPolicy.policyDigest })).not.toBe("codex-cli-runtime-v2");
  });

  it("uses one fresh ephemeral audit transport and an AuditPackage-only bounded prompt", async () => {
    const p = await prepare();
    const profile = buildCodexAuditorPermissionProfileV2({ productWorkspace: p.fixture.projectRoot, codexHome: "/home/fixture/.codex", codexRuntimeReadRoot: "/opt/codex-runtime" });
    const argv = buildCodexAuditorExecArgvV2({ productWorkspace: p.fixture.projectRoot, outputSchemaPath: "/tmp/m5d-schema.json", finalOutputPath: "/tmp/m5d-output.json", permissionProfile: profile });
    expect(argv).toContain("--ephemeral"); expect(argv).toContain("--output-schema"); expect(argv).toContain("-o");
    expect(argv).toContain("gpt-5.6-sol"); expect(argv).not.toContain("resume"); expect(argv).not.toContain("fork"); expect(argv).not.toContain("--last"); expect(argv).not.toContain("--sandbox");
    const prompt = projectAuditPackageToCodexPromptV2(p.auditPackage);
    expect(prompt.byteLength).toBe(Buffer.byteLength(prompt.text, "utf8"));
    for (const fact of [p.auditPackage.packageDigest, p.auditPackage.acceptanceCriteria[0]!, p.auditPackage.constraints.scope, "Deterministic hard negative: NO", "physically read-only", "Core mints the id", "exact structured object"]) expect(prompt.text).toContain(fact);
  });
});

describe("Ralph M5-D — proposal and workspace authority mutations", () => {
  it("M5D-4 rejects a physical Auditor workspace mutation and materializes no Core AuditResult", async () => {
    const p = await prepare(); transport.workspaceMutation = { path: "src/status.js", content: 'module.exports = "tampered";\n' };
    await expect(coreAudit(p, await auditor(p))).rejects.toThrow(/E_AUDITOR_RESULT_INVALID/);
    expect(await readAuditResultV2(p.fixture.store, p.attemptId)).toBeUndefined();
  });

  it("M5D-6 binds the exact frozen durable AuditPackage before dispatch", async () => {
    const p = await prepare(); const a = await auditor(p);
    const { packageDigest: _digest, ...base } = p.auditPackage;
    const wrongBase = { ...base, constraints: { ...base.constraints, taskTitle: "caller replacement" } };
    const wrong = Object.freeze({ ...wrongBase, packageDigest: sha256Canonical(wrongBase) }) as AuditPackageV2;
    await expect(a.invoke(wrong)).rejects.toThrow(/M5D_AUDIT_PACKAGE_BINDING_INVALID/);
    expect(transport.runs).toBe(0);
  });

  it("M5D-7 rejects provider-controlled findingId/id/finalFindingId at exact schema validation", async () => {
    const p = await prepare();
    for (const key of ["findingId", "id", "finalFindingId"]) {
      const finding = { criterionId: "criterion:1", structuredFindingKey: "x", severity: "HIGH", scope: ["src/status.js"], expectation: "ready", observed: "broken", [key]: "finding-provider" };
      expect(() => validateExactCodexAuditOutputV2(JSON.stringify({ verdict: "REJECT", proposedFindings: [finding], resolvedFindingRefs: [], rationale: "bad" }), p.auditPackage)).toThrow(/M5D_PROVIDER_RESULT_INVALID/);
    }
    expect((CODEX_AUDIT_OUTPUT_SCHEMA_V2.properties.proposedFindings.items as { additionalProperties: boolean }).additionalProperties).toBe(false);
  });

  it("M5D-8 lets frozen Core turn deterministic red plus provider ACCEPT into AUDIT_REJECTED", async () => {
    const p = await prepare("`node -e 'const s=require(\"./src/status.js\"); if(s!==\"ready\") process.exit(1)'`");
    transport.response = { verdict: "ACCEPT", proposedFindings: [], resolvedFindingRefs: [], rationale: "provider attempted acceptance" };
    const result = await coreAudit(p, await auditor(p));
    expect(result.kind).toBe("AUDIT_REJECTED");
    expect(Object.values(result.state.findings)).toEqual(expect.arrayContaining([expect.objectContaining({ status: "OPEN", severity: "BLOCKER" })]));
  });

  it("M5D-9 preserves an omitted OPEN Finding and lets frozen Core reject the incomplete ACCEPT", async () => {
    const first = await prepare();
    const rejected = await coreAudit(first, await auditor(first));
    expect(rejected.kind).toBe("AUDIT_REJECTED");
    const finding = Object.values(rejected.state.findings)[0];
    if (!finding) throw new Error("missing first Finding");
    const second = await prepareSecondAttempt(first);
    expect(second.auditPackage.openFindingRefs.map((reference) => reference.findingId)).toEqual([finding.id]);
    transport.threadId = "thr_m5d_auditor_omitted_resolution";
    transport.response = { verdict: "ACCEPT", proposedFindings: [], resolvedFindingRefs: [], rationale: "omitted the current Finding" };
    const incomplete = await coreAudit(second, await auditor(second));
    expect(incomplete.kind).toBe("AUDIT_REJECTED");
    expect(incomplete.state.findings[finding.id]?.status).toBe("OPEN");
    expect(incomplete.state.tasks.T001?.disposition).not.toBe("COMPLETE");
  }, 30_000);
});

describe("Ralph M5-D — threads, terminal facts and provider/Core separation", () => {
  it("M5D-10/M5D-11 rejects Executor/Correction and previous Auditor thread reuse from durable bindings", async () => {
    const p = await prepare(); const other = "attempt-prior-thread"; const directory = await ensureAttemptArtifactDirectoryV2(p.fixture.store, other);
    const core = { runId: p.fixture.runId, phaseId: "P01", taskId: "T001", attemptId: other, invocationId: "invocation-prior" };
    const executor = sealCodexArtifactV2<CodexThreadBindingV2>({ schema: RALPH_CODEX_THREAD_BINDING_SCHEMA_V2, ...core, descriptorRef: `attempts/${other}/codex-provider-descriptor.json`, descriptorDigest: `sha256:${"1".repeat(64)}`, dispatchIntentRef: `attempts/${other}/codex-dispatch-intent.json`, dispatchIntentDigest: `sha256:${"2".repeat(64)}`, processReceiptRef: `attempts/${other}/codex-process-receipt.json`, processReceiptDigest: `sha256:${"3".repeat(64)}`, threadId: "thr_reused_executor", boundAt: "2026-09-09T12:00:00.000Z" }, "bindingDigest");
    await writeFile(join(directory, "codex-thread-binding.json"), canonicalJson(executor), { mode: 0o600 });
    await expect(assertCodexAuditThreadIsFreshV2(p.fixture.store, p.attemptId, "thr_reused_executor")).rejects.toThrow(/M5D_THREAD_REUSE_FORBIDDEN/);
    const a = await auditor(p); transport.threadId = "thr_unique_auditor"; await coreAudit(p, a);
    const facts = await readCodexAuditArtifactSetV2(p.fixture.store, p.attemptId);
    await ensureAttemptArtifactDirectoryV2(p.fixture.store, "attempt-next-audit");
    await expect(assertCodexAuditThreadIsFreshV2(p.fixture.store, "attempt-next-audit", facts.threadBinding!.threadId)).rejects.toThrow(/M5D_THREAD_REUSE_FORBIDDEN/);
  });

  it("M5D-12/M5D-13 refuses provider result without real exit and terminal without positive quiescence", async () => {
    const p = await prepare(); await coreAudit(p, await auditor(p)); const facts = await readCodexAuditArtifactSetV2(p.fixture.store, p.attemptId);
    const { resultDigest: _r, ...resultBase } = facts.providerResult!;
    const noExit = sealCodexAuditArtifactV2<CodexAuditProviderResultV2>({ ...resultBase, actualExitCode: null }, "resultDigest");
    expect(() => validateCodexAuditProviderResultV2(noExit)).toThrow(/provider success facts/);
    const { terminalDigest: _t, ...terminalBase } = facts.terminal!;
    const qBase = { ...terminalBase.quiescence, settlementQuiescent: false }; const { evidenceDigest: _q, ...qNoDigest } = qBase;
    const nonQuiescent = sealCodexAuditArtifactV2<CodexAuditTerminalArtifactV2>({ ...terminalBase, quiescence: { ...qNoDigest, evidenceDigest: sha256Canonical(qNoDigest) } }, "terminalDigest");
    expect(() => validateCodexAuditTerminalArtifactV2(nonQuiescent)).toThrow(/M5D_PROCESS_TREE_NOT_QUIESCENT/);
  });

  it("M5D-14 treats post-intent ambiguity as UNKNOWN and never redispatches", async () => {
    const p = await prepare(); transport.throwAfterSpawn = true;
    await expect(coreAudit(p, await auditor(p))).rejects.toThrow(/E_AUDITOR_RESULT_INVALID/);
    expect(transport.runs).toBe(1);
    transport.throwAfterSpawn = false;
    await expect(coreAudit(p, await auditor(p))).rejects.toThrow(/E_AUDITOR_RESULT_INVALID/);
    expect(transport.runs).toBe(1);
  });

  it("M5D-15 uses the LAST completed agent_message and binds it to -o", async () => {
    const p = await prepare(); transport.earlierMessages = [JSON.stringify({ verdict: "ACCEPT", proposedFindings: [], resolvedFindingRefs: [], rationale: "wrong first" })];
    const result = await coreAudit(p, await auditor(p)); expect(result.kind).toBe("AUDIT_REJECTED");
    const structured = validateExactCodexAuditOutputV2(JSON.stringify(transport.response), p.auditPackage);
    expect(() => assertCodexAuditFinalMessageV2(transport.earlierMessages[0]!, structured)).toThrow(/last agent_message differs/);
  });

  it("M5D-16 persists provider result separately and lets Core create AuditResult", async () => {
    const p = await prepare(); const result = await coreAudit(p, await auditor(p)); const facts = await readCodexAuditArtifactSetV2(p.fixture.store, p.attemptId); const core = await readAuditResultV2(p.fixture.store, p.attemptId);
    expect(result.kind).toBe("AUDIT_REJECTED");
    expect(facts.providerResult?.schema).toBe(RALPH_CODEX_AUDIT_PROVIDER_RESULT_SCHEMA_V2);
    expect(core?.schema).toBe("rb-ralph-audit-result/v1");
    expect(facts.providerResult?.resultDigest).not.toBe(core?.resultDigest);
    expect(core?.metadata.providerResultDigest).toBe(facts.providerResult?.resultDigest);
  });
});

describe("Ralph M5-D — durable audit crash/restart matrix A–I", () => {
  it("A: a provider descriptor without dispatch intent is safely resumed with one physical dispatch", async () => {
    const p = await prepare();
    const fs = failOnePublish((target) => target.endsWith("/codex-audit-prompt.json"));
    await expect(coreAudit(p, await auditor(p, fs), fs)).rejects.toThrow(/E_AUDITOR_RESULT_INVALID/);
    const boundary = await readCodexAuditArtifactSetV2(p.fixture.store, p.attemptId);
    expect(boundary.descriptor).toBeDefined();
    expect(boundary.dispatchIntent).toBeUndefined();
    expect(transport.runs).toBe(0);
    const resumed = await coreAudit(p, await auditor(p));
    expect(resumed.kind).toBe("AUDIT_REJECTED");
    expect(transport.runs).toBe(1);
  });

  it("B/C/D/E: every incomplete post-intent physical boundary is UNKNOWN and cannot redispatch", async () => {
    const cases = [
      { label: "B intent before process receipt", setup: () => { transport.throwBeforeSpawn = true; }, present: "dispatchIntent" },
      { label: "C process receipt before thread.started", setup: () => { transport.throwAfterSpawn = true; }, present: "processReceipt" },
      { label: "D thread binding before terminal", setup: () => { transport.throwAfterThread = true; }, present: "threadBinding" },
      { label: "E turn.completed before provider result", setup: () => { transport.response = { ...transport.response, providerControlledState: "COMPLETE" }; }, present: "threadBinding" },
    ] as const;
    for (const boundary of cases) {
      transport.throwBeforeSpawn = false; transport.throwAfterSpawn = false; transport.throwAfterThread = false;
      transport.response = { verdict: "REJECT", proposedFindings: [{ criterionId: "criterion:1", structuredFindingKey: "status-export-mismatch", severity: "HIGH", scope: ["src/status.js"], expectation: "requiring src/status.js returns ready", observed: "src/status.js exports broken", remediationHint: "export ready" }], resolvedFindingRefs: [], rationale: "semantic rejection" };
      boundary.setup();
      const p = await prepare();
      await expect(coreAudit(p, await auditor(p))).rejects.toThrow(/E_AUDITOR_RESULT_INVALID/);
      const artifacts = await readCodexAuditArtifactSetV2(p.fixture.store, p.attemptId);
      expect(artifacts[boundary.present]).toBeDefined();
      const calls = transport.runs;
      transport.throwBeforeSpawn = false; transport.throwAfterSpawn = false; transport.throwAfterThread = false;
      await expect(coreAudit(p, await auditor(p))).rejects.toThrow(/E_AUDITOR_RESULT_INVALID/);
      expect(transport.runs).toBe(calls);
    }
  }, 120_000);

  it("F: a provider result before positive quiescence is durable but cannot redispatch", async () => {
    const p = await prepare(); transport.settlement = { observed: true, quiescent: false, verified: true };
    await expect(coreAudit(p, await auditor(p))).rejects.toThrow(/E_AUDITOR_RESULT_INVALID/);
    const artifacts = await readCodexAuditArtifactSetV2(p.fixture.store, p.attemptId);
    expect(artifacts.providerResult).toBeDefined(); expect(artifacts.terminal).toBeUndefined();
    const calls = transport.runs; transport.settlement = { observed: true, quiescent: true, verified: true };
    await expect(coreAudit(p, await auditor(p))).rejects.toThrow(/E_AUDITOR_RESULT_INVALID/);
    expect(transport.runs).toBe(calls);
  });

  it("G: a durable provider terminal replays into one Core AuditResult with zero new inference", async () => {
    const p = await prepare();
    const fs = failOnePublish((target) => target.endsWith("/audit-result.json"));
    await expect(coreAudit(p, await auditor(p, fs), fs)).rejects.toThrow(/E_AUDIT_EVENT_DURABILITY_UNKNOWN/);
    const boundary = await readCodexAuditArtifactSetV2(p.fixture.store, p.attemptId);
    expect(boundary.terminal).toBeDefined(); expect(await readAuditResultV2(p.fixture.store, p.attemptId)).toBeUndefined();
    const calls = transport.runs;
    const resumed = await coreAudit(p, await auditor(p));
    expect(resumed.kind).toBe("AUDIT_REJECTED"); expect(transport.runs).toBe(calls);
    expect(await readAuditResultV2(p.fixture.store, p.attemptId)).toBeDefined();
  });

  it("H: a durable Core AuditResult before Finding reconciliation resumes without a duplicate call or Finding", async () => {
    const p = await prepare(); const fs = eventPublishFailure("finding.state-changed");
    await expect(coreAudit(p, await auditor(p, fs), fs)).rejects.toThrow();
    expect(await readAuditResultV2(p.fixture.store, p.attemptId)).toBeDefined();
    await rm(join(p.fixture.store.runDirectory, "locks", "lease.json"), { force: true });
    const calls = transport.runs;
    const resumed = await coreAudit(p, await auditor(p));
    expect(resumed.kind).toBe("AUDIT_REJECTED"); expect(transport.runs).toBe(calls);
    expect(Object.values(resumed.state.findings)).toHaveLength(1);
  });

  it("I: a durable Finding before Attempt closure resumes without duplicate Finding, AuditResult or thread", async () => {
    const p = await prepare(); const fs = eventPublishFailure("attempt.closed");
    await expect(coreAudit(p, await auditor(p, fs), fs)).rejects.toThrow();
    expect(await readAuditResultV2(p.fixture.store, p.attemptId)).toBeDefined();
    const before = (await p.fixture.store.inspect()).events;
    expect(before.filter((event) => event.eventType === "finding.state-changed")).toHaveLength(1);
    await rm(join(p.fixture.store.runDirectory, "locks", "lease.json"), { force: true });
    const calls = transport.runs;
    const resumed = await coreAudit(p, await auditor(p));
    expect(resumed.kind).toBe("AUDIT_REJECTED"); expect(transport.runs).toBe(calls);
    const after = (await p.fixture.store.inspect()).events;
    expect(after.filter((event) => event.eventType === "finding.state-changed")).toHaveLength(1);
    expect(after.filter((event) => event.eventType === "attempt.closed" && event.attemptId === p.attemptId)).toHaveLength(1);
    expect((await readCodexAuditArtifactSetV2(p.fixture.store, p.attemptId)).threadBinding?.threadId).toBe("thr_m5d_auditor_0001");
  });
});
