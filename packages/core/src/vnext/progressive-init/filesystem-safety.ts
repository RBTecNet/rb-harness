import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type ProgressivePathEntryKind = "missing" | "file" | "directory";

export interface ProvenProgressiveProjectRoot {
  readonly path: string;
  readonly realPath: string;
  readonly device: number;
  readonly inode: number;
}

export type RejectProgressivePath = (path: string, reason: string) => never;

async function metadata(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}

/** Proves that the named project root is one stable, real directory identity. */
export async function proveProgressiveProjectRoot(
  projectRoot: string,
  reject: RejectProgressivePath,
): Promise<ProvenProgressiveProjectRoot> {
  const path = resolve(projectRoot);
  const info = await metadata(path);
  if (!info) reject(path, "project root does not exist");
  if (info.isSymbolicLink()) reject(path, "project root is a symbolic link");
  if (!info.isDirectory()) reject(path, "project root is not a directory");
  const realPath = await realpath(path);
  if (realPath !== path) reject(path, `project root resolves to ${realPath}`);
  return { path, realPath, device: info.dev, inode: info.ino };
}

/** Re-proves that a previously established root identity has not been replaced. */
export async function assertProgressiveProjectRootIdentity(
  root: ProvenProgressiveProjectRoot,
  reject: RejectProgressivePath,
): Promise<void> {
  const current = await proveProgressiveProjectRoot(root.path, reject);
  if (current.realPath !== root.realPath || current.device !== root.device || current.inode !== root.inode) {
    reject(root.path, "project root identity changed during filesystem operation");
  }
}

/**
 * Inspects every existing component from a proven root to a candidate without
 * following symlinks. The candidate must be a strict descendant of the root.
 */
export async function inspectProgressivePathInsideRoot(
  root: ProvenProgressiveProjectRoot,
  candidatePath: string,
  expected: "file",
  reject: RejectProgressivePath,
): Promise<"missing" | "file">;
export async function inspectProgressivePathInsideRoot(
  root: ProvenProgressiveProjectRoot,
  candidatePath: string,
  expected: "directory",
  reject: RejectProgressivePath,
): Promise<"missing" | "directory">;
export async function inspectProgressivePathInsideRoot(
  root: ProvenProgressiveProjectRoot,
  candidatePath: string,
  expected: "file" | "directory",
  reject: RejectProgressivePath,
): Promise<ProgressivePathEntryKind>;
export async function inspectProgressivePathInsideRoot(
  root: ProvenProgressiveProjectRoot,
  candidatePath: string,
  expected: "file" | "directory",
  reject: RejectProgressivePath,
): Promise<ProgressivePathEntryKind> {
  await assertProgressiveProjectRootIdentity(root, reject);
  const candidate = resolve(candidatePath);
  const rel = relative(root.path, candidate);
  const parts = rel.split(sep);
  if (!rel || isAbsolute(rel) || parts.some((part) => part === ".." || part === "")) {
    reject(candidate, "resolves outside the project root");
  }

  let current = root.path;
  for (const [index, part] of parts.entries()) {
    current = resolve(current, part);
    const info = await metadata(current);
    if (!info) return "missing";
    if (info.isSymbolicLink()) reject(current, "is a symbolic link");
    const final = index === parts.length - 1;
    if (!final && !info.isDirectory()) reject(current, "is not a directory ancestor");
    if (await realpath(current) !== current) reject(current, "resolves through a symbolic link");
    if (!final) continue;
    if (expected === "file" && !info.isFile()) reject(current, "is not the expected regular file");
    if (expected === "directory" && !info.isDirectory()) reject(current, "is not the expected real directory");
    return expected;
  }
  reject(candidate, "could not be proven inside the project root");
}
