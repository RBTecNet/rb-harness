import { describe, expect, it } from "vitest";
import type { InterviewQuestionEvidence } from "../src/vnext/interview.js";
import {
  createProgressiveDashboardController,
  ProgressiveDashboardCancelled,
} from "../src/vnext/progressive-init/dashboard/controller.js";
import type { ProgressiveInterviewOption } from "../src/vnext/progressive-init/dashboard/presentation.js";
import {
  anchorProgressiveSelection,
  createProgressiveSelectionState,
  moveProgressiveSelection,
  progressiveSelectedOption,
  progressiveSelectionIsCoreRecommendation,
  progressiveSelectionViewport,
} from "../src/vnext/progressive-init/dashboard/selection.js";
import {
  createProgressiveTerminal,
  decodeProgressiveKeys,
  progressiveTerminalIsInteractive,
} from "../src/vnext/progressive-init/dashboard/terminal.js";
import {
  applyProgressiveTextKey,
  createProgressiveTextInput,
  progressiveTextInputView,
} from "../src/vnext/progressive-init/dashboard/text-input.js";
import { character, fakeProgressiveTerminal, fakeStreams, key } from "./support/progressive-dashboard.js";

const flush = (): Promise<void> => new Promise<void>((resolve) => void setTimeout(resolve, 0));

function choiceEvidence(labels: readonly string[], recommended: string): InterviewQuestionEvidence {
  return {
    key: "persistence.story",
    question: "Which persistence disposition applies?",
    materiality: "architecture",
    rigidity: "RIGID",
    recommendedAnswer: { value: recommended, rationale: "Core owns the structural recommendation." },
    alternatives: [],
    persistedBeforeSelection: true,
    presented: false,
    response: null,
    selectedValue: null,
    acceptanceMode: null,
    choices: labels.map((label) => ({ label, details: [`Option key: ${label.toLowerCase().replace(/\s+/g, "-")}`] })),
    recommendedLabel: recommended,
    answerPrompt: "Choice (blank accepts recommendation): ",
  };
}

function openEvidence(): InterviewQuestionEvidence {
  return {
    key: "objective.statement",
    question: "State the objective in your own words.",
    materiality: "product",
    rigidity: "RIGID",
    recommendedAnswer: { value: "Print exactly one greeting", rationale: "Derived from the literal request span." },
    alternatives: [],
    persistedBeforeSelection: true,
    presented: false,
    response: null,
    selectedValue: null,
    acceptanceMode: null,
  };
}

function options(labels: readonly string[], recommendedIndex = 0): ProgressiveInterviewOption[] {
  return labels.map((label, index) => ({
    id: `choice:${index}`,
    label,
    details: [],
    recommended: index === recommendedIndex,
  }));
}

function controllerFor(terminal = fakeProgressiveTerminal()) {
  return {
    terminal,
    controller: createProgressiveDashboardController({
      terminal,
      version: "1.0.7",
      projectRoot: "/project",
      runId: "run-a",
    }),
  };
}

