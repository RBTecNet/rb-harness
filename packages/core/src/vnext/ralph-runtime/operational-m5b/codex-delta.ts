import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { scopeTokenCoversPath } from "../../../path-ownership.js";
import { sha256, sha256Canonical } from "../hashing.js";
import { isWorkspacePackageInfrastructurePathV1 } from "../package-infrastructure.js";
import { M5B_LIMITS_V2, RalphM5BError } from "./contract.js";
import {
  assertSafeRelativePathV2,
  isCodexProjectionExcludedPathV2,
  type CodexProjectionEntryV2,
} from "./codex-projection.js";

export const RALPH_CODEX_WORKSPACE_DELTA_SCHEMA_V2 = "rb-ralph-codex-workspace-delta/v1" as const;

export const CODEX_DELTA_OPERATIONS_V2 = ["CREATE", "MODIFY", "DELETE"] as const;
export type CodexDeltaOperationV2 = typeof CODEX_DELTA_OPERATIONS_V2[number];

export interface CodexDeltaEntryV2 {
  readonly path: string;
  readonly operation: CodexDeltaOperationV2;
  readonly preimageDigest: string | null;
  readonly postimageDigest: string | null;
  readonly mode: number | null;
  readonly postimageSize: number | null;
  /** Sealed provider bytes; publication is a transport, never an author. */
  readonly postimageBase64: string | null;
}

export interface CodexWorkspaceDeltaV2 {
  readonly schema: typeof RALPH_CODEX_WORKSPACE_DELTA_SCHEMA_V2;
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly invocationId: string;
  readonly providerDescriptorDigest: string;
  readonly threadBindingDigest: string;
  readonly threadId: string;
  readonly baseWorkspaceFingerprint: string;
  readonly projectionManifestDigest: string;
  readonly projectionBaselineDigest: string;
  readonly providerResultDigest: string;
  readonly entries: readonly CodexDeltaEntryV2[];
  readonly entryCount: number;
  readonly totalPostimageBytes: number;
  readonly deltaDigest: string;
  readonly createdAt: string;
  readonly artifactDigest: string;
}

export interface DeriveCodexDeltaInputV2 {
  readonly stagingWorkspace: string;
  readonly baseline: readonly CodexProjectionEntryV2[];
  readonly final: readonly CodexProjectionEntryV2[];
  readonly scope: string;
  readonly covers: string;
}

/**
 * The delta is derived by comparing two host filesystem observations of the
 * staging projection.  No provider prose and no JSONL command event
 * participates: the model cannot describe a change into existence, nor
 * conceal one it made.
 */
export function deriveCodexWorkspaceDeltaEntriesV2(input: DeriveCodexDeltaInputV2): readonly Omit<CodexDeltaEntryV2, "postimageBase64">[] {
  const ownership = [...tokenizeOwnership(input.scope), ...tokenizeOwnership(input.covers)];
  if (ownership.length === 0) throw new RalphM5BError("M5B_DELTA_OUT_OF_SCOPE", "M5B_DELTA_OUT_OF_SCOPE: the WorkUnit declares no owned path");
  const baselineFiles = fileMap(input.baseline);
  const finalFiles = fileMap(input.final);
  const entries: Omit<CodexDeltaEntryV2, "postimageBase64">[] = [];

  for (const path of [...new Set([...baselineFiles.keys(), ...finalFiles.keys()])].sort()) {
    const before = baselineFiles.get(path);
    const after = finalFiles.get(path);
    if (before && after && before.contentHash === after.contentHash && before.mode === after.mode) continue;
    assertPublishablePathV2(path, ownership);
    if (before && after) {
      if (before.mode !== after.mode) throw new RalphM5BError("M5B_DELTA_UNSUPPORTED_MUTATION", `M5B_DELTA_UNSUPPORTED_MUTATION: mode change on ${path}`);
      entries.push({ path, operation: "MODIFY", preimageDigest: before.contentHash, postimageDigest: after.contentHash, mode: after.mode, postimageSize: after.size });
      continue;
    }
    if (after) {
      if (after.mode !== 0o644 && after.mode !== 0o755) throw new RalphM5BError("M5B_DELTA_UNSUPPORTED_MUTATION", `M5B_DELTA_UNSUPPORTED_MUTATION: mode on ${path}`);
      entries.push({ path, operation: "CREATE", preimageDigest: null, postimageDigest: after.contentHash, mode: after.mode, postimageSize: after.size });
      continue;
    }
    entries.push({ path, operation: "DELETE", preimageDigest: before!.contentHash, postimageDigest: null, mode: null, postimageSize: null });
  }

  // The publication contract is file-authoritative: directories have no
  // delta operation or sealed bytes. Parents are materialized only as
  // transport for an independently authorized CREATE file, while empty
  // directory trees disappear with the disposable provider projection.
  // Every file above remains checked separately, so a parent never confers
  // authority on an unowned child or sibling.

  if (entries.length > M5B_LIMITS_V2.deltaMaxEntries) throw new RalphM5BError("M5B_DELTA_LIMIT_EXCEEDED", "M5B_DELTA_LIMIT_EXCEEDED: entry count");
  return Object.freeze(entries);
}

