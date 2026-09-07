import type { Finding } from "../contracts.js";
import type { RalphEventStoreV2 } from "../operational-b1/index.js";
import {
  attemptArtifactRefV2,
  persistImmutableJsonArtifactV2,
  readImmutableJsonArtifactV2,
  type ArtifactPersistenceResultV2,
  RalphB4ArtifactError,
  RalphB4ArtifactError as RalphArtifactError,
} from "../operational-b4/artifacts.js";
import type { WorkspaceManifestV2 } from "../operational-b4/workspace-manifest.js";
import {
  AUDITABILITY_CLASSIFICATIONS,
  VALIDATION_KINDS,
  VALIDATION_OUTCOMES,
  type AuditabilityClassification,
  type DeterministicValidationSummary,
  type ValidationKind,
  type ValidationOutcome,
  type ValidationRunRef,
  type ValidationSpecRef,
} from "../operational-v2/contracts.js";
import type { EvidenceCaptureV2 } from "../operational-c/evidence.js";
import type { WorkUnitV2 } from "../operational-b3/artifacts.js";
import { assertNoCredentialMaterial, RalphCredentialSafetyError } from "../operational-b1/secret-safety.js";
import { isSha256Digest, sha256, sha256Canonical } from "../hashing.js";

export const VALIDATION_RUN_SCHEMA_V2 = "rb-ralph-validation-run/v1" as const;
export const VALIDATION_DIAGNOSTICS_SCHEMA_V2 = "rb-ralph-validation-diagnostics/v1" as const;
export const VALIDATION_SET_SCHEMA_V2 = "rb-ralph-validation-set/v1" as const;
export const AUDIT_PACKAGE_SCHEMA_V2 = "rb-ralph-audit-package/v1" as const;

export const VALIDATION_INFRASTRUCTURE_STATUSES = [
  "NONE",
  "SPAWN_FAILURE",
  "PROCESS_SUPERVISION_FAILURE",
  "UNKNOWN_TERMINATION",
  "RUNNER_PROTOCOL_FAILURE",
  "TIMEOUT",
  "CANCELLED",
] as const;
export type ValidationInfrastructureStatusV2 = typeof VALIDATION_INFRASTRUCTURE_STATUSES[number];

export const VALIDATION_SEMANTIC_STATUSES = ["PASS", "FAIL", "UNPROVEN", "HUMAN_REQUIRED"] as const;
export type ValidationSemanticStatusV2 = typeof VALIDATION_SEMANTIC_STATUSES[number];

export interface ValidationDiagnosticsV2 {
  readonly schema: typeof VALIDATION_DIAGNOSTICS_SCHEMA_V2;
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly validationRunId: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutDigest: string;
  readonly stderrDigest: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly capturedAt: string;
  readonly diagnosticsDigest: string;
}

/**
 * One immutable observation of one validation execution.  The `outcome` is
 * the frozen reducer-facing summary; `semanticStatus` and
 * `infrastructureStatus` deliberately remain separate so an exit code cannot
 * be confused with a runner failure.
 */
export interface ValidationRunV2 {
  readonly schema: typeof VALIDATION_RUN_SCHEMA_V2;
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly validationSpecId: string;
  readonly validationSpecDigest: string;
  readonly validationRunId: string;
  readonly validationRunOrdinal: number;
  readonly kind: ValidationKind;
  readonly instruction: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly semanticStatus: ValidationSemanticStatusV2;
  readonly infrastructureStatus: ValidationInfrastructureStatusV2;
  readonly outcome: ValidationOutcome;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly diagnosticRefs: readonly string[];
  readonly diagnosticDigests: readonly string[];
  readonly preValidationFingerprint: string;
  readonly postValidationFingerprint: string;
  readonly runDigest: string;
}

export interface ValidationRunBindingV2 {
  readonly validationRunId: string;
  readonly validationSpecId: string;
  readonly validationSpecDigest: string;
  readonly validationRunOrdinal: number;
  readonly artifactRef: string;
  readonly runDigest: string;
}

export interface ValidationSetV2 {
  readonly schema: typeof VALIDATION_SET_SCHEMA_V2;
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly evidenceCaptureId: string;
  readonly evidenceDigest: string;
  readonly postExecutorFingerprint: string;
  readonly validationRunRefs: readonly ValidationRunBindingV2[];
  readonly summary: DeterministicValidationSummary;
  readonly hardNegative: boolean;
  readonly manualUnprovenSpecIds: readonly string[];
  readonly humanValidationSpecIds: readonly string[];
  readonly setDigest: string;
}

export interface OpenFindingBindingV2 {
  readonly findingId: string;
  readonly findingDigest: string;
  readonly status: "OPEN" | "CANDIDATE_RESOLVED" | "HUMAN_PENDING";
  readonly severity: Finding["severity"];
}

