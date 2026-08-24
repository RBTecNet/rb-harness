import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { inspectProjectInventory } from "./harness-inventory.js";
import { artifactAuditFingerprint, requestArtifactAudit } from "./harness-audit.js";
import { requestInterviewAnalysis } from "./harness-interview.js";
import { runProvider } from "./harness-provider.js";
import { loadWorkflowResources, requestNeedsHeadlessContracts } from "./standalone-resources.js";
import {
  acquireHarnessLock,
  harnessRunRoot,
  listRunStates,
  readRunState,
  writeRunState,
} from "./harness-state.js";
import {
  generationSourceSummary,
  prepareGenerationWorkspace,
  publishGeneratedArtifacts,
  recoverInterruptedPublication,
  validateGeneratedWorkspace,
} from "./harness-workspace.js";
import { slugify } from "./manifest.js";
import { pauseHarnessDashboard, resumeHarnessDashboard } from "./harness-dashboard.js";
import {
  STANDALONE_STATE_CONTRACT,
  type ArtifactAuditRecord,
  type HarnessRunState,
  type InterviewAnswer,
  type InterviewQuestion,
  type StandaloneRunOptions,
} from "./standalone-types.js";

const MAX_ADAPTIVE_INTERVIEW_ROUNDS = 128;

export function nextInterviewRound(
  state: Pick<HarnessRunState, "interviewRound" | "activeInterviewRound" | "diagnostic">,
): number {
  if (state.activeInterviewRound) return state.activeInterviewRound;
  const legacyCompletedRounds = state.diagnostic === "interview exceeded six adaptive rounds" ? 6 : 0;
  return Math.max(state.interviewRound ?? 0, legacyCompletedRounds) + 1;
}

export function hasReadyInterviewCheckpoint(
  state: Pick<HarnessRunState, "analysis" | "answers">,
): boolean {
  return state.analysis?.status === "ready"
    && !state.answers.some((answer) => answer.disposition === "PENDING");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function runId(options: StandaloneRunOptions): string {
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `${options.workflow}-${timestamp}-${hash(`${options.projectRoot}\0${options.request}`).slice(0, 10)}-${randomBytes(3).toString("hex")}`;
}

async function regularDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`project must be a regular directory: ${path}`);
  return absolute;
}

async function loadProvidedAnswers(path?: string): Promise<Record<string, string>> {
  if (!path) return {};
  const value = JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("--answers must contain a JSON object keyed by question ID");
  const answers: Record<string, string> = {};
  for (const [key, answer] of Object.entries(value)) {
    if (typeof answer !== "string" || !answer.trim()) throw new Error(`answer ${key} must be a non-empty string`);
    answers[key] = answer;
  }
  return answers;
}

function applyAnswerReviews(state: HarnessRunState): void {
  if (!state.analysis) return;
  for (const review of state.analysis.answerReviews) {
    const answer = state.answers.find((entry) => entry.questionId === review.questionId && entry.disposition === "PENDING");
    if (!answer) continue;
    answer.disposition = review.disposition;
    if (review.normalizedDecision) answer.normalizedDecision = review.normalizedDecision;
    if (review.remainingUncertainty) answer.remainingUncertainty = review.remainingUncertainty;
  }
}

function printQuestion(question: InterviewQuestion, index: number, total: number): void {
  process.stdout.write(`\nPergunta ${index + 1} de ${total} · ${question.id}\n\n${question.question}\n`);
  if (question.evidence) process.stdout.write(`\nEvidência encontrada: ${question.evidence}\n`);
  process.stdout.write(`Por que importa: ${question.why}\n`);
  if (question.options.length) {
    process.stdout.write("\n");
    question.options.forEach((option, optionIndex) => process.stdout.write(`  ${optionIndex + 1}) ${option}\n`));
  }
  if (question.recommendation) process.stdout.write(`\nRecomendação: ${question.recommendation}\n`);
}

async function answerQuestion(
  question: InterviewQuestion,
  index: number,
  total: number,
  provided: Record<string, string>,
  terminal: Interface | undefined,
): Promise<string> {
  pauseHarnessDashboard();
  let answer: string | undefined;
  try {
    printQuestion(question, index, total);
    answer = provided[question.id];
    if (answer) {
      process.stdout.write(`Resposta fornecida: ${answer}\n`);
    } else if (terminal) {
      answer = (await terminal.question("\nResposta: ")).trim();
    } else {
      throw new Error(`interview requires answer '${question.id}'; provide --answers <json> or run in an interactive terminal`);
    }
  } finally {
    resumeHarnessDashboard();
  }
  return normalizeInterviewAnswer(question, answer);
}

