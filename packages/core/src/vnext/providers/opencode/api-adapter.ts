import type {
  CanonicalSemanticResponse,
  ModelProfile,
  ProviderAdapter,
  ProviderOutcome,
  ResolvedProviderAuth,
  SemanticRequest,
} from "../contract.js";
import { openCodeApiEndpoint, type OpenCodeProtocol } from "./catalog.js";
import { isOpenCodeApiRawResponse, normalizeOpenCodeApi, usageFromOpenCodeApi, type OpenCodeApiRawResponse } from "./api-normalize.js";
import { OPENCODE_API_PROFILES, openCodeProfileConfiguration } from "./profiles.js";

export interface OpenCodeApiTransportInput {
  readonly endpoint: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
  readonly protocol: OpenCodeProtocol;
}

export interface OpenCodeApiTransport {
  send(input: OpenCodeApiTransportInput): Promise<OpenCodeApiRawResponse>;
}

function safeHeaders(response: Response): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const name of ["content-type", "request-id", "x-request-id"]) {
    const value = response.headers.get(name);
    if (value) safe[name] = value;
  }
  return safe;
}

export class FetchOpenCodeApiTransport implements OpenCodeApiTransport {
  async send(input: OpenCodeApiTransportInput): Promise<OpenCodeApiRawResponse> {
    const started = Date.now();
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
        startedAt: new Date(started).toISOString(),
        completedAt: new Date().toISOString(),
        streamComplete: false,
      };
    }
    const decoder = new TextDecoder();
    let body = "";
    let pending = "";
    let firstOutputMs: number | undefined;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const text = decoder.decode(chunk.value, { stream: true });
      body += text;
      pending += text;
      const parts = pending.split(/\r?\n\r?\n/);
      pending = parts.pop() ?? "";
      if (firstOutputMs === undefined && parts.some((frame) => frameHasVisibleOutput(frame, input.protocol))) firstOutputMs = Date.now() - started;
    }
    body += decoder.decode();
    if (firstOutputMs === undefined && pending.trim() && frameHasVisibleOutput(pending, input.protocol)) firstOutputMs = Date.now() - started;
    return {
      status: response.status,
      headers: safeHeaders(response),
      body,
      startedAt: new Date(started).toISOString(),
      completedAt: new Date().toISOString(),
      ...(firstOutputMs === undefined ? {} : { firstOutputMs }),
      streamComplete: true,
    };
  }
}

function frameHasVisibleOutput(frame: string, protocol: OpenCodeProtocol): boolean {
  const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
  if (!data || data === "[DONE]") return false;
  try {
    const event = JSON.parse(data) as Record<string, unknown>;
    if (protocol === "openai-responses") return event.type === "response.output_text.delta" && typeof event.delta === "string" && event.delta.length > 0;
    if (protocol === "anthropic-messages") {
      const delta = event.delta as Record<string, unknown> | undefined;
      return event.type === "content_block_delta" && delta?.type === "input_json_delta" && typeof delta.partial_json === "string" && delta.partial_json.length > 0;
    }
    const choice = Array.isArray(event.choices) ? event.choices[0] as Record<string, unknown> | undefined : undefined;
    const delta = choice?.delta as Record<string, unknown> | undefined;
    return typeof delta?.content === "string" && delta.content.length > 0;
  } catch { return false; }
}

function unsupported(message: string): ProviderOutcome<never> {
  return { ok: false, error: { kind: "unsupported-capability", message, transportRetryable: false } };
}

export function preflightOpenCodeApi(profile: ModelProfile, request: SemanticRequest): ProviderOutcome<true> {
  const config = openCodeProfileConfiguration(profile);
  if (profile.family !== "opencode" || profile.transport !== "direct-api" || !config || config.mode !== "api" || !config.protocol) {
    return unsupported(`unknown OpenCode API profile: ${profile.id}`);
  }
  const mechanism = config.protocol === "openai-responses" ? "json-schema"
    : config.protocol === "anthropic-messages" ? "forced-tool-argument" : "json-mode";
  if (profile.structuredOutput !== mechanism) return unsupported(`profile ${profile.id} does not declare the required ${mechanism} mechanism`);
  if (!Number.isInteger(request.limits.maxOutputTokens) || request.limits.maxOutputTokens < 1 || request.limits.maxOutputTokens > profile.maxOutputTokens) {
    return unsupported(`invalid output limit for ${profile.id}`);
  }
  if (!Number.isFinite(request.limits.deadlineMs) || request.limits.deadlineMs <= 0) return unsupported("deadlineMs must be positive");
  if (request.reasoning.mode === "on" && (!profile.reasoning.supported || !profile.reasoning.efforts.includes(request.reasoning.effort))) {
    return unsupported(`reasoning effort '${request.reasoning.effort}' is not supported by ${profile.id}`);
  }
  return { ok: true, value: true };
}

function jsonInstruction(request: SemanticRequest): string {
  return `${request.instructions}\nReturn exactly one JSON value matching schema '${request.schemaName}'. Do not use Markdown fences or explanatory text. Schema: ${JSON.stringify(request.schema)}`;
}

