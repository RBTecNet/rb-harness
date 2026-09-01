import { describe, expect, it } from "vitest";
import { DeepSeekAdapter } from "../../../src/vnext/providers/deepseek/adapter.js";
import {
  extractDeepSeekPayload,
  usageFromDeepSeek,
} from "../../../src/vnext/providers/deepseek/normalize.js";
import {
  DEEPSEEK_V4_FLASH_PROFILE,
  DEEPSEEK_V4_PRO_PROFILE,
} from "../../../src/vnext/providers/deepseek/profiles.js";
import type { SemanticRequest } from "../../../src/vnext/providers/contract.js";
import { deepSeekSse, sseEvent } from "./deepseek-helpers.js";

function request(): SemanticRequest {
  return {
    slice: "normalization-probe",
    instructions: "copy",
    input: "{}",
    schema: { type: "object" },
    schemaName: "normalization_probe",
    limits: { maxOutputTokens: 1_024, deadlineMs: 30_000 },
    reasoning: { mode: "on", effort: "low" },
    signal: new AbortController().signal,
  };
}

describe("DeepSeek Responses API normalizer", () => {
  it.each([
    ["simple object", { value: "ok" }],
    ["nested object", { nested: { one: { two: true } } }],
    ["arrays", { values: [[], [1], [1, 2]] }],
    ["enums", { mode: "alpha" }],
    ["null", { optional: null }],
    ["unicode", { text: "ação 漢字 🚀" }],
    ["large bounded object", { values: Array.from({ length: 2_000 }, (_, index) => ({ index, value: `item-${index}` })) }],
  ])("extracts %s exactly and drops provider metadata", (_label, payload) => {
    const result = extractDeepSeekPayload(
      DEEPSEEK_V4_PRO_PROFILE,
      deepSeekSse(payload, { extraResponseMetadata: { vendor_metadata: { requirementsList: "not semantic" } } }),
    );
    expect(result).toMatchObject({ ok: true, value: { payload, normalizations: [], stopReason: "completed", requestId: "resp_fixture" } });
    if (result.ok) expect(JSON.stringify(result.value.payload)).not.toContain("vendor_metadata");
  });

  it("uses the completed terminal envelope as authority after deltas and ignores reasoning text", () => {
    const payload = { final: "terminal" };
    const raw = deepSeekSse(payload, { includeReasoning: true });
    const result = extractDeepSeekPayload(DEEPSEEK_V4_PRO_PROFILE, raw);
    expect(result).toMatchObject({ ok: true, value: { payload } });
    expect(JSON.stringify(result)).not.toContain("private provider reasoning");
    expect(raw.body).toContain("response.output_text.delta");
    expect(raw.body).toContain("response.reasoning_text.delta");
  });

  it.each([
    ["unknown field with a value", "x-trace: abc"],
    ["unknown field without a colon", "vendor-meta"],
  ])("ignores SSE protocol metadata: %s", (_label, metadataLine) => {
    const source = deepSeekSse({ value: "ok" });
    const decorated = {
      ...source,
      body: source.body.replace("event: response.created\n", `event: response.created\n${metadataLine}\n`),
    };
    expect(extractDeepSeekPayload(DEEPSEEK_V4_PRO_PROFILE, decorated))
      .toMatchObject({ ok: true, value: { payload: { value: "ok" } } });
  });

  it("supports comments, blank frames, id/retry fields, CRLF, multiline data, and a final frame at EOF", () => {
    const source = deepSeekSse({ value: "framed" });
    const decoratedBody = `: keepalive\n\n\n\n${source.body}`
      .replace("event: response.created\n", "id: response-id\nretry: 1000\nevent: response.created\n")
      .replace(
        "data: {\"type\":\"response.completed\",",
        "data: {\"type\":\"response.completed\",\ndata: ",
      )
      .replace(/\n/g, "\r\n")
      .replace(/\r\n\r\n$/, "");
    expect(extractDeepSeekPayload(DEEPSEEK_V4_PRO_PROFILE, { ...source, body: decoratedBody }))
      .toMatchObject({ ok: true, value: { payload: { value: "framed" } } });
  });

  it("populates canonical telemetry from measured raw/terminal values", () => {
    const outcome = new DeepSeekAdapter().replay(DEEPSEEK_V4_PRO_PROFILE, request(), deepSeekSse({ value: true }, { firstOutputMs: 37 }));
    expect(outcome).toMatchObject({
      ok: true,
      value: {
        transport: {
          firstOutputMs: { measured: true, value: 37 },
          httpStatus: { measured: true, value: 200 },
          requestId: { measured: true, value: "resp_fixture" },
          stopReason: { measured: true, value: "completed" },
        },
      },
    });
  });

  it("normalizes incomplete and failed terminal events without provider text", () => {
    expect(extractDeepSeekPayload(
      DEEPSEEK_V4_PRO_PROFILE,
      deepSeekSse({}, { status: "incomplete", incompleteReason: "max_output_tokens" }),
    )).toMatchObject({ ok: false, error: { kind: "output-truncated", transportRetryable: false } });
    expect(extractDeepSeekPayload(
      DEEPSEEK_V4_PRO_PROFILE,
      deepSeekSse({}, { status: "incomplete", incompleteReason: "content_filter" }),
    )).toMatchObject({ ok: false, error: { kind: "provider-error", transportRetryable: false } });
    const failed = extractDeepSeekPayload(
      DEEPSEEK_V4_PRO_PROFILE,
      deepSeekSse({}, { status: "failed", error: { code: "server_error", message: "PRIVATE_REASONING_OR_SECRET" } }),
    );
    expect(failed).toMatchObject({ ok: false, error: { kind: "provider-error", message: "DeepSeek response failed (server_error)" } });
    expect(JSON.stringify(failed)).not.toContain("PRIVATE_REASONING_OR_SECRET");
  });

  it("fails closed for an incomplete transport, missing terminal, and malformed event JSON", () => {
    expect(extractDeepSeekPayload(DEEPSEEK_V4_PRO_PROFILE, deepSeekSse({}, { streamComplete: false })))
      .toMatchObject({ ok: false, error: { kind: "output-truncated" } });
    const missing = { ...deepSeekSse({}), body: sseEvent("response.output_text.delta", { sequence_number: 1, delta: "{}" }) };
    expect(extractDeepSeekPayload(DEEPSEEK_V4_PRO_PROFILE, missing))
      .toMatchObject({ ok: false, error: { kind: "malformed-syntax" } });
    const malformed = { ...deepSeekSse({}), body: "event: response.completed\ndata: {!}\n\n" };
    expect(extractDeepSeekPayload(DEEPSEEK_V4_PRO_PROFILE, malformed))
      .toMatchObject({ ok: false, error: { kind: "malformed-syntax" } });
  });

  it("rejects the Chat-Completions [DONE] sentinel in a Responses API stream", () => {
    const source = deepSeekSse({ value: true });
    const withDone = { ...source, body: `data: [DONE]\n\n${source.body}` };
    expect(extractDeepSeekPayload(DEEPSEEK_V4_PRO_PROFILE, withDone))
      .toMatchObject({ ok: false, error: { kind: "malformed-syntax" } });
  });

  it("rejects event/data disagreement, terminal event/status disagreement, and multiple terminal events", () => {
    const source = deepSeekSse({ value: true });
    const typeDisagreement = { ...source, body: source.body.replace("event: response.completed", "event: response.failed") };
    expect(extractDeepSeekPayload(DEEPSEEK_V4_PRO_PROFILE, typeDisagreement))
      .toMatchObject({ ok: false, error: { kind: "malformed-syntax" } });
    const disagreement = { ...source, body: source.body.replace('"status":"completed"', '"status":"failed"') };
    expect(extractDeepSeekPayload(DEEPSEEK_V4_PRO_PROFILE, disagreement))
      .toMatchObject({ ok: false, error: { kind: "malformed-syntax" } });
    const duplicate = { ...source, body: `${source.body}${source.body.slice(source.body.lastIndexOf("event: response.completed"))}` };
    expect(extractDeepSeekPayload(DEEPSEEK_V4_PRO_PROFILE, duplicate))
      .toMatchObject({ ok: false, error: { kind: "malformed-syntax" } });
  });

  it("rejects invalid final JSON and ambiguous visible outputs without repair", () => {
    expect(extractDeepSeekPayload(DEEPSEEK_V4_PRO_PROFILE, deepSeekSse({}, { outputTexts: ["not-json"] })))
      .toMatchObject({ ok: false, error: { kind: "malformed-syntax" } });
    expect(extractDeepSeekPayload(DEEPSEEK_V4_PRO_PROFILE, deepSeekSse({}, { outputTexts: ["{}", "{}"] })))
      .toMatchObject({ ok: false, error: { kind: "provider-error" } });
    expect(extractDeepSeekPayload(DEEPSEEK_V4_PRO_PROFILE, deepSeekSse({}, { outputTexts: [] })))
      .toMatchObject({ ok: false, error: { kind: "provider-error" } });

    const withToolOutput = deepSeekSse({ value: true });
    const unexpected = {
      ...withToolOutput,
      body: withToolOutput.body.replace(
        '"output":[',
        '"output":[{"type":"function_call","name":"unexpected","arguments":"{}"},',
      ),
    };
    expect(extractDeepSeekPayload(DEEPSEEK_V4_PRO_PROFILE, unexpected))
      .toMatchObject({ ok: false, error: { kind: "provider-error" } });
  });

  it("requires exact observed model identity", () => {
    expect(extractDeepSeekPayload(DEEPSEEK_V4_PRO_PROFILE, deepSeekSse({ ok: true }))).toMatchObject({ ok: true });
    expect(extractDeepSeekPayload(DEEPSEEK_V4_PRO_PROFILE, deepSeekSse({ ok: true }, { model: "deepseek-v4-flash" })))
      .toMatchObject({ ok: false, error: { kind: "provider-error", transportRetryable: false } });
    expect(extractDeepSeekPayload(
      DEEPSEEK_V4_FLASH_PROFILE,
      deepSeekSse({ ok: true }, { model: "deepseek-v4-flash" }),
    )).toMatchObject({ ok: true });
    for (const model of ["DeepSeek-V4-Flash-0731", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"]) {
      expect(extractDeepSeekPayload(DEEPSEEK_V4_FLASH_PROFILE, deepSeekSse({ ok: true }, { model })))
        .toMatchObject({ ok: false, error: { kind: "provider-error", transportRetryable: false } });
    }
  });

  it("maps usage truthfully and distinguishes absent from unsupported metrics", () => {
    const usage = usageFromDeepSeek({
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
    }, true);
    expect(usage).toEqual({
      inputTokens: { measured: true, value: 0 },
      cachedInputTokens: { measured: true, value: 0 },
      cacheWriteTokens: { measured: false, reason: "unsupported-by-provider" },
      outputTokens: { measured: true, value: 0 },
      reasoningTokens: { measured: true, value: 0 },
      providerRequests: { measured: true, value: 1 },
      costUsd: { measured: false, reason: "unsupported-by-provider" },
    });
    const missing = usageFromDeepSeek({ input_tokens: 2, output_tokens: 1 }, true);
    expect(missing.cachedInputTokens).toEqual({ measured: false, reason: "not-reported-in-this-response" });
    expect(missing.reasoningTokens).toEqual({ measured: false, reason: "not-reported-in-this-response" });
  });
});
