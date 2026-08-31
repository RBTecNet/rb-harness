import { semanticKey, type SemanticKey } from "./identity.js";
import type {
  AcceptedRecommendationProof,
  DeterminationSourceInput,
  Materiality,
  RecommendationAcceptanceMode,
  Rigidity,
} from "./ir.js";

export interface ProposedQuestion {
  readonly key: string;
  readonly question: string;
  readonly materiality: Materiality;
  readonly rigidity: Rigidity;
  readonly recommendedAnswer: {
    readonly value: string;
    readonly rationale: string;
  };
  readonly alternatives?: readonly string[];
}

export type InterviewAcceptanceMode = "explicit" | RecommendationAcceptanceMode;

export interface InterviewChoicePresentation {
  readonly label: string;
  readonly details?: readonly string[];
}

/** Orchestration evidence. It is deliberately not part of InitProjectModel. */
export interface InterviewQuestionEvidence {
  readonly key: string;
  readonly question: string;
  readonly materiality: Materiality;
  readonly rigidity: Rigidity;
  readonly recommendedAnswer: { readonly value: string; readonly rationale: string };
  readonly alternatives: readonly string[];
  readonly persistedBeforeSelection: boolean;
  readonly presented: boolean;
  readonly response: string | null;
  readonly selectedValue: string | null;
  readonly acceptanceMode: InterviewAcceptanceMode | null;
  /** Presentation-only prompt override. Omitted by ordinary semantic questions. */
  readonly answerPrompt?: string;
  /** Presentation-only numbered choices. Selection identity remains outside this view. */
  readonly choices?: readonly InterviewChoicePresentation[];
  /** Presentation-only recommendation visibility. Defaults to true. */
  readonly showRecommendation?: boolean;
  /** Presentation-only recommendation label. Semantic selection keeps recommendedAnswer.value. */
  readonly recommendedLabel?: string;
}

export interface VerifiedInterviewDecision {
  readonly questionKey: SemanticKey;
  readonly selectedValue: string;
  readonly source: DeterminationSourceInput;
  readonly acceptanceMode: InterviewAcceptanceMode;
  readonly acceptedRecommendation?: AcceptedRecommendationProof;
}

const NON_DECISIONS = new Set([
  "whatever is best",
  "it depends",
  "ask the developer",
  "use the appropriate solution",
]);

const NON_DECISION_PATTERNS = [
  /^(?:use|choose|select|pick)\s+(?:(?:a|an|the)\s+)?(?:appropriate|suitable|sensible|standard|best|right)\b/i,
  /^(?:(?:a|an|the)\s+)?(?:appropriate|suitable|sensible|standard|best|right)\s+(?:approach|choice|database|framework|option|solution|technology|tool)\b/i,
  /^whatever\s+(?:is\s+best|works|makes\s+sense)\b/i,
] as const;

