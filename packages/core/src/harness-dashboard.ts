import type { HarnessRunState } from "./standalone-types.js";
import type { ProviderMode } from "./harness-provider.js";

type DashboardEvent =
  | { type: "state"; state: HarnessRunState }
  | { type: "provider-start"; provider: string; model: string; mode: ProviderMode }
  | { type: "provider-output"; bytes: number; firstOutputMilliseconds?: number }
  | { type: "provider-end"; exitCode: number; bytes: number }
  | { type: "activity"; message: string };

interface ViewState {
  version: string;
  startedAt: number;
  state?: HarnessRunState;
  provider?: { name: string; model: string; mode: ProviderMode; startedAt: number; bytes: number; firstOutputMilliseconds?: number; exitCode?: number };
  recent: string[];
  paused: boolean;
  final: boolean;
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

function stageState(status: HarnessRunState["status"] | undefined, stage: string): "done" | "run" | "wait" | "fail" {
  const order = ["interview", "generating", "validating", "publishing", "complete"];
  if (!status) return "wait";
  if (status.endsWith("failed") || status === "blocked") {
    const failedStage = status.startsWith("interview") ? "interview" : "generating";
    const failedIndex = order.indexOf(failedStage);
    const targetIndex = order.indexOf(stage);
    if (targetIndex < failedIndex) return "done";
    return stage === failedStage ? "fail" : "wait";
  }
  const normalized = status === "auditing" ? "validating" : status;
  const current = order.indexOf(normalized);
  const target = order.indexOf(stage);
  if (status === "complete" || (current >= 0 && target < current)) return "done";
  if (target === current) return "run";
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
  lines.push(border("PIPELINE", width));
  const stages: Array<[string, string]> = [
    ["interview", "Entrevista"], ["generating", "Geração"], ["validating", "Contrato"],
    ["publishing", "Publicação"],
  ];
  lines.push(row(stages.map(([key, label]) => `${stageMark(stageState(state?.status, key))} ${label}`).join("    "), width));
  const legacyAudits = state?.artifactAudits?.length ?? 0;
  lines.push(row(`${C.cyan}status${C.reset} ${C.white}${clean(state?.status || "inicializando")}${C.reset}    ${C.cyan}respostas${C.reset} ${state?.answers.length ?? 0}    ${C.cyan}gate${C.reset} contrato determinístico${legacyAudits ? ` · ${legacyAudits} auditoria(s) legada(s)` : ""}`, width));
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
    this.view = { version, startedAt: Date.now(), recent: [], paused: false, final: false };
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
      this.view.recent.push(`estado · ${event.state.status}`);
    } else if (event.type === "provider-start") {
      this.view.provider = { name: event.provider, model: event.model, mode: event.mode, startedAt: Date.now(), bytes: 0 };
      this.view.recent.push(`provider · ${event.mode} iniciado`);
    } else if (event.type === "provider-output" && this.view.provider) {
      this.view.provider.bytes = event.bytes;
      if (event.firstOutputMilliseconds !== undefined) this.view.provider.firstOutputMilliseconds = event.firstOutputMilliseconds;
    } else if (event.type === "provider-end" && this.view.provider) {
      this.view.provider.exitCode = event.exitCode;
      this.view.provider.bytes = event.bytes;
      this.view.recent.push(`provider · encerrado com exit ${event.exitCode}`);
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
