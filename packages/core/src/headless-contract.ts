import type { ValidationIssue } from "./types.js";

export type HeadlessInitDocument = Record<string, unknown>;

export interface HeadlessInitValidation {
  valid: boolean;
  issues: ValidationIssue[];
  document?: HeadlessInitDocument;
}

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROJECT_ID = /^[a-z0-9][a-z0-9-]*$/;
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const VALIDATION_NAMES = new Set(["request", "paths", "contract", "operations", "manifest", "tree", "secrets"]);
const FORBIDDEN_INSTRUCTIONS = /\b(?:rb-ai-context|rb-plan|rb-evolve)\b|\b(?:run|use|invoke|execute|create)\s+(?:an?\s+)?(?:ai[-\s]?context|rb[-\s]?(?:plan|evolve))\b|\b(?:clone|snapshot)\s+(?:(?:the|our)\s+)?(?:existing|current|legacy)\s+(?:\w+\s+){0,3}?(?:application|app|system|codebase|project|product|software|service|api)\b/i;
const SYSTEM_NOUN = "(?:application|app|system|behavio(?:u)?r|codebase|project|product|software|service|api)";
// `init` accepts lifecycle requirements for the project being created (for
// example, a service that will serve customers after launch).  It must still
// reject requests to inspect or evolve software that is already in use.  Keep
// these concepts separate: lifecycle words alone do not establish existing
// system scope. Separators are normalized before evaluating either expression,
// so the same boundary applies to prose, metadata keys, URLs, media types, and
// safe attachment paths.
const SYSTEM_WORK_ACTION = "(?:add|repair|inspect(?:ion)?|analy[sz]e|assess|evaluate|review|modify|change|alter|update|extend|fix|refactor|migrat(?:e|ion)|moderni[sz]e|improve|maintain|harden|plan)";
const EXISTING_SYSTEM_WORK = new RegExp(
  // The existing system must be the action's target. An integration can
  // evaluate data *from* an existing API without operating on that API.
  `\\b${SYSTEM_WORK_ACTION}\\s+(?:(?:the|our)\\s+)?(?:existing|current|legacy)\\s+(?:\\w+\\s+){0,3}?${SYSTEM_NOUN}\\b`
  + `|\\b${SYSTEM_WORK_ACTION}\\b(?:\\s+\\w+){0,8}?\\s+\\b(?:to|in|on|against)\\s+(?:(?:the|our)\\s+)?(?:existing|current|legacy)\\s+(?:\\w+\\s+){0,3}?${SYSTEM_NOUN}\\b`,
  "i",
);
const ACTIVE_SYSTEM_STATE = new RegExp(
  `\\b(?:production|live|deployed|running)\\s+${SYSTEM_NOUN}\\b`
  + `|\\b${SYSTEM_NOUN}\\s+(?:(?:that\\s+is|is)\\s+)?(?:(?:already|currently)\\s+)?(?:in\\s+)?(?:production|live|deployed|running)\\b`
  + `|\\b${SYSTEM_NOUN}\\s+(?:currently\\s+)?(?:operating|running|serving|handling|used)\\s+(?:in\\s+)?(?:production|live|customers|customer\\s+traffic|production\\s+traffic)\\b`,
  "i",
);
const ACTIVE_SYSTEM_INTENT = new RegExp(
  `\\b${SYSTEM_WORK_ACTION}\\b|\\b(?:orient\\s+yourself\\s+around|remediation|posture|safeguards|security)\\b`,
  "i",
);
const MAX_ATTACHMENTS = 100;
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;
const MAX_PATH_SEGMENTS = 16;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * JSON arrays cannot be sparse, but programmatic callers can construct them.
 * Validate every declared index before using iteration helpers, which skip
 * holes and would otherwise let an absent item bypass its item validator.
 */
function denseArray(value: unknown, issues: ValidationIssue[], path: string): value is unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) {
      add(issues, "headless.array.sparse", "Arrays must not contain empty entries", `${path}[${index}]`);
      return false;
    }
  }
  return true;
}

