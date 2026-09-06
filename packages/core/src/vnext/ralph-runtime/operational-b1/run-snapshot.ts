import { join } from "node:path";
import type { RalphRuntimeFileSystem } from "../event-store.js";
import { writeExclusiveRuntimeFile } from "../event-store.js";
import type { CapabilityMetadata, FingerprintIdentity, SafeRuntimeDescriptor, WorkspacePolicy } from "../contracts.js";
import { canonicalJson } from "../canonical-json.js";
import { isSha256Digest, sha256Canonical } from "../hashing.js";
import {
  EVENT_SCHEMA_V2,
  OPERATIONAL_CONTRACT_V2,
  STATE_SCHEMA_V2,
} from "../operational-v2/contracts.js";
import { validateRalphRunId } from "../event-store.js";
import { assertNoCredentialMaterial, RalphCredentialSafetyError } from "./secret-safety.js";

export const RALPH_RUN_SNAPSHOT_V2_SCHEMA = "rb-ralph-run-snapshot/v2" as const;

export interface ScriptedProfileV2 {
  readonly profileId: string;
  readonly kind: "scripted";
  readonly descriptorDigest: string;
}

export interface RunSnapshotV2 {
  readonly snapshotSchemaVersion: typeof RALPH_RUN_SNAPSHOT_V2_SCHEMA;
  readonly runId: string;
  readonly eventSchema: typeof EVENT_SCHEMA_V2;
  readonly stateSchema: typeof STATE_SCHEMA_V2;
  readonly operationalContract: typeof OPERATIONAL_CONTRACT_V2;
  readonly projectIdentity: Readonly<Record<string, string>>;
  readonly readyPlanIdentity: string;
  readonly readyPlanHash: string;
  readonly readyManifestHash: string;
  readonly selectedReadyArtifactHashes: Readonly<Record<string, string>>;
  readonly readinessInspectionDigest: string;
  readonly effectiveRunConfig: SafeRuntimeDescriptor;
  readonly effectiveConfigDigest: string;
  readonly diagnosticsPolicy: SafeRuntimeDescriptor;
  readonly environmentPolicy: SafeRuntimeDescriptor;
  readonly executorProfile: ScriptedProfileV2;
  readonly executorCapabilities: CapabilityMetadata;
  readonly permissionCapabilityPolicy: SafeRuntimeDescriptor;
  readonly workspacePolicy: WorkspacePolicy;
  readonly initialWorkspaceFingerprint: FingerprintIdentity;
  readonly retryPolicies: SafeRuntimeDescriptor;
  readonly timeoutPolicy: SafeRuntimeDescriptor;
  readonly runtimeIdentity: SafeRuntimeDescriptor;
  readonly leasePolicy: SafeRuntimeDescriptor;
  readonly createdAt: string;
}

export interface OperationalRunV2Storage {
  readonly runId: string;
  readonly runDirectory: string;
  readonly fileSystem: RalphRuntimeFileSystem;
  readonly ensureLayout: () => Promise<void>;
  /** Used only to prevent V2 birth from overlaying an existing physical ledger. */
  readonly inspectPhysicalLedgerForOpen: () => Promise<{ readonly lastSequence: number }>;
}

export class RalphRunSnapshotV2Error extends Error {
  constructor(readonly code: string, readonly recoverable = false, message = code) {
    super(message);
    this.name = "RalphRunSnapshotV2Error";
  }
}

const RUN_SNAPSHOT_V2_KEYS = [
  "snapshotSchemaVersion", "runId", "eventSchema", "stateSchema", "operationalContract", "projectIdentity",
  "readyPlanIdentity", "readyPlanHash", "readyManifestHash", "selectedReadyArtifactHashes", "readinessInspectionDigest",
  "effectiveRunConfig", "effectiveConfigDigest", "diagnosticsPolicy", "environmentPolicy", "executorProfile",
  "executorCapabilities", "permissionCapabilityPolicy", "workspacePolicy", "initialWorkspaceFingerprint", "retryPolicies",
  "timeoutPolicy", "runtimeIdentity", "leasePolicy", "createdAt",
] as const;

