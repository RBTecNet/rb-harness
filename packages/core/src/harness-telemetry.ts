/**
 * Documentation-stage progress and provider telemetry.
 *
 * Repeated bytes are not progress. The dashboard, the log, and the final
 * report all describe the documentation state machine, and provider cost is
 * reported only from what the provider actually measured: a CLI adapter that
 * exposes no usage is recorded as `measured: false` rather than being given an
 * invented token or price estimate.
 */

export const HARNESS_TELEMETRY_CONTRACT = "rb-harness-telemetry/v1" as const;

export type HarnessStage =
  | "inventory"
  | "gap-analysis"
  | "awaiting-human"
  | "evidence"
  | "generation"
  | "materialization"
  | "validation"
  | "structural-repair"
  | "publication";

export const HARNESS_STAGES: readonly HarnessStage[] = [
  "inventory",
  "gap-analysis",
  "awaiting-human",
  "evidence",
  "generation",
  "materialization",
  "validation",
  "structural-repair",
  "publication",
] as const;

export const HARNESS_STAGE_LABELS: Readonly<Record<HarnessStage, string>> = {
  "inventory": "Inventário",
  "gap-analysis": "Análise de lacunas",
  "awaiting-human": "Aguardando resposta",
  "evidence": "Descoberta de evidências",
  "generation": "Geração do pacote",
  "materialization": "Materialização",
  "validation": "Validação",
  "structural-repair": "Correção estrutural",
  "publication": "Publicação",
};

export interface ProviderUsage {
  /** Whether the provider reported usage at all. */
  measured: boolean;
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  toolCalls: number;
  /**
   * How the output was spent, counted apart. A call can report a large
   * `outputTokens` and still have produced no answer, because every token went
   * to reasoning; only these two counters make that visible. They hold sizes
   * and counts — never reasoning text, artifact fragments, tool arguments,
   * credentials, or prompts.
   */
  reasoningEvents: number;
  contentEvents: number;
  reasoningBytes: number;
  contentBytes: number;
  /** Provider-reported USD cost; absent when the adapter does not expose it. */
  costUsd?: number;
}

export type ProviderCallOperation =
  | "repair-plan-generation"
  | "repair-plan-formatter";

export interface ProviderCallRecord {
  stage: HarnessStage;
  /** Narrow call purpose within a stage, recorded only where waste diagnosis needs it. */
  operation?: ProviderCallOperation;
  provider: string;
  model: string;
  attempt: number;
  startedAt: string;
  durationMilliseconds: number;
  exitCode: number;
  outputBytes: number;
  firstOutputMilliseconds?: number;
  usage: ProviderUsage;
}

export interface StageRecord {
  stage: HarnessStage;
  durationMilliseconds: number;
  entries: number;
}

export interface StructuralRepairTelemetryRecord {
  mutableRegions: number;
  regionIds: string[];
  anchors: string[];
  replacementsApplied: number;
}

export interface HarnessTelemetryReport {
  contract: typeof HARNESS_TELEMETRY_CONTRACT;
  startedAt: string;
  durationMilliseconds: number;
  stages: StageRecord[];
  providerCalls: ProviderCallRecord[];
  structuralRepairs: StructuralRepairTelemetryRecord[];
  totals: ProviderUsage & { providerCalls: number };
}

export function emptyUsage(): ProviderUsage {
  return {
    measured: false,
    requests: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    toolCalls: 0,
    reasoningEvents: 0,
    contentEvents: 0,
    reasoningBytes: 0,
    contentBytes: 0,
  };
}

export function addUsage(target: ProviderUsage, source: ProviderUsage): ProviderUsage {
  target.measured = target.measured || source.measured;
  target.requests += source.requests;
  target.inputTokens += source.inputTokens;
  target.cachedInputTokens += source.cachedInputTokens;
  target.cacheCreationInputTokens += source.cacheCreationInputTokens;
  target.outputTokens += source.outputTokens;
  target.totalTokens += source.totalTokens;
  target.toolCalls += source.toolCalls;
  target.reasoningEvents += source.reasoningEvents;
  target.contentEvents += source.contentEvents;
  target.reasoningBytes += source.reasoningBytes;
  target.contentBytes += source.contentBytes;
  if (source.costUsd !== undefined) target.costUsd = (target.costUsd ?? 0) + source.costUsd;
  return target;
}

