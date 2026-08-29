import {
  measured,
  unmeasured,
  type CanonicalUsage,
  type ModelProfile,
  type ProviderOutcome,
} from "../contract.js";

export interface AnthropicRawResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly firstOutputMs?: number;
  readonly streamComplete: boolean;
}

export interface AnthropicExtraction {
  readonly payload: unknown;
  readonly normalizations: readonly [];
  readonly usage: CanonicalUsage;
  readonly stopReason: string;
  readonly requestId?: string;
}

const retryable = (status: number): boolean => status === 408 || status === 409 || status === 429 || status >= 500;

function errorForStatus(raw: AnthropicRawResponse): ProviderOutcome<never> {
  let message = `Anthropic request failed with HTTP ${raw.status}`;
  try {
    const parsed = JSON.parse(raw.body) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === "string") message = parsed.error.message;
  } catch {
    // A bounded raw excerpt below is enough; never attempt syntax repair.
  }
  const kind = raw.status === 401 || raw.status === 403
    ? "auth"
    : raw.status === 429
      ? "rate-limit"
      : raw.status >= 500
        ? "transport"
        : "provider-error";
  return {
    ok: false,
    error: {
      kind,
      message,
      transportRetryable: retryable(raw.status),
      excerpt: raw.body.slice(0, 300),
    },
  };
}

function metric(usage: Record<string, unknown>, key: string, complete: boolean) {
  const value = usage[key];
  return typeof value === "number" && Number.isFinite(value)
    ? measured(value)
    : unmeasured<number>(complete ? "not-reported-in-this-response" : "stream-incomplete");
}

export function usageFromAnthropic(usage: Record<string, unknown>, complete: boolean): CanonicalUsage {
  return {
    inputTokens: metric(usage, "input_tokens", complete),
    cachedInputTokens: metric(usage, "cache_read_input_tokens", complete),
    cacheWriteTokens: metric(usage, "cache_creation_input_tokens", complete),
    outputTokens: metric(usage, "output_tokens", complete),
    reasoningTokens: unmeasured("unsupported-by-provider"),
    providerRequests: measured(1),
    costUsd: unmeasured("unsupported-by-provider"),
  };
}

interface DecodedStream {
  content: Array<Record<string, unknown>>;
  usage: Record<string, unknown>;
  stopReason: string;
  requestId?: string;
  completed: boolean;
}

function decodeSse(body: string): ProviderOutcome<DecodedStream> {
  const content: Array<Record<string, unknown>> = [];
  const fragments = new Map<number, string>();
  const usage: Record<string, unknown> = {};
  let stopReason = "";
  let requestId: string | undefined;
  let completed = false;
  const frames = body.split(/\r?\n\r?\n/).filter((frame) => frame.trim());
  try {
    for (const frame of frames) {
      const data = frame.split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      const event = JSON.parse(data) as Record<string, unknown>;
      const type = typeof event.type === "string" ? event.type : "";
      if (type === "message_start") {
        const message = object(event.message);
        Object.assign(usage, object(message.usage));
        if (typeof message.id === "string") requestId = message.id;
      } else if (type === "content_block_start") {
        const index = integer(event.index, content.length);
        const block = object(event.content_block);
        content[index] = { ...block };
        if (block.type === "tool_use") fragments.set(index, "");
      } else if (type === "content_block_delta") {
        const index = integer(event.index, 0);
        const delta = object(event.delta);
        if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          fragments.set(index, `${fragments.get(index) ?? ""}${delta.partial_json}`);
        }
      } else if (type === "content_block_stop") {
        const index = integer(event.index, 0);
        const fragment = fragments.get(index);
        if (fragment !== undefined && content[index]) content[index]!.input = JSON.parse(fragment || "{}");
      } else if (type === "message_delta") {
        const delta = object(event.delta);
        if (typeof delta.stop_reason === "string") stopReason = delta.stop_reason;
        Object.assign(usage, object(event.usage));
      } else if (type === "message_stop") {
        completed = true;
      } else if (type === "error") {
        const providerError = object(event.error);
        return {
          ok: false,
          error: {
            kind: "provider-error",
            message: typeof providerError.message === "string" ? providerError.message : "Anthropic stream error",
            transportRetryable: false,
          },
        };
      }
    }
  } catch (cause) {
    return {
      ok: false,
      error: {
        kind: "malformed-syntax",
        message: `Anthropic stream contains malformed JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        transportRetryable: false,
      },
    };
  }
  return { ok: true, value: { content, usage, stopReason, ...(requestId ? { requestId } : {}), completed } };
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function integer(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

export function extractAnthropicPayload(
  profile: ModelProfile,
  raw: AnthropicRawResponse,
  expectedToolName: string,
): ProviderOutcome<AnthropicExtraction> {
  if (raw.status < 200 || raw.status >= 300) return errorForStatus(raw);
  if (!raw.streamComplete) {
    return { ok: false, error: { kind: "output-truncated", message: "Anthropic stream ended before completion", transportRetryable: false } };
  }
  const decoded = decodeSse(raw.body);
  if (!decoded.ok) return decoded;
  if (!decoded.value.completed) {
    return { ok: false, error: { kind: "output-truncated", message: "Anthropic stream omitted message_stop", transportRetryable: false } };
  }
  if (decoded.value.stopReason === "max_tokens") {
    return {
      ok: false,
      error: {
        kind: "output-truncated",
        message: "Anthropic stopped at the output token limit",
        transportRetryable: false,
        usage: usageFromAnthropic(decoded.value.usage, true),
      },
    };
  }
  if (profile.structuredOutput !== "forced-tool-argument") {
    return { ok: false, error: { kind: "unsupported-capability", message: "profile does not declare forced tool arguments", transportRetryable: false } };
  }
  const blocks = decoded.value.content.filter((block) => block.type === "tool_use" && block.name === expectedToolName);
  if (blocks.length !== 1 || !("input" in blocks[0]!)) {
    return {
      ok: false,
      error: {
        kind: "provider-error",
        message: "Anthropic did not return exactly one forced tool input",
        transportRetryable: false,
        usage: usageFromAnthropic(decoded.value.usage, true),
      },
    };
  }
  return {
    ok: true,
    value: {
      payload: blocks[0]!.input,
      normalizations: [],
      usage: usageFromAnthropic(decoded.value.usage, true),
      stopReason: decoded.value.stopReason,
      ...(decoded.value.requestId ? { requestId: decoded.value.requestId } : {}),
    },
  };
}
