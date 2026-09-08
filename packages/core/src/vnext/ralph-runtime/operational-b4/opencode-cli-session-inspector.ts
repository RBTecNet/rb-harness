import { resolve } from "node:path";
import { canonicalJson } from "../canonical-json.js";
import { sha256Canonical } from "../hashing.js";
import type { RalphEventStoreV2 } from "../operational-b1/index.js";
import { SpawnOpenCodeProcess, type OpenCodeProcess } from "../../providers/opencode/cli-adapter.js";
import {
  OPENCODE_CLI_EXECUTOR_MODEL_ID_V2,
  OPENCODE_CLI_EXECUTOR_MODEL_V2,
  OPENCODE_CLI_EXECUTOR_PROVIDER_V2,
  OPENCODE_CLI_EXECUTOR_TRANSPORT_VERSION_V2,
  RalphM4BError,
} from "./opencode-cli-contract.js";
import { openCodeM4BChildEnvironment, openCodeM4BPermissionRulesV2 } from "./opencode-cli-process.js";
import {
  validateOpenCodeSessionExportTransportV2,
  validateOpenCodeTransportMessageV2,
  type ValidatedOpenCodeSessionExportV2,
} from "./opencode-cli-transport-safety.js";
import { digestObservableOpenCodeTurnV2 } from "./opencode-cli-observable-turn.js";
import type {
  OpenCodeCliSessionInspectionInputV2,
  OpenCodeCliSessionInspectorV2,
  OpenCodeCliSessionObservationV2,
} from "./opencode-cli-observer.js";
import {
  openCodeProviderResultRefV2,
  readOpenCodeProviderResultV2,
  type OpenCodeProviderResultV2,
} from "./opencode-cli-result.js";

export const MAX_OPENCODE_HTTP_RESPONSE_BYTES_V2 = 2 * 1024 * 1024;

export interface OpenCodeSessionRecordV2 {
  readonly id: string;
  readonly directory: string;
  readonly version: string;
  readonly modelSelector: string;
}

export interface OpenCodeAssistantResultV2 {
  readonly assistantMessageId: string;
  readonly sessionId: string;
  readonly userMessageId: string;
  readonly modelSelector: string;
  readonly classification: "SUCCEEDED" | "FAILED";
  readonly parts: readonly unknown[];
  readonly assistantContentDigest: string;
  readonly responseDigest: string;
  readonly observableTurnDigest: string | null;
  readonly raw: unknown;
}

export interface ReadSanitizedOpenCodeSessionExportOptionsV2 {
  readonly projectRoot: string;
  readonly executablePath: string;
  readonly deadlineMs: number;
  readonly processClient?: OpenCodeProcess;
  readonly signal?: AbortSignal;
}

export class OpenCodeCliHttpClientV2 {
  private readonly baseUrl: string;
  private readonly projectRoot: string;
  private readonly deadlineMs: number;

