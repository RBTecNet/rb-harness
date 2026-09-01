import { semanticKey } from "../identity.js";
import { validateCompiledProjectPhases } from "./project-phases-compiler.js";
import {
  PROJECT_PHASES_CONTRACT,
  decodeProjectPhasesProposalWire,
  projectPhasesSemanticSha256,
  resolveProjectPhasesProposal,
  validateProjectPhases,
  type ProjectPhases,
  type ProjectPhasesFinding,
  type ProjectPhasesUpstreamProjection,
} from "./project-phases-ir.js";

const SHA256 = /^[a-f0-9]{64}$/;

export interface ProjectPhasesDocumentMetadata {
  readonly stage: "project-phases";
  readonly contract: typeof PROJECT_PHASES_CONTRACT;
  readonly completion: "complete";
  readonly upstreamProjectionSha256: string;
  readonly authoritativeInputSha256: string;
  readonly baselineSemanticSha256: string;
}

export interface ParsedProjectPhasesDocument {
  readonly metadata: ProjectPhasesDocumentMetadata;
  readonly value: ProjectPhases;
  readonly semanticSha256: string;
  readonly developerModified: boolean;
  readonly upstreamCompatibilityFindings: readonly ProjectPhasesFinding[];
}

export class ProjectPhasesDocumentError extends Error {
  constructor(message: string) {
    super(`PROJECT_PHASES_DOCUMENT_INVALID: ${message}`);
    this.name = "ProjectPhasesDocumentError";
  }
}

function metadataComment(lines: readonly string[], index: number, name: string): string {
  const match = new RegExp(`^<!-- ${name}: (.+) -->$`).exec(lines[index] ?? "");
  if (!match?.[1]) throw new ProjectPhasesDocumentError(`missing ${name} metadata`);
  return match[1];
}

function hashMetadata(lines: readonly string[], index: number, name: string): string {
  const value = metadataComment(lines, index, name);
  if (!SHA256.test(value)) throw new ProjectPhasesDocumentError(`${name} must be lowercase SHA-256`);
  return value;
}

function decodeProjectPhasesValue(value: unknown, upstream: ProjectPhasesUpstreamProjection): ProjectPhases {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProjectPhasesDocumentError("/: expected object");
  const root = value as Record<string, unknown>;
  const allowed = new Set(["contract", "stage", "projectKey", "phases"]);
  for (const key of Object.keys(root)) if (!allowed.has(key)) throw new ProjectPhasesDocumentError(`/${key}: unknown field`);
  for (const key of allowed) if (!(key in root)) throw new ProjectPhasesDocumentError(`/${key}: required field is missing`);
  if (root.contract !== PROJECT_PHASES_CONTRACT) throw new ProjectPhasesDocumentError(`/contract: expected ${PROJECT_PHASES_CONTRACT}`);
  if (root.stage !== "project-phases") throw new ProjectPhasesDocumentError("/stage: expected project-phases");
  if (typeof root.projectKey !== "string" || !semanticKey(root.projectKey)) throw new ProjectPhasesDocumentError("/projectKey: invalid SemanticKey");
  const decoded = decodeProjectPhasesProposalWire({ phases: root.phases });
  if (!decoded.ok) throw new ProjectPhasesDocumentError(decoded.findings.map((entry) => `${entry.pointer}: ${entry.message}`).join("; "));
  return {
    ...resolveProjectPhasesProposal(decoded.value, upstream),
    projectKey: root.projectKey as ProjectPhases["projectKey"],
  };
}

export function renderProjectPhasesDocument(
  value: ProjectPhases,
  upstream: ProjectPhasesUpstreamProjection,
  metadata: Pick<ProjectPhasesDocumentMetadata, "upstreamProjectionSha256" | "authoritativeInputSha256">,
): string {
  const validation = validateProjectPhases(value, upstream);
  if (!validation.ok) throw new ProjectPhasesDocumentError(validation.findings.map((entry) => `${entry.pointer}: ${entry.message}`).join("; "));
  const semanticSha256 = projectPhasesSemanticSha256(value);
  return [
    "<!-- rb-progressive-init-stage: project-phases -->",
    `<!-- rb-project-phases-contract: ${PROJECT_PHASES_CONTRACT} -->`,
    "<!-- rb-project-phases-completion: complete -->",
    `<!-- rb-project-phases-upstream-projection-sha256: ${metadata.upstreamProjectionSha256} -->`,
    `<!-- rb-project-phases-authoritative-input-sha256: ${metadata.authoritativeInputSha256} -->`,
    `<!-- rb-project-phases-baseline-semantic-sha256: ${semanticSha256} -->`,
    "",
    "# Project Phases",
    "",
    "```json",
    JSON.stringify(value, null, 2),
    "```",
    "",
  ].join("\n");
}

