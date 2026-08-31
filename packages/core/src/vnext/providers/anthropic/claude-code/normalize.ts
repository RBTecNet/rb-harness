import {
  measured,
  unmeasured,
  type CanonicalSemanticResponse,
  type CanonicalUsage,
  type ModelProfile,
  type ProviderOutcome,
  type SemanticRequest,
} from "../../contract.js";
import { resolvedModelForProfile } from "./runtime-model.js";
import type { ClaudeCodeCommandResult } from "./process.js";

export interface ClaudeCodeRawResponse {
  readonly events: readonly unknown[];
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly firstOutputMs?: number;
  readonly streamComplete: boolean;
  readonly treeQuiescent: boolean;
  readonly treeVerified: boolean;
  readonly stderrClassification?: "auth" | "transport" | "provider-error";
}

export interface ClaudeCodeObservation {
  readonly numTurns?: number;
  readonly assistantStepIds: readonly string[];
  readonly modelIds: readonly string[];
  readonly tools: readonly string[];
  readonly toolUses: readonly string[];
  readonly mcpServers: readonly string[];
  readonly resultSubtype?: string;
  readonly hasStructuredOutput: boolean;
  readonly apiKeySource?: string;
  readonly subagentsSpawned?: number;
  readonly isolatedWorkingDirectory?: boolean;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function metric(usage: Record<string, unknown>, key: string) {
  const value = finite(usage[key]);
  return value === undefined ? unmeasured<number>("not-reported-in-this-response") : measured(value);
}

function classifyStderr(stderr: string): ClaudeCodeRawResponse["stderrClassification"] {
  if (/not logged in|authentication|auth login|unauthorized|oauth|subscription/i.test(stderr)) return "auth";
  if (/network|connection|timed out|socket|ECONN|ENOTFOUND/i.test(stderr)) return "transport";
  return stderr.trim() ? "provider-error" : undefined;
}

export function decodeClaudeCodeStream(result: ClaudeCodeCommandResult): ProviderOutcome<ClaudeCodeRawResponse> {
  if (result.outputLimitExceeded) {
    return { ok: false, error: { kind: "output-truncated", message: "Claude Code output exceeded the bounded capture limit", transportRetryable: false } };
  }
  const events: unknown[] = [];
  try {
    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      events.push(JSON.parse(line));
    }
  } catch (cause) {
    return {
      ok: false,
      error: {
        kind: "malformed-syntax",
        message: `Claude Code stream contains malformed JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        transportRetryable: false,
      },
    };
  }
  if (!events.length && result.exitCode === 0) {
    return { ok: false, error: { kind: "malformed-syntax", message: "Claude Code emitted no stream-json envelope", transportRetryable: false } };
  }
  return {
    ok: true,
    value: {
      events,
      exitCode: result.exitCode,
      exitSignal: result.exitSignal,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      ...(result.firstOutputMs === undefined ? {} : { firstOutputMs: result.firstOutputMs }),
      streamComplete: result.exitCode !== null,
      treeQuiescent: result.settlement.quiescent,
      treeVerified: result.settlement.verified,
      ...(classifyStderr(result.stderr) ? { stderrClassification: classifyStderr(result.stderr) } : {}),
    },
  };
}

export function observeClaudeCode(raw: ClaudeCodeRawResponse): ClaudeCodeObservation {
  const stepIds = new Set<string>();
  const modelIds = new Set<string>();
  const tools = new Set<string>();
  const toolUses = new Set<string>();
  const mcpServers = new Set<string>();
  let numTurns: number | undefined;
  let resultSubtype: string | undefined;
  let hasStructuredOutput = false;
  let apiKeySource: string | undefined;
  let subagentsSpawned: number | undefined;
  let isolatedWorkingDirectory: boolean | undefined;

  for (const eventValue of raw.events) {
    const event = object(eventValue);
    if (event.type === "assistant") {
      const message = object(event.message);
      const synthetic = event.is_api_error_message === true || message.model === "<synthetic>";
      if (!synthetic && typeof message.id === "string") stepIds.add(message.id);
      if (!synthetic && typeof message.model === "string") modelIds.add(message.model);
      if (Array.isArray(message.content)) {
        for (const blockValue of message.content) {
          const block = object(blockValue);
          if (block.type === "tool_use" && typeof block.name === "string") toolUses.add(block.name);
        }
      }
    }
    if (event.type === "system" && event.subtype === "init") {
      if (Array.isArray(event.tools)) for (const tool of event.tools) if (typeof tool === "string") tools.add(tool);
      if (Array.isArray(event.mcp_servers)) {
        for (const server of event.mcp_servers) {
          if (typeof server === "string") mcpServers.add(server);
          else if (typeof object(server).name === "string") mcpServers.add(object(server).name as string);
        }
      }
      if (typeof event.model === "string") modelIds.add(event.model);
      if (typeof event.apiKeySource === "string") apiKeySource = event.apiKeySource;
      if (typeof event.cwd === "string") isolatedWorkingDirectory = /(?:^|[/\\])rb-vnext-claude-code-[^/\\]+$/.test(event.cwd);
    }
    if (event.type === "result") {
      if (typeof event.num_turns === "number" && Number.isInteger(event.num_turns)) numTurns = event.num_turns;
      if (typeof event.subtype === "string") resultSubtype = event.subtype;
      hasStructuredOutput = Object.hasOwn(event, "structured_output");
      const modelUsage = object(event.modelUsage ?? event.model_usage);
      for (const modelId of Object.keys(modelUsage)) modelIds.add(modelId);
      const spawned = finite(object(event.subagent_stats).spawned);
      if (spawned !== undefined) subagentsSpawned = spawned;
    }
  }
  return {
    ...(numTurns === undefined ? {} : { numTurns }),
    assistantStepIds: [...stepIds].sort(),
    modelIds: [...modelIds].sort(),
    tools: [...tools].sort(),
    toolUses: [...toolUses].sort(),
    mcpServers: [...mcpServers].sort(),
    ...(resultSubtype === undefined ? {} : { resultSubtype }),
    hasStructuredOutput,
    ...(apiKeySource === undefined ? {} : { apiKeySource }),
    ...(subagentsSpawned === undefined ? {} : { subagentsSpawned }),
    ...(isolatedWorkingDirectory === undefined ? {} : { isolatedWorkingDirectory }),
  };
}

function errorFromEnvelope(raw: ClaudeCodeRawResponse, observation: ClaudeCodeObservation): ProviderOutcome<never> {
  if (!raw.treeQuiescent) {
    return { ok: false, error: { kind: "transport", message: "Claude Code process tree did not confirm quiescence", transportRetryable: false } };
  }
  if (!raw.streamComplete) {
    return { ok: false, error: { kind: "output-truncated", message: "Claude Code stream ended without an exit status", transportRetryable: false } };
  }
  if (raw.stderrClassification === "auth") {
    return { ok: false, error: { kind: "auth", message: "Claude Code subscription authentication failed", transportRetryable: false } };
  }
  if (raw.exitCode !== 0 || observation.resultSubtype !== "success") {
    const kind = observation.resultSubtype?.includes("max_turn")
      ? "provider-error"
      : raw.stderrClassification === "transport"
        ? "transport"
        : "provider-error";
    return {
      ok: false,
      error: {
        kind,
        message: `Claude Code invocation failed${observation.resultSubtype ? ` with subtype ${observation.resultSubtype}` : ` with exit code ${String(raw.exitCode)}`}`,
        transportRetryable: kind === "transport",
      },
    };
  }
  return { ok: false, error: { kind: "provider-error", message: "Claude Code result envelope was unusable", transportRetryable: false } };
}

export function extractClaudeCodePayload(
  profile: ModelProfile,
  request: SemanticRequest,
  raw: ClaudeCodeRawResponse,
): ProviderOutcome<CanonicalSemanticResponse> {
  if (!raw.streamComplete) {
    return { ok: false, error: { kind: "output-truncated", message: "Claude Code stream ended before a complete result", transportRetryable: false } };
  }
  const observation = observeClaudeCode(raw);
  const resultEvents = raw.events.map(object).filter((event) => event.type === "result");
  if (resultEvents.length !== 1) {
    if (raw.exitCode !== 0) return errorFromEnvelope(raw, observation);
    return { ok: false, error: { kind: "malformed-syntax", message: "Claude Code did not emit exactly one result envelope", transportRetryable: false } };
  }
  const result = resultEvents[0]!;
  if (raw.exitCode !== 0 || result.subtype !== "success" || result.is_error === true) return errorFromEnvelope(raw, observation);
  if (!raw.treeQuiescent) return errorFromEnvelope(raw, observation);
  if (observation.modelIds.length !== 1) {
    return { ok: false, error: { kind: "provider-error", message: `MODEL_IDENTITY_DISAGREEMENT: Claude Code observed model set ${observation.modelIds.join(", ") || "none"}`, transportRetryable: false } };
  }
  const expectedModel = resolvedModelForProfile(profile);
  if (expectedModel !== undefined && observation.modelIds[0] !== expectedModel) {
    return { ok: false, error: { kind: "provider-error", message: `MODEL_COMPATIBILITY_STALE: expected ${expectedModel}, observed ${observation.modelIds[0]}`, transportRetryable: false } };
  }
  if (
    observation.tools.some((tool) => tool !== "StructuredOutput")
    || observation.toolUses.some((tool) => tool !== "StructuredOutput")
    || observation.mcpServers.length
    || observation.subagentsSpawned !== 0
  ) {
    return { ok: false, error: { kind: "provider-error", message: "Claude Code initialized tools or MCP servers in isolated transport mode", transportRetryable: false } };
  }
  if (!Object.hasOwn(result, "structured_output")) {
    return { ok: false, error: { kind: "malformed-syntax", message: "Claude Code result omitted structured_output", transportRetryable: false } };
  }
  const assistant = raw.events.map(object).find((event) => event.type === "assistant");
  const message = object(assistant?.message);
  if (message.stop_reason === "max_tokens") {
    return { ok: false, error: { kind: "output-truncated", message: "Claude Code stopped at the output token limit", transportRetryable: false } };
  }
  const usageObject = object(result.usage);
  const usage: CanonicalUsage = {
    inputTokens: metric(usageObject, "input_tokens"),
    cachedInputTokens: metric(usageObject, "cache_read_input_tokens"),
    cacheWriteTokens: metric(usageObject, "cache_creation_input_tokens"),
    outputTokens: metric(usageObject, "output_tokens"),
    reasoningTokens: unmeasured("unsupported-by-provider"),
    // Claude Code does not expose an authoritative underlying provider-request counter.
    providerRequests: unmeasured("unsupported-by-provider"),
    costUsd: unmeasured("unsupported-by-provider"),
  };
  return {
    ok: true,
    value: {
      slice: request.slice,
      payload: result.structured_output,
      normalizations: [],
      usage,
      transport: {
        startedAt: raw.startedAt,
        completedAt: raw.completedAt,
        firstOutputMs: raw.firstOutputMs === undefined ? unmeasured("not-reported-in-this-response") : measured(raw.firstOutputMs),
        httpStatus: unmeasured("unsupported-by-provider"),
        requestId: observation.assistantStepIds[0]
          ? measured(observation.assistantStepIds[0])
          : unmeasured("not-reported-in-this-response"),
        stopReason: typeof message.stop_reason === "string" ? measured(message.stop_reason) : measured("success"),
      },
    },
  };
}

const PRIVATE_ENVELOPE_KEYS = new Set([
  "apiKeySource",
  "costUSD",
  "cost_usd",
  "cwd",
  "messaging_socket_path",
  "permissionMode",
  "session_id",
  "sessionId",
  "total_cost_usd",
  "uuid",
]);

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value === null || typeof value !== "object") return value;
  const safe: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (PRIVATE_ENVELOPE_KEYS.has(key)) continue;
    safe[key] = sanitizeValue(entry);
  }
  return safe;
}

export function sanitizeClaudeCodeRawResponse(raw: ClaudeCodeRawResponse): ClaudeCodeRawResponse {
  return { ...raw, events: raw.events.map(sanitizeValue) };
}
