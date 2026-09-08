import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  promptCalls: 0,
  sessionCreates: 0,
  serverStarts: 0,
  abortCalls: 0,
  sanitizedReads: 0,
  promptSawDurableBinding: false,
  mode: "success" as "success" | "hang" | "model-mismatch" | "provider-failure" | "ambiguous-terminal" | "failed-intermediate" | "credential-text" | "observation-mismatch",
  settlementObserved: true,
  settlementQuiescent: true,
  settlementVerified: true,
}));

vi.mock("../../src/vnext/ralph-runtime/operational-b4/opencode-cli-process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/vnext/ralph-runtime/operational-b4/opencode-cli-process.js")>();
  return {
    ...actual,
    inspectExactOpenCodeCliExecutableV2: vi.fn(async () => Object.freeze({
      executablePath: "/home/bruno/.opencode/bin/opencode",
      executableVersion: "1.18.29",
    })),
    startOpenCodeCliWorkerV2: vi.fn(async () => {
      const { defaultProcessIdentityProvider } = await import("../../src/vnext/ralph-runtime/operational-b2/index.js");
      const host = await defaultProcessIdentityProvider.current();
      const processIdentity = Object.freeze({ ...host, pid: 987_654, processStartIdentity: `sha256:${"a".repeat(64)}` });
      return Object.freeze({
        processIdentity,
        processGroupId: processIdentity.pid,
        startedAt: "2026-09-07T12:00:05.000Z",
        async startServer() {
          transport.serverStarts += 1;
          return "http://127.0.0.1:32109";
        },
        async settle() {
          return Object.freeze({
            observed: transport.settlementObserved,
            quiescent: transport.settlementQuiescent,
            verified: transport.settlementVerified,
            survivors: [],
            containment: { kind: "cgroup-v2", structural: true },
          });
        },
      });
    }),
  };
});

