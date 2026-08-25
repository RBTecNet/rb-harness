/**
 * Incremental transport for the direct-API runtime.
 *
 * The runtime used to request `stream: false`, so a subprocess stayed
 * completely silent from the first byte of the prompt until the whole agent
 * loop finished. The orchestrator could not tell a model that was thinking
 * from a connection that had died, and `--first-output-timeout` killed
 * legitimate, already-paid generations at exactly 300s.
 *
 * Streaming fixes that, but it must not leak. Two channels are kept strictly
 * apart:
 *
 *   - **observability**: content-free activity markers on stderr, used for
 *     first-output detection, the progress window, and telemetry;
 *   - **result**: the subprocess's stdout, which still carries only the
 *     model's complete final answer, byte for byte.
 *
 * A fragment of the document envelope never reaches stdout, and no marker ever
 * carries prompt text, reasoning, tool arguments, or a secret.
 */

export const ACTIVITY_PREFIX = "[rb-api-event]";

/**
 * Content-free markers. Each one means "the remote API did something real";
 * an SSE keep-alive comment deliberately produces none, because a keep-alive
 * proves the socket is open, not that the provider is answering.
 */
export type ActivityKind =
  | "response-start"
  | "content-delta"
  | "reasoning-delta"
  | "tool-call-delta"
  | "response-complete";

export const ACTIVITY_KINDS: readonly ActivityKind[] = [
  "response-start",
  "content-delta",
  "reasoning-delta",
  "tool-call-delta",
  "response-complete",
] as const;

/** Parse one activity line, or `undefined` when it is not a marker. */
export function parseActivityLine(line: string): ActivityKind | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith(ACTIVITY_PREFIX)) return undefined;
  const kind = trimmed.slice(ACTIVITY_PREFIX.length).trim();
  return (ACTIVITY_KINDS as readonly string[]).includes(kind) ? kind as ActivityKind : undefined;
}

/**
 * Rate-limited activity reporter.
 *
 * One marker per token would drown stderr for no extra information: the
 * progress window only needs to know that events are still arriving. Boundary
 * markers are never throttled.
 */
export class ActivityReporter {
  private readonly lastEmitted = new Map<ActivityKind, number>();
  private emitted = 0;

  constructor(
    private readonly write: (line: string) => void,
    private readonly throttleMilliseconds = 200,
    private readonly now: () => number = Date.now,
  ) {}

  count(): number {
    return this.emitted;
  }

  report(kind: ActivityKind): void {
    const boundary = kind === "response-start" || kind === "response-complete";
    const at = this.now();
    if (!boundary) {
      const previous = this.lastEmitted.get(kind);
      if (previous !== undefined && at - previous < this.throttleMilliseconds) return;
    }
    this.lastEmitted.set(kind, at);
    this.emitted += 1;
    this.write(`${ACTIVITY_PREFIX} ${kind}\n`);
  }
}

export interface SseEvent {
  /** The `event:` field, when the dialect uses one. */
  name?: string;
  /** The accumulated `data:` payload. */
  data: string;
}

/**
 * Read an SSE body incrementally.
 *
 * Comment lines (`: keep-alive`) are consumed and never surfaced: they hold no
 * provider output, so they must not renew the progress window. A dispatched
 * event requires a blank-line terminator, exactly as the SSE grammar says.
 */
export async function* readSseEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let name: string | undefined;
  const onAbort = (): void => {
    // Releasing the reader tears down the socket; nothing further is read and
    // no partial answer is ever returned.
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") {
          if (data.length) {
            yield { ...(name ? { name } : {}), data: data.join("\n") };
            data = [];
            name = undefined;
          }
        } else if (line.startsWith(":")) {
          // A keep-alive comment: the socket is alive, the provider is not
          // necessarily producing anything. Deliberately not an event.
        } else if (line.startsWith("event:")) {
          name = line.slice("event:".length).trim();
        } else if (line.startsWith("data:")) {
          data.push(line.slice("data:".length).replace(/^ /, ""));
        }
        newline = buffer.indexOf("\n");
      }
    }
    // A body that ends mid-event is a truncated stream; the caller decides,
    // because only it knows whether the terminal event had already arrived.
    if (data.length) yield { ...(name ? { name } : {}), data: data.join("\n") };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

