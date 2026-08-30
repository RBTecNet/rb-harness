import { describe, expect, it } from "vitest";
import {
  createInitDashboardController,
  dashboardHeaderGeometry,
  dashboardMascotVariant,
  deriveInitDashboardViewModel,
  renderInitDashboard,
  stripTerminalAnsi,
  terminalVisibleWidth,
  truncateTerminalText,
  type InitDashboardRecentEvent,
  type InitDashboardSnapshot,
} from "../src/harness-dashboard.js";
import {
  HARNESS_MASCOT_SOURCE,
  harnessMascotDimensions,
  harnessMascotPlainRows,
  renderHarnessMascot,
} from "../src/harness-mascot.js";

/** The terminal geometry of the reference dashboard screenshot. */
const SCREENSHOT_COLUMNS = 158;
const SCREENSHOT_ROWS = 34;

function snapshot(overrides: Partial<InitDashboardSnapshot> = {}): InitDashboardSnapshot {
  return {
    stage: "work-requested",
    selectedProfileId: "anthropic:claude-code-cli:claude-opus-5",
    transport: "claude-code-cli",
    requestAccounting: "opaque",
    questions: 3,
    semanticOperations: 2,
    transportInvocations: 2,
    correctiveRegenerations: 0,
    providerRequests: "não medido",
    publicationOccurred: false,
    projectRoot: "/home/bruno/Documentos/Projetos/testes",
    durationSeconds: 61,
    updatedAt: "2026-08-29T10:21:06.000Z",
    ...overrides,
  };
}

function render(width: number, height = 44, overrides: Partial<InitDashboardSnapshot> = {}): string {
  return renderInitDashboard(snapshot(overrides), "0.6.2", width, { height, color: false, unicode: true });
}

function lines(output: string): string[] {
  return output.replace(/\n$/, "").split("\n");
}

function assertFits(output: string, width: number, height?: number): void {
  const rendered = lines(output);
  expect(rendered.every((line) => terminalVisibleWidth(line) <= width)).toBe(true);
  if (height !== undefined) expect(rendered.length).toBeLessThanOrEqual(height);
}

