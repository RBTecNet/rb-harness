import { resolve } from "node:path";
import { canonicalJson } from "../canonical-json.js";
import { isSha256Digest, sha256Canonical } from "../hashing.js";
import { assertNoCredentialMaterial, RalphCredentialSafetyError } from "../operational-b1/secret-safety.js";
import type { RalphEventStoreV2 } from "../operational-b1/index.js";
import type { ProcessIdentity } from "../operational-b2/index.js";
import {
  attemptArtifactRefV2,
  persistImmutableJsonArtifactV2,
  readImmutableJsonArtifactV2,
  type ArtifactPersistenceResultV2,
} from "../operational-b4/artifacts.js";
import {
  EXECUTOR_STATUSES,
  EXECUTOR_TERMINATIONS,
  type ExecutorStatus,
  type ExecutorTermination,
} from "../operational-v2/contracts.js";
import type { AuditPackageV2 } from "../operational-d/artifacts.js";
import {
  OPENCODE_CLI_AUDITOR_CORE_PROFILE_ID_V2,
  OPENCODE_CLI_AUDITOR_MODEL_V2,
  OPENCODE_CLI_AUDITOR_PROFILE_V2,
  OPENCODE_CLI_AUDITOR_ROLE_V2,
  OPENCODE_CLI_AUDITOR_TRANSPORT_V2,
  m4d,
} from "./contract.js";
import {
  auditProposalDigestV2,
  MAX_AUDIT_PROPOSED_FINDINGS_V2,
  MAX_AUDIT_RATIONALE_V2,
  MAX_AUDIT_RESOLVED_REFS_V2,
  type OpenCodeAuditProposalV2,
} from "./audit-envelope.js";

export const RALPH_AUDIT_PROVIDER_DESCRIPTOR_SCHEMA_V2 = "rb-ralph-audit-provider-descriptor/v1" as const;
export const RALPH_AUDIT_PROVIDER_DISPATCH_INTENT_SCHEMA_V2 = "rb-ralph-audit-provider-dispatch-intent/v1" as const;
export const RALPH_AUDIT_PROVIDER_WORKER_RECEIPT_SCHEMA_V2 = "rb-ralph-audit-provider-worker-started/v1" as const;
export const RALPH_AUDIT_PROVIDER_SESSION_BINDING_SCHEMA_V2 = "rb-ralph-audit-provider-session-binding/v1" as const;
export const RALPH_AUDIT_PROVIDER_PROMPT_SCHEMA_V2 = "rb-ralph-audit-provider-prompt/v1" as const;
export const RALPH_AUDIT_PROVIDER_RESULT_SCHEMA_V2 = "rb-ralph-audit-provider-result/v1" as const;
export const RALPH_AUDIT_PROVIDER_TERMINAL_SCHEMA_V2 = "rb-ralph-audit-provider-terminal/v1" as const;

export const AUDIT_PROVIDER_RESULT_CLASSIFICATIONS_V2 = ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "PROTOCOL_FAILURE"] as const;
export type AuditProviderResultClassificationV2 = typeof AUDIT_PROVIDER_RESULT_CLASSIFICATIONS_V2[number];

interface AuditProviderCoreBindingV2 {
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly auditInvocationId: string;
}

export interface AuditProviderDescriptorV2 extends AuditProviderCoreBindingV2 {
  readonly schema: typeof RALPH_AUDIT_PROVIDER_DESCRIPTOR_SCHEMA_V2;
  readonly role: typeof OPENCODE_CLI_AUDITOR_ROLE_V2;
  readonly transport: typeof OPENCODE_CLI_AUDITOR_TRANSPORT_V2;
  readonly auditPackageId: string;
  readonly auditPackageDigest: string;
  readonly auditorRuntimeIdentity: string;
  /** Core-facing slash-free profile id carried by the frozen audit descriptor. */
  readonly auditorProfileId: string;
  /** Exact semantic provider profile, `opencode:cli:<provider>/<model>`. */
  readonly auditorProfileIdentity: string;
  readonly auditorProfileDigest: string;
  readonly modelSelector: string;
  readonly openCodeExecutablePath: string;
  readonly openCodeExecutableVersion: string;
  readonly openCodeExecutableIdentity: string;
  readonly conformanceProfileId: string;
  readonly conformanceRecordDigest: string;
  readonly conformanceExecutableVersion: string;
  readonly conformanceState: "MATCH";
  readonly permissionsDigest: string;
  readonly timeoutPolicyDigest: string;
  readonly projectRootIdentity: string;
  readonly baseWorkspaceFingerprint: string;
  readonly createdAt: string;
  readonly descriptorDigest: string;
}

export interface AuditProviderDispatchIntentV2 extends AuditProviderCoreBindingV2 {
  readonly schema: typeof RALPH_AUDIT_PROVIDER_DISPATCH_INTENT_SCHEMA_V2;
  readonly descriptorRef: string;
  readonly descriptorDigest: string;
  readonly dispatchId: string;
  readonly openCodeUserMessageId: string;
  readonly createdAt: string;
  readonly intentDigest: string;
}

