import { renderHarnessMascot } from "../../../harness-mascot.js";
import { PROGRESSIVE_INIT_STAGES } from "../stages.js";
import type {
  ProgressiveCountTelemetry,
  ProgressiveInterviewOption,
  ProgressivePresentationState,
  ProgressiveStagePresentation,
} from "./presentation.js";
import {
  anchorProgressiveSelection,
  progressiveSelectedIndex,
  progressiveSelectionViewport,
  type ProgressiveSelectionState,
} from "./selection.js";
import type { ProgressiveTerminalCapabilities } from "./terminal.js";
import { progressiveTextInputView, type ProgressiveTextInputState } from "./text-input.js";
import { center, pad, truncate, visibleWidth, wrap } from "./text.js";

/**
 * Pure presentation renderer.
 *
 * It reads a prepared presentation state and terminal capabilities and returns
 * a frame. It never reaches Core, a document store, a provider, or the
 * filesystem, and it never derives a ceiling or a stage disposition.
 */

export type ProgressiveLayoutTier = "large" | "medium" | "small";

export interface ProgressiveRenderInput {
  readonly state: ProgressivePresentationState;
  readonly capabilities: ProgressiveTerminalCapabilities;
  readonly version: string;
  readonly selection?: ProgressiveSelectionState;
  readonly textInput?: ProgressiveTextInputState;
}

interface Glyphs {
  readonly topLeft: string;
  readonly topRight: string;
  readonly bottomLeft: string;
  readonly bottomRight: string;
  readonly horizontal: string;
  readonly vertical: string;
  readonly teeLeft: string;
  readonly teeRight: string;
  readonly done: string;
  readonly running: string;
  readonly pending: string;
  readonly failed: string;
  readonly stale: string;
  readonly cursor: string;
  readonly up: string;
  readonly down: string;
}

const UNICODE: Glyphs = {
  topLeft: "┌", topRight: "┐", bottomLeft: "└", bottomRight: "┘",
  horizontal: "─", vertical: "│", teeLeft: "├", teeRight: "┤",
  done: "✓", running: "●", pending: "○", failed: "✕", stale: "!",
  cursor: "❯", up: "↑", down: "↓",
};

const ASCII: Glyphs = {
  topLeft: "+", topRight: "+", bottomLeft: "+", bottomRight: "+",
  horizontal: "-", vertical: "|", teeLeft: "+", teeRight: "+",
  done: "x", running: "*", pending: "o", failed: "!", stale: "!",
  cursor: ">", up: "^", down: "v",
};

export function progressiveLayoutTier(capabilities: ProgressiveTerminalCapabilities): ProgressiveLayoutTier {
  if (capabilities.width >= 96 && capabilities.height >= 28) return "large";
  if (capabilities.width >= 64 && capabilities.height >= 18) return "medium";
  return "small";
}

function stageMark(stage: ProgressiveStagePresentation, glyphs: Glyphs): string {
  if (stage.activity === "failed") return glyphs.failed;
  if (stage.disposition === "complete-fresh") return glyphs.done;
  if (stage.disposition === "complete-stale" || stage.disposition === "reconciliation-required") return glyphs.stale;
  if (stage.activity !== "idle" && stage.activity !== "done") return glyphs.running;
  return glyphs.pending;
}

/** Disposition and activity are printed side by side; running never hides stale. */
function stageDispositionLabel(stage: ProgressiveStagePresentation): string {
  switch (stage.disposition) {
    case "complete-fresh": return "fresh";
    case "complete-stale": return "stale";
    case "reconciliation-required": return "reconciliation";
    default: return "incomplete";
  }
}

function stageActivityLabel(stage: ProgressiveStagePresentation): string | undefined {
  switch (stage.activity) {
    case "running": return "running";
    case "waiting-interview": return "interview";
    case "semantic-operation": return "semantic";
    case "transport": return "transport";
    case "recovering": return "recovering";
    case "closing": return "closing";
    case "failed": return "failed";
    case "done": return undefined;
    default: return undefined;
  }
}

