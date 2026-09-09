import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { canonicalJson } from "../canonical-json.js";
import { sha256, sha256Canonical } from "../hashing.js";
import { RalphM5BError } from "./contract-errors.js";

/**
 * Ralph M5-B — the bounded acceptance receipt.
 *
 * The previous real acceptance could not be reconstructed by an independent
 * audit: its evidence lived in disposable `/tmp` artifacts that were removed
 * as soon as the run passed.  A receipt fixes that without ever becoming a
 * transcript.
 *
 * It carries STRUCTURAL FACTS ONLY — identities, digests, counts, states.  No
 * raw JSONL, no reasoning, no provider transcript, no command output, no
 * credential or auth metadata, and no user source content beyond digests that
 * were already computed elsewhere.  Every string field is credential-scanned
 * before the receipt is sealed, and the whole receipt is digest-sealed so a
 * later edit is detectable.
 */
export const RALPH_M5B_ACCEPTANCE_RECEIPT_SCHEMA_V2 = "rb-ralph-m5b-acceptance-receipt/v1" as const;

/** Bounds that keep a receipt inspectable by hand. */
export const M5B_ACCEPTANCE_RECEIPT_LIMITS_V2 = Object.freeze({
  maxFieldChars: 512,
  maxTotalBytes: 64 * 1024,
});

/**
 * Patterns that must never appear anywhere in a receipt.  This is the same
 * fail-closed scan the real E2E applies to persisted attempt artifacts, kept
 * here so the receipt cannot be published without it.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = Object.freeze([
  /Bearer\s+\S+/i,
  /-----BEGIN[^-]*PRIVATE KEY-----/,
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|secret|credential)\s*[:=]\s*\S+/i,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
]);

export interface CodexAcceptanceReceiptV2 {
  readonly schema: typeof RALPH_M5B_ACCEPTANCE_RECEIPT_SCHEMA_V2;
  readonly receiptVersion: 1;

  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly invocationId: string;

  readonly managedRuntimeKind: string;
  readonly managedRuntimeVersion: string;
  readonly managedRuntimeIdentityDigest: string;
  readonly permissionProfileName: string;
  readonly permissionProfileDigest: string;
  readonly permissionPolicyShapeDigest: string;
  readonly capabilityRecordDigest: string;
  readonly capabilityBindingDigest: string;
  readonly sandboxBackendPath: string;
  readonly legacySandboxMode: string;

  readonly requestedModel: string;
  readonly observedModelState: string;
  readonly observedModel: string | null;
  readonly threadId: string;

  readonly scopeToken: string;
  readonly stagingRootWritable: boolean;
  readonly writeRootPlanDigest: string;
  readonly rootSentinelManifestDigest: string;
  readonly sentinelPostCheck: "INTACT" | "VIOLATED";
  readonly projectionManifestDigest: string;
  readonly promptDigest: string;

  readonly actualExitCode: number | null;
  readonly actualSignal: string | null;
  readonly terminalKind: string | null;
  readonly terminalStatus: string;
  readonly termination: string;
  readonly processState: string;
  readonly processTreeState: string;
  readonly settlementQuiescent: boolean;

  readonly deltaDigest: string | null;
  readonly deltaEntries: readonly string[];
  readonly publicationDigest: string | null;
  readonly publicationAppliedCount: number;
  readonly canonicalPreFingerprint: string;
  readonly canonicalPostFingerprint: string;
  readonly canonicalPreControlPlaneFingerprint: string;
  readonly canonicalPostControlPlaneFingerprint: string;
  readonly controlPlaneCanariesIntact: boolean;

  readonly evidenceDigest: string;
  readonly validationSetDigest: string;
  readonly auditResultDigest: string;
  readonly attemptClosure: string;
  readonly taskState: string;
  readonly runState: string;

  readonly providerInvocationCount: number;
  readonly retryCount: number;
  readonly fallbackCount: number;
  readonly credentialScan: "CLEAN";
  readonly coldReopenIdentical: boolean;
  readonly completedRerunProviderCallDelta: number;

  readonly retainedProjectRoot: string;
  readonly retainedRunDirectory: string;
  readonly retentionNotice: string;

  readonly observedAt: string;
  readonly receiptDigest: string;
}

const RECEIPT_KEYS: readonly string[] = Object.freeze([
  "schema", "receiptVersion", "runId", "phaseId", "taskId", "attemptId", "invocationId",
  "managedRuntimeKind", "managedRuntimeVersion", "managedRuntimeIdentityDigest", "permissionProfileName",
  "permissionProfileDigest", "permissionPolicyShapeDigest", "capabilityRecordDigest", "capabilityBindingDigest",
  "sandboxBackendPath", "legacySandboxMode", "requestedModel", "observedModelState", "observedModel", "threadId",
  "scopeToken", "stagingRootWritable", "writeRootPlanDigest", "rootSentinelManifestDigest", "sentinelPostCheck",
  "projectionManifestDigest", "promptDigest", "actualExitCode", "actualSignal", "terminalKind", "terminalStatus",
  "termination", "processState", "processTreeState", "settlementQuiescent", "deltaDigest", "deltaEntries",
  "publicationDigest", "publicationAppliedCount", "canonicalPreFingerprint", "canonicalPostFingerprint",
  "canonicalPreControlPlaneFingerprint", "canonicalPostControlPlaneFingerprint", "controlPlaneCanariesIntact",
  "evidenceDigest", "validationSetDigest", "auditResultDigest", "attemptClosure", "taskState", "runState",
  "providerInvocationCount", "retryCount", "fallbackCount", "credentialScan", "coldReopenIdentical",
  "completedRerunProviderCallDelta", "retainedProjectRoot", "retainedRunDirectory", "retentionNotice",
  "observedAt", "receiptDigest",
]);

export const M5B_RETENTION_NOTICE_V2 = "AUDIT EVIDENCE — DO NOT CLEAN UNTIL FREEZE" as const;

export type BuildCodexAcceptanceReceiptInputV2 = Omit<CodexAcceptanceReceiptV2, "schema" | "receiptVersion" | "credentialScan" | "retentionNotice" | "receiptDigest">;

/**
 * Build and seal an acceptance receipt.
 *
 * A receipt is not a summary someone wrote: it is refused unless it is
 * internally consistent with the durable Run it claims to describe.  A
 * receipt claiming a COMPLETE Task while the Attempt did not close accepted,
 * while more or fewer than one provider call happened, or while nothing was
 * published, fails here rather than becoming audit evidence.
 */
