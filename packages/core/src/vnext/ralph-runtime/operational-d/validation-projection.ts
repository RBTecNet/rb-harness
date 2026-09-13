import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readlink, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isWorkspacePackageInfrastructurePathV1 } from "../package-infrastructure.js";
import { isSha256Digest, sha256, sha256Canonical } from "../hashing.js";
import {
  validateWorkspaceManifestV2,
  type WorkspaceManifestV2,
} from "../operational-b4/workspace-manifest.js";
import type { ValidationSpecRef } from "../operational-v2/contracts.js";
import type { ValidationProcessBindingV2 } from "./process-supervisor.js";

export const VALIDATION_PROJECTION_SCHEMA_V1 = "rb-harness-validation-projection/v1" as const;

export class RalphValidationProjectionErrorV1 extends Error {
  constructor(
    readonly code: "D_VALIDATION_PROJECTION_INVALID" | "D_VALIDATION_PROJECTION_CLEANUP_FAILED",
    readonly cause?: unknown,
  ) {
    super(code);
    this.name = "RalphValidationProjectionErrorV1";
  }
}

export interface ValidationProjectionAuthorityV1 {
  readonly schema: typeof VALIDATION_PROJECTION_SCHEMA_V1;
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly evidenceCaptureId: string;
  readonly evidenceDigest: string;
  readonly boundaryManifestDigest: string;
  readonly canonicalCandidateRoot: string;
  readonly infrastructureRoot: string;
  readonly sessionRoot: string;
  readonly projectionRoot: string;
  readonly validationSpecs: readonly {
    readonly validationSpecId: string;
    readonly validationSpecDigest: string;
  }[];
  readonly authorityDigest: string;
}

export interface ValidationProjectionRunAuthorityV1 extends ValidationProjectionAuthorityV1 {
  readonly validationSpecId: string;
  readonly validationSpecDigest: string;
  readonly validationRunId: string;
  readonly runAuthorityDigest: string;
}

export interface ValidationProjectionSessionV1 {
  readonly authority: ValidationProjectionAuthorityV1;
  readonly cleanup: () => Promise<void>;
}

const trustedProjectionAuthorities = new WeakSet<object>();
const trustedRunAuthorities = new WeakMap<object, ValidationProjectionAuthorityV1>();
const disposedProjectionAuthorities = new WeakSet<object>();

export async function createValidationProjectionV1(input: {
  readonly canonicalCandidateRoot: string;
  readonly boundaryManifest: WorkspaceManifestV2;
  readonly evidenceCaptureId: string;
  readonly evidenceDigest: string;
  readonly validationSpecs: readonly ValidationSpecRef[];
}): Promise<ValidationProjectionSessionV1> {
  validateWorkspaceManifestV2(input.boundaryManifest);
  const candidateRoot = await requireRealDirectory(input.canonicalCandidateRoot, "D_VALIDATION_PROJECTION_INVALID");
  assertSafeIdentity(input.evidenceCaptureId);
  if (!isSha256Digest(input.evidenceDigest)) throw new RalphValidationProjectionErrorV1("D_VALIDATION_PROJECTION_INVALID");
  const validationSpecs = input.validationSpecs.map((spec) => {
    assertSafeIdentity(spec.validationSpecId);
    if (!isSha256Digest(spec.digest)) throw new RalphValidationProjectionErrorV1("D_VALIDATION_PROJECTION_INVALID");
    return Object.freeze({ validationSpecId: spec.validationSpecId, validationSpecDigest: spec.digest });
  });
  if (new Set(validationSpecs.map((spec) => spec.validationSpecId)).size !== validationSpecs.length) {
    throw new RalphValidationProjectionErrorV1("D_VALIDATION_PROJECTION_INVALID");
  }

  const temporaryBase = await realpath(tmpdir());
  const infrastructureRoot = await mkdtemp(join(temporaryBase, "rb-harness-core-validation-"));
  const sessionRoot = join(infrastructureRoot, "session");
  const projectionRoot = join(sessionRoot, "projection");
  try {
    await chmod(infrastructureRoot, 0o700);
    await mkdir(sessionRoot, { mode: 0o700 });
    await mkdir(projectionRoot, { mode: 0o700 });
    await assertCoreOwnedDirectory(infrastructureRoot);
    await assertCoreOwnedDirectory(sessionRoot);
    await copyManifestProductAuthority(candidateRoot, projectionRoot, input.boundaryManifest);
    // These are empty Core-owned mountpoints, not projected product/control
    // bytes. Each sandbox overlays them read-only, so repeated ValidationRuns
    // cannot make bubblewrap-created mountpoints look like foreign state.
    for (const controlPath of [".rb", ".rb-harness", ".git"] as const) {
      await mkdir(join(projectionRoot, controlPath), { mode: 0o700 });
    }
    const base = {
      schema: VALIDATION_PROJECTION_SCHEMA_V1,
      runId: input.boundaryManifest.runId,
      phaseId: input.boundaryManifest.phaseId,
      taskId: input.boundaryManifest.taskId,
      attemptId: input.boundaryManifest.attemptId,
      evidenceCaptureId: input.evidenceCaptureId,
      evidenceDigest: input.evidenceDigest,
      boundaryManifestDigest: input.boundaryManifest.manifestDigest,
      canonicalCandidateRoot: candidateRoot,
      infrastructureRoot,
      sessionRoot,
      projectionRoot,
      validationSpecs: Object.freeze(validationSpecs),
    };
    const authority: ValidationProjectionAuthorityV1 = Object.freeze({ ...base, authorityDigest: sha256Canonical(base) });
    trustedProjectionAuthorities.add(authority);
    let disposed = false;
    return Object.freeze({
      authority,
      cleanup: async () => {
        if (disposed) return;
        await removeCoreProjectionInfrastructure(authority);
        disposed = true;
        disposedProjectionAuthorities.add(authority);
      },
    });
  } catch (error) {
    await removeIncompleteInfrastructure(infrastructureRoot, temporaryBase).catch(() => undefined);
    if (error instanceof RalphValidationProjectionErrorV1) throw error;
    throw new RalphValidationProjectionErrorV1("D_VALIDATION_PROJECTION_INVALID", error);
  }
}

