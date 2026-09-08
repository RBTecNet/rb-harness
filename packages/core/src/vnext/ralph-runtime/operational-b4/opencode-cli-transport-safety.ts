import { assertNoCredentialMaterial, RalphCredentialSafetyError } from "../operational-b1/secret-safety.js";
import { RalphM4BError } from "./opencode-cli-contract.js";

const MAX_TRANSPORT_MESSAGES_V2 = 256;
const MAX_TRANSPORT_PARTS_V2 = 256;
const MAX_TRANSPORT_STRING_BYTES_V2 = 512 * 1024;
const MAX_TRANSPORT_VALUE_DEPTH_V2 = 12;
const MAX_TRANSPORT_VALUE_NODES_V2 = 16_384;

const USER_INFO_KEYS = ["id", "sessionID", "role", "time", "format", "summary", "agent", "model", "system", "tools"] as const;
const ASSISTANT_INFO_KEYS = ["id", "sessionID", "role", "time", "error", "parentID", "modelID", "providerID", "mode", "agent", "path", "summary", "cost", "tokens", "structured", "variant", "finish"] as const;
const SESSION_INFO_KEYS = ["id", "slug", "projectID", "workspaceID", "directory", "path", "parentID", "summary", "cost", "tokens", "share", "title", "agent", "model", "version", "metadata", "time", "permission", "revert"] as const;

export interface ValidatedOpenCodeTransportMessageV2 {
  readonly info: Record<string, unknown>;
  readonly parts: readonly unknown[];
}

export interface ValidatedOpenCodeSessionExportV2 {
  readonly info: Record<string, unknown>;
  readonly messages: readonly unknown[];
}

/**
 * Validate the supported OpenCode 1.18.29 public export envelope without ever
 * treating the raw transport tree as a Ralph artifact. Usage accounting is
 * validated at its exact public schema locations and omitted from the generic
 * credential-safety projection.
 */
export function validateOpenCodeSessionExportTransportV2(value: unknown): ValidatedOpenCodeSessionExportV2 {
  const root = requireRecord(value);
  assertExactKeys(root, ["info", "messages"]);
  const info = requireRecord(root.info);
  validateSessionInfo(info);
  if (!Array.isArray(root.messages) || root.messages.length > MAX_TRANSPORT_MESSAGES_V2) invalid();
  for (const message of root.messages) validateOpenCodeTransportMessageV2(message);
  assertCredentialSafeProjection([
    info.id, info.slug, info.projectID, info.workspaceID, info.directory, info.path, info.parentID,
    info.summary, info.cost, info.share, info.title, info.agent, info.model, info.version,
    info.metadata, info.time, info.permission, info.revert,
  ]);
  return Object.freeze({ info, messages: Object.freeze([...root.messages]) });
}

/** Validate one public OpenCode message and its parts before normalization. */
export function validateOpenCodeTransportMessageV2(value: unknown): ValidatedOpenCodeTransportMessageV2 {
  const envelope = requireRecord(value);
  assertExactKeys(envelope, ["info", "parts"]);
  const info = requireRecord(envelope.info);
  if (!Array.isArray(envelope.parts) || envelope.parts.length > MAX_TRANSPORT_PARTS_V2) invalid();
  if (info.role === "user") validateUserInfo(info);
  else if (info.role === "assistant") validateAssistantInfo(info);
  else invalid();

  const projectedValues: unknown[] = [];
  projectMessageInfo(info, projectedValues);
  for (const part of envelope.parts) validateAndProjectPart(part, info, projectedValues);
  assertCredentialSafeProjection(projectedValues);
  return Object.freeze({ info, parts: Object.freeze([...envelope.parts]) });
}

function validateSessionInfo(info: Record<string, unknown>): void {
  assertExactKeys(info, SESSION_INFO_KEYS);
  for (const key of ["id", "slug", "projectID", "directory", "title", "version"] as const) assertString(info[key]);
  for (const key of ["workspaceID", "path", "parentID", "agent"] as const) if (info[key] !== undefined) assertString(info[key]);
  if (info.summary !== undefined) validateSessionSummary(info.summary);
  if (info.cost !== undefined) assertNonNegativeNumber(info.cost);
  if (info.tokens !== undefined) validateUsage(info.tokens, false);
  if (info.share !== undefined) {
    const share = requireRecord(info.share); assertExactKeys(share, ["url"]); assertString(share.url);
  }
  if (info.model !== undefined) validateModel(info.model, "id");
  if (info.metadata !== undefined) validateBoundedJson(info.metadata);
  validateTime(info.time, ["created", "updated", "compacting", "archived"], ["created", "updated"]);
  if (info.permission !== undefined) {
    if (!Array.isArray(info.permission) || info.permission.length > 256) invalid();
    for (const candidate of info.permission) {
      const rule = requireRecord(candidate); assertExactKeys(rule, ["permission", "pattern", "action"]);
      assertString(rule.permission); assertString(rule.pattern);
      if (!(["allow", "deny", "ask"] as const).includes(rule.action as "allow")) invalid();
    }
  }
  if (info.revert !== undefined) {
    const revert = requireRecord(info.revert); assertExactKeys(revert, ["messageID", "partID", "snapshot", "diff"]);
    assertString(revert.messageID);
    for (const key of ["partID", "snapshot", "diff"] as const) if (revert[key] !== undefined) assertString(revert[key]);
  }
}

