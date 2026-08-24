import { isIsoDateTime, validateHeadlessInitValue, type HeadlessInitDocument } from "./headless-contract.js";
import type { ValidationIssue } from "./types.js";

export const HEADLESS_INTERVIEW_CONTRACT = "rb-headless-interview/v1" as const;
export type HeadlessInterviewDocument = Record<string, unknown>;

export interface HeadlessInterviewValidation {
  valid: boolean;
  issues: ValidationIssue[];
  document?: HeadlessInterviewDocument;
}

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DISPOSITIONS = new Set(["accepted", "partial", "ambiguous", "deferred", "contradicted"]);
const STATUSES = new Set(["active", "complete", "invalid", "failed"]);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function add(issues: ValidationIssue[], code: string, message: string, path: string): void {
  issues.push({ code, message, severity: "error", path });
}

function exact(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  issues: ValidationIssue[],
  path: string,
): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) add(issues, "headless.interview.property.unknown", `Unknown property ${key}`, `${path}.${key}`);
  for (const key of required) if (!(key in value)) add(issues, "headless.interview.property.required", `Missing required property ${key}`, `${path}.${key}`);
}

function text(value: unknown, issues: ValidationIssue[], path: string, min = 1, max = 10_000): value is string {
  const length = typeof value === "string" ? Array.from(value).length : -1;
  if (length < min || length > max) {
    add(issues, "headless.interview.string", `Expected a string with length ${min}..${max}`, path);
    return false;
  }
  return true;
}

function id(value: unknown, issues: ValidationIssue[], path: string, max = 200): value is string {
  return text(value, issues, path, 1, max) && ID.test(value) || (add(issues, "headless.interview.id", "Invalid identifier", path), false);
}

function hash(value: unknown, issues: ValidationIssue[], path: string): value is string {
  if (typeof value !== "string" || !HASH.test(value)) {
    add(issues, "headless.interview.sha256", "Expected a lowercase SHA-256 hash", path);
    return false;
  }
  return true;
}

function sequence(value: unknown, issues: ValidationIssue[], path: string): value is number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 1_000_000) {
    add(issues, "headless.interview.sequence", "sequence must be an integer from 1 to 1000000", path);
    return false;
  }
  return true;
}

function nullableHash(value: unknown, issues: ValidationIssue[], path: string): void {
  if (value !== null) hash(value, issues, path);
}

function acceptedAnswer(value: unknown, issues: ValidationIssue[], path: string): void {
  if (!object(value)) return add(issues, "headless.interview.object", "Expected an object", path);
  exact(value, ["questionId", "question", "answer", "disposition"], ["questionId", "question", "answer", "disposition"], issues, path);
  id(value.questionId, issues, `${path}.questionId`, 80);
  text(value.question, issues, `${path}.question`, 1, 4_000);
  text(value.answer, issues, `${path}.answer`, 1, 10_000);
  if (value.disposition !== "accepted") add(issues, "headless.interview.answer.disposition", "Accepted answer disposition must be accepted", `${path}.disposition`);
}

function questionEvent(value: Record<string, unknown>, issues: ValidationIssue[], path: string): void {
  exact(value,
    ["kind", "sequence", "questionId", "header", "reason", "question", "type", "options", "allowsFreeText", "draftSchemaHash", "answerFor"],
    ["kind", "sequence", "questionId", "header", "reason", "question", "type", "options", "allowsFreeText", "draftSchemaHash"],
    issues, path);
  sequence(value.sequence, issues, `${path}.sequence`);
  id(value.questionId, issues, `${path}.questionId`, 80);
  text(value.header, issues, `${path}.header`, 1, 120);
  text(value.reason, issues, `${path}.reason`, 1, 4_000);
  text(value.question, issues, `${path}.question`, 1, 4_000);
  if (!new Set(["text", "single-choice", "confirm"]).has(String(value.type))) add(issues, "headless.interview.question.type", "Invalid question type", `${path}.type`);
  if (!Array.isArray(value.options) || value.options.length > 6) add(issues, "headless.interview.question.options", "options must be an array with at most six entries", `${path}.options`);
  else {
    const ids = new Set<string>();
    let recommended = 0;
    value.options.forEach((entry, index) => {
      const optionPath = `${path}.options[${index}]`;
      if (!object(entry)) return add(issues, "headless.interview.object", "Expected an object", optionPath);
      exact(entry, ["id", "label", "recommended"], ["id", "label", "recommended"], issues, optionPath);
      if (id(entry.id, issues, `${optionPath}.id`, 80)) {
        if (ids.has(entry.id)) add(issues, "headless.interview.question.option.duplicate", "Option IDs must be unique", `${optionPath}.id`);
        ids.add(entry.id);
      }
      text(entry.label, issues, `${optionPath}.label`, 1, 1_000);
      if (typeof entry.recommended !== "boolean") add(issues, "headless.interview.question.option.recommended", "recommended must be boolean", `${optionPath}.recommended`);
      else if (entry.recommended) recommended += 1;
    });
    if (value.type === "single-choice" && value.options.length < 2) add(issues, "headless.interview.question.options", "single-choice requires 2..6 options", `${path}.options`);
    if (value.type !== "single-choice" && value.options.length > 0) add(issues, "headless.interview.question.options", "Only single-choice may declare options", `${path}.options`);
    if (recommended > 1) add(issues, "headless.interview.question.recommendation", "At most one option may be recommended", `${path}.options`);
  }
  if (typeof value.allowsFreeText !== "boolean") add(issues, "headless.interview.question.freeText", "allowsFreeText must be boolean", `${path}.allowsFreeText`);
  hash(value.draftSchemaHash, issues, `${path}.draftSchemaHash`);
  if (value.answerFor !== undefined) id(value.answerFor, issues, `${path}.answerFor`, 80);
}