  constructor(input: { readonly baseUrl: string; readonly projectRoot: string; readonly deadlineMs: number }) {
    if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(input.baseUrl)) throw new RalphM4BError("M4B_SERVER_START_FAILED");
    if (resolve(input.projectRoot) !== input.projectRoot || !Number.isSafeInteger(input.deadlineMs) || input.deadlineMs < 1) throw new RalphM4BError("M4B_WORKSPACE_BINDING_INVALID");
    this.baseUrl = input.baseUrl;
    this.projectRoot = input.projectRoot;
    this.deadlineMs = input.deadlineMs;
    Object.freeze(this);
  }

  async health(signal?: AbortSignal): Promise<string> {
    const value = record(await this.request("GET", "/global/health", undefined, signal, false));
    if (value.healthy !== true || typeof value.version !== "string") throw new RalphM4BError("M4B_SERVER_START_FAILED");
    return value.version;
  }

  async createSession(input: { readonly title: string }, signal?: AbortSignal): Promise<OpenCodeSessionRecordV2> {
    const value = await this.request("POST", "/session", {
      title: input.title,
      agent: "build",
      model: { providerID: OPENCODE_CLI_EXECUTOR_PROVIDER_V2, id: OPENCODE_CLI_EXECUTOR_MODEL_ID_V2 },
      permission: openCodeM4BPermissionRulesV2(),
    }, signal);
    return parseSession(value, this.projectRoot);
  }

  async getSession(sessionId: string, signal?: AbortSignal): Promise<OpenCodeSessionRecordV2> {
    assertSessionId(sessionId);
    return parseSession(await this.request("GET", `/session/${encodeURIComponent(sessionId)}`, undefined, signal), this.projectRoot);
  }

  async listMessages(sessionId: string, signal?: AbortSignal): Promise<readonly unknown[]> {
    assertSessionId(sessionId);
    const value = await this.request("GET", `/session/${encodeURIComponent(sessionId)}/message`, undefined, signal);
    if (!Array.isArray(value)) throw new RalphM4BError("M4B_PROVIDER_RESULT_INVALID");
    return value;
  }

  async sendPrompt(input: { readonly sessionId: string; readonly userMessageId: string; readonly prompt: string }, signal?: AbortSignal): Promise<OpenCodeAssistantResultV2> {
    assertSessionId(input.sessionId);
    assertMessageId(input.userMessageId);
    const value = await this.request("POST", `/session/${encodeURIComponent(input.sessionId)}/message`, {
      messageID: input.userMessageId,
      model: { providerID: OPENCODE_CLI_EXECUTOR_PROVIDER_V2, modelID: OPENCODE_CLI_EXECUTOR_MODEL_ID_V2 },
      agent: "build",
      tools: { read: true, glob: true, grep: true, list: true, edit: true, write: true, apply_patch: true, bash: true, task: false, webfetch: false, websearch: false },
      parts: [{ type: "text", text: input.prompt }],
    }, signal);
    return parseAssistantResult(value, input.sessionId, input.userMessageId);
  }

  async readExactPromptResult(input: { readonly sessionId: string; readonly userMessageId: string }, signal?: AbortSignal): Promise<OpenCodeAssistantResultV2> {
    const messages = await this.listMessages(input.sessionId, signal);
    return parseExactAssistantTurnV2(messages, input.sessionId, input.userMessageId);
  }

  async abort(sessionId: string): Promise<boolean> {
    assertSessionId(sessionId);
    const value = await this.request("POST", `/session/${encodeURIComponent(sessionId)}/abort`, {});
    return value === true;
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown, outerSignal?: AbortSignal, includeDirectory = true): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    if (includeDirectory) url.searchParams.set("directory", this.projectRoot);
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(outerSignal?.reason);
    if (outerSignal?.aborted) controller.abort(outerSignal.reason);
    else outerSignal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("M4B_HTTP_DEADLINE")), this.deadlineMs);
    try {
      const response = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await readBoundedResponse(response, MAX_OPENCODE_HTTP_RESPONSE_BYTES_V2);
      if (!response.ok) throw new RalphM4BError("M4B_PROVIDER_RESULT_INVALID", `M4B_OPENCODE_HTTP_${response.status}`);
      if (!text) return undefined;
      try { return JSON.parse(text) as unknown; }
      catch (error) { throw new RalphM4BError("M4B_PROVIDER_RESULT_INVALID", undefined, error); }
    } catch (error) {
      if (error instanceof RalphM4BError) throw error;
      throw new RalphM4BError("M4B_PROVIDER_RESULT_INVALID", undefined, error);
    } finally {
      clearTimeout(timer);
      outerSignal?.removeEventListener("abort", onAbort);
    }
  }
}

/** Public OpenCode export based session observer; the export is never persisted. */
export class SupportedOpenCodeCliSessionInspectorV2 implements OpenCodeCliSessionInspectorV2 {
  constructor(private readonly options: {
    readonly store: RalphEventStoreV2;
    readonly projectRoot: string;
    readonly executablePath: string;
    readonly deadlineMs: number;
    readonly processClient?: OpenCodeProcess;
  }) {
    if (resolve(options.projectRoot) !== options.projectRoot) throw new RalphM4BError("M4B_WORKSPACE_BINDING_INVALID");
  }

