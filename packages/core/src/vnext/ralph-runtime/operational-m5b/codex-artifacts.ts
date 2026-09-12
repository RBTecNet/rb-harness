import { isSha256Digest, sha256Canonical } from "../hashing.js";
import type { RalphEventStoreV2 } from "../operational-b1/index.js";
import type { ProcessIdentity } from "../operational-b2/process-identity.js";
import {
  attemptArtifactRefV2,
  persistImmutableJsonArtifactV2,
  readImmutableJsonArtifactV2,
  type ArtifactPersistenceResultV2,
} from "../operational-b4/artifacts.js";
import type { ExecutorStatus, ExecutorTermination } from "../operational-v2/contracts.js";
import { EXECUTOR_STATUSES, EXECUTOR_TERMINATIONS } from "../operational-v2/contracts.js";
import { type CodexObservedModelStateV2 } from "./contract.js";
import { M5B_ERROR_CODES, RalphM5BError, type M5BErrorCode } from "./contract-errors.js";
import { CODEX_OBSERVED_MODEL_STATES_V2 } from "./contract.js";
import { CODEX_TERMINAL_KINDS_V2, type CodexTerminalKindV2 } from "./codex-jsonl.js";
import { validateCodexProjectionManifestV2, type CodexProjectionManifestV2 } from "./codex-projection.js";
import { validateCodexWorkspaceDeltaV2, type CodexWorkspaceDeltaV2 } from "./codex-delta.js";
import { correctionContextRefV2 } from "../operational-f/correction-context.js";
import { validateExactCodexCorrectionDescriptorV2 } from "./codex-correction.js";

/**
 * The Codex physical invocation artifact family.
 *
 * Nothing here reuses an OpenCode field: Codex has no server session, no
 * provider user-message identity and no observable turn id, so no such field
 * is invented, aliased or overloaded.
 */
export const RALPH_CODEX_PROVIDER_DESCRIPTOR_SCHEMA_V2 = "rb-ralph-codex-provider-descriptor/v1" as const;
export const RALPH_CODEX_DISPATCH_INTENT_SCHEMA_V2 = "rb-ralph-codex-dispatch-intent/v1" as const;
export const RALPH_CODEX_PROCESS_RECEIPT_SCHEMA_V2 = "rb-ralph-codex-process-receipt/v1" as const;
export const RALPH_CODEX_THREAD_BINDING_SCHEMA_V2 = "rb-ralph-codex-thread-binding/v1" as const;
export const RALPH_CODEX_PROMPT_SCHEMA_V2 = "rb-ralph-codex-prompt/v1" as const;
export const RALPH_CODEX_PROVIDER_RESULT_SCHEMA_V2 = "rb-ralph-codex-provider-result/v1" as const;
export const RALPH_CODEX_TERMINAL_SCHEMA_V2 = "rb-ralph-codex-terminal/v1" as const;
export const RALPH_CODEX_FINALIZATION_DIAGNOSTIC_SCHEMA_V2 = "rb-ralph-codex-finalization-diagnostic/v1" as const;

export const CODEX_FINALIZATION_STAGES_V2 = [
  "SENTINEL_VERIFICATION",
  "PROJECTION_OBSERVATION",
  "DELTA_DERIVATION",
  "DELTA_PERSISTENCE",
  "WORKSPACE_PUBLICATION",
  "TERMINAL_PERSISTENCE",
] as const;
export type CodexFinalizationStageV2 = typeof CODEX_FINALIZATION_STAGES_V2[number];

export interface CodexCoreBindingV2 {
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly invocationId: string;
}

export interface CodexProviderDescriptorV2 extends CodexCoreBindingV2 {
  readonly schema: typeof RALPH_CODEX_PROVIDER_DESCRIPTOR_SCHEMA_V2;
  readonly workUnitId: string;
  readonly workUnitDigest: string;
  readonly executorProfileIdentity: string;
  readonly executorProfileDigest: string;
  readonly provider: string;
  readonly transport: string;
  readonly cliVersion: string;
  /** The Harness-MANAGED runtime this dispatch executed, by identity. */
  readonly managedRuntimeKind: string;
  readonly managedRuntimeVersion: string;
  readonly managedRuntimeIdentityDigest: string;
  readonly requestedModel: string;
  readonly reasoningEffort: string;
  /** Stock ephemeral `codex exec` publishes no effective-model surface. */
  readonly observedModelState: CodexObservedModelStateV2;
  readonly observedModel: string | null;
  readonly executablePath: string;
  readonly executableVersion: string;
  readonly executableSizeBytes: number;
  readonly executableSha256: string;
  readonly capabilityRecordDigest: string;
  /**
   * Binds the capability record, the live capability probe, the observed
   * sandbox backend and this Attempt's permission profile together, so a
   * changed permission policy can never reuse an older descriptor.
   */
  readonly capabilityBindingDigest: string;
  readonly permissionProfileName: string;
  readonly permissionProfileDigest: string;
  readonly permissionPolicyShapeDigest: string;
  readonly permissionProfileFactsDigest: string;
  /**
   * Root-scope binding.  A root WorkUnit dispatches under a writable staging
   * root and a sealed sentinel authority; a non-root one under neither.  Both
   * facts are in the descriptor, so a profile built for one can never be
   * replayed as the other.
   */
  readonly stagingRootWritable: boolean;
  readonly writeRootPlanDigest: string;
  readonly rootSentinelManifestDigest: string;
  readonly sandboxBackendPath: string;
  /** M5-B never selects a legacy sandbox mode; the profile is the boundary. */
  readonly legacySandboxMode: "NONE";
  readonly runtimeIdentity: string;
  readonly projectRootIdentity: string;
  readonly baseWorkspaceFingerprint: string;
  readonly argvPolicyDigest: string;
  readonly parentEnvironmentPolicyDigest: string;
  readonly shellEnvironmentPolicyDigest: string;
  readonly outputSchemaDigest: string;
  readonly correctionContextSupported: boolean;
  readonly correctionContextRef: string | null;
  readonly correctionContextDigest: string | null;
  readonly createdAt: string;
  readonly descriptorDigest: string;
}

