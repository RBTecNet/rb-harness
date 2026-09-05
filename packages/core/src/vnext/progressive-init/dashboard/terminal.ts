/**
 * Terminal abstraction for the Progressive Dashboard.
 *
 * The interactive surface is created only for a dual-TTY session. Every escape
 * sequence, raw-mode toggle and listener registration happens here so that
 * restoration is centralized and idempotent, and so a renderer or an interview
 * controller never owns process lifetime.
 */

export interface ProgressiveTerminalInput {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  resume?(): unknown;
  pause?(): unknown;
  setEncoding?(encoding: "utf8"): unknown;
  on(event: "data", listener: (chunk: string | Buffer) => void): unknown;
  off?(event: "data", listener: (chunk: string | Buffer) => void): unknown;
  removeListener?(event: "data", listener: (chunk: string | Buffer) => void): unknown;
}

export interface ProgressiveTerminalOutput {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
  write(value: string): unknown;
  on?(event: "resize", listener: () => void): unknown;
  off?(event: "resize", listener: () => void): unknown;
  removeListener?(event: "resize", listener: () => void): unknown;
}

export interface ProgressiveTerminalCapabilities {
  readonly width: number;
  readonly height: number;
  readonly color: boolean;
  readonly unicode: boolean;
  /** 24-bit paint. Absent means the renderer keeps the basic ANSI palette. */
  readonly trueColor?: boolean;
}

export type ProgressiveKeyName =
  | "up" | "down" | "left" | "right"
  | "home" | "end" | "pageup" | "pagedown"
  | "enter" | "backspace" | "delete" | "tab" | "escape"
  | "interrupt" | "eof"
  | "character";

export interface ProgressiveKey {
  readonly name: ProgressiveKeyName;
  /** Present only for `character`; always a single printable grapheme run. */
  readonly value?: string;
}

export interface ProgressiveTerminal {
  readonly interactive: boolean;
  capabilities(): ProgressiveTerminalCapabilities;
  /** Replace the visible frame. No scrollback console is ever accumulated. */
  frame(content: string): void;
  onKey(listener: (key: ProgressiveKey) => void): void;
  onResize(listener: () => void): void;
  /** Idempotent: restores cursor, raw mode, encoding and every listener once. */
  close(): void;
}

export interface ProgressiveTerminalOptions {
  readonly input: ProgressiveTerminalInput;
  readonly output: ProgressiveTerminalOutput;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly defaultWidth?: number;
  readonly defaultHeight?: number;
}

const ESC = "\u001b";
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const RESET_STYLE = `${ESC}[0m`;
const CLEAR_HOME = `${ESC}[2J${ESC}[H`;

const SEQUENCES: Readonly<Record<string, ProgressiveKeyName>> = {
  [`${ESC}[A`]: "up",
  [`${ESC}OA`]: "up",
  [`${ESC}[B`]: "down",
  [`${ESC}OB`]: "down",
  [`${ESC}[C`]: "right",
  [`${ESC}OC`]: "right",
  [`${ESC}[D`]: "left",
  [`${ESC}OD`]: "left",
  [`${ESC}[H`]: "home",
  [`${ESC}OH`]: "home",
  [`${ESC}[1~`]: "home",
  [`${ESC}[7~`]: "home",
  [`${ESC}[F`]: "end",
  [`${ESC}OF`]: "end",
  [`${ESC}[4~`]: "end",
  [`${ESC}[8~`]: "end",
  [`${ESC}[5~`]: "pageup",
  [`${ESC}[6~`]: "pagedown",
  [`${ESC}[3~`]: "delete",
};

/**
 * Decode one input chunk into logical keys. Unknown escape sequences are
 * dropped rather than leaked into a text buffer as stray printable bytes.
 */
