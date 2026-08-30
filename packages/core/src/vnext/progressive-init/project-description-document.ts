import { semanticKey, type SemanticKey } from "../identity.js";
import {
  PROJECT_DESCRIPTION_CONTRACT,
  projectDescriptionForPersistence,
  projectDescriptionSemanticSha256,
  validateProjectDescription,
  type ProjectDescription,
  type ProjectDescriptionAuthority,
  type ProjectDescriptionQualityCommand,
} from "./project-description-ir.js";

const SHA256 = /^[a-f0-9]{64}$/;

export interface ProjectDescriptionDocumentMetadata {
  readonly stage: "project-description";
  readonly contract: typeof PROJECT_DESCRIPTION_CONTRACT;
  readonly completion: "complete";
  readonly originalRequestSha256: string;
  readonly discoverySha256: string;
  readonly authoritativeInputSha256: string;
  /** Hash when Harness last wrote the document; a mismatch is a valid developer edit. */
  readonly baselineSemanticSha256: string;
}

export interface ParsedProjectDescriptionDocument {
  readonly metadata: ProjectDescriptionDocumentMetadata;
  readonly value: ProjectDescription;
  readonly semanticSha256: string;
  readonly developerModified: boolean;
}

export class ProjectDescriptionDocumentError extends Error {
  constructor(message: string) {
    super(`INVALID_PROJECT_DESCRIPTION_DOCUMENT: ${message}`);
    this.name = "ProjectDescriptionDocumentError";
  }
}

function json(value: string): string {
  return JSON.stringify(value);
}

function renderItems<T extends { readonly key: SemanticKey }>(
  values: readonly T[],
  kind: string,
  fields: (value: T) => readonly string[],
): string[] {
  if (!values.length) return ["_None._", ""];
  return values.flatMap((value) => [`### ${kind} \`${value.key}\``, "", ...fields(value), ""]);
}

export function renderProjectDescriptionDocument(
  input: ProjectDescription,
  metadata: Omit<ProjectDescriptionDocumentMetadata, "stage" | "contract" | "completion" | "baselineSemanticSha256">,
): string {
  const value = projectDescriptionForPersistence(input);
  const semanticSha256 = projectDescriptionSemanticSha256(value);
  const lines = [
    "<!-- rb-progressive-init-stage: project-description -->",
    `<!-- rb-project-description-contract: ${PROJECT_DESCRIPTION_CONTRACT} -->`,
    "<!-- rb-project-description-completion: complete -->",
    `<!-- rb-project-description-original-request-sha256: ${metadata.originalRequestSha256} -->`,
    `<!-- rb-project-description-discovery-sha256: ${metadata.discoverySha256} -->`,
    `<!-- rb-project-description-authoritative-input-sha256: ${metadata.authoritativeInputSha256} -->`,
    `<!-- rb-project-description-baseline-semantic-sha256: ${semanticSha256} -->`,
    "# Project Description",
    "",
    "## Request Authority",
    "",
    `Original request: ${json(value.originalRequest)}`,
    "",
    "## Project",
    "",
    `Key: \`${value.project.key}\``,
    `Name: ${json(value.project.name)}`,
    `Objective: ${json(value.project.objective)}`,
    "",
    "## Actors",
    "",
    ...renderItems(value.actors, "Actor", (entry) => [
      `Name: ${json(entry.name)}`,
      `Responsibility: ${json(entry.responsibility)}`,
    ]),
    "## Capabilities",
    "",
    ...renderItems(value.capabilities, "Capability", (entry) => [`Statement: ${json(entry.statement)}`]),
    "## Workflows",
    "",
    ...renderItems(value.workflows, "Workflow", (entry) => [
      `Statement: ${json(entry.statement)}`,
      `Actors: ${JSON.stringify(entry.actorKeys)}`,
      `Capabilities: ${JSON.stringify(entry.capabilityKeys)}`,
    ]),
    "## Constraints",
    "",
    ...renderItems(value.constraints, "Constraint", (entry) => [`Statement: ${json(entry.statement)}`]),
    "## Determinations",
    "",
    ...renderItems(value.determinations, "Determination", (entry) => [
      `Statement: ${json(entry.statement)}`,
      `Rationale: ${json(entry.rationale)}`,
      `Materiality: ${entry.materiality}`,
      `Rigidity: ${entry.rigidity}`,
      `Source: ${JSON.stringify(entry.source)}`,
    ]),
    "## Quality Commands",
    "",
    ...renderItems(value.qualityCommands, "Quality Command", (entry) => [
      `Kind: ${entry.kind}`,
      `Command: ${json(entry.command)}`,
    ]),
  ];
  return `${lines.join("\n")}\n`;
}