export interface AuditPackageConstraintsV2 {
  readonly planIdentity: string;
  readonly taskTitle: string;
  readonly scope: string;
  readonly covers: string;
  readonly expectedEvidence: string;
}

export interface AuditPackageV2 {
  readonly schema: typeof AUDIT_PACKAGE_SCHEMA_V2;
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly workUnitId: string;
  readonly workUnitDigest: string;
  readonly evidenceCaptureId: string;
  readonly evidenceDigest: string;
  readonly validationSetId: string;
  readonly validationSetDigest: string;
  readonly acceptanceCriteria: readonly string[];
  readonly constraints: AuditPackageConstraintsV2;
  readonly relevantContext: readonly string[];
  readonly openFindingRefs: readonly OpenFindingBindingV2[];
  readonly workspaceFingerprint: string;
  readonly postExecutorFingerprint: string;
  readonly auditability: AuditabilityClassification;
  readonly validationSummary: DeterministicValidationSummary;
  readonly packageDigest: string;
}

export function validationDiagnosticsRefV2(attemptId: string, validationRunId: string): string {
  assertSegment(validationRunId);
  return attemptArtifactRefV2(attemptId, `validation-diagnostics-${validationRunId}.json`);
}

export function validationRunRefV2(attemptId: string, validationRunId: string): string {
  assertSegment(validationRunId);
  return attemptArtifactRefV2(attemptId, `validation-run-${validationRunId}.json`);
}

export function validationSetRefV2(attemptId: string): string {
  return attemptArtifactRefV2(attemptId, "validation-set.json");
}

export function auditPackageRefV2(attemptId: string): string {
  return attemptArtifactRefV2(attemptId, "audit-package.json");
}

export function createValidationDiagnosticsV2(input: Omit<ValidationDiagnosticsV2, "schema" | "stdoutDigest" | "stderrDigest" | "diagnosticsDigest">): ValidationDiagnosticsV2 {
  assertBoundedText(input.stdout, "D_DIAGNOSTICS_INVALID", 4096);
  assertBoundedText(input.stderr, "D_DIAGNOSTICS_INVALID", 4096);
  const base = {
    schema: VALIDATION_DIAGNOSTICS_SCHEMA_V2,
    ...input,
    stdoutDigest: sha256(input.stdout),
    stderrDigest: sha256(input.stderr),
  };
  const result: ValidationDiagnosticsV2 = { ...base, diagnosticsDigest: sha256Canonical(base) };
  validateValidationDiagnosticsV2(result);
  return result;
}

export function validateValidationDiagnosticsV2(value: unknown): asserts value is ValidationDiagnosticsV2 {
  assertSafeArtifact(value, "D_DIAGNOSTICS_INVALID", [
    "schema", "runId", "phaseId", "taskId", "attemptId", "validationRunId", "stdout", "stderr", "stdoutDigest", "stderrDigest",
    "stdoutTruncated", "stderrTruncated", "capturedAt", "diagnosticsDigest",
  ]);
  const item = value as Record<string, unknown>;
  if (item.schema !== VALIDATION_DIAGNOSTICS_SCHEMA_V2) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "D_DIAGNOSTICS_INVALID");
  for (const key of ["runId", "phaseId", "taskId", "attemptId", "validationRunId", "capturedAt"] as const) assertSafeIdentity(item[key], "D_DIAGNOSTICS_INVALID");
  assertBoundedText(item.stdout, "D_DIAGNOSTICS_INVALID", 4096);
  assertBoundedText(item.stderr, "D_DIAGNOSTICS_INVALID", 4096);
  for (const key of ["stdoutDigest", "stderrDigest", "diagnosticsDigest"] as const) assertDigest(item[key], "D_DIAGNOSTICS_INVALID");
  if (sha256(item.stdout as string) !== item.stdoutDigest || sha256(item.stderr as string) !== item.stderrDigest) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "D_DIAGNOSTICS_INVALID: stream digest");
  if (typeof item.stdoutTruncated !== "boolean" || typeof item.stderrTruncated !== "boolean") throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "D_DIAGNOSTICS_INVALID: truncation");
  const { diagnosticsDigest: _ignored, ...base } = item;
  if (sha256Canonical(base) !== item.diagnosticsDigest) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "D_DIAGNOSTICS_INVALID: digest");
  assertNoCredentials(value, "D_DIAGNOSTICS_CREDENTIAL");
}

export function createValidationRunV2(input: Omit<ValidationRunV2, "schema" | "runDigest">): ValidationRunV2 {
  validateValidationRunInput(input);
  const base = { schema: VALIDATION_RUN_SCHEMA_V2, ...input };
  const result: ValidationRunV2 = { ...base, runDigest: sha256Canonical(base) };
  validateValidationRunV2(result);
  return result;
}

