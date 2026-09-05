import { join } from "node:path";
import type { RunSnapshot, SafeRuntimeDescriptor } from "./contracts.js";
import { canonicalJson } from "./canonical-json.js";
import { isSha256Digest } from "./hashing.js";
import { RalphEventStore, writeExclusiveRuntimeFile } from "./event-store.js";

const RUN_SNAPSHOT_KEYS = [
  "snapshotSchemaVersion", "runId", "projectIdentity", "readyPlanIdentity", "readyPlanHash", "readyManifestHash",
  "selectedReadyArtifactHashes", "readinessInspectionDigest", "effectiveRunConfig", "effectiveConfigDigest",
  "executorProfile", "auditorProfile", "executorCapabilities", "auditorCapabilities", "permissionEnforceDigest",
  "workspacePolicy", "initialFingerprint", "retryPolicy", "timeoutPolicy", "parallelismPolicy", "runtimeVersion", "createdAt",
] as const;

export function validateRunSnapshot(snapshot: unknown): asserts snapshot is RunSnapshot {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("RALPH_RUN_SNAPSHOT_MALFORMED");
  assertNoCredentials(snapshot, "$");
  assertExactKeys(snapshot, RUN_SNAPSHOT_KEYS, "RALPH_RUN_SNAPSHOT_UNKNOWN_FIELD");
  const candidate = snapshot as Partial<RunSnapshot>;
  if (candidate.snapshotSchemaVersion !== "rb-ralph-run-snapshot/v1") throw new Error("RALPH_RUN_SNAPSHOT_UNSUPPORTED_SCHEMA");
  if (!candidate.runId || !candidate.readyPlanHash || !candidate.readyManifestHash) throw new Error("RALPH_RUN_SNAPSHOT_IDENTITY_MISSING");
  if (!candidate.auditorCapabilities || candidate.auditorCapabilities.readOnlyEnforced === false) {
    throw new Error("RALPH_RUN_SNAPSHOT_AUDITOR_READ_ONLY_NOT_ENFORCED");
  }
  assertStringRecord(candidate.projectIdentity, "RALPH_RUN_SNAPSHOT_PROJECT_IDENTITY_INVALID");
  assertStringRecord(candidate.selectedReadyArtifactHashes, "RALPH_RUN_SNAPSHOT_ARTIFACT_HASHES_INVALID");
  for (const digest of [candidate.readyPlanHash, candidate.readyManifestHash, candidate.readinessInspectionDigest, candidate.effectiveConfigDigest, candidate.permissionEnforceDigest]) {
    if (typeof digest !== "string" || !isSha256Digest(digest)) throw new Error("RALPH_RUN_SNAPSHOT_INVALID_DIGEST");
  }
  assertProviderProfile(candidate.executorProfile);
  assertProviderProfile(candidate.auditorProfile);
  assertCapabilities(candidate.executorCapabilities);
  assertCapabilities(candidate.auditorCapabilities);
  assertSafeDescriptor(candidate.effectiveRunConfig, "effectiveRunConfig");
  assertSafeDescriptor(candidate.retryPolicy, "retryPolicy");
  assertSafeDescriptor(candidate.timeoutPolicy, "timeoutPolicy");
  assertSafeDescriptor(candidate.parallelismPolicy, "parallelismPolicy");
  if (candidate.effectiveRunConfig?.descriptorDigest !== candidate.effectiveConfigDigest) throw new Error("RALPH_RUN_SNAPSHOT_CONFIG_DIGEST_MISMATCH");
  assertWorkspacePolicy(candidate.workspacePolicy);
  assertFingerprint(candidate.initialFingerprint);
  if (typeof candidate.runtimeVersion !== "string" || typeof candidate.createdAt !== "string") throw new Error("RALPH_RUN_SNAPSHOT_METADATA_INVALID");
}

export async function persistImmutableRunSnapshot(
  store: RalphEventStore,
  snapshot: RunSnapshot,
  nonce: string,
): Promise<"created" | "already-present"> {
  validateRunSnapshot(snapshot);
  if (snapshot.runId !== store.runId) throw new Error("RALPH_RUN_SNAPSHOT_FOREIGN_RUN");
  await store.ensureLayout();
  const path = join(store.runDirectory, "run-snapshot.json");
  const bytes = Buffer.from(canonicalJson(snapshot), "utf8");
  try {
    return await writeExclusiveRuntimeFile(store.fileSystem, path, bytes, nonce);
  } catch (error) {
    if (error instanceof Error && error.message === "RALPH_RUNTIME_IMMUTABLE_VIOLATION") throw new Error("RALPH_RUN_SNAPSHOT_IMMUTABLE_VIOLATION");
    throw error;
  }
}

export async function readRunSnapshot(store: RalphEventStore): Promise<RunSnapshot> {
  await store.ensureLayout();
  const bytes = await store.fileSystem.readFile(join(store.runDirectory, "run-snapshot.json"));
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("RALPH_RUN_SNAPSHOT_MALFORMED_JSON"); }
  validateRunSnapshot(parsed);
  if (bytes.toString("utf8") !== canonicalJson(parsed)) throw new Error("RALPH_RUN_SNAPSHOT_NON_CANONICAL");
  if ((parsed as RunSnapshot).runId !== store.runId) throw new Error("RALPH_RUN_SNAPSHOT_FOREIGN_RUN");
  return parsed as RunSnapshot;
}

