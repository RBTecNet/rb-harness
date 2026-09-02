import {
  measured,
  unmeasured,
  type CanonicalSemanticResponse,
  type CanonicalUsage,
  type ModelProfile,
  type ProviderOutcome,
  type ProviderRuntimeObservation,
  type SemanticRequest,
} from "../contract.js";

export type OpenCodeCliEvent =
  | { readonly kind: "text"; readonly id?: string; readonly text: string }
  | { readonly kind: "step-start"; readonly modelId?: string; readonly messageId?: string }
  | { readonly kind: "step-finish"; readonly reason?: string; readonly usage?: Readonly<Record<string, number>> }
  | { readonly kind: "complete" }
  | { readonly kind: "error"; readonly classification: "auth" | "transport" | "provider-error" };

export interface OpenCodeCliRawResponse {
  readonly events: readonly OpenCodeCliEvent[];
  readonly toolEventsObserved: number;
  readonly assistantMessageCount: number;
  readonly observedModelIds: readonly string[];
  readonly exitCode: number | null;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly firstOutputMs?: number;
  readonly streamComplete: boolean;
  readonly treeQuiescent: boolean;
  readonly treeVerified: boolean;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function classifyError(value: unknown): "auth" | "transport" | "provider-error" {
  const code = String(object(value).code ?? object(value).name ?? "");
  if (/auth|unauthorized|credential/i.test(code)) return "auth";
  if (/network|timeout|connection|socket/i.test(code)) return "transport";
  return "provider-error";
}

function modelFrom(part: Record<string, unknown>): string | undefined {
  const provider = typeof part.providerID === "string" ? part.providerID : typeof part.providerId === "string" ? part.providerId : undefined;
  const model = typeof part.modelID === "string" ? part.modelID : typeof part.modelId === "string" ? part.modelId : undefined;
  if (provider && model) return `${provider}/${model}`;
  return typeof part.model === "string" && part.model.includes("/") ? part.model : undefined;
}

/** Convert transport JSONL into a bounded whitelist before recording or diagnostics. */
export function decodeOpenCodeCliJsonl(
  stdout: string,
  facts: Omit<OpenCodeCliRawResponse, "events" | "toolEventsObserved" | "assistantMessageCount" | "observedModelIds">
    & Partial<Pick<OpenCodeCliRawResponse, "assistantMessageCount" | "observedModelIds">>,
): ProviderOutcome<OpenCodeCliRawResponse> {
  const events: OpenCodeCliEvent[] = [];
  let toolEventsObserved = 0;
  const toolCallIds = new Set<string>();
  try {
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const envelope = object(JSON.parse(line));
      const part = object(envelope.part ?? object(envelope.properties).part);
      const type = String(envelope.type ?? part.type ?? "");
      if (/^(?:tool|tool[-_.](?:call|use|invocation|execution))(?:[-_.].*)?$/.test(type)
        || /^(?:tool|tool[-_.](?:call|use|invocation|execution))(?:[-_.].*)?$/.test(String(part.type ?? ""))) {
        const callId = [part.callID, part.callId, part.tool_call_id, part.id]
          .find((value): value is string => typeof value === "string" && value.length > 0);
        if (!callId || !toolCallIds.has(callId)) toolEventsObserved += 1;
        if (callId) toolCallIds.add(callId);
      } else if ((type === "text" || part.type === "text") && typeof part.text === "string") {
        events.push({ kind: "text", ...(typeof part.id === "string" ? { id: part.id } : {}), text: part.text });
      } else if (type === "step-start" || type === "step_start" || part.type === "step-start") {
        const modelId = modelFrom(part);
        events.push({ kind: "step-start", ...(modelId ? { modelId } : {}), ...(typeof part.messageID === "string" ? { messageId: part.messageID } : {}) });
      } else if (type === "step-finish" || type === "step_finish" || part.type === "step-finish") {
        const tokens = object(part.tokens ?? part.usage);
        const cache = object(tokens.cache);
        const usage: Record<string, number> = {};
        for (const [target, source] of [["input", tokens.input], ["output", tokens.output], ["reasoning", tokens.reasoning], ["cacheRead", cache.read], ["cacheWrite", cache.write], ["cost", part.cost]] as const) {
          const value = finite(source);
          if (value !== undefined) usage[target] = value;
        }
        events.push({ kind: "step-finish", ...(typeof part.reason === "string" ? { reason: part.reason } : {}), ...(Object.keys(usage).length ? { usage } : {}) });
      } else if (type === "message.updated") {
        const info = object(object(envelope.properties).info);
        const modelId = modelFrom(info);
        if (modelId) events.push({ kind: "step-start", modelId, ...(typeof info.id === "string" ? { messageId: info.id } : {}) });
      } else if (type === "complete" || type === "session.idle") events.push({ kind: "complete" });
      else if (type === "error" || part.type === "error") events.push({ kind: "error", classification: classifyError(part.error ?? envelope.error) });
      // Thinking, account, path, session, and other events are intentionally discarded.
      // Tool content is discarded too; only the sanitized occurrence count survives.
    }
  } catch {
    return { ok: false, error: { kind: "malformed-syntax", message: "OpenCode CLI emitted malformed JSONL", transportRetryable: false } };
  }
  return { ok: true, value: {
    ...facts, events, toolEventsObserved,
    assistantMessageCount: facts.assistantMessageCount ?? 0,
    observedModelIds: [...new Set(facts.observedModelIds ?? [])].sort(),
  } };
}

