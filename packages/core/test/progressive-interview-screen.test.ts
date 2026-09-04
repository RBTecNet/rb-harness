import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { formatInteractiveQuestion, type InterviewQuestionEvidence } from "../src/vnext/interview.js";
import type { ProviderAdapter, ResolvedProviderAuth } from "../src/vnext/providers/contract.js";
import { resolveProviderProfile } from "../src/vnext/providers/registry.js";
import { executeProgressiveInitWizardStage, type ProgressiveInitCliRuntime } from "../src/vnext/progressive-init/cli.js";
import type { ProgressiveStageSnapshot } from "../src/vnext/progressive-init/coordinator.js";
import {
  prepareInteractiveQuestionScreen,
  type InteractiveQuestionScreenOptions,
} from "../src/vnext/progressive-init/interview-screen.js";

function capture() {
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { output, chunks, text: () => chunks.join("") };
}

function question(key: string, text: string): InterviewQuestionEvidence {
  return {
    key,
    question: text,
    materiality: "product",
    rigidity: "RIGID",
    recommendedAnswer: { value: "Use the recommended option", rationale: "It keeps the accepted scope deterministic." },
    alternatives: ["Use another explicit option"],
    persistedBeforeSelection: true,
    presented: false,
    response: null,
    selectedValue: null,
    acceptanceMode: null,
  };
}

function prepare(overrides: Partial<InteractiveQuestionScreenOptions> = {}) {
  const terminal = capture();
  const result = prepareInteractiveQuestionScreen({
    stage: "project-description",
    questionIndex: 1,
    inputIsTTY: true,
    outputIsTTY: true,
    headless: false,
    terminalOutput: terminal.output,
    write: (value) => terminal.output.write(value),
    ...overrides,
  });
  return { ...terminal, result };
}

describe("Progressive interview screen preparation", () => {
  it("clears an interactive TTY using Node terminal controls and renders truthful stage/question context", () => {
    const state = prepare({ stage: "database-schema", questionIndex: 3 });
    expect(state.result).toEqual({
      cleared: true,
      header: "RB Harness Progressive Init\nP3/4 · Database Schema\nPergunta 3",
    });
    expect(state.text()).toContain("\u001b[1;1H\u001b[0J");
    expect(state.text()).toContain("P3/4 · Database Schema\nPergunta 3\n\n");
    expect(state.text()).not.toContain("Pergunta 3/");
  });

  it("prepares each consecutive question independently so the newest viewport contains only current content", () => {
    const terminal = capture();
    const common = {
      stage: "project-description" as const,
      inputIsTTY: true,
      outputIsTTY: true,
      headless: false,
      terminalOutput: terminal.output,
      write: (value: string) => terminal.output.write(value),
    };
    prepareInteractiveQuestionScreen({ ...common, questionIndex: 1 });
    terminal.output.write(formatInteractiveQuestion(question("q1", "Previous question text")));
    prepareInteractiveQuestionScreen({ ...common, questionIndex: 2 });
    terminal.output.write(formatInteractiveQuestion(question("q2", "Current question text")));
    expect(terminal.text().match(/\u001b\[1;1H\u001b\[0J/g)).toHaveLength(2);
    const currentViewport = terminal.text().split("\u001b[0J").at(-1)!;
    expect(currentViewport).toContain("Pergunta 2");
    expect(currentViewport).toContain("Current question text");
    expect(currentViewport).toContain("Recommended:\n  Use the recommended option");
    expect(currentViewport).not.toContain("Previous question text");
  });

  it("never emits clear controls for non-TTY, redirected, or headless presentation", () => {
    for (const mode of [
      { inputIsTTY: false, outputIsTTY: true, headless: false },
      { inputIsTTY: true, outputIsTTY: false, headless: false },
      { inputIsTTY: true, outputIsTTY: true, headless: true },
    ]) {
      const state = prepare(mode);
      expect(state.result.cleared).toBe(false);
      expect(state.text()).not.toContain("\u001b[");
      expect(state.text()).toContain("RB Harness Progressive Init");
    }
  });

  it("keeps recommendation and blank-answer prompt formatting byte-for-byte owned by the existing formatter", () => {
    const pending = question("unchanged", "Which option should be selected?");
    expect(formatInteractiveQuestion(pending)).toBe([
      "\nWhich option should be selected?",
      "",
      "Recommended:",
      "  Use the recommended option",
      "",
      "Why:",
      "  It keeps the accepted scope deterministic.",
      "",
      "Alternatives:",
      "  1. Use another explicit option",
      "",
      "Answer (blank accepts the recommendation): ",
    ].join("\n"));
  });

  it("clears a readable same-question retry without advancing its index, then advances the next key", async () => {
    const terminal = capture();
    const prompts: string[] = [];
    const declared = resolveProviderProfile("openai:gpt-5.6-sol");
    const profile = {
      ...declared,
      conformance: { ...declared.conformance, tier: "SUPPORTED" as const, verifiedRecord: true },
    };
    const statuses: readonly ProgressiveStageSnapshot[] = [
      { stage: "project-description", status: "incomplete" },
      { stage: "user-stories", status: "incomplete" },
      { stage: "database-schema", status: "incomplete" },
      { stage: "project-phases", status: "incomplete" },
    ];
    const first = question("audience", "Who is the primary audience?");
    const retry = { ...first, question: `Invalid answer: choose an explicit audience. ${first.question}` };
    const second = question("platform", "Which platform should be supported?");
    const auth: ResolvedProviderAuth = { kind: "credential", credential: { id: "fixture", secret: "fixture", attributes: {} } };
    const runtime: ProgressiveInitCliRuntime = {
      inputIsTTY: true,
      outputIsTTY: true,
      terminalOutput: terminal.output,
      write: (value) => terminal.output.write(value),
      ask: async (prompt) => { prompts.push(prompt); return "fixture answer"; },
      inspect: async () => statuses,
      listProfiles: () => [profile],
      loadProfile: async () => profile,
      adapterFor: () => ({} as ProviderAdapter),
      authFor: async () => auth,
      listClaudeCodeModels: async () => [],
      inspectClaudeCodeModel: async () => ({ requestedModel: "unused", transportVersion: "unused", state: "UNSUPPORTED" }),
      verifyClaudeCodeModel: async () => { throw new Error("unused"); },
      execute: async (options) => {
        await options.presentation!.stage("project-description", statuses);
        for (const pending of [first, retry, second]) {
          await options.presentation!.question!(pending);
          if (options.interview?.kind !== "interactive") throw new Error("expected interactive fixture");
          await options.interview.answer(pending);
        }
        return {
          mode: "focused",
          selectedStage: "project-description",
          completedStage: "project-description",
          semanticOperations: 0,
          correctiveRegenerations: 0,
        };
      },
    };
    await executeProgressiveInitWizardStage({
      requestParts: ["Build a fixture."],
      profileId: profile.id,
      projectRoot: "/tmp/rb-progressive-screen-fixture",
      headless: false,
      deadlineSeconds: 120,
      stage: "project-description",
    }, runtime);
    expect(terminal.text().match(/\u001b\[1;1H\u001b\[0J/g)).toHaveLength(3);
    expect(terminal.text().match(/Pergunta 1\n/g)).toHaveLength(2);
    expect(terminal.text().match(/Pergunta 2\n/g)).toHaveLength(1);
    expect(prompts[1]).toContain("Invalid answer: choose an explicit audience.");
    expect(prompts[1]).toContain("Recommended:\n  Use the recommended option");
  });
});
