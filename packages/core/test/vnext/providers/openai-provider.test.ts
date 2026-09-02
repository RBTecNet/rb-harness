import { describe, expect, it, vi } from "vitest";
import { discoverOpenAiModels, OPENAI_MODELS_ENDPOINT, type OpenAiDiscoveryTransport } from "../../../src/vnext/providers/openai/discovery.js";
import { assertOpenAiRecordCandidateSanitized, sanitizeOpenAiRawResponseForRecord } from "../../../src/vnext/providers/openai/record.js";
import { OPENAI_GPT_5_6_SOL_PROFILE } from "../../../src/vnext/providers/openai/profiles.js";
import { resolveProviderAdapter, resolveProviderProfile } from "../../../src/vnext/providers/registry.js";
import { openAiSse, openAiSseEvent } from "./openai-helpers.js";

describe("OpenAI provider integration", () => {
  it("registers exact profiles and one direct adapter", () => {
    expect(resolveProviderProfile("openai:gpt-5.6-sol", "openai")).toBe(OPENAI_GPT_5_6_SOL_PROFILE);
    expect(resolveProviderAdapter("openai:gpt-5.6-sol", "openai")).toMatchObject({ family: "openai", transport: "direct-api" });
  });

  it("discovers only safe unique model IDs through an explicit lazy call", async () => {
    const get = vi.fn(async (_input: { readonly endpoint: string; readonly headers: Readonly<Record<string, string>>; readonly signal: AbortSignal }) => ({
      status: 200,
      body: JSON.stringify({ data: [{ id: "gpt-5.6-sol" }, { id: "gpt-5.6-sol" }, { id: "gpt-5.3-codex" }, { id: "unsafe value" }, { object: "model" }] }),
    }));
    const result = await discoverOpenAiModels("secret", new AbortController().signal, { get } as OpenAiDiscoveryTransport);
    expect(result).toEqual(["gpt-5.3-codex", "gpt-5.6-sol"]);
    expect(get).toHaveBeenCalledOnce();
    expect(get.mock.calls[0]![0]).toMatchObject({ endpoint: OPENAI_MODELS_ENDPOINT, headers: { authorization: "Bearer secret" } });
  });

  it("sanitizes reasoning and unsafe errors before record persistence", () => {
    const secret = "OPENAI_RECORD_SECRET_SENTINEL";
    const raw = openAiSse({ value: "ok" }, {
      includeReasoning: true,
      extraFrames: [openAiSseEvent("error", { error: { type: "invalid_request_error", code: "bad_schema", param: "text.format", message: secret } })],
    });
    const sanitized = sanitizeOpenAiRawResponseForRecord({ ...raw, headers: { ...raw.headers, authorization: `Bearer ${secret}` } });
    expect(sanitized.headers).not.toHaveProperty("authorization");
    expect(sanitized.body).not.toContain("response.reasoning");
    expect(sanitized.body).not.toContain("private");
    expect(sanitized.body).not.toContain(secret);
    expect(sanitized.body).toContain("invalid_request_error");
    expect(() => assertOpenAiRecordCandidateSanitized(sanitized, secret)).not.toThrow();
    expect(() => assertOpenAiRecordCandidateSanitized({ secret }, secret)).toThrow();
  });
});
