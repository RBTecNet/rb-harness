import { resolve } from "node:path";
import { canonicalJson } from "../canonical-json.js";
import { isSha256Digest, sha256Canonical } from "../hashing.js";
import { assertNoCredentialMaterial, RalphCredentialSafetyError } from "../operational-b1/secret-safety.js";
import type { RalphEventStoreV2 } from "../operational-b1/index.js";
import type { ProcessIdentity } from "../operational-b2/index.js";
import {
  assertAuthorizedInvocationV2,
  readInvocationDescriptorV2,
  readWorkUnitV2,
  type AuthorizedInvocationV2,
} from "../operational-b3/index.js";
import {
  correctionContextRefV2,
  readCorrectionContextV2,
} from "../operational-f/correction-context.js";
import {
  EXECUTOR_STATUSES,
  EXECUTOR_TERMINATIONS,
  type ExecutorStatus,
  type ExecutorTermination,
} from "../operational-v2/contracts.js";
import { OPENCODE_CLI_PROFILE_PREFIX } from "../../providers/opencode/profiles.js";
import {
  attemptArtifactRefV2,
  persistImmutableJsonArtifactV2,
  readImmutableJsonArtifactV2,
  type ArtifactPersistenceResultV2,
  RalphB4ArtifactError,
} from "./artifacts.js";

export const RALPH_PROVIDER_INVOCATION_DESCRIPTOR_SCHEMA_V2 = "rb-ralph-provider-invocation-descriptor/v1" as const;
export const RALPH_PROVIDER_DISPATCH_INTENT_SCHEMA_V2 = "rb-ralph-provider-dispatch-intent/v1" as const;
export const RALPH_PROVIDER_WORKER_RECEIPT_SCHEMA_V2 = "rb-ralph-provider-worker-started/v1" as const;
export const RALPH_PROVIDER_SESSION_BINDING_SCHEMA_V2 = "rb-ralph-provider-session-binding/v1" as const;
export const RALPH_PROVIDER_TERMINAL_SCHEMA_V2 = "rb-ralph-provider-terminal/v1" as const;

export const OPENCODE_CLI_CONFORMANCE_STATES_V2 = ["MATCH", "MISMATCH", "MISSING"] as const;
export type OpenCodeCliConformanceStateV2 = typeof OPENCODE_CLI_CONFORMANCE_STATES_V2[number];

export const PROVIDER_TERMINAL_PROCESS_STATES_V2 = ["ABSENT", "QUIESCENCE_UNKNOWN"] as const;
export type ProviderTerminalProcessStateV2 = typeof PROVIDER_TERMINAL_PROCESS_STATES_V2[number];

export const M4A_ERROR_CODES = [
  "M4A_PROVIDER_BINDING_INVALID",
  "M4A_OPENCODE_PROFILE_REQUIRED",
  "M4A_OPENCODE_CONFORMANCE_REQUIRED",
] as const;
export type M4AErrorCode = typeof M4A_ERROR_CODES[number];

export class RalphM4AError extends Error {
  constructor(readonly code: M4AErrorCode, message: string = code, readonly cause?: unknown) {
    super(message);
    this.name = "RalphM4AError";
  }
}

interface ProviderInvocationCoreBindingV2 {
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly invocationId: string;
}

export interface OpenCodeCliExecutableIdentityInputV2 {
  /** Exact absolute executable path observed by the future adapter preflight. */
  readonly executablePath: string;
  /** Exact normalized version reported by that executable. */
  readonly executableVersion: string;
  /** Exact profile identity recorded by the conformance artifact, when one exists. */
  readonly conformanceProfileId: string | null;
  /** Digest of the complete immutable conformance record, when one exists. */
  readonly conformanceRecordDigest: string | null;
  /** Exact OpenCode version recorded by that conformance artifact. */
  readonly conformanceExecutableVersion: string | null;
}

export interface ProviderInvocationDescriptorV2 extends ProviderInvocationCoreBindingV2 {
  readonly schema: typeof RALPH_PROVIDER_INVOCATION_DESCRIPTOR_SCHEMA_V2;
  readonly workUnitId: string;
  readonly workUnitDigest: string;
  readonly executorProfileIdentity: string;
  readonly executorProfileDigest: string;
  readonly transport: "opencode-cli";
  readonly modelSelector: string;
  readonly openCodeExecutablePath: string;
  readonly openCodeExecutableVersion: string;
  readonly openCodeExecutableIdentity: string;
  readonly conformanceProfileId: string | null;
  readonly conformanceRecordDigest: string | null;
  readonly conformanceExecutableVersion: string | null;
  readonly conformanceState: OpenCodeCliConformanceStateV2;
  readonly runtimeIdentity: string;
  readonly projectRootIdentity: string;
  readonly baseWorkspaceFingerprint: string;
  readonly correctionContextRef: string | null;
  readonly correctionContextDigest: string | null;
  readonly createdAt: string;
  readonly descriptorDigest: string;
}

export interface ProviderDispatchIntentV2 extends ProviderInvocationCoreBindingV2 {
  readonly schema: typeof RALPH_PROVIDER_DISPATCH_INTENT_SCHEMA_V2;
  readonly descriptorRef: string;
  readonly descriptorDigest: string;
  readonly dispatchId: string;
  /** Caller-controlled OpenCode message identity is derived by Core, not supplied by a provider. */
  readonly openCodeUserMessageId: string;
  readonly createdAt: string;
  readonly intentDigest: string;
}

export interface ProviderWorkerReceiptV2 extends ProviderInvocationCoreBindingV2 {
  readonly schema: typeof RALPH_PROVIDER_WORKER_RECEIPT_SCHEMA_V2;
  readonly descriptorRef: string;
  readonly descriptorDigest: string;
  readonly dispatchIntentRef: string;
  readonly dispatchIntentDigest: string;
  readonly dispatchId: string;
  readonly processIdentity: ProcessIdentity;
  readonly processGroupId: number | null;
  readonly startedAt: string;
  readonly receiptDigest: string;
}

export interface ProviderSessionBindingV2 extends ProviderInvocationCoreBindingV2 {
  readonly schema: typeof RALPH_PROVIDER_SESSION_BINDING_SCHEMA_V2;
  readonly descriptorRef: string;
  readonly descriptorDigest: string;
  readonly dispatchIntentRef: string;
  readonly dispatchIntentDigest: string;
  readonly workerReceiptRef: string;
  readonly workerReceiptDigest: string;
  readonly openCodeSessionId: string;
  readonly modelSelector: string;
  readonly boundAt: string;
  readonly bindingDigest: string;
}

export interface ProviderTerminalQuiescenceV2 {
  readonly workerProcessState: ProviderTerminalProcessStateV2;
  readonly processTreeState: "QUIESCENT" | "UNKNOWN";
  readonly observedAt: string;
  readonly evidenceDigest: string;
}

