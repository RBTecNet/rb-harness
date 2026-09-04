import { describe, expect, it } from "vitest";
import type { ProgressiveStageSnapshot } from "../src/vnext/progressive-init/coordinator.js";
import {
  emptyProgressiveCounters,
  progressiveInterviewQuestion,
  type ProgressivePresentationEvent,
  type ProgressivePresentationEventBody,
  type ProgressivePresentationState,
} from "../src/vnext/progressive-init/dashboard/presentation.js";
import {
  acceptsProgressiveEvent,
  initialProgressivePresentationState,
  reduceProgressivePresentation,
  reduceProgressivePresentationAll,
} from "../src/vnext/progressive-init/dashboard/reducer.js";
import { sanitizeProgressiveText } from "../src/vnext/progressive-init/dashboard/safety.js";
import type { InterviewQuestionEvidence } from "../src/vnext/interview.js";

function stream(runId: string, bodies: readonly ProgressivePresentationEventBody[], from = 1): ProgressivePresentationEvent[] {
  return bodies.map((body, index) => ({ runId, sequence: from + index, ...body } as ProgressivePresentationEvent));
}

function apply(
  state: ProgressivePresentationState,
  bodies: readonly ProgressivePresentationEventBody[],
): ProgressivePresentationState {
  return reduceProgressivePresentationAll(state, stream(state.runId, bodies, state.sequence + 1));
}

function snapshots(overrides: Partial<Record<string, ProgressiveStageSnapshot>> = {}): ProgressiveStageSnapshot[] {
  const base: ProgressiveStageSnapshot[] = [
    { stage: "project-description", status: "complete-fresh" },
    { stage: "user-stories", status: "complete-fresh" },
    { stage: "database-schema", status: "complete-stale" },
    { stage: "project-phases", status: "incomplete" },
  ];
  return base.map((entry) => overrides[entry.stage] ?? entry);
}

const evidence: InterviewQuestionEvidence = {
  key: "persistence.story",
  question: "Should the greeting story persist data?",
  materiality: "architecture",
  rigidity: "RIGID",
  recommendedAnswer: { value: "Not persisted", rationale: "The workflow completes within one process invocation." },
  alternatives: [],
  persistedBeforeSelection: true,
  presented: false,
  response: null,
  selectedValue: null,
  acceptanceMode: null,
  choices: [
    { label: "Not persisted", details: ["Option key: not-persisted"] },
    { label: "Tenant-owned with explicit tenant_id", details: ["Option key: tenant-owned"] },
  ],
  recommendedLabel: "Not persisted",
};

