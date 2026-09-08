import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readConformanceRecord, type ConformanceRecord } from "../../providers/conformance/recording.js";
import { canonicalJson } from "../canonical-json.js";
import { sha256Canonical } from "../hashing.js";
import type { RalphEventStoreV2 } from "../operational-b1/index.js";
import { defaultProcessIdentityProvider, type ProcessIdentityProvider } from "../operational-b2/index.js";
import { assertAuthorizedInvocationV2, type AuthorizedInvocationV2 } from "../operational-b3/index.js";
import { fingerprintWorkspace } from "../fingerprint.js";
import {
  ExecutorRuntimeV2,
  ExecutorRuntimeError,
  type CancelRequestReceiptV2,
  type ExecutorInvocationReceiptV2,
} from "./executor-runtime.js";
import type { ExecutorObservationEnvelopeV2 } from "./execution-observation.js";
import {
  createProviderDispatchIntentV2,
  createProviderInvocationDescriptorV2,
  createProviderSessionBindingV2,
  createProviderTerminalArtifactV2,
  createProviderWorkerReceiptV2,
  persistProviderDispatchIntentV2,
  persistProviderInvocationDescriptorV2,
  persistProviderSessionBindingV2,
  persistProviderTerminalArtifactV2,
  persistProviderWorkerReceiptV2,
  readProviderInvocationArtifactSetV2,
  type OpenCodeCliExecutableIdentityInputV2,
  type ProviderDispatchIntentV2,
  type ProviderInvocationDescriptorV2,
  type ProviderSessionBindingV2,
  type ProviderWorkerReceiptV2,
} from "./provider-invocation-artifacts.js";
import { OpenCodeCliInvocationObserverV2 } from "./opencode-cli-observer.js";
import {
  M4B_ERROR_CODES,
  OPENCODE_CLI_EXECUTOR_MODEL_V2,
  OPENCODE_CLI_EXECUTOR_PATH_V2,
  OPENCODE_CLI_EXECUTOR_PROFILE_V2,
  OPENCODE_CLI_EXECUTOR_TRANSPORT_VERSION_V2,
  RalphM4BError,
  validateM4BTimeoutPolicyV2,
  type M4BTimeoutPolicyV2,
} from "./opencode-cli-contract.js";
import { projectWorkUnitToOpenCodePromptV2 } from "./opencode-cli-prompt.js";
import {
  RalphM4CError,
  validateExactCorrectionContextForDispatchV2,
} from "./opencode-cli-correction.js";
import type { CorrectionContextV2 } from "../operational-f/correction-context.js";
import {
  createOpenCodePromptArtifactV2,
  createOpenCodeProviderResultV2,
  openCodePromptRefV2,
  openCodeProviderResultRefV2,
  persistOpenCodePromptArtifactV2,
  persistOpenCodeProviderResultV2,
  readOpenCodePromptArtifactV2,
} from "./opencode-cli-result.js";
import {
  inspectExactOpenCodeCliExecutableV2,
  startOpenCodeCliWorkerV2,
  type OpenCodeCliWorkerV2,
} from "./opencode-cli-process.js";
import {
  OpenCodeCliHttpClientV2,
  readSanitizedExactOpenCodeTurnV2,
  SupportedOpenCodeCliSessionInspectorV2,
  type OpenCodeAssistantResultV2,
} from "./opencode-cli-session-inspector.js";
import { LinuxProviderProcessTreeInspectorV2 } from "./provider-process-tree-inspector.js";

const EXECUTOR_SEAL = Symbol("OpenCodeCliExecutorV2");
const trustedOpenCodeExecutors = new WeakSet<OpenCodeCliExecutorV2>();

interface ActiveInvocationV2 {
  readonly worker: OpenCodeCliWorkerV2;
  readonly client: OpenCodeCliHttpClientV2;
  readonly controller: AbortController;
  readonly session: ProviderSessionBindingV2;
  readonly descriptor: ProviderInvocationDescriptorV2;
  readonly intent: ProviderDispatchIntentV2;
  readonly workerReceipt: ProviderWorkerReceiptV2;
  readonly startedAt: string;
  cancelled: boolean;
  timedOut: boolean;
  settled: boolean;
  settlement?: Awaited<ReturnType<OpenCodeCliWorkerV2["settle"]>>;
}