export interface CodexDispatchIntentV2 extends CodexCoreBindingV2 {
  readonly schema: typeof RALPH_CODEX_DISPATCH_INTENT_SCHEMA_V2;
  readonly descriptorRef: string;
  readonly descriptorDigest: string;
  readonly dispatchId: string;
  readonly projectionManifestRef: string;
  readonly projectionManifestDigest: string;
  readonly rootSentinelManifestDigest: string;
  readonly promptRef: string;
  readonly promptDigest: string;
  readonly argvDigest: string;
  readonly stagingRootIdentity: string;
  readonly createdAt: string;
  readonly intentDigest: string;
}

export interface CodexProcessReceiptV2 extends CodexCoreBindingV2 {
  readonly schema: typeof RALPH_CODEX_PROCESS_RECEIPT_SCHEMA_V2;
  readonly descriptorRef: string;
  readonly descriptorDigest: string;
  readonly dispatchIntentRef: string;
  readonly dispatchIntentDigest: string;
  readonly dispatchId: string;
  readonly processIdentity: ProcessIdentity;
  readonly processGroupId: number;
  readonly containmentKind: string;
  readonly containmentStructural: boolean;
  readonly startedAt: string;
  readonly receiptDigest: string;
}

export interface CodexThreadBindingV2 extends CodexCoreBindingV2 {
  readonly schema: typeof RALPH_CODEX_THREAD_BINDING_SCHEMA_V2;
  readonly descriptorRef: string;
  readonly descriptorDigest: string;
  readonly dispatchIntentRef: string;
  readonly dispatchIntentDigest: string;
  readonly processReceiptRef: string;
  readonly processReceiptDigest: string;
  /** The single public `thread.started` identity of this fresh exec. */
  readonly threadId: string;
  readonly boundAt: string;
  readonly bindingDigest: string;
}

export interface CodexPromptArtifactV2 extends CodexCoreBindingV2 {
  readonly schema: typeof RALPH_CODEX_PROMPT_SCHEMA_V2;
  readonly descriptorDigest: string;
  readonly projectionManifestDigest: string;
  readonly promptDigest: string;
  readonly promptBytes: number;
  readonly preparedAt: string;
  readonly artifactDigest: string;
}

export interface CodexProviderResultV2 extends CodexCoreBindingV2 {
  readonly schema: typeof RALPH_CODEX_PROVIDER_RESULT_SCHEMA_V2;
  readonly descriptorDigest: string;
  readonly dispatchIntentDigest: string;
  readonly threadBindingDigest: string;
  readonly threadId: string;
  readonly requestedModel: string;
  readonly observedModelState: CodexObservedModelStateV2;
  readonly observedModel: string | null;
  readonly classification: ExecutorStatus;
  readonly terminalKind: CodexTerminalKindV2 | null;
  readonly structuredResultDigest: string | null;
  readonly finalAgentMessageDigest: string | null;
  readonly eventStreamDigest: string | null;
  readonly eventCount: number;
  readonly agentMessageCount: number;
  readonly commandExecutionCount: number;
  readonly usageInputTokens: number | null;
  readonly usageOutputTokens: number | null;
  readonly actualExitCode: number | null;
  readonly actualSignal: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly resultDigest: string;
}

export interface CodexQuiescenceV2 {
  readonly processState: "ABSENT" | "QUIESCENCE_UNKNOWN";
  readonly processTreeState: "QUIESCENT" | "ACTIVE" | "UNKNOWN";
  readonly settlementObserved: boolean;
  readonly settlementQuiescent: boolean;
  readonly settlementVerified: boolean;
  readonly observedAt: string;
}

export interface CodexTerminalArtifactV2 extends CodexCoreBindingV2 {
  readonly schema: typeof RALPH_CODEX_TERMINAL_SCHEMA_V2;
  readonly descriptorDigest: string;
  readonly dispatchIntentDigest: string;
  readonly processReceiptDigest: string;
  readonly threadBindingDigest: string | null;
  readonly status: ExecutorStatus;
  readonly termination: ExecutorTermination;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly resultRef: string | null;
  readonly resultDigest: string | null;
  readonly deltaRef: string | null;
  readonly deltaDigest: string | null;
  readonly publicationReceiptRef: string | null;
  readonly publicationDigest: string | null;
  readonly quiescence: CodexQuiescenceV2;
  readonly finishedAt: string;
  readonly terminalDigest: string;
}

