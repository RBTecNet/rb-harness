import { join, resolve } from "node:path";
import { isSha256Digest, sha256Canonical } from "../hashing.js";
import { assertNoCredentialMaterial } from "../operational-b1/secret-safety.js";
import type { RalphEventStoreV2 } from "../operational-b1/event-store.js";
import type { ProcessIdentity } from "../operational-b2/process-identity.js";
import {
  attemptArtifactRefV2,
  persistImmutableJsonArtifactV2,
  readImmutableJsonArtifactV2,
  type ArtifactPersistenceResultV2,
} from "../operational-b4/artifacts.js";
import { readCodexThreadBindingV2 } from "../operational-m5b/codex-artifacts.js";
import {
  MAX_AUDIT_FINDING_TEXT_V2,
  MAX_AUDIT_PROPOSED_FINDINGS_V2,
  MAX_AUDIT_RATIONALE_V2,
  MAX_AUDIT_RESOLVED_REFS_V2,
  MAX_AUDIT_SCOPE_ENTRIES_V2,
} from "../operational-m4d/audit-envelope.js";
import type { CodexObservedModelStateV2 } from "../operational-m5b/contract.js";
import type { CodexTerminalKindV2 } from "../operational-m5b/codex-jsonl.js";
import type { ExecutorStatus, ExecutorTermination } from "../operational-v2/contracts.js";
import { codexAuditProposalDigestV2, type CodexAuditProposalV2 } from "./codex-audit-output.js";
import {
  CODEX_CLI_AUDITOR_PROFILE_IDENTITY_V2,
  CODEX_CLI_AUDITOR_PROVIDER_V2,
  CODEX_CLI_AUDITOR_ROLE_V2,
  CODEX_CLI_AUDITOR_TRANSPORT_V2,
  m5d,
} from "./contract.js";

export const RALPH_CODEX_AUDIT_PROVIDER_DESCRIPTOR_SCHEMA_V2 = "rb-ralph-codex-audit-provider-descriptor/v1" as const;
export const RALPH_CODEX_AUDIT_PROMPT_SCHEMA_V2 = "rb-ralph-codex-audit-prompt/v1" as const;
export const RALPH_CODEX_AUDIT_DISPATCH_INTENT_SCHEMA_V2 = "rb-ralph-codex-audit-dispatch-intent/v1" as const;
export const RALPH_CODEX_AUDIT_PROCESS_RECEIPT_SCHEMA_V2 = "rb-ralph-codex-audit-process-receipt/v1" as const;
export const RALPH_CODEX_AUDIT_THREAD_BINDING_SCHEMA_V2 = "rb-ralph-codex-audit-thread-binding/v1" as const;
export const RALPH_CODEX_AUDIT_PROVIDER_RESULT_SCHEMA_V2 = "rb-ralph-codex-audit-provider-result/v1" as const;
export const RALPH_CODEX_AUDIT_TERMINAL_SCHEMA_V2 = "rb-ralph-codex-audit-terminal/v1" as const;

interface CoreAuditBindingV2 {
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly auditInvocationId: string;
}

export interface CodexAuditProviderDescriptorV2 extends CoreAuditBindingV2 {
  readonly schema: typeof RALPH_CODEX_AUDIT_PROVIDER_DESCRIPTOR_SCHEMA_V2;
  readonly role: typeof CODEX_CLI_AUDITOR_ROLE_V2;
  readonly auditPackageId: string;
  readonly auditPackageDigest: string;
  readonly auditorRuntimeIdentity: string;
  readonly auditorProfileId: string;
  readonly auditorProfileIdentity: typeof CODEX_CLI_AUDITOR_PROFILE_IDENTITY_V2;
  readonly auditorProfileDigest: string;
  readonly provider: typeof CODEX_CLI_AUDITOR_PROVIDER_V2;
  readonly transport: typeof CODEX_CLI_AUDITOR_TRANSPORT_V2;
  readonly requestedModel: string;
  readonly reasoningEffort: string;
  readonly observedModelState: CodexObservedModelStateV2;
  readonly observedModel: string | null;
  readonly managedRuntimeKind: string;
  readonly managedRuntimeVersion: string;
  readonly managedRuntimeIdentityDigest: string;
  readonly executablePath: string;
  readonly executableVersion: string;
  readonly executableSizeBytes: number;
  readonly executableSha256: string;
  readonly capabilityDigest: string;
  readonly capabilityBindingDigest: string;
  readonly permissionProfileName: string;
  readonly permissionProfileDigest: string;
  readonly permissionPolicyShapeDigest: string;
  readonly permissionProfileFactsDigest: string;
  readonly sandboxBackendPath: string;
  readonly timeoutPolicyDigest: string;
  readonly projectRootIdentity: string;
  readonly baseWorkspaceFingerprint: string;
  readonly baseProductWorkspaceFingerprint: string;
  readonly baseControlPlaneFingerprint: string;
  readonly argvPolicyDigest: string;
  readonly parentEnvironmentPolicyDigest: string;
  readonly shellEnvironmentPolicyDigest: string;
  readonly outputSchemaDigest: string;
  readonly createdAt: string;
  readonly descriptorDigest: string;
}