interface OpenCodeCliExecutorInternalsV2 {
  readonly store: RalphEventStoreV2;
  readonly authorizedInvocation: AuthorizedInvocationV2;
  readonly timeoutPolicy: M4BTimeoutPolicyV2;
  readonly executable: Readonly<OpenCodeCliExecutableIdentityInputV2>;
  readonly processIdentityProvider: ProcessIdentityProvider;
  readonly processTreeInspector: LinuxProviderProcessTreeInspectorV2;
  readonly observer: OpenCodeCliInvocationObserverV2;
  readonly observerRuntimeIdentity: string;
  readonly clock: () => string;
  readonly nonceFactory: () => string;
  readonly active: Map<string, ActiveInvocationV2>;
}

const executorInternals = new WeakMap<OpenCodeCliExecutorV2, OpenCodeCliExecutorInternalsV2>();

export interface CreateOpenCodeCliExecutorV2Input {
  readonly store: RalphEventStoreV2;
  readonly authorizedInvocation: AuthorizedInvocationV2;
  readonly timeoutPolicy: M4BTimeoutPolicyV2;
  readonly clock?: () => string;
  readonly nonceFactory?: () => string;
}

export class OpenCodeCliExecutorV2 extends ExecutorRuntimeV2 {
  readonly kind = "EXECUTOR_RUNTIME" as const;
  readonly runtimeIdentity: string;

  constructor(internals: OpenCodeCliExecutorInternalsV2, seal: symbol) {
    super();
    if (new.target !== OpenCodeCliExecutorV2 || seal !== EXECUTOR_SEAL) throw new ExecutorRuntimeError("B4_EXECUTOR_AUTHORIZATION_REQUIRED", "B4_EXECUTOR_AUTHORIZATION_REQUIRED: genuine OpenCodeCliExecutorV2 required");
    this.runtimeIdentity = internals.observerRuntimeIdentity;
    executorInternals.set(this, internals);
    trustedOpenCodeExecutors.add(this);
    Object.freeze(this);
  }

  async observe(invocationId: string): Promise<ExecutorObservationEnvelopeV2> {
    const internal = requireInternals(this);
    assertExactInvocation(internal, invocationId);
    return internal.observer.observe(internal.authorizedInvocation);
  }