/** Minimal sealed evidence for a typed failure after the provider result. */
export interface CodexFinalizationDiagnosticV2 extends CodexCoreBindingV2 {
  readonly schema: typeof RALPH_CODEX_FINALIZATION_DIAGNOSTIC_SCHEMA_V2;
  readonly providerResultDigest: string;
  readonly stage: CodexFinalizationStageV2;
  readonly m5bCode: M5BErrorCode;
  readonly recordedAt: string;
  readonly diagnosticDigest: string;
}

export const codexProviderDescriptorRefV2 = (attemptId: string): string => attemptArtifactRefV2(attemptId, "codex-provider-descriptor.json");
export const codexDispatchIntentRefV2 = (attemptId: string): string => attemptArtifactRefV2(attemptId, "codex-dispatch-intent.json");
export const codexProcessReceiptRefV2 = (attemptId: string): string => attemptArtifactRefV2(attemptId, "codex-process-receipt.json");
export const codexThreadBindingRefV2 = (attemptId: string): string => attemptArtifactRefV2(attemptId, "codex-thread-binding.json");
export const codexPromptRefV2 = (attemptId: string): string => attemptArtifactRefV2(attemptId, "codex-prompt.json");
export const codexProviderResultRefV2 = (attemptId: string): string => attemptArtifactRefV2(attemptId, "codex-provider-result.json");
export const codexTerminalRefV2 = (attemptId: string): string => attemptArtifactRefV2(attemptId, "codex-terminal.json");
export const codexFinalizationDiagnosticRefV2 = (attemptId: string): string => attemptArtifactRefV2(attemptId, "codex-finalization-diagnostic.json");
export const codexProjectionManifestRefV2 = (attemptId: string): string => attemptArtifactRefV2(attemptId, "codex-projection-manifest.json");
export const codexWorkspaceDeltaRefV2 = (attemptId: string): string => attemptArtifactRefV2(attemptId, "codex-workspace-delta.json");

const DESCRIPTOR_KEYS = [
  "schema", "runId", "phaseId", "taskId", "attemptId", "invocationId", "workUnitId", "workUnitDigest",
  "executorProfileIdentity", "executorProfileDigest", "provider", "transport", "cliVersion",
  "managedRuntimeKind", "managedRuntimeVersion", "managedRuntimeIdentityDigest", "requestedModel",
  "reasoningEffort", "observedModelState", "observedModel", "executablePath", "executableVersion", "executableSizeBytes",
  "executableSha256", "capabilityRecordDigest", "capabilityBindingDigest", "permissionProfileName", "permissionProfileDigest",
  "permissionPolicyShapeDigest", "permissionProfileFactsDigest",
  "stagingRootWritable", "writeRootPlanDigest", "rootSentinelManifestDigest", "sandboxBackendPath", "legacySandboxMode",
  "runtimeIdentity", "projectRootIdentity", "baseWorkspaceFingerprint",
  "argvPolicyDigest", "parentEnvironmentPolicyDigest", "shellEnvironmentPolicyDigest", "outputSchemaDigest",
  "correctionContextSupported", "correctionContextRef", "correctionContextDigest", "createdAt", "descriptorDigest",
] as const;
const DISPATCH_KEYS = [
  "schema", "runId", "phaseId", "taskId", "attemptId", "invocationId", "descriptorRef", "descriptorDigest", "dispatchId",
  "projectionManifestRef", "projectionManifestDigest", "rootSentinelManifestDigest", "promptRef", "promptDigest",
  "argvDigest", "stagingRootIdentity",
  "createdAt", "intentDigest",
] as const;
const PROCESS_KEYS = [
  "schema", "runId", "phaseId", "taskId", "attemptId", "invocationId", "descriptorRef", "descriptorDigest",
  "dispatchIntentRef", "dispatchIntentDigest", "dispatchId", "processIdentity", "processGroupId", "containmentKind",
  "containmentStructural", "startedAt", "receiptDigest",
] as const;
const THREAD_KEYS = [
  "schema", "runId", "phaseId", "taskId", "attemptId", "invocationId", "descriptorRef", "descriptorDigest",
  "dispatchIntentRef", "dispatchIntentDigest", "processReceiptRef", "processReceiptDigest", "threadId", "boundAt", "bindingDigest",
] as const;
const PROMPT_KEYS = [
  "schema", "runId", "phaseId", "taskId", "attemptId", "invocationId", "descriptorDigest", "projectionManifestDigest",
  "promptDigest", "promptBytes", "preparedAt", "artifactDigest",
] as const;
const RESULT_KEYS = [
  "schema", "runId", "phaseId", "taskId", "attemptId", "invocationId", "descriptorDigest", "dispatchIntentDigest",
  "threadBindingDigest", "threadId", "requestedModel", "observedModelState", "observedModel", "classification",
  "terminalKind", "structuredResultDigest", "finalAgentMessageDigest", "eventStreamDigest", "eventCount",
  "agentMessageCount", "commandExecutionCount", "usageInputTokens", "usageOutputTokens", "actualExitCode",
  "actualSignal", "startedAt", "finishedAt", "resultDigest",
] as const;
const TERMINAL_KEYS = [
  "schema", "runId", "phaseId", "taskId", "attemptId", "invocationId", "descriptorDigest", "dispatchIntentDigest",
  "processReceiptDigest", "threadBindingDigest", "status", "termination", "exitCode", "signal", "timedOut", "cancelled",
  "resultRef", "resultDigest", "deltaRef", "deltaDigest", "publicationReceiptRef", "publicationDigest", "quiescence",
  "finishedAt", "terminalDigest",
] as const;
const FINALIZATION_DIAGNOSTIC_KEYS = [
  "schema", "runId", "phaseId", "taskId", "attemptId", "invocationId", "providerResultDigest", "stage", "m5bCode",
  "recordedAt", "diagnosticDigest",
] as const;

