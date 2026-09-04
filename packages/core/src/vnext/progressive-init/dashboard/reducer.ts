import type { ProgressiveStageSnapshot } from "../coordinator.js";
import { PROGRESSIVE_INIT_STAGES, progressiveInitStageDefinition, type ProgressiveInitStage } from "../stages.js";
import {
  emptyProgressiveCounters,
  type ProgressiveInterviewQuestion,
  type ProgressivePresentationEvent,
  type ProgressivePresentationState,
  type ProgressiveStageActivity,
  type ProgressiveStagePresentation,
} from "./presentation.js";
import { sanitizeProgressiveBlock, sanitizeProgressiveText } from "./safety.js";

/**
 * `previous presentation state + event → next presentation state`.
 *
 * Pure and terminal-free. Disposition is only ever taken from a Core snapshot;
 * activity is only ever taken from operational events; neither overwrites the
 * other. Events belonging to another run, or arriving out of order inside this
 * run, are rejected on identity rather than aged out heuristically.
 */

function emptyStage(stage: ProgressiveInitStage): ProgressiveStagePresentation {
  return {
    stage,
    label: progressiveInitStageDefinition(stage).label,
    disposition: "incomplete",
    activity: "idle",
    skipped: false,
    findings: [],
  };
}

export function initialProgressivePresentationState(
  runId: string,
  projectRoot: string,
): ProgressivePresentationState {
  return {
    runId,
    sequence: 0,
    projectRoot: sanitizeProgressiveText(projectRoot, 512),
    phase: "initializing",
    runDisposition: "unknown",
    stages: PROGRESSIVE_INIT_STAGES.map(emptyStage),
    counters: emptyProgressiveCounters(),
    closure: { started: false, completed: false },
    ralphReady: false,
  };
}

function withStage(
  state: ProgressivePresentationState,
  stage: ProgressiveInitStage,
  patch: (entry: ProgressiveStagePresentation) => ProgressiveStagePresentation,
): readonly ProgressiveStagePresentation[] {
  return state.stages.map((entry) => (entry.stage === stage ? patch(entry) : entry));
}

/** Activity only. A running stage keeps whatever disposition Core last reported. */
function activity(
  state: ProgressivePresentationState,
  stage: ProgressiveInitStage,
  next: ProgressiveStageActivity,
): readonly ProgressiveStagePresentation[] {
  return withStage(state, stage, (entry) => ({ ...entry, activity: next }));
}

/** Whatever else was mid-flight yields focus without losing its disposition. */
function quiesceOthers(
  stages: readonly ProgressiveStagePresentation[],
  stage: ProgressiveInitStage,
): readonly ProgressiveStagePresentation[] {
  return stages.map((entry) => {
    if (entry.stage === stage) return entry;
    if (entry.activity === "failed" || entry.activity === "done" || entry.activity === "idle") return entry;
    return { ...entry, activity: "idle" };
  });
}

function applySnapshots(
  state: ProgressivePresentationState,
  snapshots: readonly ProgressiveStageSnapshot[],
): readonly ProgressiveStagePresentation[] {
  return state.stages.map((entry) => {
    const snapshot = snapshots.find((candidate) => candidate.stage === entry.stage);
    if (!snapshot) return entry;
    const findings = (snapshot.findings ?? []).map((finding) => sanitizeProgressiveText(`${finding.pointer}: ${finding.message}`, 240));
    return {
      ...entry,
      disposition: snapshot.status,
      findings,
      ...(snapshot.closureStatus ? { closureStatus: snapshot.closureStatus } : {}),
    };
  });
}

function sanitizeQuestion(question: ProgressiveInterviewQuestion): ProgressiveInterviewQuestion {
  return {
    ...question,
    key: sanitizeProgressiveText(question.key, 200),
    prompt: sanitizeProgressiveBlock(question.prompt, 4_000),
    ...(question.explanation ? { explanation: sanitizeProgressiveBlock(question.explanation, 4_000) } : {}),
    ...(question.recommendedLabel ? { recommendedLabel: sanitizeProgressiveText(question.recommendedLabel, 400) } : {}),
    ...(question.recommendedRationale ? { recommendedRationale: sanitizeProgressiveBlock(question.recommendedRationale, 1_200) } : {}),
    options: question.options.map((option) => ({
      ...option,
      label: sanitizeProgressiveBlock(option.label, 600),
      details: option.details.map((detail) => sanitizeProgressiveBlock(detail, 600)),
    })),
    alternatives: question.alternatives.map((alternative) => sanitizeProgressiveText(alternative, 400)),
    answerPrompt: sanitizeProgressiveText(question.answerPrompt, 200),
  };
}

/** Late events from a superseded run, and replays inside this run, change nothing. */
export function acceptsProgressiveEvent(
  state: ProgressivePresentationState,
  event: ProgressivePresentationEvent,
): boolean {
  return event.runId === state.runId && event.sequence > state.sequence;
}

