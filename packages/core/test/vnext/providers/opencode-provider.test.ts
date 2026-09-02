import { describe, expect, it, vi } from "vitest";
import { access } from "node:fs/promises";
import type { SemanticRequest } from "../../../src/vnext/providers/contract.js";
import { FetchOpenCodeApiTransport, OpenCodeApiAdapter, openCodeApiHeaders, openCodeApiRequestBody, type OpenCodeApiTransportInput } from "../../../src/vnext/providers/opencode/api-adapter.js";
import { safeOpenCodeHttpErrorDetails } from "../../../src/vnext/providers/opencode/api-normalize.js";
import { decodeOpenCodeSessionExport, extractOpenCodeCliSessionId, OpenCodeCliAdapter, openCodeChildEnvironment, openCodeCliArgs, type OpenCodeCommandInput, type OpenCodeProcess } from "../../../src/vnext/providers/opencode/cli-adapter.js";
import { decodeOpenCodeCliJsonl } from "../../../src/vnext/providers/opencode/cli-normalize.js";
import { OPEN_CODE_COMPATIBILITY, normalizeOpenCodeDiscovery, openCodeApiEndpoint, resolveOpenCodeCompatibility, type OpenCodeProtocol, type OpenCodeService } from "../../../src/vnext/providers/opencode/catalog.js";
import { OPENCODE_API_PROFILES, OPENCODE_PROFILES, createOpenCodeCliProfile } from "../../../src/vnext/providers/opencode/profiles.js";
import { resolveProviderAdapter, resolveProviderAuth, resolveProviderProfile } from "../../../src/vnext/providers/registry.js";
import { assertOpenCodeRecordSanitized, sanitizeOpenCodeApiRawForRecord } from "../../../src/vnext/providers/opencode/api-record.js";
import { discoverOpenCodeApiModels, discoverOpenCodeCliModels } from "../../../src/vnext/providers/opencode/discovery.js";

const SENTINEL = "OPENCODE_SENTINEL_DO_NOT_LEAK_94af0123456789";
const credential = { kind: "credential" as const, credential: { id: "fixture", secret: SENTINEL, attributes: {} } };

type MatrixFixture = readonly [OpenCodeService, string, OpenCodeProtocol | "google", boolean];
function matrixGroup(service: OpenCodeService, protocol: OpenCodeProtocol | "google", supported: boolean, models: string): readonly MatrixFixture[] {
  return models.trim().split(/\s+/).map((model) => [service, model, protocol, supported] as const);
}

/** Maintained regression fixture reconstructed from Ralph's 86-entry working matrix. */
const PROVEN_RALPH_MATRIX: readonly MatrixFixture[] = [
  ...matrixGroup("go", "openai-responses", true, `
    grok-4.6 gpt-5.6-luna muse-spark-1.2-contributor
  `),
  ...matrixGroup("go", "openai-chat", true, `
    glm-5.3-flash glm-5.3 glm-5.2 glm-5.1 kimi-k3 kimi-k2.7-code kimi-k2.6 longcat-2.0
    deepseek-v4-pro deepseek-v4-flash deepseek-v4-flash-vision-exp mimo-v2.5 mimo-v2.5-pro hy3
  `),
  ...matrixGroup("go", "anthropic-messages", true, `
    minimax-m3 minimax-m2.7 minimax-m2.5 qwen3.8-max qwen3.7-max qwen3.7-plus qwen3.6-plus
  `),
  ...matrixGroup("zen", "openai-responses", true, `
    gpt-5.6-sol gpt-5.6-terra gpt-5.6-luna gpt-5.5 gpt-5.5-pro gpt-5.4 gpt-5.4-pro gpt-5.4-mini
    gpt-5.4-nano gpt-5.3-codex gpt-5.3-codex-spark gpt-5.2 gpt-5.2-codex gpt-5.1 gpt-5.1-codex
    gpt-5.1-codex-max gpt-5.1-codex-mini gpt-5 gpt-5-codex gpt-5-nano grok-4.6 grok-4.5 grok-build-0.1
    muse-spark-1.2 muse-spark-1.2-contributor-free
  `),
  ...matrixGroup("zen", "anthropic-messages", true, `
    claude-fable-5 claude-opus-5 claude-opus-4-8 claude-opus-4-7 claude-opus-4-6 claude-opus-4-5
    claude-sonnet-5 claude-sonnet-4-6 claude-sonnet-4-5 claude-haiku-4-5 qwen3.7-max qwen3.7-plus
    qwen3.6-plus qwen3.5-plus
  `),
  ...matrixGroup("zen", "openai-chat", true, `
    deepseek-v4-pro deepseek-v4-flash minimax-m3 minimax-m2.7 minimax-m2.5 glm-5.2 glm-5.1 glm-5
    kimi-k2.5 kimi-k2.6 kimi-k2.7-code kimi-k3 big-pickle mimo-v2.5-free hy3-free
    nemotron-3-ultra-free nemotron-3.5-lightning-free
  `),
  ...matrixGroup("zen", "google", false, `
    gemini-3.7-flash gemini-3.6-flash gemini-3.5-flash gemini-3.5-flash-lite gemini-3.1-pro gemini-3-flash
  `),
];

