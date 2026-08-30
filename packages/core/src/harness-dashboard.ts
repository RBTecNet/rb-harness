import type { HarnessRunState } from "./standalone-types.js";
import { HARNESS_BUDGET } from "./harness-budget.js";
import type { ProviderMode } from "./harness-provider.js";
import {
  HARNESS_STAGE_LABELS,
  addUsage,
  emptyUsage,
  type HarnessStage,
  type ProviderUsage,
} from "./harness-telemetry.js";
import { harnessMascotDimensions, renderHarnessMascot } from "./harness-mascot.js";

type DashboardEvent =
  | { type: "state"; state: HarnessRunState }
  | { type: "provider-start"; provider: string; model: string; mode: ProviderMode; stage: HarnessStage }
  | { type: "provider-output"; bytes: number; firstOutputMilliseconds?: number }
  | { type: "provider-end"; exitCode: number; bytes: number; usage: ProviderUsage }
  | { type: "stage"; stage: HarnessStage }
  | { type: "activity"; message: string };

interface ViewState {
  version: string;
  startedAt: number;
  state?: HarnessRunState;
  stage?: HarnessStage;
  provider?: { name: string; model: string; mode: ProviderMode; startedAt: number; bytes: number; firstOutputMilliseconds?: number; exitCode?: number };
  providerCalls: number;
  usage: ProviderUsage;
  recent: string[];
  paused: boolean;
  final: boolean;
}

/** Documentation stages the operator can see advance, in order. */
const PIPELINE: readonly HarnessStage[] = [
  "inventory", "gap-analysis", "generation", "materialization", "validation", "publication",
];

const COMPACT_LABEL: Readonly<Record<HarnessStage, string>> = {
  "inventory": "Inventário",
  "gap-analysis": "Lacunas",
  "awaiting-human": "Resposta",
  "evidence": "Evidências",
  "generation": "Geração",
  "materialization": "Materialização",
  "validation": "Validação",
  "structural-repair": "Correção",
  "publication": "Publicação",
};

/**
 * The documentation stage implied by a run status. The dashboard prefers the
 * stage a live provider call reported, because it distinguishes evidence
 * discovery from package generation inside one status.
 */
export function stageForStatus(status: HarnessRunState["status"] | undefined): HarnessStage | undefined {
  switch (status) {
    case "inventory": return "inventory";
    case "interview": case "interview-failed": return "gap-analysis";
    case "generating": case "generation-failed": case "blocked": return "generation";
    case "materializing": return "materialization";
    case "validating": case "auditing": return "validation";
    case "repairing": return "structural-repair";
    case "publishing": return "publication";
    case "complete": return "publication";
    default: return undefined;
  }
}

const C = {
  reset: "\u001b[0m", bold: "\u001b[1m", dim: "\u001b[2m",
  cyan: "\u001b[36m", blue: "\u001b[34m", magenta: "\u001b[35m",
  green: "\u001b[32m", yellow: "\u001b[33m", red: "\u001b[31m", grey: "\u001b[90m", white: "\u001b[37m",
};

let active: HarnessDashboard | undefined;

function clean(value: unknown): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

const ANSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export function stripTerminalAnsi(value: string): string {
  return value.replace(ANSI_SEQUENCE, "");
}

function terminalCellWidth(character: string): number {
  const point = character.codePointAt(0) ?? 0;
  if (point === 0 || point < 32 || (point >= 0x7f && point < 0xa0) || /\p{Mark}/u.test(character)) return 0;
  if (
    point >= 0x1100 && (
      point <= 0x115f || point === 0x2329 || point === 0x232a
      || (point >= 0x2e80 && point <= 0xa4cf && point !== 0x303f)
      || (point >= 0xac00 && point <= 0xd7a3)
      || (point >= 0xf900 && point <= 0xfaff)
      || (point >= 0xfe10 && point <= 0xfe19)
      || (point >= 0xfe30 && point <= 0xfe6f)
      || (point >= 0xff00 && point <= 0xff60)
      || (point >= 0xffe0 && point <= 0xffe6)
      || (point >= 0x1f300 && point <= 0x1faff)
      || (point >= 0x20000 && point <= 0x3fffd)
    )
  ) return 2;
  return 1;
}

export function terminalVisibleWidth(value: string): number {
  return [...stripTerminalAnsi(value)].reduce((total, character) => total + terminalCellWidth(character), 0);
}

export function truncateTerminalText(value: string, width: number): string {
  if (width <= 0) return "";
  const plain = stripTerminalAnsi(value);
  if (terminalVisibleWidth(plain) <= width) return value;
  const target = Math.max(0, width - 1);
  let used = 0;
  let result = "";
  for (const character of plain) {
    const cells = terminalCellWidth(character);
    if (used + cells > target) break;
    result += character;
    used += cells;
  }
  return `${result}…`;
}

function visible(value: string): number {
  return terminalVisibleWidth(value);
}

function fit(value: string, width: number): string {
  const fitted = truncateTerminalText(value, width);
  return `${fitted}${" ".repeat(Math.max(0, width - terminalVisibleWidth(fitted)))}`;
}

function duration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours ? `${hours}h ${String(minutes).padStart(2, "0")}m` : `${minutes}m ${String(rest).padStart(2, "0")}s`;
}

export function stageState(
  status: HarnessRunState["status"] | undefined,
  active: HarnessStage | undefined,
  stage: HarnessStage,
): "done" | "run" | "wait" | "fail" {
  if (!status && !active) return "wait";
  if (status === "complete") return "done";
  // A live provider stage outside the visible pipeline (evidence discovery,
  // waiting for a human) belongs to the pipeline step that owns it.
  const owner: Partial<Record<HarnessStage, HarnessStage>> = {
    "awaiting-human": "gap-analysis",
    "evidence": "generation",
    "structural-repair": "validation",
  };
  const current = active ? owner[active] ?? active : stageForStatus(status);
  const currentIndex = current ? PIPELINE.indexOf(current) : -1;
  const targetIndex = PIPELINE.indexOf(stage);
  const failed = Boolean(status && (status.endsWith("failed") || status === "blocked"));
  if (currentIndex < 0) return "wait";
  if (targetIndex < currentIndex) return "done";
  if (targetIndex === currentIndex) return failed ? "fail" : "run";
  return "wait";
}

function stageMark(value: ReturnType<typeof stageState>): string {
  if (value === "done") return `${C.green}✓${C.reset}`;
  if (value === "run") return `${C.yellow}●${C.reset}`;
  if (value === "fail") return `${C.red}✗${C.reset}`;
  return `${C.grey}·${C.reset}`;
}

function border(title: string, width: number, bottom = false): string {
  if (bottom) return `${C.blue}╰${"─".repeat(width - 2)}╯${C.reset}`;
  const label = ` ${title} `;
  return `${C.blue}╭─${label}${"─".repeat(Math.max(0, width - visible(label) - 3))}╮${C.reset}`;
}

