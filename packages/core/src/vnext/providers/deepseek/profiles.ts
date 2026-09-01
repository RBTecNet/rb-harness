import type { ModelProfile } from "../contract.js";
import { CONFORMANCE_SUITE_VERSION } from "../conformance/suite.js";

export const DEEPSEEK_V4_PRO_PROFILE_ID = "deepseek:deepseek-v4-pro";
export const DEEPSEEK_V4_FLASH_PROFILE_ID = "deepseek:deepseek-v4-flash";

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
 * The declared JSON Schema mechanism is the documented protocol target. The
 * profile remains unavailable until current-suite live evidence is recorded
 * and replayed; declaration alone is not an RB conformance claim.
 */
function deepSeekV4Profile(input: {
  readonly id: string;
  readonly modelId: string;
  readonly label: string;
}): ModelProfile {
  return {
    id: input.id,
    family: "deepseek",
    transport: "direct-api",
    requestAccounting: "exact",
    modelId: input.modelId,
    label: input.label,
    runtime: { kind: "built-in" },
    structuredOutput: "json-schema",
    strictSchema: false,
    toolCalling: false,
    toolChoiceForcing: false,
    reasoning: {
      supported: true,
      defaultMode: "on",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      reportsReasoningTokens: true,
    },
    maxOutputTokens: 384_000,
    systemRole: "top-level-system",
    streaming: { supported: true, usageInStream: true },
    usageReporting: {
      inputTokens: true,
      cachedInputTokens: true,
      cacheWriteTokens: false,
      outputTokens: true,
      reasoningTokens: true,
      costUsd: false,
    },
    conformance: unavailable("no verified current-suite DeepSeek conformance record is loaded"),
  };
}

export const DEEPSEEK_V4_PRO_PROFILE = deepSeekV4Profile({
  id: DEEPSEEK_V4_PRO_PROFILE_ID,
  modelId: "deepseek-v4-pro",
  label: "DeepSeek V4 Pro",
});

export const DEEPSEEK_V4_FLASH_PROFILE = deepSeekV4Profile({
  id: DEEPSEEK_V4_FLASH_PROFILE_ID,
  modelId: "deepseek-v4-flash",
  label: "DeepSeek V4 Flash",
});

export const DEEPSEEK_PROFILES: readonly ModelProfile[] = [
  DEEPSEEK_V4_PRO_PROFILE,
  DEEPSEEK_V4_FLASH_PROFILE,
];
