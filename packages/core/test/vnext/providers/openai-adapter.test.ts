import { describe, expect, it, vi } from "vitest";
import {
  FetchOpenAiTransport,
  OPENAI_RESPONSES_ENDPOINT,
  OpenAiAdapter,
  openAiRequestBody,
  type OpenAiTransport,
  type OpenAiTransportInput,
} from "../../../src/vnext/providers/openai/adapter.js";
import {
  OPENAI_GPT_5_3_CODEX_PROFILE,
  OPENAI_GPT_5_6_SOL_PROFILE,
  OPENAI_PROFILES,
} from "../../../src/vnext/providers/openai/profiles.js";
import type { JsonSchemaDocument, SemanticRequest } from "../../../src/vnext/providers/contract.js";
import { CONFORMANCE_CASES } from "../../../src/vnext/providers/conformance/fixtures.js";
import { INIT_INTENT_SCHEMA, decodeIntentWire, deriveWorkSchema } from "../../../src/vnext/wire.js";
import { PROJECT_DESCRIPTION_SCHEMA } from "../../../src/vnext/progressive-init/project-description-ir.js";
import { PROJECT_PHASES_PROPOSAL_SCHEMA } from "../../../src/vnext/progressive-init/project-phases-ir.js";
import { openAiSse } from "./openai-helpers.js";

const SECRET = "OPENAI_SECRET_SENTINEL_NEVER_LEAK";
const credential = { kind: "credential" as const, credential: { id: "openai:test", secret: SECRET, attributes: {} } };