export function renderProjectPhasesProposal(value: ProjectPhases): string {
  return ["Project phases proposal", "", "```json", JSON.stringify(value, null, 2), "```", ""].join("\n");
}

export function parseProjectPhasesDocument(
  source: string,
  upstream: ProjectPhasesUpstreamProjection,
): ParsedProjectPhasesDocument {
  if (!source.endsWith("\n")) throw new ProjectPhasesDocumentError("document must end with a newline");
  if (source.includes("\r")) throw new ProjectPhasesDocumentError("bare carriage returns are not allowed");
  const lines = source.slice(0, -1).split("\n");
  if (metadataComment(lines, 0, "rb-progressive-init-stage") !== "project-phases") throw new ProjectPhasesDocumentError("stage metadata must be project-phases");
  if (metadataComment(lines, 1, "rb-project-phases-contract") !== PROJECT_PHASES_CONTRACT) throw new ProjectPhasesDocumentError(`contract must be ${PROJECT_PHASES_CONTRACT}`);
  if (metadataComment(lines, 2, "rb-project-phases-completion") !== "complete") throw new ProjectPhasesDocumentError("completion metadata must be complete");
  const upstreamProjectionSha256 = hashMetadata(lines, 3, "rb-project-phases-upstream-projection-sha256");
  const authoritativeInputSha256 = hashMetadata(lines, 4, "rb-project-phases-authoritative-input-sha256");
  const baselineSemanticSha256 = hashMetadata(lines, 5, "rb-project-phases-baseline-semantic-sha256");
  if (lines[6] !== "" || lines[7] !== "# Project Phases" || lines[8] !== "" || lines[9] !== "```json") {
    throw new ProjectPhasesDocumentError("invalid strict document heading or JSON boundary");
  }
  const closing = lines.lastIndexOf("```");
  if (closing <= 9 || closing !== lines.length - 1) throw new ProjectPhasesDocumentError("invalid closing JSON boundary");
  let decodedJson: unknown;
  try {
    decodedJson = JSON.parse(lines.slice(10, closing).join("\n"));
  } catch (error) {
    throw new ProjectPhasesDocumentError(`invalid JSON body: ${error instanceof Error ? error.message : String(error)}`);
  }
  const value = decodeProjectPhasesValue(decodedJson, upstream);
  const validation = validateProjectPhases(value, upstream, {
    allowMissingUpstreamSubjects: true,
    allowProjectKeyMismatch: true,
    allowUncoveredUpstreamSubjects: true,
  });
  const findings = validation.ok ? [] : validation.findings;
  const upstreamCompatibilityFindings = findings.filter((entry) => entry.code === "upstream");
  const intrinsicFindings = findings.filter((entry) => entry.code !== "upstream");
  if (intrinsicFindings.length) throw new ProjectPhasesDocumentError(intrinsicFindings.map((entry) => `${entry.pointer}: ${entry.message}`).join("; "));
  const strictCurrent = validateProjectPhases(value, upstream);
  if (strictCurrent.ok) {
    const canonical = validateCompiledProjectPhases(upstream, value, {
      originalRequest: upstream.projectDescription.originalRequest,
      runId: "document-validation",
      generatedAt: "2000-01-01T00:00:00.000Z",
    });
    if (!canonical.ok) {
      throw new ProjectPhasesDocumentError(canonical.findings.map((entry) => `${entry.pointer}: ${entry.invariant} ${entry.message}`).join("; "));
    }
  }
  const semanticSha256 = projectPhasesSemanticSha256(value);
  return {
    metadata: {
      stage: "project-phases",
      contract: PROJECT_PHASES_CONTRACT,
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
