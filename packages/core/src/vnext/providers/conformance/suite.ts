import type {
  CanonicalUsage,
  NormalizationCode,
  ProviderErrorKind,
  SemanticRequest,
  ModelProfile,
} from "../contract.js";

export const CONFORMANCE_SUITE_VERSION = "rb-adapter-conformance/v1" as const;

export type ConformanceCategory =
  | "valid-structured-response"
  | "nested-objects"
  | "arrays"
  | "enums"
  | "optional-null-fields"
  | "unknown-provider-metadata"
  | "wrapper-envelope"
  | "fenced-text"
  | "truncated-response"
  | "malformed-syntax"
  | "semantically-incomplete"
  | "unsupported-structured-output"
  | "reasoning-enabled"
  | "reasoning-disabled"
  | "usage-reporting"
  | "cancellation"
  | "timeout";

export type ConformanceExpectation =
  | { readonly kind: "payload-equals"; readonly value: unknown }
  | { readonly kind: "error"; readonly errorKind: ProviderErrorKind }
  | { readonly kind: "usage"; readonly required: readonly (keyof CanonicalUsage)[] }
  | { readonly kind: "capability-refusal" }
  | { readonly kind: "live-smoke"; readonly errorKind: "cancelled" | "timeout" };

export interface ConformanceCase {
  readonly id: string;
  readonly category: ConformanceCategory;
  readonly mandatory: boolean;
  readonly happyPath: boolean;
  readonly recordingKey?: string;
  readonly profile?: (profile: ModelProfile) => ModelProfile;
  readonly request: (signal?: AbortSignal) => SemanticRequest;
  readonly expect: ConformanceExpectation;
}

export interface ConformanceCaseResult {
  readonly id: string;
  readonly category: ConformanceCategory;
  readonly mandatory: boolean;
  readonly passed: boolean;
  readonly normalizations: readonly NormalizationCode[];
  readonly diagnostic?: string;
}

export interface ConformanceResult {
  readonly profileId: string;
  readonly suiteVersion: typeof CONFORMANCE_SUITE_VERSION;
  readonly runId: string;
  readonly recordedAt: string;
  readonly tier: import("../contract.js").ConformanceTier;
  readonly cases: readonly ConformanceCaseResult[];
  readonly normalizationsOnHappyPath: readonly NormalizationCode[];
  readonly capabilitiesActuallyTested: readonly string[];
}

export const MANDATORY_CATEGORIES: readonly ConformanceCategory[] = [
  "valid-structured-response",
  "nested-objects",
  "arrays",
  "enums",
  "optional-null-fields",
  "unknown-provider-metadata",
  "wrapper-envelope",
  "truncated-response",
  "malformed-syntax",
  "semantically-incomplete",
  "unsupported-structured-output",
  "usage-reporting",
  "cancellation",
  "timeout",
];
