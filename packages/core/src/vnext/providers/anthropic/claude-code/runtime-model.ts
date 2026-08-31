import { createHash } from "node:crypto";
import type {
  ConformanceState,
  ModelProfile,
  RequestAccounting,
  RuntimeModelSelectorKind,
} from "../../contract.js";
import { CONFORMANCE_SUITE_VERSION } from "../../conformance/suite.js";
import { CLAUDE_CODE_INVOCATION_POLICY } from "./process.js";

export const CLAUDE_CODE_TRANSPORT_PROFILE_ID = "anthropic:claude-code-cli";
export const CLAUDE_CODE_MODEL_SELECTOR_MAX_LENGTH = 256;
export const CLAUDE_CODE_SUGGESTED_ALIASES = ["opus", "sonnet", "fable", "haiku"] as const;

export interface ClaudeCodeTransportProfile {
  readonly id: typeof CLAUDE_CODE_TRANSPORT_PROFILE_ID;
  readonly family: "anthropic";
  readonly transport: "claude-code-cli";
  readonly authKind: "ambient-session";
  readonly requestAccounting: RequestAccounting;
  readonly runtimeVersionPolicy: "exact-evidence";
  readonly structuredOutput: "claude-code-json-schema";
  readonly fallback: "disabled";
  readonly invocationPolicySha256: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function claudeCodeInvocationPolicySha256(): string {
  return sha256Canonical(CLAUDE_CODE_INVOCATION_POLICY);
}

export const CLAUDE_CODE_TRANSPORT_PROFILE: ClaudeCodeTransportProfile = Object.freeze({
  id: CLAUDE_CODE_TRANSPORT_PROFILE_ID,
  family: "anthropic",
  transport: "claude-code-cli",
  authKind: "ambient-session",
  requestAccounting: "opaque",
  runtimeVersionPolicy: "exact-evidence",
  structuredOutput: "claude-code-json-schema",
  fallback: "disabled",
  invocationPolicySha256: claudeCodeInvocationPolicySha256(),
});

export interface RuntimeModelSelection {
  readonly requestedModel: string;
  readonly selectorKind: RuntimeModelSelectorKind;
}

export function validateClaudeCodeModelSelector(value: string): string {
  if (value !== value.trim() || value.length === 0) {
    throw new Error("MODEL_SELECTOR_INVALID: model selector must be non-empty and have no surrounding whitespace");
  }
  if (value.length > CLAUDE_CODE_MODEL_SELECTOR_MAX_LENGTH) {
    throw new Error(`MODEL_SELECTOR_INVALID: model selector exceeds ${CLAUDE_CODE_MODEL_SELECTOR_MAX_LENGTH} characters`);
  }
  if (/\p{Cc}/u.test(value)) throw new Error("MODEL_SELECTOR_INVALID: model selector contains control characters");
  if (/\bsk-[A-Za-z0-9_-]{12,}\b/i.test(value)) throw new Error("MODEL_SELECTOR_INVALID: model selector resembles credential material");
  return value;
}

export function runtimeModelSelection(requestedModel: string, resolvedModel?: string): RuntimeModelSelection {
  const requested = validateClaudeCodeModelSelector(requestedModel);
  const selectorKind: RuntimeModelSelectorKind = resolvedModel === undefined
    ? CLAUDE_CODE_SUGGESTED_ALIASES.includes(requested as typeof CLAUDE_CODE_SUGGESTED_ALIASES[number]) ? "alias" : "exact"
    : requested === resolvedModel ? "exact" : "alias";
  return Object.freeze({ requestedModel: requested, selectorKind });
}

function unavailable(reason: string): ConformanceState {
  return {
    tier: "UNSUPPORTED",
    suiteVersion: CONFORMANCE_SUITE_VERSION,
    runId: null,
    recordedAt: null,
    normalizationsOnHappyPath: [],
    verifiedRecord: false,
    reason,
  };
}

export function createClaudeCodeRuntimeProfile(input: {
  readonly requestedModel: string;
  readonly resolvedModel?: string;
  readonly transportVersion: string;
  readonly maxOutputTokens?: number;
  readonly conformance?: ConformanceState;
  readonly compatibilityEvidenceId?: string;
  readonly compatibilityEvidenceSha256?: string;
  readonly compatibilityStoreRoot?: string;
  readonly compatibilitySource?: "packaged" | "runtime" | "verification-pending";
}): ModelProfile {
  const selection = runtimeModelSelection(input.requestedModel, input.resolvedModel);
  const resolvedModel = input.resolvedModel;
  const profile: ModelProfile = {
    id: CLAUDE_CODE_TRANSPORT_PROFILE_ID,
    family: "anthropic",
    transport: "claude-code-cli",
    requestAccounting: "opaque",
    modelId: resolvedModel ?? selection.requestedModel,
    label: `${resolvedModel ?? selection.requestedModel} via Claude Code subscription`,
    runtime: { kind: "external-executable", versionPolicy: "exact-recorded" },
    structuredOutput: "claude-code-json-schema",
    strictSchema: false,
    toolCalling: false,
    toolChoiceForcing: false,
    reasoning: { supported: true, defaultMode: "on", efforts: ["low"], reportsReasoningTokens: false },
    maxOutputTokens: input.maxOutputTokens ?? 1_024,
    systemRole: "top-level-system",
    streaming: { supported: true, usageInStream: true },
    usageReporting: {
      inputTokens: true,
      cachedInputTokens: true,
      cacheWriteTokens: true,
      outputTokens: true,
      reasoningTokens: false,
      costUsd: false,
    },
    conformance: input.conformance ?? unavailable("runtime model compatibility has not been verified"),
    runtimeModel: {
      transportProfileId: CLAUDE_CODE_TRANSPORT_PROFILE_ID,
      transportVersion: input.transportVersion,
      requestedModel: selection.requestedModel,
      selectorKind: selection.selectorKind,
      ...(resolvedModel === undefined ? {} : { resolvedModel }),
      ...(input.compatibilityEvidenceId ? { compatibilityEvidenceId: input.compatibilityEvidenceId } : {}),
      ...(input.compatibilityEvidenceSha256 ? { compatibilityEvidenceSha256: input.compatibilityEvidenceSha256 } : {}),
      ...(input.compatibilityStoreRoot ? { compatibilityStoreRoot: input.compatibilityStoreRoot } : {}),
      compatibilitySource: input.compatibilitySource ?? "verification-pending",
    },
  };
  return Object.freeze(profile);
}

export function requestedModelForProfile(profile: ModelProfile): string {
  return profile.runtimeModel?.requestedModel ?? profile.modelId;
}

export function resolvedModelForProfile(profile: ModelProfile): string | undefined {
  return profile.runtimeModel ? profile.runtimeModel.resolvedModel : profile.modelId;
}

export function isClaudeCodeRuntimeProfile(profile: ModelProfile): boolean {
  return profile.id === CLAUDE_CODE_TRANSPORT_PROFILE_ID
    && profile.family === "anthropic"
    && profile.transport === "claude-code-cli"
    && profile.runtimeModel?.transportProfileId === CLAUDE_CODE_TRANSPORT_PROFILE_ID;
}