function row(content: string, width: number): string {
  return `${C.blue}│${C.reset} ${fit(content, width - 4)} ${C.blue}│${C.reset}`;
}

function header(version: string, width: number): string[] {
  if (width < 100) return [`${C.bold}${C.magenta}◆${C.reset} ${C.bold}${C.cyan}RB HARNESS${C.reset} ${C.dim}v${clean(version)} · DOCUMENTATION CONTROL PLANE${C.reset}`];
  const logo = [
    "█▀█ █▄▄   █░█ ▄▀█ █▀█ █▄░█ █▀▀ █▀ █▀",
    "█▀▄ █▄█   █▀█ █▀█ █▀▄ █░▀█ ██▄ ▄█ ▄█",
    "  RB HARNESS · DOCUMENTATION CONTROL PLANE",
    `                 v${clean(version)}`,
    "",
    "",
  ];
  const mascot = renderHarnessMascot("compact", { color: false });
  return logo.map((line, index) => `${index < 2 ? `${C.bold}${C.cyan}` : C.dim}${line.padEnd(44)}${C.reset}${C.magenta}${mascot[index] ?? ""}${C.reset}${index === 5 ? `${C.grey}   HARNESS · capivara documentadora${C.reset}` : ""}`);
}

export function renderHarnessDashboard(view: ViewState, requestedWidth?: number): string {
  const width = Math.max(84, requestedWidth || process.stdout.columns || 118);
  const state = view.state;
  const elapsed = Math.max(0, Math.floor((Date.now() - view.startedAt) / 1000));
  const lines = [...header(view.version, width), `${C.grey}${"━".repeat(width)}${C.reset}`];
  lines.push(`${C.cyan}PROJETO${C.reset} ${C.white}${fit(clean(state?.projectRoot || "aguardando"), Math.max(18, Math.floor(width / 3))).trimEnd()}${C.reset}   ${C.cyan}DURAÇÃO${C.reset} ${duration(elapsed)}`);
  lines.push(`${C.cyan}WORKFLOW${C.reset} ${C.white}${state?.workflow || "—"}${C.reset}   ${C.cyan}RUN${C.reset} ${C.white}${clean(state?.id || "a inicializar")}${C.reset}`);
  lines.push("");
  lines.push(border("PIPELINE DOCUMENTAL", width));
  lines.push(row(PIPELINE.map((stage) => `${stageMark(stageState(state?.status, view.stage, stage))} ${COMPACT_LABEL[stage]}`).join("  "), width));
  const activeLabel = view.stage ? HARNESS_STAGE_LABELS[view.stage] : "inicializando";
  lines.push(row(`${C.cyan}etapa${C.reset} ${C.white}${activeLabel}${C.reset}    ${C.cyan}status${C.reset} ${C.white}${clean(state?.status || "inicializando")}${C.reset}    ${C.cyan}respostas${C.reset} ${state?.answers.length ?? 0}    ${C.cyan}correções${C.reset} ${state?.repairsUsed ?? 0}/${HARNESS_BUDGET.generation.structuralRepairs}`, width));
  lines.push(row(`${C.cyan}gate${C.reset} contrato determinístico · sem gerente ou auditor LLM`, width));
  lines.push(border("", width, true));
  lines.push("");
  lines.push(border("PROVIDER ATUAL", width));
  const provider = view.provider;
  const providerElapsed = provider ? Math.max(0, Math.floor((Date.now() - provider.startedAt) / 1000)) : 0;
  lines.push(row(provider
    ? `${C.magenta}${provider.name}/${provider.model || "default"}${C.reset}  ${C.cyan}${provider.mode}${C.reset}  ${provider.exitCode === undefined ? `${C.yellow}ativo ${duration(providerElapsed)}${C.reset}` : `${provider.exitCode === 0 ? C.green : C.red}exit ${provider.exitCode}${C.reset}`}`
    : `${C.grey}nenhuma chamada ativa${C.reset}`, width));
  const first = provider?.firstOutputMilliseconds === undefined
    ? `aguardando a primeira saída · ${provider?.bytes ?? 0} bytes`
    : `primeira saída em ${Math.max(1, Math.round(provider.firstOutputMilliseconds / 1000))}s · ${provider.bytes} bytes observados`;
  lines.push(row(`${C.cyan}atividade${C.reset} ${C.white}${provider ? first : "preparando o próximo estágio"}${C.reset}`, width));
  lines.push(border("", width, true));
  lines.push("");
  lines.push(border("TELEMETRIA", width));
  lines.push(row(`${C.cyan}chamadas${C.reset} ${view.providerCalls}    ${C.cyan}ferramentas${C.reset} ${view.usage.toolCalls}    ${C.cyan}requisições${C.reset} ${view.usage.requests}`, width));
  lines.push(row(view.usage.measured
    ? `${C.cyan}tokens${C.reset} entrada ${view.usage.inputTokens} · cache ${view.usage.cachedInputTokens} · criação ${view.usage.cacheCreationInputTokens} · saída ${view.usage.outputTokens} · total ${view.usage.totalTokens}`
    : `${C.grey}tokens não medidos por este provider · nenhum custo é estimado${C.reset}`, width));
  lines.push(border("", width, true));
  lines.push("");
  lines.push(border("EVENTOS RECENTES", width));
  const events = view.recent.slice(-5);
  for (const event of events) lines.push(row(`${C.grey}›${C.reset} ${C.white}${clean(event)}${C.reset}`, width));
  while (events.length < 5) { lines.push(row("", width)); events.push(""); }
  lines.push(border("", width, true));
  if (state?.diagnostic) lines.push(`${C.red}${C.bold}DIAGNÓSTICO${C.reset} ${fit(clean(state.diagnostic), width - 12).trimEnd()}`);
  else if (view.final) lines.push(`${C.green}${C.bold}Execução encerrada.${C.reset} Artefatos e estado permaneceram registrados no projeto.`);
  else lines.push(`${C.dim}Ctrl-C interrompe com estado retomável · segredos nunca entram neste painel${C.reset}`);
  return `${lines.join("\n")}\n`;
}

class HarnessDashboard {
  private readonly view: ViewState;
  private timer?: ReturnType<typeof setInterval>;
  private enabled = false;

  constructor(version: string) {
    this.view = {
      version,
      startedAt: Date.now(),
      providerCalls: 0,
      usage: emptyUsage(),
      recent: [],
      paused: false,
      final: false,
    };
  }

  start(): void {
    if (!process.stdout.isTTY) {
      process.stderr.write("[rb-harness] --dashboard requer um terminal; seguindo com o log textual.\n");
      return;
    }
    this.enabled = true;
    process.stdout.write("\u001b[?25l");
    this.render();
    this.timer = setInterval(() => this.render(), 1000);
    this.timer.unref();
  }