export interface CodexAuditPromptArtifactV2 extends CoreAuditBindingV2 {
  readonly schema: typeof RALPH_CODEX_AUDIT_PROMPT_SCHEMA_V2;
  readonly descriptorDigest: string;
  readonly auditPackageId: string;
  readonly auditPackageDigest: string;
  readonly promptDigest: string;
  readonly promptBytes: number;
  readonly outputSchemaDigest: string;
  readonly preparedAt: string;
  readonly artifactDigest: string;
}

export interface CodexAuditDispatchIntentV2 extends CoreAuditBindingV2 {
  readonly schema: typeof RALPH_CODEX_AUDIT_DISPATCH_INTENT_SCHEMA_V2;
  readonly descriptorRef: string;
  readonly descriptorDigest: string;
  readonly promptRef: string;
  readonly promptArtifactDigest: string;
  readonly dispatchId: string;
  readonly argvDigest: string;
  readonly ioDirectoryIdentity: string;
  readonly workspaceFingerprintBefore: string;
  readonly productWorkspaceFingerprintBefore: string;
  readonly controlPlaneFingerprintBefore: string;
  readonly createdAt: string;
  readonly intentDigest: string;
}

export interface CodexAuditProcessReceiptV2 extends CoreAuditBindingV2 {
  readonly schema: typeof RALPH_CODEX_AUDIT_PROCESS_RECEIPT_SCHEMA_V2;
  readonly descriptorDigest: string;
  readonly dispatchIntentDigest: string;
  readonly dispatchId: string;
  readonly processIdentity: ProcessIdentity;
  readonly processGroupId: number;
  readonly containmentKind: string;
  readonly containmentStructural: boolean;
  readonly startedAt: string;
  readonly receiptDigest: string;
}

export interface CodexAuditThreadBindingV2 extends CoreAuditBindingV2 {
  readonly schema: typeof RALPH_CODEX_AUDIT_THREAD_BINDING_SCHEMA_V2;
  readonly descriptorDigest: string;
  readonly dispatchIntentDigest: string;
  readonly processReceiptDigest: string;
  readonly threadId: string;
  readonly boundAt: string;
  readonly bindingDigest: string;
}

export interface CodexAuditProviderResultV2 extends CoreAuditBindingV2 {
  readonly schema: typeof RALPH_CODEX_AUDIT_PROVIDER_RESULT_SCHEMA_V2;
  readonly descriptorDigest: string;
  readonly dispatchIntentDigest: string;
  readonly promptArtifactDigest: string;
  readonly auditPackageId: string;
  readonly auditPackageDigest: string;
  readonly auditorRuntimeIdentity: string;
  readonly managedRuntimeIdentityDigest: string;
  readonly threadBindingDigest: string;
  readonly threadId: string;
  readonly requestedModel: string;
  readonly observedModelState: CodexObservedModelStateV2;
  readonly observedModel: string | null;
  readonly classification: ExecutorStatus;
  readonly terminalKind: CodexTerminalKindV2;
  readonly proposal: CodexAuditProposalV2;
  readonly proposalDigest: string;
  readonly structuredResultDigest: string;
  readonly finalAgentMessageDigest: string;
  readonly eventStreamDigest: string;
  readonly eventCount: number;
  readonly agentMessageCount: number;
  readonly commandExecutionCount: number;
  readonly usageInputCount: number | null;
  readonly usageOutputCount: number | null;
  readonly actualExitCode: number;
  readonly actualSignal: null;
  readonly workspaceFingerprintBefore: string;
  readonly workspaceFingerprintAfter: string;
  readonly productWorkspaceFingerprintBefore: string;
  readonly productWorkspaceFingerprintAfter: string;
  readonly controlPlaneFingerprintBefore: string;
  readonly controlPlaneFingerprintAfter: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly resultDigest: string;
}

export interface CodexAuditQuiescenceV2 {
  readonly processState: "ABSENT";
  readonly processTreeState: "QUIESCENT";
  readonly settlementObserved: true;
  readonly settlementQuiescent: true;
  readonly settlementVerified: true;
  readonly observedAt: string;
  readonly evidenceDigest: string;
}

export interface CodexAuditTerminalArtifactV2 extends CoreAuditBindingV2 {
  readonly schema: typeof RALPH_CODEX_AUDIT_TERMINAL_SCHEMA_V2;
  readonly descriptorDigest: string;
  readonly dispatchIntentDigest: string;
  readonly processReceiptDigest: string;
  readonly threadBindingDigest: string;
  readonly status: ExecutorStatus;
  readonly termination: ExecutorTermination;
  readonly exitCode: number;
  readonly signal: null;
  readonly timedOut: false;
  readonly cancelled: false;
  readonly resultRef: string;
  readonly resultDigest: string;
  readonly workspaceFingerprintBefore: string;
  readonly workspaceFingerprintAfter: string;
  readonly quiescence: CodexAuditQuiescenceV2;
  readonly finishedAt: string;
  readonly terminalDigest: string;
}

