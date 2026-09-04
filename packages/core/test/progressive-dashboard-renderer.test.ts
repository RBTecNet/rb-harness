import { describe, expect, it } from "vitest";
import { HARNESS_MASCOT_SOURCE } from "../src/harness-mascot.js";
import type { ProgressiveStageSnapshot } from "../src/vnext/progressive-init/coordinator.js";
import {
  emptyProgressiveCounters,
  progressiveInterviewQuestion,
  type ProgressiveInterviewOption,
  type ProgressivePresentationEventBody,
  type ProgressivePresentationState,
} from "../src/vnext/progressive-init/dashboard/presentation.js";
import {
  initialProgressivePresentationState,
  reduceProgressivePresentationAll,
} from "../src/vnext/progressive-init/dashboard/reducer.js";
import {
  progressiveLayoutTier,
  renderProgressiveDashboard,
} from "../src/vnext/progressive-init/dashboard/renderer.js";
import { createProgressiveSelectionState } from "../src/vnext/progressive-init/dashboard/selection.js";
import { visibleWidth } from "../src/vnext/progressive-init/dashboard/text.js";
import type { ProgressiveTerminalCapabilities } from "../src/vnext/progressive-init/dashboard/terminal.js";
import type { InterviewQuestionEvidence } from "../src/vnext/interview.js";

const CAPABILITIES: ProgressiveTerminalCapabilities = { width: 100, height: 40, color: false, unicode: true };

function apply(
  state: ProgressivePresentationState,
  bodies: readonly ProgressivePresentationEventBody[],
): ProgressivePresentationState {
  return reduceProgressivePresentationAll(
    state,
    bodies.map((body, index) => ({ runId: state.runId, sequence: state.sequence + 1 + index, ...body }) as never),
  );
}

function complete(closure: "fresh" | "stale" | undefined = "fresh"): ProgressiveStageSnapshot[] {
  return [
    { stage: "project-description", status: "complete-fresh" },
    { stage: "user-stories", status: "complete-fresh" },
    { stage: "database-schema", status: "complete-fresh" },
    { stage: "project-phases", status: "complete-fresh", ...(closure ? { closureStatus: closure } : {}) },
  ];
}

function render(state: ProgressivePresentationState, capabilities = CAPABILITIES, extra: Record<string, unknown> = {}): string {
  return renderProgressiveDashboard({ state, capabilities, version: "1.0.7", ...extra } as never);
}

function longOptions(count: number): ProgressiveInterviewOption[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `choice:${index}`,
    label: `Option ${index + 1}`,
    details: [],
    recommended: index === 7,
  }));
}

const multilineEvidence: InterviewQuestionEvidence = {
  key: "persistence.story",
  question: "Which persistence disposition applies to the greeting story, considering the approved workflow scope?",
  materiality: "architecture",
  rigidity: "RIGID",
  recommendedAnswer: { value: "Not persisted", rationale: "The approved workflow completes within one process invocation." },
  alternatives: [],
  persistedBeforeSelection: true,
  presented: false,
  response: null,
  selectedValue: null,
  acceptanceMode: null,
  choices: [
    { label: "Not persisted", details: ["Option key: not-persisted"] },
    {
      label: "Tenant-owned with explicit tenant_id — every row belongs to exactly one tenant and cross-tenant access is forbidden by construction",
      details: ["Option key: tenant-owned", "Story: print-greeting"],
    },
  ],
  recommendedLabel: "Not persisted",
};

