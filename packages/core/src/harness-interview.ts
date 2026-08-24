/**
 * Finite interview (RF-003).
 *
 * One batch of at most five material questions, at most one focused follow-up
 * with at most three, and then a decision: ready, or BLOCKED naming the
 * missing decision. `one-by-one` is a local presentation mode and never costs
 * an extra provider call.
 *
 * The parser normalizes superficial protocol deviations — question IDs, types,
 * option arrays, missing classifications — instead of discarding a complete,
 * paid-for response over a formatting detail. Only a response that is not
 * parseable JSON in the declared envelope is rejected.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runProvider } from "./harness-provider.js";
import { HARNESS_BUDGET, interviewQuestionBudget } from "./harness-budget.js";
import { interviewContractDigest, interviewRoundDirective } from "./harness-contract-digest.js";
import { extractEnvelope } from "./harness-documents.js";
import { assertPromptWithinBudget, serializeInputPackage, type HarnessInputPackage } from "./harness-input-package.js";
import { loadWorkflowResources, requestNeedsHeadlessContracts } from "./standalone-resources.js";
import type {
  AnswerDisposition,
  AnswerReview,
  HarnessRunState,
  InterviewAnalysis,
  InterviewAnswer,
  InterviewQuestion,
  ProviderConfiguration,
} from "./standalone-types.js";

const BEGIN = "RB_HARNESS_INTERVIEW_JSON_BEGIN";
const END = "RB_HARNESS_INTERVIEW_JSON_END";
const QUESTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/;
const UNRESOLVED_DISPOSITIONS = new Set<AnswerDisposition>(["PARTIAL", "AMBIGUOUS", "CONTRADICTED"]);

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringList(value: unknown, max = 50): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
    .map((entry) => entry.trim())
    .slice(0, max);
}

/** Turn any provider-supplied identifier into a usable stable correlation key. */
export function normalizeQuestionId(value: unknown, index: number, claimed: Set<string>): string {
  const raw = typeof value === "string" ? value.trim() : "";
  let candidate = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  if (!QUESTION_ID.test(candidate)) candidate = `q${index + 1}`;
  if (!claimed.has(candidate)) {
    claimed.add(candidate);
    return candidate;
  }
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const next = `${candidate.slice(0, 76)}-${suffix}`;
    if (!claimed.has(next)) {
      claimed.add(next);
      return next;
    }
  }
  throw new Error("interview questions exhausted the stable ID space");
}

function normalizeQuestion(
  value: unknown,
  index: number,
  claimed: Set<string>,
  normalizations: string[],
): InterviewQuestion | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const question = text(source.question);
  if (!question) return undefined;
  const id = normalizeQuestionId(source.id, index, claimed);
  if (typeof source.id === "string" && source.id.trim() !== id) {
    normalizations.push(`question id ${source.id.trim()} normalized to ${id}`);
  }
  const options = stringList(source.options, 6);
  let type: InterviewQuestion["type"] | undefined =
    source.type === "single-choice" || source.type === "confirm" || source.type === "text"
      ? source.type
      : undefined;
  if (!type) {
    type = options.length >= 2 ? "single-choice" : "text";
    normalizations.push(`question ${id} received the inferred type ${type}`);
  }
  if (type === "single-choice" && options.length < 2) {
    type = "text";
    normalizations.push(`question ${id} declared single-choice without two options and became free text`);
  }
  const finalOptions = type === "single-choice" ? options : [];
  if (type !== "single-choice" && options.length) {
    normalizations.push(`question ${id} dropped choices that its type cannot use`);
  }
  return {
    id,
    question,
    why: text(source.why, "This decision changes the generated documentation."),
    type,
    options: finalOptions,
    ...(text(source.recommendation) ? { recommendation: text(source.recommendation) } : {}),
    ...(text(source.evidence) ? { evidence: text(source.evidence) } : {}),
    ...(text(source.answerFor) ? { answerFor: text(source.answerFor) } : {}),
  };
}