export function normalizeInterviewAnswer(question: InterviewQuestion, suppliedAnswer: string): string {
  let answer = suppliedAnswer.trim();
  if (/^(?:use (?:the |a )?recommendation|use a recomenda[cç][aã]o|usar (?:a )?recomenda[cç][aã]o)$/i.test(answer) && question.recommendation) {
    answer = question.recommendation;
  }
  if (question.type === "single-choice" && /^[1-9][0-9]*$/.test(answer)) {
    const selected = question.options[Number(answer) - 1];
    if (!selected) throw new Error(`answer for ${question.id} selects an unknown option`);
    answer = selected;
  }
  if (question.type === "confirm") {
    if (/^(?:s|sim|yes|y)$/i.test(answer)) answer = "Yes";
    else if (/^(?:n|nao|não|no)$/i.test(answer)) answer = "No";
  }
  if (!answer.trim()) throw new Error(`answer for ${question.id} must not be empty`);
  return answer.trim();
}

async function collectInterviewAnswers(
  state: HarnessRunState,
  questions: InterviewQuestion[],
  provided: Record<string, string>,
  terminal: Interface | undefined,
): Promise<void> {
  const unanswered = questions.filter((question) =>
    !state.answers.some((answer) => answer.questionId === question.id));
  for (let index = 0; index < unanswered.length; index += 1) {
    const question = unanswered[index]!;
    const rawAnswer = await answerQuestion(question, index, unanswered.length, provided, terminal);
    state.answers.push({
      questionId: question.id,
      question: question.question,
      rawAnswer,
      disposition: "PENDING",
      answeredAt: new Date().toISOString(),
    });
    await writeRunState(state);
  }
}

async function interview(
  state: HarnessRunState,
  runRoot: string,
  options: StandaloneRunOptions,
): Promise<void> {
  const provided = await loadProvidedAnswers(options.answersFile);
  const terminal = !options.nonInteractive && process.stdin.isTTY && process.stdout.isTTY
    ? createInterface({ input, output })
    : undefined;
  try {
    let normalizedCarriedAnswer = false;
    for (const question of state.analysis?.questions ?? []) {
      const answer = state.answers.find((entry) => entry.questionId === question.id && entry.disposition === "PENDING");
      if (!answer) continue;
      const normalized = normalizeInterviewAnswer(question, answer.rawAnswer);
      if (normalized !== answer.rawAnswer) {
        answer.rawAnswer = normalized;
        normalizedCarriedAnswer = true;
      }
    }
    if (normalizedCarriedAnswer) await writeRunState(state);
    const carriedQuestions = state.analysis?.status === "needs_input"
      ? state.analysis.questions.filter((question) =>
        !state.answers.some((answer) => answer.questionId === question.id))
      : [];
    if (carriedQuestions.length) {
      process.stdout.write(`[rb-harness] retomando ${carriedQuestions.length} pergunta(s) ainda não respondida(s) do checkpoint anterior.\n`);
      await collectInterviewAnswers(state, carriedQuestions, provided, terminal);
    }
    const firstRound = nextInterviewRound(state);
    for (let round = firstRound; round <= MAX_ADAPTIVE_INTERVIEW_ROUNDS; round += 1) {
      state.activeInterviewRound = round;
      state.diagnostic = undefined;
      await writeRunState(state);
      process.stdout.write(`[rb-harness] analisando lacunas da entrevista (rodada ${round}/${MAX_ADAPTIVE_INTERVIEW_ROUNDS})...\n`);
      state.analysis = await requestInterviewAnalysis(
        state,
        runRoot,
        round,
        options.timeoutSeconds,
        options.firstOutputTimeoutSeconds,
      );
      state.interviewRound = round;
      state.activeInterviewRound = undefined;
      applyAnswerReviews(state);
      state.diagnostic = undefined;
      await writeRunState(state);
      if (state.analysis.status === "ready") return;
      if (state.analysis.status === "blocked") {
        state.status = "blocked";
        state.diagnostic = state.analysis.unresolved.join("; ") || "material interview decision remains blocked";
        await writeRunState(state);
        throw new Error(`generation is blocked: ${state.diagnostic}`);
      }
      if (options.questionMode === "batch") {
        process.stdout.write(`\nO modelo encontrou ${state.analysis.questions.length} decisões materiais nesta rodada.\n`);
      }
      await collectInterviewAnswers(state, state.analysis.questions, provided, terminal);
    }
    state.status = "blocked";
    state.diagnostic = `interview exceeded the safety ceiling of ${MAX_ADAPTIVE_INTERVIEW_ROUNDS} adaptive rounds`;
    await writeRunState(state);
    throw new Error(state.diagnostic);
  } finally {
    terminal?.close();
  }
}

