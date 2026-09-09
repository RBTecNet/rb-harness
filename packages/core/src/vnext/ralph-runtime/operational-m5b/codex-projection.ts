import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { Stats } from "node:fs";
import { sha256, sha256Canonical } from "../hashing.js";
import {
  WORKSPACE_CONTROL_PLANE_ROOT,
  WORKSPACE_FORBIDDEN_ROOTS,
  type WorkspaceFingerprint,
} from "../fingerprint.js";
import { M5B_LIMITS_V2 } from "./contract.js";
import { RalphM5BError } from "./contract-errors.js";

export const RALPH_CODEX_PROJECTION_MANIFEST_SCHEMA_V2 = "rb-ralph-codex-projection-manifest/v1" as const;

/**
 * Roots that may never appear in a provider projection.  The set is derived
 * from the single workspace path authority rather than restated, so it can
 * never drift away from the fingerprint's control-plane rules.  `.rb-harness`
 * is included as the parent of the already-forbidden `.rb-harness/ralph`.
 */
export const CODEX_PROJECTION_EXCLUDED_ROOTS_V2: readonly string[] = Object.freeze(
  [...new Set([WORKSPACE_CONTROL_PLANE_ROOT, ...WORKSPACE_FORBIDDEN_ROOTS.map((root) => root.split("/")[0]!)])].sort(),
);

export function isCodexProjectionExcludedPathV2(path: string): boolean {
  return CODEX_PROJECTION_EXCLUDED_ROOTS_V2.some((root) => path === root || path.startsWith(`${root}/`));
}

/**
 * The physical namespace guard that makes a WRITABLE staging root safe.
 *
 * When a WorkUnit's authoritative product lives at the workspace root, the
 * provider must be able to create files there — and therefore could otherwise
 * create `.rb-harness`, `.rb` or `.git` too.  A sentinel closes that by
 * occupying the name before the sandbox is admitted: an empty, non-writable
 * directory that the permission profile denies by exact path.
 *
 * A sentinel carries NO canonical control-plane data.  Nothing is copied into
 * it, nothing is read out of it, and it never reaches a provider delta or a
 * publication.  It exists only so the name is taken and the denial has an
 * exact existing path to bind to, which is what stock 0.153.4 requires.
 */
export const RALPH_CODEX_SENTINEL_SCHEMA_V2 = "rb-ralph-codex-control-plane-sentinel/v1" as const;

/** Sentinels are directories the provider may neither enter nor replace. */
export const CODEX_SENTINEL_MODE_V2 = 0o500 as const;

export interface CodexSentinelEntryV2 {
  /** Top-level, project-relative control-plane root. */
  readonly path: string;
  readonly kind: "directory";
  readonly mode: number;
  readonly childCount: 0;
  readonly identityDigest: string;
}

/**
 * Physical object identity captured immediately after materialization.
 *
 * Deliberately NOT part of the sealed manifest — an inode number is machine
 * state, not a reproducible artifact fact — but it is the strongest available
 * proof that the post-run sentinel is the SAME object rather than a
 * same-named replacement.  The change timestamps are carried alongside the
 * inode because a filesystem readily REUSES a freed inode number: a directory
 * deleted and immediately recreated can land on the same `ino`, and only the
 * fresh `ctime` distinguishes it.  Nothing legitimate alters either value —
 * an untouched sentinel is never written to, and a chmod or a new child is
 * already a violation on its own.
 */
export interface CodexSentinelPreimageV2 {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly ctimeNs: string;
  readonly mtimeNs: string;
}

export function codexSentinelIdentityDigestV2(path: string, mode: number): string {
  return sha256Canonical({ schema: RALPH_CODEX_SENTINEL_SCHEMA_V2, path, kind: "directory", mode, childCount: 0 });
}

export interface CodexProjectionEntryV2 {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly mode: number;
  readonly size: number;
  readonly contentHash: string | null;
}

