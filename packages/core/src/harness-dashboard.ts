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

function visible(value: string): number {
  return value.replace(/\u001b\[[0-9;]*m/g, "").length;
}

function fit(value: string, width: number): string {
  const plain = value.replace(/\u001b\[[0-9;]*m/g, "");
  if (plain.length <= width) return `${value}${" ".repeat(width - plain.length)}`;
  return `${plain.slice(0, Math.max(0, width - 1))}…`;
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
  const mascot = [
    "    ╭─╮          ╭─╮",
    "  ╭─╯ ╰──────────╯ ╰─╮",
    "  │     ◕      ◕     │",
    "  ╰──╮  ╭──────╮  ╭──╯",
    "     ╰──┤ ▪  ▪ ├──╯",
    "        ╰──◡◡──╯          HARNESS · capivara documentadora",
  ];
  return logo.map((line, index) => `${index < 2 ? `${C.bold}${C.cyan}` : C.dim}${line.padEnd(44)}${C.reset}${index < 2 ? C.magenta : C.grey}${mascot[index]}${C.reset}`);
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