describe("canonical Init dashboard presentation", () => {
  it("reproduces the reference composition at the screenshot terminal size", () => {
    const output = render(SCREENSHOT_COLUMNS, SCREENSHOT_ROWS);
    const rendered = lines(output);
    expect(rendered).toHaveLength(SCREENSHOT_ROWS);
    expect(output).toContain("INIT · DOCUMENTAÇÃO · HARNESS CONTROL PLANE");
    expect(output).toContain("HARNESS · capivara documentadora");
    expect(output).toContain("v0.6.2");
    expect(output).toContain("PROJETO");
    expect(output).toContain("ETAPA ATUAL");
    expect(output).toContain("DURAÇÃO");
    expect(output).toContain("PIPELINE · FLUXO DE EXECUÇÃO");
    expect(output).toContain("PROVEDOR ATUAL");
    expect(output).toContain("TELEMETRIA");
    expect(output).toContain("EVENTOS RECENTES");
    expect(output).toContain("Ctrl-C interrompe com estado retomável");
    // Panel headings live inside the frame, never inside the top border.
    expect(output).not.toMatch(/─ TELEMETRIA ─/);
    assertFits(output, SCREENSHOT_COLUMNS, SCREENSHOT_ROWS);
  });

  it("draws the pipeline as a progress rail over the canonical Init stages", () => {
    const output = render(SCREENSHOT_COLUMNS, SCREENSHOT_ROWS);
    const rail = lines(output).find((line) => line.includes("[✓]") && line.includes("[●]"));
    expect(rail).toBeDefined();
    expect(rail).toContain("╌");
    expect(rail).toContain("[ ]");
    for (const label of ["pedido", "intent", "entrevista", "decisões", "work", "closure"]) {
      expect(output).toContain(label);
    }
    expect(output).toContain("concluído");
    expect(output).toContain("em andamento");
    expect(output).toContain("aguardando");
    expect(output).toContain("Somente metadados operacionais seguros");
    // Legacy documentation states must not reappear behind the reference art.
    for (const legacy of ["dispatched", "executing", "reviewing", "inventory", "gap-analysis"]) {
      expect(output).not.toContain(legacy);
    }
  });

  it("places the provider panel beside the pipeline when the terminal is wide", () => {
    const output = render(SCREENSHOT_COLUMNS, SCREENSHOT_ROWS);
    const row = lines(output).find((line) => line.includes("PIPELINE · FLUXO DE EXECUÇÃO"));
    expect(row).toContain("PROVEDOR ATUAL");
    const perfil = lines(output).find((line) => line.includes("perfil"));
    expect(perfil).toContain("anthropic:claude-code-cli:claude-opus-5");
    expect(output).toContain("transporte");
    expect(output).toContain("contabilidade");
    expect(output).toContain("opaque");
  });

  it("keeps every telemetry metric on one evenly separated row when wide", () => {
    const output = render(SCREENSHOT_COLUMNS, SCREENSHOT_ROWS);
    const rendered = lines(output);
    const labels = rendered.find((line) => line.includes("ENTREVISTA") && line.includes("TOKENS"));
    expect(labels).toBeDefined();
    for (const label of ["OPERAÇÕES SEMÂNTICAS", "INVOCAÇÕES", "CORREÇÕES", "PROVIDER REQUESTS", "PUBLICAÇÃO"]) {
      expect(labels).toContain(label);
    }
    const values = rendered[rendered.indexOf(labels!) + 1]!;
    expect(values).toContain("3 pergunta(s)");
    expect(values).toContain("não medido");
    expect(values).toContain("pendente");
  });

  it("uses stacked medium panels without losing provider or telemetry", () => {
    const output = render(92, 44);
    expect(output).toContain("PROVEDOR ATUAL");
    expect(output).toContain("claude-code-cli");
    expect(output).toContain("OPERAÇÕES SEMÂNTICAS");
    assertFits(output, 92, 44);
  });

  it("selects the full mascot independently from the medium panel breakpoint", () => {
    const width = 100;
    const output = render(width, 48);
    expect(deriveInitDashboardViewModel(snapshot(), "0.6.2", { width, height: 48, color: false, unicode: true }).layout).toBe("medium");
    expect(dashboardMascotVariant(width)).toBe("wide");
    expect(dashboardMascotVariant(SCREENSHOT_COLUMNS)).toBe("wide");
    expect(dashboardMascotVariant(68)).toBe("wide");
    expect(dashboardMascotVariant(60)).toBe("compact");
    for (const row of harnessMascotPlainRows("wide")) expect(output).toContain(row);
    expect(output).not.toContain("HARNESS · capivara documentadora");
    assertFits(output, width, 48);
  });

  it("centers the full mascot inside the reference header without cropping it", () => {
    const geometry = dashboardHeaderGeometry({ width: SCREENSHOT_COLUMNS, height: SCREENSHOT_ROWS, color: false, unicode: true });
    expect(geometry.variant).toBe("wide");
    expect(geometry.split).toBe(true);
    expect(geometry.mascotStart).toBe(Math.floor((SCREENSHOT_COLUMNS - geometry.mascotWidth) / 2));
    const header = lines(render(SCREENSHOT_COLUMNS, SCREENSHOT_ROWS));
    harnessMascotPlainRows("wide").forEach((row, index) => {
      expect([...header[index]!].slice(geometry.mascotStart, geometry.mascotStart + geometry.mascotWidth).join("")).toBe(row);
    });
  });

  it("uses a readable single-column narrow layout and explicit compact mascot", () => {
    const output = render(60, 40);
    expect(dashboardMascotVariant(60)).toBe("compact");
    for (const row of harnessMascotPlainRows("compact")) expect(output).toContain(row);
    expect(output).toContain("RESUMO");
    expect(output).toContain("PIPELINE · FLUXO DE EXECUÇÃO");
    expect(output).toContain("TELEMETRIA");
    expect(output).toMatch(/PROVEDOR ATUAL|provedor/);
    assertFits(output, 60, 40);
  });

  it("compresses secondary presentation before critical state on short terminals", () => {
    const output = render(54, 18, { stage: "failed", terminalStatus: "failed", failureKind: "semantic-invalid-after-recovery", lastActiveStage: "work-requested" });
    expect(output).toContain("RB HARNESS");
    expect(output).toContain("falhou");
    expect(output).toContain("semantic-invalid-after-recovery");
    // Telemetry survives as a dense line rather than disappearing.
    expect(output).toContain("semânticas 2");
    assertFits(output, 54, 18);
  });

  it("truncates long project paths and profiles without damaging adjacent panels", () => {
    const output = render(120, 44, {
      projectRoot: `/workspace/${"deep-directory/".repeat(20)}project`,
      selectedProfileId: `anthropic:claude-code-cli:${"very-long-profile-".repeat(8)}`,
    });
    expect(output).toContain("…");
    const frames = lines(output).filter((line) => line.startsWith("│"));
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((line) => /[│╯╮]$/.test(line.trimEnd()))).toBe(true);
    assertFits(output, 120, 44);
  });

  it("projects running, successful, and failed canonical Init lifecycle states", () => {
    const running = render(SCREENSHOT_COLUMNS, SCREENSHOT_ROWS, { stage: "work-requested" });
    expect(running).toContain("em andamento");
    expect(running).toContain("[●]");

    const success = render(SCREENSHOT_COLUMNS, SCREENSHOT_ROWS, { stage: "published", terminalStatus: "published", publicationOccurred: true });
    expect(success).toContain("concluído");
    expect(success).toContain("Ralph READY");
    expect(success).not.toContain("[●]");

    const failed = render(SCREENSHOT_COLUMNS, SCREENSHOT_ROWS, { stage: "failed", lastActiveStage: "deterministic-closure", terminalStatus: "failed", failureKind: "deterministic-core-failure" });
    expect(failed).toContain("falhou");
    expect(failed).toContain("[✕]");
    expect(failed).toContain("ERRO");
    expect(failed).toContain("deterministic-core-failure");
  });

  it("keeps the failure layout intact and never dumps a raw exception through the frame", () => {
    const output = render(SCREENSHOT_COLUMNS, SCREENSHOT_ROWS, {
      stage: "failed",
      lastActiveStage: "work-requested",
      terminalStatus: "failed",
      failureKind: "semantic-invalid-after-recovery",
    });
    expect(output).toContain("PIPELINE · FLUXO DE EXECUÇÃO");
    expect(output).toContain("TELEMETRIA");
    expect(output).toContain("PROVEDOR ATUAL");
    expect(output).toContain("EVENTOS RECENTES");
    expect(output).not.toContain("Error:");
    expect(output).not.toContain("    at ");
    assertFits(output, SCREENSHOT_COLUMNS, SCREENSHOT_ROWS);
  });

  it("shows real correction counts and opaque accounting without fabricating zero", () => {
    const output = render(SCREENSHOT_COLUMNS, SCREENSHOT_ROWS, { correctiveRegenerations: 1, providerRequests: "não medido" });
    expect(output).toMatch(/CORREÇÕES[\s\S]*1/);
    expect(output).toContain("não medido");
    expect(output).not.toContain("PROVIDER REQUESTS 0");
    expect(render(SCREENSHOT_COLUMNS, SCREENSHOT_ROWS, { tokens: "não medido" })).toContain("não medido");
  });

  it("bounds recent events deterministically", () => {
    const events: InitDashboardRecentEvent[] = Array.from({ length: 20 }, (_, index) => ({
      at: `10:21:${String(index).padStart(2, "0")}`,
      category: "etapa",
      message: `evento-${index}`,
    }));
    const output = render(SCREENSHOT_COLUMNS, 60, { events });
    expect(output).toContain("evento-19");
    expect(output).toContain("evento-14");
    expect(output).not.toContain("evento-13");
    expect(output).not.toContain("evento-0 ");
  });

  it("calculates ANSI and wide Unicode visible widths without splitting styled text", () => {
    expect(terminalVisibleWidth("[31m日本[0m")).toBe(4);
    expect(stripTerminalAnsi("[31mfalhou[0m")).toBe("falhou");
    expect(terminalVisibleWidth(truncateTerminalText("[31m日本語[0m", 5))).toBeLessThanOrEqual(5);
    expect(truncateTerminalText("abcdef", 4)).toBe("abc…");
  });

  it("keeps colored output width-correct and free of dangling ANSI state", () => {
    const colored = renderInitDashboard(snapshot(), "0.6.2", SCREENSHOT_COLUMNS, {
      height: SCREENSHOT_ROWS, color: true, unicode: true, trueColor: true,
    });
    const rendered = lines(colored);
    expect(rendered).toHaveLength(SCREENSHOT_ROWS);
    expect(rendered.every((line) => terminalVisibleWidth(line) <= SCREENSHOT_COLUMNS)).toBe(true);
    expect(rendered.every((line) => !/\[[0-9;]*m$/.test(line) || line.endsWith("[0m"))).toBe(true);
    // Chrome uses the truecolor reference palette and degrades to basic ANSI.
    expect(colored).toContain("[38;2;45;212;238m");
    const basic = renderInitDashboard(snapshot(), "0.6.2", SCREENSHOT_COLUMNS, {
      height: SCREENSHOT_ROWS, color: true, unicode: true, trueColor: false,
    });
    expect(basic).toContain("[36m");
    expect(basic).not.toContain("[38;2;45;212;238m");
  });

  it("keeps the mascot source stable, bounded, reset-safe, and monochrome-capable", () => {
    expect(harnessMascotDimensions("wide")).toEqual({ width: 30, height: 7 });
    expect(harnessMascotDimensions("compact")).toEqual({ width: 17, height: 4 });
    expect(HARNESS_MASCOT_SOURCE.wide).toHaveLength(14);
    expect(HARNESS_MASCOT_SOURCE.compact).toHaveLength(8);
    expect(HARNESS_MASCOT_SOURCE.wide.every((row) => row.length === 30 && /^[.pdlmnkc]+$/.test(row))).toBe(true);
    expect(HARNESS_MASCOT_SOURCE.compact.every((row) => row.length === 17 && /^[.pdlmnkc]+$/.test(row))).toBe(true);
    // The reference silhouette: magenta accents, cyan platform, dark eye pixels.
    expect(HARNESS_MASCOT_SOURCE.wide.join("")).toContain("p");
    expect(HARNESS_MASCOT_SOURCE.wide.at(-1)).toContain("c");
    expect(HARNESS_MASCOT_SOURCE.wide.some((row) => row.includes("kk"))).toBe(true);
    expect(harnessMascotPlainRows("wide").every((row) => terminalVisibleWidth(row) === 30)).toBe(true);
    expect(renderHarnessMascot("wide").every((row) => row.endsWith("[0m") && terminalVisibleWidth(row) === 30)).toBe(true);
    expect(renderHarnessMascot("compact").every((row) => row.endsWith("[0m") && terminalVisibleWidth(row) === 17)).toBe(true);
    expect(renderHarnessMascot("compact", { color: false, unicode: false }).every((row) => terminalVisibleWidth(row) === 17)).toBe(true);
  });

  it("keeps one intentional wordmark and sacrifices the secondary subtitle before the full mascot", () => {
    const wide = render(SCREENSHOT_COLUMNS, SCREENSHOT_ROWS);
    const medium = render(100, 48);
    const wordmarkRow = lines(wide)[0]!.trim().split("  ")[0]!;
    expect(wordmarkRow.startsWith("█")).toBe(true);
    expect(wide.split(wordmarkRow)).toHaveLength(2);
    expect(medium.split(wordmarkRow)).toHaveLength(2);
    expect(wide).not.toMatch(/(^|\n)\s*RB HARNESS(\s|$)/);
    expect(wide).toContain("HARNESS · capivara documentadora");
    expect(medium).not.toContain("HARNESS · capivara documentadora");
    expect(harnessMascotPlainRows("wide").every((row) => medium.includes(row))).toBe(true);
  });

  it("falls back to the plain wordmark rather than clipping the brand", () => {
    const output = render(40, 24);
    expect(output).toContain("RB HARNESS");
    assertFits(output, 40, 24);
  });

  it("derives only a presentation projection from safe orchestration metadata", () => {
    const input = snapshot();
    const before = structuredClone(input);
    const view = deriveInitDashboardViewModel(input, "0.6.2", { width: SCREENSHOT_COLUMNS, height: SCREENSHOT_ROWS, color: false, unicode: true });
    expect(input).toEqual(before);
    expect(view.workflow).toBe("init");
    expect(view.layout).toBe("wide");
    expect(view).not.toHaveProperty("requirements");
    expect(view).not.toHaveProperty("originalRequest");
    // The renderer is a pure function of the snapshot.
    expect(render(SCREENSHOT_COLUMNS, SCREENSHOT_ROWS)).toBe(render(SCREENSHOT_COLUMNS, SCREENSHOT_ROWS));
  });

  it("refreshes in place and always restores terminal state on success and failure", () => {
    const writes: string[] = [];
    const output = { isTTY: true, columns: SCREENSHOT_COLUMNS, rows: SCREENSHOT_ROWS, write: (value: string) => void writes.push(value) };
    const controller = createInitDashboardController("0.6.2", "/workspace/example", output);
    const sigintListeners = process.listenerCount("SIGINT");
    const sigtermListeners = process.listenerCount("SIGTERM");
    controller.start();
    expect(process.listenerCount("SIGINT")).toBe(sigintListeners + 1);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners + 1);
    controller.state(snapshot());
    controller.pause();
    controller.resume();
    controller.state(snapshot({ stage: "failed", terminalStatus: "failed", failureKind: "semantic-invalid-after-recovery" }));
    controller.finish();
    expect(writes[0]).toBe("[?25l");
    expect(writes.some((value) => value.startsWith("[2J[H"))).toBe(true);
    expect(writes.join("")).toContain("semantic-invalid-after-recovery");
    expect(writes.at(-1)).toContain("[?25h");
    expect(writes.at(-1)).toContain("[0m");
    expect(process.listenerCount("SIGINT")).toBe(sigintListeners);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners);
  });

  it("contains renderer/output failures so presentation cannot fail semantic execution", () => {
    const controller = createInitDashboardController("0.6.2", "/workspace/example", {
      isTTY: true,
      columns: 100,
      rows: 35,
      write: () => { throw new Error("terminal broke"); },
    });
    expect(() => controller.start()).not.toThrow();
    expect(() => controller.state(snapshot())).not.toThrow();
    expect(() => controller.pause()).not.toThrow();
    expect(() => controller.resume()).not.toThrow();
    expect(() => controller.finish()).not.toThrow();
  });
});