export function validateRunSnapshotV2(value: unknown): asserts value is RunSnapshotV2 {
  try { assertNoCredentialMaterial(value, "RALPH_V2_RUN_SNAPSHOT_CREDENTIAL"); }
  catch (error) {
    if (error instanceof RalphCredentialSafetyError) throw new RalphRunSnapshotV2Error(error.code);
    throw error;
  }
  if (!isRecord(value)) throw new RalphRunSnapshotV2Error("RALPH_V2_RUN_SNAPSHOT_MALFORMED");
  assertExactKeys(value, RUN_SNAPSHOT_V2_KEYS, "RALPH_V2_RUN_SNAPSHOT_UNKNOWN_FIELD");
  const snapshot = value as Partial<RunSnapshotV2>;
  if (snapshot.snapshotSchemaVersion !== RALPH_RUN_SNAPSHOT_V2_SCHEMA) {
    throw new RalphRunSnapshotV2Error("RALPH_V2_RUN_SNAPSHOT_UNSUPPORTED_SCHEMA");
  }
  if (typeof snapshot.runId !== "string" || snapshot.runId.length === 0) {
    throw new RalphRunSnapshotV2Error("RALPH_V2_RUN_SNAPSHOT_INVALID_RUN_ID");
  }
  try { validateRalphRunId(snapshot.runId); }
  catch { throw new RalphRunSnapshotV2Error("RALPH_V2_RUN_SNAPSHOT_INVALID_RUN_ID"); }
  if (snapshot.eventSchema !== EVENT_SCHEMA_V2 || snapshot.stateSchema !== STATE_SCHEMA_V2 || snapshot.operationalContract !== OPERATIONAL_CONTRACT_V2) {
    throw new RalphRunSnapshotV2Error("RALPH_V2_RUN_SNAPSHOT_IDENTITY_MISMATCH");
  }
  assertStringRecord(snapshot.projectIdentity, "RALPH_V2_RUN_SNAPSHOT_PROJECT_IDENTITY_INVALID");
  assertNonEmptyString(snapshot.readyPlanIdentity, "RALPH_V2_RUN_SNAPSHOT_PLAN_IDENTITY_INVALID");
  for (const digest of [snapshot.readyPlanHash, snapshot.readyManifestHash, snapshot.readinessInspectionDigest, snapshot.effectiveConfigDigest]) {
    assertDigest(digest, "RALPH_V2_RUN_SNAPSHOT_INVALID_DIGEST");
  }
  assertDigestRecord(snapshot.selectedReadyArtifactHashes, "RALPH_V2_RUN_SNAPSHOT_ARTIFACT_HASHES_INVALID");
  assertSafeDescriptor(snapshot.effectiveRunConfig, "effectiveRunConfig");
  assertSafeDescriptor(snapshot.diagnosticsPolicy, "diagnosticsPolicy");
  assertSafeDescriptor(snapshot.environmentPolicy, "environmentPolicy");
  if (snapshot.effectiveRunConfig?.descriptorDigest !== snapshot.effectiveConfigDigest) {
    throw new RalphRunSnapshotV2Error("RALPH_V2_RUN_SNAPSHOT_CONFIG_DIGEST_MISMATCH");
  }
  assertScriptedProfile(snapshot.executorProfile);
  assertCapabilities(snapshot.executorCapabilities);
  assertSafeDescriptor(snapshot.permissionCapabilityPolicy, "permissionCapabilityPolicy");
  assertWorkspacePolicy(snapshot.workspacePolicy);
  assertFingerprint(snapshot.initialWorkspaceFingerprint);
  if (snapshot.initialWorkspaceFingerprint?.policyDigest !== snapshot.workspacePolicy?.policyDigest) {
    throw new RalphRunSnapshotV2Error("RALPH_V2_RUN_SNAPSHOT_FINGERPRINT_POLICY_MISMATCH");
  }
  assertSafeDescriptor(snapshot.retryPolicies, "retryPolicies");
  assertSafeDescriptor(snapshot.timeoutPolicy, "timeoutPolicy");
  assertSafeDescriptor(snapshot.runtimeIdentity, "runtimeIdentity");
  assertSafeDescriptor(snapshot.leasePolicy, "leasePolicy");
  assertNonEmptyString(snapshot.createdAt, "RALPH_V2_RUN_SNAPSHOT_CREATED_AT_INVALID");
}