export const codexAuditProviderDescriptorRefV2 = (attemptId: string): string => attemptArtifactRefV2(attemptId, "codex-audit-provider-descriptor.json");
export const codexAuditPromptRefV2 = (attemptId: string): string => attemptArtifactRefV2(attemptId, "codex-audit-prompt.json");
export const codexAuditDispatchIntentRefV2 = (attemptId: string): string => attemptArtifactRefV2(attemptId, "codex-audit-dispatch-intent.json");
export const codexAuditProcessReceiptRefV2 = (attemptId: string): string => attemptArtifactRefV2(attemptId, "codex-audit-process-receipt.json");
export const codexAuditThreadBindingRefV2 = (attemptId: string): string => attemptArtifactRefV2(attemptId, "codex-audit-thread-binding.json");
export const codexAuditProviderResultRefV2 = (attemptId: string): string => attemptArtifactRefV2(attemptId, "codex-audit-provider-result.json");
export const codexAuditTerminalRefV2 = (attemptId: string): string => attemptArtifactRefV2(attemptId, "codex-audit-terminal.json");

const CORE = ["runId", "phaseId", "taskId", "attemptId", "auditInvocationId"] as const;
const DESCRIPTOR = ["schema", ...CORE, "role", "auditPackageId", "auditPackageDigest", "auditorRuntimeIdentity", "auditorProfileId", "auditorProfileIdentity", "auditorProfileDigest", "provider", "transport", "requestedModel", "reasoningEffort", "observedModelState", "observedModel", "managedRuntimeKind", "managedRuntimeVersion", "managedRuntimeIdentityDigest", "executablePath", "executableVersion", "executableSizeBytes", "executableSha256", "capabilityDigest", "capabilityBindingDigest", "permissionProfileName", "permissionProfileDigest", "permissionPolicyShapeDigest", "permissionProfileFactsDigest", "sandboxBackendPath", "timeoutPolicyDigest", "projectRootIdentity", "baseWorkspaceFingerprint", "baseProductWorkspaceFingerprint", "baseControlPlaneFingerprint", "argvPolicyDigest", "parentEnvironmentPolicyDigest", "shellEnvironmentPolicyDigest", "outputSchemaDigest", "createdAt", "descriptorDigest"] as const;
const PROMPT = ["schema", ...CORE, "descriptorDigest", "auditPackageId", "auditPackageDigest", "promptDigest", "promptBytes", "outputSchemaDigest", "preparedAt", "artifactDigest"] as const;
const INTENT = ["schema", ...CORE, "descriptorRef", "descriptorDigest", "promptRef", "promptArtifactDigest", "dispatchId", "argvDigest", "ioDirectoryIdentity", "workspaceFingerprintBefore", "productWorkspaceFingerprintBefore", "controlPlaneFingerprintBefore", "createdAt", "intentDigest"] as const;
const PROCESS = ["schema", ...CORE, "descriptorDigest", "dispatchIntentDigest", "dispatchId", "processIdentity", "processGroupId", "containmentKind", "containmentStructural", "startedAt", "receiptDigest"] as const;
const THREAD = ["schema", ...CORE, "descriptorDigest", "dispatchIntentDigest", "processReceiptDigest", "threadId", "boundAt", "bindingDigest"] as const;
const RESULT = ["schema", ...CORE, "descriptorDigest", "dispatchIntentDigest", "promptArtifactDigest", "auditPackageId", "auditPackageDigest", "auditorRuntimeIdentity", "managedRuntimeIdentityDigest", "threadBindingDigest", "threadId", "requestedModel", "observedModelState", "observedModel", "classification", "terminalKind", "proposal", "proposalDigest", "structuredResultDigest", "finalAgentMessageDigest", "eventStreamDigest", "eventCount", "agentMessageCount", "commandExecutionCount", "usageInputCount", "usageOutputCount", "actualExitCode", "actualSignal", "workspaceFingerprintBefore", "workspaceFingerprintAfter", "productWorkspaceFingerprintBefore", "productWorkspaceFingerprintAfter", "controlPlaneFingerprintBefore", "controlPlaneFingerprintAfter", "startedAt", "finishedAt", "resultDigest"] as const;
const TERMINAL = ["schema", ...CORE, "descriptorDigest", "dispatchIntentDigest", "processReceiptDigest", "threadBindingDigest", "status", "termination", "exitCode", "signal", "timedOut", "cancelled", "resultRef", "resultDigest", "workspaceFingerprintBefore", "workspaceFingerprintAfter", "quiescence", "finishedAt", "terminalDigest"] as const;

export function sealCodexAuditArtifactV2<T>(base: Record<string, unknown>, digestField: string): T {
  return Object.freeze({ ...base, [digestField]: sha256Canonical(base) }) as T;
}

