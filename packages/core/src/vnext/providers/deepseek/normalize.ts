import {
  measured,
  unmeasured,
  type CanonicalUsage,
  type ModelProfile,
  type ProviderErrorKind,
  type ProviderOutcome,
} from "../contract.js";

export interface DeepSeekRawResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly firstOutputMs?: number;
  readonly streamComplete: boolean;
}

export interface DeepSeekExtraction {
  readonly payload: unknown;
  readonly normalizations: readonly [];
  readonly usage: CanonicalUsage;
  readonly stopReason: string;
  readonly requestId: string;
}

interface DecodedTerminal {
  readonly eventType: "response.completed" | "response.incomplete" | "response.failed";
  readonly response: Record<string, unknown>;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function metric(usage: Record<string, unknown>, key: string, complete: boolean) {
  const value = usage[key];
  return typeof value === "number" && Number.isFinite(value)
    ? measured(value)
    : unmeasured<number>(complete ? "not-reported-in-this-response" : "stream-incomplete");
}

export function usageFromDeepSeek(
  usage: Record<string, unknown>,
  complete: boolean,
  providerRequests = 1,
): CanonicalUsage {
  return {
    inputTokens: metric(usage, "input_tokens", complete),
    cachedInputTokens: metric(object(usage.input_tokens_details), "cached_tokens", complete),
    cacheWriteTokens: unmeasured("unsupported-by-provider"),
    outputTokens: metric(usage, "output_tokens", complete),
    reasoningTokens: metric(object(usage.output_tokens_details), "reasoning_tokens", complete),
    providerRequests: measured(providerRequests),
    costUsd: unmeasured("unsupported-by-provider"),
  };
}

function failure(
  kind: ProviderErrorKind,
  message: string,
  transportRetryable: boolean,
  usage?: CanonicalUsage,
): ProviderOutcome<never> {
  return { ok: false, error: { kind, message, transportRetryable, ...(usage ? { usage } : {}) } };
}

function errorForStatus(raw: DeepSeekRawResponse): ProviderOutcome<never> {
  const kind = raw.status === 401 || raw.status === 403
    ? "auth"
    : raw.status === 429
      ? "rate-limit"
      : raw.status >= 500
        ? "transport"
        : "provider-error";
  return failure(
    kind,
    `DeepSeek request failed with HTTP ${raw.status}`,
    raw.status === 408 || raw.status === 429 || raw.status >= 500,
    usageFromDeepSeek({}, true),
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

function frameData(frame: string): ProviderOutcome<{ eventName?: string; value?: Record<string, unknown> }> {
  let eventName: string | undefined;
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const rawValue = colon === -1 ? "" : line.slice(colon + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "event") eventName = value;
    else if (field === "data") data.push(value);
    // SSE requires clients to ignore id/retry here and every unknown field.
  }
  if (!data.length) {
    if (!eventName) return { ok: true, value: {} };
    return failure("malformed-syntax", "DeepSeek stream event omitted its data payload", false);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.join("\n"));
  } catch {
    return failure("malformed-syntax", "DeepSeek stream contains malformed JSON event data", false);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return failure("malformed-syntax", "DeepSeek stream event data is not an object", false);
  }
  return { ok: true, value: { ...(eventName ? { eventName } : {}), value: parsed as Record<string, unknown> } };
}

function decodeTerminal(body: string): ProviderOutcome<DecodedTerminal> {
  let terminal: DecodedTerminal | undefined;
  for (const frame of frames(body)) {
    const decoded = frameData(frame);
    if (!decoded.ok) return decoded;
    if (!decoded.value.value) continue;
    const event = decoded.value.value;
    const type = typeof event.type === "string" ? event.type : undefined;
    if (!type) return failure("malformed-syntax", "DeepSeek stream event omitted its type", false);
    if (decoded.value.eventName && decoded.value.eventName !== type) {
      return failure("malformed-syntax", "DeepSeek SSE event name does not match its data type", false);
    }
    if (type !== "response.completed" && type !== "response.incomplete" && type !== "response.failed") continue;
    if (terminal) return failure("malformed-syntax", "DeepSeek stream contains multiple terminal events", false);
    const response = object(event.response);
    if (!Object.keys(response).length) {
      return failure("malformed-syntax", "DeepSeek terminal event omitted its response envelope", false);
    }
    terminal = { eventType: type, response };
  }
  return terminal
    ? { ok: true, value: terminal }
    : failure("malformed-syntax", "DeepSeek stream ended without a terminal response event", false);
}

function visibleTexts(response: Record<string, unknown>): ProviderOutcome<string[]> {
  if (!Array.isArray(response.output)) {
    return failure("malformed-syntax", "DeepSeek terminal response omitted its output array", false);
  }
  const text: string[] = [];
  for (const itemValue of response.output) {
    const item = object(itemValue);
    if (item.type === "reasoning") continue;
    if (item.type !== "message") {
      return failure("provider-error", "DeepSeek returned an unexpected non-text output item", false);
    }
    if (item.role !== "assistant" || item.status !== "completed" || !Array.isArray(item.content)) {
      return failure("provider-error", "DeepSeek returned an invalid assistant output item", false);
    }
    for (const partValue of item.content) {
      const part = object(partValue);
      if (part.type === "output_text" && typeof part.text === "string") text.push(part.text);
    }
  }
  return { ok: true, value: text };
}

function safeErrorCode(response: Record<string, unknown>): string | undefined {
  const code = object(response.error).code;
  return typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : undefined;
}

export function isDeepSeekRawResponse(value: unknown): value is DeepSeekRawResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  const firstOutputValid = raw.firstOutputMs === undefined
    || typeof raw.firstOutputMs === "number" && Number.isFinite(raw.firstOutputMs) && raw.firstOutputMs >= 0;
  return Number.isInteger(raw.status)
    && raw.headers !== null && typeof raw.headers === "object" && !Array.isArray(raw.headers)
    && Object.values(raw.headers as Record<string, unknown>).every((entry) => typeof entry === "string")
    && typeof raw.body === "string"
    && typeof raw.startedAt === "string"
    && typeof raw.completedAt === "string"
    && typeof raw.streamComplete === "boolean"
    && firstOutputValid;
}

