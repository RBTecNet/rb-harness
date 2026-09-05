import { harnessMascotDimensions, renderHarnessMascot } from "../../../harness-mascot.js";
import { PROGRESSIVE_INIT_STAGES } from "../stages.js";
import type {
  ProgressiveCountTelemetry,
  ProgressiveInterviewOption,
  ProgressivePresentationState,
  ProgressiveRunPhase,
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
 *
 * The composition is the canonical RB Harness control-plane face: wordmark and
 * capybara, a summary grid, a pipeline rail beside the current provider,
 * telemetry cells, and one workspace panel. Chrome is decoration and is given
 * up in a fixed order whenever the workspace needs the rows, so an interview
 * always wins over the frame drawn around it.
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
  readonly done: string;
  readonly running: string;
  readonly pending: string;
  readonly failed: string;
  readonly stale: string;
  readonly cursor: string;
  readonly up: string;
  readonly down: string;
  readonly project: string;
  readonly workflow: string;
  readonly stage: string;
  readonly status: string;
  readonly progress: string;
  readonly semantic: string;
  readonly invocations: string;
  readonly corrections: string;
  readonly retries: string;
  readonly plug: string;
  readonly dash: string;
  readonly rule: string;
  readonly separator: string;
}

const UNICODE: Glyphs = {
  topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯",
  horizontal: "─", vertical: "│",
  done: "✓", running: "●", pending: "○", failed: "✕", stale: "!",
  cursor: "❯", up: "↑", down: "↓",
  project: "▤", workflow: "◈", stage: "▸", status: "●", progress: "◷",
  semantic: "◇", invocations: "↯", corrections: "↺", retries: "◌",
  plug: "◉", dash: "╌", rule: "─", separator: "┊",
};

const ASCII: Glyphs = {
  topLeft: "+", topRight: "+", bottomLeft: "+", bottomRight: "+",
  horizontal: "-", vertical: "|",
  done: "x", running: "*", pending: "o", failed: "!", stale: "!",
  cursor: ">", up: "^", down: "v",
  project: "#", workflow: "%", stage: ">", status: "*", progress: "@",
  semantic: "&", invocations: "!", corrections: "~", retries: "o",
  plug: "+", dash: "-", rule: "-", separator: ":",
};

type Tone =
  | "border" | "heading" | "label" | "value" | "muted" | "subtle"
  | "running" | "success" | "failed" | "accent";

/** Reference control-plane palette: cyan chrome, amber/green state, slate text. */
const TONE_RGB: Readonly<Record<Tone, string>> = {
  border: "21;110;133",
  heading: "45;212;238",
  label: "56;189;224",
  value: "226;232;240",
  muted: "100;116;139",
  subtle: "148;163;184",
  running: "251;191;36",
  success: "45;200;105",
  failed: "248;113;113",
  accent: "236;72;153",
};

const TONE_BASIC: Readonly<Record<Tone, string>> = {
  border: "[36m",
  heading: "[36m",
  label: "[36m",
  value: "[37m",
  muted: "[90m",
  subtle: "[90m",
  running: "[33m",
  success: "[32m",
  failed: "[31m",
  accent: "[35m",
};

const BOLD = "[1m";
const RESET = "[0m";

const HEADER_SUBTITLE = "INIT · PROGRESSIVO · HARNESS CONTROL PLANE";
const HEADER_TAGLINE = "HARNESS · capivara documentadora";
const HEADER_MARGIN = 2;
const PIPELINE_NOTE = "Somente metadados operacionais seguros; o painel observa e nunca decide.";
const FOOTER_HINT = "Ctrl-C interrompe com estado retomável · segredos nunca entram neste painel";

/**
 * Two-row solid half-block display face: the same letterforms the splash
 * wordmark uses, so the two surfaces carry one brand.
 *
 * Full blocks carry every stroke and ▀/▄ only closes a counter, which reads as a
 * single heavy weight instead of the thin outline a 3 × 4 cell produced. Two
 * rows also keep the header short enough to survive a 24-row terminal.
 */
const WORDMARK_GLYPHS: Readonly<Record<string, readonly [string, string]>> = {
  R: ["█▀█", "█▀▄"],
  B: ["█▄▄", "█▄█"],
  H: ["█░█", "█▀█"],
  A: ["▄▀█", "█▀█"],
  N: ["█▄░█", "█░▀█"],
  E: ["█▀▀", "██▄"],
  S: ["█▀", "▄█"],
  " ": [" ", " "],
};

function wordmarkRows(text = "RB HARNESS"): string[] {
  const rows = ["", ""];
  [...text].forEach((character, index) => {
    const glyph = WORDMARK_GLYPHS[character] ?? WORDMARK_GLYPHS[" "]!;
    for (let row = 0; row < rows.length; row += 1) rows[row] += `${index ? " " : ""}${glyph[row]}`;
  });
  return rows;
}

function styled(value: string, tone: Tone, capabilities: ProgressiveTerminalCapabilities, bold = false): string {
  if (!capabilities.color || value === "") return value;
  const paint = capabilities.trueColor ? `[38;2;${TONE_RGB[tone]}m` : TONE_BASIC[tone];
  return `${bold ? BOLD : ""}${paint}${value}${RESET}`;
}

