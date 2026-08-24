/**
 * Accounting for a provider's output stream (CR-003).
 *
 * Two things must be separated. A *controlled* adapter emits a machine-readable
 * event stream the Harness can count against the documentation budget. An
 * *opaque* adapter emits prose, and no amount of parsing turns that into
 * telemetry — so it is governed by time, volume, and progress instead, and is
 * reported as unmeasured rather than pretend-controlled.
 *
 * Progress is the subtle one: a stalled agent can emit megabytes of identical
 * chatter. Repeated content therefore does not renew the progress window; only
 * genuinely new content or a significant event does.
 */

import { createHash } from "node:crypto";
import { HARNESS_BUDGET } from "./harness-budget.js";

export type StreamMode = "structured" | "opaque";

/**
 * How to read a structured stream. `generic` inspects an unknown event
 * structurally; `opencode` follows the schema of the installed OpenCode CLI,
 * whose events are `{ type, properties }` and whose tool work arrives as
 * repeated `message.part.updated` events for one `part.callID`.
 */
export type StreamDialect = "generic" | "opencode";

export interface StreamAccounting {
  mode: StreamMode;
  /** Structured events successfully parsed. */
  events: number;
  /** Events classified as a tool invocation. */
  toolEvents: number;
  /** Events classified as a model turn or step. */
  turnEvents: number;
  /** Lines that were not JSON objects, kept as plain text. */
  unstructuredLines: number;
  /**
   * True when structured mode was requested but the stream carried no parsable
   * event at all. The axis is then declared unmeasured, never silently claimed.
   */
  degraded: boolean;
}

export interface StreamLimitBreach {
  code: "tool-budget" | "turn-budget" | "malformed-event" | "no-progress";
  message: string;
}

/** Field names that mark a tool invocation across the common event dialects. */
const TOOL_HINT = /(?:^|[._-])tool(?:[._-]|$)/i;
/** Field names that mark a model turn, step, or message boundary. */
const TURN_HINT = /(?:^|[._-])(?:turn|step|message|assistant|response|completion)(?:[._-]|$)/i;