function assertSafeDescriptor(value: unknown, name: string): asserts value is SafeRuntimeDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`RALPH_RUN_SNAPSHOT_${name.toUpperCase()}_UNSAFE`);
  assertExactKeys(value, ["schemaVersion", "descriptorId", "descriptorDigest"], `RALPH_RUN_SNAPSHOT_${name.toUpperCase()}_UNKNOWN_FIELD`);
  const candidate = value as Partial<SafeRuntimeDescriptor>;
  if (typeof candidate.schemaVersion !== "string" || typeof candidate.descriptorId !== "string" || !isSha256Digest(candidate.descriptorDigest ?? "")) throw new Error(`RALPH_RUN_SNAPSHOT_${name.toUpperCase()}_UNSAFE`);
}

function assertProviderProfile(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RALPH_RUN_SNAPSHOT_PROFILE_INVALID");
  assertExactKeys(value, ["profileId", "providerId", "modelId", "descriptorDigest"], "RALPH_RUN_SNAPSHOT_PROFILE_UNKNOWN_FIELD");
  const candidate = value as Record<string, unknown>;
  if (["profileId", "providerId", "modelId"].some((key) => typeof candidate[key] !== "string") || !isSha256Digest(String(candidate.descriptorDigest))) throw new Error("RALPH_RUN_SNAPSHOT_PROFILE_INVALID");
}

function assertCapabilities(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RALPH_RUN_SNAPSHOT_CAPABILITIES_INVALID");
  assertExactKeys(value, ["requested", "granted", "verified", "readOnlyEnforced"], "RALPH_RUN_SNAPSHOT_CAPABILITIES_UNKNOWN_FIELD");
  const candidate = value as Record<string, unknown>;
  for (const key of ["requested", "granted", "verified"]) {
    if (!Array.isArray(candidate[key]) || (candidate[key] as unknown[]).some((item) => typeof item !== "string")) throw new Error("RALPH_RUN_SNAPSHOT_CAPABILITIES_INVALID");
  }
  if (typeof candidate.readOnlyEnforced !== "boolean") throw new Error("RALPH_RUN_SNAPSHOT_CAPABILITIES_INVALID");
}

function assertWorkspacePolicy(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RALPH_RUN_SNAPSHOT_POLICY_INVALID");
  assertExactKeys(value, ["format", "scopePaths", "coversPaths", "additionalExcludes", "generatedPaths", "policyDigest"], "RALPH_RUN_SNAPSHOT_POLICY_UNKNOWN_FIELD");
  const candidate = value as Record<string, unknown>;
  if (candidate.format !== "rb-ralph-workspace-policy/v1" || !isSha256Digest(String(candidate.policyDigest))) throw new Error("RALPH_RUN_SNAPSHOT_POLICY_INVALID");
  for (const key of ["scopePaths", "coversPaths", "additionalExcludes", "generatedPaths"]) {
    if (!Array.isArray(candidate[key]) || (candidate[key] as unknown[]).some((item) => typeof item !== "string")) throw new Error("RALPH_RUN_SNAPSHOT_POLICY_INVALID");
  }
}

function assertFingerprint(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RALPH_RUN_SNAPSHOT_FINGERPRINT_INVALID");
  assertExactKeys(value, ["controlPlaneFingerprint", "productWorkspaceFingerprint", "policyDigest", "fingerprintDigest"], "RALPH_RUN_SNAPSHOT_FINGERPRINT_UNKNOWN_FIELD");
  const candidate = value as Record<string, unknown>;
  for (const key of ["controlPlaneFingerprint", "productWorkspaceFingerprint", "policyDigest", "fingerprintDigest"]) if (!isSha256Digest(String(candidate[key]))) throw new Error("RALPH_RUN_SNAPSHOT_FINGERPRINT_INVALID");
}

function assertStringRecord(value: unknown, code: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some((item) => typeof item !== "string")) throw new Error(code);
}

function assertExactKeys(value: object, allowed: readonly string[], code: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new Error(`${code}: ${unknown.sort().join(",")}`);
}

function assertNoCredentials(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCredentials(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "string") {
    if (/-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/i.test(value) || /\bBearer\s+[A-Za-z0-9._~+/=-]+/i.test(value) || /(?:^|[\s"'=])(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,})(?:$|[\s"'])/.test(value)) {
      throw new Error(`RALPH_RUN_SNAPSHOT_CREDENTIAL_VALUE: ${path}`);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/(authorization|bearer|private[-_]?key|access[-_]?token|refresh[-_]?token|credential|secret|password|api[-_]?key|token)/i.test(key)) throw new Error(`RALPH_RUN_SNAPSHOT_CREDENTIAL_FIELD: ${path}.${key}`);
    assertNoCredentials(child, `${path}.${key}`);
  }
}