vi.mock("../../src/vnext/ralph-runtime/operational-b4/opencode-cli-session-inspector.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/vnext/ralph-runtime/operational-b4/opencode-cli-session-inspector.js")>();
  const model = "opencode-go/deepseek-v4-pro";
  const sessionId = "ses_m4bFakeDedicatedSession001";
  const assistant = (userMessageId: string) => Object.freeze({
    assistantMessageId: "msg_m4b_fake_assistant_001",
    sessionId,
    userMessageId,
    modelSelector: transport.mode === "model-mismatch" ? "opencode-go/foreign-model" : model,
    classification: transport.mode === "provider-failure" ? "FAILED" as const : "SUCCEEDED" as const,
    parts: Object.freeze([{ type: "text", text: "Task complete; validation passed." }]),
    assistantContentDigest: `sha256:${"d".repeat(64)}`,
    responseDigest: `sha256:${"e".repeat(64)}`,
    observableTurnDigest: `sha256:${"f".repeat(64)}`,
    raw: {},
  });
  return {
    ...actual,
    OpenCodeCliHttpClientV2: class {
      constructor(private readonly options: { readonly projectRoot: string }) {}
      async health() { return "1.18.29"; }
      async createSession() {
        transport.sessionCreates += 1;
        return Object.freeze({ id: sessionId, directory: this.options.projectRoot, version: "1.18.29", modelSelector: model });
      }
      async getSession() { return Object.freeze({ id: sessionId, directory: this.options.projectRoot, version: "1.18.29", modelSelector: model }); }
      async listMessages() { return []; }
      async sendPrompt(input: { readonly userMessageId: string }, signal?: AbortSignal) {
        transport.promptCalls += 1;
        const files = await readdir(resolve(this.options.projectRoot, ".rb-harness", "ralph", "runs"), { recursive: true });
        transport.promptSawDurableBinding = files.some((file) => String(file).endsWith("provider-session-binding.json"))
          && files.some((file) => String(file).endsWith("opencode-prompt.json"));
        if (!transport.promptSawDurableBinding) throw new Error("fixture observed prompt before durable binding");
        if (transport.mode !== "hang") return assistant(input.userMessageId);
        return await new Promise((resolvePrompt, rejectPrompt) => {
          const onAbort = () => rejectPrompt(signal?.reason ?? new Error("aborted"));
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
          void resolvePrompt;
        });
      }
      async readExactPromptResult(input: { readonly userMessageId: string }) {
        if (transport.mode === "ambiguous-terminal" || transport.mode === "failed-intermediate" || transport.mode === "credential-text") {
          const user = {
            info: { id: input.userMessageId, role: "user", sessionID: sessionId, time: { created: 1_000 } },
            parts: [{ id: "prt_executor_user", sessionID: sessionId, messageID: input.userMessageId, type: "text", text: "bounded" }],
          };
          const rawAssistant = (id: string, finish: "tool-calls" | "stop", error?: unknown, text = "informational") => ({
            info: {
              id, role: "assistant", sessionID: sessionId, parentID: input.userMessageId,
              providerID: "opencode-go", modelID: "deepseek-v4-pro", finish,
              ...(error === undefined ? {} : { error }),
            },
            parts: finish === "stop"
              ? [
                { id: `${id}_start`, sessionID: sessionId, messageID: id, type: "step-start" },
                { id: `${id}_text`, sessionID: sessionId, messageID: id, type: "text", text },
                { id: `${id}_finish`, sessionID: sessionId, messageID: id, type: "step-finish", reason: "stop", cost: 0, tokens: { total: 1, input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
              ]
              : [
                { id: `${id}_start`, sessionID: sessionId, messageID: id, type: "step-start" },
                { id: `${id}_tool`, sessionID: sessionId, messageID: id, type: "tool", tool: "write", callID: `${id}_call`, state: { status: "completed", input: {}, output: "written", title: "write", metadata: {}, time: { start: 1_001, end: 1_002 } } },
                { id: `${id}_finish`, sessionID: sessionId, messageID: id, type: "step-finish", reason: "tool-calls", cost: 0, tokens: { total: 1, input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
              ],
          });
          return actual.parseExactAssistantTurnV2(transport.mode === "ambiguous-terminal"
            ? [user, rawAssistant("msg_ambiguous_terminal_001", "stop"), rawAssistant("msg_ambiguous_terminal_002", "stop")]
            : transport.mode === "credential-text"
              ? [user, rawAssistant("msg_credential_terminal_001", "stop", undefined, "Authorization: Bearer sk-forbidden-material")]
              : [user, rawAssistant("msg_failed_intermediate_001", "tool-calls", { name: "UnknownError", data: { message: "redacted" } })], sessionId, input.userMessageId);
        }
        return assistant(input.userMessageId);
      }
      async abort() { transport.abortCalls += 1; return true; }
    },
    readSanitizedExactOpenCodeTurnV2: async (_options: unknown, input: { readonly userMessageId: string }) => {
      transport.sanitizedReads += 1;
      const value = assistant(input.userMessageId);
      return transport.mode === "observation-mismatch"
        ? Object.freeze({ ...value, observableTurnDigest: `sha256:${"9".repeat(64)}` })
        : value;
    },
    SupportedOpenCodeCliSessionInspectorV2: class {
      async inspect(input: {
        readonly descriptor: { readonly modelSelector: string };
        readonly dispatchIntent: { readonly openCodeUserMessageId: string };
        readonly sessionBinding: { readonly openCodeSessionId: string };
        readonly terminal: null | { readonly resultRef: string | null; readonly resultDigest: string | null };
      }) {
        return Object.freeze({
          sessionIdentity: "MATCH" as const,
          observedSessionId: input.sessionBinding.openCodeSessionId,
          activity: "STATUS_UNPROVEN" as const,
          modelIdentity: "MATCH" as const,
          observedModelSelector: input.descriptor.modelSelector,
          userMessageIdentity: "MATCH" as const,
          observedUserMessageId: input.dispatchIntent.openCodeUserMessageId,
          resultIdentity: input.terminal ? "MATCH" as const : "ABSENT" as const,
          observedResultRef: input.terminal?.resultRef ?? null,
          observedResultDigest: input.terminal?.resultDigest ?? null,
        });
      }
    },
  };
});

import type { RuntimeEntityRef } from "../../src/vnext/ralph-runtime/contracts.js";
import type { ExecutionDocument, Phase, Task } from "../../src/types.js";
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
  type LeasedRunV2,
  type ProcessIdentity,
  type ProcessIdentityProvider,
} from "../../src/vnext/ralph-runtime/operational-b2/index.js";
import { prepareNextAuthorizedInvocationV2, type AuthorizedInvocationV2 } from "../../src/vnext/ralph-runtime/operational-b3/index.js";
import {
  OpenCodeCliExecutorV2,
  createM4BTimeoutPolicyV2,
  createOpenCodeCliExecutorV2,
  executeAuthorizedInvocationV2,
  isTrustedExecutorRuntimeV2,
  isTrustedOpenCodeCliExecutorV2,
  loadExactConformanceRecordV2,
  readProviderInvocationArtifactSetV2,
  type M4BTimeoutPolicyV2,
} from "../../src/vnext/ralph-runtime/operational-b4/index.js";
import {
  createOpenCodeProviderResultV2,
  persistOpenCodeProviderResultV2,
  readOpenCodePromptArtifactV2,
  readOpenCodeProviderResultV2,
} from "../../src/vnext/ralph-runtime/operational-b4/opencode-cli-result.js";
import { assertExactOpenCodeCliConformanceV2 } from "../../src/vnext/ralph-runtime/operational-b4/opencode-cli-executor.js";
import { LinuxProviderProcessTreeInspectorV2 } from "../../src/vnext/ralph-runtime/operational-b4/provider-process-tree-inspector.js";
import { createWorkspacePolicy, fingerprintWorkspace } from "../../src/vnext/ralph-runtime/fingerprint.js";
import { sha256, sha256Canonical } from "../../src/vnext/ralph-runtime/hashing.js";
import { createCorrectionContextV2, persistCorrectionContextV2 } from "../../src/vnext/ralph-runtime/operational-f/index.js";

const PROFILE = "opencode:cli:opencode-go/deepseek-v4-pro";
const LEASE_IDENTITY: ProcessIdentity = Object.freeze({
  pid: 64020,
  processStartIdentity: sha256("m4b-lease-birth"),
  hostIdentity: sha256("m4b-host"),
  bootSessionIdentity: sha256("m4b-boot"),
});

interface Fixture {
  readonly root: string;
  readonly store: RalphEventStoreV2;
  readonly document: ExecutionDocument;
  readonly genesis: RalphRuntimeStateV2;
  readonly leasedRun: LeasedRunV2;
  readonly authorizedInvocation: AuthorizedInvocationV2;
  readonly timeoutPolicy: M4BTimeoutPolicyV2;
}

function task(): Task {
  return {
    id: "T001", title: "Create status module", done: false, scope: "src/status.js",
    change: "create src/status.js exporting exactly module.exports = \"ready\";", covers: "src/status.js", dependsOn: [], parallelSafe: false,
    acceptanceCriteria: ["src/status.js exports exactly ready"], validation: ["`node -e 'process.exit(0)'`"],
    expectedEvidence: "real src/status.js workspace delta", line: 1,
  };
}

function plan(): ExecutionDocument {
  const phase: Phase = { number: 1, id: "P01", title: "M4-B", goal: "create a deterministic status module", dependsOn: [], context: ["fixture"], tasks: [task()], line: 1 };
  return { contract: "rb-execution/v1", artifactId: "plan-m4b", title: "M4-B", phases: [phase] };
}

function descriptor(schemaVersion: string, descriptorId: string, descriptorDigest?: string) {
  const base = { schemaVersion, descriptorId };
  return { ...base, descriptorDigest: descriptorDigest ?? sha256Canonical(base) };
}

function initialState(document: ExecutionDocument, runId: string): RalphRuntimeStateV2 {
  return createInitialRuntimeStateV2({
    runId, maxTaskAttemptsPerTask: 2,
    phases: document.phases.map((phase) => ({ phaseId: phase.id, taskIds: phase.tasks.map((candidate) => candidate.id) })),
    tasks: document.phases.flatMap((phase) => phase.tasks.map((candidate) => ({ taskId: candidate.id, phaseId: phase.id, dependsOn: candidate.dependsOn }))),
  });
}

function event<TType extends RalphEventTypeV2>(state: RalphRuntimeStateV2, eventType: TType, payload: EventPayloadMapV2[TType], context: { readonly phaseId?: string; readonly taskId?: string; readonly attemptId?: string } = {}): RalphEventV2 {
  const kind = V2_EVENT_ENTITY_KINDS[eventType];
  const entity: RuntimeEntityRef = kind === "run" ? { kind, id: state.runId }
    : kind === "workspace" ? { kind, id: `${state.runId}:workspace` }
      : kind === "task" ? { kind, id: context.taskId ?? "T001" }
        : { kind: "attempt", id: context.attemptId ?? "attempt-m4b-001" };
  return createRalphEventV2({
    eventId: `m4b-event-${state.lastSequence + 1}-${eventType}`, eventType, schemaVersion: EVENT_SCHEMA_V2, runId: state.runId,
    sequence: state.lastSequence + 1, occurredAt: "2026-09-07T12:00:00.000Z", recordedAt: "2026-09-07T12:00:00.000Z", entity,
    ...(context.phaseId === undefined ? {} : { phaseId: context.phaseId }), ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
    ...(context.attemptId === undefined ? {} : { attemptId: context.attemptId }), actor: "CORE", causationId: null,
    correlationId: `${state.runId}:m4b`, payload, previousEventHash: state.lastEventHash,
  } as UnsignedRalphEventV2<TType>) as RalphEventV2;
}

async function fixture(name: string, timeoutMs = 5_000): Promise<Fixture> {
  const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-m4b-"));
  const runId = `run-${name}`;
  const document = plan();
  const workspacePolicy = createWorkspacePolicy({ scopePaths: ["src/status.js"], coversPaths: ["src/status.js"] });
  const fingerprint = await fingerprintWorkspace(root, workspacePolicy);
  const timeoutPolicy = createM4BTimeoutPolicyV2(timeoutMs);
  const retryPolicy = createRetryPolicyV1({ runId, policyId: "m4b-retry", maxTaskAttemptsPerTask: 2, validationInfrastructureRetryLimit: 1 });
  const snapshot: RunSnapshotV2 = {
    snapshotSchemaVersion: RALPH_RUN_SNAPSHOT_V2_SCHEMA, runId, eventSchema: EVENT_SCHEMA_V2, stateSchema: STATE_SCHEMA_V2,
    operationalContract: OPERATIONAL_CONTRACT_V2, projectIdentity: { projectId: "m4b-project" }, readyPlanIdentity: document.artifactId,
    readyPlanHash: sha256Canonical(document), readyManifestHash: sha256("m4b-manifest"), selectedReadyArtifactHashes: { plan: sha256Canonical(document) },
    readinessInspectionDigest: sha256("m4b-readiness"), effectiveRunConfig: descriptor("rb-ralph-config/v2", "m4b-config"),
    effectiveConfigDigest: descriptor("rb-ralph-config/v2", "m4b-config").descriptorDigest,
    diagnosticsPolicy: descriptor("rb-ralph-diagnostics/v2", "m4b-diagnostics"), environmentPolicy: descriptor("rb-ralph-environment/v2", "m4b-environment"),
    executorProfile: { profileId: PROFILE, kind: "scripted", descriptorDigest: sha256("m4b-opencode-profile") },
    executorCapabilities: { requested: ["workspace.write"], granted: ["workspace.write"], verified: ["workspace.write"], readOnlyEnforced: false },
    permissionCapabilityPolicy: descriptor("rb-ralph-capabilities/v2", "m4b-capabilities"), workspacePolicy,
    initialWorkspaceFingerprint: { controlPlaneFingerprint: fingerprint.controlPlaneFingerprint, productWorkspaceFingerprint: fingerprint.productWorkspaceFingerprint, policyDigest: fingerprint.policyDigest, fingerprintDigest: fingerprint.fingerprintDigest },
    retryPolicies: retryPolicyDescriptorV1(retryPolicy), timeoutPolicy: descriptor("rb-ralph-timeout/v2", "m4b-timeout", timeoutPolicy.policyDigest),
    runtimeIdentity: descriptor("rb-ralph-runtime/v2", "m4b-runtime"), leasePolicy: descriptor("rb-ralph-lease/v2", "m4b-lease"),
    createdAt: "2026-09-07T12:00:00.000Z",
  };
  const store = new RalphEventStoreV2({ projectRoot: root, runId });
  const genesis = initialState(document, runId);
  const initialized = await initializeOperationalRunV2({
    store, snapshot, retryPolicy, genesisState: genesis,
    runCreatedEvent: event(genesis, "run.created", { phaseIds: genesis.phaseIds, taskIds: genesis.taskIds }),
    createdAt: "2026-09-07T12:00:01.000Z", nonce: "m4b-init",
  });
  let state = (await commitRalphEventV2({ store, state: initialized.state, event: event(initialized.state, "run.started", {}), writtenAt: "2026-09-07T12:00:02.000Z", nonce: "m4b-start" })).state;
  state = (await commitRalphEventV2({ store, state, event: event(state, "task.state-changed", { disposition: "READY", activity: "IDLE", owner: "NONE", hold: "NONE" }, { phaseId: "P01", taskId: "T001" }), writtenAt: "2026-09-07T12:00:03.000Z", nonce: "m4b-ready" })).state;
  const leaseProvider: ProcessIdentityProvider = { current: () => LEASE_IDENTITY, inspect: () => "MATCH" };
  const leasedRun = await acquireLeasedRunV2({ projectRoot: root, runId, genesisState: genesis, processIdentityProvider: leaseProvider });
  const admitted = await prepareNextAuthorizedInvocationV2({
    leasedRun, plan: document, planIdentity: document.artifactId, planDigest: sha256Canonical(document),
    attemptIdFactory: () => "attempt-m4b-001", eventIdFactory: () => "m4b-attempt-event", nonceFactory: () => "m4b-admission",
    clock: () => "2026-09-07T12:00:04.000Z",
  });
  if (admitted.kind !== "AUTHORIZED_NOT_INVOKED") throw new Error(`M4-B fixture admission failed: ${admitted.kind}`);
  const resumedLease = await acquireLeasedRunV2({ projectRoot: root, runId, genesisState: genesis, processIdentityProvider: leaseProvider });
  return { root, store, document, genesis, leasedRun: resumedLease, authorizedInvocation: admitted.authorizedInvocation, timeoutPolicy };
}

async function withFixture(name: string, action: (value: Fixture) => Promise<void>, timeoutMs?: number): Promise<void> {
  const value = await fixture(name, timeoutMs);
  try { await action(value); }
  finally { await rm(value.root, { recursive: true, force: true }); }
}

function executionInput(value: Fixture, runtime: OpenCodeCliExecutorV2) {
  let ordinal = 0;
  return {
    leasedRun: value.leasedRun, plan: value.document, planIdentity: value.document.artifactId, planDigest: sha256Canonical(value.document),
    attemptId: value.authorizedInvocation.descriptor.attemptId, runtime,
    eventIdFactory: () => `m4b-execution-event-${++ordinal}`, nonceFactory: () => `m4b-execution-${++ordinal}`,
    clock: () => new Date(Date.parse("2026-09-07T12:01:00.000Z") + ordinal * 1_000).toISOString(),
  };
}

beforeEach(() => {
  transport.promptCalls = 0;
  transport.sessionCreates = 0;
  transport.serverStarts = 0;
  transport.abortCalls = 0;
  transport.sanitizedReads = 0;
  transport.promptSawDurableBinding = false;
  transport.mode = "success";
  transport.settlementObserved = true;
  transport.settlementQuiescent = true;
  transport.settlementVerified = true;
  vi.restoreAllMocks();
});

describe("Ralph M4-B — nominal OpenCode CLI Executor through real B4 authority", () => {
  it("M4B-1: extends the trust root only with a genuine sealed OpenCodeCliExecutorV2", async () => {
    await withFixture("m4b-trust", async (value) => {
      const runtime = await createOpenCodeCliExecutorV2({ store: value.store, authorizedInvocation: value.authorizedInvocation, timeoutPolicy: value.timeoutPolicy });
      expect(isTrustedOpenCodeCliExecutorV2(runtime)).toBe(true);
      expect(isTrustedExecutorRuntimeV2(runtime)).toBe(true);
      expect(isTrustedExecutorRuntimeV2({ kind: "EXECUTOR_RUNTIME", runtimeIdentity: runtime.runtimeIdentity, invoke: runtime.invoke.bind(runtime), observe: runtime.observe.bind(runtime), requestCancel: runtime.requestCancel.bind(runtime) })).toBe(false);
      expect(isTrustedExecutorRuntimeV2(JSON.parse(JSON.stringify(runtime)))).toBe(false);
      expect(isTrustedExecutorRuntimeV2(structuredClone({ kind: runtime.kind, runtimeIdentity: runtime.runtimeIdentity }))).toBe(false);
      expect(isTrustedExecutorRuntimeV2(Object.create(Object.getPrototypeOf(runtime)))).toBe(false);
      expect(() => Reflect.construct(OpenCodeCliExecutorV2, [{}, Symbol("fake")])).toThrow("B4_EXECUTOR_AUTHORIZATION_REQUIRED");
      expect(() => Reflect.construct(OpenCodeCliExecutorV2, [{}, Symbol("fake")], class extends OpenCodeCliExecutorV2 {})).toThrow("B4_EXECUTOR_AUTHORIZATION_REQUIRED");
      expect(Object.isFrozen(runtime)).toBe(true);
    });
  });

  it("binds the exact frozen conformance and rejects timeout authority not committed by the WorkUnit", async () => {
    await withFixture("m4b-conformance", async (value) => {
      const record = await loadExactConformanceRecordV2();
      expect(record).toMatchObject({ profileId: PROFILE, modelId: "opencode-go/deepseek-v4-pro", transportVersion: "1.18.29", result: { tier: "SUPPORTED" } });
      expect(record.result.cases).toHaveLength(17);
      expect(record.result.cases.every((candidate) => candidate.passed)).toBe(true);
      expect(() => assertExactOpenCodeCliConformanceV2({ ...record, transportVersion: "1.18.28" })).toThrow(expect.objectContaining({ m4bCode: "M4B_CONFORMANCE_REQUIRED" }));
      expect(() => assertExactOpenCodeCliConformanceV2({ ...record, modelId: "opencode-go/foreign-model" })).toThrow(expect.objectContaining({ m4bCode: "M4B_CONFORMANCE_REQUIRED" }));
      await expect(createOpenCodeCliExecutorV2({ store: value.store, authorizedInvocation: value.authorizedInvocation, timeoutPolicy: createM4BTimeoutPolicyV2(value.timeoutPolicy.deadlineMs + 1) }))
        .rejects.toMatchObject({ m4bCode: "M4B_TIMEOUT_POLICY_INVALID" });
      expect(transport.promptCalls).toBe(0);
    });
  });

  it("M4B-2/M4B-5/M4B-6: executes exactly once after durable session binding and reaches canonical B4 completion", async () => {
    await withFixture("m4b-success", async (value) => {
      const runtime = await createOpenCodeCliExecutorV2({ store: value.store, authorizedInvocation: value.authorizedInvocation, timeoutPolicy: value.timeoutPolicy });
      const result = await executeAuthorizedInvocationV2(executionInput(value, runtime));
      expect(result.kind).toBe("EXECUTOR_FINISHED_READY_FOR_CAPTURE");
      expect(transport).toMatchObject({ promptCalls: 1, sanitizedReads: 1, sessionCreates: 1, serverStarts: 1, promptSawDurableBinding: true });
      const provider = await readProviderInvocationArtifactSetV2(value.store, value.authorizedInvocation.descriptor.attemptId);
      const prompt = await readOpenCodePromptArtifactV2(value.store, value.authorizedInvocation.descriptor.attemptId);
      const physical = await readOpenCodeProviderResultV2(value.store, value.authorizedInvocation.descriptor.attemptId);
      expect(provider.descriptor).toMatchObject({ executorProfileIdentity: PROFILE, modelSelector: "opencode-go/deepseek-v4-pro", conformanceState: "MATCH" });
      expect(provider.sessionBinding?.openCodeSessionId).toBe(prompt?.openCodeSessionId);
      expect(prompt).toMatchObject({ openCodeSessionId: provider.sessionBinding?.openCodeSessionId, openCodeUserMessageId: provider.dispatchIntent?.openCodeUserMessageId });
      expect(physical).toMatchObject({ classification: "SUCCEEDED", openCodeSessionId: provider.sessionBinding?.openCodeSessionId, observedModelSelector: "opencode-go/deepseek-v4-pro" });
      expect(provider.terminal).toMatchObject({ status: "SUCCEEDED", termination: "NORMAL", resultDigest: physical?.resultDigest, quiescence: { workerProcessState: "ABSENT", processTreeState: "QUIESCENT" } });
      if (!physical) throw new Error("M4-B physical result missing");
      const { schema: _schema, resultDigest: _digest, ...physicalInput } = physical;
      const foreign = createOpenCodeProviderResultV2({ ...physicalInput, sessionBindingDigest: sha256("foreign-session-binding") });
      await expect(persistOpenCodeProviderResultV2(value.store, foreign, "m4b-foreign-result"))
        .rejects.toThrow("M4B_PROVIDER_RESULT_BINDING_INVALID");
      expect(result.kind === "EXECUTOR_FINISHED_READY_FOR_CAPTURE" ? result.resultArtifact.status : null).toBe("SUCCEEDED");
      const events = await value.store.inspect();
      expect(events.events.filter((entry) => entry.eventType === "executor.finished")).toHaveLength(1);
      expect(events.events.findIndex((entry) => entry.eventType === "executor.finished")).toBeGreaterThan(-1);
      const taskState = result.state.tasks.T001;
      expect(taskState?.disposition).not.toBe("COMPLETE");
    });
  });

  it.each([
    ["settlement observed=false", () => { transport.settlementObserved = false; }],
    ["settlement quiescent=false", () => { transport.settlementQuiescent = false; }],
    ["settlement verified=false", () => { transport.settlementVerified = false; }],
    ["worker process state is not ABSENT", () => { vi.spyOn(defaultProcessIdentityProvider, "inspect").mockResolvedValue("MATCH"); }],
    ["process tree state is ACTIVE", () => { vi.spyOn(LinuxProviderProcessTreeInspectorV2.prototype, "inspect").mockReturnValue("ACTIVE"); }],
    ["process tree state is UNKNOWN", () => { vi.spyOn(LinuxProviderProcessTreeInspectorV2.prototype, "inspect").mockReturnValue("UNKNOWN"); }],
  ] as const)("M4B-6: rejects %s and leaves provider-terminal physically absent", async (_label, arrange) => {
    arrange();
    await withFixture("m4b-non-quiescent", async (value) => {
      const runtime = await createOpenCodeCliExecutorV2({ store: value.store, authorizedInvocation: value.authorizedInvocation, timeoutPolicy: value.timeoutPolicy });
      await expect(runtime.invoke(value.authorizedInvocation)).rejects.toMatchObject({ m4bCode: "M4B_PROCESS_TREE_NOT_QUIESCENT" });
      const provider = await readProviderInvocationArtifactSetV2(value.store, value.authorizedInvocation.descriptor.attemptId);
      expect(provider.terminal).toBeUndefined();
      expect(transport.promptCalls).toBe(1);
    });
  });

  it("M4B-4: fresh runtime resume never redispatches after durable physical/canonical result", async () => {
    await withFixture("m4b-resume", async (value) => {
      const first = await createOpenCodeCliExecutorV2({ store: value.store, authorizedInvocation: value.authorizedInvocation, timeoutPolicy: value.timeoutPolicy });
      expect((await executeAuthorizedInvocationV2(executionInput(value, first))).kind).toBe("EXECUTOR_FINISHED_READY_FOR_CAPTURE");
      const fresh = await createOpenCodeCliExecutorV2({ store: new RalphEventStoreV2({ projectRoot: value.root, runId: value.store.runId }), authorizedInvocation: value.authorizedInvocation, timeoutPolicy: value.timeoutPolicy });
      await expect(fresh.invoke(value.authorizedInvocation)).rejects.toMatchObject({ m4bCode: "M4B_REDISPATCH_FORBIDDEN" });
      expect((await executeAuthorizedInvocationV2(executionInput(value, fresh))).kind).toBe("EXECUTOR_FINISHED_READY_FOR_CAPTURE");
      expect(transport.promptCalls).toBe(1);
      expect(transport.sessionCreates).toBe(1);
    });
  });

  it("M4B-7: rejects a genuine CorrectionContext before descriptor, intent, session or prompt", async () => {
    await withFixture("m4b-correction", async (value) => {
      const core = value.authorizedInvocation.descriptor;
      const context = createCorrectionContextV2({
        runId: core.runId, phaseId: core.phaseId, taskId: core.taskId, currentAttemptId: core.attemptId,
        sourceRejectedAttempts: [], openFindingRefs: [], openFindings: [], baseWorkspaceFingerprint: core.attemptBaseFingerprint,
        createdAt: "2026-09-07T12:00:04.500Z",
      });
      await persistCorrectionContextV2(value.store, context, "m4b-correction-context");
      const runtime = await createOpenCodeCliExecutorV2({ store: value.store, authorizedInvocation: value.authorizedInvocation, timeoutPolicy: value.timeoutPolicy });
      await expect(runtime.invoke(value.authorizedInvocation)).rejects.toMatchObject({ m4bCode: "M4B_CORRECTION_CONTEXT_NOT_SUPPORTED" });
      expect(await readProviderInvocationArtifactSetV2(value.store, core.attemptId)).toEqual({});
      expect(transport).toMatchObject({ promptCalls: 0, sessionCreates: 0, serverStarts: 0 });
    });
  });

  it("M4B-3: model mismatch after physical dispatch fails closed and never reaches executor.finished", async () => {
    transport.mode = "model-mismatch";
    await withFixture("m4b-model-mismatch", async (value) => {
      const runtime = await createOpenCodeCliExecutorV2({ store: value.store, authorizedInvocation: value.authorizedInvocation, timeoutPolicy: value.timeoutPolicy });
      const result = await executeAuthorizedInvocationV2(executionInput(value, runtime));
      expect(result.kind).toBe("RECONCILIATION_REQUIRED");
      const events = await value.store.inspect();
      expect(events.events.filter((entry) => entry.eventType === "executor.finished")).toHaveLength(0);
      expect(await readOpenCodeProviderResultV2(value.store, value.authorizedInvocation.descriptor.attemptId)).toBeUndefined();
      const provider = await readProviderInvocationArtifactSetV2(value.store, value.authorizedInvocation.descriptor.attemptId);
      const prompt = await readOpenCodePromptArtifactV2(value.store, value.authorizedInvocation.descriptor.attemptId);
      if (!provider.descriptor || !provider.dispatchIntent || !provider.sessionBinding || !prompt) throw new Error("M4-B mismatch fixture artifacts missing");
      const foreignResult = createOpenCodeProviderResultV2({
        runId: provider.descriptor.runId, phaseId: provider.descriptor.phaseId, taskId: provider.descriptor.taskId,
        attemptId: provider.descriptor.attemptId, invocationId: provider.descriptor.invocationId,
        descriptorDigest: provider.descriptor.descriptorDigest, dispatchIntentDigest: provider.dispatchIntent.intentDigest,
        sessionBindingDigest: sha256("foreign-session-binding"), promptArtifactDigest: prompt.artifactDigest,
        openCodeSessionId: provider.sessionBinding.openCodeSessionId, openCodeUserMessageId: provider.dispatchIntent.openCodeUserMessageId,
        assistantMessageId: null, observedModelSelector: provider.descriptor.modelSelector, classification: "PROTOCOL_FAILURE",
        assistantContentDigest: null, responseDigest: sha256("foreign-result"), observableTurnDigest: null,
        startedAt: provider.workerReceipt?.startedAt ?? prompt.preparedAt,
        finishedAt: "2026-09-07T12:03:00.000Z",
      });
      await expect(persistOpenCodeProviderResultV2(value.store, foreignResult, "m4b-foreign-unoccupied-result"))
        .rejects.toThrow("M4B_PROVIDER_RESULT_BINDING_INVALID");
      expect(transport.promptCalls).toBe(1);
    });
  });

  it("M4B-18: refuses provider result persistence when live and supported sanitized observation identities differ", async () => {
    transport.mode = "observation-mismatch";
    await withFixture("m4b-observation-mismatch", async (value) => {
      const runtime = await createOpenCodeCliExecutorV2({ store: value.store, authorizedInvocation: value.authorizedInvocation, timeoutPolicy: value.timeoutPolicy });
      const outcome = await executeAuthorizedInvocationV2(executionInput(value, runtime));
      expect(outcome.kind).toBe("RECONCILIATION_REQUIRED");
      expect(transport).toMatchObject({ promptCalls: 1, sanitizedReads: 1 });
      expect(await readOpenCodeProviderResultV2(value.store, value.authorizedInvocation.descriptor.attemptId)).toBeUndefined();
      expect((await readProviderInvocationArtifactSetV2(value.store, value.authorizedInvocation.descriptor.attemptId)).terminal).toBeUndefined();
      const events = (await value.store.inspect()).events;
      expect(events.some((entry) => ["executor.finished", "evidence.capture-started", "validation.started", "audit.started"].includes(entry.eventType))).toBe(false);
    });
  });

  it.each(["ambiguous-terminal", "failed-intermediate", "credential-text"] as const)("fails closed for %s transcript before provider result, terminal or downstream semantics", async (mode) => {
    transport.mode = mode;
    await withFixture(`m4b-${mode}`, async (value) => {
      const runtime = await createOpenCodeCliExecutorV2({ store: value.store, authorizedInvocation: value.authorizedInvocation, timeoutPolicy: value.timeoutPolicy });
      const result = await executeAuthorizedInvocationV2(executionInput(value, runtime));
      expect(result.kind).toBe("RECONCILIATION_REQUIRED");
      expect(await readOpenCodeProviderResultV2(value.store, value.authorizedInvocation.descriptor.attemptId)).toBeUndefined();
      expect((await readProviderInvocationArtifactSetV2(value.store, value.authorizedInvocation.descriptor.attemptId)).terminal).toBeUndefined();
      const events = (await value.store.inspect()).events;
      expect(events.some((entry) => ["executor.finished", "evidence.capture-started", "validation.started", "audit.started"].includes(entry.eventType))).toBe(false);
      expect(transport.promptCalls).toBe(1);
    });
  });

  it("maps a bound provider terminal error to the existing FAILED/ERROR result without retry", async () => {
    transport.mode = "provider-failure";
    await withFixture("m4b-provider-failure", async (value) => {
      const runtime = await createOpenCodeCliExecutorV2({ store: value.store, authorizedInvocation: value.authorizedInvocation, timeoutPolicy: value.timeoutPolicy });
      const result = await executeAuthorizedInvocationV2(executionInput(value, runtime));
      expect(result.kind).toBe("EXECUTOR_FINISHED_READY_FOR_CAPTURE");
      expect(result.kind === "EXECUTOR_FINISHED_READY_FOR_CAPTURE" ? result.resultArtifact : null)
        .toMatchObject({ status: "FAILED", termination: "ERROR", exitCode: 1 });
      expect(transport.promptCalls).toBe(1);
      expect((await readProviderInvocationArtifactSetV2(value.store, value.authorizedInvocation.descriptor.attemptId)).terminal)
        .toMatchObject({ status: "FAILED", termination: "ERROR" });
    });
  });

  it("M4B-8: provider success text cannot bypass Evidence, Validation, Audit or complete the Task", async () => {
    await withFixture("m4b-provider-text", async (value) => {
      const runtime = await createOpenCodeCliExecutorV2({ store: value.store, authorizedInvocation: value.authorizedInvocation, timeoutPolicy: value.timeoutPolicy });
      const result = await executeAuthorizedInvocationV2(executionInput(value, runtime));
      expect(result.kind).toBe("EXECUTOR_FINISHED_READY_FOR_CAPTURE");
      await expect(readFile(join(value.root, "src/status.js"), "utf8")).rejects.toThrow();
      expect(result.state.tasks.T001?.disposition).not.toBe("COMPLETE");
      const events = await value.store.inspect();
      expect(events.events.some((entry) => ["validation.completed", "audit.started"].includes(entry.eventType))).toBe(false);
    });
  });

  it("maps a proven exact-session cancellation without treating abort acceptance as quiescence", async () => {
    transport.mode = "hang";
    await withFixture("m4b-cancel", async (value) => {
      const runtime = await createOpenCodeCliExecutorV2({ store: value.store, authorizedInvocation: value.authorizedInvocation, timeoutPolicy: value.timeoutPolicy });
      const running = executeAuthorizedInvocationV2(executionInput(value, runtime));
      while (transport.promptCalls === 0) await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      const receipt = await runtime.requestCancel(value.authorizedInvocation.descriptor.invocationId);
      expect(receipt.requestState).toBe("ISSUED");
      const result = await running;
      expect(result.kind).toBe("EXECUTOR_FINISHED_READY_FOR_CAPTURE");
      expect(result.kind === "EXECUTOR_FINISHED_READY_FOR_CAPTURE" ? result.resultArtifact.status : null).toBe("CANCELLED");
      expect(transport.abortCalls).toBeGreaterThan(0);
      expect((await readProviderInvocationArtifactSetV2(value.store, value.authorizedInvocation.descriptor.attemptId)).terminal).toMatchObject({ status: "CANCELLED", termination: "CANCELLED" });
    });
  });

  it("uses the exact precommitted timeout once and performs no retry", async () => {
    transport.mode = "hang";
    await withFixture("m4b-timeout", async (value) => {
      const runtime = await createOpenCodeCliExecutorV2({ store: value.store, authorizedInvocation: value.authorizedInvocation, timeoutPolicy: value.timeoutPolicy });
      const result = await executeAuthorizedInvocationV2(executionInput(value, runtime));
      expect(result.kind).toBe("EXECUTOR_FINISHED_READY_FOR_CAPTURE");
      expect(result.kind === "EXECUTOR_FINISHED_READY_FOR_CAPTURE" ? result.resultArtifact.status : null).toBe("TIMED_OUT");
      expect((await readProviderInvocationArtifactSetV2(value.store, value.authorizedInvocation.descriptor.attemptId)).terminal).toMatchObject({ status: "TIMED_OUT", termination: "TIMEOUT" });
      expect(transport.promptCalls).toBe(1);
      expect(transport.sessionCreates).toBe(1);
    }, 30);
  });
});
