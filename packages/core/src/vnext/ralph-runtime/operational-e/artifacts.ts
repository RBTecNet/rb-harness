import type { RalphEventStoreV2 } from "../operational-b1/index.js";
import {
  attemptArtifactRefV2,
  persistImmutableJsonArtifactV2,
  readImmutableJsonArtifactV2,
  type ArtifactPersistenceResultV2,
  RalphB4ArtifactError,
} from "../operational-b4/artifacts.js";
import type { AuditPackageV2 } from "../operational-d/artifacts.js";
import { assertNoCredentialMaterial, RalphCredentialSafetyError } from "../operational-b1/secret-safety.js";
import { isSha256Digest, sha256Canonical } from "../hashing.js";

export const AUDIT_INVOCATION_SCHEMA_V2 = "rb-ralph-audit-invocation/v1" as const;
export const AUDIT_RESULT_SCHEMA_V2 = "rb-ralph-audit-result/v1" as const;
export const AUDIT_VERDICTS_V2 = ["ACCEPT", "REJECT"] as const;
export type AuditVerdictV2 = typeof AUDIT_VERDICTS_V2[number];

/** Immutable Core descriptor written before ScriptedAuditor is invoked. */
export interface AuditInvocationDescriptorV2 {
  readonly schema: typeof AUDIT_INVOCATION_SCHEMA_V2;
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly auditInvocationId: string;
  readonly auditPackageId: string;
  readonly auditPackageDigest: string;
  readonly auditorIdentity: string;
  readonly auditorProfileId: string;
  readonly auditorProfileDigest: string;
  readonly startedAt: string;
  readonly descriptorDigest: string;
}

/**
 * Structured finding proposal.  The absence of a final Finding ID is
 * deliberate: identity is minted by Core from this stable key and task
 * authority, never by an Auditor runtime.
 */
export interface ProposedFindingV2 {
  readonly criterionId: string;
  readonly structuredFindingKey: string;
  readonly severity: "INFO" | "LOW" | "MEDIUM" | "HIGH" | "BLOCKER";
  readonly scope: readonly string[];
  readonly expectation: string;
  readonly observed: string;
  readonly remediationHint?: string;
  readonly rootCauseGroup?: string;
}

/** Untrusted result is validated and sealed into this immutable artifact. */
export interface AuditResultV2 {
  readonly schema: typeof AUDIT_RESULT_SCHEMA_V2;
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly auditInvocationId: string;
  readonly auditPackageId: string;
  readonly auditPackageDigest: string;
  readonly verdict: AuditVerdictV2;
  readonly proposedFindings: readonly ProposedFindingV2[];
  readonly resolvedFindingRefs: readonly string[];
  readonly rationale: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly resultDigest: string;
}

export interface AuditInvocationBindingV2 {
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly auditPackageId: string;
  readonly auditPackageDigest: string;
  readonly auditorIdentity: string;
  readonly auditorProfileId: string;
  readonly auditorProfileDigest: string;
}

export function auditInvocationRefV2(attemptId: string): string {
  return attemptArtifactRefV2(attemptId, "audit-invocation.json");
}

export function auditResultRefV2(attemptId: string): string {
  return attemptArtifactRefV2(attemptId, "audit-result.json");
}

export function auditInvocationIdV2(binding: AuditInvocationBindingV2): string {
  for (const value of [binding.runId, binding.phaseId, binding.taskId, binding.attemptId, binding.auditPackageId, binding.auditorIdentity, binding.auditorProfileId]) {
    assertSafeIdentity(value, "E_AUDIT_INVOCATION_INVALID");
  }
  assertDigest(binding.auditPackageDigest, "E_AUDIT_INVOCATION_INVALID");
  assertDigest(binding.auditorProfileDigest, "E_AUDIT_INVOCATION_INVALID");
  return `audit-${sha256Canonical(binding).slice("sha256:".length)}`;
}

export function createAuditInvocationDescriptorV2(
  input: AuditInvocationBindingV2 & { readonly startedAt: string },
): AuditInvocationDescriptorV2 {
  const auditInvocationId = auditInvocationIdV2({
    runId: input.runId,
    phaseId: input.phaseId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    auditPackageId: input.auditPackageId,
    auditPackageDigest: input.auditPackageDigest,
    auditorIdentity: input.auditorIdentity,
    auditorProfileId: input.auditorProfileId,
    auditorProfileDigest: input.auditorProfileDigest,
  });
  const base = {
    schema: AUDIT_INVOCATION_SCHEMA_V2,
    runId: input.runId,
    phaseId: input.phaseId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    auditInvocationId,
    auditPackageId: input.auditPackageId,
    auditPackageDigest: input.auditPackageDigest,
    auditorIdentity: input.auditorIdentity,
    auditorProfileId: input.auditorProfileId,
    auditorProfileDigest: input.auditorProfileDigest,
    startedAt: input.startedAt,
  };
  const result: AuditInvocationDescriptorV2 = { ...base, descriptorDigest: sha256Canonical(base) };
  validateAuditInvocationDescriptorV2(result);
  return result;
}

