import { describe, expect, it, vi } from "vitest";
import {
  AnthropicAdapter,
  anthropicRequestBody,
  type AnthropicTransport,
} from "../../../src/vnext/providers/anthropic/adapter.js";
import { CLAUDE_OPUS_5_PROFILE } from "../../../src/vnext/providers/anthropic/profiles.js";
import type { SemanticRequest } from "../../../src/vnext/providers/contract.js";
import { anthropicSse } from "./helpers.js";

function request(overrides: Partial<SemanticRequest> = {}): SemanticRequest {
  return {
    slice: "opaque-label",
    instructions: "INSTRUCTIONS-BYTES",
    input: "INPUT-BYTES",
    schema: { type: "object", properties: { value: { type: "string" } } },
    schemaName: "opaque_schema",
    limits: { maxOutputTokens: 100, deadlineMs: 5_000 },
    reasoning: { mode: "off" },
    signal: new AbortController().signal,
    ...overrides,
  };
}

const credential = { id: "anthropic:test", secret: "secret-never-snapshot", attributes: {} };

describe("Anthropic adapter", () => {
  it("places instructions/input/schema bytes into protocol without prompt augmentation", () => {
    const value = request();
    const body = anthropicRequestBody(CLAUDE_OPUS_5_PROFILE, value);
    expect(body.system).toBe(value.instructions);
    expect(body.messages).toEqual([{ role: "user", content: value.input }]);
    expect(body.tools).toEqual([{ name: value.schemaName, input_schema: value.schema }]);
    expect(body.tool_choice).toEqual({ type: "tool", name: value.schemaName });
    expect(JSON.stringify(body)).not.toMatch(/valid JSON|requirements|Ralph|PHASES|Markdown/i);
  });

  it("rejects unsupported capability before invoking transport", async () => {
    const send = vi.fn();
    const adapter = new AnthropicAdapter({ send } as AnthropicTransport);
    const badEffort = await adapter.request(CLAUDE_OPUS_5_PROFILE, credential, request({ reasoning: { mode: "on", effort: "ultra" } }));
    expect(badEffort).toMatchObject({ ok: false, error: { kind: "unsupported-capability" } });
    const tooLarge = await adapter.request(CLAUDE_OPUS_5_PROFILE, credential, request({ limits: { maxOutputTokens: 128_001, deadlineMs: 5_000 } }));
    expect(tooLarge).toMatchObject({ ok: false, error: { kind: "unsupported-capability" } });
    expect(send).not.toHaveBeenCalled();
  });

  it("owns exactly one request and never retries malformed or incomplete payloads", async () => {
    let calls = 0;
    const transport: AnthropicTransport = {
      async send() {
        calls += 1;
        return calls === 1
          ? anthropicSse({ items: [] }, { toolName: "opaque_schema" })
          : anthropicSse({ shouldNever: "happen" }, { toolName: "opaque_schema" });
      },
    };
    const adapter = new AnthropicAdapter(transport);
    const outcome = await adapter.request(CLAUDE_OPUS_5_PROFILE, credential, request());
    expect(outcome).toMatchObject({ ok: true, value: { payload: { items: [] }, usage: { providerRequests: { measured: true, value: 1 } } } });
    expect(calls).toBe(1);

    calls = 0;
    const malformedAdapter = new AnthropicAdapter({
      async send() {
        calls += 1;
        return { ...anthropicSse({}, { toolName: "opaque_schema" }), body: "data: {!}\n\n" };
      },
    });
    expect(await malformedAdapter.request(CLAUDE_OPUS_5_PROFILE, credential, request()))
      .toMatchObject({ ok: false, error: { kind: "malformed-syntax" } });
    expect(calls).toBe(1);
  });

  it("maps caller cancellation and deadlines promptly without retry", async () => {
    let calls = 0;
    const blocking: AnthropicTransport = {
      send(input) {
        calls += 1;
        return new Promise((_, reject) => input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true }));
      },
    };
    const adapter = new AnthropicAdapter(blocking);
    const controller = new AbortController();
    const cancelled = adapter.request(CLAUDE_OPUS_5_PROFILE, credential, request({ signal: controller.signal }));
    controller.abort();
    expect(await cancelled).toMatchObject({ ok: false, error: { kind: "cancelled" } });
    expect(calls).toBe(1);

    calls = 0;
    const timedOut = await adapter.request(CLAUDE_OPUS_5_PROFILE, credential, request({ limits: { maxOutputTokens: 100, deadlineMs: 5 } }));
    expect(timedOut).toMatchObject({ ok: false, error: { kind: "timeout" } });
    expect(calls).toBe(1);
  });

  it("encodes enabled and disabled exact-profile reasoning controls", () => {
    expect(anthropicRequestBody(CLAUDE_OPUS_5_PROFILE, request({ reasoning: { mode: "on", effort: "xhigh" } })))
      .toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort: "xhigh" } });
    expect(anthropicRequestBody(CLAUDE_OPUS_5_PROFILE, request({ reasoning: { mode: "off" } })))
      .toMatchObject({ thinking: { type: "disabled" } });
  });

  it("sends a valid configured workspace ID and omits the header when absent", async () => {
    const captured: Array<Readonly<Record<string, string>>> = [];
    const adapter = new AnthropicAdapter({
      async send(input) {
        captured.push(input.headers);
        return anthropicSse({ value: "ok" }, { toolName: "opaque_schema" });
      },
    });
    const withWorkspace = await adapter.request(
      CLAUDE_OPUS_5_PROFILE,
      { ...credential, attributes: { workspaceId: "wrkspc_TEST123" } },
      request(),
    );
    const withoutWorkspace = await adapter.request(CLAUDE_OPUS_5_PROFILE, credential, request());
    expect(withWorkspace.ok).toBe(true);
    expect(withoutWorkspace.ok).toBe(true);
    expect(captured[0]?.["anthropic-workspace-id"]).toBe("wrkspc_TEST123");
    expect(captured[1]).not.toHaveProperty("anthropic-workspace-id");
    expect(JSON.stringify([withWorkspace, withoutWorkspace])).not.toContain(credential.secret);
  });

  it("rejects malformed configured workspace metadata before transport without exposing the secret", async () => {
    const send = vi.fn();
    const adapter = new AnthropicAdapter({ send } as AnthropicTransport);
    const outcome = await adapter.request(
      CLAUDE_OPUS_5_PROFILE,
      { ...credential, attributes: { workspaceId: "workspace-not-valid" } },
      request(),
    );
    expect(outcome).toMatchObject({ ok: false, error: { kind: "auth", transportRetryable: false } });
    expect(send).not.toHaveBeenCalled();
    expect(JSON.stringify(outcome)).not.toContain(credential.secret);
  });
});
