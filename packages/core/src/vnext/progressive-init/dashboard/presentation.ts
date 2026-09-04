import type { InterviewQuestionEvidence } from "../../interview.js";
import type { ProgressiveStageSnapshot, ProgressiveStageStatus } from "../coordinator.js";
import type { ProgressiveInitStage } from "../stages.js";

/**
 * Progressive Init presentation contracts.
 *
 * Everything declared here is a projection of authority that already exists in
 * the coordinator. The Dashboard observes; it never decides stage completion,
 * freshness, reconciliation, closure, readiness, or recovery permission.
 */

/** Core-owned disposition. Deliberately the coordinator's own status union. */
export type ProgressiveStageDisposition = ProgressiveStageStatus;

/** What is happening right now. Never a substitute for the disposition. */
export type ProgressiveStageActivity =
  | "idle"
  | "running"
  | "waiting-interview"
  | "semantic-operation"
  | "transport"
  | "recovering"
  | "closing"
  | "failed"
  | "done";

export interface ProgressiveStagePresentation {
  readonly stage: ProgressiveInitStage;
  readonly label: string;
  /** Authoritative; only a Core snapshot may change it. */
  readonly disposition: ProgressiveStageDisposition;
  /** Operational only; running never erases a stale disposition. */
  readonly activity: ProgressiveStageActivity;
  readonly skipped: boolean;
  readonly findings: readonly string[];
  readonly closureStatus?: "fresh" | "stale";
}

/** Exact provider identity. `profileId` is always the registry object's own id. */
export interface ProgressiveProviderIdentity {
  readonly providerLabel: string;
  readonly modelLabel: string;
  readonly profileId: string;
  readonly transport: string;
  readonly requestAccounting: string;
}

export type ProgressiveMeasuredCount =
  | { readonly measured: true; readonly value: number }
  | { readonly measured: false; readonly reason: string };

export interface ProgressiveCountTelemetry {
  readonly used: ProgressiveMeasuredCount;
}

/**
 * Operational telemetry. Progressive Core supplies no execution ceilings on
 * this path, so this contract deliberately has no limit field.
 */
export interface ProgressiveExecutionCounters {
  readonly semanticOperations: ProgressiveCountTelemetry;
  readonly transportInvocations: ProgressiveCountTelemetry;
  readonly correctiveRegenerationsRun: ProgressiveCountTelemetry;
  readonly correctiveRegenerationsSlice: ProgressiveCountTelemetry;
  /** Structurally distinct from corrective regeneration; never merged into it. */
  readonly transportRetries: ProgressiveCountTelemetry;
}

export const TRANSPORT_RETRY_UNMEASURED_REASON = "transport retries are not accounted by Progressive Core";

export function emptyProgressiveCounters(): ProgressiveExecutionCounters {
  return {
    semanticOperations: { used: { measured: true, value: 0 } },
    transportInvocations: { used: { measured: true, value: 0 } },
    correctiveRegenerationsRun: { used: { measured: true, value: 0 } },
    correctiveRegenerationsSlice: { used: { measured: true, value: 0 } },
    transportRetries: { used: { measured: false, reason: TRANSPORT_RETRY_UNMEASURED_REASON } },
  };
}

/** One closed option as the developer navigates it. Identity is never a terminal row. */
export interface ProgressiveInterviewOption {
  readonly id: string;
  readonly label: string;
  readonly details: readonly string[];
  readonly recommended: boolean;
}

export interface ProgressiveInterviewQuestion {
  readonly key: string;
  readonly stage?: ProgressiveInitStage;
  readonly ordinal: number;
  readonly prompt: string;
  readonly explanation?: string;
  readonly recommendedLabel?: string;
  readonly recommendedRationale?: string;
  /** Only a Core-declared closed option list. Never derived from alternatives. */
  readonly options: readonly ProgressiveInterviewOption[];
  /** Informative Core alternatives; an open answer is still free text. */
  readonly alternatives: readonly string[];
  readonly answerPrompt: string;
}

export type ProgressiveInterviewPhase = "presented" | "submitting" | "rejected";

export interface ProgressiveInterviewPresentation {
  readonly question: ProgressiveInterviewQuestion;
  readonly phase: ProgressiveInterviewPhase;
  readonly rejection?: string;
}

export type ProgressiveRunPhase =
  | "initializing"
  | "running"
  | "interview"
  | "recovering"
  | "closing"
  | "completed"
  | "failed";

export interface ProgressiveClosurePresentation {
  readonly started: boolean;
  readonly completed: boolean;
  readonly failureReason?: string;
}

