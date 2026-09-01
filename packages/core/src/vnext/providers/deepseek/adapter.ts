import {
  measured,
  unmeasured,
  type CanonicalSemanticResponse,
  type ModelProfile,
  type ProviderAdapter,
  type ProviderOutcome,
  type ResolvedProviderAuth,
  type SemanticRequest,
} from "../contract.js";
import {
  deepSeekFrameHasVisibleOutput,
  extractDeepSeekPayload,
  isDeepSeekRawResponse,
  usageFromDeepSeek,
  type DeepSeekRawResponse,
} from "./normalize.js";
import { DEEPSEEK_PROFILES } from "./profiles.js";

export const DEEPSEEK_RESPONSES_ENDPOINT = "https://api.deepseek.com/responses";

export interface DeepSeekTransportInput {
  readonly endpoint: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
}

export interface DeepSeekTransport {
  send(input: DeepSeekTransportInput): Promise<DeepSeekRawResponse>;
}

function safeHeaders(response: Response): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const name of ["content-type", "request-id", "x-request-id"]) {
    const value = response.headers.get(name);
    if (value) safe[name] = value;
  }
  return safe;
}

function takeCompleteFrames(buffer: string): { complete: string[]; rest: string } {
  const complete: string[] = [];
  const delimiter = /\r?\n\r?\n/g;
  let start = 0;
  for (let match = delimiter.exec(buffer); match; match = delimiter.exec(buffer)) {
    complete.push(buffer.slice(start, match.index));
    start = delimiter.lastIndex;
  }
  return { complete, rest: buffer.slice(start) };
}

export class FetchDeepSeekTransport implements DeepSeekTransport {
  async send(input: DeepSeekTransportInput): Promise<DeepSeekRawResponse> {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const response = await fetch(input.endpoint, {
      method: "POST",
      headers: input.headers,
      body: input.body,
      signal: input.signal,
    });
    const reader = response.body?.getReader();
    if (!reader) {
      return {
        status: response.status,
        headers: safeHeaders(response),
        body: "",
        startedAt,
        completedAt: new Date().toISOString(),
        streamComplete: false,
      };
    }
    const decoder = new TextDecoder();
    let body = "";
    let frameBuffer = "";
    let firstOutputMs: number | undefined;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const text = decoder.decode(chunk.value, { stream: true });
      body += text;
      frameBuffer += text;
      const drained = takeCompleteFrames(frameBuffer);
      frameBuffer = drained.rest;
      if (firstOutputMs === undefined && drained.complete.some(deepSeekFrameHasVisibleOutput)) {
        firstOutputMs = Date.now() - started;
      }
    }
    const tail = decoder.decode();
    body += tail;
    frameBuffer += tail;
    if (firstOutputMs === undefined && frameBuffer.trim() && deepSeekFrameHasVisibleOutput(frameBuffer)) {
      firstOutputMs = Date.now() - started;
    }
    return {
      status: response.status,
      headers: safeHeaders(response),
      body,
      startedAt,
      completedAt: new Date().toISOString(),
      ...(firstOutputMs === undefined ? {} : { firstOutputMs }),
      streamComplete: true,
    };
  }
}

function unsupported(message: string): ProviderOutcome<never> {
  return { ok: false, error: { kind: "unsupported-capability", message, transportRetryable: false } };
}

export function preflightDeepSeek(profile: ModelProfile, request: SemanticRequest): ProviderOutcome<true> {
  if (profile.family !== "deepseek") return unsupported(`profile ${profile.id} is not a DeepSeek profile`);
  if (profile.transport !== "direct-api") return unsupported(`profile ${profile.id} does not use the DeepSeek direct API transport`);
  if (!DEEPSEEK_PROFILES.some((candidate) => candidate.id === profile.id && candidate.modelId === profile.modelId)) {
    return unsupported(`unknown DeepSeek profile: ${profile.id}`);
  }
  if (profile.structuredOutput !== "json-schema" || profile.toolCalling || profile.toolChoiceForcing) {
    return unsupported(`profile ${profile.id} cannot use native JSON Schema without tools`);
  }
  if (!Number.isInteger(request.limits.maxOutputTokens) || request.limits.maxOutputTokens < 1) {
    return unsupported("maxOutputTokens must be a positive integer");
  }
  if (request.limits.maxOutputTokens > profile.maxOutputTokens) {
    return unsupported(`requested output limit exceeds ${profile.id}'s ${profile.maxOutputTokens}-token capability`);
  }
  if (!Number.isFinite(request.limits.deadlineMs) || request.limits.deadlineMs <= 0) {
    return unsupported("deadlineMs must be positive");
  }
  if (request.reasoning.mode === "on") {
    if (!profile.reasoning.supported || !profile.reasoning.efforts.includes(request.reasoning.effort)) {
      return unsupported(`reasoning effort '${request.reasoning.effort}' is not supported by ${profile.id}`);
    }
  }
  return { ok: true, value: true };
}