export interface CreateCodexWorkspaceDeltaInputV2 extends DeriveCodexDeltaInputV2 {
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly invocationId: string;
  readonly providerDescriptorDigest: string;
  readonly threadBindingDigest: string;
  readonly threadId: string;
  readonly baseWorkspaceFingerprint: string;
  readonly projectionManifestDigest: string;
  readonly projectionBaselineDigest: string;
  readonly providerResultDigest: string;
  readonly createdAt: string;
}

/** Seal the delta, including the exact provider bytes it will publish. */
export async function createCodexWorkspaceDeltaV2(input: CreateCodexWorkspaceDeltaInputV2): Promise<CodexWorkspaceDeltaV2> {
  const derived = deriveCodexWorkspaceDeltaEntriesV2(input);
  const staging = resolve(input.stagingWorkspace);
  const entries: CodexDeltaEntryV2[] = [];
  let totalPostimageBytes = 0;
  for (const entry of derived) {
    if (entry.operation === "DELETE") {
      entries.push(Object.freeze({ ...entry, postimageBase64: null }));
      continue;
    }
    const bytes = await readFile(join(staging, entry.path));
    if (bytes.byteLength > M5B_LIMITS_V2.deltaMaxFileBytes) throw new RalphM5BError("M5B_DELTA_LIMIT_EXCEEDED", `M5B_DELTA_LIMIT_EXCEEDED: ${entry.path}`);
    totalPostimageBytes += bytes.byteLength;
    if (totalPostimageBytes > M5B_LIMITS_V2.deltaMaxTotalBytes) throw new RalphM5BError("M5B_DELTA_LIMIT_EXCEEDED", "M5B_DELTA_LIMIT_EXCEEDED: total bytes");
    if (sha256(bytes) !== entry.postimageDigest || bytes.byteLength !== entry.postimageSize) throw new RalphM5BError("M5B_DELTA_INVALID", `M5B_DELTA_INVALID: staging changed under ${entry.path}`);
    entries.push(Object.freeze({ ...entry, postimageBase64: bytes.toString("base64") }));
  }
  const sorted = Object.freeze([...entries].sort((left, right) => comparePathsV2(left.path, right.path)));
  const deltaDigest = sha256Canonical({ schema: RALPH_CODEX_WORKSPACE_DELTA_SCHEMA_V2, entries: sorted });
  const base = {
    schema: RALPH_CODEX_WORKSPACE_DELTA_SCHEMA_V2,
    runId: input.runId,
    phaseId: input.phaseId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    invocationId: input.invocationId,
    providerDescriptorDigest: input.providerDescriptorDigest,
    threadBindingDigest: input.threadBindingDigest,
    threadId: input.threadId,
    baseWorkspaceFingerprint: input.baseWorkspaceFingerprint,
    projectionManifestDigest: input.projectionManifestDigest,
    projectionBaselineDigest: input.projectionBaselineDigest,
    providerResultDigest: input.providerResultDigest,
    entries: sorted,
    entryCount: sorted.length,
    totalPostimageBytes,
    deltaDigest,
    createdAt: input.createdAt,
  };
  const delta: CodexWorkspaceDeltaV2 = Object.freeze({ ...base, artifactDigest: sha256Canonical(base) });
  validateCodexWorkspaceDeltaV2(delta);
  return delta;
}

