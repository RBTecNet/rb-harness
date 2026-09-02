import type { OpenAiRawResponse } from "../../../src/vnext/providers/openai/normalize.js";

export interface OpenAiFixtureOptions {
  readonly model?: string | null;
  readonly status?: "completed" | "incomplete" | "failed";
  readonly incompleteReason?: string;
  readonly outputTexts?: readonly string[];
  readonly output?: readonly unknown[];
  readonly usage?: Record<string, unknown>;
  readonly includeReasoning?: boolean;
  readonly error?: Record<string, unknown>;
  readonly streamComplete?: boolean;
  readonly httpStatus?: number;
  readonly lineEnding?: "\n" | "\r\n";
  readonly extraFrames?: readonly string[];
}

export function openAiSseEvent(type: string, value: Record<string, unknown>, lineEnding = "\n"): string {
  return `event: ${type}${lineEnding}data: ${JSON.stringify({ type, ...value })}${lineEnding}${lineEnding}`;
}

export function openAiSse(payload: unknown, options: OpenAiFixtureOptions = {}): OpenAiRawResponse {
  const status = options.status ?? "completed";
  const ending = options.lineEnding ?? "\n";
  const model = options.model === null ? undefined : options.model ?? "gpt-5.6-sol";
  const outputTexts = options.outputTexts ?? [JSON.stringify(payload)];
  const output: unknown[] = options.output ? [...options.output] : [];
  const frames: string[] = [openAiSseEvent("response.created", { sequence_number: 0, response: { id: "resp_fixture", status: "in_progress", ...(model ? { model } : {}) } }, ending)];
  if (options.includeReasoning) {
    output.push({ type: "reasoning", id: "rs_fixture", status: "completed", content: [] });
    frames.push(openAiSseEvent("response.reasoning_summary_text.delta", { delta: "private" }, ending));
  }
  if (!options.output) {
    outputTexts.forEach((text, index) => {
      output.push({ type: "message", id: `msg_${index}`, status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] });
      frames.push(openAiSseEvent("response.output_text.delta", { delta: text }, ending));
    });
  }
  frames.push(...(options.extraFrames ?? []));
  frames.push(openAiSseEvent(`response.${status}`, {
    sequence_number: frames.length,
    response: {
      id: "resp_fixture",
      status,
      ...(model ? { model } : {}),
      output,
      usage: options.usage ?? {
        input_tokens: 11,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens: 7,
        output_tokens_details: { reasoning_tokens: 2 },
      },
      error: options.error ?? null,
      incomplete_details: options.incompleteReason ? { reason: options.incompleteReason } : null,
    },
  }, ending));
  return {
    status: options.httpStatus ?? 200,
    headers: { "content-type": "text/event-stream", "x-request-id": "request_fixture" },
    body: frames.join(""),
    startedAt: "2026-09-01T12:00:00.000Z",
    completedAt: "2026-09-01T12:00:01.000Z",
    firstOutputMs: 25,
    streamComplete: options.streamComplete ?? true,
  };
}
