export type OpenCodeService = "go" | "zen";
export type OpenCodeProtocol = "openai-chat" | "anthropic-messages" | "openai-responses";

export interface OpenCodeServiceDefinition {
  readonly id: OpenCodeService;
  readonly label: string;
  readonly baseUrl: string;
  readonly credentialNamespace: "opencode-go" | "opencode-zen";
  readonly cliProvider: "opencode-go" | "opencode";
}

export const OPEN_CODE_SERVICES: Readonly<Record<OpenCodeService, OpenCodeServiceDefinition>> = Object.freeze({
  go: Object.freeze({
    id: "go",
    label: "OpenCode Go API",
    baseUrl: "https://opencode.ai/zen/go/v1",
    credentialNamespace: "opencode-go",
    cliProvider: "opencode-go",
  }),
  zen: Object.freeze({
    id: "zen",
    label: "OpenCode Zen API",
    baseUrl: "https://opencode.ai/zen/v1",
    credentialNamespace: "opencode-zen",
    cliProvider: "opencode",
  }),
});

interface MatrixGroup {
  readonly service: OpenCodeService;
  readonly protocol: OpenCodeProtocol | "google";
  readonly supported: boolean;
  readonly reason?: string;
  readonly models: readonly string[];
}

/**
 * Typed reconstruction of Ralph's proven compatibility matrix. `/models`
 * announces availability only; this matrix alone selects one wire protocol.
 */
const MATRIX_GROUPS: readonly MatrixGroup[] = [
  {
    service: "go", protocol: "openai-responses", supported: true,
    models: ["grok-4.6", "gpt-5.6-luna", "muse-spark-1.2-contributor"],
  },
  {
    service: "go", protocol: "openai-chat", supported: true,
    models: [
      "glm-5.3-flash", "glm-5.3", "glm-5.2", "glm-5.1", "kimi-k3",
      "kimi-k2.7-code", "kimi-k2.6", "longcat-2.0", "deepseek-v4-pro",
      "deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "mimo-v2.5",
      "mimo-v2.5-pro", "hy3",
    ],
  },
  {
    service: "go", protocol: "anthropic-messages", supported: true,
    models: [
      "minimax-m3", "minimax-m2.7", "minimax-m2.5", "qwen3.8-max",
      "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus",
    ],
  },
  {
    service: "zen", protocol: "openai-responses", supported: true,
    models: [
      "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5",
      "gpt-5.5-pro", "gpt-5.4", "gpt-5.4-pro", "gpt-5.4-mini",
      "gpt-5.4-nano", "gpt-5.3-codex", "gpt-5.3-codex-spark", "gpt-5.2",
      "gpt-5.2-codex", "gpt-5.1", "gpt-5.1-codex", "gpt-5.1-codex-max",
      "gpt-5.1-codex-mini", "gpt-5", "gpt-5-codex", "gpt-5-nano",
      "grok-4.6", "grok-4.5", "grok-build-0.1", "muse-spark-1.2",
      "muse-spark-1.2-contributor-free",
    ],
  },
  {
    service: "zen", protocol: "anthropic-messages", supported: true,
    models: [
      "claude-fable-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7",
      "claude-opus-4-6", "claude-opus-4-5", "claude-sonnet-5",
      "claude-sonnet-4-6", "claude-sonnet-4-5", "claude-haiku-4-5",
      "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus", "qwen3.5-plus",
    ],
  },
  {
    service: "zen", protocol: "openai-chat", supported: true,
    models: [
      "deepseek-v4-pro", "deepseek-v4-flash", "minimax-m3", "minimax-m2.7",
      "minimax-m2.5", "glm-5.2", "glm-5.1", "glm-5", "kimi-k2.5",
      "kimi-k2.6", "kimi-k2.7-code", "kimi-k3", "big-pickle",
      "mimo-v2.5-free", "hy3-free",
      "nemotron-3-ultra-free", "nemotron-3.5-lightning-free",
    ],
  },
  {
    service: "zen", protocol: "google", supported: false,
    reason: "google protocol not implemented",
    models: [
      "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash",
      "gemini-3.5-flash-lite", "gemini-3.1-pro", "gemini-3-flash",
    ],
  },
] as const;

export interface OpenCodeCompatibilityEntry {
  readonly service: OpenCodeService;
  readonly modelId: string;
  readonly protocol: OpenCodeProtocol | "google" | "unknown";
  readonly supported: boolean;
  readonly reason?: string;
}

export const OPEN_CODE_COMPATIBILITY: readonly OpenCodeCompatibilityEntry[] = Object.freeze(
  MATRIX_GROUPS.flatMap((group) => group.models.map((modelId) => Object.freeze({
    service: group.service,
    modelId,
    protocol: group.protocol,
    supported: group.supported,
    ...(group.reason ? { reason: group.reason } : {}),
  }))),
);

export function resolveOpenCodeCompatibility(service: OpenCodeService, modelId: string): OpenCodeCompatibilityEntry {
  return OPEN_CODE_COMPATIBILITY.find((entry) => entry.service === service && entry.modelId === modelId)
    ?? { service, modelId, protocol: "unknown", supported: false, reason: "unknown protocol" };
}

export function openCodeApiEndpoint(service: OpenCodeService, modelId: string): string | undefined {
  const resolved = resolveOpenCodeCompatibility(service, modelId);
  if (!resolved.supported) return undefined;
  const suffix = resolved.protocol === "openai-chat"
    ? "chat/completions"
    : resolved.protocol === "anthropic-messages"
      ? "messages"
      : "responses";
  return `${OPEN_CODE_SERVICES[service].baseUrl}/${suffix}`;
}

export function openCodeModelsEndpoint(service: OpenCodeService): string {
  return `${OPEN_CODE_SERVICES[service].baseUrl}/models`;
}

function discoveredModelId(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const candidate = typeof record.id === "string" ? record.id : typeof record.model === "string" ? record.model : "";
  return candidate.trim() || undefined;
}

export interface DiscoveredOpenCodeModel extends OpenCodeCompatibilityEntry {
  readonly available: true;
}

/** Whitelist catalog identity; arbitrary provider metadata is deliberately discarded. */
export function normalizeOpenCodeDiscovery(service: OpenCodeService, payload: unknown): readonly DiscoveredOpenCodeModel[] {
  const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const values = Array.isArray(record.data) ? record.data
    : Array.isArray(record.models) ? record.models
      : Array.isArray(payload) ? payload : [];
  const seen = new Set<string>();
  const result: DiscoveredOpenCodeModel[] = [];
  for (const value of values) {
    const modelId = discoveredModelId(value);
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    result.push({ ...resolveOpenCodeCompatibility(service, modelId), available: true });
  }
  return result;
}

export function openCodeCliSelector(service: OpenCodeService, modelId: string): string {
  return `${OPEN_CODE_SERVICES[service].cliProvider}/${modelId}`;
}