  async inspect(input: OpenCodeCliSessionInspectionInputV2): Promise<OpenCodeCliSessionObservationV2> {
    let transport: ValidatedOpenCodeSessionExportV2;
    try {
      transport = await readSanitizedOpenCodeSessionExportV2(this.options, input.sessionBinding.openCodeSessionId);
    } catch {
      return unknownSession();
    }
    const info = transport.info;
    const observedSessionId = typeof info.id === "string" ? info.id : null;
    if (observedSessionId !== input.sessionBinding.openCodeSessionId) {
      return { ...unknownSession(), sessionIdentity: observedSessionId === null ? "UNKNOWN" : "FOREIGN", observedSessionId };
    }
    const messages = transport.messages;
    const sessionModel = modelSelector(record(info.model));
    const user = messages.find((message) => {
      const messageInfo = record(record(message).info);
      return messageInfo.role === "user" && messageInfo.id === input.dispatchIntent.openCodeUserMessageId && messageInfo.sessionID === observedSessionId;
    });
    let assistant: OpenCodeAssistantResultV2 | undefined;
    try { assistant = parseExactAssistantTurnV2(messages, observedSessionId, input.dispatchIntent.openCodeUserMessageId); }
    catch { assistant = undefined; }
    const boundAssistantModels = new Set(messages.flatMap((message) => {
      const messageInfo = record(record(message).info);
      if (messageInfo.role !== "assistant" || messageInfo.sessionID !== observedSessionId
        || messageInfo.parentID !== input.dispatchIntent.openCodeUserMessageId) return [];
      const selector = `${String(messageInfo.providerID ?? "")}/${String(messageInfo.modelID ?? "")}`;
      return selector === "/" ? [] : [selector];
    }));
    const hasForeignAssistantModel = [...boundAssistantModels].some((candidate) => candidate !== input.descriptor.modelSelector);
    const assistantModel = assistant?.modelSelector ?? (boundAssistantModels.size === 1 ? [...boundAssistantModels][0]! : null);
    const observedModel = assistantModel && assistantModel !== "/" ? assistantModel : sessionModel;
    const modelIdentity = hasForeignAssistantModel ? "MISMATCH"
      : observedModel === null ? "UNKNOWN" : observedModel === input.descriptor.modelSelector ? "MATCH" : "MISMATCH";
    let resultIdentity: OpenCodeCliSessionObservationV2["resultIdentity"] = assistant ? "UNKNOWN" : "ABSENT";
    let observedResultRef: string | null = null;
    let observedResultDigest: string | null = null;
    if (input.terminal?.resultRef && input.terminal.resultDigest) {
      const result = await readOpenCodeProviderResultV2(this.options.store, input.descriptor.attemptId);
      observedResultRef = result ? openCodeProviderResultRefV2(input.descriptor.attemptId) : null;
      observedResultDigest = result?.resultDigest ?? null;
      if (!result || !assistant) resultIdentity = "ABSENT";
      else resultIdentity = result.resultDigest === input.terminal.resultDigest && resultMatchesSession(result, input, assistant) ? "MATCH" : "MISMATCH";
    }
    return Object.freeze({
      sessionIdentity: "MATCH",
      observedSessionId,
      activity: "STATUS_UNPROVEN",
      modelIdentity,
      observedModelSelector: observedModel,
      userMessageIdentity: user ? "MATCH" : messages.length === 0 ? "ABSENT" : "MISMATCH",
      observedUserMessageId: user ? input.dispatchIntent.openCodeUserMessageId : null,
      resultIdentity,
      observedResultRef,
      observedResultDigest,
    });
  }
}