/** JSON Schema maxLength is measured in Unicode code points, not UTF-16 units. */
function unicodeLength(value: string): number {
  return Array.from(value).length;
}

function add(issues: ValidationIssue[], code: string, message: string, path: string): void {
  issues.push({ code, message, severity: "error", path });
}

function keys(value: Record<string, unknown>, allowed: readonly string[], issues: ValidationIssue[], path: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) add(issues, "headless.property.unknown", `Unknown property ${key}`, `${path}.${key}`);
}

function required(value: Record<string, unknown>, names: readonly string[], issues: ValidationIssue[], path: string): void {
  for (const name of names) if (!(name in value)) add(issues, "headless.property.required", `Missing required property ${name}`, `${path}.${name}`);
}

function string(value: unknown, issues: ValidationIssue[], path: string, max = 10000, min = 1): value is string {
  if (typeof value !== "string" || unicodeLength(value) < min || unicodeLength(value) > max) {
    add(issues, "headless.string", `Expected a string with length ${min}..${max}`, path);
    return false;
  }
  return true;
}

function id(value: unknown, issues: ValidationIssue[], path: string, project = false): void {
  if (!string(value, issues, path, project ? 100 : 200) || !(project ? PROJECT_ID : ID).test(value)) add(issues, "headless.id", "Invalid identifier", path);
}

function hash(value: unknown, issues: ValidationIssue[], path: string): void {
  if (typeof value !== "string" || !HASH.test(value)) add(issues, "headless.sha256", "Expected a lowercase SHA-256 hash", path);
}

export function normalizedRelativePathKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    // Reject lone UTF-16 surrogates so the value is representable as UTF-8.
    encodeURIComponent(value);
  } catch {
    return undefined;
  }
  const normalized = value.normalize("NFC");
  if (value !== normalized || unicodeLength(normalized) === 0 || unicodeLength(normalized) > 240 || normalized.endsWith("/") || normalized.includes("\\") || normalized.includes("\0") || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return undefined;
  const segments = normalized.split("/");
  if (segments.length > MAX_PATH_SEGMENTS || !segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")) return undefined;
  // NFC plus Unicode lowercase is the v1, locale-independent collision key.
  return normalized.toLowerCase();
}

export function isSafeRelativePath(value: unknown): value is string {
  return normalizedRelativePathKey(value) !== undefined;
}

function path(value: unknown, issues: ValidationIssue[], location: string): void {
  if (!isSafeRelativePath(value)) add(issues, "headless.path", "Path must be a safe relative path without empty or trailing segments", location);
}

/**
 * JSON Schema's date-time format requires a real calendar date. Date.parse
 * normalizes overflow days (for example, February 31), so check the calendar
 * portion independently before accepting its timestamp.
 */
export function isIsoDateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ISO_DATE_TIME.exec(value);
  if (!match || Number.isNaN(Date.parse(value))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  return calendar.getUTCFullYear() === year
    && calendar.getUTCMonth() === month - 1
    && calendar.getUTCDate() === day;
}

function metadata(value: unknown, issues: ValidationIssue[], location: string): void {
  if (!isObject(value) || Object.keys(value).length > 100) add(issues, "headless.metadata", "metadata must be an object with at most 100 properties", location);
}

function requestsExistingSystemWork(value: string): boolean {
  const normalized = value.replace(/[-_./:+]+/g, " ");
  // Evaluate independent clauses so a future-project clause cannot suppress a
  // separate request to inspect active software. References to an existing API
  // remain valid when it is only an integration dependency.
  return normalized
    .split(/[.;!?]+|\b(?:meanwhile|however|whereas|but)\b/i)
    .some((clause) => EXISTING_SYSTEM_WORK.test(clause)
      || (ACTIVE_SYSTEM_STATE.test(clause) && ACTIVE_SYSTEM_INTENT.test(clause)));
}

function rejectsHeadlessInitScope(value: string): boolean {
  return FORBIDDEN_INSTRUCTIONS.test(value) || requestsExistingSystemWork(value);
}

/**
 * The adapter receives these request subtrees as JSON in its prompt.  Inspect
 * every user-controlled string (including metadata keys) before allowing that
 * serialization to reach an adapter.  JSON input cannot be cyclic, but the
 * public value validator also accepts programmatic callers, so keep the walk
 * cycle-safe and avoid assuming dense arrays here.
 */
function validatePromptScope(value: unknown, issues: ValidationIssue[], location: string, seen = new Set<object>()): void {
  if (typeof value === "string") {
    if (rejectsHeadlessInitScope(value)) add(issues, "headless.instructions.scope", "Prompt-bearing request field requests an unsupported scope", location);
    return;
  }
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) if (index in value) validatePromptScope(value[index], issues, `${location}[${index}]`, seen);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (rejectsHeadlessInitScope(key)) add(issues, "headless.instructions.scope", "Prompt-bearing metadata key requests an unsupported scope", `${location}.${key}`);
    validatePromptScope(nested, issues, `${location}.${key}`, seen);
  }
}

