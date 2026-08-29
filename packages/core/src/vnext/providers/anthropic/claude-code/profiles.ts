import type { ModelProfile } from "../../contract.js";
import { CONFORMANCE_SUITE_VERSION } from "../../conformance/suite.js";

export const CLAUDE_CODE_OPUS_5_PROFILE_ID = "anthropic:claude-code-cli:claude-opus-5";

export const CLAUDE_CODE_OPUS_5_PROFILE: ModelProfile = {
  id: CLAUDE_CODE_OPUS_5_PROFILE_ID,
  family: "anthropic",
  transport: "claude-code-cli",
  requestAccounting: "opaque",
  modelId: "claude-opus-5",
  label: "Claude Opus 5 via Claude Code subscription",
  runtime: { kind: "external-executable", versionPolicy: "exact-recorded" },
  structuredOutput: "claude-code-json-schema",
  strictSchema: false,
  toolCalling: false,
  toolChoiceForcing: false,
  reasoning: {
    supported: true,
    defaultMode: "on",
    efforts: ["low"],
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
  conformance: {
    tier: "UNSUPPORTED",
    suiteVersion: CONFORMANCE_SUITE_VERSION,
    runId: null,
    recordedAt: null,
    normalizationsOnHappyPath: [],
    verifiedRecord: false,
    reason: "no verified current-version Claude Code conformance record is loaded",
  },
};

export const CLAUDE_CODE_PROFILES: readonly ModelProfile[] = [CLAUDE_CODE_OPUS_5_PROFILE];
