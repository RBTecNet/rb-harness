import {
  measured,
  unmeasured,
  type CanonicalUsage,
  type ModelProfile,
  type ProviderErrorKind,
  type ProviderOutcome,
} from "../contract.js";

export interface OpenAiRawResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly firstOutputMs?: number;
  readonly streamComplete: boolean;
}

export interface OpenAiExtraction {
  readonly payload: unknown;
  readonly normalizations: readonly [];
  readonly usage: CanonicalUsage;
  readonly stopReason: string;
  readonly requestId: string;
}

type ObjectValue = Record<string, unknown>;

function object(value: unknown): ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ObjectValue
    : {};
}

function failure(
  kind: ProviderErrorKind,
  message: string,
  transportRetryable: boolean,
  usage?: CanonicalUsage,
): ProviderOutcome<never> {
  return { ok: false, error: { kind, message, transportRetryable, ...(usage ? { usage } : {}) } };
}

function metric(usage: ObjectValue, key: string, complete: boolean) {
  const value = usage[key];
  return typeof value === "number" && Number.isFinite(value)
    ? measured(value)
    : unmeasured<number>(complete ? "not-reported-in-this-response" : "stream-incomplete");
}

export function usageFromOpenAi(
  usage: ObjectValue,
  complete: boolean,
  providerRequests = 1,
): CanonicalUsage {
  return {
    inputTokens: metric(usage, "input_tokens", complete),
    cachedInputTokens: unmeasured("unsupported-by-provider"),
    cacheWriteTokens: unmeasured("unsupported-by-provider"),
    outputTokens: metric(usage, "output_tokens", complete),
    reasoningTokens: unmeasured("unsupported-by-provider"),
    providerRequests: measured(providerRequests),
    costUsd: unmeasured("unsupported-by-provider"),
  };
}

function safeScalar(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

function safeErrorDetails(value: unknown): string {
  const envelope = object(value);
  const source = object(envelope.error ?? value);
  const values = [
    ["type", safeScalar(source.type, /^[a-z][a-z0-9_]{0,63}$/)],
    ["code", safeScalar(source.code, /^[A-Za-z0-9_.-]{1,64}$/)],
    ["param", safeScalar(source.param, /^[A-Za-z0-9_.\[\]-]{1,128}$/)],
  ].filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return values.length ? ` (${values.map(([key, entry]) => `${key}=${entry}`).join(", ")})` : "";
}

function httpFailure(raw: OpenAiRawResponse): ProviderOutcome<never> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw.body); } catch { parsed = undefined; }
  const kind: ProviderErrorKind = raw.status === 401
    ? "auth"
    : raw.status === 429
      ? "rate-limit"
      : raw.status === 408 || raw.status >= 500
        ? "transport"
        : "provider-error";
  return failure(
    kind,
    `OpenAI request failed with HTTP ${raw.status}${safeErrorDetails(parsed)}`,
    raw.status === 408 || raw.status === 429 || raw.status >= 500,
    usageFromOpenAi({}, true),
  );
}

function frames(body: string): string[] {
  const result: string[] = [];
  const delimiter = /\r?\n\r?\n/g;
  let start = 0;
  for (let match = delimiter.exec(body); match; match = delimiter.exec(body)) {
    result.push(body.slice(start, match.index));
    start = delimiter.lastIndex;
  }
  if (body.slice(start).trim()) result.push(body.slice(start));
  return result.filter((frame) => frame.trim());
}

function decodeFrame(frame: string): ProviderOutcome<{ readonly eventName?: string; readonly event?: ObjectValue }> {
  let eventName: string | undefined;
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const raw = colon < 0 ? "" : line.slice(colon + 1);
    const value = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (field === "event") eventName = value;
    else if (field === "data") data.push(value);
    // id, retry and unknown SSE fields are intentionally ignored.
  }
  if (!data.length) {
    return eventName
      ? failure("malformed-syntax", "OpenAI stream event omitted data", false)
      : { ok: true, value: {} };
  }
  if (data.join("\n") === "[DONE]") {
    return failure("malformed-syntax", "OpenAI Responses stream used an unexpected legacy terminator", false);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(data.join("\n")); } catch {
    return failure("malformed-syntax", "OpenAI stream contains malformed JSON event data", false);
  }
  const event = object(parsed);
  if (!Object.keys(event).length) return failure("malformed-syntax", "OpenAI stream event data is not an object", false);
  const type = typeof event.type === "string" ? event.type : undefined;
  if (!type) return failure("malformed-syntax", "OpenAI stream event omitted its type", false);
  if (eventName && eventName !== type) {
    return failure("malformed-syntax", "OpenAI SSE event name does not match its data type", false);
  }
  return { ok: true, value: { ...(eventName ? { eventName } : {}), event } };
}

interface Terminal {
  readonly type: "response.completed" | "response.incomplete" | "response.failed";
  readonly response: ObjectValue;
}

