import { describe, expect, it, vi } from "vitest";
import {
  DEEPSEEK_RESPONSES_ENDPOINT,
  DeepSeekAdapter,
  FetchDeepSeekTransport,
  deepSeekRequestBody,
  type DeepSeekTransport,
  type DeepSeekTransportInput,
} from "../../../src/vnext/providers/deepseek/adapter.js";
import {
  DEEPSEEK_V4_FLASH_PROFILE,
  DEEPSEEK_V4_PRO_PROFILE,
} from "../../../src/vnext/providers/deepseek/profiles.js";
import type { SemanticRequest } from "../../../src/vnext/providers/contract.js";
import { deepSeekSse, sseEvent } from "./deepseek-helpers.js";

const SENTINEL = "DEEPSEEK_SENTINEL_DO_NOT_LEAK_94af0123456789";

function request(overrides: Partial<SemanticRequest> = {}): SemanticRequest {
  return {
    slice: "opaque-label",
    instructions: "INSTRUCTIONS-BYTES",
    input: "INPUT-BYTES",
    schema: { type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "string" } } },
    schemaName: "opaque_schema",
    limits: { maxOutputTokens: 100, deadlineMs: 5_000 },
    reasoning: { mode: "off" },
    signal: new AbortController().signal,
    ...overrides,
  };
}

const credential = { id: "deepseek:test", secret: SENTINEL, attributes: {} };
const credentialAuth = { kind: "credential" as const, credential };

function byteChunks(text: string, widths: readonly number[]): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const chunks: Uint8Array[] = [];
  for (let offset = 0, index = 0; offset < bytes.length; index += 1) {
    const end = Math.min(bytes.length, offset + widths[index % widths.length]!);
    chunks.push(bytes.slice(offset, end));
    offset = end;
  }
  return chunks;
}