function validateUserInfo(info: Record<string, unknown>): void {
  assertExactKeys(info, USER_INFO_KEYS);
  assertString(info.id); assertString(info.sessionID);
  validateTime(info.time, ["created"], ["created"]);
  if (info.format !== undefined) validateOutputFormat(info.format);
  if (info.summary !== undefined) validateUserSummary(info.summary);
  if (info.agent !== undefined) assertString(info.agent);
  if (info.model !== undefined) validateModel(info.model, "modelID");
  if (info.system !== undefined) assertString(info.system);
  if (info.tools !== undefined) {
    const tools = requireRecord(info.tools);
    const allowed = new Set(["read", "glob", "grep", "list", "edit", "write", "apply_patch", "bash", "task", "webfetch", "websearch"]);
    if (Object.keys(tools).some((key) => !allowed.has(key)) || Object.values(tools).some((enabled) => typeof enabled !== "boolean")) invalid();
  }
}

function validateAssistantInfo(info: Record<string, unknown>): void {
  assertExactKeys(info, ASSISTANT_INFO_KEYS);
  for (const key of ["id", "sessionID", "parentID", "modelID", "providerID"] as const) assertString(info[key]);
  if (info.time !== undefined) validateTime(info.time, ["created", "completed"], ["created"]);
  if (info.error !== undefined) validateProviderError(info.error);
  for (const key of ["mode", "agent", "variant", "finish"] as const) if (info[key] !== undefined) assertString(info[key]);
  if (info.path !== undefined) {
    const path = requireRecord(info.path); assertExactKeys(path, ["cwd", "root"]); assertString(path.cwd); assertString(path.root);
  }
  if (info.summary !== undefined && typeof info.summary !== "boolean") invalid();
  if (info.cost !== undefined) assertNonNegativeNumber(info.cost);
  if (info.tokens !== undefined) validateUsage(info.tokens, true);
  if (info.structured !== undefined) validateBoundedJson(info.structured);
}

function projectMessageInfo(info: Record<string, unknown>, values: unknown[]): void {
  if (info.role === "user") {
    values.push(info.id, info.sessionID, info.time, info.format, info.summary, info.agent, info.model, info.system, info.tools);
    return;
  }
  // Deliberately omit only the validated assistant usage-accounting object.
  values.push(info.id, info.sessionID, info.time, info.error, info.parentID, info.modelID, info.providerID,
    info.mode, info.agent, info.path, info.summary, info.cost, info.structured, info.variant, info.finish);
}

