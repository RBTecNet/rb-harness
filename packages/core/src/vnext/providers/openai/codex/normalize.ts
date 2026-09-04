import {
  measured,
  unmeasured,
  type CanonicalSemanticResponse,
  type CanonicalUsage,
  type ModelProfile,
  type ProviderOutcome,
  type ProviderRuntimeObservation,
  type SemanticRequest,
} from "../../contract.js";

export const EMPTY_TOOL_MANIFEST_SHA256 = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";

export interface CodexSemanticPreflight {
  readonly semanticMode: boolean;
  readonly semanticModeVersion: string;
  readonly runtimeVersion: string;
  readonly model: string;
  readonly modelProvider: string;
  readonly toolPolicy: string;
  readonly effectiveToolCount: number;
  readonly toolManifestDigest: string;
  readonly instructionPolicy: string;
  readonly outputSchemaStrict: boolean;
  readonly authenticated: boolean;
  readonly authMode: string;
  readonly authStoreKind: string;
  readonly sessionMode: string;
  readonly requestedCodexTurns: number;
  readonly requestAccounting: string;
}

export interface CodexSemanticCompletion {
  readonly initialModel: string;
  readonly initialModelProvider: string;
  readonly finalModel: string;
  readonly finalModelProvider: string;
  readonly rerouted: boolean;
  readonly rerouteReason?: string;
}

export interface CodexActionCounts {
  readonly commandExecutionEvents: number;
  readonly fileChangeEvents: number;
  readonly mcpToolEvents: number;
  readonly appToolEvents: number;
  readonly webSearchEvents: number;
  readonly otherToolEvents: number;
}

export interface CodexTokenUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
}

/** Sanitized app-server result. No auth, session ids, paths, tool payloads, or reasoning enter this shape. */
export interface CodexAppServerRawResponse {
  readonly preflight: CodexSemanticPreflight;
  readonly completion?: CodexSemanticCompletion;
  readonly terminalStatus?: string;
  readonly finalMessages: readonly string[];
  readonly actionCounts: CodexActionCounts;
  readonly usage?: CodexTokenUsage;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly firstOutputMs?: number;
  readonly streamComplete: boolean;
  readonly processCompleted: boolean;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => key in value);
}

export function isCodexSemanticPreflight(value: unknown): value is CodexSemanticPreflight {
  const item = object(value);
  return exactKeys(item, [
    "semanticMode", "semanticModeVersion", "runtimeVersion", "model", "modelProvider", "toolPolicy",
    "effectiveToolCount", "toolManifestDigest", "instructionPolicy", "outputSchemaStrict", "authenticated",
    "authMode", "authStoreKind", "sessionMode", "requestedCodexTurns", "requestAccounting",
  ]);
}

export function validateCodexSemanticPreflight(
  profile: ModelProfile,
  value: unknown,
  runtime: { readonly semanticRuntimeVersion: string; readonly semanticModeVersion: string },
): ProviderOutcome<CodexSemanticPreflight> {
  if (!isCodexSemanticPreflight(value)) {
    return { ok: false, error: { kind: "unsupported-capability", message: "rb-codex semantic preflight is absent or malformed", transportRetryable: false } };
  }
  const expected: Readonly<Record<keyof CodexSemanticPreflight, unknown>> = {
    semanticMode: true,
    semanticModeVersion: runtime.semanticModeVersion,
    runtimeVersion: runtime.semanticRuntimeVersion,
    model: profile.modelId,
    modelProvider: "openai",
    toolPolicy: "none",
    effectiveToolCount: 0,
    toolManifestDigest: EMPTY_TOOL_MANIFEST_SHA256,
    instructionPolicy: "isolated",
    outputSchemaStrict: false,
    authenticated: true,
    authMode: "chatgpt",
    authStoreKind: "file",
    sessionMode: "ephemeral",
    requestedCodexTurns: 1,
    requestAccounting: "opaque",
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key as keyof CodexSemanticPreflight] !== expectedValue) {
      return { ok: false, error: { kind: key === "authenticated" || key === "authMode" || key === "authStoreKind" ? "auth" : "unsupported-capability", message: `rb-codex semantic preflight invariant failed: ${key}`, transportRetryable: false } };
    }
  }
  return { ok: true, value };
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function isCodexAppServerRawResponse(value: unknown): value is CodexAppServerRawResponse {
  const raw = object(value);
  const counts = object(raw.actionCounts);
  return isCodexSemanticPreflight(raw.preflight)
    && (raw.completion === undefined || typeof raw.completion === "object" && raw.completion !== null)
    && (raw.terminalStatus === undefined || typeof raw.terminalStatus === "string")
    && Array.isArray(raw.finalMessages) && raw.finalMessages.every((item) => typeof item === "string")
    && ["commandExecutionEvents", "fileChangeEvents", "mcpToolEvents", "appToolEvents", "webSearchEvents", "otherToolEvents"].every((key) => nonnegativeInteger(counts[key]))
    && typeof raw.startedAt === "string" && typeof raw.completedAt === "string"
    && typeof raw.streamComplete === "boolean" && typeof raw.processCompleted === "boolean";
}

