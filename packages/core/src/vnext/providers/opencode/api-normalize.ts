import {
  measured,
  unmeasured,
  type CanonicalSemanticResponse,
  type CanonicalUsage,
  type Measured,
  type ModelProfile,
  type ProviderOutcome,
  type SemanticRequest,
} from "../contract.js";
import { openCodeProfileConfiguration, type OpenCodeProfileConfiguration } from "./profiles.js";

export interface OpenCodeApiRawResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly firstOutputMs?: number;
  readonly streamComplete: boolean;
}

interface DecodedApiResponse {
  readonly payload: unknown;
  readonly usage: Record<string, unknown>;
  readonly modelId: string;
  readonly requestId?: string;
  readonly stopReason: string;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

interface SseFrame {
  readonly name?: string;
  readonly data: string;
}

function frames(body: string): SseFrame[] {
  return body.split(/\r?\n\r?\n/).filter((frame) => frame.trim()).flatMap((frame) => {
    let name: string | undefined;
    const data: string[] = [];
    for (const rawLine of frame.split(/\r?\n/)) {
      if (!rawLine || rawLine.startsWith(":")) continue;
      const colon = rawLine.indexOf(":");
      const field = colon < 0 ? rawLine : rawLine.slice(0, colon);
      const value = colon < 0 ? "" : rawLine.slice(colon + 1).replace(/^ /, "");
      if (field === "event") name = value;
      else if (field === "data") data.push(value);
      // id, retry, and unknown fields are non-semantic.
    }
    return data.length ? [{ ...(name ? { name } : {}), data: data.join("\n") }] : [];
  });
}

function parseJson(value: string, label: string): ProviderOutcome<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("event is not an object");
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: { kind: "malformed-syntax", message: `${label} stream contains malformed JSON`, transportRetryable: false } };
  }
}

const SAFE_ERROR_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const SAFE_ERROR_PARAM = /^[A-Za-z0-9_.\[\]-]{1,128}$/;

export function safeOpenCodeHttpErrorDetails(body: string): string {
  try {
    const error = object(object(JSON.parse(body)).error);
    const entries = [
      ["type", error.type, SAFE_ERROR_TYPE],
      ["code", error.code, SAFE_ERROR_CODE],
      ["param", error.param, SAFE_ERROR_PARAM],
    ] as const;
    const safe = entries.flatMap(([label, value, pattern]) => (
      typeof value === "string" && pattern.test(value) ? [`${label}=${value}`] : []
    ));
    return safe.length ? ` (${safe.join("; ")})` : "";
  } catch { return ""; }
}

function safeHttpError(status: number, usage: CanonicalUsage, body: string): ProviderOutcome<never> {
  const kind = status === 401 ? "auth"
    : status === 429 ? "rate-limit"
      : status >= 500 ? "transport" : "provider-error";
  return {
    ok: false,
    error: {
      kind,
      message: `OpenCode API request failed with HTTP ${status}${safeOpenCodeHttpErrorDetails(body)}`,
      transportRetryable: status === 408 || status === 409 || status === 429 || status >= 500,
      usage,
    },
  };
}

function parseVisibleJson(text: string): ProviderOutcome<unknown> {
  const value = text.trim();
  if (!value) return { ok: false, error: { kind: "provider-error", message: "OpenCode API completed without visible structured output", transportRetryable: false } };
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false, error: { kind: "malformed-syntax", message: "OpenCode API visible output is not valid JSON", transportRetryable: false } };
  }
}

function decodeChat(body: string): ProviderOutcome<DecodedApiResponse> {
  let text = "";
  let completed = false;
  let stopReason = "";
  let modelId = "";
  let requestId: string | undefined;
  let usage: Record<string, unknown> = {};
  for (const frame of frames(body)) {
    if (frame.data === "[DONE]") continue;
    const parsed = parseJson(frame.data, "OpenCode Chat");
    if (!parsed.ok) return parsed;
    const event = parsed.value;
    if (typeof event.model === "string" && event.model) modelId = event.model;
    if (typeof event.id === "string" && event.id) requestId = event.id;
    if (Object.keys(object(event.usage)).length) usage = object(event.usage);
    const choice = object(Array.isArray(event.choices) ? event.choices[0] : undefined);
    const delta = object(choice.delta);
    if (typeof delta.content === "string") text += delta.content;
    if (typeof choice.finish_reason === "string" && choice.finish_reason) {
      stopReason = choice.finish_reason;
      completed = true;
    }
  }
  if (!completed || !stopReason) return { ok: false, error: { kind: "output-truncated", message: "OpenCode Chat stream ended without a terminal finish reason", transportRetryable: false } };
  if (stopReason === "length") return { ok: false, error: { kind: "output-truncated", message: "OpenCode Chat exhausted the output token limit", transportRetryable: false } };
  const payload = parseVisibleJson(text);
  return payload.ok ? { ok: true, value: { payload: payload.value, usage, modelId, ...(requestId ? { requestId } : {}), stopReason: stopReason || "completed" } } : payload;
}

