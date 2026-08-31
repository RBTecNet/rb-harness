import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parseProjectDescriptionDocument, type ParsedProjectDescriptionDocument } from "./project-description-document.js";
import {
  loadStrictStageDocument,
  strictStageDocumentPath,
  writeStrictStageDocumentAtomically,
} from "./stage-document-store.js";

const PROJECT_DESCRIPTION_DOCUMENT = {
  fileName: "project-description.md",
  temporaryPrefix: "project-description",
  concurrentModificationCode: "PROJECT_DESCRIPTION_CONCURRENT_MODIFICATION",
  parse: parseProjectDescriptionDocument,
} as const;

export const projectDescriptionPath = (root: string): string => strictStageDocumentPath(root, PROJECT_DESCRIPTION_DOCUMENT);
export const projectDescriptionStageRecordPath = (root: string): string => resolve(root, ".rb-harness", "progressive-init", "project-description.json");

export interface LoadedProjectDescription {
  readonly path: string;
  readonly source: string;
  readonly sourceSha256: string;
  readonly document: ParsedProjectDescriptionDocument;
}

export async function loadProjectDescription(root: string): Promise<LoadedProjectDescription | undefined> {
  return loadStrictStageDocument(root, PROJECT_DESCRIPTION_DOCUMENT);
}

export async function writeProjectDescriptionAtomically(root: string, source: string, expectedSha256: string | undefined): Promise<string> {
  return writeStrictStageDocumentAtomically(root, PROJECT_DESCRIPTION_DOCUMENT, source, expectedSha256);
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