  async invoke(authorizedInvocation: AuthorizedInvocationV2): Promise<ExecutorInvocationReceiptV2> {
    const internal = requireInternals(this);
    assertAuthorizedInvocationV2(authorizedInvocation);
    assertSameAuthorizedInvocation(internal.authorizedInvocation, authorizedInvocation);
    const invocationId = authorizedInvocation.descriptor.invocationId;
    const existing = await readProviderInvocationArtifactSetV2(internal.store, authorizedInvocation.descriptor.attemptId);
    if (existing.dispatchIntent) throw new RalphM4BError("M4B_REDISPATCH_FORBIDDEN");

    const descriptor = await createProviderInvocationDescriptorV2({ store: internal.store, authorizedInvocation, executable: internal.executable });
    // M4-C: a CorrectionContext is admitted only after every binding, digest
    // and Finding is proven against the durable Core authority. An invalid
    // context fails here, before the descriptor becomes durable, so a refused
    // correction leaves no descriptor, no session and no prompt behind.
    const correctionContext = await validateExactCorrectionContextForDispatchV2({ store: internal.store, descriptor });
    if (descriptor.conformanceState !== "MATCH") throw new RalphM4BError("M4B_CONFORMANCE_REQUIRED");
    if (descriptor.executorProfileIdentity !== OPENCODE_CLI_EXECUTOR_PROFILE_V2 || descriptor.modelSelector !== OPENCODE_CLI_EXECUTOR_MODEL_V2) throw new RalphM4BError("M4B_PROFILE_BINDING_INVALID");
    if (authorizedInvocation.workUnit.timeoutPolicyDigest !== internal.timeoutPolicy.policyDigest) throw new RalphM4BError("M4B_TIMEOUT_POLICY_INVALID");

    await persistProviderInvocationDescriptorV2(internal.store, descriptor, internal.nonceFactory());
    const intent = createProviderDispatchIntentV2(descriptor, internal.clock());
    await persistProviderDispatchIntentV2(internal.store, intent, internal.nonceFactory());

    const worker = await startOpenCodeCliWorkerV2({
      projectRoot: internal.store.projectRoot,
      deadlineMs: internal.timeoutPolicy.deadlineMs,
      processIdentityProvider: internal.processIdentityProvider,
      clock: internal.clock,
    });
    const workerReceipt = createProviderWorkerReceiptV2({
      descriptor,
      dispatchIntent: intent,
      processIdentity: worker.processIdentity,
      processGroupId: worker.processGroupId,
      startedAt: worker.startedAt,
    });
    await persistProviderWorkerReceiptV2(internal.store, workerReceipt, internal.nonceFactory());

    let active: ActiveInvocationV2 | undefined;
    try {
      const baseUrl = await worker.startServer();
      const client = new OpenCodeCliHttpClientV2({ baseUrl, projectRoot: internal.store.projectRoot, deadlineMs: internal.timeoutPolicy.deadlineMs });
      if (await client.health() !== OPENCODE_CLI_EXECUTOR_TRANSPORT_VERSION_V2) throw new RalphM4BError("M4B_EXECUTABLE_IDENTITY_INVALID");
      const sessionRecord = await client.createSession({ title: `ralph-${invocationId.slice(0, 48)}` });
      if ((await client.listMessages(sessionRecord.id)).length !== 0) throw new RalphM4BError("M4B_SESSION_BINDING_INVALID");
      const session = createProviderSessionBindingV2({ descriptor, dispatchIntent: intent, workerReceipt, openCodeSessionId: sessionRecord.id, boundAt: internal.clock() });
      await persistProviderSessionBindingV2(internal.store, session, internal.nonceFactory());

      const projected = projectWorkUnitToOpenCodePromptV2(authorizedInvocation.workUnit, correctionContext);
      const promptArtifact = createOpenCodePromptArtifactV2({
        runId: descriptor.runId, phaseId: descriptor.phaseId, taskId: descriptor.taskId, attemptId: descriptor.attemptId, invocationId,
        descriptorDigest: descriptor.descriptorDigest, dispatchIntentDigest: intent.intentDigest, sessionBindingDigest: session.bindingDigest,
        openCodeSessionId: session.openCodeSessionId, openCodeUserMessageId: intent.openCodeUserMessageId,
        modelSelector: descriptor.modelSelector, promptDigest: projected.promptDigest, promptBytes: projected.byteLength, preparedAt: internal.clock(),
      });
      await persistOpenCodePromptArtifactV2(internal.store, promptArtifact, internal.nonceFactory());
      await assertPrePromptDurability(internal.store, descriptor, intent, workerReceipt, session, promptArtifact.artifactDigest, correctionContext);
      const reboundSession = await client.getSession(session.openCodeSessionId);
      if (reboundSession.id !== session.openCodeSessionId || reboundSession.modelSelector !== descriptor.modelSelector) throw new RalphM4BError("M4B_SESSION_BINDING_INVALID");

      const controller = new AbortController();
      active = { worker, client, controller, session, descriptor, intent, workerReceipt, startedAt: internal.clock(), cancelled: false, timedOut: false, settled: false };
      internal.active.set(invocationId, active);
      const timer = setTimeout(() => {
        active!.timedOut = true;
        controller.abort(new Error("M4B_PROVIDER_TIMEOUT"));
      }, internal.timeoutPolicy.deadlineMs);
      let assistant: OpenCodeAssistantResultV2;
      try {
        // This is the sole model-bearing crossing. Every binding above is durable.
        await client.sendPrompt({ sessionId: session.openCodeSessionId, userMessageId: intent.openCodeUserMessageId, prompt: projected.text }, controller.signal);
        assistant = await client.readExactPromptResult({ sessionId: session.openCodeSessionId, userMessageId: intent.openCodeUserMessageId }, controller.signal);
        const sanitizedAssistant = await readSanitizedExactOpenCodeTurnV2({
          projectRoot: internal.store.projectRoot,
          executablePath: internal.executable.executablePath,
          deadlineMs: internal.timeoutPolicy.deadlineMs,
          signal: controller.signal,
        }, { sessionId: session.openCodeSessionId, userMessageId: intent.openCodeUserMessageId });
        if (assistant.observableTurnDigest === null
          || sanitizedAssistant.observableTurnDigest === null
          || assistant.observableTurnDigest !== sanitizedAssistant.observableTurnDigest
          || assistant.sessionId !== sanitizedAssistant.sessionId
          || assistant.userMessageId !== sanitizedAssistant.userMessageId
          || assistant.assistantMessageId !== sanitizedAssistant.assistantMessageId
          || assistant.modelSelector !== sanitizedAssistant.modelSelector
          || assistant.classification !== sanitizedAssistant.classification) {
          throw new RalphM4BError("M4B_PROVIDER_RESULT_INVALID");
        }
      } catch (error) {
        clearTimeout(timer);
        if (active.timedOut || active.cancelled) return await finishInterrupted(internal, active, active.timedOut ? "TIMED_OUT" : "CANCELLED");
        await settleActive(active, "M4-B prompt failed");
        throw error;
      }
      clearTimeout(timer);
      if (assistant.modelSelector !== descriptor.modelSelector) {
        await settleActive(active, "M4-B model mismatch");
        throw new RalphM4BError("M4B_MODEL_MISMATCH");
      }
      const result = createOpenCodeProviderResultV2({
        runId: descriptor.runId, phaseId: descriptor.phaseId, taskId: descriptor.taskId, attemptId: descriptor.attemptId, invocationId,
        descriptorDigest: descriptor.descriptorDigest, dispatchIntentDigest: intent.intentDigest, sessionBindingDigest: session.bindingDigest,
        promptArtifactDigest: promptArtifact.artifactDigest, openCodeSessionId: session.openCodeSessionId, openCodeUserMessageId: intent.openCodeUserMessageId,
        assistantMessageId: assistant.assistantMessageId, observedModelSelector: assistant.modelSelector, classification: assistant.classification,
        assistantContentDigest: assistant.assistantContentDigest, responseDigest: assistant.responseDigest,
        observableTurnDigest: assistant.observableTurnDigest, startedAt: active.startedAt, finishedAt: internal.clock(),
      });
      await persistOpenCodeProviderResultV2(internal.store, result, internal.nonceFactory());
      const settlement = await settleActive(active, "M4-B provider completed");
      await requirePositiveQuiescence(internal, workerReceipt, settlement);
      const terminal = createProviderTerminalArtifactV2({
        descriptor, dispatchIntent: intent, workerReceipt, sessionBinding: session,
        status: assistant.classification, termination: assistant.classification === "SUCCEEDED" ? "NORMAL" : "ERROR",
        exitCode: assistant.classification === "SUCCEEDED" ? 0 : 1, signal: null, timedOut: false, cancelled: false,
        resultRef: openCodeProviderResultRefV2(descriptor.attemptId), resultDigest: result.resultDigest, finishedAt: result.finishedAt,
        quiescence: { workerProcessState: "ABSENT", processTreeState: "QUIESCENT", observedAt: internal.clock() },
      });
      await persistProviderTerminalArtifactV2(internal.store, terminal, internal.nonceFactory());
      return Object.freeze({ invocationId, runtimeIdentity: this.runtimeIdentity, acceptedAt: active.startedAt, physicalStart: "STARTED" });
    } finally {
      internal.active.delete(invocationId);
      if (!active?.settled) await worker.settle("M4-B invocation scope ended").catch(() => undefined);
    }
  }