export function openCodeApiRequestBody(profile: ModelProfile, request: SemanticRequest): Record<string, unknown> {
  const config = openCodeProfileConfiguration(profile);
  if (!config || config.mode !== "api" || !config.protocol) throw new Error(`unknown OpenCode API profile: ${profile.id}`);
  const reasoning = request.reasoning.mode === "on" ? request.reasoning.effort : undefined;
  if (config.protocol === "openai-responses") {
    return {
      model: profile.modelId,
      instructions: request.instructions,
      input: request.input,
      max_output_tokens: request.limits.maxOutputTokens,
      stream: true,
      text: { format: { type: "json_schema", name: request.schemaName, schema: request.schema } },
      ...(reasoning ? { reasoning: { effort: reasoning } } : {}),
    };
  }
  if (config.protocol === "anthropic-messages") {
    return {
      model: profile.modelId,
      system: request.instructions,
      messages: [{ role: "user", content: request.input }],
      max_tokens: request.limits.maxOutputTokens,
      stream: true,
      tools: [{ name: request.schemaName, description: "Return the semantic candidate", input_schema: request.schema }],
      tool_choice: { type: "tool", name: request.schemaName },
      ...(reasoning ? { output_config: { effort: reasoning } } : {}),
    };
  }
  return {
    model: profile.modelId,
    messages: [
      { role: "system", content: jsonInstruction(request) },
      { role: "user", content: request.input },
    ],
    max_tokens: request.limits.maxOutputTokens,
    stream: true,
    stream_options: { include_usage: true },
    response_format: { type: "json_object" },
    ...(reasoning ? { reasoning_effort: reasoning } : {}),
  };
}

export function openCodeApiHeaders(protocol: OpenCodeProtocol, secret: string): Record<string, string> {
  return protocol === "anthropic-messages"
    ? { "x-api-key": secret, "anthropic-version": "2023-06-01", "content-type": "application/json", accept: "text/event-stream" }
    : { authorization: `Bearer ${secret}`, "content-type": "application/json", accept: "text/event-stream" };
}

export class OpenCodeApiAdapter implements ProviderAdapter {
  readonly family = "opencode";
  readonly transport = "direct-api" as const;
  readonly profiles = OPENCODE_API_PROFILES;

  constructor(private readonly transportClient: OpenCodeApiTransport = new FetchOpenCodeApiTransport()) {}

  checkCapabilities(profile: ModelProfile, request: SemanticRequest): ProviderOutcome<true> {
    return preflightOpenCodeApi(profile, request);
  }

  replay(profile: ModelProfile, request: SemanticRequest, raw: unknown): ProviderOutcome<CanonicalSemanticResponse> {
    const preflight = preflightOpenCodeApi(profile, request);
    if (!preflight.ok) return preflight;
    if (!isOpenCodeApiRawResponse(raw)) return { ok: false, error: { kind: "malformed-syntax", message: "recorded OpenCode API response is invalid", transportRetryable: false } };
    return normalizeOpenCodeApi(profile, request, raw);
  }

  async request(profile: ModelProfile, auth: ResolvedProviderAuth, request: SemanticRequest): Promise<ProviderOutcome<CanonicalSemanticResponse>> {
    const preflight = preflightOpenCodeApi(profile, request);
    if (!preflight.ok) return preflight;
    const config = openCodeProfileConfiguration(profile)!;
    if (auth.kind !== "credential") return { ok: false, error: { kind: "auth", message: "OpenCode API requires a vault credential", transportRetryable: false, usage: usageFromOpenCodeApi(profile, true, 0) } };
    if (request.signal.aborted) return { ok: false, error: { kind: "cancelled", message: "OpenCode API request was cancelled before transport", transportRetryable: false, usage: usageFromOpenCodeApi(profile, true, 0) } };
    const controller = new AbortController();
    let timedOut = false;
    const cancel = (): void => controller.abort(request.signal.reason);
    request.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, request.limits.deadlineMs);
    try {
      const raw = await this.transportClient.send({
        endpoint: openCodeApiEndpoint(config.service!, profile.modelId)!,
        headers: openCodeApiHeaders(config.protocol!, auth.credential.secret),
        body: JSON.stringify(openCodeApiRequestBody(profile, request)),
        signal: controller.signal,
        protocol: config.protocol!,
      });
      return normalizeOpenCodeApi(profile, request, raw);
    } catch {
      if (timedOut) return { ok: false, error: { kind: "timeout", message: "OpenCode API request exceeded its deadline", transportRetryable: true, usage: usageFromOpenCodeApi(profile, false, 1) } };
      if (request.signal.aborted || controller.signal.aborted) return { ok: false, error: { kind: "cancelled", message: "OpenCode API request was cancelled", transportRetryable: false, usage: usageFromOpenCodeApi(profile, false, 1) } };
      return { ok: false, error: { kind: "transport", message: "OpenCode API transport failed", transportRetryable: true, usage: usageFromOpenCodeApi(profile, false, 1) } };
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", cancel);
    }
  }
}

export const openCodeApiAdapter = new OpenCodeApiAdapter();