export function validationRunRefFromArtifactV2(run: ValidationRunV2): ValidationRunRef {
  validateValidationRunV2(run);
  return {
    validationRunId: run.validationRunId,
    validationSpecId: run.validationSpecId,
    validationSpecDigest: run.validationSpecDigest,
    validationRunOrdinal: run.validationRunOrdinal,
    startedAt: run.startedAt,
    endedAt: run.finishedAt,
    outcome: run.outcome,
    exitCode: run.exitCode,
    resultDigest: run.runDigest,
  };
}

export function validateValidationRunV2(value: unknown): asserts value is ValidationRunV2 {
  assertSafeArtifact(value, "D_VALIDATION_RUN_INVALID", [
    "schema", "runId", "phaseId", "taskId", "attemptId", "validationSpecId", "validationSpecDigest", "validationRunId",
    "validationRunOrdinal", "kind", "instruction", "startedAt", "finishedAt", "semanticStatus", "infrastructureStatus", "outcome",
    "exitCode", "signal", "timedOut", "cancelled", "diagnosticRefs", "diagnosticDigests", "preValidationFingerprint",
    "postValidationFingerprint", "runDigest",
  ]);
  const item = value as Record<string, unknown>;
  if (item.schema !== VALIDATION_RUN_SCHEMA_V2) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_RUN_INVALID: schema");
  for (const key of ["runId", "phaseId", "taskId", "attemptId", "validationSpecId", "validationSpecDigest", "validationRunId", "instruction", "startedAt", "finishedAt"] as const) {
    if (key === "instruction") assertText(item[key], "D_VALIDATION_RUN_INVALID", 4096);
    else assertSafeIdentity(item[key], "D_VALIDATION_RUN_INVALID");
  }
  assertDigest(item.validationSpecDigest, "D_VALIDATION_RUN_INVALID");
  if (!Number.isSafeInteger(item.validationRunOrdinal) || (item.validationRunOrdinal as number) < 1) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_RUN_INVALID: ordinal");
  assertEnum(item.kind, VALIDATION_KINDS, "D_VALIDATION_RUN_INVALID");
  assertEnum(item.semanticStatus, VALIDATION_SEMANTIC_STATUSES, "D_VALIDATION_RUN_INVALID");
  assertEnum(item.infrastructureStatus, VALIDATION_INFRASTRUCTURE_STATUSES, "D_VALIDATION_RUN_INVALID");
  assertEnum(item.outcome, VALIDATION_OUTCOMES, "D_VALIDATION_RUN_INVALID");
  if (item.outcome === "PENDING") throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_RUN_INVALID: persisted ValidationRun cannot remain pending");
  if (item.exitCode !== null && (!Number.isSafeInteger(item.exitCode) || (item.exitCode as number) < -1)) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_RUN_INVALID: exit");
  if (item.signal !== null && (typeof item.signal !== "string" || item.signal.length === 0 || item.signal.length > 64 || item.signal.includes("\0"))) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_RUN_INVALID: signal");
  if (typeof item.timedOut !== "boolean" || typeof item.cancelled !== "boolean") throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_RUN_INVALID: termination facts");
  assertStringArray(item.diagnosticRefs, "D_VALIDATION_RUN_INVALID");
  for (const ref of item.diagnosticRefs as readonly unknown[]) assertSafeArtifactRef(ref, "D_VALIDATION_RUN_INVALID");
  assertStringArray(item.diagnosticDigests, "D_VALIDATION_RUN_INVALID");
  for (const digest of item.diagnosticDigests as readonly unknown[]) assertDigest(digest, "D_VALIDATION_RUN_INVALID");
  if ((item.diagnosticRefs as readonly unknown[]).length !== (item.diagnosticDigests as readonly unknown[]).length) throw new RalphArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_RUN_INVALID: diagnostic binding");
  assertDigest(item.preValidationFingerprint, "D_VALIDATION_RUN_INVALID");
  assertDigest(item.postValidationFingerprint, "D_VALIDATION_RUN_INVALID");
  assertDigest(item.runDigest, "D_VALIDATION_RUN_INVALID");
  assertValidationOutcomeMapping(item);
  const { runDigest: _ignored, ...base } = item;
  if (sha256Canonical(base) !== item.runDigest) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_RUN_INVALID: digest");
  assertNoCredentials(value, "D_VALIDATION_RUN_CREDENTIAL");
}

export function createValidationSetV2(input: Omit<ValidationSetV2, "schema" | "setDigest">): ValidationSetV2 {
  validateValidationSetInput(input);
  const base = { schema: VALIDATION_SET_SCHEMA_V2, ...input };
  const result: ValidationSetV2 = { ...base, setDigest: sha256Canonical(base) };
  validateValidationSetV2(result);
  return result;
}