export function validateCodexAuditProviderDescriptorV2(value: unknown): asserts value is CodexAuditProviderDescriptorV2 {
  shape(value, RALPH_CODEX_AUDIT_PROVIDER_DESCRIPTOR_SCHEMA_V2, DESCRIPTOR, "descriptorDigest");
  if (value.role !== CODEX_CLI_AUDITOR_ROLE_V2 || value.auditorProfileIdentity !== CODEX_CLI_AUDITOR_PROFILE_IDENTITY_V2 || value.provider !== CODEX_CLI_AUDITOR_PROVIDER_V2 || value.transport !== CODEX_CLI_AUDITOR_TRANSPORT_V2) throw invalid("descriptor role/transport");
  if (value.observedModelState !== "UNAVAILABLE" || value.observedModel !== null) throw invalid("descriptor observed model");
  if (!Number.isSafeInteger(value.executableSizeBytes) || Number(value.executableSizeBytes) < 1) throw invalid("descriptor executable size");
  digests(value, ["auditPackageDigest", "auditorProfileDigest", "managedRuntimeIdentityDigest", "executableSha256", "capabilityDigest", "capabilityBindingDigest", "permissionProfileDigest", "permissionPolicyShapeDigest", "permissionProfileFactsDigest", "timeoutPolicyDigest", "projectRootIdentity", "baseWorkspaceFingerprint", "baseProductWorkspaceFingerprint", "baseControlPlaneFingerprint", "argvPolicyDigest", "parentEnvironmentPolicyDigest", "shellEnvironmentPolicyDigest", "outputSchemaDigest"]);
}

export function validateCodexAuditPromptArtifactV2(value: unknown): asserts value is CodexAuditPromptArtifactV2 {
  shape(value, RALPH_CODEX_AUDIT_PROMPT_SCHEMA_V2, PROMPT, "artifactDigest");
  digests(value, ["descriptorDigest", "auditPackageDigest", "promptDigest", "outputSchemaDigest"]);
  if (!Number.isSafeInteger(value.promptBytes) || Number(value.promptBytes) < 1 || Number(value.promptBytes) > 64 * 1024) throw invalid("prompt bytes");
}

export function validateCodexAuditDispatchIntentV2(value: unknown): asserts value is CodexAuditDispatchIntentV2 {
  shape(value, RALPH_CODEX_AUDIT_DISPATCH_INTENT_SCHEMA_V2, INTENT, "intentDigest");
  digests(value, ["descriptorDigest", "promptArtifactDigest", "argvDigest", "ioDirectoryIdentity", "workspaceFingerprintBefore", "productWorkspaceFingerprintBefore", "controlPlaneFingerprintBefore"]);
}

export function validateCodexAuditProcessReceiptV2(value: unknown): asserts value is CodexAuditProcessReceiptV2 {
  shape(value, RALPH_CODEX_AUDIT_PROCESS_RECEIPT_SCHEMA_V2, PROCESS, "receiptDigest");
  digests(value, ["descriptorDigest", "dispatchIntentDigest"]);
  if (!record(value.processIdentity) || !Number.isSafeInteger(value.processIdentity.pid) || Number(value.processIdentity.pid) < 1 || !Number.isSafeInteger(value.processGroupId) || Number(value.processGroupId) < 1 || value.containmentStructural !== true) throw invalid("process identity/containment");
}

export function validateCodexAuditThreadBindingV2(value: unknown): asserts value is CodexAuditThreadBindingV2 {
  shape(value, RALPH_CODEX_AUDIT_THREAD_BINDING_SCHEMA_V2, THREAD, "bindingDigest");
  digests(value, ["descriptorDigest", "dispatchIntentDigest", "processReceiptDigest"]);
  if (typeof value.threadId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,190}$/.test(value.threadId)) throw m5d("M5D_THREAD_BINDING_INVALID");
}

export function validateCodexAuditProviderResultV2(value: unknown): asserts value is CodexAuditProviderResultV2 {
  shape(value, RALPH_CODEX_AUDIT_PROVIDER_RESULT_SCHEMA_V2, RESULT, "resultDigest");
  digests(value, ["descriptorDigest", "dispatchIntentDigest", "promptArtifactDigest", "auditPackageDigest", "managedRuntimeIdentityDigest", "threadBindingDigest", "proposalDigest", "structuredResultDigest", "finalAgentMessageDigest", "eventStreamDigest", "workspaceFingerprintBefore", "workspaceFingerprintAfter", "productWorkspaceFingerprintBefore", "productWorkspaceFingerprintAfter", "controlPlaneFingerprintBefore", "controlPlaneFingerprintAfter"]);
  if (value.classification !== "SUCCEEDED" || value.terminalKind !== "TURN_COMPLETED" || value.actualExitCode !== 0 || value.actualSignal !== null || value.observedModelState !== "UNAVAILABLE" || value.observedModel !== null) throw invalid("provider success facts");
  validateDurableProposal(value.proposal);
  if (value.proposalDigest !== codexAuditProposalDigestV2(value.proposal)) throw invalid("proposal digest");
  if (value.workspaceFingerprintBefore !== value.workspaceFingerprintAfter || value.productWorkspaceFingerprintBefore !== value.productWorkspaceFingerprintAfter || value.controlPlaneFingerprintBefore !== value.controlPlaneFingerprintAfter) throw m5d("M5D_WORKSPACE_MUTATED_BY_AUDITOR");
}