export function buildCodexAcceptanceReceiptV2(input: BuildCodexAcceptanceReceiptInputV2): CodexAcceptanceReceiptV2 {
  const base = {
    schema: RALPH_M5B_ACCEPTANCE_RECEIPT_SCHEMA_V2,
    receiptVersion: 1 as const,
    ...input,
    credentialScan: "CLEAN" as const,
    retentionNotice: M5B_RETENTION_NOTICE_V2,
  };
  const receipt: CodexAcceptanceReceiptV2 = Object.freeze({ ...base, receiptDigest: sha256Canonical(base) });
  validateCodexAcceptanceReceiptV2(receipt);
  return receipt;
}

export function validateCodexAcceptanceReceiptV2(value: unknown): asserts value is CodexAcceptanceReceiptV2 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RalphM5BError("M5B_ACCEPTANCE_RECEIPT_INVALID", "M5B_ACCEPTANCE_RECEIPT_INVALID: not a record");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(RECEIPT_KEYS);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new RalphM5BError("M5B_ACCEPTANCE_RECEIPT_INVALID", `M5B_ACCEPTANCE_RECEIPT_INVALID: unknown fields ${unknown.sort().join(",")}`);
  const missing = RECEIPT_KEYS.filter((key) => !(key in record));
  if (missing.length > 0) throw new RalphM5BError("M5B_ACCEPTANCE_RECEIPT_INVALID", `M5B_ACCEPTANCE_RECEIPT_INVALID: missing fields ${missing.join(",")}`);
  if (record.schema !== RALPH_M5B_ACCEPTANCE_RECEIPT_SCHEMA_V2 || record.receiptVersion !== 1) {
    throw new RalphM5BError("M5B_ACCEPTANCE_RECEIPT_INVALID", "M5B_ACCEPTANCE_RECEIPT_INVALID: schema");
  }
  if (record.retentionNotice !== M5B_RETENTION_NOTICE_V2) {
    throw new RalphM5BError("M5B_ACCEPTANCE_RECEIPT_INVALID", "M5B_ACCEPTANCE_RECEIPT_INVALID: retention notice");
  }

  const serialized = canonicalJson(record);
  if (Buffer.byteLength(serialized, "utf8") > M5B_ACCEPTANCE_RECEIPT_LIMITS_V2.maxTotalBytes) {
    throw new RalphM5BError("M5B_ACCEPTANCE_RECEIPT_INVALID", "M5B_ACCEPTANCE_RECEIPT_INVALID: receipt exceeds its byte bound");
  }
  for (const [key, item] of Object.entries(record)) {
    for (const text of typeof item === "string" ? [item] : Array.isArray(item) ? item.filter((entry): entry is string => typeof entry === "string") : []) {
      if (text.length > M5B_ACCEPTANCE_RECEIPT_LIMITS_V2.maxFieldChars) {
        throw new RalphM5BError("M5B_ACCEPTANCE_RECEIPT_INVALID", `M5B_ACCEPTANCE_RECEIPT_INVALID: ${key} exceeds its field bound`);
      }
    }
  }
  // The scan runs over the whole serialized receipt, so a credential cannot
  // hide in a field the caller happened to add.
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(serialized)) {
      throw new RalphM5BError("M5B_PROVIDER_CREDENTIAL_MATERIAL", "M5B_PROVIDER_CREDENTIAL_MATERIAL: the acceptance receipt carries credential-shaped material");
    }
  }
  if (record.credentialScan !== "CLEAN") throw new RalphM5BError("M5B_ACCEPTANCE_RECEIPT_INVALID", "M5B_ACCEPTANCE_RECEIPT_INVALID: credential scan");

  // A receipt may not claim more completion than the durable Run supports.
  const accepted = record.attemptClosure === "AUDIT_ACCEPTED";
  if (record.taskState === "COMPLETE" || record.runState === "COMPLETE") {
    if (!accepted) throw new RalphM5BError("M5B_ACCEPTANCE_RECEIPT_INVALID", "M5B_ACCEPTANCE_RECEIPT_INVALID: a COMPLETE state requires an accepted Attempt closure");
    if (record.terminalStatus !== "SUCCEEDED" || record.terminalKind !== "TURN_COMPLETED" || record.actualExitCode !== 0 || record.actualSignal !== null) {
      throw new RalphM5BError("M5B_ACCEPTANCE_RECEIPT_INVALID", "M5B_ACCEPTANCE_RECEIPT_INVALID: a COMPLETE state requires a clean provider terminal");
    }
    if (typeof record.publicationDigest !== "string" || record.publicationDigest.length === 0 || typeof record.deltaDigest !== "string") {
      throw new RalphM5BError("M5B_ACCEPTANCE_RECEIPT_INVALID", "M5B_ACCEPTANCE_RECEIPT_INVALID: a COMPLETE state requires a published delta");
    }
    if (record.sentinelPostCheck !== "INTACT" || record.controlPlaneCanariesIntact !== true) {
      throw new RalphM5BError("M5B_ACCEPTANCE_RECEIPT_INVALID", "M5B_ACCEPTANCE_RECEIPT_INVALID: a COMPLETE state requires an intact control plane");
    }
  }
  if (record.providerInvocationCount !== 1 || record.retryCount !== 0 || record.fallbackCount !== 0) {
    throw new RalphM5BError("M5B_ACCEPTANCE_RECEIPT_INVALID", "M5B_ACCEPTANCE_RECEIPT_INVALID: exactly one provider invocation with no retry or fallback is authorized");
  }
  if (record.completedRerunProviderCallDelta !== 0) {
    throw new RalphM5BError("M5B_ACCEPTANCE_RECEIPT_INVALID", "M5B_ACCEPTANCE_RECEIPT_INVALID: a completed rerun must add no provider call");
  }
  // Stock ephemeral `codex exec` publishes no effective-model surface; a
  // receipt claiming otherwise would be claiming an observation nobody made.
  if (record.observedModelState !== "UNAVAILABLE" || record.observedModel !== null) {
    throw new RalphM5BError("M5B_PROVIDER_MODEL_SURFACE_UNEXPECTED", "M5B_PROVIDER_MODEL_SURFACE_UNEXPECTED: the receipt claims an observed model");
  }
  if (record.stagingRootWritable === true && (typeof record.rootSentinelManifestDigest !== "string" || record.rootSentinelManifestDigest.length === 0)) {
    throw new RalphM5BError("M5B_SENTINEL_MANIFEST_INVALID", "M5B_SENTINEL_MANIFEST_INVALID: a root-scope receipt requires a sentinel authority");
  }
  if (!Array.isArray(record.deltaEntries)) throw new RalphM5BError("M5B_ACCEPTANCE_RECEIPT_INVALID", "M5B_ACCEPTANCE_RECEIPT_INVALID: deltaEntries");

  const { receiptDigest, ...base } = record;
  if (typeof receiptDigest !== "string" || sha256Canonical(base) !== receiptDigest) {
    throw new RalphM5BError("M5B_ACCEPTANCE_RECEIPT_INVALID", "M5B_ACCEPTANCE_RECEIPT_INVALID: digest mismatch");
  }
}

