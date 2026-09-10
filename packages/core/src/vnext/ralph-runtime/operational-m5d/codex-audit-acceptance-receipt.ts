import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { canonicalJson } from "../canonical-json.js";
import { isSha256Digest, sha256, sha256Canonical } from "../hashing.js";
import { m5d } from "./contract.js";

export const RALPH_M5D_ACCEPTANCE_RECEIPT_SCHEMA_V2 = "rb-ralph-m5d-acceptance-receipt/v1" as const;
export const M5D_RETENTION_NOTICE_V2 = "AUDIT EVIDENCE — DO NOT CLEAN UNTIL M5-D FREEZE" as const;

export interface CodexAuditAcceptanceReceiptV2 {
  readonly schema: typeof RALPH_M5D_ACCEPTANCE_RECEIPT_SCHEMA_V2;
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly attemptOneId: string;
  readonly attemptTwoId: string;
  readonly acceptanceCriteriaDigest: string;
  readonly attemptOneValidationSetDigest: string;
  readonly attemptOneValidationHardNegative: false;
  readonly auditorOneRuntimeIdentity: string;
  readonly auditorOneProfileDigest: string;
  readonly auditorOneCapabilityDigest: string;
  readonly auditorOneThreadId: string;
  readonly auditorOneWorkspaceFingerprintBefore: string;
  readonly auditorOneWorkspaceFingerprintAfter: string;
  readonly auditorOneProductFingerprintBefore: string;
  readonly auditorOneProductFingerprintAfter: string;
  readonly auditorOneControlFingerprintBefore: string;
  readonly auditorOneControlFingerprintAfter: string;
  readonly auditorOneVerdict: "REJECT";
  readonly auditorOneProposalDigest: string;
  readonly coreFindingId: string;
  readonly coreFindingDigest: string;
  readonly attemptOneClosure: "AUDIT_REJECTED";
  readonly freshRuntimeBoundary: true;
  readonly correctionContextDigest: string;
  readonly correctionProviderDescriptorDigest: string;
  readonly correctionThreadId: string;
  readonly correctionDeltaDigest: string;
  readonly correctionDeltaEntries: readonly string[];
  readonly correctionPublicationDigest: string;
  readonly attemptTwoValidationSetDigest: string;
  readonly attemptTwoValidationHardNegative: false;
  readonly auditorTwoRuntimeIdentity: string;
  readonly auditorTwoProfileDigest: string;
  readonly auditorTwoCapabilityDigest: string;
  readonly auditorTwoThreadId: string;
  readonly auditorTwoWorkspaceFingerprintBefore: string;
  readonly auditorTwoWorkspaceFingerprintAfter: string;
  readonly auditorTwoProductFingerprintBefore: string;
  readonly auditorTwoProductFingerprintAfter: string;
  readonly auditorTwoControlFingerprintBefore: string;
  readonly auditorTwoControlFingerprintAfter: string;
  readonly auditorTwoVerdict: "ACCEPT";
  readonly auditorTwoProposalDigest: string;
  readonly resolvedFindingRefs: readonly string[];
  readonly findingLifecycle: readonly ["OPEN", "CANDIDATE_RESOLVED", "RESOLVED"];
  readonly attemptTwoClosure: "AUDIT_ACCEPTED";
  readonly taskState: "COMPLETE";
  readonly runState: "COMPLETE";
  readonly managedRuntimeKind: "stock-codex-cli-managed";
  readonly managedRuntimeVersion: "0.153.4-rb.1";
  readonly managedRuntimeIdentityDigest: string;
  readonly requestedModel: "gpt-5.6-sol";
  readonly sandboxBackendPath: "/usr/bin/bwrap";
  readonly auditorPermissionShapeDigest: string;
  readonly auditorModelCallCount: 2;
  readonly executorCorrectionModelCallCount: 1;
  readonly totalModelCallCount: 3;
  readonly distinctThreadCount: 3;
  readonly retryCount: 0;
  readonly fallbackCount: 0;
  readonly credentialLeakage: false;
  readonly coldReopenIdentical: true;
  readonly completedRerunModelCallDelta: 0;
  readonly retainedProjectRoot: string;
  readonly retainedRunDirectory: string;
  readonly retainedStagingBase: string;
  readonly platform: "linux-x86_64";
  readonly unqualifiedPlatforms: readonly ["WSL2", "linux ARM", "macOS ARM", "macOS x64"];
  readonly retentionNotice: typeof M5D_RETENTION_NOTICE_V2;
  readonly observedAt: string;
  readonly receiptDigest: string;
}

