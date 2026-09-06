import { dirname, join } from "node:path";
import type { Stats } from "node:fs";
import type { RalphRuntimeFileSystem } from "../event-store.js";
import type { RalphEventStoreV2 } from "../operational-b1/index.js";
import { canonicalJson } from "../canonical-json.js";

export const B4_ARTIFACT_ERROR_CODES = [
  "B4_ARTIFACT_PATH_UNSAFE",
  "B4_ARTIFACT_INVALID",
  "B4_ARTIFACT_IMMUTABLE_CONFLICT",
  "B4_ARTIFACT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION",
  "B4_ARTIFACT_PERSISTENCE_FAILED",
] as const;
export type B4ArtifactErrorCode = typeof B4_ARTIFACT_ERROR_CODES[number];

export class RalphB4ArtifactError extends Error {
  constructor(readonly code: B4ArtifactErrorCode, message: string = code, readonly cause?: unknown) {
    super(message);
    this.name = "RalphB4ArtifactError";
  }
}

export interface ArtifactPersistenceResultV2<T> {
  readonly artifact: T;
  readonly publishDisposition: "PUBLISHED_BY_THIS_CALL" | "ALREADY_PRESENT";
  readonly artifactDurability: "DURABLE";
}

export function attemptArtifactRefV2(attemptId: string, fileName: string): string {
  assertArtifactSegment(attemptId);
  assertArtifactSegment(fileName);
  return `attempts/${attemptId}/${fileName}`;
}

export function attemptArtifactPathV2(store: RalphEventStoreV2, attemptId: string, fileName: string): string {
  return join(store.runDirectory, attemptArtifactRefV2(attemptId, fileName));
}

export async function ensureAttemptArtifactDirectoryV2(store: RalphEventStoreV2, attemptId: string): Promise<string> {
  assertArtifactSegment(attemptId);
  await store.ensureLayout();
  const attemptsDirectory = join(store.runDirectory, "attempts");
  await ensureDirectory(store.fileSystem, attemptsDirectory);
  const attemptDirectory = join(attemptsDirectory, attemptId);
  await ensureDirectory(store.fileSystem, attemptDirectory);
  return attemptDirectory;
}