  event(event: DashboardEvent): void {
    if (event.type === "state") {
      this.view.state = event.state;
      this.view.stage ??= stageForStatus(event.state.status);
      if (!this.view.provider || this.view.provider.exitCode !== undefined) {
        this.view.stage = stageForStatus(event.state.status) ?? this.view.stage;
      }
      this.view.recent.push(`estado · ${event.state.status}`);
    } else if (event.type === "provider-start") {
      this.view.provider = { name: event.provider, model: event.model, mode: event.mode, startedAt: Date.now(), bytes: 0 };
      this.view.providerCalls += 1;
      this.view.stage = event.stage;
      this.view.recent.push(`${HARNESS_STAGE_LABELS[event.stage]} · chamada ${this.view.providerCalls} iniciada`);
    } else if (event.type === "provider-output" && this.view.provider) {
      this.view.provider.bytes = event.bytes;
      if (event.firstOutputMilliseconds !== undefined) this.view.provider.firstOutputMilliseconds = event.firstOutputMilliseconds;
    } else if (event.type === "provider-end" && this.view.provider) {
      this.view.provider.exitCode = event.exitCode;
      this.view.provider.bytes = event.bytes;
      addUsage(this.view.usage, event.usage);
      this.view.recent.push(`provider · encerrado com exit ${event.exitCode}`);
    } else if (event.type === "stage") {
      this.view.stage = event.stage;
      this.view.recent.push(`etapa · ${HARNESS_STAGE_LABELS[event.stage]}`);
    } else if (event.type === "activity") this.view.recent.push(event.message);
    this.view.recent = this.view.recent.slice(-12);
    this.render();
  }

  pause(): void {
    if (!this.enabled) return;
    this.view.paused = true;
    process.stdout.write("\u001b[2J\u001b[H\u001b[?25h");
  }

  resume(): void {
    if (!this.enabled) return;
    this.view.paused = false;
    process.stdout.write("\u001b[?25l");
    this.render();
  }

  finish(): void {
    if (this.timer) clearInterval(this.timer);
    this.view.final = true;
    this.render();
    if (this.enabled) process.stdout.write("\u001b[?25h");
  }

  isEnabled(): boolean { return this.enabled; }

  private render(): void {
    if (!this.enabled || this.view.paused) return;
    process.stdout.write(`\u001b[2J\u001b[H${renderHarnessDashboard(this.view, Number(process.env.RB_HARNESS_DASHBOARD_COLS) || undefined)}`);
  }
}

export function startHarnessDashboard(version: string): void {
  if (active) return;
  active = new HarnessDashboard(version);
  active.start();
}

export function emitHarnessDashboard(event: DashboardEvent): void {
  active?.event(event);
}

export function pauseHarnessDashboard(): void { active?.pause(); }
export function resumeHarnessDashboard(): void { active?.resume(); }
export function harnessDashboardActive(): boolean { return Boolean(active?.isEnabled()); }

export function finishHarnessDashboard(): void {
  active?.finish();
  active = undefined;
}

export interface InitDashboardSnapshot {
  readonly stage: string;
  readonly selectedProfileId: string;
  readonly transport: string;
  readonly requestAccounting: string;
  readonly questions: number;
  readonly semanticOperations: number;
  readonly transportInvocations: number;
  readonly correctiveRegenerations: number;
  readonly providerRequests: string;
  readonly terminalStatus?: string;
  readonly failureKind?: string;
  readonly publicationOccurred: boolean;
  readonly projectRoot?: string;
  readonly updatedAt?: string;
  readonly durationSeconds?: number;
  readonly lastActiveStage?: string;
  readonly events?: readonly InitDashboardRecentEvent[];
  readonly tokens?: string;
}

export interface InitDashboardRecentEvent {
  readonly at: string;
  readonly category: "workflow" | "etapa" | "provider" | "entrevista" | "correção" | "publicação" | "erro";
  readonly message: string;
  readonly tone?: "normal" | "success" | "running" | "failed";
}

export type InitDashboardLayout = "wide" | "medium" | "narrow";

export interface InitDashboardCapabilities {
  readonly width: number;
  readonly height: number;
  readonly color: boolean;
  readonly unicode: boolean;
  readonly trueColor?: boolean;
}

export interface DashboardViewModel {
  readonly version: string;
  readonly layout: InitDashboardLayout;
  readonly project: string;
  readonly workflow: "init";
  readonly stage: string;
  readonly lastActiveStage: string;
  readonly status: "running" | "success" | "failed";
  readonly statusLabel: string;
  readonly duration: string;
  readonly profile: string;
  readonly transport: string;
  readonly requestAccounting: string;
  readonly questions: number;
  readonly semanticOperations: number;
  readonly transportInvocations: number;
  readonly correctiveRegenerations: number;
  readonly providerRequests: string;
  readonly publication: string;
  readonly tokens: string;
  readonly failureKind?: string;
  readonly events: readonly InitDashboardRecentEvent[];
}

type DashboardTone =
  | "border"
  | "heading"
  | "label"
  | "value"
  | "muted"
  | "subtle"
  | "running"
  | "success"
  | "failed"
  | "accent";