export function deepSeekRequestBody(profile: ModelProfile, request: SemanticRequest): Record<string, unknown> {
  return {
    model: profile.modelId,
    instructions: request.instructions,
    input: request.input,
    max_output_tokens: request.limits.maxOutputTokens,
    stream: true,
    text: {
      format: {
        type: "json_schema",
        name: request.schemaName,
        schema: request.schema,
      },
    },
    reasoning: { effort: request.reasoning.mode === "off" ? "none" : request.reasoning.effort },
  };
}

export class DeepSeekAdapter implements ProviderAdapter {
  readonly family = "deepseek";
  readonly transport = "direct-api" as const;
  readonly profiles = DEEPSEEK_PROFILES;

  constructor(private readonly transportClient: DeepSeekTransport = new FetchDeepSeekTransport()) {}

  checkCapabilities(profile: ModelProfile, request: SemanticRequest): ProviderOutcome<true> {
    return preflightDeepSeek(profile, request);
  }

  replay(profile: ModelProfile, request: SemanticRequest, raw: unknown): ProviderOutcome<CanonicalSemanticResponse> {
    const preflight = preflightDeepSeek(profile, request);
    if (!preflight.ok) return preflight;
    if (!isDeepSeekRawResponse(raw)) {
      return { ok: false, error: { kind: "malformed-syntax", message: "recorded DeepSeek response is not a valid raw response", transportRetryable: false } };
    }
    return this.canonicalize(profile, request, raw);
  }

  private canonicalize(
    profile: ModelProfile,
    request: SemanticRequest,
    raw: DeepSeekRawResponse,
  ): ProviderOutcome<CanonicalSemanticResponse> {
    const extracted = extractDeepSeekPayload(profile, raw);
    if (!extracted.ok) return extracted;
    return {
      ok: true,
      value: {
        slice: request.slice,
        payload: extracted.value.payload,
        normalizations: extracted.value.normalizations,
        usage: extracted.value.usage,
        transport: {
          startedAt: raw.startedAt,
          completedAt: raw.completedAt,
          firstOutputMs: raw.firstOutputMs === undefined
            ? unmeasured("not-reported-in-this-response")
            : measured(raw.firstOutputMs),
          httpStatus: measured(raw.status),
          requestId: measured(extracted.value.requestId),
          stopReason: measured(extracted.value.stopReason),
        },
      },
    };
  }

  async request(
    profile: ModelProfile,
    auth: ResolvedProviderAuth,
    request: SemanticRequest,
  ): Promise<ProviderOutcome<CanonicalSemanticResponse>> {
    const preflight = preflightDeepSeek(profile, request);
    if (!preflight.ok) return preflight;
    if (auth.kind !== "credential") {
      return { ok: false, error: { kind: "auth", message: "DeepSeek direct API requires a resolved credential", transportRetryable: false } };
    }
    if (request.signal.aborted) {
      return {
        ok: false,
        error: {
          kind: "cancelled",
          message: "DeepSeek request was cancelled before transport",
          transportRetryable: false,
          usage: usageFromDeepSeek({}, true, 0),
        },
      };
    }

    const controller = new AbortController();
    let deadlineElapsed = false;
    const onCancel = (): void => controller.abort(request.signal.reason);
    request.signal.addEventListener("abort", onCancel, { once: true });
    const timer = setTimeout(() => {
      deadlineElapsed = true;
      controller.abort(new DOMException("deadline elapsed", "TimeoutError"));
    }, request.limits.deadlineMs);

    try {
      const raw = await this.transportClient.send({
        endpoint: DEEPSEEK_RESPONSES_ENDPOINT,
        headers: {
          authorization: `Bearer ${auth.credential.secret}`,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify(deepSeekRequestBody(profile, request)),
        signal: controller.signal,
      });
      return this.canonicalize(profile, request, raw);
    } catch {
      if (deadlineElapsed) {
        return {
          ok: false,
          error: {
            kind: "timeout",
            message: "DeepSeek request exceeded its deadline",
            transportRetryable: true,
            usage: usageFromDeepSeek({}, false),
          },
        };
      }
      if (request.signal.aborted || controller.signal.aborted) {
        return {
          ok: false,
          error: {
            kind: "cancelled",
            message: "DeepSeek request was cancelled",
            transportRetryable: false,
            usage: usageFromDeepSeek({}, false),
          },
        };
      }
      return {
        ok: false,
        error: {
          kind: "transport",
          message: "DeepSeek transport failed",
          transportRetryable: true,
          usage: usageFromDeepSeek({}, false),
        },
      };
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onCancel);
    }
  }
}

export const deepSeekAdapter = new DeepSeekAdapter();