async function generationPrompt(
  state: HarnessRunState,
  workspace: string,
  priorAudit?: ArtifactAuditRecord,
): Promise<string> {
  const resources = await loadWorkflowResources(state.workflow, {
    includeHeadlessContracts: requestNeedsHeadlessContracts(state.request),
  });
  const decisions = state.answers.filter((answer) => answer.disposition === "ACCEPTED").map((answer) => ({
    questionId: answer.questionId,
    decision: answer.normalizedDecision,
    sourceAnswer: answer.rawAnswer,
  }));
  return [
    "You are the standalone RB Harness artifact writer.",
    "This is an isolated copy of the project. Generate documentation only; never implement or modify application code.",
    "Write exclusively under .rb/. Preserve compatible existing artifacts and confirmed manual edits unless this request supersedes them.",
    "Do not create provider-specific instructions, credentials, secrets, commits, branches, Ralph runtime state, or hidden chat-session dependencies.",
    "The standalone orchestrator owns manifest sync and deterministic validation after this call. You must still produce contract-correct artifacts.",
    "Do not ask questions in this call. If a material contradiction still prevents safe readiness, write BLOCKED documentation and do not pretend PHASES is ready.",
    "Before claiming readiness, verify that every RIGID natural-language rule has a finite implementation authority: typed data, an exact grammar/matrix, or an explicitly declared classifier and failure contract. Never turn examples or a growing keyword list into an allegedly exhaustive semantic validator.",
    "Keep independently failing concerns in independently verifiable tasks. Name one canonical source and the synchronization mechanism for any derived or distributable copy.",
    priorAudit ? "An independent audit rejected the previous draft. Resolve every finding by its root invariant, not only the quoted reproduction. Preserve unrelated correct material." : "",
    priorAudit ? `\nPrevious independent audit:\n${JSON.stringify(priorAudit)}` : "",
    `\nWorkflow: ${state.workflow}`,
    `\nDeveloper request:\n${state.request}`,
    `\nNormalized interview checkpoint:\n${state.analysis?.summary ?? ""}`,
    `\nAccepted decisions:\n${JSON.stringify(decisions)}`,
    `\nExplicit assumptions:\n${JSON.stringify(state.analysis?.assumptions ?? [])}`,
    `\nUnresolved non-rigid or blocking items:\n${JSON.stringify(state.analysis?.unresolved ?? [])}`,
    `\nExisting artifact inventory:\n${await generationSourceSummary(workspace)}`,
    resources,
  ].join("\n");
}