/** Seal an artifact by appending its own canonical digest field. */
export function sealCodexArtifactV2<T>(base: Record<string, unknown>, digestField: string): T {
  return Object.freeze({ ...base, [digestField]: sha256Canonical(base) }) as unknown as T;
}

function assertCodexArtifactShapeV2(value: unknown, schema: string, keys: readonly string[], digestField: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new RalphM5BError("M5B_PROVIDER_RESULT_INVALID", `M5B_ARTIFACT_INVALID: ${schema}`);
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new RalphM5BError("M5B_PROVIDER_RESULT_INVALID", `M5B_ARTIFACT_INVALID: ${schema} unknown fields ${unknown.sort().join(",")}`);
  const missing = keys.filter((key) => !(key in value));
  if (missing.length > 0) throw new RalphM5BError("M5B_PROVIDER_RESULT_INVALID", `M5B_ARTIFACT_INVALID: ${schema} missing fields ${missing.join(",")}`);
  if (value.schema !== schema) throw new RalphM5BError("M5B_PROVIDER_RESULT_INVALID", `M5B_ARTIFACT_INVALID: ${schema} schema`);
  for (const key of ["runId", "phaseId", "taskId", "attemptId", "invocationId"]) {
    const item = value[key];
    if (typeof item !== "string" || item.length === 0 || item.length > 512 || item.includes("/") || item.includes("\0")) {
      throw new RalphM5BError("M5B_PROVIDER_RESULT_INVALID", `M5B_ARTIFACT_INVALID: ${schema} ${key}`);
    }
  }
  if (!isSha256Digest(value[digestField])) throw new RalphM5BError("M5B_PROVIDER_RESULT_INVALID", `M5B_ARTIFACT_INVALID: ${schema} digest`);
  const { [digestField]: _ignored, ...base } = value;
  if (sha256Canonical(base) !== value[digestField]) throw new RalphM5BError("M5B_PROVIDER_RESULT_INVALID", `M5B_ARTIFACT_INVALID: ${schema} digest mismatch`);
}

export function validateCodexProviderDescriptorV2(value: unknown): asserts value is CodexProviderDescriptorV2 {
  assertCodexArtifactShapeV2(value, RALPH_CODEX_PROVIDER_DESCRIPTOR_SCHEMA_V2, DESCRIPTOR_KEYS, "descriptorDigest");
  if (typeof value.correctionContextSupported !== "boolean") throw new RalphM5BError("M5B_PROVIDER_RESULT_INVALID", "M5C_CORRECTION_DESCRIPTOR_BINDING_INVALID: support flag");
  const correctionBound = value.correctionContextRef !== null || value.correctionContextDigest !== null;
  if (correctionBound !== value.correctionContextSupported
    || (value.correctionContextRef === null) !== (value.correctionContextDigest === null)) {
    throw new RalphM5BError("M5B_PROVIDER_RESULT_INVALID", "M5C_CORRECTION_DESCRIPTOR_BINDING_INVALID: partial or inconsistent binding");
  }
  if (correctionBound) {
    if (value.correctionContextRef !== correctionContextRefV2(String(value.attemptId)) || !isSha256Digest(value.correctionContextDigest)) {
      throw new RalphM5BError("M5B_PROVIDER_RESULT_INVALID", "M5C_CORRECTION_DESCRIPTOR_BINDING_INVALID: ref or digest");
    }
  }
  if (typeof value.stagingRootWritable !== "boolean") throw new RalphM5BError("M5B_PROVIDER_RESULT_INVALID", "M5B_ARTIFACT_INVALID: stagingRootWritable");
  // A descriptor that claims a writable staging root but carries no sentinel
  // authority would describe an unguarded root-scope dispatch.
  if (value.stagingRootWritable && (typeof value.rootSentinelManifestDigest !== "string" || !isSha256Digest(value.rootSentinelManifestDigest))) {
    throw new RalphM5BError("M5B_SENTINEL_MANIFEST_INVALID", "M5B_SENTINEL_MANIFEST_INVALID: a writable staging root requires a sealed sentinel authority");
  }
  // A descriptor that reintroduces the legacy sandbox, or drops the named
  // permission profile, is refused: those are the exact regressions M5-B.1
  // was opened to close.
  if (value.legacySandboxMode !== "NONE") throw new RalphM5BError("M5B_ARGV_POLICY_INVALID", "M5B_ARGV_POLICY_INVALID: legacy sandbox mode in descriptor");
  if (typeof value.permissionProfileName !== "string" || value.permissionProfileName.length === 0) throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", "M5B_PERMISSION_PROFILE_INVALID: descriptor profile name");
  for (const key of ["permissionProfileDigest", "permissionPolicyShapeDigest", "permissionProfileFactsDigest", "capabilityBindingDigest"] as const) {
    if (!isSha256Digest(value[key])) throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", `M5B_PERMISSION_PROFILE_INVALID: descriptor ${key}`);
  }
  if (!(CODEX_OBSERVED_MODEL_STATES_V2 as readonly string[]).includes(value.observedModelState as string)) throw new RalphM5BError("M5B_PROVIDER_MODEL_SURFACE_UNEXPECTED");
  if (value.observedModelState === "UNAVAILABLE" && value.observedModel !== null) throw new RalphM5BError("M5B_PROVIDER_MODEL_SURFACE_UNEXPECTED", "M5B_PROVIDER_MODEL_SURFACE_UNEXPECTED: an unavailable observation cannot carry a model");
  if (typeof value.executableSizeBytes !== "number" || !Number.isSafeInteger(value.executableSizeBytes) || value.executableSizeBytes < 1) throw new RalphM5BError("M5B_EXECUTABLE_IDENTITY_INVALID");
  if (!isSha256Digest(value.executableSha256)) throw new RalphM5BError("M5B_EXECUTABLE_IDENTITY_INVALID");
}