/**
 * Classify the pending answers.
 *
 * Only superficial form is repaired here. A disposition that is absent,
 * unknown, or misspelled is a *semantic* defect, not a formatting slip:
 * silently promoting it to ACCEPTED would turn the developer's uncertainty
 * into a confirmed decision, which is the one failure this gate exists to
 * prevent. Such answers are reported as defects and carried as AMBIGUOUS, so
 * they either earn a focused follow-up or block the run.
 */
function normalizeReviews(
  value: unknown,
  pending: InterviewAnswer[],
  normalizations: string[],
  semanticDefects: string[],
): AnswerReview[] {
  const supplied = new Map<string, AnswerReview>();
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const questionId = text(record.questionId);
      if (!questionId) continue;
      const declared = text(record.disposition);
      const dispositionValue = declared.toUpperCase();
      const known = (["ACCEPTED", "PARTIAL", "AMBIGUOUS", "DEFERRED", "CONTRADICTED"] as const)
        .find((candidate) => candidate === dispositionValue);
      if (!known) {
        semanticDefects.push(
          `answer ${questionId} declared the unsupported disposition ${JSON.stringify(declared) || "(none)"}; `
          + "use exactly one of ACCEPTED, PARTIAL, AMBIGUOUS, DEFERRED, CONTRADICTED",
        );
        supplied.set(questionId, {
          questionId,
          disposition: "AMBIGUOUS",
          remainingUncertainty: `The classification of ${questionId} is not a supported disposition, so its meaning is undecided.`,
        });
        continue;
      }
      if (dispositionValue !== declared) {
        normalizations.push(`answer ${questionId} disposition case-normalized to ${dispositionValue}`);
      }
      supplied.set(questionId, {
        questionId,
        disposition: known,
        ...(text(record.normalizedDecision) ? { normalizedDecision: text(record.normalizedDecision) } : {}),
        ...(text(record.remainingUncertainty) ? { remainingUncertainty: text(record.remainingUncertainty) } : {}),
      });
    }
  }
  const reviews: AnswerReview[] = [];
  for (const answer of pending) {
    const review = supplied.get(answer.questionId);
    if (!review) {
      semanticDefects.push(
        `answer ${answer.questionId} was never classified; every pending answer needs exactly one explicit disposition`,
      );
      reviews.push({
        questionId: answer.questionId,
        disposition: "AMBIGUOUS",
        remainingUncertainty: `The answer to ${answer.questionId} carries no classification, so its decision is undetermined.`,
      });
      continue;
    }
    if (review.disposition === "ACCEPTED" && !review.normalizedDecision) {
      // The raw answer is a legitimate decision only under an explicit
      // ACCEPTED: the provider stated there is one material interpretation.
      reviews.push({ ...review, normalizedDecision: answer.rawAnswer });
      continue;
    }
    if (UNRESOLVED_DISPOSITIONS.has(review.disposition) && !review.remainingUncertainty) {
      reviews.push({ ...review, remainingUncertainty: `The answer to ${answer.questionId} left a material boundary open.` });
      continue;
    }
    reviews.push(review);
  }
  return reviews;
}

export interface InterviewParseOptions {
  pendingAnswers: InterviewAnswer[];
  round: number;
  /** Question IDs already used in this run; follow-ups need fresh IDs. */
  usedQuestionIds?: Iterable<string>;
  /**
   * Override the per-round question ceiling. The public
   * `rb-headless-interview/v1` boundary keeps its own documented budget and
   * must not inherit the internal Harness interview budget.
   */
  maxQuestions?: number;
}