  async requestCancel(invocationId: string): Promise<CancelRequestReceiptV2> {
    const internal = requireInternals(this);
    assertExactInvocation(internal, invocationId);
    const requestedAt = internal.clock();
    const active = internal.active.get(invocationId);
    if (!active) return Object.freeze({ requestId: `cancel-${randomUUID()}`, invocationId, runtimeIdentity: this.runtimeIdentity, requestedAt, requestState: "UNKNOWN" });
    active.cancelled = true;
    try { await active.client.abort(active.session.openCodeSessionId); } catch { /* abort acceptance is not termination proof */ }
    active.controller.abort(new Error("M4B_PROVIDER_CANCELLED"));
    return Object.freeze({ requestId: `cancel-${randomUUID()}`, invocationId, runtimeIdentity: this.runtimeIdentity, requestedAt, requestState: "ISSUED" });
  }
}

export async function createOpenCodeCliExecutorV2(input: CreateOpenCodeCliExecutorV2Input): Promise<OpenCodeCliExecutorV2> {
  assertAuthorizedInvocationV2(input.authorizedInvocation);
  validateM4BTimeoutPolicyV2(input.timeoutPolicy);
  if (resolve(input.store.projectRoot) !== input.store.projectRoot || input.store.runId !== input.authorizedInvocation.descriptor.runId) throw new RalphM4BError("M4B_WORKSPACE_BINDING_INVALID");
  if (input.authorizedInvocation.descriptor.executorProfileIdentity !== OPENCODE_CLI_EXECUTOR_PROFILE_V2) throw new RalphM4BError("M4B_PROFILE_BINDING_INVALID");
  if (input.authorizedInvocation.workUnit.timeoutPolicyDigest !== input.timeoutPolicy.policyDigest) throw new RalphM4BError("M4B_TIMEOUT_POLICY_INVALID");
  const record = await loadExactConformanceRecordV2();
  const executablePreflight = await inspectExactOpenCodeCliExecutableV2(input.store.projectRoot, input.timeoutPolicy.deadlineMs);
  const executable: OpenCodeCliExecutableIdentityInputV2 = Object.freeze({
    executablePath: executablePreflight.executablePath,
    executableVersion: executablePreflight.executableVersion,
    conformanceProfileId: record.profileId,
    conformanceRecordDigest: sha256Canonical(record),
    conformanceExecutableVersion: record.transportVersion ?? null,
  });
  const descriptor = await createProviderInvocationDescriptorV2({ store: input.store, authorizedInvocation: input.authorizedInvocation, executable });
  if (descriptor.conformanceState !== "MATCH") throw new RalphM4BError("M4B_CONFORMANCE_REQUIRED");
  const processIdentityProvider = defaultProcessIdentityProvider;
  const processTreeInspector = new LinuxProviderProcessTreeInspectorV2();
  const sessionInspector = new SupportedOpenCodeCliSessionInspectorV2({
    store: input.store, projectRoot: input.store.projectRoot, executablePath: OPENCODE_CLI_EXECUTOR_PATH_V2, deadlineMs: input.timeoutPolicy.deadlineMs,
  });
  const observer = new OpenCodeCliInvocationObserverV2({ store: input.store, executable, processIdentityProvider, processTreeInspector, sessionInspector, clock: input.clock });
  const internals: OpenCodeCliExecutorInternalsV2 = {
    store: input.store,
    authorizedInvocation: input.authorizedInvocation,
    timeoutPolicy: Object.freeze({ ...input.timeoutPolicy }),
    executable,
    processIdentityProvider,
    processTreeInspector,
    observer,
    observerRuntimeIdentity: descriptor.runtimeIdentity,
    clock: input.clock ?? (() => new Date().toISOString()),
    nonceFactory: input.nonceFactory ?? randomUUID,
    active: new Map<string, ActiveInvocationV2>(),
  };
  return new OpenCodeCliExecutorV2(internals, EXECUTOR_SEAL);
}