/** A bordered section whose heading lives inside the frame, as in the reference. */
function panel(
  content: readonly string[],
  width: number,
  capabilities: ProgressiveTerminalCapabilities,
  glyphs: Glyphs,
): string[] {
  const safeWidth = Math.max(12, width);
  const inner = safeWidth - 2;
  return [
    styled(`${glyphs.topLeft}${glyphs.horizontal.repeat(inner)}${glyphs.topRight}`, "border", capabilities),
    ...content.map((line) => `${styled(glyphs.vertical, "border", capabilities)}${pad(line, inner)}${styled(glyphs.vertical, "border", capabilities)}`),
    styled(`${glyphs.bottomLeft}${glyphs.horizontal.repeat(inner)}${glyphs.bottomRight}`, "border", capabilities),
  ];
}

function heading(text: string, capabilities: ProgressiveTerminalCapabilities): string {
  return `  ${styled(text, "heading", capabilities, true)}`;
}

function joinColumns(
  left: readonly string[],
  right: readonly string[],
  leftWidth: number,
  rightWidth: number,
  gap = 2,
): string[] {
  const rows = Math.max(left.length, right.length);
  return Array.from({ length: rows }, (_, index) => `${pad(left[index] ?? "", leftWidth)}${" ".repeat(gap)}${pad(right[index] ?? "", rightWidth)}`);
}

function distribute(total: number, weights: readonly number[]): number[] {
  const usable = Math.max(weights.length, total);
  const sum = weights.reduce((value, weight) => value + weight, 0);
  const widths = weights.map((weight) => Math.max(1, Math.floor((usable * weight) / sum)));
  let remainder = usable - widths.reduce((value, width) => value + width, 0);
  for (let index = 0; remainder > 0; index = (index + 1) % widths.length, remainder -= 1) widths[index]! += 1;
  return widths;
}

function gridLine(
  cells: readonly string[],
  widths: readonly number[],
  capabilities: ProgressiveTerminalCapabilities,
  glyphs: Glyphs,
): string {
  const separator = styled(glyphs.separator, "border", capabilities);
  return cells.map((cell, index) => pad(cell, widths[index] ?? 1)).join(` ${separator} `);
}

function centeredCell(value: string, width: number): string {
  return `${" ".repeat(Math.max(0, Math.floor((width - visibleWidth(value)) / 2)))}${value}`;
}

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

/** Colour follows the authoritative disposition first, the activity second. */
function stageTone(stage: ProgressiveStagePresentation): Tone {
  if (stage.activity === "failed") return "failed";
  if (stage.disposition === "complete-fresh") return "success";
  if (stage.disposition === "complete-stale" || stage.disposition === "reconciliation-required") return "accent";
  if (stage.activity !== "idle" && stage.activity !== "done") return "running";
  return "muted";
}

function countValue(usage: ProgressiveCountTelemetry): string {
  return usage.used.measured ? String(usage.used.value) : "—";
}

const PHASE_LABEL: Readonly<Record<ProgressiveRunPhase, string>> = {
  initializing: "iniciando",
  running: "em andamento",
  interview: "entrevista",
  recovering: "recuperando",
  closing: "encerrando",
  completed: "concluído",
  failed: "falhou",
};

function phaseTone(state: ProgressivePresentationState): Tone {
  if (state.phase === "failed") return "failed";
  if (state.phase === "completed") return "success";
  return "running";
}

function currentStageLabel(state: ProgressivePresentationState): string {
  if (state.phase === "completed") return state.closure.completed ? "closure" : "encerramento";
  const failed = state.stages.find((stage) => stage.activity === "failed");
  if (failed) return failed.label;
  const active = state.activeStage
    ? state.stages.find((stage) => stage.stage === state.activeStage)
    : state.stages.find((stage) => stage.activity !== "idle" && stage.activity !== "done");
  return active?.label ?? "aguardando";
}

function completedStages(state: ProgressivePresentationState): number {
  return state.stages.filter((stage) => stage.disposition === "complete-fresh").length;
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
  const { state, capabilities } = input;
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
  const lines: string[] = [styled(questionHeader(state), "heading", capabilities, true)];
  const room = (): number => Math.max(0, contextRows - lines.length);
  const addTier = (tier: readonly string[], separator: boolean, tone: Tone): boolean => {
    if (!tier.length) return true;
    const spareRows = room();
    if (separator && spareRows > tier.length) lines.push("");
    const take = Math.min(tier.length, room());
    lines.push(...tier.slice(0, take).map((line) => styled(line, tone, capabilities)));
    return take === tier.length;
  };
  const alternatives = question.alternatives.length
    ? ["Alternatives:", ...question.alternatives.flatMap((alternative, index) => wrap(`${index + 1}. ${alternative}`, Math.max(1, width - 2)).map((line) => `  ${line}`))]
    : [];
  const complete = [
    addTier(prompt, true, "value"),
    addTier(explanation, true, "subtle"),
    addTier(recommendation, true, "label"),
    addTier(alternatives, true, "muted"),
  ].every(Boolean);
  if (!complete && lines.length) {
    const last = lines.length - 1;
    lines[last] = truncate(`${(lines[last] ?? "").trimEnd()} …`, width);
  }

  if (heights.length && input.selection) {
    const viewport = progressiveSelectionViewport(input.selection, heights, inputRows);
    const selected = progressiveSelectedIndex(input.selection);
    if (viewport.hiddenBefore > 0) lines.push(styled(`${glyphs.up} ${viewport.hiddenBefore} previous`, "muted", capabilities));
    for (let index = viewport.start; index < viewport.end && index < question.options.length; index += 1) {
      const option = question.options[index]!;
      const active = index === selected;
      const marker = active ? `${styled(glyphs.cursor, "accent", capabilities, true)} ` : "  ";
      wrap(option.label, Math.max(1, width - 4)).forEach((labelRow, rowIndex) => {
        const prefix = rowIndex === 0 ? marker : "  ";
        const suffix = rowIndex === 0 && option.recommended ? styled("   Recommended", "success", capabilities) : "";
        lines.push(truncate(`${prefix}${styled(labelRow, active ? "heading" : "value", capabilities, active)}${suffix}`, width));
      });
      for (const detail of option.details) {
        for (const detailRow of wrap(detail, Math.max(1, width - 6))) lines.push(truncate(`    ${styled(detailRow, "muted", capabilities)}`, width));
      }
    }
    if (viewport.hiddenAfter > 0) lines.push(styled(`${glyphs.down} ${viewport.hiddenAfter} more`, "muted", capabilities));
  } else if (input.textInput) {
    const view = progressiveTextInputView(input.textInput, Math.max(1, width - 2), Math.max(1, inputRows));
    if (view.hiddenBefore > 0) lines.push(styled(`${glyphs.up} ${view.hiddenBefore} more lines`, "muted", capabilities));
    view.rows.forEach((textRow, index) => {
      const caret = index === view.cursorRow && interview.phase !== "submitting" ? "_" : "";
      lines.push(truncate(`${index === 0 ? styled("> ", "accent", capabilities, true) : "  "}${styled(`${textRow}${caret}`, "value", capabilities)}`, width));
    });
    if (view.hiddenAfter > 0) lines.push(styled(`${glyphs.down} ${view.hiddenAfter} more lines`, "muted", capabilities));
  }

  if (statusLine) lines.push(truncate(styled(statusLine, interview.phase === "rejected" ? "failed" : "running", capabilities), width));
  lines.push(truncate(styled(footerHint, "muted", capabilities), width));
  return lines;
}

