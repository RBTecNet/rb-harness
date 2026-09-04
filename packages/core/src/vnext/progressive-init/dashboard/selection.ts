import type { ProgressiveInterviewOption } from "./presentation.js";

/**
 * Closed-option navigation.
 *
 * Selection and scrolling are expressed in logical options, never in terminal
 * rows: one `↓` always advances exactly one option even when that option wraps
 * over several visual rows, and a resize keeps the same selected option.
 *
 * When Core marks no option as recommended it has refused to recommend one —
 * the frozen `blank is not accepted` questions — so nothing is focused and a
 * bare Enter cannot select anything.
 */

export interface ProgressiveSelectionState {
  readonly options: readonly ProgressiveInterviewOption[];
  /** Empty when nothing is focused; never a terminal row index. */
  readonly selectedId: string;
  /** Topmost visible option; identity so a resize cannot scroll the list. */
  readonly anchorId: string;
  /** UI-only: whether the developer moved off the Core-focused option. */
  readonly moved: boolean;
}

export type ProgressiveSelectionMove = "up" | "down" | "home" | "end" | "pageup" | "pagedown";

export interface ProgressiveSelectionViewport {
  readonly start: number;
  readonly end: number;
  readonly hiddenBefore: number;
  readonly hiddenAfter: number;
}

/** The Core recommendation is focused when it maps unambiguously to one option. */
export function createProgressiveSelectionState(
  options: readonly ProgressiveInterviewOption[],
): ProgressiveSelectionState {
  const recommended = options.filter((option) => option.recommended);
  const selectedId = recommended.length === 1 ? recommended[0]!.id : "";
  return { options, selectedId, anchorId: options[0]?.id ?? "", moved: false };
}

/** `-1` when Core refused to recommend and the developer has not chosen yet. */
export function progressiveSelectedIndex(state: ProgressiveSelectionState): number {
  return state.selectedId ? state.options.findIndex((option) => option.id === state.selectedId) : -1;
}

export function progressiveSelectedOption(
  state: ProgressiveSelectionState,
): ProgressiveInterviewOption | undefined {
  const index = progressiveSelectedIndex(state);
  return index >= 0 ? state.options[index] : undefined;
}

/** True while the focused option is still exactly the one Core recommended. */
export function progressiveSelectionIsCoreRecommendation(state: ProgressiveSelectionState): boolean {
  if (state.moved) return false;
  const selected = progressiveSelectedOption(state);
  return Boolean(selected?.recommended);
}

export function moveProgressiveSelection(
  state: ProgressiveSelectionState,
  move: ProgressiveSelectionMove,
  pageSize = 1,
): ProgressiveSelectionState {
  if (!state.options.length) return state;
  const last = state.options.length - 1;
  const current = progressiveSelectedIndex(state);
  const page = Math.max(1, Math.floor(pageSize));
  if (current < 0) {
    // The first movement on an unfocused list lands on an end, never silently
    // on whatever happens to be first when the developer pressed `end`.
    const entry = move === "end" || move === "pagedown" ? last : 0;
    return { ...state, selectedId: state.options[entry]!.id, moved: true };
  }
  const next = move === "up" ? current - 1
    : move === "down" ? current + 1
      : move === "home" ? 0
        : move === "end" ? last
          : move === "pageup" ? current - page
            : current + page;
  const clamped = Math.min(last, Math.max(0, next));
  if (clamped === current) return state;
  return { ...state, selectedId: state.options[clamped]!.id, moved: true };
}

/**
 * The window of logical options that fits `rows`, always containing the
 * selection. `heights` is the rendered row cost of each option at the current
 * width; scrolling never splits an option across the window boundary unless it
 * alone exceeds the available rows.
 */
export function progressiveSelectionViewport(
  state: ProgressiveSelectionState,
  heights: readonly number[],
  rows: number,
): ProgressiveSelectionViewport {
  const total = state.options.length;
  if (!total) return { start: 0, end: 0, hiddenBefore: 0, hiddenAfter: 0 };
  const available = Math.max(1, Math.floor(rows));
  const selected = Math.max(0, progressiveSelectedIndex(state));
  const anchorIndex = state.options.findIndex((option) => option.id === state.anchorId);
  let start = Math.min(Math.max(0, anchorIndex < 0 ? 0 : anchorIndex), selected);

  const spans = (from: number): number => {
    let used = 0;
    let index = from;
    while (index < total) {
      const cost = Math.max(1, heights[index] ?? 1);
      if (used + cost > available && index > from) break;
      used += cost;
      index += 1;
    }
    return index;
  };

  let end = spans(start);
  while (end <= selected && start < selected) {
    start += 1;
    end = spans(start);
  }
  const bounded = Math.max(end, selected + 1);
  return {
    start,
    end: bounded,
    hiddenBefore: start,
    hiddenAfter: Math.max(0, total - bounded),
  };
}

/** Persist the viewport the renderer will use so scrolling is stable across frames. */
export function anchorProgressiveSelection(
  state: ProgressiveSelectionState,
  viewport: ProgressiveSelectionViewport,
): ProgressiveSelectionState {
  const anchor = state.options[viewport.start];
  return anchor && anchor.id !== state.anchorId ? { ...state, anchorId: anchor.id } : state;
}