/** Read one supported sanitized export. The raw stdout is bounded, validated, and never persisted. */
export async function readSanitizedOpenCodeSessionExportV2(
  options: ReadSanitizedOpenCodeSessionExportOptionsV2,
  sessionId: string,
): Promise<ValidatedOpenCodeSessionExportV2> {
  if (resolve(options.projectRoot) !== options.projectRoot || !Number.isSafeInteger(options.deadlineMs) || options.deadlineMs < 1) {
    throw new RalphM4BError("M4B_WORKSPACE_BINDING_INVALID");
  }
  assertSessionId(sessionId);
  const client = options.processClient ?? new SpawnOpenCodeProcess();
  const controller = new AbortController();
  const exported = await client.run({
    executable: options.executablePath,
    args: ["export", sessionId, "--sanitize", "--pure"],
    stdin: "",
    cwd: options.projectRoot,
    env: openCodeM4BChildEnvironment(),
    signal: options.signal ?? controller.signal,
    deadlineMs: options.deadlineMs,
  });
  if (exported.exitCode !== 0 || exported.spawnFailed || exported.timedOut || exported.cancelled || exported.outputLimitExceeded
    || !exported.settlement.quiescent || !exported.settlement.verified
    || Buffer.byteLength(exported.stdout, "utf8") > MAX_OPENCODE_HTTP_RESPONSE_BYTES_V2) {
    throw new RalphM4BError("M4B_PROVIDER_RESULT_INVALID");
  }
  try {
    return validateOpenCodeSessionExportTransportV2(JSON.parse(exported.stdout));
  } catch (error) {
    if (error instanceof RalphM4BError) throw error;
    throw new RalphM4BError("M4B_PROVIDER_RESULT_INVALID", undefined, error);
  }
}

/** Re-observe the exact Core-bound turn through the future cross-process path. */
export async function readSanitizedExactOpenCodeTurnV2(
  options: ReadSanitizedOpenCodeSessionExportOptionsV2,
  input: { readonly sessionId: string; readonly userMessageId: string },
): Promise<OpenCodeAssistantResultV2> {
  const transport = await readSanitizedOpenCodeSessionExportV2(options, input.sessionId);
  if (transport.info.id !== input.sessionId) throw new RalphM4BError("M4B_SESSION_BINDING_INVALID");
  const result = parseExactAssistantTurnV2(transport.messages, input.sessionId, input.userMessageId);
  const sessionModel = modelSelector(record(transport.info.model));
  if (sessionModel !== null && sessionModel !== result.modelSelector) throw new RalphM4BError("M4B_MODEL_MISMATCH");
  return result;
}

export function parseAssistantResult(value: unknown, sessionId: string, userMessageId: string): OpenCodeAssistantResultV2 {
  const envelope = validateOpenCodeTransportMessageV2(value);
  const info = envelope.info;
  const parts = envelope.parts;
  if (info.role !== "assistant" || info.sessionID !== sessionId || info.parentID !== userMessageId || typeof info.id !== "string" || !/^msg_[A-Za-z0-9_-]{3,128}$/.test(info.id)) {
    throw new RalphM4BError("M4B_PROVIDER_RESULT_INVALID");
  }
  const observedModel = `${String(info.providerID ?? "")}/${String(info.modelID ?? "")}`;
  if (observedModel !== OPENCODE_CLI_EXECUTOR_MODEL_V2) throw new RalphM4BError("M4B_MODEL_MISMATCH");
  const providerFailed = (info.error !== undefined && info.error !== null)
    || parts.some((part) => record(part).type === "error");
  return Object.freeze({
    assistantMessageId: info.id,
    sessionId,
    userMessageId,
    modelSelector: observedModel,
    classification: providerFailed ? "FAILED" : "SUCCEEDED",
    parts: Object.freeze([...parts]),
    assistantContentDigest: sha256Canonical(parts),
    responseDigest: sha256Canonical({ info, parts }),
    observableTurnDigest: null,
    raw: value,
  });
}

/**
 * OpenCode emits one assistant message per tool step. One Core user message
 * may therefore own several `tool-calls` assistant messages followed by one
 * terminal `stop` message. Bind and digest the complete turn, but retain it
 * only in memory; persisted provider artifacts contain digests and IDs.
 */
