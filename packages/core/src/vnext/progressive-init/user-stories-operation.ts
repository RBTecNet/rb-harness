import {
  pendingQuestionEvidence,
  selectInterviewAnswer,
  verifyInterviewEvidence,
  type InterviewQuestionEvidence,
} from "../interview.js";
import type { InitInterviewMode } from "../init.js";
import type { ModelProfile, ProviderAdapter, ResolvedProviderAuth, SemanticRequest } from "../providers/contract.js";
import {
  USER_STORIES_QUESTIONS_SCHEMA,
  USER_STORIES_SCHEMA,
  decodeUserStoriesQuestionSelection,
  decodeUserStoriesWire,
  isCapabilityParticipationQuestion,
  materializeUserStoriesInterviewDeterminations,
  materializeUserStoriesStructuralDecisions,
  requiredUserStoriesParticipationSubjects,
  resolveUserStoriesWire,
  validateUserStoriesPreservation,
  validateUserStoriesUpstreamReadiness,
  validateUserStoriesUpstreamRefinement,
  type UserStories,
  type UserStoriesFinding,
  type UserStoriesUpstreamProjection,
  type UserStoriesQuestion,
  type UserStoriesCapabilityParticipationStepOneOption,
  type UserStoriesCapabilityParticipationPairOption,
} from "./user-stories-ir.js";

export const USER_STORIES_QUESTION_INSTRUCTIONS = [
  "Recommend presentation for every Core-owned required participation subject, then select any additional ordinary user-stories questions before story authoring.",
  "For each requiredParticipationSubject, return exactly one participationRecommendations entry using its exact subjectKey and one exact Step-1 recommendedOptionKey supplied by Core.",
  "Core exclusively owns structural-question detection, workflow/capability identity, option keys, Actor keys, Operator keys, and pair construction. Do not restate, replace, merge, add, or omit structural subjects or options.",
  "Ordinary questions may resolve independently valuable story boundaries, observable outcomes, granularity, or decomposition; they cannot establish Actor, Operator, capability, or Capability Participation authority.",
  "Do not ask about databases, DBML, frameworks, deployment, phases, tasks, paths, validation commands, or whether an approved workflow should be ignored.",
  "Every recommendation and ordinary question must have concrete wording and useful rationale.",
  "Return only the strict question-selection object. Do not author stories or Markdown.",
].join("\n");

export const USER_STORIES_CANDIDATE_INSTRUCTIONS = [
  "Produce the complete user-stories stage object described by the schema after all structural questions have resolved.",
  "Author only actor/workflow story semantics. Actor is the business/story actor; Operator is the actor that directly operates the system.",
  "Every story explicitly lists the upstream capabilities it realizes. Workflow membership never implies capability coverage.",
  "Actor and Operator must be equal unless an accepted capability-participation structural decision authorizes the exact mediated pair.",
  "The selected stage decisions and structural decisions are already authoritative Core-owned constraints.",
  "Obey selectedStageDecisions, but do not restate them as determinations or alter their materiality or rigidity.",
  "Every approved workflow and every approved capability must be explicitly covered. Each story references exactly one workflow; Actor and Operator must both be eligible for it.",
  "Use stable lower-case kebab-case semantic keys. Do not emit storyId; Core owns stable US-x.y allocation.",
  "Do not infer capability coverage from workflow membership. Do not emit phases, tasks, paths, validation commands, database concepts, tables, DBML, framework choices, or Ralph machine IDs.",
  "Provider output cannot claim interview or developer authority. Existing developer authority must remain byte-for-semantic-byte unchanged.",
  "Return a complete candidate. Never return a patch or Markdown.",
].join("\n");

export interface UserStoriesOperationOptions {
  readonly upstream: UserStoriesUpstreamProjection;
  readonly existing?: UserStories;
  readonly profile: ModelProfile;
  readonly adapter: ProviderAdapter;
  readonly auth: ResolvedProviderAuth;
  readonly interview: InitInterviewMode;
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
  readonly onQuestion?: (question: InterviewQuestionEvidence) => void | Promise<void>;
}

export interface UserStoriesOperationResult {
  readonly value: UserStories;
  readonly interviewEvidence: readonly InterviewQuestionEvidence[];
  readonly semanticOperations: number;
  readonly correctiveRegenerations: number;
  readonly findingsByAttempt: readonly (readonly UserStoriesFinding[])[];
}

function requestFor(
  options: UserStoriesOperationOptions,
  slice: string,
  instructions: string,
  input: unknown,
  schema: SemanticRequest["schema"],
  schemaName: string,
  signal: AbortSignal,
): SemanticRequest {
  return {
    slice,
    instructions,
    input: JSON.stringify(input, null, 2),
    schema,
    schemaName,
    limits: { maxOutputTokens: Math.min(options.profile.maxOutputTokens, 128_000), deadlineMs: options.deadlineMs },
    reasoning: options.profile.reasoning.supported && options.profile.reasoning.defaultMode === "on"
      ? { mode: "on", effort: options.profile.reasoning.efforts[0]! }
      : { mode: "off" },
    signal,
  };
}