function closureWorkspace(
  state: ProgressivePresentationState,
  width: number,
  glyphs: Glyphs,
  capabilities: ProgressiveTerminalCapabilities,
): readonly string[] {
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
  return lines.flatMap((line) => wrap(line, width)).map((line) => {
    const tone: Tone = line.startsWith("RALPH READY") ? "success"
      : line.startsWith("Ralph readiness not") ? "running"
        : line.startsWith("Run `rb-harness") ? "label"
          : line.startsWith("P") ? "muted" : "value";
    return styled(line, tone, capabilities, line.startsWith("RALPH READY"));
  });
}

function failureWorkspace(
  state: ProgressivePresentationState,
  width: number,
  glyphs: Glyphs,
  capabilities: ProgressiveTerminalCapabilities,
): readonly string[] {
  const lines: string[] = [styled(`FAILED ${glyphs.failed}`, "failed", capabilities, true), ""];
  lines.push(...wrap(state.failure ?? "Progressive Init failed", width).map((line) => styled(line, "failed", capabilities)));
  if (state.closure.failureReason) {
    lines.push("");
    lines.push(...wrap(`Closure: ${state.closure.failureReason}`, width).map((line) => styled(line, "value", capabilities)));
  }
  const findings = state.stages.flatMap((stage) => stage.findings.map((finding) => `${stage.label}: ${finding}`));
  if (findings.length) {
    lines.push("");
    for (const finding of findings.slice(0, 6)) lines.push(...wrap(finding, width).map((line) => styled(line, "muted", capabilities)));
  }
  lines.push("");
  lines.push(styled("Ralph is not READY. No bypass action is offered.", "muted", capabilities));
  return lines;
}

function statusWorkspace(
  state: ProgressivePresentationState,
  width: number,
  glyphs: Glyphs,
  capabilities: ProgressiveTerminalCapabilities,
  verbose: boolean,
): readonly string[] {
  const lines: string[] = [];
  for (const [index, stage] of state.stages.entries()) {
    const activity = stageActivityLabel(stage);
    const detail = [
      stageDispositionLabel(stage),
      ...(activity ? [activity] : []),
      ...(stage.skipped ? ["skipped"] : []),
    ].join(" · ");
    const tone = stageTone(stage);
    const row = `${styled(`P${index + 1}`, "label", capabilities)} ${styled(stageMark(stage, glyphs), tone, capabilities, true)} ${styled(stage.label, tone, capabilities, tone !== "muted")} ${styled("·", "muted", capabilities)} ${styled(detail, "muted", capabilities)}`;
    lines.push(truncate(row, width));
    if (verbose) for (const finding of stage.findings.slice(0, 2)) lines.push(...wrap(`   ${finding}`, width).map((line) => styled(line, "muted", capabilities)));
  }
  if (state.closure.started) {
    lines.push("");
    lines.push(styled(`Closure ${state.closure.completed ? glyphs.done : glyphs.running}`, state.closure.completed ? "success" : "running", capabilities));
  }
  if (state.activityLine) {
    lines.push("");
    lines.push(...wrap(state.activityLine, width).map((line) => styled(line, "subtle", capabilities)));
  }
  return lines;
}

/* ------------------------------------------------------------------ header */

interface HeaderGeometry {
  readonly variant: "wide" | "compact";
  readonly mascotWidth: number;
  readonly wordmark: readonly string[];
  readonly wordmarkWidth: number;
  readonly mascotStart: number;
  readonly leftWidth: number;
  readonly rightWidth: number;
  readonly split: boolean;
}

/** The full mascot is chosen independently from the panel-layout breakpoint. */
export function progressiveMascotVariant(width: number): "wide" | "compact" {
  return width >= 68 ? "wide" : "compact";
}

