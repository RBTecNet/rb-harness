import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runProvider } from "./harness-provider.js";
import { loadWorkflowResources } from "./standalone-resources.js";
import type {
  HarnessRunState,
  InterviewAnalysis,
  InterviewAnswer,
  InterviewQuestion,
  ProviderConfiguration,
} from "./standalone-types.js";

const BEGIN = "RB_HARNESS_INTERVIEW_JSON_BEGIN";
const END = "RB_HARNESS_INTERVIEW_JSON_END";
const QUESTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/;

function stringArray(value: unknown, label: string, max = 50): string[] {
  if (!Array.isArray(value) || value.length > max || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return value as string[];
}

function parseQuestion(value: unknown): InterviewQuestion {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("interview question must be an object");
  const question = value as Record<string, unknown>;
  const allowed = new Set(["id", "question", "why", "type", "options", "recommendation", "evidence", "answerFor"]);
  for (const key of Object.keys(question)) if (!allowed.has(key)) throw new Error(`unsupported interview question field: ${key}`);
  if (typeof question.id !== "string" || !QUESTION_ID.test(question.id)) {
    throw new Error("interview question id must contain 2-80 ASCII letters, digits, dots, underscores, or hyphens and start with a letter or digit");
  }
  if (typeof question.question !== "string" || !question.question.trim()) throw new Error(`question ${question.id} has no text`);
  if (typeof question.why !== "string" || !question.why.trim()) throw new Error(`question ${question.id} has no rationale`);
  if (!(["text", "single-choice", "confirm"] as unknown[]).includes(question.type)) throw new Error(`question ${question.id} has an invalid type`);
  const options = stringArray(question.options, `question ${question.id}.options`, 6);
  if (question.type === "single-choice" && options.length < 2) throw new Error(`question ${question.id} needs at least two choices`);
  if (question.type !== "single-choice" && options.length > 0) throw new Error(`question ${question.id} must not declare choices`);
  for (const optional of ["recommendation", "evidence", "answerFor"] as const) {
    if (question[optional] !== undefined && (typeof question[optional] !== "string" || !question[optional].trim())) {
      throw new Error(`question ${question.id}.${optional} must be a non-empty string`);
    }
  }
  return question as unknown as InterviewQuestion;
}

export function parseInterviewAnalysis(output: string, pendingAnswers: InterviewAnswer[]): InterviewAnalysis {
  const complete = output.trim();
  if (!complete.startsWith(BEGIN) || !complete.endsWith(END) ||
      complete.indexOf(BEGIN, BEGIN.length) >= 0 || complete.indexOf(END) !== complete.lastIndexOf(END)) {
    throw new Error("provider output must contain exactly one interview envelope and no surrounding text");
  }
  const start = complete.indexOf(BEGIN);
  const finish = complete.lastIndexOf(END);
  if (start < 0 || finish < 0) throw new Error("provider omitted the interview JSON markers");
  const source = complete.slice(start + BEGIN.length, finish).trim();
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error("provider returned malformed interview JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("interview result must be an object");
  const analysis = value as Record<string, unknown>;
  const allowed = new Set(["contract", "status", "summary", "discoveries", "assumptions", "unresolved", "answerReviews", "questions"]);
  for (const key of Object.keys(analysis)) if (!allowed.has(key)) throw new Error(`unsupported interview result field: ${key}`);
  if (analysis.contract !== "rb-harness-interview/v1") throw new Error("provider returned an unsupported interview contract");
  if (!["ready", "needs_input", "blocked"].includes(String(analysis.status))) throw new Error("provider returned an invalid interview status");
  if (typeof analysis.summary !== "string" || !analysis.summary.trim()) throw new Error("provider omitted the normalized summary");
  const questions = Array.isArray(analysis.questions) ? analysis.questions.map(parseQuestion) : (() => { throw new Error("questions must be an array"); })();
  if (questions.length > 8) throw new Error("provider returned more than eight questions in one round");
  if (new Set(questions.map((question) => question.id)).size !== questions.length) throw new Error("provider returned duplicate question IDs");
  const answerReviews = Array.isArray(analysis.answerReviews) ? analysis.answerReviews : (() => { throw new Error("answerReviews must be an array"); })();
  const reviews = answerReviews.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("answer review must be an object");
    const review = entry as Record<string, unknown>;
    const keys = new Set(["questionId", "disposition", "normalizedDecision", "remainingUncertainty"]);
    for (const key of Object.keys(review)) if (!keys.has(key)) throw new Error(`unsupported answer review field: ${key}`);
    if (typeof review.questionId !== "string" || !QUESTION_ID.test(review.questionId)) {
      throw new Error("answer review questionId must contain 2-80 ASCII letters, digits, dots, underscores, or hyphens and start with a letter or digit");
    }
    if (!["ACCEPTED", "PARTIAL", "AMBIGUOUS", "DEFERRED", "CONTRADICTED"].includes(String(review.disposition))) {
      throw new Error(`answer ${review.questionId} has invalid disposition`);
    }
    if (review.disposition === "ACCEPTED" && (typeof review.normalizedDecision !== "string" || !review.normalizedDecision.trim())) {
      throw new Error(`accepted answer ${review.questionId} has no normalized decision`);
    }
    if (review.remainingUncertainty !== undefined && typeof review.remainingUncertainty !== "string") {
      throw new Error(`answer ${review.questionId} has invalid remaining uncertainty`);
    }
    if (["PARTIAL", "AMBIGUOUS", "CONTRADICTED"].includes(String(review.disposition)) &&
        (typeof review.remainingUncertainty !== "string" || !review.remainingUncertainty.trim())) {
      throw new Error(`unresolved answer ${review.questionId} has no remaining uncertainty`);
    }
    return review as unknown as InterviewAnalysis["answerReviews"][number];
  });
  const pendingIds = new Set(pendingAnswers.map((answer) => answer.questionId));
  const reviewedIds = new Set(reviews.map((review) => review.questionId));
  if (pendingIds.size !== reviewedIds.size || [...pendingIds].some((id) => !reviewedIds.has(id))) {
    throw new Error("provider did not classify every pending answer exactly once");
  }
  for (const review of reviews) {
    if (["PARTIAL", "AMBIGUOUS", "CONTRADICTED"].includes(review.disposition) &&
        !questions.some((question) => question.answerFor === review.questionId)) {
      throw new Error(`materially unresolved answer ${review.questionId} has no focused follow-up`);
    }
  }
  if (analysis.status === "ready" && questions.length > 0) throw new Error("ready interview must not contain questions");
  if (analysis.status === "needs_input" && questions.length === 0) throw new Error("needs_input interview must contain questions");
  return {
    contract: "rb-harness-interview/v1",
    status: analysis.status as InterviewAnalysis["status"],
    summary: analysis.summary,
    discoveries: stringArray(analysis.discoveries, "discoveries"),
    assumptions: stringArray(analysis.assumptions, "assumptions"),
    unresolved: stringArray(analysis.unresolved, "unresolved"),
    answerReviews: reviews,
    questions,
  };
}