function streamingResponse(chunks: readonly Uint8Array[]): Response {
  return new Response(new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(chunk));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("DeepSeek adapter", () => {
  it("constructs one native Responses API request without Anthropic or tool fields", async () => {
    const calls: DeepSeekTransportInput[] = [];
    const adapter = new DeepSeekAdapter({
      async send(input) {
        calls.push(input);
        return deepSeekSse({ value: "ok" });
      },
    });
    const value = request();
    const outcome = await adapter.request(DEEPSEEK_V4_PRO_PROFILE, credentialAuth, value);
    expect(outcome).toMatchObject({ ok: true, value: { payload: { value: "ok" } } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      endpoint: DEEPSEEK_RESPONSES_ENDPOINT,
      headers: {
        authorization: `Bearer ${SENTINEL}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
    });
    const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(body).toEqual({
      model: "deepseek-v4-pro",
      instructions: value.instructions,
      input: value.input,
      max_output_tokens: 100,
      stream: true,
      text: { format: { type: "json_schema", name: value.schemaName, schema: value.schema } },
      reasoning: { effort: "none" },
    });
    expect(calls[0]!.body).not.toContain(SENTINEL);
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(calls[0]!.headers).not.toHaveProperty("x-api-key");
    expect(calls[0]!.headers).not.toHaveProperty("anthropic-version");
  });

  it("reuses the direct adapter and propagates the exact Flash model identity", async () => {
    const calls: DeepSeekTransportInput[] = [];
    const adapter = new DeepSeekAdapter({
      async send(input) {
        calls.push(input);
        return deepSeekSse({ value: "flash" }, { model: "deepseek-v4-flash" });
      },
    });
    const outcome = await adapter.request(DEEPSEEK_V4_FLASH_PROFILE, credentialAuth, request());
    expect(outcome).toMatchObject({ ok: true, value: { payload: { value: "flash" } } });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ model: "deepseek-v4-flash" });
    expect(calls[0]).toMatchObject({ endpoint: DEEPSEEK_RESPONSES_ENDPOINT });
  });

  it("maps only declared generic reasoning efforts and refuses unknown values before transport", async () => {
    expect(deepSeekRequestBody(DEEPSEEK_V4_PRO_PROFILE, request({ reasoning: { mode: "off" } })))
      .toMatchObject({ reasoning: { effort: "none" } });
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      expect(deepSeekRequestBody(DEEPSEEK_V4_PRO_PROFILE, request({ reasoning: { mode: "on", effort } })))
        .toMatchObject({ reasoning: { effort } });
    }
    const send = vi.fn();
    const adapter = new DeepSeekAdapter({ send } as DeepSeekTransport);
    await expect(adapter.request(DEEPSEEK_V4_PRO_PROFILE, credentialAuth, request({ reasoning: { mode: "on", effort: "minimal" } })))
      .resolves.toMatchObject({ ok: false, error: { kind: "unsupported-capability" } });
    await expect(adapter.request(DEEPSEEK_V4_PRO_PROFILE, credentialAuth, request({ limits: { maxOutputTokens: 384_001, deadlineMs: 1_000 } })))
      .resolves.toMatchObject({ ok: false, error: { kind: "unsupported-capability" } });
    expect(send).not.toHaveBeenCalled();
  });

  it("owns exactly one request and does not retry malformed output", async () => {
    let calls = 0;
    const adapter = new DeepSeekAdapter({
      async send() {
        calls += 1;
        return { ...deepSeekSse({}), body: "event: response.completed\ndata: {!}\n\n" };
      },
    });
    expect(await adapter.request(DEEPSEEK_V4_PRO_PROFILE, credentialAuth, request()))
      .toMatchObject({ ok: false, error: { kind: "malformed-syntax" } });
    expect(calls).toBe(1);
  });

  it.each([
    [400, "provider-error", false],
    [401, "auth", false],
    [402, "provider-error", false],
    [403, "auth", false],
    [404, "provider-error", false],
    [422, "provider-error", false],
    [429, "rate-limit", true],
    [500, "transport", true],
    [503, "transport", true],
    [599, "transport", true],
  ] as const)("normalizes HTTP %i safely", async (status, kind, transportRetryable) => {
    const adapter = new DeepSeekAdapter({
      async send() {
        return { ...deepSeekSse({}), status, body: JSON.stringify({ error: { message: SENTINEL } }) };
      },
    });
    const outcome = await adapter.request(DEEPSEEK_V4_PRO_PROFILE, credentialAuth, request());
    expect(outcome).toMatchObject({
      ok: false,
      error: {
        kind,
        transportRetryable,
        usage: { providerRequests: { measured: true, value: 1 } },
      },
    });
    expect(JSON.stringify(outcome)).not.toContain(SENTINEL);
  });

  it("distinguishes caller cancellation, local timeout, and network failure without leaking causes", async () => {
    let calls = 0;
    const blocking: DeepSeekTransport = {
      send(input) {
        calls += 1;
        return new Promise((_, reject) => input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true }));
      },
    };
    const adapter = new DeepSeekAdapter(blocking);
    const controller = new AbortController();
    const cancelled = adapter.request(DEEPSEEK_V4_PRO_PROFILE, credentialAuth, request({ signal: controller.signal }));
    controller.abort(new Error(SENTINEL));
    expect(await cancelled).toMatchObject({ ok: false, error: { kind: "cancelled", transportRetryable: false } });
    expect(calls).toBe(1);

    calls = 0;
    expect(await adapter.request(DEEPSEEK_V4_PRO_PROFILE, credentialAuth, request({ limits: { maxOutputTokens: 100, deadlineMs: 5 } })))
      .toMatchObject({ ok: false, error: { kind: "timeout", transportRetryable: true } });
    expect(calls).toBe(1);

    const network = new DeepSeekAdapter({ async send() { throw new Error(SENTINEL); } });
    const failed = await network.request(DEEPSEEK_V4_PRO_PROFILE, credentialAuth, request());
    expect(failed).toMatchObject({ ok: false, error: { kind: "transport", transportRetryable: true } });
    expect(JSON.stringify(failed)).not.toContain(SENTINEL);
  });

  it("accounts for a pre-transport abort as zero provider requests", async () => {
    const controller = new AbortController();
    controller.abort();
    const send = vi.fn();
    const outcome = await new DeepSeekAdapter({ send } as DeepSeekTransport)
      .request(DEEPSEEK_V4_PRO_PROFILE, credentialAuth, request({ signal: controller.signal }));
    expect(outcome).toMatchObject({
      ok: false,
      error: { kind: "cancelled", usage: { providerRequests: { measured: true, value: 0 } } },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("measures first visible output, not reasoning, in the fetch transport", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      sseEvent("response.reasoning_text.delta", { sequence_number: 1, delta: "private" }),
      sseEvent("response.output_text.delta", { sequence_number: 2, delta: "{" }),
      sseEvent("response.completed", { sequence_number: 3, response: { id: "r", status: "completed" } }),
    ];
    const response = (values: readonly string[]) => new Response(new ReadableStream({
      start(controller) {
        values.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream", authorization: SENTINEL } });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response(chunks))
      .mockResolvedValueOnce(response([
        sseEvent("response.reasoning_text.delta", { sequence_number: 1, delta: "private" }),
        sseEvent("response.failed", { sequence_number: 2, response: { id: "r", status: "failed" } }),
      ])));
    const transport = new FetchDeepSeekTransport();
    const raw = await transport.send({
      endpoint: DEEPSEEK_RESPONSES_ENDPOINT,
      headers: { authorization: `Bearer ${SENTINEL}` },
      body: "{}",
      signal: new AbortController().signal,
    });
    expect(raw.firstOutputMs).toEqual(expect.any(Number));
    expect(raw.headers).toEqual({ "content-type": "text/event-stream" });
    expect(JSON.stringify(raw)).not.toContain(SENTINEL);
    const reasoningOnly = await transport.send({
      endpoint: DEEPSEEK_RESPONSES_ENDPOINT,
      headers: { authorization: `Bearer ${SENTINEL}` },
      body: "{}",
      signal: new AbortController().signal,
    });
    expect(reasoningOnly.firstOutputMs).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it.each([
    ["one byte at a time", [1]],
    ["alternating two/three-byte chunks", [2, 3]],
  ] as const)("preserves split events, delimiters, and UTF-8 with %s", async (_label, widths) => {
    const source = deepSeekSse({ text: "ação 漢字 🚀" }, { includeReasoning: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamingResponse(byteChunks(source.body, widths))));
    const raw = await new FetchDeepSeekTransport().send({
      endpoint: DEEPSEEK_RESPONSES_ENDPOINT,
      headers: { authorization: `Bearer ${SENTINEL}` },
      body: "{}",
      signal: new AbortController().signal,
    });
    expect(raw.body).toBe(source.body);
    expect(raw.firstOutputMs).toEqual(expect.any(Number));
    expect(new DeepSeekAdapter().replay(DEEPSEEK_V4_PRO_PROFILE, request(), raw))
      .toMatchObject({ ok: true, value: { payload: { text: "ação 漢字 🚀" } } });
    vi.unstubAllGlobals();
  });
});