function usageFor(profile: ModelProfile, raw: CodexAppServerRawResponse): CanonicalUsage {
  const metric = (key: keyof ModelProfile["usageReporting"], value: number | undefined) => !profile.usageReporting[key]
    ? unmeasured<number>("unsupported-by-provider")
    : value === undefined ? unmeasured<number>(raw.streamComplete ? "not-reported-in-this-response" : "stream-incomplete") : measured(value);
  return {
    inputTokens: metric("inputTokens", raw.usage?.inputTokens),
    cachedInputTokens: metric("cachedInputTokens", raw.usage?.cachedInputTokens),
    cacheWriteTokens: metric("cacheWriteTokens", raw.usage?.cacheWriteInputTokens),
    outputTokens: metric("outputTokens", raw.usage?.outputTokens),
    reasoningTokens: metric("reasoningTokens", raw.usage?.reasoningOutputTokens),
    costUsd: unmeasured("unsupported-by-provider"),
    providerRequests: unmeasured("unsupported-by-provider"),
  };
}

export function observeCodexAppServer(raw: unknown): ProviderRuntimeObservation | undefined {
  if (!isCodexAppServerRawResponse(raw)) return undefined;
  const actionTotal = Object.values(raw.actionCounts).reduce((sum, count) => sum + count, 0);
  return {
    assistantMessageIds: raw.finalMessages.map((_, index) => `completed-assistant-${index + 1}`),
    modelIds: raw.completion ? [raw.completion.finalModel] : [],
    declaredTools: [],
    usedTools: [],
    mcpServers: [],
    structuredOutputPresent: raw.finalMessages.length === 1,
    streamComplete: raw.streamComplete,
    treeQuiescent: raw.processCompleted,
    treeVerified: raw.processCompleted,
    toolEventsObserved: actionTotal,
  };
}

export function normalizeCodexAppServer(
  profile: ModelProfile,
  request: SemanticRequest,
  raw: CodexAppServerRawResponse,
): ProviderOutcome<CanonicalSemanticResponse> {
  const usage = usageFor(profile, raw);
  if (!raw.processCompleted) return { ok: false, error: { kind: "transport", message: "rb-codex app-server did not terminate cleanly", transportRetryable: false, usage } };
  if (!raw.streamComplete || raw.terminalStatus === undefined) return { ok: false, error: { kind: "output-truncated", message: "rb-codex app-server ended without authoritative turn completion", transportRetryable: false, usage } };
  if (raw.terminalStatus !== "completed") return { ok: false, error: { kind: raw.terminalStatus === "interrupted" ? "cancelled" : "provider-error", message: `rb-codex semantic turn ended with status ${raw.terminalStatus}`, transportRetryable: false, usage } };
  const action = Object.entries(raw.actionCounts).find(([, count]) => count !== 0);
  if (action) return { ok: false, error: { kind: "provider-error", message: `rb-codex semantic invocation emitted ${action[0]}=${action[1]}`, transportRetryable: false, usage } };
  const completion = raw.completion;
  if (!completion) return { ok: false, error: { kind: "provider-error", message: "rb-codex semantic completion identity is absent", transportRetryable: false, usage } };
  if (completion.initialModel !== profile.modelId || completion.initialModelProvider !== "openai"
    || completion.finalModel !== profile.modelId || completion.finalModelProvider !== "openai" || completion.rerouted) {
    return { ok: false, error: { kind: "provider-error", message: "rb-codex exact model identity changed or was rerouted", transportRetryable: false, usage } };
  }
  if (raw.finalMessages.length !== 1) return { ok: false, error: { kind: "provider-error", message: `rb-codex semantic turn produced ${raw.finalMessages.length} authoritative completed assistant messages`, transportRetryable: false, usage } };
  let payload: unknown;
  try { payload = JSON.parse(raw.finalMessages[0]!); }
  catch { return { ok: false, error: { kind: "malformed-syntax", message: "rb-codex authoritative assistant message is not valid JSON", transportRetryable: false, usage } }; }
  return { ok: true, value: {
    slice: request.slice,
    payload,
    normalizations: [],
    usage,
    transport: {
      startedAt: raw.startedAt,
      completedAt: raw.completedAt,
      firstOutputMs: raw.firstOutputMs === undefined ? unmeasured("not-reported-in-this-response") : measured(raw.firstOutputMs),
      httpStatus: unmeasured("unsupported-by-provider"),
      requestId: unmeasured("not-reported-in-this-response"),
      stopReason: measured(raw.terminalStatus),
    },
  } };
}