export interface CodexProjectionManifestV2 {
  readonly schema: typeof RALPH_CODEX_PROJECTION_MANIFEST_SCHEMA_V2;
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly invocationId: string;
  /** Physical metadata only; the staging path is never semantic authority. */
  readonly stagingRootIdentity: string;
  readonly sourceWorkspaceFingerprint: string;
  readonly sourcePolicyDigest: string;
  readonly excludedRoots: readonly string[];
  /**
   * Project-relative product directories the permission profile grants write
   * access to.  Empty for a root-scope WorkUnit, where `stagingRootWritable`
   * carries the grant and the sentinels carry the denial instead.
   */
  readonly writableRoots: readonly string[];
  /**
   * True when the STAGING projection root itself carries WRITE because the
   * WorkUnit's authoritative product lives at the workspace root.
   */
  readonly stagingRootWritable: boolean;
  /**
   * The protected control-plane sentinels materialized before the sandbox was
   * admitted.  Empty unless the staging root is writable, where the
   * control-plane names are instead proven ABSENT.
   */
  readonly sentinels: readonly CodexSentinelEntryV2[];
  readonly sentinelDigest: string;
  readonly entries: readonly CodexProjectionEntryV2[];
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly baselineDigest: string;
  readonly createdAt: string;
  readonly manifestDigest: string;
}

export interface CodexProjectionBindingV2 {
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly invocationId: string;
}

/**
 * Deterministic staging directory name.  The same Attempt always projects to
 * the same physical path, so a crashed run can rebuild or inspect it without
 * inventing a second workspace.
 */
export function codexStagingWorkspacePathV2(stagingBase: string, binding: CodexProjectionBindingV2, baseWorkspaceFingerprint: string): string {
  if (!isAbsolute(stagingBase) || resolve(stagingBase) !== stagingBase) throw new RalphM5BError("M5B_PROJECTION_INVALID", "M5B_PROJECTION_INVALID: staging base must be absolute");
  const identity = sha256Canonical({
    runId: binding.runId,
    phaseId: binding.phaseId,
    taskId: binding.taskId,
    attemptId: binding.attemptId,
    invocationId: binding.invocationId,
    baseWorkspaceFingerprint,
  }).replace("sha256:", "");
  return join(stagingBase, `rb-ralph-m5b-${identity.slice(0, 40)}`);
}

export interface BuildCodexProjectionInputV2 {
  readonly projectRoot: string;
  readonly stagingWorkspace: string;
  readonly binding: CodexProjectionBindingV2;
  readonly fingerprint: WorkspaceFingerprint;
  /**
   * Product directories the provider will be allowed to write.  They are
   * materialized here so the permission profile can name an existing path:
   * stock 0.153.4 only enforces an exact path that exists when the sandbox
   * starts.  Empty for a root-scope WorkUnit.
   */
  readonly writableRoots: readonly string[];
  /** True when the staging root itself carries the provider write grant. */
  readonly stagingRootWritable?: boolean;
  /**
   * Control-plane roots to pre-create as protected sentinels.  Required when
   * the staging root is writable; forbidden otherwise, where the same names
   * are proven ABSENT instead.
   */
  readonly sentinelRoots?: readonly string[];
  readonly createdAt: string;
}

/**
 * Materialize the isolated provider workspace.  Codex is never given the
 * canonical project root: it receives only this disposable projection of the
 * product surface, with every Core-owned control-plane root absent by
 * construction.
 */
