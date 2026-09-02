import { describe, expect, it } from "vitest";
import { OpenAiAdapter } from "../../../src/vnext/providers/openai/adapter.js";
import { OPENAI_GPT_5_6_SOL_PROFILE } from "../../../src/vnext/providers/openai/profiles.js";
import type { SemanticRequest } from "../../../src/vnext/providers/contract.js";
import { openAiSse, openAiSseEvent } from "./openai-helpers.js";

const request: SemanticRequest = {
  slice: "normalize",
  instructions: "",
  input: "",
  schema: { type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "string" } } },
  schemaName: "normalize",
  limits: { maxOutputTokens: 100, deadlineMs: 1_000 },
  reasoning: { mode: "off" },
  signal: new AbortController().signal,
};

const replay = (raw: unknown) => new OpenAiAdapter().replay(OPENAI_GPT_5_6_SOL_PROFILE, request, raw);

describe("OpenAI Responses normalizer", () => {
  it("accepts one completed output, ignores reasoning, and keeps conservative usage", () => {
    expect(replay(openAiSse({ value: "ok" }, { includeReasoning: true }))).toMatchObject({
      ok: true,
      value: {
        payload: { value: "ok" },
        usage: {
          inputTokens: { measured: true, value: 11 },
          outputTokens: { measured: true, value: 7 },
          cachedInputTokens: { measured: false, reason: "unsupported-by-provider" },
          reasoningTokens: { measured: false, reason: "unsupported-by-provider" },
          providerRequests: { measured: true, value: 1 },
        },
      },
    });
  });

  it("requires exact observed model identity", () => {
    expect(replay(openAiSse({}, { model: null }))).toMatchObject({ ok: false, error: { kind: "provider-error" } });
    expect(replay(openAiSse({}, { model: "gpt-5.6-terra" }))).toMatchObject({ ok: false, error: { kind: "provider-error" } });
  });

  it("fails closed on multiple texts, unexpected tools, refusal, and malformed JSON", () => {
    expect(replay(openAiSse({}, { outputTexts: ["{}", "{}"] }))).toMatchObject({ ok: false, error: { kind: "provider-error" } });
    expect(replay(openAiSse({}, { output: [{ type: "function_call", name: "forbidden" }] }))).toMatchObject({ ok: false, error: { kind: "provider-error" } });
    expect(replay(openAiSse({}, { output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "no" }] }] }))).toMatchObject({ ok: false, error: { kind: "provider-error" } });
    expect(replay(openAiSse({}, { outputTexts: ["not json"] }))).toMatchObject({ ok: false, error: { kind: "malformed-syntax" } });
  });

  it("classifies incomplete, failed, truncated, missing, and conflicting terminal outcomes", () => {
    expect(replay(openAiSse({}, { status: "incomplete", incompleteReason: "max_output_tokens" }))).toMatchObject({ ok: false, error: { kind: "output-truncated" } });
    expect(replay(openAiSse({}, { status: "incomplete", incompleteReason: "content_filter" }))).toMatchObject({ ok: false, error: { kind: "provider-error" } });
    expect(replay(openAiSse({}, { status: "failed", error: { type: "server_error", message: "unsafe" } }))).toMatchObject({ ok: false, error: { kind: "provider-error" } });
    expect(replay({ ...openAiSse({}), streamComplete: false })).toMatchObject({ ok: false, error: { kind: "output-truncated" } });
    expect(replay({ ...openAiSse({}), body: openAiSseEvent("response.created", { response: { id: "r", status: "in_progress" } }) })).toMatchObject({ ok: false, error: { kind: "malformed-syntax" } });
    const first = openAiSse({});
    const terminal = openAiSseEvent("response.completed", { response: { id: "r2", status: "completed", model: "gpt-5.6-sol", output: [], usage: {} } });
    expect(replay({ ...first, body: `${first.body}${terminal}` })).toMatchObject({ ok: false, error: { kind: "malformed-syntax" } });
  });

  it("supports CRLF, multiline data, comments, id/retry, and unknown fields", () => {
    const terminal = {
      type: "response.completed",
      response: {
        id: "resp_multiline", status: "completed", model: "gpt-5.6-sol",
        output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "{\"value\":\"ok\"}" }] }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    };
    const serialized = JSON.stringify(terminal);
    const split = serialized.indexOf("\"response\"");
    const body = `: comment\r\nid: 7\r\nretry: 10\r\nunknown: ignored\r\nevent: response.completed\r\ndata: ${serialized.slice(0, split)}\r\ndata: ${serialized.slice(split)}\r\n\r\n`;
    expect(replay({ ...openAiSse({}), body })).toMatchObject({ ok: true, value: { payload: { value: "ok" } } });
  });
});
