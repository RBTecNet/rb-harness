import { readdir, readFile, lstat, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Stats } from "node:fs";
import type { WorkspacePolicy } from "./contracts.js";
import { canonicalJson } from "./canonical-json.js";
import { sha256, sha256Canonical } from "./hashing.js";
import { scopeTokenCoversPath } from "../../path-ownership.js";

export const WORKSPACE_FINGERPRINT_FORMAT = "rb-ralph-workspace-fingerprint/v1" as const;
const CONTROL_ROOT = ".rb";
const FORBIDDEN_ROOTS = [".git", ".rb-harness/ralph"] as const;
const DEFAULT_EXCLUDED_ROOTS = [
  ".git",
  ".rb-harness/ralph",
  "node_modules",
  "vendor",
  "build",
  "dist",
  "coverage",
  ".cache",
  "cache",
  "tmp",
  "temp",
] as const;

export interface WorkspaceFingerprintPolicyInput {
  readonly scopePaths?: readonly string[];
  readonly coversPaths?: readonly string[];
  readonly additionalExcludes?: readonly string[];
  readonly generatedPaths?: readonly string[];
  readonly trackedPaths?: readonly string[];
  readonly ignoredPaths?: readonly string[];
}

export interface WorkspaceFingerprintFileSystem {
  readonly readdir: (path: string) => Promise<readonly string[]>;
  readonly readFile: (path: string) => Promise<Buffer>;
  readonly lstat: (path: string) => Promise<Stats>;
  readonly readlink: (path: string) => Promise<string>;
}

export const nodeWorkspaceFingerprintFileSystem: WorkspaceFingerprintFileSystem = {
  readdir: async (path) => readdir(path),
  readFile: async (path) => readFile(path),
  lstat,
  readlink: async (path) => readlink(path, "utf8"),
};

export interface FingerprintEntry {
  readonly path: string;
  readonly kind: "file" | "directory" | "symlink";
  readonly mode: number;
  readonly size?: number;
  readonly contentHash?: string;
  readonly target?: string;
}

export interface ExcludedRootSentinel {
  readonly path: string;
  readonly kind: "file" | "directory" | "symlink" | "special";
  readonly exists: boolean;
  readonly mode: number | null;
  readonly policyRule: string;
}

export interface WorkspaceFingerprint {
  readonly format: typeof WORKSPACE_FINGERPRINT_FORMAT;
  readonly controlPlaneFingerprint: string;
  readonly productWorkspaceFingerprint: string;
  readonly policyDigest: string;
  readonly controlPlaneEntries: readonly FingerprintEntry[];
  readonly productWorkspaceEntries: readonly FingerprintEntry[];
  readonly excludedRoots: readonly ExcludedRootSentinel[];
  readonly vcsMetadata?: Readonly<Record<string, string>>;
  readonly fingerprintDigest: string;
}

export function createWorkspacePolicy(input: WorkspaceFingerprintPolicyInput = {}): WorkspacePolicy {
  const scopePaths = normalizePatterns(input.scopePaths ?? []);
  const coversPaths = normalizePatterns(input.coversPaths ?? []);
  const additionalExcludes = normalizePatterns([...(input.additionalExcludes ?? []), ...(input.generatedPaths ?? [])]);
  for (const pattern of [...scopePaths, ...coversPaths]) {
    if (isForbiddenPath(patternLiteralPrefix(pattern)) || patternLiteralPrefix(pattern) === CONTROL_ROOT) {
      throw new Error(`RALPH_WORKSPACE_POLICY_FORBIDDEN_SCOPE: ${pattern}`);
    }
  }
  for (const pattern of additionalExcludes) {
    if (isForbiddenPath(patternLiteralPrefix(pattern)) || patternLiteralPrefix(pattern) === CONTROL_ROOT) throw new Error(`RALPH_WORKSPACE_POLICY_FORBIDDEN_EXCLUDE: ${pattern}`);
    if (scopePaths.some((scope) => patternsIntersect(scope, pattern)) || coversPaths.some((scope) => patternsIntersect(scope, pattern))) {
      throw new Error(`RALPH_WORKSPACE_POLICY_EXCLUDES_SCOPE: ${pattern}`);
    }
  }
  const base = {
    format: "rb-ralph-workspace-policy/v1" as const,
    scopePaths,
    coversPaths,
    additionalExcludes,
  };
  return { ...base, generatedPaths: normalizePatterns(input.generatedPaths ?? []), policyDigest: sha256Canonical(base) };
}