describe("Progressive Dashboard renderer", () => {
  it("keeps every rendered row inside the terminal width", () => {
    const state = apply(initialProgressivePresentationState("run", "/very/long/project/root/path/that/keeps/going/for/a/while"), [
      { kind: "run-started", projectRoot: "/very/long/project/root/path/that/keeps/going/for/a/while", disposition: "fresh-run" },
      { kind: "stage-snapshot", snapshots: complete("stale") },
      { kind: "stage-started", stage: "project-phases" },
    ]);
    for (const width of [40, 64, 80, 100, 140]) {
      const frame = render(state, { ...CAPABILITIES, width });
      for (const line of frame.replace(/\n$/, "").split("\n")) {
        expect(visibleWidth(line), `${width}: ${line}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it("selects large, medium and small tiers and drops decoration before content", () => {
    expect(progressiveLayoutTier({ ...CAPABILITIES, width: 120, height: 40 })).toBe("large");
    expect(progressiveLayoutTier({ ...CAPABILITIES, width: 80, height: 24 })).toBe("medium");
    expect(progressiveLayoutTier({ ...CAPABILITIES, width: 50, height: 14 })).toBe("small");

    const state = apply(initialProgressivePresentationState("run", "/project"), [
      { kind: "stage-snapshot", snapshots: complete("stale") },
      { kind: "stage-started", stage: "project-phases" },
    ]);
    const large = render(state, { ...CAPABILITIES, width: 120, height: 40 });
    const small = render(state, { ...CAPABILITIES, width: 46, height: 14 });
    // Decoration disappears first; the pipeline and truthful telemetry survive.
    expect(large).toContain("▀");
    expect(small).not.toContain("▀");
    expect(small).toContain("P4");
    expect(small).toMatch(/Sem ops 0/);
    expect(small).not.toMatch(/Sem(?:antic)?(?: operations)? 0\//);
  });

  it("renders the canonical capybara and never another rodent", () => {
    const state = apply(initialProgressivePresentationState("run", "/project"), [
      { kind: "stage-snapshot", snapshots: complete("stale") },
    ]);
    const frame = render(state, { ...CAPABILITIES, width: 120, height: 40 });
    const mascotRows = HARNESS_MASCOT_SOURCE.compact.length / 2;
    expect(mascotRows).toBeGreaterThan(0);
    expect(frame).toContain("▀");
    // The art is the shared canonical capybara source, not a local redraw.
    expect(HARNESS_MASCOT_SOURCE.compact.join("")).toMatch(/^[.pdmnkcl]+$/);
  });

  it("shows disposition and activity together so running never hides stale", () => {
    const state = apply(initialProgressivePresentationState("run", "/project"), [
      {
        kind: "stage-snapshot",
        snapshots: [
          { stage: "project-description", status: "complete-fresh" },
          { stage: "user-stories", status: "complete-fresh" },
          { stage: "database-schema", status: "complete-stale" },
          { stage: "project-phases", status: "incomplete" },
        ],
      },
      { kind: "stage-started", stage: "database-schema" },
    ]);
    const frame = render(state);
    expect(frame).toMatch(/P3 . stale RUNNING/);
    expect(frame).toMatch(/P1 . fresh/);
  });

  it("shows provider, model and the exact registry profile ID verbatim", () => {
    const state = apply(initialProgressivePresentationState("run", "/project"), [
      { kind: "stage-snapshot", snapshots: complete("stale") },
      {
        kind: "provider-selected",
        identity: {
          providerLabel: "Codex / ChatGPT Subscription",
          modelLabel: "GPT-5.6 Sol",
          profileId: "openai:codex:gpt-5.6-sol",
          transport: "codex-app-server",
          requestAccounting: "opaque",
        },
      },
    ]);
    const frame = render(state);
    expect(frame).toContain("Codex / ChatGPT Subscription");
    expect(frame).toContain("GPT-5.6 Sol");
    expect(frame).toContain("openai:codex:gpt-5.6-sol");
  });

  it("prints measured telemetry without fabricated Progressive ceilings", () => {
    const state = apply(initialProgressivePresentationState("run", "/project"), [
      { kind: "stage-snapshot", snapshots: complete("stale") },
      {
        kind: "counters",
        counters: {
          ...emptyProgressiveCounters(),
          semanticOperations: { used: { measured: true, value: 6 } },
          transportInvocations: { used: { measured: true, value: 6 } },
          correctiveRegenerationsRun: { used: { measured: true, value: 1 } },
          correctiveRegenerationsSlice: { used: { measured: true, value: 1 } },
        },
      },
    ]);
    const frame = render(state, { ...CAPABILITIES, width: 180 });
    expect(frame).toContain("Semantic operations 6");
    expect(frame).toContain("Transport invocations 6");
    expect(frame).toContain("Corrective run 1");
    expect(frame).toContain("Corrective slice 1");
    expect(frame).not.toMatch(/Semantic(?: operations)? 6\/5|Transport(?: invocations)? 6\/7/);
    // Unmeasured stays unmeasured; a retry counter is never fabricated from events.
    expect(frame).toContain("Transport retry —");
    expect(frame).not.toMatch(/\bRetry \d+\/\d+\b/);
  });

  it("renders closure and Ralph READY without ever offering to start Ralph", () => {
    const state = apply(initialProgressivePresentationState("run", "/project"), [
      { kind: "stage-snapshot", snapshots: complete("fresh") },
      { kind: "closure-started" },
      { kind: "closure-completed" },
      { kind: "readiness", established: true, reasons: [] },
      { kind: "run-completed", zeroWork: false },
    ]);
    const frame = render(state);
    expect(frame).toContain("Closure ✓");
    expect(frame).toContain("RALPH READY ✓");
    expect(frame).toContain("Progressive Init complete.");
    expect(frame).toContain("Run `rb-harness --ralph` to start Ralph.");
    expect(frame).not.toMatch(/starting ralph|ralph started|launching ralph/i);
  });

  it("does not show READY when closure is fresh but readiness was not established", () => {
    const state = apply(initialProgressivePresentationState("run", "/project"), [
      { kind: "stage-snapshot", snapshots: complete("fresh") },
      { kind: "closure-completed" },
      { kind: "readiness", established: false, reasons: ["canonical closure is stale"] },
      { kind: "run-completed", zeroWork: false },
    ]);
    const frame = render(state);
    expect(frame).toContain("Ralph readiness not established");
    expect(frame).not.toContain("RALPH READY ✓");
  });

  it("renders a failure without a bypass action and without marking READY", () => {
    const state = apply(initialProgressivePresentationState("run", "/project"), [
      { kind: "stage-snapshot", snapshots: complete("stale") },
      { kind: "stage-failed", stage: "project-phases", reason: "PROJECT_PHASES_CLOSURE_VERIFICATION_FAILED: manifest mismatch" },
    ]);
    const frame = render(state);
    expect(frame).toContain("FAILED");
    expect(frame).toContain("PROJECT_PHASES_CLOSURE_VERIFICATION_FAILED");
    expect(frame).toContain("Ralph is not READY");
    expect(frame).not.toMatch(/continue anyway|ignore validation|force ready/i);
  });

  it("gives the interview the main workspace, marks the recommendation and wraps long options", () => {
    const question = progressiveInterviewQuestion(multilineEvidence, { ordinal: 1, stage: "database-schema" });
    const state = apply(initialProgressivePresentationState("run", "/project"), [
      { kind: "stage-snapshot", snapshots: complete("stale") },
      { kind: "interview-question-presented", question },
    ]);
    const selection = createProgressiveSelectionState(question.options);
    const frame = render(state, { ...CAPABILITIES, width: 80, height: 34 }, { selection });
    expect(frame).toContain("Which persistence disposition applies");
    expect(frame).toContain("Recommended: Not persisted");
    expect(frame).toContain("❯ Not persisted");
    expect(frame).toContain("Recommended");
    expect(frame).toContain("Tenant-owned with explicit tenant_id");
    expect(frame).toContain("↑ ↓ Select · Enter Submit");
    // The long option wrapped rather than being cut off.
    expect(frame).toContain("cross-tenant access is forbidden");
  });

  it("scrolls a long option list internally with previous/more indicators", () => {
    const options = longOptions(30);
    const question = { key: "q", ordinal: 1, prompt: "Pick one", options, alternatives: [], answerPrompt: "Choice" };
    const state = apply(initialProgressivePresentationState("run", "/project"), [
      { kind: "interview-question-presented", question },
    ]);
    const selection = createProgressiveSelectionState(options);
    const frame = render(state, { ...CAPABILITIES, width: 60, height: 24 }, { selection });
    expect(frame).toMatch(/↓ \d+ more/);
    expect(frame).toContain("Option 8");
  });

  it("keeps the interview usable on a small terminal and prioritizes the question", () => {
    const question = progressiveInterviewQuestion(multilineEvidence, { ordinal: 1, stage: "database-schema" });
    const state = apply(initialProgressivePresentationState("run", "/project"), [
      { kind: "interview-question-presented", question },
    ]);
    const selection = createProgressiveSelectionState(question.options);
    const frame = render(state, { width: 44, height: 14, color: false, unicode: true }, { selection });
    expect(frame).toContain("Which persistence disposition");
    expect(frame).toContain("Not persisted");
    expect(frame).not.toContain("▀");
  });

  it("falls back to ASCII glyphs on a terminal without Unicode", () => {
    const state = apply(initialProgressivePresentationState("run", "/project"), [
      { kind: "stage-snapshot", snapshots: complete("fresh") },
      { kind: "closure-completed" },
      { kind: "readiness", established: true, reasons: [] },
      { kind: "run-completed", zeroWork: true },
    ]);
    const frame = render(state, { ...CAPABILITIES, unicode: false });
    expect(frame).not.toContain("┌");
    expect(frame).toContain("+");
    expect(frame).toContain("RALPH READY x");
    expect(frame).toContain("already complete and fresh");
  });
});