export function validateCodexWorkspaceDeltaV2(value: unknown): asserts value is CodexWorkspaceDeltaV2 {
  if (!isRecord(value)) throw new RalphM5BError("M5B_DELTA_INVALID");
  assertExactKeys(value, [
    "schema", "runId", "phaseId", "taskId", "attemptId", "invocationId", "providerDescriptorDigest", "threadBindingDigest", "threadId",
    "baseWorkspaceFingerprint", "projectionManifestDigest", "projectionBaselineDigest", "providerResultDigest", "entries", "entryCount",
    "totalPostimageBytes", "deltaDigest", "createdAt", "artifactDigest",
  ]);
  if (value.schema !== RALPH_CODEX_WORKSPACE_DELTA_SCHEMA_V2) throw new RalphM5BError("M5B_DELTA_INVALID", "M5B_DELTA_INVALID: schema");
  if (!Array.isArray(value.entries)) throw new RalphM5BError("M5B_DELTA_INVALID", "M5B_DELTA_INVALID: entries");
  if (value.entries.length !== value.entryCount) throw new RalphM5BError("M5B_DELTA_INVALID", "M5B_DELTA_INVALID: entry count");
  if (value.entries.length > M5B_LIMITS_V2.deltaMaxEntries) throw new RalphM5BError("M5B_DELTA_LIMIT_EXCEEDED");
  let previous = "";
  for (const entry of value.entries) {
    if (!isRecord(entry)) throw new RalphM5BError("M5B_DELTA_INVALID", "M5B_DELTA_INVALID: entry");
    assertExactKeys(entry, ["path", "operation", "preimageDigest", "postimageDigest", "mode", "postimageSize", "postimageBase64"]);
    const path = assertSafeRelativePathV2(entry.path);
    if (isWorkspacePackageInfrastructurePathV1(path)) throw new RalphM5BError("M5B_DELTA_PATH_FORBIDDEN", `M5B_DELTA_PATH_FORBIDDEN: ${path}`);
    if (isCodexProjectionExcludedPathV2(path)) throw new RalphM5BError("M5B_DELTA_PATH_FORBIDDEN", `M5B_DELTA_PATH_FORBIDDEN: ${path}`);
    if (path <= previous) throw new RalphM5BError("M5B_DELTA_INVALID", "M5B_DELTA_INVALID: entries must be sorted and unique");
    previous = path;
    if (!(CODEX_DELTA_OPERATIONS_V2 as readonly string[]).includes(entry.operation as string)) throw new RalphM5BError("M5B_DELTA_INVALID", "M5B_DELTA_INVALID: operation");
    const operation = entry.operation as CodexDeltaOperationV2;
    if (operation === "DELETE") {
      if (entry.postimageDigest !== null || entry.postimageBase64 !== null || entry.postimageSize !== null || entry.mode !== null || typeof entry.preimageDigest !== "string") {
        throw new RalphM5BError("M5B_DELTA_INVALID", `M5B_DELTA_INVALID: DELETE shape ${path}`);
      }
      continue;
    }
    if (typeof entry.postimageBase64 !== "string" || typeof entry.postimageDigest !== "string" || typeof entry.postimageSize !== "number") {
      throw new RalphM5BError("M5B_DELTA_INVALID", `M5B_DELTA_INVALID: postimage ${path}`);
    }
    if (entry.mode !== 0o644 && entry.mode !== 0o755) throw new RalphM5BError("M5B_DELTA_UNSUPPORTED_MUTATION", `M5B_DELTA_UNSUPPORTED_MUTATION: mode ${path}`);
    if (operation === "CREATE" && entry.preimageDigest !== null) throw new RalphM5BError("M5B_DELTA_INVALID", `M5B_DELTA_INVALID: CREATE shape ${path}`);
    if (operation === "MODIFY" && typeof entry.preimageDigest !== "string") throw new RalphM5BError("M5B_DELTA_INVALID", `M5B_DELTA_INVALID: MODIFY shape ${path}`);
    const bytes = Buffer.from(entry.postimageBase64, "base64");
    if (bytes.toString("base64") !== entry.postimageBase64) throw new RalphM5BError("M5B_DELTA_INVALID", `M5B_DELTA_INVALID: payload encoding ${path}`);
    if (bytes.byteLength !== entry.postimageSize || sha256(bytes) !== entry.postimageDigest) throw new RalphM5BError("M5B_DELTA_INVALID", `M5B_DELTA_INVALID: payload digest ${path}`);
  }
  if (sha256Canonical({ schema: RALPH_CODEX_WORKSPACE_DELTA_SCHEMA_V2, entries: value.entries }) !== value.deltaDigest) {
    throw new RalphM5BError("M5B_DELTA_INVALID", "M5B_DELTA_INVALID: delta digest mismatch");
  }
  const { artifactDigest: _ignored, ...base } = value;
  if (sha256Canonical(base) !== value.artifactDigest) throw new RalphM5BError("M5B_DELTA_INVALID", "M5B_DELTA_INVALID: artifact digest mismatch");
}