export function validateValidationSetV2(value: unknown): asserts value is ValidationSetV2 {
  assertSafeArtifact(value, "D_VALIDATION_SET_INVALID", [
    "schema", "runId", "phaseId", "taskId", "attemptId", "evidenceCaptureId", "evidenceDigest", "postExecutorFingerprint",
    "validationRunRefs", "summary", "hardNegative", "manualUnprovenSpecIds", "humanValidationSpecIds", "setDigest",
  ]);
  const item = value as Record<string, unknown>;
  if (item.schema !== VALIDATION_SET_SCHEMA_V2) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_SET_INVALID: schema");
  for (const key of ["runId", "phaseId", "taskId", "attemptId", "evidenceCaptureId"] as const) assertSafeIdentity(item[key], "D_VALIDATION_SET_INVALID");
  assertDigest(item.postExecutorFingerprint, "D_VALIDATION_SET_INVALID");
  for (const key of ["evidenceDigest", "setDigest"] as const) assertDigest(item[key], "D_VALIDATION_SET_INVALID");
  assertValidationSummary(item.summary);
  if ((item.summary as DeterministicValidationSummary).completed !== (item.summary as DeterministicValidationSummary).total) {
    throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_SET_INVALID: pending ValidationRuns");
  }
  if (typeof item.hardNegative !== "boolean" || item.hardNegative !== (item.summary as DeterministicValidationSummary).hardNegative) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_SET_INVALID: hard negative");
  assertStringArray(item.manualUnprovenSpecIds, "D_VALIDATION_SET_INVALID");
  assertStringArray(item.humanValidationSpecIds, "D_VALIDATION_SET_INVALID");
  if (!Array.isArray(item.validationRunRefs)) throw new RalphArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_SET_INVALID: run refs");
  let lastSpecOrdinal = 0;
  let lastSpecId = "";
  let lastRunOrdinal = 0;
  for (const raw of item.validationRunRefs) {
    if (!isRecord(raw)) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_SET_INVALID: run ref");
    assertExactKeys(raw, ["validationRunId", "validationSpecId", "validationSpecDigest", "validationRunOrdinal", "artifactRef", "runDigest"], "D_VALIDATION_SET_INVALID");
    assertSafeIdentity(raw.validationRunId, "D_VALIDATION_SET_INVALID");
    assertSafeIdentity(raw.validationSpecId, "D_VALIDATION_SET_INVALID");
    assertDigest(raw.validationSpecDigest, "D_VALIDATION_SET_INVALID");
    assertSafeArtifactRef(raw.artifactRef, "D_VALIDATION_SET_INVALID");
    assertDigest(raw.runDigest, "D_VALIDATION_SET_INVALID");
    if (!Number.isSafeInteger(raw.validationRunOrdinal) || (raw.validationRunOrdinal as number) < 1) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_SET_INVALID: run ordinal");
    const specOrdinal = specOrdinalFromId(raw.validationSpecId as string);
    if (specOrdinal < lastSpecOrdinal || (specOrdinal === lastSpecOrdinal && (raw.validationSpecId as string) < lastSpecId)) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_SET_INVALID: order");
    if (specOrdinal === lastSpecOrdinal && (raw.validationRunOrdinal as number) < ((lastSpecId === raw.validationSpecId) ? lastRunOrdinal : 0)) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_SET_INVALID: retry order");
    lastSpecOrdinal = specOrdinal;
    lastSpecId = raw.validationSpecId as string;
    lastRunOrdinal = raw.validationRunOrdinal as number;
  }
  const { setDigest: _ignored, ...base } = item;
  if (sha256Canonical(base) !== item.setDigest) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_SET_INVALID: digest");
  assertNoCredentials(value, "D_VALIDATION_SET_CREDENTIAL");
}

export function createAuditPackageV2(input: Omit<AuditPackageV2, "schema" | "packageDigest">): AuditPackageV2 {
  validateAuditPackageInput(input);
  const base = { schema: AUDIT_PACKAGE_SCHEMA_V2, ...input };
  const result: AuditPackageV2 = { ...base, packageDigest: sha256Canonical(base) };
  validateAuditPackageV2(result);
  return result;
}