export interface AuditProviderWorkerReceiptV2 extends AuditProviderCoreBindingV2 {
  readonly schema: typeof RALPH_AUDIT_PROVIDER_WORKER_RECEIPT_SCHEMA_V2;
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

export interface AuditProviderSessionBindingV2 extends AuditProviderCoreBindingV2 {
  readonly schema: typeof RALPH_AUDIT_PROVIDER_SESSION_BINDING_SCHEMA_V2;
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

export interface AuditProviderPromptArtifactV2 extends AuditProviderCoreBindingV2 {
  readonly schema: typeof RALPH_AUDIT_PROVIDER_PROMPT_SCHEMA_V2;
  readonly descriptorDigest: string;
  readonly dispatchIntentDigest: string;
  readonly sessionBindingDigest: string;
  readonly auditPackageId: string;
  readonly auditPackageDigest: string;
  readonly openCodeSessionId: string;
  readonly openCodeUserMessageId: string;
  readonly modelSelector: string;
  readonly promptDigest: string;
  readonly promptBytes: number;
  readonly preparedAt: string;
  readonly artifactDigest: string;
}

export interface AuditProviderResultV2 extends AuditProviderCoreBindingV2 {
  readonly schema: typeof RALPH_AUDIT_PROVIDER_RESULT_SCHEMA_V2;
  readonly descriptorDigest: string;
  readonly dispatchIntentDigest: string;
  readonly sessionBindingDigest: string;
  readonly promptArtifactDigest: string;
  readonly auditPackageId: string;
  readonly auditPackageDigest: string;
  readonly openCodeSessionId: string;
  readonly openCodeUserMessageId: string;
  readonly assistantMessageId: string;
  readonly observedModelSelector: string;
  readonly classification: AuditProviderResultClassificationV2;
  readonly assistantContentDigest: string;
  readonly responseDigest: string;
  readonly observableTurnDigest: string;
  /** Bounded validated structured proposal. It is not AuditResult authority. */
  readonly proposal: OpenCodeAuditProposalV2;
  readonly proposalDigest: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly resultDigest: string;
}

export interface AuditProviderTerminalQuiescenceV2 {
  readonly workerProcessState: "ABSENT" | "QUIESCENCE_UNKNOWN";
  readonly processTreeState: "QUIESCENT" | "UNKNOWN";
  readonly observedAt: string;
  readonly evidenceDigest: string;
}

export interface AuditProviderTerminalArtifactV2 extends AuditProviderCoreBindingV2 {
  readonly schema: typeof RALPH_AUDIT_PROVIDER_TERMINAL_SCHEMA_V2;
  readonly descriptorRef: string;
  readonly descriptorDigest: string;
  readonly dispatchIntentRef: string;
  readonly dispatchIntentDigest: string;
  readonly workerReceiptRef: string;
  readonly workerReceiptDigest: string;
  readonly sessionBindingRef: string;
  readonly sessionBindingDigest: string;
  readonly openCodeSessionId: string;
  readonly status: ExecutorStatus;
  readonly termination: ExecutorTermination;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly resultRef: string;
  readonly resultDigest: string;
  readonly workspaceFingerprintBefore: string;
  readonly workspaceFingerprintAfter: string;
  readonly finishedAt: string;
  readonly quiescence: AuditProviderTerminalQuiescenceV2;
  readonly terminalDigest: string;
}

export interface AuditProviderArtifactSetV2 {
  readonly descriptor?: AuditProviderDescriptorV2;
  readonly dispatchIntent?: AuditProviderDispatchIntentV2;
  readonly workerReceipt?: AuditProviderWorkerReceiptV2;
  readonly sessionBinding?: AuditProviderSessionBindingV2;
  readonly prompt?: AuditProviderPromptArtifactV2;
  readonly result?: AuditProviderResultV2;
  readonly terminal?: AuditProviderTerminalArtifactV2;
}

const CORE_KEYS = ["runId", "phaseId", "taskId", "attemptId", "auditInvocationId"] as const;

export function auditProviderDescriptorRefV2(attemptId: string): string {
  return attemptArtifactRefV2(attemptId, "audit-provider-descriptor.json");
}
export function auditProviderDispatchIntentRefV2(attemptId: string): string {
  return attemptArtifactRefV2(attemptId, "audit-provider-dispatch-intent.json");
}
export function auditProviderWorkerReceiptRefV2(attemptId: string): string {
  return attemptArtifactRefV2(attemptId, "audit-provider-worker-started.json");
}
export function auditProviderSessionBindingRefV2(attemptId: string): string {
  return attemptArtifactRefV2(attemptId, "audit-provider-session-binding.json");
}
export function auditProviderPromptRefV2(attemptId: string): string {
  return attemptArtifactRefV2(attemptId, "audit-provider-prompt.json");
}
export function auditProviderResultRefV2(attemptId: string): string {
  return attemptArtifactRefV2(attemptId, "audit-provider-result.json");
}
export function auditProviderTerminalRefV2(attemptId: string): string {
  return attemptArtifactRefV2(attemptId, "audit-provider-terminal.json");
}

export function createAuditProviderDescriptorV2(input: Omit<AuditProviderDescriptorV2, "schema" | "role" | "transport" | "descriptorDigest">): AuditProviderDescriptorV2 {
  const base = {
    schema: RALPH_AUDIT_PROVIDER_DESCRIPTOR_SCHEMA_V2,
    role: OPENCODE_CLI_AUDITOR_ROLE_V2,
    transport: OPENCODE_CLI_AUDITOR_TRANSPORT_V2,
    ...input,
  };
  return freeze({ ...base, descriptorDigest: sha256Canonical(base) }, validateAuditProviderDescriptorV2);
}

/**
 * Deterministic dispatch identity. The `audit-dispatch-`/`msg_ralph_audit_`
 * shapes cannot collide with the frozen Executor `dispatch-`/`msg_ralph_`
 * identities even for the same Attempt.
 */
export function createAuditProviderDispatchIntentV2(descriptor: AuditProviderDescriptorV2, createdAt: string): AuditProviderDispatchIntentV2 {
  validateAuditProviderDescriptorV2(descriptor);
  const hash = sha256Canonical({
    role: OPENCODE_CLI_AUDITOR_ROLE_V2,
    auditInvocationId: descriptor.auditInvocationId,
    descriptorDigest: descriptor.descriptorDigest,
    auditorRuntimeIdentity: descriptor.auditorRuntimeIdentity,
  }).slice("sha256:".length);
  const base = {
    schema: RALPH_AUDIT_PROVIDER_DISPATCH_INTENT_SCHEMA_V2,
    ...coreBinding(descriptor),
    descriptorRef: auditProviderDescriptorRefV2(descriptor.attemptId),
    descriptorDigest: descriptor.descriptorDigest,
    dispatchId: `audit-dispatch-${hash}`,
    openCodeUserMessageId: `msg_ralph_audit_${hash.slice(0, 32)}`,
    createdAt,
  };
  return freeze({ ...base, intentDigest: sha256Canonical(base) }, validateAuditProviderDispatchIntentV2);
}

export function createAuditProviderWorkerReceiptV2(input: {
  readonly descriptor: AuditProviderDescriptorV2;
  readonly dispatchIntent: AuditProviderDispatchIntentV2;
  readonly processIdentity: ProcessIdentity;
  readonly processGroupId: number | null;
  readonly startedAt: string;
}): AuditProviderWorkerReceiptV2 {
  assertDispatchBinding(input.descriptor, input.dispatchIntent);
  const base = {
    schema: RALPH_AUDIT_PROVIDER_WORKER_RECEIPT_SCHEMA_V2,
    ...coreBinding(input.descriptor),
    descriptorRef: auditProviderDescriptorRefV2(input.descriptor.attemptId),
    descriptorDigest: input.descriptor.descriptorDigest,
    dispatchIntentRef: auditProviderDispatchIntentRefV2(input.descriptor.attemptId),
    dispatchIntentDigest: input.dispatchIntent.intentDigest,
    dispatchId: input.dispatchIntent.dispatchId,
    processIdentity: { ...input.processIdentity },
    processGroupId: input.processGroupId,
    startedAt: input.startedAt,
  };
  return freeze({ ...base, receiptDigest: sha256Canonical(base) }, validateAuditProviderWorkerReceiptV2);
}

export function createAuditProviderSessionBindingV2(input: {
  readonly descriptor: AuditProviderDescriptorV2;
  readonly dispatchIntent: AuditProviderDispatchIntentV2;
  readonly workerReceipt: AuditProviderWorkerReceiptV2;
  readonly openCodeSessionId: string;
  readonly boundAt: string;
}): AuditProviderSessionBindingV2 {
  assertWorkerBinding(input.descriptor, input.dispatchIntent, input.workerReceipt);
  const base = {
    schema: RALPH_AUDIT_PROVIDER_SESSION_BINDING_SCHEMA_V2,
    ...coreBinding(input.descriptor),
    descriptorRef: auditProviderDescriptorRefV2(input.descriptor.attemptId),
    descriptorDigest: input.descriptor.descriptorDigest,
    dispatchIntentRef: auditProviderDispatchIntentRefV2(input.descriptor.attemptId),
    dispatchIntentDigest: input.dispatchIntent.intentDigest,
    workerReceiptRef: auditProviderWorkerReceiptRefV2(input.descriptor.attemptId),
    workerReceiptDigest: input.workerReceipt.receiptDigest,
    openCodeSessionId: input.openCodeSessionId,
    modelSelector: input.descriptor.modelSelector,
    boundAt: input.boundAt,
  };
  return freeze({ ...base, bindingDigest: sha256Canonical(base) }, validateAuditProviderSessionBindingV2);
}

export function createAuditProviderPromptArtifactV2(input: Omit<AuditProviderPromptArtifactV2, "schema" | "artifactDigest">): AuditProviderPromptArtifactV2 {
  const base = { schema: RALPH_AUDIT_PROVIDER_PROMPT_SCHEMA_V2, ...input };
  return freeze({ ...base, artifactDigest: sha256Canonical(base) }, validateAuditProviderPromptArtifactV2);
}

export function createAuditProviderResultV2(input: Omit<AuditProviderResultV2, "schema" | "proposalDigest" | "resultDigest">): AuditProviderResultV2 {
  const base = { schema: RALPH_AUDIT_PROVIDER_RESULT_SCHEMA_V2, ...input, proposalDigest: auditProposalDigestV2(input.proposal) };
  return freeze({ ...base, resultDigest: sha256Canonical(base) }, validateAuditProviderResultV2);
}

export function createAuditProviderTerminalArtifactV2(input: Omit<AuditProviderTerminalArtifactV2, "schema" | "descriptorRef" | "dispatchIntentRef" | "workerReceiptRef" | "sessionBindingRef" | "resultRef" | "terminalDigest" | "quiescence"> & {
  readonly quiescence: Omit<AuditProviderTerminalQuiescenceV2, "evidenceDigest">;
}): AuditProviderTerminalArtifactV2 {
  const quiescenceBase = { ...input.quiescence };
  if (!["ABSENT", "QUIESCENCE_UNKNOWN"].includes(quiescenceBase.workerProcessState) || !["QUIESCENT", "UNKNOWN"].includes(quiescenceBase.processTreeState)) throw invalid("terminal quiescence");
  if ((quiescenceBase.workerProcessState === "ABSENT") !== (quiescenceBase.processTreeState === "QUIESCENT")) throw invalid("inconsistent terminal quiescence");
  const { quiescence: _ignored, ...rest } = input;
  const base = {
    schema: RALPH_AUDIT_PROVIDER_TERMINAL_SCHEMA_V2,
    ...rest,
    descriptorRef: auditProviderDescriptorRefV2(input.attemptId),
    dispatchIntentRef: auditProviderDispatchIntentRefV2(input.attemptId),
    workerReceiptRef: auditProviderWorkerReceiptRefV2(input.attemptId),
    sessionBindingRef: auditProviderSessionBindingRefV2(input.attemptId),
    resultRef: auditProviderResultRefV2(input.attemptId),
    quiescence: { ...quiescenceBase, evidenceDigest: sha256Canonical(quiescenceBase) },
  };
  return freeze({ ...base, terminalDigest: sha256Canonical(base) }, validateAuditProviderTerminalArtifactV2);
}

export function validateAuditProviderDescriptorV2(value: unknown): asserts value is AuditProviderDescriptorV2 {
  const record = requireRecord(value);
  assertExactKeys(record, ["schema", "role", "transport", ...CORE_KEYS, "auditPackageId", "auditPackageDigest", "auditorRuntimeIdentity", "auditorProfileId", "auditorProfileIdentity", "auditorProfileDigest", "modelSelector", "openCodeExecutablePath", "openCodeExecutableVersion", "openCodeExecutableIdentity", "conformanceProfileId", "conformanceRecordDigest", "conformanceExecutableVersion", "conformanceState", "permissionsDigest", "timeoutPolicyDigest", "projectRootIdentity", "baseWorkspaceFingerprint", "createdAt", "descriptorDigest"]);
  if (record.schema !== RALPH_AUDIT_PROVIDER_DESCRIPTOR_SCHEMA_V2) throw invalid("descriptor schema");
  if (record.role !== OPENCODE_CLI_AUDITOR_ROLE_V2 || record.transport !== OPENCODE_CLI_AUDITOR_TRANSPORT_V2) throw invalid("descriptor role");
  validateCoreBinding(record);
  assertSafeText(record.auditPackageId, false);
  for (const key of ["auditPackageDigest", "auditorProfileDigest", "openCodeExecutableIdentity", "conformanceRecordDigest", "permissionsDigest", "timeoutPolicyDigest", "projectRootIdentity", "baseWorkspaceFingerprint", "descriptorDigest"] as const) assertDigest(record[key]);
  if (typeof record.auditorRuntimeIdentity !== "string" || !/^opencode-cli-auditor-runtime-[0-9a-f]{64}$/.test(record.auditorRuntimeIdentity)) throw invalid("auditor runtime identity");
  if (record.auditorProfileId !== OPENCODE_CLI_AUDITOR_CORE_PROFILE_ID_V2
    || record.auditorProfileIdentity !== OPENCODE_CLI_AUDITOR_PROFILE_V2
    || record.modelSelector !== OPENCODE_CLI_AUDITOR_MODEL_V2) throw invalid("auditor profile binding");
  if (record.conformanceProfileId !== OPENCODE_CLI_AUDITOR_PROFILE_V2 || record.conformanceState !== "MATCH") throw invalid("conformance binding");
  assertSafeText(record.conformanceExecutableVersion, false);
  assertSafeText(record.openCodeExecutableVersion, false);
  if (record.conformanceExecutableVersion !== record.openCodeExecutableVersion) throw invalid("conformance version");
  if (typeof record.openCodeExecutablePath !== "string" || record.openCodeExecutablePath.length === 0 || record.openCodeExecutablePath.length > 4096 || resolve(record.openCodeExecutablePath) !== record.openCodeExecutablePath) throw invalid("executable path");
  if (record.openCodeExecutableIdentity !== sha256Canonical({ transport: OPENCODE_CLI_AUDITOR_TRANSPORT_V2, executablePath: record.openCodeExecutablePath, executableVersion: record.openCodeExecutableVersion })) throw invalid("executable identity");
  assertTimestamp(record.createdAt);
  assertOwnDigest(record, "descriptorDigest");
  assertArtifactSecurity(record);
}

export function validateAuditProviderDispatchIntentV2(value: unknown): asserts value is AuditProviderDispatchIntentV2 {
  const record = requireRecord(value);
  assertExactKeys(record, ["schema", ...CORE_KEYS, "descriptorRef", "descriptorDigest", "dispatchId", "openCodeUserMessageId", "createdAt", "intentDigest"]);
  if (record.schema !== RALPH_AUDIT_PROVIDER_DISPATCH_INTENT_SCHEMA_V2) throw invalid("intent schema");
  validateCoreBinding(record);
  if (record.descriptorRef !== auditProviderDescriptorRefV2(String(record.attemptId))) throw invalid("intent descriptor ref");
  assertDigest(record.descriptorDigest);
  if (typeof record.dispatchId !== "string" || !/^audit-dispatch-[0-9a-f]{64}$/.test(record.dispatchId)) throw invalid("dispatch id");
  if (typeof record.openCodeUserMessageId !== "string" || !/^msg_ralph_audit_[0-9a-f]{32}$/.test(record.openCodeUserMessageId)) throw invalid("audit user message id");
  assertTimestamp(record.createdAt);
  assertOwnDigest(record, "intentDigest");
  assertArtifactSecurity(record);
}

export function validateAuditProviderWorkerReceiptV2(value: unknown): asserts value is AuditProviderWorkerReceiptV2 {
  const record = requireRecord(value);
  assertExactKeys(record, ["schema", ...CORE_KEYS, "descriptorRef", "descriptorDigest", "dispatchIntentRef", "dispatchIntentDigest", "dispatchId", "processIdentity", "processGroupId", "startedAt", "receiptDigest"]);
  if (record.schema !== RALPH_AUDIT_PROVIDER_WORKER_RECEIPT_SCHEMA_V2) throw invalid("worker schema");
  validateCoreBinding(record);
  assertChainRefs(record, false);
  assertDigest(record.descriptorDigest);
  assertDigest(record.dispatchIntentDigest);
  if (typeof record.dispatchId !== "string" || !/^audit-dispatch-[0-9a-f]{64}$/.test(record.dispatchId)) throw invalid("worker dispatch id");
  validateProcessIdentity(record.processIdentity);
  if (record.processGroupId !== null && (!Number.isSafeInteger(record.processGroupId) || (record.processGroupId as number) < 1)) throw invalid("worker process group");
  assertTimestamp(record.startedAt);
  assertOwnDigest(record, "receiptDigest");
  assertArtifactSecurity(record);
}

export function validateAuditProviderSessionBindingV2(value: unknown): asserts value is AuditProviderSessionBindingV2 {
  const record = requireRecord(value);
  assertExactKeys(record, ["schema", ...CORE_KEYS, "descriptorRef", "descriptorDigest", "dispatchIntentRef", "dispatchIntentDigest", "workerReceiptRef", "workerReceiptDigest", "openCodeSessionId", "modelSelector", "boundAt", "bindingDigest"]);
  if (record.schema !== RALPH_AUDIT_PROVIDER_SESSION_BINDING_SCHEMA_V2) throw invalid("session schema");
  validateCoreBinding(record);
  assertChainRefs(record, true);
  for (const key of ["descriptorDigest", "dispatchIntentDigest", "workerReceiptDigest"] as const) assertDigest(record[key]);
  assertSessionId(record.openCodeSessionId);
  if (record.modelSelector !== OPENCODE_CLI_AUDITOR_MODEL_V2) throw invalid("session model");
  assertTimestamp(record.boundAt);
  assertOwnDigest(record, "bindingDigest");
  assertArtifactSecurity(record);
}

export function validateAuditProviderPromptArtifactV2(value: unknown): asserts value is AuditProviderPromptArtifactV2 {
  const record = requireRecord(value);
  assertExactKeys(record, ["schema", ...CORE_KEYS, "descriptorDigest", "dispatchIntentDigest", "sessionBindingDigest", "auditPackageId", "auditPackageDigest", "openCodeSessionId", "openCodeUserMessageId", "modelSelector", "promptDigest", "promptBytes", "preparedAt", "artifactDigest"]);
  if (record.schema !== RALPH_AUDIT_PROVIDER_PROMPT_SCHEMA_V2) throw invalid("prompt schema");
  validateCoreBinding(record);
  for (const key of ["descriptorDigest", "dispatchIntentDigest", "sessionBindingDigest", "auditPackageDigest", "promptDigest", "artifactDigest"] as const) assertDigest(record[key]);
  assertSafeText(record.auditPackageId, false);
  assertSessionId(record.openCodeSessionId);
  assertAuditMessageId(record.openCodeUserMessageId);
  if (record.modelSelector !== OPENCODE_CLI_AUDITOR_MODEL_V2) throw invalid("prompt model");
  if (!Number.isSafeInteger(record.promptBytes) || Number(record.promptBytes) < 1 || Number(record.promptBytes) > 64 * 1024) throw invalid("prompt bytes");
  assertTimestamp(record.preparedAt);
  assertOwnDigest(record, "artifactDigest");
  assertArtifactSecurity(record);
}

export function validateAuditProviderResultV2(value: unknown): asserts value is AuditProviderResultV2 {
  const record = requireRecord(value);
  assertExactKeys(record, ["schema", ...CORE_KEYS, "descriptorDigest", "dispatchIntentDigest", "sessionBindingDigest", "promptArtifactDigest", "auditPackageId", "auditPackageDigest", "openCodeSessionId", "openCodeUserMessageId", "assistantMessageId", "observedModelSelector", "classification", "assistantContentDigest", "responseDigest", "observableTurnDigest", "proposal", "proposalDigest", "startedAt", "finishedAt", "resultDigest"]);
  if (record.schema !== RALPH_AUDIT_PROVIDER_RESULT_SCHEMA_V2) throw invalid("result schema");
  validateCoreBinding(record);
  for (const key of ["descriptorDigest", "dispatchIntentDigest", "sessionBindingDigest", "promptArtifactDigest", "auditPackageDigest", "assistantContentDigest", "responseDigest", "observableTurnDigest", "proposalDigest", "resultDigest"] as const) assertDigest(record[key]);
  assertSafeText(record.auditPackageId, false);
  assertSessionId(record.openCodeSessionId);
  assertAuditMessageId(record.openCodeUserMessageId);
  if (typeof record.assistantMessageId !== "string" || !/^msg_[A-Za-z0-9_-]{3,128}$/.test(record.assistantMessageId)) throw invalid("assistant message id");
  if (record.observedModelSelector !== OPENCODE_CLI_AUDITOR_MODEL_V2) throw invalid("result model");
  // Only a complete, positively observed provider turn may become a durable
  // audit provider result. Interrupted physical states never carry a proposal.
  if (record.classification !== "SUCCEEDED") throw invalid("result classification");
  validateDurableProposal(record.proposal);
  if (record.proposalDigest !== auditProposalDigestV2(record.proposal as OpenCodeAuditProposalV2)) throw invalid("proposal digest");
  assertTimestamp(record.startedAt);
  assertTimestamp(record.finishedAt);
  assertOwnDigest(record, "resultDigest");
  assertArtifactSecurity(record);
}

export function validateAuditProviderTerminalArtifactV2(value: unknown): asserts value is AuditProviderTerminalArtifactV2 {
  const record = requireRecord(value);
  assertExactKeys(record, ["schema", ...CORE_KEYS, "descriptorRef", "descriptorDigest", "dispatchIntentRef", "dispatchIntentDigest", "workerReceiptRef", "workerReceiptDigest", "sessionBindingRef", "sessionBindingDigest", "openCodeSessionId", "status", "termination", "exitCode", "signal", "timedOut", "cancelled", "resultRef", "resultDigest", "workspaceFingerprintBefore", "workspaceFingerprintAfter", "finishedAt", "quiescence", "terminalDigest"]);
  if (record.schema !== RALPH_AUDIT_PROVIDER_TERMINAL_SCHEMA_V2) throw invalid("terminal schema");
  validateCoreBinding(record);
  assertChainRefs(record, true);
  if (record.sessionBindingRef !== auditProviderSessionBindingRefV2(String(record.attemptId))) throw invalid("terminal session ref");
  if (record.resultRef !== auditProviderResultRefV2(String(record.attemptId))) throw invalid("terminal result ref");
  for (const key of ["descriptorDigest", "dispatchIntentDigest", "workerReceiptDigest", "sessionBindingDigest", "resultDigest", "workspaceFingerprintBefore", "workspaceFingerprintAfter", "terminalDigest"] as const) assertDigest(record[key]);
  assertSessionId(record.openCodeSessionId);
  if (!EXECUTOR_STATUSES.includes(record.status as ExecutorStatus) || !EXECUTOR_TERMINATIONS.includes(record.termination as ExecutorTermination)) throw invalid("terminal termination");
  if (record.exitCode !== null && (!Number.isSafeInteger(record.exitCode) || (record.exitCode as number) < -1)) throw invalid("terminal exit code");
  if (record.signal !== null && (typeof record.signal !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(record.signal))) throw invalid("terminal signal");
  if (record.timedOut !== false || record.cancelled !== false) throw invalid("terminal flags");
  // The Auditor is read-only. A terminal artifact that does not prove an
  // unchanged workspace is not a valid terminal at all.
  if (record.workspaceFingerprintBefore !== record.workspaceFingerprintAfter) throw invalid("terminal workspace mutation");
  assertTimestamp(record.finishedAt);
  validateTerminalQuiescence(record.quiescence);
  assertOwnDigest(record, "terminalDigest");
  assertArtifactSecurity(record);
}

export async function persistAuditProviderDescriptorV2(store: RalphEventStoreV2, value: AuditProviderDescriptorV2, nonce: string): Promise<ArtifactPersistenceResultV2<AuditProviderDescriptorV2>> {
  validateAuditProviderDescriptorV2(value);
  assertStore(store, value);
  if (value.projectRootIdentity !== sha256Canonical({ projectRoot: resolve(store.projectRoot) })) throw invalid("descriptor project root");
  return persistImmutableJsonArtifactV2({ store, ref: auditProviderDescriptorRefV2(value.attemptId), artifact: value, validate: validateAuditProviderDescriptorV2, nonce });
}

export async function persistAuditProviderDispatchIntentV2(store: RalphEventStoreV2, value: AuditProviderDispatchIntentV2, nonce: string): Promise<ArtifactPersistenceResultV2<AuditProviderDispatchIntentV2>> {
  validateAuditProviderDispatchIntentV2(value);
  assertStore(store, value);
  assertDispatchBinding(await requireDescriptor(store, value.attemptId), value);
  return persistImmutableJsonArtifactV2({ store, ref: auditProviderDispatchIntentRefV2(value.attemptId), artifact: value, validate: validateAuditProviderDispatchIntentV2, nonce });
}

export async function persistAuditProviderWorkerReceiptV2(store: RalphEventStoreV2, value: AuditProviderWorkerReceiptV2, nonce: string): Promise<ArtifactPersistenceResultV2<AuditProviderWorkerReceiptV2>> {
  validateAuditProviderWorkerReceiptV2(value);
  assertStore(store, value);
  assertWorkerBinding(await requireDescriptor(store, value.attemptId), await requireDispatchIntent(store, value.attemptId), value);
  return persistImmutableJsonArtifactV2({ store, ref: auditProviderWorkerReceiptRefV2(value.attemptId), artifact: value, validate: validateAuditProviderWorkerReceiptV2, nonce });
}

export async function persistAuditProviderSessionBindingV2(store: RalphEventStoreV2, value: AuditProviderSessionBindingV2, nonce: string): Promise<ArtifactPersistenceResultV2<AuditProviderSessionBindingV2>> {
  validateAuditProviderSessionBindingV2(value);
  assertStore(store, value);
  assertSessionBinding(await requireDescriptor(store, value.attemptId), await requireDispatchIntent(store, value.attemptId), await requireWorkerReceipt(store, value.attemptId), value);
  return persistImmutableJsonArtifactV2({ store, ref: auditProviderSessionBindingRefV2(value.attemptId), artifact: value, validate: validateAuditProviderSessionBindingV2, nonce });
}

export async function persistAuditProviderPromptArtifactV2(store: RalphEventStoreV2, value: AuditProviderPromptArtifactV2, nonce: string): Promise<ArtifactPersistenceResultV2<AuditProviderPromptArtifactV2>> {
  validateAuditProviderPromptArtifactV2(value);
  assertStore(store, value);
  const descriptor = await requireDescriptor(store, value.attemptId);
  const intent = await requireDispatchIntent(store, value.attemptId);
  const session = await requireSessionBinding(store, value.attemptId);
  assertSessionBinding(descriptor, intent, await requireWorkerReceipt(store, value.attemptId), session);
  if (value.descriptorDigest !== descriptor.descriptorDigest || value.dispatchIntentDigest !== intent.intentDigest
    || value.sessionBindingDigest !== session.bindingDigest || value.openCodeSessionId !== session.openCodeSessionId
    || value.openCodeUserMessageId !== intent.openCodeUserMessageId || value.modelSelector !== descriptor.modelSelector
    || value.auditPackageId !== descriptor.auditPackageId || value.auditPackageDigest !== descriptor.auditPackageDigest
    || !sameCoreBinding(value, descriptor)) throw invalid("prompt binding");
  return persistImmutableJsonArtifactV2({ store, ref: auditProviderPromptRefV2(value.attemptId), artifact: value, validate: validateAuditProviderPromptArtifactV2, nonce });
}

export async function persistAuditProviderResultV2(store: RalphEventStoreV2, value: AuditProviderResultV2, nonce: string): Promise<ArtifactPersistenceResultV2<AuditProviderResultV2>> {
  validateAuditProviderResultV2(value);
  assertStore(store, value);
  const descriptor = await requireDescriptor(store, value.attemptId);
  const intent = await requireDispatchIntent(store, value.attemptId);
  const session = await requireSessionBinding(store, value.attemptId);
  const prompt = await readAuditProviderPromptArtifactV2(store, value.attemptId);
  if (!prompt || value.descriptorDigest !== descriptor.descriptorDigest || value.dispatchIntentDigest !== intent.intentDigest
    || value.sessionBindingDigest !== session.bindingDigest || value.promptArtifactDigest !== prompt.artifactDigest
    || value.openCodeSessionId !== session.openCodeSessionId || value.openCodeUserMessageId !== intent.openCodeUserMessageId
    || value.observedModelSelector !== descriptor.modelSelector
    || value.auditPackageId !== descriptor.auditPackageId || value.auditPackageDigest !== descriptor.auditPackageDigest
    || !sameCoreBinding(value, descriptor)) throw invalid("result binding");
  return persistImmutableJsonArtifactV2({ store, ref: auditProviderResultRefV2(value.attemptId), artifact: value, validate: validateAuditProviderResultV2, nonce });
}

export async function persistAuditProviderTerminalArtifactV2(store: RalphEventStoreV2, value: AuditProviderTerminalArtifactV2, nonce: string): Promise<ArtifactPersistenceResultV2<AuditProviderTerminalArtifactV2>> {
  validateAuditProviderTerminalArtifactV2(value);
  assertStore(store, value);
  const descriptor = await requireDescriptor(store, value.attemptId);
  const intent = await requireDispatchIntent(store, value.attemptId);
  const worker = await requireWorkerReceipt(store, value.attemptId);
  const session = await requireSessionBinding(store, value.attemptId);
  const result = await readAuditProviderResultV2(store, value.attemptId);
  assertSessionBinding(descriptor, intent, worker, session);
  if (!result || value.descriptorDigest !== descriptor.descriptorDigest || value.dispatchIntentDigest !== intent.intentDigest
    || value.workerReceiptDigest !== worker.receiptDigest || value.sessionBindingDigest !== session.bindingDigest
    || value.openCodeSessionId !== session.openCodeSessionId || value.resultDigest !== result.resultDigest
    || value.workspaceFingerprintBefore !== descriptor.baseWorkspaceFingerprint
    || !sameCoreBinding(value, descriptor)) throw invalid("terminal binding");
  return persistImmutableJsonArtifactV2({ store, ref: auditProviderTerminalRefV2(value.attemptId), artifact: value, validate: validateAuditProviderTerminalArtifactV2, nonce });
}

export async function readAuditProviderDescriptorV2(store: RalphEventStoreV2, attemptId: string): Promise<AuditProviderDescriptorV2 | undefined> {
  return readImmutableJsonArtifactV2({ store, ref: auditProviderDescriptorRefV2(attemptId), validate: validateAuditProviderDescriptorV2 });
}
export async function readAuditProviderDispatchIntentV2(store: RalphEventStoreV2, attemptId: string): Promise<AuditProviderDispatchIntentV2 | undefined> {
  return readImmutableJsonArtifactV2({ store, ref: auditProviderDispatchIntentRefV2(attemptId), validate: validateAuditProviderDispatchIntentV2 });
}
export async function readAuditProviderWorkerReceiptV2(store: RalphEventStoreV2, attemptId: string): Promise<AuditProviderWorkerReceiptV2 | undefined> {
  return readImmutableJsonArtifactV2({ store, ref: auditProviderWorkerReceiptRefV2(attemptId), validate: validateAuditProviderWorkerReceiptV2 });
}
export async function readAuditProviderSessionBindingV2(store: RalphEventStoreV2, attemptId: string): Promise<AuditProviderSessionBindingV2 | undefined> {
  return readImmutableJsonArtifactV2({ store, ref: auditProviderSessionBindingRefV2(attemptId), validate: validateAuditProviderSessionBindingV2 });
}
export async function readAuditProviderPromptArtifactV2(store: RalphEventStoreV2, attemptId: string): Promise<AuditProviderPromptArtifactV2 | undefined> {
  return readImmutableJsonArtifactV2({ store, ref: auditProviderPromptRefV2(attemptId), validate: validateAuditProviderPromptArtifactV2 });
}
export async function readAuditProviderResultV2(store: RalphEventStoreV2, attemptId: string): Promise<AuditProviderResultV2 | undefined> {
  return readImmutableJsonArtifactV2({ store, ref: auditProviderResultRefV2(attemptId), validate: validateAuditProviderResultV2 });
}
export async function readAuditProviderTerminalArtifactV2(store: RalphEventStoreV2, attemptId: string): Promise<AuditProviderTerminalArtifactV2 | undefined> {
  return readImmutableJsonArtifactV2({ store, ref: auditProviderTerminalRefV2(attemptId), validate: validateAuditProviderTerminalArtifactV2 });
}

/**
 * Read the whole durable audit provider chain and prove it is internally
 * consistent. An orphan artifact is an ambiguous physical state, never an
 * empty one.
 */
export async function readAuditProviderArtifactSetV2(store: RalphEventStoreV2, attemptId: string): Promise<AuditProviderArtifactSetV2> {
  const descriptor = await readAuditProviderDescriptorV2(store, attemptId);
  const dispatchIntent = await readAuditProviderDispatchIntentV2(store, attemptId);
  const workerReceipt = await readAuditProviderWorkerReceiptV2(store, attemptId);
  const sessionBinding = await readAuditProviderSessionBindingV2(store, attemptId);
  const prompt = await readAuditProviderPromptArtifactV2(store, attemptId);
  const result = await readAuditProviderResultV2(store, attemptId);
  const terminal = await readAuditProviderTerminalArtifactV2(store, attemptId);
  if (!descriptor) {
    if (dispatchIntent || workerReceipt || sessionBinding || prompt || result || terminal) throw invalid("orphan audit provider artifact");
    return {};
  }
  assertStore(store, descriptor);
  if (dispatchIntent) assertDispatchBinding(descriptor, dispatchIntent);
  if (workerReceipt) {
    if (!dispatchIntent) throw invalid("worker without dispatch intent");
    assertWorkerBinding(descriptor, dispatchIntent, workerReceipt);
  }
  if (sessionBinding) {
    if (!dispatchIntent || !workerReceipt) throw invalid("session without worker");
    assertSessionBinding(descriptor, dispatchIntent, workerReceipt, sessionBinding);
  }
  if (prompt && (!sessionBinding || prompt.sessionBindingDigest !== sessionBinding.bindingDigest || prompt.descriptorDigest !== descriptor.descriptorDigest)) throw invalid("prompt without session");
  if (result && (!prompt || result.promptArtifactDigest !== prompt.artifactDigest || result.descriptorDigest !== descriptor.descriptorDigest)) throw invalid("result without prompt");
  if (terminal && (!result || terminal.resultDigest !== result.resultDigest || terminal.descriptorDigest !== descriptor.descriptorDigest)) throw invalid("terminal without result");
  return {
    descriptor,
    ...(dispatchIntent ? { dispatchIntent } : {}),
    ...(workerReceipt ? { workerReceipt } : {}),
    ...(sessionBinding ? { sessionBinding } : {}),
    ...(prompt ? { prompt } : {}),
    ...(result ? { result } : {}),
    ...(terminal ? { terminal } : {}),
  };
}

export function auditPackageBindsDescriptorV2(descriptor: AuditProviderDescriptorV2, auditPackage: AuditPackageV2, auditPackageId: string): boolean {
  return descriptor.runId === auditPackage.runId
    && descriptor.phaseId === auditPackage.phaseId
    && descriptor.taskId === auditPackage.taskId
    && descriptor.attemptId === auditPackage.attemptId
    && descriptor.auditPackageId === auditPackageId
    && descriptor.auditPackageDigest === auditPackage.packageDigest;
}

function validateDurableProposal(value: unknown): void {
  const record = requireRecord(value);
  assertExactKeys(record, ["verdict", "proposedFindings", "resolvedFindingRefs", "rationale"]);
  if (record.verdict !== "ACCEPT" && record.verdict !== "REJECT") throw invalid("proposal verdict");
  if (!Array.isArray(record.proposedFindings) || record.proposedFindings.length > MAX_AUDIT_PROPOSED_FINDINGS_V2) throw invalid("proposal findings");
  if (!Array.isArray(record.resolvedFindingRefs) || record.resolvedFindingRefs.length > MAX_AUDIT_RESOLVED_REFS_V2) throw invalid("proposal resolutions");
  for (const reference of record.resolvedFindingRefs) {
    if (typeof reference !== "string" || !/^finding-[0-9a-f]{64}$/.test(reference)) throw invalid("proposal resolution reference");
  }
  if (typeof record.rationale !== "string" || record.rationale.length === 0 || record.rationale.length > MAX_AUDIT_RATIONALE_V2) throw invalid("proposal rationale");
  for (const finding of record.proposedFindings) {
    const item = requireRecord(finding);
    assertExactKeys(item, ["criterionId", "structuredFindingKey", "severity", "scope", "expectation", "observed", "remediationHint", "rootCauseGroup"]);
    if (typeof item.criterionId !== "string" || !/^criterion:[1-9][0-9]{0,2}$/.test(item.criterionId)) throw invalid("proposal criterion");
    if (typeof item.structuredFindingKey !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,63}$/.test(item.structuredFindingKey)) throw invalid("proposal finding key");
  }
  if (record.verdict === "ACCEPT" && record.proposedFindings.length > 0) throw invalid("proposal ACCEPT carries Findings");
  if (record.verdict === "REJECT" && record.proposedFindings.length === 0) throw invalid("proposal REJECT carries no Finding");
}

function validateProcessIdentity(value: unknown): asserts value is ProcessIdentity {
  const record = requireRecord(value);
  assertExactKeys(record, ["pid", "processStartIdentity", "hostIdentity", "bootSessionIdentity"]);
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) < 1) throw invalid("process identity pid");
  for (const key of ["processStartIdentity", "hostIdentity", "bootSessionIdentity"] as const) assertSafeText(record[key], false);
}