export type BuildCodexAuditAcceptanceReceiptInputV2 = Omit<CodexAuditAcceptanceReceiptV2, "schema" | "retentionNotice" | "receiptDigest">;

const KEYS = Object.freeze([
  "schema", "runId", "phaseId", "taskId", "attemptOneId", "attemptTwoId", "acceptanceCriteriaDigest",
  "attemptOneValidationSetDigest", "attemptOneValidationHardNegative", "auditorOneRuntimeIdentity", "auditorOneProfileDigest",
  "auditorOneCapabilityDigest", "auditorOneThreadId", "auditorOneWorkspaceFingerprintBefore", "auditorOneWorkspaceFingerprintAfter",
  "auditorOneProductFingerprintBefore", "auditorOneProductFingerprintAfter", "auditorOneControlFingerprintBefore", "auditorOneControlFingerprintAfter",
  "auditorOneVerdict", "auditorOneProposalDigest", "coreFindingId", "coreFindingDigest", "attemptOneClosure", "freshRuntimeBoundary",
  "correctionContextDigest", "correctionProviderDescriptorDigest", "correctionThreadId", "correctionDeltaDigest", "correctionDeltaEntries",
  "correctionPublicationDigest", "attemptTwoValidationSetDigest", "attemptTwoValidationHardNegative", "auditorTwoRuntimeIdentity",
  "auditorTwoProfileDigest", "auditorTwoCapabilityDigest", "auditorTwoThreadId", "auditorTwoWorkspaceFingerprintBefore",
  "auditorTwoWorkspaceFingerprintAfter", "auditorTwoProductFingerprintBefore", "auditorTwoProductFingerprintAfter",
  "auditorTwoControlFingerprintBefore", "auditorTwoControlFingerprintAfter", "auditorTwoVerdict", "auditorTwoProposalDigest",
  "resolvedFindingRefs", "findingLifecycle", "attemptTwoClosure", "taskState", "runState", "managedRuntimeKind",
  "managedRuntimeVersion", "managedRuntimeIdentityDigest", "requestedModel", "sandboxBackendPath", "auditorPermissionShapeDigest",
  "auditorModelCallCount", "executorCorrectionModelCallCount", "totalModelCallCount", "distinctThreadCount", "retryCount", "fallbackCount",
  "credentialLeakage", "coldReopenIdentical", "completedRerunModelCallDelta", "retainedProjectRoot", "retainedRunDirectory",
  "retainedStagingBase", "platform", "unqualifiedPlatforms", "retentionNotice", "observedAt", "receiptDigest",
]);

export function buildCodexAuditAcceptanceReceiptV2(input: BuildCodexAuditAcceptanceReceiptInputV2): CodexAuditAcceptanceReceiptV2 {
  const base = { schema: RALPH_M5D_ACCEPTANCE_RECEIPT_SCHEMA_V2, ...input, retentionNotice: M5D_RETENTION_NOTICE_V2 };
  const receipt = Object.freeze({ ...base, receiptDigest: sha256Canonical(base) });
  validateCodexAuditAcceptanceReceiptV2(receipt);
  return receipt;
}