function pipelineCell(stage: ProgressiveStagePresentation, index: number, glyphs: Glyphs, verbose: boolean): string {
  const code = `P${index + 1}`;
  const mark = stageMark(stage, glyphs);
  if (!verbose) return `${code} ${mark}`;
  const activity = stageActivityLabel(stage);
  const skipped = stage.skipped ? " · skipped" : "";
  const detail = activity ? ` ${activity.toUpperCase()}` : "";
  return `${code} ${mark} ${stageDispositionLabel(stage)}${detail}${skipped}`;
}

function countText(label: string, usage: ProgressiveCountTelemetry): string {
  return `${label} ${usage.used.measured ? usage.used.value : "—"}`;
}

function counterLine(state: ProgressivePresentationState, verbose: boolean): string {
  const counters = state.counters;
  const parts = verbose
    ? [
      countText("Semantic operations", counters.semanticOperations),
      countText("Transport invocations", counters.transportInvocations),
      countText("Corrective run", counters.correctiveRegenerationsRun),
      countText("Corrective slice", counters.correctiveRegenerationsSlice),
      countText("Transport retry", counters.transportRetries),
    ]
    : [
      countText("Sem ops", counters.semanticOperations),
      countText("Transport", counters.transportInvocations),
      countText("Corr", counters.correctiveRegenerationsRun),
    ];
  return parts.join(" · ");
}

/** Rendered row cost of one option at the interview width. */
export function progressiveOptionHeight(option: ProgressiveInterviewOption, width: number): number {
  const labelRows = wrap(option.label, Math.max(1, width - 4)).length;
  const detailRows = option.details.reduce((total, detail) => total + wrap(detail, Math.max(1, width - 6)).length, 0);
  return labelRows + detailRows;
}

export function progressiveOptionHeights(
  options: readonly ProgressiveInterviewOption[],
  width: number,
): readonly number[] {
  return options.map((option) => progressiveOptionHeight(option, width));
}

function questionHeader(state: ProgressivePresentationState): string {
  const interview = state.interview!;
  const stage = interview.question.stage;
  const stageIndex = stage ? PROGRESSIVE_INIT_STAGES.indexOf(stage) + 1 : undefined;
  const stagePart = stageIndex && stage
    ? `P${stageIndex}/${PROGRESSIVE_INIT_STAGES.length} · ${state.stages.find((entry) => entry.stage === stage)?.label ?? stage}`
    : "Interview";
  return `${stagePart} · Question ${interview.question.ordinal}`;
}