export async function fingerprintWorkspace(
  projectRoot: string,
  input: WorkspaceFingerprintPolicyInput = {},
  vcsMetadata?: Readonly<Record<string, string>>,
  fileSystem: WorkspaceFingerprintFileSystem = nodeWorkspaceFingerprintFileSystem,
): Promise<WorkspaceFingerprint> {
  const root = resolve(projectRoot);
  const policy = createWorkspacePolicy(input);
  const tracked = new Set(normalizePaths(input.trackedPaths ?? []));
  const ignored = new Set(normalizePaths(input.ignoredPaths ?? []));
  const controlPlaneEntries: FingerprintEntry[] = [];
  const productWorkspaceEntries: FingerprintEntry[] = [];
  const excludedRoots: ExcludedRootSentinel[] = [];
  const normalizedPaths = new Set<string>();

  await visit(root, "", "product");

  controlPlaneEntries.sort(compareEntries);
  productWorkspaceEntries.sort(compareEntries);
  excludedRoots.sort((left, right) => comparePath(left.path, right.path));
  const controlPlaneFingerprint = sha256Canonical({ format: WORKSPACE_FINGERPRINT_FORMAT, plane: "control", entries: controlPlaneEntries });
  const productWorkspaceFingerprint = sha256Canonical({ format: WORKSPACE_FINGERPRINT_FORMAT, plane: "product", entries: productWorkspaceEntries, excludedRoots });
  const result = {
    format: WORKSPACE_FINGERPRINT_FORMAT,
    controlPlaneFingerprint,
    productWorkspaceFingerprint,
    policyDigest: policy.policyDigest,
    controlPlaneEntries,
    productWorkspaceEntries,
    excludedRoots,
    ...(vcsMetadata === undefined ? {} : { vcsMetadata }),
  };
  return { ...result, fingerprintDigest: sha256Canonical(result) };

  async function visit(absolutePath: string, relativePath: string, plane: "control" | "product"): Promise<boolean> {
    const path = normalizeRelative(relativePath);
    if (path && normalizedPaths.has(path)) throw new Error(`RALPH_FINGERPRINT_PATH_COLLISION: ${path}`);
    if (path) normalizedPaths.add(path);
    let stats: Stats;
    try { stats = await fileSystem.lstat(absolutePath); } catch (error) { throw fingerprintReadError(path, error); }
    const control = isControlPath(path);
    const forbidden = isForbiddenPath(path);
    const excludedRule = path.length === 0 ? undefined : excludedRuleFor(path);

    if (forbidden) {
      return false;
    }
    if (stats.isSymbolicLink()) {
      if (excludedRule === path && !control && !isExplicitPath(path) && !tracked.has(path)) {
        recordSentinel(path, stats, excludedRule);
        return false;
      }
      if (!shouldIncludePath(path, control, plane)) return false;
      const entry: FingerprintEntry = { path, kind: "symlink", mode: modeOf(stats), target: await fileSystem.readlink(absolutePath) };
      addEntry(plane, entry);
      return true;
    }
    if (stats.isDirectory()) {
      if (excludedRule === path && !control) recordSentinel(path, stats, excludedRule);
      if (excludedRule === path && !control && !hasExplicitDescendant(path) && !hasTrackedDescendant(path)) {
        return false;
      }
      if (excludedRule !== undefined && !control && !isExplicitPath(path) && !hasExplicitDescendant(path) && !tracked.has(path) && !hasTrackedDescendant(path)) {
        return false;
      }
      if (!control && isIgnoredPath(path) && !isExplicitPath(path) && !hasTrackedDescendant(path)) {
        recordSentinel(path, stats, "ignored");
        return false;
      }
      const names = [...await fileSystem.readdir(absolutePath)].sort(comparePath);
      let childIncluded = false;
      for (const name of names) {
        const child = path ? `${path}/${name}` : name;
        const childExcludedRule = excludedRuleFor(child);
        if (!control && childExcludedRule && !isForbiddenPath(child) && !isExplicitPath(child) && !hasExplicitDescendant(child) && !tracked.has(child) && !hasTrackedDescendant(child)) {
          // Visit the excluded root exactly once so its existence/type/mode is
          // authoritative, while the visit itself stops before readdir().
          await visit(join(absolutePath, name), child, "product");
          continue;
        }
        if (await visit(join(absolutePath, name), child, control || isControlPath(child) ? "control" : "product")) childIncluded = true;
      }
      const includeDirectory = control || childIncluded || isExplicitPath(path) || (plane === "product" && !excludedRule && path.length > 0 && path !== ".rb-harness" && !isIgnoredPath(path));
      if (includeDirectory && path.length > 0 && (shouldIncludePath(path, control, plane) || (childIncluded && !forbidden))) {
        addEntry(plane, { path, kind: "directory", mode: modeOf(stats) });
        return true;
      }
      return childIncluded;
    }
    if (stats.isFile()) {
      if (excludedRule === path && !control && !isExplicitPath(path) && !tracked.has(path)) {
        recordSentinel(path, stats, excludedRule);
        return false;
      }
      if (!shouldIncludePath(path, control, plane)) return false;
      const bytes = await fileSystem.readFile(absolutePath).catch((error) => { throw fingerprintReadError(path, error); });
      addEntry(plane, { path, kind: "file", mode: modeOf(stats), size: stats.size, contentHash: sha256(bytes) });
      return true;
    }
    if (shouldIncludePath(path, control, plane)) throw new Error(`RALPH_FINGERPRINT_SPECIAL_FILE_UNSUPPORTED: ${path}`);
    return false;
  }

  function addEntry(plane: "control" | "product", entry: FingerprintEntry): void {
    (plane === "control" ? controlPlaneEntries : productWorkspaceEntries).push(entry);
  }

  function recordSentinel(path: string, stats: Stats, policyRule: string): void {
    if (excludedRoots.some((entry) => entry.path === path)) return;
    const kind = stats.isDirectory() ? "directory" : stats.isSymbolicLink() ? "symlink" : stats.isFile() ? "file" : "special";
    excludedRoots.push({ path, kind, exists: true, mode: modeOf(stats), policyRule });
  }

  function isExplicitPath(path: string): boolean {
    return [...policy.scopePaths, ...policy.coversPaths].some((pattern) => scopeTokenCoversPath(pattern, path));
  }

  function hasExplicitDescendant(path: string): boolean {
    return [...policy.scopePaths, ...policy.coversPaths].some((pattern) => pathMayContain(path, patternLiteralPrefix(pattern)));
  }

  function hasTrackedDescendant(path: string): boolean {
    return [...tracked].some((trackedPath) => pathMayContain(path, trackedPath));
  }

  function excludedRuleFor(path: string): string | undefined {
    const rootRule = DEFAULT_EXCLUDED_ROOTS.find((candidate) => matchesRoot(path, candidate));
    if (rootRule) return rootRule;
    const policyRule = policy.additionalExcludes.find((candidate) => scopeTokenCoversPath(candidate, path));
    if (policyRule) return policyRule;
    return rootRule;
  }

  function shouldIncludePath(path: string, isControl: boolean, currentPlane: "control" | "product"): boolean {
    if (path.length === 0) return false;
    if (isControl) return currentPlane === "control";
    if (isForbiddenPath(path)) return false;
    if (isExplicitPath(path)) return true;
    if (tracked.has(path)) return true;
    if (excludedRuleFor(path)) return false;
    return !isIgnoredPath(path);
  }

  function isIgnoredPath(path: string): boolean {
    return [...ignored].some((candidate) => scopeTokenCoversPath(candidate, path));
  }
}

