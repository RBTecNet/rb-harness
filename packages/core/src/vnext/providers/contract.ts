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

export type ProviderTransportId = "direct-api" | "claude-code-cli";

/**
 * Whether underlying provider/model requests are authoritatively observable.
 * Harness-owned transport invocations remain bounded independently of this capability.
 */
export type RequestAccounting = "exact" | "opaque";

export function isRequestAccounting(value: unknown): value is RequestAccounting {
  return value === "exact" || value === "opaque";
}

export function isProviderTransportId(value: unknown): value is ProviderTransportId {
  return value === "direct-api" || value === "claude-code-cli";
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
    };

export interface ProviderAdapter {
  readonly family: string;
  readonly transport: ProviderTransportId;
  readonly profiles: readonly ModelProfile[];
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
}
