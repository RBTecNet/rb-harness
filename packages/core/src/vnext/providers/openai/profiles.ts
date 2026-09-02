import type { ModelProfile } from "../contract.js";
import { CONFORMANCE_SUITE_VERSION } from "../conformance/suite.js";

export const OPENAI_PROFILE_IDS = [
  "openai:gpt-5.6-sol",
  "openai:gpt-5.6-terra",
  "openai:gpt-5.6-luna",
  "openai:gpt-5.3-codex",
] as const;

function unavailable(): ModelProfile["conformance"] {
  return {
    tier: "UNSUPPORTED",
    suiteVersion: CONFORMANCE_SUITE_VERSION,
    runId: null,
    recordedAt: null,
    normalizationsOnHappyPath: [],
    verifiedRecord: false,
    reason: "no verified current-suite OpenAI conformance record is loaded",
  };
}

function profile(input: {
  readonly id: typeof OPENAI_PROFILE_IDS[number];
  readonly modelId: string;
  readonly label: string;
  readonly efforts: readonly string[];
}): ModelProfile {
  return {
    id: input.id,
    family: "openai",
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
      efforts: input.efforts,
      reportsReasoningTokens: false,
    },
    maxOutputTokens: 128_000,
    systemRole: "top-level-system",
    streaming: { supported: true, usageInStream: true },
    usageReporting: {
      inputTokens: true,
      cachedInputTokens: false,
      cacheWriteTokens: false,
      outputTokens: true,
      reasoningTokens: false,
      costUsd: false,
    },
    conformance: unavailable(),
  };
}

export const OPENAI_PROFILES: readonly ModelProfile[] = [
  profile({ id: "openai:gpt-5.6-sol", modelId: "gpt-5.6-sol", label: "OpenAI GPT-5.6 Sol", efforts: ["low", "medium", "high", "xhigh", "max"] }),
  profile({ id: "openai:gpt-5.6-terra", modelId: "gpt-5.6-terra", label: "OpenAI GPT-5.6 Terra", efforts: ["low", "medium", "high", "xhigh", "max"] }),
  profile({ id: "openai:gpt-5.6-luna", modelId: "gpt-5.6-luna", label: "OpenAI GPT-5.6 Luna", efforts: ["low", "medium", "high", "xhigh", "max"] }),
  profile({ id: "openai:gpt-5.3-codex", modelId: "gpt-5.3-codex", label: "OpenAI GPT-5.3 Codex", efforts: ["low", "medium", "high", "xhigh"] }),
];

export const OPENAI_GPT_5_6_SOL_PROFILE = OPENAI_PROFILES[0]!;
export const OPENAI_GPT_5_6_TERRA_PROFILE = OPENAI_PROFILES[1]!;
export const OPENAI_GPT_5_6_LUNA_PROFILE = OPENAI_PROFILES[2]!;
export const OPENAI_GPT_5_3_CODEX_PROFILE = OPENAI_PROFILES[3]!;