export interface ProviderTerminalArtifactV2 extends ProviderInvocationCoreBindingV2 {
  readonly schema: typeof RALPH_PROVIDER_TERMINAL_SCHEMA_V2;
  readonly descriptorRef: string;
  readonly descriptorDigest: string;
  readonly dispatchIntentRef: string;
  readonly dispatchIntentDigest: string;
  readonly workerReceiptRef: string;
  readonly workerReceiptDigest: string;
  readonly sessionBindingRef: string | null;
  readonly sessionBindingDigest: string | null;
  readonly openCodeSessionId: string | null;
  readonly status: ExecutorStatus;
  readonly termination: ExecutorTermination;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly resultRef: string | null;
  readonly resultDigest: string | null;
  readonly finishedAt: string;
  readonly quiescence: ProviderTerminalQuiescenceV2;
  readonly terminalDigest: string;
}

export interface ProviderInvocationArtifactSetV2 {
  readonly descriptor?: ProviderInvocationDescriptorV2;
  readonly dispatchIntent?: ProviderDispatchIntentV2;
  readonly workerReceipt?: ProviderWorkerReceiptV2;
  readonly sessionBinding?: ProviderSessionBindingV2;
  readonly terminal?: ProviderTerminalArtifactV2;
}

const DESCRIPTOR_KEYS = [
  "schema", "runId", "phaseId", "taskId", "attemptId", "invocationId", "workUnitId", "workUnitDigest",
  "executorProfileIdentity", "executorProfileDigest", "transport", "modelSelector", "openCodeExecutablePath",
  "openCodeExecutableVersion", "openCodeExecutableIdentity", "conformanceProfileId", "conformanceRecordDigest",
  "conformanceExecutableVersion", "conformanceState", "runtimeIdentity", "projectRootIdentity", "baseWorkspaceFingerprint",
  "correctionContextRef", "correctionContextDigest", "createdAt", "descriptorDigest",
] as const;
const DISPATCH_KEYS = [
  "schema", "runId", "phaseId", "taskId", "attemptId", "invocationId", "descriptorRef", "descriptorDigest",
  "dispatchId", "openCodeUserMessageId", "createdAt", "intentDigest",
] as const;
const WORKER_KEYS = [
  "schema", "runId", "phaseId", "taskId", "attemptId", "invocationId", "descriptorRef", "descriptorDigest",
  "dispatchIntentRef", "dispatchIntentDigest", "dispatchId", "processIdentity", "processGroupId", "startedAt", "receiptDigest",
] as const;
const SESSION_KEYS = [
  "schema", "runId", "phaseId", "taskId", "attemptId", "invocationId", "descriptorRef", "descriptorDigest",
  "dispatchIntentRef", "dispatchIntentDigest", "workerReceiptRef", "workerReceiptDigest", "openCodeSessionId",
  "modelSelector", "boundAt", "bindingDigest",
] as const;
const TERMINAL_KEYS = [
  "schema", "runId", "phaseId", "taskId", "attemptId", "invocationId", "descriptorRef", "descriptorDigest",
  "dispatchIntentRef", "dispatchIntentDigest", "workerReceiptRef", "workerReceiptDigest", "sessionBindingRef",
  "sessionBindingDigest", "openCodeSessionId", "status", "termination", "exitCode", "signal", "timedOut", "cancelled",
  "resultRef", "resultDigest", "finishedAt", "quiescence", "terminalDigest",
] as const;

export function providerInvocationDescriptorRefV2(attemptId: string): string {
  return attemptArtifactRefV2(attemptId, "provider-invocation-descriptor.json");
}

export function providerDispatchIntentRefV2(attemptId: string): string {
  return attemptArtifactRefV2(attemptId, "provider-dispatch-intent.json");
}

export function providerWorkerReceiptRefV2(attemptId: string): string {
  return attemptArtifactRefV2(attemptId, "provider-worker-started.json");
}

export function providerSessionBindingRefV2(attemptId: string): string {
  return attemptArtifactRefV2(attemptId, "provider-session-binding.json");
}

export function providerTerminalRefV2(attemptId: string): string {
  return attemptArtifactRefV2(attemptId, "provider-terminal.json");
}

/**
 * Derive the provider descriptor only from a sealed B3 invocation, its durable
 * artifacts, the run's project root, and an inspected executable fact. The
 * correction binding is resolved from the Attempt namespace, never supplied
 * by an executor/provider caller.
 */
export async function createProviderInvocationDescriptorV2(input: {
  readonly store: RalphEventStoreV2;
  readonly authorizedInvocation: AuthorizedInvocationV2;
  readonly executable: OpenCodeCliExecutableIdentityInputV2;
}): Promise<ProviderInvocationDescriptorV2> {
  assertAuthorizedInvocationV2(input.authorizedInvocation);
  const core = input.authorizedInvocation.descriptor;
  const workUnit = input.authorizedInvocation.workUnit;
  if (input.store.runId !== core.runId
    || core.runId !== workUnit.runId
    || core.phaseId !== workUnit.phaseId
    || core.taskId !== workUnit.taskId
    || core.attemptId !== workUnit.attemptId
    || core.workUnitId !== workUnit.workUnitId
    || core.workUnitDigest !== workUnit.workUnitDigest
    || core.executorProfileIdentity !== workUnit.executorProfileIdentity
    || core.executorProfileDigest !== workUnit.executorProfileDigest
  ) throw m4a("M4A_PROVIDER_BINDING_INVALID");

  const durableWorkUnit = await readWorkUnitV2(input.store, core.attemptId);
  const durableInvocation = await readInvocationDescriptorV2(input.store, core.attemptId);
  if (!durableWorkUnit || !durableInvocation || canonicalJson(durableWorkUnit) !== canonicalJson(workUnit) || canonicalJson(durableInvocation) !== canonicalJson(core)) {
    throw m4a("M4A_PROVIDER_BINDING_INVALID", "M4A_PROVIDER_BINDING_INVALID: B3 authority is not durable and exact");
  }

  const modelSelector = modelSelectorFromProfile(core.executorProfileIdentity);
  validateExecutableIdentityInput(input.executable);
  const executablePath = resolve(input.executable.executablePath);
  if (executablePath !== input.executable.executablePath) throw m4a("M4A_PROVIDER_BINDING_INVALID", "M4A_PROVIDER_BINDING_INVALID: executable path is not absolute and normalized");

  const context = await readCorrectionContextV2(input.store, core.attemptId);
  if (context && (
    context.runId !== core.runId || context.phaseId !== core.phaseId || context.taskId !== core.taskId
    || context.currentAttemptId !== core.attemptId || context.baseWorkspaceFingerprint !== core.attemptBaseFingerprint
  )) throw m4a("M4A_PROVIDER_BINDING_INVALID", "M4A_PROVIDER_BINDING_INVALID: correction context is foreign");

  const conformanceState = conformanceStateFor(input.executable, core.executorProfileIdentity);
  const openCodeExecutableIdentity = sha256Canonical({
    transport: "opencode-cli",
    executablePath,
    executableVersion: input.executable.executableVersion,
  });
  const runtimeIdentity = `opencode-cli-runtime-${sha256Canonical({
    openCodeExecutableIdentity,
    executorProfileIdentity: core.executorProfileIdentity,
    executorProfileDigest: core.executorProfileDigest,
    modelSelector,
  }).slice("sha256:".length)}`;
  const base = {
    schema: RALPH_PROVIDER_INVOCATION_DESCRIPTOR_SCHEMA_V2,
    runId: core.runId,
    phaseId: core.phaseId,
    taskId: core.taskId,
    attemptId: core.attemptId,
    invocationId: core.invocationId,
    workUnitId: core.workUnitId,
    workUnitDigest: core.workUnitDigest,
    executorProfileIdentity: core.executorProfileIdentity,
    executorProfileDigest: core.executorProfileDigest,
    transport: "opencode-cli" as const,
    modelSelector,
    openCodeExecutablePath: executablePath,
    openCodeExecutableVersion: input.executable.executableVersion,
    openCodeExecutableIdentity,
    conformanceProfileId: input.executable.conformanceProfileId,
    conformanceRecordDigest: input.executable.conformanceRecordDigest,
    conformanceExecutableVersion: input.executable.conformanceExecutableVersion,
    conformanceState,
    runtimeIdentity,
    projectRootIdentity: sha256Canonical({ projectRoot: resolve(input.store.projectRoot) }),
    baseWorkspaceFingerprint: core.attemptBaseFingerprint,
    correctionContextRef: context ? correctionContextRefV2(core.attemptId) : null,
    correctionContextDigest: context?.contextDigest ?? null,
    createdAt: core.createdAt,
  };
  return freezeArtifact({ ...base, descriptorDigest: sha256Canonical(base) }, validateProviderInvocationDescriptorV2);
}