async function providerRequest(
  options: UserStoriesOperationOptions,
  request: SemanticRequest,
  failureCode: string,
): Promise<unknown> {
  const capability = options.adapter.checkCapabilities(options.profile, request);
  if (!capability.ok) throw new Error(`${failureCode}: ${capability.error.message}`);
  const outcome = await options.adapter.request(options.profile, options.auth, request);
  if (!outcome.ok) throw new Error(`${failureCode}: ${outcome.error.message}`);
  return outcome.value.payload;
}

interface ResolvedQuestionSelection {
  readonly questions: readonly UserStoriesQuestion[];
  readonly evidence: readonly InterviewQuestionEvidence[];
}

const STRUCTURAL_INTERACTIVE_ATTEMPTS = 3;
const STEP_ONE_SELECTION_ERROR = "Invalid structural selection. Enter a listed Step-1 number or exact Core option key.";
const STEP_TWO_SELECTION_ERROR = "Invalid structural selection. Step 2 requires a listed number or exact Core pair option key; blank is not accepted.";

function structuralRetryEvidence(
  pending: InterviewQuestionEvidence,
  feedback: string,
): InterviewQuestionEvidence {
  return { ...pending, question: `${feedback} ${pending.question}` };
}

function structuralPairLabel(
  option: UserStoriesCapabilityParticipationPairOption,
): string {
  const actorSuffix = ` (${option.actorKey})`;
  const operatorSuffix = ` (${option.operatorActorKey})`;
  if (!option.label.endsWith(operatorSuffix)) return option.label;
  const withoutOperatorKey = option.label.slice(0, -operatorSuffix.length);
  const separator = `${actorSuffix} / `;
  const separatorIndex = withoutOperatorKey.lastIndexOf(separator);
  if (separatorIndex < 0) return option.label;
  return `${withoutOperatorKey.slice(0, separatorIndex)} / ${withoutOperatorKey.slice(separatorIndex + separator.length)}`;
}

function structuralQuestionEvidence(question: Extract<UserStoriesQuestion, { readonly kind: "capability-participation" }>): InterviewQuestionEvidence {
  const recommended = question.stepOneOptions.find((option) => option.key === question.recommendedOptionKey)!;
  return {
    ...pendingQuestionEvidence({
      key: question.key,
      question: question.question,
      materiality: question.materiality,
      rigidity: question.rigidity,
      recommendedAnswer: { value: recommended.label, rationale: question.rationale },
      alternatives: [],
    }),
    choices: question.stepOneOptions.map((option) => option.kind === "pair" ? {
      label: structuralPairLabel(option),
      details: [`Actor: ${option.actorKey}`, `Operator: ${option.operatorActorKey}`],
    } : { label: option.label }),
    recommendedLabel: recommended.kind === "pair" ? structuralPairLabel(recommended) : recommended.label,
    answerPrompt: "Choice (blank accepts recommendation): ",
  };
}

function optionFromResponse<T extends { readonly key: string }>(
  options: readonly T[],
  response: string,
): T | undefined {
  const normalized = response.trim();
  const ordinal = /^\d+$/.test(normalized) ? Number(normalized) : 0;
  return ordinal >= 1 && ordinal <= options.length
    ? options[ordinal - 1]
    : options.find((entry) => entry.key === normalized);
}

function structuralPairEvidence(
  pending: InterviewQuestionEvidence,
  pair: UserStoriesCapabilityParticipationPairOption,
  acceptance: "explicit" | "recommendation",
): InterviewQuestionEvidence {
  if (acceptance === "recommendation") return selectInterviewAnswer(pending, { kind: "interactive", response: "" });
  return selectInterviewAnswer(pending, { kind: "interactive", response: pair.label });
}

function stepTwoEvidence(
  question: Extract<UserStoriesQuestion, { readonly kind: "capability-participation" }>,
): InterviewQuestionEvidence {
  return {
    ...pendingQuestionEvidence({
      key: question.key,
      question: `Step 2 — select concrete Actor/Operator pair for ${question.workflowKey}/${question.capabilityKey}`,
      materiality: question.materiality,
      rigidity: question.rigidity,
      recommendedAnswer: {
        value: "No Step-2 recommendation; choose one concrete pair",
        rationale: "Core cannot infer a concrete mediated pair from the Step-1 recommendation or rationale.",
      },
      alternatives: [],
    }),
    choices: question.pairOptions.map((option) => ({
      label: structuralPairLabel(option),
      details: [`Actor: ${option.actorKey}`, `Operator: ${option.operatorActorKey}`],
    })),
    showRecommendation: false,
    answerPrompt: "Choice (blank is not accepted): ",
  };
}