export async function buildCodexProviderProjectionV2(input: BuildCodexProjectionInputV2): Promise<CodexProjectionManifestV2> {
  const projectRoot = resolve(input.projectRoot);
  const staging = resolve(input.stagingWorkspace);
  if (staging === projectRoot || staging.startsWith(`${projectRoot}${sep}`) || projectRoot.startsWith(`${staging}${sep}`)) {
    throw new RalphM5BError("M5B_PROJECTION_INVALID", "M5B_PROJECTION_INVALID: the projection must live outside the canonical project root");
  }
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });

  const entries: CodexProjectionEntryV2[] = [];
  let totalBytes = 0;
  let fileCount = 0;

  for (const entry of [...input.fingerprint.productWorkspaceEntries].sort((left, right) => comparePathsV2(left.path, right.path))) {
    const path = assertSafeRelativePathV2(entry.path);
    // A Core-owned root is never projected, even when the fingerprint policy
    // tracks it: the provider must not be able to see or write one at all.
    if (isCodexProjectionExcludedPathV2(path)) continue;
    if (entry.kind === "symlink") throw new RalphM5BError("M5B_PROJECTION_PATH_UNSAFE", `M5B_PROJECTION_PATH_UNSAFE: symlink ${path}`);
    const source = join(projectRoot, path);
    const target = join(staging, path);
    const stats = await safeLstatV2(source, path);
    if (entry.kind === "directory") {
      if (!stats.isDirectory()) throw new RalphM5BError("M5B_PROJECTION_PATH_UNSAFE", `M5B_PROJECTION_PATH_UNSAFE: ${path}`);
      await mkdir(target, { recursive: true, mode: 0o700 });
      entries.push(Object.freeze({ path, kind: "directory", mode: 0o700, size: 0, contentHash: null }));
      continue;
    }
    if (!stats.isFile()) throw new RalphM5BError("M5B_PROJECTION_PATH_UNSAFE", `M5B_PROJECTION_PATH_UNSAFE: ${path} is not a regular file`);
    if (stats.size > M5B_LIMITS_V2.projectionMaxFileBytes) throw new RalphM5BError("M5B_PROJECTION_LIMIT_EXCEEDED", `M5B_PROJECTION_LIMIT_EXCEEDED: ${path}`);
    fileCount += 1;
    totalBytes += stats.size;
    if (fileCount > M5B_LIMITS_V2.projectionMaxFiles) throw new RalphM5BError("M5B_PROJECTION_LIMIT_EXCEEDED", "M5B_PROJECTION_LIMIT_EXCEEDED: file count");
    if (totalBytes > M5B_LIMITS_V2.projectionMaxTotalBytes) throw new RalphM5BError("M5B_PROJECTION_LIMIT_EXCEEDED", "M5B_PROJECTION_LIMIT_EXCEEDED: total bytes");
    const bytes = await readFile(source);
    const mode = normalizedProjectionModeV2(stats);
    await mkdir(join(staging, parentOf(path)), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { mode });
    entries.push(Object.freeze({ path, kind: "file", mode, size: bytes.byteLength, contentHash: sha256(bytes) }));
  }

  // Materialize the product write roots so the permission profile can name
  // an existing path. These are ordinary product directories; a control-plane
  // root is refused.
  const stagingRootWritable = input.stagingRootWritable === true;
  const writableRoots = [...new Set(input.writableRoots.map((root) => assertSafeRelativePathV2(root)))].sort();
  if (!stagingRootWritable && writableRoots.length === 0) throw new RalphM5BError("M5B_PROJECTION_INVALID", "M5B_PROJECTION_INVALID: at least one product write root is required");
  if (stagingRootWritable && writableRoots.length > 0) throw new RalphM5BError("M5B_PROJECTION_INVALID", "M5B_PROJECTION_INVALID: a writable staging root may not carry additional product write roots");
  for (const root of writableRoots) {
    if (isCodexProjectionExcludedPathV2(root)) throw new RalphM5BError("M5B_PROJECTION_CONTROL_PLANE_PATH", `M5B_PROJECTION_CONTROL_PLANE_PATH: write root ${root}`);
    const target = join(staging, root);
    if (!entries.some((entry) => entry.path === root && entry.kind === "directory")) {
      await mkdir(target, { recursive: true, mode: 0o700 });
      if (!entries.some((entry) => entry.path === root)) {
        entries.push(Object.freeze({ path: root, kind: "directory", mode: 0o700, size: 0, contentHash: null }));
      }
    }
  }

  // Pre-create the control-plane sentinels BEFORE the sandbox is admitted.
  // They are empty, non-writable directories carrying no canonical data: the
  // name is occupied so the provider cannot take it, and the permission
  // profile has an exact existing path to deny.
  const sentinelRoots = [...new Set((input.sentinelRoots ?? []).map((root) => assertSafeRelativePathV2(root)))].sort();
  if (stagingRootWritable && sentinelRoots.length === 0) {
    throw new RalphM5BError("M5B_SENTINEL_MANIFEST_INVALID", "M5B_SENTINEL_MANIFEST_INVALID: a writable staging root requires protected control-plane sentinels");
  }
  if (!stagingRootWritable && sentinelRoots.length > 0) {
    throw new RalphM5BError("M5B_SENTINEL_MANIFEST_INVALID", "M5B_SENTINEL_MANIFEST_INVALID: sentinels are only materialized for a writable staging root");
  }
  const sentinels: CodexSentinelEntryV2[] = [];
  for (const root of sentinelRoots) {
    if (!isCodexProjectionExcludedPathV2(root) || root.includes("/")) {
      throw new RalphM5BError("M5B_SENTINEL_MANIFEST_INVALID", `M5B_SENTINEL_MANIFEST_INVALID: ${root} is not a top-level control-plane root`);
    }
    if (entries.some((entry) => entry.path === root || entry.path.startsWith(`${root}/`))) {
      throw new RalphM5BError("M5B_PROJECTION_CONTROL_PLANE_PATH", `M5B_PROJECTION_CONTROL_PLANE_PATH: ${root} was projected`);
    }
    const target = join(staging, root);
    await mkdir(target, { recursive: false, mode: CODEX_SENTINEL_MODE_V2 });
    await chmod(target, CODEX_SENTINEL_MODE_V2);
    sentinels.push(Object.freeze({
      path: root,
      kind: "directory" as const,
      mode: CODEX_SENTINEL_MODE_V2,
      childCount: 0 as const,
      identityDigest: codexSentinelIdentityDigestV2(root, CODEX_SENTINEL_MODE_V2),
    }));
  }

  entries.sort((left, right) => comparePathsV2(left.path, right.path));
  const baselineDigest = sha256Canonical({ schema: RALPH_CODEX_PROJECTION_MANIFEST_SCHEMA_V2, entries });
  const base = {
    schema: RALPH_CODEX_PROJECTION_MANIFEST_SCHEMA_V2,
    runId: input.binding.runId,
    phaseId: input.binding.phaseId,
    taskId: input.binding.taskId,
    attemptId: input.binding.attemptId,
    invocationId: input.binding.invocationId,
    stagingRootIdentity: sha256(staging),
    sourceWorkspaceFingerprint: input.fingerprint.fingerprintDigest,
    sourcePolicyDigest: input.fingerprint.policyDigest,
    excludedRoots: [...CODEX_PROJECTION_EXCLUDED_ROOTS_V2],
    writableRoots,
    stagingRootWritable,
    sentinels: Object.freeze(sentinels),
    sentinelDigest: sha256Canonical({ schema: RALPH_CODEX_SENTINEL_SCHEMA_V2, stagingRootWritable, sentinels }),
    entries,
    fileCount,
    totalBytes,
    baselineDigest,
    createdAt: input.createdAt,
  };
  const manifest: CodexProjectionManifestV2 = Object.freeze({ ...base, manifestDigest: sha256Canonical(base) });
  validateCodexProjectionManifestV2(manifest);
  // Positive physical proof, taken from the filesystem rather than from the
  // manifest that was just written: every control-plane name is either
  // absent or an untouched sentinel.
  await assertCodexProjectionNamespaceV2(staging, manifest);
  return manifest;
}