export function createProviderDispatchIntentV2(
  descriptor: ProviderInvocationDescriptorV2,
  createdAt: string,
): ProviderDispatchIntentV2 {
  validateProviderInvocationDescriptorV2(descriptor);
  if (descriptor.conformanceState !== "MATCH") throw m4a("M4A_OPENCODE_CONFORMANCE_REQUIRED");
  assertTimestamp(createdAt);
  const identity = {
    invocationId: descriptor.invocationId,
    descriptorDigest: descriptor.descriptorDigest,
    runtimeIdentity: descriptor.runtimeIdentity,
  };
  const dispatchHash = sha256Canonical(identity).slice("sha256:".length);
  const base = {
    schema: RALPH_PROVIDER_DISPATCH_INTENT_SCHEMA_V2,
    ...coreBinding(descriptor),
    descriptorRef: providerInvocationDescriptorRefV2(descriptor.attemptId),
    descriptorDigest: descriptor.descriptorDigest,
    dispatchId: `dispatch-${dispatchHash}`,
    openCodeUserMessageId: `msg_ralph_${dispatchHash.slice(0, 40)}`,
    createdAt,
  };
  return freezeArtifact({ ...base, intentDigest: sha256Canonical(base) }, validateProviderDispatchIntentV2);
}

export function createProviderWorkerReceiptV2(input: {
  readonly descriptor: ProviderInvocationDescriptorV2;
  readonly dispatchIntent: ProviderDispatchIntentV2;
  readonly processIdentity: ProcessIdentity;
  readonly processGroupId: number | null;
  readonly startedAt: string;
}): ProviderWorkerReceiptV2 {
  validateProviderInvocationDescriptorV2(input.descriptor);
  validateProviderDispatchIntentV2(input.dispatchIntent);
  assertDispatchBinding(input.descriptor, input.dispatchIntent);
  validateProcessIdentity(input.processIdentity);
  if (input.processGroupId !== null && (!Number.isSafeInteger(input.processGroupId) || input.processGroupId < 1)) throw artifact("M4A_WORKER_RECEIPT_INVALID: process group");
  assertTimestamp(input.startedAt);
  const base = {
    schema: RALPH_PROVIDER_WORKER_RECEIPT_SCHEMA_V2,
    ...coreBinding(input.descriptor),
    descriptorRef: providerInvocationDescriptorRefV2(input.descriptor.attemptId),
    descriptorDigest: input.descriptor.descriptorDigest,
    dispatchIntentRef: providerDispatchIntentRefV2(input.descriptor.attemptId),
    dispatchIntentDigest: input.dispatchIntent.intentDigest,
    dispatchId: input.dispatchIntent.dispatchId,
    processIdentity: { ...input.processIdentity },
    processGroupId: input.processGroupId,
    startedAt: input.startedAt,
  };
  return freezeArtifact({ ...base, receiptDigest: sha256Canonical(base) }, validateProviderWorkerReceiptV2);
}

export function createProviderSessionBindingV2(input: {
  readonly descriptor: ProviderInvocationDescriptorV2;
  readonly dispatchIntent: ProviderDispatchIntentV2;
  readonly workerReceipt: ProviderWorkerReceiptV2;
  readonly openCodeSessionId: string;
  readonly boundAt: string;
}): ProviderSessionBindingV2 {
  validateProviderInvocationDescriptorV2(input.descriptor);
  validateProviderDispatchIntentV2(input.dispatchIntent);
  validateProviderWorkerReceiptV2(input.workerReceipt);
  assertWorkerBinding(input.descriptor, input.dispatchIntent, input.workerReceipt);
  assertOpenCodeSessionId(input.openCodeSessionId);
  assertTimestamp(input.boundAt);
  const base = {
    schema: RALPH_PROVIDER_SESSION_BINDING_SCHEMA_V2,
    ...coreBinding(input.descriptor),
    descriptorRef: providerInvocationDescriptorRefV2(input.descriptor.attemptId),
    descriptorDigest: input.descriptor.descriptorDigest,
    dispatchIntentRef: providerDispatchIntentRefV2(input.descriptor.attemptId),
    dispatchIntentDigest: input.dispatchIntent.intentDigest,
    workerReceiptRef: providerWorkerReceiptRefV2(input.descriptor.attemptId),
    workerReceiptDigest: input.workerReceipt.receiptDigest,
    openCodeSessionId: input.openCodeSessionId,
    modelSelector: input.descriptor.modelSelector,
    boundAt: input.boundAt,
  };
  return freezeArtifact({ ...base, bindingDigest: sha256Canonical(base) }, validateProviderSessionBindingV2);
}