export function bindValidationProjectionRunV1(
  authority: ValidationProjectionAuthorityV1,
  input: ValidationProcessBindingV2 & { readonly validationSpecDigest: string },
): ValidationProjectionRunAuthorityV1 {
  assertProjectionAuthority(authority);
  if (!sameAttemptBinding(authority, input) || !isSha256Digest(input.validationSpecDigest)) {
    throw new RalphValidationProjectionErrorV1("D_VALIDATION_PROJECTION_INVALID");
  }
  const spec = authority.validationSpecs.find((candidate) => candidate.validationSpecId === input.validationSpecId);
  if (!spec || spec.validationSpecDigest !== input.validationSpecDigest) throw new RalphValidationProjectionErrorV1("D_VALIDATION_PROJECTION_INVALID");
  assertSafeIdentity(input.validationRunId);
  const base = {
    ...authority,
    validationSpecId: input.validationSpecId,
    validationSpecDigest: input.validationSpecDigest,
    validationRunId: input.validationRunId,
  };
  const result: ValidationProjectionRunAuthorityV1 = Object.freeze({ ...base, runAuthorityDigest: sha256Canonical(base) });
  trustedRunAuthorities.set(result, authority);
  return result;
}

export async function assertValidationProjectionRunAuthorityV1(input: {
  readonly authority: ValidationProjectionRunAuthorityV1 | undefined;
  readonly cwd: string;
  readonly binding: ValidationProcessBindingV2 | undefined;
}): Promise<ValidationProjectionRunAuthorityV1> {
  const authority = input.authority;
  const parent = authority && trustedRunAuthorities.get(authority);
  if (!authority || !parent || disposedProjectionAuthorities.has(parent)) throw new RalphValidationProjectionErrorV1("D_VALIDATION_PROJECTION_INVALID");
  assertProjectionAuthority(parent);
  const { runAuthorityDigest: _ignored, ...base } = authority;
  if (sha256Canonical(base) !== authority.runAuthorityDigest || !input.binding || !sameAttemptBinding(authority, input.binding)
    || authority.validationSpecId !== input.binding.validationSpecId || authority.validationRunId !== input.binding.validationRunId
    || resolve(input.cwd) !== authority.projectionRoot) {
    throw new RalphValidationProjectionErrorV1("D_VALIDATION_PROJECTION_INVALID");
  }
  await assertProjectionStructure(parent);
  return authority;
}

function assertProjectionAuthority(authority: ValidationProjectionAuthorityV1): void {
  if (!trustedProjectionAuthorities.has(authority) || disposedProjectionAuthorities.has(authority)) {
    throw new RalphValidationProjectionErrorV1("D_VALIDATION_PROJECTION_INVALID");
  }
  const { authorityDigest: _ignored, ...base } = authority;
  if (sha256Canonical(base) !== authority.authorityDigest) throw new RalphValidationProjectionErrorV1("D_VALIDATION_PROJECTION_INVALID");
}

