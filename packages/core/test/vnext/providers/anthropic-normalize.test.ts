import { describe, expect, it } from "vitest";
import { extractAnthropicPayload, usageFromAnthropic } from "../../../src/vnext/providers/anthropic/normalize.js";
import { CLAUDE_OPUS_5_PROFILE } from "../../../src/vnext/providers/anthropic/profiles.js";
import { anthropicSse } from "./helpers.js";

describe("Anthropic protocol normalizer", () => {
  it("extracts the forced tool input and drops all provider envelope metadata", () => {
    const payload = { arbitrary: { nested: ["a", "b"] }, optional: null };
    const result = extractAnthropicPayload(
      CLAUDE_OPUS_5_PROFILE,
      anthropicSse(payload, { extraBlockMetadata: { requirementsList: "provider metadata only" } }),
      "record_representation",
    );
    expect(result).toMatchObject({ ok: true, value: { payload, normalizations: [], stopReason: "tool_use" } });
    if (result.ok) {
      expect(result.value.payload).not.toHaveProperty("provider_extra");
      expect(result.value.payload).not.toHaveProperty("requirementsList");
    }
  });

  it("returns semantically incomplete provider-structured data as OK", () => {
    const payload = { items: [] };
    const result = extractAnthropicPayload(CLAUDE_OPUS_5_PROFILE, anthropicSse(payload), "record_representation");
    expect(result).toEqual(expect.objectContaining({ ok: true }));
    if (result.ok) expect(result.value.payload).toEqual(payload);
  });

  it("maps malformed syntax and truncation without repairing either", () => {
    const malformed = { ...anthropicSse({ value: true }), body: "data: {!not-json}\n\n" };
    expect(extractAnthropicPayload(CLAUDE_OPUS_5_PROFILE, malformed, "record_representation"))
      .toMatchObject({ ok: false, error: { kind: "malformed-syntax" } });

    const truncated = { ...anthropicSse({ value: true }), streamComplete: false };
    expect(extractAnthropicPayload(CLAUDE_OPUS_5_PROFILE, truncated, "record_representation"))
      .toMatchObject({ ok: false, error: { kind: "output-truncated" } });

    const capped = anthropicSse({ value: true }, { stopReason: "max_tokens" });
    expect(extractAnthropicPayload(CLAUDE_OPUS_5_PROFILE, capped, "record_representation"))
      .toMatchObject({ ok: false, error: { kind: "output-truncated" } });
  });

  it("distinguishes reported zero, absent, and provider-unsupported metrics", () => {
    const usage = usageFromAnthropic({ input_tokens: 0, output_tokens: 0 }, true);
    expect(usage.inputTokens).toEqual({ measured: true, value: 0 });
    expect(usage.outputTokens).toEqual({ measured: true, value: 0 });
    expect(usage.cachedInputTokens).toEqual({ measured: false, reason: "not-reported-in-this-response" });
    expect(usage.reasoningTokens).toEqual({ measured: false, reason: "unsupported-by-provider" });
    expect(usage.costUsd).toEqual({ measured: false, reason: "unsupported-by-provider" });
    expect(usage.providerRequests).toEqual({ measured: true, value: 1 });
  });
});