export function createProviderTerminalArtifactV2(input: {
  readonly descriptor: ProviderInvocationDescriptorV2;
  readonly dispatchIntent: ProviderDispatchIntentV2;
  readonly workerReceipt: ProviderWorkerReceiptV2;
  readonly sessionBinding: ProviderSessionBindingV2 | null;
  readonly status: ExecutorStatus;
  readonly termination: ExecutorTermination;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly resultRef: string | null;
  readonly resultDigest: string | null;
  readonly finishedAt: string;
  readonly quiescence: Omit<ProviderTerminalQuiescenceV2, "evidenceDigest">;
}): ProviderTerminalArtifactV2 {
  validateProviderInvocationDescriptorV2(input.descriptor);
  validateProviderDispatchIntentV2(input.dispatchIntent);
  validateProviderWorkerReceiptV2(input.workerReceipt);
  assertWorkerBinding(input.descriptor, input.dispatchIntent, input.workerReceipt);
  if (input.sessionBinding) {
    validateProviderSessionBindingV2(input.sessionBinding);
    assertSessionBinding(input.descriptor, input.dispatchIntent, input.workerReceipt, input.sessionBinding);
  }
  if (!EXECUTOR_STATUSES.includes(input.status) || !EXECUTOR_TERMINATIONS.includes(input.termination)) throw artifact("M4A_TERMINAL_INVALID: termination");
  assertExitAndSignal(input.exitCode, input.signal);
  if (typeof input.timedOut !== "boolean" || typeof input.cancelled !== "boolean") throw artifact("M4A_TERMINAL_INVALID: flags");
  assertTimestamp(input.finishedAt);
  const resultPair = input.resultRef !== null && input.resultDigest !== null;
  if ((input.resultRef === null) !== (input.resultDigest === null)) throw artifact("M4A_TERMINAL_INVALID: partial result binding");
  if (resultPair) {
    assertAttemptRef(input.resultRef!, input.descriptor.attemptId);
    assertDigest(input.resultDigest);
  }
  validateTerminalQuiescenceInput(input.quiescence);
  const quiescenceBase = { ...input.quiescence };
  const quiescence = { ...quiescenceBase, evidenceDigest: sha256Canonical(quiescenceBase) };
  const base = {
    schema: RALPH_PROVIDER_TERMINAL_SCHEMA_V2,
    ...coreBinding(input.descriptor),
    descriptorRef: providerInvocationDescriptorRefV2(input.descriptor.attemptId),
    descriptorDigest: input.descriptor.descriptorDigest,
    dispatchIntentRef: providerDispatchIntentRefV2(input.descriptor.attemptId),
    dispatchIntentDigest: input.dispatchIntent.intentDigest,
    workerReceiptRef: providerWorkerReceiptRefV2(input.descriptor.attemptId),
    workerReceiptDigest: input.workerReceipt.receiptDigest,
    sessionBindingRef: input.sessionBinding ? providerSessionBindingRefV2(input.descriptor.attemptId) : null,
    sessionBindingDigest: input.sessionBinding?.bindingDigest ?? null,
    openCodeSessionId: input.sessionBinding?.openCodeSessionId ?? null,
    status: input.status,
    termination: input.termination,
    exitCode: input.exitCode,
    signal: input.signal,
    timedOut: input.timedOut,
    cancelled: input.cancelled,
    resultRef: input.resultRef,
    resultDigest: input.resultDigest,
    finishedAt: input.finishedAt,
    quiescence,
  };
  return freezeArtifact({ ...base, terminalDigest: sha256Canonical(base) }, validateProviderTerminalArtifactV2);
}

