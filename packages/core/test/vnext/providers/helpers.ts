import type { AnthropicRawResponse } from "../../../src/vnext/providers/anthropic/normalize.js";

export function anthropicSse(payload: unknown, options: {
  toolName?: string;
  stopReason?: string;
  usage?: Record<string, number>;
  extraBlockMetadata?: Record<string, unknown>;
} = {}): AnthropicRawResponse {
  const toolName = options.toolName ?? "record_representation";
  const usage = options.usage ?? {
    input_tokens: 10,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 8,
  };
  const event = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
  return {
    status: 200,
    headers: { "content-type": "text/event-stream", "request-id": "req_fixture" },
    body: [
      event({ type: "message_start", message: { id: "msg_fixture", usage, provider_extra: "drop-me" } }),
      event({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool_fixture", name: toolName, input: {}, ...options.extraBlockMetadata } }),
      event({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(payload) } }),
      event({ type: "content_block_stop", index: 0 }),
      event({ type: "message_delta", delta: { stop_reason: options.stopReason ?? "tool_use" }, usage: { output_tokens: usage.output_tokens } }),
      event({ type: "message_stop" }),
    ].join(""),
    startedAt: "2026-08-28T12:00:00.000Z",
    completedAt: "2026-08-28T12:00:00.100Z",
    firstOutputMs: 25,
    streamComplete: true,
  };
}
