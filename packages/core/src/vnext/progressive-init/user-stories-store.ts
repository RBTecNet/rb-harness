import {
  parseUserStoriesDocument,
  type ParsedUserStoriesDocument,
} from "./user-stories-document.js";
import type { UserStoriesUpstreamProjection } from "./user-stories-ir.js";
import {
  loadStrictStageDocument,
  strictStageDocumentPath,
  writeStrictStageDocumentAtomically,
  type StrictStageDocumentDefinition,
} from "./stage-document-store.js";

function definition(upstream: UserStoriesUpstreamProjection): StrictStageDocumentDefinition<ParsedUserStoriesDocument> {
  return {
    fileName: "user-stories.md",
    temporaryPrefix: "user-stories",
    concurrentModificationCode: "USER_STORIES_CONCURRENT_MODIFICATION",
    // A newly approved workflow makes the source stale, not structurally unsafe.
    // Existing story references still receive full actor/workflow validation.
    parse: (source) => parseUserStoriesDocument(source, upstream, { allowUncoveredWorkflows: true }),
  };
}

export interface LoadedUserStories {
  readonly path: string;
  readonly source: string;
  readonly sourceSha256: string;
  readonly document: ParsedUserStoriesDocument;
}

export function userStoriesPath(root: string, upstream: UserStoriesUpstreamProjection): string {
  return strictStageDocumentPath(root, definition(upstream));
}

export async function loadUserStories(
  root: string,
  upstream: UserStoriesUpstreamProjection,
): Promise<LoadedUserStories | undefined> {
  return loadStrictStageDocument(root, definition(upstream));
}

export async function writeUserStoriesAtomically(
  root: string,
  upstream: UserStoriesUpstreamProjection,
  source: string,
  expectedSha256: string | undefined,
): Promise<string> {
  return writeStrictStageDocumentAtomically(root, definition(upstream), source, expectedSha256);
}