async function resolveStructuralQuestion(
  options: UserStoriesOperationOptions,
  question: Extract<UserStoriesQuestion, { readonly kind: "capability-participation" }>,
  pending: InterviewQuestionEvidence,
): Promise<InterviewQuestionEvidence> {
  const recommended = question.stepOneOptions.find((option) => option.key === question.recommendedOptionKey)!;
  if (options.interview.kind === "headless") {
    if (recommended.kind === "escape") {
      throw new Error(`USER_STORIES_STRUCTURAL_ESCAPE_SELECTION_REQUIRED: question '${question.key}' requires a local concrete Step-2 pair selection`);
    }
    return selectInterviewAnswer(pending, { kind: "headless" });
  }
  let selected: UserStoriesCapabilityParticipationStepOneOption | undefined;
  let blank = false;
  let stepOnePrompt = pending;
  for (let attempt = 0; attempt < STRUCTURAL_INTERACTIVE_ATTEMPTS; attempt += 1) {
    const response = await options.interview.answer(stepOnePrompt);
    blank = !response.trim();
    selected = blank ? recommended : optionFromResponse(question.stepOneOptions, response);
    if (selected) break;
    if (attempt === STRUCTURAL_INTERACTIVE_ATTEMPTS - 1) {
      throw new Error(`USER_STORIES_STRUCTURAL_SELECTION_INVALID: question '${question.key}' requires a listed Step-1 number or exact Core option key`);
    }
    stepOnePrompt = structuralRetryEvidence(pending, STEP_ONE_SELECTION_ERROR);
    await options.onQuestion?.(stepOnePrompt);
  }
  if (!selected) throw new Error(`USER_STORIES_STRUCTURAL_SELECTION_INVALID: question '${question.key}' requires a listed Step-1 number or exact Core option key`);
  if (selected.kind === "pair") return structuralPairEvidence(pending, selected, blank ? "recommendation" : "explicit");
  const secondStep = stepTwoEvidence(question);
  await options.onQuestion?.(secondStep);
  let stepTwoPrompt = secondStep;
  for (let attempt = 0; attempt < STRUCTURAL_INTERACTIVE_ATTEMPTS; attempt += 1) {
    const secondResponse = await options.interview.answer(stepTwoPrompt);
    const pair = secondResponse.trim() ? optionFromResponse(question.pairOptions, secondResponse) : undefined;
    if (pair) return structuralPairEvidence(pending, pair, "explicit");
    if (attempt === STRUCTURAL_INTERACTIVE_ATTEMPTS - 1) {
      throw new Error(`USER_STORIES_STRUCTURAL_SELECTION_INVALID: question '${question.key}' Step 2 requires a listed number or exact Core pair option key`);
    }
    stepTwoPrompt = structuralRetryEvidence(secondStep, STEP_TWO_SELECTION_ERROR);
    await options.onQuestion?.(stepTwoPrompt);
  }
  throw new Error(`USER_STORIES_STRUCTURAL_SELECTION_INVALID: question '${question.key}' Step 2 requires a listed number or exact Core pair option key`);
}

async function selectQuestions(
  options: UserStoriesOperationOptions,
  signal: AbortSignal,
): Promise<ResolvedQuestionSelection> {
  const requiredParticipationSubjects = requiredUserStoriesParticipationSubjects(options.upstream, options.existing);
  const request = requestFor(
    options,
    "user-stories-questions",
    USER_STORIES_QUESTION_INSTRUCTIONS,
    {
      task: "Select every material user-stories question before complete candidate authoring.",
      upstreamProjectDescription: options.upstream,
      requiredParticipationSubjects,
      existingDeveloperAuthority: options.existing ?? null,
    },
    USER_STORIES_QUESTIONS_SCHEMA,
    "rb_user_stories_questions_v1",
    signal,
  );
  const decoded = decodeUserStoriesQuestionSelection(
    await providerRequest(options, request, "USER_STORIES_QUESTION_SELECTION_PROVIDER_FAILURE"),
    requiredParticipationSubjects,
  );
  if (!decoded.ok) {
    throw new Error(`USER_STORIES_QUESTION_SELECTION_INVALID: ${decoded.findings.map((entry) => `${entry.pointer}: ${entry.message}`).join("; ")}`);
  }
  const selected: InterviewQuestionEvidence[] = [];
  for (const proposed of decoded.value.questions) {
    const pending = isCapabilityParticipationQuestion(proposed)
      ? structuralQuestionEvidence(proposed)
      : pendingQuestionEvidence(proposed);
    await options.onQuestion?.(pending);
    if (isCapabilityParticipationQuestion(proposed)) selected.push(await resolveStructuralQuestion(options, proposed, pending));
    else if (options.interview.kind === "headless") selected.push(selectInterviewAnswer(pending, { kind: "headless" }));
    else selected.push(selectInterviewAnswer(pending, { kind: "interactive", response: await options.interview.answer(pending) }));
  }
  return { questions: decoded.value.questions, evidence: selected };
}

