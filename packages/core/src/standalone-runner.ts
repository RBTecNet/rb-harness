/**
 * The documentation state machine.
 *
 * inventory → adaptive gap analysis (1 batch, then focused rounds until it
 * converges) → closed decision checkpoint → bounded incremental authoring →
 * materialization → deterministic validation → at most one localized structural
 * repair → atomic publication.
 *
 * The graph is acyclic apart from those two explicitly counted allowances. The
 * interview loop is bounded by declared safety ceilings rather than a fixed
 * round count: reaching one is a failure to converge, reported as a resumable
 * BLOCKED checkpoint naming the open decision.
 * There is no manager, no semantic auditor, and no stage that can restart
 * itself: an exhausted budget produces a resumable checkpoint and an explicit
 * diagnostic, never more provider spend.
 */

import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { HARNESS_BUDGET } from "./harness-budget.js";
import { inspectProjectInventory } from "./harness-inventory.js";
import { requestInterviewAnalysis } from "./harness-interview.js";
import {
  requestDocumentBundle,
  requestStructuralRepair,
  type StructuralError,
} from "./harness-generator.js";
import { materializeDocuments, type DocumentBundle } from "./harness-documents.js";
import { discardEvidenceProjection, prepareEvidenceProjection } from "./harness-evidence.js";
import { buildInputPackage, type HarnessInputPackage } from "./harness-input-package.js";
import {
  acquireHarnessLock,
  harnessRunRoot,
  listRunStates,
  readRunState,
  writeRunState,
} from "./harness-state.js";
import {
  prepareStagingTree,
  publishStagedArtifacts,
  recoverInterruptedPublication,
  validateStagedTree,
} from "./harness-workspace.js";
import {
  finishHarnessTelemetry,
  formatTelemetryReport,
  harnessTelemetry,
  startHarnessTelemetry,
} from "./harness-telemetry.js";
import { pauseHarnessDashboard, resumeHarnessDashboard } from "./harness-dashboard.js";
import {
  STANDALONE_STATE_CONTRACT,
  type HarnessRunState,
  type InterviewQuestion,
  type RunCheckpoints,
  type StandaloneRunOptions,
} from "./standalone-types.js";