export interface ProgressivePresentationState {
  readonly runId: string;
  readonly sequence: number;
  readonly projectRoot: string;
  readonly phase: ProgressiveRunPhase;
  readonly runDisposition: "fresh-run" | "resume" | "unknown";
  readonly stages: readonly ProgressiveStagePresentation[];
  /** Presentation focus only; the coordinator alone decides what actually runs. */
  readonly activeStage?: ProgressiveInitStage;
  readonly provider?: ProgressiveProviderIdentity;
  readonly counters: ProgressiveExecutionCounters;
  readonly interview?: ProgressiveInterviewPresentation;
  readonly closure: ProgressiveClosurePresentation;
  /** Authoritative only. Never inferred from an absence of provider activity. */
  readonly zeroWork?: boolean;
  /** Authoritative Ralph readiness, established only by Core inspection. */
  readonly ralphReady: boolean;
  readonly failure?: string;
  readonly activityLine?: string;
}

export interface ProgressivePresentationEventEnvelope {
  /** Run identity. A late event from an earlier run is rejected, never aged out. */
  readonly runId: string;
  readonly sequence: number;
}

export type ProgressivePresentationEventBody =
  | { readonly kind: "run-started"; readonly projectRoot: string; readonly disposition: "fresh-run" | "resume" }
  | { readonly kind: "run-completed"; readonly zeroWork: boolean }
  | { readonly kind: "run-failed"; readonly reason: string }
  | { readonly kind: "stage-snapshot"; readonly snapshots: readonly ProgressiveStageSnapshot[] }
  | { readonly kind: "stage-started"; readonly stage: ProgressiveInitStage }
  | { readonly kind: "stage-skipped"; readonly stage: ProgressiveInitStage }
  | { readonly kind: "stage-waiting-interview"; readonly stage: ProgressiveInitStage }
  | { readonly kind: "stage-recovery-started"; readonly stage: ProgressiveInitStage }
  | { readonly kind: "stage-finished"; readonly stage: ProgressiveInitStage }
  | { readonly kind: "stage-failed"; readonly stage: ProgressiveInitStage; readonly reason: string }
  | { readonly kind: "interview-question-presented"; readonly question: ProgressiveInterviewQuestion }
  | { readonly kind: "interview-answer-submitted"; readonly questionKey: string }
  | { readonly kind: "interview-answer-accepted"; readonly questionKey: string }
  | { readonly kind: "interview-answer-rejected"; readonly questionKey: string; readonly reason: string }
  | { readonly kind: "semantic-operation-started"; readonly stage: ProgressiveInitStage }
  | { readonly kind: "semantic-operation-finished"; readonly stage: ProgressiveInitStage }
  | { readonly kind: "transport-invocation-started"; readonly stage?: ProgressiveInitStage }
  | { readonly kind: "transport-invocation-finished"; readonly stage?: ProgressiveInitStage }
  | { readonly kind: "transport-retry"; readonly stage?: ProgressiveInitStage }
  | { readonly kind: "corrective-regeneration-started"; readonly stage: ProgressiveInitStage }
  | { readonly kind: "corrective-regeneration-finished"; readonly stage: ProgressiveInitStage }
  | { readonly kind: "corrective-regeneration-exhausted"; readonly stage: ProgressiveInitStage }
  | { readonly kind: "provider-selected"; readonly identity: ProgressiveProviderIdentity }
  | { readonly kind: "counters"; readonly counters: ProgressiveExecutionCounters }
  | { readonly kind: "closure-started" }
  | { readonly kind: "closure-completed" }
  | { readonly kind: "closure-failed"; readonly reason: string }
  | { readonly kind: "readiness"; readonly established: boolean; readonly reasons: readonly string[] };

export type ProgressivePresentationEvent = ProgressivePresentationEventEnvelope & ProgressivePresentationEventBody;

/**
 * Observability sink. Core performs exactly the same semantic operation whether
 * or not a subscriber exists, so emission never returns a value the producer
 * can wait on.
 */
export type ProgressivePresentationObserver = (event: ProgressivePresentationEvent) => void;

/** Presentation-only projection of one Core interview question. */
export function progressiveInterviewQuestion(
  evidence: InterviewQuestionEvidence,
  context: { readonly ordinal: number; readonly stage?: ProgressiveInitStage },
): ProgressiveInterviewQuestion {
  const recommendedLabel = evidence.recommendedLabel ?? evidence.recommendedAnswer.value;
  // A question is a selection question only when Core declared closed choices.
  // Alternatives are guidance for an open answer, so promoting them to a closed
  // list would remove the developer's ability to give a different answer.
  const options: ProgressiveInterviewOption[] = (evidence.choices ?? []).map((choice, index) => ({
    id: `choice:${index}`,
    label: choice.label,
    details: [...(choice.details ?? [])],
    recommended: choice.label === recommendedLabel,
  }));
  return {
    key: evidence.key,
    ...(context.stage ? { stage: context.stage } : {}),
    ordinal: context.ordinal,
    prompt: evidence.question,
    ...(evidence.showRecommendation === false ? {} : {
      recommendedLabel,
      recommendedRationale: evidence.recommendedAnswer.rationale,
    }),
    options,
    alternatives: [...evidence.alternatives],
    answerPrompt: evidence.answerPrompt ?? "Answer (blank accepts the recommendation)",
  };
}