export function validateProviderInvocationDescriptorV2(value: unknown): asserts value is ProviderInvocationDescriptorV2 {
  const record = requireRecord(value, "M4A_DESCRIPTOR_INVALID");
  assertExactKeys(record, DESCRIPTOR_KEYS, "M4A_DESCRIPTOR_INVALID");
  if (record.schema !== RALPH_PROVIDER_INVOCATION_DESCRIPTOR_SCHEMA_V2 || record.transport !== "opencode-cli") throw artifact("M4A_DESCRIPTOR_INVALID: schema");
  validateCoreBinding(record);
  for (const key of ["workUnitId", "executorProfileIdentity", "modelSelector", "openCodeExecutableVersion", "runtimeIdentity", "createdAt"] as const) assertSafeText(record[key], key === "modelSelector" || key === "executorProfileIdentity");
  if (typeof record.workUnitId !== "string" || !/^wu-[0-9a-f]{64}$/.test(record.workUnitId)) throw artifact("M4A_DESCRIPTOR_INVALID: WorkUnit id");
  for (const key of ["workUnitDigest", "executorProfileDigest", "openCodeExecutableIdentity", "projectRootIdentity", "baseWorkspaceFingerprint", "descriptorDigest"] as const) assertDigest(record[key]);
  if (typeof record.openCodeExecutablePath !== "string" || record.openCodeExecutablePath.length === 0 || record.openCodeExecutablePath.length > 4096 || record.openCodeExecutablePath.includes("\0") || resolve(record.openCodeExecutablePath) !== record.openCodeExecutablePath) throw artifact("M4A_DESCRIPTOR_INVALID: executable path");
  if (!/^opencode:cli:[A-Za-z0-9][A-Za-z0-9._+-]*\/[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(String(record.executorProfileIdentity))) throw artifact("M4A_DESCRIPTOR_INVALID: profile");
  if (record.modelSelector !== String(record.executorProfileIdentity).slice(OPENCODE_CLI_PROFILE_PREFIX.length)) throw artifact("M4A_DESCRIPTOR_INVALID: model binding");
  if (!OPENCODE_CLI_CONFORMANCE_STATES_V2.includes(record.conformanceState as OpenCodeCliConformanceStateV2)) throw artifact("M4A_DESCRIPTOR_INVALID: conformance");
  validateNullableString(record.conformanceProfileId, true);
  validateNullableDigest(record.conformanceRecordDigest);
  validateNullableString(record.conformanceExecutableVersion, false);
  const conformanceAll = record.conformanceProfileId !== null && record.conformanceRecordDigest !== null && record.conformanceExecutableVersion !== null;
  const conformanceNone = record.conformanceProfileId === null && record.conformanceRecordDigest === null && record.conformanceExecutableVersion === null;
  if (!conformanceAll && !conformanceNone) throw artifact("M4A_DESCRIPTOR_INVALID: partial conformance");
  const expectedConformance = conformanceNone ? "MISSING" : record.conformanceProfileId === record.executorProfileIdentity && record.conformanceExecutableVersion === record.openCodeExecutableVersion ? "MATCH" : "MISMATCH";
  if (record.conformanceState !== expectedConformance) throw artifact("M4A_DESCRIPTOR_INVALID: conformance state");
  validateNullableAttemptRef(record.correctionContextRef, String(record.attemptId));
  validateNullableDigest(record.correctionContextDigest);
  if ((record.correctionContextRef === null) !== (record.correctionContextDigest === null)) throw artifact("M4A_DESCRIPTOR_INVALID: partial correction binding");
  const expectedExecutableIdentity = sha256Canonical({ transport: "opencode-cli", executablePath: record.openCodeExecutablePath, executableVersion: record.openCodeExecutableVersion });
  if (record.openCodeExecutableIdentity !== expectedExecutableIdentity) throw artifact("M4A_DESCRIPTOR_INVALID: executable identity");
  const expectedRuntimeIdentity = `opencode-cli-runtime-${sha256Canonical({ openCodeExecutableIdentity: record.openCodeExecutableIdentity, executorProfileIdentity: record.executorProfileIdentity, executorProfileDigest: record.executorProfileDigest, modelSelector: record.modelSelector }).slice("sha256:".length)}`;
  if (record.runtimeIdentity !== expectedRuntimeIdentity) throw artifact("M4A_DESCRIPTOR_INVALID: runtime identity");
  assertTimestamp(record.createdAt);
  assertOwnDigest(record, "descriptorDigest");
  assertArtifactSecurity(record);
}

export function validateProviderDispatchIntentV2(value: unknown): asserts value is ProviderDispatchIntentV2 {
  const record = requireRecord(value, "M4A_DISPATCH_INTENT_INVALID");
  assertExactKeys(record, DISPATCH_KEYS, "M4A_DISPATCH_INTENT_INVALID");
  if (record.schema !== RALPH_PROVIDER_DISPATCH_INTENT_SCHEMA_V2) throw artifact("M4A_DISPATCH_INTENT_INVALID: schema");
  validateCoreBinding(record);
  assertAttemptRef(record.descriptorRef, String(record.attemptId));
  if (record.descriptorRef !== providerInvocationDescriptorRefV2(String(record.attemptId))) throw artifact("M4A_DISPATCH_INTENT_INVALID: descriptor ref");
  assertDigest(record.descriptorDigest);
  if (typeof record.dispatchId !== "string" || !/^dispatch-[0-9a-f]{64}$/.test(record.dispatchId)) throw artifact("M4A_DISPATCH_INTENT_INVALID: dispatch id");
  if (typeof record.openCodeUserMessageId !== "string" || !/^msg_ralph_[0-9a-f]{40}$/.test(record.openCodeUserMessageId)) throw artifact("M4A_DISPATCH_INTENT_INVALID: message id");
  assertTimestamp(record.createdAt);
  assertOwnDigest(record, "intentDigest");
  assertArtifactSecurity(record);
}

export function validateProviderWorkerReceiptV2(value: unknown): asserts value is ProviderWorkerReceiptV2 {
  const record = requireRecord(value, "M4A_WORKER_RECEIPT_INVALID");
  assertExactKeys(record, WORKER_KEYS, "M4A_WORKER_RECEIPT_INVALID");
  if (record.schema !== RALPH_PROVIDER_WORKER_RECEIPT_SCHEMA_V2) throw artifact("M4A_WORKER_RECEIPT_INVALID: schema");
  validateCoreBinding(record);
  assertExactChainRefs(record, "worker");
  assertDigest(record.descriptorDigest);
  assertDigest(record.dispatchIntentDigest);
  if (typeof record.dispatchId !== "string" || !/^dispatch-[0-9a-f]{64}$/.test(record.dispatchId)) throw artifact("M4A_WORKER_RECEIPT_INVALID: dispatch");
  validateProcessIdentity(record.processIdentity);
  if (record.processGroupId !== null && (!Number.isSafeInteger(record.processGroupId) || (record.processGroupId as number) < 1)) throw artifact("M4A_WORKER_RECEIPT_INVALID: process group");
  assertTimestamp(record.startedAt);
  assertOwnDigest(record, "receiptDigest");
  assertArtifactSecurity(record);
}

export function validateProviderSessionBindingV2(value: unknown): asserts value is ProviderSessionBindingV2 {
  const record = requireRecord(value, "M4A_SESSION_BINDING_INVALID");
  assertExactKeys(record, SESSION_KEYS, "M4A_SESSION_BINDING_INVALID");
  if (record.schema !== RALPH_PROVIDER_SESSION_BINDING_SCHEMA_V2) throw artifact("M4A_SESSION_BINDING_INVALID: schema");
  validateCoreBinding(record);
  assertExactChainRefs(record, "session");
  for (const key of ["descriptorDigest", "dispatchIntentDigest", "workerReceiptDigest"] as const) assertDigest(record[key]);
  assertOpenCodeSessionId(record.openCodeSessionId);
  assertSafeText(record.modelSelector, true);
  assertTimestamp(record.boundAt);
  assertOwnDigest(record, "bindingDigest");
  assertArtifactSecurity(record);
}

export function validateProviderTerminalArtifactV2(value: unknown): asserts value is ProviderTerminalArtifactV2 {
  const record = requireRecord(value, "M4A_TERMINAL_INVALID");
  assertExactKeys(record, TERMINAL_KEYS, "M4A_TERMINAL_INVALID");
  if (record.schema !== RALPH_PROVIDER_TERMINAL_SCHEMA_V2) throw artifact("M4A_TERMINAL_INVALID: schema");
  validateCoreBinding(record);
  assertExactChainRefs(record, "terminal");
  for (const key of ["descriptorDigest", "dispatchIntentDigest", "workerReceiptDigest"] as const) assertDigest(record[key]);
  validateNullableAttemptRef(record.sessionBindingRef, String(record.attemptId));
  validateNullableDigest(record.sessionBindingDigest);
  validateNullableString(record.openCodeSessionId, false);
  const sessionAll = record.sessionBindingRef !== null && record.sessionBindingDigest !== null && record.openCodeSessionId !== null;
  const sessionNone = record.sessionBindingRef === null && record.sessionBindingDigest === null && record.openCodeSessionId === null;
  if (!sessionAll && !sessionNone) throw artifact("M4A_TERMINAL_INVALID: partial session binding");
  if (sessionAll && record.sessionBindingRef !== providerSessionBindingRefV2(String(record.attemptId))) throw artifact("M4A_TERMINAL_INVALID: session ref");
  if (sessionAll) assertOpenCodeSessionId(record.openCodeSessionId);
  if (!EXECUTOR_STATUSES.includes(record.status as ExecutorStatus) || !EXECUTOR_TERMINATIONS.includes(record.termination as ExecutorTermination)) throw artifact("M4A_TERMINAL_INVALID: termination");
  assertExitAndSignal(record.exitCode as number | null, record.signal as string | null);
  if (typeof record.timedOut !== "boolean" || typeof record.cancelled !== "boolean") throw artifact("M4A_TERMINAL_INVALID: flags");
  validateNullableAttemptRef(record.resultRef, String(record.attemptId));
  validateNullableDigest(record.resultDigest);
  if ((record.resultRef === null) !== (record.resultDigest === null)) throw artifact("M4A_TERMINAL_INVALID: partial result binding");
  assertTimestamp(record.finishedAt);
  validateTerminalQuiescence(record.quiescence);
  assertOwnDigest(record, "terminalDigest");
  assertArtifactSecurity(record);
}

export async function persistProviderInvocationDescriptorV2(store: RalphEventStoreV2, value: ProviderInvocationDescriptorV2, nonce: string): Promise<ArtifactPersistenceResultV2<ProviderInvocationDescriptorV2>> {
  validateProviderInvocationDescriptorV2(value);
  assertStoreBinding(store, value);
  const durableWorkUnit = await readWorkUnitV2(store, value.attemptId);
  const durableInvocation = await readInvocationDescriptorV2(store, value.attemptId);
  if (!durableWorkUnit || !durableInvocation
    || durableWorkUnit.runId !== value.runId
    || durableWorkUnit.phaseId !== value.phaseId
    || durableWorkUnit.taskId !== value.taskId
    || durableWorkUnit.attemptId !== value.attemptId
    || durableWorkUnit.workUnitId !== value.workUnitId
    || durableWorkUnit.workUnitDigest !== value.workUnitDigest
    || durableWorkUnit.executorProfileIdentity !== value.executorProfileIdentity
    || durableWorkUnit.executorProfileDigest !== value.executorProfileDigest
    || durableInvocation.runId !== value.runId
    || durableInvocation.phaseId !== value.phaseId
    || durableInvocation.taskId !== value.taskId
    || durableInvocation.attemptId !== value.attemptId
    || durableInvocation.invocationId !== value.invocationId
    || durableInvocation.executorProfileIdentity !== value.executorProfileIdentity
    || durableInvocation.executorProfileDigest !== value.executorProfileDigest
    || durableInvocation.attemptBaseFingerprint !== value.baseWorkspaceFingerprint
    || value.projectRootIdentity !== sha256Canonical({ projectRoot: resolve(store.projectRoot) })
  ) throw m4a("M4A_PROVIDER_BINDING_INVALID");
  if (value.correctionContextRef !== null) {
    const context = await readCorrectionContextV2(store, value.attemptId);
    if (!context || context.contextDigest !== value.correctionContextDigest || correctionContextRefV2(value.attemptId) !== value.correctionContextRef) throw m4a("M4A_PROVIDER_BINDING_INVALID");
  }
  return persistImmutableJsonArtifactV2({ store, ref: providerInvocationDescriptorRefV2(value.attemptId), artifact: value, validate: validateProviderInvocationDescriptorV2, nonce });
}

export async function persistProviderDispatchIntentV2(store: RalphEventStoreV2, value: ProviderDispatchIntentV2, nonce: string): Promise<ArtifactPersistenceResultV2<ProviderDispatchIntentV2>> {
  validateProviderDispatchIntentV2(value);
  const descriptor = await requireDescriptor(store, value.attemptId);
  assertDispatchBinding(descriptor, value);
  if (descriptor.conformanceState !== "MATCH") throw m4a("M4A_OPENCODE_CONFORMANCE_REQUIRED");
  return persistImmutableJsonArtifactV2({ store, ref: providerDispatchIntentRefV2(value.attemptId), artifact: value, validate: validateProviderDispatchIntentV2, nonce });
}

export async function persistProviderWorkerReceiptV2(store: RalphEventStoreV2, value: ProviderWorkerReceiptV2, nonce: string): Promise<ArtifactPersistenceResultV2<ProviderWorkerReceiptV2>> {
  validateProviderWorkerReceiptV2(value);
  const descriptor = await requireDescriptor(store, value.attemptId);
  const intent = await requireDispatchIntent(store, value.attemptId);
  assertWorkerBinding(descriptor, intent, value);
  return persistImmutableJsonArtifactV2({ store, ref: providerWorkerReceiptRefV2(value.attemptId), artifact: value, validate: validateProviderWorkerReceiptV2, nonce });
}

export async function persistProviderSessionBindingV2(store: RalphEventStoreV2, value: ProviderSessionBindingV2, nonce: string): Promise<ArtifactPersistenceResultV2<ProviderSessionBindingV2>> {
  validateProviderSessionBindingV2(value);
  const descriptor = await requireDescriptor(store, value.attemptId);
  const intent = await requireDispatchIntent(store, value.attemptId);
  const worker = await requireWorkerReceipt(store, value.attemptId);
  assertSessionBinding(descriptor, intent, worker, value);
  return persistImmutableJsonArtifactV2({ store, ref: providerSessionBindingRefV2(value.attemptId), artifact: value, validate: validateProviderSessionBindingV2, nonce });
}

export async function persistProviderTerminalArtifactV2(store: RalphEventStoreV2, value: ProviderTerminalArtifactV2, nonce: string): Promise<ArtifactPersistenceResultV2<ProviderTerminalArtifactV2>> {
  validateProviderTerminalArtifactV2(value);
  const descriptor = await requireDescriptor(store, value.attemptId);
  const intent = await requireDispatchIntent(store, value.attemptId);
  const worker = await requireWorkerReceipt(store, value.attemptId);
  const session = value.sessionBindingRef === null ? null : await requireSessionBinding(store, value.attemptId);
  assertTerminalBinding(descriptor, intent, worker, session, value);
  return persistImmutableJsonArtifactV2({ store, ref: providerTerminalRefV2(value.attemptId), artifact: value, validate: validateProviderTerminalArtifactV2, nonce });
}

export async function readProviderInvocationDescriptorV2(store: RalphEventStoreV2, attemptId: string): Promise<ProviderInvocationDescriptorV2 | undefined> {
  return readImmutableJsonArtifactV2({ store, ref: providerInvocationDescriptorRefV2(attemptId), validate: validateProviderInvocationDescriptorV2 });
}
export async function readProviderDispatchIntentV2(store: RalphEventStoreV2, attemptId: string): Promise<ProviderDispatchIntentV2 | undefined> {
  return readImmutableJsonArtifactV2({ store, ref: providerDispatchIntentRefV2(attemptId), validate: validateProviderDispatchIntentV2 });
}
export async function readProviderWorkerReceiptV2(store: RalphEventStoreV2, attemptId: string): Promise<ProviderWorkerReceiptV2 | undefined> {
  return readImmutableJsonArtifactV2({ store, ref: providerWorkerReceiptRefV2(attemptId), validate: validateProviderWorkerReceiptV2 });
}
export async function readProviderSessionBindingV2(store: RalphEventStoreV2, attemptId: string): Promise<ProviderSessionBindingV2 | undefined> {
  return readImmutableJsonArtifactV2({ store, ref: providerSessionBindingRefV2(attemptId), validate: validateProviderSessionBindingV2 });
}
export async function readProviderTerminalArtifactV2(store: RalphEventStoreV2, attemptId: string): Promise<ProviderTerminalArtifactV2 | undefined> {
  return readImmutableJsonArtifactV2({ store, ref: providerTerminalRefV2(attemptId), validate: validateProviderTerminalArtifactV2 });
}

export async function readProviderInvocationArtifactSetV2(store: RalphEventStoreV2, attemptId: string): Promise<ProviderInvocationArtifactSetV2> {
  const descriptor = await readProviderInvocationDescriptorV2(store, attemptId);
  const dispatchIntent = await readProviderDispatchIntentV2(store, attemptId);
  const workerReceipt = await readProviderWorkerReceiptV2(store, attemptId);
  const sessionBinding = await readProviderSessionBindingV2(store, attemptId);
  const terminal = await readProviderTerminalArtifactV2(store, attemptId);
  if (!descriptor) {
    if (dispatchIntent || workerReceipt || sessionBinding || terminal) throw m4a("M4A_PROVIDER_BINDING_INVALID", "M4A_PROVIDER_BINDING_INVALID: orphan provider artifact");
    return {};
  }
  assertStoreBinding(store, descriptor);
  if (dispatchIntent) assertDispatchBinding(descriptor, dispatchIntent);
  if (workerReceipt) {
    if (!dispatchIntent) throw m4a("M4A_PROVIDER_BINDING_INVALID", "M4A_PROVIDER_BINDING_INVALID: worker without dispatch intent");
    assertWorkerBinding(descriptor, dispatchIntent, workerReceipt);
  }
  if (sessionBinding) {
    if (!dispatchIntent || !workerReceipt) throw m4a("M4A_PROVIDER_BINDING_INVALID", "M4A_PROVIDER_BINDING_INVALID: session without worker");
    assertSessionBinding(descriptor, dispatchIntent, workerReceipt, sessionBinding);
  }
  if (terminal) {
    if (!dispatchIntent || !workerReceipt) throw m4a("M4A_PROVIDER_BINDING_INVALID", "M4A_PROVIDER_BINDING_INVALID: terminal without worker");
    assertTerminalBinding(descriptor, dispatchIntent, workerReceipt, sessionBinding ?? null, terminal);
  }
  return { descriptor, ...(dispatchIntent ? { dispatchIntent } : {}), ...(workerReceipt ? { workerReceipt } : {}), ...(sessionBinding ? { sessionBinding } : {}), ...(terminal ? { terminal } : {}) };
}

function modelSelectorFromProfile(profileIdentity: string): string {
  if (!profileIdentity.startsWith(OPENCODE_CLI_PROFILE_PREFIX)) throw m4a("M4A_OPENCODE_PROFILE_REQUIRED");
  const selector = profileIdentity.slice(OPENCODE_CLI_PROFILE_PREFIX.length);
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*\/[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(selector)) throw m4a("M4A_OPENCODE_PROFILE_REQUIRED");
  return selector;
}

function conformanceStateFor(input: OpenCodeCliExecutableIdentityInputV2, profileIdentity: string): OpenCodeCliConformanceStateV2 {
  const allNull = input.conformanceProfileId === null && input.conformanceRecordDigest === null && input.conformanceExecutableVersion === null;
  if (allNull) return "MISSING";
  return input.conformanceProfileId === profileIdentity && input.conformanceExecutableVersion === input.executableVersion ? "MATCH" : "MISMATCH";
}

function validateExecutableIdentityInput(input: OpenCodeCliExecutableIdentityInputV2): void {
  if (!input || typeof input !== "object") throw m4a("M4A_PROVIDER_BINDING_INVALID");
  if (typeof input.executablePath !== "string" || input.executablePath.length === 0 || input.executablePath.length > 4096 || input.executablePath.includes("\0")) throw m4a("M4A_PROVIDER_BINDING_INVALID");
  assertSafeText(input.executableVersion, false);
  validateNullableString(input.conformanceProfileId, true);
  validateNullableDigest(input.conformanceRecordDigest);
  validateNullableString(input.conformanceExecutableVersion, false);
  const all = input.conformanceProfileId !== null && input.conformanceRecordDigest !== null && input.conformanceExecutableVersion !== null;
  const none = input.conformanceProfileId === null && input.conformanceRecordDigest === null && input.conformanceExecutableVersion === null;
  if (!all && !none) throw m4a("M4A_PROVIDER_BINDING_INVALID", "M4A_PROVIDER_BINDING_INVALID: partial conformance identity");
}

function validateCoreBinding(record: Record<string, unknown>): void {
  for (const key of ["runId", "phaseId", "taskId", "attemptId", "invocationId"] as const) assertSafeText(record[key], false);
  if (typeof record.invocationId !== "string" || !/^inv-[0-9a-f]{64}$/.test(record.invocationId)) throw artifact("M4A_PROVIDER_BINDING_INVALID: invocation id");
}

function validateProcessIdentity(value: unknown): asserts value is ProcessIdentity {
  const record = requireRecord(value, "M4A_PROCESS_IDENTITY_INVALID");
  assertExactKeys(record, ["pid", "processStartIdentity", "hostIdentity", "bootSessionIdentity"], "M4A_PROCESS_IDENTITY_INVALID");
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) < 1) throw artifact("M4A_PROCESS_IDENTITY_INVALID: pid");
  for (const key of ["processStartIdentity", "hostIdentity", "bootSessionIdentity"] as const) assertSafeText(record[key], false);
}