export function nextInterviewRound(
  state: Pick<HarnessRunState, "interviewRound" | "activeInterviewRound">,
): number {
  if (state.activeInterviewRound) return state.activeInterviewRound;
  return (state.interviewRound ?? 0) + 1;
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

function checkpoints(state: HarnessRunState): RunCheckpoints {
  state.checkpoints ??= {};
  return state.checkpoints;
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
  if (!unanswered.length) return;
  const telemetry = harnessTelemetry();
  const previousStage = telemetry?.activeStage();
  telemetry?.beginStage("awaiting-human");
  try {
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
  } finally {
    if (previousStage) telemetry?.beginStage(previousStage);
  }
}

async function interview(
  state: HarnessRunState,
  runRoot: string,
  evidenceRoot: string,
  inputPackage: HarnessInputPackage,
  options: StandaloneRunOptions,
): Promise<void> {
  const provided = await loadProvidedAnswers(options.answersFile);
  const terminal = !options.nonInteractive && process.stdin.isTTY && process.stdout.isTTY
    ? createInterface({ input, output })
    : undefined;
  const telemetry = harnessTelemetry();
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
    for (let round = firstRound; round <= HARNESS_BUDGET.interview.maxRounds; round += 1) {
      telemetry?.beginStage("gap-analysis");
      state.activeInterviewRound = round;
      state.diagnostic = undefined;
      await writeRunState(state);
      process.stdout.write(
        `[rb-harness] analisando lacunas (rodada ${round}; ${state.answers.length} pergunta(s) já respondida(s); `
        + `teto de segurança ${HARNESS_BUDGET.interview.maxRounds} rodadas / ${HARNESS_BUDGET.interview.maxQuestions} perguntas)...\n`,
      );
      state.analysis = await requestInterviewAnalysis({
        state,
        inputPackage,
        runRoot,
        evidenceRoot,
        round,
        timeoutSeconds: options.timeoutSeconds,
        firstOutputTimeoutSeconds: options.firstOutputTimeoutSeconds,
      });
      state.interviewRound = round;
      state.activeInterviewRound = undefined;
      applyAnswerReviews(state);
      state.diagnostic = undefined;
      await writeRunState(state);
      for (const normalization of state.analysis.normalizations ?? []) {
        process.stdout.write(`[rb-harness] protocolo normalizado: ${normalization}\n`);
      }
      for (const defect of state.analysis.semanticDefects ?? []) {
        process.stdout.write(`[rb-harness] classificação não aceita: ${defect}\n`);
      }
      if (state.analysis.overflowQuestions) {
        process.stdout.write(
          `[rb-harness] ${state.analysis.overflowQuestions} pergunta(s) acima do orçamento foram registradas como decisões adiadas.\n`,
        );
      }
      if (state.analysis.status === "ready") {
        checkpoints(state).interviewCompletedAt = new Date().toISOString();
        await writeRunState(state);
        process.stdout.write(
          `[rb-harness] entrevista convergida em ${round} rodada(s) e ${state.answers.length} pergunta(s); `
          + "nenhuma ambiguidade material em aberto.\n",
        );
        return;
      }
      if (state.analysis.status === "blocked") {
        state.status = "blocked";
        state.diagnostic = state.analysis.unresolved.join("; ") || "material interview decision remains blocked";
        await writeRunState(state);
        throw new Error(`generation is blocked: ${state.diagnostic}`);
      }
      process.stdout.write(
        options.questionMode === "batch"
          ? `\nO modelo encontrou ${state.analysis.questions.length} decisão(ões) material(is) nesta rodada.\n`
          : `[rb-harness] ${state.analysis.questions.length} decisão(ões) material(is) em aberto; serão perguntadas uma a uma.\n`,
      );
      await collectInterviewAnswers(state, state.analysis.questions, provided, terminal);
    }
    // The parser converts an exhausted final round into `blocked`, so reaching
    // this point means the safety ceiling itself was violated.
    state.status = "blocked";
    state.diagnostic = `the interview did not converge within the safety ceiling of ${HARNESS_BUDGET.interview.maxRounds} rounds and a material decision remains open`;
    await writeRunState(state);
    throw new Error(state.diagnostic);
  } finally {
    terminal?.close();
  }
}

function bundlePath(runRoot: string): string {
  return resolve(runRoot, "bundle.json");
}

async function persistBundle(state: HarnessRunState, runRoot: string, bundle: DocumentBundle, repaired: boolean): Promise<void> {
  const path = bundlePath(runRoot);
  const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
  const temporary = `${path}.tmp-${process.pid}`;
  await mkdir(runRoot, { recursive: true, mode: 0o700 });
  await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  state.bundle = {
    contract: "rb-harness-documents/v1",
    documents: bundle.documents.length,
    sha256: hash(serialized),
    receivedAt: new Date().toISOString(),
    repaired,
  };
  checkpoints(state).bundleReceivedAt = state.bundle.receivedAt;
  await writeRunState(state);
}

async function loadPersistedBundle(state: HarnessRunState, runRoot: string): Promise<DocumentBundle | undefined> {
  if (!state.bundle) return undefined;
  try {
    const serialized = await readFile(bundlePath(runRoot), "utf8");
    if (hash(serialized) !== state.bundle.sha256) return undefined;
    return JSON.parse(serialized) as DocumentBundle;
  } catch {
    return undefined;
  }
}

function formatStructuralErrors(errors: StructuralError[]): string {
  return errors
    .slice(0, 12)
    .map((error) => `${error.code}${error.path ? ` [${error.path}]` : ""}: ${error.message}`)
    .join("; ");
}

async function materializeAndValidate(
  state: HarnessRunState,
  runRoot: string,
  bundle: DocumentBundle,
): Promise<Awaited<ReturnType<typeof validateStagedTree>>> {
  const telemetry = harnessTelemetry();
  telemetry?.beginStage("materialization");
  state.status = "materializing";
  await writeRunState(state);
  const staging = await prepareStagingTree(state, runRoot);
  await materializeDocuments(staging, bundle);
  checkpoints(state).materializedAt = new Date().toISOString();
  await writeRunState(state);
  telemetry?.beginStage("validation");
  state.status = "validating";
  await writeRunState(state);
  return validateStagedTree(staging, state.workflow);
}