export function isOpenCodeCliRawResponse(raw: unknown): raw is OpenCodeCliRawResponse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const value = raw as Record<string, unknown>;
  return Array.isArray(value.events) && typeof value.startedAt === "string" && typeof value.completedAt === "string"
    && typeof value.streamComplete === "boolean" && typeof value.treeQuiescent === "boolean" && typeof value.treeVerified === "boolean"
    && Number.isInteger(value.toolEventsObserved) && Number(value.toolEventsObserved) >= 0
    && Number.isInteger(value.assistantMessageCount) && Number(value.assistantMessageCount) >= 0
    && Array.isArray(value.observedModelIds) && value.observedModelIds.every((item) => typeof item === "string")
    && (typeof value.exitCode === "number" || value.exitCode === null);
}

export function usageFromOpenCodeCli(profile: ModelProfile, raw?: Pick<OpenCodeCliRawResponse, "events">): CanonicalUsage {
  const total: Record<string, number> = {};
  for (const event of raw?.events ?? []) if (event.kind === "step-finish" && event.usage) {
    for (const [key, value] of Object.entries(event.usage)) total[key] = (total[key] ?? 0) + value;
  }
  const metric = (key: keyof ModelProfile["usageReporting"], source: string) => !profile.usageReporting[key]
    ? unmeasured<number>("unsupported-by-provider")
    : total[source] === undefined ? unmeasured<number>("not-reported-in-this-response") : measured(total[source]!);
  return {
    inputTokens: metric("inputTokens", "input"), cachedInputTokens: metric("cachedInputTokens", "cacheRead"),
    cacheWriteTokens: metric("cacheWriteTokens", "cacheWrite"), outputTokens: metric("outputTokens", "output"),
    reasoningTokens: metric("reasoningTokens", "reasoning"), costUsd: metric("costUsd", "cost"),
    providerRequests: unmeasured("unsupported-by-provider"),
  };
}

export function observeOpenCodeCli(raw: unknown): ProviderRuntimeObservation | undefined {
  if (!isOpenCodeCliRawResponse(raw)) return undefined;
  const messages = new Set<string>();
  for (const event of raw.events) if (event.kind === "step-start") {
    if (event.messageId) messages.add(event.messageId);
  }
  return {
    assistantMessageIds: [...messages].sort(), modelIds: [...new Set(raw.observedModelIds)].sort(), declaredTools: [], usedTools: [], mcpServers: [],
    structuredOutputPresent: raw.events.some((event) => event.kind === "text"), streamComplete: raw.streamComplete,
    treeQuiescent: raw.treeQuiescent, treeVerified: raw.treeVerified, toolEventsObserved: raw.toolEventsObserved,
  };
}

export function normalizeOpenCodeCli(profile: ModelProfile, request: SemanticRequest, raw: OpenCodeCliRawResponse): ProviderOutcome<CanonicalSemanticResponse> {
  const usage = usageFromOpenCodeCli(profile, raw);
  if (!raw.treeQuiescent) return { ok: false, error: { kind: "transport", message: "OpenCode CLI process tree did not confirm quiescence", transportRetryable: false, usage } };
  if (!raw.streamComplete) return { ok: false, error: { kind: "output-truncated", message: "OpenCode CLI process ended without an exit status", transportRetryable: false, usage } };
  const error = raw.events.find((event) => event.kind === "error");
  if (error?.kind === "error") return { ok: false, error: { kind: error.classification, message: `OpenCode CLI reported a ${error.classification} failure`, transportRetryable: error.classification === "transport", usage } };
  if (raw.exitCode !== 0) return { ok: false, error: { kind: "provider-error", message: `OpenCode CLI exited with status ${String(raw.exitCode)}`, transportRetryable: false, usage } };
  if (raw.toolEventsObserved > 0) return { ok: false, error: { kind: "provider-error", message: "OpenCode CLI emitted tool activity in model-transport mode", transportRetryable: false, usage } };
  const observations = observeOpenCodeCli(raw)!;
  if (observations.modelIds.length !== 1 || observations.modelIds[0] !== profile.modelId) {
    return { ok: false, error: { kind: "provider-error", message: "OpenCode CLI observed model identity does not match the exact requested selector", transportRetryable: false, usage } };
  }
  const texts = new Map<string, string>();
  const anonymous: string[] = [];
  let stopReason = "completed";
  for (const event of raw.events) {
    if (event.kind === "text") {
      if (event.id) {
        const previous = texts.get(event.id);
        texts.set(event.id, previous === undefined || event.text.startsWith(previous) ? event.text : previous + event.text);
      } else anonymous.push(event.text);
    }
    if (event.kind === "step-finish" && event.reason) stopReason = event.reason;
  }
  if (/length|max.tokens|output.limit/i.test(stopReason)) return { ok: false, error: { kind: "output-truncated", message: "OpenCode CLI exhausted the output token limit", transportRetryable: false, usage } };
  const candidates = [...texts.values(), ...anonymous].filter((value) => value.trim());
  if (candidates.length === 0) return { ok: false, error: { kind: "provider-error", message: "OpenCode CLI did not expose visible output", transportRetryable: false, usage } };
  if (candidates.length !== 1) return { ok: false, error: { kind: "provider-error", message: "OpenCode CLI exposed multiple authoritative text parts", transportRetryable: false, usage } };
  const visible = candidates[0]!;
  let payload: unknown;
  try { payload = JSON.parse(visible); }
  catch { return { ok: false, error: { kind: "malformed-syntax", message: "OpenCode CLI visible output is not valid JSON", transportRetryable: false, usage } }; }
  return { ok: true, value: {
    slice: request.slice, payload, normalizations: [], usage,
    transport: {
      startedAt: raw.startedAt, completedAt: raw.completedAt,
      firstOutputMs: raw.firstOutputMs === undefined ? unmeasured("not-reported-in-this-response") : measured(raw.firstOutputMs),
      httpStatus: unmeasured("unsupported-by-provider"), requestId: unmeasured("not-reported-in-this-response"), stopReason: measured(stopReason),
    },
  } };
}