export function validateCodexAuditTerminalArtifactV2(value: unknown): asserts value is CodexAuditTerminalArtifactV2 {
  shape(value, RALPH_CODEX_AUDIT_TERMINAL_SCHEMA_V2, TERMINAL, "terminalDigest");
  digests(value, ["descriptorDigest", "dispatchIntentDigest", "processReceiptDigest", "threadBindingDigest", "resultDigest", "workspaceFingerprintBefore", "workspaceFingerprintAfter"]);
  if (value.status !== "SUCCEEDED" || value.termination !== "NORMAL" || value.exitCode !== 0 || value.signal !== null || value.timedOut !== false || value.cancelled !== false || value.workspaceFingerprintBefore !== value.workspaceFingerprintAfter) throw invalid("terminal success");
  const q = value.quiescence;
  if (!record(q) || q.processState !== "ABSENT" || q.processTreeState !== "QUIESCENT" || q.settlementObserved !== true || q.settlementQuiescent !== true || q.settlementVerified !== true || !isSha256Digest(q.evidenceDigest)) throw m5d("M5D_PROCESS_TREE_NOT_QUIESCENT");
  const { evidenceDigest: _digest, ...base } = q;
  if (sha256Canonical(base) !== q.evidenceDigest) throw m5d("M5D_PROCESS_TREE_NOT_QUIESCENT");
}

export async function persistCodexAuditProviderDescriptorV2(store: RalphEventStoreV2, value: CodexAuditProviderDescriptorV2, nonce: string): Promise<ArtifactPersistenceResultV2<CodexAuditProviderDescriptorV2>> {
  validateCodexAuditProviderDescriptorV2(value); sameStore(store, value);
  if (value.projectRootIdentity !== sha256Canonical({ projectRoot: resolve(store.projectRoot) })) throw invalid("project root");
  return persistImmutableJsonArtifactV2({ store, ref: codexAuditProviderDescriptorRefV2(value.attemptId), artifact: value, validate: validateCodexAuditProviderDescriptorV2, nonce });
}
export async function persistCodexAuditPromptArtifactV2(store: RalphEventStoreV2, value: CodexAuditPromptArtifactV2, nonce: string): Promise<ArtifactPersistenceResultV2<CodexAuditPromptArtifactV2>> {
  validateCodexAuditPromptArtifactV2(value); sameStore(store, value); const d = await requireDescriptor(store, value.attemptId);
  if (!same(value, d) || value.descriptorDigest !== d.descriptorDigest || value.auditPackageId !== d.auditPackageId || value.auditPackageDigest !== d.auditPackageDigest || value.outputSchemaDigest !== d.outputSchemaDigest) throw invalid("prompt binding");
  return persistImmutableJsonArtifactV2({ store, ref: codexAuditPromptRefV2(value.attemptId), artifact: value, validate: validateCodexAuditPromptArtifactV2, nonce });
}
export async function persistCodexAuditDispatchIntentV2(store: RalphEventStoreV2, value: CodexAuditDispatchIntentV2, nonce: string): Promise<ArtifactPersistenceResultV2<CodexAuditDispatchIntentV2>> {
  validateCodexAuditDispatchIntentV2(value); sameStore(store, value); const d = await requireDescriptor(store, value.attemptId); const p = await requirePrompt(store, value.attemptId);
  if (!same(value, d) || value.descriptorDigest !== d.descriptorDigest || value.promptArtifactDigest !== p.artifactDigest || value.workspaceFingerprintBefore !== d.baseWorkspaceFingerprint || value.productWorkspaceFingerprintBefore !== d.baseProductWorkspaceFingerprint || value.controlPlaneFingerprintBefore !== d.baseControlPlaneFingerprint) throw invalid("intent binding");
  return persistImmutableJsonArtifactV2({ store, ref: codexAuditDispatchIntentRefV2(value.attemptId), artifact: value, validate: validateCodexAuditDispatchIntentV2, nonce });
}
export async function persistCodexAuditProcessReceiptV2(store: RalphEventStoreV2, value: CodexAuditProcessReceiptV2, nonce: string): Promise<ArtifactPersistenceResultV2<CodexAuditProcessReceiptV2>> {
  validateCodexAuditProcessReceiptV2(value); sameStore(store, value); const d = await requireDescriptor(store, value.attemptId); const i = await requireIntent(store, value.attemptId);
  if (!same(value, d) || value.descriptorDigest !== d.descriptorDigest || value.dispatchIntentDigest !== i.intentDigest || value.dispatchId !== i.dispatchId) throw invalid("process binding");
  return persistImmutableJsonArtifactV2({ store, ref: codexAuditProcessReceiptRefV2(value.attemptId), artifact: value, validate: validateCodexAuditProcessReceiptV2, nonce });
}
export async function persistCodexAuditThreadBindingV2(store: RalphEventStoreV2, value: CodexAuditThreadBindingV2, nonce: string): Promise<ArtifactPersistenceResultV2<CodexAuditThreadBindingV2>> {
  validateCodexAuditThreadBindingV2(value); sameStore(store, value); const d = await requireDescriptor(store, value.attemptId); const i = await requireIntent(store, value.attemptId); const p = await requireProcess(store, value.attemptId);
  if (!same(value, d) || value.descriptorDigest !== d.descriptorDigest || value.dispatchIntentDigest !== i.intentDigest || value.processReceiptDigest !== p.receiptDigest) throw invalid("thread binding");
  await assertCodexAuditThreadIsFreshV2(store, value.attemptId, value.threadId);
  return persistImmutableJsonArtifactV2({ store, ref: codexAuditThreadBindingRefV2(value.attemptId), artifact: value, validate: validateCodexAuditThreadBindingV2, nonce });
}
export async function persistCodexAuditProviderResultV2(store: RalphEventStoreV2, value: CodexAuditProviderResultV2, nonce: string): Promise<ArtifactPersistenceResultV2<CodexAuditProviderResultV2>> {
  validateCodexAuditProviderResultV2(value); sameStore(store, value); const d = await requireDescriptor(store, value.attemptId); const i = await requireIntent(store, value.attemptId); const p = await requirePrompt(store, value.attemptId); const t = await requireThread(store, value.attemptId);
  if (!same(value, d) || value.descriptorDigest !== d.descriptorDigest || value.dispatchIntentDigest !== i.intentDigest || value.promptArtifactDigest !== p.artifactDigest || value.threadBindingDigest !== t.bindingDigest || value.threadId !== t.threadId || value.auditPackageId !== d.auditPackageId || value.auditPackageDigest !== d.auditPackageDigest || value.auditorRuntimeIdentity !== d.auditorRuntimeIdentity || value.managedRuntimeIdentityDigest !== d.managedRuntimeIdentityDigest) throw invalid("result binding");
  return persistImmutableJsonArtifactV2({ store, ref: codexAuditProviderResultRefV2(value.attemptId), artifact: value, validate: validateCodexAuditProviderResultV2, nonce });
}
export async function persistCodexAuditTerminalArtifactV2(store: RalphEventStoreV2, value: CodexAuditTerminalArtifactV2, nonce: string): Promise<ArtifactPersistenceResultV2<CodexAuditTerminalArtifactV2>> {
  validateCodexAuditTerminalArtifactV2(value); sameStore(store, value); const d = await requireDescriptor(store, value.attemptId); const i = await requireIntent(store, value.attemptId); const p = await requireProcess(store, value.attemptId); const t = await requireThread(store, value.attemptId); const r = await requireResult(store, value.attemptId);
  if (!same(value, d) || value.descriptorDigest !== d.descriptorDigest || value.dispatchIntentDigest !== i.intentDigest || value.processReceiptDigest !== p.receiptDigest || value.threadBindingDigest !== t.bindingDigest || value.resultDigest !== r.resultDigest || value.resultRef !== codexAuditProviderResultRefV2(value.attemptId)) throw invalid("terminal binding");
  return persistImmutableJsonArtifactV2({ store, ref: codexAuditTerminalRefV2(value.attemptId), artifact: value, validate: validateCodexAuditTerminalArtifactV2, nonce });
}