function selectedDecisionProjection(evidence: readonly InterviewQuestionEvidence[]): readonly unknown[] {
  return evidence.map((entry) => {
    const verified = verifyInterviewEvidence(entry);
    return {
      questionKey: verified.questionKey,
      selectedValue: verified.selectedValue,
      materiality: entry.materiality,
      rigidity: entry.rigidity,
    };
  });
}

export async function runUserStoriesOperation(options: UserStoriesOperationOptions): Promise<UserStoriesOperationResult> {
  const readiness = validateUserStoriesUpstreamReadiness(options.upstream);
  if (readiness.length) {
    throw new Error(`USER_STORIES_UPSTREAM_NOT_READY: ${readiness.map((entry) => `${entry.pointer}: ${entry.message}`).join("; ")}`);
  }
  const controller = options.signal ? undefined : new AbortController();
  const signal = options.signal ?? controller!.signal;
  const selection = await selectQuestions(options, signal);
  const interviewEvidence = selection.evidence;
  const determinations = materializeUserStoriesInterviewDeterminations(interviewEvidence, options.existing);
  if (!determinations.ok) {
      throw new Error(`USER_STORIES_INTERVIEW_DETERMINATION_CONFLICT: ${determinations.findings.map((entry) => `${entry.pointer}: ${entry.message}`).join("; ")}`);
  }
  const structuralDecisions = materializeUserStoriesStructuralDecisions(selection.questions, interviewEvidence, options.existing);
  if (!structuralDecisions.ok) {
    throw new Error(`USER_STORIES_STRUCTURAL_DECISION_CONFLICT: ${structuralDecisions.findings.map((entry) => `${entry.pointer}: ${entry.message}`).join("; ")}`);
  }
  const refinement = validateUserStoriesUpstreamRefinement(structuralDecisions.value, options.upstream);
  if (refinement.length) {
    throw new Error(
      `USER_STORIES_UPSTREAM_REFINEMENT_REQUIRED: ${refinement.map((entry) => `${entry.pointer}: ${entry.message}`).join("; ")}. `
      + "Refine the Project Description workflow participants or re-answer the structural decision before candidate generation.",
    );
  }
  const findingsByAttempt: UserStoriesFinding[][] = [];
  let previous: readonly UserStoriesFinding[] | undefined;
  for (let ordinal = 0; ordinal < 2; ordinal += 1) {
    const request = requestFor(
      options,
      "user-stories",
      USER_STORIES_CANDIDATE_INSTRUCTIONS,
      {
        task: previous
          ? "Regenerate the COMPLETE user-stories candidate; do not patch the rejected candidate."
          : "Create the complete user-stories stage candidate from the already resolved interview decisions.",
        upstreamProjectDescription: options.upstream,
        selectedStageDecisions: selectedDecisionProjection(interviewEvidence),
        structuralDecisions: structuralDecisions.value.map(({ key, workflowKey, capabilityKey, actorKey, operatorActorKey }) => ({
          kind: "capability-participation", key, workflowKey, capabilityKey, actorKey, operatorActorKey,
        })),
        existingDeveloperAuthority: options.existing ?? null,
        ...(previous ? {
          recovery: {
            completeStageRegeneration: true,
            immediatelyPrecedingFindings: previous.map(({ pointer, message }) => ({ pointer, message })),
          },
        } : {}),
      },
      USER_STORIES_SCHEMA,
      "rb_user_stories_v1",
      signal,
    );
    const decoded = decodeUserStoriesWire(await providerRequest(options, request, "USER_STORIES_PROVIDER_FAILURE"));
    let findings: readonly UserStoriesFinding[];
    if (!decoded.ok) findings = decoded.findings;
    else {
      const resolved = resolveUserStoriesWire(
        decoded.value,
        options.upstream,
        interviewEvidence,
        options.existing,
        structuralDecisions.value,
      );
      findings = resolved.ok ? validateUserStoriesPreservation(options.existing, resolved.value) : resolved.findings;
      if (resolved.ok && !findings.length) {
        return {
          value: resolved.value,
          interviewEvidence,
          semanticOperations: ordinal + 2,
          correctiveRegenerations: ordinal,
          findingsByAttempt,
        };
      }
    }
    findingsByAttempt.push([...findings]);
    previous = findings;
  }
  throw new Error(`USER_STORIES_INVALID_AFTER_RECOVERY: ${previous?.map((entry) => `${entry.pointer}: ${entry.message}`).join("; ")}`);
}