export async function recoverInterviewAnalysis(
  logPath: string,
  pendingAnswers: InterviewAnswer[],
): Promise<InterviewAnalysis | undefined> {
  try {
    const log = await readFile(logPath, "utf8");
    const stdoutMarker = "\n--- stdout ---\n";
    const stderrMarker = "\n--- stderr ---\n";
    const stdoutStart = log.indexOf(stdoutMarker);
    const stdoutEnd = log.lastIndexOf(stderrMarker);
    if (!/^exit_code=0$/m.test(log.slice(0, Math.max(0, stdoutStart))) || stdoutStart < 0 || stdoutEnd <= stdoutStart) return undefined;
    return parseInterviewAnalysis(log.slice(stdoutStart + stdoutMarker.length, stdoutEnd), pendingAnswers);
  } catch {
    return undefined;
  }
}

function rejectReusedQuestionIds(state: HarnessRunState, analysis: InterviewAnalysis): void {
  const answeredIds = new Set(state.answers.map((answer) => answer.questionId));
  const reused = analysis.questions.find((question) => answeredIds.has(question.id));
  if (reused) throw new Error(`provider reused answered question ID ${reused.id}; a focused follow-up needs a new stable ID`);
}

function interviewPrompt(
  state: HarnessRunState,
  resources: string,
  pending: InterviewAnswer[],
  repair?: string,
  rejectedResponse?: string,
): string {
  return [
    "You are the RB Harness interview controller running headlessly.",
    "Inspect the project only as allowed by the workflow resources. Do not write or modify any file during this call.",
    "Ask only material questions. You may discover a batch, but the CLI will present them one at a time.",
    "Question IDs are internal correlation keys: use 2-80 ASCII letters, digits, dots, underscores, or hyphens, starting with a letter or digit. IDs such as q1 and EVO-MEMORY-001 are valid.",
    "Classify every pending answer with the answer acceptance gate. PARTIAL, AMBIGUOUS, or CONTRADICTED requires one focused follow-up whose answerFor names the original question ID.",
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
      questions: [{ id: "stable-id", question: "single material decision", why: "impact", type: "text | single-choice | confirm", options: ["only for single-choice"], recommendation: "optional", evidence: "optional", answerFor: "original question id when following up" }],
    }),
    repair ? `A prior response violated the protocol. Correct only the protocol defect without changing its substantive discoveries, decisions, or questions: ${repair}` : "",
    rejectedResponse ? `\nRejected response to repair faithfully:\n${rejectedResponse}` : "",
    `\nWorkflow: ${state.workflow}`,
    `\nDeveloper request:\n${state.request}`,
    `\nExisting artifact inventory:\n${JSON.stringify(state.inventory)}`,
    `\nAll interview answers:\n${JSON.stringify(state.answers)}`,
    `\nAnswers requiring classification in this round:\n${JSON.stringify(pending)}`,
    resources,
  ].filter(Boolean).join("\n");
}