function request(overrides: Partial<SemanticRequest> = {}): SemanticRequest {
  return {
    slice: "fixture", instructions: "INSTRUCTIONS", input: "INPUT",
    schema: { type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "string" } } },
    schemaName: "semantic_candidate", limits: { maxOutputTokens: 100, deadlineMs: 5_000 },
    reasoning: { mode: "on", effort: "low" }, signal: new AbortController().signal, ...overrides,
  };
}

function profile(id: string) {
  return OPENCODE_API_PROFILES.find((item) => item.id === id)!;
}

function raw(body: string, status = 200) {
  return { status, headers: {}, body, startedAt: "2026-09-01T00:00:00.000Z", completedAt: "2026-09-01T00:00:01.000Z", firstOutputMs: 12, streamComplete: true } as const;
}

function responseSse(model: string, value = "ok"): string {
  return [
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: JSON.stringify({ value }) })}`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", model, status: "completed", usage: { input_tokens: 11, input_tokens_details: { cached_tokens: 2 }, output_tokens: 7, output_tokens_details: { reasoning_tokens: 3 } } } })}`,
    "",
  ].join("\n\n");
}

describe("OpenCode API family", () => {
  it("matches the proven Ralph matrix exactly without additions or respellings", () => {
    const actual = OPEN_CODE_COMPATIBILITY.map((entry) => [entry.service, entry.modelId, entry.protocol, entry.supported] as const)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const expected = [...PROVEN_RALPH_MATRIX].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    expect(PROVEN_RALPH_MATRIX).toHaveLength(86);
    expect(OPEN_CODE_COMPATIBILITY).toHaveLength(86);
    expect(actual).toEqual(expected);
  });
  it("keeps every source profile unpromoted until exact packaged evidence exists", () => {
    expect(OPENCODE_PROFILES.length).toBeGreaterThan(0);
    expect(OPENCODE_PROFILES.every((item) => item.conformance.tier === "UNSUPPORTED"
      && item.conformance.verifiedRecord === false && item.conformance.runId === null && item.conformance.recordedAt === null)).toBe(true);
  });
  it("uses one shared adapter with exact service/profile/protocol identities", () => {
    const goChat = profile("opencode:go:deepseek-v4-pro");
    const zenMessages = profile("opencode:zen:claude-opus-5");
    const zenResponses = profile("opencode:zen:gpt-5.6-luna");
    expect([goChat, zenMessages, zenResponses].map((item) => resolveProviderAdapter(item.id))).toEqual([
      resolveProviderAdapter(goChat.id), resolveProviderAdapter(goChat.id), resolveProviderAdapter(goChat.id),
    ]);
    expect(openCodeApiEndpoint("go", goChat.modelId)).toBe("https://opencode.ai/zen/go/v1/chat/completions");
    expect(openCodeApiEndpoint("zen", zenMessages.modelId)).toBe("https://opencode.ai/zen/v1/messages");
    expect(openCodeApiEndpoint("zen", zenResponses.modelId)).toBe("https://opencode.ai/zen/v1/responses");
  });

  it("refuses unknown or protocol-skewed API profiles before credential or network", async () => {
    const send = vi.fn();
    const known = profile("opencode:zen:gpt-5.6-luna");
    const unknown = { ...known, id: "opencode:zen:future-model", modelId: "future-model" };
    await expect(new OpenCodeApiAdapter({ send }).request(unknown, credential, request()))
      .resolves.toMatchObject({ ok: false, error: { kind: "unsupported-capability" } });
    await expect(new OpenCodeApiAdapter({ send }).request({ ...known, structuredOutput: "json-mode" }, credential, request()))
      .resolves.toMatchObject({ ok: false, error: { kind: "unsupported-capability" } });
    expect(send).not.toHaveBeenCalled();
  });

  it("builds protocol-specific structured requests and authentication", () => {
    const chat = openCodeApiRequestBody(profile("opencode:go:deepseek-v4-pro"), request());
    const messages = openCodeApiRequestBody(profile("opencode:zen:claude-opus-5"), request());
    const responses = openCodeApiRequestBody(profile("opencode:zen:gpt-5.6-luna"), request());
    expect(chat).toMatchObject({ model: "deepseek-v4-pro", stream: true, response_format: { type: "json_object" }, reasoning_effort: "low" });
    expect(messages).toMatchObject({ model: "claude-opus-5", stream: true, tool_choice: { type: "tool", name: "semantic_candidate" } });
    expect(responses).toMatchObject({ model: "gpt-5.6-luna", stream: true, text: { format: { type: "json_schema", name: "semantic_candidate" } } });
    expect(openCodeApiHeaders("anthropic-messages", SENTINEL)).toMatchObject({ "x-api-key": SENTINEL, "anthropic-version": "2023-06-01" });
    expect(openCodeApiHeaders("anthropic-messages", SENTINEL)).not.toHaveProperty("authorization");
    expect(openCodeApiHeaders("openai-chat", SENTINEL)).toMatchObject({ authorization: `Bearer ${SENTINEL}` });
    expect(JSON.stringify([chat, messages, responses])).not.toContain(SENTINEL);
  });

  it("issues exactly one HTTP request and normalizes Responses usage/model", async () => {
    const calls: OpenCodeApiTransportInput[] = [];
    const selected = profile("opencode:zen:gpt-5.6-luna");
    const adapter = new OpenCodeApiAdapter({ async send(input) { calls.push(input); return raw(responseSse(selected.modelId)); } });
    const outcome = await adapter.request(selected, credential, request());
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ endpoint: "https://opencode.ai/zen/v1/responses", protocol: "openai-responses" });
    expect(outcome).toMatchObject({ ok: true, value: { payload: { value: "ok" }, usage: {
      inputTokens: { measured: true, value: 11 }, cachedInputTokens: { measured: false, reason: "unsupported-by-provider" },
      cacheWriteTokens: { measured: false, reason: "unsupported-by-provider" }, outputTokens: { measured: true, value: 7 },
      reasoningTokens: { measured: false, reason: "unsupported-by-provider" }, providerRequests: { measured: true, value: 1 }, costUsd: { measured: false, reason: "unsupported-by-provider" },
    } } });
  });

  it("declares only guaranteed usage metrics for every OpenCode dialect and CLI", () => {
    for (const selected of OPENCODE_PROFILES) {
      expect(selected.usageReporting).toEqual({
        inputTokens: true, cachedInputTokens: false, cacheWriteTokens: false,
        outputTokens: true, reasoningTokens: false, costUsd: false,
      });
      expect(selected.reasoning.supported).toBe(true);
      if (selected.reasoning.supported) expect(selected.reasoning.reportsReasoningTokens).toBe(false);
    }
  });

  it("normalizes Chat and Messages only through their declared dialect", () => {
    const chatProfile = profile("opencode:go:deepseek-v4-pro");
    const chat = [
      `data: ${JSON.stringify({ id: "chat_1", model: chatProfile.modelId, choices: [{ delta: { content: '{"value":"chat"}' }, finish_reason: "stop" }] })}`,
      `data: ${JSON.stringify({ model: chatProfile.modelId, choices: [], usage: { prompt_tokens: 8, prompt_tokens_details: { cached_tokens: 1 }, completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 2 } } })}`,
      "data: [DONE]", "",
    ].join("\n\n");
    expect(new OpenCodeApiAdapter().replay(chatProfile, request(), raw(chat))).toMatchObject({ ok: true, value: { payload: { value: "chat" } } });
    const messagesProfile = profile("opencode:zen:claude-opus-5");
    const events = [
      { type: "message_start", message: { id: "msg_1", model: messagesProfile.modelId, usage: { input_tokens: 5, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "semantic_candidate" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"value":"messages"}' } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ];
    const stream = `${events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
    expect(new OpenCodeApiAdapter().replay(messagesProfile, request(), raw(stream))).toMatchObject({ ok: true, value: { payload: { value: "messages" } } });
  });

  it("fails closed on unknown catalog models and rejects identity/error cases safely", async () => {
    expect(resolveOpenCodeCompatibility("zen", "unknown-new-model")).toMatchObject({ supported: false, protocol: "unknown" });
    const catalog = normalizeOpenCodeDiscovery("zen", { data: [{ id: "unknown-new-model", authorization: SENTINEL }, { id: "gpt-5.6-luna" }] });
    expect(catalog[0]).toMatchObject({ available: true, supported: false });
    expect(JSON.stringify(catalog)).not.toContain(SENTINEL);
    const selected = profile("opencode:zen:gpt-5.6-luna");
    expect(new OpenCodeApiAdapter().replay(selected, request(), raw(responseSse("wrong-model")))).toMatchObject({ ok: false, error: { kind: "provider-error", transportRetryable: false } });
    const transport = vi.fn(async () => raw(SENTINEL, 401));
    const outcome = await new OpenCodeApiAdapter({ send: transport }).request(selected, credential, request());
    expect(outcome).toMatchObject({ ok: false, error: { kind: "auth", message: "OpenCode API request failed with HTTP 401" } });
    expect(JSON.stringify(outcome)).not.toContain(SENTINEL);
  });

  it.each([
    [400, "provider-error", false], [401, "auth", false], [402, "provider-error", false], [403, "provider-error", false], [404, "provider-error", false],
    [422, "provider-error", false], [429, "rate-limit", true], [500, "transport", true], [503, "transport", true],
  ] as const)("maps HTTP %s without exposing raw provider bodies", async (status, kind, retryable) => {
    const selected = profile("opencode:zen:gpt-5.6-luna");
    const outcome = await new OpenCodeApiAdapter({ async send() { return raw(`provider error ${SENTINEL}`, status); } }).request(selected, credential, request());
    expect(outcome).toMatchObject({ ok: false, error: { kind, transportRetryable: retryable, usage: { providerRequests: { measured: true, value: 1 } } } });
    expect(JSON.stringify(outcome)).not.toContain(SENTINEL);
  });

  it("extracts only allowlisted HTTP type/code/param and never provider messages", async () => {
    const unsafe = `unsafe ${SENTINEL}`;
    const body = JSON.stringify({ error: {
      type: "invalid_request_error", code: "unsupported.parameter", param: "text.format[0]",
      message: unsafe, credential: SENTINEL,
    } });
    expect(safeOpenCodeHttpErrorDetails(body)).toBe(" (type=invalid_request_error; code=unsupported.parameter; param=text.format[0])");
    expect(safeOpenCodeHttpErrorDetails(JSON.stringify({ error: {
      type: `INVALID ${SENTINEL}`, code: `bad/${SENTINEL}`, param: `bad value ${SENTINEL}`, message: unsafe,
    } }))).toBe("");
    const selected = profile("opencode:go:gpt-5.6-luna");
    const outcome = await new OpenCodeApiAdapter({ async send() { return raw(body, 400); } }).request(selected, credential, request());
    expect(outcome).toMatchObject({ ok: false, error: {
      message: "OpenCode API request failed with HTTP 400 (type=invalid_request_error; code=unsupported.parameter; param=text.format[0])",
    } });
    expect(JSON.stringify(outcome)).not.toContain(unsafe);
    expect(JSON.stringify(outcome)).not.toContain(SENTINEL);
  });

  it("reports a bounded safe census for unexpected Messages blocks without content", () => {
    const selected = profile("opencode:go:minimax-m2.5");
    const events = [
      { type: "message_start", message: { id: "msg_1", model: selected.modelId, usage: { input_tokens: 5 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: SENTINEL } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "image", source: SENTINEL } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "image", source: SENTINEL } },
      { type: "content_block_stop", index: 2 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ];
    const body = `${events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
    const outcome = new OpenCodeApiAdapter().replay(selected, request(), raw(body));
    expect(outcome).toMatchObject({ ok: false, error: { message: "OpenCode Messages returned unexpected blocks (image:2,text:1)" } });
    expect(JSON.stringify(outcome)).not.toContain(SENTINEL);
  });

  it("classifies timeout, caller cancellation, and network failure without internal retries", async () => {
    const selected = profile("opencode:zen:gpt-5.6-luna");
    let calls = 0;
    const timeout = new OpenCodeApiAdapter({ send: (input) => new Promise((_, reject) => {
      calls += 1;
      input.signal.addEventListener("abort", () => reject(new Error(SENTINEL)), { once: true });
    }) });
    await expect(timeout.request(selected, credential, request({ limits: { maxOutputTokens: 10, deadlineMs: 1 } })))
      .resolves.toMatchObject({ ok: false, error: { kind: "timeout", transportRetryable: true, usage: { providerRequests: { measured: true, value: 1 } } } });
    expect(calls).toBe(1);
    const controller = new AbortController();
    controller.abort();
    const send = vi.fn();
    await expect(new OpenCodeApiAdapter({ send }).request(selected, credential, request({ signal: controller.signal })))
      .resolves.toMatchObject({ ok: false, error: { kind: "cancelled", transportRetryable: false, usage: { providerRequests: { measured: true, value: 0 } } } });
    expect(send).not.toHaveBeenCalled();
    await expect(new OpenCodeApiAdapter({ async send() { throw new Error(SENTINEL); } }).request(selected, credential, request()))
      .resolves.toMatchObject({ ok: false, error: { kind: "transport", message: "OpenCode API transport failed" } });
  });

  it("keeps discovery explicit and treats availability as distinct from compatibility", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "gpt-5.6-luna" }, { id: "future-unknown", token: SENTINEL }] }), { status: 200 }));
    const discovered = await discoverOpenCodeApiModels("zen", credential.credential, fetcher as typeof fetch);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(discovered).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: "gpt-5.6-luna", available: true, supported: true, protocol: "openai-responses" }),
      expect.objectContaining({ modelId: "future-unknown", available: true, supported: false, protocol: "unknown" }),
    ]));
    expect(JSON.stringify(discovered)).not.toContain(SENTINEL);
    const discoveryCalls: OpenCodeCommandInput[] = [];
    const processClient: OpenCodeProcess = { async run(input) { discoveryCalls.push(input); return { stdout: "opencode/gpt-5.6-luna\nopencode/future\nnoise line", exitCode: 0,
      startedAt: "s", completedAt: "e", cancelled: false, timedOut: false, outputLimitExceeded: false,
      settlement: { observed: true, quiescent: true, verified: true, containment: { kind: "cgroup2", structural: true, reason: "fixture" }, survivors: [] } }; } };
    await expect(discoverOpenCodeCliModels({ processClient, provider: "opencode" })).resolves.toEqual(["opencode/future", "opencode/gpt-5.6-luna"]);
    expect(discoveryCalls[0]!.args).toEqual(["--pure", "models", "opencode"]);
    expect(discoveryCalls[0]!.cwd).toContain("rb-vnext-opencode-");
    expect(discoveryCalls[0]!.cwd).not.toBe(process.cwd());
    await expect(access(discoveryCalls[0]!.cwd)).rejects.toThrow();
  });

  it("strips reasoning records and enforces exact active-secret absence", () => {
    const candidate = raw([
      `event: response.reasoning_text.delta\ndata: ${JSON.stringify({ type: "response.reasoning_text.delta", delta: SENTINEL })}`,
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: '{"value":"safe"}' })}`,
    ].join("\n\n"));
    const sanitized = sanitizeOpenCodeApiRawForRecord(candidate);
    expect(sanitized.body).not.toContain(SENTINEL);
    expect(sanitized.body).toContain("safe");
    expect(() => assertOpenCodeRecordSanitized({ response: sanitized }, SENTINEL)).not.toThrow();
    expect(() => assertOpenCodeRecordSanitized({ error: SENTINEL }, SENTINEL)).toThrow(/credential material/);
  });

  it("decodes fragmented UTF-8 SSE and starts first-output only at visible protocol output", async () => {
    const streamText = [
      `event: response.reasoning_text.delta\ndata: ${JSON.stringify({ type: "response.reasoning_text.delta", delta: "private" })}`,
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: '{"value":"ação"}' })}`,
      "",
    ].join("\r\n\r\n");
    const bytes = new TextEncoder().encode(streamText);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(new ReadableStream({
      start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); },
    }), { status: 200, headers: { authorization: SENTINEL, "x-request-id": "safe-request" } })) as typeof fetch;
    try {
      const result = await new FetchOpenCodeApiTransport().send({ endpoint: "https://fixture.invalid/responses", headers: {}, body: "{}", signal: new AbortController().signal, protocol: "openai-responses" });
      expect(result.body).toBe(streamText);
      expect(result.body).toContain("ação");
      expect(result.firstOutputMs).toBeTypeOf("number");
      expect(result.headers).toEqual({ "x-request-id": "safe-request" });
      expect(JSON.stringify(result)).not.toContain(SENTINEL);
    } finally { globalThis.fetch = originalFetch; }
  });
});