export function validateAuditPackageV2(value: unknown): asserts value is AuditPackageV2 {
  assertSafeArtifact(value, "D_AUDIT_PACKAGE_INVALID", [
    "schema", "runId", "phaseId", "taskId", "attemptId", "workUnitId", "workUnitDigest", "evidenceCaptureId", "evidenceDigest",
    "validationSetId", "validationSetDigest", "acceptanceCriteria", "constraints", "relevantContext", "openFindingRefs", "workspaceFingerprint",
    "postExecutorFingerprint", "auditability", "validationSummary", "packageDigest",
  ]);
  const item = value as Record<string, unknown>;
  if (item.schema !== AUDIT_PACKAGE_SCHEMA_V2) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "D_AUDIT_PACKAGE_INVALID: schema");
  for (const key of ["runId", "phaseId", "taskId", "attemptId", "workUnitId", "evidenceCaptureId"] as const) assertSafeIdentity(item[key], "D_AUDIT_PACKAGE_INVALID");
  for (const key of ["workspaceFingerprint", "postExecutorFingerprint"] as const) assertDigest(item[key], "D_AUDIT_PACKAGE_INVALID");
  for (const key of ["workUnitDigest", "evidenceDigest", "validationSetDigest", "packageDigest"] as const) assertDigest(item[key], "D_AUDIT_PACKAGE_INVALID");
  assertStringArray(item.acceptanceCriteria, "D_AUDIT_PACKAGE_INVALID");
  assertStringArray(item.relevantContext, "D_AUDIT_PACKAGE_INVALID");
  if (!isRecord(item.constraints)) throw new RalphArtifactError("B4_ARTIFACT_INVALID", "D_AUDIT_PACKAGE_INVALID: constraints");
  assertExactKeys(item.constraints, ["planIdentity", "taskTitle", "scope", "covers", "expectedEvidence"], "D_AUDIT_PACKAGE_INVALID");
  for (const key of ["planIdentity", "taskTitle", "scope", "covers", "expectedEvidence"] as const) assertText(item.constraints[key], "D_AUDIT_PACKAGE_INVALID", 4096);
  assertEnum(item.auditability, AUDITABILITY_CLASSIFICATIONS, "D_AUDIT_PACKAGE_INVALID");
  assertValidationSummary(item.validationSummary);
  if (!Array.isArray(item.openFindingRefs)) throw new RalphArtifactError("B4_ARTIFACT_INVALID", "D_AUDIT_PACKAGE_INVALID: findings");
  let previousFinding = "";
  for (const raw of item.openFindingRefs) {
    if (!isRecord(raw)) throw new RalphArtifactError("B4_ARTIFACT_INVALID", "D_AUDIT_PACKAGE_INVALID: finding ref");
    assertExactKeys(raw, ["findingId", "findingDigest", "status", "severity"], "D_AUDIT_PACKAGE_INVALID");
    assertSafeIdentity(raw.findingId, "D_AUDIT_PACKAGE_INVALID");
    assertDigest(raw.findingDigest, "D_AUDIT_PACKAGE_INVALID");
    assertEnum(raw.status, ["OPEN", "CANDIDATE_RESOLVED", "HUMAN_PENDING"] as const, "D_AUDIT_PACKAGE_INVALID");
    assertEnum(raw.severity, ["INFO", "LOW", "MEDIUM", "HIGH", "BLOCKER"] as const, "D_AUDIT_PACKAGE_INVALID");
    if ((raw.findingId as string) <= previousFinding) throw new RalphArtifactError("B4_ARTIFACT_INVALID", "D_AUDIT_PACKAGE_INVALID: finding order");
    previousFinding = raw.findingId as string;
  }
  const { packageDigest: _ignored, ...base } = item;
  if (sha256Canonical(base) !== item.packageDigest) throw new RalphArtifactError("B4_ARTIFACT_INVALID", "D_AUDIT_PACKAGE_INVALID: digest");
  assertNoCredentials(value, "D_AUDIT_PACKAGE_CREDENTIAL");
}

export async function persistValidationDiagnosticsV2(store: RalphEventStoreV2, value: ValidationDiagnosticsV2, nonce: string): Promise<ArtifactPersistenceResultV2<ValidationDiagnosticsV2>> {
  validateValidationDiagnosticsV2(value);
  return persistImmutableJsonArtifactV2({ store, ref: validationDiagnosticsRefV2(value.attemptId, value.validationRunId), artifact: value, validate: validateValidationDiagnosticsV2, nonce });
}

export async function readValidationDiagnosticsV2(store: RalphEventStoreV2, attemptId: string, validationRunId: string): Promise<ValidationDiagnosticsV2 | undefined> {
  return readImmutableJsonArtifactV2({ store, ref: validationDiagnosticsRefV2(attemptId, validationRunId), validate: validateValidationDiagnosticsV2 });
}

export async function persistValidationRunV2(store: RalphEventStoreV2, value: ValidationRunV2, nonce: string): Promise<ArtifactPersistenceResultV2<ValidationRunV2>> {
  validateValidationRunV2(value);
  return persistImmutableJsonArtifactV2({ store, ref: validationRunRefV2(value.attemptId, value.validationRunId), artifact: value, validate: validateValidationRunV2, nonce });
}