function interviewWorkspace(input: ProgressiveRenderInput, width: number, rows: number, glyphs: Glyphs): readonly string[] {
  const { state } = input;
  const interview = state.interview!;
  const question = interview.question;

  // Priority when rows are scarce: the input, then the question itself, then
  // the explanation and the recommendation. Clipped context is marked, never
  // dropped silently.
  const prompt = wrap(question.prompt, width);
  const explanation = question.explanation ? wrap(question.explanation, width) : [];
  const recommendation = question.recommendedLabel
    ? [
      ...wrap(`Recommended: ${question.recommendedLabel}`, width),
      ...(question.recommendedRationale
        ? wrap(`Why: ${question.recommendedRationale}`, width).map((line) => `  ${line}`)
        : []),
    ]
    : [];
  const contextTotal = 1 + prompt.length + (explanation.length ? explanation.length + 1 : 0)
    + (recommendation.length ? recommendation.length + 1 : 0) + 1;

  const unfocused = Boolean(question.options.length && input.selection && progressiveSelectedIndex(input.selection) < 0);
  const footerHint = question.options.length
    ? unfocused
      ? `${glyphs.up} ${glyphs.down} Select an option · Enter Submit · ${question.answerPrompt}`
      : `${glyphs.up} ${glyphs.down} Select · Enter Submit`
    : `Enter Submit · ${question.answerPrompt}`;
  const statusLine = interview.phase === "submitting"
    ? "Submitting to Core…"
    : interview.phase === "rejected" && interview.rejection
      ? `Rejected: ${interview.rejection}`
      : undefined;

  const heights = question.options.length && input.selection
    ? progressiveOptionHeights(question.options, width)
    : [];
  const wantedInput = heights.length
    ? Math.min(heights.reduce((total, height) => total + height, 0), 10)
    : 3;
  const minimumInput = 1;
  const minimumContext = Math.min(contextTotal, 2);
  const statusRows = statusLine ? 1 : 0;

  const spare = rows - statusRows - 1;
  let inputRows = Math.max(minimumInput, Math.min(wantedInput, spare - minimumContext));
  let contextRows = Math.max(minimumContext, spare - inputRows);
  if (contextRows + inputRows > spare) {
    contextRows = Math.max(1, spare - inputRows);
    inputRows = Math.max(minimumInput, spare - contextRows);
  }

  // Fill the context by priority: the question header, then the question, then
  // the explanation, then the recommendation. Separators are cosmetic and are
  // only inserted when the tier they precede fits whole.
  const lines: string[] = [questionHeader(state)];
  const room = (): number => Math.max(0, contextRows - lines.length);
  const addTier = (tier: readonly string[], separator: boolean): boolean => {
    if (!tier.length) return true;
    const spareRows = room();
    if (separator && spareRows > tier.length) lines.push("");
    const take = Math.min(tier.length, room());
    lines.push(...tier.slice(0, take));
    return take === tier.length;
  };
  const alternatives = question.alternatives.length
    ? ["Alternatives:", ...question.alternatives.flatMap((alternative, index) => wrap(`${index + 1}. ${alternative}`, Math.max(1, width - 2)).map((line) => `  ${line}`))]
    : [];
  const complete = [
    addTier(prompt, true),
    addTier(explanation, true),
    addTier(recommendation, true),
    addTier(alternatives, true),
  ].every(Boolean);
  if (!complete && lines.length) {
    const last = lines.length - 1;
    lines[last] = truncate(`${(lines[last] ?? "").trimEnd()} …`, width);
  }

  if (heights.length && input.selection) {
    const viewport = progressiveSelectionViewport(input.selection, heights, inputRows);
    const selected = progressiveSelectedIndex(input.selection);
    if (viewport.hiddenBefore > 0) lines.push(`${glyphs.up} ${viewport.hiddenBefore} previous`);
    for (let index = viewport.start; index < viewport.end && index < question.options.length; index += 1) {
      const option = question.options[index]!;
      const marker = index === selected ? `${glyphs.cursor} ` : "  ";
      wrap(option.label, Math.max(1, width - 4)).forEach((labelRow, rowIndex) => {
        const prefix = rowIndex === 0 ? marker : "  ";
        const suffix = rowIndex === 0 && option.recommended ? "   Recommended" : "";
        lines.push(truncate(`${prefix}${labelRow}${suffix}`, width));
      });
      for (const detail of option.details) {
        for (const detailRow of wrap(detail, Math.max(1, width - 6))) lines.push(truncate(`    ${detailRow}`, width));
      }
    }
    if (viewport.hiddenAfter > 0) lines.push(`${glyphs.down} ${viewport.hiddenAfter} more`);
  } else if (input.textInput) {
    const view = progressiveTextInputView(input.textInput, Math.max(1, width - 2), Math.max(1, inputRows));
    if (view.hiddenBefore > 0) lines.push(`${glyphs.up} ${view.hiddenBefore} more lines`);
    view.rows.forEach((textRow, index) => {
      const caret = index === view.cursorRow && interview.phase !== "submitting" ? "_" : "";
      lines.push(truncate(`${index === 0 ? "> " : "  "}${textRow}${caret}`, width));
    });
    if (view.hiddenAfter > 0) lines.push(`${glyphs.down} ${view.hiddenAfter} more lines`);
  }

  if (statusLine) lines.push(truncate(statusLine, width));
  lines.push(truncate(footerHint, width));
  return lines;
}