function validateTerminalQuiescence(value: unknown): void {
  const record = requireRecord(value);
  assertExactKeys(record, ["workerProcessState", "processTreeState", "observedAt", "evidenceDigest"]);
  if (record.workerProcessState !== "ABSENT" || record.processTreeState !== "QUIESCENT") throw invalid("terminal quiescence is not positive");
  assertTimestamp(record.observedAt);
  assertDigest(record.evidenceDigest);
  const { evidenceDigest: _ignored, ...base } = record;
  if (sha256Canonical(base) !== record.evidenceDigest) throw invalid("terminal quiescence digest");
}

function assertDispatchBinding(descriptor: AuditProviderDescriptorV2, intent: AuditProviderDispatchIntentV2): void {
  validateAuditProviderDescriptorV2(descriptor);
  validateAuditProviderDispatchIntentV2(intent);
  const hash = sha256Canonical({
    role: OPENCODE_CLI_AUDITOR_ROLE_V2,
    auditInvocationId: descriptor.auditInvocationId,
    descriptorDigest: descriptor.descriptorDigest,
    auditorRuntimeIdentity: descriptor.auditorRuntimeIdentity,
  }).slice("sha256:".length);
  if (!sameCoreBinding(descriptor, intent) || intent.descriptorDigest !== descriptor.descriptorDigest
    || intent.dispatchId !== `audit-dispatch-${hash}` || intent.openCodeUserMessageId !== `msg_ralph_audit_${hash.slice(0, 32)}`) {
    throw invalid("dispatch binding");
  }
}