export function extractDeepSeekPayload(
  profile: ModelProfile,
  raw: DeepSeekRawResponse,
): ProviderOutcome<DeepSeekExtraction> {
  if (raw.status < 200 || raw.status >= 300) return errorForStatus(raw);
  if (!raw.streamComplete) {
    return failure(
      "output-truncated",
      "DeepSeek stream ended before transport completion",
      false,
      usageFromDeepSeek({}, false),
    );
  }
  const terminal = decodeTerminal(raw.body);
  if (!terminal.ok) return terminal;
  const response = terminal.value.response;
  const status = typeof response.status === "string" ? response.status : "";
  const expectedStatus = terminal.value.eventType.slice("response.".length);
  if (status !== expectedStatus) {
    return failure("malformed-syntax", "DeepSeek terminal event does not match response status", false);
  }
  if (response.model !== profile.modelId) {
    return failure("provider-error", `DeepSeek returned a model other than ${profile.modelId}`, false, usageFromDeepSeek(object(response.usage), true));
  }
  const requestId = typeof response.id === "string" && response.id ? response.id : undefined;
  if (!requestId) return failure("malformed-syntax", "DeepSeek terminal response omitted its id", false);
  const usage = usageFromDeepSeek(object(response.usage), true);

  if (status === "incomplete") {
    const reason = object(response.incomplete_details).reason;
    if (reason === "max_output_tokens") {
      return failure("output-truncated", "DeepSeek stopped at the output token limit", false, usage);
    }
    if (reason === "content_filter") {
      return failure("provider-error", "DeepSeek response was blocked by content filtering", false, usage);
    }
    return failure("provider-error", "DeepSeek returned an incomplete response", false, usage);
  }
  if (status === "failed") {
    const code = safeErrorCode(response);
    return failure("provider-error", `DeepSeek response failed${code ? ` (${code})` : ""}`, false, usage);
  }
  if (status !== "completed") {
    return failure("malformed-syntax", "DeepSeek terminal response has an unsupported status", false, usage);
  }

  const texts = visibleTexts(response);
  if (!texts.ok) return { ...texts, error: { ...texts.error, usage } };
  if (texts.value.length !== 1) {
    return failure("provider-error", "DeepSeek did not return exactly one visible structured text output", false, usage);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(texts.value[0]!);
  } catch {
    return failure("malformed-syntax", "DeepSeek returned invalid structured JSON", false, usage);
  }
  return {
    ok: true,
    value: {
      payload,
      normalizations: [],
      usage,
      stopReason: "completed",
      requestId,
    },
  };
}

export function deepSeekFrameHasVisibleOutput(frame: string): boolean {
  const decoded = frameData(frame);
  if (!decoded.ok || !decoded.value.value) return false;
  const event = decoded.value.value;
  if (event.type === "response.output_text.delta") return typeof event.delta === "string" && event.delta.length > 0;
  if (event.type === "response.output_text.done") return typeof event.text === "string" && event.text.length > 0;
  return false;
}