export async function persistRunSnapshotV2(
  storage: OperationalRunV2Storage,
  snapshot: RunSnapshotV2,
  nonce: string,
): Promise<"created" | "already-present"> {
  validateRunSnapshotV2(snapshot);
  if (snapshot.runId !== storage.runId) throw new RalphRunSnapshotV2Error("RALPH_V2_RUN_SNAPSHOT_FOREIGN_RUN");
  await storage.ensureLayout();
  let snapshotAlreadyExists = true;
  try {
    await readRunSnapshotV2File(storage);
  } catch (error) {
    if (error instanceof RalphRunSnapshotV2Error && error.code === "RALPH_V2_RUN_SNAPSHOT_MISSING") snapshotAlreadyExists = false;
    else throw error;
  }
  if (!snapshotAlreadyExists) {
    const ledger = await storage.inspectPhysicalLedgerForOpen();
    if (ledger.lastSequence > 0) throw new RalphRunSnapshotV2Error("RALPH_V2_RUN_SNAPSHOT_LEDGER_ALREADY_EXISTS");
  }
  const path = join(storage.runDirectory, "run-snapshot.json");
  const bytes = Buffer.from(canonicalJson(snapshot), "utf8");
  try {
    return await writeExclusiveRuntimeFile(storage.fileSystem, path, bytes, nonce);
  } catch (error) {
    if (error instanceof Error && error.message === "RALPH_RUNTIME_IMMUTABLE_VIOLATION") {
      throw new RalphRunSnapshotV2Error("RALPH_V2_RUN_SNAPSHOT_IMMUTABLE_VIOLATION");
    }
    throw error;
  }
}

export async function readRunSnapshotV2(storage: OperationalRunV2Storage): Promise<RunSnapshotV2> {
  await storage.ensureLayout();
  return readRunSnapshotV2File(storage);
}

export const persistImmutableRunSnapshotV2 = persistRunSnapshotV2;

/** Reads an already-layout-verified immutable identity without recursing into a store facade. */
export async function readRunSnapshotV2File(storage: OperationalRunV2Storage): Promise<RunSnapshotV2> {
  const path = join(storage.runDirectory, "run-snapshot.json");
  let bytes: Buffer;
  try {
    const stats = await storage.fileSystem.lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new RalphRunSnapshotV2Error("RALPH_V2_RUN_SNAPSHOT_FILE_UNSAFE");
    }
    bytes = await storage.fileSystem.readFile(path);
  } catch (error) {
    if (error instanceof RalphRunSnapshotV2Error) throw error;
    if (isMissing(error)) throw new RalphRunSnapshotV2Error("RALPH_V2_RUN_SNAPSHOT_MISSING");
    throw error;
  }

  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch { throw new RalphRunSnapshotV2Error("RALPH_V2_RUN_SNAPSHOT_MALFORMED_JSON"); }
  if (isRecord(parsed) && parsed.snapshotSchemaVersion === "rb-ralph-run-snapshot/v1") {
    throw new RalphRunSnapshotV2Error("RALPH_V2_WRONG_RUN_FAMILY");
  }
  validateRunSnapshotV2(parsed);
  if (bytes.toString("utf8") !== canonicalJson(parsed)) throw new RalphRunSnapshotV2Error("RALPH_V2_RUN_SNAPSHOT_NON_CANONICAL");
  if (parsed.runId !== storage.runId) throw new RalphRunSnapshotV2Error("RALPH_V2_RUN_SNAPSHOT_FOREIGN_RUN");
  return parsed;
}

function assertScriptedProfile(value: unknown): asserts value is ScriptedProfileV2 {
  if (!isRecord(value)) throw new RalphRunSnapshotV2Error("RALPH_V2_RUN_SNAPSHOT_EXECUTOR_PROFILE_INVALID");
  assertExactKeys(value, ["profileId", "kind", "descriptorDigest"], "RALPH_V2_RUN_SNAPSHOT_EXECUTOR_PROFILE_UNKNOWN_FIELD");
  if (typeof value.profileId !== "string" || value.profileId.length === 0 || value.kind !== "scripted") {
    throw new RalphRunSnapshotV2Error("RALPH_V2_RUN_SNAPSHOT_EXECUTOR_PROFILE_UNSUPPORTED");
  }
  assertDigest(value.descriptorDigest, "RALPH_V2_RUN_SNAPSHOT_EXECUTOR_PROFILE_INVALID");
}

function assertSafeDescriptor(value: unknown, name: string): asserts value is SafeRuntimeDescriptor {
  if (!isRecord(value)) throw new RalphRunSnapshotV2Error(`RALPH_V2_RUN_SNAPSHOT_${name.toUpperCase()}_UNSAFE`);
  assertExactKeys(value, ["schemaVersion", "descriptorId", "descriptorDigest"], `RALPH_V2_RUN_SNAPSHOT_${name.toUpperCase()}_UNKNOWN_FIELD`);
  if (typeof value.schemaVersion !== "string" || value.schemaVersion.length === 0 || typeof value.descriptorId !== "string" || value.descriptorId.length === 0) {
    throw new RalphRunSnapshotV2Error(`RALPH_V2_RUN_SNAPSHOT_${name.toUpperCase()}_UNSAFE`);
  }
  assertDigest(value.descriptorDigest, `RALPH_V2_RUN_SNAPSHOT_${name.toUpperCase()}_UNSAFE`);
}