export function validateCodexDispatchIntentV2(value: unknown): asserts value is CodexDispatchIntentV2 {
  assertCodexArtifactShapeV2(value, RALPH_CODEX_DISPATCH_INTENT_SCHEMA_V2, DISPATCH_KEYS, "intentDigest");
}

export function validateCodexProcessReceiptV2(value: unknown): asserts value is CodexProcessReceiptV2 {
  assertCodexArtifactShapeV2(value, RALPH_CODEX_PROCESS_RECEIPT_SCHEMA_V2, PROCESS_KEYS, "receiptDigest");
  const identity = value.processIdentity;
  if (!isRecord(identity) || !Number.isSafeInteger(identity.pid) || Number(identity.pid) < 1
    || typeof identity.processStartIdentity !== "string" || typeof identity.hostIdentity !== "string" || typeof identity.bootSessionIdentity !== "string") {
    throw new RalphM5BError("M5B_PROCESS_IDENTITY_INVALID");
  }
  if (!Number.isSafeInteger(value.processGroupId) || Number(value.processGroupId) < 1) throw new RalphM5BError("M5B_PROCESS_IDENTITY_INVALID");
}

export function validateCodexThreadBindingV2(value: unknown): asserts value is CodexThreadBindingV2 {
  assertCodexArtifactShapeV2(value, RALPH_CODEX_THREAD_BINDING_SCHEMA_V2, THREAD_KEYS, "bindingDigest");
  if (typeof value.threadId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,190}$/.test(value.threadId)) throw new RalphM5BError("M5B_THREAD_BINDING_INVALID");
}

export function validateCodexPromptArtifactV2(value: unknown): asserts value is CodexPromptArtifactV2 {
  assertCodexArtifactShapeV2(value, RALPH_CODEX_PROMPT_SCHEMA_V2, PROMPT_KEYS, "artifactDigest");
  if (!isSha256Digest(value.promptDigest) || !Number.isSafeInteger(value.promptBytes)) throw new RalphM5BError("M5B_PROVIDER_RESULT_INVALID", "M5B_ARTIFACT_INVALID: prompt");
}

export function validateCodexProviderResultV2(value: unknown): asserts value is CodexProviderResultV2 {
  assertCodexArtifactShapeV2(value, RALPH_CODEX_PROVIDER_RESULT_SCHEMA_V2, RESULT_KEYS, "resultDigest");
  if (!EXECUTOR_STATUSES.includes(value.classification as ExecutorStatus)) throw new RalphM5BError("M5B_PROVIDER_RESULT_INVALID", "M5B_ARTIFACT_INVALID: classification");
  if (value.terminalKind !== null && !(CODEX_TERMINAL_KINDS_V2 as readonly string[]).includes(value.terminalKind as string)) throw new RalphM5BError("M5B_PROVIDER_RESULT_INVALID", "M5B_ARTIFACT_INVALID: terminal kind");
  if (!(CODEX_OBSERVED_MODEL_STATES_V2 as readonly string[]).includes(value.observedModelState as string)) throw new RalphM5BError("M5B_PROVIDER_MODEL_SURFACE_UNEXPECTED");
  if (value.observedModelState === "UNAVAILABLE" && value.observedModel !== null) throw new RalphM5BError("M5B_PROVIDER_MODEL_SURFACE_UNEXPECTED");
  if (value.classification === "SUCCEEDED" && (value.terminalKind !== "TURN_COMPLETED" || value.structuredResultDigest === null || value.actualExitCode !== 0)) {
    throw new RalphM5BError("M5B_PROVIDER_RESULT_INVALID", "M5B_ARTIFACT_INVALID: success requires a terminal turn, a structured result and a zero child exit");
  }
}

