import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { sha256Text } from "../../hash.js";
import { parseProjectDescriptionDocument, type ParsedProjectDescriptionDocument } from "./project-description-document.js";

export const projectDescriptionPath = (root: string): string => resolve(root, ".spec", "init", "project-description.md");
export const projectDescriptionStageRecordPath = (root: string): string => resolve(root, ".rb-harness", "progressive-init", "project-description.json");

export interface LoadedProjectDescription {
  readonly path: string;
  readonly source: string;
  readonly sourceSha256: string;
  readonly document: ParsedProjectDescriptionDocument;
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

export async function loadProjectDescription(root: string): Promise<LoadedProjectDescription | undefined> {
  const path = projectDescriptionPath(root);
  if (await safeRegularFile(path) === "missing") return undefined;
  const source = await readFile(path, "utf8");
  return { path, source, sourceSha256: sha256Text(source), document: parseProjectDescriptionDocument(source) };
}

async function assertUnchanged(path: string, expectedSha256: string | undefined): Promise<void> {
  const state = await safeRegularFile(path);
  if (state === "missing") {
    if (expectedSha256 !== undefined) throw new Error("PROJECT_DESCRIPTION_CONCURRENT_MODIFICATION: stage file was removed after load");
    return;
  }
  const current = sha256Text(await readFile(path, "utf8"));
  if (expectedSha256 === undefined || current !== expectedSha256) throw new Error("PROJECT_DESCRIPTION_CONCURRENT_MODIFICATION: developer source changed after load");
}

export async function writeProjectDescriptionAtomically(root: string, source: string, expectedSha256: string | undefined): Promise<string> {
  const path = projectDescriptionPath(root);
  const spec = resolve(root, ".spec");
  const init = dirname(path);
  await safeDirectory(spec);
  await safeDirectory(init);
  await assertUnchanged(path, expectedSha256);
  await mkdir(init, { recursive: true });
  await safeDirectory(spec);
  await safeDirectory(init);
  await assertUnchanged(path, expectedSha256);
  const temporary = resolve(init, `.project-description.${randomUUID()}.tmp`);
  await writeFile(temporary, source, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await assertUnchanged(path, expectedSha256);
    await rename(temporary, path);
  } catch (error) {
    await import("node:fs/promises").then(({ unlink }) => unlink(temporary).catch(() => undefined));
    throw error;
  }
  return path;
}

export interface ProjectDescriptionStageRecord {
  readonly contract: "rb-progressive-init-stage-record/v1";
  readonly stage: "project-description";
  readonly completion: "complete";
  readonly semanticSha256: string;
  readonly authoritativeInputSha256: string;
}

/** Audit/status cache only. Stage authority is always reparsed from .spec/init. */
export async function writeProjectDescriptionStageRecord(root: string, record: ProjectDescriptionStageRecord): Promise<string> {
  const path = projectDescriptionStageRecordPath(root);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  return path;
}