export function assertPublishablePathV2(path: string, ownership: readonly string[]): void {
  assertSafeRelativePathV2(path);
  if (isWorkspacePackageInfrastructurePathV1(path)) throw new RalphM5BError("M5B_DELTA_PATH_FORBIDDEN", `M5B_DELTA_PATH_FORBIDDEN: ${path}`);
  if (isCodexProjectionExcludedPathV2(path)) throw new RalphM5BError("M5B_DELTA_PATH_FORBIDDEN", `M5B_DELTA_PATH_FORBIDDEN: ${path}`);
  if (!ownership.some((token) => scopeTokenCoversPath(token, path))) throw new RalphM5BError("M5B_DELTA_OUT_OF_SCOPE", `M5B_DELTA_OUT_OF_SCOPE: ${path}`);
}

export function tokenizeOwnership(value: string): readonly string[] {
  return value.split(/[\s,\n]+/).map((token) => token.trim()).filter(Boolean);
}

function fileMap(entries: readonly CodexProjectionEntryV2[]): Map<string, CodexProjectionEntryV2> {
  const map = new Map<string, CodexProjectionEntryV2>();
  for (const entry of entries) {
    if (entry.kind !== "file") continue;
    if (map.has(entry.path)) throw new RalphM5BError("M5B_DELTA_INVALID", `M5B_DELTA_INVALID: duplicate path ${entry.path}`);
    map.set(entry.path, entry);
  }
  return map;
}

function assertExactKeys(value: object, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new RalphM5BError("M5B_DELTA_INVALID", `M5B_DELTA_INVALID: unknown fields ${unknown.sort().join(",")}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deterministic path ordering.
 *
 * Code-unit order, never `localeCompare`: locale collation is machine state,
 * it would make a sealed digest depend on the host's locale, and it disagrees
 * with the byte-order the validators enforce — which a root-level WorkUnit
 * surfaces immediately, because `README.md` and `package.json` sort one way
 * under collation and the other way under code units.
 */
function comparePathsV2(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