async function copyManifestProductAuthority(candidateRoot: string, projectionRoot: string, manifest: WorkspaceManifestV2): Promise<void> {
  // Only byte-authoritative product entries are projected. An excluded-root
  // sentinel proves existence/type/mode, not the bytes hidden below it, so
  // copying such bytes would invent product authority. Explicitly scoped
  // paths (including generated products such as dist/) are ordinary manifest
  // entries and therefore are copied without any output-name allowlist.
  const entries = manifest.productWorkspaceEntries.filter((entry) => {
    if (isProjectionControlPath(entry.path)) return false;
    if (isWorkspacePackageInfrastructurePathV1(entry.path)) throw new RalphValidationProjectionErrorV1("D_VALIDATION_PROJECTION_INVALID");
    return true;
  });
  const byPath = new Map(entries.map((entry) => [entry.path, entry] as const));
  if (byPath.size !== entries.length) throw new RalphValidationProjectionErrorV1("D_VALIDATION_PROJECTION_INVALID");
  for (const entry of entries) {
    assertSafeRelativePath(entry.path);
    let parent = dirname(entry.path);
    while (parent !== ".") {
      if (isProjectionControlPath(parent)) throw new RalphValidationProjectionErrorV1("D_VALIDATION_PROJECTION_INVALID");
      if (byPath.get(parent)?.kind !== "directory") throw new RalphValidationProjectionErrorV1("D_VALIDATION_PROJECTION_INVALID");
      parent = dirname(parent);
    }
  }

  const directories = entries.filter((entry) => entry.kind === "directory")
    .sort((left, right) => pathDepth(left.path) - pathDepth(right.path) || comparePath(left.path, right.path));
  for (const entry of directories) {
    await assertSourceEntry(candidateRoot, entry.path, "directory", entry.mode);
    await mkdir(join(projectionRoot, entry.path), { mode: 0o700 });
  }
  const leaves = entries.filter((entry) => entry.kind !== "directory").sort((left, right) => comparePath(left.path, right.path));
  for (const entry of leaves) {
    const source = join(candidateRoot, entry.path);
    const destination = join(projectionRoot, entry.path);
    await assertRealCandidateParent(candidateRoot, dirname(source));
    if (entry.kind === "symlink") {
      const stats = await lstat(source);
      const target = await readlink(source, "utf8");
      if (!stats.isSymbolicLink() || (stats.mode & 0o7777) !== entry.mode || target !== entry.target) throw new RalphValidationProjectionErrorV1("D_VALIDATION_PROJECTION_INVALID");
      await symlink(target, destination);
      continue;
    }
    const bytes = await readSourceFileExact(source, entry);
    const handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); }
    finally { await handle.close(); }
    await chmod(destination, entry.mode);
  }
  for (const entry of [...directories].reverse()) await chmod(join(projectionRoot, entry.path), entry.mode);
}

async function readSourceFileExact(source: string, entry: WorkspaceManifestV2["productWorkspaceEntries"][number]): Promise<Buffer> {
  const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o7777) !== entry.mode || before.size !== entry.size) {
      throw new RalphValidationProjectionErrorV1("D_VALIDATION_PROJECTION_INVALID");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!after.isFile() || (after.mode & 0o7777) !== entry.mode || after.size !== entry.size || sha256(bytes) !== entry.contentHash
      || before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new RalphValidationProjectionErrorV1("D_VALIDATION_PROJECTION_INVALID");
    }
    return bytes;
  } finally { await handle.close(); }
}

async function assertSourceEntry(candidateRoot: string, path: string, kind: "directory", mode: number): Promise<void> {
  const source = join(candidateRoot, path);
  await assertRealCandidateParent(candidateRoot, dirname(source));
  const stats = await lstat(source);
  if (kind === "directory" && (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o7777) !== mode || await realpath(source) !== source)) {
    throw new RalphValidationProjectionErrorV1("D_VALIDATION_PROJECTION_INVALID");
  }
}

async function assertRealCandidateParent(candidateRoot: string, parent: string): Promise<void> {
  if (!isDescendantOrSelf(candidateRoot, parent) || await realpath(parent) !== parent) throw new RalphValidationProjectionErrorV1("D_VALIDATION_PROJECTION_INVALID");
}