async function generate(
  state: HarnessRunState,
  runRoot: string,
  evidenceRoot: string,
  inputPackage: HarnessInputPackage,
  options: StandaloneRunOptions,
): Promise<void> {
  const telemetry = harnessTelemetry();
  let bundle = await loadPersistedBundle(state, runRoot);
  if (bundle) {
    process.stdout.write(`[rb-harness] pacote documental completo recuperado do checkpoint (${bundle.documents.length} documentos); provider não será reinvocado.\n`);
  } else {
    telemetry?.beginStage("generation");
    state.status = "generating";
    state.diagnostic = undefined;
    await writeRunState(state);
    process.stdout.write(`[rb-harness] geração incremental com ${state.provider.provider}/${state.provider.model || "provider-default"}...\n`);
    bundle = await requestDocumentBundle({
      state,
      inputPackage,
      runRoot,
      evidenceRoot,
      timeoutSeconds: options.timeoutSeconds,
      firstOutputTimeoutSeconds: options.firstOutputTimeoutSeconds,
      streamOutput: false,
    });
    await persistBundle(state, runRoot, bundle, false);
    process.stdout.write(`[rb-harness] pacote incremental montado: ${bundle.documents.length} documento(s).\n`);
  }

  if (bundle.status === "blocked") {
    state.status = "blocked";
    state.diagnostic = `generation is blocked: ${bundle.blocked.join("; ")}`;
    await writeRunState(state);
    throw new Error(state.diagnostic);
  }

  let validation = await materializeAndValidate(state, runRoot, bundle);
  if (!validation.valid) {
    const repairsUsed = state.repairsUsed ?? 0;
    if (!validation.repairable || repairsUsed >= HARNESS_BUDGET.generation.structuralRepairs) {
      state.status = "generation-failed";
      state.diagnostic = `generated artifact tree is invalid: ${formatStructuralErrors(validation.errors)}`;
      await writeRunState(state);
      throw new Error(state.diagnostic);
    }
    telemetry?.beginStage("structural-repair");
    state.status = "repairing";
    state.repairsUsed = repairsUsed + 1;
    state.diagnostic = undefined;
    await writeRunState(state);
    process.stdout.write(`[rb-harness] ${validation.errors.length} erro(s) estrutural(is); executando a única correção localizada.\n`);
    bundle = await requestStructuralRepair({
      state,
      bundle,
      errors: validation.errors,
      runRoot,
      evidenceRoot,
      timeoutSeconds: options.timeoutSeconds,
      firstOutputTimeoutSeconds: options.firstOutputTimeoutSeconds,
      streamOutput: false,
    });
    await persistBundle(state, runRoot, bundle, true);
    validation = await materializeAndValidate(state, runRoot, bundle);
    if (!validation.valid) {
      state.status = "generation-failed";
      state.diagnostic = `structural repair did not converge: ${formatStructuralErrors(validation.errors)}`;
      await writeRunState(state);
      throw new Error(state.diagnostic);
    }
  }

  checkpoints(state).validatedAt = new Date().toISOString();
  await writeRunState(state);
  process.stdout.write(`[rb-harness] validação determinística verde: ${validation.artifacts} artefatos, ${validation.readyPlans} plano(s) pronto(s).\n`);

  telemetry?.beginStage("publication");
  state.status = "publishing";
  await writeRunState(state);
  const previous = await publishStagedArtifacts(state, runRoot, resolve(runRoot, "staging"));
  state.previousArtifacts = previous;
  state.status = "complete";
  state.generationCheckpoint = undefined;
  state.publishedAt = new Date().toISOString();
  checkpoints(state).publishedAt = state.publishedAt;
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
  const telemetry = startHarnessTelemetry();
  let state: HarnessRunState;
  if (options.resumeId) {
    state = await readRunState(projectRoot, options.resumeId);
    options = optionsFromState(state, options);
    if (state.status === "complete") {
      finishHarnessTelemetry();
      return state;
    }
  } else {
    telemetry.beginStage("inventory");
    const inventory = await inspectProjectInventory(projectRoot, options.artifactDirectory);
    const createdAt = new Date().toISOString();
    state = {
      contract: STANDALONE_STATE_CONTRACT,
      id: runId({ ...options, projectRoot }),
      workflow: options.workflow,
      status: "inventory",
      projectRoot,
      artifactDirectory: options.artifactDirectory,
      request: options.request,
      requestSource: options.requestSource,
      requestHash: hash(options.request),
      provider: options.provider,
      answers: [],
      inventory,
      checkpoints: {},
      repairsUsed: 0,
      createdAt,
      updatedAt: createdAt,
    };
    await writeRunState(state);
  }
  const runRoot = harnessRunRoot(projectRoot, state.id);
  await mkdir(runRoot, { recursive: true, mode: 0o700 });
  await chmod(runRoot, 0o700).catch(() => undefined);
  let evidenceRoot: string | undefined;
  const releaseLock = await acquireHarnessLock(projectRoot, state.id);
  try {
    if (await recoverInterruptedPublication(state, runRoot)) {
      process.stdout.write(`[rb-harness] publicação interrompida detectada; revisão anterior restaurada em ${state.artifactDirectory}.\n`);
      await writeRunState(state);
    }
    telemetry.beginStage("inventory");
    state.inventory = await inspectProjectInventory(projectRoot, state.artifactDirectory);
    // The provider never runs in the project itself: it runs in a bounded,
    // read-only projection that contains no Harness or Git control state.
    // Deliberately not under `runRoot`: a projection beside the run state puts
    // `../state.json` one directory away from the provider.
    const evidence = await prepareEvidenceProjection({
      projectRoot,
      artifactDirectory: state.artifactDirectory,
    });
    evidenceRoot = evidence.root;
    process.stdout.write(
      `[rb-harness] projeção de evidências pronta: ${evidence.files} arquivo(s), ${evidence.bytes} bytes`
      + `${evidence.truncated ? " (truncada pelo orçamento de inventário)" : ""}.\n`,
    );
    const inputPackage = await buildInputPackage({
      workflow: state.workflow,
      projectRoot,
      artifactDirectory: state.artifactDirectory,
      request: state.request,
      requestSource: state.requestSource,
      inventory: state.inventory,
      answers: state.answers,
      assumptions: state.analysis?.assumptions,
      unresolved: state.analysis?.unresolved,
    });
    if (hasReadyInterviewCheckpoint(state)) {
      process.stdout.write("[rb-harness] checkpoint de entrevista pronto; retomando diretamente da geração.\n");
    } else {
      state.status = "interview";
      await writeRunState(state);
      await interview(state, runRoot, evidence.root, inputPackage, options);
    }
    // Accepted decisions become part of the closed checkpoint handed to the writer.
    const closedPackage = await buildInputPackage({
      workflow: state.workflow,
      projectRoot,
      artifactDirectory: state.artifactDirectory,
      request: state.request,
      requestSource: state.requestSource,
      inventory: state.inventory,
      answers: state.answers,
      assumptions: state.analysis?.assumptions,
      unresolved: state.analysis?.unresolved,
    });
    await generate(state, runRoot, evidence.root, closedPackage, options);
    return state;
  } catch (error) {
    if (state.status !== "blocked") {
      state.status = state.status === "interview" ? "interview-failed" : "generation-failed";
    }
    state.diagnostic = error instanceof Error ? error.message : String(error);
    await writeRunState(state);
    throw error;
  } finally {
    // The evidence projection is a derived, rebuildable copy in its own
    // temporary root; it is removed once this invocation's provider calls end.
    if (evidenceRoot) await discardEvidenceProjection(evidenceRoot);
    const report = finishHarnessTelemetry();
    if (report) {
      state.telemetry = report;
      await writeRunState(state).catch(() => undefined);
      await writeFile(
        resolve(runRoot, "telemetry.json"),
        `${JSON.stringify(report, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      ).catch(() => undefined);
      process.stdout.write(`${formatTelemetryReport(report)}\n`);
    }
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
