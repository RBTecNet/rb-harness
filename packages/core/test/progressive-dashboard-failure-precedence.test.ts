/**
 * A stage or run failure is not an interview answer rejection.
 *
 * A real P1 run failed with PROJECT_DESCRIPTION_INVALID_AFTER_RECOVERY, raised
 * by an unrelated provider-authored determination, while an answer happened to
 * be awaiting acceptance. The Dashboard translated that stage failure into a
 * synthesized `interview-answer-rejected`, kept the interview alive and drew a
 * "Rejected: … / Enter Submit" screen, inviting the developer to answer a
 * question Core was no longer waiting on. These regressions pin the split
 * between an authoritative rejection and a terminal failure.
 */

import { describe, expect, it } from "vitest";
import type { InterviewQuestionEvidence } from "../src/vnext/interview.js";
import {
  createProgressiveDashboardController,
  ProgressiveDashboardInputAbandoned,
} from "../src/vnext/progressive-init/dashboard/controller.js";
import type {
  ProgressivePresentationEventBody,
  ProgressivePresentationState,
} from "../src/vnext/progressive-init/dashboard/presentation.js";
import {
  initialProgressivePresentationState,
  reduceProgressivePresentationAll,
} from "../src/vnext/progressive-init/dashboard/reducer.js";
import { renderProgressiveDashboard } from "../src/vnext/progressive-init/dashboard/renderer.js";
import { fakeProgressiveTerminal, key } from "./support/progressive-dashboard.js";
import { HARNESS_VERSION } from "../src/version.js";

const FORENSIC_REASON = "PROJECT_DESCRIPTION_INVALID_AFTER_RECOVERY: /determinations/1/source/evidence";