/** Reference dashboard palette: dark slate ground, cyan chrome, amber/green state. */
const TONE_RGB: Readonly<Record<DashboardTone, string>> = {
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

const TONE_BASIC: Readonly<Record<DashboardTone, string>> = {
  border: C.cyan,
  heading: C.cyan,
  label: C.cyan,
  value: C.white,
  muted: C.grey,
  subtle: C.grey,
  running: C.yellow,
  success: C.green,
  failed: C.red,
  accent: C.magenta,
};

const INIT_PIPELINE = [
  { label: "pedido", stages: ["request-received"] },
  { label: "intent", stages: ["intent-requested", "intent-decoded"] },
  { label: "entrevista", stages: ["interview-pending"] },
  { label: "decisões", stages: ["intent-resolved"] },
  { label: "work", stages: ["work-requested", "work-resolved"] },
  { label: "closure", stages: ["deterministic-closure", "published"] },
] as const;

const PIPELINE_STATUS: Readonly<Record<"done" | "running" | "pending" | "failed", string>> = {
  done: "concluído",
  running: "em andamento",
  pending: "aguardando",
  failed: "falhou",
};

const PIPELINE_NOTE = "Somente metadados operacionais seguros; o painel não altera a execução.";
const HEADER_SUBTITLE = "INIT · DOCUMENTAÇÃO · HARNESS CONTROL PLANE";
const HEADER_TAGLINE = "HARNESS · capivara documentadora";
const HEADER_MARGIN = 2;
const FOOTER_HINT = "Ctrl-C interrompe com estado retomável · segredos nunca entram neste painel";

/**
 * Three-row half-block display face used for the single RB HARNESS wordmark.
 * Each glyph is a 4 × 6 pixel cell folded into 4 × 3 terminal cells, which
 * reproduces the reference wordmark's chunky upper-left presence.
 */
const WORDMARK_GLYPHS: Readonly<Record<string, readonly [string, string, string]>> = {
  R: ["█▀▀▄", "█▄▄▀", "█ ▀▄"],
  B: ["█▀▀▄", "█▀▀▄", "█▄▄▀"],
  H: ["█  █", "█▀▀█", "█  █"],
  A: ["▄▀▀▄", "█▄▄█", "█  █"],
  N: ["█▄ █", "█▀▄█", "█ ▀█"],
  E: ["█▀▀▀", "█▀▀ ", "█▄▄▄"],
  S: ["▄▀▀▀", " ▀▀▄", "▀▄▄▀"],
  " ": ["  ", "  ", "  "],
};

function wordmarkRows(text = "RB HARNESS"): string[] {
  const rows = ["", "", ""];
  [...text].forEach((character, index) => {
    const glyph = WORDMARK_GLYPHS[character] ?? WORDMARK_GLYPHS[" "]!;
    for (let row = 0; row < rows.length; row += 1) rows[row] += `${index ? " " : ""}${glyph[row]}`;
  });
  return rows;
}

interface DashboardIcons {
  readonly project: string;
  readonly workflow: string;
  readonly stage: string;
  readonly status: string;
  readonly duration: string;
  readonly interview: string;
  readonly semantic: string;
  readonly invocations: string;
  readonly corrections: string;
  readonly requests: string;
  readonly publication: string;
  readonly tokens: string;
  readonly plug: string;
  readonly bullet: string;
  readonly dash: string;
  readonly rule: string;
  readonly separator: string;
}

const UNICODE_ICONS: DashboardIcons = {
  project: "▤", workflow: "◈", stage: "▸", status: "●", duration: "◷",
  interview: "▭", semantic: "◇", invocations: "↯", corrections: "↺",
  requests: "◌", publication: "↥", tokens: "{}", plug: "◉",
  bullet: "›", dash: "╌", rule: "─", separator: "┊",
};

const ASCII_ICONS: DashboardIcons = {
  project: "#", workflow: "%", stage: ">", status: "*", duration: "@",
  interview: "?", semantic: "&", invocations: "!", corrections: "~",
  requests: "o", publication: "^", tokens: "{}", plug: "+",
  bullet: ">", dash: "-", rule: "-", separator: ":",
};

function icons(unicode: boolean): DashboardIcons {
  return unicode ? UNICODE_ICONS : ASCII_ICONS;
}

function styled(value: string, tone: DashboardTone, capabilities: InitDashboardCapabilities, bold = false): string {
  if (!capabilities.color || value === "") return value;
  const paint = capabilities.trueColor ? `[38;2;${TONE_RGB[tone]}m` : TONE_BASIC[tone];
  return `${bold ? C.bold : ""}${paint}${value}${C.reset}`;
}

function frameCharacters(unicode: boolean): { readonly tl: string; readonly tr: string; readonly bl: string; readonly br: string; readonly h: string; readonly v: string } {
  return unicode
    ? { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" }
    : { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" };
}

/** A bordered section whose heading lives inside the frame, as in the reference. */
function panel(content: readonly string[], width: number, capabilities: InitDashboardCapabilities): string[] {
  const frame = frameCharacters(capabilities.unicode);
  const safeWidth = Math.max(12, width);
  const inner = safeWidth - 2;
  return [
    styled(`${frame.tl}${frame.h.repeat(inner)}${frame.tr}`, "border", capabilities),
    ...content.map((line) => `${styled(frame.v, "border", capabilities)}${fit(line, inner)}${styled(frame.v, "border", capabilities)}`),
    styled(`${frame.bl}${frame.h.repeat(inner)}${frame.br}`, "border", capabilities),
  ];
}

function heading(text: string, capabilities: InitDashboardCapabilities): string {
  return `  ${styled(text, "heading", capabilities, true)}`;
}

function joinColumns(left: readonly string[], right: readonly string[], leftWidth: number, rightWidth: number, gap = 2): string[] {
  const rows = Math.max(left.length, right.length);
  return Array.from({ length: rows }, (_, index) => `${fit(left[index] ?? "", leftWidth)}${" ".repeat(gap)}${fit(right[index] ?? "", rightWidth)}`);
}

function distribute(total: number, weights: readonly number[]): number[] {
  const usable = Math.max(weights.length, total);
  const sum = weights.reduce((value, weight) => value + weight, 0);
  const widths = weights.map((weight) => Math.max(1, Math.floor((usable * weight) / sum)));
  let remainder = usable - widths.reduce((value, width) => value + width, 0);
  for (let index = 0; remainder > 0; index = (index + 1) % widths.length, remainder -= 1) widths[index]! += 1;
  return widths;
}

function gridLine(cells: readonly string[], widths: readonly number[], capabilities: InitDashboardCapabilities): string {
  const separator = styled(icons(capabilities.unicode).separator, "border", capabilities);
  return cells.map((cell, index) => fit(cell, widths[index] ?? 1)).join(` ${separator} `);
}

function centeredCell(value: string, width: number): string {
  return `${" ".repeat(Math.max(0, Math.floor((width - terminalVisibleWidth(value)) / 2)))}${value}`;
}

function centeredTerminalLine(value: string, width: number): string {
  return centeredCell(value, width);
}

/** The full mascot is chosen independently from the panel-layout breakpoint. */
export function dashboardMascotVariant(width: number): "wide" | "compact" {
  return width >= 68 ? "wide" : "compact";
}

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

export function dashboardHeaderGeometry(capabilities: InitDashboardCapabilities): HeaderGeometry {
  const variant = dashboardMascotVariant(capabilities.width);
  const mascotWidth = harnessMascotDimensions(variant).width;
  const face = capabilities.unicode ? wordmarkRows() : ["RB HARNESS"];
  const faceWidth = face.reduce((maximum, row) => Math.max(maximum, terminalVisibleWidth(row)), 0);
  // The wordmark is never clipped: a terminal too narrow for the block face
  // keeps the plain one instead of losing the brand entirely.
  const wordmark = faceWidth + HEADER_MARGIN <= capabilities.width ? face : ["RB HARNESS"];
  const wordmarkWidth = wordmark.reduce((maximum, row) => Math.max(maximum, terminalVisibleWidth(row)), 0);
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

function dashboardHeader(view: DashboardViewModel, capabilities: InitDashboardCapabilities, compactHeight: boolean): string[] {
  const margin = " ".repeat(HEADER_MARGIN);
  const geometry = dashboardHeaderGeometry(capabilities);
  if (compactHeight && capabilities.height < 24) {
    return [
      `${margin}${styled("RB HARNESS", "heading", capabilities, true)}  ${styled(`v${view.version}`, "muted", capabilities)}`,
      `${margin}${styled(HEADER_SUBTITLE, "subtle", capabilities)}`,
    ].map((line) => truncateTerminalText(line, capabilities.width));
  }

  const mascot = renderHarnessMascot(geometry.variant, { color: capabilities.color, unicode: capabilities.unicode });
  const subtitle = styled(HEADER_SUBTITLE, "subtle", capabilities);
  const version = styled(`v${view.version}`, "muted", capabilities);
  const wordmark = geometry.wordmark.map((row) => styled(row, "heading", capabilities, true));

  if (!geometry.split) {
    const merged = geometry.variant === "compact"
      && terminalVisibleWidth(`${HEADER_SUBTITLE} · v${view.version}`) + HEADER_MARGIN <= capabilities.width;
    return [
      ...wordmark.map((row) => `${margin}${row}`),
      merged ? `${margin}${subtitle} ${styled("·", "muted", capabilities)} ${version}` : `${margin}${subtitle}`,
      ...(merged ? [] : [`${margin}${" ".repeat(Math.floor(geometry.wordmarkWidth / 2))}${version}`]),
      ...mascot.map((row) => centeredTerminalLine(row, capabilities.width)),
    ].map((line) => truncateTerminalText(line, capabilities.width));
  }

  const rows = mascot.length;
  const left = Array.from({ length: rows }, () => "");
  const right = Array.from({ length: rows }, () => "");
  wordmark.forEach((row, index) => { left[index] = row; });
  left[Math.min(wordmark.length, rows - 1)] = subtitle;
  left[Math.min(wordmark.length + 2, rows - 1)] = `${" ".repeat(Math.floor(geometry.wordmarkWidth / 2))}${version}`;
  // Width pressure removes the secondary tagline before it ever touches the mascot.
  if (geometry.rightWidth >= HEADER_TAGLINE.length + 2) {
    right[Math.min(wordmark.length + 2, rows - 1)] = styled(HEADER_TAGLINE, "muted", capabilities);
  }

  return Array.from({ length: rows }, (_, index) => {
    const rightText = right[index] ?? "";
    const rightCell = rightText
      ? `${" ".repeat(Math.max(0, geometry.rightWidth - 1 - terminalVisibleWidth(rightText)))}${rightText}`
      : "";
    return truncateTerminalText(`${fit(`${margin}${left[index] ?? ""}`, geometry.leftWidth)} ${mascot[index] ?? ""}${rightCell}`, capabilities.width);
  });
}

function pipelineState(view: DashboardViewModel, index: number): "done" | "running" | "failed" | "pending" {
  if (view.status === "success") return "done";
  const activeStage = view.status === "failed" ? view.lastActiveStage : view.stage;
  const activeIndex = INIT_PIPELINE.findIndex((entry) => entry.stages.some((stage) => stage === activeStage));
  if (activeIndex < 0) return "pending";
  if (index < activeIndex) return "done";
  if (index === activeIndex) return view.status === "failed" ? "failed" : "running";
  return "pending";
}

function pipelineTone(state: ReturnType<typeof pipelineState>): DashboardTone {
  if (state === "done") return "success";
  if (state === "running") return "running";
  if (state === "failed") return "failed";
  return "muted";
}

function pipelineNode(state: ReturnType<typeof pipelineState>, capabilities: InitDashboardCapabilities): string {
  const tone = pipelineTone(state);
  const mark = state === "done"
    ? (capabilities.unicode ? "✓" : "x")
    : state === "running"
      ? (capabilities.unicode ? "●" : "*")
      : state === "failed"
        ? (capabilities.unicode ? "✕" : "!")
        : " ";
  return `${styled("[", tone, capabilities)}${styled(mark, tone, capabilities, true)}${styled("]", tone, capabilities)}`;
}

function anchoredRow(
  entries: readonly { readonly text: string; readonly tone: DashboardTone; readonly bold?: boolean }[],
  centers: readonly number[],
  capabilities: InitDashboardCapabilities,
): string {
  let row = "";
  let column = 0;
  entries.forEach((entry, index) => {
    const size = terminalVisibleWidth(entry.text);
    const start = Math.max(column, (centers[index] ?? column) - Math.floor(size / 2));
    row += `${" ".repeat(start - column)}${styled(entry.text, entry.tone, capabilities, entry.bold === true)}`;
    column = start + size;
  });
  return row;
}

/** A progress rail: boxed nodes, dashed connectors, stage names and states. */
function pipelineRail(view: DashboardViewModel, inner: number, capabilities: InitDashboardCapabilities): string[] {
  const glyph = icons(capabilities.unicode);
  const steps = INIT_PIPELINE.map((step, index) => {
    const state = pipelineState(view, index);
    return { label: step.label, state, status: PIPELINE_STATUS[state] };
  });
  const cells = steps.map((step) => Math.max(3, terminalVisibleWidth(step.label), terminalVisibleWidth(step.status)));
  const spare = inner - cells.reduce((total, cell) => total + cell, 0);
  const gap = Math.max(1, Math.floor(spare / Math.max(1, steps.length - 1)));
  const centers: number[] = [];
  let cursor = 0;
  for (const cell of cells) {
    centers.push(cursor + Math.floor(cell / 2));
    cursor += cell + gap;
  }
  // Anchor the rail at the panel edge so it opens on a node, never on connector dashes.
  const lead = Math.max(0, (centers[0] ?? 1) - 1);
  for (let index = 0; index < centers.length; index += 1) centers[index] = Math.max(1, centers[index]! - lead);

  let rail = "";
  let column = 0;
  steps.forEach((step, index) => {
    const start = Math.max(column, (centers[index] ?? 0) - 1);
    if (start > column) rail += styled(glyph.dash.repeat(start - column), "muted", capabilities);
    rail += pipelineNode(step.state, capabilities);
    column = start + 3;
  });

  return [
    rail,
    anchoredRow(steps.map((step) => ({ text: step.label, tone: pipelineTone(step.state), bold: step.state !== "pending" })), centers, capabilities),
    anchoredRow(steps.map((step) => ({ text: step.status, tone: "muted" as DashboardTone })), centers, capabilities),
  ];
}

function pipelinePanel(view: DashboardViewModel, width: number, capabilities: InitDashboardCapabilities, compactHeight: boolean): string[] {
  const glyph = icons(capabilities.unicode);
  const inner = width - 2;
  const title = heading("PIPELINE · FLUXO DE EXECUÇÃO", capabilities);
  if (view.layout === "narrow") {
    const states = INIT_PIPELINE.map((_, index) => pipelineState(view, index));
    if (compactHeight) {
      const active = states.findIndex((state) => state === "running" || state === "failed");
      const step = INIT_PIPELINE[active < 0 ? INIT_PIPELINE.length - 1 : active]!;
      return panel([
        title,
        `  ${states.map((state) => pipelineNode(state, capabilities)).join("")}`,
        `  ${styled(step.label, pipelineTone(states[active < 0 ? states.length - 1 : active]!), capabilities, true)} ${styled(PIPELINE_STATUS[states[active < 0 ? states.length - 1 : active]!], "muted", capabilities)}`,
      ], width, capabilities);
    }
    const steps = INIT_PIPELINE.map((step, index) => `  ${pipelineNode(states[index]!, capabilities)} ${fit(styled(step.label, pipelineTone(states[index]!), capabilities), 12)}${styled(PIPELINE_STATUS[states[index]!], "muted", capabilities)}`);
    return panel([title, ...steps], width, capabilities);
  }
  const rail = pipelineRail(view, Math.max(12, inner - 3), capabilities).map((line) => `  ${line}`);
  const note = `  ${styled(truncateTerminalText(PIPELINE_NOTE, Math.max(4, inner - 3)), "muted", capabilities)}`;
  return panel(compactHeight ? [title, ...rail] : [title, "", ...rail, note], width, capabilities);
}

function providerPanel(view: DashboardViewModel, width: number, capabilities: InitDashboardCapabilities, compactHeight: boolean): string[] {
  const glyph = icons(capabilities.unicode);
  const inner = width - 2;
  const labelWidth = Math.min(15, Math.max(11, Math.floor(inner * 0.26)));
  const valueWidth = Math.max(6, inner - 2 - labelWidth - 1);
  const entry = (label: string, value: string, tone: DashboardTone = "value"): string =>
    `  ${fit(styled(label, "label", capabilities), labelWidth)}${styled(truncateTerminalText(value, valueWidth), tone, capabilities)}`;
  const title = heading("PROVEDOR ATUAL", capabilities);
  const titleGap = Math.max(1, inner - 2 - terminalVisibleWidth("PROVEDOR ATUAL") - terminalVisibleWidth(glyph.plug) - 2);
  const titleLine = `${title}${" ".repeat(titleGap)}${styled(glyph.plug, "accent", capabilities)}`;
  const lines = compactHeight
    ? [titleLine, entry("perfil", view.profile), entry("transporte", `${view.transport} · ${view.requestAccounting}`)]
    : [titleLine, "", entry("perfil", view.profile), entry("transporte", view.transport), entry("contabilidade", view.requestAccounting)];
  return panel(lines, width, capabilities);
}

const SUMMARY_WEIGHTS = [3.3, 1.45, 2.05, 1.85, 1.6] as const;

function summaryPanel(view: DashboardViewModel, capabilities: InitDashboardCapabilities, compactHeight: boolean): string[] {
  const glyph = icons(capabilities.unicode);
  const statusTone: DashboardTone = view.status === "failed" ? "failed" : view.status === "success" ? "success" : "running";
  const currentStage = view.status === "failed" ? view.lastActiveStage : view.stage;
  const cells = [
    { label: "PROJETO", icon: glyph.project, value: view.project, tone: "value" as DashboardTone, iconTone: "label" as DashboardTone },
    { label: "WORKFLOW", icon: glyph.workflow, value: view.workflow, tone: "value" as DashboardTone, iconTone: "label" as DashboardTone },
    { label: "ETAPA ATUAL", icon: glyph.stage, value: currentStage, tone: "heading" as DashboardTone, iconTone: "label" as DashboardTone },
    { label: "STATUS", icon: glyph.status, value: view.statusLabel, tone: statusTone, iconTone: statusTone },
    { label: "DURAÇÃO", icon: glyph.duration, value: view.duration, tone: "value" as DashboardTone, iconTone: "label" as DashboardTone },
  ];

  if (view.layout === "narrow") {
    const rows = compactHeight ? cells.filter((cell) => cell.label !== "WORKFLOW" && cell.label !== "DURAÇÃO") : cells;
    return panel([
      heading("RESUMO", capabilities),
      ...rows.map((cell) => `  ${styled(cell.icon, cell.iconTone, capabilities)} ${fit(styled(cell.label, "label", capabilities), 13)}${styled(truncateTerminalText(cell.value, Math.max(4, capabilities.width - 20)), cell.tone, capabilities)}`),
    ], capabilities.width, capabilities);
  }

  const widths = distribute(capabilities.width - 2 - (cells.length - 1) * 3, SUMMARY_WEIGHTS);
  return panel([
    gridLine(cells.map((cell) => `   ${styled(cell.label, "heading", capabilities)}`), widths, capabilities),
    gridLine(cells.map((cell, index) => `   ${styled(cell.icon, cell.iconTone, capabilities)}  ${styled(truncateTerminalText(cell.value, Math.max(3, (widths[index] ?? 8) - 6)), cell.tone, capabilities)}`), widths, capabilities),
  ], capabilities.width, capabilities);
}

function telemetryPanel(view: DashboardViewModel, capabilities: InitDashboardCapabilities, compactHeight: boolean): string[] {
  const glyph = icons(capabilities.unicode);
  const publicationTone: DashboardTone = view.status === "success" ? "success" : view.status === "failed" ? "failed" : "running";
  const metrics = [
    { label: "ENTREVISTA", short: "ENTREVISTA", icon: glyph.interview, iconTone: "label" as DashboardTone, value: `${view.questions} pergunta(s)`, tone: "value" as DashboardTone, weight: 1.55 },
    { label: "OPERAÇÕES SEMÂNTICAS", short: "OPERAÇÕES", icon: glyph.semantic, iconTone: "label" as DashboardTone, value: String(view.semanticOperations), tone: "value" as DashboardTone, weight: 1.8 },
    { label: "INVOCAÇÕES", short: "INVOCAÇÕES", icon: glyph.invocations, iconTone: "label" as DashboardTone, value: String(view.transportInvocations), tone: "value" as DashboardTone, weight: 1.2 },
    { label: "CORREÇÕES", short: "CORREÇÕES", icon: glyph.corrections, iconTone: "accent" as DashboardTone, value: String(view.correctiveRegenerations), tone: (view.correctiveRegenerations > 0 ? "accent" : "value") as DashboardTone, weight: 1.1 },
    { label: "PROVIDER REQUESTS", short: "REQUESTS", icon: glyph.requests, iconTone: "label" as DashboardTone, value: view.providerRequests, tone: (/^\d+$/.test(view.providerRequests) ? "value" : "muted") as DashboardTone, weight: 1.7 },
    { label: "PUBLICAÇÃO", short: "PUBLICAÇÃO", icon: glyph.publication, iconTone: publicationTone, value: view.publication, tone: publicationTone, weight: 1.3 },
    { label: "TOKENS", short: "TOKENS", icon: glyph.tokens, iconTone: "label" as DashboardTone, value: view.tokens, tone: (/^\d/.test(view.tokens) ? "value" : "muted") as DashboardTone, weight: 1.35 },
  ];
  const columns = view.layout === "wide" && !compactHeight ? metrics.length : view.layout === "narrow" ? 3 : 4;
  // One width vector for every metric row keeps the dotted separators aligned.
  const columnWeights = Array.from({ length: columns }, (_, column) => {
    let weight = 0;
    for (let index = column; index < metrics.length; index += columns) weight = Math.max(weight, metrics[index]!.weight);
    return weight;
  });
  const widths = distribute(capabilities.width - 2 - (columns - 1) * 3, columnWeights);
  const rows: string[] = [heading("TELEMETRIA", capabilities)];
  for (let offset = 0; offset < metrics.length; offset += columns) {
    const group = Array.from({ length: columns }, (_, index) => metrics[offset + index]);
    rows.push(gridLine(group.map((metric, index) => {
      const cell = widths[index] ?? 8;
      if (!metric) return "";
      const label = terminalVisibleWidth(metric.label) <= cell ? metric.label : metric.short;
      return centeredCell(styled(truncateTerminalText(label, cell), "heading", capabilities), cell);
    }), widths, capabilities));
    rows.push(gridLine(group.map((metric, index) => {
      const cell = widths[index] ?? 8;
      if (!metric) return "";
      const budget = Math.max(3, cell - terminalVisibleWidth(metric.icon) - 1);
      return centeredCell(`${styled(metric.icon, metric.iconTone, capabilities)} ${styled(truncateTerminalText(metric.value, budget), metric.tone, capabilities)}`, cell);
    }), widths, capabilities));
  }
  return panel(rows, capabilities.width, capabilities);
}

/** The active provider never disappears: a short terminal keeps it as one line. */
function providerStrip(view: DashboardViewModel, capabilities: InitDashboardCapabilities): string {
  const label = styled("provedor", "label", capabilities);
  return truncateTerminalText(`  ${label} ${styled(`${view.profile} · ${view.transport} · ${view.requestAccounting}`, "value", capabilities)}`, capabilities.width);
}

/** Telemetry never disappears: a short terminal keeps it as one dense line. */
function telemetryStrip(view: DashboardViewModel, capabilities: InitDashboardCapabilities): string {
  const parts = [
    `entrevista ${view.questions}`,
    `semânticas ${view.semanticOperations}`,
    `invocações ${view.transportInvocations}`,
    `correções ${view.correctiveRegenerations}`,
    `requests ${view.providerRequests}`,
    `publicação ${view.publication}`,
    `tokens ${view.tokens}`,
  ];
  return truncateTerminalText(`  ${styled(parts.join(" · "), "muted", capabilities)}`, capabilities.width);
}

function eventsPanel(view: DashboardViewModel, capabilities: InitDashboardCapabilities, maximum: number): string[] {
  const glyph = icons(capabilities.unicode);
  const events = view.events.slice(-maximum);
  const lines = [heading("EVENTOS RECENTES", capabilities)];
  if (events.length === 0) lines.push(`  ${styled("aguardando eventos da execução", "muted", capabilities)}`);
  // The event area keeps a fixed height so the frame never jumps while a run advances.
  for (const event of events) {
    const tone: DashboardTone = event.tone === "failed"
      ? "failed"
      : event.tone === "success" ? "success" : event.tone === "running" ? "running" : "value";
    const prefix = `  ${styled(glyph.bullet, "muted", capabilities)} ${styled(`[${event.at}]`, "heading", capabilities)}   `;
    const budget = Math.max(4, capabilities.width - 4 - terminalVisibleWidth(stripTerminalAnsi(prefix)) - terminalVisibleWidth(event.category) - 3);
    lines.push(`${prefix}${styled(event.category, "value", capabilities)} ${styled("·", "muted", capabilities)} ${styled(truncateTerminalText(event.message, budget), tone, capabilities)}`);
  }
  while (lines.length < maximum + 1) lines.push("");
  return panel(lines, capabilities.width, capabilities);
}

export function deriveInitDashboardViewModel(
  state: InitDashboardSnapshot,
  version: string,
  capabilities: InitDashboardCapabilities,
): DashboardViewModel {
  const status = state.terminalStatus === "failed" || state.stage === "failed"
    ? "failed"
    : state.publicationOccurred || state.terminalStatus === "published"
      ? "success"
      : "running";
  return {
    version: clean(version),
    layout: capabilities.width >= 120 ? "wide" : capabilities.width >= 76 ? "medium" : "narrow",
    project: clean(state.projectRoot || process.cwd()),
    workflow: "init",
    stage: clean(state.stage),
    lastActiveStage: clean(state.lastActiveStage || state.stage),
    status,
    statusLabel: status === "success" ? "concluído" : status === "failed" ? "falhou" : "em andamento",
    duration: duration(Math.max(0, Math.floor(state.durationSeconds ?? 0))),
    profile: clean(state.selectedProfileId),
    transport: clean(state.transport),
    requestAccounting: clean(state.requestAccounting),
    questions: state.questions,
    semanticOperations: state.semanticOperations,
    transportInvocations: state.transportInvocations,
    correctiveRegenerations: state.correctiveRegenerations,
    providerRequests: clean(state.providerRequests),
    publication: state.publicationOccurred ? "concluída" : status === "failed" ? "não publicada" : "pendente",
    tokens: clean(state.tokens ?? "não medido"),
    ...(state.failureKind ? { failureKind: clean(state.failureKind) } : {}),
    events: (state.events ?? []).slice(-12).map((event) => ({ ...event, at: clean(event.at), message: clean(event.message) })),
  };
}

/** A safe projection of canonical Init orchestration state; no semantic text is rendered. */
export function renderInitDashboard(
  state: InitDashboardSnapshot,
  version: string,
  requestedWidth = 92,
  options: { readonly height?: number; readonly color?: boolean; readonly unicode?: boolean; readonly trueColor?: boolean } = {},
): string {
  const width = Math.max(32, Math.floor(requestedWidth || 92));
  const height = Math.max(12, Math.floor(options.height ?? process.stdout.rows ?? 40));
  const color = options.color ?? (!("NO_COLOR" in process.env) && process.env.TERM !== "dumb");
  const capabilities: InitDashboardCapabilities = {
    width,
    height,
    color,
    unicode: options.unicode ?? process.env.TERM !== "dumb",
    trueColor: options.trueColor ?? (color && /truecolor|24bit/i.test(process.env.COLORTERM ?? "")),
  };
  const view = deriveInitDashboardViewModel(state, version, capabilities);
  const compactHeight = height < (view.layout === "narrow" ? 40 : 30);
  const glyph = icons(capabilities.unicode);
  const lines: string[] = [...dashboardHeader(view, capabilities, compactHeight)];
  lines.push(styled(glyph.rule.repeat(width), "border", capabilities));
  lines.push(...summaryPanel(view, capabilities, compactHeight));

  const pipelineWidth = view.layout === "wide" ? Math.max(58, Math.floor(width * 0.62)) : width;
  const providerWidth = width - pipelineWidth - 2;
  const pipeline = pipelinePanel(view, pipelineWidth, capabilities, compactHeight);
  const provider = providerPanel(view, view.layout === "wide" ? providerWidth : width, capabilities, compactHeight);
  if (view.layout === "wide") lines.push(...joinColumns(pipeline, provider, pipelineWidth, providerWidth));
  else lines.push(...pipeline);

  const failure = view.failureKind
    ? truncateTerminalText(`  ${styled("ERRO", "failed", capabilities, true)} ${styled(view.failureKind, "failed", capabilities)}`, width)
    : undefined;
  // Secondary sections yield rows in this order so state stays legible when the
  // terminal is short: recent events first, then the provider, then telemetry.
  const budget = Math.max(lines.length, height - 1 - (failure ? 1 : 0));
  const telemetry = telemetryPanel(view, capabilities, compactHeight);
  const telemetryRows = lines.length + telemetry.length <= budget ? telemetry : [telemetryStrip(view, capabilities)];
  if (view.layout !== "wide") {
    const stacked = lines.length + telemetryRows.length + provider.length <= budget ? provider : [providerStrip(view, capabilities)];
    if (lines.length + telemetryRows.length + stacked.length <= budget) lines.push(...stacked);
  }
  if (lines.length + telemetryRows.length <= budget) lines.push(...telemetryRows);
  const eventCapacity = Math.max(0, Math.min(6, budget - lines.length - 3));
  if (eventCapacity > 0) lines.push(...eventsPanel(view, capabilities, eventCapacity));
  if (failure) lines.push(failure);
  const footer = view.status === "success"
    ? `${styled("Ralph READY", "success", capabilities, true)} · execução concluída · segredos nunca entram neste painel`
    : styled(FOOTER_HINT, "muted", capabilities);
  lines.push(truncateTerminalText(`  ${footer}`, width));
  return `${lines.slice(0, Math.max(1, height)).join("\n")}\n`;
}

interface InitDashboardWritable {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
  write(value: string): unknown;
}

export interface InitDashboardController {
  start(): void;
  state(snapshot: InitDashboardSnapshot): void;
  pause(): void;
  resume(): void;
  finish(): void;
}

function isoTime(value?: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value ?? "") ? value!.slice(11, 19) : new Date().toISOString().slice(11, 19);
}

export function createInitDashboardController(
  version: string,
  projectRoot: string,
  output: InitDashboardWritable = process.stdout,
): InitDashboardController {
  const startedAt = Date.now();
  let enabled = false;
  let paused = false;
  let last: InitDashboardSnapshot | undefined;
  let lastActiveStage = "request-received";
  let events: InitDashboardRecentEvent[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;

  const record = (event: InitDashboardRecentEvent): void => {
    events = [...events, event].slice(-12);
  };
  const safeWrite = (value: string): void => {
    try { output.write(value); } catch { /* presentation must never affect execution */ }
  };
  const render = (): void => {
    if (!enabled || paused || !last) return;
    const snapshot = {
      ...last,
      projectRoot,
      lastActiveStage,
      durationSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1_000)),
      events,
    };
    try {
      safeWrite(`\u001b[2J\u001b[H${renderInitDashboard(snapshot, version, output.columns || 92, { height: output.rows || 40 })}`);
    } catch { /* renderer failures are cosmetic */ }
  };
  const cleanup = (): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (enabled) safeWrite(`${C.reset}\u001b[?25h`);
    enabled = false;
    paused = false;
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    cleanup();
    process.removeListener(signal, signal === "SIGINT" ? onSigint : onSigterm);
    try { process.kill(process.pid, signal); } catch { /* process is already terminating */ }
  };
  const onSigint = (): void => onSignal("SIGINT");
  const onSigterm = (): void => onSignal("SIGTERM");

  return {
    start(): void {
      if (!output.isTTY) {
        try { process.stderr.write("[rb-harness] --dashboard requer um terminal; seguindo com o log textual.\n"); } catch { /* cosmetic */ }
        return;
      }
      enabled = true;
      safeWrite("\u001b[?25l");
      process.once("SIGINT", onSigint);
      process.once("SIGTERM", onSigterm);
      timer = setInterval(render, 1_000);
      timer.unref();
    },
    state(snapshot): void {
      try {
        const at = isoTime(snapshot.updatedAt);
        if (!last) {
          record({ at, category: "workflow", message: "init · iniciado", tone: "running" });
          record({ at, category: "provider", message: `${clean(snapshot.selectedProfileId)} · ativo`, tone: "running" });
          record({ at, category: "publicação", message: "pendente" });
        }
        if (snapshot.stage !== "failed") lastActiveStage = snapshot.stage;
        if (last && snapshot.stage !== last.stage) {
          record({ at, category: "etapa", message: `${clean(snapshot.stage)} · ${snapshot.stage === "published" ? "concluída" : snapshot.stage === "failed" ? "falhou" : "em andamento"}`, tone: snapshot.stage === "published" ? "success" : snapshot.stage === "failed" ? "failed" : "running" });
        }
        if (last && snapshot.questions > last.questions) record({ at, category: "entrevista", message: `${snapshot.questions} pergunta(s) registrada(s)` });
        if (last && snapshot.correctiveRegenerations > last.correctiveRegenerations) record({ at, category: "correção", message: `${snapshot.correctiveRegenerations} regeneração(ões)`, tone: "running" });
        if (snapshot.stage === "failed" && snapshot.failureKind) record({ at, category: "erro", message: clean(snapshot.failureKind), tone: "failed" });
        last = { ...snapshot };
        render();
      } catch { /* observer mutation/rendering must never affect semantics */ }
    },
    pause(): void {
      if (!enabled) return;
      paused = true;
      safeWrite(`\u001b[2J\u001b[H${C.reset}\u001b[?25h`);
    },
    resume(): void {
      if (!enabled) return;
      paused = false;
      safeWrite("\u001b[?25l");
      render();
    },
    finish(): void {
      render();
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      cleanup();
    },
  };
}

let defaultInitController: InitDashboardController | undefined;

/** Compatibility wrappers for callers outside the canonical Init command. */
export function startInitDashboard(version = "", projectRoot = process.cwd()): void {
  defaultInitController = createInitDashboardController(version, projectRoot);
  defaultInitController.start();
}

export function emitInitDashboard(state: InitDashboardSnapshot, version = ""): void {
  defaultInitController ??= createInitDashboardController(version, state.projectRoot ?? process.cwd());
  defaultInitController.state(state);
}

export function pauseInitDashboard(): void { defaultInitController?.pause(); }
export function resumeInitDashboard(): void { defaultInitController?.resume(); }

export function finishInitDashboard(): void {
  defaultInitController?.finish();
  defaultInitController = undefined;
}
