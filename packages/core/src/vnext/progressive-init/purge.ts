import { readdir, rm, rmdir, unlink } from "node:fs/promises";
import { posix, relative, resolve, sep } from "node:path";
import { projectDescriptionStageRecordPath } from "./project-description-store.js";
import { strictStageDocumentPath } from "./stage-document-store.js";
import {
  assertProgressiveProjectRootIdentity,
  inspectProgressivePathInsideRoot,
  proveProgressiveProjectRoot,
  type ProvenProgressiveProjectRoot,
} from "./filesystem-safety.js";

/** Stage documents written by `stage-document-store` under `.spec/init`. */
const STAGE_DOCUMENT_FILE_NAMES = [
  "project-description.md",
  "user-stories.md",
  "database-schema.md",
  "project-phases.md",
] as const;

/** Canonical closure published by `closeInitProject`; `.rb` holds exactly these. */
const CANONICAL_CLOSURE_RELATIVE_PATHS = [
  ".rb/init/BRIEF.md",
  ".rb/init/PHASES.md",
  ".rb/rb-manifest.json",
] as const;

/** `closeInitProject` permits at most 64 characters for the complete run ID. */
const PROGRESSIVE_RUN_ID = /^progressive-[a-z0-9][a-z0-9-]{0,51}$/;
const OWNED_CONTAINER_RELATIVE_PATHS = [
  ".spec/init", ".spec", ".rb/init", ".rb",
  ".rb-harness/progressive-init", ".rb-harness/runs",
] as const;

const EXACT_OWNED_FILES = new Set([
  ...STAGE_DOCUMENT_FILE_NAMES.map((name) => `.spec/init/${name}`),
  ".rb-harness/progressive-init/project-description.json",
  ...CANONICAL_CLOSURE_RELATIVE_PATHS,
]);

const CONTROLLED_DIRECTORY_CONTENTS = new Map<string, ReadonlyMap<string, "file" | "directory">>([
  [".spec/init", new Map(STAGE_DOCUMENT_FILE_NAMES.map((name) => [name, "file" as const]))],
  [".rb", new Map([["init", "directory"], ["rb-manifest.json", "file"]])],
  [".rb/init", new Map([["BRIEF.md", "file"], ["PHASES.md", "file"]])],
  [".rb-harness/progressive-init", new Map([["project-description.json", "file"]])],
]);

const RUN_TREE_CONTENTS = new Map<string, ReadonlyMap<string, "file" | "directory">>([
  ["", new Map([["staging", "directory"], ["previous", "directory"], ["vnext-init-state.json", "file"]])],
  ["staging", new Map([[".rb", "directory"]])],
  ["staging/.rb", new Map([["init", "directory"], ["rb-manifest.json", "file"]])],
  ["staging/.rb/init", new Map([["BRIEF.md", "file"], ["PHASES.md", "file"]])],
  ["previous", new Map([[".rb", "directory"]])],
  ["previous/.rb", new Map([["init", "directory"], ["rb-manifest.json", "file"]])],
  ["previous/.rb/init", new Map([["BRIEF.md", "file"], ["PHASES.md", "file"]])],
]);

export class ProgressiveInitPurgeUnsafeError extends Error {
  constructor(readonly path: string, reason: string) {
    super(`PROGRESSIVE_INIT_PURGE_UNSAFE: ${path} ${reason}`);
  }
}

export type ProgressiveInitPurgeTargetKind = "stage-document" | "stage-record" | "canonical-closure" | "run-state";
export interface ProgressiveInitPurgeTarget {
  readonly kind: ProgressiveInitPurgeTargetKind;
  readonly path: string;
  readonly entry: "file" | "directory";
}
export interface ProgressiveInitPurgePlan {
  readonly root: string;
  readonly rootIdentity: ProvenProgressiveProjectRoot;
  readonly targets: readonly ProgressiveInitPurgeTarget[];
}
export interface ProgressiveInitPurgeReport {
  readonly root: string;
  readonly removedFiles: readonly string[];
  readonly removedDirectories: readonly string[];
  readonly emptiedContainers: readonly string[];
}