export async function requestInterviewAnalysis(
  state: HarnessRunState,
  runRoot: string,
  round: number,
  timeoutSeconds: number,
  firstOutputTimeoutSeconds: number,
): Promise<InterviewAnalysis> {
  const resources = await loadWorkflowResources(state.workflow);
  const pending = state.answers.filter((answer) => answer.disposition === "PENDING");
  for (let attempt = 2; attempt >= 1; attempt -= 1) {
    const recovered = await recoverInterviewAnalysis(
      resolve(runRoot, `logs/interview-round-${round}-protocol-${attempt}.log`),
      pending,
    );
    if (!recovered) continue;
    try {
      rejectReusedQuestionIds(state, recovered);
      process.stdout.write(`[rb-harness] resposta válida da entrevista recuperada do log da tentativa ${attempt}; provider não será reiniciado.\n`);
      return recovered;
    } catch {
      // The stored response belongs to an earlier answer state; request a fresh analysis.
    }
  }
  let repair: string | undefined;
  let rejectedResponse: string | undefined;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await runProvider({
      configuration: state.provider as ProviderConfiguration,
      mode: "interview",
      projectRoot: state.projectRoot,
      prompt: interviewPrompt(state, resources, pending, repair, rejectedResponse),
      logPath: resolve(runRoot, `logs/interview-round-${round}-protocol-${attempt}.log`),
      timeoutSeconds,
      firstOutputTimeoutSeconds,
    });
    try {
      const analysis = parseInterviewAnalysis(result.stdout, pending);
      rejectReusedQuestionIds(state, analysis);
      return analysis;
    }
    catch (error) {
      repair = error instanceof Error ? error.message : String(error);
      rejectedResponse = result.stdout.length <= 256 * 1024 ? result.stdout : undefined;
      if (attempt === 2) throw new Error(`provider could not satisfy the interview protocol: ${repair}`);
    }
  }
  throw new Error("unreachable interview protocol state");
}