function headerGeometry(capabilities: ProgressiveTerminalCapabilities): HeaderGeometry {
  const variant = progressiveMascotVariant(capabilities.width);
  const mascotWidth = harnessMascotDimensions(variant).width;
  const face = capabilities.unicode ? wordmarkRows() : ["RB HARNESS"];
  const faceWidth = face.reduce((maximum, row) => Math.max(maximum, visibleWidth(row)), 0);
  // The wordmark is never clipped: a terminal too narrow for the block face
  // keeps the plain one instead of losing the brand entirely.
  const wordmark = faceWidth + HEADER_MARGIN <= capabilities.width ? face : ["RB HARNESS"];
  const wordmarkWidth = wordmark.reduce((maximum, row) => Math.max(maximum, visibleWidth(row)), 0);
  const mascotStart = Math.max(0, Math.floor((capabilities.width - mascotWidth) / 2));
  const leftWidth = Math.max(0, mascotStart - 1);
  const rightWidth = Math.max(0, capabilities.width - mascotStart - mascotWidth);
  return {
    variant,
    mascotWidth,
    wordmark,
    wordmarkWidth,
    mascotStart,
    leftWidth,
    rightWidth,
    split: variant === "wide" && leftWidth >= wordmarkWidth + HEADER_MARGIN,
  };
}

function badgeText(state: ProgressivePresentationState, glyphs: Glyphs): string | undefined {
  if (state.phase === "failed") return `FALHOU ${glyphs.failed}`;
  if (state.ralphReady) return `RALPH READY ${glyphs.done}`;
  return undefined;
}

function badgeTone(state: ProgressivePresentationState): Tone {
  return state.phase === "failed" ? "failed" : "success";
}

function dashboardHeader(input: ProgressiveRenderInput, glyphs: Glyphs, withMascot: boolean): string[] {
  const { state, capabilities } = input;
  const margin = " ".repeat(HEADER_MARGIN);
  const geometry = headerGeometry(capabilities);
  const subtitle = styled(HEADER_SUBTITLE, "subtle", capabilities);
  const version = styled(`v${input.version}`, "muted", capabilities);
  const wordmark = geometry.wordmark.map((row) => styled(row, "heading", capabilities, true));
  const badge = badgeText(state, glyphs);

  // Subtitle and version share one row wherever the column can hold both, so the
  // header costs three rows instead of five. Where it cannot -- the mascot split
  // leaves a narrow left column -- they stay stacked rather than being cut.
  const identityFor = (available: number): string[] =>
    visibleWidth(`${HEADER_SUBTITLE} · v${input.version}`) <= available
      ? [`${subtitle} ${styled("·", "muted", capabilities)} ${version}`]
      : [subtitle, `${" ".repeat(Math.floor(geometry.wordmarkWidth / 2))}${version}`];

  if (!withMascot) {
    const trailer = badge ? `  ${styled(badge, badgeTone(state), capabilities, true)}` : "";
    const identityRows = identityFor(capabilities.width - HEADER_MARGIN);
    const identity = identityRows.map((row, index) => (index === identityRows.length - 1 ? `${row}${trailer}` : row));
    return [...wordmark, ...identity].map((line) => truncate(`${margin}${line}`, capabilities.width));
  }

  const mascot = renderHarnessMascot(geometry.variant, { color: capabilities.color, unicode: capabilities.unicode });

  if (!geometry.split) {
    return [
      ...[...wordmark, ...identityFor(capabilities.width - HEADER_MARGIN)].map((row) => `${margin}${row}`),
      ...mascot.map((row) => center(row, capabilities.width)),
    ].map((line) => truncate(line, capabilities.width));
  }

  const rows = mascot.length;
  const left = Array.from({ length: rows }, () => "");
  const right = Array.from({ length: rows }, () => "");
  const identityRows = identityFor(Math.max(0, geometry.leftWidth - HEADER_MARGIN));
  wordmark.forEach((row, index) => { left[index] = row; });
  identityRows.forEach((row, index) => { left[Math.min(wordmark.length + index, rows - 1)] = row; });
  const taglineRow = Math.min(wordmark.length + identityRows.length - 1, rows - 1);
  const tagline = badge
    ? styled(badge, badgeTone(state), capabilities, true)
    : styled(HEADER_TAGLINE, "muted", capabilities);
  // Width pressure removes the secondary line before it ever touches the mascot.
  if (geometry.rightWidth >= visibleWidth(tagline) + 2) {
    right[taglineRow] = tagline;
  }

  return Array.from({ length: rows }, (_, index) => {
    const rightText = right[index] ?? "";
    const rightCell = rightText
      ? `${" ".repeat(Math.max(0, geometry.rightWidth - 1 - visibleWidth(rightText)))}${rightText}`
      : "";
    return truncate(`${pad(`${margin}${left[index] ?? ""}`, geometry.leftWidth)} ${mascot[index] ?? ""}${rightCell}`, capabilities.width);
  });
}

/** The last header the frame can afford: one line that still carries identity. */
function headerLine(input: ProgressiveRenderInput, glyphs: Glyphs): string {
  const { state, capabilities } = input;
  const badge = badgeText(state, glyphs);
  const separator = styled("·", "muted", capabilities);
  const title = `${styled("RB HARNESS", "heading", capabilities, true)} ${styled(`v${input.version}`, "muted", capabilities)} ${separator} ${styled("INIT PROGRESSIVO", "subtle", capabilities)}`;
  const trailer = badge ? ` ${separator} ${styled(badge, badgeTone(state), capabilities, true)}` : "";
  return truncate(`  ${title}${trailer}`, capabilities.width);
}

/* ----------------------------------------------------------------- summary */