export function reduceProgressivePresentation(
  state: ProgressivePresentationState,
  event: ProgressivePresentationEvent,
): ProgressivePresentationState {
  if (!acceptsProgressiveEvent(state, event)) return state;
  const advanced: ProgressivePresentationState = { ...state, sequence: event.sequence };
  switch (event.kind) {
    case "run-started":
      return {
        ...advanced,
        projectRoot: sanitizeProgressiveText(event.projectRoot, 512),
        runDisposition: event.disposition,
        phase: "running",
      };
    case "run-completed":
      return {
        ...advanced,
        phase: "completed",
        zeroWork: event.zeroWork,
        activityLine: undefined,
        activeStage: undefined,
        // Nothing is still in flight once the run is complete; dispositions are
        // untouched because only a Core snapshot may change them.
        stages: advanced.stages.map((entry) => (entry.activity === "failed" ? entry : { ...entry, activity: "done" })),
      };
    case "run-failed":
      return { ...advanced, phase: "failed", failure: sanitizeProgressiveText(event.reason) };
    case "stage-snapshot":
      return { ...advanced, stages: applySnapshots(advanced, event.snapshots) };
    case "stage-started":
      return {
        ...advanced,
        phase: advanced.phase === "failed" ? advanced.phase : "running",
        activeStage: event.stage,
        stages: quiesceOthers(activity(advanced, event.stage, "running"), event.stage),
      };
    case "stage-skipped":
      return {
        ...advanced,
        stages: withStage(advanced, event.stage, (entry) => ({ ...entry, skipped: true, activity: "done" })),
      };
    case "stage-waiting-interview":
      return { ...advanced, activeStage: event.stage, stages: activity(advanced, event.stage, "waiting-interview") };
    case "stage-recovery-started":
      return { ...advanced, phase: "recovering", stages: activity(advanced, event.stage, "recovering") };
    case "stage-finished":
      return {
        ...advanced,
        phase: advanced.phase === "failed" ? advanced.phase : "running",
        stages: activity(advanced, event.stage, "done"),
        activeStage: undefined,
        interview: undefined,
      };
    case "stage-failed":
      return {
        ...advanced,
        phase: "failed",
        failure: sanitizeProgressiveText(event.reason),
        stages: activity(advanced, event.stage, "failed"),
      };
    case "interview-question-presented": {
      const question = sanitizeQuestion(event.question);
      return {
        ...advanced,
        phase: "interview",
        ...(question.stage ? { activeStage: question.stage } : {}),
        stages: question.stage ? activity(advanced, question.stage, "waiting-interview") : advanced.stages,
        interview: { question, phase: "presented" },
      };
    }
    case "interview-answer-submitted":
      if (!advanced.interview || advanced.interview.question.key !== event.questionKey) return advanced;
      return { ...advanced, interview: { question: advanced.interview.question, phase: "submitting" } };
    case "interview-answer-accepted":
      if (!advanced.interview || advanced.interview.question.key !== event.questionKey) return advanced;
      return {
        ...advanced,
        interview: undefined,
        phase: advanced.phase === "interview" ? "running" : advanced.phase,
        ...(advanced.activeStage ? { stages: activity(advanced, advanced.activeStage, "running") } : {}),
      };
    case "interview-answer-rejected":
      if (!advanced.interview || advanced.interview.question.key !== event.questionKey) return advanced;
      return {
        ...advanced,
        interview: {
          question: advanced.interview.question,
          phase: "rejected",
          rejection: sanitizeProgressiveText(event.reason, 400),
        },
      };
    case "semantic-operation-started":
      return { ...advanced, stages: activity(advanced, event.stage, "semantic-operation") };
    case "semantic-operation-finished":
      return { ...advanced, stages: activity(advanced, event.stage, "running") };
    case "transport-invocation-started": {
      const stage = event.stage ?? advanced.activeStage;
      return stage ? { ...advanced, stages: activity(advanced, stage, "transport") } : advanced;
    }
    case "transport-invocation-finished": {
      const stage = event.stage ?? advanced.activeStage;
      return stage ? { ...advanced, stages: activity(advanced, stage, "running") } : advanced;
    }
    case "transport-retry": {
      const stage = event.stage ?? advanced.activeStage;
      return stage ? { ...advanced, stages: activity(advanced, stage, "transport") } : advanced;
    }
    case "corrective-regeneration-started":
      return { ...advanced, phase: "recovering", stages: activity(advanced, event.stage, "recovering") };
    case "corrective-regeneration-finished":
      return {
        ...advanced,
        phase: advanced.phase === "recovering" ? "running" : advanced.phase,
        stages: activity(advanced, event.stage, "running"),
      };
    case "corrective-regeneration-exhausted":
      return {
        ...advanced,
        phase: "failed",
        stages: activity(advanced, event.stage, "failed"),
        failure: advanced.failure ?? "corrective regeneration exhausted",
      };
    case "provider-selected":
      return {
        ...advanced,
        provider: {
          providerLabel: sanitizeProgressiveText(event.identity.providerLabel, 120),
          modelLabel: sanitizeProgressiveText(event.identity.modelLabel, 120),
          // The exact registry profile id is carried verbatim; it is never rebuilt from a label.
          profileId: sanitizeProgressiveText(event.identity.profileId, 200),
          transport: sanitizeProgressiveText(event.identity.transport, 60),
          requestAccounting: sanitizeProgressiveText(event.identity.requestAccounting, 60),
        },
      };
    case "counters":
      return { ...advanced, counters: event.counters };
    case "closure-started":
      return {
        ...advanced,
        phase: "closing",
        closure: { started: true, completed: false },
        stages: activity(advanced, "project-phases", "closing"),
      };
    case "closure-completed":
      return { ...advanced, closure: { started: true, completed: true } };
    case "closure-failed":
      return {
        ...advanced,
        phase: "failed",
        closure: { started: true, completed: false, failureReason: sanitizeProgressiveText(event.reason, 400) },
      };
    case "readiness":
      return {
        ...advanced,
        ralphReady: event.established,
        ...(event.established
          ? {}
          : { activityLine: event.reasons.length ? sanitizeProgressiveText(event.reasons.join("; "), 400) : advanced.activityLine }),
      };
    default:
      return advanced;
  }
}

export function reduceProgressivePresentationAll(
  state: ProgressivePresentationState,
  events: readonly ProgressivePresentationEvent[],
): ProgressivePresentationState {
  return events.reduce(reduceProgressivePresentation, state);
}