describe("OpenCode CLI family", () => {
  const cliProfile = createOpenCodeCliProfile("opencode/gpt-5.6-luna");
  const settlement = { observed: true, quiescent: true, verified: true, containment: { kind: "cgroup2" as const, structural: true, reason: "fixture" }, survivors: [] };
  const cliRaw = (events: readonly ({ readonly kind: "step-start"; readonly modelId?: string } | { readonly kind: "text"; readonly id?: string; readonly text: string })[], toolEventsObserved = 0, observedModelIds: readonly string[] = [cliProfile.modelId]) => ({
    events, toolEventsObserved, assistantMessageCount: observedModelIds.length, observedModelIds,
    exitCode: 0, startedAt: "s", completedAt: "e", streamComplete: true, treeQuiescent: true, treeVerified: true,
  });

  it("uses one model-bearing run plus one metadata-only session export", async () => {
    const calls: OpenCodeCommandInput[] = [];
    const rawExportSentinel = "RAW_EXPORT_MUST_NOT_PERSIST";
    const processClient: OpenCodeProcess = { async run(input) {
      calls.push(input);
      const stdout = input.args.includes("export") ? JSON.stringify({
        title: rawExportSentinel,
        messages: [{ info: { role: "assistant", providerID: "opencode", modelID: "gpt-5.6-luna", path: "/private/path" },
          parts: [{ type: "reasoning", text: SENTINEL }, { type: "tool", input: rawExportSentinel }] }],
      }) : [
        JSON.stringify({ type: "step_start", sessionID: "ses_fixture", part: { type: "step-start", sessionID: "ses_fixture", messageID: "m1" } }),
        JSON.stringify({ type: "reasoning", part: { type: "reasoning", text: SENTINEL } }),
        JSON.stringify({ type: "text", sessionID: "ses_fixture", part: { type: "text", id: "t1", text: '{"value":"cli"}', path: "/private/path" } }),
        JSON.stringify({ type: "step_finish", sessionID: "ses_fixture", part: { type: "step-finish", reason: "stop", tokens: { input: 4, output: 2, reasoning: 1, cache: { read: 1 } }, cost: 0.01 } }),
      ].join("\n");
      return { stdout, exitCode: 0, startedAt: "2026-09-01T00:00:00.000Z", completedAt: "2026-09-01T00:00:01.000Z", firstOutputMs: 8,
        cancelled: false, timedOut: false, outputLimitExceeded: false, settlement };
    } };
    const adapter = new OpenCodeCliAdapter(processClient, "opencode-fixture");
    const outcome = await adapter.request(cliProfile, { kind: "ambient-session", id: "opencode-ambient-session" }, request());
    expect(outcome).toMatchObject({ ok: true, value: { payload: { value: "cli" }, usage: {
      inputTokens: { measured: true, value: 4 }, outputTokens: { measured: true, value: 2 },
      cachedInputTokens: { measured: false, reason: "unsupported-by-provider" },
      reasoningTokens: { measured: false, reason: "unsupported-by-provider" },
      costUsd: { measured: false, reason: "unsupported-by-provider" },
      providerRequests: { measured: false, reason: "unsupported-by-provider" },
    } } });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args).toEqual(["--pure", "run", "--dir", expect.stringContaining("rb-vnext-opencode-"), "--format", "json", "--model", "opencode/gpt-5.6-luna", "--variant", "low"]);
    expect(calls[1]!.args).toEqual(["--pure", "export", "ses_fixture", "--sanitize"]);
    expect(calls[1]!.cwd).toBe(calls[0]!.cwd);
    expect(calls[1]!.stdin).toBe("");
    expect(calls[0]!.stdin).not.toContain(SENTINEL);
    expect(JSON.parse(calls[0]!.env.OPENCODE_CONFIG_CONTENT!)).toEqual({ permission: "deny", instructions: [] });
    expect(calls[0]!.env).toMatchObject({ OPENCODE_DISABLE_CLAUDE_CODE: "1", DO_NOT_TRACK: "1" });
    expect(calls[0]!.env.OPENCODE_PERMISSION).toBeUndefined();
    expect(adapter.currentExternalCliInvocationPolicy(cliProfile)).toEqual({
      format: "rb-external-cli-invocation-policy/v1", outputMode: "json", transportFraming: "jsonl", inputMode: "stdin",
      ambientAuth: true, modelArgument: cliProfile.modelId, directoryIsolation: "isolated-temporary",
      stderrPolicy: "ignored-not-recorded", pluginMode: "pure", toolPolicy: "deny", externalInstructions: "disabled",
      legacyCompatibilityRules: "disabled", environmentPolicy: "allowlisted",
      modelBearingProcessesPerSemanticRequest: 1, metadataProcessesPerSemanticRequest: 1,
      identitySource: "session-export", transportRetryLimit: 0,
    });
    expect(JSON.stringify(outcome)).not.toContain(rawExportSentinel);
    expect(JSON.stringify(outcome)).not.toContain(SENTINEL);
    expect(cliProfile).toMatchObject({ transport: "opencode-cli", requestAccounting: "opaque", strictSchema: false });
  });

  it("detects the runtime version through a separate non-inference preflight", async () => {
    const calls: OpenCodeCommandInput[] = [];
    const processClient: OpenCodeProcess = { async run(input) { calls.push(input); return {
      stdout: "OpenCode 1.18.25\n", exitCode: 0, startedAt: "s", completedAt: "e", cancelled: false, timedOut: false, outputLimitExceeded: false, settlement,
    }; } };
    await expect(new OpenCodeCliAdapter(processClient, "opencode-fixture").runtimePreflight()).resolves.toEqual({
      ok: true, value: { executable: "opencode-fixture", transportVersion: "1.18.25" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ executable: "opencode-fixture", args: ["--version"], stdin: "" });
    expect(calls[0]!.cwd).toContain("rb-vnext-opencode-");
    expect(calls[0]!.cwd).not.toBe(process.cwd());
    await expect(access(calls[0]!.cwd)).rejects.toThrow();
  });

  it("captures one session id and whitelists only assistant export identities", () => {
    const jsonl = [
      JSON.stringify({ type: "step_start", sessionID: "ses_fixture", part: { sessionID: "ses_fixture" } }),
      JSON.stringify({ type: "text", sessionID: "ses_fixture", part: { text: SENTINEL } }),
    ].join("\n");
    expect(extractOpenCodeCliSessionId(jsonl)).toBe("ses_fixture");
    expect(extractOpenCodeCliSessionId(`${jsonl}\n${JSON.stringify({ sessionID: "ses_other" })}`)).toBeUndefined();
    const exported = decodeOpenCodeSessionExport(JSON.stringify({
      title: SENTINEL,
      messages: [
        { info: { role: "user", providerID: "ignored", modelID: "ignored", path: "/private" }, parts: [{ text: SENTINEL }] },
        { info: { role: "assistant", providerID: "opencode", modelID: "gpt-5.6-luna", path: "/private" }, parts: [{ type: "reasoning", text: SENTINEL }] },
        { info: { role: "assistant", providerID: "opencode", modelID: "gpt-5.6-luna" }, parts: [{ type: "tool", input: SENTINEL }] },
      ],
    }));
    expect(exported).toEqual({ assistantMessageCount: 2, observedModelIds: ["opencode/gpt-5.6-luna"] });
    expect(JSON.stringify(exported)).not.toContain(SENTINEL);
    expect(JSON.stringify(exported)).not.toContain("/private");
  });

  it.each([
    [[], "missing"],
    [[{ info: { role: "assistant", providerID: "opencode", modelID: "other" } }], "wrong"],
    [[
      { info: { role: "assistant", providerID: "opencode", modelID: "gpt-5.6-luna" } },
      { info: { role: "assistant", providerID: "opencode", modelID: "other" } },
    ], "distinct"],
  ] as const)("fails closed for %s session-export identity", async (messages, _label) => {
    const processClient: OpenCodeProcess = { async run(input) { return {
      stdout: input.args.includes("export") ? JSON.stringify({ messages }) : [
        JSON.stringify({ type: "step_start", sessionID: "ses_fixture", part: { type: "step-start", sessionID: "ses_fixture" } }),
        JSON.stringify({ type: "text", sessionID: "ses_fixture", part: { type: "text", id: "answer", text: '{"value":"safe"}' } }),
      ].join("\n"),
      exitCode: 0, startedAt: "s", completedAt: "e", cancelled: false, timedOut: false, outputLimitExceeded: false, settlement,
    }; } };
    await expect(new OpenCodeCliAdapter(processClient).request(cliProfile, { kind: "ambient-session", id: "opencode-ambient-session" }, request()))
      .resolves.toMatchObject({ ok: false, error: { kind: "provider-error" } });
  });

  it("does not send a variant when generic reasoning is off", () => {
    expect(openCodeCliArgs(cliProfile, request({ reasoning: { mode: "off" } }), "/tmp/project")).toEqual([
      "--pure", "run", "--dir", "/tmp/project", "--format", "json", "--model", "opencode/gpt-5.6-luna",
    ]);
  });

  it("injects deny policy while allowlisting ambient-auth paths and excluding unrelated secrets", () => {
    const environment = openCodeChildEnvironment({
      PATH: "/bin", HOME: "/ambient-home", XDG_CONFIG_HOME: "/ambient-config", XDG_DATA_HOME: "/ambient-data",
      OPENCODE_PERMISSION: '"allow"', OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: "allow", instructions: ["BAD_EXTERNAL_RULE"] }),
      ANTHROPIC_API_KEY: "SHOULD_NOT_REACH_CHILD", OPENAI_API_KEY: "SHOULD_NOT_REACH_CHILD",
      DEEPSEEK_API_KEY: "SHOULD_NOT_REACH_CHILD", RANDOM_SECRET: "SHOULD_NOT_REACH_CHILD",
    });
    expect(environment).toMatchObject({ PATH: "/bin", HOME: "/ambient-home", XDG_CONFIG_HOME: "/ambient-config", XDG_DATA_HOME: "/ambient-data",
      OPENCODE_DISABLE_CLAUDE_CODE: "1", DO_NOT_TRACK: "1" });
    expect(JSON.parse(environment.OPENCODE_CONFIG_CONTENT!)).toEqual({ permission: "deny", instructions: [] });
    expect(environment).not.toHaveProperty("OPENCODE_PERMISSION");
    expect(environment).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(environment).not.toHaveProperty("OPENAI_API_KEY");
    expect(environment).not.toHaveProperty("DEEPSEEK_API_KEY");
    expect(environment).not.toHaveProperty("RANDOM_SECRET");
  });

  it("whitelists JSONL and drops reasoning, account, path, tool args, and ambient auth material", () => {
    const toolArguments = "TOOL_ARGUMENTS_MUST_NOT_PERSIST";
    const toolOutput = "TOOL_OUTPUT_MUST_NOT_PERSIST";
    const decoded = decodeOpenCodeCliJsonl([
      JSON.stringify({ type: "reasoning", part: { text: SENTINEL } }),
      JSON.stringify({ type: "tool", part: { callID: "call-1", arguments: toolArguments } }),
      JSON.stringify({ type: "tool", part: { callID: "call-1", output: toolOutput } }),
      JSON.stringify({ type: "text", part: { type: "text", text: '{"value":"safe"}', account: SENTINEL, cwd: "/private" } }),
    ].join("\n"), { exitCode: 0, startedAt: "s", completedAt: "e", streamComplete: true, treeQuiescent: true, treeVerified: true });
    expect(decoded).toMatchObject({ ok: true, value: { events: [{ kind: "text", text: '{"value":"safe"}' }], toolEventsObserved: 1 } });
    expect(JSON.stringify(decoded)).not.toContain(SENTINEL);
    expect(JSON.stringify(decoded)).not.toContain(toolArguments);
    expect(JSON.stringify(decoded)).not.toContain(toolOutput);
    expect(JSON.stringify(decoded)).not.toContain("/private");
  });

  it("rejects malformed JSONL and exact observed-model mismatch", () => {
    expect(decodeOpenCodeCliJsonl("{!", { exitCode: 0, startedAt: "s", completedAt: "e", streamComplete: true, treeQuiescent: true, treeVerified: true }))
      .toMatchObject({ ok: false, error: { kind: "malformed-syntax" } });
    const rawMismatch = { events: [{ kind: "step-start" as const }, { kind: "text" as const, text: "{}" }], toolEventsObserved: 0,
      assistantMessageCount: 1, observedModelIds: ["opencode/other"], exitCode: 0, startedAt: "s", completedAt: "e", streamComplete: true, treeQuiescent: true, treeVerified: true };
    expect(new OpenCodeCliAdapter().replay(cliProfile, request(), rawMismatch)).toMatchObject({ ok: false, error: { kind: "provider-error" } });
  });

  it("requires non-vacuous exact model identity and rejects distinct observations", () => {
    const adapter = new OpenCodeCliAdapter();
    const text = { kind: "text" as const, id: "answer", text: '{"value":"ok"}' };
    expect(adapter.replay(cliProfile, request(), cliRaw([text], 0, []))).toMatchObject({ ok: false, error: { kind: "provider-error" } });
    expect(adapter.replay(cliProfile, request(), cliRaw([{ kind: "step-start" }, text])))
      .toMatchObject({ ok: true, value: { payload: { value: "ok" } } });
    expect(adapter.replay(cliProfile, request(), cliRaw([
      { kind: "step-start" }, { kind: "step-start" }, text,
    ]))).toMatchObject({ ok: true });
    expect(adapter.replay(cliProfile, request(), cliRaw([
      { kind: "step-start" }, text,
    ], 0, [cliProfile.modelId, "opencode/other"]))).toMatchObject({ ok: false, error: { kind: "provider-error" } });
  });

  it("accepts one cumulative or incremental text part and rejects multiple authoritative parts", () => {
    const adapter = new OpenCodeCliAdapter();
    const model = { kind: "step-start" as const, modelId: cliProfile.modelId };
    expect(adapter.replay(cliProfile, request(), cliRaw([
      model, { kind: "text", id: "answer", text: '{"value"' }, { kind: "text", id: "answer", text: '{"value":"cumulative"}' },
    ]))).toMatchObject({ ok: true, value: { payload: { value: "cumulative" } } });
    expect(adapter.replay(cliProfile, request(), cliRaw([
      model, { kind: "text", id: "answer", text: '{"value":' }, { kind: "text", id: "answer", text: '"incremental"}' },
    ]))).toMatchObject({ ok: true, value: { payload: { value: "incremental" } } });
    expect(adapter.replay(cliProfile, request(), cliRaw([
      model, { kind: "text", id: "one", text: '{"value":"one"}' }, { kind: "text", id: "two", text: '{"value":"two"}' },
    ]))).toMatchObject({ ok: false, error: { kind: "provider-error" } });
  });

  it("ignores reasoning and stderr but fails closed on sanitized tool occurrence evidence", async () => {
    const transport = decodeOpenCodeCliJsonl([
      JSON.stringify({ type: "step-start", part: {} }),
      JSON.stringify({ type: "reasoning", part: { text: SENTINEL } }),
      JSON.stringify({ type: "text", part: { type: "text", id: "answer", text: '{"value":"safe"}' } }),
    ].join("\n"), { exitCode: 0, startedAt: "s", completedAt: "e", streamComplete: true, treeQuiescent: true, treeVerified: true,
      assistantMessageCount: 1, observedModelIds: [cliProfile.modelId] });
    expect(transport).toMatchObject({ ok: true, value: { toolEventsObserved: 0 } });
    if (transport.ok) expect(new OpenCodeCliAdapter().replay(cliProfile, request(), transport.value)).toMatchObject({ ok: true, value: { payload: { value: "safe" } } });

    expect(new OpenCodeCliAdapter().replay(cliProfile, request(), cliRaw([
      { kind: "step-start", modelId: cliProfile.modelId }, { kind: "text", id: "answer", text: '{"value":"unsafe"}' },
    ], 1))).toMatchObject({ ok: false, error: { kind: "provider-error" } });

    const processClient: OpenCodeProcess = { async run(input) { return {
      stdout: input.args.includes("export") ? JSON.stringify({ messages: [{ info: { role: "assistant", providerID: "opencode", modelID: "gpt-5.6-luna" } }] }) : [
        JSON.stringify({ type: "step_start", sessionID: "ses_fixture", part: { type: "step-start", sessionID: "ses_fixture" } }),
        JSON.stringify({ type: "text", sessionID: "ses_fixture", part: { type: "text", id: "answer", text: '{"value":"stdout"}' } }),
      ].join("\n"), stderr: '{"value":"stderr"}', exitCode: 0, startedAt: "s", completedAt: "e", cancelled: false,
      timedOut: false, outputLimitExceeded: false, settlement,
    }; } };
    await expect(new OpenCodeCliAdapter(processClient).request(cliProfile, { kind: "ambient-session", id: "opencode-ambient-session" }, request()))
      .resolves.toMatchObject({ ok: true, value: { payload: { value: "stdout" } } });
  });

  it.each([
    [{ exitCode: 2, timedOut: false, cancelled: false }, "provider-error"],
    [{ exitCode: null, timedOut: true, cancelled: false }, "timeout"],
    [{ exitCode: null, timedOut: false, cancelled: true }, "cancelled"],
  ] as const)("normalizes process failure %j as %s", async (state, kind) => {
    const processClient: OpenCodeProcess = { async run() { return {
      stdout: "", startedAt: "s", completedAt: "e", outputLimitExceeded: false, settlement,
      ...state,
    }; } };
    const outcome = await new OpenCodeCliAdapter(processClient).request(cliProfile, { kind: "ambient-session", id: "opencode-ambient-session" }, request());
    expect(outcome).toMatchObject({ ok: false, error: { kind, usage: { providerRequests: { measured: false, reason: "unsupported-by-provider" } } } });
  });

  it("registers dynamic exact CLI profiles and never resolves API credentials for CLI", async () => {
    const resolved = resolveProviderProfile(cliProfile.id);
    expect(resolved).toMatchObject({ id: cliProfile.id, modelId: "opencode/gpt-5.6-luna", transport: "opencode-cli" });
    expect(resolveProviderAdapter(cliProfile.id).transport).toBe("opencode-cli");
    await expect(resolveProviderAuth(resolved)).resolves.toEqual({ kind: "ambient-session", id: "opencode-ambient-session" });
    await expect(resolveProviderAuth(resolved, "opencode-go:default")).rejects.toThrow("not accepted");
  });
});
