import type { ProgressiveInterviewOption } from "./presentation.js";
import {
  createProgressiveSelectionState,
  moveProgressiveSelection,
  progressiveSelectedIndex,
  progressiveSelectedOption,
  type ProgressiveSelectionState,
} from "./selection.js";
import type { ProgressiveTerminal, ProgressiveTerminalCapabilities } from "./terminal.js";
import { pad, truncate, wrap } from "./text.js";

/**
 * A bounded closed-option confirmation rendered with the Dashboard's own
 * selection model, so arrow navigation behaves identically everywhere. It is a
 * presentation surface only: the decision it returns is acted on by Core.
 */

export interface ProgressiveConfirmationOptions {
  readonly title: string;
  readonly body: readonly string[];
  readonly question: string;
  readonly options: readonly ProgressiveInterviewOption[];
}

export function renderProgressiveConfirmation(
  request: ProgressiveConfirmationOptions,
  selection: ProgressiveSelectionState,
  capabilities: ProgressiveTerminalCapabilities,
): string {
  const glyph = capabilities.unicode
    ? { cursor: "❯", vertical: "│", horizontal: "─", topLeft: "┌", topRight: "┐", bottomLeft: "└", bottomRight: "┘", up: "↑", down: "↓" }
    : { cursor: ">", vertical: "|", horizontal: "-", topLeft: "+", topRight: "+", bottomLeft: "+", bottomRight: "+", up: "^", down: "v" };
  const width = capabilities.width;
  const inner = Math.max(4, width - 4);
  const row = (content: string): string => `${glyph.vertical} ${pad(content, inner)} ${glyph.vertical}`;
  const rule = (left: string, right: string): string => `${left}${glyph.horizontal.repeat(Math.max(0, width - 2))}${right}`;
  const selected = progressiveSelectedIndex(selection);
  const lines = [
    rule(glyph.topLeft, glyph.topRight),
    row(truncate(request.title, inner)),
    row(""),
    ...request.body.flatMap((paragraph) => [...wrap(paragraph, inner).map(row), row("")]),
    ...wrap(request.question, inner).map(row),
    row(""),
    ...selection.options.map((option, index) => row(truncate(
      `${index === selected ? `${glyph.cursor} ` : "  "}${option.label}${option.recommended ? "     Recommended" : ""}`,
      inner,
    ))),
    row(""),
    row(`${glyph.up} ${glyph.down} Select · Enter Confirm`),
    rule(glyph.bottomLeft, glyph.bottomRight),
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Present the confirmation and resolve with the selected option id. The caller
 * owns the terminal lifetime; this never closes it and never exits.
 */
export function askProgressiveConfirmation(
  terminal: ProgressiveTerminal,
  request: ProgressiveConfirmationOptions,
): Promise<string> {
  if (!terminal.interactive) {
    return Promise.reject(new Error("PROGRESSIVE_CONFIRMATION_REQUIRES_TTY: interactive confirmation is unavailable"));
  }
  let selection = createProgressiveSelectionState(request.options);
  const draw = (): void => terminal.frame(renderProgressiveConfirmation(request, selection, terminal.capabilities()));
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    terminal.onResize(() => {
      if (!settled) draw();
    });
    terminal.onKey((key) => {
      if (settled) return;
      if (key.name === "interrupt" || key.name === "eof") {
        settled = true;
        reject(new Error("PROGRESSIVE_CONFIRMATION_CANCELLED: no decision was taken"));
        return;
      }
      if (key.name === "enter") {
        const chosen = progressiveSelectedOption(selection);
        // A confirmation with no focused option cannot be answered by Enter.
        if (!chosen) return;
        settled = true;
        resolve(chosen.id);
        return;
      }
      const move = key.name === "up" ? "up"
        : key.name === "down" ? "down"
          : key.name === "home" ? "home"
            : key.name === "end" ? "end" : undefined;
      if (!move) return;
      const next = moveProgressiveSelection(selection, move);
      if (next === selection) return;
      selection = next;
      draw();
    });
    draw();
  });
}

/** The already-Ralph-READY reinitialization confirmation. `No` is recommended. */
export const PROGRESSIVE_REINIT_CONFIRMATION_OPTIONS: readonly ProgressiveInterviewOption[] = [
  { id: "no", label: "No", details: [], recommended: true },
  { id: "yes", label: "Yes", details: [], recommended: false },
];

export function progressiveReinitConfirmationRequest(projectRoot: string): ProgressiveConfirmationOptions {
  return {
    title: "RB Harness · Progressive Init",
    body: [
      "This project is already Ralph READY.",
      "Starting a new Progressive Init will permanently remove the existing RB Harness Init artifacts and start again from P1.",
      projectRoot,
    ],
    question: "Do you want to continue?",
    options: PROGRESSIVE_REINIT_CONFIRMATION_OPTIONS,
  };
}