function assertWorkerBinding(descriptor: AuditProviderDescriptorV2, intent: AuditProviderDispatchIntentV2, worker: AuditProviderWorkerReceiptV2): void {
  assertDispatchBinding(descriptor, intent);
  validateAuditProviderWorkerReceiptV2(worker);
  if (!sameCoreBinding(descriptor, worker) || worker.descriptorDigest !== descriptor.descriptorDigest
    || worker.dispatchIntentDigest !== intent.intentDigest || worker.dispatchId !== intent.dispatchId) throw invalid("worker binding");
}

function assertSessionBinding(descriptor: AuditProviderDescriptorV2, intent: AuditProviderDispatchIntentV2, worker: AuditProviderWorkerReceiptV2, session: AuditProviderSessionBindingV2): void {
  assertWorkerBinding(descriptor, intent, worker);
  validateAuditProviderSessionBindingV2(session);
  if (!sameCoreBinding(descriptor, session) || session.descriptorDigest !== descriptor.descriptorDigest
    || session.dispatchIntentDigest !== intent.intentDigest || session.workerReceiptDigest !== worker.receiptDigest
    || session.modelSelector !== descriptor.modelSelector) throw invalid("session binding");
}

async function requireDescriptor(store: RalphEventStoreV2, attemptId: string): Promise<AuditProviderDescriptorV2> {
  const value = await readAuditProviderDescriptorV2(store, attemptId);
  if (!value) throw invalid("descriptor missing");
  assertStore(store, value);
  return value;
}
async function requireDispatchIntent(store: RalphEventStoreV2, attemptId: string): Promise<AuditProviderDispatchIntentV2> {
  const value = await readAuditProviderDispatchIntentV2(store, attemptId);
  if (!value) throw invalid("dispatch intent missing");
  return value;
}
async function requireWorkerReceipt(store: RalphEventStoreV2, attemptId: string): Promise<AuditProviderWorkerReceiptV2> {
  const value = await readAuditProviderWorkerReceiptV2(store, attemptId);
  if (!value) throw invalid("worker receipt missing");
  return value;
}
async function requireSessionBinding(store: RalphEventStoreV2, attemptId: string): Promise<AuditProviderSessionBindingV2> {
  const value = await readAuditProviderSessionBindingV2(store, attemptId);
  if (!value) throw invalid("session binding missing");
  return value;
}

