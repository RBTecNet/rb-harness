/**
 * Provider-neutral incremental document authoring contracts.
 *
 * Every adapter can return a small final answer even when it cannot write
 * files or produce a multi-megabyte completion. The provider first declares a
 * plan, then authors one bounded part at a time. RB Harness owns checkpoints,
 * assembly, validation, and publication.
 */

import { HARNESS_BUDGET } from "./harness-budget.js";
import {
  DOCUMENT_BUNDLE_CONTRACT,
  DocumentSubstanceError,
  extractEnvelopeOrJson,
  normalizeGeneratedDocument,
  normalizeGeneratedDocumentPath,
  parseDocumentBundle,
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

export function parseDocumentPlan(output: string): DocumentPlan {
  const value = jsonEnvelope(output, DOCUMENT_PLAN_BEGIN, DOCUMENT_PLAN_END, "document plan", HARNESS_BUDGET.documents.maxPlanBytes);
  allowedKeys(value, ["contract", "status", "summary", "coordination", "documents", "blocked"], "document plan");
  if (value.contract !== DOCUMENT_PLAN_CONTRACT) {
    throw new Error(`document plan contract must be ${DOCUMENT_PLAN_CONTRACT}`);
  }
  if (value.status !== "complete" && value.status !== "blocked") {
    throw new Error("document plan status must be complete or blocked");
  }
  const summary = text(value.summary, "document plan summary");
  const coordination = typeof value.coordination === "string" ? value.coordination.trim() : "";
  if (!Array.isArray(value.documents)) throw new Error("document plan documents must be an array");
  if (value.documents.length > HARNESS_BUDGET.documents.maxPlannedDocuments) {
    throw new Error(`document plan exceeds ${HARNESS_BUDGET.documents.maxPlannedDocuments} documents`);
  }
  const seenPaths = new Set<string>();
  let totalParts = 0;
  const documents = value.documents.map((entry, documentIndex): PlannedDocument => {
    const record = object(entry, `planned document ${documentIndex + 1}`);
    allowedKeys(record, ["path", "purpose", "parts"], "planned document");
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
    return { path, purpose, parts };
  });
  if (totalParts > HARNESS_BUDGET.documents.maxPlannedParts) {
    throw new Error(`document plan exceeds ${HARNESS_BUDGET.documents.maxPlannedParts} total parts`);
  }
  const blocked = stringArray(value.blocked, "document plan blocked");
  if (value.status === "blocked" && !blocked.length) throw new Error("a blocked document plan must name the missing decision");
  if (value.status === "complete" && !documents.length) throw new Error("a complete document plan must contain documents");
  if (value.status === "complete" && blocked.length) throw new Error("a complete document plan cannot retain blockers");
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
export function parsePlanOrLegacyBundle(output: string): PlannedOrLegacyBundle {
  if (output.includes(DOCUMENT_PLAN_BEGIN) || output.includes(DOCUMENT_PLAN_CONTRACT)) {
    return { kind: "plan", plan: parseDocumentPlan(output) };
  }
  return { kind: "bundle", bundle: parseDocumentBundle(output) };
}
