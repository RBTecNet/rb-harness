import type { Finding } from "../contracts.js";
import type { RalphEventStoreV2 } from "../operational-b1/index.js";
import {
  attemptArtifactRefV2,
  persistImmutableJsonArtifactV2,
  readImmutableJsonArtifactV2,
  type ArtifactPersistenceResultV2,
  RalphB4ArtifactError,
} from "../operational-b4/artifacts.js";
import { assertNoCredentialMaterial, RalphCredentialSafetyError } from "../operational-b1/secret-safety.js";
import { isSha256Digest, sha256Canonical } from "../hashing.js";

export const CORRECTION_CONTEXT_SCHEMA_V2 = "rb-ralph-correction-context/v1" as const;

export interface CorrectionSourceAttemptV2 {
  readonly attemptId: string;
  readonly ordinal: number;
  readonly closureReason: "AUDIT_REJECTED";
  readonly auditPackageDigest: string;
  readonly validationSetDigest: string;
}

export interface CorrectionFindingV2 {
  readonly findingId: string;
  readonly findingDigest: string;
  readonly criterionId: string;
  readonly severity: Finding["severity"];
  readonly status: "OPEN" | "CANDIDATE_RESOLVED" | "HUMAN_PENDING";
  readonly observed: string;
  readonly remediationHint?: string;
}

/** Immutable adjunct; the frozen WorkUnit schema remains unchanged. */
export interface CorrectionContextV2 {
  readonly schema: typeof CORRECTION_CONTEXT_SCHEMA_V2;
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly currentAttemptId: string;
  readonly sourceRejectedAttempts: readonly CorrectionSourceAttemptV2[];
  readonly openFindingRefs: readonly string[];
  readonly openFindings: readonly CorrectionFindingV2[];
  readonly baseWorkspaceFingerprint: string;
  readonly createdAt: string;
  readonly contextId: string;
  readonly contextDigest: string;
}

export function correctionContextRefV2(attemptId: string): string {
  return attemptArtifactRefV2(attemptId, "correction-context.json");
}

export function correctionContextIdV2(input: Omit<CorrectionContextV2, "schema" | "contextId" | "contextDigest" | "createdAt">): string {
  return `correction-${sha256Canonical({ runId: input.runId, phaseId: input.phaseId, taskId: input.taskId, currentAttemptId: input.currentAttemptId, sourceRejectedAttempts: input.sourceRejectedAttempts, openFindingRefs: input.openFindingRefs, openFindings: input.openFindings, baseWorkspaceFingerprint: input.baseWorkspaceFingerprint }).slice("sha256:".length)}`;
}

export function createCorrectionContextV2(input: Omit<CorrectionContextV2, "schema" | "contextId" | "contextDigest">): CorrectionContextV2 {
  const baseWithoutId = { ...input, schema: CORRECTION_CONTEXT_SCHEMA_V2 };
  const contextId = correctionContextIdV2(input);
  const withId = { ...baseWithoutId, contextId };
  const result: CorrectionContextV2 = { ...withId, contextDigest: sha256Canonical(withId) };
  validateCorrectionContextV2(result);
  return result;
}

