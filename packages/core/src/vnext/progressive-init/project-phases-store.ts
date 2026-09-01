import { parseProjectPhasesDocument, type ParsedProjectPhasesDocument } from "./project-phases-document.js";
import type { ProjectPhasesUpstreamProjection } from "./project-phases-ir.js";
import {
  loadStrictStageDocument,
  strictStageDocumentPath,
  writeStrictStageDocumentAtomically,
  type StrictStageDocumentDefinition,
} from "./stage-document-store.js";

function definition(upstream: ProjectPhasesUpstreamProjection): StrictStageDocumentDefinition<ParsedProjectPhasesDocument> {
  return {
    fileName: "project-phases.md",
    temporaryPrefix: "project-phases",
    concurrentModificationCode: "PROJECT_PHASES_CONCURRENT_MODIFICATION",
    parse: (source) => parseProjectPhasesDocument(source, upstream),
  };
}

export interface LoadedProjectPhases {
  readonly path: string;
  readonly source: string;
  readonly sourceSha256: string;
  readonly document: ParsedProjectPhasesDocument;
}

export function projectPhasesPath(root: string, upstream: ProjectPhasesUpstreamProjection): string {
  return strictStageDocumentPath(root, definition(upstream));
}

export async function loadProjectPhases(root: string, upstream: ProjectPhasesUpstreamProjection): Promise<LoadedProjectPhases | undefined> {
  return loadStrictStageDocument(root, definition(upstream));
}

export async function writeProjectPhasesAtomically(
  root: string,
  upstream: ProjectPhasesUpstreamProjection,
  source: string,
  expectedSha256: string | undefined,
): Promise<string> {
  return writeStrictStageDocumentAtomically(root, definition(upstream), source, expectedSha256);
}