export function decodeProgressiveKeys(chunk: string): readonly ProgressiveKey[] {
  const keys: ProgressiveKey[] = [];
  let index = 0;
  while (index < chunk.length) {
    const character = chunk[index]!;
    if (character === ESC) {
      const matched = Object.keys(SEQUENCES)
        .filter((sequence) => chunk.startsWith(sequence, index))
        .sort((left, right) => right.length - left.length)[0];
      if (matched) {
        keys.push({ name: SEQUENCES[matched]! });
        index += matched.length;
        continue;
      }
      const csi = /^\u001b(?:\[[0-?]*[ -/]*[@-~]|O.)/.exec(chunk.slice(index));
      if (csi) {
        index += csi[0].length;
        continue;
      }
      keys.push({ name: "escape" });
      index += 1;
      continue;
    }
    if (character === "\r" || character === "\n") {
      keys.push({ name: "enter" });
      index += 1;
      continue;
    }
    if (character === "\u0003") {
      keys.push({ name: "interrupt" });
      index += 1;
      continue;
    }
    if (character === "\u0004") {
      keys.push({ name: "eof" });
      index += 1;
      continue;
    }
    if (character === "\u007f" || character === "\b") {
      keys.push({ name: "backspace" });
      index += 1;
      continue;
    }
    if (character === "\t") {
      keys.push({ name: "tab" });
      index += 1;
      continue;
    }
    if (character < " ") {
      index += 1;
      continue;
    }
    const codePoint = chunk.codePointAt(index)!;
    const value = String.fromCodePoint(codePoint);
    keys.push({ name: "character", value });
    index += value.length;
  }
  return keys;
}

function detachData(input: ProgressiveTerminalInput, listener: (chunk: string | Buffer) => void): void {
  if (typeof input.off === "function") input.off("data", listener);
  else if (typeof input.removeListener === "function") input.removeListener("data", listener);
}

function detachResize(output: ProgressiveTerminalOutput, listener: () => void): void {
  if (typeof output.off === "function") output.off("resize", listener);
  else if (typeof output.removeListener === "function") output.removeListener("resize", listener);
}

export function progressiveTerminalIsInteractive(
  input: ProgressiveTerminalInput,
  output: ProgressiveTerminalOutput,
): boolean {
  return Boolean(input.isTTY) && Boolean(output.isTTY);
}

export function createProgressiveTerminal(options: ProgressiveTerminalOptions): ProgressiveTerminal {
  const { input, output } = options;
  const env = options.env ?? {};
  const interactive = progressiveTerminalIsInteractive(input, output);
  const keyListeners: ((key: ProgressiveKey) => void)[] = [];
  const resizeListeners: (() => void)[] = [];
  let closed = false;
  let opened = false;

  const safeWrite = (value: string): void => {
    // Presentation must never fail semantic execution.
    try { output.write(value); } catch { /* cosmetic */ }
  };

  const onData = (chunk: string | Buffer): void => {
    if (closed) return;
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (const key of decodeProgressiveKeys(text)) {
      for (const listener of [...keyListeners]) {
        try { listener(key); } catch { /* an input observer never breaks the terminal */ }
      }
    }
  };

  const onResize = (): void => {
    if (closed) return;
    for (const listener of [...resizeListeners]) {
      try { listener(); } catch { /* a resize observer never breaks the terminal */ }
    }
  };

  if (interactive) {
    opened = true;
    try { input.setRawMode?.(true); } catch { /* a terminal without raw mode still renders */ }
    try { input.setEncoding?.("utf8"); } catch { /* default decoding is acceptable */ }
    try { input.resume?.(); } catch { /* already flowing */ }
    input.on("data", onData);
    output.on?.("resize", onResize);
    safeWrite(HIDE_CURSOR);
  }

  return {
    interactive,
    capabilities(): ProgressiveTerminalCapabilities {
      return {
        width: Math.max(20, Math.floor(output.columns || options.defaultWidth || 92)),
        height: Math.max(8, Math.floor(output.rows || options.defaultHeight || 32)),
        color: !("NO_COLOR" in env) && env.TERM !== "dumb",
        unicode: env.TERM !== "dumb",
        trueColor: !("NO_COLOR" in env) && /truecolor|24bit/i.test(env.COLORTERM ?? ""),
      };
    },
    frame(content: string): void {
      if (!interactive || closed) return;
      safeWrite(`${CLEAR_HOME}${content}`);
    },
    onKey(listener): void {
      keyListeners.push(listener);
    },
    onResize(listener): void {
      resizeListeners.push(listener);
    },
    close(): void {
      if (closed) return;
      closed = true;
      keyListeners.length = 0;
      resizeListeners.length = 0;
      if (!opened) return;
      detachData(input, onData);
      detachResize(output, onResize);
      try { input.setRawMode?.(false); } catch { /* already restored */ }
      try { input.pause?.(); } catch { /* already paused */ }
      safeWrite(`${RESET_STYLE}${SHOW_CURSOR}`);
    },
  };
}