export async function readValidationRunV2(store: RalphEventStoreV2, attemptId: string, validationRunId: string): Promise<ValidationRunV2 | undefined> {
  return readImmutableJsonArtifactV2({ store, ref: validationRunRefV2(attemptId, validationRunId), validate: validateValidationRunV2 });
}

export async function persistValidationSetV2(store: RalphEventStoreV2, value: ValidationSetV2, nonce: string): Promise<ArtifactPersistenceResultV2<ValidationSetV2>> {
  validateValidationSetV2(value);
  await assertStableValidationSetRunsV2(store, value);
  return persistImmutableJsonArtifactV2({ store, ref: validationSetRefV2(value.attemptId), artifact: value, validate: validateValidationSetV2, nonce });
}

export async function readValidationSetV2(store: RalphEventStoreV2, attemptId: string): Promise<ValidationSetV2 | undefined> {
  const value = await readImmutableJsonArtifactV2({ store, ref: validationSetRefV2(attemptId), validate: validateValidationSetV2 });
  if (value) await assertStableValidationSetRunsV2(store, value);
  return value;
}

async function assertStableValidationSetRunsV2(store: RalphEventStoreV2, value: ValidationSetV2): Promise<void> {
  for (const binding of value.validationRunRefs) {
    const run = await readValidationRunV2(store, value.attemptId, binding.validationRunId);
    if (!run
      || run.runId !== value.runId
      || run.phaseId !== value.phaseId
      || run.taskId !== value.taskId
      || run.attemptId !== value.attemptId
      || run.validationSpecId !== binding.validationSpecId
      || run.validationSpecDigest !== binding.validationSpecDigest
      || run.validationRunOrdinal !== binding.validationRunOrdinal
      || validationRunRefV2(value.attemptId, run.validationRunId) !== binding.artifactRef
      || run.runDigest !== binding.runDigest
      || run.outcome === "PENDING") {
      throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_SET_INVALID: unstable ValidationRun binding");
    }
  }
}

export async function persistAuditPackageV2(store: RalphEventStoreV2, value: AuditPackageV2, nonce: string): Promise<ArtifactPersistenceResultV2<AuditPackageV2>> {
  validateAuditPackageV2(value);
  return persistImmutableJsonArtifactV2({ store, ref: auditPackageRefV2(value.attemptId), artifact: value, validate: validateAuditPackageV2, nonce });
}

export async function readAuditPackageV2(store: RalphEventStoreV2, attemptId: string): Promise<AuditPackageV2 | undefined> {
  return readImmutableJsonArtifactV2({ store, ref: auditPackageRefV2(attemptId), validate: validateAuditPackageV2 });
}

export function findingDigestV2(finding: Finding): string {
  return sha256Canonical(finding);
}

export function validationRunIdV2(runId: string, attemptId: string, spec: ValidationSpecRef, ordinal: number): string {
  assertSafeIdentity(runId, "D_VALIDATION_RUN_ID_INVALID");
  assertSafeIdentity(attemptId, "D_VALIDATION_RUN_ID_INVALID");
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) throw new RalphArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_RUN_ID_INVALID");
  return `vr-${sha256Canonical({ runId, attemptId, validationSpecId: spec.validationSpecId, validationSpecDigest: spec.digest, validationRunOrdinal: ordinal }).slice("sha256:".length)}`;
}

export function validationSetIdV2(runId: string, attemptId: string, evidence: { readonly evidenceCaptureId: string; readonly evidenceDigest: string }, runs: readonly ValidationRunV2[]): string {
  return `vs-${sha256Canonical({ runId, attemptId, evidenceCaptureId: evidence.evidenceCaptureId, evidenceDigest: evidence.evidenceDigest, runs: runs.map((run) => run.runDigest) }).slice("sha256:".length)}`;
}

export function auditPackageIdV2(packageValue: Omit<AuditPackageV2, "schema" | "packageDigest">): string {
  return `ap-${sha256Canonical(packageValue).slice("sha256:".length)}`;
}

export function validationRunToBindingV2(run: ValidationRunV2): ValidationRunBindingV2 {
  return {
    validationRunId: run.validationRunId,
    validationSpecId: run.validationSpecId,
    validationSpecDigest: run.validationSpecDigest,
    validationRunOrdinal: run.validationRunOrdinal,
    artifactRef: validationRunRefV2(run.attemptId, run.validationRunId),
    runDigest: run.runDigest,
  };
}

export function workspaceFingerprintFromManifestV2(manifest: WorkspaceManifestV2): string {
  return manifest.fingerprintDigest;
}

