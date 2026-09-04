import type { ProgressiveKey } from "./terminal.js";
import { wrapVerbatim } from "./text.js";

/**
 * Open-answer editing.
 *
 * A large wrapped field, not a single terminal line: the buffer grows and the
 * view scrolls, so a long answer is never silently truncated. Enter submits;
 * no cross-terminal multiline chord is claimed. Blank stays blank — the
 * `blank → recommended answer` contract belongs to Core, never to this editor.
 */

export interface ProgressiveTextInputState {
  readonly value: string;
  readonly cursor: number;
}

export const EMPTY_TEXT_INPUT: ProgressiveTextInputState = { value: "", cursor: 0 };

export function createProgressiveTextInput(value = ""): ProgressiveTextInputState {
  return { value, cursor: [...value].length };
}

function characters(value: string): readonly string[] {
  return [...value];
}

function rebuild(units: readonly string[]): string {
  return units.join("");
}

/** Editing only. Enter, interrupt and eof are lifecycle keys handled by the controller. */
export function applyProgressiveTextKey(
  state: ProgressiveTextInputState,
  key: ProgressiveKey,
): ProgressiveTextInputState {
  const units = characters(state.value);
  const cursor = Math.min(units.length, Math.max(0, state.cursor));
  switch (key.name) {
    case "character": {
      if (!key.value) return state;
      const next = [...units.slice(0, cursor), key.value, ...units.slice(cursor)];
      return { value: rebuild(next), cursor: cursor + 1 };
    }
    case "backspace": {
      if (cursor === 0) return state;
      const next = [...units.slice(0, cursor - 1), ...units.slice(cursor)];
      return { value: rebuild(next), cursor: cursor - 1 };
    }
    case "delete": {
      if (cursor >= units.length) return state;
      const next = [...units.slice(0, cursor), ...units.slice(cursor + 1)];
      return { value: rebuild(next), cursor };
    }
    case "left":
      return cursor === 0 ? state : { ...state, cursor: cursor - 1 };
    case "right":
      return cursor >= units.length ? state : { ...state, cursor: cursor + 1 };
    case "home":
      return cursor === 0 ? state : { ...state, cursor: 0 };
    case "end":
      return cursor === units.length ? state : { ...state, cursor: units.length };
    default:
      return state;
  }
}

export interface ProgressiveTextInputView {
  readonly rows: readonly string[];
  readonly cursorRow: number;
  readonly cursorColumn: number;
  readonly offset: number;
  readonly hiddenBefore: number;
  readonly hiddenAfter: number;
}

/**
 * Wrap the buffer to `width` and scroll the view so the caret stays visible.
 * Terminal geometry is derived here and never stored as semantic state.
 */
export function progressiveTextInputView(
  state: ProgressiveTextInputState,
  width: number,
  rows: number,
): ProgressiveTextInputView {
  const columns = Math.max(1, Math.floor(width));
  const height = Math.max(1, Math.floor(rows));
  const units = characters(state.value);
  const cursor = Math.min(units.length, Math.max(0, state.cursor));
  const wrapped = wrapVerbatim(state.value, columns);
  const before = rebuild(units.slice(0, cursor));
  const beforeRows = wrapVerbatim(before, columns);
  const cursorRow = Math.min(wrapped.length - 1, beforeRows.length - 1);
  const cursorColumn = characters(beforeRows[beforeRows.length - 1] ?? "").length;
  const offset = Math.max(0, Math.min(wrapped.length - height, cursorRow - height + 1));
  const start = Math.max(0, offset);
  const visible = wrapped.slice(start, start + height);
  return {
    rows: visible,
    cursorRow: cursorRow - start,
    cursorColumn,
    offset: start,
    hiddenBefore: start,
    hiddenAfter: Math.max(0, wrapped.length - start - visible.length),
  };
}