function decodeTerminal(body: string): ProviderOutcome<Terminal> {
  let found: Terminal | undefined;
  for (const frame of frames(body)) {
    const decoded = decodeFrame(frame);
    if (!decoded.ok) return decoded;
    const event = decoded.value.event;
    if (!event) continue;
    if (event.type === "error") {
      return failure("provider-error", `OpenAI stream reported an error${safeErrorDetails(event)}`, false);
    }
    if (event.type !== "response.completed" && event.type !== "response.incomplete" && event.type !== "response.failed") continue;
    if (found) return failure("malformed-syntax", "OpenAI stream contains multiple terminal events", false);
    const response = object(event.response);
    if (!Object.keys(response).length) return failure("malformed-syntax", "OpenAI terminal event omitted its response envelope", false);
    found = { type: event.type, response };
  }
  return found
    ? { ok: true, value: found }
    : failure("malformed-syntax", "OpenAI stream ended without a terminal response event", false);
}

function visibleText(response: ObjectValue): ProviderOutcome<string> {
  if (!Array.isArray(response.output)) return failure("malformed-syntax", "OpenAI terminal response omitted its output array", false);
  const texts: string[] = [];
  for (const rawItem of response.output) {
    const item = object(rawItem);
    if (item.type === "reasoning") continue;
    if (item.type !== "message" || item.role !== "assistant" || item.status !== "completed" || !Array.isArray(item.content)) {
      return failure("provider-error", "OpenAI returned an unexpected output item", false);
    }
    for (const rawPart of item.content) {
      const part = object(rawPart);
      if (part.type === "output_text" && typeof part.text === "string" && part.text.length) texts.push(part.text);
      else if (part.type === "refusal") return failure("provider-error", "OpenAI refused the structured response", false);
      else return failure("provider-error", "OpenAI returned an unexpected message content part", false);
    }
  }
  return texts.length === 1
    ? { ok: true, value: texts[0]! }
    : failure("provider-error", "OpenAI did not return exactly one authoritative output text", false);
}

export function isOpenAiRawResponse(value: unknown): value is OpenAiRawResponse {
  const raw = object(value);
  const headers = object(raw.headers);
  return Number.isInteger(raw.status)
    && raw.headers !== null && typeof raw.headers === "object" && !Array.isArray(raw.headers)
    && Object.values(headers).every((entry) => typeof entry === "string")
    && typeof raw.body === "string"
    && typeof raw.startedAt === "string"
    && typeof raw.completedAt === "string"
    && typeof raw.streamComplete === "boolean"
    && (raw.firstOutputMs === undefined || typeof raw.firstOutputMs === "number" && Number.isFinite(raw.firstOutputMs) && raw.firstOutputMs >= 0);
}

export function openAiFrameHasVisibleOutput(frame: string): boolean {
  const decoded = decodeFrame(frame);
  return decoded.ok
    && decoded.value.event?.type === "response.output_text.delta"
    && typeof decoded.value.event.delta === "string"
    && decoded.value.event.delta.length > 0;
}

export function extractOpenAiPayload(
  profile: ModelProfile,
  raw: OpenAiRawResponse,
): ProviderOutcome<OpenAiExtraction> {
  if (raw.status < 200 || raw.status >= 300) return httpFailure(raw);
  if (!raw.streamComplete) {
    return failure("output-truncated", "OpenAI stream ended before transport completion", false, usageFromOpenAi({}, false));
  }
  const decoded = decodeTerminal(raw.body);
  if (!decoded.ok) return decoded;
  const response = decoded.value.response;
  const status = typeof response.status === "string" ? response.status : "";
  if (status !== decoded.value.type.slice("response.".length)) {
    return failure("malformed-syntax", "OpenAI terminal event does not match response status", false);
  }
  const usage = usageFromOpenAi(object(response.usage), true);
  if (typeof response.model !== "string" || !response.model) {
    return failure("provider-error", "OpenAI terminal response omitted observed model identity", false, usage);
  }
  if (response.model !== profile.modelId) {
    return failure("provider-error", `OpenAI returned a model other than ${profile.modelId}`, false, usage);
  }
  const requestId = typeof response.id === "string" && response.id ? response.id : undefined;
  if (!requestId) return failure("malformed-syntax", "OpenAI terminal response omitted its id", false);
  if (decoded.value.type === "response.incomplete") {
    const reason = object(response.incomplete_details).reason;
    return failure(
      reason === "max_output_tokens" ? "output-truncated" : "provider-error",
      reason === "max_output_tokens" ? "OpenAI response reached its output limit" : "OpenAI response was incomplete",
      false,
      usage,
    );
  }
  if (decoded.value.type === "response.failed") {
    return failure("provider-error", `OpenAI response failed${safeErrorDetails(response)}`, false, usage);
  }
  const text = visibleText(response);
  if (!text.ok) return text;
  let payload: unknown;
  try { payload = JSON.parse(text.value); } catch {
    return failure("malformed-syntax", "OpenAI structured output is not valid JSON", false, usage);
  }
  return { ok: true, value: { payload, normalizations: [], usage, stopReason: "completed", requestId } };
}