export function validateCodexTerminalArtifactV2(value: unknown): asserts value is CodexTerminalArtifactV2 {
  assertCodexArtifactShapeV2(value, RALPH_CODEX_TERMINAL_SCHEMA_V2, TERMINAL_KEYS, "terminalDigest");
  if (!EXECUTOR_STATUSES.includes(value.status as ExecutorStatus) || !EXECUTOR_TERMINATIONS.includes(value.termination as ExecutorTermination)) {
    throw new RalphM5BError("M5B_PROVIDER_RESULT_INVALID", "M5B_ARTIFACT_INVALID: terminal status");
  }
  const quiescence = value.quiescence;
  if (!isRecord(quiescence)) throw new RalphM5BError("M5B_PROCESS_TREE_NOT_QUIESCENT");
  const unknown = Object.keys(quiescence).filter((key) => !["processState", "processTreeState", "settlementObserved", "settlementQuiescent", "settlementVerified", "observedAt"].includes(key));
  if (unknown.length > 0) throw new RalphM5BError("M5B_PROCESS_TREE_NOT_QUIESCENT", `M5B_ARTIFACT_INVALID: quiescence ${unknown.join(",")}`);
  if (value.status === "SUCCEEDED" && (quiescence.processState !== "ABSENT" || quiescence.processTreeState !== "QUIESCENT" || quiescence.settlementObserved !== true || quiescence.settlementQuiescent !== true)) {
    throw new RalphM5BError("M5B_PROCESS_TREE_NOT_QUIESCENT", "M5B_PROCESS_TREE_NOT_QUIESCENT: success requires a positive quiescence observation");
  }
}

export function validateCodexFinalizationDiagnosticV2(value: unknown): asserts value is CodexFinalizationDiagnosticV2 {
  assertCodexArtifactShapeV2(
    value,
    RALPH_CODEX_FINALIZATION_DIAGNOSTIC_SCHEMA_V2,
    FINALIZATION_DIAGNOSTIC_KEYS,
    "diagnosticDigest",
  );
  if (!isSha256Digest(value.providerResultDigest)) {
    throw new RalphM5BError("M5B_PROVIDER_RESULT_INVALID", "M5B_FINALIZATION_DIAGNOSTIC_INVALID: provider result digest");
  }
  if (!(CODEX_FINALIZATION_STAGES_V2 as readonly string[]).includes(value.stage as string)) {
    throw new RalphM5BError("M5B_PROVIDER_RESULT_INVALID", "M5B_FINALIZATION_DIAGNOSTIC_INVALID: stage");
  }
  if (!(M5B_ERROR_CODES as readonly string[]).includes(value.m5bCode as string)) {
    throw new RalphM5BError("M5B_PROVIDER_RESULT_INVALID", "M5B_FINALIZATION_DIAGNOSTIC_INVALID: m5bCode");
  }
  if (typeof value.recordedAt !== "string" || value.recordedAt.length < 20 || value.recordedAt.length > 64
    || !Number.isFinite(Date.parse(value.recordedAt)) || new Date(Date.parse(value.recordedAt)).toISOString() !== value.recordedAt) {
    throw new RalphM5BError("M5B_PROVIDER_RESULT_INVALID", "M5B_FINALIZATION_DIAGNOSTIC_INVALID: recordedAt");
  }
}

export async function persistCodexProviderDescriptorV2(store: RalphEventStoreV2, artifact: CodexProviderDescriptorV2, nonce: string): Promise<ArtifactPersistenceResultV2<CodexProviderDescriptorV2>> {
  validateCodexProviderDescriptorV2(artifact);
  await validateExactCodexCorrectionDescriptorV2({ store, descriptor: artifact });
  return persistImmutableJsonArtifactV2({ store, ref: codexProviderDescriptorRefV2(artifact.attemptId), artifact, validate: validateCodexProviderDescriptorV2, nonce });
}
export const persistCodexDispatchIntentV2 = (store: RalphEventStoreV2, artifact: CodexDispatchIntentV2, nonce: string): Promise<ArtifactPersistenceResultV2<CodexDispatchIntentV2>> =>
  persistImmutableJsonArtifactV2({ store, ref: codexDispatchIntentRefV2(artifact.attemptId), artifact, validate: validateCodexDispatchIntentV2, nonce });
export const persistCodexProcessReceiptV2 = (store: RalphEventStoreV2, artifact: CodexProcessReceiptV2, nonce: string): Promise<ArtifactPersistenceResultV2<CodexProcessReceiptV2>> =>
  persistImmutableJsonArtifactV2({ store, ref: codexProcessReceiptRefV2(artifact.attemptId), artifact, validate: validateCodexProcessReceiptV2, nonce });
export async function persistCodexThreadBindingV2(store: RalphEventStoreV2, artifact: CodexThreadBindingV2, nonce: string): Promise<ArtifactPersistenceResultV2<CodexThreadBindingV2>> {
  validateCodexThreadBindingV2(artifact);
  const priorAttemptIds = [...new Set((await store.inspect()).events
    .filter((event) => event.eventType === "attempt.started")
    .map((event) => event.payload.attemptId))]
    .filter((attemptId) => attemptId !== artifact.attemptId);
  for (const attemptId of priorAttemptIds) {
    const prior = await readCodexThreadBindingV2(store, attemptId);
    if (prior?.threadId === artifact.threadId) {
      throw new RalphM5BError("M5B_THREAD_BINDING_INVALID", "M5C_FRESH_THREAD_REQUIRED: thread identity was already bound to another Attempt");
    }
  }
  return persistImmutableJsonArtifactV2({ store, ref: codexThreadBindingRefV2(artifact.attemptId), artifact, validate: validateCodexThreadBindingV2, nonce });
}
export const persistCodexPromptArtifactV2 = (store: RalphEventStoreV2, artifact: CodexPromptArtifactV2, nonce: string): Promise<ArtifactPersistenceResultV2<CodexPromptArtifactV2>> =>
  persistImmutableJsonArtifactV2({ store, ref: codexPromptRefV2(artifact.attemptId), artifact, validate: validateCodexPromptArtifactV2, nonce });