function validateTerminalQuiescence(value: unknown): asserts value is ProviderTerminalQuiescenceV2 {
  const record = requireRecord(value, "M4A_TERMINAL_INVALID");
  assertExactKeys(record, ["workerProcessState", "processTreeState", "observedAt", "evidenceDigest"], "M4A_TERMINAL_INVALID");
  validateTerminalQuiescenceInput(record as unknown as Omit<ProviderTerminalQuiescenceV2, "evidenceDigest">);
  assertDigest(record.evidenceDigest);
  const { evidenceDigest: _ignored, ...base } = record;
  if (sha256Canonical(base) !== record.evidenceDigest) throw artifact("M4A_TERMINAL_INVALID: quiescence digest");
}

function validateTerminalQuiescenceInput(value: Omit<ProviderTerminalQuiescenceV2, "evidenceDigest">): void {
  if (!PROVIDER_TERMINAL_PROCESS_STATES_V2.includes(value.workerProcessState) || !["QUIESCENT", "UNKNOWN"].includes(value.processTreeState)) throw artifact("M4A_TERMINAL_INVALID: quiescence");
  if ((value.workerProcessState === "ABSENT") !== (value.processTreeState === "QUIESCENT")) throw artifact("M4A_TERMINAL_INVALID: inconsistent quiescence");
  assertTimestamp(value.observedAt);
}