export const readCodexAuditProviderDescriptorV2 = (store: RalphEventStoreV2, attemptId: string): Promise<CodexAuditProviderDescriptorV2 | undefined> => readImmutableJsonArtifactV2({ store, ref: codexAuditProviderDescriptorRefV2(attemptId), validate: validateCodexAuditProviderDescriptorV2 });
export const readCodexAuditPromptArtifactV2 = (store: RalphEventStoreV2, attemptId: string): Promise<CodexAuditPromptArtifactV2 | undefined> => readImmutableJsonArtifactV2({ store, ref: codexAuditPromptRefV2(attemptId), validate: validateCodexAuditPromptArtifactV2 });
export const readCodexAuditDispatchIntentV2 = (store: RalphEventStoreV2, attemptId: string): Promise<CodexAuditDispatchIntentV2 | undefined> => readImmutableJsonArtifactV2({ store, ref: codexAuditDispatchIntentRefV2(attemptId), validate: validateCodexAuditDispatchIntentV2 });
export const readCodexAuditProcessReceiptV2 = (store: RalphEventStoreV2, attemptId: string): Promise<CodexAuditProcessReceiptV2 | undefined> => readImmutableJsonArtifactV2({ store, ref: codexAuditProcessReceiptRefV2(attemptId), validate: validateCodexAuditProcessReceiptV2 });
export const readCodexAuditThreadBindingV2 = (store: RalphEventStoreV2, attemptId: string): Promise<CodexAuditThreadBindingV2 | undefined> => readImmutableJsonArtifactV2({ store, ref: codexAuditThreadBindingRefV2(attemptId), validate: validateCodexAuditThreadBindingV2 });
export const readCodexAuditProviderResultV2 = (store: RalphEventStoreV2, attemptId: string): Promise<CodexAuditProviderResultV2 | undefined> => readImmutableJsonArtifactV2({ store, ref: codexAuditProviderResultRefV2(attemptId), validate: validateCodexAuditProviderResultV2 });
export const readCodexAuditTerminalArtifactV2 = (store: RalphEventStoreV2, attemptId: string): Promise<CodexAuditTerminalArtifactV2 | undefined> => readImmutableJsonArtifactV2({ store, ref: codexAuditTerminalRefV2(attemptId), validate: validateCodexAuditTerminalArtifactV2 });

export interface CodexAuditArtifactSetV2 {
  readonly descriptor?: CodexAuditProviderDescriptorV2;
  readonly prompt?: CodexAuditPromptArtifactV2;
  readonly dispatchIntent?: CodexAuditDispatchIntentV2;
  readonly processReceipt?: CodexAuditProcessReceiptV2;
  readonly threadBinding?: CodexAuditThreadBindingV2;
  readonly providerResult?: CodexAuditProviderResultV2;
  readonly terminal?: CodexAuditTerminalArtifactV2;
}