function validateAndProjectPart(value: unknown, messageInfo: Record<string, unknown>, projectedValues: unknown[]): void {
  const part = requireRecord(value);
  const type = part.type;
  if (typeof type !== "string") invalid();
  const common = (): void => {
    assertString(part.id); assertString(part.sessionID); assertString(part.messageID);
    if (part.sessionID !== messageInfo.sessionID || part.messageID !== messageInfo.id) invalid();
  };
  switch (type) {
    case "text":
      assertExactKeys(part, ["id", "sessionID", "messageID", "type", "text", "synthetic", "ignored", "time", "metadata"]);
      common(); assertString(part.text);
      if (part.synthetic !== undefined && typeof part.synthetic !== "boolean") invalid();
      if (part.ignored !== undefined && typeof part.ignored !== "boolean") invalid();
      if (part.time !== undefined) validateTime(part.time, ["start", "end"], ["start"]);
      if (part.metadata !== undefined) validateBoundedJson(part.metadata);
      projectedValues.push(part.text, part.metadata); return;
    case "reasoning":
      assertExactKeys(part, ["id", "sessionID", "messageID", "type", "text", "metadata", "time"]);
      common(); assertString(part.text); validateTime(part.time, ["start", "end"], ["start"]);
      if (part.metadata !== undefined) validateBoundedJson(part.metadata);
      projectedValues.push(part.text, part.metadata); return;
    case "tool":
      assertExactKeys(part, ["id", "sessionID", "messageID", "type", "callID", "tool", "state", "metadata"]);
      common(); assertString(part.callID); assertString(part.tool);
      if (part.metadata !== undefined) validateBoundedJson(part.metadata);
      validateAndProjectToolState(part.state, projectedValues);
      projectedValues.push(part.tool, part.metadata); return;
    case "step-start":
      assertExactKeys(part, ["id", "sessionID", "messageID", "type", "snapshot"]);
      common(); if (part.snapshot !== undefined) assertString(part.snapshot);
      projectedValues.push(part.snapshot); return;
    case "step-finish":
      assertExactKeys(part, ["id", "sessionID", "messageID", "type", "reason", "snapshot", "cost", "tokens"]);
      common(); assertString(part.reason); if (part.snapshot !== undefined) assertString(part.snapshot);
      assertNonNegativeNumber(part.cost); validateUsage(part.tokens, true);
      // `tokens` is public numeric bookkeeping at this exact path; it is
      // validated above and intentionally omitted from the generic scan.
      projectedValues.push(part.reason, part.snapshot, part.cost); return;
    case "snapshot":
      assertExactKeys(part, ["id", "sessionID", "messageID", "type", "snapshot"]);
      common(); assertString(part.snapshot); projectedValues.push(part.snapshot); return;
    case "patch":
      assertExactKeys(part, ["id", "sessionID", "messageID", "type", "hash", "files"]);
      common(); assertString(part.hash); assertStringArray(part.files); projectedValues.push(part.hash, part.files); return;
    case "agent":
      assertExactKeys(part, ["id", "sessionID", "messageID", "type", "name", "source"]);
      common(); assertString(part.name);
      if (part.source !== undefined) validateSourceText(part.source);
      projectedValues.push(part.name, part.source); return;
    case "subtask":
      assertExactKeys(part, ["id", "sessionID", "messageID", "type", "prompt", "description", "agent", "model", "command"]);
      common(); assertString(part.prompt); assertString(part.description); assertString(part.agent);
      if (part.model !== undefined) validateModel(part.model, "modelID");
      if (part.command !== undefined) assertString(part.command);
      projectedValues.push(part.prompt, part.description, part.agent, part.model, part.command); return;
    case "retry":
      assertExactKeys(part, ["id", "sessionID", "messageID", "type", "attempt", "error", "time"]);
      common(); assertNonNegativeInteger(part.attempt); validateProviderError(part.error);
      validateTime(part.time, ["created"], ["created"]); projectedValues.push(part.error); return;
    case "compaction":
      assertExactKeys(part, ["id", "sessionID", "messageID", "type", "auto", "overflow", "tail_start_id"]);
      common(); if (typeof part.auto !== "boolean") invalid();
      if (part.overflow !== undefined && typeof part.overflow !== "boolean") invalid();
      if (part.tail_start_id !== undefined) assertString(part.tail_start_id);
      projectedValues.push(part.tail_start_id); return;
    case "file":
      assertExactKeys(part, ["id", "sessionID", "messageID", "type", "mime", "filename", "url", "source"]);
      common(); assertString(part.mime); if (part.filename !== undefined) assertString(part.filename); assertString(part.url);
      if (part.source !== undefined) validateFileSource(part.source);
      projectedValues.push(part.mime, part.filename, part.url, part.source); return;
    default:
      invalid();
  }
}

function validateAndProjectToolState(value: unknown, projectedValues: unknown[]): void {
  const state = requireRecord(value);
  switch (state.status) {
    case "pending":
      assertExactKeys(state, ["status", "input", "raw"]); validateBoundedJson(state.input); assertString(state.raw);
      projectedValues.push(state.input, state.raw); return;
    case "running":
      assertExactKeys(state, ["status", "input", "title", "metadata", "time"]); validateBoundedJson(state.input);
      if (state.title !== undefined) assertString(state.title); if (state.metadata !== undefined) validateBoundedJson(state.metadata);
      validateTime(state.time, ["start"], ["start"]); projectedValues.push(state.input, state.title, state.metadata); return;
    case "completed":
      assertExactKeys(state, ["status", "input", "output", "title", "metadata", "time", "attachments"]);
      validateBoundedJson(state.input); assertString(state.output); assertString(state.title); validateBoundedJson(state.metadata);
      validateTime(state.time, ["start", "end", "compacted"], ["start", "end"]);
      if (state.attachments !== undefined) {
        if (!Array.isArray(state.attachments) || state.attachments.length > 64) invalid();
        for (const attachment of state.attachments) validateStandaloneFilePart(attachment, projectedValues);
      }
      projectedValues.push(state.input, state.output, state.title, state.metadata); return;
    case "error":
      assertExactKeys(state, ["status", "input", "error", "metadata", "time"]); validateBoundedJson(state.input); assertString(state.error);
      if (state.metadata !== undefined) validateBoundedJson(state.metadata);
      validateTime(state.time, ["start", "end"], ["start", "end"]); projectedValues.push(state.input, state.error, state.metadata); return;
    default:
      invalid();
  }
}