/**
 * Re-read the staging workspace after the provider ran.
 *
 * A declared sentinel is skipped rather than walked: it is not product, never
 * reaches a delta and never reaches a publication.  It is not IGNORED —
 * `verifyCodexRootSentinelsV2` proves separately that it survived untouched,
 * and a sentinel found with any child fails here immediately.  Any OTHER
 * control-plane path is a hard failure exactly as before.
 */
export async function readCodexProjectionStateV2(
  stagingWorkspace: string,
  sentinels: readonly CodexSentinelEntryV2[] = [],
): Promise<readonly CodexProjectionEntryV2[]> {
  const root = resolve(stagingWorkspace);
  const declaredSentinels = new Set(sentinels.map((entry) => entry.path));
  const entries: CodexProjectionEntryV2[] = [];
  let fileCount = 0;
  let totalBytes = 0;
  await walk("");
  entries.sort((left, right) => comparePathsV2(left.path, right.path));
  return Object.freeze(entries);

  async function walk(relative: string): Promise<void> {
    const absolute = relative ? join(root, relative) : root;
    const names = [...await readdir(absolute)].sort();
    for (const name of names) {
      const path = relative ? `${relative}/${name}` : name;
      assertSafeRelativePathV2(path);
      if (declaredSentinels.has(path)) {
        const sentinelStats = await safeLstatV2(join(root, path), path);
        if (sentinelStats.isSymbolicLink() || !sentinelStats.isDirectory()) throw new RalphM5BError("M5B_SENTINEL_VIOLATED", `M5B_SENTINEL_VIOLATED: ${path} is no longer a directory`);
        const children = await readdir(join(root, path)).catch(() => { throw new RalphM5BError("M5B_SENTINEL_VIOLATED", `M5B_SENTINEL_VIOLATED: ${path} is unreadable`); });
        if (children.length > 0) throw new RalphM5BError("M5B_SENTINEL_VIOLATED", `M5B_SENTINEL_VIOLATED: ${path} gained ${children.length} entries`);
        continue;
      }
      if (isCodexProjectionExcludedPathV2(path)) throw new RalphM5BError("M5B_PROJECTION_CONTROL_PLANE_PATH", `M5B_PROJECTION_CONTROL_PLANE_PATH: ${path}`);
      const stats = await safeLstatV2(join(root, path), path);
      if (stats.isSymbolicLink()) throw new RalphM5BError("M5B_PROJECTION_PATH_UNSAFE", `M5B_PROJECTION_PATH_UNSAFE: symlink ${path}`);
      if (stats.isDirectory()) {
        entries.push(Object.freeze({ path, kind: "directory", mode: 0o700, size: 0, contentHash: null }));
        await walk(path);
        continue;
      }
      if (!stats.isFile()) throw new RalphM5BError("M5B_PROJECTION_PATH_UNSAFE", `M5B_PROJECTION_PATH_UNSAFE: special file ${path}`);
      if (stats.size > M5B_LIMITS_V2.projectionMaxFileBytes) throw new RalphM5BError("M5B_PROJECTION_LIMIT_EXCEEDED", `M5B_PROJECTION_LIMIT_EXCEEDED: ${path}`);
      fileCount += 1;
      totalBytes += stats.size;
      if (fileCount > M5B_LIMITS_V2.projectionMaxFiles) throw new RalphM5BError("M5B_PROJECTION_LIMIT_EXCEEDED", "M5B_PROJECTION_LIMIT_EXCEEDED: file count");
      if (totalBytes > M5B_LIMITS_V2.projectionMaxTotalBytes) throw new RalphM5BError("M5B_PROJECTION_LIMIT_EXCEEDED", "M5B_PROJECTION_LIMIT_EXCEEDED: total bytes");
      const bytes = await readFile(join(root, path));
      entries.push(Object.freeze({ path, kind: "file", mode: normalizedProjectionModeV2(stats), size: bytes.byteLength, contentHash: sha256(bytes) }));
    }
  }
}