function decodeMessages(body: string, expectedTool: string): ProviderOutcome<DecodedApiResponse> {
  let terminalCount = 0;
  let stopReason = "";
  let modelId = "";
  let requestId: string | undefined;
  const usage: Record<string, unknown> = {};
  const blocks = new Map<number, Record<string, unknown>>();
  const argumentsByIndex = new Map<number, string>();
  for (const frame of frames(body)) {
    if (frame.data === "[DONE]") return { ok: false, error: { kind: "malformed-syntax", message: "OpenCode Messages stream used an invalid Chat [DONE] sentinel", transportRetryable: false } };
    const parsed = parseJson(frame.data, "OpenCode Messages");
    if (!parsed.ok) return parsed;
    const event = parsed.value;
    const type = typeof event.type === "string" ? event.type : frame.name ?? "";
    if (frame.name && typeof event.type === "string" && frame.name !== event.type) {
      return { ok: false, error: { kind: "malformed-syntax", message: "OpenCode Messages event name disagrees with data.type", transportRetryable: false } };
    }
    if (type === "message_start") {
      const message = object(event.message);
      if (typeof message.model === "string") modelId = message.model;
      if (typeof message.id === "string") requestId = message.id;
      Object.assign(usage, object(message.usage));
    } else if (type === "content_block_start") {
      const index = finite(event.index) ?? blocks.size;
      const block = object(event.content_block);
      blocks.set(index, block);
      if (block.type === "tool_use") argumentsByIndex.set(index, "");
    } else if (type === "content_block_delta") {
      const index = finite(event.index) ?? 0;
      const delta = object(event.delta);
      if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        argumentsByIndex.set(index, `${argumentsByIndex.get(index) ?? ""}${delta.partial_json}`);
      }
    } else if (type === "content_block_stop") {
      const index = finite(event.index) ?? 0;
      const block = blocks.get(index);
      const json = argumentsByIndex.get(index);
      if (block && json !== undefined) {
        try { block.input = JSON.parse(json || "{}"); }
        catch { return { ok: false, error: { kind: "malformed-syntax", message: "OpenCode Messages tool input is malformed JSON", transportRetryable: false } }; }
      }
    } else if (type === "message_delta") {
      const delta = object(event.delta);
      if (typeof delta.stop_reason === "string") stopReason = delta.stop_reason;
      Object.assign(usage, object(event.usage));
    } else if (type === "message_stop") terminalCount += 1;
    else if (type === "error") return { ok: false, error: { kind: "provider-error", message: "OpenCode Messages stream reported a provider error", transportRetryable: false } };
  }
  if (terminalCount !== 1) return { ok: false, error: { kind: terminalCount ? "malformed-syntax" : "output-truncated", message: terminalCount ? "OpenCode Messages stream contains multiple terminal events" : "OpenCode Messages stream omitted message_stop", transportRetryable: false } };
  if (stopReason === "max_tokens") return { ok: false, error: { kind: "output-truncated", message: "OpenCode Messages exhausted the output token limit", transportRetryable: false } };
  const candidates = [...blocks.values()].filter((block) => block.type === "tool_use" && block.name === expectedTool && "input" in block);
  const unexpected = [...blocks.values()].filter((block) => block.type !== "tool_use" && block.type !== "thinking" && block.type !== "reasoning");
  if (unexpected.length) {
    const counts = new Map<string, number>();
    for (const block of unexpected) {
      const type = typeof block.type === "string" && /^[a-z][a-z0-9_]{0,31}$/.test(block.type) ? block.type : undefined;
      if (type) counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    const census = [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).slice(0, 5)
      .map(([type, count]) => `${type}:${count}`).join(",");
    return { ok: false, error: {
      kind: "provider-error",
      message: `OpenCode Messages returned unexpected blocks${census ? ` (${census})` : ""}`,
      transportRetryable: false,
    } };
  }
  if (candidates.length !== 1) return { ok: false, error: { kind: "provider-error", message: "OpenCode Messages did not return exactly one forced structured tool input", transportRetryable: false } };
  return { ok: true, value: { payload: candidates[0]!.input, usage, modelId, ...(requestId ? { requestId } : {}), stopReason: stopReason || "completed" } };
}