function answerResultEvent(value: Record<string, unknown>, issues: ValidationIssue[], path: string): void {
  exact(value,
    ["kind", "sequence", "questionId", "disposition", "normalizedDecision", "remainingUncertainty", "followUpQuestionId"],
    ["kind", "sequence", "questionId", "disposition"], issues, path);
  sequence(value.sequence, issues, `${path}.sequence`);
  id(value.questionId, issues, `${path}.questionId`, 80);
  const disposition = String(value.disposition);
  if (!DISPOSITIONS.has(disposition)) add(issues, "headless.interview.answer.disposition", "Invalid answer disposition", `${path}.disposition`);
  if (disposition === "accepted") {
    text(value.normalizedDecision, issues, `${path}.normalizedDecision`, 1, 10_000);
    if (value.remainingUncertainty !== undefined || value.followUpQuestionId !== undefined) add(issues, "headless.interview.answer.accepted", "Accepted answers cannot retain uncertainty or follow-up", path);
  } else {
    if (value.normalizedDecision !== undefined) add(issues, "headless.interview.answer.normalized", "Only accepted answers may contain normalizedDecision", `${path}.normalizedDecision`);
    if (["partial", "ambiguous", "contradicted"].includes(disposition)) {
      text(value.remainingUncertainty, issues, `${path}.remainingUncertainty`, 1, 10_000);
      id(value.followUpQuestionId, issues, `${path}.followUpQuestionId`, 80);
    }
  }
}

function completeEvent(value: Record<string, unknown>, issues: ValidationIssue[], path: string): void {
  exact(value, ["kind", "acceptedAnswers", "transcriptHash"], ["kind", "acceptedAnswers", "transcriptHash"], issues, path);
  if (!Array.isArray(value.acceptedAnswers) || value.acceptedAnswers.length > 100) add(issues, "headless.interview.answers", "acceptedAnswers must contain at most 100 entries", `${path}.acceptedAnswers`);
  else value.acceptedAnswers.forEach((entry, index) => acceptedAnswer(entry, issues, `${path}.acceptedAnswers[${index}]`));
  hash(value.transcriptHash, issues, `${path}.transcriptHash`);
}

function failedEvent(value: Record<string, unknown>, issues: ValidationIssue[], path: string): void {
  exact(value, ["kind", "diagnosticCode", "retryable"], ["kind", "diagnosticCode", "retryable"], issues, path);
  text(value.diagnosticCode, issues, `${path}.diagnosticCode`, 1, 200);
  if (typeof value.retryable !== "boolean") add(issues, "headless.interview.failed.retryable", "retryable must be boolean", `${path}.retryable`);
}

function startRequest(value: Record<string, unknown>, issues: ValidationIssue[]): void {
  exact(value, ["contract", "kind", "requestId", "captureHash", "initRequest", "cursor"], ["contract", "kind", "requestId", "captureHash", "initRequest", "cursor"], issues, "$");
  id(value.requestId, issues, "$.requestId");
  hash(value.captureHash, issues, "$.captureHash");
  nullableHash(value.cursor, issues, "$.cursor");
  const init = validateHeadlessInitValue(value.initRequest);
  for (const issue of init.issues) {
    const nestedPath = issue.path ?? "$";
    issues.push({ ...issue, code: `headless.interview.init.${issue.code}`, path: `$.initRequest${nestedPath === "$" ? "" : nestedPath.slice(1)}` });
  }
  if (object(value.initRequest) && value.initRequest.kind !== "request") add(issues, "headless.interview.init.kind", "initRequest must be a request", "$.initRequest.kind");
}

function answerRequest(value: Record<string, unknown>, issues: ValidationIssue[]): void {
  exact(value,
    ["contract", "kind", "requestId", "interviewId", "sequence", "questionId", "answer", "idempotencyKey", "cursor"],
    ["contract", "kind", "requestId", "interviewId", "sequence", "questionId", "answer", "idempotencyKey", "cursor"], issues, "$");
  id(value.requestId, issues, "$.requestId");
  id(value.interviewId, issues, "$.interviewId");
  sequence(value.sequence, issues, "$.sequence");
  id(value.questionId, issues, "$.questionId", 80);
  text(value.answer, issues, "$.answer", 1, 10_000);
  id(value.idempotencyKey, issues, "$.idempotencyKey");
  hash(value.cursor, issues, "$.cursor");
}

