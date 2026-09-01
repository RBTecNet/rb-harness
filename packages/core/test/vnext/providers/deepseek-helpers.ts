import type { DeepSeekRawResponse } from "../../../src/vnext/providers/deepseek/normalize.js";

export interface DeepSeekFixtureOptions {
  readonly model?: string;
  readonly status?: "completed" | "incomplete" | "failed";
  readonly incompleteReason?: "max_output_tokens" | "content_filter";
  readonly outputTexts?: readonly string[];
  readonly usage?: Record<string, unknown>;
  readonly includeReasoning?: boolean;
  readonly error?: Record<string, unknown>;
  readonly extraResponseMetadata?: Record<string, unknown>;
  readonly firstOutputMs?: number;
  readonly streamComplete?: boolean;
  readonly httpStatus?: number;
}

export function sseEvent(type: string, value: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
}

export function deepSeekSse(payload: unknown, options: DeepSeekFixtureOptions = {}): DeepSeekRawResponse {
  const status = options.status ?? "completed";
  const outputTexts = options.outputTexts ?? [JSON.stringify(payload)];
  const output: Record<string, unknown>[] = [];
  const events: string[] = [sseEvent("response.created", {
    sequence_number: 0,
    response: { id: "resp_fixture", object: "response", status: "in_progress", model: options.model ?? "deepseek-v4-pro" },
  })];
  if (options.includeReasoning) {
    output.push({
      type: "reasoning",
      id: "rs_fixture",
      status: "completed",
      content: [{ type: "reasoning_text", text: "private provider reasoning" }],
    });
    events.push(sseEvent("response.reasoning_text.delta", {
      sequence_number: 1,
      item_id: "rs_fixture",
      output_index: 0,
      content_index: 0,
      delta: "private provider reasoning",
    }));
  }
  outputTexts.forEach((text, index) => {
    output.push({
      type: "message",
      id: `msg_${index}`,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    });
    events.push(sseEvent("response.output_text.delta", {
      sequence_number: events.length,
      item_id: `msg_${index}`,
      output_index: output.length - 1,
      content_index: 0,
      delta: text.slice(0, Math.max(1, Math.floor(text.length / 2))),
    }));
    events.push(sseEvent("response.output_text.delta", {
      sequence_number: events.length,
      item_id: `msg_${index}`,
      output_index: output.length - 1,
      content_index: 0,
      delta: text.slice(Math.max(1, Math.floor(text.length / 2))),
    }));
    events.push(sseEvent("response.output_text.done", {
      sequence_number: events.length,
      item_id: `msg_${index}`,
      output_index: output.length - 1,
      content_index: 0,
      text,
    }));
  });
  const terminalType = `response.${status}`;
  events.push(sseEvent(terminalType, {
    sequence_number: events.length,
    response: {
      id: "resp_fixture",
      object: "response",
      status,
      model: options.model ?? "deepseek-v4-pro",
      output,
      usage: options.usage ?? {
        input_tokens: 11,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens: 7,
        output_tokens_details: { reasoning_tokens: options.includeReasoning ? 2 : 0 },
        total_tokens: 18,
      },
      error: options.error ?? null,
      incomplete_details: options.incompleteReason ? { reason: options.incompleteReason } : null,
      provider_extra: { ignored: true },
      ...options.extraResponseMetadata,
    },
  }));
  return {
    status: options.httpStatus ?? 200,
    headers: { "content-type": "text/event-stream", "x-request-id": "header_fixture" },
    body: events.join(""),
    startedAt: "2026-09-01T12:00:00.000Z",
    completedAt: "2026-09-01T12:00:01.000Z",
    firstOutputMs: options.firstOutputMs ?? 25,
    streamComplete: options.streamComplete ?? true,
  };
}