/**
 * The stable local evidence root, deliberately OUTSIDE any canonical
 * repository: an acceptance receipt is machine evidence, not source, and must
 * never pollute a project tree it describes.
 */
export function codexAcceptanceEvidenceRootV2(): string {
  return join(homedir(), ".local", "state", "rb-harness", "ralph-m5b-acceptance");
}

export interface WrittenCodexAcceptanceReceiptV2 {
  readonly path: string;
  readonly receiptDigest: string;
  readonly fileDigest: string;
  readonly byteLength: number;
}

/** Write a sealed receipt to the stable local evidence root. */
export async function writeCodexAcceptanceReceiptV2(
  receipt: CodexAcceptanceReceiptV2,
  evidenceRoot: string = codexAcceptanceEvidenceRootV2(),
): Promise<WrittenCodexAcceptanceReceiptV2> {
  validateCodexAcceptanceReceiptV2(receipt);
  const root = resolve(evidenceRoot);
  if (!isAbsolute(root)) throw new RalphM5BError("M5B_ACCEPTANCE_RECEIPT_INVALID", "M5B_ACCEPTANCE_RECEIPT_INVALID: evidence root must be absolute");
  const directory = join(root, receipt.runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `acceptance-receipt-${receipt.attemptId}.json`);
  const serialized = `${canonicalJson(receipt)}\n`;
  await writeFile(path, serialized, { mode: 0o600 });
  return Object.freeze({
    path,
    receiptDigest: receipt.receiptDigest,
    fileDigest: sha256(serialized),
    byteLength: Buffer.byteLength(serialized, "utf8"),
  });
}