function evidence(): InterviewQuestionEvidence {
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

function controllerFor(terminal = fakeProgressiveTerminal()) {
  return {
    terminal,
    controller: createProgressiveDashboardController({
      terminal,
      version: HARNESS_VERSION,
      projectRoot: "/project",
      runId: "run-failure",
    }),
  };
}

function apply(
  state: ProgressivePresentationState,
  bodies: readonly ProgressivePresentationEventBody[],
): ProgressivePresentationState {
  return reduceProgressivePresentationAll(
    state,
    bodies.map((body, index) => ({ runId: state.runId, sequence: state.sequence + 1 + index, ...body }) as never),
  );
}

function frame(state: ProgressivePresentationState): string {
  return renderProgressiveDashboard({
    state,
    capabilities: { width: 100, height: 34, color: false, unicode: true },
    version: HARNESS_VERSION,
  });
}

/** Drives the exact production order run.ts uses for a terminal failure. */
async function submitThenFail(body: ProgressivePresentationEventBody) {
  const { terminal, controller } = controllerFor();
  controller.presentQuestion(evidence(), "project-description");
  const answer = controller.ask("Answer: ");
  terminal.press(key("enter"));
  expect(await answer).toBe("");
  // Core accepted the answer; the stage then failed for an unrelated reason.
  expect(controller.state().interview?.phase).toBe("submitting");

  controller.abandonPendingInput();
  // Nothing was rejected: the question is still the one Core last presented and
  // it never entered the rejected phase.
  expect(controller.state().interview?.phase).toBe("submitting");
  expect(controller.state().interview?.rejection).toBeUndefined();

  controller.emit(body);
  controller.flush();
  return { terminal, controller };
}

describe("Dashboard failure never masquerades as an answer rejection", () => {
  it("A · a stage failure while an answer awaits acceptance ends the interview", async () => {
    const { terminal, controller } = await submitThenFail({
      kind: "stage-failed",
      stage: "project-description",
      reason: FORENSIC_REASON,
    });

    const state = controller.state();
    expect(state.phase).toBe("failed");
    expect(state.interview).toBeUndefined();
    expect(state.failure).toContain("PROJECT_DESCRIPTION_INVALID_AFTER_RECOVERY");

    const rendered = terminal.last();
    expect(rendered).toContain("FALHA");
    expect(rendered).toContain("PROJECT_DESCRIPTION_INVALID_AFTER_RECOVERY");
    expect(rendered).not.toContain("Rejected:");
    expect(rendered).not.toContain("Enter Submit");

    // The developer cannot submit into a run that is over.
    const before = terminal.frames.length;
    terminal.press(key("enter"), key("enter"));
    expect(terminal.frames.length).toBe(before);
    expect(controller.state().interview).toBeUndefined();
    controller.close();
  });

  it("B · a run failure while an answer awaits acceptance ends the interview", async () => {
    const { terminal, controller } = await submitThenFail({
      kind: "run-failed",
      reason: "PROGRESSIVE_RUN_ABORTED: the wizard could not continue",
    });

    const state = controller.state();
    expect(state.phase).toBe("failed");
    expect(state.interview).toBeUndefined();
    expect(state.failure).toContain("PROGRESSIVE_RUN_ABORTED");

    const rendered = terminal.last();
    expect(rendered).toContain("FALHA");
    expect(rendered).not.toContain("Rejected:");
    expect(rendered).not.toContain("Enter Submit");
    controller.close();
  });

  it("C · a genuine same-question re-presentation is still a usable rejection", async () => {
    const { terminal, controller } = controllerFor();
    const question = evidence();
    controller.presentQuestion(question, "project-description");
    const first = controller.ask("Answer: ");
    terminal.press(key("enter"));
    await first;

    // Core re-presents the same key with the same shape: an authoritative rejection.
    controller.presentQuestion({ ...question, question: `Invalid objective. ${question.question}` }, "project-description");
    const state = controller.state();
    expect(state.phase).toBe("interview");
    expect(state.interview?.phase).toBe("rejected");
    expect(state.interview?.rejection).toBeTruthy();

    // The interview stays interactive and a second answer still reaches Core.
    const retry = controller.ask("Answer: ");
    terminal.press(key("enter"));
    expect(await retry).toBe("");
    controller.close();
  });

  it("D · failure outranks an interview even in an inconsistent state", () => {
    const interviewing = apply(initialProgressivePresentationState("run-failure", "/project"), [
      { kind: "run-started", projectRoot: "/project", disposition: "fresh-run" },
      { kind: "stage-started", stage: "project-description" },
      {
        kind: "interview-question-presented",
        question: {
          key: "objective.statement",
          ordinal: 1,
          prompt: "State the objective in your own words.",
          options: [],
          alternatives: [],
          answerPrompt: "Answer",
          stage: "project-description",
        },
      },
    ]);
    expect(interviewing.interview).toBeDefined();

    // Deliberately inconsistent: a failed phase that still carries an interview.
    const inconsistent: ProgressivePresentationState = {
      ...interviewing,
      phase: "failed",
      failure: FORENSIC_REASON,
    };
    const rendered = frame(inconsistent);
    expect(rendered).toContain("FALHA");
    expect(rendered).toContain("PROJECT_DESCRIPTION_INVALID_AFTER_RECOVERY");
    expect(rendered).not.toContain("Rejected:");
    expect(rendered).not.toContain("Enter Submit");
    expect(rendered).not.toContain("ENTREVISTA");
  });

  it("E · a failure with a still-pending prompt releases it and shuts down cleanly", async () => {
    const { terminal, controller } = controllerFor();
    controller.presentQuestion(evidence(), "project-description");
    // No key is pressed: the prompt is still awaiting an answer when it fails.
    const pending = controller.ask("Answer: ");
    const settled = pending.then(() => "resolved").catch((error: unknown) => error);

    controller.abandonPendingInput();
    controller.emit({ kind: "stage-failed", stage: "project-description", reason: FORENSIC_REASON });
    controller.flush();

    // The promise is released rather than left hanging, and not as a rejection.
    await expect(settled).resolves.toBeInstanceOf(ProgressiveDashboardInputAbandoned);
    expect(controller.state().interview).toBeUndefined();
    expect(controller.state().phase).toBe("failed");

    controller.close();
    expect(terminal.closes()).toBe(1);
    // Listeners are gone: further input cannot reach a closed controller.
    terminal.press(key("enter"));
    expect(controller.state().phase).toBe("failed");
  });

  it("F · the original forensic shape renders FAILED rather than Rejected", async () => {
    const { terminal, controller } = await submitThenFail({
      kind: "stage-failed",
      stage: "project-description",
      reason: FORENSIC_REASON,
    });

    const rendered = terminal.last();
    expect(rendered).toContain("FALHA · DIAGNÓSTICO");
    expect(rendered).toContain("/determinations/1/source/evidence");
    expect(rendered).not.toMatch(/Rejected/);
    expect(rendered).not.toMatch(/Enter Submit/);
    controller.close();
  });
});

describe("reducer clears the interview on every terminal failure", () => {
  const interviewing = (): ProgressivePresentationState =>
    apply(initialProgressivePresentationState("run-failure", "/project"), [
      { kind: "run-started", projectRoot: "/project", disposition: "fresh-run" },
      { kind: "stage-started", stage: "project-description" },
      {
        kind: "interview-question-presented",
        question: {
          key: "objective.statement",
          ordinal: 1,
          prompt: "State the objective.",
          options: [],
          alternatives: [],
          answerPrompt: "Answer",
          stage: "project-description",
        },
      },
      { kind: "interview-answer-submitted", questionKey: "objective.statement" },
    ]);

  const cases: readonly (readonly [string, ProgressivePresentationEventBody])[] = [
    ["stage-failed", { kind: "stage-failed", stage: "project-description", reason: FORENSIC_REASON }],
    ["run-failed", { kind: "run-failed", reason: FORENSIC_REASON }],
    ["closure-failed", { kind: "closure-failed", reason: "closure refused" }],
    [
      "corrective-regeneration-exhausted",
      { kind: "corrective-regeneration-exhausted", stage: "project-description" },
    ],
  ];

  for (const [name, body] of cases) {
    it(`${name} leaves no interview behind`, () => {
      const before = interviewing();
      expect(before.interview?.phase).toBe("submitting");
      const after = apply(before, [body]);
      expect(after.phase).toBe("failed");
      expect(after.interview, `${name} must clear the interview`).toBeUndefined();
    });
  }
});