function request(schema: JsonSchemaDocument = {
  type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "string" } },
}, overrides: Partial<SemanticRequest> = {}): SemanticRequest {
  return {
    slice: "openai-test",
    instructions: "instructions",
    input: "input",
    schema,
    schemaName: "openai_test_schema",
    limits: { maxOutputTokens: 100, deadlineMs: 5_000 },
    reasoning: { mode: "off" },
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("OpenAI direct adapter", () => {
  it("declares exactly the four non-strict source profiles", () => {
    expect(OPENAI_PROFILES.map((profile) => profile.id)).toEqual([
      "openai:gpt-5.6-sol", "openai:gpt-5.6-terra", "openai:gpt-5.6-luna", "openai:gpt-5.3-codex",
    ]);
    for (const profile of OPENAI_PROFILES) {
      expect(profile).toMatchObject({
        family: "openai", transport: "direct-api", structuredOutput: "json-schema", strictSchema: false,
        conformance: { tier: "UNSUPPORTED", verifiedRecord: false, runId: null, recordedAt: null },
      });
    }
  });

  it("sends one Responses request with Bearer auth, strict:false, no tools, and the original schema", async () => {
    const calls: OpenAiTransportInput[] = [];
    const schema = structuredClone(INIT_INTENT_SCHEMA);
    const before = structuredClone(schema);
    const adapter = new OpenAiAdapter({ async send(input) { calls.push(input); return openAiSse({ value: "ok" }); } });
    expect(await adapter.request(OPENAI_GPT_5_6_SOL_PROFILE, credential, request(schema)))
      .toMatchObject({ ok: true, value: { payload: { value: "ok" } } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ endpoint: OPENAI_RESPONSES_ENDPOINT, headers: { authorization: `Bearer ${SECRET}` } });
    const body = JSON.parse(calls[0]!.body) as Record<string, any>;
    expect(body.text.format).toMatchObject({ type: "json_schema", name: "openai_test_schema", strict: false });
    expect(body.text.format.schema).toEqual(before);
    expect(schema).toEqual(before);
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(calls[0]!.body).not.toContain(SECRET);
  });

  it("preserves every previously problematic production and generic schema exactly", () => {
    const work = deriveWorkSchema({
      requirements: [{ key: "requirement-a", statement: "A" }],
      qualityCommands: [{ key: "test", kind: "test", command: "npm test" }],
    });
    const generic = CONFORMANCE_CASES.map((test) => test.request().schema);
    for (const schema of [INIT_INTENT_SCHEMA, PROJECT_DESCRIPTION_SCHEMA, PROJECT_PHASES_PROPOSAL_SCHEMA, work, ...generic]) {
      const before = structuredClone(schema);
      const body = openAiRequestBody(OPENAI_GPT_5_6_SOL_PROFILE, request(schema)) as any;
      expect(body.text.format.schema).toEqual(before);
      expect(body.text.format.strict).toBe(false);
      expect(schema).toEqual(before);
    }
    const intent = (openAiRequestBody(OPENAI_GPT_5_6_SOL_PROFILE, request(INIT_INTENT_SCHEMA)) as any).text.format.schema;
    expect(intent.properties.determinations.items.properties.evidence).toEqual({ type: "string" });
    expect(intent.properties.determinations.items.required).not.toContain("evidence");
    const workBody = (openAiRequestBody(OPENAI_GPT_5_6_SOL_PROFILE, request(work)) as any).text.format.schema;
    expect(workBody.properties.phases.items.properties.tasks.items.properties.validation.items).toHaveProperty("oneOf");
    expect(workBody.properties.phases.items.properties.tasks.items.properties.validation.items).not.toHaveProperty("anyOf");
    expect((openAiRequestBody(OPENAI_GPT_5_6_SOL_PROFILE, request(generic[9]!)) as any).text.format.schema)
      .toMatchObject({ additionalProperties: true, properties: { items: { items: {} } } });
  });

  it("maps conservative model-specific reasoning efforts", () => {
    expect(openAiRequestBody(OPENAI_GPT_5_6_SOL_PROFILE, request(undefined, { reasoning: { mode: "off" } })))
      .toMatchObject({ reasoning: { effort: "none" } });
    expect(openAiRequestBody(OPENAI_GPT_5_3_CODEX_PROFILE, request(undefined, { reasoning: { mode: "off" } })))
      .toMatchObject({ reasoning: { effort: "low" } });
  });

  it("returns schema-invalid JSON as unknown payload so Core remains final authority", async () => {
    const invalid = { format: "wrong", unexpected: true };
    const adapter = new OpenAiAdapter({ async send() { return openAiSse(invalid); } });
    const outcome = await adapter.request(OPENAI_GPT_5_6_SOL_PROFILE, credential, request(INIT_INTENT_SCHEMA));
    expect(outcome).toMatchObject({ ok: true, value: { payload: invalid } });
    if (!outcome.ok) throw new Error("expected parsed payload");
    expect(decodeIntentWire(outcome.value.payload, "authoritative request").ok).toBe(false);
  });

  it("owns one request and never retries malformed output", async () => {
    let calls = 0;
    const adapter = new OpenAiAdapter({ async send() { calls += 1; return { ...openAiSse({}), body: "event: response.completed\ndata: {!}\n\n" }; } });
    expect(await adapter.request(OPENAI_GPT_5_6_SOL_PROFILE, credential, request()))
      .toMatchObject({ ok: false, error: { kind: "malformed-syntax" } });
    expect(calls).toBe(1);
  });

  it.each([
    [401, "auth", false], [403, "provider-error", false], [429, "rate-limit", true], [500, "transport", true],
  ] as const)("maps HTTP %i without unsafe provider text", async (status, kind, retryable) => {
    const adapter = new OpenAiAdapter({ async send() { return { ...openAiSse({}), status, body: JSON.stringify({ error: { type: "invalid_request_error", code: "safe_code", param: "model", message: SECRET } }) }; } });
    const outcome = await adapter.request(OPENAI_GPT_5_6_SOL_PROFILE, credential, request());
    expect(outcome).toMatchObject({ ok: false, error: { kind, transportRetryable: retryable } });
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });

  it("distinguishes cancellation, timeout, and network failure", async () => {
    const blocking: OpenAiTransport = { send(input) { return new Promise((_, reject) => input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true })); } };
    const controller = new AbortController();
    const cancelled = new OpenAiAdapter(blocking).request(OPENAI_GPT_5_6_SOL_PROFILE, credential, request(undefined, { signal: controller.signal }));
    controller.abort(new Error(SECRET));
    expect(await cancelled).toMatchObject({ ok: false, error: { kind: "cancelled" } });
    expect(await new OpenAiAdapter(blocking).request(OPENAI_GPT_5_6_SOL_PROFILE, credential, request(undefined, { limits: { maxOutputTokens: 100, deadlineMs: 5 } })))
      .toMatchObject({ ok: false, error: { kind: "timeout" } });
    const failed = await new OpenAiAdapter({ async send() { throw new Error(SECRET); } }).request(OPENAI_GPT_5_6_SOL_PROFILE, credential, request());
    expect(failed).toMatchObject({ ok: false, error: { kind: "transport" } });
    expect(JSON.stringify(failed)).not.toContain(SECRET);
  });

  it("preserves fragmented UTF-8 in the fetch transport", async () => {
    const raw = openAiSse({ text: "ação 漢字 🚀" });
    const bytes = new TextEncoder().encode(raw.body);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({ start(controller) { bytes.forEach((byte) => controller.enqueue(Uint8Array.of(byte))); controller.close(); } }), { status: 200, headers: { "content-type": "text/event-stream", authorization: SECRET } })));
    const captured = await new FetchOpenAiTransport().send({ endpoint: OPENAI_RESPONSES_ENDPOINT, headers: {}, body: "{}", signal: new AbortController().signal });
    expect(captured.body).toBe(raw.body);
    expect(captured.headers).toEqual({ "content-type": "text/event-stream" });
    vi.unstubAllGlobals();
  });
});
