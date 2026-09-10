import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { canonicalJson } from "../canonical-json.js";
import { isSha256Digest, sha256, sha256Canonical } from "../hashing.js";
import { RalphM5BError } from "./contract-errors.js";

/** Structural-only evidence retained for the single real M5-C correction. */
export const RALPH_M5C_ACCEPTANCE_RECEIPT_SCHEMA_V2 = "rb-ralph-m5c-acceptance-receipt/v1" as const;
export const M5C_RETENTION_NOTICE_V2 = "AUDIT EVIDENCE — DO NOT CLEAN UNTIL M5-C FREEZE" as const;

export interface CodexCorrectionAcceptanceReceiptV2 {
  readonly schema: typeof RALPH_M5C_ACCEPTANCE_RECEIPT_SCHEMA_V2;
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly rejectedAttemptId: string;
  readonly correctionAttemptId: string;
  readonly rejectedAttemptClosure: "AUDIT_REJECTED";
  readonly correctionAttemptClosure: "AUDIT_ACCEPTED";
  readonly findingId: string;
  readonly findingDigest: string;
  readonly findingFinalStatus: "RESOLVED";
  readonly correctionContextRef: string;
  readonly correctionContextDigest: string;
  readonly providerDescriptorDigest: string;
  readonly promptDigest: string;
  readonly threadId: string;
  readonly managedRuntimeKind: string;
  readonly managedRuntimeVersion: string;
  readonly managedRuntimeIdentityDigest: string;
  readonly requestedModel: string;
  readonly sandboxBackendPath: string;
  readonly permissionProfileDigest: string;
  readonly capabilityBindingDigest: string;
  readonly stagingRootWritable: true;
  readonly rootSentinelManifestDigest: string;
  readonly deltaDigest: string;
  readonly deltaEntries: readonly string[];
  readonly publicationDigest: string;
  readonly rejectedEvidenceDigest: string;
  readonly correctionEvidenceDigest: string;
  readonly rejectedValidationSetDigest: string;
  readonly correctionValidationSetDigest: string;
  readonly validationTransition: "FAIL_TO_PASS";
  readonly taskState: "COMPLETE";
  readonly runState: "COMPLETE";
  readonly runHold: "NONE";
  readonly providerInvocationCount: 1;
  readonly retryCount: 0;
  readonly fallbackCount: 0;
  readonly completedRerunProviderCallDelta: 0;
  readonly coldReopenIdentical: true;
  readonly controlPlaneCanariesIntact: true;
  readonly credentialLeakage: false;
  readonly retainedProjectRoot: string;
  readonly retainedRunDirectory: string;
  readonly retainedStagingBase: string;
  readonly platform: "linux-x86_64";
  readonly unqualifiedPlatforms: readonly ["WSL2", "macOS arm64", "macOS x64", "linux arm64"];
  readonly retentionNotice: typeof M5C_RETENTION_NOTICE_V2;
  readonly observedAt: string;
  readonly receiptDigest: string;
}

export type BuildCodexCorrectionAcceptanceReceiptInputV2 = Omit<
  CodexCorrectionAcceptanceReceiptV2,
  "schema" | "retentionNotice" | "receiptDigest"
>;

const KEYS = Object.freeze([
  "schema", "runId", "phaseId", "taskId", "rejectedAttemptId", "correctionAttemptId",
  "rejectedAttemptClosure", "correctionAttemptClosure", "findingId", "findingDigest", "findingFinalStatus",
  "correctionContextRef", "correctionContextDigest", "providerDescriptorDigest", "promptDigest", "threadId",
  "managedRuntimeKind", "managedRuntimeVersion", "managedRuntimeIdentityDigest", "requestedModel", "sandboxBackendPath",
  "permissionProfileDigest", "capabilityBindingDigest", "stagingRootWritable", "rootSentinelManifestDigest",
  "deltaDigest", "deltaEntries", "publicationDigest", "rejectedEvidenceDigest", "correctionEvidenceDigest",
  "rejectedValidationSetDigest", "correctionValidationSetDigest", "validationTransition", "taskState", "runState",
  "runHold", "providerInvocationCount", "retryCount", "fallbackCount", "completedRerunProviderCallDelta",
  "coldReopenIdentical", "controlPlaneCanariesIntact", "credentialLeakage", "retainedProjectRoot",
  "retainedRunDirectory", "retainedStagingBase", "platform", "unqualifiedPlatforms", "retentionNotice", "observedAt",
  "receiptDigest",
]);

const CREDENTIAL_PATTERNS = Object.freeze([
  /Bearer\s+\S+/i,
  /-----BEGIN[^-]*PRIVATE KEY-----/,
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*\S+/i,
  /\bsk-[A-Za-z0-9_-]{16,}/,
]);