function validateStandaloneFilePart(value: unknown, projectedValues: unknown[]): void {
  const part = requireRecord(value);
  assertExactKeys(part, ["id", "sessionID", "messageID", "type", "mime", "filename", "url", "source"]);
  if (part.type !== "file") invalid();
  for (const key of ["id", "sessionID", "messageID", "mime", "url"] as const) assertString(part[key]);
  if (part.filename !== undefined) assertString(part.filename);
  if (part.source !== undefined) validateFileSource(part.source);
  projectedValues.push(part.mime, part.filename, part.url, part.source);
}

function validateFileSource(value: unknown): void {
  const source = requireRecord(value);
  if (source.type === "file") {
    assertExactKeys(source, ["text", "type", "path"]); validateSourceText(source.text); assertString(source.path); return;
  }
  if (source.type === "symbol") {
    assertExactKeys(source, ["text", "type", "path", "range", "name", "kind"]); validateSourceText(source.text);
    assertString(source.path); validateRange(source.range); assertString(source.name); assertNonNegativeInteger(source.kind); return;
  }
  if (source.type === "resource") {
    assertExactKeys(source, ["text", "type", "clientName", "uri"]); validateSourceText(source.text); assertString(source.clientName); assertString(source.uri); return;
  }
  invalid();
}

function validateSourceText(value: unknown): void {
  const text = requireRecord(value); assertExactKeys(text, ["value", "start", "end"]);
  assertString(text.value); assertNonNegativeInteger(text.start); assertNonNegativeInteger(text.end);
  if (Number(text.end) < Number(text.start)) invalid();
}

function validateRange(value: unknown): void {
  const range = requireRecord(value); assertExactKeys(range, ["start", "end"]);
  for (const endpoint of [range.start, range.end]) {
    const point = requireRecord(endpoint); assertExactKeys(point, ["line", "character"]);
    assertNonNegativeInteger(point.line); assertNonNegativeInteger(point.character);
  }
}

function validateProviderError(value: unknown): void {
  const error = requireRecord(value); assertExactKeys(error, ["name", "data"]); assertString(error.name);
  const data = requireRecord(error.data);
  switch (error.name) {
    case "ProviderAuthError": assertExactKeys(data, ["providerID", "message"]); assertString(data.providerID); assertString(data.message); return;
    case "UnknownError": assertExactKeys(data, ["message", "ref"]); assertString(data.message); if (data.ref !== undefined) assertString(data.ref); return;
    case "MessageOutputLengthError": validateBoundedJson(data); return;
    case "MessageAbortedError": assertExactKeys(data, ["message"]); assertString(data.message); return;
    case "StructuredOutputError": assertExactKeys(data, ["message", "retries"]); assertString(data.message); assertNonNegativeInteger(data.retries); return;
    case "ContextOverflowError": assertExactKeys(data, ["message", "responseBody"]); assertString(data.message); if (data.responseBody !== undefined) assertString(data.responseBody); return;
    case "ContentFilterError": assertExactKeys(data, ["message"]); assertString(data.message); return;
    case "APIError":
      assertExactKeys(data, ["message", "statusCode", "isRetryable", "responseHeaders", "responseBody", "metadata"]);
      assertString(data.message); if (data.statusCode !== undefined) assertNonNegativeInteger(data.statusCode);
      if (typeof data.isRetryable !== "boolean") invalid();
      if (data.responseHeaders !== undefined) validateStringRecord(data.responseHeaders);
      if (data.responseBody !== undefined) assertString(data.responseBody);
      if (data.metadata !== undefined) validateStringRecord(data.metadata);
      return;
    default: invalid();
  }
}