function closureWorkspace(state: ProgressivePresentationState, width: number, glyphs: Glyphs): readonly string[] {
  const lines: string[] = [];
  state.stages.forEach((stage, index) => {
    lines.push(`P${index + 1} ${stageMark(stage, glyphs)} ${stage.label} · ${stageDispositionLabel(stage)}${stage.skipped ? " · skipped" : ""}`);
  });
  lines.push(`Closure ${state.closure.completed ? glyphs.done : glyphs.pending}`);
  lines.push("");
  lines.push(state.ralphReady ? `RALPH READY ${glyphs.done}` : "Ralph readiness not established");
  lines.push("");
  lines.push(state.zeroWork === true
    ? "Progressive Init already complete and fresh."
    : "Progressive Init complete.");
  if (state.ralphReady) {
    lines.push("");
    // Progressive Init ends here. Ralph is never started from this dashboard.
    lines.push("Run `rb-harness --ralph` to start Ralph.");
  }
  return lines.flatMap((line) => wrap(line, width));
}

function failureWorkspace(state: ProgressivePresentationState, width: number, glyphs: Glyphs): readonly string[] {
  const lines: string[] = [`FAILED ${glyphs.failed}`, ""];
  lines.push(...wrap(state.failure ?? "Progressive Init failed", width));
  if (state.closure.failureReason) {
    lines.push("");
    lines.push(...wrap(`Closure: ${state.closure.failureReason}`, width));
  }
  const findings = state.stages.flatMap((stage) => stage.findings.map((finding) => `${stage.label}: ${finding}`));
  if (findings.length) {
    lines.push("");
    for (const finding of findings.slice(0, 6)) lines.push(...wrap(finding, width));
  }
  lines.push("");
  lines.push("Ralph is not READY. No bypass action is offered.");
  return lines;
}

function statusWorkspace(state: ProgressivePresentationState, width: number, glyphs: Glyphs, verbose: boolean): readonly string[] {
  const lines: string[] = [];
  for (const [index, stage] of state.stages.entries()) {
    const activity = stageActivityLabel(stage);
    const detail = [
      stageDispositionLabel(stage),
      ...(activity ? [activity] : []),
      ...(stage.skipped ? ["skipped"] : []),
    ].join(" · ");
    lines.push(truncate(`P${index + 1} ${stageMark(stage, glyphs)} ${stage.label} · ${detail}`, width));
    if (verbose) for (const finding of stage.findings.slice(0, 2)) lines.push(...wrap(`   ${finding}`, width));
  }
  if (state.closure.started) {
    lines.push("");
    lines.push(`Closure ${state.closure.completed ? glyphs.done : glyphs.running}`);
  }
  if (state.activityLine) {
    lines.push("");
    lines.push(...wrap(state.activityLine, width));
  }
  return lines;
}

function providerLines(state: ProgressivePresentationState, width: number): readonly string[] {
  if (!state.provider) return [];
  const provider = state.provider;
  return [
    truncate(provider.providerLabel, width),
    truncate(provider.modelLabel, width),
    // The exact registry profile id, never a label-derived reconstruction.
    truncate(provider.profileId, width),
  ];
}