export function isTrustedOpenCodeCliExecutorV2(value: unknown): value is OpenCodeCliExecutorV2 {
  return typeof value === "object" && value !== null && trustedOpenCodeExecutors.has(value as OpenCodeCliExecutorV2);
}

export function assertTrustedOpenCodeCliExecutorV2(value: unknown): asserts value is OpenCodeCliExecutorV2 {
  if (!isTrustedOpenCodeCliExecutorV2(value)) throw new ExecutorRuntimeError("B4_EXECUTOR_AUTHORIZATION_REQUIRED", "B4_EXECUTOR_AUTHORIZATION_REQUIRED: genuine OpenCodeCliExecutorV2 required");
}

export async function loadExactConformanceRecordV2(): Promise<ConformanceRecord> {
  const roots = [
    fileURLToPath(new URL("./records", import.meta.url)),
    fileURLToPath(new URL("../../providers/conformance/records", import.meta.url)),
  ];
  let record: ConformanceRecord | undefined;
  let lastError: unknown;
  for (const root of roots) {
    try { record = await readConformanceRecord(root, OPENCODE_CLI_EXECUTOR_PROFILE_V2); break; }
    catch (error) { lastError = error; }
  }
  if (!record) throw new RalphM4BError("M4B_CONFORMANCE_REQUIRED", undefined, lastError);
  assertExactOpenCodeCliConformanceV2(record);
  return Object.freeze(record);
}