export function validateCodexProjectionManifestV2(value: unknown): asserts value is CodexProjectionManifestV2 {
  if (!isRecord(value)) throw new RalphM5BError("M5B_PROJECTION_INVALID");
  assertExactKeys(value, [
    "schema", "runId", "phaseId", "taskId", "attemptId", "invocationId", "stagingRootIdentity", "sourceWorkspaceFingerprint",
    "sourcePolicyDigest", "excludedRoots", "writableRoots", "stagingRootWritable", "sentinels", "sentinelDigest",
    "entries", "fileCount", "totalBytes", "baselineDigest", "createdAt", "manifestDigest",
  ]);
  if (typeof value.stagingRootWritable !== "boolean") throw new RalphM5BError("M5B_PROJECTION_INVALID", "M5B_PROJECTION_INVALID: stagingRootWritable");
  if (!Array.isArray(value.writableRoots)) throw new RalphM5BError("M5B_PROJECTION_INVALID", "M5B_PROJECTION_INVALID: writableRoots");
  if (!value.stagingRootWritable && value.writableRoots.length === 0) throw new RalphM5BError("M5B_PROJECTION_INVALID", "M5B_PROJECTION_INVALID: writableRoots");
  if (value.stagingRootWritable && value.writableRoots.length > 0) throw new RalphM5BError("M5B_PROJECTION_INVALID", "M5B_PROJECTION_INVALID: a writable staging root carries no product write roots");
  for (const root of value.writableRoots as readonly unknown[]) {
    assertSafeRelativePathV2(root);
    if (isCodexProjectionExcludedPathV2(root as string)) throw new RalphM5BError("M5B_PROJECTION_CONTROL_PLANE_PATH", `M5B_PROJECTION_CONTROL_PLANE_PATH: write root ${String(root)}`);
  }
  // A writable staging root without sentinels is exactly the failure the
  // whole root-scope design exists to prevent; it is refused at validation,
  // not only at construction.
  if (!Array.isArray(value.sentinels)) throw new RalphM5BError("M5B_SENTINEL_MANIFEST_INVALID", "M5B_SENTINEL_MANIFEST_INVALID: sentinels");
  if (value.stagingRootWritable && value.sentinels.length === 0) throw new RalphM5BError("M5B_SENTINEL_MANIFEST_INVALID", "M5B_SENTINEL_MANIFEST_INVALID: a writable staging root requires protected sentinels");
  if (!value.stagingRootWritable && value.sentinels.length > 0) throw new RalphM5BError("M5B_SENTINEL_MANIFEST_INVALID", "M5B_SENTINEL_MANIFEST_INVALID: sentinels require a writable staging root");
  if (value.stagingRootWritable) {
    // The sentinel set is the workspace authority's own excluded-root set:
    // omitting one would leave that control-plane name creatable.
    const declared = [...new Set((value.sentinels as readonly CodexSentinelEntryV2[]).map((entry) => entry?.path))].sort();
    const required = [...CODEX_PROJECTION_EXCLUDED_ROOTS_V2].sort();
    if (declared.length !== required.length || declared.some((path, index) => path !== required[index])) {
      throw new RalphM5BError("M5B_SENTINEL_MANIFEST_INVALID", `M5B_SENTINEL_MANIFEST_INVALID: sentinels must cover exactly ${required.join(",")}`);
    }
  }
  for (const sentinel of value.sentinels as readonly unknown[]) {
    if (!isRecord(sentinel)) throw new RalphM5BError("M5B_SENTINEL_MANIFEST_INVALID", "M5B_SENTINEL_MANIFEST_INVALID: entry");
    assertExactKeys(sentinel, ["path", "kind", "mode", "childCount", "identityDigest"]);
    const path = assertSafeRelativePathV2(sentinel.path);
    if (!isCodexProjectionExcludedPathV2(path) || path.includes("/")) throw new RalphM5BError("M5B_SENTINEL_MANIFEST_INVALID", `M5B_SENTINEL_MANIFEST_INVALID: ${path}`);
    if (sentinel.kind !== "directory" || sentinel.childCount !== 0) throw new RalphM5BError("M5B_SENTINEL_MANIFEST_INVALID", `M5B_SENTINEL_MANIFEST_INVALID: shape ${path}`);
    if (typeof sentinel.mode !== "number") throw new RalphM5BError("M5B_SENTINEL_MANIFEST_INVALID", `M5B_SENTINEL_MANIFEST_INVALID: mode ${path}`);
    if (sentinel.identityDigest !== codexSentinelIdentityDigestV2(path, sentinel.mode)) {
      throw new RalphM5BError("M5B_SENTINEL_MANIFEST_INVALID", `M5B_SENTINEL_MANIFEST_INVALID: identity ${path}`);
    }
  }
  if (value.sentinelDigest !== sha256Canonical({ schema: RALPH_CODEX_SENTINEL_SCHEMA_V2, stagingRootWritable: value.stagingRootWritable, sentinels: value.sentinels })) {
    throw new RalphM5BError("M5B_SENTINEL_MANIFEST_INVALID", "M5B_SENTINEL_MANIFEST_INVALID: sentinel digest mismatch");
  }
  if (value.schema !== RALPH_CODEX_PROJECTION_MANIFEST_SCHEMA_V2) throw new RalphM5BError("M5B_PROJECTION_INVALID", "M5B_PROJECTION_INVALID: schema");
  if (!Array.isArray(value.entries)) throw new RalphM5BError("M5B_PROJECTION_INVALID", "M5B_PROJECTION_INVALID: entries");
  for (const entry of value.entries) {
    if (!isRecord(entry)) throw new RalphM5BError("M5B_PROJECTION_INVALID", "M5B_PROJECTION_INVALID: entry");
    assertExactKeys(entry, ["path", "kind", "mode", "size", "contentHash"]);
    assertSafeRelativePathV2(entry.path as string);
    if (isCodexProjectionExcludedPathV2(entry.path as string)) throw new RalphM5BError("M5B_PROJECTION_CONTROL_PLANE_PATH", `M5B_PROJECTION_CONTROL_PLANE_PATH: ${String(entry.path)}`);
    if (entry.kind !== "file" && entry.kind !== "directory") throw new RalphM5BError("M5B_PROJECTION_PATH_UNSAFE", "M5B_PROJECTION_PATH_UNSAFE: kind");
  }
  const { manifestDigest: _ignored, ...base } = value;
  if (sha256Canonical(base) !== value.manifestDigest) throw new RalphM5BError("M5B_PROJECTION_INVALID", "M5B_PROJECTION_INVALID: digest mismatch");
  if (sha256Canonical({ schema: RALPH_CODEX_PROJECTION_MANIFEST_SCHEMA_V2, entries: value.entries }) !== value.baselineDigest) {
    throw new RalphM5BError("M5B_PROJECTION_INVALID", "M5B_PROJECTION_INVALID: baseline digest mismatch");
  }
}

