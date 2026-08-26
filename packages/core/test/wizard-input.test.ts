import { describe, expect, it } from "vitest";
import { askChoice, askRequest, type WizardPrompt } from "../src/harness-wizard.js";

/** A scripted terminal: each answer is consumed once, in order. */
function scripted(answers: string[]): WizardPrompt & { written: string[]; remaining: () => string[] } {
  const queue = [...answers];
  const written: string[] = [];
  return {
    ask: async () => {
      if (!queue.length) throw new Error("end of input");
      return queue.shift()!;
    },
    write: (text) => void written.push(text),
    written,
    remaining: () => queue,
  };
}

/**
 * Reported from a real session. The developer pasted a multi-line project brief
 * at the "Pedido: digitar ou arquivo" prompt and the transcript came back with
 * that prompt repeated and the brief shredded across it.
 *
 * Two defects, one paste. A prompt read returns at the first newline, so the
 * brief's first line was taken as the *mode*; anything other than "arquivo"
 * fell through to "digitar", and each remaining line was then answered — one
 * per prompt — into the questions that followed.
 */
const BRIEF = [
  "Crie um projeto web em nodejs e typescript para facilitar o uso de crontab no linux,",
  "a interface deverá ser dividida em 2 abas onde a primeira aba deverá conter um campo",
  "para o usuario digitar uma linha cron existente e o sistema devolver o que ela faz,",
  "as variaveis deverão ser: AI_BASE_URL,AI_API_KEY,AI_MODEL,AI_TIMEOUT_MS",
];

describe("a pasted brief is never read as a menu choice", () => {
  it("rejects each pasted line and takes the real answer", async () => {
    const io = scripted([...BRIEF, "digitar"]);
    expect(await askChoice(io, "Pedido: ", ["digitar", "arquivo"], "digitar")).toBe("digitar");
    // Nothing of the paste is left to leak into the next question.
    expect(io.remaining()).toEqual([]);
  });

  it("explains the mistake instead of failing silently", async () => {
    const io = scripted([BRIEF[0]!, "arquivo"]);
    await askChoice(io, "Pedido: ", ["digitar", "arquivo"], "digitar");
    const said = io.written.join("");
    expect(said).toContain("Responda com digitar, arquivo");
    expect(said).toContain("Se você colou o pedido aqui");
  });

  it("accepts every offered choice, case-insensitively, and the empty default", async () => {
    for (const [answer, expected] of [["arquivo", "arquivo"], ["DIGITAR", "digitar"], ["", "digitar"]] as const) {
      const io = scripted([answer]);
      expect(await askChoice(io, "Pedido: ", ["digitar", "arquivo"], "digitar")).toBe(expected);
    }
  });

  it("gives up instead of looping forever", async () => {
    const io = scripted(Array.from({ length: 20 }, () => "x"));
    await expect(askChoice(io, "Pedido: ", ["digitar", "arquivo"], "digitar"))
      .rejects.toThrow(/resposta inválida após 5 tentativas/);
    // Exactly five reads, not twenty.
    expect(io.remaining()).toHaveLength(15);
  });
});

describe("a request may span several lines", () => {
  it("preserves a pasted brief byte for byte and stops at the terminator", async () => {
    const io = scripted([...BRIEF, ".", "codex"]);
    expect(await askRequest(io, "Descreva o pedido:")).toBe(BRIEF.join("\n"));
    // What follows the terminator belongs to the next question — this is
    // exactly what used to leak into provider, model, and effort.
    expect(io.remaining()).toEqual(["codex"]);
  });

  it("tells the developer how to finish", async () => {
    const io = scripted(["uma linha", "."]);
    await askRequest(io, "Descreva o pedido:");
    expect(io.written.join("")).toContain("Finalize com uma linha contendo apenas . (ponto) ou pressione Ctrl-D");
  });

  it("keeps blank lines inside the brief and trims only the edges", async () => {
    const io = scripted(["", "Primeira parte.", "", "Segunda parte.", "", "."]);
    expect(await askRequest(io, "Descreva o pedido:")).toBe("Primeira parte.\n\nSegunda parte.");
  });

  it("accepts a single-line request unchanged", async () => {
    const io = scripted(["Planejar a exportação em PDF.", "."]);
    expect(await askRequest(io, "Descreva o pedido:")).toBe("Planejar a exportação em PDF.");
  });

  it("ends at end of input when no terminator is typed", async () => {
    const io = scripted([...BRIEF]);
    expect(await askRequest(io, "Descreva o pedido:")).toBe(BRIEF.join("\n"));
  });

  it("returns empty when nothing was typed, so the caller can refuse it", async () => {
    const io = scripted(["."]);
    expect(await askRequest(io, "Descreva o pedido:")).toBe("");
  });
});
