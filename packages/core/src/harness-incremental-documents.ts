/**
 * Provider-neutral incremental document authoring contracts.
 *
 * Every adapter can return a small final answer even when it cannot write
 * files or produce a multi-megabyte completion. The provider first declares a
 * plan, then authors one bounded part at a time. RB Harness owns checkpoints,
 * assembly, validation, and publication.
 */

import { HARNESS_BUDGET } from "./harness-budget.js";
import { createHash } from "node:crypto";
import { basename, dirname } from "node:path/posix";
import {
  DOCUMENT_BUNDLE_CONTRACT,
  DocumentSubstanceError,
  extractEnvelopeOrJson,
  normalizeGeneratedDocument,
  normalizeGeneratedDocumentPath,
  parseDocumentBundle,
  stripEnclosingCodeFence,
  type DocumentBundle,
  type GeneratedDocument,
} from "./harness-documents.js";

export const DOCUMENT_PLAN_CONTRACT = "rb-harness-document-plan/v1" as const;
export const DOCUMENT_PLAN_BEGIN = "RB_HARNESS_DOCUMENT_PLAN_JSON_BEGIN";
export const DOCUMENT_PLAN_END = "RB_HARNESS_DOCUMENT_PLAN_JSON_END";
export const DOCUMENT_PART_CONTRACT = "rb-harness-document-part/v1" as const;
export const DOCUMENT_PART_BEGIN = "RB_HARNESS_DOCUMENT_PART_JSON_BEGIN";
export const DOCUMENT_PART_END = "RB_HARNESS_DOCUMENT_PART_JSON_END";

export interface DocumentPlanPart {
  id: string;
  purpose: string;
}

export interface PlannedDocument {
  path: string;
  purpose: string;
  /** Documents whose finalized authority this writer must receive. */
  dependsOn: string[];
  parts: DocumentPlanPart[];
}

export interface DocumentPlan {
  contract: typeof DOCUMENT_PLAN_CONTRACT;
  status: "complete" | "blocked";
  summary: string;
  /** Compact shared ID/traceability ledger used by every independent writer. */
  coordination: string;
  documents: PlannedDocument[];
  blocked: string[];
}

export interface DocumentPart {
  contract: typeof DOCUMENT_PART_CONTRACT;
  path: string;
  part: string;
  content: string;
}

export type DocumentPlanNormalizationReason =
  | "stripped-json-fence"
  | "recovered-root-property-boundary"
  | "canonicalized-coordination-object"
  | "removed-document-prefix"
  | "removed-part-scope";

export interface DocumentPlanParseOptions {
  /** Finalized documents from this run that a localized repair may read. */
  availableDocumentPaths?: readonly string[];
  /** Repair plans support only their observed representation differences. */
  context?: "generation" | "structural-repair";
}

interface ExtractedDocumentPlan {
  source: string;
  explicitEnvelope: boolean;
  reasons: DocumentPlanNormalizationReason[];
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

/**
 * Some providers correctly escape quotes and backslashes but stream literal
 * line breaks inside a JSON string. Escaping only JSON-forbidden control
 * characters preserves the authored bytes after JSON decoding and cannot
 * change keys, paths, IDs, or object structure.
 */
function escapeRawJsonStringControls(source: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (const character of source) {
    if (!inString) {
      result += character;
      if (character === '"') inString = true;
      continue;
    }
    if (escaped) {
      result += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      result += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      result += character;
      inString = false;
      continue;
    }
    if (character === "\n") result += "\\n";
    else if (character === "\r") result += "\\r";
    else if (character === "\t") result += "\\t";
    else result += character;
  }
  return result;
}

function jsonEnvelope(
  output: string,
  begin: string,
  end: string,
  label: string,
  maximumBytes: number,
  repairRawStringControls = false,
): Record<string, unknown> {
  const source = extractEnvelopeOrJson(output, begin, end, label);
  if (Buffer.byteLength(source) > maximumBytes) {
    throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  }
  try {
    return object(JSON.parse(source), label);
  } catch (error) {
    if (error instanceof SyntaxError && repairRawStringControls) {
      try {
        return object(JSON.parse(escapeRawJsonStringControls(source)), label);
      } catch { /* retain the stable public diagnostic below */ }
    }
    if (error instanceof SyntaxError) throw new Error(`provider returned malformed ${label} JSON`);
    throw error;
  }
}

function text(value: unknown, label: string, maximum = HARNESS_BUDGET.documents.maxPlanBytes): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  if (Buffer.byteLength(value) > maximum) throw new Error(`${label} exceeds ${maximum} bytes`);
  return value.trim();
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return value.map((entry) => (entry as string).trim());
}

function allowedKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!accepted.has(key)) throw new Error(`unsupported ${label} field: ${key}`);
  }
}

function stripDocumentPlanJsonFence(source: string): { source: string; stripped: boolean } {
  const trimmed = source.trim();
  if (!/^(?:`{3,}|~{3,})[ \t]*(?:json)?[ \t]*(?:\r?\n|$)/i.test(trimmed)) {
    return { source: trimmed, stripped: false };
  }
  const stripped = stripEnclosingCodeFence(trimmed);
  if (stripped === trimmed) return { source: trimmed, stripped: false };
  return { source: stripped.trim(), stripped: true };
}

/**
 * Extract only the declared document-plan region. Prose outside explicit
 * sentinels is ignored; without sentinels the whole response must itself be
 * the JSON object (optionally fenced), so prose can never widen the boundary.
 */
function extractDocumentPlan(output: string): ExtractedDocumentPlan {
  const start = output.indexOf(DOCUMENT_PLAN_BEGIN);
  let source: string;
  let explicitEnvelope = false;
  if (start >= 0) {
    explicitEnvelope = true;
    const finish = output.indexOf(DOCUMENT_PLAN_END, start + DOCUMENT_PLAN_BEGIN.length);
    if (finish < 0) throw new Error("the document plan envelope was truncated before its terminator");
    source = output.slice(start + DOCUMENT_PLAN_BEGIN.length, finish);
  } else {
    source = output;
  }
  const fenced = stripDocumentPlanJsonFence(source);
  if (!fenced.source) throw new Error("the document plan envelope is empty");
  return {
    source: fenced.source,
    explicitEnvelope,
    reasons: fenced.stripped ? ["stripped-json-fence"] : [],
  };
}

interface JsonPropertyLocation {
  key: string;
  start: number;
  ownerObjectStart: number;
  valueStart: number;
}

interface JsonStructureScan {
  properties: JsonPropertyLocation[];
  remaining: { kind: "object" | "array"; start: number }[];
}

/** Structural scan only: it locates property ownership without repairing JSON. */
function scanJsonStructure(source: string): JsonStructureScan | undefined {
  const stack: { kind: "object" | "array"; start: number }[] = [];
  const properties: JsonPropertyLocation[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === '"') {
      const start = index;
      let escaped = false;
      index += 1;
      for (; index < source.length; index += 1) {
        const current = source[index]!;
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === '"') break;
      }
      if (index >= source.length) return undefined;
      let key: unknown;
      try { key = JSON.parse(source.slice(start, index + 1)); }
      catch { return undefined; }
      let next = index + 1;
      while (/\s/.test(source[next] ?? "")) next += 1;
      const owner = stack.at(-1);
      if (source[next] === ":" && owner?.kind === "object" && typeof key === "string") {
        next += 1;
        while (/\s/.test(source[next] ?? "")) next += 1;
        properties.push({ key, start, ownerObjectStart: owner.start, valueStart: next });
      }
      continue;
    }
    if (character === "{") stack.push({ kind: "object", start: index });
    else if (character === "[") stack.push({ kind: "array", start: index });
    else if (character === "}" || character === "]") {
      const expected = character === "}" ? "object" : "array";
      if (stack.at(-1)?.kind !== expected) return undefined;
      stack.pop();
    }
  }
  return { properties, remaining: stack };
}

/**
 * Recover only the observed MiMo serialization: the root object is the sole
 * unclosed container, `coordination` began as a root object, and exactly one
 * direct `documents` property is trapped inside it. Inserting `}` before that
 * property must make the complete source valid JSON. No other brace insertion
 * or candidate search is attempted.
 */
function recoverDocumentPlanRootBoundary(source: string): string | undefined {
  const scan = scanJsonStructure(source);
  const rootStart = source.search(/\S/);
  if (!scan || rootStart < 0 || source[rootStart] !== "{") return undefined;
  if (scan.remaining.length !== 1 || scan.remaining[0]?.kind !== "object" || scan.remaining[0].start !== rootStart) {
    return undefined;
  }
  const rootProperties = scan.properties.filter((property) => property.ownerObjectStart === rootStart);
  const coordination = rootProperties.filter((property) => property.key === "coordination");
  if (coordination.length !== 1 || source[coordination[0]!.valueStart] !== "{") return undefined;
  if (rootProperties.some((property) => property.key === "documents")) return undefined;
  const trappedDocuments = scan.properties.filter((property) =>
    property.ownerObjectStart === coordination[0]!.valueStart && property.key === "documents");
  if (trappedDocuments.length !== 1) return undefined;
  let comma = trappedDocuments[0]!.start - 1;
  while (/\s/.test(source[comma] ?? "")) comma -= 1;
  if (source[comma] !== ",") return undefined;
  const candidate = `${source.slice(0, comma)}}${source.slice(comma)}`;
  try {
    const parsed = object(JSON.parse(candidate), "document plan");
    object(parsed.coordination, "document plan coordination");
    if (!Array.isArray(parsed.documents)) return undefined;
    return candidate;
  } catch {
    return undefined;
  }
}

const COORDINATION_ROOT_AUTHORITY_FIELDS = new Set([
  "contract", "status", "summary", "coordination", "documents", "blocked",
]);

/**
 * Accepted structured coordination shape:
 * - a non-empty JSON object;
 * - no top-level document-plan authority field;
 * - JSON primitives, arrays, and nested objects up to 16 levels deep.
 *
 * Object keys are sorted recursively and array order is retained. The compact
 * JSON text is therefore lossless and deterministic; no value is summarized,
 * interpreted, renamed, or inferred.
 */
function canonicalCoordinationObject(value: Record<string, unknown>): string {
  if (!Object.keys(value).length) throw new Error("document plan coordination object must not be empty");
  for (const key of Object.keys(value)) {
    if (COORDINATION_ROOT_AUTHORITY_FIELDS.has(key)) {
      throw new Error(`unsupported document plan coordination authority field: ${key}`);
    }
  }
  const canonicalize = (entry: unknown, depth: number): unknown => {
    if (depth > 16) throw new Error("document plan coordination object exceeds 16 levels");
    if (entry === null || typeof entry === "string" || typeof entry === "boolean" || typeof entry === "number") {
      return entry;
    }
    if (Array.isArray(entry)) return entry.map((item) => canonicalize(item, depth + 1));
    const record = object(entry, "document plan coordination value");
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key], depth + 1)]));
  };
  return JSON.stringify(canonicalize(value, 0));
}

interface NormalizedDocumentPlan {
  value: Record<string, unknown>;
  reasons: DocumentPlanNormalizationReason[];
}

function normalizeDocumentPlanRepresentation(
  output: string,
  context: DocumentPlanParseOptions["context"] = "generation",
): NormalizedDocumentPlan {
  const extracted = extractDocumentPlan(output);
  if (Buffer.byteLength(extracted.source) > HARNESS_BUDGET.documents.maxPlanBytes) {
    throw new Error(`document plan exceeds ${HARNESS_BUDGET.documents.maxPlanBytes} bytes`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = object(JSON.parse(extracted.source), "document plan");
  } catch (error) {
    const recovered = error instanceof SyntaxError && extracted.explicitEnvelope
      ? recoverDocumentPlanRootBoundary(extracted.source)
      : undefined;
    if (!recovered) throw new Error("provider returned malformed document plan JSON");
    parsed = object(JSON.parse(recovered), "document plan");
    extracted.reasons.push("recovered-root-property-boundary");
  }

  const canonical: Record<string, unknown> = { ...parsed };
  if (canonical.coordination && typeof canonical.coordination === "object" && !Array.isArray(canonical.coordination)) {
    canonical.coordination = canonicalCoordinationObject(canonical.coordination as Record<string, unknown>);
    extracted.reasons.push("canonicalized-coordination-object");
  }
  if (Array.isArray(canonical.documents)) {
    canonical.documents = canonical.documents.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
      const document = { ...(entry as Record<string, unknown>) };
      if (typeof document.prefix === "string" && Object.hasOwn(document, "purpose")) {
        delete document.prefix;
        extracted.reasons.push("removed-document-prefix");
      }
      if (context === "structural-repair" && Array.isArray(document.parts)) {
        document.parts = document.parts.map((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
          const part = { ...(entry as Record<string, unknown>) };
          if (typeof part.scope === "string" && Object.hasOwn(part, "purpose")) {
            delete part.scope;
            extracted.reasons.push("removed-part-scope");
          }
          return part;
        });
      }
      return document;
    });
  }
  return { value: canonical, reasons: [...new Set(extracted.reasons)] };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Fingerprint only the relevant plan payload; used solely to stop formatter repetition. */
export function documentPlanFormattingFingerprint(output: string): string {
  let relevant: string;
  try { relevant = extractDocumentPlan(output).source; }
  catch { relevant = output.trim().replace(/\r\n?/g, "\n"); }
  try { relevant = stableJson(JSON.parse(relevant)); }
  catch { relevant = relevant.trim().replace(/\r\n?/g, "\n"); }
  return createHash("sha256").update(relevant).digest("hex");
}

const EXECUTION_AUTHORITIES = new Set([
  "REQUEST.MD",
  "SPEC.MD",
  "REQUIREMENTS.MD",
  "PROJECT.MD",
  "ARCHITECTURE.MD",
  "PLAN.MD",
  "DECISIONS.MD",
  "NON_FUNCTIONAL.MD",
  "WORKFLOWS.MD",
  "TO_BE.MD",
  "IMPACT.MD",
  "PRESERVATION.MD",
  "MIGRATION.MD",
  "REGRESSION_MATRIX.MD",
]);

function codeOwnedDependencies(path: string, allPaths: readonly string[]): string[] {
  const name = basename(path).toUpperCase();
  const directory = dirname(path);
  const siblings = allPaths.filter((candidate) => candidate !== path && dirname(candidate) === directory);
  if (name === "PHASES.MD") {
    return siblings.filter((candidate) => EXECUTION_AUTHORITIES.has(basename(candidate).toUpperCase()));
  }
  if (name === "OPERATIONS.JSON") {
    return siblings.filter((candidate) => basename(candidate).toUpperCase() === "PHASES.MD");
  }
  if (name === "SOURCE-MANIFEST.JSON") return allPaths.filter((candidate) => candidate !== path);
  return [];
}

function dependencyWouldCycle(
  target: string,
  dependency: string,
  dependenciesByPath: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (target === dependency) return true;
  const pending = [dependency];
  const visited = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (current === target) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(dependenciesByPath.get(current) ?? []));
  }
  return false;
}

/**
 * `dependsOn` means authoring order, not a general cross-reference graph.
 * Providers naturally describe reciprocal semantic relationships between
 * planning documents, so treating every suggestion as write order creates
 * cycles such as PHASES -> OPERATIONS -> PHASES. Establish the code-owned
 * workflow DAG first, then retain provider edges only while they preserve it.
 */
function reconcileDocumentDependencies(
  documents: PlannedDocument[],
  availableDocumentPaths: readonly string[] = [],
): PlannedDocument[] {
  const allPaths = documents.map((document) => document.path);
  const knownPaths = new Set([...allPaths, ...availableDocumentPaths]);
  for (const document of documents) {
    for (const dependency of document.dependsOn) {
      if (!knownPaths.has(dependency)) {
        throw new DocumentSubstanceError(`planned document ${document.path} depends on missing document ${dependency}`);
      }
    }
  }

  const dependenciesByPath = new Map(documents.map((document) => [
    document.path,
    new Set(codeOwnedDependencies(document.path, allPaths)),
  ]));

  // A cycle here would be a harness defect, not provider output. Keep the
  // closed validator as an invariant before considering any suggested edge.
  orderDocuments(documents.map((document) => ({
    ...document,
    dependsOn: [...dependenciesByPath.get(document.path)!].sort(),
  })), availableDocumentPaths);

  const suggestions = documents.flatMap((document) => [...new Set(document.dependsOn)].map((dependency) => ({
    target: document.path,
    dependency,
  }))).sort((left, right) => left.target.localeCompare(right.target) || left.dependency.localeCompare(right.dependency));

  for (const { target, dependency } of suggestions) {
    const dependencies = dependenciesByPath.get(target)!;
    if (dependencies.has(dependency)) continue;
    if (dependencyWouldCycle(target, dependency, dependenciesByPath)) continue;
    dependencies.add(dependency);
  }

  return documents.map((document) => ({
    ...document,
    dependsOn: [...dependenciesByPath.get(document.path)!].sort(),
  }));
}

function orderDocuments(documents: PlannedDocument[], availableDocumentPaths: readonly string[] = []): PlannedDocument[] {
  const byPath = new Map(documents.map((document) => [document.path, document]));
  const available = new Set(availableDocumentPaths);
  for (const document of documents) {
    for (const dependency of document.dependsOn) {
      if (dependency === document.path) throw new DocumentSubstanceError(`planned document ${document.path} depends on itself`);
      if (!byPath.has(dependency) && !available.has(dependency)) {
        throw new DocumentSubstanceError(`planned document ${document.path} depends on missing document ${dependency}`);
      }
    }
  }
  const pending = new Map(documents.map((document, index) => [document.path, { document, index }]));
  const completed = new Set(available);
  const ordered: PlannedDocument[] = [];
  while (pending.size) {
    const ready = [...pending.values()]
      .filter(({ document }) => document.dependsOn.every((dependency) => completed.has(dependency)))
      .sort((left, right) => left.index - right.index)[0];
    if (!ready) {
      const cycle = [...pending.values()].map(({ document }) => `${document.path} -> ${document.dependsOn.join(", ")}`).join("; ");
      throw new DocumentSubstanceError(`document dependency graph contains a cycle: ${cycle}`);
    }
    pending.delete(ready.document.path);
    completed.add(ready.document.path);
    ordered.push(ready.document);
  }
  return ordered;
}

export function parseDocumentPlan(output: string, options: DocumentPlanParseOptions = {}): DocumentPlan {
  const normalized = normalizeDocumentPlanRepresentation(output, options.context);
  const value = normalized.value;
  allowedKeys(value, ["contract", "status", "summary", "coordination", "documents", "blocked"], "document plan");
  if (value.contract !== DOCUMENT_PLAN_CONTRACT) {
    throw new Error(`document plan contract must be ${DOCUMENT_PLAN_CONTRACT}`);
  }
  if (value.status !== "complete" && value.status !== "blocked") {
    throw new Error("document plan status must be complete or blocked");
  }
  const summary = text(value.summary, "document plan summary");
  const coordination = text(value.coordination, "document plan coordination");
  if (!Array.isArray(value.documents)) throw new Error("document plan documents must be an array");
  if (value.documents.length > HARNESS_BUDGET.documents.maxPlannedDocuments) {
    throw new Error(`document plan exceeds ${HARNESS_BUDGET.documents.maxPlannedDocuments} documents`);
  }
  const seenPaths = new Set<string>();
  let totalParts = 0;
  let documents = value.documents.map((entry, documentIndex): PlannedDocument => {
    const record = object(entry, `planned document ${documentIndex + 1}`);
    allowedKeys(record, ["path", "purpose", "dependsOn", "parts"], "planned document");
    const path = normalizeGeneratedDocumentPath(record.path, documentIndex);
    if (seenPaths.has(path)) throw new Error(`document plan declares ${path} twice`);
    seenPaths.add(path);
    const purpose = text(record.purpose, `planned document ${path} purpose`);
    if (!Array.isArray(record.parts) || !record.parts.length) {
      throw new Error(`planned document ${path} must declare at least one bounded part`);
    }
    if (record.parts.length > HARNESS_BUDGET.documents.maxPartsPerDocument) {
      throw new Error(`planned document ${path} exceeds ${HARNESS_BUDGET.documents.maxPartsPerDocument} parts`);
    }
    const seenParts = new Set<string>();
    const parts = record.parts.map((raw, partIndex): DocumentPlanPart => {
      const part = object(raw, `part ${partIndex + 1} of ${path}`);
      allowedKeys(part, ["id", "purpose"], "document part plan");
      const id = text(part.id, `part ${partIndex + 1} id`, 128);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new Error(`unsupported part id ${id} for ${path}`);
      if (seenParts.has(id)) throw new Error(`planned document ${path} declares part ${id} twice`);
      seenParts.add(id);
      return { id, purpose: text(part.purpose, `part ${id} purpose`) };
    });
    totalParts += parts.length;
    return { path, purpose, dependsOn: stringArray(record.dependsOn, `planned document ${path} dependsOn`), parts };
  });
  if (totalParts > HARNESS_BUDGET.documents.maxPlannedParts) {
    throw new Error(`document plan exceeds ${HARNESS_BUDGET.documents.maxPlannedParts} total parts`);
  }
  const blocked = stringArray(value.blocked, "document plan blocked");
  if (value.status === "blocked" && !blocked.length) throw new Error("a blocked document plan must name the missing decision");
  if (value.status === "complete" && !documents.length) throw new Error("a complete document plan must contain documents");
  if (value.status === "complete" && blocked.length) throw new Error("a complete document plan cannot retain blockers");
  documents = reconcileDocumentDependencies(documents, options.availableDocumentPaths);
  documents = orderDocuments(documents, options.availableDocumentPaths);
  if (options.context === "structural-repair") {
    process.stdout.write(
      `[rb-harness] repair-plan deterministic normalization ${JSON.stringify({ reasons: normalized.reasons })}\n`,
    );
  } else if (normalized.reasons.length) {
    process.stdout.write(
      `[rb-harness] document-plan normalization applied ${JSON.stringify({ reasons: normalized.reasons })}\n`,
    );
  }
  return { contract: DOCUMENT_PLAN_CONTRACT, status: value.status, summary, coordination, documents, blocked };
}

export function parseDocumentPart(output: string, expected: { path: string; part: string }): DocumentPart {
  const value = jsonEnvelope(
    output,
    DOCUMENT_PART_BEGIN,
    DOCUMENT_PART_END,
    "document part",
    HARNESS_BUDGET.documents.maxPartEnvelopeBytes,
    true,
  );
  allowedKeys(value, ["contract", "path", "part", "content"], "document part");
  if (value.contract !== DOCUMENT_PART_CONTRACT) throw new Error(`document part contract must be ${DOCUMENT_PART_CONTRACT}`);
  const path = normalizeGeneratedDocumentPath(value.path, 0);
  const part = text(value.part, "document part id", 128);
  if (path !== expected.path || part !== expected.part) {
    throw new Error(`provider returned document part ${path}#${part}; expected ${expected.path}#${expected.part}`);
  }
  if (typeof value.content !== "string" || !value.content) throw new Error(`document part ${path}#${part} has no content`);
  if (Buffer.byteLength(value.content) > HARNESS_BUDGET.documents.maxPartBytes) {
    // Length is substance: the formatter may only change representation, so
    // sending an oversized part through it buys attempts that cannot shorten
    // anything. The writer has to author this segment again, more concisely.
    throw new DocumentSubstanceError(
      `document part ${path}#${part} is ${Buffer.byteLength(value.content)} bytes, above the `
      + `${HARNESS_BUDGET.documents.maxPartBytes}-byte limit for one segment`,
    );
  }
  return { contract: DOCUMENT_PART_CONTRACT, path, part, content: value.content.replace(/\r\n/g, "\n").replace(/\r/g, "\n") };
}