export function validateAuditInvocationDescriptorV2(value: unknown): asserts value is AuditInvocationDescriptorV2 {
  assertSafeArtifact(value, "E_AUDIT_INVOCATION_INVALID", [
    "schema", "runId", "phaseId", "taskId", "attemptId", "auditInvocationId", "auditPackageId", "auditPackageDigest",
    "auditorIdentity", "auditorProfileId", "auditorProfileDigest", "startedAt", "descriptorDigest",
  ]);
  const item = value as Record<string, unknown>;
  if (item.schema !== AUDIT_INVOCATION_SCHEMA_V2) throw artifact("E_AUDIT_INVOCATION_INVALID: schema");
  for (const key of ["runId", "phaseId", "taskId", "attemptId", "auditInvocationId", "auditPackageId", "auditorIdentity", "auditorProfileId", "startedAt"] as const) assertSafeIdentity(item[key], "E_AUDIT_INVOCATION_INVALID");
  if (typeof item.auditInvocationId !== "string" || !/^audit-[0-9a-f]{64}$/.test(item.auditInvocationId)) throw artifact("E_AUDIT_INVOCATION_INVALID: id");
  for (const key of ["auditPackageDigest", "auditorProfileDigest", "descriptorDigest"] as const) assertDigest(item[key], "E_AUDIT_INVOCATION_INVALID");
  const { descriptorDigest: _ignored, ...base } = item;
  if (sha256Canonical(base) !== item.descriptorDigest) throw artifact("E_AUDIT_INVOCATION_INVALID: digest");
  assertNoCredentials(value, "E_AUDIT_INVOCATION_CREDENTIAL");
}

export function createAuditResultV2(input: Omit<AuditResultV2, "schema" | "resultDigest">): AuditResultV2 {
  validateAuditResultInput(input);
  const base = { schema: AUDIT_RESULT_SCHEMA_V2, ...input };
  const result: AuditResultV2 = { ...base, resultDigest: sha256Canonical(base) };
  validateAuditResultV2(result);
  return result;
}

export function validateAuditResultV2(value: unknown): asserts value is AuditResultV2 {
  assertSafeArtifact(value, "E_AUDIT_RESULT_INVALID", [
    "schema", "runId", "phaseId", "taskId", "attemptId", "auditInvocationId", "auditPackageId", "auditPackageDigest",
    "verdict", "proposedFindings", "resolvedFindingRefs", "rationale", "metadata", "startedAt", "finishedAt", "resultDigest",
  ]);
  const item = value as Record<string, unknown>;
  if (item.schema !== AUDIT_RESULT_SCHEMA_V2) throw artifact("E_AUDIT_RESULT_INVALID: schema");
  for (const key of ["runId", "phaseId", "taskId", "attemptId", "auditInvocationId", "auditPackageId", "startedAt", "finishedAt"] as const) assertSafeIdentity(item[key], "E_AUDIT_RESULT_INVALID");
  if (typeof item.auditInvocationId !== "string" || !/^audit-[0-9a-f]{64}$/.test(item.auditInvocationId)) throw artifact("E_AUDIT_RESULT_INVALID: id");
  assertSafeIdentity(item.auditPackageId, "E_AUDIT_RESULT_INVALID");
  assertDigest(item.auditPackageDigest, "E_AUDIT_RESULT_INVALID");
  assertEnum(item.verdict, AUDIT_VERDICTS_V2, "E_AUDIT_RESULT_INVALID");
  if (!Array.isArray(item.proposedFindings) || item.proposedFindings.length > 128) throw artifact("E_AUDIT_RESULT_INVALID: findings");
  for (const finding of item.proposedFindings) validateProposedFindingV2(finding);
  assertStringArray(item.resolvedFindingRefs, "E_AUDIT_RESULT_INVALID", 128);
  for (const value of item.resolvedFindingRefs) assertSafeIdentity(value, "E_AUDIT_RESULT_INVALID");
  assertBoundedText(item.rationale, "E_AUDIT_RESULT_INVALID", 4096);
  validateMetadata(item.metadata);
  assertDigest(item.resultDigest, "E_AUDIT_RESULT_INVALID");
  const { resultDigest: _ignored, ...base } = item;
  if (sha256Canonical(base) !== item.resultDigest) throw artifact("E_AUDIT_RESULT_INVALID: digest");
  assertNoCredentials(value, "E_AUDIT_RESULT_CREDENTIAL");
}