/**
 * Positive physical proof that the control-plane namespace is closed.
 *
 * Without a writable staging root the proof is ABSENCE: none of the Core-owned
 * roots was materialized at all, which is the structural denial M5-B has
 * always relied on.  With a writable staging root the proof is OCCUPATION:
 * each root exists as an empty, non-writable sentinel directory whose identity
 * matches the manifest.  Anything else fails closed.
 */
export async function assertCodexProjectionNamespaceV2(
  stagingWorkspace: string,
  manifest: Pick<CodexProjectionManifestV2, "stagingRootWritable" | "sentinels">,
): Promise<void> {
  const root = resolve(stagingWorkspace);
  const declared = new Map(manifest.sentinels.map((entry) => [entry.path, entry] as const));
  for (const controlRoot of CODEX_PROJECTION_EXCLUDED_ROOTS_V2) {
    const sentinel = declared.get(controlRoot);
    if (!sentinel) {
      if (manifest.stagingRootWritable) {
        throw new RalphM5BError("M5B_SENTINEL_MISSING", `M5B_SENTINEL_MISSING: ${controlRoot} has no protected sentinel while the staging root is writable`);
      }
      await assertAbsentV2(join(root, controlRoot), controlRoot);
      continue;
    }
    await assertSentinelIntactV2(root, sentinel);
  }
}

