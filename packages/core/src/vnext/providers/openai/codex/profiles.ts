import type { ModelProfile } from "../../contract.js";
import { CONFORMANCE_SUITE_VERSION } from "../../conformance/suite.js";

export const CODEX_SUBSCRIPTION_PROFILE_ID = "openai:codex:gpt-5.6-sol" as const;

export const CODEX_SUBSCRIPTION_PROFILE: ModelProfile = {
  id: CODEX_SUBSCRIPTION_PROFILE_ID,
  family: "openai",
  transport: "codex-app-server",
  requestAccounting: "opaque",
  modelId: "gpt-5.6-sol",
  label: "GPT-5.6 Sol — Codex Subscription",
  runtime: { kind: "external-executable", versionPolicy: "exact-recorded" },
  structuredOutput: "json-schema",
  strictSchema: false,
  toolCalling: false,
  toolChoiceForcing: false,
  reasoning: { supported: false },
  maxOutputTokens: 128_000,
  systemRole: "none",
  streaming: { supported: true, usageInStream: true },
  usageReporting: {
    inputTokens: true,
    cachedInputTokens: true,
    cacheWriteTokens: true,
    outputTokens: true,
    reasoningTokens: true,
    costUsd: false,
  },
  conformance: {
    tier: "UNSUPPORTED",
    suiteVersion: CONFORMANCE_SUITE_VERSION,
    runId: null,
    recordedAt: null,
    normalizationsOnHappyPath: [],
    verifiedRecord: false,
    reason: "no verified current-suite Codex Subscription conformance record is loaded",
  },
};

export const CODEX_SUBSCRIPTION_PROFILES: readonly ModelProfile[] = [CODEX_SUBSCRIPTION_PROFILE];