export class HarnessTelemetry {
  private readonly startedAt = new Date();
  private readonly stageTotals = new Map<HarnessStage, StageRecord>();
  private readonly calls: ProviderCallRecord[] = [];
  private readonly structuralRepairs: StructuralRepairTelemetryRecord[] = [];
  private current?: { stage: HarnessStage; at: number };

  /** Enter a documentation stage; the previous stage's elapsed time is banked. */
  beginStage(stage: HarnessStage): void {
    this.closeStage();
    this.current = { stage, at: Date.now() };
    const record = this.stageTotals.get(stage) ?? { stage, durationMilliseconds: 0, entries: 0 };
    record.entries += 1;
    this.stageTotals.set(stage, record);
  }

  /** Bank the elapsed time of the active stage without opening another one. */
  closeStage(): void {
    if (!this.current) return;
    const record = this.stageTotals.get(this.current.stage);
    if (record) record.durationMilliseconds += Date.now() - this.current.at;
    this.current = undefined;
  }

  activeStage(): HarnessStage | undefined {
    return this.current?.stage;
  }

  recordProviderCall(record: ProviderCallRecord): void {
    this.calls.push(record);
  }

  providerCallCount(): number {
    return this.calls.length;
  }

  recordStructuralRepair(record: StructuralRepairTelemetryRecord): void {
    this.structuralRepairs.push({
      ...record,
      regionIds: [...record.regionIds],
      anchors: [...record.anchors],
    });
  }

  report(): HarnessTelemetryReport {
    const active = this.current;
    if (active) {
      const record = this.stageTotals.get(active.stage);
      if (record) record.durationMilliseconds += Date.now() - active.at;
      this.current = { stage: active.stage, at: Date.now() };
    }
    const totals = { ...emptyUsage(), providerCalls: this.calls.length };
    for (const call of this.calls) addUsage(totals, call.usage);
    return {
      contract: HARNESS_TELEMETRY_CONTRACT,
      startedAt: this.startedAt.toISOString(),
      durationMilliseconds: Date.now() - this.startedAt.getTime(),
      stages: HARNESS_STAGES.map((stage) => this.stageTotals.get(stage)).filter(
        (record): record is StageRecord => Boolean(record),
      ),
      providerCalls: [...this.calls],
      structuralRepairs: [...this.structuralRepairs],
      totals,
    };
  }
}

let active: HarnessTelemetry | undefined;

export function startHarnessTelemetry(): HarnessTelemetry {
  active = new HarnessTelemetry();
  return active;
}

export function harnessTelemetry(): HarnessTelemetry | undefined {
  return active;
}

export function finishHarnessTelemetry(): HarnessTelemetryReport | undefined {
  if (!active) return undefined;
  active.closeStage();
  const report = active.report();
  active = undefined;
  return report;
}

function seconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

export function formatTelemetryReport(report: HarnessTelemetryReport): string {
  const lines = [
    `Duração total: ${seconds(report.durationMilliseconds)} · chamadas ao provider: ${report.totals.providerCalls}`,
  ];
  for (const stage of report.stages) {
    lines.push(`  ${HARNESS_STAGE_LABELS[stage.stage].padEnd(24)} ${seconds(stage.durationMilliseconds)}`);
  }
  if (report.totals.measured) {
    lines.push(
      `Tokens: entrada=${report.totals.inputTokens}, em cache=${report.totals.cachedInputTokens}, `
      + `criação de cache=${report.totals.cacheCreationInputTokens}, saída=${report.totals.outputTokens}, `
      + `total=${report.totals.totalTokens} · requisições=${report.totals.requests}`,
    );
    if (report.totals.costUsd !== undefined) {
      lines.push(`Custo reportado pelo provider: US$ ${report.totals.costUsd.toFixed(6)}`);
    }
  } else {
    lines.push("Tokens: não medidos por este provider (o adapter não informou usage).");
  }
  if (report.totals.reasoningEvents > 0 || report.totals.contentEvents > 0) {
    // Reasoning and answer are reported apart: a call can consume its entire
    // output limit reasoning and still deliver nothing.
    lines.push(
      `Saída: eventos de raciocínio=${report.totals.reasoningEvents}, `
      + `eventos de conteúdo=${report.totals.contentEvents} `
      + `(bytes: raciocínio=${report.totals.reasoningBytes}, conteúdo=${report.totals.contentBytes})`,
    );
  }
  return lines.join("\n");
}