function coreBinding(value: AuditProviderCoreBindingV2): AuditProviderCoreBindingV2 {
  return { runId: value.runId, phaseId: value.phaseId, taskId: value.taskId, attemptId: value.attemptId, auditInvocationId: value.auditInvocationId };
}

function sameCoreBinding(left: AuditProviderCoreBindingV2, right: AuditProviderCoreBindingV2): boolean {
  return CORE_KEYS.every((key) => left[key] === right[key]);
}

function validateCoreBinding(record: Record<string, unknown>): void {
  for (const key of CORE_KEYS) assertSafeText(record[key], false);
  if (typeof record.auditInvocationId !== "string" || !/^audit-[0-9a-f]{64}$/.test(record.auditInvocationId)) throw invalid("audit invocation id");
}

function assertChainRefs(record: Record<string, unknown>, includeWorker: boolean): void {
  const attemptId = String(record.attemptId);
  if (record.descriptorRef !== auditProviderDescriptorRefV2(attemptId) || record.dispatchIntentRef !== auditProviderDispatchIntentRefV2(attemptId)) throw invalid("chain ref");
  if (includeWorker && record.workerReceiptRef !== auditProviderWorkerReceiptRefV2(attemptId)) throw invalid("worker ref");
}

function assertStore(store: RalphEventStoreV2, value: AuditProviderCoreBindingV2): void {
  if (store.runId !== value.runId) throw invalid("store binding");
}