function discriminator(event: Record<string, unknown>): string {
  for (const key of ["type", "event", "kind", "name", "role"]) {
    const value = event[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * Collect every string leaf of an event, in order. The Harness does not own a
 * provider's event schema, so the final envelope is recovered structurally
 * instead of from an assumed field path.
 */
export function collectEventText(value: unknown, into: string[] = [], depth = 0): string[] {
  if (depth > 12) return into;
  if (typeof value === "string") {
    if (value) into.push(value);
    return into;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectEventText(entry, into, depth + 1);
    return into;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) collectEventText(entry, into, depth + 1);
  }
  return into;
}

export interface StreamObserverOptions {
  mode: StreamMode;
  dialect?: StreamDialect;
  /** Turn/tool ceilings; only meaningful for a controlled adapter. */
  maxToolEvents?: number;
  maxTurnEvents?: number;
  /** Window after which output that carries nothing new ends the run. */
  noProgressMilliseconds?: number;
}

/**
 * Line-oriented observer over a provider's stdout.
 *
 * `push` returns a breach when a documented limit is crossed. It never mutates
 * or hides the raw text: the caller keeps the complete transcript for the
 * envelope and the log.
 */
export class ProviderStreamObserver {
  private readonly options: Required<StreamObserverOptions>;
  /** Distinct tool invocations seen, keyed by the provider's own call ID. */
  private readonly toolCallIds = new Set<string>();
  private buffer = "";
  private readonly seen = new Set<string>();
  private lastProgressAt = Date.now();
  private readonly accounting: StreamAccounting;
  /** Plain-text projection used to recover the final envelope. */
  private text = "";

  constructor(options: StreamObserverOptions) {
    this.options = {
      mode: options.mode,
      dialect: options.dialect ?? "generic",
      maxToolEvents: options.maxToolEvents ?? HARNESS_BUDGET.tools.maxCalls,
      maxTurnEvents: options.maxTurnEvents ?? HARNESS_BUDGET.stream.maxTurnEvents,
      noProgressMilliseconds: options.noProgressMilliseconds ?? HARNESS_BUDGET.stream.noProgressMilliseconds,
    };
    this.accounting = {
      mode: options.mode,
      events: 0,
      toolEvents: 0,
      turnEvents: 0,
      unstructuredLines: 0,
      degraded: false,
    };
  }

  /** Text recovered from the stream, for envelope extraction. */
  recoveredText(): string {
    return this.text;
  }

  report(): StreamAccounting {
    return {
      ...this.accounting,
      degraded: this.accounting.mode === "structured" && this.accounting.events === 0 && this.accounting.unstructuredLines > 0,
    };
  }

  /**
   * Renew the progress window from a real remote event observed outside the
   * stdout stream — an activity marker from the direct-API runtime. A
   * keep-alive comment never reaches here, so an idle socket cannot renew it.
   */
  noteActivity(): void {
    this.lastProgressAt = Date.now();
  }

  /** Whether the progress window has elapsed with nothing new in it. */
  stalled(now = Date.now()): boolean {
    return this.options.noProgressMilliseconds > 0
      && now - this.lastProgressAt > this.options.noProgressMilliseconds;
  }

  push(chunk: string): StreamLimitBreach | undefined {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      const breach = this.line(line);
      if (breach) return breach;
      newlineIndex = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > 1024 * 1024) {
      // A single unterminated line is still content; keep it and reset the
      // buffer so memory stays bounded.
      this.text += this.buffer;
      this.buffer = "";
    }
    return undefined;
  }

  /**
   * Flush a trailing line that never got its newline.
   *
   * A stream can be truncated exactly at EOF — a killed provider, a closed
   * pipe — leaving a half-written event with no terminator. That is a protocol
   * failure like any other malformed event, so `end` returns the breach and the
   * caller must act on it instead of silently accepting a partial stream.
   */
  end(): StreamLimitBreach | undefined {
    if (!this.buffer) return undefined;
    const trailing = this.buffer;
    this.buffer = "";
    return this.line(trailing);
  }

  /**
   * OpenCode 1.18.x: `{ type: "<event>", properties: { ... } }`. A tool part is
   * re-emitted as its state moves pending → running → completed, so counting
   * events would count one invocation several times; the provider's own
   * `callID` is what identifies the invocation. A `step-start` part marks a
   * model turn.
   */
  private classifyOpenCode(record: Record<string, unknown>): boolean {
    const type = typeof record.type === "string" ? record.type : "";
    const properties = record.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) return false;
    const part = (properties as Record<string, unknown>).part;
    if (type !== "message.part.updated" || !part || typeof part !== "object" || Array.isArray(part)) {
      // `session.idle` and `message.updated` are real progress boundaries.
      return type === "session.idle" || type === "message.updated";
    }
    const partRecord = part as Record<string, unknown>;
    const partType = typeof partRecord.type === "string" ? partRecord.type : "";
    if (partType === "tool") {
      const callId = typeof partRecord.callID === "string" && partRecord.callID
        ? partRecord.callID
        : typeof partRecord.id === "string" ? partRecord.id : "";
      if (!callId) return false;
      if (this.toolCallIds.has(callId)) return false;
      this.toolCallIds.add(callId);
      this.accounting.toolEvents += 1;
      return true;
    }
    if (partType === "step-start") {
      this.accounting.turnEvents += 1;
      return true;
    }
    return partType === "text";
  }

  /** Structural classification for an unknown event dialect. */
  private classifyGeneric(record: Record<string, unknown>): boolean {
    const marker = discriminator(record);
    if (TOOL_HINT.test(marker) || TOOL_HINT.test(Object.keys(record).join(" "))) {
      // Without a schema there is no call ID to group by, so an identifier is
      // used when the event offers one and the event itself otherwise.
      const identity = ["callID", "callId", "tool_call_id", "id"]
        .map((key) => record[key])
        .find((value): value is string => typeof value === "string" && Boolean(value));
      if (identity) {
        if (this.toolCallIds.has(identity)) return false;
        this.toolCallIds.add(identity);
      }
      this.accounting.toolEvents += 1;
      return true;
    }
    if (TURN_HINT.test(marker)) {
      this.accounting.turnEvents += 1;
      return true;
    }
    return false;
  }

  private line(raw: string): StreamLimitBreach | undefined {
    const line = raw.replace(/\r$/, "");
    const trimmed = line.trim();
    if (!trimmed) return undefined;

    let significant = false;
    if (this.options.mode === "structured" && trimmed.startsWith("{")) {
      let event: unknown;
      try {
        event = JSON.parse(trimmed);
      } catch {
        // A line that opens as a structured event and does not parse is a
        // protocol violation, not prose. Failing here is the point: silently
        // ignoring it would hide a broken or truncated stream.
        return {
          code: "malformed-event",
          message: `the provider emitted a malformed structured event: ${trimmed.slice(0, 200)}`,
        };
      }
      if (event && typeof event === "object" && !Array.isArray(event)) {
        const record = event as Record<string, unknown>;
        this.accounting.events += 1;
        significant = this.options.dialect === "opencode"
          ? this.classifyOpenCode(record)
          : this.classifyGeneric(record);
        // Leaves of one event are joined without a separator: an envelope
        // split across fields must not gain a newline inside a JSON string.
        // Events are separated by one newline so line-oriented output stays
        // readable.
        const leaves = collectEventText(record);
        if (leaves.length) this.text += `${leaves.join("")}\n`;
        if (this.accounting.toolEvents > this.options.maxToolEvents) {
          return {
            code: "tool-budget",
            message: `provider exceeded the documentation tool budget of ${this.options.maxToolEvents} tool events`,
          };
        }
        if (this.accounting.turnEvents > this.options.maxTurnEvents) {
          return {
            code: "turn-budget",
            message: `provider exceeded the documentation turn budget of ${this.options.maxTurnEvents} turns`,
          };
        }
      }
    } else {
      this.accounting.unstructuredLines += 1;
      this.text += `${line}\n`;
    }

    // Only genuinely new content renews the progress window. Repeating the same
    // line forever is activity, not progress.
    const fingerprint = createHash("sha256").update(trimmed).digest("hex").slice(0, 16);
    if (significant || !this.seen.has(fingerprint)) {
      this.lastProgressAt = Date.now();
      if (this.seen.size < HARNESS_BUDGET.stream.progressFingerprints) this.seen.add(fingerprint);
    }
    return undefined;
  }
}