const SUMMARY_WEIGHTS = [3.0, 1.5, 2.1, 1.8, 1.6] as const;

interface SummaryCell {
  readonly label: string;
  readonly icon: string;
  readonly value: string;
  readonly tone: Tone;
  readonly iconTone: Tone;
}

function summaryCells(state: ProgressivePresentationState, glyphs: Glyphs): readonly SummaryCell[] {
  const tone = phaseTone(state);
  const disposition = state.runDisposition === "fresh-run" ? "nova"
    : state.runDisposition === "resume" ? "retomada" : "—";
  return [
    { label: "PROJETO", icon: glyphs.project, value: state.projectRoot, tone: "value", iconTone: "label" },
    { label: "EXECUÇÃO", icon: glyphs.workflow, value: disposition, tone: "value", iconTone: "label" },
    { label: "ETAPA ATUAL", icon: glyphs.stage, value: currentStageLabel(state), tone: "heading", iconTone: "label" },
    { label: "STATUS", icon: glyphs.status, value: PHASE_LABEL[state.phase], tone, iconTone: tone },
    { label: "PROGRESSO", icon: glyphs.progress, value: `${completedStages(state)}/${state.stages.length}`, tone: "value", iconTone: "label" },
  ];
}

function summaryPanel(
  state: ProgressivePresentationState,
  capabilities: ProgressiveTerminalCapabilities,
  glyphs: Glyphs,
  narrow: boolean,
): string[] {
  const cells = summaryCells(state, glyphs);
  const widths = distribute(capabilities.width - 2 - (cells.length - 1) * 3, SUMMARY_WEIGHTS);
  // A column narrower than its own heading prints a cut word such as "EXECUÇ…",
  // so the grid yields to the stacked form before the labels stop being words.
  const labelsFit = cells.every((cell, index) => (widths[index] ?? 0) >= visibleWidth(cell.label) + 3);
  if (narrow || !labelsFit) {
    return panel([
      heading("RESUMO", capabilities),
      ...cells.map((cell) => `  ${styled(cell.icon, cell.iconTone, capabilities)} ${pad(styled(cell.label, "label", capabilities), 13)}${styled(truncate(cell.value, Math.max(4, capabilities.width - 22)), cell.tone, capabilities)}`),
    ], capabilities.width, capabilities, glyphs);
  }
  return panel([
    gridLine(cells.map((cell) => `   ${styled(cell.label, "heading", capabilities)}`), widths, capabilities, glyphs),
    gridLine(cells.map((cell, index) => `   ${styled(cell.icon, cell.iconTone, capabilities)}  ${styled(truncate(cell.value, Math.max(3, (widths[index] ?? 8) - 6)), cell.tone, capabilities)}`), widths, capabilities, glyphs),
  ], capabilities.width, capabilities, glyphs);
}

/** The summary never disappears: a short terminal keeps it as one line. */
function summaryStrip(
  state: ProgressivePresentationState,
  capabilities: ProgressiveTerminalCapabilities,
  glyphs: Glyphs,
): string {
  const tone = phaseTone(state);
  const parts = [
    `${styled(glyphs.project, "label", capabilities)} ${styled(state.projectRoot, "value", capabilities)}`,
    `${styled(glyphs.stage, "label", capabilities)} ${styled(currentStageLabel(state), "heading", capabilities)}`,
    `${styled(glyphs.status, tone, capabilities)} ${styled(PHASE_LABEL[state.phase], tone, capabilities)}`,
    `${styled(glyphs.progress, "label", capabilities)} ${styled(`${completedStages(state)}/${state.stages.length}`, "value", capabilities)}`,
  ];
  return truncate(`  ${parts.join(` ${styled(glyphs.separator, "border", capabilities)} `)}`, capabilities.width);
}

/* ---------------------------------------------------------------- pipeline */

const RAIL_GUTTER = 2;

function anchoredRow(
  entries: readonly { readonly text: string; readonly tone: Tone; readonly bold?: boolean }[],
  centers: readonly number[],
  capabilities: ProgressiveTerminalCapabilities,
): string {
  let row = "";
  let column = 0;
  entries.forEach((entry, index) => {
    const size = visibleWidth(entry.text);
    // Two cells of gutter are reserved before a neighbour, so long stage names
    // stay readable instead of running into each other.
    const floorColumn = index === 0 ? column : column + RAIL_GUTTER;
    const start = Math.max(floorColumn, (centers[index] ?? floorColumn) - Math.floor(size / 2));
    row += `${" ".repeat(start - column)}${styled(entry.text, entry.tone, capabilities, entry.bold === true)}`;
    column = start + size;
  });
  return row;
}

function pipelineNode(
  stage: ProgressiveStagePresentation,
  glyphs: Glyphs,
  capabilities: ProgressiveTerminalCapabilities,
): string {
  const tone = stageTone(stage);
  return `${styled("[", tone, capabilities)}${styled(stageMark(stage, glyphs), tone, capabilities, true)}${styled("]", tone, capabilities)}`;
}

function railStatus(stage: ProgressiveStagePresentation): string {
  const activity = stageActivityLabel(stage);
  return [
    stageDispositionLabel(stage),
    ...(activity ? [activity] : []),
    ...(stage.skipped ? ["skipped"] : []),
  ].join(" · ");
}

const RAIL_MINIMUM_CELL = 9;

/**
 * Column widths for the rail, or nothing when the terminal is too narrow to
 * carry one. A wide stage name is shortened before the rail is given up, so the
 * flow stays a rail for as long as it stays readable.
 */