describe("Progressive Dashboard selection interview", () => {
  it("focuses the Core recommendation when it maps unambiguously to one option", () => {
    const state = createProgressiveSelectionState(options(["A", "B", "C"], 2));
    expect(progressiveSelectedOption(state)?.label).toBe("C");
    expect(progressiveSelectionIsCoreRecommendation(state)).toBe(true);
    const ambiguous = createProgressiveSelectionState([
      { id: "a", label: "A", details: [], recommended: true },
      { id: "b", label: "B", details: [], recommended: true },
    ]);
    // Nothing is focused when Core did not single one out.
    expect(progressiveSelectedOption(ambiguous)).toBeUndefined();
  });

  it("focuses nothing when Core refuses to recommend, so Enter alone cannot approve", async () => {
    const approval: InterviewQuestionEvidence = {
      key: "approve-project-phases-proposal",
      question: "Approve the exact validated Project Phases candidate displayed above?",
      materiality: "implementation",
      rigidity: "RIGID",
      recommendedAnswer: {
        value: "Explicit selection required",
        rationale: "Core cannot recommend or silently approve provider-authored execution structure.",
      },
      alternatives: [],
      persistedBeforeSelection: true,
      presented: false,
      response: null,
      selectedValue: null,
      acceptanceMode: null,
      choices: [{ label: "Approve exact proposal" }, { label: "Reject proposal" }],
      showRecommendation: false,
      answerPrompt: "Choice (blank is not accepted): ",
    };
    const { terminal, controller } = controllerFor();
    controller.presentQuestion(approval, "project-phases");
    const answer = controller.ask("Choice (blank is not accepted): ");
    terminal.press(key("enter"));
    terminal.press(key("enter"));
    // Still pending: an unfocused list refuses a bare Enter.
    expect(controller.state().interview?.phase).toBe("presented");
    // The first movement focuses the first option; a second reaches the second.
    terminal.press(key("down"), key("down"), key("enter"));
    expect(await answer).toBe("2");
    controller.close();
  });

  it("submits an untouched Core recommendation as blank so Core keeps its own acceptance evidence", async () => {
    const { terminal, controller } = controllerFor();
    controller.presentQuestion(choiceEvidence(["Not persisted", "Tenant-owned"], "Not persisted"), "database-schema");
    const answer = controller.ask("Choice (blank accepts recommendation): ");
    terminal.press(key("enter"));
    expect(await answer).toBe("");
    controller.close();
  });

  it("navigates one logical option per key even when an option wraps over rows", () => {
    const multiline = [
      { id: "a", label: "Tenant-owned with explicit tenant_id", details: ["Every row belongs to exactly one tenant."], recommended: true },
      { id: "b", label: "Globally shared", details: [], recommended: false },
      { id: "c", label: "Not persisted", details: [], recommended: false },
    ];
    let state = createProgressiveSelectionState(multiline);
    expect(progressiveSelectedOption(state)?.id).toBe("a");
    state = moveProgressiveSelection(state, "down");
    expect(progressiveSelectedOption(state)?.id).toBe("b");
    state = moveProgressiveSelection(state, "up");
    expect(progressiveSelectedOption(state)?.id).toBe("a");
    // Up at the first option is a no-op rather than a wrap.
    expect(moveProgressiveSelection(state, "up")).toBe(state);
    state = moveProgressiveSelection(state, "end");
    expect(progressiveSelectedOption(state)?.id).toBe("c");
    state = moveProgressiveSelection(state, "home");
    expect(progressiveSelectedOption(state)?.id).toBe("a");
  });

  it("scrolls a long list internally and always keeps the selection visible", () => {
    const many = options(Array.from({ length: 30 }, (_, index) => `Option ${index + 1}`), 0);
    let state = createProgressiveSelectionState(many);
    const heights = many.map(() => 1);
    for (let step = 0; step < 20; step += 1) state = moveProgressiveSelection(state, "down");
    const viewport = progressiveSelectionViewport(state, heights, 6);
    expect(viewport.start).toBeLessThanOrEqual(20);
    expect(viewport.end).toBeGreaterThan(20);
    expect(viewport.hiddenBefore).toBeGreaterThan(0);
    expect(viewport.hiddenAfter).toBeGreaterThan(0);
  });

  it("keeps the selected logical option across a resize", () => {
    const many = options(Array.from({ length: 20 }, (_, index) => `Option ${index + 1}`), 0);
    let state = createProgressiveSelectionState(many);
    for (let step = 0; step < 12; step += 1) state = moveProgressiveSelection(state, "down");
    const selected = progressiveSelectedOption(state)!.id;
    const wide = anchorProgressiveSelection(state, progressiveSelectionViewport(state, many.map(() => 1), 12));
    const narrow = anchorProgressiveSelection(wide, progressiveSelectionViewport(wide, many.map(() => 2), 4));
    expect(progressiveSelectedOption(narrow)!.id).toBe(selected);
  });

  it("submits the selected option exactly once and never accepts it locally", async () => {
    const { terminal, controller } = controllerFor();
    controller.presentQuestion(choiceEvidence(["Not persisted", "Tenant-owned"], "Not persisted"), "database-schema");
    const answer = controller.ask("Choice (blank accepts recommendation): ");
    terminal.press(key("down"));
    terminal.press(key("enter"));
    terminal.press(key("enter"));
    expect(await answer).toBe("2");
    await flush();
    // Submitted, not accepted: Core has not answered yet.
    expect(controller.state().interview?.phase).toBe("submitting");
    controller.close();
  });

  it("keeps a rejected answer usable and never fabricates acceptance", async () => {
    const { terminal, controller } = controllerFor();
    const evidence = choiceEvidence(["Not persisted", "Tenant-owned"], "Not persisted");
    controller.presentQuestion(evidence, "database-schema");
    const first = controller.ask("Choice: ");
    terminal.press(key("down"), key("up"), key("enter"));
    expect(await first).toBe("1");

    // Core re-presents the same key with the same options: that is a rejection.
    controller.presentQuestion({ ...evidence, question: `Invalid persistence selection. ${evidence.question}` }, "database-schema");
    expect(controller.state().interview?.phase).toBe("rejected");
    expect(controller.state().interview?.question.options).toHaveLength(2);
    const retry = controller.ask("Choice: ");
    terminal.press(key("down"), key("enter"));
    expect(await retry).toBe("2");
    controller.close();
  });

  it("treats a different question on the same key as a new question, not a rejection", async () => {
    const { terminal, controller } = controllerFor();
    const stepOne = choiceEvidence(["Escape", "Pair A"], "Pair A");
    controller.presentQuestion(stepOne, "user-stories");
    const first = controller.ask("Choice: ");
    terminal.press(key("enter"));
    await first;
    controller.presentQuestion({ ...stepOne, question: "Step 2 — select concrete pair", choices: [{ label: "Pair A/B" }, { label: "Pair C/D" }] }, "user-stories");
    expect(controller.state().interview?.phase).toBe("presented");
    controller.close();
  });
});