export function assertExactOpenCodeCliConformanceV2(record: ConformanceRecord): void {
  const evidence = record.externalCliEvidence;
  if (record.profileId !== OPENCODE_CLI_EXECUTOR_PROFILE_V2 || record.providerFamily !== "opencode"
    || record.modelId !== OPENCODE_CLI_EXECUTOR_MODEL_V2 || record.transport !== "opencode-cli"
    || record.transportVersion !== OPENCODE_CLI_EXECUTOR_TRANSPORT_VERSION_V2 || record.result.tier !== "SUPPORTED"
    || record.result.cases.length !== 17 || record.result.cases.some((item) => !item.passed)
    || !evidence || evidence.executable !== OPENCODE_CLI_EXECUTOR_PATH_V2 || evidence.transportVersion !== OPENCODE_CLI_EXECUTOR_TRANSPORT_VERSION_V2
    || evidence.requestedModel !== OPENCODE_CLI_EXECUTOR_MODEL_V2 || evidence.invocationPolicy.pluginMode !== "pure"
    || evidence.invocationPolicy.environmentPolicy !== "allowlisted" || evidence.invocationPolicy.transportRetryLimit !== 0
    || evidence.invocations.some((item) => item.observedModelIds.some((model) => model !== OPENCODE_CLI_EXECUTOR_MODEL_V2))) {
    throw new RalphM4BError("M4B_CONFORMANCE_REQUIRED");
  }
}

function requireInternals(value: OpenCodeCliExecutorV2): OpenCodeCliExecutorInternalsV2 {
  if (!isTrustedOpenCodeCliExecutorV2(value)) throw new ExecutorRuntimeError("B4_EXECUTOR_AUTHORIZATION_REQUIRED");
  const internal = executorInternals.get(value);
  if (!internal) throw new ExecutorRuntimeError("B4_EXECUTOR_AUTHORIZATION_REQUIRED");
  return internal;
}

function assertExactInvocation(internal: OpenCodeCliExecutorInternalsV2, invocationId: string): void {
  if (invocationId !== internal.authorizedInvocation.descriptor.invocationId) throw new ExecutorRuntimeError("B4_EXECUTOR_INVOCATION_ID_INVALID");
}

function assertSameAuthorizedInvocation(expected: AuthorizedInvocationV2, actual: AuthorizedInvocationV2): void {
  assertAuthorizedInvocationV2(expected);
  assertAuthorizedInvocationV2(actual);
  if (canonicalJson(expected.descriptor) !== canonicalJson(actual.descriptor)
    || canonicalJson(expected.workUnit) !== canonicalJson(actual.workUnit)) {
    throw new ExecutorRuntimeError("B4_EXECUTOR_AUTHORIZATION_REQUIRED");
  }
}

async function assertPrePromptDurability(
  store: RalphEventStoreV2,
  descriptor: ProviderInvocationDescriptorV2,
  intent: ProviderDispatchIntentV2,
  worker: ProviderWorkerReceiptV2,
  session: ProviderSessionBindingV2,
  promptArtifactDigest: string,
  correctionContext: CorrectionContextV2 | undefined,
): Promise<void> {
  const facts = await readProviderInvocationArtifactSetV2(store, descriptor.attemptId);
  const prompt = await readOpenCodePromptArtifactV2(store, descriptor.attemptId);
  if (facts.descriptor?.descriptorDigest !== descriptor.descriptorDigest || facts.dispatchIntent?.intentDigest !== intent.intentDigest
    || facts.workerReceipt?.receiptDigest !== worker.receiptDigest || facts.sessionBinding?.bindingDigest !== session.bindingDigest
    || prompt?.artifactDigest !== promptArtifactDigest || prompt.openCodeUserMessageId !== intent.openCodeUserMessageId) {
    throw new RalphM4BError("M4B_PROMPT_ORDER_INVALID");
  }
  // M4-C exact revalidation: the correction authority admitted before the
  // descriptor must still be exactly the same durable authority immediately
  // before the single model-bearing crossing.
  const revalidated = await validateExactCorrectionContextForDispatchV2({ store, descriptor });
  if (canonicalJson(revalidated ?? null) !== canonicalJson(correctionContext ?? null)) {
    throw new RalphM4CError("M4C_CORRECTION_CONTEXT_INVALID", "M4C_CORRECTION_CONTEXT_INVALID: correction authority changed before dispatch");
  }
  const snapshot = await store.verifyRunSnapshot();
  const workspace = await fingerprintWorkspace(store.projectRoot, snapshot.workspacePolicy);
  if (workspace.fingerprintDigest !== descriptor.baseWorkspaceFingerprint) throw new RalphM4BError("M4B_WORKSPACE_BINDING_INVALID");
  const conformance = await loadExactConformanceRecordV2();
  if (sha256Canonical(conformance) !== descriptor.conformanceRecordDigest) throw new RalphM4BError("M4B_CONFORMANCE_REQUIRED");
}