function decodeResponses(body: string): ProviderOutcome<DecodedApiResponse> {
  let text = "";
  let terminal: Record<string, unknown> | undefined;
  let terminalType = "";
  const visibleOutputs = new Set<string>();
  for (const frame of frames(body)) {
    if (frame.data === "[DONE]") return { ok: false, error: { kind: "malformed-syntax", message: "OpenCode Responses stream used an invalid Chat [DONE] sentinel", transportRetryable: false } };
    const parsed = parseJson(frame.data, "OpenCode Responses");
    if (!parsed.ok) return parsed;
    const event = parsed.value;
    const type = typeof event.type === "string" ? event.type : frame.name ?? "";
    if (frame.name && typeof event.type === "string" && frame.name !== event.type) {
      return { ok: false, error: { kind: "malformed-syntax", message: "OpenCode Responses event name disagrees with data.type", transportRetryable: false } };
    }
    if (type === "response.output_text.delta" && typeof event.delta === "string") {
      const identity = typeof event.item_id === "string" ? event.item_id
        : `${String(event.output_index ?? "default")}:${String(event.content_index ?? "default")}`;
      visibleOutputs.add(identity);
      text += event.delta;
    }
    if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
      if (terminal) return { ok: false, error: { kind: "malformed-syntax", message: "OpenCode Responses stream contains multiple terminal events", transportRetryable: false } };
      terminal = object(event.response);
      terminalType = type;
    }
  }
  if (!terminal) return { ok: false, error: { kind: "output-truncated", message: "OpenCode Responses stream ended without a terminal event", transportRetryable: false } };
  const status = typeof terminal.status === "string" ? terminal.status : "";
  if (terminalType === "response.incomplete") {
    const reason = String(object(terminal.incomplete_details).reason ?? "unknown");
    return reason === "max_output_tokens"
      ? { ok: false, error: { kind: "output-truncated", message: "OpenCode Responses exhausted the output token limit", transportRetryable: false } }
      : { ok: false, error: { kind: "provider-error", message: `OpenCode Responses was incomplete (${reason})`, transportRetryable: false } };
  }
  if (terminalType === "response.failed") return { ok: false, error: { kind: "provider-error", message: "OpenCode Responses terminal status was failed", transportRetryable: false } };
  if (status !== "completed") return { ok: false, error: { kind: "malformed-syntax", message: "OpenCode Responses terminal type/status disagree", transportRetryable: false } };
  if (visibleOutputs.size !== 1) return { ok: false, error: { kind: "provider-error", message: "OpenCode Responses did not expose exactly one authoritative output text", transportRetryable: false } };
  if (Array.isArray(terminal.output)) {
    const outputTexts = terminal.output.flatMap((item) => {
      const entry = object(item);
      if (entry.type === "reasoning") return [];
      return Array.isArray(entry.content) ? entry.content.map(object).filter((part) => part.type === "output_text") : [];
    });
    if (outputTexts.length !== 1) return { ok: false, error: { kind: "provider-error", message: "OpenCode Responses terminal envelope has ambiguous visible output", transportRetryable: false } };
  }
  const payload = parseVisibleJson(text);
  if (!payload.ok) return payload;
  return {
    ok: true,
    value: {
      payload: payload.value,
      usage: object(terminal.usage),
      modelId: typeof terminal.model === "string" ? terminal.model : "",
      ...(typeof terminal.id === "string" ? { requestId: terminal.id } : {}),
      stopReason: "completed",
    },
  };
}

function detail(usage: Record<string, unknown>, parent: string, key: string): number | undefined {
  return finite(object(usage[parent])[key]);
}

function supportedMetric(profile: ModelProfile, key: keyof ModelProfile["usageReporting"], value: number | undefined, complete: boolean): Measured<number> {
  if (!profile.usageReporting[key]) return unmeasured("unsupported-by-provider");
  return value === undefined ? unmeasured(complete ? "not-reported-in-this-response" : "stream-incomplete") : measured(value);
}