function railCells(state: ProgressivePresentationState, inner: number): number[] | undefined {
  const count = state.stages.length;
  if (count === 0) return undefined;
  const available = inner - (RAIL_GUTTER + 1) * (count - 1);
  if (available < count * RAIL_MINIMUM_CELL) return undefined;
  const natural = state.stages.map((stage) => Math.max(3, visibleWidth(stage.label), visibleWidth(railStatus(stage))));
  if (natural.reduce((total, cell) => total + cell, 0) <= available) return natural;
  const cap = Math.max(RAIL_MINIMUM_CELL, Math.floor(available / count));
  return natural.map((cell) => Math.min(cell, cap));
}

/** A progress rail: boxed nodes, dashed connectors, stage names and states. */
function pipelineRail(
  state: ProgressivePresentationState,
  inner: number,
  capabilities: ProgressiveTerminalCapabilities,
  glyphs: Glyphs,
): string[] {
  const cells = railCells(state, inner) ?? [];
  const steps = state.stages.map((stage, index) => ({
    stage,
    label: truncate(stage.label, cells[index] ?? 3),
    status: truncate(railStatus(stage), cells[index] ?? 3),
  }));
  // The rail is later pulled left so it opens on a node; that lead is handed
  // back to the connectors, so the flow spans the panel instead of stopping short.
  const lead = Math.max(0, Math.floor((cells[0] ?? 3) / 2) - 1);
  const spare = inner - cells.reduce((total, cell) => total + cell, 0) + lead;
  const gap = Math.max(RAIL_GUTTER + 1, Math.floor(spare / Math.max(1, steps.length - 1)));
  const centers: number[] = [];
  let cursor = 0;
  for (const cell of cells) {
    centers.push(cursor + Math.floor(cell / 2));
    cursor += cell + gap;
  }
  // Anchor the rail at the panel edge so it opens on a node, never on connector dashes.
  for (let index = 0; index < centers.length; index += 1) centers[index] = Math.max(1, centers[index]! - lead);

  let rail = "";
  let column = 0;
  steps.forEach((step, index) => {
    const start = Math.max(column, (centers[index] ?? 0) - 1);
    if (start > column) rail += styled(glyphs.dash.repeat(start - column), "muted", capabilities);
    rail += pipelineNode(step.stage, glyphs, capabilities);
    column = start + 3;
  });

  return [
    rail,
    anchoredRow(steps.map((step) => ({ text: step.label, tone: stageTone(step.stage), bold: stageTone(step.stage) !== "muted" })), centers, capabilities),
    anchoredRow(steps.map((step) => ({ text: step.status, tone: "muted" as Tone })), centers, capabilities),
  ];
}

function pipelinePanel(
  state: ProgressivePresentationState,
  width: number,
  capabilities: ProgressiveTerminalCapabilities,
  glyphs: Glyphs,
  compact: boolean,
): string[] {
  const inner = width - 2;
  const title = heading("PIPELINE · FLUXO DE EXECUÇÃO", capabilities);
  if (!railCells(state, Math.max(12, inner - 3))) {
    const steps = state.stages.map((stage, index) => {
      const label = pad(styled(truncate(stage.label, 18), stageTone(stage), capabilities, stageTone(stage) !== "muted"), 19);
      const status = styled(truncate(railStatus(stage), Math.max(4, inner - 29)), "muted", capabilities);
      return `  ${pipelineNode(stage, glyphs, capabilities)} ${styled(`P${index + 1}`, "label", capabilities)} ${label}${status}`;
    });
    return panel([title, ...steps], width, capabilities, glyphs);
  }
  const rail = pipelineRail(state, Math.max(12, inner - 3), capabilities, glyphs).map((line) => `  ${line}`);
  const note = `  ${styled(truncate(PIPELINE_NOTE, Math.max(4, inner - 3)), "muted", capabilities)}`;
  return panel(compact ? [title, ...rail] : [title, "", ...rail, note], width, capabilities, glyphs);
}

/** The pipeline never disappears: a short terminal keeps it as one node row. */
function pipelineStrip(
  state: ProgressivePresentationState,
  capabilities: ProgressiveTerminalCapabilities,
  glyphs: Glyphs,
): string {
  const nodes = state.stages
    .map((stage, index) => `${styled(`P${index + 1}`, "label", capabilities)}${pipelineNode(stage, glyphs, capabilities)}`)
    .join(" ");
  const active = state.stages.find((stage) => stage.activity !== "idle" && stage.activity !== "done")
    ?? state.stages[state.stages.length - 1];
  const trailer = active
    ? `  ${styled(active.label, stageTone(active), capabilities, true)} ${styled(railStatus(active), "muted", capabilities)}`
    : "";
  return truncate(`  ${nodes}${trailer}`, capabilities.width);
}

/* ---------------------------------------------------------------- provider */

