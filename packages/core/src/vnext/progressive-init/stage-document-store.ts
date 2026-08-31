import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256Text } from "../../hash.js";

export interface StrictStageDocumentDefinition<T> {
  readonly fileName: string;
  readonly temporaryPrefix: string;
  readonly concurrentModificationCode: string;
  readonly parse: (source: string) => T;
}

export interface LoadedStrictStageDocument<T> {
  readonly path: string;
  readonly source: string;
  readonly sourceSha256: string;
  readonly document: T;
}

function stageDocumentPath(root: string, definition: StrictStageDocumentDefinition<unknown>): string {
  if (!/^[a-z0-9-]+\.md$/.test(definition.fileName)) {
    throw new Error(`INVALID_PROGRESSIVE_INIT_STAGE_FILE: ${definition.fileName}`);
  }
  return resolve(root, ".spec", "init", definition.fileName);
}

async function safeRegularFile(path: string): Promise<"missing" | "file"> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (!info) return "missing";
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`UNSAFE_PROGRESSIVE_INIT_PATH: ${path} must be a regular file`);
  return "file";
}

async function safeDirectory(path: string): Promise<void> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new Error(`UNSAFE_PROGRESSIVE_INIT_PATH: ${path} must be a regular directory`);
}

async function assertUnchanged(
  path: string,
  expectedSha256: string | undefined,
  concurrentModificationCode: string,
): Promise<void> {
  const state = await safeRegularFile(path);
  if (state === "missing") {
    if (expectedSha256 !== undefined) throw new Error(`${concurrentModificationCode}: stage file was removed after load`);
    return;
  }
  const current = sha256Text(await readFile(path, "utf8"));
  if (expectedSha256 === undefined || current !== expectedSha256) {
    throw new Error(`${concurrentModificationCode}: developer source changed after load`);
  }
}

export function strictStageDocumentPath<T>(root: string, definition: StrictStageDocumentDefinition<T>): string {
  return stageDocumentPath(root, definition);
}

export async function loadStrictStageDocument<T>(
  root: string,
  definition: StrictStageDocumentDefinition<T>,
): Promise<LoadedStrictStageDocument<T> | undefined> {
  const path = stageDocumentPath(root, definition);
  if (await safeRegularFile(path) === "missing") return undefined;
  const source = await readFile(path, "utf8");
  return { path, source, sourceSha256: sha256Text(source), document: definition.parse(source) };
}

export async function writeStrictStageDocumentAtomically<T>(
  root: string,
  definition: StrictStageDocumentDefinition<T>,
  source: string,
  expectedSha256: string | undefined,
): Promise<string> {
  const path = stageDocumentPath(root, definition);
  const spec = resolve(root, ".spec");
  const init = resolve(spec, "init");
  await safeDirectory(spec);
  await safeDirectory(init);
  await assertUnchanged(path, expectedSha256, definition.concurrentModificationCode);
  await mkdir(init, { recursive: true });
  await safeDirectory(spec);
  await safeDirectory(init);
  await assertUnchanged(path, expectedSha256, definition.concurrentModificationCode);
  const temporary = resolve(init, `.${definition.temporaryPrefix}.${randomUUID()}.tmp`);
  await writeFile(temporary, source, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await assertUnchanged(path, expectedSha256, definition.concurrentModificationCode);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return path;
}