function clean(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

export function questionProblem(question: ProposedQuestion): string | undefined {
  if (!semanticKey(question.key)) return "question key must use the semantic-key grammar";
  if (clean(question.question).length < 8) return "question must be concrete";
  const recommended = clean(question.recommendedAnswer.value);
  if (
    !recommended
    || NON_DECISIONS.has(recommended.toLowerCase())
    || NON_DECISION_PATTERNS.some((pattern) => pattern.test(recommended))
  ) return "recommended answer must be a concrete selectable decision";
  if (clean(question.recommendedAnswer.rationale).length < 8) return "recommended answer rationale must be non-empty and useful";
  if (question.alternatives?.some((value) => !clean(value))) return "alternatives must be non-empty";
  return undefined;
}

export function pendingQuestionEvidence(question: ProposedQuestion): InterviewQuestionEvidence {
  const problem = questionProblem(question);
  if (problem) throw new Error(`INVALID_INTERVIEW_QUESTION ${question.key}: ${problem}`);
  return {
    key: question.key,
    question: clean(question.question),
    materiality: question.materiality,
    rigidity: question.rigidity,
    recommendedAnswer: {
      value: clean(question.recommendedAnswer.value),
      rationale: clean(question.recommendedAnswer.rationale),
    },
    alternatives: (question.alternatives ?? []).map(clean),
    persistedBeforeSelection: true,
    presented: false,
    response: null,
    selectedValue: null,
    acceptanceMode: null,
  };
}

export function selectInterviewAnswer(
  evidence: InterviewQuestionEvidence,
  input: { readonly kind: "interactive"; readonly response: string } | { readonly kind: "headless" },
): InterviewQuestionEvidence {
  if (!evidence.persistedBeforeSelection || evidence.selectedValue !== null) {
    throw new Error(`INTERVIEW_STATE_INVALID: question ${evidence.key} was not pending persisted evidence`);
  }
  if (input.kind === "headless") {
    return {
      ...evidence,
      response: null,
      selectedValue: evidence.recommendedAnswer.value,
      acceptanceMode: "non-interactive-policy",
    };
  }
  const response = input.response.trim();
  if (response) {
    return { ...evidence, presented: true, response, selectedValue: response, acceptanceMode: "explicit" };
  }
  return {
    ...evidence,
    presented: true,
    response: "",
    selectedValue: evidence.recommendedAnswer.value,
    acceptanceMode: "blank-interactive",
  };
}

export function verifyInterviewEvidence(evidence: InterviewQuestionEvidence): VerifiedInterviewDecision {
  const questionKey = semanticKey(evidence.key);
  if (!questionKey || questionProblem(evidence)) throw new Error(`INTERVIEW_AUTHORITY_INVALID: malformed question ${evidence.key}`);
  if (!evidence.persistedBeforeSelection || !evidence.selectedValue?.trim() || !evidence.acceptanceMode) {
    throw new Error(`INTERVIEW_AUTHORITY_INVALID: unresolved question ${evidence.key}`);
  }
  if (evidence.acceptanceMode === "explicit") {
    if (!evidence.presented || !evidence.response?.trim() || evidence.selectedValue !== evidence.response.trim()) {
      throw new Error(`INTERVIEW_AUTHORITY_INVALID: explicit answer mismatch for ${evidence.key}`);
    }
    return {
      questionKey,
      selectedValue: evidence.selectedValue,
      acceptanceMode: "explicit",
      source: { kind: "user-answer", questionKey: evidence.key },
    };
  }
  if (evidence.selectedValue !== evidence.recommendedAnswer.value) {
    throw new Error(`INTERVIEW_AUTHORITY_INVALID: recommendation mismatch for ${evidence.key}`);
  }
  if (evidence.acceptanceMode === "blank-interactive" && (!evidence.presented || evidence.response !== "")) {
    throw new Error(`INTERVIEW_AUTHORITY_INVALID: blank acceptance was not presented for ${evidence.key}`);
  }
  if (evidence.acceptanceMode === "non-interactive-policy" && (evidence.presented || evidence.response !== null)) {
    throw new Error(`INTERVIEW_AUTHORITY_INVALID: headless acceptance evidence is inconsistent for ${evidence.key}`);
  }
  return {
    questionKey,
    selectedValue: evidence.selectedValue,
    acceptanceMode: evidence.acceptanceMode,
    source: { kind: "accepted-recommendation", questionKey: evidence.key },
    acceptedRecommendation: { value: evidence.selectedValue, acceptanceMode: evidence.acceptanceMode },
  };
}

export function formatInteractiveQuestion(question: InterviewQuestionEvidence): string {
  const lines = [`\n${question.question}`];
  if (question.choices?.length) {
    lines.push("");
    question.choices.forEach((choice, index) => {
      lines.push(`${index + 1}. ${choice.label}`);
      lines.push(...(choice.details ?? []).map((detail) => `   ${detail}`));
      if (index < question.choices!.length - 1) lines.push("");
    });
  }
  if (question.showRecommendation !== false) {
    lines.push(
      "",
      "Recommended:",
      `  ${question.recommendedLabel ?? question.recommendedAnswer.value}`,
      "",
      "Why:",
      `  ${question.recommendedAnswer.rationale}`,
    );
  }
  if (question.alternatives.length) {
    lines.push(
      "",
      "Alternatives:",
      ...question.alternatives.map((alternative, index) => `  ${index + 1}. ${alternative}`),
    );
  }
  lines.push("", question.answerPrompt ?? "Answer (blank accepts the recommendation): ");
  return lines.join("\n");
}
