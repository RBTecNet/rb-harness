import { semanticKey, type SemanticKey } from "../identity.js";
import {
  DATABASE_SCHEMA_CONTRACT,
  DATABASE_SCHEMA_LOGICAL_TYPES,
  canonicalizeDatabaseSchema,
  databaseSchemaSemanticSha256,
  validateDatabaseSchema,
  type DatabaseSchema,
  type DatabaseSchemaAuthority,
  type DatabaseSchemaDetermination,
  type DatabaseSchemaDisposition,
  type DatabaseSchemaField,
  type DatabaseSchemaFinding,
  type DatabaseSchemaForeignKey,
  type DatabaseSchemaLogicalType,
  type DatabaseSchemaStoryCoverage,
  type DatabaseSchemaStoryPersistence,
  type DatabaseSchemaTable,
  type DatabaseSchemaUpstreamProjection,
  type DatabaseSchemaUniqueConstraint,
  type StoryPersistenceDisposition,
} from "./database-schema-ir.js";

const SHA256 = /^[a-f0-9]{64}$/;

export interface DatabaseSchemaDocumentMetadata {
  readonly stage: "database-schema";
  readonly contract: typeof DATABASE_SCHEMA_CONTRACT;
  readonly completion: "complete";
  readonly upstreamProjectionSha256: string;
  readonly authoritativeInputSha256: string;
  readonly baselineSemanticSha256: string;
}

export interface ParsedDatabaseSchemaDocument {
  readonly metadata: DatabaseSchemaDocumentMetadata;
  readonly value: DatabaseSchema;
  readonly semanticSha256: string;
  readonly developerModified: boolean;
  readonly upstreamCompatibilityFindings: readonly DatabaseSchemaFinding[];
}

export class DatabaseSchemaDocumentError extends Error {
  constructor(message: string) {
    super(`DATABASE_SCHEMA_DOCUMENT_INVALID: ${message}`);
    this.name = "DatabaseSchemaDocumentError";
  }
}