async function generate(state: HarnessRunState, runRoot: string, options: StandaloneRunOptions): Promise<void> {
  const maximumPasses = 3;
  let validation: Awaited<ReturnType<typeof validateGeneratedWorkspace>> | undefined;
  let priorAudit = state.artifactAudits?.at(-1);
  const nextPass = Math.min(maximumPasses, Math.max(1, (priorAudit?.pass ?? 0) + 1));
  const stagedWorkspace = resolve(runRoot, "workspace");
  const legacyValidationFailure = state.status === "generation-failed"
    && state.diagnostic?.startsWith("generated artifact tree is invalid:");
  const legacyDecisionlessAuditBlock = state.status === "blocked"
    && priorAudit?.status === "blocked"
    && !priorAudit.decision;
  const checkpointMatches = state.generationCheckpoint?.contract === "rb-harness-generation-checkpoint/v1"
    && state.generationCheckpoint.pass === nextPass;
  let reuseGeneratedWorkspace = false;
  let reuseRepairWorkspace = false;
  if (legacyValidationFailure || checkpointMatches || legacyDecisionlessAuditBlock) {
    try {
      const workspaceInfo = await lstat(stagedWorkspace);
      const artifactInfo = await lstat(resolve(stagedWorkspace, ".rb"));
      const stagedWorkspaceAvailable = workspaceInfo.isDirectory() && !workspaceInfo.isSymbolicLink()
        && artifactInfo.isDirectory() && !artifactInfo.isSymbolicLink();
      reuseGeneratedWorkspace = stagedWorkspaceAvailable && (legacyValidationFailure || checkpointMatches);
      reuseRepairWorkspace = stagedWorkspaceAvailable && legacyDecisionlessAuditBlock;
    } catch { /* an incomplete checkpoint is regenerated safely */ }
  }
  const workspace = reuseGeneratedWorkspace || reuseRepairWorkspace
    ? stagedWorkspace
    : await prepareGenerationWorkspace(state, runRoot);
  if (reuseRepairWorkspace) {
    process.stdout.write("[rb-harness] bloqueio legado sem decisão explícita reclassificado como revisão; preservando o workspace para a próxima geração.\n");
  }
  for (let pass = nextPass; pass <= maximumPasses; pass += 1) {
    if (reuseGeneratedWorkspace) {
      process.stdout.write(`[rb-harness] saída completa da geração ${pass}/${maximumPasses} recuperada; retomando da validação sem reinvocar o provider.\n`);
      reuseGeneratedWorkspace = false;
    } else {
      state.status = "generating";
      state.diagnostic = undefined;
      state.generationCheckpoint = undefined;
      await writeRunState(state);
      process.stdout.write(`[rb-harness] workspace isolado pronto; geração ${pass}/${maximumPasses} com ${state.provider.provider}/${state.provider.model || "provider-default"}...\n`);
      await runProvider({
        configuration: state.provider,
        mode: "generation",
        projectRoot: workspace,
        prompt: await generationPrompt(state, workspace, priorAudit),
        logPath: resolve(runRoot, `logs/generation-pass-${pass}.log`),
        timeoutSeconds: options.timeoutSeconds,
        firstOutputTimeoutSeconds: options.firstOutputTimeoutSeconds,
        streamOutput: true,
      });
      state.generationCheckpoint = {
        contract: "rb-harness-generation-checkpoint/v1",
        pass,
        providerCompletedAt: new Date().toISOString(),
      };
    }
    state.status = "validating";
    state.diagnostic = undefined;
    await writeRunState(state);
    validation = await validateGeneratedWorkspace(workspace, state.workflow);
    process.stdout.write(`[rb-harness] validação estrutural verde: ${validation.artifacts} artefatos, ${validation.readyPlans} planos prontos.\n`);
    state.status = "auditing";
    await writeRunState(state);
    process.stdout.write(`[rb-harness] auditoria documental independente ${pass}/${maximumPasses}...\n`);
    const audit = await requestArtifactAudit(
      state,
      workspace,
      runRoot,
      pass,
      options.timeoutSeconds,
      options.firstOutputTimeoutSeconds,
    );
    const record = {
      ...audit,
      pass,
      fingerprint: artifactAuditFingerprint(audit),
      auditedAt: new Date().toISOString(),
    };
    state.artifactAudits ??= [];
    state.artifactAudits.push(record);
    await writeRunState(state);
    if (audit.status === "pass") {
      process.stdout.write(`[rb-harness] auditoria documental verde: ${audit.summary}\n`);
      break;
    }
    const findingList = audit.findings.map((finding) => finding.id).join(", ");
    if (audit.status === "blocked") {
      state.status = "blocked";
      state.diagnostic = `artifact audit requires a material developer decision: ${audit.decision?.question ?? findingList}`;
      await writeRunState(state);
      throw new Error(state.diagnostic);
    }
    if (priorAudit?.fingerprint === record.fingerprint) {
      state.status = "blocked";
      state.diagnostic = `artifact audit repeated the same root-cause batch after repair: ${findingList}`;
      await writeRunState(state);
      throw new Error(state.diagnostic);
    }
    if (pass === maximumPasses) {
      state.status = "blocked";
      state.diagnostic = `artifact audit did not converge after ${maximumPasses} passes: ${findingList}`;
      await writeRunState(state);
      throw new Error(state.diagnostic);
    }
    process.stdout.write(`[rb-harness] auditoria pediu revisão completa (${findingList}); iniciando nova geração em contexto fresco.\n`);
    priorAudit = record;
    state.generationCheckpoint = undefined;
  }
  if (!validation) throw new Error("artifact generation produced no validated pass");
  state.status = "publishing";
  await writeRunState(state);
  const previous = await publishGeneratedArtifacts(state, runRoot, workspace);
  state.previousArtifacts = previous;
  state.status = "complete";
  state.generationCheckpoint = undefined;
  state.publishedAt = new Date().toISOString();
  state.diagnostic = undefined;
  await writeRunState(state);
  process.stdout.write(`[rb-harness] artefatos publicados em ${state.artifactDirectory}.\n`);
  if (previous) process.stdout.write(`[rb-harness] revisão anterior preservada em ${previous}.\n`);
}