export async function persistCodexProviderResultV2(store: RalphEventStoreV2, artifact: CodexProviderResultV2, nonce: string): Promise<ArtifactPersistenceResultV2<CodexProviderResultV2>> {
  validateCodexProviderResultV2(artifact);
  const [descriptor, intent, thread] = await Promise.all([
    readCodexProviderDescriptorV2(store, artifact.attemptId),
    readCodexDispatchIntentV2(store, artifact.attemptId),
    readCodexThreadBindingV2(store, artifact.attemptId),
  ]);
  const threadBindingValid = thread
    ? artifact.threadBindingDigest === thread.bindingDigest && artifact.threadId === thread.threadId
    : artifact.classification !== "SUCCEEDED" && artifact.threadBindingDigest === "" && artifact.threadId === "";
  if (!descriptor || !intent || !threadBindingValid
    || artifact.descriptorDigest !== descriptor.descriptorDigest
    || artifact.dispatchIntentDigest !== intent.intentDigest
    || artifact.runId !== descriptor.runId
    || artifact.phaseId !== descriptor.phaseId
    || artifact.taskId !== descriptor.taskId
    || artifact.attemptId !== descriptor.attemptId
    || artifact.invocationId !== descriptor.invocationId) {
    throw new RalphM5BError("M5B_PROVIDER_RESULT_INVALID", "M5C_ATTEMPT_RESULT_BINDING_INVALID: provider result cannot be reused across Attempts");
  }
  return persistImmutableJsonArtifactV2({ store, ref: codexProviderResultRefV2(artifact.attemptId), artifact, validate: validateCodexProviderResultV2, nonce });
}
export const persistCodexTerminalArtifactV2 = (store: RalphEventStoreV2, artifact: CodexTerminalArtifactV2, nonce: string): Promise<ArtifactPersistenceResultV2<CodexTerminalArtifactV2>> =>
  persistImmutableJsonArtifactV2({ store, ref: codexTerminalRefV2(artifact.attemptId), artifact, validate: validateCodexTerminalArtifactV2, nonce });
export async function persistCodexFinalizationDiagnosticV2(
  store: RalphEventStoreV2,
  artifact: CodexFinalizationDiagnosticV2,
  nonce: string,
): Promise<ArtifactPersistenceResultV2<CodexFinalizationDiagnosticV2>> {
  validateCodexFinalizationDiagnosticV2(artifact);
  const providerResult = await readCodexProviderResultV2(store, artifact.attemptId);
  assertCodexFinalizationDiagnosticBindingV2(artifact, providerResult);
  return persistImmutableJsonArtifactV2({
    store,
    ref: codexFinalizationDiagnosticRefV2(artifact.attemptId),
    artifact,
    validate: validateCodexFinalizationDiagnosticV2,
    nonce,
  });
}
export const persistCodexProjectionManifestV2 = (store: RalphEventStoreV2, artifact: CodexProjectionManifestV2, nonce: string): Promise<ArtifactPersistenceResultV2<CodexProjectionManifestV2>> =>
  persistImmutableJsonArtifactV2({ store, ref: codexProjectionManifestRefV2(artifact.attemptId), artifact, validate: validateCodexProjectionManifestV2, nonce });
export const persistCodexWorkspaceDeltaV2 = (store: RalphEventStoreV2, artifact: CodexWorkspaceDeltaV2, nonce: string): Promise<ArtifactPersistenceResultV2<CodexWorkspaceDeltaV2>> =>
  persistImmutableJsonArtifactV2({ store, ref: codexWorkspaceDeltaRefV2(artifact.attemptId), artifact, validate: validateCodexWorkspaceDeltaV2, nonce });

export const readCodexProviderDescriptorV2 = (store: RalphEventStoreV2, attemptId: string): Promise<CodexProviderDescriptorV2 | undefined> =>
  readImmutableJsonArtifactV2({ store, ref: codexProviderDescriptorRefV2(attemptId), validate: validateCodexProviderDescriptorV2 });
export const readCodexDispatchIntentV2 = (store: RalphEventStoreV2, attemptId: string): Promise<CodexDispatchIntentV2 | undefined> =>
  readImmutableJsonArtifactV2({ store, ref: codexDispatchIntentRefV2(attemptId), validate: validateCodexDispatchIntentV2 });
export const readCodexProcessReceiptV2 = (store: RalphEventStoreV2, attemptId: string): Promise<CodexProcessReceiptV2 | undefined> =>
  readImmutableJsonArtifactV2({ store, ref: codexProcessReceiptRefV2(attemptId), validate: validateCodexProcessReceiptV2 });
export const readCodexThreadBindingV2 = (store: RalphEventStoreV2, attemptId: string): Promise<CodexThreadBindingV2 | undefined> =>
  readImmutableJsonArtifactV2({ store, ref: codexThreadBindingRefV2(attemptId), validate: validateCodexThreadBindingV2 });