function providerPanel(
  state: ProgressivePresentationState,
  width: number,
  capabilities: ProgressiveTerminalCapabilities,
  glyphs: Glyphs,
  compact: boolean,
): string[] {
  const provider = state.provider!;
  const inner = width - 2;
  const labelWidth = Math.max(4, Math.min(inner - 10, Math.max(15, Math.floor(inner * 0.26))));
  const valueWidth = Math.max(6, inner - 2 - labelWidth - 1);
  const entry = (label: string, value: string, tone: Tone = "value"): string =>
    `  ${pad(styled(label, "label", capabilities), labelWidth)}${styled(truncate(value, valueWidth), tone, capabilities)}`;
  const title = heading("PROVEDOR ATUAL", capabilities);
  const titleGap = Math.max(1, inner - 2 - visibleWidth("PROVEDOR ATUAL") - visibleWidth(glyphs.plug) - 2);
  const titleLine = `${title}${" ".repeat(titleGap)}${styled(glyphs.plug, "accent", capabilities)}`;
  // The registry profile id is printed verbatim, never a label-derived rebuild.
  const lines = compact
    ? [
      titleLine,
      entry("provedor", provider.providerLabel),
      entry("modelo", provider.modelLabel, "heading"),
      entry("perfil", provider.profileId),
    ]
    : [
      titleLine,
      "",
      entry("provedor", provider.providerLabel),
      entry("modelo", provider.modelLabel, "heading"),
      entry("perfil", provider.profileId),
      entry("transporte", provider.transport),
      entry("contabilidade", provider.requestAccounting, "muted"),
    ];
  return panel(lines, width, capabilities, glyphs);
}

/** The active provider never disappears: a short terminal keeps it as one line. */
function providerStrip(
  state: ProgressivePresentationState,
  capabilities: ProgressiveTerminalCapabilities,
  glyphs: Glyphs,
): string {
  const provider = state.provider!;
  const value = `${provider.providerLabel} · ${provider.modelLabel} · ${provider.profileId}`;
  return truncate(`  ${styled(glyphs.plug, "accent", capabilities)} ${styled("provedor", "label", capabilities)} ${styled(value, "value", capabilities)}`, capabilities.width);
}

/* --------------------------------------------------------------- telemetry */

interface Metric {
  readonly label: string;
  readonly short: string;
  readonly icon: string;
  readonly value: string;
  readonly tone: Tone;
  readonly iconTone: Tone;
  readonly weight: number;
}

/**
 * Operational telemetry only. Progressive Core supplies no ceilings on this
 * path, so a cell prints a measured count or the unmeasured dash, never a
 * fabricated denominator.
 */
function metrics(state: ProgressivePresentationState, glyphs: Glyphs): readonly Metric[] {
  const counters = state.counters;
  const corrections = countValue(counters.correctiveRegenerationsRun);
  return [
    { label: "OPERAÇÕES SEMÂNTICAS", short: "SEMÂNTICAS", icon: glyphs.semantic, value: countValue(counters.semanticOperations), tone: "value", iconTone: "label", weight: 1.7 },
    { label: "INVOCAÇÕES", short: "INVOCAÇÕES", icon: glyphs.invocations, value: countValue(counters.transportInvocations), tone: "value", iconTone: "label", weight: 1.3 },
    { label: "CORREÇÕES · RUN", short: "CORREÇÕES", icon: glyphs.corrections, value: corrections, tone: corrections !== "0" && corrections !== "—" ? "accent" : "value", iconTone: "accent", weight: 1.4 },
    { label: "CORREÇÕES · SLICE", short: "SLICE", icon: glyphs.corrections, value: countValue(counters.correctiveRegenerationsSlice), tone: "value", iconTone: "accent", weight: 1.4 },
    { label: "RETENTATIVAS", short: "RETENT.", icon: glyphs.retries, value: countValue(counters.transportRetries), tone: counters.transportRetries.used.measured ? "value" : "muted", iconTone: "label", weight: 1.3 },
  ];
}

function telemetryPanel(
  state: ProgressivePresentationState,
  capabilities: ProgressiveTerminalCapabilities,
  glyphs: Glyphs,
  tier: ProgressiveLayoutTier,
): string[] {
  const cells = metrics(state, glyphs);
  const columns = tier === "large" ? cells.length : 3;
  // One width vector for every metric row keeps the dotted separators aligned.
  const columnWeights = Array.from({ length: columns }, (_, column) => {
    let weight = 0;
    for (let index = column; index < cells.length; index += columns) weight = Math.max(weight, cells[index]!.weight);
    return weight;
  });
  const widths = distribute(capabilities.width - 2 - (columns - 1) * 3, columnWeights);
  const rows: string[] = [heading("TELEMETRIA", capabilities)];
  for (let offset = 0; offset < cells.length; offset += columns) {
    const group = Array.from({ length: columns }, (_, index) => cells[offset + index]);
    rows.push(gridLine(group.map((metric, index) => {
      const cell = widths[index] ?? 8;
      if (!metric) return "";
      const label = visibleWidth(metric.label) <= cell ? metric.label : metric.short;
      return centeredCell(styled(truncate(label, cell), "heading", capabilities), cell);
    }), widths, capabilities, glyphs));
    rows.push(gridLine(group.map((metric, index) => {
      const cell = widths[index] ?? 8;
      if (!metric) return "";
      const budget = Math.max(3, cell - visibleWidth(metric.icon) - 1);
      return centeredCell(`${styled(metric.icon, metric.iconTone, capabilities)} ${styled(truncate(metric.value, budget), metric.tone, capabilities)}`, cell);
    }), widths, capabilities, glyphs));
  }
  return panel(rows, capabilities.width, capabilities, glyphs);
}

/** Telemetry never disappears: a short terminal keeps it as one dense line. */
function telemetryStrip(
  state: ProgressivePresentationState,
  capabilities: ProgressiveTerminalCapabilities,
): string {
  const counters = state.counters;
  const parts = [
    `semânticas ${countValue(counters.semanticOperations)}`,
    `invocações ${countValue(counters.transportInvocations)}`,
    `correções ${countValue(counters.correctiveRegenerationsRun)}`,
    `slice ${countValue(counters.correctiveRegenerationsSlice)}`,
    `retentativas ${countValue(counters.transportRetries)}`,
  ];
  return truncate(`  ${styled(parts.join(" · "), "muted", capabilities)}`, capabilities.width);
}