const reject = (path: string, reason: string): never => {
  throw new ProgressiveInitPurgeUnsafeError(path, reason);
};

function normalizeOwnedRelativePath(relativePath: string): string {
  if (!relativePath || relativePath.startsWith("/") || relativePath.includes("\\")) {
    reject(relativePath, "is not a project-relative Progressive artifact path");
  }
  const parts = relativePath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    reject(relativePath, "contains path traversal");
  }
  const normalized = posix.normalize(relativePath);
  if (normalized !== relativePath) reject(relativePath, "is not a normalized Progressive artifact path");
  return normalized;
}

function assertOwnedNamespace(relativePath: string, expected: "file" | "directory"): void {
  const owned = EXACT_OWNED_FILES.has(relativePath) && expected === "file"
    || expected === "directory" && relativePath.startsWith(".rb-harness/runs/")
      && PROGRESSIVE_RUN_ID.test(relativePath.slice(".rb-harness/runs/".length));
  if (!owned) reject(relativePath, "is outside the Harness-owned Progressive artifact namespace");
}

/** Testable namespace + ancestry proof used for every purge candidate. */
export async function verifyProgressiveInitPurgeCandidate(
  root: ProvenProgressiveProjectRoot,
  relativePath: string,
  expected: "file" | "directory",
): Promise<"missing" | "file" | "directory"> {
  const normalized = normalizeOwnedRelativePath(relativePath);
  assertOwnedNamespace(normalized, expected);
  return inspectProgressivePathInsideRoot(root, resolve(root.path, ...normalized.split("/")), expected, reject);
}

function stageDocumentPaths(root: string): readonly string[] {
  return STAGE_DOCUMENT_FILE_NAMES.map((fileName) => strictStageDocumentPath(root, {
    fileName,
    temporaryPrefix: "purge",
    concurrentModificationCode: "PROGRESSIVE_INIT_PURGE",
    parse: () => { throw new Error("PROGRESSIVE_INIT_PURGE: stage documents are never parsed during purge"); },
  }));
}

async function verifyControlledDirectory(
  root: ProvenProgressiveProjectRoot,
  relativePath: string,
  allowed: ReadonlyMap<string, "file" | "directory">,
): Promise<void> {
  const absolute = resolve(root.path, ...relativePath.split("/"));
  const state = await inspectProgressivePathInsideRoot(root, absolute, "directory", reject);
  if (state === "missing") return;
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const expected = allowed.get(entry.name);
    const path = resolve(absolute, entry.name);
    if (expected === undefined) throw new ProgressiveInitPurgeUnsafeError(path, "is unexpected content in a Harness-owned Progressive directory");
    await inspectProgressivePathInsideRoot(root, path, expected, reject);
  }
}

async function verifyProgressiveRunTree(root: ProvenProgressiveProjectRoot, runRelativePath: string): Promise<void> {
  for (const [subdirectory, allowed] of RUN_TREE_CONTENTS) {
    const relativePath = subdirectory ? `${runRelativePath}/${subdirectory}` : runRelativePath;
    await verifyControlledDirectory(root, relativePath, allowed);
  }
}

async function progressiveRunRelativePaths(root: ProvenProgressiveProjectRoot): Promise<readonly string[]> {
  const relativeRuns = ".rb-harness/runs";
  const runs = resolve(root.path, ".rb-harness", "runs");
  const state = await inspectProgressivePathInsideRoot(root, runs, "directory", reject);
  if (state === "missing") return [];
  const progressive: string[] = [];
  for (const entry of await readdir(runs, { withFileTypes: true })) {
    if (!entry.name.startsWith("progressive-")) continue;
    const relativePath = `${relativeRuns}/${entry.name}`;
    normalizeOwnedRelativePath(relativePath);
    assertOwnedNamespace(relativePath, "directory");
    await verifyProgressiveInitPurgeCandidate(root, relativePath, "directory");
    await verifyProgressiveRunTree(root, relativePath);
    progressive.push(relativePath);
  }
  return progressive.sort();
}