export async function readCodexAuditArtifactSetV2(store: RalphEventStoreV2, attemptId: string): Promise<CodexAuditArtifactSetV2> {
  const [descriptor, prompt, dispatchIntent, processReceipt, threadBinding, providerResult, terminal] = await Promise.all([
    readCodexAuditProviderDescriptorV2(store, attemptId), readCodexAuditPromptArtifactV2(store, attemptId), readCodexAuditDispatchIntentV2(store, attemptId),
    readCodexAuditProcessReceiptV2(store, attemptId), readCodexAuditThreadBindingV2(store, attemptId), readCodexAuditProviderResultV2(store, attemptId), readCodexAuditTerminalArtifactV2(store, attemptId),
  ]);
  if (!descriptor) { if (prompt || dispatchIntent || processReceipt || threadBinding || providerResult || terminal) throw invalid("orphan artifact"); return {}; }
  if (prompt && (prompt.descriptorDigest !== descriptor.descriptorDigest || !same(prompt, descriptor))) throw invalid("orphan prompt");
  if (dispatchIntent && (!prompt || dispatchIntent.promptArtifactDigest !== prompt.artifactDigest || dispatchIntent.descriptorDigest !== descriptor.descriptorDigest)) throw invalid("orphan intent");
  if (processReceipt && (!dispatchIntent || processReceipt.dispatchIntentDigest !== dispatchIntent.intentDigest)) throw invalid("orphan process");
  if (threadBinding && (!processReceipt || threadBinding.processReceiptDigest !== processReceipt.receiptDigest)) throw invalid("orphan thread");
  if (providerResult && (!threadBinding || providerResult.threadBindingDigest !== threadBinding.bindingDigest)) throw invalid("orphan result");
  if (terminal && (!providerResult || terminal.resultDigest !== providerResult.resultDigest)) throw invalid("orphan terminal");
  return Object.freeze({ ...(descriptor ? { descriptor } : {}), ...(prompt ? { prompt } : {}), ...(dispatchIntent ? { dispatchIntent } : {}), ...(processReceipt ? { processReceipt } : {}), ...(threadBinding ? { threadBinding } : {}), ...(providerResult ? { providerResult } : {}), ...(terminal ? { terminal } : {}) });
}

/** Enumerate durable bindings, including Executor/Correction artifacts. */
export async function assertCodexAuditThreadIsFreshV2(store: RalphEventStoreV2, attemptId: string, threadId: string): Promise<void> {
  const attempts = new Set<string>([attemptId]);
  for (const event of (await store.inspect()).events) if (event.attemptId) attempts.add(event.attemptId);
  try { for (const name of await store.fileSystem.readdir(join(store.runDirectory, "attempts"))) if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) attempts.add(name); } catch { /* no attempts */ }
  const observed = new Map<string, string>();
  for (const candidate of attempts) {
    const executor = await readCodexThreadBindingV2(store, candidate);
    const auditor = await readCodexAuditThreadBindingV2(store, candidate);
    for (const [role, binding] of [["EXECUTOR", executor], ["AUDITOR", auditor]] as const) {
      if (!binding) continue;
      const owner = `${role}:${candidate}`;
      const prior = observed.get(binding.threadId);
      if (prior && prior !== owner) throw m5d("M5D_THREAD_REUSE_FORBIDDEN", `M5D_THREAD_REUSE_FORBIDDEN: ${prior}/${owner}`);
      observed.set(binding.threadId, owner);
      if (binding.threadId === threadId && !(role === "AUDITOR" && candidate === attemptId)) throw m5d("M5D_THREAD_REUSE_FORBIDDEN", `M5D_THREAD_REUSE_FORBIDDEN: ${owner}`);
    }
  }
}