function assertDispatchBinding(descriptor: ProviderInvocationDescriptorV2, intent: ProviderDispatchIntentV2): void {
  if (!sameCoreBinding(descriptor, intent) || intent.descriptorRef !== providerInvocationDescriptorRefV2(descriptor.attemptId) || intent.descriptorDigest !== descriptor.descriptorDigest) throw m4a("M4A_PROVIDER_BINDING_INVALID");
  const hash = sha256Canonical({ invocationId: descriptor.invocationId, descriptorDigest: descriptor.descriptorDigest, runtimeIdentity: descriptor.runtimeIdentity }).slice("sha256:".length);
  if (intent.dispatchId !== `dispatch-${hash}` || intent.openCodeUserMessageId !== `msg_ralph_${hash.slice(0, 40)}`) throw m4a("M4A_PROVIDER_BINDING_INVALID");
}

function assertWorkerBinding(descriptor: ProviderInvocationDescriptorV2, intent: ProviderDispatchIntentV2, worker: ProviderWorkerReceiptV2): void {
  assertDispatchBinding(descriptor, intent);
  if (!sameCoreBinding(descriptor, worker) || worker.descriptorDigest !== descriptor.descriptorDigest || worker.dispatchIntentDigest !== intent.intentDigest || worker.dispatchId !== intent.dispatchId) throw m4a("M4A_PROVIDER_BINDING_INVALID");
}

function assertSessionBinding(descriptor: ProviderInvocationDescriptorV2, intent: ProviderDispatchIntentV2, worker: ProviderWorkerReceiptV2, session: ProviderSessionBindingV2): void {
  assertWorkerBinding(descriptor, intent, worker);
  if (!sameCoreBinding(descriptor, session) || session.descriptorDigest !== descriptor.descriptorDigest || session.dispatchIntentDigest !== intent.intentDigest || session.workerReceiptDigest !== worker.receiptDigest || session.modelSelector !== descriptor.modelSelector) throw m4a("M4A_PROVIDER_BINDING_INVALID");
}