async function settleActive(active: ActiveInvocationV2, reason: string) {
  if (active.settlement) return active.settlement;
  active.settled = true;
  active.settlement = await active.worker.settle(reason);
  return active.settlement;
}

async function requirePositiveQuiescence(internal: OpenCodeCliExecutorInternalsV2, worker: ProviderWorkerReceiptV2, settlement: Awaited<ReturnType<OpenCodeCliWorkerV2["settle"]>>): Promise<void> {
  const processState = await internal.processIdentityProvider.inspect(worker.processIdentity);
  const treeState = await internal.processTreeInspector.inspect({ processIdentity: worker.processIdentity, processGroupId: worker.processGroupId });
  if (!settlement.observed || !settlement.quiescent || !settlement.verified || processState !== "ABSENT" || treeState !== "QUIESCENT") throw new RalphM4BError("M4B_PROCESS_TREE_NOT_QUIESCENT");
}

async function finishInterrupted(internal: OpenCodeCliExecutorInternalsV2, active: ActiveInvocationV2, classification: "TIMED_OUT" | "CANCELLED"): Promise<ExecutorInvocationReceiptV2> {
  try { await active.client.abort(active.session.openCodeSessionId); } catch { /* the tree settlement remains separately verified */ }
  const settlement = await settleActive(active, classification === "TIMED_OUT" ? "M4-B timeout" : "M4-B cancellation");
  await requirePositiveQuiescence(internal, active.workerReceipt, settlement);
  const prompt = await readOpenCodePromptArtifactV2(internal.store, active.descriptor.attemptId);
  if (!prompt) throw new RalphM4BError("M4B_PROMPT_ORDER_INVALID");
  const finishedAt = internal.clock();
  const result = createOpenCodeProviderResultV2({
    runId: active.descriptor.runId, phaseId: active.descriptor.phaseId, taskId: active.descriptor.taskId, attemptId: active.descriptor.attemptId, invocationId: active.descriptor.invocationId,
    descriptorDigest: active.descriptor.descriptorDigest, dispatchIntentDigest: active.intent.intentDigest, sessionBindingDigest: active.session.bindingDigest,
    promptArtifactDigest: prompt.artifactDigest, openCodeSessionId: active.session.openCodeSessionId, openCodeUserMessageId: active.intent.openCodeUserMessageId,
    assistantMessageId: null, observedModelSelector: active.descriptor.modelSelector, classification,
    assistantContentDigest: null, responseDigest: sha256Canonical({ classification, invocationId: active.descriptor.invocationId }), observableTurnDigest: null,
    startedAt: active.startedAt, finishedAt,
  });
  await persistOpenCodeProviderResultV2(internal.store, result, internal.nonceFactory());
  const terminal = createProviderTerminalArtifactV2({
    descriptor: active.descriptor, dispatchIntent: active.intent, workerReceipt: active.workerReceipt, sessionBinding: active.session,
    status: classification === "TIMED_OUT" ? "TIMED_OUT" : "CANCELLED", termination: classification === "TIMED_OUT" ? "TIMEOUT" : "CANCELLED",
    exitCode: null, signal: "SIGTERM", timedOut: classification === "TIMED_OUT", cancelled: classification === "CANCELLED",
    resultRef: openCodeProviderResultRefV2(active.descriptor.attemptId), resultDigest: result.resultDigest, finishedAt,
    quiescence: { workerProcessState: "ABSENT", processTreeState: "QUIESCENT", observedAt: internal.clock() },
  });
  await persistProviderTerminalArtifactV2(internal.store, terminal, internal.nonceFactory());
  return Object.freeze({ invocationId: active.descriptor.invocationId, runtimeIdentity: active.descriptor.runtimeIdentity, acceptedAt: active.startedAt, physicalStart: "STARTED" });
}

export { M4B_ERROR_CODES, RalphM4BError };