function assertOwnDigest(record: Record<string, unknown>, field: string): void {
  assertDigest(record[field]);
  const { [field]: _ignored, ...base } = record;
  if (sha256Canonical(base) !== record[field]) throw invalid(`${field} mismatch`);
}

function assertArtifactSecurity(record: Record<string, unknown>): void {
  if (Buffer.byteLength(canonicalJson(record), "utf8") > 32 * 1024) throw invalid("artifact oversized");
  try { assertNoCredentialMaterial(record, "M4D_PROVIDER_CREDENTIAL_MATERIAL"); }
  catch (error) {
    if (error instanceof RalphCredentialSafetyError) throw m4d("M4D_PROVIDER_CREDENTIAL_MATERIAL", "M4D_PROVIDER_CREDENTIAL_MATERIAL", error);
    throw error;
  }
}

function assertSessionId(value: unknown): void {
  if (typeof value !== "string" || !/^ses_[A-Za-z0-9_-]{8,128}$/.test(value)) throw invalid("session id");
}

function assertAuditMessageId(value: unknown): void {
  if (typeof value !== "string" || !/^msg_ralph_audit_[0-9a-f]{32}$/.test(value)) throw invalid("audit user message id");
}

function assertTimestamp(value: unknown): void {
  if (typeof value !== "string" || value.length < 20 || value.length > 64 || !Number.isFinite(Date.parse(value))) throw invalid("timestamp");
}

function assertSafeText(value: unknown, slashAllowed: boolean): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || (!slashAllowed && value.includes("/"))) throw invalid("text");
}

function assertDigest(value: unknown): void {
  if (!isSha256Digest(value)) throw invalid("digest");
}

function assertExactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw invalid(`unknown fields ${unknown.sort().join(",")}`);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid("record");
  return value as Record<string, unknown>;
}

function freeze<T>(value: T, validate: (candidate: unknown) => asserts candidate is T): T {
  validate(value);
  return freezeDeep(value);
}

function freezeDeep<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  return value;
}

function invalid(message: string): Error {
  return m4d("M4D_PROVIDER_RESULT_INVALID", `M4D_AUDIT_PROVIDER_ARTIFACT_INVALID: ${message}`);
}