function object(value: unknown, allowed: readonly string[], requiredNames: readonly string[], issues: ValidationIssue[], path: string): Record<string, unknown> | undefined {
  if (!isObject(value)) {
    add(issues, "headless.object", "Expected an object", path);
    return undefined;
  }
  keys(value, allowed, issues, path);
  required(value, requiredNames, issues, path);
  return value;
}

function date(value: unknown, issues: ValidationIssue[], path: string): void {
  if (!string(value, issues, path, 100) || !isIsoDateTime(value)) add(issues, "headless.date", "Expected an ISO date-time", path);
}

function resource(value: unknown, issues: ValidationIssue[], location: string): void {
  const item = object(value, ["id", "kind", "label", "reference", "path", "mediaType", "bytes", "sha256"], ["id", "kind", "label", "sha256"], issues, location);
  if (!item) return;
  id(item.id, issues, `${location}.id`);
  string(item.label, issues, `${location}.label`, 300);
  hash(item.sha256, issues, `${location}.sha256`);
  if (item.kind === "reference") {
    string(item.reference, issues, `${location}.reference`, 4000);
    for (const name of ["path", "mediaType", "bytes"]) if (name in item) add(issues, "headless.resource.variant", "Reference resources cannot include attachment fields", `${location}.${name}`);
  } else if (item.kind === "attachment") {
    path(item.path, issues, `${location}.path`);
    string(item.mediaType, issues, `${location}.mediaType`, 200);
    if (!Number.isInteger(item.bytes) || Number(item.bytes) < 0 || Number(item.bytes) > 10485760) add(issues, "headless.bytes", "Attachment bytes must be an integer from 0 to 10485760", `${location}.bytes`);
    if ("reference" in item) add(issues, "headless.resource.variant", "Attachment resources cannot include reference", `${location}.reference`);
  } else add(issues, "headless.resource.kind", "Resource kind must be reference or attachment", `${location}.kind`);
}

