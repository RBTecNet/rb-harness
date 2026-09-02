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
  extractOpenAiPayload,
  isOpenAiRawResponse,
  openAiFrameHasVisibleOutput,
  usageFromOpenAi,
  type OpenAiRawResponse,
} from "./normalize.js";
import { OPENAI_PROFILES } from "./profiles.js";

export const OPENAI_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";

export interface OpenAiTransportInput {
  readonly endpoint: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
}

export interface OpenAiTransport {
  send(input: OpenAiTransportInput): Promise<OpenAiRawResponse>;
}

function safeHeaders(response: Response): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const name of ["content-type", "request-id", "x-request-id", "openai-request-id"]) {
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

export class FetchOpenAiTransport implements OpenAiTransport {
  async send(input: OpenAiTransportInput): Promise<OpenAiRawResponse> {
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
      if (firstOutputMs === undefined && drained.complete.some(openAiFrameHasVisibleOutput)) {
        firstOutputMs = Date.now() - started;
      }
    }
    const tail = decoder.decode();
    body += tail;
    frameBuffer += tail;
    if (firstOutputMs === undefined && frameBuffer.trim() && openAiFrameHasVisibleOutput(frameBuffer)) {
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

export function preflightOpenAi(profile: ModelProfile, request: SemanticRequest): ProviderOutcome<true> {
  if (profile.family !== "openai" || profile.transport !== "direct-api") {
    return unsupported(`profile ${profile.id} is not an OpenAI direct API profile`);
  }
  if (!OPENAI_PROFILES.some((candidate) => candidate.id === profile.id && candidate.modelId === profile.modelId)) {
    return unsupported(`unknown OpenAI profile: ${profile.id}`);
  }
  if (profile.structuredOutput !== "json-schema" || profile.strictSchema || profile.toolCalling || profile.toolChoiceForcing) {
    return unsupported(`profile ${profile.id} cannot use non-strict JSON Schema without tools`);
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(request.schemaName)) {
    return unsupported("OpenAI schemaName must contain 1-64 letters, digits, underscores, or hyphens");
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
  if (request.reasoning.mode === "on" && (!profile.reasoning.supported || !profile.reasoning.efforts.includes(request.reasoning.effort))) {
    return unsupported(`reasoning effort '${request.reasoning.effort}' is not supported by ${profile.id}`);
  }
  return { ok: true, value: true };
}

/** The original caller-owned schema is transmitted unchanged with strict:false. */
export function openAiRequestBody(profile: ModelProfile, request: SemanticRequest): Record<string, unknown> {
  const offEffort = profile.modelId === "gpt-5.3-codex" ? "low" : "none";
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
        strict: false,
      },
    },
    reasoning: { effort: request.reasoning.mode === "off" ? offEffort : request.reasoning.effort },
  };
}

export class OpenAiAdapter implements ProviderAdapter {
  readonly family = "openai";
  readonly transport = "direct-api" as const;
  readonly profiles = OPENAI_PROFILES;

  constructor(private readonly transportClient: OpenAiTransport = new FetchOpenAiTransport()) {}

  checkCapabilities(profile: ModelProfile, request: SemanticRequest): ProviderOutcome<true> {
    return preflightOpenAi(profile, request);
  }

  replay(profile: ModelProfile, request: SemanticRequest, raw: unknown): ProviderOutcome<CanonicalSemanticResponse> {
    const preflight = preflightOpenAi(profile, request);
    if (!preflight.ok) return preflight;
    if (!isOpenAiRawResponse(raw)) {
      return { ok: false, error: { kind: "malformed-syntax", message: "recorded OpenAI response is not a valid raw response", transportRetryable: false } };
    }
    return this.canonicalize(profile, request, raw);
  }

  private canonicalize(profile: ModelProfile, request: SemanticRequest, raw: OpenAiRawResponse): ProviderOutcome<CanonicalSemanticResponse> {
    const extracted = extractOpenAiPayload(profile, raw);
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
    const preflight = preflightOpenAi(profile, request);
    if (!preflight.ok) return preflight;
    if (auth.kind !== "credential") {
      return { ok: false, error: { kind: "auth", message: "OpenAI direct API requires a resolved credential", transportRetryable: false } };
    }
    if (request.signal.aborted) {
      return {
        ok: false,
        error: {
          kind: "cancelled",
          message: "OpenAI request was cancelled before transport",
          transportRetryable: false,
          usage: usageFromOpenAi({}, true, 0),
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
        endpoint: OPENAI_RESPONSES_ENDPOINT,
        headers: {
          authorization: `Bearer ${auth.credential.secret}`,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify(openAiRequestBody(profile, request)),
        signal: controller.signal,
      });
      return this.canonicalize(profile, request, raw);
    } catch {
      if (deadlineElapsed) {
        return { ok: false, error: { kind: "timeout", message: "OpenAI request exceeded its deadline", transportRetryable: true, usage: usageFromOpenAi({}, false) } };
      }
      if (request.signal.aborted || controller.signal.aborted) {
        return { ok: false, error: { kind: "cancelled", message: "OpenAI request was cancelled", transportRetryable: false, usage: usageFromOpenAi({}, false) } };
      }
      return { ok: false, error: { kind: "transport", message: "OpenAI transport failed", transportRetryable: true, usage: usageFromOpenAi({}, false) } };
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onCancel);
    }
  }
}

export const openAiAdapter = new OpenAiAdapter();
