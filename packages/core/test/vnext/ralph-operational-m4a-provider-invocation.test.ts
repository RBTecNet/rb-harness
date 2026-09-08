import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { OpenCodeProcess } from "../../src/vnext/providers/opencode/cli-adapter.js";
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
  commitRalphEventV2,
  createRetryPolicyV1,
  initializeOperationalRunV2,
  RalphEventStoreV2,
  retryPolicyDescriptorV1,
  type RunSnapshotV2,
} from "../../src/vnext/ralph-runtime/operational-b1/index.js";
import {
  acquireLeasedRunV2,
  type ProcessIdentity,
  type ProcessIdentityInspection,
  type ProcessIdentityProvider,
} from "../../src/vnext/ralph-runtime/operational-b2/index.js";
import { prepareNextAuthorizedInvocationV2, type AuthorizedInvocationV2 } from "../../src/vnext/ralph-runtime/operational-b3/index.js";
import {
  OpenCodeCliInvocationObserverV2,
  assertTrustedOpenCodeCliInvocationObserverV2,
  createProviderDispatchIntentV2,
  createProviderInvocationDescriptorV2,
  createProviderSessionBindingV2,
  createProviderTerminalArtifactV2,
  createProviderWorkerReceiptV2,
  isTrustedOpenCodeCliInvocationObserverV2,
  persistProviderDispatchIntentV2,
  persistProviderInvocationDescriptorV2,
  persistProviderSessionBindingV2,
  persistProviderTerminalArtifactV2,
  persistProviderWorkerReceiptV2,
  providerInvocationDescriptorRefV2,
  readProviderInvocationArtifactSetV2,
  validateProviderInvocationDescriptorV2,
  type OpenCodeCliSessionObservationV2,
  type OpenCodeCliSessionInspectorV2,
  type OpenCodeCliExecutableIdentityInputV2,
  type ProviderInvocationDescriptorV2,
  type ProviderProcessTreeStateV2,
} from "../../src/vnext/ralph-runtime/operational-b4/index.js";
import { createWorkspacePolicy, fingerprintWorkspace } from "../../src/vnext/ralph-runtime/fingerprint.js";
import { canonicalJson } from "../../src/vnext/ralph-runtime/canonical-json.js";
import { sha256, sha256Canonical } from "../../src/vnext/ralph-runtime/hashing.js";
import { createCorrectionContextV2, persistCorrectionContextV2 } from "../../src/vnext/ralph-runtime/operational-f/index.js";
import {
  createOpenCodePromptArtifactV2,
  createOpenCodeProviderResultV2,
  openCodeProviderResultRefV2,
  persistOpenCodePromptArtifactV2,
  persistOpenCodeProviderResultV2,
} from "../../src/vnext/ralph-runtime/operational-b4/opencode-cli-result.js";
import {
  SupportedOpenCodeCliSessionInspectorV2,
  parseExactAssistantTurnV2,
} from "../../src/vnext/ralph-runtime/operational-b4/opencode-cli-session-inspector.js";
import { validateOpenCodeSessionExportTransportV2 } from "../../src/vnext/ralph-runtime/operational-b4/opencode-cli-transport-safety.js";

const MODEL_SELECTOR = "opencode-go/deepseek-v4-pro";
const PROFILE_ID = `opencode:cli:${MODEL_SELECTOR}`;
const TEST_MAX_TASK_ATTEMPTS = 2;
const TEST_VALIDATION_INFRA_RETRIES = 1;
const OPENCODE_EXECUTABLE = "/home/bruno/.opencode/bin/opencode";
const DUAL_VIEW_SESSION = "ses_f80e11c17ffePBoHPiPJeH1wxf";
const DUAL_VIEW_USER = "msg_ralph_a7439ea788f86139dabe65cb15ed5e870e9bd381";
const DUAL_VIEW_FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/opencode-cli-1.18.29-dual-view-turn.json");
const MATCHING_EXECUTABLE: OpenCodeCliExecutableIdentityInputV2 = Object.freeze({
  executablePath: OPENCODE_EXECUTABLE,
  executableVersion: "1.18.29",
  conformanceProfileId: PROFILE_ID,
  conformanceRecordDigest: sha256("m4a-matching-conformance-record"),
  conformanceExecutableVersion: "1.18.29",
});
const STALE_CONFORMANCE_EXECUTABLE: OpenCodeCliExecutableIdentityInputV2 = Object.freeze({
  ...MATCHING_EXECUTABLE,
  conformanceRecordDigest: sha256("existing-opencode-conformance-record"),
  conformanceExecutableVersion: "1.18.25",
});
const WORKER_IDENTITY: ProcessIdentity = Object.freeze({
  pid: 64001,
  processStartIdentity: sha256("m4a-worker-birth"),
  hostIdentity: sha256("m4a-host"),
  bootSessionIdentity: sha256("m4a-boot"),
});
const LEASE_IDENTITY: ProcessIdentity = Object.freeze({
  pid: 64000,
  processStartIdentity: sha256("m4a-lease-birth"),
  hostIdentity: sha256("m4a-host"),
  bootSessionIdentity: sha256("m4a-boot"),
});

interface Fixture {
  readonly root: string;
  readonly store: RalphEventStoreV2;
  readonly document: ExecutionDocument;
  readonly genesis: RalphRuntimeStateV2;
  readonly authorizedInvocation: AuthorizedInvocationV2;
}

interface DurableChain {
  readonly descriptor: Awaited<ReturnType<typeof createProviderInvocationDescriptorV2>>;
  readonly intent: ReturnType<typeof createProviderDispatchIntentV2>;
  readonly worker: ReturnType<typeof createProviderWorkerReceiptV2>;
  readonly session: ReturnType<typeof createProviderSessionBindingV2>;
}

function task(): Task {
  return {
    id: "T001",
    title: "M4-A invocation identity",
    done: false,
    scope: "src",
    change: "exercise durable provider identity without inference",
    covers: "src",
    dependsOn: [],
    parallelSafe: false,
    acceptanceCriteria: ["provider invocation remains observable after restart"],
    validation: ["`printf m4a`"],
    expectedEvidence: "durable bounded provider artifacts",
    line: 1,
  };
}