describe("Progressive Dashboard text interview", () => {
  it("edits, wraps and scrolls a long answer without losing content", () => {
    let input = createProgressiveTextInput("");
    for (const letter of "the quick brown fox jumps over the lazy dog again and again") {
      input = applyProgressiveTextKey(input, character(letter));
    }
    expect(input.value).toHaveLength(59);
    const view = progressiveTextInputView(input, 20, 2);
    expect(view.rows.length).toBeLessThanOrEqual(2);
    expect(view.hiddenBefore).toBeGreaterThan(0);
    expect(view.rows.join("")).toContain("again");

    input = applyProgressiveTextKey(input, key("home"));
    input = applyProgressiveTextKey(input, character("X"));
    expect(input.value.startsWith("Xthe")).toBe(true);
    input = applyProgressiveTextKey(input, key("delete"));
    expect(input.value.startsWith("Xhe")).toBe(true);
    input = applyProgressiveTextKey(input, key("end"));
    input = applyProgressiveTextKey(input, key("backspace"));
    expect(input.value.endsWith("agai")).toBe(true);
  });

  it("forwards the typed answer verbatim to Core", async () => {
    const { terminal, controller } = controllerFor();
    controller.presentQuestion(openEvidence(), "project-description");
    const answer = controller.ask("Answer: ");
    for (const letter of "Print exactly one greeting per name") terminal.press(character(letter));
    terminal.press(key("enter"));
    expect(await answer).toBe("Print exactly one greeting per name");
    controller.close();
  });

  it("forwards a blank answer as blank and never substitutes the recommendation", async () => {
    const { terminal, controller } = controllerFor();
    controller.presentQuestion(openEvidence(), "project-description");
    const answer = controller.ask("Answer: ");
    terminal.press(key("enter"));
    // Core owns `blank → recommended answer`; the Dashboard must not pre-empt it.
    expect(await answer).toBe("");
    controller.close();
  });
});