function usageFor(profile: ModelProfile, config: OpenCodeProfileConfiguration, usage: Record<string, unknown>, complete: boolean, providerRequests = 1): CanonicalUsage {
  const anthropic = config.protocol === "anthropic-messages";
  const input = finite(usage[anthropic ? "input_tokens" : config.protocol === "openai-responses" ? "input_tokens" : "prompt_tokens"]);
  const output = finite(usage[anthropic ? "output_tokens" : config.protocol === "openai-responses" ? "output_tokens" : "completion_tokens"]);
  const cached = anthropic ? finite(usage.cache_read_input_tokens)
    : config.protocol === "openai-responses" ? detail(usage, "input_tokens_details", "cached_tokens")
      : detail(usage, "prompt_tokens_details", "cached_tokens");
  const cacheWrite = anthropic ? finite(usage.cache_creation_input_tokens) : undefined;
  const reasoning = config.protocol === "openai-responses" ? detail(usage, "output_tokens_details", "reasoning_tokens")
    : config.protocol === "openai-chat" ? detail(usage, "completion_tokens_details", "reasoning_tokens") : undefined;
  return {
    inputTokens: supportedMetric(profile, "inputTokens", input, complete),
    cachedInputTokens: supportedMetric(profile, "cachedInputTokens", cached, complete),
    cacheWriteTokens: supportedMetric(profile, "cacheWriteTokens", cacheWrite, complete),
    outputTokens: supportedMetric(profile, "outputTokens", output, complete),
    reasoningTokens: supportedMetric(profile, "reasoningTokens", reasoning, complete),
    providerRequests: measured(providerRequests),
    costUsd: supportedMetric(profile, "costUsd", undefined, complete),
  };
}

export function usageFromOpenCodeApi(profile: ModelProfile, complete: boolean, providerRequests: number, usage: Record<string, unknown> = {}): CanonicalUsage {
  const config = openCodeProfileConfiguration(profile);
  if (!config || config.mode !== "api") throw new Error(`unknown OpenCode API profile: ${profile.id}`);
  return usageFor(profile, config, usage, complete, providerRequests);
}

export function isOpenCodeApiRawResponse(raw: unknown): raw is OpenCodeApiRawResponse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const value = raw as Record<string, unknown>;
  return typeof value.status === "number"
    && typeof value.body === "string"
    && typeof value.startedAt === "string"
    && typeof value.completedAt === "string"
    && typeof value.streamComplete === "boolean"
    && Boolean(value.headers && typeof value.headers === "object" && !Array.isArray(value.headers));
}

export function normalizeOpenCodeApi(
  profile: ModelProfile,
  request: SemanticRequest,
  raw: OpenCodeApiRawResponse,
): ProviderOutcome<CanonicalSemanticResponse> {
  const config = openCodeProfileConfiguration(profile);
  if (!config || config.mode !== "api" || !config.protocol) {
    return { ok: false, error: { kind: "unsupported-capability", message: `unknown OpenCode API profile: ${profile.id}`, transportRetryable: false } };
  }
  if (raw.status < 200 || raw.status >= 300) return safeHttpError(raw.status, usageFor(profile, config, {}, true), raw.body);
  if (!raw.streamComplete) return { ok: false, error: { kind: "output-truncated", message: "OpenCode API stream was incomplete", transportRetryable: false, usage: usageFor(profile, config, {}, false) } };
  const decoded = config.protocol === "openai-chat" ? decodeChat(raw.body)
    : config.protocol === "anthropic-messages" ? decodeMessages(raw.body, request.schemaName)
      : decodeResponses(raw.body);
  if (!decoded.ok) return { ok: false, error: { ...decoded.error, usage: decoded.error.usage ?? usageFor(profile, config, {}, raw.streamComplete) } };
  if (!decoded.value.modelId) return { ok: false, error: { kind: "provider-error", message: "OpenCode API response omitted model identity", transportRetryable: false, usage: usageFor(profile, config, decoded.value.usage, true) } };
  if (decoded.value.modelId !== profile.modelId) {
    return { ok: false, error: { kind: "provider-error", message: `OpenCode API observed model '${decoded.value.modelId}' instead of '${profile.modelId}'`, transportRetryable: false, usage: usageFor(profile, config, decoded.value.usage, true) } };
  }
  return {
    ok: true,
    value: {
      slice: request.slice,
      payload: decoded.value.payload,
      normalizations: [],
      usage: usageFor(profile, config, decoded.value.usage, true),
      transport: {
        startedAt: raw.startedAt,
        completedAt: raw.completedAt,
        firstOutputMs: raw.firstOutputMs === undefined ? unmeasured("not-reported-in-this-response") : measured(raw.firstOutputMs),
        httpStatus: measured(raw.status),
        requestId: decoded.value.requestId ? measured(decoded.value.requestId) : unmeasured("not-reported-in-this-response"),
        stopReason: measured(decoded.value.stopReason),
      },
    },
  };
}
