import { sha256, sha256Canonical } from "../hashing.js";
import { M5B_LIMITS_V2, RalphM5BError } from "./contract.js";

/**
 * Exact stock `codex exec --json` (0.153.4) transport parser.
 *
 * The stream is transport and terminal telemetry ONLY.  It never establishes
 * what the provider wrote, which commands really ran, or whether the
 * workspace changed: the host filesystem comparison owns all of that.
 */
export const CODEX_EVENT_TYPES_V2 = [
  "thread.started",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "item.started",
  "item.updated",
  "item.completed",
  "error",
] as const;
export type CodexEventTypeV2 = typeof CODEX_EVENT_TYPES_V2[number];

export const CODEX_ITEM_TYPES_V2 = [
  "agent_message",
  "reasoning",
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "web_search",
  "todo_list",
] as const;
export type CodexItemTypeV2 = typeof CODEX_ITEM_TYPES_V2[number];

export const CODEX_TERMINAL_KINDS_V2 = ["TURN_COMPLETED", "TURN_FAILED", "ERROR"] as const;
export type CodexTerminalKindV2 = typeof CODEX_TERMINAL_KINDS_V2[number];

const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,190}$/;

export interface CodexEventStreamV2 {
  readonly threadId: string;
  readonly terminal: CodexTerminalKindV2;
  readonly eventCount: number;
  readonly turnStartedCount: number;
  readonly agentMessageCount: number;
  readonly commandExecutionCount: number;
  readonly fileChangeItemCount: number;
  /** The LAST completed agent_message of the turn; never the first. */
  readonly finalAgentMessage: string | null;
  readonly finalAgentMessageDigest: string | null;
  readonly usageInputTokens: number | null;
  readonly usageOutputTokens: number | null;
  readonly failureSummary: string | null;
  readonly streamDigest: string;
}

/**
 * Parse and validate one complete stdout stream.  A stream that is not a
 * single fresh thread with exactly one terminal event fails closed.
 */
export function parseExactCodexEventStreamV2(stdout: string, options: { readonly truncated?: boolean } = {}): CodexEventStreamV2 {
  if (options.truncated === true) throw new RalphM5BError("M5B_EVENT_STREAM_LIMIT", "M5B_EVENT_STREAM_LIMIT: stdout exceeded the bounded transport window");
  if (typeof stdout !== "string") throw new RalphM5BError("M5B_EVENT_STREAM_INVALID");
  if (Buffer.byteLength(stdout, "utf8") > M5B_LIMITS_V2.eventStreamMaxBytes) throw new RalphM5BError("M5B_EVENT_STREAM_LIMIT");
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new RalphM5BError("M5B_EVENT_STREAM_INVALID", "M5B_EVENT_STREAM_INVALID: empty stream");
  if (lines.length > M5B_LIMITS_V2.eventStreamMaxEvents) throw new RalphM5BError("M5B_EVENT_STREAM_LIMIT", "M5B_EVENT_STREAM_LIMIT: event count");

  let threadId: string | undefined;
  let threadStartedCount = 0;
  let turnStartedCount = 0;
  let agentMessageCount = 0;
  let commandExecutionCount = 0;
  let fileChangeItemCount = 0;
  let finalAgentMessage: string | null = null;
  let terminal: CodexTerminalKindV2 | undefined;
  let terminalIndex = -1;
  let usageInputTokens: number | null = null;
  let usageOutputTokens: number | null = null;
  let failureSummary: string | null = null;

  lines.forEach((line, index) => {
    if (Buffer.byteLength(line, "utf8") > M5B_LIMITS_V2.eventLineMaxBytes) throw new RalphM5BError("M5B_EVENT_STREAM_LIMIT", "M5B_EVENT_STREAM_LIMIT: event line");
    let parsed: unknown;
    try { parsed = JSON.parse(line); }
    catch (error) { throw new RalphM5BError("M5B_EVENT_STREAM_INVALID", "M5B_EVENT_STREAM_INVALID: malformed JSON line", error); }
    if (!isRecord(parsed)) throw new RalphM5BError("M5B_EVENT_STREAM_INVALID", "M5B_EVENT_STREAM_INVALID: event is not an object");
    const eventType = parsed.type;
    if (typeof eventType !== "string" || !(CODEX_EVENT_TYPES_V2 as readonly string[]).includes(eventType)) {
      throw new RalphM5BError("M5B_EVENT_STREAM_INVALID", "M5B_EVENT_STREAM_INVALID: unknown event type");
    }
    if (terminal !== undefined) throw new RalphM5BError("M5B_EVENT_STREAM_INVALID", "M5B_EVENT_STREAM_INVALID: event after the terminal event");

    switch (eventType as CodexEventTypeV2) {
      case "thread.started": {
        threadStartedCount += 1;
        if (threadStartedCount > 1) throw new RalphM5BError("M5B_THREAD_BINDING_INVALID", "M5B_THREAD_BINDING_INVALID: more than one thread.started");
        if (index !== 0) throw new RalphM5BError("M5B_THREAD_BINDING_INVALID", "M5B_THREAD_BINDING_INVALID: thread.started is not first");
        const candidate = parsed.thread_id;
        if (typeof candidate !== "string" || !THREAD_ID_PATTERN.test(candidate)) throw new RalphM5BError("M5B_THREAD_BINDING_INVALID", "M5B_THREAD_BINDING_INVALID: thread id shape");
        threadId = candidate;
        return;
      }
      case "turn.started":
        turnStartedCount += 1;
        if (turnStartedCount > 1) throw new RalphM5BError("M5B_EVENT_STREAM_INVALID", "M5B_EVENT_STREAM_INVALID: M5-B admits exactly one turn");
        return;
      case "item.started":
      case "item.updated":
        readItemType(parsed);
        return;
      case "item.completed": {
        const itemType = readItemType(parsed);
        if (itemType === "agent_message") {
          agentMessageCount += 1;
          // Empirical stock behaviour: a turn may complete several
          // agent_message items. The LAST completed one is the provider's
          // final message; an earlier message is never final authority.
          finalAgentMessage = boundedText(readItemString(parsed, "text"));
        }
        if (itemType === "command_execution") commandExecutionCount += 1;
        if (itemType === "file_change") fileChangeItemCount += 1;
        return;
      }
      case "turn.completed":
        terminal = "TURN_COMPLETED";
        terminalIndex = index;
        ({ usageInputTokens, usageOutputTokens } = readUsage(parsed.usage));
        return;
      case "turn.failed":
        terminal = "TURN_FAILED";
        terminalIndex = index;
        failureSummary = boundedText(readNestedString(parsed.error, "message"));
        return;
      case "error":
        terminal = "ERROR";
        terminalIndex = index;
        failureSummary = boundedText(typeof parsed.message === "string" ? parsed.message : null);
        return;
    }
  });

  if (threadStartedCount !== 1 || !threadId) throw new RalphM5BError("M5B_THREAD_BINDING_INVALID", "M5B_THREAD_BINDING_INVALID: exactly one thread.started is required");
  if (terminal === undefined || terminalIndex !== lines.length - 1) throw new RalphM5BError("M5B_TERMINAL_REQUIRED", "M5B_TERMINAL_REQUIRED: no terminal event closes the stream");

  const base = {
    threadId,
    terminal,
    eventCount: lines.length,
    turnStartedCount,
    agentMessageCount,
    commandExecutionCount,
    fileChangeItemCount,
    finalAgentMessage,
    finalAgentMessageDigest: finalAgentMessage === null ? null : sha256(finalAgentMessage),
    usageInputTokens,
    usageOutputTokens,
    failureSummary,
  };
  return Object.freeze({ ...base, streamDigest: sha256Canonical(base) });
}