function normalizePatterns(paths: readonly string[]): readonly string[] {
  return [...new Set(paths.map(normalizePattern))].sort(comparePath);
}

function normalizePaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths.map(normalizeRelative))].sort(comparePath);
}

function normalizePattern(input: string): string {
  let value = normalizeRelative(input);
  if (value === ".") value = "";
  if (!value) throw new Error("RALPH_WORKSPACE_POLICY_EMPTY_PATH");
  return value;
}

function normalizeRelative(input: string): string {
  const value = input.replaceAll("\\", "/").normalize("NFC").replace(/^\.\//, "").replace(/\/$/, "");
  if (!value || value === ".") return "";
  if (value.startsWith("/") || value.split("/").includes("..")) throw new Error(`RALPH_INVALID_WORKSPACE_PATH: ${input}`);
  return value;
}

function isControlPath(path: string): boolean { return path === CONTROL_ROOT || path.startsWith(`${CONTROL_ROOT}/`); }
function isForbiddenPath(path: string): boolean { return FORBIDDEN_ROOTS.some((root) => path === root || path.startsWith(`${root}/`)); }
function matchesRoot(path: string, root: string): boolean { return path === root || path.startsWith(`${root}/`); }
function pathMayContain(parent: string, child: string): boolean { return child === parent || child.startsWith(`${parent}/`) || parent.startsWith(`${child}/`); }
function patternsIntersect(left: string, right: string): boolean { return pathMayContain(patternLiteralPrefix(left), patternLiteralPrefix(right)); }
function patternLiteralPrefix(pattern: string): string {
  const firstWildcard = pattern.search(/[?*]/);
  if (firstWildcard < 0) return pattern;
  const slash = pattern.lastIndexOf("/", firstWildcard);
  return slash < 0 ? "" : pattern.slice(0, slash);
}
function modeOf(stats: Stats): number { return stats.mode & 0o7777; }
function comparePath(left: string, right: string): number { return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8")); }
function compareEntries(left: FingerprintEntry, right: FingerprintEntry): number { return comparePath(left.path, right.path); }
function fingerprintReadError(path: string, error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(`RALPH_FINGERPRINT_UNREADABLE_PATH: ${path}: ${reason}`);
}