export function parseExactAssistantTurnV2(messages: readonly unknown[], sessionId: string, userMessageId: string): OpenCodeAssistantResultV2 {
  const indexed = messages.map((value, index) => ({ value, index, info: record(record(value).info) }));
  const matchingUsers = indexed.filter(({ info }) => info.role === "user" && info.id === userMessageId && info.sessionID === sessionId);
  if (matchingUsers.length !== 1) throw new RalphM4BError("M4B_PROVIDER_RESULT_INVALID");
  const user = matchingUsers[0]!;
  validateOpenCodeTransportMessageV2(user.value);
  const nextSameSessionUser = indexed.find(({ index, info }) => index > user.index && info.role === "user" && info.sessionID === sessionId);
  const relatedAssistants = indexed.filter(({ info }) => info.role === "assistant" && info.parentID === userMessageId);
  if (relatedAssistants.length < 1
    || relatedAssistants.some(({ index }) => index <= user.index || (nextSameSessionUser !== undefined && index >= nextSameSessionUser.index))) {
    throw new RalphM4BError("M4B_PROVIDER_RESULT_INVALID");
  }

  const assistantIds = new Set<string>();
  const parsed = relatedAssistants.map(({ value, info, index }) => {
    const timing = parseAssistantTiming(info);
    const result = parseAssistantResult(value, sessionId, userMessageId);
    if (assistantIds.has(result.assistantMessageId)) throw new RalphM4BError("M4B_PROVIDER_RESULT_INVALID");
    assistantIds.add(result.assistantMessageId);
    return { value, info, index, result, timing };
  });
  assertOpenCodeTurnChronology(user.info, parsed);

  const terminalCandidates = parsed.filter(({ info }) => info.finish === "stop");
  if (terminalCandidates.length !== 1) throw new RalphM4BError("M4B_PROVIDER_RESULT_INVALID");
  const terminal = terminalCandidates[0]!;
  if (parsed.some(({ index }) => index > terminal.index)) throw new RalphM4BError("M4B_PROVIDER_RESULT_INVALID");
  for (const entry of parsed) {
    if (entry === terminal) continue;
    if (entry.info.finish !== "tool-calls" || entry.result.classification !== "SUCCEEDED") {
      throw new RalphM4BError("M4B_PROVIDER_RESULT_INVALID");
    }
  }

  const boundedTurn = relatedAssistants.map(({ value }) => {
    const envelope = record(value);
    return { info: record(envelope.info), parts: Array.isArray(envelope.parts) ? envelope.parts : [] };
  });
  const allParts = boundedTurn.flatMap((value) => value.parts);
  const observableTurnDigest = digestObservableOpenCodeTurnV2({
    user: user.value,
    assistants: relatedAssistants.map(({ value }) => value),
  });
  return Object.freeze({
    ...terminal.result,
    parts: Object.freeze(allParts),
    assistantContentDigest: sha256Canonical(boundedTurn.map((value) => value.parts)),
    responseDigest: sha256Canonical({
      user: { info: user.info, parts: Array.isArray(record(user.value).parts) ? record(user.value).parts : [] },
      assistants: boundedTurn,
    }),
    observableTurnDigest,
    raw: relatedAssistants.map(({ value }) => value),
  });
}

interface OpenCodeAssistantTimingV2 {
  readonly created: number;
  readonly completed: number;
}

function parseAssistantTiming(info: Record<string, unknown>): OpenCodeAssistantTimingV2 | null {
  if (!("time" in info)) return null;
  const time = record(info.time);
  if (!Number.isSafeInteger(time.created) || !Number.isSafeInteger(time.completed)
    || Number(time.created) < 0 || Number(time.completed) < Number(time.created)) {
    throw new RalphM4BError("M4B_PROVIDER_RESULT_INVALID");
  }
  return { created: Number(time.created), completed: Number(time.completed) };
}

function parseUserCreatedAt(info: Record<string, unknown>): number | null {
  if (!("time" in info)) return null;
  const time = record(info.time);
  if (!Number.isSafeInteger(time.created) || Number(time.created) < 0) throw new RalphM4BError("M4B_PROVIDER_RESULT_INVALID");
  return Number(time.created);
}