function response(value: Record<string, unknown>, issues: ValidationIssue[]): void {
  exact(value,
    ["contract", "kind", "requestId", "requestHash", "status", "interviewId", "cursor", "events", "harness", "adapter", "diagnosticCode", "startedAt", "finishedAt"],
    ["contract", "kind", "requestId", "requestHash", "status", "interviewId", "cursor", "events", "harness", "adapter", "startedAt", "finishedAt"], issues, "$");
  id(value.requestId, issues, "$.requestId");
  hash(value.requestHash, issues, "$.requestHash");
  if (!STATUSES.has(String(value.status))) add(issues, "headless.interview.status", "Invalid response status", "$.status");
  if (value.interviewId !== null) id(value.interviewId, issues, "$.interviewId");
  nullableHash(value.cursor, issues, "$.cursor");
  if (!Array.isArray(value.events) || value.events.length < 1 || value.events.length > 2) add(issues, "headless.interview.events", "events must contain one or two entries", "$.events");
  else value.events.forEach((entry, index) => {
    const path = `$.events[${index}]`;
    if (!object(entry)) return add(issues, "headless.interview.object", "Expected an object", path);
    if (entry.kind === "question") questionEvent(entry, issues, path);
    else if (entry.kind === "answer_result") answerResultEvent(entry, issues, path);
    else if (entry.kind === "interview_complete") completeEvent(entry, issues, path);
    else if (entry.kind === "interview_failed") failedEvent(entry, issues, path);
    else add(issues, "headless.interview.event.kind", "Invalid event kind", `${path}.kind`);
  });
  for (const [key, limit] of [["harness", 100], ["adapter", 200]] as const) {
    const nested = value[key];
    if (!object(nested)) { add(issues, "headless.interview.object", "Expected an object", `$.${key}`); continue; }
    const fields = key === "harness" ? ["version", "sha256"] : ["id", "version", "provider", "model"];
    exact(nested, fields, fields, issues, `$.${key}`);
    if (key === "harness") { text(nested.version, issues, "$.harness.version", 1, limit); hash(nested.sha256, issues, "$.harness.sha256"); }
    else { id(nested.id, issues, "$.adapter.id"); text(nested.version, issues, "$.adapter.version", 1, 100); text(nested.provider, issues, "$.adapter.provider", 1, 120); text(nested.model, issues, "$.adapter.model", 1, 160); }
  }
  if (!isIsoDateTime(value.startedAt)) add(issues, "headless.interview.date", "startedAt must be an ISO date-time", "$.startedAt");
  if (!isIsoDateTime(value.finishedAt)) add(issues, "headless.interview.date", "finishedAt must be an ISO date-time", "$.finishedAt");
  if (value.diagnosticCode !== undefined) text(value.diagnosticCode, issues, "$.diagnosticCode", 0, 200);
  if (value.status === "active" && !(value.events as unknown[] | undefined)?.some((event) => object(event) && event.kind === "question")) add(issues, "headless.interview.active.question", "active responses require one question event", "$.events");
  if (value.status === "complete" && !(value.events as unknown[] | undefined)?.some((event) => object(event) && event.kind === "interview_complete")) add(issues, "headless.interview.complete.event", "complete responses require interview_complete", "$.events");
  if (["invalid", "failed"].includes(String(value.status)) && !(value.events as unknown[] | undefined)?.some((event) => object(event) && event.kind === "interview_failed")) add(issues, "headless.interview.failed.event", "failed responses require interview_failed", "$.events");
}

export function validateHeadlessInterviewValue(value: unknown): HeadlessInterviewValidation {
  const issues: ValidationIssue[] = [];
  if (!object(value)) {
    add(issues, "headless.interview.root", "Headless interview root must be an object", "$");
    return { valid: false, issues };
  }
  if (value.contract !== HEADLESS_INTERVIEW_CONTRACT) add(issues, "headless.interview.contract", `contract must be ${HEADLESS_INTERVIEW_CONTRACT}`, "$.contract");
  if (value.kind === "interview_start") startRequest(value, issues);
  else if (value.kind === "answer") answerRequest(value, issues);
  else if (value.kind === "response") response(value, issues);
  else add(issues, "headless.interview.kind", "kind must be interview_start, answer, or response", "$.kind");
  return { valid: issues.length === 0, issues, ...(issues.length === 0 ? { document: value } : {}) };
}

export function validateHeadlessInterviewJson(source: string): HeadlessInterviewValidation {
  try {
    return validateHeadlessInterviewValue(JSON.parse(source));
  } catch (error) {
    return { valid: false, issues: [{ code: "headless.interview.json", message: error instanceof Error ? error.message : String(error), severity: "error", path: "$" }] };
  }
}

export function headlessInterviewInitRequest(document: HeadlessInterviewDocument): HeadlessInitDocument | undefined {
  return document.kind === "interview_start" && object(document.initRequest) ? document.initRequest : undefined;
}