function validateValidationRunInput(input: Omit<ValidationRunV2, "schema" | "runDigest">): void {
  if (!isRecord(input)) throw new RalphArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_RUN_INVALID");
  for (const key of ["runId", "phaseId", "taskId", "attemptId", "validationSpecId", "validationSpecDigest", "validationRunId", "startedAt", "finishedAt"] as const) assertSafeIdentity(input[key], "D_VALIDATION_RUN_INVALID");
  assertText(input.instruction, "D_VALIDATION_RUN_INVALID", 4096);
  if (!isSha256Digest(input.validationSpecDigest) || !isSha256Digest(input.preValidationFingerprint) || !isSha256Digest(input.postValidationFingerprint)) throw new RalphArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_RUN_INVALID: digest");
  if (!VALIDATION_KINDS.includes(input.kind) || !VALIDATION_SEMANTIC_STATUSES.includes(input.semanticStatus) || !VALIDATION_INFRASTRUCTURE_STATUSES.includes(input.infrastructureStatus) || !VALIDATION_OUTCOMES.includes(input.outcome)) throw new RalphArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_RUN_INVALID: enum");
  assertStringArray(input.diagnosticRefs, "D_VALIDATION_RUN_INVALID");
  assertStringArray(input.diagnosticDigests, "D_VALIDATION_RUN_INVALID");
}

function validateValidationSetInput(input: Omit<ValidationSetV2, "schema" | "setDigest">): void {
  for (const key of ["runId", "phaseId", "taskId", "attemptId", "evidenceCaptureId"] as const) assertSafeIdentity(input[key], "D_VALIDATION_SET_INVALID");
  assertDigest(input.postExecutorFingerprint, "D_VALIDATION_SET_INVALID");
  for (const key of ["evidenceDigest"] as const) assertDigest(input[key], "D_VALIDATION_SET_INVALID");
  if (input.hardNegative !== input.summary.hardNegative) throw new RalphArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_SET_INVALID: hard negative");
}

function validateAuditPackageInput(input: Omit<AuditPackageV2, "schema" | "packageDigest">): void {
  for (const key of ["runId", "phaseId", "taskId", "attemptId", "workUnitId", "evidenceCaptureId"] as const) assertSafeIdentity(input[key], "D_AUDIT_PACKAGE_INVALID");
  assertDigest(input.workspaceFingerprint, "D_AUDIT_PACKAGE_INVALID");
  assertDigest(input.postExecutorFingerprint, "D_AUDIT_PACKAGE_INVALID");
  for (const key of ["workUnitDigest", "evidenceDigest", "validationSetDigest"] as const) assertDigest(input[key], "D_AUDIT_PACKAGE_INVALID");
}

function assertValidationOutcomeMapping(item: Record<string, unknown>): void {
  const kind = item.kind as ValidationKind;
  const infra = item.infrastructureStatus as ValidationInfrastructureStatusV2;
  const semantic = item.semanticStatus as ValidationSemanticStatusV2;
  const outcome = item.outcome as ValidationOutcome;
  if (infra !== "NONE" && outcome !== "INFRASTRUCTURE_FAILURE") throw new RalphArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_RUN_INVALID: infrastructure mapping");
  if (infra === "NONE" && outcome === "INFRASTRUCTURE_FAILURE") throw new RalphArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_RUN_INVALID: infrastructure mapping");
  if (infra !== "NONE" && semantic !== "UNPROVEN") throw new RalphArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_RUN_INVALID: infrastructure result cannot be semantic PASS/FAIL");
  if (infra === "NONE" && semantic === "PASS" && outcome !== "PASS") throw new RalphArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_RUN_INVALID: pass mapping");
  if (infra === "NONE" && semantic === "FAIL" && outcome !== "FAIL") throw new RalphArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_RUN_INVALID: fail mapping");
  if (infra === "NONE" && (semantic === "UNPROVEN" || semantic === "HUMAN_REQUIRED") && outcome !== "NOT_APPLICABLE") throw new RalphArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_RUN_INVALID: unproven mapping");
  if (semantic === "HUMAN_REQUIRED") throw new RalphArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_RUN_INVALID: unresolved human result");
  if (kind === "MANUAL" && (semantic !== "UNPROVEN" || infra !== "NONE" || outcome !== "NOT_APPLICABLE")) throw new RalphArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_RUN_INVALID: manual must remain unproven");
  if (kind === "HUMAN" && (semantic !== "PASS" && semantic !== "FAIL")) throw new RalphArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_RUN_INVALID: human result is not materialized");
  if (kind === "COMMAND" && infra === "NONE") {
    if (semantic !== "PASS" && semantic !== "FAIL") throw new RalphArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_RUN_INVALID: command result is not semantic");
    if (semantic === "PASS" && (item.exitCode !== 0 || item.signal !== null)) throw new RalphArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_RUN_INVALID: command pass termination");
    if (semantic === "FAIL" && item.exitCode === 0 && item.signal === null) throw new RalphArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_RUN_INVALID: command fail termination");
  }
  const timedOut = item.timedOut as boolean;
  const cancelled = item.cancelled as boolean;
  if (timedOut && cancelled) throw new RalphArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_RUN_INVALID: contradictory termination facts");
  if (infra === "TIMEOUT" && (!timedOut || cancelled)) throw new RalphArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_RUN_INVALID: timeout facts");
  if (infra === "CANCELLED" && (!cancelled || timedOut)) throw new RalphArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_RUN_INVALID: cancellation facts");
  if (infra !== "TIMEOUT" && timedOut) throw new RalphArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_RUN_INVALID: unexpected timeout fact");
  if (infra !== "CANCELLED" && cancelled) throw new RalphArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_RUN_INVALID: unexpected cancellation fact");
  if (infra === "NONE" && (timedOut || cancelled)) throw new RalphArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_RUN_INVALID: termination facts without infrastructure result");
}

