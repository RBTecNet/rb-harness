import { parseDatabaseSchemaDocument, type ParsedDatabaseSchemaDocument } from "./database-schema-document.js";
import type { DatabaseSchemaUpstreamProjection } from "./database-schema-ir.js";
import {
  loadStrictStageDocument,
  strictStageDocumentPath,
  writeStrictStageDocumentAtomically,
  type StrictStageDocumentDefinition,
} from "./stage-document-store.js";

function definition(upstream: DatabaseSchemaUpstreamProjection): StrictStageDocumentDefinition<ParsedDatabaseSchemaDocument> {
  return {
    fileName: "database-schema.md",
    temporaryPrefix: "database-schema",
    concurrentModificationCode: "DATABASE_SCHEMA_CONCURRENT_MODIFICATION",
    parse: (source) => parseDatabaseSchemaDocument(source, upstream),
  };
}

export interface LoadedDatabaseSchema {
  readonly path: string;
  readonly source: string;
  readonly sourceSha256: string;
  readonly document: ParsedDatabaseSchemaDocument;
}

export function databaseSchemaPath(root: string, upstream: DatabaseSchemaUpstreamProjection): string {
  return strictStageDocumentPath(root, definition(upstream));
}

export async function loadDatabaseSchema(
  root: string,
  upstream: DatabaseSchemaUpstreamProjection,
): Promise<LoadedDatabaseSchema | undefined> {
  return loadStrictStageDocument(root, definition(upstream));
}

export async function writeDatabaseSchemaAtomically(
  root: string,
  upstream: DatabaseSchemaUpstreamProjection,
  source: string,
  expectedSha256: string | undefined,
): Promise<string> {
  return writeStrictStageDocumentAtomically(root, definition(upstream), source, expectedSha256);
}