function assertCapabilities(value: unknown): asserts value is CapabilityMetadata {
  if (!isRecord(value)) throw new RalphRunSnapshotV2Error("RALPH_V2_RUN_SNAPSHOT_CAPABILITIES_INVALID");
  assertExactKeys(value, ["requested", "granted", "verified", "readOnlyEnforced"], "RALPH_V2_RUN_SNAPSHOT_CAPABILITIES_UNKNOWN_FIELD");
  for (const key of ["requested", "granted", "verified"] as const) {
    if (!Array.isArray(value[key]) || value[key].some((item) => typeof item !== "string" || item.length === 0)) {
      throw new RalphRunSnapshotV2Error("RALPH_V2_RUN_SNAPSHOT_CAPABILITIES_INVALID");
    }
  }
  if (typeof value.readOnlyEnforced !== "boolean") throw new RalphRunSnapshotV2Error("RALPH_V2_RUN_SNAPSHOT_CAPABILITIES_INVALID");
}

function assertWorkspacePolicy(value: unknown): asserts value is WorkspacePolicy {
  if (!isRecord(value)) throw new RalphRunSnapshotV2Error("RALPH_V2_RUN_SNAPSHOT_WORKSPACE_POLICY_INVALID");
  assertExactKeys(value, ["format", "scopePaths", "coversPaths", "additionalExcludes", "generatedPaths", "policyDigest"], "RALPH_V2_RUN_SNAPSHOT_WORKSPACE_POLICY_UNKNOWN_FIELD");
  if (value.format !== "rb-ralph-workspace-policy/v1") throw new RalphRunSnapshotV2Error("RALPH_V2_RUN_SNAPSHOT_WORKSPACE_POLICY_INVALID");
  for (const key of ["scopePaths", "coversPaths", "additionalExcludes", "generatedPaths"] as const) {
    if (!Array.isArray(value[key]) || value[key].some((item) => typeof item !== "string")) throw new RalphRunSnapshotV2Error("RALPH_V2_RUN_SNAPSHOT_WORKSPACE_POLICY_INVALID");
  }
  assertDigest(value.policyDigest, "RALPH_V2_RUN_SNAPSHOT_WORKSPACE_POLICY_INVALID");
  const policyBase = {
    format: value.format,
    scopePaths: value.scopePaths,
    coversPaths: value.coversPaths,
    additionalExcludes: value.additionalExcludes,
  };
  if (sha256Canonical(policyBase) !== value.policyDigest) throw new RalphRunSnapshotV2Error("RALPH_V2_RUN_SNAPSHOT_WORKSPACE_POLICY_DIGEST_MISMATCH");
}

function assertFingerprint(value: unknown): asserts value is FingerprintIdentity {
  if (!isRecord(value)) throw new RalphRunSnapshotV2Error("RALPH_V2_RUN_SNAPSHOT_FINGERPRINT_INVALID");
  assertExactKeys(value, ["controlPlaneFingerprint", "productWorkspaceFingerprint", "policyDigest", "fingerprintDigest"], "RALPH_V2_RUN_SNAPSHOT_FINGERPRINT_UNKNOWN_FIELD");
  for (const key of ["controlPlaneFingerprint", "productWorkspaceFingerprint", "policyDigest", "fingerprintDigest"] as const) assertDigest(value[key], "RALPH_V2_RUN_SNAPSHOT_FINGERPRINT_INVALID");
}

function assertDigest(value: unknown, code: string): asserts value is string {
  if (!isSha256Digest(value)) throw new RalphRunSnapshotV2Error(code);
}

function assertDigestRecord(value: unknown, code: string): asserts value is Readonly<Record<string, string>> {
  if (!isRecord(value) || Object.values(value).some((item) => !isSha256Digest(item))) throw new RalphRunSnapshotV2Error(code);
}

function assertStringRecord(value: unknown, code: string): asserts value is Readonly<Record<string, string>> {
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== "string" || item.length === 0)) throw new RalphRunSnapshotV2Error(code);
}

function assertNonEmptyString(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new RalphRunSnapshotV2Error(code);
}

function assertExactKeys(value: object, allowed: readonly string[], code: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new RalphRunSnapshotV2Error(`${code}: ${unknown.sort().join(",")}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}