function expectRecord(value: unknown, pointer: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DatabaseSchemaDocumentError(`${pointer}: expected object`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, fields: readonly string[], pointer: string): void {
  const allowed = new Set(fields);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new DatabaseSchemaDocumentError(`${pointer}/${key}: unknown field`);
  for (const key of fields) if (!(key in value)) throw new DatabaseSchemaDocumentError(`${pointer}/${key}: required field is missing`);
}

function expectArray(value: unknown, pointer: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new DatabaseSchemaDocumentError(`${pointer}: expected array`);
  return value;
}

function expectString(value: unknown, pointer: string): string {
  if (typeof value !== "string") throw new DatabaseSchemaDocumentError(`${pointer}: expected string`);
  return value;
}

function expectBoolean(value: unknown, pointer: string): boolean {
  if (typeof value !== "boolean") throw new DatabaseSchemaDocumentError(`${pointer}: expected boolean`);
  return value;
}

function expectSha256(value: unknown, pointer: string): string {
  const raw = expectString(value, pointer);
  if (!SHA256.test(raw)) throw new DatabaseSchemaDocumentError(`${pointer}: expected lowercase SHA-256`);
  return raw;
}

function expectKey(value: unknown, pointer: string): SemanticKey {
  const raw = expectString(value, pointer);
  const key = semanticKey(raw);
  if (!key) throw new DatabaseSchemaDocumentError(`${pointer}: invalid SemanticKey '${raw}'`);
  return key;
}

function expectDisposition(value: unknown, pointer: string): StoryPersistenceDisposition {
  if (value !== "persisted" && value !== "not-persisted") throw new DatabaseSchemaDocumentError(`${pointer}: expected persisted or not-persisted`);
  return value;
}

function expectSchemaDisposition(value: unknown, pointer: string): DatabaseSchemaDisposition {
  if (value !== "applicable" && value !== "not-applicable") throw new DatabaseSchemaDocumentError(`${pointer}: expected applicable or not-applicable`);
  return value;
}

function developerAuthority(value: unknown, pointer: string): DatabaseSchemaAuthority {
  const source = expectRecord(value, pointer);
  exact(source, ["kind"], pointer);
  if (source.kind !== "developer") throw new DatabaseSchemaDocumentError(`${pointer}: persisted authority must be developer`);
  return { kind: "developer" };
}

function decodeDetermination(value: unknown, index: number): DatabaseSchemaDetermination {
  const pointer = `/determinations/${index}`;
  const entry = expectRecord(value, pointer);
  exact(entry, ["key", "statement", "rationale", "materiality", "rigidity", "source"], pointer);
  if (entry.materiality !== "architecture") throw new DatabaseSchemaDocumentError(`${pointer}/materiality: expected architecture`);
  if (entry.rigidity !== "RIGID") throw new DatabaseSchemaDocumentError(`${pointer}/rigidity: expected RIGID`);
  return {
    key: expectKey(entry.key, `${pointer}/key`),
    statement: expectString(entry.statement, `${pointer}/statement`),
    rationale: expectString(entry.rationale, `${pointer}/rationale`),
    materiality: "architecture",
    rigidity: "RIGID",
    source: developerAuthority(entry.source, `${pointer}/source`),
  };
}

function decodeDecision(value: unknown, index: number): DatabaseSchemaStoryPersistence {
  const pointer = `/structuralDecisions/${index}`;
  const entry = expectRecord(value, pointer);
  exact(entry, ["kind", "key", "storyKey", "decisionInputSha256", "disposition", "source"], pointer);
  if (entry.kind !== "story-persistence") throw new DatabaseSchemaDocumentError(`${pointer}/kind: expected story-persistence`);
  return {
    kind: "story-persistence",
    key: expectKey(entry.key, `${pointer}/key`),
    storyKey: expectKey(entry.storyKey, `${pointer}/storyKey`),
    decisionInputSha256: expectSha256(entry.decisionInputSha256, `${pointer}/decisionInputSha256`),
    disposition: expectDisposition(entry.disposition, `${pointer}/disposition`),
    source: developerAuthority(entry.source, `${pointer}/source`),
  };
}

function decodeCoverage(value: unknown, index: number): DatabaseSchemaStoryCoverage {
  const pointer = `/storyCoverage/${index}`;
  const entry = expectRecord(value, pointer);
  exact(entry, ["storyKey", "disposition", "tableKeys"], pointer);
  return {
    storyKey: expectKey(entry.storyKey, `${pointer}/storyKey`),
    disposition: expectDisposition(entry.disposition, `${pointer}/disposition`),
    tableKeys: expectArray(entry.tableKeys, `${pointer}/tableKeys`).map((item, itemIndex) => expectKey(item, `${pointer}/tableKeys/${itemIndex}`)),
  };
}

function decodeField(value: unknown, tableIndex: number, fieldIndex: number): DatabaseSchemaField {
  const pointer = `/tables/${tableIndex}/fields/${fieldIndex}`;
  const entry = expectRecord(value, pointer);
  exact(entry, ["key", "name", "logicalType", "required"], pointer);
  const logicalType = expectString(entry.logicalType, `${pointer}/logicalType`);
  if (!(DATABASE_SCHEMA_LOGICAL_TYPES as readonly string[]).includes(logicalType)) {
    throw new DatabaseSchemaDocumentError(`${pointer}/logicalType: unsupported logical type '${logicalType}'`);
  }
  return {
    key: expectKey(entry.key, `${pointer}/key`),
    name: expectString(entry.name, `${pointer}/name`),
    logicalType: logicalType as DatabaseSchemaLogicalType,
    required: expectBoolean(entry.required, `${pointer}/required`),
  };
}

function decodeUniqueConstraint(value: unknown, tableIndex: number, constraintIndex: number): DatabaseSchemaUniqueConstraint {
  const pointer = `/tables/${tableIndex}/uniqueConstraints/${constraintIndex}`;
  const entry = expectRecord(value, pointer);
  exact(entry, ["fieldKeys"], pointer);
  return { fieldKeys: expectArray(entry.fieldKeys, `${pointer}/fieldKeys`).map((item, itemIndex) => expectKey(item, `${pointer}/fieldKeys/${itemIndex}`)) };
}

function decodeTable(value: unknown, index: number): DatabaseSchemaTable {
  const pointer = `/tables/${index}`;
  const entry = expectRecord(value, pointer);
  exact(entry, ["key", "name", "purpose", "fields", "primaryKeyFieldKeys", "uniqueConstraints"], pointer);
  return {
    key: expectKey(entry.key, `${pointer}/key`),
    name: expectString(entry.name, `${pointer}/name`),
    purpose: expectString(entry.purpose, `${pointer}/purpose`),
    fields: expectArray(entry.fields, `${pointer}/fields`).map((item, fieldIndex) => decodeField(item, index, fieldIndex)),
    primaryKeyFieldKeys: expectArray(entry.primaryKeyFieldKeys, `${pointer}/primaryKeyFieldKeys`).map((item, itemIndex) => expectKey(item, `${pointer}/primaryKeyFieldKeys/${itemIndex}`)),
    uniqueConstraints: expectArray(entry.uniqueConstraints, `${pointer}/uniqueConstraints`).map((item, constraintIndex) => decodeUniqueConstraint(item, index, constraintIndex)),
  };
}

function decodeForeignKey(value: unknown, index: number): DatabaseSchemaForeignKey {
  const pointer = `/foreignKeys/${index}`;
  const entry = expectRecord(value, pointer);
  exact(entry, ["fromTableKey", "fromFieldKey", "toTableKey", "toFieldKey"], pointer);
  return {
    fromTableKey: expectKey(entry.fromTableKey, `${pointer}/fromTableKey`),
    fromFieldKey: expectKey(entry.fromFieldKey, `${pointer}/fromFieldKey`),
    toTableKey: expectKey(entry.toTableKey, `${pointer}/toTableKey`),
    toFieldKey: expectKey(entry.toFieldKey, `${pointer}/toFieldKey`),
  };
}

function decodeDatabaseSchemaValue(value: unknown): DatabaseSchema {
  const root = expectRecord(value, "/");
  exact(root, ["contract", "stage", "projectKey", "determinations", "structuralDecisions", "disposition", "storyCoverage", "tables", "foreignKeys"], "/");
  if (root.contract !== DATABASE_SCHEMA_CONTRACT) throw new DatabaseSchemaDocumentError(`/contract: expected ${DATABASE_SCHEMA_CONTRACT}`);
  if (root.stage !== "database-schema") throw new DatabaseSchemaDocumentError("/stage: expected database-schema");
  return {
    contract: DATABASE_SCHEMA_CONTRACT,
    stage: "database-schema",
    projectKey: expectKey(root.projectKey, "/projectKey"),
    determinations: expectArray(root.determinations, "/determinations").map(decodeDetermination),
    structuralDecisions: expectArray(root.structuralDecisions, "/structuralDecisions").map(decodeDecision),
    disposition: expectSchemaDisposition(root.disposition, "/disposition"),
    storyCoverage: expectArray(root.storyCoverage, "/storyCoverage").map(decodeCoverage),
    tables: expectArray(root.tables, "/tables").map(decodeTable),
    foreignKeys: expectArray(root.foreignKeys, "/foreignKeys").map(decodeForeignKey),
  };
}

function metadataComment(lines: readonly string[], index: number, name: string): string {
  const match = new RegExp(`^<!-- ${name}: (.+) -->$`).exec(lines[index] ?? "");
  if (!match?.[1]) throw new DatabaseSchemaDocumentError(`missing ${name} metadata`);
  return match[1];
}

function hashMetadata(lines: readonly string[], index: number, name: string): string {
  const value = metadataComment(lines, index, name);
  if (!SHA256.test(value)) throw new DatabaseSchemaDocumentError(`${name} must be lowercase SHA-256`);
  return value;
}

export function renderDatabaseSchemaDocument(
  input: DatabaseSchema,
  upstream: DatabaseSchemaUpstreamProjection,
  metadata: Pick<DatabaseSchemaDocumentMetadata, "upstreamProjectionSha256" | "authoritativeInputSha256">,
): string {
  const validated = validateDatabaseSchema(input, upstream);
  if (!validated.ok) throw new DatabaseSchemaDocumentError(validated.findings.map((entry) => `${entry.pointer}: ${entry.message}`).join("; "));
  const value = canonicalizeDatabaseSchema(validated.value);
  const semanticSha256 = databaseSchemaSemanticSha256(value);
  return [
    "<!-- rb-progressive-init-stage: database-schema -->",
    `<!-- rb-database-schema-contract: ${DATABASE_SCHEMA_CONTRACT} -->`,
    "<!-- rb-database-schema-completion: complete -->",
    `<!-- rb-database-schema-upstream-projection-sha256: ${metadata.upstreamProjectionSha256} -->`,
    `<!-- rb-database-schema-authoritative-input-sha256: ${metadata.authoritativeInputSha256} -->`,
    `<!-- rb-database-schema-baseline-semantic-sha256: ${semanticSha256} -->`,
    "",
    "# Database Schema",
    "",
    "```json",
    JSON.stringify(value, null, 2),
    "```",
    "",
  ].join("\n");
}

export function renderDatabaseSchemaProposal(input: DatabaseSchema): string {
  const value = canonicalizeDatabaseSchema(input);
  const approvalView = {
    disposition: value.disposition,
    storyCoverage: value.storyCoverage,
    tables: value.tables,
    foreignKeys: value.foreignKeys,
  };
  return ["Database schema proposal", "", "```json", JSON.stringify(approvalView, null, 2), "```", ""].join("\n");
}

export function parseDatabaseSchemaDocument(
  source: string,
  upstream: DatabaseSchemaUpstreamProjection,
): ParsedDatabaseSchemaDocument {
  if (!source.endsWith("\n")) throw new DatabaseSchemaDocumentError("document must end with a newline");
  if (source.includes("\r")) throw new DatabaseSchemaDocumentError("bare carriage returns are not allowed");
  const lines = source.slice(0, -1).split("\n");
  if (metadataComment(lines, 0, "rb-progressive-init-stage") !== "database-schema") throw new DatabaseSchemaDocumentError("stage metadata must be database-schema");
  if (metadataComment(lines, 1, "rb-database-schema-contract") !== DATABASE_SCHEMA_CONTRACT) throw new DatabaseSchemaDocumentError(`contract must be ${DATABASE_SCHEMA_CONTRACT}`);
  if (metadataComment(lines, 2, "rb-database-schema-completion") !== "complete") throw new DatabaseSchemaDocumentError("completion metadata must be complete");
  const upstreamProjectionSha256 = hashMetadata(lines, 3, "rb-database-schema-upstream-projection-sha256");
  const authoritativeInputSha256 = hashMetadata(lines, 4, "rb-database-schema-authoritative-input-sha256");
  const baselineSemanticSha256 = hashMetadata(lines, 5, "rb-database-schema-baseline-semantic-sha256");
  if (lines[6] !== "" || lines[7] !== "# Database Schema" || lines[8] !== "" || lines[9] !== "```json") {
    throw new DatabaseSchemaDocumentError("invalid strict document heading or JSON boundary");
  }
  const closing = lines.lastIndexOf("```");
  if (closing <= 9 || closing !== lines.length - 1) throw new DatabaseSchemaDocumentError("invalid closing JSON boundary");
  let decodedJson: unknown;
  try {
    decodedJson = JSON.parse(lines.slice(10, closing).join("\n"));
  } catch (error) {
    throw new DatabaseSchemaDocumentError(`invalid JSON body: ${error instanceof Error ? error.message : String(error)}`);
  }
  const decoded = decodeDatabaseSchemaValue(decodedJson);
  const validated = validateDatabaseSchema(decoded, upstream, [], {
    allowMissingUpstreamStories: true,
    allowStaleDecisionInputs: true,
  });
  const findings = validated.ok ? [] : validated.findings;
  const upstreamCompatibilityFindings = findings.filter((entry) => entry.code === "upstream");
  const intrinsicFindings = findings.filter((entry) => entry.code !== "upstream");
  if (intrinsicFindings.length) throw new DatabaseSchemaDocumentError(intrinsicFindings.map((entry) => `${entry.pointer}: ${entry.message}`).join("; "));
  const value = canonicalizeDatabaseSchema(decoded);
  const semanticSha256 = databaseSchemaSemanticSha256(value);
  return {
    metadata: {
      stage: "database-schema",
      contract: DATABASE_SCHEMA_CONTRACT,
      completion: "complete",
      upstreamProjectionSha256,
      authoritativeInputSha256,
      baselineSemanticSha256,
    },
    value,
    semanticSha256,
    developerModified: semanticSha256 !== baselineSemanticSha256,
    upstreamCompatibilityFindings,
  };
}