export async function persistAuditInvocationDescriptorV2(
  store: RalphEventStoreV2,
  value: AuditInvocationDescriptorV2,
  nonce: string,
): Promise<ArtifactPersistenceResultV2<AuditInvocationDescriptorV2>> {
  validateAuditInvocationDescriptorV2(value);
  return persistImmutableJsonArtifactV2({ store, ref: auditInvocationRefV2(value.attemptId), artifact: value, validate: validateAuditInvocationDescriptorV2, nonce });
}

export async function readAuditInvocationDescriptorV2(store: RalphEventStoreV2, attemptId: string): Promise<AuditInvocationDescriptorV2 | undefined> {
  return readImmutableJsonArtifactV2({ store, ref: auditInvocationRefV2(attemptId), validate: validateAuditInvocationDescriptorV2 });
}

export async function persistAuditResultV2(
  store: RalphEventStoreV2,
  value: AuditResultV2,
  nonce: string,
): Promise<ArtifactPersistenceResultV2<AuditResultV2>> {
  validateAuditResultV2(value);
  return persistImmutableJsonArtifactV2({ store, ref: auditResultRefV2(value.attemptId), artifact: value, validate: validateAuditResultV2, nonce });
}

export async function readAuditResultV2(store: RalphEventStoreV2, attemptId: string): Promise<AuditResultV2 | undefined> {
  return readImmutableJsonArtifactV2({ store, ref: auditResultRefV2(attemptId), validate: validateAuditResultV2 });
}

function validateProposedFindingV2(value: unknown): asserts value is ProposedFindingV2 {
  assertSafeArtifact(value, "E_AUDIT_RESULT_INVALID", ["criterionId", "structuredFindingKey", "severity", "scope", "expectation", "observed", "remediationHint", "rootCauseGroup"]);
  const item = value as Record<string, unknown>;
  for (const key of ["criterionId", "structuredFindingKey", "expectation", "observed"] as const) assertBoundedText(item[key], "E_AUDIT_RESULT_INVALID", 4096);
  assertEnum(item.severity, ["INFO", "LOW", "MEDIUM", "HIGH", "BLOCKER"] as const, "E_AUDIT_RESULT_INVALID");
  assertStringArray(item.scope, "E_AUDIT_RESULT_INVALID", 64);
  for (const key of ["remediationHint", "rootCauseGroup"] as const) if (item[key] !== undefined) assertBoundedText(item[key], "E_AUDIT_RESULT_INVALID", 4096);
}

function validateAuditResultInput(input: Omit<AuditResultV2, "schema" | "resultDigest">): void {
  for (const key of ["runId", "phaseId", "taskId", "attemptId", "auditInvocationId", "auditPackageId", "startedAt", "finishedAt"] as const) assertSafeIdentity(input[key], "E_AUDIT_RESULT_INVALID");
  assertDigest(input.auditPackageDigest, "E_AUDIT_RESULT_INVALID");
  assertBoundedText(input.rationale, "E_AUDIT_RESULT_INVALID", 4096);
  validateMetadata(input.metadata);
}

function validateMetadata(value: unknown): asserts value is Readonly<Record<string, string>> {
  if (!isRecord(value)) throw artifact("E_AUDIT_RESULT_INVALID: metadata");
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(key)) throw artifact("E_AUDIT_RESULT_INVALID: metadata key");
    assertBoundedText(item, "E_AUDIT_RESULT_INVALID", 512);
  }
}

function assertSafeArtifact(value: unknown, code: string, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw artifact(code);
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw artifact(`${code}: ${unknown.sort().join(",")}`);
}

function assertSafeIdentity(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\0") || value.includes("/")) throw artifact(code);
}

function assertBoundedText(value: unknown, code: string, max: number): asserts value is string {
  if (typeof value !== "string" || value.length > max || value.includes("\0")) throw artifact(code);
}

function assertDigest(value: unknown, code: string): asserts value is string {
  if (!isSha256Digest(value)) throw artifact(code);
}

function assertEnum<T extends readonly string[]>(value: unknown, values: T, code: string): asserts value is T[number] {
  if (typeof value !== "string" || !values.includes(value)) throw artifact(code);
}

function assertStringArray(value: unknown, code: string, maxLength = 128): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.length > maxLength || value.some((item) => typeof item !== "string" || item.length === 0 || item.length > 512 || item.includes("\0"))) throw artifact(code);
}

function assertNoCredentials(value: unknown, code: string): void {
  try { assertNoCredentialMaterial(value, code); }
  catch (error) {
    if (error instanceof RalphCredentialSafetyError) throw artifact(code, error);
    throw error;
  }
}

function artifact(message: string, cause?: unknown): RalphB4ArtifactError {
  return new RalphB4ArtifactError("B4_ARTIFACT_INVALID", message, cause);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Keep the package type visible at the E boundary without accepting a caller
// record as an authority-bearing runtime.
export type AuditArtifactPackageV2 = AuditPackageV2;