/** Retained name for the absence-only proof used by a non-root projection. */
export async function assertProjectionExcludesControlPlaneV2(stagingWorkspace: string): Promise<void> {
  await assertCodexProjectionNamespaceV2(stagingWorkspace, { stagingRootWritable: false, sentinels: [] });
}

/**
 * Capture the inode identity of each sentinel immediately after it is
 * materialized, so the post-run check can tell an untouched sentinel from a
 * same-named replacement.  Deliberately not part of the sealed manifest: an
 * inode number is machine state, not a reproducible artifact fact.
 */
export async function captureCodexSentinelPreimageV2(
  stagingWorkspace: string,
  manifest: Pick<CodexProjectionManifestV2, "sentinels">,
): Promise<readonly CodexSentinelPreimageV2[]> {
  const root = resolve(stagingWorkspace);
  const preimage: CodexSentinelPreimageV2[] = [];
  for (const sentinel of manifest.sentinels) {
    const stats = await lstat(join(root, sentinel.path), { bigint: true }).catch((error) => {
      throw new RalphM5BError("M5B_SENTINEL_MISSING", `M5B_SENTINEL_MISSING: ${sentinel.path}`, error);
    });
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new RalphM5BError("M5B_SENTINEL_MISSING", `M5B_SENTINEL_MISSING: ${sentinel.path}`);
    preimage.push(Object.freeze({
      path: sentinel.path,
      dev: Number(stats.dev),
      ino: Number(stats.ino),
      ctimeNs: stats.ctimeNs.toString(),
      mtimeNs: stats.mtimeNs.toString(),
    }));
  }
  return Object.freeze(preimage);
}

/**
 * The post-run sentinel check.  It runs BEFORE any provider delta is derived
 * or published: a sentinel that was deleted, renamed away, replaced by a file
 * or a symlink, given a child, or swapped for a different directory of the
 * same name fails the whole Attempt closed rather than reaching publication.
 */
export async function verifyCodexRootSentinelsV2(
  stagingWorkspace: string,
  manifest: Pick<CodexProjectionManifestV2, "stagingRootWritable" | "sentinels">,
  preimage: readonly CodexSentinelPreimageV2[] = [],
): Promise<void> {
  await assertCodexProjectionNamespaceV2(stagingWorkspace, manifest);
  const root = resolve(stagingWorkspace);
  const observed = new Map(preimage.map((entry) => [entry.path, entry] as const));
  for (const sentinel of manifest.sentinels) {
    const before = observed.get(sentinel.path);
    if (!before) continue;
    const stats = await lstat(join(root, sentinel.path), { bigint: true }).catch((error) => {
      throw new RalphM5BError("M5B_SENTINEL_VIOLATED", `M5B_SENTINEL_VIOLATED: ${sentinel.path} is unreadable`, error);
    });
    if (Number(stats.dev) !== before.dev
      || Number(stats.ino) !== before.ino
      || stats.ctimeNs.toString() !== before.ctimeNs
      || stats.mtimeNs.toString() !== before.mtimeNs) {
      throw new RalphM5BError("M5B_SENTINEL_VIOLATED", `M5B_SENTINEL_VIOLATED: ${sentinel.path} is a different object than the one materialized before dispatch`);
    }
  }
}