export function validateCorrectionContextV2(value: unknown): asserts value is CorrectionContextV2 {
  if (!isRecord(value)) throw artifact("F_CORRECTION_CONTEXT_INVALID");
  assertExactKeys(value, ["schema", "runId", "phaseId", "taskId", "currentAttemptId", "sourceRejectedAttempts", "openFindingRefs", "openFindings", "baseWorkspaceFingerprint", "createdAt", "contextId", "contextDigest"]);
  if (value.schema !== CORRECTION_CONTEXT_SCHEMA_V2) throw artifact("F_CORRECTION_CONTEXT_INVALID: schema");
  for (const key of ["runId", "phaseId", "taskId", "currentAttemptId", "createdAt", "contextId"] as const) assertSafeIdentity(value[key]);
  if (typeof value.contextId !== "string" || !/^correction-[0-9a-f]{64}$/.test(value.contextId)) throw artifact("F_CORRECTION_CONTEXT_INVALID: id");
  if (!isSha256Digest(value.baseWorkspaceFingerprint) || !isSha256Digest(value.contextDigest)) throw artifact("F_CORRECTION_CONTEXT_INVALID: digest");
  assertStringArray(value.openFindingRefs);
  if (!Array.isArray(value.sourceRejectedAttempts)) throw artifact("F_CORRECTION_CONTEXT_INVALID: source attempts");
  for (const raw of value.sourceRejectedAttempts) {
    if (!isRecord(raw)) throw artifact("F_CORRECTION_CONTEXT_INVALID: source attempt");
    assertExactKeys(raw, ["attemptId", "ordinal", "closureReason", "auditPackageDigest", "validationSetDigest"]);
    assertSafeIdentity(raw.attemptId);
    if (!Number.isSafeInteger(raw.ordinal) || (raw.ordinal as number) < 1 || raw.closureReason !== "AUDIT_REJECTED" || !isSha256Digest(raw.auditPackageDigest) || !isSha256Digest(raw.validationSetDigest)) throw artifact("F_CORRECTION_CONTEXT_INVALID: source attempt");
  }
  if (!Array.isArray(value.openFindings) || value.openFindings.length !== value.openFindingRefs.length) throw artifact("F_CORRECTION_CONTEXT_INVALID: findings");
  const refSet = new Set(value.openFindingRefs as readonly string[]);
  for (const raw of value.openFindings) {
    if (!isRecord(raw)) throw artifact("F_CORRECTION_CONTEXT_INVALID: finding");
    assertExactKeys(raw, ["findingId", "findingDigest", "criterionId", "severity", "status", "observed", "remediationHint"]);
    assertSafeIdentity(raw.findingId);
    if (!refSet.has(raw.findingId) || !isSha256Digest(raw.findingDigest) || typeof raw.criterionId !== "string" || raw.criterionId.length === 0 || raw.criterionId.length > 512 || !["INFO", "LOW", "MEDIUM", "HIGH", "BLOCKER"].includes(String(raw.severity)) || !["OPEN", "CANDIDATE_RESOLVED", "HUMAN_PENDING"].includes(String(raw.status)) || typeof raw.observed !== "string" || raw.observed.length > 4096 || raw.observed.includes("\0")) throw artifact("F_CORRECTION_CONTEXT_INVALID: finding");
    if (raw.remediationHint !== undefined && (typeof raw.remediationHint !== "string" || raw.remediationHint.length > 4096 || raw.remediationHint.includes("\0"))) throw artifact("F_CORRECTION_CONTEXT_INVALID: finding hint");
  }
  const { contextDigest: _ignored, ...base } = value;
  if (sha256Canonical(base) !== value.contextDigest) throw artifact("F_CORRECTION_CONTEXT_INVALID: digest");
  if (correctionContextIdV2({
    runId: value.runId as string,
    phaseId: value.phaseId as string,
    taskId: value.taskId as string,
    currentAttemptId: value.currentAttemptId as string,
    sourceRejectedAttempts: value.sourceRejectedAttempts as readonly CorrectionSourceAttemptV2[],
    openFindingRefs: value.openFindingRefs as readonly string[],
    openFindings: value.openFindings as readonly CorrectionFindingV2[],
    baseWorkspaceFingerprint: value.baseWorkspaceFingerprint as string,
  }) !== value.contextId) throw artifact("F_CORRECTION_CONTEXT_INVALID: identity");
  try { assertNoCredentialMaterial(value, "F_CORRECTION_CONTEXT_CREDENTIAL"); }
  catch (error) { if (error instanceof RalphCredentialSafetyError) throw artifact("F_CORRECTION_CONTEXT_CREDENTIAL", error); throw error; }
}

export async function persistCorrectionContextV2(store: RalphEventStoreV2, value: CorrectionContextV2, nonce: string): Promise<ArtifactPersistenceResultV2<CorrectionContextV2>> {
  validateCorrectionContextV2(value);
  return persistImmutableJsonArtifactV2({ store, ref: correctionContextRefV2(value.currentAttemptId), artifact: value, validate: validateCorrectionContextV2, nonce });
}

export async function readCorrectionContextV2(store: RalphEventStoreV2, attemptId: string): Promise<CorrectionContextV2 | undefined> {
  return readImmutableJsonArtifactV2({ store, ref: correctionContextRefV2(attemptId), validate: validateCorrectionContextV2 });
}

function assertExactKeys(value: object, keys: readonly string[]): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw artifact("F_CORRECTION_CONTEXT_UNKNOWN_FIELD");
}

function assertSafeIdentity(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\0") || value.includes("/")) throw artifact("F_CORRECTION_CONTEXT_INVALID: identity");
}

function assertStringArray(value: unknown): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0 || item.length > 512 || item.includes("\0"))) throw artifact("F_CORRECTION_CONTEXT_INVALID: refs");
}

function artifact(message: string, cause?: unknown): RalphB4ArtifactError {
  return new RalphB4ArtifactError("B4_ARTIFACT_INVALID", message, cause);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
