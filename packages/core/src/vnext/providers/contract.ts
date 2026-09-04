export type JsonSchemaDocument = Readonly<Record<string, unknown>>;

export type MeasuredReason =
  | "unsupported-by-provider"
  | "not-reported-in-this-response"
  | "stream-incomplete";

export type Measured<T> =
  | { readonly measured: true; readonly value: T }
  | { readonly measured: false; readonly reason: MeasuredReason };

export const measured = <T>(value: T): Measured<T> => ({ measured: true, value });
export const unmeasured = <T>(reason: MeasuredReason): Measured<T> => ({ measured: false, reason });

export interface SemanticRequest {
  readonly slice: string;
  readonly instructions: string;
  readonly input: string;
  readonly schema: JsonSchemaDocument;
  readonly schemaName: string;
  readonly limits: {
    readonly maxOutputTokens: number;
    readonly deadlineMs: number;
  };
  readonly reasoning:
    | { readonly mode: "off" }
    | { readonly mode: "on"; readonly effort: string };
  readonly signal: AbortSignal;
}

/** Closed vocabulary. Empty until a current exact-profile fixture proves one is needed. */
export type NormalizationCode = never;

export interface NormalizationEvent {
  readonly code: NormalizationCode;
  readonly detail: string;
}

export interface CanonicalUsage {
  readonly inputTokens: Measured<number>;
  readonly cachedInputTokens: Measured<number>;
  readonly cacheWriteTokens: Measured<number>;
  readonly outputTokens: Measured<number>;
  readonly reasoningTokens: Measured<number>;
  readonly providerRequests: Measured<number>;
  readonly costUsd: Measured<number>;
}

export interface TransportTelemetry {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly firstOutputMs: Measured<number>;
  readonly httpStatus: Measured<number>;
  readonly requestId: Measured<string>;
  readonly stopReason: Measured<string>;
}

/** Integrity-bound, sanitized configuration for a conformed external model invocation. */
export interface ModelInvocationConfigurationEvidence {
  readonly modelId: string;
  readonly effort: string;
  readonly inputMode: "stdin";
  readonly outputMode: "stream-json" | "other";
  readonly systemPromptMode: "replacement-file" | "other";
  readonly settingSources: "none" | "configured";
  readonly strictMcpConfig: boolean;
  readonly configuredMcpServers: number;
  readonly toolsMode: "disabled-except-structured-output" | "other";
  readonly disallowedMcpTools: boolean;
  readonly fallbackModelConfigured: boolean;
  readonly sessionPersistence: "disabled" | "enabled-or-unspecified";
  readonly safeMode: boolean;
  readonly restrictedMode: boolean;
  readonly slashCommands: "disabled" | "enabled-or-unspecified";
  readonly chrome: "disabled" | "enabled-or-unspecified";
  readonly promptSuggestions: "disabled" | "enabled-or-unspecified";
  readonly maxTurns: number;
  readonly structuredOutputRetryLimit: number;
  readonly transportRetryLimit: number;
}

/** Integrity-bound, provider-neutral policy for one external CLI semantic invocation. */
export interface ExternalCliInvocationPolicyEvidence {
  readonly format: "rb-external-cli-invocation-policy/v1";
  readonly outputMode: "json" | "other";
  readonly transportFraming: "jsonl" | "other";
  readonly inputMode: "stdin" | "other";
  readonly ambientAuth: boolean;
  readonly modelArgument: string;
  readonly directoryIsolation: "isolated-temporary" | "not-isolated";
  readonly stderrPolicy: "ignored-not-recorded" | "captured";
  readonly pluginMode: "pure" | "configured";
  readonly toolPolicy: "deny" | "configured";
  readonly externalInstructions: "disabled" | "configured";
  readonly legacyCompatibilityRules: "disabled" | "enabled";
  readonly environmentPolicy: "allowlisted" | "inherited";
  readonly modelBearingProcessesPerSemanticRequest: 1;
  readonly metadataProcessesPerSemanticRequest: 1;
  readonly identitySource: "session-export";
  readonly transportRetryLimit: 0;
}

export interface CanonicalSemanticResponse {
  readonly slice: string;
  readonly payload: unknown;
  readonly normalizations: readonly NormalizationEvent[];
  readonly usage: CanonicalUsage;
  readonly transport: TransportTelemetry;
}

/** Provider-neutral protocol observations used only to re-derive conformance. */
export interface ProviderRuntimeObservation {
  readonly numTurns?: number;
  readonly assistantMessageIds: readonly string[];
  readonly modelIds: readonly string[];
  readonly declaredTools: readonly string[];
  readonly usedTools: readonly string[];
  readonly mcpServers: readonly string[];
  readonly resultSubtype?: string;
  readonly structuredOutputPresent: boolean;
  readonly subagentsSpawned?: number;
  readonly streamComplete: boolean;
  readonly treeQuiescent: boolean;
  readonly treeVerified: boolean;
  readonly toolEventsObserved?: number;
}

export type ProviderErrorKind =
  | "auth"
  | "rate-limit"
  | "transport"
  | "timeout"
  | "cancelled"
  | "output-truncated"
  | "malformed-syntax"
  | "unsupported-capability"
  | "provider-error";

export interface ProviderResponseError {
  readonly kind: ProviderErrorKind;
  readonly message: string;
  readonly transportRetryable: boolean;
  readonly excerpt?: string;
  readonly usage?: CanonicalUsage;
}