/** Build and completely verify the destructive plan before the first deletion. */
export async function planProgressiveInitPurge(projectRoot: string): Promise<ProgressiveInitPurgePlan> {
  const rootIdentity = await proveProgressiveProjectRoot(projectRoot, reject);
  for (const [relativePath, allowed] of CONTROLLED_DIRECTORY_CONTENTS) {
    await verifyControlledDirectory(rootIdentity, relativePath, allowed);
  }
  const runPaths = await progressiveRunRelativePaths(rootIdentity);
  const candidates: readonly { kind: ProgressiveInitPurgeTargetKind; path: string; expected: "file" | "directory" }[] = [
    ...stageDocumentPaths(rootIdentity.path).map((path) => ({ kind: "stage-document" as const, path, expected: "file" as const })),
    { kind: "stage-record", path: projectDescriptionStageRecordPath(rootIdentity.path), expected: "file" },
    ...CANONICAL_CLOSURE_RELATIVE_PATHS.map((path) => ({ kind: "canonical-closure" as const, path: resolve(rootIdentity.path, ...path.split("/")), expected: "file" as const })),
    ...runPaths.map((path) => ({ kind: "run-state" as const, path: resolve(rootIdentity.path, ...path.split("/")), expected: "directory" as const })),
  ];
  const targets: ProgressiveInitPurgeTarget[] = [];
  for (const candidate of candidates) {
    const relativePath = relative(rootIdentity.path, candidate.path).split(sep).join("/");
    const state = await verifyProgressiveInitPurgeCandidate(rootIdentity, relativePath, candidate.expected);
    if (state !== "missing") targets.push({ kind: candidate.kind, path: candidate.path, entry: candidate.expected });
  }
  return { root: rootIdentity.path, rootIdentity, targets };
}

async function removeEmptyOwnedContainers(plan: ProgressiveInitPurgePlan): Promise<readonly string[]> {
  const emptied: string[] = [];
  for (const relativePath of OWNED_CONTAINER_RELATIVE_PATHS) {
    const path = resolve(plan.root, ...relativePath.split("/"));
    const state = await inspectProgressivePathInsideRoot(plan.rootIdentity, path, "directory", reject);
    if (state === "missing") continue;
    const removed = await rmdir(path).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOTEMPTY" || error.code === "EEXIST" || error.code === "ENOENT") return false;
      throw error;
    });
    if (removed) emptied.push(path);
  }
  return emptied;
}

export async function purgeProgressiveInitArtifacts(projectRoot: string): Promise<ProgressiveInitPurgeReport> {
  const plan = await planProgressiveInitPurge(projectRoot);
  // Revalidate the complete plan and root identity immediately before mutation.
  await assertProgressiveProjectRootIdentity(plan.rootIdentity, reject);
  for (const target of plan.targets) {
    const relativePath = relative(plan.root, target.path).split(sep).join("/");
    await verifyProgressiveInitPurgeCandidate(plan.rootIdentity, relativePath, target.entry);
    if (target.entry === "directory") await verifyProgressiveRunTree(plan.rootIdentity, relativePath);
  }

  const removedFiles: string[] = [];
  const removedDirectories: string[] = [];
  for (const target of plan.targets) {
    if (target.entry === "file") {
      await unlink(target.path);
      removedFiles.push(target.path);
    } else {
      await rm(target.path, { recursive: true, force: false });
      removedDirectories.push(target.path);
    }
  }
  return {
    root: plan.root,
    removedFiles,
    removedDirectories,
    emptiedContainers: await removeEmptyOwnedContainers(plan),
  };
}