function parseEventJson(raw: string, dialect: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value as Record<string, unknown>;
  } catch {
    // A malformed event is a protocol failure. Skipping it would silently
    // drop part of a paid answer.
    throw new Error(`the ${dialect} stream produced a malformed event: ${raw.slice(0, 200)}`);
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/** One tool call reassembled from its deltas. */
interface StreamedToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * What a response was actually made of.
 *
 * Reasoning and content are counted apart because they are not
 * interchangeable: a response can be entirely reasoning and still be empty as
 * an answer, which is precisely how a paid generation was lost. Only sizes and
 * counts are kept — never a byte of the text itself.
 */
export interface StreamComposition {
  reasoningEvents: number;
  contentEvents: number;
  reasoningBytes: number;
  contentBytes: number;
}

export function emptyComposition(): StreamComposition {
  return { reasoningEvents: 0, contentEvents: 0, reasoningBytes: 0, contentBytes: 0 };
}

export interface StreamedOpenAiMessage {
  /** The assistant message, in the same shape the non-streaming API returns. */
  message: Record<string, unknown>;
  finishReason: string;
  /** Usage exactly as the provider reported it, or `undefined` when it did not. */
  usage?: Record<string, unknown>;
  composition: StreamComposition;
}

/**
 * Reassemble one OpenAI-compatible chat completion from its SSE deltas.
 *
 * Tool-call arguments arrive split across any number of deltas and are only
 * parsed by the caller once the response is complete; concatenating them here
 * keeps that decision in one place.
 */
export async function readOpenAiStream(
  body: ReadableStream<Uint8Array>,
  reporter: ActivityReporter,
  signal?: AbortSignal,
): Promise<StreamedOpenAiMessage> {
  let started = false;
  let completed = false;
  let content = "";
  let reasoning = "";
  let finishReason = "";
  let usage: Record<string, unknown> | undefined;
  const composition = emptyComposition();
  const toolCalls: StreamedToolCall[] = [];

  for await (const event of readSseEvents(body, signal)) {
    if (event.data === "[DONE]") {
      completed = true;
      continue;
    }
    const chunk = parseEventJson(event.data, "OpenAI-compatible");
    if (!started) {
      started = true;
      reporter.report("response-start");
    }
    // Usage may ride the final chunk; the last one wins and is counted once.
    const chunkUsage = record(chunk.usage);
    if (Object.keys(chunkUsage).length) usage = chunkUsage;
    const choice = record(Array.isArray(chunk.choices) ? chunk.choices[0] : undefined);
    if (typeof choice.finish_reason === "string" && choice.finish_reason) {
      finishReason = choice.finish_reason;
      completed = true;
    }
    const delta = record(choice.delta);
    if (typeof delta.content === "string" && delta.content) {
      content += delta.content;
      composition.contentEvents += 1;
      composition.contentBytes += Buffer.byteLength(delta.content);
      reporter.report("content-delta");
    }
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
      // Consumed for observability only: reasoning never joins the answer.
      reasoning += delta.reasoning_content;
      composition.reasoningEvents += 1;
      composition.reasoningBytes += Buffer.byteLength(delta.reasoning_content);
      reporter.report("reasoning-delta");
    }
    for (const raw of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const entry = record(raw);
      const index = Number.isInteger(entry.index) ? Number(entry.index) : toolCalls.length;
      const slot = toolCalls[index] ?? { id: "", name: "", arguments: "" };
      const fn = record(entry.function);
      if (typeof entry.id === "string" && entry.id) slot.id = entry.id;
      if (typeof fn.name === "string" && fn.name) slot.name += fn.name;
      if (typeof fn.arguments === "string") slot.arguments += fn.arguments;
      toolCalls[index] = slot;
      reporter.report("tool-call-delta");
    }
  }

  if (!started) throw new Error("the provider closed the stream without sending any event");
  if (!completed) {
    throw new Error("the provider stream ended before signalling completion; the response is truncated");
  }
  reporter.report("response-complete");

  const present = toolCalls.filter((call): call is StreamedToolCall => Boolean(call?.name));
  const message: Record<string, unknown> = { role: "assistant", content };
  if (reasoning) message.reasoning_content = reasoning;
  if (present.length) {
    message.tool_calls = present.map((call, index) => ({
      id: call.id || `call-${index}`,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  return { message, finishReason, composition, ...(usage ? { usage } : {}) };
}

export interface StreamedAnthropicMessage {
  content: Array<Record<string, unknown>>;
  stopReason: string;
  usage?: Record<string, unknown>;
  composition: StreamComposition;
}

/**
 * Reassemble one Anthropic Messages response from its event stream.
 *
 * Input tokens arrive with `message_start` and output tokens with
 * `message_delta`; both are merged into a single usage object so the caller
 * counts one response exactly once.
 */
export async function readAnthropicStream(
  body: ReadableStream<Uint8Array>,
  reporter: ActivityReporter,
  signal?: AbortSignal,
): Promise<StreamedAnthropicMessage> {
  let started = false;
  let completed = false;
  let stopReason = "";
  const usage: Record<string, unknown> = {};
  const composition = emptyComposition();
  const blocks: Array<Record<string, unknown>> = [];
  const partialJson = new Map<number, string>();

  for await (const event of readSseEvents(body, signal)) {
    const payload = parseEventJson(event.data, "Anthropic");
    const type = typeof payload.type === "string" ? payload.type : event.name ?? "";
    if (!started) {
      started = true;
      reporter.report("response-start");
    }
    if (type === "message_start") {
      Object.assign(usage, record(record(payload.message).usage));
      continue;
    }
    if (type === "content_block_start") {
      const index = Number(payload.index ?? blocks.length);
      const block = record(payload.content_block);
      blocks[index] = block.type === "tool_use"
        ? { type: "tool_use", id: String(block.id ?? `tool-${index}`), name: String(block.name ?? ""), input: {} }
        : { type: "text", text: typeof block.text === "string" ? block.text : "" };
      if (block.type === "tool_use") partialJson.set(index, "");
      continue;
    }
    if (type === "content_block_delta") {
      const index = Number(payload.index ?? 0);
      const delta = record(payload.delta);
      const block = blocks[index] ?? { type: "text", text: "" };
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        block.text = `${String(block.text ?? "")}${delta.text}`;
        composition.contentEvents += 1;
        composition.contentBytes += Buffer.byteLength(delta.text);
        reporter.report("content-delta");
      } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        // Observed and measured, never merged into the answer.
        composition.reasoningEvents += 1;
        composition.reasoningBytes += Buffer.byteLength(delta.thinking);
        reporter.report("reasoning-delta");
      } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        partialJson.set(index, `${partialJson.get(index) ?? ""}${delta.partial_json}`);
        reporter.report("tool-call-delta");
      }
      blocks[index] = block;
      continue;
    }
    if (type === "content_block_stop") {
      const index = Number(payload.index ?? 0);
      const raw = partialJson.get(index);
      const block = blocks[index];
      if (raw !== undefined && block) {
        // Only now, with every fragment in hand, is the JSON parsed.
        try {
          block.input = raw.trim() ? record(JSON.parse(raw)) : {};
        } catch {
          block.input = { __invalid_arguments: raw };
        }
      }
      continue;
    }
    if (type === "message_delta") {
      const delta = record(payload.delta);
      if (typeof delta.stop_reason === "string" && delta.stop_reason) stopReason = delta.stop_reason;
      Object.assign(usage, record(payload.usage));
      continue;
    }
    if (type === "message_stop") {
      completed = true;
      continue;
    }
    if (type === "error") {
      const error = record(payload.error);
      throw new Error(`provider stream error: ${String(error.message ?? "unknown")}`.slice(0, 500));
    }
  }

  if (!started) throw new Error("the provider closed the stream without sending any event");
  if (!completed) {
    throw new Error("the provider stream ended before signalling completion; the response is truncated");
  }
  reporter.report("response-complete");
  return {
    content: blocks.filter(Boolean),
    stopReason,
    composition,
    ...(Object.keys(usage).length ? { usage } : {}),
  };
}