export function assembleDocumentPlan(plan: DocumentPlan, parts: readonly DocumentPart[]): DocumentBundle {
  if (plan.status === "blocked") {
    return { contract: DOCUMENT_BUNDLE_CONTRACT, status: "blocked", summary: plan.summary, documents: [], blocked: plan.blocked };
  }
  const expected = new Set(plan.documents.flatMap((document) => document.parts.map((part) => `${document.path}\0${part.id}`)));
  const provided = new Map<string, DocumentPart>();
  for (const part of parts) {
    const key = `${part.path}\0${part.part}`;
    if (!expected.has(key)) throw new Error(`document checkpoint contains unexpected part ${part.path}#${part.part}`);
    if (provided.has(key)) throw new Error(`document checkpoint contains duplicate part ${part.path}#${part.part}`);
    provided.set(key, part);
  }
  const documents: GeneratedDocument[] = plan.documents.map((document, index) => {
    const content = document.parts.map((part) => {
      const value = provided.get(`${document.path}\0${part.id}`);
      if (!value) throw new Error(`document checkpoint is missing ${document.path}#${part.id}`);
      return value.content;
    }).join("");
    return normalizeGeneratedDocument(document.path, content, index);
  });
  return {
    contract: DOCUMENT_BUNDLE_CONTRACT,
    status: "complete",
    summary: plan.summary,
    documents: documents.sort((left, right) => left.path.localeCompare(right.path)),
    blocked: [],
  };
}

export type PlannedOrLegacyBundle = { kind: "plan"; plan: DocumentPlan } | { kind: "bundle"; bundle: DocumentBundle };

/** Accept complete legacy adapters without making them pay for a second call. */
export function parsePlanOrLegacyBundle(
  output: string,
  options: DocumentPlanParseOptions = {},
): PlannedOrLegacyBundle {
  if (output.includes(DOCUMENT_PLAN_BEGIN) || output.includes(DOCUMENT_PLAN_CONTRACT)) {
    return { kind: "plan", plan: parseDocumentPlan(output, options) };
  }
  return { kind: "bundle", bundle: parseDocumentBundle(output) };
}