describe("Progressive Dashboard terminal", () => {
  it("creates an interactive surface only when both streams are TTYs", () => {
    const dual = fakeStreams({ isTTY: true });
    const none = fakeStreams({ isTTY: false });
    expect(progressiveTerminalIsInteractive(dual.input, dual.output)).toBe(true);
    expect(progressiveTerminalIsInteractive(none.input, none.output)).toBe(false);
    expect(progressiveTerminalIsInteractive(dual.input, none.output)).toBe(false);
    expect(progressiveTerminalIsInteractive(none.input, dual.output)).toBe(false);
  });

  it("emits no frame, clear, cursor control or raw mode without a TTY", () => {
    const streams = fakeStreams({ isTTY: false });
    const terminal = createProgressiveTerminal({ input: streams.input, output: streams.output, env: {} });
    terminal.frame("would be a frame");
    terminal.close();
    expect(terminal.interactive).toBe(false);
    expect(streams.written).toEqual([]);
    expect(streams.rawModes).toEqual([]);
    expect(streams.dataListeners).toHaveLength(0);
  });

  it("restores cursor, raw mode, stdin and listeners exactly once, idempotently", () => {
    const streams = fakeStreams();
    const terminal = createProgressiveTerminal({ input: streams.input, output: streams.output, env: {} });
    expect(streams.rawModes).toEqual([true]);
    expect(streams.written.join("")).toContain("\u001b[?25l");
    terminal.close();
    terminal.close();
    terminal.close();
    expect(streams.rawModes).toEqual([true, false]);
    expect(streams.written.filter((value) => value.includes("\u001b[?25h"))).toHaveLength(1);
    expect(streams.dataListeners).toHaveLength(0);
    expect(streams.resizeListeners).toHaveLength(0);
    expect(streams.isPaused()).toBe(true);
  });

  it("decodes arrows, editing keys and interrupt without leaking escape bytes", () => {
    const esc = "\u001b";
    expect(decodeProgressiveKeys(`${esc}[A${esc}[B${esc}[C${esc}[D`).map((entry) => entry.name))
      .toEqual(["up", "down", "right", "left"]);
    expect(decodeProgressiveKeys(`${esc}[5~${esc}[6~${esc}[H${esc}[F`).map((entry) => entry.name))
      .toEqual(["pageup", "pagedown", "home", "end"]);
    expect(decodeProgressiveKeys("\r").map((entry) => entry.name)).toEqual(["enter"]);
    expect(decodeProgressiveKeys("\u0003").map((entry) => entry.name)).toEqual(["interrupt"]);
    expect(decodeProgressiveKeys("\u007f").map((entry) => entry.name)).toEqual(["backspace"]);
    expect(decodeProgressiveKeys("ok").map((entry) => entry.value)).toEqual(["o", "k"]);
    // An unknown CSI sequence is dropped, never typed into the answer buffer.
    expect(decodeProgressiveKeys(`${esc}[200~x`).map((entry) => entry.value)).toEqual(["x"]);
  });
});

describe("Progressive Dashboard lifecycle safety", () => {
  it("routes Ctrl+C through the cancellation owner instead of exiting", async () => {
    const terminal = fakeProgressiveTerminal();
    let cancelled = 0;
    const controller = createProgressiveDashboardController({
      terminal, version: "1.0.7", projectRoot: "/project", runId: "run-a",
      onCancel: () => { cancelled += 1; },
    });
    controller.presentQuestion(openEvidence(), "project-description");
    const answer = controller.ask("Answer: ");
    terminal.press(key("interrupt"));
    await expect(answer).rejects.toBeInstanceOf(ProgressiveDashboardCancelled);
    expect(cancelled).toBe(1);
    controller.close();
    expect(terminal.closes()).toBe(1);
  });

  it("closes the terminal once on repeated close and rejects a pending answer", async () => {
    const { terminal, controller } = controllerFor();
    controller.presentQuestion(openEvidence(), "project-description");
    const answer = controller.ask("Answer: ");
    controller.close();
    controller.close();
    await expect(answer).rejects.toBeInstanceOf(ProgressiveDashboardCancelled);
    expect(terminal.closes()).toBe(1);
  });

  it("coalesces redraws and keeps typed content across a resize", async () => {
    const { terminal, controller } = controllerFor();
    controller.presentQuestion(openEvidence(), "project-description");
    const answer = controller.ask("Answer: ");
    for (const letter of "keep this text") terminal.press(character(letter));
    await flush();
    const before = terminal.frames.length;
    terminal.resize(60, 20);
    await flush();
    expect(terminal.frames.length).toBeGreaterThan(before);
    expect(terminal.last()).toContain("keep this text");
    terminal.press(key("enter"));
    expect(await answer).toBe("keep this text");
    controller.close();
  });

  it("counts adapter requests as measured transport-invocation telemetry", () => {
    const { controller } = controllerFor();
    expect(controller.counters().transportInvocations.used).toEqual({ measured: true, value: 0 });
    controller.countTransportInvocation();
    controller.countTransportInvocation();
    expect(controller.counters().transportInvocations.used).toEqual({ measured: true, value: 2 });
    controller.recordStageAccounting({ semanticOperations: 2, correctiveRegenerations: 1 });
    controller.recordStageAccounting({ semanticOperations: 1, correctiveRegenerations: 0 });
    const counters = controller.counters();
    expect(counters.semanticOperations.used).toEqual({ measured: true, value: 3 });
    expect(counters.correctiveRegenerationsRun.used).toEqual({ measured: true, value: 1 });
    expect(counters.correctiveRegenerationsSlice.used).toEqual({ measured: true, value: 0 });
    expect(counters.transportRetries.used.measured).toBe(false);
    expect(Object.values(counters).every((usage) => !("limit" in usage))).toBe(true);
    controller.close();
  });
});
