import {
  WORKSPACE_FINGERPRINT_FORMAT,
  fingerprintWorkspace,
  type ExcludedRootSentinel,
  type FingerprintEntry,
  type WorkspaceFingerprint,
  type WorkspaceFingerprintFileSystem,
} from "../fingerprint.js";
import type { RalphEventStoreV2 } from "../operational-b1/index.js";
import { canonicalJson } from "../canonical-json.js";
import { isSha256Digest, sha256Canonical } from "../hashing.js";
import {
  attemptArtifactRefV2,
  persistImmutableJsonArtifactV2,
  readImmutableJsonArtifactV2,
  type ArtifactPersistenceResultV2,
  RalphB4ArtifactError,
} from "./artifacts.js";

export const RALPH_WORKSPACE_MANIFEST_SCHEMA_V2 = "rb-ralph-workspace-manifest/v1" as const;

export interface WorkspaceManifestV2 {
  readonly schema: typeof RALPH_WORKSPACE_MANIFEST_SCHEMA_V2;
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly invocationId: string;
  readonly policyDigest: string;
  readonly fingerprintDigest: string;
  readonly controlPlaneFingerprint: string;
  readonly productWorkspaceFingerprint: string;
  readonly controlPlaneEntries: readonly FingerprintEntry[];
  readonly productWorkspaceEntries: readonly FingerprintEntry[];
  readonly excludedRoots: readonly ExcludedRootSentinel[];
  readonly manifestDigest: string;
}

export interface WorkspaceManifestBindingV2 {
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly invocationId: string;
}

export interface WorkspaceManifestObservationV2 {
  readonly manifest: WorkspaceManifestV2;
  readonly fingerprint: WorkspaceFingerprint;
}

export function workspaceBeforeRefV2(attemptId: string): string {
  return attemptArtifactRefV2(attemptId, "workspace-before.json");
}

export function workspaceAfterRefV2(attemptId: string): string {
  return attemptArtifactRefV2(attemptId, "workspace-after.json");
}

export async function observeWorkspaceManifestV2(input: {
  readonly projectRoot: string;
  readonly policy: Parameters<typeof fingerprintWorkspace>[1];
  readonly binding: WorkspaceManifestBindingV2;
  readonly fileSystem?: WorkspaceFingerprintFileSystem;
}): Promise<WorkspaceManifestObservationV2> {
  const fingerprint = await fingerprintWorkspace(input.projectRoot, input.policy, undefined, input.fileSystem);
  const manifest = createWorkspaceManifestV2(input.binding, fingerprint);
  return { manifest, fingerprint };
}