function request(value: Record<string, unknown>, issues: ValidationIssue[]): void {
  keys(value, ["contract", "kind", "requestId", "workflow", "projectKind", "project", "artifactSet", "revision", "specifications", "additionalInstructions", "interviewAnswers"], issues, "$");
  required(value, ["contract", "kind", "requestId", "workflow", "projectKind", "project", "artifactSet", "revision", "specifications", "additionalInstructions", "interviewAnswers"], issues, "$");
  if (value.contract !== "rb-headless-init/v1") add(issues, "headless.contract", "contract must be rb-headless-init/v1", "$.contract");
  if (value.kind !== "request") add(issues, "headless.kind", "kind must be request", "$.kind");
  if (value.workflow !== "init" || value.projectKind !== "new") add(issues, "headless.scope", "Only init of a new project is supported", "$.workflow");
  id(value.requestId, issues, "$.requestId");
  const project = object(value.project, ["id", "name", "description", "metadata"], ["id", "name", "description", "metadata"], issues, "$.project");
  if (project) { id(project.id, issues, "$.project.id", true); string(project.name, issues, "$.project.name", 200); string(project.description, issues, "$.project.description"); metadata(project.metadata, issues, "$.project.metadata"); }
  const set = object(value.artifactSet, ["id", "name", "description", "strategy"], ["id", "name", "description", "strategy"], issues, "$.artifactSet");
  if (set) { id(set.id, issues, "$.artifactSet.id"); string(set.name, issues, "$.artifactSet.name", 200); string(set.description, issues, "$.artifactSet.description", 10000, 0); string(set.strategy, issues, "$.artifactSet.strategy", 10000, 0); }
  const revision = object(value.revision, ["id", "number", "createdAt"], ["id", "number", "createdAt"], issues, "$.revision");
  if (revision) { id(revision.id, issues, "$.revision.id"); if (!Number.isInteger(revision.number) || Number(revision.number) < 1) add(issues, "headless.revision.number", "revision number must be a positive integer", "$.revision.number"); date(revision.createdAt, issues, "$.revision.createdAt"); }
  if (!denseArray(value.specifications, issues, "$.specifications") || value.specifications.length < 1 || value.specifications.length > 50) add(issues, "headless.specifications", "specifications must contain 1..50 items", "$.specifications");
  else {
    let attachmentCount = 0;
    let attachmentBytes = 0;
    const attachmentPaths = new Set<string>();
    value.specifications.forEach((entry, index) => {
    const spec = object(entry, ["id", "title", "description", "decisions", "metadata", "snapshotHash", "resources"], ["id", "title", "description", "decisions", "metadata", "snapshotHash", "resources"], issues, `$.specifications[${index}]`);
    if (!spec) return;
    id(spec.id, issues, `$.specifications[${index}].id`); string(spec.title, issues, `$.specifications[${index}].title`, 300); string(spec.description, issues, `$.specifications[${index}].description`, 100000); hash(spec.snapshotHash, issues, `$.specifications[${index}].snapshotHash`);
    if (!denseArray(spec.decisions, issues, `$.specifications[${index}].decisions`) || spec.decisions.length > 200 || spec.decisions.some((item) => typeof item !== "string" || unicodeLength(item) < 1 || unicodeLength(item) > 4000)) add(issues, "headless.decisions", "decisions must be up to 200 non-empty strings", `$.specifications[${index}].decisions`);
    metadata(spec.metadata, issues, `$.specifications[${index}].metadata`);
    if (!denseArray(spec.resources, issues, `$.specifications[${index}].resources`) || spec.resources.length > 20) add(issues, "headless.resources", "resources must be an array of at most 20 items", `$.specifications[${index}].resources`); else {
      let specificationAttachments = 0;
      spec.resources.forEach((item, resourceIndex) => {
        resource(item, issues, `$.specifications[${index}].resources[${resourceIndex}]`);
        if (!isObject(item) || item.kind !== "attachment") return;
        specificationAttachments += 1;
        attachmentCount += 1;
        if (Number.isInteger(item.bytes) && Number(item.bytes) >= 0) attachmentBytes += Number(item.bytes);
        const collisionKey = normalizedRelativePathKey(item.path);
        if (collisionKey !== undefined) {
          if (attachmentPaths.has(collisionKey)) add(issues, "headless.resources.duplicate", "Attachment paths must be unique after NFC/case normalization", `$.specifications[${index}].resources[${resourceIndex}].path`);
          else attachmentPaths.add(collisionKey);
        }
      });
      if (specificationAttachments > 20) add(issues, "headless.attachments.perSpecification", "A specification may contain at most 20 attachments", `$.specifications[${index}].resources`);
    }
    });
    if (attachmentCount > MAX_ATTACHMENTS) add(issues, "headless.attachments.aggregate", "A request may contain at most 100 attachments", "$.specifications");
    if (attachmentBytes > MAX_ATTACHMENT_BYTES) add(issues, "headless.attachments.bytes.aggregate", "Attachment bytes may total at most 104857600", "$.specifications");
  }
  string(value.additionalInstructions, issues, "$.additionalInstructions", 20000, 0);
  if (!denseArray(value.interviewAnswers, issues, "$.interviewAnswers") || value.interviewAnswers.length > 100) add(issues, "headless.answers", "interviewAnswers must be an array of at most 100 items", "$.interviewAnswers");
  else value.interviewAnswers.forEach((entry, index) => {
    const answer = object(entry, ["questionId", "question", "answer", "disposition"], ["questionId", "question", "answer", "disposition"], issues, `$.interviewAnswers[${index}]`);
    if (answer) { id(answer.questionId, issues, `$.interviewAnswers[${index}].questionId`); string(answer.question, issues, `$.interviewAnswers[${index}].question`, 4000); string(answer.answer, issues, `$.interviewAnswers[${index}].answer`); if (answer.disposition !== "accepted") add(issues, "headless.answer.disposition", "disposition must be accepted", `$.interviewAnswers[${index}].disposition`); }
  });
  // Keep this list aligned with buildHeadlessInitPrompt.  Fields not passed to
  // the adapter (for example, artifactSet and revision) are intentionally not
  // evaluated as generation instructions.
  validatePromptScope(value.project, issues, "$.project");
  validatePromptScope(value.specifications, issues, "$.specifications");
  validatePromptScope(value.interviewAnswers, issues, "$.interviewAnswers");
  validatePromptScope(value.additionalInstructions, issues, "$.additionalInstructions");
}