function plan(): ExecutionDocument {
  const phase: Phase = { number: 1, id: "P01", title: "M4-A", goal: "prove provider identity", dependsOn: [], context: ["test"], tasks: [task()], line: 1 };
  return { contract: "rb-execution/v1", artifactId: "plan-m4a", title: "M4-A", phases: [phase] };
}

function descriptor(schemaVersion: string, descriptorId: string) {
  const base = { schemaVersion, descriptorId };
  return { ...base, descriptorDigest: sha256Canonical(base) };
}

function genesis(document: ExecutionDocument, runId: string): RalphRuntimeStateV2 {
  return createInitialRuntimeStateV2({
    runId,
    maxTaskAttemptsPerTask: TEST_MAX_TASK_ATTEMPTS,
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
        : { kind: "attempt", id: context.attemptId ?? "attempt-m4a-001" };
  return createRalphEventV2({
    eventId: `m4a-event-${state.lastSequence + 1}-${eventType}`,
    eventType,
    schemaVersion: EVENT_SCHEMA_V2,
    runId: state.runId,
    sequence: state.lastSequence + 1,
    occurredAt: "2026-09-07T12:00:00.000Z",
    recordedAt: "2026-09-07T12:00:00.000Z",
    entity,
    ...(context.phaseId === undefined ? {} : { phaseId: context.phaseId }),
    ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
    ...(context.attemptId === undefined ? {} : { attemptId: context.attemptId }),
    actor: "CORE",
    causationId: null,
    correlationId: `${state.runId}:m4a`,
    payload,
    previousEventHash: state.lastEventHash,
  } as UnsignedRalphEventV2<TType>) as RalphEventV2;
}

async function fixture(runId: string): Promise<Fixture> {
  const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-m4a-"));
  const document = plan();
  const workspacePolicy = createWorkspacePolicy();
  const fingerprint = await fingerprintWorkspace(root, workspacePolicy);
  const retryPolicy = createRetryPolicyV1({ runId, policyId: "m4a-retry", maxTaskAttemptsPerTask: TEST_MAX_TASK_ATTEMPTS, validationInfrastructureRetryLimit: TEST_VALIDATION_INFRA_RETRIES });
  const snapshot: RunSnapshotV2 = {
    snapshotSchemaVersion: RALPH_RUN_SNAPSHOT_V2_SCHEMA,
    runId,
    eventSchema: EVENT_SCHEMA_V2,
    stateSchema: STATE_SCHEMA_V2,
    operationalContract: OPERATIONAL_CONTRACT_V2,
    projectIdentity: { projectId: "m4a-project" },
    readyPlanIdentity: document.artifactId,
    readyPlanHash: sha256Canonical(document),
    readyManifestHash: sha256("m4a-manifest"),
    selectedReadyArtifactHashes: { plan: sha256Canonical(document) },
    readinessInspectionDigest: sha256("m4a-readiness"),
    effectiveRunConfig: descriptor("rb-ralph-config/v2", "m4a-config"),
    effectiveConfigDigest: descriptor("rb-ralph-config/v2", "m4a-config").descriptorDigest,
    diagnosticsPolicy: descriptor("rb-ralph-diagnostics/v2", "m4a-diagnostics"),
    environmentPolicy: descriptor("rb-ralph-environment/v2", "m4a-environment"),
    executorProfile: { profileId: PROFILE_ID, kind: "scripted", descriptorDigest: sha256("m4a-opencode-profile") },
    executorCapabilities: { requested: ["workspace.write"], granted: ["workspace.write"], verified: ["workspace.write"], readOnlyEnforced: false },
    permissionCapabilityPolicy: descriptor("rb-ralph-capabilities/v2", "m4a-capabilities"),
    workspacePolicy,
    initialWorkspaceFingerprint: { controlPlaneFingerprint: fingerprint.controlPlaneFingerprint, productWorkspaceFingerprint: fingerprint.productWorkspaceFingerprint, policyDigest: fingerprint.policyDigest, fingerprintDigest: fingerprint.fingerprintDigest },
    retryPolicies: retryPolicyDescriptorV1(retryPolicy),
    timeoutPolicy: descriptor("rb-ralph-timeout/v2", "m4a-timeout"),
    runtimeIdentity: descriptor("rb-ralph-runtime/v2", "m4a-runtime"),
    leasePolicy: descriptor("rb-ralph-lease/v2", "m4a-lease"),
    createdAt: "2026-09-07T12:00:00.000Z",
  };
  const store = new RalphEventStoreV2({ projectRoot: root, runId });
  const initial = genesis(document, runId);
  const initialized = await initializeOperationalRunV2({
    store,
    snapshot,
    retryPolicy,
    genesisState: initial,
    runCreatedEvent: event(initial, "run.created", { phaseIds: initial.phaseIds, taskIds: initial.taskIds }),
    createdAt: "2026-09-07T12:00:01.000Z",
    nonce: "m4a-init",
  });
  let state = (await commitRalphEventV2({ store, state: initialized.state, event: event(initialized.state, "run.started", {}), writtenAt: "2026-09-07T12:00:02.000Z", nonce: "m4a-start" })).state;
  state = (await commitRalphEventV2({ store, state, event: event(state, "task.state-changed", { disposition: "READY", activity: "IDLE", owner: "NONE", hold: "NONE" }, { phaseId: "P01", taskId: "T001" }), writtenAt: "2026-09-07T12:00:03.000Z", nonce: "m4a-ready" })).state;
  const leaseProvider: ProcessIdentityProvider = { current: () => LEASE_IDENTITY, inspect: () => "MATCH" };
  const leased = await acquireLeasedRunV2({ projectRoot: root, runId, genesisState: initial, processIdentityProvider: leaseProvider });
  const admitted = await prepareNextAuthorizedInvocationV2({
    leasedRun: leased,
    plan: document,
    planIdentity: document.artifactId,
    planDigest: sha256Canonical(document),
    attemptIdFactory: () => "attempt-m4a-001",
    eventIdFactory: () => "m4a-attempt-event",
    nonceFactory: () => "m4a-admission",
    clock: () => "2026-09-07T12:00:04.000Z",
  });
  if (admitted.kind !== "AUTHORIZED_NOT_INVOKED") throw new Error(`M4-A fixture admission failed: ${admitted.kind}`);
  return { root, store, document, genesis: initial, authorizedInvocation: admitted.authorizedInvocation };
}

async function persistDescriptorAndIntent(value: Fixture): Promise<{ readonly descriptor: DurableChain["descriptor"]; readonly intent: DurableChain["intent"] }> {
  const descriptorValue = await createProviderInvocationDescriptorV2({ store: value.store, authorizedInvocation: value.authorizedInvocation, executable: MATCHING_EXECUTABLE });
  await persistProviderInvocationDescriptorV2(value.store, descriptorValue, "m4a-descriptor");
  const intent = createProviderDispatchIntentV2(descriptorValue, "2026-09-07T12:00:05.000Z");
  await persistProviderDispatchIntentV2(value.store, intent, "m4a-intent");
  return { descriptor: descriptorValue, intent };
}

async function persistWorkerAndSession(value: Fixture, openCodeSessionId = "ses_m4aDedicatedSession0001"): Promise<DurableChain> {
  const { descriptor: descriptorValue, intent } = await persistDescriptorAndIntent(value);
  const worker = createProviderWorkerReceiptV2({ descriptor: descriptorValue, dispatchIntent: intent, processIdentity: WORKER_IDENTITY, processGroupId: 64001, startedAt: "2026-09-07T12:00:06.000Z" });
  await persistProviderWorkerReceiptV2(value.store, worker, "m4a-worker");
  const session = createProviderSessionBindingV2({ descriptor: descriptorValue, dispatchIntent: intent, workerReceipt: worker, openCodeSessionId, boundAt: "2026-09-07T12:00:07.000Z" });
  await persistProviderSessionBindingV2(value.store, session, "m4a-session");
  return { descriptor: descriptorValue, intent, worker, session };
}

async function dualViewFixture(): Promise<{ readonly live: Record<string, unknown>; readonly sanitized: Record<string, unknown> }> {
  const value = JSON.parse(await readFile(DUAL_VIEW_FIXTURE, "utf8")) as Record<string, unknown>;
  return { live: value.live as Record<string, unknown>, sanitized: value.sanitized as Record<string, unknown> };
}

function exportProcess(value: unknown, options: { readonly exitCode?: number; readonly malformed?: boolean } = {}): OpenCodeProcess {
  return {
    run: async () => ({
      stdout: options.malformed ? "{" : JSON.stringify(value),
      exitCode: options.exitCode ?? 0,
      startedAt: "2026-09-07T12:00:15.000Z",
      completedAt: "2026-09-07T12:00:16.000Z",
      cancelled: false,
      timedOut: false,
      outputLimitExceeded: false,
      settlement: {
        observed: true,
        quiescent: true,
        verified: true,
        survivors: [],
        containment: { kind: "cgroup2", structural: true, reason: "deterministic fixture" },
      },
    }),
  };
}

function bindFixtureUser(value: Record<string, unknown>, userMessageId: string): Record<string, unknown> {
  const fixture = structuredClone(value);
  const messages = fixture.messages as Array<Record<string, unknown>>;
  (messages[0]!.info as Record<string, unknown>).id = userMessageId;
  for (const part of messages[0]!.parts as Array<Record<string, unknown>>) part.messageID = userMessageId;
  for (const message of messages.slice(1)) (message.info as Record<string, unknown>).parentID = userMessageId;
  return fixture;
}

function processProvider(result: ProcessIdentityInspection): ProcessIdentityProvider {
  return { current: () => WORKER_IDENTITY, inspect: () => result };
}

function sessionObservation(overrides: Partial<OpenCodeCliSessionObservationV2> = {}): OpenCodeCliSessionObservationV2 {
  return {
    sessionIdentity: "MATCH",
    observedSessionId: "ses_m4aDedicatedSession0001",
    activity: "STATUS_UNPROVEN",
    modelIdentity: "MATCH",
    observedModelSelector: MODEL_SELECTOR,
    userMessageIdentity: "MATCH",
    observedUserMessageId: "msg_ralph_placeholder",
    resultIdentity: "ABSENT",
    observedResultRef: null,
    observedResultDigest: null,
    ...overrides,
  };
}

function observer(value: Fixture, options: {
  readonly process?: ProcessIdentityInspection;
  readonly tree?: ProviderProcessTreeStateV2;
  readonly session?: OpenCodeCliSessionObservationV2;
  readonly executable?: OpenCodeCliExecutableIdentityInputV2;
} = {}): OpenCodeCliInvocationObserverV2 {
  const sessionInspector: OpenCodeCliSessionInspectorV2 = { inspect: ({ dispatchIntent }) => {
    const configured = options.session ?? sessionObservation({ sessionIdentity: "UNKNOWN", observedSessionId: null, modelIdentity: "UNKNOWN", observedModelSelector: null, userMessageIdentity: "UNKNOWN", observedUserMessageId: null, resultIdentity: "UNKNOWN" });
    return configured.observedUserMessageId === "msg_ralph_placeholder" ? { ...configured, observedUserMessageId: dispatchIntent.openCodeUserMessageId } : configured;
  } };
  return new OpenCodeCliInvocationObserverV2({
    store: new RalphEventStoreV2({ projectRoot: value.root, runId: value.store.runId }),
    executable: options.executable ?? MATCHING_EXECUTABLE,
    processIdentityProvider: processProvider(options.process ?? "UNKNOWN"),
    processTreeInspector: { inspect: () => options.tree ?? "UNKNOWN" },
    sessionInspector,
    clock: () => "2026-09-07T12:00:20.000Z",
    observationIdFactory: () => "fresh-runtime",
  });
}

async function withFixture(name: string, action: (value: Fixture) => Promise<void>): Promise<void> {
  const value = await fixture(`run-${name}`);
  try { await action(value); }
  finally { await rm(value.root, { recursive: true, force: true }); }
}

describe("Ralph M4-A — durable OpenCode CLI provider invocation authority", () => {
  it("persists a closed immutable descriptor bound to Core, project, model, executable and exact conformance", async () => {
    await withFixture("m4a-descriptor", async (value) => {
      const descriptorValue = await createProviderInvocationDescriptorV2({ store: value.store, authorizedInvocation: value.authorizedInvocation, executable: MATCHING_EXECUTABLE });
      expect(descriptorValue).toMatchObject({ transport: "opencode-cli", modelSelector: MODEL_SELECTOR, executorProfileIdentity: PROFILE_ID, openCodeExecutableVersion: "1.18.29", conformanceState: "MATCH", correctionContextRef: null });
      const first = await persistProviderInvocationDescriptorV2(value.store, descriptorValue, "descriptor-first");
      const second = await persistProviderInvocationDescriptorV2(value.store, descriptorValue, "descriptor-second");
      expect(first.publishDisposition).toBe("PUBLISHED_BY_THIS_CALL");
      expect(second.publishDisposition).toBe("ALREADY_PRESENT");
      const path = join(value.store.runDirectory, providerInvocationDescriptorRefV2(descriptorValue.attemptId));
      expect((await lstat(path)).mode & 0o7777).toBe(0o600);
      expect(await readFile(path, "utf8")).toBe(canonicalJson(descriptorValue));

      const otherExecutable = { ...MATCHING_EXECUTABLE, executablePath: "/opt/opencode", executableVersion: "1.18.30", conformanceExecutableVersion: "1.18.30", conformanceRecordDigest: sha256("other-conformance") };
      const conflicting = await createProviderInvocationDescriptorV2({ store: value.store, authorizedInvocation: value.authorizedInvocation, executable: otherExecutable });
      await expect(persistProviderInvocationDescriptorV2(value.store, conflicting, "descriptor-conflict")).rejects.toMatchObject({ code: "B4_ARTIFACT_IMMUTABLE_CONFLICT" });
    });
  });

  it("detects installed 1.18.29 versus recorded 1.18.25 and blocks dispatch until conformance is renewed", async () => {
    await withFixture("m4a-conformance", async (value) => {
      const descriptorValue = await createProviderInvocationDescriptorV2({ store: value.store, authorizedInvocation: value.authorizedInvocation, executable: STALE_CONFORMANCE_EXECUTABLE });
      expect(descriptorValue.conformanceState).toBe("MISMATCH");
      await persistProviderInvocationDescriptorV2(value.store, descriptorValue, "stale-descriptor");
      expect(() => createProviderDispatchIntentV2(descriptorValue, "2026-09-07T12:00:05.000Z")).toThrow(expect.objectContaining({ code: "M4A_OPENCODE_CONFORMANCE_REQUIRED" }));
    });
  });

  it("resolves an existing CorrectionContext from the Attempt namespace instead of accepting caller binding input", async () => {
    await withFixture("m4a-correction-binding", async (value) => {
      const core = value.authorizedInvocation.descriptor;
      const context = createCorrectionContextV2({
        runId: core.runId,
        phaseId: core.phaseId,
        taskId: core.taskId,
        currentAttemptId: core.attemptId,
        sourceRejectedAttempts: [],
        openFindingRefs: [],
        openFindings: [],
        baseWorkspaceFingerprint: core.attemptBaseFingerprint,
        createdAt: "2026-09-07T12:00:04.500Z",
      });
      await persistCorrectionContextV2(value.store, context, "m4a-correction");
      const descriptorValue = await createProviderInvocationDescriptorV2({ store: value.store, authorizedInvocation: value.authorizedInvocation, executable: MATCHING_EXECUTABLE });
      expect(descriptorValue.correctionContextRef).toBe(`attempts/${core.attemptId}/correction-context.json`);
      expect(descriptorValue.correctionContextDigest).toBe(context.contextDigest);
      await persistProviderInvocationDescriptorV2(value.store, descriptorValue, "m4a-correction-descriptor");
    });
  });

  it("M4A-1/M4A-7: dispatch intent makes every fresh runtime default to UNKNOWN, never NOT_INVOKED", async () => {
    await withFixture("m4a-intent-gap", async (value) => {
      expect((await observer(value).observe(value.authorizedInvocation)).state).toBe("NOT_INVOKED");
      const descriptorValue = await createProviderInvocationDescriptorV2({ store: value.store, authorizedInvocation: value.authorizedInvocation, executable: MATCHING_EXECUTABLE });
      await persistProviderInvocationDescriptorV2(value.store, descriptorValue, "descriptor-only");
      expect((await observer(value).observe(value.authorizedInvocation)).state).toBe("NOT_INVOKED");
      const intent = createProviderDispatchIntentV2(descriptorValue, "2026-09-07T12:00:05.000Z");
      await persistProviderDispatchIntentV2(value.store, intent, "intent-gap");
      for (let fresh = 0; fresh < 3; fresh += 1) {
        const observation = await observer(value).observe(value.authorizedInvocation);
        expect(observation.state).toBe("UNKNOWN");
        expect(observation.safeMetadata.dispatchIntent).toBe("PRESENT");
      }
    });
  });

  it("M4A-2: accepts a complete birth identity as RUNNING but PID reuse/mismatch and disappearance remain UNKNOWN", async () => {
    await withFixture("m4a-process-birth", async (value) => {
      const { descriptor: descriptorValue, intent } = await persistDescriptorAndIntent(value);
      const worker = createProviderWorkerReceiptV2({ descriptor: descriptorValue, dispatchIntent: intent, processIdentity: WORKER_IDENTITY, processGroupId: 64001, startedAt: "2026-09-07T12:00:06.000Z" });
      await persistProviderWorkerReceiptV2(value.store, worker, "worker-birth");
      expect((await observer(value, { process: "MATCH" }).observe(value.authorizedInvocation)).state).toBe("RUNNING");
      expect((await observer(value, { process: "START_MISMATCH" }).observe(value.authorizedInvocation)).state).toBe("UNKNOWN");
      expect((await observer(value, { process: "ABSENT" }).observe(value.authorizedInvocation)).state).toBe("UNKNOWN");
      const session = createProviderSessionBindingV2({ descriptor: descriptorValue, dispatchIntent: intent, workerReceipt: worker, openCodeSessionId: "ses_m4aDedicatedSession0001", boundAt: "2026-09-07T12:00:07.000Z" });
      await persistProviderSessionBindingV2(value.store, session, "worker-birth-session");
      expect((await observer(value, { process: "START_MISMATCH", session: sessionObservation({ activity: "ACTIVE" }) }).observe(value.authorizedInvocation)).state).toBe("UNKNOWN");
    });
  });

  it("M4A-3/M4A-5: idle or foreign session observations cannot manufacture terminal or running authority", async () => {
    await withFixture("m4a-session-safe", async (value) => {
      await persistWorkerAndSession(value);
      const idle = sessionObservation({ activity: "INACTIVE" });
      expect((await observer(value, { process: "ABSENT", tree: "QUIESCENT", session: idle }).observe(value.authorizedInvocation)).state).toBe("UNKNOWN");
      const foreign = sessionObservation({ sessionIdentity: "FOREIGN", observedSessionId: "ses_foreignSession9999", activity: "ACTIVE" });
      expect((await observer(value, { process: "MATCH", tree: "ACTIVE", session: foreign }).observe(value.authorizedInvocation)).state).toBe("UNKNOWN");
    });
  });

  it("M4A-4: terminal bytes do not establish quiescence while the exact process/tree remains active", async () => {
    await withFixture("m4a-terminal-active", async (value) => {
      const chain = await persistWorkerAndSession(value);
      const resultRef = `attempts/${chain.descriptor.attemptId}/provider-result.json`;
      const resultDigest = sha256("bounded-provider-result");
      const terminal = createProviderTerminalArtifactV2({
        descriptor: chain.descriptor,
        dispatchIntent: chain.intent,
        workerReceipt: chain.worker,
        sessionBinding: chain.session,
        status: "SUCCEEDED",
        termination: "NORMAL",
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
        resultRef,
        resultDigest,
        finishedAt: "2026-09-07T12:00:10.000Z",
        quiescence: { workerProcessState: "ABSENT", processTreeState: "QUIESCENT", observedAt: "2026-09-07T12:00:09.000Z" },
      });
      await persistProviderTerminalArtifactV2(value.store, terminal, "terminal-active");
      const matchedResult = sessionObservation({ resultIdentity: "MATCH", observedResultRef: resultRef, observedResultDigest: resultDigest });
      expect((await observer(value, { process: "MATCH", tree: "ACTIVE", session: matchedResult }).observe(value.authorizedInvocation)).state).toBe("UNKNOWN");
      expect((await observer(value, { process: "ABSENT", tree: "UNKNOWN", session: matchedResult }).observe(value.authorizedInvocation)).state).toBe("UNKNOWN");
    });
  });

  it("reaches TERMINATED_QUIESCENT only with exact result binding plus fresh positive process-tree quiescence", async () => {
    await withFixture("m4a-terminal-quiescent", async (value) => {
      const chain = await persistWorkerAndSession(value);
      const resultRef = `attempts/${chain.descriptor.attemptId}/provider-result.json`;
      const resultDigest = sha256("exact-provider-result");
      const terminal = createProviderTerminalArtifactV2({
        descriptor: chain.descriptor,
        dispatchIntent: chain.intent,
        workerReceipt: chain.worker,
        sessionBinding: chain.session,
        status: "SUCCEEDED",
        termination: "NORMAL",
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
        resultRef,
        resultDigest,
        finishedAt: "2026-09-07T12:00:10.000Z",
        quiescence: { workerProcessState: "ABSENT", processTreeState: "QUIESCENT", observedAt: "2026-09-07T12:00:09.000Z" },
      });
      await persistProviderTerminalArtifactV2(value.store, terminal, "terminal-quiescent");
      const exact = sessionObservation({ resultIdentity: "MATCH", observedResultRef: resultRef, observedResultDigest: resultDigest });
      const complete = await observer(value, { process: "ABSENT", tree: "QUIESCENT", session: exact }).observe(value.authorizedInvocation);
      expect(complete).toMatchObject({ state: "TERMINATED_QUIESCENT", status: "SUCCEEDED", termination: "NORMAL", exitCode: 0 });
      const wrongResult = sessionObservation({ resultIdentity: "MATCH", observedResultRef: resultRef, observedResultDigest: sha256("wrong") });
      expect((await observer(value, { process: "ABSENT", tree: "QUIESCENT", session: wrongResult }).observe(value.authorizedInvocation)).state).toBe("UNKNOWN");
      const wrongMessage = sessionObservation({ userMessageIdentity: "MISMATCH", observedUserMessageId: "msg_foreign", resultIdentity: "MATCH", observedResultRef: resultRef, observedResultDigest: resultDigest });
      expect((await observer(value, { process: "ABSENT", tree: "QUIESCENT", session: wrongMessage }).observe(value.authorizedInvocation)).state).toBe("UNKNOWN");
    });
  });

  it("M4B-17..20: real supported inspector rebinds the paired sanitized view and drives M4-A terminal authority", async () => {
    await withFixture("m4b-supported-session-inspector", async (value) => {
      const pair = await dualViewFixture();
      const chain = await persistWorkerAndSession(value, DUAL_VIEW_SESSION);
      const liveFixture = bindFixtureUser(pair.live, chain.intent.openCodeUserMessageId);
      const sanitizedFixture = bindFixtureUser(pair.sanitized, chain.intent.openCodeUserMessageId);
      const liveTransport = validateOpenCodeSessionExportTransportV2(liveFixture);
      const sanitizedTransport = validateOpenCodeSessionExportTransportV2(sanitizedFixture);
      const live = parseExactAssistantTurnV2(liveTransport.messages, DUAL_VIEW_SESSION, chain.intent.openCodeUserMessageId);
      const sanitized = parseExactAssistantTurnV2(sanitizedTransport.messages, DUAL_VIEW_SESSION, chain.intent.openCodeUserMessageId);
      expect(live.observableTurnDigest).toBe(sanitized.observableTurnDigest);
      expect(live.responseDigest).not.toBe(sanitized.responseDigest);

      const prompt = createOpenCodePromptArtifactV2({
        runId: chain.descriptor.runId, phaseId: chain.descriptor.phaseId, taskId: chain.descriptor.taskId,
        attemptId: chain.descriptor.attemptId, invocationId: chain.descriptor.invocationId,
        descriptorDigest: chain.descriptor.descriptorDigest, dispatchIntentDigest: chain.intent.intentDigest,
        sessionBindingDigest: chain.session.bindingDigest, openCodeSessionId: chain.session.openCodeSessionId,
        openCodeUserMessageId: chain.intent.openCodeUserMessageId, modelSelector: chain.descriptor.modelSelector,
        promptDigest: sha256("m4b-inspector-prompt"), promptBytes: 128, preparedAt: "2026-09-07T12:00:08.000Z",
      });
      await persistOpenCodePromptArtifactV2(value.store, prompt, "m4b-inspector-prompt");
      const result = createOpenCodeProviderResultV2({
        runId: chain.descriptor.runId, phaseId: chain.descriptor.phaseId, taskId: chain.descriptor.taskId,
        attemptId: chain.descriptor.attemptId, invocationId: chain.descriptor.invocationId,
        descriptorDigest: chain.descriptor.descriptorDigest, dispatchIntentDigest: chain.intent.intentDigest,
        sessionBindingDigest: chain.session.bindingDigest, promptArtifactDigest: prompt.artifactDigest,
        openCodeSessionId: chain.session.openCodeSessionId, openCodeUserMessageId: chain.intent.openCodeUserMessageId,
        assistantMessageId: live.assistantMessageId, observedModelSelector: live.modelSelector, classification: live.classification,
        assistantContentDigest: live.assistantContentDigest, responseDigest: live.responseDigest,
        observableTurnDigest: live.observableTurnDigest, startedAt: chain.worker.startedAt, finishedAt: "2026-09-07T12:00:10.000Z",
      });
      await persistOpenCodeProviderResultV2(value.store, result, "m4b-inspector-result");
      const terminal = createProviderTerminalArtifactV2({
        descriptor: chain.descriptor, dispatchIntent: chain.intent, workerReceipt: chain.worker, sessionBinding: chain.session,
        status: "SUCCEEDED", termination: "NORMAL", exitCode: 0, signal: null, timedOut: false, cancelled: false,
        resultRef: openCodeProviderResultRefV2(chain.descriptor.attemptId), resultDigest: result.resultDigest,
        finishedAt: result.finishedAt,
        quiescence: { workerProcessState: "ABSENT", processTreeState: "QUIESCENT", observedAt: "2026-09-07T12:00:11.000Z" },
      });
      await persistProviderTerminalArtifactV2(value.store, terminal, "m4b-inspector-terminal");
      const input = { descriptor: chain.descriptor, dispatchIntent: chain.intent, sessionBinding: chain.session, terminal };
      const inspect = async (transport: unknown, options: { readonly exitCode?: number; readonly malformed?: boolean } = {}) => {
        const inspector = new SupportedOpenCodeCliSessionInspectorV2({
          store: new RalphEventStoreV2({ projectRoot: value.root, runId: value.store.runId }),
          projectRoot: value.root,
          executablePath: OPENCODE_EXECUTABLE,
          deadlineMs: 5_000,
          processClient: exportProcess(transport, options),
        });
        return inspector.inspect(input);
      };

      const matching = await inspect(sanitizedFixture);
      expect(matching).toMatchObject({
        sessionIdentity: "MATCH", userMessageIdentity: "MATCH", modelIdentity: "MATCH", resultIdentity: "MATCH",
        observedResultRef: terminal.resultRef, observedResultDigest: terminal.resultDigest,
      });

      const wrongTerminal = structuredClone(sanitizedFixture);
      const wrongTerminalMessage = (wrongTerminal.messages as Array<Record<string, unknown>>).at(-1)!;
      (wrongTerminalMessage.info as Record<string, unknown>).id = "msg_foreign_terminal_observation_001";
      for (const part of wrongTerminalMessage.parts as Array<Record<string, unknown>>) part.messageID = "msg_foreign_terminal_observation_001";
      expect((await inspect(wrongTerminal)).resultIdentity).toBe("MISMATCH");

      const wrongUser = structuredClone(sanitizedFixture);
      const wrongUserMessages = wrongUser.messages as Array<Record<string, unknown>>;
      const wrongUserId = "msg_foreign_core_user_observation_001";
      (wrongUserMessages[0]!.info as Record<string, unknown>).id = wrongUserId;
      for (const part of wrongUserMessages[0]!.parts as Array<Record<string, unknown>>) part.messageID = wrongUserId;
      for (const message of wrongUserMessages.slice(1)) (message.info as Record<string, unknown>).parentID = wrongUserId;
      expect(await inspect(wrongUser)).toMatchObject({ userMessageIdentity: "MISMATCH", resultIdentity: "ABSENT" });

      const wrongSession = structuredClone(sanitizedFixture);
      (wrongSession.info as Record<string, unknown>).id = "ses_foreignObservationSession001";
      expect(await inspect(wrongSession)).toMatchObject({ sessionIdentity: "FOREIGN", resultIdentity: "UNKNOWN" });

      const wrongModel = structuredClone(sanitizedFixture);
      (((wrongModel.messages as Array<Record<string, unknown>>).at(-1)!.info) as Record<string, unknown>).modelID = "foreign-model";
      expect(await inspect(wrongModel)).toMatchObject({ modelIdentity: "MISMATCH", resultIdentity: "ABSENT" });

      const structuralMismatch = structuredClone(sanitizedFixture);
      const structuralTool = ((structuralMismatch.messages as Array<Record<string, unknown>>)[1]!.parts as Array<Record<string, unknown>>)
        .find((part) => part.type === "tool")!;
      structuralTool.callID = "call_foreign_observation_001";
      expect((await inspect(structuralMismatch)).resultIdentity).toBe("MISMATCH");

      const missingResult = structuredClone(sanitizedFixture);
      (missingResult.messages as unknown[]).pop();
      expect((await inspect(missingResult)).resultIdentity).toBe("ABSENT");
      expect(await inspect({}, { malformed: true })).toMatchObject({ sessionIdentity: "UNKNOWN", resultIdentity: "UNKNOWN" });

      const unsafe = structuredClone(sanitizedFixture);
      const unsafeTerminal = (unsafe.messages as Array<Record<string, unknown>>).at(-1)!;
      ((unsafeTerminal.parts as Array<Record<string, unknown>>).find((part) => part.type === "text")!).text = "Authorization: Bearer sk-forbidden-material";
      expect(await inspect(unsafe)).toMatchObject({ sessionIdentity: "UNKNOWN", resultIdentity: "UNKNOWN" });

      const twoTerminals = structuredClone(sanitizedFixture);
      const injected = structuredClone((twoTerminals.messages as Array<Record<string, unknown>>).at(-1)!);
      (injected.info as Record<string, unknown>).id = "msg_injected_terminal_observation_002";
      for (const [index, part] of (injected.parts as Array<Record<string, unknown>>).entries()) {
        part.id = `prt_injected_observation_${index}`;
        part.messageID = "msg_injected_terminal_observation_002";
      }
      (twoTerminals.messages as Array<Record<string, unknown>>).push(injected);
      expect((await inspect(twoTerminals)).resultIdentity).toBe("ABSENT");
      expect(await inspect(sanitizedFixture, { exitCode: 1 })).toMatchObject({ sessionIdentity: "UNKNOWN", resultIdentity: "UNKNOWN" });

      const realInspector = new SupportedOpenCodeCliSessionInspectorV2({
        store: new RalphEventStoreV2({ projectRoot: value.root, runId: value.store.runId }), projectRoot: value.root,
        executablePath: OPENCODE_EXECUTABLE, deadlineMs: 5_000, processClient: exportProcess(sanitizedFixture),
      });
      const freshObserver = new OpenCodeCliInvocationObserverV2({
        store: new RalphEventStoreV2({ projectRoot: value.root, runId: value.store.runId }), executable: MATCHING_EXECUTABLE,
        processIdentityProvider: processProvider("ABSENT"), processTreeInspector: { inspect: () => "QUIESCENT" }, sessionInspector: realInspector,
        clock: () => "2026-09-07T12:00:20.000Z", observationIdFactory: () => "supported-inspector-match",
      });
      expect(await freshObserver.observe(value.authorizedInvocation)).toMatchObject({ state: "TERMINATED_QUIESCENT", status: "SUCCEEDED" });

      const mismatchingInspector = new SupportedOpenCodeCliSessionInspectorV2({
        store: new RalphEventStoreV2({ projectRoot: value.root, runId: value.store.runId }), projectRoot: value.root,
        executablePath: OPENCODE_EXECUTABLE, deadlineMs: 5_000, processClient: exportProcess(structuralMismatch),
      });
      const mismatchingObserver = new OpenCodeCliInvocationObserverV2({
        store: new RalphEventStoreV2({ projectRoot: value.root, runId: value.store.runId }), executable: MATCHING_EXECUTABLE,
        processIdentityProvider: processProvider("ABSENT"), processTreeInspector: { inspect: () => "QUIESCENT" }, sessionInspector: mismatchingInspector,
        clock: () => "2026-09-07T12:00:20.000Z", observationIdFactory: () => "supported-inspector-mismatch",
      });
      expect((await mismatchingObserver.observe(value.authorizedInvocation)).state).toBe("UNKNOWN");
    });
  });

  it("M4A-6: rejects descriptor model/profile substitution against the durable B3 authority", async () => {
    await withFixture("m4a-profile-binding", async (value) => {
      const original = await createProviderInvocationDescriptorV2({ store: value.store, authorizedInvocation: value.authorizedInvocation, executable: MATCHING_EXECUTABLE });
      const profileIdentity = "opencode:cli:opencode/attacker-model";
      const modelSelector = "opencode/attacker-model";
      const runtimeIdentity = `opencode-cli-runtime-${sha256Canonical({ openCodeExecutableIdentity: original.openCodeExecutableIdentity, executorProfileIdentity: profileIdentity, executorProfileDigest: original.executorProfileDigest, modelSelector }).slice("sha256:".length)}`;
      const withoutDigest = { ...original, executorProfileIdentity: profileIdentity, modelSelector, conformanceProfileId: profileIdentity, runtimeIdentity } as Record<string, unknown>;
      delete withoutDigest.descriptorDigest;
      const forged = { ...withoutDigest, descriptorDigest: sha256Canonical(withoutDigest) } as unknown as ProviderInvocationDescriptorV2;
      validateProviderInvocationDescriptorV2(forged);
      await expect(persistProviderInvocationDescriptorV2(value.store, forged, "forged-profile")).rejects.toMatchObject({ code: "M4A_PROVIDER_BINDING_INVALID" });
    });
  });

  it("M4A-8: fails closed on tamper, unknown fields, credentials, foreign binding, traversal and symlink", async () => {
    await withFixture("m4a-artifact-security", async (value) => {
      const descriptorValue = await createProviderInvocationDescriptorV2({ store: value.store, authorizedInvocation: value.authorizedInvocation, executable: MATCHING_EXECUTABLE });
      expect(() => validateProviderInvocationDescriptorV2({ ...descriptorValue, descriptorDigest: sha256("tampered") })).toThrow("M4A_ARTIFACT_DIGEST_MISMATCH");
      expect(() => validateProviderInvocationDescriptorV2({ ...descriptorValue, surprise: true })).toThrow("unknown fields");
      const foreignBase = { ...descriptorValue, runId: "run-foreign" } as Record<string, unknown>;
      delete foreignBase.descriptorDigest;
      const foreign = { ...foreignBase, descriptorDigest: sha256Canonical(foreignBase) } as unknown as ProviderInvocationDescriptorV2;
      await expect(persistProviderInvocationDescriptorV2(value.store, foreign, "foreign-run")).rejects.toMatchObject({ code: "M4A_PROVIDER_BINDING_INVALID" });
      const foreignBindings: readonly [string, unknown][] = [
        ["phaseId", "P99"],
        ["taskId", "T999"],
        ["attemptId", "attempt-foreign-999"],
        ["invocationId", `inv-${"f".repeat(64)}`],
        ["workUnitDigest", sha256("foreign-work-unit")],
        ["projectRootIdentity", sha256("foreign-project-root")],
      ];
      for (const [field, replacement] of foreignBindings) {
        const base = { ...descriptorValue, [field]: replacement } as Record<string, unknown>;
        delete base.descriptorDigest;
        const forgedBinding = { ...base, descriptorDigest: sha256Canonical(base) } as unknown as ProviderInvocationDescriptorV2;
        validateProviderInvocationDescriptorV2(forgedBinding);
        await expect(persistProviderInvocationDescriptorV2(value.store, forgedBinding, `foreign-${field}`)).rejects.toBeDefined();
      }
      await expect(createProviderInvocationDescriptorV2({ store: value.store, authorizedInvocation: value.authorizedInvocation, executable: { ...MATCHING_EXECUTABLE, executableVersion: "sk-abcdefghijklmno", conformanceExecutableVersion: "sk-abcdefghijklmno" } })).rejects.toThrow("M4A_PROVIDER_ARTIFACT_CREDENTIAL");
      await expect(createProviderInvocationDescriptorV2({ store: value.store, authorizedInvocation: value.authorizedInvocation, executable: { ...MATCHING_EXECUTABLE, executableVersion: "x".repeat(513), conformanceExecutableVersion: "x".repeat(513) } })).rejects.toThrow();
      expect(() => providerInvocationDescriptorRefV2("../escape")).toThrow();

      const target = join(value.root, "outside.json");
      await writeFile(target, canonicalJson(descriptorValue), { mode: 0o600 });
      const artifactPath = join(value.store.runDirectory, providerInvocationDescriptorRefV2(descriptorValue.attemptId));
      await symlink(target, artifactPath);
      await expect(readProviderInvocationArtifactSetV2(value.store, descriptorValue.attemptId)).rejects.toMatchObject({ code: "B4_ARTIFACT_PATH_UNSAFE" });
    });
  });

  it("keeps observer authority nominal across structural, clone and prototype forgeries", async () => {
    await withFixture("m4a-observer-trust", async (value) => {
      const real = observer(value);
      expect(isTrustedOpenCodeCliInvocationObserverV2(real)).toBe(true);
      expect(isTrustedOpenCodeCliInvocationObserverV2({ kind: "OPENCODE_CLI_INVOCATION_OBSERVER", observe: real.observe.bind(real) })).toBe(false);
      expect(isTrustedOpenCodeCliInvocationObserverV2(JSON.parse(JSON.stringify(real)))).toBe(false);
      expect(isTrustedOpenCodeCliInvocationObserverV2(Object.create(Object.getPrototypeOf(real)))).toBe(false);
      expect(() => assertTrustedOpenCodeCliInvocationObserverV2({})).toThrow("M4A_OBSERVER_TRUST_REQUIRED");
    });
  });

  it("replays the full crash-window matrix from fresh stores and observer instances", async () => {
    await withFixture("m4a-fresh-matrix", async (value) => {
      const states: string[] = [];
      states.push((await observer(value).observe(value.authorizedInvocation)).state);
      const descriptorValue = await createProviderInvocationDescriptorV2({ store: value.store, authorizedInvocation: value.authorizedInvocation, executable: MATCHING_EXECUTABLE });
      await persistProviderInvocationDescriptorV2(value.store, descriptorValue, "matrix-descriptor");
      states.push((await observer(value).observe(value.authorizedInvocation)).state);
      const intent = createProviderDispatchIntentV2(descriptorValue, "2026-09-07T12:00:05.000Z");
      await persistProviderDispatchIntentV2(value.store, intent, "matrix-intent");
      states.push((await observer(value).observe(value.authorizedInvocation)).state);
      const worker = createProviderWorkerReceiptV2({ descriptor: descriptorValue, dispatchIntent: intent, processIdentity: WORKER_IDENTITY, processGroupId: 64001, startedAt: "2026-09-07T12:00:06.000Z" });
      await persistProviderWorkerReceiptV2(value.store, worker, "matrix-worker");
      states.push((await observer(value, { process: "MATCH" }).observe(value.authorizedInvocation)).state);
      const session = createProviderSessionBindingV2({ descriptor: descriptorValue, dispatchIntent: intent, workerReceipt: worker, openCodeSessionId: "ses_m4aDedicatedSession0001", boundAt: "2026-09-07T12:00:07.000Z" });
      await persistProviderSessionBindingV2(value.store, session, "matrix-session");
      states.push((await observer(value, { process: "ABSENT", tree: "QUIESCENT", session: sessionObservation() }).observe(value.authorizedInvocation)).state);
      const resultRef = `attempts/${descriptorValue.attemptId}/provider-result.json`;
      const resultDigest = sha256("matrix-result");
      const terminal = createProviderTerminalArtifactV2({ descriptor: descriptorValue, dispatchIntent: intent, workerReceipt: worker, sessionBinding: session, status: "SUCCEEDED", termination: "NORMAL", exitCode: 0, signal: null, timedOut: false, cancelled: false, resultRef, resultDigest, finishedAt: "2026-09-07T12:00:10.000Z", quiescence: { workerProcessState: "ABSENT", processTreeState: "QUIESCENT", observedAt: "2026-09-07T12:00:09.000Z" } });
      await persistProviderTerminalArtifactV2(value.store, terminal, "matrix-terminal");
      states.push((await observer(value, { process: "MATCH", tree: "ACTIVE", session: sessionObservation({ resultIdentity: "MATCH", observedResultRef: resultRef, observedResultDigest: resultDigest }) }).observe(value.authorizedInvocation)).state);
      states.push((await observer(value, { process: "ABSENT", tree: "QUIESCENT", session: sessionObservation({ resultIdentity: "MATCH", observedResultRef: resultRef, observedResultDigest: resultDigest }) }).observe(value.authorizedInvocation)).state);
      expect(states).toEqual(["NOT_INVOKED", "NOT_INVOKED", "UNKNOWN", "RUNNING", "UNKNOWN", "UNKNOWN", "TERMINATED_QUIESCENT"]);
    });
  });
});