function shape(value: unknown, schema: string, keys: readonly string[], digestField: string): asserts value is Record<string, any> {
  if (!record(value)) throw invalid(schema);
  const unknown = Object.keys(value).filter((key) => !keys.includes(key)); const missing = keys.filter((key) => !(key in value));
  if (unknown.length || missing.length || value.schema !== schema) throw invalid(`${schema} shape`);
  for (const key of CORE) if (typeof value[key] !== "string" || value[key].length === 0 || value[key].length > 512 || value[key].includes("/") || value[key].includes("\0")) throw invalid(`${schema} ${key}`);
  if (!isSha256Digest(value[digestField])) throw invalid(`${schema} digest`);
  const { [digestField]: _digest, ...base } = value;
  if (sha256Canonical(base) !== value[digestField]) throw invalid(`${schema} digest mismatch`);
  try { assertNoCredentialMaterial(value, "M5D_ARTIFACT_CREDENTIAL"); } catch (error) { throw m5d("M5D_PROVIDER_CREDENTIAL_MATERIAL", undefined, error); }
}
function digests(value: Record<string, any>, keys: readonly string[]): void { for (const key of keys) if (!isSha256Digest(value[key])) throw invalid(`digest ${key}`); }
function validateDurableProposal(value: unknown): asserts value is CodexAuditProposalV2 {
  if (!record(value) || !["ACCEPT", "REJECT"].includes(String(value.verdict)) || !Array.isArray(value.proposedFindings) || !Array.isArray(value.resolvedFindingRefs) || typeof value.rationale !== "string") throw invalid("durable proposal");
  const keys = Object.keys(value); if (keys.length !== 4 || ["verdict", "proposedFindings", "resolvedFindingRefs", "rationale"].some((key) => !keys.includes(key))) throw invalid("durable proposal fields");
  if (value.proposedFindings.length > MAX_AUDIT_PROPOSED_FINDINGS_V2 || value.resolvedFindingRefs.length > MAX_AUDIT_RESOLVED_REFS_V2 || value.rationale.length < 1 || value.rationale.length > MAX_AUDIT_RATIONALE_V2 || value.rationale.includes("\0")) throw invalid("durable proposal bounds");
  if (value.verdict === "ACCEPT" && value.proposedFindings.length !== 0) throw invalid("durable ACCEPT findings");
  if (value.verdict === "REJECT" && value.proposedFindings.length === 0) throw invalid("durable REJECT findings");
  const refs = new Set<string>();
  for (const reference of value.resolvedFindingRefs) {
    if (typeof reference !== "string" || !/^finding-[0-9a-f]{64}$/.test(reference) || refs.has(reference)) throw invalid("durable resolution ref");
    refs.add(reference);
  }
  const findingKeys = new Set<string>();
  for (const finding of value.proposedFindings) {
    if (!record(finding)) throw invalid("durable finding");
    const allowed = ["criterionId", "structuredFindingKey", "severity", "scope", "expectation", "observed", "remediationHint"];
    const required = ["criterionId", "structuredFindingKey", "severity", "scope", "expectation", "observed"];
    if (Object.keys(finding).some((key) => !allowed.includes(key)) || required.some((key) => !(key in finding))) throw invalid("durable finding fields");
    if (typeof finding.criterionId !== "string" || !/^criterion:[1-9][0-9]{0,2}$/.test(finding.criterionId)
      || typeof finding.structuredFindingKey !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,63}$/.test(finding.structuredFindingKey)
      || typeof finding.severity !== "string" || !["INFO", "LOW", "MEDIUM", "HIGH", "BLOCKER"].includes(finding.severity)
      || !Array.isArray(finding.scope) || finding.scope.length < 1 || finding.scope.length > MAX_AUDIT_SCOPE_ENTRIES_V2
      || finding.scope.some((entry) => typeof entry !== "string" || entry.length < 1 || entry.length > 256 || entry.includes("\0") || entry.includes("\n"))
      || typeof finding.expectation !== "string" || finding.expectation.length < 1 || finding.expectation.length > MAX_AUDIT_FINDING_TEXT_V2 || finding.expectation.includes("\0")
      || typeof finding.observed !== "string" || finding.observed.length < 1 || finding.observed.length > MAX_AUDIT_FINDING_TEXT_V2 || finding.observed.includes("\0")
      || (finding.remediationHint !== undefined && (typeof finding.remediationHint !== "string" || finding.remediationHint.length > MAX_AUDIT_FINDING_TEXT_V2 || finding.remediationHint.includes("\0")))) throw invalid("durable finding values");
    const key = `${finding.criterionId}:${finding.structuredFindingKey}`;
    if (findingKeys.has(key)) throw invalid("durable duplicate finding");
    findingKeys.add(key);
  }
}
function same(left: CoreAuditBindingV2, right: CoreAuditBindingV2): boolean { return CORE.every((key) => left[key] === right[key]); }
function sameStore(store: RalphEventStoreV2, value: CoreAuditBindingV2): void { if (store.runId !== value.runId) throw invalid("foreign store"); }
function record(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function invalid(message: string): Error { return m5d("M5D_ARTIFACT_INVALID", `M5D_ARTIFACT_INVALID: ${message}`); }
async function requireDescriptor(store: RalphEventStoreV2, id: string): Promise<CodexAuditProviderDescriptorV2> { const v = await readCodexAuditProviderDescriptorV2(store, id); if (!v) throw invalid("descriptor missing"); return v; }
async function requirePrompt(store: RalphEventStoreV2, id: string): Promise<CodexAuditPromptArtifactV2> { const v = await readCodexAuditPromptArtifactV2(store, id); if (!v) throw invalid("prompt missing"); return v; }
async function requireIntent(store: RalphEventStoreV2, id: string): Promise<CodexAuditDispatchIntentV2> { const v = await readCodexAuditDispatchIntentV2(store, id); if (!v) throw invalid("intent missing"); return v; }
async function requireProcess(store: RalphEventStoreV2, id: string): Promise<CodexAuditProcessReceiptV2> { const v = await readCodexAuditProcessReceiptV2(store, id); if (!v) throw invalid("process missing"); return v; }
async function requireThread(store: RalphEventStoreV2, id: string): Promise<CodexAuditThreadBindingV2> { const v = await readCodexAuditThreadBindingV2(store, id); if (!v) throw invalid("thread missing"); return v; }
async function requireResult(store: RalphEventStoreV2, id: string): Promise<CodexAuditProviderResultV2> { const v = await readCodexAuditProviderResultV2(store, id); if (!v) throw invalid("result missing"); return v; }