function result(value: Record<string, unknown>, issues: ValidationIssue[]): void {
  keys(value, ["contract", "kind", "requestId", "requestHash", "status", "harness", "adapter", "files", "validations", "diagnosticCode", "startedAt", "finishedAt"], issues, "$");
  required(value, ["contract", "kind", "requestId", "requestHash", "status", "harness", "adapter", "files", "validations", "startedAt", "finishedAt"], issues, "$");
  if (value.contract !== "rb-headless-init/v1") add(issues, "headless.contract", "contract must be rb-headless-init/v1", "$.contract");
  if (value.kind !== "result") add(issues, "headless.kind", "kind must be result", "$.kind");
  id(value.requestId, issues, "$.requestId"); hash(value.requestHash, issues, "$.requestHash"); date(value.startedAt, issues, "$.startedAt"); date(value.finishedAt, issues, "$.finishedAt");
  const ready = value.status === "ready";
  if (!ready && value.status !== "invalid" && value.status !== "failed") add(issues, "headless.status", "status must be ready, invalid, or failed", "$.status");
  const harness = object(value.harness, ["version", "sha256"], ["version", "sha256"], issues, "$.harness"); if (harness) { string(harness.version, issues, "$.harness.version", 100); hash(harness.sha256, issues, "$.harness.sha256"); }
  const adapter = object(value.adapter, ["id", "version", "provider", "model"], ["id", "version", "provider", "model"], issues, "$.adapter"); if (adapter) { id(adapter.id, issues, "$.adapter.id"); string(adapter.version, issues, "$.adapter.version", 100); string(adapter.provider, issues, "$.adapter.provider", 120); string(adapter.model, issues, "$.adapter.model", 160); }
  if (!denseArray(value.files, issues, "$.files") || value.files.length > 2000) add(issues, "headless.files", "files must be an array of at most 2000 items", "$.files"); else {
    const paths = new Set<string>();
    let totalBytes = 0;
    value.files.forEach((entry, index) => { const file = object(entry, ["path", "bytes", "sha256", "mediaType"], ["path", "bytes", "sha256", "mediaType"], issues, `$.files[${index}]`); if (!file) return; path(file.path, issues, `$.files[${index}].path`); if (!Number.isInteger(file.bytes) || Number(file.bytes) < 0 || Number(file.bytes) > 5242880) add(issues, "headless.bytes", "File bytes must be an integer from 0 to 5242880", `$.files[${index}].bytes`); hash(file.sha256, issues, `$.files[${index}].sha256`); string(file.mediaType, issues, `$.files[${index}].mediaType`, 200); });
    value.files.forEach((entry, index) => {
      if (!isObject(entry)) return;
      const collisionKey = normalizedRelativePathKey(entry.path);
      if (collisionKey !== undefined) {
        if (paths.has(collisionKey)) add(issues, "headless.files.duplicate", "File paths must be unique after NFC/case normalization", `$.files[${index}].path`);
        else paths.add(collisionKey);
      }
      if (Number.isInteger(entry.bytes) && Number(entry.bytes) >= 0) totalBytes += Number(entry.bytes);
    });
    if (totalBytes > MAX_OUTPUT_BYTES) add(issues, "headless.files.bytes.aggregate", "Output bytes may total at most 104857600", "$.files");
  }
  if (!denseArray(value.validations, issues, "$.validations") || value.validations.length < 1 || value.validations.length > 7) add(issues, "headless.validations", "validations must contain 1..7 items", "$.validations"); else {
    const names = new Set<string>();
    value.validations.forEach((entry, index) => { const validation = object(entry, ["name", "passed", "exitCode", "diagnosticCode"], ["name", "passed", "exitCode"], issues, `$.validations[${index}]`); if (!validation) return; if (typeof validation.name !== "string" || !VALIDATION_NAMES.has(validation.name)) add(issues, "headless.validation.name", "Unknown validation name", `$.validations[${index}].name`); else if (names.has(validation.name)) add(issues, "headless.validation.duplicate", "Validation names must be unique", `$.validations[${index}].name`); else names.add(validation.name); if (typeof validation.passed !== "boolean") add(issues, "headless.validation.passed", "passed must be boolean", `$.validations[${index}].passed`); if (!Number.isInteger(validation.exitCode)) add(issues, "headless.validation.exit", "exitCode must be an integer", `$.validations[${index}].exitCode`); if ("diagnosticCode" in validation) string(validation.diagnosticCode, issues, `$.validations[${index}].diagnosticCode`, 200, 0); });
    if (ready) { if (!denseArray(value.files, issues, "$.files") || value.files.length === 0) add(issues, "headless.ready.files", "ready requires at least one file", "$.files"); for (const name of VALIDATION_NAMES) if (!names.has(name)) add(issues, "headless.ready.validation.missing", `ready requires ${name} validation`, "$.validations"); value.validations.forEach((validation, index) => { if (isObject(validation) && (validation.passed !== true || validation.exitCode !== 0)) add(issues, "headless.ready.validation.failed", "ready validations must pass with exit code 0", `$.validations[${index}]`); }); }
  }
  if ("diagnosticCode" in value) string(value.diagnosticCode, issues, "$.diagnosticCode", 200, 0);
  if (!ready && denseArray(value.files, issues, "$.files") && value.files.length > 0) add(issues, "headless.nonready.files", "invalid and failed results must not publish file bytes", "$.files");
}

export function validateHeadlessInitValue(value: unknown): HeadlessInitValidation {
  const issues: ValidationIssue[] = [];
  if (!isObject(value)) { add(issues, "headless.root", "Headless contract root must be an object", "$"); return { valid: false, issues }; }
  if (value.kind === "request") request(value, issues); else if (value.kind === "result") result(value, issues); else { keys(value, ["kind"], issues, "$"); add(issues, "headless.kind", "kind must be request or result", "$.kind"); }
  return { valid: issues.length === 0, issues, ...(issues.length === 0 ? { document: value } : {}) };
}

export function validateHeadlessInitJson(source: string): HeadlessInitValidation {
  try { return validateHeadlessInitValue(JSON.parse(source)); } catch (error) { return { valid: false, issues: [{ code: "headless.json", message: error instanceof Error ? error.message : String(error), severity: "error", path: "$" }] }; }
}