export async function readImmutableJsonArtifactV2<T>(input: {
  readonly store: RalphEventStoreV2;
  readonly ref: string;
  readonly validate: (value: unknown) => asserts value is T;
}): Promise<T | undefined> {
  const path = resolveArtifactRef(input.store, input.ref);
  await assertArtifactDirectoryChain(input.store, attemptFromRef(input.ref));
  let stats: Stats;
  try { stats = await input.store.fileSystem.lstat(path); }
  catch (error) {
    if (isMissing(error)) return undefined;
    throw new RalphB4ArtifactError("B4_ARTIFACT_PATH_UNSAFE", "B4_ARTIFACT_PATH_UNSAFE: artifact cannot be inspected", error);
  }
  assertSafeFile(stats, path);
  let bytes: Buffer;
  try { bytes = await input.store.fileSystem.readFile(path); }
  catch (error) { throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_ARTIFACT_INVALID: artifact disappeared", error); }
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch (error) { throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_ARTIFACT_INVALID: artifact JSON is malformed", error); }
  try { input.validate(parsed); }
  catch (error) { throw error instanceof RalphB4ArtifactError ? error : new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_ARTIFACT_INVALID: artifact schema is invalid", error); }
  if (bytes.toString("utf8") !== canonicalJson(parsed)) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_ARTIFACT_INVALID: artifact is not canonical");
  return parsed;
}

export async function persistImmutableJsonArtifactV2<T>(input: {
  readonly store: RalphEventStoreV2;
  readonly ref: string;
  readonly artifact: T;
  readonly validate: (value: unknown) => asserts value is T;
  readonly nonce: string;
}): Promise<ArtifactPersistenceResultV2<T>> {
  input.validate(input.artifact);
  const path = resolveArtifactRef(input.store, input.ref);
  const directory = dirname(path);
  await ensureAttemptArtifactDirectoryV2(input.store, attemptFromRef(input.ref));
  const bytes = Buffer.from(canonicalJson(input.artifact), "utf8");
  const temporary = `${path}.tmp-${safeNonce(input.nonce)}`;
  try {
    await input.store.fileSystem.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await input.store.fileSystem.fsyncFile(temporary);
  } catch (error) {
    throw new RalphB4ArtifactError("B4_ARTIFACT_PERSISTENCE_FAILED", "B4_ARTIFACT_PERSISTENCE_FAILED: artifact staging failed", error);
  }
  try {
    await input.store.fileSystem.link(temporary, path);
  } catch (error) {
    if (!isExisting(error)) throw new RalphB4ArtifactError("B4_ARTIFACT_PERSISTENCE_FAILED", "B4_ARTIFACT_PERSISTENCE_FAILED: artifact publication failed", error);
    const existing = await readExistingBytes(input.store.fileSystem, path);
    await unlinkBestEffort(input.store.fileSystem, temporary);
    if (!existing.equals(bytes)) throw new RalphB4ArtifactError("B4_ARTIFACT_IMMUTABLE_CONFLICT", "B4_ARTIFACT_IMMUTABLE_CONFLICT: immutable artifact bytes differ");
    return { artifact: input.artifact, publishDisposition: "ALREADY_PRESENT", artifactDurability: "DURABLE" };
  }
  try {
    await input.store.fileSystem.fsyncDirectory(directory);
  } catch (error) {
    throw new RalphB4ArtifactError("B4_ARTIFACT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION", "B4_ARTIFACT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION", error);
  }
  try {
    await input.store.fileSystem.unlink(temporary);
    await input.store.fileSystem.fsyncDirectory(directory);
  } catch (error) {
    throw new RalphB4ArtifactError("B4_ARTIFACT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION", "B4_ARTIFACT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION", error);
  }
  return { artifact: input.artifact, publishDisposition: "PUBLISHED_BY_THIS_CALL", artifactDurability: "DURABLE" };
}

async function assertArtifactDirectoryChain(store: RalphEventStoreV2, attemptId: string): Promise<void> {
  const attemptsDirectory = join(store.runDirectory, "attempts");
  const attemptDirectory = join(attemptsDirectory, attemptId);
  for (const path of [attemptsDirectory, attemptDirectory]) {
    let stats: Stats;
    try { stats = await store.fileSystem.lstat(path); }
    catch (error) { throw new RalphB4ArtifactError("B4_ARTIFACT_PATH_UNSAFE", "B4_ARTIFACT_PATH_UNSAFE: artifact directory cannot be inspected", error); }
    if (stats.isSymbolicLink() || !stats.isDirectory() || modeOf(stats) !== 0o700) {
      throw new RalphB4ArtifactError("B4_ARTIFACT_PATH_UNSAFE", `B4_ARTIFACT_PATH_UNSAFE: ${path}`);
    }
  }
}

export function assertSafeArtifactRefV2(ref: string): void {
  resolveArtifactRefPath(ref);
}

function resolveArtifactRef(store: RalphEventStoreV2, ref: string): string {
  resolveArtifactRefPath(ref);
  return join(store.runDirectory, ref);
}

function resolveArtifactRefPath(ref: string): void {
  if (!/^attempts\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(ref)) {
    throw new RalphB4ArtifactError("B4_ARTIFACT_PATH_UNSAFE", "B4_ARTIFACT_PATH_UNSAFE: artifact reference is outside the Attempt boundary");
  }
}

function attemptFromRef(ref: string): string {
  resolveArtifactRefPath(ref);
  const attemptId = ref.split("/")[1];
  if (!attemptId) throw new RalphB4ArtifactError("B4_ARTIFACT_PATH_UNSAFE");
  return attemptId;
}

async function readExistingBytes(fileSystem: RalphRuntimeFileSystem, path: string): Promise<Buffer> {
  let stats: Stats;
  try { stats = await fileSystem.lstat(path); }
  catch (error) { throw new RalphB4ArtifactError("B4_ARTIFACT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION", "B4_ARTIFACT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION: target disappeared", error); }
  assertSafeFile(stats, path);
  try { return await fileSystem.readFile(path); }
  catch (error) { throw new RalphB4ArtifactError("B4_ARTIFACT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION", "B4_ARTIFACT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION: target is unreadable", error); }
}

async function ensureDirectory(fileSystem: RalphRuntimeFileSystem, path: string): Promise<void> {
  let stats: Stats | undefined;
  try { stats = await fileSystem.lstat(path); }
  catch (error) {
    if (!isMissing(error)) throw new RalphB4ArtifactError("B4_ARTIFACT_PATH_UNSAFE", "B4_ARTIFACT_PATH_UNSAFE: artifact directory cannot be inspected", error);
    try { await fileSystem.mkdir(path, { recursive: false, mode: 0o700 }); }
    catch (mkdirError) {
      if (!isExisting(mkdirError)) throw new RalphB4ArtifactError("B4_ARTIFACT_PATH_UNSAFE", "B4_ARTIFACT_PATH_UNSAFE: artifact directory cannot be created", mkdirError);
    }
    try { stats = await fileSystem.lstat(path); }
    catch (lstatError) { throw new RalphB4ArtifactError("B4_ARTIFACT_PATH_UNSAFE", "B4_ARTIFACT_PATH_UNSAFE: artifact directory race", lstatError); }
  }
  if (!stats || stats.isSymbolicLink() || !stats.isDirectory() || modeOf(stats) !== 0o700) throw new RalphB4ArtifactError("B4_ARTIFACT_PATH_UNSAFE", `B4_ARTIFACT_PATH_UNSAFE: ${path}`);
}

function assertSafeFile(stats: Stats, path: string): void {
  if (stats.isSymbolicLink() || !stats.isFile() || modeOf(stats) !== 0o600) throw new RalphB4ArtifactError("B4_ARTIFACT_PATH_UNSAFE", `B4_ARTIFACT_PATH_UNSAFE: ${path}`);
}

function assertArtifactSegment(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new RalphB4ArtifactError("B4_ARTIFACT_PATH_UNSAFE");
}

function modeOf(stats: Stats): number { return stats.mode & 0o7777; }
function safeNonce(value: string): string { return /^[A-Za-z0-9._-]+$/.test(value) ? value : "nonce"; }

async function unlinkBestEffort(fileSystem: RalphRuntimeFileSystem, path: string): Promise<void> {
  try { await fileSystem.unlink(path); } catch { /* immutable target remains authoritative */ }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { readonly code?: unknown }).code === "ENOENT");
}

function isExisting(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { readonly code?: unknown }).code === "EEXIST");
}