export function parseInterviewAnalysis(
  output: string,
  pendingAnswersOrOptions: InterviewAnswer[] | InterviewParseOptions,
): InterviewAnalysis {
  const options: InterviewParseOptions = Array.isArray(pendingAnswersOrOptions)
    ? { pendingAnswers: pendingAnswersOrOptions, round: 1 }
    : pendingAnswersOrOptions;
  const source = extractEnvelope(output, BEGIN, END, "interview");
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("provider returned malformed interview JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("interview result must be an object");
  const analysis = value as Record<string, unknown>;
  if (analysis.contract !== "rb-harness-interview/v1") throw new Error("provider returned an unsupported interview contract");

  const normalizations: string[] = [];
  const semanticDefects: string[] = [];
  const claimed = new Set<string>(options.usedQuestionIds ?? []);
  const budget = options.maxQuestions ?? interviewQuestionBudget(options.round);
  const rawQuestions = Array.isArray(analysis.questions) ? analysis.questions : [];
  let questions = rawQuestions
    .map((entry, index) => normalizeQuestion(entry, index, claimed, normalizations))
    .filter((question): question is InterviewQuestion => Boolean(question));
  // Surplus questions are never discarded. Asking them would break the round
  // budget, but dropping them would hide material decisions behind a clean
  // result, so they become declared open items instead.
  const overflow = questions.slice(budget);
  const overflowQuestions = overflow.length;
  if (overflowQuestions) {
    questions = questions.slice(0, budget);
    normalizations.push(
      `round ${options.round} returned ${overflowQuestions + budget} questions; `
      + `${budget} are asked and ${overflowQuestions} are recorded as deferred open decisions`,
    );
  }

  const reviews = normalizeReviews(analysis.answerReviews, options.pendingAnswers, normalizations, semanticDefects);
  const finalRound = options.maxQuestions === undefined && options.round >= HARNESS_BUDGET.interview.maxRounds;

  // A materially unresolved answer needs a focused follow-up. When one is
  // missing and a round still remains, reshape the provider's own stated
  // uncertainty into that question rather than inventing new substance.
  if (!finalRound) {
    for (const review of reviews) {
      if (!UNRESOLVED_DISPOSITIONS.has(review.disposition)) continue;
      if (questions.some((question) => question.answerFor === review.questionId)) continue;
      if (questions.length >= budget) break;
      const id = normalizeQuestionId(`${review.questionId}-followup`, questions.length, claimed);
      questions.push({
        id,
        question: `${review.remainingUncertainty} Which exact decision should the documentation record?`,
        why: `The prior answer to ${review.questionId} is ${review.disposition.toLowerCase()} and would otherwise enter a RIGID claim.`,
        type: "text",
        options: [],
        answerFor: review.questionId,
      });
      normalizations.push(`focused follow-up ${id} was derived from the declared uncertainty of ${review.questionId}`);
    }
  }

  const unresolved = stringList(analysis.unresolved);
  for (const question of overflow) unresolved.push(`Deferred material decision: ${question.question}`);
  let status: InterviewAnalysis["status"] =
    analysis.status === "ready" || analysis.status === "needs_input" || analysis.status === "blocked"
      ? analysis.status
      : questions.length ? "needs_input" : "ready";
  if (status === "ready" && questions.length) {
    if (finalRound) {
      questions = [];
      normalizations.push("a ready result may not carry questions; the final round dropped them");
    } else {
      status = "needs_input";
      normalizations.push("a result with questions was reclassified as needs_input");
    }
  }
  if (status === "needs_input" && !questions.length) {
    status = unresolved.length ? "blocked" : "ready";
    normalizations.push(`needs_input without questions was resolved as ${status}`);
  }
  if (status === "needs_input" && finalRound) {
    status = "blocked";
    normalizations.push("the follow-up round is exhausted; remaining questions became a blocked decision");
    for (const question of questions) unresolved.push(question.question);
    questions = [];
  }

  // A result cannot claim readiness while a material decision is still open,
  // whether it is an unclassified answer or a question that did not fit the
  // round budget.
  if (status === "ready" && (semanticDefects.length || overflowQuestions)) {
    status = finalRound ? "blocked" : "needs_input";
    normalizations.push(`readiness withheld: ${semanticDefects.length} unclassified answer(s) and ${overflowQuestions} deferred question(s) remain`);
  }
  if (status === "needs_input" && !questions.length && finalRound) {
    status = "blocked";
  }

  const unresolvedAnswers = reviews.filter((review) => UNRESOLVED_DISPOSITIONS.has(review.disposition));
  if (status === "ready" && unresolvedAnswers.length && finalRound) {
    status = "blocked";
    for (const review of unresolvedAnswers) {
      unresolved.push(review.remainingUncertainty ?? `Answer ${review.questionId} remains ${review.disposition.toLowerCase()}.`);
    }
    normalizations.push("unresolved answers cannot enter generation after the final round");
  }

  return {
    contract: "rb-harness-interview/v1",
    status,
    summary: text(analysis.summary, "Normalized interview checkpoint."),
    discoveries: stringList(analysis.discoveries),
    assumptions: stringList(analysis.assumptions),
    unresolved: [...new Set(unresolved)].slice(0, 50),
    answerReviews: reviews,
    questions,
    ...(normalizations.length ? { normalizations: normalizations.slice(0, 30) } : {}),
    ...(semanticDefects.length ? { semanticDefects: semanticDefects.slice(0, 30) } : {}),
    ...(overflowQuestions ? { overflowQuestions } : {}),
  };
}

export async function recoverInterviewAnalysis(
  logPath: string,
  options: InterviewParseOptions | InterviewAnswer[],
): Promise<InterviewAnalysis | undefined> {
  try {
    const log = await readFile(logPath, "utf8");
    const stdoutMarker = "\n--- stdout ---\n";
    const stderrMarker = "\n--- stderr ---\n";
    const stdoutStart = log.indexOf(stdoutMarker);
    const stdoutEnd = log.lastIndexOf(stderrMarker);
    if (!/^exit_code=0$/m.test(log.slice(0, Math.max(0, stdoutStart))) || stdoutStart < 0 || stdoutEnd <= stdoutStart) return undefined;
    return parseInterviewAnalysis(log.slice(stdoutStart + stdoutMarker.length, stdoutEnd), options);
  } catch {
    return undefined;
  }
}

const INTERVIEW_SHAPE = JSON.stringify({
  contract: "rb-harness-interview/v1",
  status: "ready | needs_input | blocked",
  summary: "normalized checkpoint",
  discoveries: ["repository or supplied-source fact"],
  assumptions: ["explicit low-risk assumption"],
  unresolved: ["remaining unknown or conflict"],
  answerReviews: [{
    questionId: "prior-question-id",
    disposition: "ACCEPTED | PARTIAL | AMBIGUOUS | DEFERRED | CONTRADICTED",
    normalizedDecision: "required for ACCEPTED",
    remainingUncertainty: "required for PARTIAL, AMBIGUOUS, CONTRADICTED",
  }],
  questions: [{
    id: "stable-id",
    question: "single material decision",
    why: "impact",
    type: "text | single-choice | confirm",
    options: ["2-6 choices only for single-choice"],
    recommendation: "optional",
    evidence: "optional",
    answerFor: "original question id when following up",
  }],
});

/**
 * The genuinely invariant part of the interview prompt (CR-007).
 *
 * Byte-identical across every round of one run and independent of the answers
 * given so far. Whether a provider actually reuses it is the provider's
 * business — the Harness only guarantees the bytes, and reports cache reuse
 * solely from what a provider measures.
 */
export function stableInterviewPrefix(
  state: HarnessRunState,
  inputPackage: HarnessInputPackage,
  resources: string,
): string {
  return [
    "You are the RB Harness interview controller. You analyze gaps and return one JSON envelope; you never write files, implement code, or run the project.",
    "Work only on the target project described below. Never inspect the RB Harness installation, its source, its tests, or its packaged resources.",
    `Return exactly ${BEGIN}, one JSON object, and ${END}. Do not use Markdown fences or surrounding prose.`,
    `The JSON shape is:\n${INTERVIEW_SHAPE}`,
    interviewContractDigest(state.workflow),
    resources,
    `\n===== INPUT PACKAGE (${inputPackage.contract}) =====\n${serializeInputPackage(inputPackage)}`,
  ].join("\n");
}

export function buildInterviewPrompt(
  state: HarnessRunState,
  inputPackage: HarnessInputPackage,
  resources: string,
  round: number,
  pending: InterviewAnswer[],
  repair?: string,
): string {
  const prompt = [
    // Invariant prefix first; everything below it varies by round.
    stableInterviewPrefix(state, inputPackage, resources),
    `\n===== ROUND STATE =====\n${interviewRoundDirective(round)}`,
    `\nPrior validated checkpoint (navigation only, not source authority):\n${state.analysis ? JSON.stringify({
      summary: state.analysis.summary,
      discoveries: state.analysis.discoveries,
      assumptions: state.analysis.assumptions,
      unresolved: state.analysis.unresolved,
    }) : "none"}`,
    `\nAnswers requiring classification in this round:\n${JSON.stringify(pending.map((answer) => ({
      questionId: answer.questionId,
      question: answer.question,
      rawAnswer: answer.rawAnswer,
    })))}`,
    repair
      ? `\nA prior response could not be parsed. Correct only the protocol defect and preserve its substantive discoveries, decisions, and questions: ${repair}`
      : "",
  ].filter(Boolean).join("\n");
  assertPromptWithinBudget(prompt, HARNESS_BUDGET.prompt.maxInterviewPromptBytes, "interview");
  return prompt;
}

export interface InterviewRequestOptions {
  state: HarnessRunState;
  inputPackage: HarnessInputPackage;
  runRoot: string;
  /** Read-only evidence projection the provider runs in (CR-005). */
  evidenceRoot: string;
  round: number;
  timeoutSeconds: number;
  firstOutputTimeoutSeconds: number;
}

export async function requestInterviewAnalysis(options: InterviewRequestOptions): Promise<InterviewAnalysis> {
  const { state, runRoot, round } = options;
  const resources = await loadWorkflowResources(state.workflow, {
    includeHeadlessContracts: requestNeedsHeadlessContracts(state.request),
    section: "interview",
  });
  const pending = state.answers.filter((answer) => answer.disposition === "PENDING");
  const parseOptions: InterviewParseOptions = {
    pendingAnswers: pending,
    round,
    usedQuestionIds: state.answers.map((answer) => answer.questionId),
  };
  for (let attempt = HARNESS_BUDGET.interview.protocolAttempts; attempt >= 1; attempt -= 1) {
    const recovered = await recoverInterviewAnalysis(
      resolve(runRoot, `logs/interview-round-${round}-protocol-${attempt}.log`),
      parseOptions,
    );
    if (!recovered) continue;
    process.stdout.write(`[rb-harness] resposta válida da entrevista recuperada do log da tentativa ${attempt}; provider não será reiniciado.\n`);
    return recovered;
  }
  let repair: string | undefined;
  for (let attempt = 1; attempt <= HARNESS_BUDGET.interview.protocolAttempts; attempt += 1) {
    const result = await runProvider({
      configuration: state.provider as ProviderConfiguration,
      mode: "interview",
      stage: "gap-analysis",
      projectRoot: options.evidenceRoot,
      prompt: buildInterviewPrompt(state, options.inputPackage, resources, round, pending, repair),
      logPath: resolve(runRoot, `logs/interview-round-${round}-protocol-${attempt}.log`),
      timeoutSeconds: options.timeoutSeconds,
      firstOutputTimeoutSeconds: options.firstOutputTimeoutSeconds,
      attempt,
    });
    try {
      const analysis = parseInterviewAnalysis(result.stdout, parseOptions);
      const defects = analysis.semanticDefects ?? [];
      // A semantic defect earns exactly one correction, which is the protocol
      // repair the bounded flow already allows. It never becomes an
      // acceptance, and it never buys an extra interview round.
      if (defects.length && attempt < HARNESS_BUDGET.interview.protocolAttempts) {
        repair = `classify every pending answer exactly once with a supported disposition: ${defects.join("; ")}`;
        process.stdout.write(`[rb-harness] classificação incompleta na entrevista; solicitando uma única correção de protocolo.\n`);
        continue;
      }
      return analysis;
    } catch (error) {
      repair = error instanceof Error ? error.message : String(error);
      if (attempt === HARNESS_BUDGET.interview.protocolAttempts) {
        throw new Error(`provider could not satisfy the interview protocol: ${repair}`);
      }
    }
  }
  throw new Error("unreachable interview protocol state");
}


/**
 * Reject a follow-up that reuses an already-answered ID.
 *
 * The internal Harness interview normalizes a colliding ID instead of failing,
 * because a superficial ID clash must not discard a paid response. The public
 * `rb-headless-interview/v1` boundary keeps the stricter rule: an integrating
 * service correlates answers by ID across processes, so a silently renamed
 * question would corrupt its durable cursor.
 */
export function rejectReusedQuestionIds(state: HarnessRunState, analysis: InterviewAnalysis): void {
  const answeredIds = new Set(state.answers.map((answer) => answer.questionId));
  const reused = analysis.questions.find((question) => answeredIds.has(question.id));
  if (reused) throw new Error(`provider reused answered question ID ${reused.id}; a focused follow-up needs a new stable ID`);
}

/**
 * Prompt for the public `rb-headless-interview/v1` service boundary. It keeps
 * its own documented adaptive budget and message shape; the internal Harness
 * interview uses the bounded `buildInterviewPrompt` above.
 */
export function buildInterviewControllerPrompt(
  state: HarnessRunState,
  resources: string,
  pending: InterviewAnswer[],
  repair?: string,
  rejectedResponse?: string,
): string {
  return [
    "You are the RB Harness interview controller running headlessly.",
    "Inspect the project only as allowed by the workflow resources. Do not write or modify any file during this call.",
    "Ask only material questions. You may discover a batch, but the caller will present them one at a time.",
    "Question IDs are internal correlation keys: use 2-80 ASCII letters, digits, dots, underscores, or hyphens, starting with a letter or digit. IDs such as q1 and EVO-MEMORY-001 are valid.",
    "Classify every pending answer with the answer acceptance gate. PARTIAL, AMBIGUOUS, or CONTRADICTED requires one focused follow-up whose answerFor names the original question ID.",
    "Question options are type-sensitive: single-choice requires 2-6 non-empty choices; text and confirm must omit options or use an empty array.",
    "Do not turn vague language into precise requirements. A ready result may contain only accepted decisions, explicit low-risk assumptions, or non-rigid deferrals.",
    `Return exactly ${BEGIN}, one JSON object, and ${END}. Do not use Markdown fences.`,
    "The JSON shape is:",
    JSON.stringify({
      contract: "rb-harness-interview/v1",
      status: "ready | needs_input | blocked",
      summary: "normalized checkpoint",
      discoveries: ["repository or supplied-source fact"],
      assumptions: ["explicit low-risk assumption"],
      unresolved: ["remaining unknown or conflict"],
      answerReviews: [{ questionId: "prior-question-id", disposition: "ACCEPTED | PARTIAL | AMBIGUOUS | DEFERRED | CONTRADICTED", normalizedDecision: "required for ACCEPTED", remainingUncertainty: "optional" }],
      questions: [{ id: "stable-id", question: "single material decision", why: "impact", type: "text | single-choice | confirm", options: ["2-6 choices only for single-choice; omit or use [] otherwise"], recommendation: "optional", evidence: "optional", answerFor: "original question id when following up" }],
    }),
    repair ? `A prior response violated the protocol. Correct only the protocol defect without changing its substantive discoveries, decisions, or questions: ${repair}` : "",
    rejectedResponse ? `\nRejected response to repair faithfully:\n${rejectedResponse}` : "",
    `\nWorkflow: ${state.workflow}`,
    `\nDeveloper request:\n${state.request}`,
    "\nPrior validated interview checkpoint is navigation, not source authority. Preserve settled discoveries and decisions; re-open repository evidence only when a pending answer materially changes them.",
    `\nPrior validated interview checkpoint:\n${state.analysis ? JSON.stringify(state.analysis) : "none"}`,
    `\nAll interview answers:\n${JSON.stringify(state.answers)}`,
    `\nAnswers requiring classification in this round:\n${JSON.stringify(pending)}`,
    resources,
  ].filter(Boolean).join("\n");
}