async function assertSentinelIntactV2(root: string, sentinel: CodexSentinelEntryV2): Promise<void> {
  let stats;
  try { stats = await lstat(join(root, sentinel.path)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new RalphM5BError("M5B_SENTINEL_MISSING", `M5B_SENTINEL_MISSING: ${sentinel.path} was deleted or renamed away`);
    }
    throw new RalphM5BError("M5B_SENTINEL_VIOLATED", `M5B_SENTINEL_VIOLATED: ${sentinel.path} is unreadable`, error);
  }
  if (stats.isSymbolicLink()) throw new RalphM5BError("M5B_SENTINEL_VIOLATED", `M5B_SENTINEL_VIOLATED: ${sentinel.path} was replaced by a symlink`);
  if (!stats.isDirectory()) throw new RalphM5BError("M5B_SENTINEL_VIOLATED", `M5B_SENTINEL_VIOLATED: ${sentinel.path} is no longer a directory`);
  if ((stats.mode & 0o777) !== (sentinel.mode & 0o777)) throw new RalphM5BError("M5B_SENTINEL_VIOLATED", `M5B_SENTINEL_VIOLATED: ${sentinel.path} mode changed`);
  const children = await readdir(join(root, sentinel.path)).catch((error) => {
    throw new RalphM5BError("M5B_SENTINEL_VIOLATED", `M5B_SENTINEL_VIOLATED: ${sentinel.path} is unreadable`, error);
  });
  if (children.length !== sentinel.childCount) {
    throw new RalphM5BError("M5B_SENTINEL_VIOLATED", `M5B_SENTINEL_VIOLATED: ${sentinel.path} contains ${children.length} entries`);
  }
  if (sentinel.identityDigest !== codexSentinelIdentityDigestV2(sentinel.path, stats.mode & 0o777)) {
    throw new RalphM5BError("M5B_SENTINEL_VIOLATED", `M5B_SENTINEL_VIOLATED: ${sentinel.path} identity mismatch`);
  }
}

async function assertAbsentV2(absolute: string, controlRoot: string): Promise<void> {
  try {
    await lstat(absolute);
    throw new RalphM5BError("M5B_PROJECTION_CONTROL_PLANE_PATH", `M5B_PROJECTION_CONTROL_PLANE_PATH: ${controlRoot}`);
  } catch (error) {
    if (error instanceof RalphM5BError) throw error;
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw new RalphM5BError("M5B_PROJECTION_PATH_UNSAFE", "M5B_PROJECTION_PATH_UNSAFE: control-plane sentinel unreadable", error);
    }
  }
}

export function assertSafeRelativePathV2(path: unknown): string {
  if (typeof path !== "string" || path.length === 0 || path.length > 1024) throw new RalphM5BError("M5B_PROJECTION_PATH_UNSAFE", "M5B_PROJECTION_PATH_UNSAFE: path shape");
  if (path.startsWith("/") || isAbsolute(path) || path.includes("\0") || path.includes("\\")) throw new RalphM5BError("M5B_PROJECTION_PATH_UNSAFE", `M5B_PROJECTION_PATH_UNSAFE: ${path}`);
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) throw new RalphM5BError("M5B_PROJECTION_PATH_UNSAFE", `M5B_PROJECTION_PATH_UNSAFE: ${path}`);
  return path;
}

function normalizedProjectionModeV2(stats: Stats): number {
  return (stats.mode & 0o100) === 0o100 ? 0o755 : 0o644;
}

function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "." : path.slice(0, index);
}

async function safeLstatV2(absolute: string, path: string): Promise<Stats> {
  try { return await lstat(absolute); }
  catch (error) { throw new RalphM5BError("M5B_PROJECTION_PATH_UNSAFE", `M5B_PROJECTION_PATH_UNSAFE: ${path} is unreadable`, error); }
}

function assertExactKeys(value: object, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new RalphM5BError("M5B_PROJECTION_INVALID", `M5B_PROJECTION_INVALID: unknown fields ${unknown.sort().join(",")}`);
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