describe("Progressive Dashboard presentation state", () => {
  it("keeps the authoritative disposition independent from operational activity", () => {
    const state = apply(initialProgressivePresentationState("run-a", "/project"), [
      { kind: "run-started", projectRoot: "/project", disposition: "fresh-run" },
      { kind: "stage-snapshot", snapshots: snapshots() },
      { kind: "stage-started", stage: "database-schema" },
    ]);
    const stage = state.stages.find((entry) => entry.stage === "database-schema")!;
    // stale + running is a valid pair; running must never erase stale.
    expect(stage.disposition).toBe("complete-stale");
    expect(stage.activity).toBe("running");
    expect(state.stages.find((entry) => entry.stage === "project-phases")!.disposition).toBe("incomplete");
  });

  it("keeps incomplete + waiting-interview and reconciliation distinct from stale", () => {
    const withReconciliation = snapshots({
      "database-schema": {
        stage: "database-schema",
        status: "reconciliation-required",
        findings: [{ pointer: "/stories/0", message: "upstream story changed" }],
      },
    });
    const state = apply(initialProgressivePresentationState("run-a", "/project"), [
      { kind: "stage-snapshot", snapshots: withReconciliation },
      { kind: "stage-waiting-interview", stage: "project-phases" },
    ]);
    const schema = state.stages.find((entry) => entry.stage === "database-schema")!;
    const phases = state.stages.find((entry) => entry.stage === "project-phases")!;
    expect(schema.disposition).toBe("reconciliation-required");
    expect(schema.findings).toEqual(["/stories/0: upstream story changed"]);
    expect(phases.disposition).toBe("incomplete");
    expect(phases.activity).toBe("waiting-interview");
  });

  it("shows resume as Core decided it, without deciding the resume point itself", () => {
    const state = apply(initialProgressivePresentationState("run-a", "/project"), [
      { kind: "stage-snapshot", snapshots: snapshots() },
      { kind: "stage-skipped", stage: "project-description" },
      { kind: "stage-skipped", stage: "user-stories" },
      { kind: "stage-started", stage: "database-schema" },
    ]);
    expect(state.stages.map((entry) => [entry.disposition, entry.activity, entry.skipped])).toEqual([
      ["complete-fresh", "done", true],
      ["complete-fresh", "done", true],
      ["complete-stale", "running", false],
      ["incomplete", "idle", false],
    ]);
  });

  it("rejects a late event from a superseded run on identity, not on age", () => {
    const runB = apply(initialProgressivePresentationState("run-b", "/project"), [
      { kind: "run-started", projectRoot: "/project", disposition: "fresh-run" },
      { kind: "stage-snapshot", snapshots: snapshots() },
    ]);
    const lateFromRunA: ProgressivePresentationEvent = {
      runId: "run-a",
      sequence: 999,
      kind: "stage-failed",
      stage: "project-description",
      reason: "run A failure arriving late",
    };
    expect(acceptsProgressiveEvent(runB, lateFromRunA)).toBe(false);
    expect(reduceProgressivePresentation(runB, lateFromRunA)).toBe(runB);
  });

  it("ignores an out-of-order replay inside the same run", () => {
    const state = apply(initialProgressivePresentationState("run-a", "/project"), [
      { kind: "stage-started", stage: "project-description" },
      { kind: "stage-finished", stage: "project-description" },
    ]);
    const replay: ProgressivePresentationEvent = {
      runId: "run-a", sequence: state.sequence - 1, kind: "stage-started", stage: "project-description",
    };
    expect(reduceProgressivePresentation(state, replay)).toBe(state);
  });

  it("never lets provider activity complete a stage", () => {
    const state = apply(initialProgressivePresentationState("run-a", "/project"), [
      { kind: "stage-started", stage: "project-description" },
      { kind: "semantic-operation-started", stage: "project-description" },
      { kind: "transport-invocation-started", stage: "project-description" },
      { kind: "transport-invocation-finished", stage: "project-description" },
      { kind: "semantic-operation-finished", stage: "project-description" },
    ]);
    const stage = state.stages.find((entry) => entry.stage === "project-description")!;
    expect(stage.disposition).toBe("incomplete");
    expect(state.ralphReady).toBe(false);
  });

  it("locks a submission, refuses fake acceptance, and keeps a rejected interview usable", () => {
    const question = progressiveInterviewQuestion(evidence, { ordinal: 1, stage: "database-schema" });
    let state = apply(initialProgressivePresentationState("run-a", "/project"), [
      { kind: "interview-question-presented", question },
    ]);
    expect(state.interview?.phase).toBe("presented");
    state = apply(state, [{ kind: "interview-answer-submitted", questionKey: question.key }]);
    expect(state.interview?.phase).toBe("submitting");
    // A second submission for the same question changes nothing.
    const locked = apply(state, [{ kind: "interview-answer-submitted", questionKey: question.key }]);
    expect(locked.interview?.phase).toBe("submitting");
    const rejected = apply(state, [
      { kind: "interview-answer-rejected", questionKey: question.key, reason: "choose a listed option" },
    ]);
    expect(rejected.interview?.phase).toBe("rejected");
    expect(rejected.interview?.question.options).toHaveLength(2);
    expect(rejected.ralphReady).toBe(false);
    const accepted = apply(rejected, [{ kind: "interview-answer-accepted", questionKey: question.key }]);
    expect(accepted.interview).toBeUndefined();
  });

  it("keeps P4, closure and Ralph READY as three distinct states", () => {
    let state = apply(initialProgressivePresentationState("run-a", "/project"), [
      {
        kind: "stage-snapshot",
        snapshots: [
          { stage: "project-description", status: "complete-fresh" },
          { stage: "user-stories", status: "complete-fresh" },
          { stage: "database-schema", status: "complete-fresh" },
          { stage: "project-phases", status: "complete-fresh" },
        ],
      },
    ]);
    expect(state.stages.at(-1)!.disposition).toBe("complete-fresh");
    expect(state.closure.completed).toBe(false);
    expect(state.ralphReady).toBe(false);

    state = apply(state, [{ kind: "closure-started" }, { kind: "closure-completed" }]);
    expect(state.closure.completed).toBe(true);
    expect(state.ralphReady).toBe(false);

    state = apply(state, [{ kind: "readiness", established: true, reasons: [] }]);
    expect(state.ralphReady).toBe(true);
  });

  it("shows zero-work only from an authoritative run summary", () => {
    const inferred = apply(initialProgressivePresentationState("run-a", "/project"), [
      { kind: "stage-snapshot", snapshots: snapshots() },
    ]);
    expect(inferred.zeroWork).toBeUndefined();
    const authoritative = apply(inferred, [{ kind: "run-completed", zeroWork: true }]);
    expect(authoritative.zeroWork).toBe(true);
  });

  it("carries measured counts without borrowing Canonical Init limits", () => {
    const empty = emptyProgressiveCounters();
    expect(Object.values(empty).every((usage) => !("limit" in usage))).toBe(true);
    expect(empty.transportRetries.used.measured).toBe(false);
    expect(Object.keys(empty).sort()).toEqual([
      "correctiveRegenerationsRun", "correctiveRegenerationsSlice",
      "semanticOperations", "transportInvocations", "transportRetries",
    ]);

    const state = apply(initialProgressivePresentationState("run-a", "/project"), [
      {
        kind: "counters",
        counters: {
          ...empty,
          semanticOperations: { used: { measured: true, value: 6 } },
          correctiveRegenerationsRun: { used: { measured: true, value: 1 } },
        },
      },
    ]);
    expect(state.counters.semanticOperations.used).toEqual({ measured: true, value: 6 });
    expect(state.counters.correctiveRegenerationsRun.used).toEqual({ measured: true, value: 1 });
  });

  it("sanitizes presentation payloads so credentials never reach a frame", () => {
    const state = apply(initialProgressivePresentationState("run-a", "/project"), [
      { kind: "run-failed", reason: "provider rejected Authorization: Bearer abcdef0123456789 and api_key=sk-livesecretvalue0" },
    ]);
    expect(state.failure).not.toContain("abcdef0123456789");
    expect(state.failure).not.toContain("sk-livesecretvalue0");
    expect(state.failure).toContain("[redacted-credential]");
    expect(sanitizeProgressiveText("line one\nline two")).toBe("line one line two");
  });

  it("projects Core choices as logical options with the recommendation marked", () => {
    const question = progressiveInterviewQuestion(evidence, { ordinal: 2, stage: "database-schema" });
    expect(question.options.map((option) => [option.label, option.recommended])).toEqual([
      ["Not persisted", true],
      ["Tenant-owned with explicit tenant_id", false],
    ]);
    expect(question.ordinal).toBe(2);
    expect(question.stage).toBe("database-schema");
  });
});