class Cursor {
  index = 0;
  constructor(readonly lines: readonly string[]) {}
  peek(): string | undefined { return this.lines[this.index]; }
  take(): string {
    const value = this.lines[this.index];
    if (value === undefined) throw new ProjectDescriptionDocumentError("unexpected end of file");
    this.index += 1;
    return value;
  }
  exact(expected: string): void {
    const actual = this.take();
    if (actual !== expected) throw new ProjectDescriptionDocumentError(`expected ${JSON.stringify(expected)} at line ${this.index}, received ${JSON.stringify(actual)}`);
  }
  blank(): void { this.exact(""); }
}

function comment(cursor: Cursor, name: string): string {
  const line = cursor.take();
  const match = line.match(new RegExp(`^<!-- ${name}: (.+) -->$`));
  if (!match?.[1]) throw new ProjectDescriptionDocumentError(`invalid ${name} metadata at line ${cursor.index}`);
  return match[1];
}

function hashComment(cursor: Cursor, name: string): string {
  const value = comment(cursor, name);
  if (!SHA256.test(value)) throw new ProjectDescriptionDocumentError(`${name} must be a lowercase SHA-256`);
  return value;
}

function parseJsonString(line: string, label: string, lineNumber: number): string {
  if (!line.startsWith(`${label}: `)) throw new ProjectDescriptionDocumentError(`expected ${label} at line ${lineNumber}`);
  let value: unknown;
  try { value = JSON.parse(line.slice(label.length + 2)); }
  catch { throw new ProjectDescriptionDocumentError(`${label} must contain one valid JSON string at line ${lineNumber}`); }
  if (typeof value !== "string") throw new ProjectDescriptionDocumentError(`${label} must contain one JSON string at line ${lineNumber}`);
  return value;
}

function parseKeyLine(line: string, label: string, lineNumber: number): SemanticKey {
  const match = line.match(new RegExp("^" + label + ": `([^`]+)`$"));
  const key = match?.[1] ? semanticKey(match[1]) : undefined;
  if (!key) throw new ProjectDescriptionDocumentError(`${label} must contain one canonical SemanticKey at line ${lineNumber}`);
  return key;
}

function parseItemHeading(line: string, kind: string, lineNumber: number): SemanticKey {
  const match = line.match(new RegExp("^### " + kind + " `([^`]+)`$"));
  const key = match?.[1] ? semanticKey(match[1]) : undefined;
  if (!key) throw new ProjectDescriptionDocumentError(`invalid ${kind} heading at line ${lineNumber}`);
  return key;
}

function jsonKeys(line: string, label: string, lineNumber: number): readonly SemanticKey[] {
  if (!line.startsWith(`${label}: `)) throw new ProjectDescriptionDocumentError(`expected ${label} at line ${lineNumber}`);
  let value: unknown;
  try { value = JSON.parse(line.slice(label.length + 2)); }
  catch { throw new ProjectDescriptionDocumentError(`${label} must contain one JSON key array at line ${lineNumber}`); }
  if (!Array.isArray(value)) throw new ProjectDescriptionDocumentError(`${label} must contain one JSON key array at line ${lineNumber}`);
  return value.map((entry) => {
    const key = typeof entry === "string" ? semanticKey(entry) : undefined;
    if (!key) throw new ProjectDescriptionDocumentError(`${label} contains an invalid SemanticKey at line ${lineNumber}`);
    return key;
  });
}