function validateUsage(value: unknown, allowTotal: boolean): void {
  const usage = requireRecord(value);
  assertExactKeys(usage, allowTotal ? ["total", "input", "output", "reasoning", "cache"] : ["input", "output", "reasoning", "cache"]);
  if (allowTotal && usage.total !== undefined) assertNonNegativeInteger(usage.total);
  for (const key of ["input", "output", "reasoning"] as const) assertNonNegativeInteger(usage[key]);
  const cache = requireRecord(usage.cache); assertExactKeys(cache, ["read", "write"]);
  assertNonNegativeInteger(cache.read); assertNonNegativeInteger(cache.write);
}

function validateModel(value: unknown, idKey: "id" | "modelID"): void {
  const model = requireRecord(value); assertExactKeys(model, ["providerID", idKey, "variant"]);
  assertString(model.providerID); assertString(model[idKey]); if (model.variant !== undefined) assertString(model.variant);
}

function validateTime(value: unknown, allowed: readonly string[], required: readonly string[]): void {
  const time = requireRecord(value); assertExactKeys(time, allowed);
  for (const key of required) assertNonNegativeInteger(time[key]);
  for (const key of allowed) if (time[key] !== undefined) assertNonNegativeInteger(time[key]);
}

function validateOutputFormat(value: unknown): void {
  const format = requireRecord(value);
  if (format.type === "text") { assertExactKeys(format, ["type"]); return; }
  if (format.type === "json_schema") {
    assertExactKeys(format, ["type", "schema", "retryCount"]); validateBoundedJson(format.schema);
    if (format.retryCount !== undefined) assertNonNegativeInteger(format.retryCount); return;
  }
  invalid();
}

function validateSessionSummary(value: unknown): void {
  const summary = requireRecord(value); assertExactKeys(summary, ["additions", "deletions", "files", "diffs"]);
  assertNonNegativeInteger(summary.additions); assertNonNegativeInteger(summary.deletions); assertNonNegativeInteger(summary.files);
  if (summary.diffs !== undefined) validateDiffs(summary.diffs);
}

function validateUserSummary(value: unknown): void {
  const summary = requireRecord(value); assertExactKeys(summary, ["title", "body", "diffs"]);
  if (summary.title !== undefined) assertString(summary.title); if (summary.body !== undefined) assertString(summary.body);
  validateDiffs(summary.diffs);
}

function validateDiffs(value: unknown): void {
  if (!Array.isArray(value) || value.length > 256) invalid();
  for (const candidate of value) {
    const diff = requireRecord(candidate); assertExactKeys(diff, ["file", "patch", "additions", "deletions", "status"]);
    if (diff.file !== undefined) assertString(diff.file); if (diff.patch !== undefined) assertString(diff.patch);
    assertNonNegativeInteger(diff.additions); assertNonNegativeInteger(diff.deletions);
    if (diff.status !== undefined && !(["added", "deleted", "modified"] as const).includes(diff.status as "added")) invalid();
  }
}

function validateStringRecord(value: unknown): void {
  const candidate = requireRecord(value);
  for (const child of Object.values(candidate)) assertString(child);
}

function validateBoundedJson(value: unknown): void {
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_TRANSPORT_VALUE_NODES_V2 || depth > MAX_TRANSPORT_VALUE_DEPTH_V2) invalid();
    if (candidate === null || typeof candidate === "boolean") return;
    if (typeof candidate === "string") { assertString(candidate); return; }
    if (typeof candidate === "number") { if (!Number.isFinite(candidate)) invalid(); return; }
    if (Array.isArray(candidate)) { for (const child of candidate) visit(child, depth + 1); return; }
    if (typeof candidate !== "object") invalid();
    for (const child of Object.values(candidate as Record<string, unknown>)) visit(child, depth + 1);
  };
  visit(value, 0);
}

function assertCredentialSafeProjection(values: readonly unknown[]): void {
  try { assertNoCredentialMaterial({ transportValues: values }, "M4B_PROVIDER_CREDENTIAL_MATERIAL"); }
  catch (error) {
    if (error instanceof RalphCredentialSafetyError) throw new RalphM4BError("M4B_PROVIDER_CREDENTIAL_MATERIAL", undefined, error);
    throw error;
  }
}

function assertStringArray(value: unknown): void {
  if (!Array.isArray(value) || value.length > 256) invalid();
  for (const candidate of value) assertString(candidate);
}

function assertString(value: unknown): void {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_TRANSPORT_STRING_BYTES_V2 || value.includes("\0")) invalid();
}

function assertNonNegativeInteger(value: unknown): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid();
}

function assertNonNegativeNumber(value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) invalid();
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const keys = new Set(allowed);
  if (Object.keys(value).some((key) => !keys.has(key))) invalid();
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function invalid(): never {
  throw new RalphM4BError("M4B_PROVIDER_RESULT_INVALID");
}