export function createWorkspaceManifestV2(binding: WorkspaceManifestBindingV2, fingerprint: WorkspaceFingerprint): WorkspaceManifestV2 {
  assertSafeIdentity(binding.runId, "B4_WORKSPACE_MANIFEST_INVALID");
  assertSafeIdentity(binding.phaseId, "B4_WORKSPACE_MANIFEST_INVALID");
  assertSafeIdentity(binding.taskId, "B4_WORKSPACE_MANIFEST_INVALID");
  assertSafeIdentity(binding.attemptId, "B4_WORKSPACE_MANIFEST_INVALID");
  assertSafeIdentity(binding.invocationId, "B4_WORKSPACE_MANIFEST_INVALID");
  const expectedControlPlaneFingerprint = sha256Canonical({ format: WORKSPACE_FINGERPRINT_FORMAT, plane: "control", entries: fingerprint.controlPlaneEntries });
  const expectedProductWorkspaceFingerprint = sha256Canonical({ format: WORKSPACE_FINGERPRINT_FORMAT, plane: "product", entries: fingerprint.productWorkspaceEntries, excludedRoots: fingerprint.excludedRoots });
  const expectedFingerprintDigest = sha256Canonical({
    format: WORKSPACE_FINGERPRINT_FORMAT,
    controlPlaneFingerprint: expectedControlPlaneFingerprint,
    productWorkspaceFingerprint: expectedProductWorkspaceFingerprint,
    policyDigest: fingerprint.policyDigest,
    controlPlaneEntries: fingerprint.controlPlaneEntries,
    productWorkspaceEntries: fingerprint.productWorkspaceEntries,
    excludedRoots: fingerprint.excludedRoots,
  });
  if (fingerprint.format !== WORKSPACE_FINGERPRINT_FORMAT || fingerprint.vcsMetadata !== undefined || !isSha256Digest(fingerprint.policyDigest) || !isSha256Digest(fingerprint.controlPlaneFingerprint) || !isSha256Digest(fingerprint.productWorkspaceFingerprint) || !isSha256Digest(fingerprint.fingerprintDigest) || expectedControlPlaneFingerprint !== fingerprint.controlPlaneFingerprint || expectedProductWorkspaceFingerprint !== fingerprint.productWorkspaceFingerprint || expectedFingerprintDigest !== fingerprint.fingerprintDigest) {
    throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_WORKSPACE_MANIFEST_INVALID: fingerprint identity is invalid");
  }
  const base = {
    schema: RALPH_WORKSPACE_MANIFEST_SCHEMA_V2,
    runId: binding.runId,
    phaseId: binding.phaseId,
    taskId: binding.taskId,
    attemptId: binding.attemptId,
    invocationId: binding.invocationId,
    policyDigest: fingerprint.policyDigest,
    fingerprintDigest: fingerprint.fingerprintDigest,
    controlPlaneFingerprint: fingerprint.controlPlaneFingerprint,
    productWorkspaceFingerprint: fingerprint.productWorkspaceFingerprint,
    controlPlaneEntries: fingerprint.controlPlaneEntries.map((entry) => ({ ...entry })),
    productWorkspaceEntries: fingerprint.productWorkspaceEntries.map((entry) => ({ ...entry })),
    excludedRoots: fingerprint.excludedRoots.map((entry) => ({ ...entry })),
  };
  const manifest: WorkspaceManifestV2 = { ...base, manifestDigest: sha256Canonical(base) };
  validateWorkspaceManifestV2(manifest);
  return manifest;
}

export function validateWorkspaceManifestV2(value: unknown): asserts value is WorkspaceManifestV2 {
  if (!isRecord(value)) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_WORKSPACE_MANIFEST_INVALID");
  assertExactKeys(value, [
    "schema", "runId", "phaseId", "taskId", "attemptId", "invocationId", "policyDigest", "fingerprintDigest",
    "controlPlaneFingerprint", "productWorkspaceFingerprint", "controlPlaneEntries", "productWorkspaceEntries", "excludedRoots", "manifestDigest",
  ]);
  if (value.schema !== RALPH_WORKSPACE_MANIFEST_SCHEMA_V2) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_WORKSPACE_MANIFEST_INVALID: schema");
  for (const key of ["runId", "phaseId", "taskId", "attemptId", "invocationId"] as const) assertSafeIdentity(value[key], "B4_WORKSPACE_MANIFEST_INVALID");
  for (const key of ["policyDigest", "fingerprintDigest", "controlPlaneFingerprint", "productWorkspaceFingerprint", "manifestDigest"] as const) {
    if (!isSha256Digest(value[key])) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_WORKSPACE_MANIFEST_INVALID: digest");
  }
  assertEntries(value.controlPlaneEntries);
  assertEntries(value.productWorkspaceEntries);
  assertExcludedRoots(value.excludedRoots);
  const { manifestDigest: _ignored, ...base } = value;
  if (sha256Canonical(base) !== value.manifestDigest) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_WORKSPACE_MANIFEST_INVALID: digest mismatch");
}

export async function persistWorkspaceBeforeManifestV2(
  store: RalphEventStoreV2,
  manifest: WorkspaceManifestV2,
  nonce: string,
): Promise<ArtifactPersistenceResultV2<WorkspaceManifestV2>> {
  validateWorkspaceManifestV2(manifest);
  return persistImmutableJsonArtifactV2({ store, ref: workspaceBeforeRefV2(manifest.attemptId), artifact: manifest, validate: validateWorkspaceManifestV2, nonce });
}