async function removeCoreProjectionInfrastructure(authority: ValidationProjectionAuthorityV1): Promise<void> {
  try {
    assertProjectionAuthority(authority);
    await assertProjectionStructure(authority);
    const temporaryBase = await realpath(tmpdir());
    if (dirname(authority.infrastructureRoot) !== temporaryBase || dirname(authority.sessionRoot) !== authority.infrastructureRoot
      || dirname(authority.projectionRoot) !== authority.sessionRoot) throw new Error("structure");
    // The validation namespace sees only the projection at synthetic
    // /workspace. It never sees this 0700 session or its 0700 parent, so it
    // cannot replace either between these lstat/realpath checks and removal.
    // Recursive removal may encounter untrusted children but does not follow
    // their symlinks; the structurally proved session root is the only target.
    await rm(authority.sessionRoot, { recursive: true, force: false });
    const remaining = await lstat(authority.infrastructureRoot);
    if (!remaining.isDirectory() || remaining.isSymbolicLink() || await realpath(authority.infrastructureRoot) !== authority.infrastructureRoot) throw new Error("infrastructure");
    await rm(authority.infrastructureRoot, { recursive: true, force: false });
  } catch (error) {
    throw new RalphValidationProjectionErrorV1("D_VALIDATION_PROJECTION_CLEANUP_FAILED", error);
  }
}

async function assertProjectionStructure(authority: ValidationProjectionAuthorityV1): Promise<void> {
  await assertCoreOwnedDirectory(authority.infrastructureRoot);
  await assertCoreOwnedDirectory(authority.sessionRoot);
  const projection = await lstat(authority.projectionRoot);
  if (!projection.isDirectory() || projection.isSymbolicLink() || await realpath(authority.projectionRoot) !== authority.projectionRoot) throw new Error("projection");
  if (!isDescendant(authority.infrastructureRoot, authority.sessionRoot) || !isDescendant(authority.sessionRoot, authority.projectionRoot)
    || isDescendantOrSelf(authority.canonicalCandidateRoot, authority.infrastructureRoot)
    || isDescendantOrSelf(authority.infrastructureRoot, authority.canonicalCandidateRoot)) throw new Error("relationship");
}

async function assertCoreOwnedDirectory(path: string): Promise<void> {
  const stats = await lstat(path);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!stats.isDirectory() || stats.isSymbolicLink() || await realpath(path) !== path || (stats.mode & 0o077) !== 0 || (uid !== undefined && stats.uid !== uid)) throw new Error("ownership");
}

async function requireRealDirectory(path: string, code: "D_VALIDATION_PROJECTION_INVALID"): Promise<string> {
  try {
    if (resolve(path) !== path || path.includes("\0")) throw new Error("path");
    const stats = await lstat(path);
    if (!stats.isDirectory() || stats.isSymbolicLink() || await realpath(path) !== path) throw new Error("directory");
    return path;
  } catch (error) { throw new RalphValidationProjectionErrorV1(code, error); }
}

async function removeIncompleteInfrastructure(infrastructureRoot: string, temporaryBase: string): Promise<void> {
  const stats = await lstat(infrastructureRoot).catch(() => undefined);
  if (!stats) return;
  if (!stats.isDirectory() || stats.isSymbolicLink() || dirname(infrastructureRoot) !== temporaryBase || await realpath(infrastructureRoot) !== infrastructureRoot) return;
  await rm(infrastructureRoot, { recursive: true, force: false });
}

function sameAttemptBinding(left: Pick<ValidationProjectionAuthorityV1, "runId" | "phaseId" | "taskId" | "attemptId">, right: ValidationProcessBindingV2): boolean {
  return left.runId === right.runId && left.phaseId === right.phaseId && left.taskId === right.taskId && left.attemptId === right.attemptId;
}

function isProjectionControlPath(path: string): boolean {
  return [".rb", ".rb-harness", ".git"].some((root) => path === root || path.startsWith(`${root}/`));
}

function assertSafeRelativePath(path: string): void {
  if (!path || path.startsWith("/") || path.includes("\0") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new RalphValidationProjectionErrorV1("D_VALIDATION_PROJECTION_INVALID");
  }
}

function assertSafeIdentity(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\0") || value.includes("/")) throw new RalphValidationProjectionErrorV1("D_VALIDATION_PROJECTION_INVALID");
}

function isDescendant(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value.length > 0 && value !== ".." && !value.startsWith(`..${sep}`);
}

function isDescendantOrSelf(parent: string, child: string): boolean {
  return parent === child || isDescendant(parent, child);
}

function pathDepth(path: string): number { return path.split("/").length; }
function comparePath(left: string, right: string): number { return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8")); }