function authority(line: string, lineNumber: number): ProjectDescriptionAuthority {
  if (!line.startsWith("Source: ")) throw new ProjectDescriptionDocumentError(`expected Source at line ${lineNumber}`);
  let value: unknown;
  try { value = JSON.parse(line.slice(8)); }
  catch { throw new ProjectDescriptionDocumentError(`Source must contain one JSON authority object at line ${lineNumber}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProjectDescriptionDocumentError(`Source must be an authority object at line ${lineNumber}`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || record.kind !== "developer") {
    throw new ProjectDescriptionDocumentError(`persisted Source must be developer authority at line ${lineNumber}`);
  }
  return { kind: "developer" };
}

function parseSection<T>(cursor: Cursor, section: string, kind: string, parse: (key: SemanticKey, cursor: Cursor) => T): T[] {
  cursor.exact(`## ${section}`);
  cursor.blank();
  if (cursor.peek() === "_None._") {
    cursor.take();
    cursor.blank();
    return [];
  }
  const values: T[] = [];
  while (cursor.peek()?.startsWith(`### ${kind} `)) {
    const key = parseItemHeading(cursor.take(), kind, cursor.index);
    cursor.blank();
    values.push(parse(key, cursor));
    cursor.blank();
  }
  if (!values.length) throw new ProjectDescriptionDocumentError(`${section} must contain canonical entries or _None._`);
  return values;
}

export function parseProjectDescriptionDocument(source: string): ParsedProjectDescriptionDocument {
  const normalized = source.replace(/\r\n/g, "\n");
  if (normalized.includes("\r")) throw new ProjectDescriptionDocumentError("bare carriage returns are not allowed");
  const lines = normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
  const cursor = new Cursor(lines);
  if (comment(cursor, "rb-progressive-init-stage") !== "project-description") throw new ProjectDescriptionDocumentError("stage metadata must be project-description");
  if (comment(cursor, "rb-project-description-contract") !== PROJECT_DESCRIPTION_CONTRACT) throw new ProjectDescriptionDocumentError(`contract must be ${PROJECT_DESCRIPTION_CONTRACT}`);
  if (comment(cursor, "rb-project-description-completion") !== "complete") throw new ProjectDescriptionDocumentError("completion metadata must be complete");
  const originalRequestSha256 = hashComment(cursor, "rb-project-description-original-request-sha256");
  const discoverySha256 = hashComment(cursor, "rb-project-description-discovery-sha256");
  const authoritativeInputSha256 = hashComment(cursor, "rb-project-description-authoritative-input-sha256");
  const baselineSemanticSha256 = hashComment(cursor, "rb-project-description-baseline-semantic-sha256");
  cursor.exact("# Project Description"); cursor.blank();
  cursor.exact("## Request Authority"); cursor.blank();
  const originalRequest = parseJsonString(cursor.take(), "Original request", cursor.index); cursor.blank();
  cursor.exact("## Project"); cursor.blank();
  const project = {
    key: parseKeyLine(cursor.take(), "Key", cursor.index),
    name: parseJsonString(cursor.take(), "Name", cursor.index),
    objective: parseJsonString(cursor.take(), "Objective", cursor.index),
  };
  cursor.blank();
  const actors = parseSection(cursor, "Actors", "Actor", (key, current) => ({
    key,
    name: parseJsonString(current.take(), "Name", current.index),
    responsibility: parseJsonString(current.take(), "Responsibility", current.index),
  }));
  const capabilities = parseSection(cursor, "Capabilities", "Capability", (key, current) => ({
    key,
    statement: parseJsonString(current.take(), "Statement", current.index),
  }));
  const workflows = parseSection(cursor, "Workflows", "Workflow", (key, current) => ({
    key,
    statement: parseJsonString(current.take(), "Statement", current.index),
    actorKeys: jsonKeys(current.take(), "Actors", current.index),
    capabilityKeys: jsonKeys(current.take(), "Capabilities", current.index),
  }));
  const constraints = parseSection(cursor, "Constraints", "Constraint", (key, current) => ({
    key,
    statement: parseJsonString(current.take(), "Statement", current.index),
  }));
  const determinations = parseSection(cursor, "Determinations", "Determination", (key, current) => {
    const statement = parseJsonString(current.take(), "Statement", current.index);
    const rationale = parseJsonString(current.take(), "Rationale", current.index);
    const materialityLine = current.take();
    const materiality = materialityLine.slice("Materiality: ".length);
    if (!materialityLine.startsWith("Materiality: ") || !["product", "architecture", "implementation", "preference"].includes(materiality)) throw new ProjectDescriptionDocumentError(`invalid Materiality at line ${current.index}`);
    const rigidityLine = current.take();
    const rigidity = rigidityLine.slice("Rigidity: ".length);
    if (!rigidityLine.startsWith("Rigidity: ") || !["RIGID", "FLEXIBLE"].includes(rigidity)) throw new ProjectDescriptionDocumentError(`invalid Rigidity at line ${current.index}`);
    return { key, statement, rationale, materiality: materiality as "product" | "architecture" | "implementation" | "preference", rigidity: rigidity as "RIGID" | "FLEXIBLE", source: authority(current.take(), current.index) };
  });
  const qualityCommands = parseSection<ProjectDescriptionQualityCommand>(cursor, "Quality Commands", "Quality Command", (key, current) => {
    const kindLine = current.take();
    const kind = kindLine.slice("Kind: ".length);
    if (!kindLine.startsWith("Kind: ") || !["test", "build", "lint", "typecheck", "run"].includes(kind)) throw new ProjectDescriptionDocumentError(`invalid quality-command Kind at line ${current.index}`);
    return { key, kind: kind as ProjectDescriptionQualityCommand["kind"], command: parseJsonString(current.take(), "Command", current.index) };
  });
  if (cursor.index !== lines.length) throw new ProjectDescriptionDocumentError(`unexpected content at line ${cursor.index + 1}`);
  const decoded: ProjectDescription = { contract: PROJECT_DESCRIPTION_CONTRACT, stage: "project-description", originalRequest, project, actors, capabilities, workflows, constraints, determinations, qualityCommands };
  const validated = validateProjectDescription(decoded);
  if (!validated.ok) throw new ProjectDescriptionDocumentError(validated.findings.map((entry) => `${entry.pointer}: ${entry.message}`).join("; "));
  const semanticSha256 = projectDescriptionSemanticSha256(validated.value);
  return {
    metadata: { stage: "project-description", contract: PROJECT_DESCRIPTION_CONTRACT, completion: "complete", originalRequestSha256, discoverySha256, authoritativeInputSha256, baselineSemanticSha256 },
    value: validated.value,
    semanticSha256,
    developerModified: semanticSha256 !== baselineSemanticSha256,
  };
}