/* ------------------------------------------------------------------- frame */

function workspaceTitle(state: ProgressivePresentationState): string {
  // Failure outranks the interview. Even if an interview somehow survived a
  // terminal failure, the screen must say FALHA rather than invite an answer.
  if (state.phase === "failed") return "FALHA · DIAGNÓSTICO";
  if (state.interview) return "ENTREVISTA · DECISÕES DO PROJETO";
  if (state.phase === "completed") return "CONCLUSÃO · PRONTIDÃO";
  return "ETAPAS · ESTADO ATUAL";
}

function workspaceBody(
  input: ProgressiveRenderInput,
  inner: number,
  rows: number,
  glyphs: Glyphs,
  verbose: boolean,
): readonly string[] {
  const { state, capabilities } = input;
  // Same precedence as the title: a failed run never renders an input surface.
  if (state.phase === "failed") return failureWorkspace(state, inner, glyphs, capabilities);
  if (state.interview) return interviewWorkspace(input, inner, rows, glyphs);
  if (state.phase === "completed") return closureWorkspace(state, inner, glyphs, capabilities);
  return statusWorkspace(state, inner, glyphs, capabilities, verbose);
}

interface Chrome {
  readonly top: readonly string[];
  readonly bottom: readonly string[];
}

/**
 * Degradation ladder. Every step gives the workspace rows back in the order a
 * developer misses them least: mascot, telemetry grid, provider panel, summary
 * grid, pipeline panel, wordmark.
 */
const MAX_DEGRADATION = 6;

function buildChrome(
  input: ProgressiveRenderInput,
  glyphs: Glyphs,
  tier: ProgressiveLayoutTier,
  level: number,
): Chrome {
  const { state, capabilities } = input;
  const width = capabilities.width;
  const top: string[] = [];

  if (level >= 6) {
    top.push(headerLine(input, glyphs));
  } else {
    top.push(...dashboardHeader(input, glyphs, level < 1 && tier !== "small"));
    top.push(styled(glyphs.rule.repeat(width), "border", capabilities));
  }

  if (level >= 4) top.push(summaryStrip(state, capabilities, glyphs));
  else top.push(...summaryPanel(state, capabilities, glyphs, tier === "small"));

  // The provider yields the screen while the interview owns the workspace, so
  // the developer reads one question instead of a status wall.
  const showProvider = Boolean(state.provider) && !state.interview;
  const sideBySide = width >= 116 && showProvider && level < 3;

  if (level >= 5) {
    top.push(pipelineStrip(state, capabilities, glyphs));
    if (showProvider) top.push(providerStrip(state, capabilities, glyphs));
  } else if (sideBySide) {
    const pipelineWidth = Math.max(58, Math.floor(width * 0.6));
    const providerWidth = width - pipelineWidth - 2;
    top.push(...joinColumns(
      pipelinePanel(state, pipelineWidth, capabilities, glyphs, level >= 2),
      providerPanel(state, providerWidth, capabilities, glyphs, level >= 2),
      pipelineWidth,
      providerWidth,
    ));
  } else {
    top.push(...pipelinePanel(state, width, capabilities, glyphs, level >= 2));
    if (showProvider) {
      if (level >= 3) top.push(providerStrip(state, capabilities, glyphs));
      else top.push(...providerPanel(state, width, capabilities, glyphs, level >= 2));
    }
  }

  if (level >= 2 || tier === "small") top.push(telemetryStrip(state, capabilities));
  else top.push(...telemetryPanel(state, capabilities, glyphs, tier));

  return { top, bottom: [truncate(`  ${styled(FOOTER_HINT, "muted", capabilities)}`, width)] };
}

export function renderProgressiveDashboard(input: ProgressiveRenderInput): string {
  const { state, capabilities } = input;
  const glyphs = capabilities.unicode ? UNICODE : ASCII;
  const tier = progressiveLayoutTier(capabilities);
  const width = capabilities.width;
  const height = capabilities.height;
  const inner = Math.max(4, width - 4);

  // The workspace is the point of the screen, so the chrome around it is given
  // up until the panel holds what this run actually has to say.
  const wanted = state.interview && state.phase !== "failed"
    ? 16
    : workspaceBody(input, inner, 16, glyphs, tier !== "small").length + 1;
  const target = Math.min(Math.max(4, wanted) + 2, Math.max(4, height - 4));

  let level = 0;
  let chrome = buildChrome(input, glyphs, tier, level);
  while (level < MAX_DEGRADATION && height - chrome.top.length - chrome.bottom.length < target) {
    level += 1;
    chrome = buildChrome(input, glyphs, tier, level);
  }

  const workspaceRows = Math.max(3, height - chrome.top.length - chrome.bottom.length);
  const bodyRows = Math.max(1, workspaceRows - 3);
  const body = workspaceBody(input, inner, bodyRows, glyphs, tier !== "small");
  const content = body.length > bodyRows
    ? body.slice(0, bodyRows)
    : [...body, ...Array.from({ length: bodyRows - body.length }, () => "")];

  const lines = [
    ...chrome.top,
    ...panel([heading(workspaceTitle(state), capabilities), ...content.map((line) => `  ${line}`)], width, capabilities, glyphs),
    ...chrome.bottom,
  ];
  // The frame fills the viewport exactly and stops. A trailing newline after the
  // last row scrolls the terminal by one line, which silently eats the wordmark
  // at the top of the next frame.
  return lines.slice(0, Math.max(1, height)).join("\n");
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