export async function persistWorkspaceAfterManifestV2(
  store: RalphEventStoreV2,
  manifest: WorkspaceManifestV2,
  nonce: string,
): Promise<ArtifactPersistenceResultV2<WorkspaceManifestV2>> {
  validateWorkspaceManifestV2(manifest);
  return persistImmutableJsonArtifactV2({ store, ref: workspaceAfterRefV2(manifest.attemptId), artifact: manifest, validate: validateWorkspaceManifestV2, nonce });
}

export async function readWorkspaceBeforeManifestV2(store: RalphEventStoreV2, attemptId: string): Promise<WorkspaceManifestV2 | undefined> {
  return readImmutableJsonArtifactV2({ store, ref: workspaceBeforeRefV2(attemptId), validate: validateWorkspaceManifestV2 });
}

export async function readWorkspaceAfterManifestV2(store: RalphEventStoreV2, attemptId: string): Promise<WorkspaceManifestV2 | undefined> {
  return readImmutableJsonArtifactV2({ store, ref: workspaceAfterRefV2(attemptId), validate: validateWorkspaceManifestV2 });
}

export function workspaceManifestCoreJson(manifest: WorkspaceManifestV2): string {
  const { manifestDigest: _ignored, ...base } = manifest;
  return canonicalJson(base);
}

export function workspaceManifestEntries(manifest: WorkspaceManifestV2): readonly FingerprintEntry[] {
  return [...manifest.controlPlaneEntries, ...manifest.productWorkspaceEntries];
}

function assertEntries(value: unknown): asserts value is readonly FingerprintEntry[] {
  if (!Array.isArray(value)) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_WORKSPACE_MANIFEST_INVALID: entries");
  for (const entry of value) {
    if (!isRecord(entry)) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_WORKSPACE_MANIFEST_INVALID: entry");
    // Fingerprint entries deliberately omit metadata that is not meaningful
    // for their kind (for example, directories have no contentHash).
    assertExactKeys(entry, ["path", "kind", "mode", "size", "contentHash", "target"]);
    if (typeof entry.path !== "string" || entry.path.length === 0 || entry.path.startsWith("/") || entry.path.split("/").includes("..")) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_WORKSPACE_MANIFEST_INVALID: path");
    if (!(["file", "directory", "symlink"] as const).includes(entry.kind as "file" | "directory" | "symlink")) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_WORKSPACE_MANIFEST_INVALID: kind");
    if (typeof entry.mode !== "number" || !Number.isSafeInteger(entry.mode) || entry.mode < 0) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_WORKSPACE_MANIFEST_INVALID: mode");
    if (entry.size !== undefined && (typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0)) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_WORKSPACE_MANIFEST_INVALID: size");
    if (entry.contentHash !== undefined && !isSha256Digest(entry.contentHash)) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_WORKSPACE_MANIFEST_INVALID: content hash");
    if (entry.target !== undefined && typeof entry.target !== "string") throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_WORKSPACE_MANIFEST_INVALID: symlink target");
  }
}

function assertExcludedRoots(value: unknown): asserts value is WorkspaceManifestV2["excludedRoots"] {
  if (!Array.isArray(value)) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_WORKSPACE_MANIFEST_INVALID: excluded roots");
  for (const entry of value) {
    if (!isRecord(entry)) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_WORKSPACE_MANIFEST_INVALID: sentinel");
    assertExactKeys(entry, ["path", "kind", "exists", "mode", "policyRule"]);
    if (typeof entry.path !== "string" || entry.path.length === 0 || entry.path.startsWith("/") || entry.path.split("/").includes("..") || typeof entry.policyRule !== "string" || entry.policyRule.length === 0) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_WORKSPACE_MANIFEST_INVALID: sentinel identity");
    if (!(["file", "directory", "symlink", "special"] as const).includes(entry.kind as "file" | "directory" | "symlink" | "special") || entry.exists !== true) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_WORKSPACE_MANIFEST_INVALID: sentinel shape");
    if (entry.mode !== null && (typeof entry.mode !== "number" || !Number.isSafeInteger(entry.mode) || entry.mode < 0)) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_WORKSPACE_MANIFEST_INVALID: sentinel mode");
  }
}

function assertExactKeys(value: object, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", `B4_WORKSPACE_MANIFEST_INVALID: unknown fields ${unknown.sort().join(",")}`);
}

function assertSafeIdentity(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\0") || value.includes("/")) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