export type ProviderOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProviderResponseError };

export type StructuredOutputMechanism =
  | "strict-json-schema"
  | "json-schema"
  | "forced-tool-argument"
  | "claude-code-json-schema"
  | "json-mode"
  | "none";

export type ConformanceTier = "SUPPORTED" | "SUPPORTED_WITH_NORMALIZATION" | "UNSUPPORTED";

export type ProviderTransportId = "direct-api" | "claude-code-cli" | "opencode-cli" | "codex-app-server";

/**
 * Whether underlying provider/model requests are authoritatively observable.
 * Harness-owned transport invocations remain bounded independently of this capability.
 */
export type RequestAccounting = "exact" | "opaque";

export function isRequestAccounting(value: unknown): value is RequestAccounting {
  return value === "exact" || value === "opaque";
}

export function isProviderTransportId(value: unknown): value is ProviderTransportId {
  return value === "direct-api" || value === "claude-code-cli" || value === "opencode-cli" || value === "codex-app-server";
}

export interface ConformanceState {
  readonly tier: ConformanceTier;
  readonly suiteVersion: string;
  readonly runId: string | null;
  readonly recordedAt: string | null;
  readonly normalizationsOnHappyPath: readonly NormalizationCode[];
  readonly verifiedRecord: boolean;
  readonly reason?: string;
}

export type RuntimeModelSelectorKind = "alias" | "exact";

/**
 * Operational runtime-model selection attached only after compatibility has
 * been verified. It is never project or interview authority.
 */
export interface RuntimeModelBinding {
  readonly transportProfileId: string;
  readonly transportVersion: string;
  readonly requestedModel: string;
  readonly selectorKind: RuntimeModelSelectorKind;
  readonly resolvedModel?: string;
  readonly compatibilityEvidenceId?: string;
  readonly compatibilityEvidenceSha256?: string;
  readonly compatibilityStoreRoot?: string;
  readonly compatibilitySource: "packaged" | "runtime" | "verification-pending";
}

export interface ModelProfile {
  readonly id: string;
  readonly family: string;
  readonly transport: ProviderTransportId;
  readonly requestAccounting: RequestAccounting;
  readonly modelId: string;
  readonly label: string;
  readonly runtime:
    | { readonly kind: "built-in" }
    | { readonly kind: "external-executable"; readonly versionPolicy: "exact-recorded" };
  readonly structuredOutput: StructuredOutputMechanism;
  readonly strictSchema: boolean;
  readonly toolCalling: boolean;
  readonly toolChoiceForcing: boolean;
  readonly reasoning:
    | { readonly supported: false }
    | {
        readonly supported: true;
        readonly defaultMode: "off" | "on";
        readonly efforts: readonly string[];
        readonly reportsReasoningTokens: boolean;
      };
  readonly maxOutputTokens: number;
  readonly systemRole: "system" | "developer" | "top-level-system" | "none";
  readonly streaming: { readonly supported: boolean; readonly usageInStream: boolean };
  readonly usageReporting: {
    readonly inputTokens: boolean;
    readonly cachedInputTokens: boolean;
    readonly cacheWriteTokens: boolean;
    readonly outputTokens: boolean;
    readonly reasoningTokens: boolean;
    readonly costUsd: boolean;
  };
  readonly conformance: ConformanceState;
  readonly runtimeModel?: RuntimeModelBinding;
}

export interface ResolvedProviderCredential {
  readonly id: string;
  readonly secret: string;
  readonly attributes: Readonly<Record<string, string>>;
}

export type ResolvedProviderAuth =
  | {
      readonly kind: "credential";
      readonly credential: ResolvedProviderCredential;
    }
  | {
      readonly kind: "ambient-session";
      readonly id: string;
    }
  | {
      readonly kind: "external-auth-store";
      readonly id: string;
      readonly storeKind: "file";
      /** Runtime-only location. It must never be copied into conformance evidence. */
      readonly path: string;
    };

export interface ProviderAdapter {
  readonly family: string;
  readonly transport: ProviderTransportId;
  readonly profiles: readonly ModelProfile[];
  /** Dynamic transport/model targets are admitted explicitly by their adapter. */
  acceptsProfile?(profile: ModelProfile): boolean;
  checkCapabilities(profile: ModelProfile, request: SemanticRequest): ProviderOutcome<true>;
  request(
    profile: ModelProfile,
    auth: ResolvedProviderAuth,
    request: SemanticRequest,
  ): Promise<ProviderOutcome<CanonicalSemanticResponse>>;
  /** Offline protocol replay. Implementations must not perform transport here. */
  replay(
    profile: ModelProfile,
    request: SemanticRequest,
    raw: unknown,
  ): ProviderOutcome<CanonicalSemanticResponse>;
  /** Offline-only protocol observation. It must not perform transport. */
  observeRuntime?(raw: unknown): ProviderRuntimeObservation | undefined;
  /** Current production policy used to reject stale external-transport evidence before execution. */
  invocationConfigurationEvidence?(profile: ModelProfile): ModelInvocationConfigurationEvidence;
  /** Current external-CLI policy used to reject evidence recorded under a different invocation boundary. */
  currentExternalCliInvocationPolicy?(profile: ModelProfile): ExternalCliInvocationPolicyEvidence;
}
