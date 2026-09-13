import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { scopeTokenCoversPath } from "../../path-ownership.js";
import { canonicalJson } from "../ralph-runtime/canonical-json.js";
import { sha256, sha256Canonical } from "../ralph-runtime/hashing.js";
import { isWorkspacePackageInfrastructurePathV1 } from "../ralph-runtime/package-infrastructure.js";

export const RALPH_BRIDGE_PUBLICATION_SCHEMA_V1 = "rb-ralph-host-publication/v1" as const;

const PROTECTED_ROOTS = [".rb", ".rb-harness", ".spec/init", ".git"] as const;
const GENERATED_ROOTS = ["node_modules", "vendor", "build", "dist", "coverage", ".cache", "cache", "tmp", "temp"] as const;

export class RalphBridgeWorkspaceError extends Error {
  constructor(readonly code: string, message: string = code) {
    super(`${code}: ${message}`);
    this.name = "RalphBridgeWorkspaceError";
  }
}

export interface BridgeFileEntryV1 {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly mode: number;
}

export interface BridgeWorkspaceSnapshotV1 {
  readonly files: Readonly<Record<string, BridgeFileEntryV1>>;
  readonly digest: string;
}

export interface BridgeDeltaEntryV1 {
  readonly path: string;
  readonly kind: "create" | "update" | "delete";
  readonly beforeSha256?: string;
  readonly afterSha256?: string;
}

export interface HostPublicationReceiptV1 {
  readonly schema: typeof RALPH_BRIDGE_PUBLICATION_SCHEMA_V1;
  readonly runId: string;
  readonly planId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly decision: "PUBLISHED" | "REJECTED";
  readonly reason?: string;
  readonly readinessDigest: string;
  readonly hostBaselineBefore: string;
  readonly hostBaselineAfter: string;
  readonly workspaceBaselineBefore: string;
  readonly workspaceCandidate: string;
  readonly delta: readonly BridgeDeltaEntryV1[];
  readonly publishedAt: string;
  readonly receiptDigest: string;
}

export interface HostPublicationOutcomeV1 {
  readonly publicationOccurred: boolean;
  readonly rejected?: HostPublicationReceiptV1;
}

export async function snapshotHostImplementation(
  projectRoot: string,
  allOwnedPaths: readonly string[],
): Promise<BridgeWorkspaceSnapshotV1> {
  return snapshotTree(projectRoot, { plane: "host", allOwnedPaths });
}

export async function snapshotRalphWorkspace(
  workspaceRoot: string,
  allOwnedPaths: readonly string[],
): Promise<BridgeWorkspaceSnapshotV1> {
  return snapshotTree(workspaceRoot, { plane: "workspace", allOwnedPaths });
}