export const readCodexPromptArtifactV2 = (store: RalphEventStoreV2, attemptId: string): Promise<CodexPromptArtifactV2 | undefined> =>
  readImmutableJsonArtifactV2({ store, ref: codexPromptRefV2(attemptId), validate: validateCodexPromptArtifactV2 });
export const readCodexProviderResultV2 = (store: RalphEventStoreV2, attemptId: string): Promise<CodexProviderResultV2 | undefined> =>
  readImmutableJsonArtifactV2({ store, ref: codexProviderResultRefV2(attemptId), validate: validateCodexProviderResultV2 });
export const readCodexTerminalArtifactV2 = (store: RalphEventStoreV2, attemptId: string): Promise<CodexTerminalArtifactV2 | undefined> =>
  readImmutableJsonArtifactV2({ store, ref: codexTerminalRefV2(attemptId), validate: validateCodexTerminalArtifactV2 });
export async function readCodexFinalizationDiagnosticV2(
  store: RalphEventStoreV2,
  attemptId: string,
): Promise<CodexFinalizationDiagnosticV2 | undefined> {
  const artifact = await readImmutableJsonArtifactV2({
    store,
    ref: codexFinalizationDiagnosticRefV2(attemptId),
    validate: validateCodexFinalizationDiagnosticV2,
  });
  if (!artifact) return undefined;
  const providerResult = await readCodexProviderResultV2(store, attemptId);
  assertCodexFinalizationDiagnosticBindingV2(artifact, providerResult);
  return artifact;
}
export const readCodexProjectionManifestV2 = (store: RalphEventStoreV2, attemptId: string): Promise<CodexProjectionManifestV2 | undefined> =>
  readImmutableJsonArtifactV2({ store, ref: codexProjectionManifestRefV2(attemptId), validate: validateCodexProjectionManifestV2 });
export const readCodexWorkspaceDeltaV2 = (store: RalphEventStoreV2, attemptId: string): Promise<CodexWorkspaceDeltaV2 | undefined> =>
  readImmutableJsonArtifactV2({ store, ref: codexWorkspaceDeltaRefV2(attemptId), validate: validateCodexWorkspaceDeltaV2 });

export interface CodexInvocationArtifactSetV2 {
  readonly descriptor?: CodexProviderDescriptorV2;
  readonly dispatchIntent?: CodexDispatchIntentV2;
  readonly processReceipt?: CodexProcessReceiptV2;
  readonly threadBinding?: CodexThreadBindingV2;
  readonly prompt?: CodexPromptArtifactV2;
  readonly providerResult?: CodexProviderResultV2;
  readonly terminal?: CodexTerminalArtifactV2;
  readonly finalizationDiagnostic?: CodexFinalizationDiagnosticV2;
  readonly projectionManifest?: CodexProjectionManifestV2;
  readonly workspaceDelta?: CodexWorkspaceDeltaV2;
}

export async function readCodexInvocationArtifactSetV2(store: RalphEventStoreV2, attemptId: string): Promise<CodexInvocationArtifactSetV2> {
  const [descriptor, dispatchIntent, processReceipt, threadBinding, prompt, providerResult, terminal, finalizationDiagnostic, projectionManifest, workspaceDelta] = await Promise.all([
    readCodexProviderDescriptorV2(store, attemptId),
    readCodexDispatchIntentV2(store, attemptId),
    readCodexProcessReceiptV2(store, attemptId),
    readCodexThreadBindingV2(store, attemptId),
    readCodexPromptArtifactV2(store, attemptId),
    readCodexProviderResultV2(store, attemptId),
    readCodexTerminalArtifactV2(store, attemptId),
    readCodexFinalizationDiagnosticV2(store, attemptId),
    readCodexProjectionManifestV2(store, attemptId),
    readCodexWorkspaceDeltaV2(store, attemptId),
  ]);
  return Object.freeze({
    ...(descriptor === undefined ? {} : { descriptor }),
    ...(dispatchIntent === undefined ? {} : { dispatchIntent }),
    ...(processReceipt === undefined ? {} : { processReceipt }),
    ...(threadBinding === undefined ? {} : { threadBinding }),
    ...(prompt === undefined ? {} : { prompt }),
    ...(providerResult === undefined ? {} : { providerResult }),
    ...(terminal === undefined ? {} : { terminal }),
    ...(finalizationDiagnostic === undefined ? {} : { finalizationDiagnostic }),
    ...(projectionManifest === undefined ? {} : { projectionManifest }),
    ...(workspaceDelta === undefined ? {} : { workspaceDelta }),
  });
}

function assertCodexFinalizationDiagnosticBindingV2(
  artifact: CodexFinalizationDiagnosticV2,
  providerResult: CodexProviderResultV2 | undefined,
): asserts providerResult is CodexProviderResultV2 {
  if (!providerResult
    || artifact.runId !== providerResult.runId
    || artifact.phaseId !== providerResult.phaseId
    || artifact.taskId !== providerResult.taskId
    || artifact.attemptId !== providerResult.attemptId
    || artifact.invocationId !== providerResult.invocationId
    || artifact.providerResultDigest !== providerResult.resultDigest) {
    throw new RalphM5BError("M5B_PROVIDER_RESULT_INVALID", "M5B_FINALIZATION_DIAGNOSTIC_BINDING_INVALID");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