function assertOpenCodeTurnChronology(
  userInfo: Record<string, unknown>,
  assistants: readonly { readonly timing: OpenCodeAssistantTimingV2 | null }[],
): void {
  const timed = assistants.filter(({ timing }) => timing !== null);
  if (timed.length !== 0 && timed.length !== assistants.length) throw new RalphM4BError("M4B_PROVIDER_RESULT_INVALID");
  if (timed.length === 0) return;
  let previousCompleted = parseUserCreatedAt(userInfo);
  for (const entry of assistants) {
    const timing = entry.timing!;
    if (previousCompleted !== null && timing.created < previousCompleted) throw new RalphM4BError("M4B_PROVIDER_RESULT_INVALID");
    previousCompleted = timing.completed;
  }
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    bytes += item.value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new RalphM4BError("M4B_PROVIDER_OUTPUT_LIMIT");
    }
    chunks.push(item.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseSession(value: unknown, projectRoot: string): OpenCodeSessionRecordV2 {
  const session = record(value);
  const selector = modelSelector(record(session.model));
  if (typeof session.id !== "string" || !/^ses_[A-Za-z0-9_-]{8,128}$/.test(session.id)
    || typeof session.directory !== "string" || resolve(session.directory) !== projectRoot
    || session.version !== OPENCODE_CLI_EXECUTOR_TRANSPORT_VERSION_V2 || selector !== OPENCODE_CLI_EXECUTOR_MODEL_V2) {
    throw new RalphM4BError("M4B_SESSION_BINDING_INVALID");
  }
  return Object.freeze({ id: session.id, directory: session.directory, version: session.version, modelSelector: selector });
}

function modelSelector(model: Record<string, unknown>): string | null {
  const provider = typeof model.providerID === "string" ? model.providerID : typeof model.providerId === "string" ? model.providerId : null;
  const id = typeof model.id === "string" ? model.id : typeof model.modelID === "string" ? model.modelID : null;
  return provider && id ? `${provider}/${id}` : null;
}

function resultMatchesSession(result: OpenCodeProviderResultV2, input: OpenCodeCliSessionInspectionInputV2, assistant: OpenCodeAssistantResultV2 | undefined): boolean {
  if (result.runId !== input.descriptor.runId || result.phaseId !== input.descriptor.phaseId || result.taskId !== input.descriptor.taskId
    || result.attemptId !== input.descriptor.attemptId || result.invocationId !== input.descriptor.invocationId
    || result.descriptorDigest !== input.descriptor.descriptorDigest
    || result.dispatchIntentDigest !== input.dispatchIntent.intentDigest
    || result.sessionBindingDigest !== input.sessionBinding.bindingDigest
    || result.openCodeSessionId !== input.sessionBinding.openCodeSessionId || result.openCodeUserMessageId !== input.dispatchIntent.openCodeUserMessageId
    || result.observedModelSelector !== input.descriptor.modelSelector) return false;
  if (result.classification !== "SUCCEEDED" && result.classification !== "FAILED") {
    return result.assistantMessageId === null && result.assistantContentDigest === null && result.observableTurnDigest === null;
  }
  return assistant !== undefined
    && result.classification === assistant.classification
    && result.assistantMessageId === assistant.assistantMessageId
    && assistant.observableTurnDigest !== null
    && result.observableTurnDigest === assistant.observableTurnDigest;
}

function unknownSession(): OpenCodeCliSessionObservationV2 {
  return Object.freeze({
    sessionIdentity: "UNKNOWN", observedSessionId: null, activity: "UNKNOWN", modelIdentity: "UNKNOWN", observedModelSelector: null,
    userMessageIdentity: "UNKNOWN", observedUserMessageId: null, resultIdentity: "UNKNOWN", observedResultRef: null, observedResultDigest: null,
  });
}

function assertSessionId(value: string): void {
  if (!/^ses_[A-Za-z0-9_-]{8,128}$/.test(value)) throw new RalphM4BError("M4B_SESSION_BINDING_INVALID");
}

function assertMessageId(value: string): void {
  if (!/^msg_[A-Za-z0-9_-]{3,128}$/.test(value)) throw new RalphM4BError("M4B_PROVIDER_RESULT_INVALID");
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function canonicalOpenCodeAssistantEvidenceV2(value: OpenCodeAssistantResultV2): string {
  return canonicalJson({ assistantMessageId: value.assistantMessageId, sessionId: value.sessionId, userMessageId: value.userMessageId, modelSelector: value.modelSelector, classification: value.classification, assistantContentDigest: value.assistantContentDigest, responseDigest: value.responseDigest, observableTurnDigest: value.observableTurnDigest });
}