/** Creates a provider workspace containing implementation inputs only. */
export async function createIsolatedRalphWorkspace(
  projectRoot: string,
  workspaceRoot: string,
  baseline: BridgeWorkspaceSnapshotV1,
): Promise<void> {
  const sourceRoot = await canonicalRoot(projectRoot);
  const targetRoot = resolve(workspaceRoot);
  if (targetRoot === sourceRoot || !targetRoot.startsWith(`${sourceRoot}${sep}`) || !isProtectedPath(relative(sourceRoot, targetRoot).replaceAll("\\", "/"))) {
    throw new RalphBridgeWorkspaceError("RALPH_BRIDGE_WORKSPACE_LOCATION_UNSAFE");
  }
  if (await lstat(targetRoot).then(() => true).catch(() => false)) {
    throw new RalphBridgeWorkspaceError("RALPH_BRIDGE_WORKSPACE_ALREADY_EXISTS");
  }
  await assertSafeTargetAncestors(sourceRoot, targetRoot, relative(sourceRoot, targetRoot).replaceAll("\\", "/"));
  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  await canonicalRoot(targetRoot);
  for (const entry of Object.values(baseline.files).sort((left, right) => left.path.localeCompare(right.path))) {
    const source = safeChild(sourceRoot, entry.path);
    const target = safeChild(targetRoot, entry.path);
    await assertRegularNoSymlink(source, entry.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(source, target);
    await chmod(target, entry.mode & 0o777);
    const copied = await readFile(target);
    if (sha256(copied) !== entry.sha256) throw new RalphBridgeWorkspaceError("RALPH_BRIDGE_WORKSPACE_COPY_MISMATCH", entry.path);
  }
}

export function deriveWorkspaceDelta(
  before: BridgeWorkspaceSnapshotV1,
  after: BridgeWorkspaceSnapshotV1,
): readonly BridgeDeltaEntryV1[] {
  const paths = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort();
  return paths.flatMap((path): BridgeDeltaEntryV1[] => {
    const oldEntry = before.files[path];
    const nextEntry = after.files[path];
    if (!oldEntry && nextEntry) return [{ path, kind: "create", afterSha256: nextEntry.sha256 }];
    if (oldEntry && !nextEntry) return [{ path, kind: "delete", beforeSha256: oldEntry.sha256 }];
    if (oldEntry && nextEntry && (oldEntry.sha256 !== nextEntry.sha256 || oldEntry.mode !== nextEntry.mode)) {
      return [{ path, kind: "update", beforeSha256: oldEntry.sha256, afterSha256: nextEntry.sha256 }];
    }
    return [];
  });
}

export async function publishAcceptedTaskDelta(input: {
  readonly projectRoot: string;
  readonly workspaceRoot: string;
  readonly runDirectory: string;
  readonly runId: string;
  readonly planId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly taskOwnedPaths: readonly string[];
  readonly allOwnedPaths: readonly string[];
  readonly expectedHostBaseline: BridgeWorkspaceSnapshotV1;
  readonly workspaceBaseline: BridgeWorkspaceSnapshotV1;
  readonly revalidateReadiness: () => Promise<string>;
  readonly clock?: () => string;
}): Promise<{
  readonly receipt: HostPublicationReceiptV1;
  readonly hostBaseline: BridgeWorkspaceSnapshotV1;
  readonly workspaceBaseline: BridgeWorkspaceSnapshotV1;
}> {
  const readinessDigest = await input.revalidateReadiness();
  const currentHost = await snapshotHostImplementation(input.projectRoot, input.allOwnedPaths);
  if (currentHost.digest !== input.expectedHostBaseline.digest) {
    throw new RalphBridgeWorkspaceError("RALPH_BRIDGE_PROJECT_CONCURRENT_MODIFICATION");
  }
  const candidate = await snapshotRalphWorkspace(input.workspaceRoot, input.allOwnedPaths);
  const delta = deriveWorkspaceDelta(input.workspaceBaseline, candidate);
  assertAuthorizedDelta(delta, input.taskOwnedPaths);

  const root = await canonicalRoot(input.projectRoot);
  const workspace = await canonicalRoot(input.workspaceRoot);
  const stagingRoot = resolve(input.runDirectory, "host-publication-staging");
  if (!stagingRoot.startsWith(`${resolve(input.runDirectory)}${sep}`)) {
    throw new RalphBridgeWorkspaceError("RALPH_BRIDGE_PUBLICATION_STAGING_UNSAFE");
  }
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  const staged: Array<{ readonly target: string; readonly temporary?: string; readonly backup?: string; readonly entry: BridgeDeltaEntryV1 }> = [];
  const applied: typeof staged = [];
  try {
    for (const entry of delta) {
      const target = safeChild(root, entry.path);
      await assertSafeTargetAncestors(root, target, entry.path);
      let backup: string | undefined;
      if (entry.kind !== "create") {
        await assertRegularNoSymlink(target, entry.path);
        const before = await readFile(target);
        if (sha256(before) !== entry.beforeSha256) throw new RalphBridgeWorkspaceError("RALPH_BRIDGE_PROJECT_CONCURRENT_MODIFICATION", entry.path);
        backup = resolve(stagingRoot, `${randomUUID()}.backup`);
        await writeFile(backup, before, { flag: "wx", mode: input.expectedHostBaseline.files[entry.path]!.mode & 0o777 });
      } else if (await lstat(target).then(() => true).catch(() => false)) {
        throw new RalphBridgeWorkspaceError("RALPH_BRIDGE_PROJECT_CONCURRENT_MODIFICATION", entry.path);
      }
      if (entry.kind === "delete") {
        staged.push({ target, backup, entry });
      } else {
        const source = safeChild(workspace, entry.path);
        await assertRegularNoSymlink(source, entry.path);
        const bytes = await readFile(source);
        if (sha256(bytes) !== entry.afterSha256) throw new RalphBridgeWorkspaceError("RALPH_BRIDGE_CANDIDATE_CHANGED_DURING_PUBLICATION", entry.path);
        await mkdir(dirname(target), { recursive: true, mode: 0o755 });
        await assertSafeTargetAncestors(root, target, entry.path);
        const temporary = resolve(stagingRoot, `${randomUUID()}.tmp`);
        await writeFile(temporary, bytes, { flag: "wx", mode: candidate.files[entry.path]!.mode & 0o777 });
        staged.push({ target, temporary, backup, entry });
      }
    }
    // Recheck every source preimage after staging and immediately before the
    // first externally visible rename/unlink.
    const finalHostCheck = await snapshotHostImplementation(root, input.allOwnedPaths);
    if (finalHostCheck.digest !== input.expectedHostBaseline.digest) {
      throw new RalphBridgeWorkspaceError("RALPH_BRIDGE_PROJECT_CONCURRENT_MODIFICATION");
    }
    for (const entry of delta) {
      const stage = staged.find((candidateStage) => candidateStage.entry === entry)!;
      applied.push(stage);
      if (entry.kind === "delete") {
        await assertRegularNoSymlink(stage.target, entry.path);
        await unlink(stage.target);
      } else {
        await rename(stage.temporary!, stage.target);
        await chmod(stage.target, candidate.files[entry.path]!.mode & 0o777);
      }
    }
    const hostBaseline = await snapshotHostImplementation(root, input.allOwnedPaths);
    const publishedAt = input.clock?.() ?? new Date().toISOString();
    const receipt = createReceipt({
      runId: input.runId,
      planId: input.planId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      decision: "PUBLISHED",
      readinessDigest,
      hostBaselineBefore: input.expectedHostBaseline.digest,
      hostBaselineAfter: hostBaseline.digest,
      workspaceBaselineBefore: input.workspaceBaseline.digest,
      workspaceCandidate: candidate.digest,
      delta,
      publishedAt,
    });
    await persistPublicationReceipt(input.runDirectory, receipt);
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    return { receipt, hostBaseline, workspaceBaseline: candidate };
  } catch (error) {
    let rollbackFailed = false;
    for (const stage of applied.reverse()) {
      try {
        if (stage.entry.kind === "create") await rm(stage.target, { force: true });
        else {
          if (!stage.backup) throw new Error("missing publication backup");
          await rename(stage.backup, stage.target);
          await chmod(stage.target, input.expectedHostBaseline.files[stage.entry.path]!.mode & 0o777);
        }
      } catch { rollbackFailed = true; }
    }
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => { rollbackFailed = true; });
    if (rollbackFailed) throw new RalphBridgeWorkspaceError("RALPH_BRIDGE_PUBLICATION_ROLLBACK_FAILED", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export async function persistRejectedPublication(input: {
  readonly runDirectory: string;
  readonly runId: string;
  readonly planId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly readinessDigest: string;
  readonly hostBaseline: BridgeWorkspaceSnapshotV1;
  readonly workspaceBaseline: BridgeWorkspaceSnapshotV1;
  readonly workspaceCandidate?: BridgeWorkspaceSnapshotV1;
  readonly reason: string;
  readonly clock?: () => string;
}): Promise<HostPublicationReceiptV1> {
  const receipt = createReceipt({
    runId: input.runId,
    planId: input.planId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    decision: "REJECTED",
    reason: input.reason,
    readinessDigest: input.readinessDigest,
    hostBaselineBefore: input.hostBaseline.digest,
    hostBaselineAfter: input.hostBaseline.digest,
    workspaceBaselineBefore: input.workspaceBaseline.digest,
    workspaceCandidate: input.workspaceCandidate?.digest ?? input.workspaceBaseline.digest,
    delta: input.workspaceCandidate ? deriveWorkspaceDelta(input.workspaceBaseline, input.workspaceCandidate) : [],
    publishedAt: input.clock?.() ?? new Date().toISOString(),
  });
  await persistPublicationReceipt(input.runDirectory, receipt);
  return receipt;
}

/** Reads only the immutable host receipts; Ralph state remains run authority. */
export async function inspectHostPublicationOutcome(
  runDirectory: string,
): Promise<HostPublicationOutcomeV1> {
  const attemptsRoot = resolve(runDirectory, "attempts");
  const attempts = await readdir(attemptsRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
  let publicationOccurred = false;
  let rejected: HostPublicationReceiptV1 | undefined;
  for (const attemptId of attempts.sort()) {
    const path = resolve(attemptsRoot, attemptId, "host-publication.json");
    const source = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (source === undefined) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(source); }
    catch { throw new RalphBridgeWorkspaceError("RALPH_BRIDGE_PUBLICATION_RECEIPT_INVALID", attemptId); }
    if (!isPublicationReceipt(parsed) || parsed.attemptId !== attemptId) {
      throw new RalphBridgeWorkspaceError("RALPH_BRIDGE_PUBLICATION_RECEIPT_INVALID", attemptId);
    }
    if (parsed.decision === "REJECTED") rejected = parsed;
    if (parsed.decision === "PUBLISHED" && parsed.delta.length > 0) publicationOccurred = true;
  }
  return Object.freeze({ publicationOccurred, ...(rejected ? { rejected } : {}) });
}

export function isProtectedPath(path: string): boolean {
  const normalized = normalizeRelativePath(path);
  return PROTECTED_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

function assertAuthorizedDelta(delta: readonly BridgeDeltaEntryV1[], ownedPaths: readonly string[]): void {
  for (const entry of delta) {
    const path = normalizeRelativePath(entry.path);
    if (path !== entry.path) throw new RalphBridgeWorkspaceError("RALPH_BRIDGE_PUBLICATION_PATH_UNSAFE", entry.path);
    if (isProtectedPath(path)) throw new RalphBridgeWorkspaceError("RALPH_BRIDGE_CONTROL_PATH_WRITE", path);
    if (!ownedPaths.some((owned) => scopeTokenCoversPath(owned, path))) {
      throw new RalphBridgeWorkspaceError("RALPH_BRIDGE_UNOWNED_PATH_WRITE", path);
    }
  }
}

async function snapshotTree(
  rootInput: string,
  options: { readonly plane: "host" | "workspace"; readonly allOwnedPaths: readonly string[] },
): Promise<BridgeWorkspaceSnapshotV1> {
  const root = await canonicalRoot(rootInput);
  const files: Record<string, BridgeFileEntryV1> = {};
  await visit(root, "");
  const ordered = Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)));
  return Object.freeze({ files: Object.freeze(ordered), digest: sha256Canonical(ordered) });

  async function visit(absolute: string, relativePath: string): Promise<void> {
    const stats = await lstat(absolute).catch((error) => {
      throw new RalphBridgeWorkspaceError("RALPH_BRIDGE_WORKSPACE_READ_FAILED", `${relativePath}: ${String(error)}`);
    });
    if (stats.isSymbolicLink()) throw new RalphBridgeWorkspaceError("RALPH_BRIDGE_SYMLINK_UNSAFE", relativePath || ".");
    if (relativePath && options.plane === "workspace" && isWorkspacePackageInfrastructurePathV1(relativePath)) {
      throw new RalphBridgeWorkspaceError("RALPH_BRIDGE_PACKAGE_INFRASTRUCTURE_FORBIDDEN", relativePath);
    }
    if (relativePath && skipPath(relativePath, options)) return;
    if (stats.isDirectory()) {
      const names = (await readdir(absolute)).sort();
      for (const name of names) await visit(resolve(absolute, name), relativePath ? `${relativePath}/${name}` : name);
      return;
    }
    if (!stats.isFile()) throw new RalphBridgeWorkspaceError("RALPH_BRIDGE_SPECIAL_FILE_UNSAFE", relativePath);
    const path = normalizeRelativePath(relativePath);
    const bytes = await readFile(absolute);
    files[path] = Object.freeze({ path, sha256: sha256(bytes), size: bytes.length, mode: stats.mode & 0o777 });
  }
}

function skipPath(path: string, options: { readonly plane: "host" | "workspace"; readonly allOwnedPaths: readonly string[] }): boolean {
  if (options.plane === "host" && isProtectedPath(path)) return true;
  if (options.plane === "workspace" && (path === ".rb-harness/ralph" || path.startsWith(".rb-harness/ralph/"))) return true;
  if (options.plane === "host" && isWorkspacePackageInfrastructurePathV1(path)) return true;
  return GENERATED_ROOTS.some((root) => (path === root || path.startsWith(`${root}/`))
    && !options.allOwnedPaths.some((owned) => scopeTokenCoversPath(owned, path) || scopeTokenCoversPath(path, owned)));
}

async function canonicalRoot(rootInput: string): Promise<string> {
  const root = resolve(rootInput);
  const physical = await realpath(root).catch(() => root);
  if (physical !== root) throw new RalphBridgeWorkspaceError("RALPH_BRIDGE_ROOT_SYMLINK_UNSAFE", root);
  const stats = await lstat(root).catch(() => undefined);
  if (!stats?.isDirectory() || stats.isSymbolicLink()) throw new RalphBridgeWorkspaceError("RALPH_BRIDGE_ROOT_UNSAFE", root);
  return root;
}

function safeChild(root: string, path: string): string {
  const normalized = normalizeRelativePath(path);
  const child = resolve(root, normalized);
  if (child === root || !child.startsWith(`${root}${sep}`)) throw new RalphBridgeWorkspaceError("RALPH_BRIDGE_PUBLICATION_PATH_UNSAFE", path);
  return child;
}

function normalizeRelativePath(path: string): string {
  if (typeof path !== "string" || !path || path.includes("\0") || path.includes("\\") || isAbsolute(path)) {
    throw new RalphBridgeWorkspaceError("RALPH_BRIDGE_PUBLICATION_PATH_UNSAFE", String(path));
  }
  const normalized = path.split("/").filter((part) => part !== ".").join("/");
  if (!normalized || normalized !== path || normalized.split("/").some((part) => !part || part === "..")) {
    throw new RalphBridgeWorkspaceError("RALPH_BRIDGE_PUBLICATION_PATH_UNSAFE", path);
  }
  return normalized;
}

async function assertRegularNoSymlink(path: string, logicalPath: string): Promise<void> {
  const stats = await lstat(path).catch(() => undefined);
  if (!stats?.isFile() || stats.isSymbolicLink()) throw new RalphBridgeWorkspaceError("RALPH_BRIDGE_FILE_UNSAFE", logicalPath);
}

async function assertSafeTargetAncestors(root: string, target: string, logicalPath: string): Promise<void> {
  let current = dirname(target);
  const ancestors: string[] = [];
  while (current !== root) {
    if (!current.startsWith(`${root}${sep}`)) throw new RalphBridgeWorkspaceError("RALPH_BRIDGE_PATH_ESCAPE", logicalPath);
    ancestors.push(current);
    current = dirname(current);
  }
  for (const ancestor of ancestors.reverse()) {
    const stats = await lstat(ancestor).catch(() => undefined);
    if (stats && (!stats.isDirectory() || stats.isSymbolicLink())) throw new RalphBridgeWorkspaceError("RALPH_BRIDGE_SYMLINK_UNSAFE", logicalPath);
  }
  const targetStats = await lstat(target).catch(() => undefined);
  if (targetStats?.isSymbolicLink() || (targetStats && !targetStats.isFile())) throw new RalphBridgeWorkspaceError("RALPH_BRIDGE_FILE_UNSAFE", logicalPath);
}

function createReceipt(input: Omit<HostPublicationReceiptV1, "schema" | "receiptDigest">): HostPublicationReceiptV1 {
  const base = { schema: RALPH_BRIDGE_PUBLICATION_SCHEMA_V1, ...input } as const;
  return Object.freeze({ ...base, receiptDigest: sha256Canonical(base) });
}

function isPublicationReceipt(value: unknown): value is HostPublicationReceiptV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.schema !== RALPH_BRIDGE_PUBLICATION_SCHEMA_V1
    || typeof record.runId !== "string" || typeof record.planId !== "string"
    || typeof record.taskId !== "string" || typeof record.attemptId !== "string"
    || (record.decision !== "PUBLISHED" && record.decision !== "REJECTED")
    || !Array.isArray(record.delta) || typeof record.receiptDigest !== "string") return false;
  const { receiptDigest, ...base } = record;
  return receiptDigest === sha256Canonical(base);
}

async function persistPublicationReceipt(runDirectory: string, receipt: HostPublicationReceiptV1): Promise<void> {
  const attemptDirectory = resolve(runDirectory, "attempts", receipt.attemptId);
  if (!attemptDirectory.startsWith(`${resolve(runDirectory)}${sep}`)) throw new RalphBridgeWorkspaceError("RALPH_BRIDGE_RECEIPT_PATH_UNSAFE");
  await mkdir(attemptDirectory, { recursive: true, mode: 0o700 });
  const path = resolve(attemptDirectory, "host-publication.json");
  const source = canonicalJson(receipt);
  try {
    await writeFile(path, source, { flag: "wx", mode: 0o600 });
  } catch (error) {
    const existing = await readFile(path, "utf8").catch(() => undefined);
    if (existing !== source) throw new RalphBridgeWorkspaceError("RALPH_BRIDGE_RECEIPT_IMMUTABLE_CONFLICT");
  }
}