export function buildCodexCorrectionAcceptanceReceiptV2(
  input: BuildCodexCorrectionAcceptanceReceiptInputV2,
): CodexCorrectionAcceptanceReceiptV2 {
  const base = {
    schema: RALPH_M5C_ACCEPTANCE_RECEIPT_SCHEMA_V2,
    ...input,
    retentionNotice: M5C_RETENTION_NOTICE_V2,
  };
  const result = Object.freeze({ ...base, receiptDigest: sha256Canonical(base) });
  validateCodexCorrectionAcceptanceReceiptV2(result);
  return result;
}

export function validateCodexCorrectionAcceptanceReceiptV2(value: unknown): asserts value is CodexCorrectionAcceptanceReceiptV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("record");
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !KEYS.includes(key));
  const missing = KEYS.filter((key) => !(key in record));
  if (unknown.length > 0 || missing.length > 0) throw invalid(`shape ${unknown.join(",")} ${missing.join(",")}`);
  if (record.schema !== RALPH_M5C_ACCEPTANCE_RECEIPT_SCHEMA_V2 || record.retentionNotice !== M5C_RETENTION_NOTICE_V2) throw invalid("schema");
  const serialized = canonicalJson(record);
  if (Buffer.byteLength(serialized, "utf8") > 64 * 1024) throw invalid("size");
  for (const item of Object.values(record)) {
    for (const text of typeof item === "string" ? [item] : Array.isArray(item) ? item.filter((entry): entry is string => typeof entry === "string") : []) {
      if (text.length > 512) throw invalid("field bound");
    }
  }
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(serialized))) throw new RalphM5BError("M5B_PROVIDER_CREDENTIAL_MATERIAL", "M5C_ACCEPTANCE_RECEIPT_CREDENTIAL_MATERIAL");
  for (const key of [
    "findingDigest", "correctionContextDigest", "providerDescriptorDigest", "promptDigest", "managedRuntimeIdentityDigest",
    "permissionProfileDigest", "capabilityBindingDigest", "rootSentinelManifestDigest", "deltaDigest", "publicationDigest",
    "rejectedEvidenceDigest", "correctionEvidenceDigest", "rejectedValidationSetDigest", "correctionValidationSetDigest",
  ]) if (!isSha256Digest(record[key])) throw invalid(`digest ${key}`);
  if (record.rejectedAttemptId === record.correctionAttemptId) throw invalid("fresh Attempt");
  if (record.rejectedAttemptClosure !== "AUDIT_REJECTED" || record.correctionAttemptClosure !== "AUDIT_ACCEPTED"
    || record.findingFinalStatus !== "RESOLVED" || record.validationTransition !== "FAIL_TO_PASS"
    || record.taskState !== "COMPLETE" || record.runState !== "COMPLETE" || record.runHold !== "NONE") throw invalid("closure");
  if (record.providerInvocationCount !== 1 || record.retryCount !== 0 || record.fallbackCount !== 0 || record.completedRerunProviderCallDelta !== 0) throw invalid("call count");
  if (record.coldReopenIdentical !== true || record.controlPlaneCanariesIntact !== true || record.credentialLeakage !== false) throw invalid("safety outcome");
  if (record.stagingRootWritable !== true || record.platform !== "linux-x86_64") throw invalid("platform/root scope");
  if (canonicalJson(record.unqualifiedPlatforms) !== canonicalJson(["WSL2", "macOS arm64", "macOS x64", "linux arm64"])) throw invalid("platform qualification");
  if (canonicalJson(record.deltaEntries) !== canonicalJson(["MODIFY package.json"])) throw invalid("delta");
  const { receiptDigest, ...base } = record;
  if (!isSha256Digest(receiptDigest) || sha256Canonical(base) !== receiptDigest) throw invalid("digest mismatch");
}

export function codexCorrectionAcceptanceEvidenceRootV2(): string {
  return join(homedir(), ".local", "state", "rb-harness", "ralph-m5c-acceptance");
}

export async function writeCodexCorrectionAcceptanceReceiptV2(
  receipt: CodexCorrectionAcceptanceReceiptV2,
  evidenceRoot: string = codexCorrectionAcceptanceEvidenceRootV2(),
): Promise<{ readonly path: string; readonly receiptDigest: string; readonly fileDigest: string }> {
  validateCodexCorrectionAcceptanceReceiptV2(receipt);
  const root = resolve(evidenceRoot);
  if (!isAbsolute(root)) throw invalid("evidence root");
  const directory = join(root, receipt.runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `acceptance-receipt-${receipt.correctionAttemptId}.json`);
  const serialized = `${canonicalJson(receipt)}\n`;
  await writeFile(path, serialized, { mode: 0o600 });
  return Object.freeze({ path, receiptDigest: receipt.receiptDigest, fileDigest: sha256(serialized) });
}

function invalid(detail: string): RalphM5BError {
  return new RalphM5BError("M5B_ACCEPTANCE_RECEIPT_INVALID", `M5C_ACCEPTANCE_RECEIPT_INVALID: ${detail}`);
}