export function renderProgressiveDashboard(input: ProgressiveRenderInput): string {
  const { state, capabilities } = input;
  const glyphs = capabilities.unicode ? UNICODE : ASCII;
  const tier = progressiveLayoutTier(capabilities);
  const width = capabilities.width;
  const inner = Math.max(4, width - 4);
  const height = capabilities.height;

  const row = (content: string): string => `${glyphs.vertical} ${pad(content, inner)} ${glyphs.vertical}`;
  const rule = (left: string, right: string): string => `${left}${glyphs.horizontal.repeat(Math.max(0, width - 2))}${right}`;

  const badge = state.phase === "failed" ? "FAILED"
    : state.ralphReady ? "RALPH READY"
      : state.runDisposition === "resume" ? "RESUME"
        : state.runDisposition === "fresh-run" ? "FRESH RUN" : "";
  const title = `RB Harness · Progressive Init`;
  const titleRow = badge
    ? `${title}${" ".repeat(Math.max(1, inner - visibleWidth(title) - visibleWidth(badge)))}${badge}`
    : title;

  const decorative = tier === "large" && capabilities.height >= 32;
  const mascot = decorative
    ? renderHarnessMascot("compact", { color: capabilities.color, unicode: capabilities.unicode })
      .map((line) => center(line, inner))
    : [];

  const pipelineVerbose = tier !== "small";
  const cells = state.stages.map((stage, index) => pipelineCell(stage, index, glyphs, pipelineVerbose));
  const pipelineText = cells.join("   ");
  const pipelineRows = visibleWidth(pipelineText) <= inner
    ? [pipelineText]
    : state.stages.map((stage, index) => pipelineCell(stage, index, glyphs, true));

  const header = [titleRow, ...(tier === "small" ? [] : [`v${input.version} · ${state.projectRoot}`])];
  const footer = [counterLine(state, tier !== "small")];
  const providerRows = tier === "small" || state.interview ? [] : providerLines(state, inner);

  // Fixed chrome: borders, header, separators, pipeline, footer.
  const chrome = (): number => 2 + header.length + mascot.length + 1 + pipelineRows.length + 1 + footer.length + 1;
  let mascotRows = mascot;
  let pipeline = pipelineRows;
  let headerRows = header;
  let workspaceRows = height - chrome();
  if (workspaceRows < 6 && mascotRows.length) {
    // Decoration is the first thing sacrificed; semantic content is never cut for it.
    mascotRows = [];
    workspaceRows = height - (2 + headerRows.length + 1 + pipeline.length + 1 + footer.length + 1);
  }
  if (workspaceRows < 5 && headerRows.length > 1) {
    headerRows = [titleRow];
    workspaceRows = height - (2 + headerRows.length + 1 + pipeline.length + 1 + footer.length + 1);
  }
  if (workspaceRows < 4 && pipeline.length > 1) {
    pipeline = [state.stages.map((stage, index) => pipelineCell(stage, index, glyphs, false)).join(" ")];
    workspaceRows = height - (2 + headerRows.length + 1 + pipeline.length + 1 + footer.length + 1);
  }
  workspaceRows = Math.max(3, workspaceRows);

  const workspace = state.interview
    ? interviewWorkspace(input, inner, workspaceRows, glyphs)
    : state.phase === "failed"
      ? failureWorkspace(state, inner, glyphs)
      : state.phase === "completed"
        ? closureWorkspace(state, inner, glyphs)
        : [...statusWorkspace(state, inner, glyphs, tier !== "small"), ...(providerRows.length ? ["", ...providerRows] : [])];

  const body = workspace.length > workspaceRows
    ? workspace.slice(0, workspaceRows)
    : [...workspace, ...Array.from({ length: workspaceRows - workspace.length }, () => "")];

  const lines = [
    rule(glyphs.topLeft, glyphs.topRight),
    ...headerRows.map(row),
    ...mascotRows.map(row),
    rule(glyphs.teeLeft, glyphs.teeRight),
    ...pipeline.map(row),
    rule(glyphs.teeLeft, glyphs.teeRight),
    ...body.map(row),
    rule(glyphs.teeLeft, glyphs.teeRight),
    ...footer.map(row),
    rule(glyphs.bottomLeft, glyphs.bottomRight),
  ];
  return `${lines.slice(0, Math.max(1, height)).join("\n")}\n`;
}

/** The selection anchor the next frame will use; keeps scrolling stable. */
export function progressiveInterviewAnchor(
  input: ProgressiveRenderInput,
  selection: ProgressiveSelectionState,
): ProgressiveSelectionState {
  const inner = Math.max(4, input.capabilities.width - 4);
  const heights = progressiveOptionHeights(selection.options, inner);
  const rows = Math.max(1, input.capabilities.height - 12);
  return anchorProgressiveSelection(selection, progressiveSelectionViewport(selection, heights, rows));
}
