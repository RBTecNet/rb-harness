import {
  measured,
  unmeasured,
  type ModelProfile,
  type ProviderAdapter,
  type ProviderOutcome,
  type ResolvedProviderAuth,
  type ResolvedProviderCredential,
  type SemanticRequest,
} from "../contract.js";
import { extractAnthropicPayload, type AnthropicRawResponse } from "./normalize.js";
import { ANTHROPIC_PROFILES } from "./profiles.js";
import { isAnthropicWorkspaceId } from "../../../anthropic-credential.js";

export const ANTHROPIC_MESSAGES_ENDPOINT = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_API_VERSION = "2023-06-01";

export interface AnthropicTransportInput {
  readonly endpoint: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
}

export interface AnthropicTransport {
  send(input: AnthropicTransportInput): Promise<AnthropicRawResponse>;
}

function headers(response: Response): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const name of ["content-type", "request-id", "anthropic-request-id"]) {
    const value = response.headers.get(name);
    if (value) safe[name] = value;
  }
  return safe;
}

export class FetchAnthropicTransport implements AnthropicTransport {
  async send(input: AnthropicTransportInput): Promise<AnthropicRawResponse> {
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
        headers: headers(response),
        body: "",
        startedAt,
        completedAt: new Date().toISOString(),
        streamComplete: false,
      };
    }
    const decoder = new TextDecoder();
    let body = "";
    let firstOutputMs: number | undefined;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (firstOutputMs === undefined) firstOutputMs = Date.now() - started;
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    return {
      status: response.status,
      headers: headers(response),
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

function workspaceHeaders(credential: ResolvedProviderCredential): ProviderOutcome<Readonly<Record<string, string>>> {
  const workspaceId = credential.attributes.workspaceId;
  if (workspaceId === undefined || workspaceId === "") return { ok: true, value: {} };
  if (!isAnthropicWorkspaceId(workspaceId)) {
    return {
      ok: false,
      error: {
        kind: "auth",
        message: `Anthropic credential ${credential.id} has an invalid workspaceId attribute`,
        transportRetryable: false,
      },
    };
  }
  return { ok: true, value: { "anthropic-workspace-id": workspaceId } };
}

export function preflightAnthropic(profile: ModelProfile, request: SemanticRequest): ProviderOutcome<true> {
  if (profile.family !== "anthropic") return unsupported(`profile ${profile.id} is not an Anthropic profile`);
  if (profile.transport !== "direct-api") return unsupported(`profile ${profile.id} does not use the Anthropic direct API transport`);
  if (!ANTHROPIC_PROFILES.some((candidate) => candidate.id === profile.id && candidate.modelId === profile.modelId)) {
    return unsupported(`unknown Anthropic profile: ${profile.id}`);
  }
  if (profile.structuredOutput !== "forced-tool-argument" || !profile.toolCalling || !profile.toolChoiceForcing) {
    return unsupported(`profile ${profile.id} cannot force a structured tool argument`);
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

export function anthropicRequestBody(profile: ModelProfile, request: SemanticRequest): Record<string, unknown> {
  const reasoning = request.reasoning.mode === "on"
    ? { thinking: { type: "adaptive" }, output_config: { effort: request.reasoning.effort } }
    : { thinking: { type: "disabled" } };
  return {
    model: profile.modelId,
    max_tokens: request.limits.maxOutputTokens,
    stream: true,
    system: request.instructions,
    messages: [{ role: "user", content: request.input }],
    tools: [{ name: request.schemaName, input_schema: request.schema }],
    tool_choice: { type: "tool", name: request.schemaName },
    ...reasoning,
  };
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly family = "anthropic";
  readonly transport = "direct-api" as const;
  readonly profiles = ANTHROPIC_PROFILES;

  constructor(private readonly transportClient: AnthropicTransport = new FetchAnthropicTransport()) {}

  checkCapabilities(profile: ModelProfile, request: SemanticRequest): ProviderOutcome<true> {
    return preflightAnthropic(profile, request);
  }

  replay(
    profile: ModelProfile,
    request: SemanticRequest,
    raw: unknown,
  ): ProviderOutcome<import("../contract.js").CanonicalSemanticResponse> {
    const preflight = preflightAnthropic(profile, request);
    if (!preflight.ok) return preflight;
    if (!raw || typeof raw !== "object") {
      return { ok: false, error: { kind: "malformed-syntax", message: "recorded Anthropic response is not an object", transportRetryable: false } };
    }
    return this.canonicalize(profile, request, raw as AnthropicRawResponse);
  }

  private canonicalize(
    profile: ModelProfile,
    request: SemanticRequest,
    raw: AnthropicRawResponse,
  ): ProviderOutcome<import("../contract.js").CanonicalSemanticResponse> {
    const extracted = extractAnthropicPayload(profile, raw, request.schemaName);
    if (!extracted.ok) return extracted;
    const headerRequestId = raw.headers["request-id"] ?? raw.headers["anthropic-request-id"];
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
          requestId: extracted.value.requestId || headerRequestId
            ? measured(extracted.value.requestId ?? headerRequestId!)
            : unmeasured("not-reported-in-this-response"),
          stopReason: extracted.value.stopReason
            ? measured(extracted.value.stopReason)
            : unmeasured("not-reported-in-this-response"),
        },
      },
    };
  }

  async request(
    profile: ModelProfile,
    auth: ResolvedProviderAuth,
    request: SemanticRequest,
  ): Promise<ProviderOutcome<import("../contract.js").CanonicalSemanticResponse>> {
    const preflight = preflightAnthropic(profile, request);
    if (!preflight.ok) return preflight;
    if (auth.kind !== "credential") {
      return { ok: false, error: { kind: "auth", message: "Anthropic direct API requires a resolved credential", transportRetryable: false } };
    }
    const credential = auth.credential;
    const workspace = workspaceHeaders(credential);
    if (!workspace.ok) return workspace;
    if (request.signal.aborted) {
      return { ok: false, error: { kind: "cancelled", message: "request was cancelled before transport", transportRetryable: false } };
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
        endpoint: ANTHROPIC_MESSAGES_ENDPOINT,
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          "anthropic-version": ANTHROPIC_API_VERSION,
          "x-api-key": credential.secret,
          ...workspace.value,
        },
        body: JSON.stringify(anthropicRequestBody(profile, request)),
        signal: controller.signal,
      });
      return this.canonicalize(profile, request, raw);
    } catch (cause) {
      if (deadlineElapsed) {
        return { ok: false, error: { kind: "timeout", message: "Anthropic request exceeded its deadline", transportRetryable: true } };
      }
      if (request.signal.aborted || controller.signal.aborted) {
        return { ok: false, error: { kind: "cancelled", message: "Anthropic request was cancelled", transportRetryable: false } };
      }
      return {
        ok: false,
        error: {
          kind: "transport",
          message: `Anthropic transport failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          transportRetryable: true,
        },
      };
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onCancel);
    }
  }
}

export const anthropicAdapter = new AnthropicAdapter();