function assertSafeArtifact(value: unknown, code: string, allowed: readonly string[]): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new RalphArtifactError("B4_ARTIFACT_INVALID", code);
  assertExactKeys(value, allowed, code);
}

function assertNoCredentials(value: unknown, code: string): void {
  try { assertNoCredentialMaterial(value, code); }
  catch (error) {
    if (error instanceof RalphCredentialSafetyError) throw new RalphArtifactError("B4_ARTIFACT_INVALID", code, error);
    throw error;
  }
}

function assertSafeIdentity(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\0") || value.includes("/")) throw new RalphArtifactError("B4_ARTIFACT_INVALID", code);
}

function assertText(value: unknown, code: string, max: number): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0")) throw new RalphArtifactError("B4_ARTIFACT_INVALID", code);
}

function assertBoundedText(value: unknown, code: string, max: number): asserts value is string {
  if (typeof value !== "string" || value.length > max || value.includes("\0")) throw new RalphArtifactError("B4_ARTIFACT_INVALID", code);
}

function assertDigest(value: unknown, code: string): asserts value is string {
  if (!isSha256Digest(value)) throw new RalphArtifactError("B4_ARTIFACT_INVALID", code);
}

function assertSafeArtifactRef(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || !/^attempts\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new RalphArtifactError("B4_ARTIFACT_INVALID", code);
}

function assertSafeArtifactRefOrDigest(value: unknown, code: string, ref: boolean): asserts value is string {
  if (ref) assertSafeArtifactRef(value, code);
  else assertDigest(value, code);
}

function assertStringArray(value: unknown, code: string): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0 || item.length > 4096 || item.includes("\0"))) throw new RalphArtifactError("B4_ARTIFACT_INVALID", code);
}

function assertValidationSummary(value: unknown): asserts value is DeterministicValidationSummary {
  if (!isRecord(value)) throw new RalphArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_SUMMARY_INVALID");
  assertExactKeys(value, ["total", "completed", "passed", "failed", "notApplicable", "infrastructureFailures", "manualRequired", "humanRequired", "hardNegative"], "D_VALIDATION_SUMMARY_INVALID");
  for (const key of ["total", "completed", "passed", "failed", "notApplicable", "infrastructureFailures", "manualRequired", "humanRequired"] as const) {
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0) throw new RalphArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_SUMMARY_INVALID");
  }
  if (typeof value.hardNegative !== "boolean"
    || value.completed !== (value.passed as number) + (value.failed as number) + (value.notApplicable as number) + (value.infrastructureFailures as number)
    || (value.completed as number) > (value.total as number)
    || value.hardNegative !== ((value.failed as number) > 0)) {
    throw new RalphArtifactError("B4_ARTIFACT_INVALID", "D_VALIDATION_SUMMARY_INVALID");
  }
}

function assertEnum<T extends readonly string[]>(value: unknown, values: T, code: string): asserts value is T[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new RalphArtifactError("B4_ARTIFACT_INVALID", code);
}

function assertExactKeys(value: object, allowed: readonly string[], code: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new RalphArtifactError("B4_ARTIFACT_INVALID", `${code}: ${unknown.sort().join(",")}`);
}

function assertSegment(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new RalphArtifactError("B4_ARTIFACT_PATH_UNSAFE");
}

function specOrdinalFromId(value: string): number {
  const match = value.match(/:validation:(\d+)$/);
  if (!match) return Number.MAX_SAFE_INTEGER;
  return Number(match[1]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Keep these imports visible in generated declarations and make the binding
// boundary explicit to callers that assemble D artifacts.
export type ValidationArtifactWorkUnitV2 = WorkUnitV2;
export type ValidationArtifactEvidenceV2 = EvidenceCaptureV2;
