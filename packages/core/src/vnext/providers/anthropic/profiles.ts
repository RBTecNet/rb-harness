import type { ModelProfile } from "../contract.js";
import { CONFORMANCE_SUITE_VERSION } from "../conformance/suite.js";

const unavailable = (reason: string): ModelProfile["conformance"] => ({
  tier: "UNSUPPORTED",
  suiteVersion: CONFORMANCE_SUITE_VERSION,
  runId: null,
  recordedAt: null,
  normalizationsOnHappyPath: [],
  verifiedRecord: false,
  reason,
});

/**
 * Capabilities are exact-profile declarations. Support remains unavailable
 * until a current runner-produced record is loaded and verified.
 */
export const CLAUDE_OPUS_5_PROFILE: ModelProfile = {
  id: "anthropic:claude-opus-5",
  family: "anthropic",
  transport: "direct-api",
  requestAccounting: "exact",
  modelId: "claude-opus-5",
  label: "Claude Opus 5",
  runtime: { kind: "built-in" },
  structuredOutput: "forced-tool-argument",
  strictSchema: false,
  toolCalling: true,
  toolChoiceForcing: true,
  reasoning: {
    supported: true,
    defaultMode: "on",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    reportsReasoningTokens: false,
  },
  maxOutputTokens: 128_000,
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
  conformance: unavailable("no verified current-suite conformance record is loaded"),
};

export const ANTHROPIC_PROFILES: readonly ModelProfile[] = [CLAUDE_OPUS_5_PROFILE];