export function validateCodexAuditAcceptanceReceiptV2(value: unknown): asserts value is CodexAuditAcceptanceReceiptV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("record");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !KEYS.includes(key)) || KEYS.some((key) => !(key in record))) throw invalid("shape");
  if (record.schema !== RALPH_M5D_ACCEPTANCE_RECEIPT_SCHEMA_V2 || record.retentionNotice !== M5D_RETENTION_NOTICE_V2) throw invalid("schema");
  const serialized = canonicalJson(record);
  if (Buffer.byteLength(serialized, "utf8") > 64 * 1024) throw invalid("size");
  if (/Bearer\s+\S+|-----BEGIN[^-]*PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*\S+|\bsk-[A-Za-z0-9_-]{16,}/i.test(serialized)) throw m5d("M5D_PROVIDER_CREDENTIAL_MATERIAL", "M5D_ACCEPTANCE_RECEIPT_CREDENTIAL_MATERIAL");
  for (const value of Object.values(record)) for (const item of typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []) if (item.length > 512) throw invalid("field bound");
  const digestKeys = KEYS.filter((key) => key.toLowerCase().endsWith("digest") && key !== "receiptDigest");
  for (const key of digestKeys) if (!isSha256Digest(record[key])) throw invalid(`digest ${key}`);
  if (record.attemptOneValidationHardNegative !== false || record.attemptTwoValidationHardNegative !== false || record.auditorOneVerdict !== "REJECT" || record.auditorTwoVerdict !== "ACCEPT" || record.attemptOneClosure !== "AUDIT_REJECTED" || record.attemptTwoClosure !== "AUDIT_ACCEPTED" || record.taskState !== "COMPLETE" || record.runState !== "COMPLETE") throw invalid("closed loop");
  if (record.freshRuntimeBoundary !== true || record.coldReopenIdentical !== true || record.completedRerunModelCallDelta !== 0) throw invalid("restart/idempotence");
  if (record.auditorModelCallCount !== 2 || record.executorCorrectionModelCallCount !== 1 || record.totalModelCallCount !== 3 || record.distinctThreadCount !== 3 || record.retryCount !== 0 || record.fallbackCount !== 0) throw invalid("call/thread counts");
  if (new Set([record.auditorOneThreadId, record.correctionThreadId, record.auditorTwoThreadId]).size !== 3) throw invalid("thread isolation");
  for (const prefix of ["auditorOne", "auditorTwo"] as const) {
    if (record[`${prefix}WorkspaceFingerprintBefore`] !== record[`${prefix}WorkspaceFingerprintAfter`] || record[`${prefix}ProductFingerprintBefore`] !== record[`${prefix}ProductFingerprintAfter`] || record[`${prefix}ControlFingerprintBefore`] !== record[`${prefix}ControlFingerprintAfter`]) throw invalid("auditor workspace mutation");
  }
  if (canonicalJson(record.resolvedFindingRefs) !== canonicalJson([record.coreFindingId]) || canonicalJson(record.findingLifecycle) !== canonicalJson(["OPEN", "CANDIDATE_RESOLVED", "RESOLVED"])) throw invalid("Finding resolution");
  if (record.managedRuntimeKind !== "stock-codex-cli-managed" || record.managedRuntimeVersion !== "0.153.4-rb.1" || record.requestedModel !== "gpt-5.6-sol" || record.sandboxBackendPath !== "/usr/bin/bwrap" || record.platform !== "linux-x86_64") throw invalid("runtime/platform");
  if (record.credentialLeakage !== false) throw invalid("credential leakage");
  const { receiptDigest, ...base } = record;
  if (!isSha256Digest(receiptDigest) || sha256Canonical(base) !== receiptDigest) throw invalid("receipt digest");
}

export function codexAuditAcceptanceEvidenceRootV2(): string { return join(homedir(), ".local", "state", "rb-harness", "ralph-m5d-acceptance"); }
export async function writeCodexAuditAcceptanceReceiptV2(receipt: CodexAuditAcceptanceReceiptV2, evidenceRoot = codexAuditAcceptanceEvidenceRootV2()): Promise<{ readonly path: string; readonly receiptDigest: string; readonly fileDigest: string }> {
  validateCodexAuditAcceptanceReceiptV2(receipt);
  const root = resolve(evidenceRoot); if (!isAbsolute(root)) throw invalid("evidence root");
  const directory = join(root, receipt.runId); await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "acceptance-receipt.json"); const bytes = `${canonicalJson(receipt)}\n`; await writeFile(path, bytes, { mode: 0o600 });
  return Object.freeze({ path, receiptDigest: receipt.receiptDigest, fileDigest: sha256(bytes) });
}

function invalid(reason: string): Error { return m5d("M5D_ARTIFACT_INVALID", `M5D_ACCEPTANCE_RECEIPT_INVALID: ${reason}`); }