function optionsFromState(state: HarnessRunState, current: Partial<StandaloneRunOptions> = {}): StandaloneRunOptions {
  return {
    workflow: state.workflow,
    projectRoot: state.projectRoot,
    artifactDirectory: state.artifactDirectory,
    request: state.request,
    requestSource: state.requestSource,
    provider: state.provider,
    answersFile: current.answersFile,
    questionMode: current.questionMode ?? "one-by-one",
    nonInteractive: current.nonInteractive ?? false,
    timeoutSeconds: current.timeoutSeconds ?? 3600,
    firstOutputTimeoutSeconds: current.firstOutputTimeoutSeconds ?? 300,
    resumeId: state.id,
  };
}

export async function runStandaloneWorkflow(options: StandaloneRunOptions): Promise<HarnessRunState> {
  const projectRoot = await regularDirectory(options.projectRoot);
  let state: HarnessRunState;
  if (options.resumeId) {
    state = await readRunState(projectRoot, options.resumeId);
    options = optionsFromState(state, options);
    if (state.status === "complete") return state;
  } else {
    const inventory = await inspectProjectInventory(projectRoot, options.artifactDirectory);
    const createdAt = new Date().toISOString();
    state = {
      contract: STANDALONE_STATE_CONTRACT,
      id: runId({ ...options, projectRoot }),
      workflow: options.workflow,
      status: "interview",
      projectRoot,
      artifactDirectory: options.artifactDirectory,
      request: options.request,
      requestSource: options.requestSource,
      requestHash: hash(options.request),
      provider: options.provider,
      answers: [],
      inventory,
      createdAt,
      updatedAt: createdAt,
    };
    await writeRunState(state);
  }
  const runRoot = harnessRunRoot(projectRoot, state.id);
  await mkdir(runRoot, { recursive: true, mode: 0o700 });
  await chmod(runRoot, 0o700).catch(() => undefined);
  const releaseLock = await acquireHarnessLock(projectRoot, state.id);
  try {
    if (await recoverInterruptedPublication(state, runRoot)) {
      process.stdout.write(`[rb-harness] publicação interrompida detectada; revisão anterior restaurada em ${state.artifactDirectory}.\n`);
      await writeRunState(state);
    }
    state.inventory = await inspectProjectInventory(projectRoot, state.artifactDirectory);
    if (hasReadyInterviewCheckpoint(state)) {
      process.stdout.write("[rb-harness] checkpoint de entrevista pronto; retomando diretamente da geração.\n");
    } else {
      state.status = "interview";
      await writeRunState(state);
      await interview(state, runRoot, options);
    }
    await generate(state, runRoot, options);
    return state;
  } catch (error) {
    if (state.status !== "blocked") {
      state.status = state.status === "interview" ? "interview-failed" : "generation-failed";
    }
    state.diagnostic = error instanceof Error ? error.message : String(error);
    await writeRunState(state);
    throw error;
  } finally {
    await releaseLock();
  }
}

export async function resumableRuns(projectRoot: string): Promise<HarnessRunState[]> {
  return (await listRunStates(await regularDirectory(projectRoot))).filter((state) => state.status !== "complete");
}

export async function resumeStandaloneWorkflow(
  projectRoot: string,
  runId: string,
  overrides: Partial<StandaloneRunOptions> = {},
): Promise<HarnessRunState> {
  const root = await regularDirectory(projectRoot);
  const state = await readRunState(root, runId);
  return runStandaloneWorkflow(optionsFromState(state, { ...overrides, resumeId: runId }));
}

export async function resolveStandaloneRequest(
  projectRoot: string,
  positional?: string,
  prompt?: string,
  file?: string,
): Promise<{ request: string; source?: string }> {
  const supplied = [positional, prompt, file].filter((value) => value !== undefined);
  if (supplied.length > 1) throw new Error("choose only one request source: argument, --prompt, or --file");
  let candidate = positional ?? prompt ?? "";
  let source = file;
  if (!source && candidate.startsWith("@")) source = candidate.slice(1);
  if (!source && candidate) {
    try {
      const info = await lstat(resolve(projectRoot, candidate));
      if (info.isFile() && !info.isSymbolicLink()) source = candidate;
    } catch {
      // Treat a non-path argument as direct request text.
    }
  }
  if (source) {
    const absolute = resolve(projectRoot, source);
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error("request file must be a regular file no larger than 2 MiB");
    candidate = await readFile(absolute, "utf8");
    return { request: candidate.trim(), source: absolute };
  }
  return { request: candidate.trim() };
}

export function defaultRequestForWorkflow(workflow: StandaloneRunOptions["workflow"], projectRoot: string): string {
  if (workflow === "ai-context") return `Reverse-engineer the implemented project at ${basename(projectRoot)} into evidence-grounded AS IS documentation.`;
  if (workflow === "review") return `Audit the implemented project at ${basename(projectRoot)} end to end and record evidence-grounded findings.`;
  return "";
}