function readItemType(event: Record<string, unknown>): CodexItemTypeV2 {
  const item = event.item;
  if (!isRecord(item)) throw new RalphM5BError("M5B_EVENT_STREAM_INVALID", "M5B_EVENT_STREAM_INVALID: item payload");
  // Stock 0.153.4 discriminates thread items by `item_type`; a stream that
  // carries the plain `type` discriminator instead is accepted only when the
  // two agree. Anything else is refused rather than guessed.
  const primary = item.item_type;
  const secondary = item.type;
  const candidate = typeof primary === "string" ? primary : typeof secondary === "string" ? secondary : undefined;
  if (candidate === undefined) throw new RalphM5BError("M5B_EVENT_STREAM_INVALID", "M5B_EVENT_STREAM_INVALID: item discriminator");
  if (typeof primary === "string" && typeof secondary === "string" && primary !== secondary) throw new RalphM5BError("M5B_EVENT_STREAM_INVALID", "M5B_EVENT_STREAM_INVALID: conflicting item discriminators");
  if (!(CODEX_ITEM_TYPES_V2 as readonly string[]).includes(candidate)) throw new RalphM5BError("M5B_EVENT_STREAM_INVALID", "M5B_EVENT_STREAM_INVALID: unknown item type");
  return candidate as CodexItemTypeV2;
}

function readItemString(event: Record<string, unknown>, key: string): string | null {
  const item = event.item;
  if (!isRecord(item)) return null;
  const value = item[key];
  return typeof value === "string" ? value : null;
}

function readNestedString(value: unknown, key: string): string | null {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return null;
  const nested = value[key];
  return typeof nested === "string" ? nested : null;
}

function readUsage(value: unknown): { usageInputTokens: number | null; usageOutputTokens: number | null } {
  if (!isRecord(value)) return { usageInputTokens: null, usageOutputTokens: null };
  const input = value.input_tokens;
  const output = value.output_tokens;
  return {
    usageInputTokens: Number.isSafeInteger(input) && Number(input) >= 0 ? Number(input) : null,
    usageOutputTokens: Number.isSafeInteger(output) && Number(output) >= 0 ? Number(output) : null,
  };
}

function boundedText(value: string | null): string | null {
  if (value === null) return null;
  if (value.length > M5B_LIMITS_V2.providerSummaryMaxChars) throw new RalphM5BError("M5B_PROVIDER_OUTPUT_LIMIT", "M5B_PROVIDER_OUTPUT_LIMIT: provider text");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