function assertTerminalBinding(descriptor: ProviderInvocationDescriptorV2, intent: ProviderDispatchIntentV2, worker: ProviderWorkerReceiptV2, session: ProviderSessionBindingV2 | null, terminal: ProviderTerminalArtifactV2): void {
  assertWorkerBinding(descriptor, intent, worker);
  if (!sameCoreBinding(descriptor, terminal) || terminal.descriptorDigest !== descriptor.descriptorDigest || terminal.dispatchIntentDigest !== intent.intentDigest || terminal.workerReceiptDigest !== worker.receiptDigest) throw m4a("M4A_PROVIDER_BINDING_INVALID");
  if (session === null) {
    if (terminal.sessionBindingRef !== null || terminal.sessionBindingDigest !== null || terminal.openCodeSessionId !== null) throw m4a("M4A_PROVIDER_BINDING_INVALID");
  } else {
    assertSessionBinding(descriptor, intent, worker, session);
    if (terminal.sessionBindingDigest !== session.bindingDigest || terminal.openCodeSessionId !== session.openCodeSessionId) throw m4a("M4A_PROVIDER_BINDING_INVALID");
  }
}

function assertExactChainRefs(record: Record<string, unknown>, kind: "worker" | "session" | "terminal"): void {
  const attemptId = String(record.attemptId);
  if (record.descriptorRef !== providerInvocationDescriptorRefV2(attemptId) || record.dispatchIntentRef !== providerDispatchIntentRefV2(attemptId)) throw artifact("M4A_PROVIDER_BINDING_INVALID: chain ref");
  if ((kind === "session" || kind === "terminal") && record.workerReceiptRef !== providerWorkerReceiptRefV2(attemptId)) throw artifact("M4A_PROVIDER_BINDING_INVALID: worker ref");
}

function assertStoreBinding(store: RalphEventStoreV2, value: ProviderInvocationCoreBindingV2): void {
  if (store.runId !== value.runId) throw m4a("M4A_PROVIDER_BINDING_INVALID");
}

async function requireDescriptor(store: RalphEventStoreV2, attemptId: string): Promise<ProviderInvocationDescriptorV2> {
  const value = await readProviderInvocationDescriptorV2(store, attemptId);
  if (!value) throw m4a("M4A_PROVIDER_BINDING_INVALID", "M4A_PROVIDER_BINDING_INVALID: descriptor missing");
  assertStoreBinding(store, value);
  return value;
}
async function requireDispatchIntent(store: RalphEventStoreV2, attemptId: string): Promise<ProviderDispatchIntentV2> {
  const value = await readProviderDispatchIntentV2(store, attemptId);
  if (!value) throw m4a("M4A_PROVIDER_BINDING_INVALID", "M4A_PROVIDER_BINDING_INVALID: dispatch intent missing");
  return value;
}
async function requireWorkerReceipt(store: RalphEventStoreV2, attemptId: string): Promise<ProviderWorkerReceiptV2> {
  const value = await readProviderWorkerReceiptV2(store, attemptId);
  if (!value) throw m4a("M4A_PROVIDER_BINDING_INVALID", "M4A_PROVIDER_BINDING_INVALID: worker receipt missing");
  return value;
}
async function requireSessionBinding(store: RalphEventStoreV2, attemptId: string): Promise<ProviderSessionBindingV2> {
  const value = await readProviderSessionBindingV2(store, attemptId);
  if (!value) throw m4a("M4A_PROVIDER_BINDING_INVALID", "M4A_PROVIDER_BINDING_INVALID: session binding missing");
  return value;
}

function coreBinding(value: ProviderInvocationCoreBindingV2): ProviderInvocationCoreBindingV2 {
  return { runId: value.runId, phaseId: value.phaseId, taskId: value.taskId, attemptId: value.attemptId, invocationId: value.invocationId };
}

function sameCoreBinding(left: ProviderInvocationCoreBindingV2, right: ProviderInvocationCoreBindingV2): boolean {
  return left.runId === right.runId && left.phaseId === right.phaseId && left.taskId === right.taskId && left.attemptId === right.attemptId && left.invocationId === right.invocationId;
}

function assertOwnDigest(record: Record<string, unknown>, field: string): void {
  assertDigest(record[field]);
  const { [field]: _ignored, ...base } = record;
  if (sha256Canonical(base) !== record[field]) throw artifact("M4A_ARTIFACT_DIGEST_MISMATCH");
}

function assertArtifactSecurity(record: Record<string, unknown>): void {
  if (Buffer.byteLength(canonicalJson(record), "utf8") > 32 * 1024) throw artifact("M4A_ARTIFACT_OVERSIZED");
  try { assertNoCredentialMaterial(record, "M4A_PROVIDER_ARTIFACT_CREDENTIAL"); }
  catch (error) {
    if (error instanceof RalphCredentialSafetyError) throw artifact(error.code, error);
    throw error;
  }
}

function assertAttemptRef(value: unknown, attemptId: string): asserts value is string {
  if (typeof value !== "string" || !new RegExp(`^attempts/${escapeRegExp(attemptId)}/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`).test(value)) throw artifact("M4A_PROVIDER_BINDING_INVALID: artifact ref");
}

function validateNullableAttemptRef(value: unknown, attemptId: string): void {
  if (value !== null) assertAttemptRef(value, attemptId);
}

function assertOpenCodeSessionId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^ses_[A-Za-z0-9_-]{8,128}$/.test(value)) throw artifact("M4A_SESSION_BINDING_INVALID: session id");
}

function assertExitAndSignal(exitCode: number | null, signal: string | null): void {
  if (exitCode !== null && (!Number.isSafeInteger(exitCode) || exitCode < -1)) throw artifact("M4A_TERMINAL_INVALID: exit code");
  if (signal !== null && (typeof signal !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(signal))) throw artifact("M4A_TERMINAL_INVALID: signal");
}

function assertTimestamp(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 20 || value.length > 64 || !Number.isFinite(Date.parse(value))) throw artifact("M4A_ARTIFACT_TIMESTAMP_INVALID");
}

function assertSafeText(value: unknown, slashAllowed: boolean): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\0") || (!slashAllowed && value.includes("/"))) throw artifact("M4A_ARTIFACT_STRING_INVALID");
}

function assertDigest(value: unknown): asserts value is string {
  if (!isSha256Digest(value)) throw artifact("M4A_ARTIFACT_DIGEST_INVALID");
}

function validateNullableDigest(value: unknown): void {
  if (value !== null) assertDigest(value);
}

function validateNullableString(value: unknown, slashAllowed: boolean): void {
  if (value !== null) assertSafeText(value, slashAllowed);
}

function assertExactKeys(value: object, keys: readonly string[], code: string): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw artifact(`${code}: unknown fields ${unknown.sort().join(",")}`);
}

function requireRecord(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw artifact(code);
  return value as Record<string, unknown>;
}

function freezeArtifact<T>(value: T, validate: (candidate: unknown) => asserts candidate is T): T {
  validate(value);
  return freezeDeep(value);
}

function freezeDeep<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function artifact(message: string, cause?: unknown): RalphB4ArtifactError {
  return new RalphB4ArtifactError("B4_ARTIFACT_INVALID", message, cause);
}

function m4a(code: M4AErrorCode, message: string = code, cause?: unknown): RalphM4AError {
  return new RalphM4AError(code, message, cause);
}
