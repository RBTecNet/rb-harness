import { isUtf8 } from "node:buffer";
import { spawn } from "node:child_process";
import { mkdir, lstat, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  buildInterviewControllerPrompt,
  parseInterviewAnalysis,
  rejectReusedQuestionIds,
} from "./harness-interview.js";
import { sha256File, sha256Text } from "./hash.js";
import {
  HEADLESS_INTERVIEW_CONTRACT,
  headlessInterviewInitRequest,
  validateHeadlessInterviewJson,
  validateHeadlessInterviewValue,
  type HeadlessInterviewDocument,
} from "./headless-interview-contract.js";
import {
  HEADLESS_HARNESS_SHA256,
  HEADLESS_HARNESS_VERSION,
  allowlistedHeadlessSecretValues,
  canonicalHeadlessJson,
  configuredHeadlessAdapter,
  headlessAdapterEnvironment,
  publicHeadlessAdapter,
  validHeadlessAdapter,
  verifyHeadlessAttachments,
  type HeadlessAdapter,
} from "./headless-runner.js";
import { loadWorkflowResources } from "./standalone-resources.js";
import { normalizeInterviewAnswer } from "./standalone-runner.js";
import type {
  HarnessRunState,
  InterviewAnalysis,
  InterviewAnswer,
  InterviewQuestion,
} from "./standalone-types.js";

export const HEADLESS_INTERVIEW_DRAFT_SCHEMA_SHA256 = sha256Text("rb-headless-interview-question/v1");
const STATE_CONTRACT = "rb-headless-interview-state/v1";
const MAX_PROVIDER_ROUNDS = 128;
const MAX_ADAPTER_OUTPUT = 2 * 1024 * 1024;

type SessionStatus = "active" | "complete" | "blocked";
type CachedResponse = { idempotencyKey: string; requestHash: string; response: HeadlessInterviewDocument };
interface InterviewSession {
  contract: typeof STATE_CONTRACT;
  requestId: string;
  interviewId: string;
  captureHash: string;
  initRequest: Record<string, unknown>;
  initRequestHash: string;
  status: SessionStatus;
  round: number;
  sequence: number;
  analysis?: InterviewAnalysis;
  answers: InterviewAnswer[];
  activeQuestion?: InterviewQuestion;
  activeSequence?: number;
  cursor: string;
  cachedResponses: CachedResponse[];
  createdAt: string;
  updatedAt: string;
}

export interface HeadlessInterviewRunOptions {
  input: string | Buffer;
  stateRoot: string;
  workspace?: string;
  environment?: NodeJS.ProcessEnv;
  adapter?: HeadlessAdapter;
  timeoutSeconds?: number;
  firstOutputTimeoutSeconds?: number;
}

export interface HeadlessInterviewRunResult {
  exitCode: number;
  result: HeadlessInterviewDocument;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function redact(value: string, secrets: string[]): string {
  return secrets.reduce((current, secret) => secret ? current.split(secret).join("[REDACTED]") : current, value);
}

function semanticState(session: InterviewSession): Record<string, unknown> {
  return {
    contract: session.contract,
    requestId: session.requestId,
    interviewId: session.interviewId,
    captureHash: session.captureHash,
    initRequestHash: session.initRequestHash,
    status: session.status,
    round: session.round,
    sequence: session.sequence,
    analysis: session.analysis ?? null,
    answers: session.answers,
    activeQuestion: session.activeQuestion ?? null,
    activeSequence: session.activeSequence ?? null,
  };
}

function refreshCursor(session: InterviewSession): void {
  session.cursor = sha256Text(canonicalHeadlessJson(semanticState(session)));
  session.updatedAt = new Date().toISOString();
}

function validSession(value: unknown, requestId: string): value is InterviewSession {
  if (!object(value) || value.contract !== STATE_CONTRACT || value.requestId !== requestId || typeof value.cursor !== "string") return false;
  const session = value as unknown as InterviewSession;
  return session.cursor === sha256Text(canonicalHeadlessJson(semanticState(session)));
}

async function ensureStateRoot(stateRoot: string, workspace: string): Promise<string> {
  if (!isAbsolute(stateRoot)) throw new Error("state_not_absolute");
  const absolute = resolve(stateRoot);
  if (absolute === workspace) throw new Error("state_not_isolated");
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("state_not_isolated");
  return realpath(absolute);
}

function sessionPath(stateRoot: string, requestId: string): string {
  return resolve(stateRoot, `${requestId}.json`);
}

async function writeSession(stateRoot: string, session: InterviewSession): Promise<void> {
  refreshCursor(session);
  const path = sessionPath(stateRoot, session.requestId);
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function readSession(stateRoot: string, requestId: string): Promise<InterviewSession | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(sessionPath(stateRoot, requestId), "utf8"));
    if (!validSession(value, requestId)) throw new Error("session_invalid");
    return value;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function processActive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function acquireSessionLock(stateRoot: string, requestId: string): Promise<() => Promise<void>> {
  const path = resolve(stateRoot, `${requestId}.lock`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
      return async () => { await handle.close().catch(() => undefined); await rm(path, { force: true }); };
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
      let pid = 0;
      try { pid = Number((JSON.parse(await readFile(path, "utf8")) as { pid?: unknown }).pid); } catch { /* stale malformed lock */ }
      if (processActive(pid)) throw new Error("session_locked");
      await rm(path, { force: true });
    }
  }
  throw new Error("session_locked");
}

function isDescendant(candidate: string, parent: string): boolean {
  const nested = relative(parent, candidate);
  return nested !== "" && nested !== ".." && !nested.startsWith(`..${sep}`) && !isAbsolute(nested);
}

async function workspaceSnapshot(workspace: string, excludedRoot: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      if (absolute === excludedRoot || isDescendant(absolute, excludedRoot)) continue;
      const path = relative(workspace, absolute).split(sep).join("/");
      const info = await lstat(absolute);
      if (info.isDirectory()) { snapshot.set(path, "directory"); await visit(absolute); }
      else if (info.isFile()) snapshot.set(path, `file:${info.size}:${await sha256File(absolute)}`);
      else if (info.isSymbolicLink()) snapshot.set(path, "symlink");
      else snapshot.set(path, "special");
    }
  }
  await visit(workspace);
  return snapshot;
}

function sameSnapshot(left: Map<string, string>, right: Map<string, string>): boolean {
  return left.size === right.size && [...left].every(([path, fingerprint]) => right.get(path) === fingerprint);
}

function requestIdFrom(document: HeadlessInterviewDocument | undefined): string {
  return typeof document?.requestId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(document.requestId) ? document.requestId : "invalid-request";
}

function eventQuestion(question: InterviewQuestion, sequence: number): Record<string, unknown> {
  const header = question.question.replace(/\s+/g, " ").trim().replace(/[?.!]+$/, "");
  return {
    kind: "question",
    sequence,
    questionId: question.id,
    header: Array.from(header).slice(0, 120).join("") || question.id,
    reason: question.why,
    question: question.question,
    type: question.type,
    options: question.options.map((label, index) => ({
      id: `option-${index + 1}`,
      label,
      recommended: question.recommendation?.trim() === label.trim(),
    })),
    allowsFreeText: true,
    draftSchemaHash: HEADLESS_INTERVIEW_DRAFT_SCHEMA_SHA256,
    ...(question.answerFor ? { answerFor: question.answerFor } : {}),
  };
}

function acceptedAnswers(session: InterviewSession): Array<Record<string, unknown>> {
  return session.answers
    .filter((answer) => answer.disposition === "ACCEPTED" && answer.normalizedDecision)
    .map((answer) => ({ questionId: answer.questionId, question: answer.question, answer: answer.normalizedDecision, disposition: "accepted" }));
}

function terminalEvent(session: InterviewSession): Record<string, unknown> {
  if (session.status === "complete") {
    return {
      kind: "interview_complete",
      acceptedAnswers: acceptedAnswers(session),
      transcriptHash: sha256Text(canonicalHeadlessJson(session.answers)),
    };
  }
  return { kind: "interview_failed", diagnosticCode: "material_interview_blocked", retryable: false };
}

function adapterMetadata(adapter: HeadlessAdapter | undefined, secrets: string[]): Record<string, unknown> {
  const safe = publicHeadlessAdapter(adapter, secrets);
  return { id: safe.id, version: safe.version, provider: safe.provider, model: safe.model };
}

function response(
  requestId: string,
  requestHash: string,
  adapter: HeadlessAdapter | undefined,
  secrets: string[],
  startedAt: string,
  status: "active" | "complete" | "invalid" | "failed",
  events: Array<Record<string, unknown>>,
  session?: InterviewSession,
  diagnosticCode = "",
): HeadlessInterviewDocument {
  const result: HeadlessInterviewDocument = {
    contract: HEADLESS_INTERVIEW_CONTRACT,
    kind: "response",
    requestId: redact(requestId, secrets),
    requestHash,
    status,
    interviewId: session ? redact(session.interviewId, secrets) : null,
    cursor: session?.cursor ?? null,
    events,
    harness: { version: HEADLESS_HARNESS_VERSION, sha256: HEADLESS_HARNESS_SHA256 },
    adapter: adapterMetadata(adapter, secrets),
    startedAt,
    finishedAt: new Date().toISOString(),
    ...(diagnosticCode ? { diagnosticCode } : {}),
  };
  if (secrets.some((secret) => secret && canonicalHeadlessJson(result).includes(secret))) throw new Error("secret_detected");
  if (!validateHeadlessInterviewValue(result).valid) throw new Error("result_invalid");
  return result;
}

function failed(
  requestId: string,
  requestHash: string,
  adapter: HeadlessAdapter | undefined,
  secrets: string[],
  startedAt: string,
  diagnosticCode: string,
  exitCode: number,
  retryable: boolean,
  status: "invalid" | "failed" = "failed",
): HeadlessInterviewRunResult {
  return {
    exitCode,
    result: response(requestId, requestHash, adapter, secrets, startedAt, status,
      [{ kind: "interview_failed", diagnosticCode, retryable }], undefined, diagnosticCode),
  };
}

function emptyInventory(workspace: string): HarnessRunState["inventory"] {
  return {
    projectRoot: workspace, artifactDirectory: ".rb", manifestFound: false, manifestValid: false,
    artifacts: 0, byKind: {}, byStatus: {}, readyPlans: [], artifactHighlights: [], ralphRuns: [], issues: [],
  };
}

function subject(initRequest: Record<string, unknown>): string {
  return [
    "Interview for a declarative new-project specification package. Do not inspect or change an existing system.",
    `Project: ${JSON.stringify(initRequest.project)}`,
    `Specifications: ${JSON.stringify(initRequest.specifications)}`,
    `Additional constraints: ${JSON.stringify(initRequest.additionalInstructions)}`,
  ].join("\n");
}

function syntheticState(session: InterviewSession, workspace: string): HarnessRunState {
  return {
    contract: "rb-harness-run/v1",
    id: session.interviewId,
    workflow: "init",
    status: "interview",
    projectRoot: workspace,
    artifactDirectory: ".rb",
    request: subject(session.initRequest),
    requestHash: session.initRequestHash,
    provider: { provider: "custom", model: "headless-adapter", effort: "provider-default", command: "headless-adapter" },
    answers: session.answers,
    analysis: session.analysis,
    inventory: emptyInventory(workspace),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

async function runAdapter(
  adapter: HeadlessAdapter,
  prompt: string,
  workspace: string,
  environment: NodeJS.ProcessEnv,
  timeoutSeconds: number,
  firstOutputTimeoutSeconds: number,
): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(adapter.command, adapter.args, { cwd: workspace, env: environment, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    let settled = false;
    const terminate = () => {
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); } catch { child.kill("SIGTERM"); }
    };
    let wall: ReturnType<typeof setTimeout> | undefined;
    let first: ReturnType<typeof setTimeout> | undefined;
    const finish = () => { if (wall) clearTimeout(wall); if (first) clearTimeout(first); };
    const abort = (diagnostic: string) => {
      if (settled) return;
      settled = true;
      finish();
      terminate();
      reject(new Error(diagnostic));
    };
    wall = timeoutSeconds > 0 ? setTimeout(() => abort("adapter_timeout"), timeoutSeconds * 1_000) : undefined;
    first = firstOutputTimeoutSeconds > 0 ? setTimeout(() => { if (stdout.length === 0) abort("adapter_first_output_timeout"); }, firstOutputTimeoutSeconds * 1_000) : undefined;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (first) clearTimeout(first);
      if (Buffer.byteLength(stdout) > MAX_ADAPTER_OUTPUT) abort("adapter_output_too_large");
    });
    child.once("error", (error) => { if (settled) return; settled = true; finish(); reject(error); });
    child.once("close", (code, signal) => { if (settled) return; settled = true; finish(); resolveRun({ exitCode: code ?? (signal ? 70 : 1), stdout }); });
    child.stdin.once("error", () => {});
    child.stdin.end(prompt, "utf8");
  });
}

function applyReviews(session: InterviewSession, analysis: InterviewAnalysis): void {
  for (const review of analysis.answerReviews) {
    const answer = session.answers.find((entry) => entry.questionId === review.questionId && entry.disposition === "PENDING");
    if (!answer) continue;
    answer.disposition = review.disposition;
    if (review.normalizedDecision !== undefined) answer.normalizedDecision = review.normalizedDecision;
    else delete answer.normalizedDecision;
    if (review.remainingUncertainty !== undefined) answer.remainingUncertainty = review.remainingUncertainty;
    else delete answer.remainingUncertainty;
  }
}

async function analyze(
  session: InterviewSession,
  workspace: string,
  stateRoot: string,
  adapter: HeadlessAdapter,
  environment: NodeJS.ProcessEnv,
  secrets: string[],
  timeoutSeconds: number,
  firstOutputTimeoutSeconds: number,
): Promise<InterviewAnalysis> {
  if (session.round >= MAX_PROVIDER_ROUNDS) throw new Error("interview_round_limit");
  const pending = session.answers.filter((answer) => answer.disposition === "PENDING");
  const resources = [
    "Headless continuity rule: preserve every still-unanswered question from the prior checkpoint with its stable ID. A materially unresolved submitted answer requires a new focused follow-up ID.",
    await loadWorkflowResources("init"),
  ].join("\n");
  let repair: string | undefined;
  let rejected: string | undefined;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const prompt = buildInterviewControllerPrompt(syntheticState(session, workspace), resources, pending, repair, rejected);
    const beforeWorkspace = await workspaceSnapshot(workspace, stateRoot);
    const stateFile = sessionPath(stateRoot, session.requestId);
    const beforeState = await sha256File(stateFile);
    const outcome = await runAdapter(adapter, redact(prompt, secrets), workspace, environment, timeoutSeconds, firstOutputTimeoutSeconds);
    if (!sameSnapshot(beforeWorkspace, await workspaceSnapshot(workspace, stateRoot)) || beforeState !== await sha256File(stateFile)) throw new Error("workspace_modified");
    if (outcome.exitCode !== 0) throw new Error(outcome.exitCode === 75 ? "adapter_unavailable" : "adapter_failed");
    try {
      const analysis = parseInterviewAnalysis(outcome.stdout, pending);
      rejectReusedQuestionIds(syntheticState(session, workspace), analysis);
      return analysis;
    } catch (error) {
      repair = error instanceof Error ? error.message : String(error);
      rejected = outcome.stdout.length <= 256 * 1024 ? redact(outcome.stdout, secrets) : undefined;
      if (attempt === 2) throw new Error("adapter_protocol_invalid");
    }
  }
  throw new Error("adapter_protocol_invalid");
}

function chooseQuestion(analysis: InterviewAnalysis, reviewedQuestionId?: string): InterviewQuestion | undefined {
  const focused = reviewedQuestionId
    ? analysis.questions.find((question) => question.answerFor === reviewedQuestionId)
    : undefined;
  return focused ?? analysis.questions[0];
}

function updateFromAnalysis(session: InterviewSession, analysis: InterviewAnalysis, reviewedQuestionId?: string): void {
  applyReviews(session, analysis);
  session.analysis = analysis;
  session.round += 1;
  session.activeQuestion = undefined;
  session.activeSequence = undefined;
  if (analysis.status === "ready") session.status = "complete";
  else if (analysis.status === "blocked") session.status = "blocked";
  else {
    session.status = "active";
    session.activeQuestion = chooseQuestion(analysis, reviewedQuestionId);
    if (!session.activeQuestion) throw new Error("adapter_protocol_invalid");
    session.sequence += 1;
    session.activeSequence = session.sequence;
  }
}

function sessionEvents(session: InterviewSession): Array<Record<string, unknown>> {
  if (session.status !== "active") return [terminalEvent(session)];
  if (!session.activeQuestion || !session.activeSequence) throw new Error("session_invalid");
  return [eventQuestion(session.activeQuestion, session.activeSequence)];
}

function answerResult(session: InterviewSession, questionId: string, sequence: number): Record<string, unknown> {
  const answer = session.answers.find((entry) => entry.questionId === questionId);
  if (!answer || answer.disposition === "PENDING") throw new Error("adapter_protocol_invalid");
  const disposition = answer.disposition.toLowerCase();
  const followUp = session.activeQuestion?.answerFor === questionId ? session.activeQuestion.id : undefined;
  return {
    kind: "answer_result",
    sequence,
    questionId,
    disposition,
    ...(answer.disposition === "ACCEPTED" ? { normalizedDecision: answer.normalizedDecision } : {}),
    ...(["PARTIAL", "AMBIGUOUS", "CONTRADICTED"].includes(answer.disposition)
      ? { remainingUncertainty: answer.remainingUncertainty, followUpQuestionId: followUp }
      : {}),
  };
}

function exitForError(code: string): { exitCode: number; retryable: boolean; status: "invalid" | "failed" } {
  if (["invalid_request", "cursor_mismatch", "session_mismatch", "session_invalid", "answer_mismatch", "attachment_invalid", "attachment_hash_mismatch"].includes(code)) return { exitCode: 2, retryable: false, status: "invalid" };
  if (["adapter_not_configured", "adapter_configuration_invalid", "state_not_absolute", "state_not_isolated"].includes(code)) return { exitCode: 3, retryable: false, status: "failed" };
  if (["session_locked", "adapter_unavailable", "adapter_first_output_timeout"].includes(code)) return { exitCode: 75, retryable: true, status: "failed" };
  return { exitCode: 70, retryable: true, status: "failed" };
}

export async function runHeadlessInterview(options: HeadlessInterviewRunOptions): Promise<HeadlessInterviewRunResult> {
  const startedAt = new Date().toISOString();
  const environment = options.environment ?? process.env;
  const workspace = resolve(options.workspace ?? process.cwd());
  const adapter = options.adapter ?? configuredHeadlessAdapter(environment);
  const secrets = allowlistedHeadlessSecretValues(environment);
  const source = typeof options.input === "string" ? options.input : isUtf8(options.input) ? options.input.toString("utf8") : undefined;
  const parsed = source === undefined ? { valid: false, issues: [], document: undefined } : validateHeadlessInterviewJson(source);
  const request = parsed.document;
  const requestId = requestIdFrom(request);
  const requestHash = sha256Text(parsed.valid && request ? canonicalHeadlessJson(request) : source ?? options.input.toString("hex"));
  if (!parsed.valid || !request) return failed(requestId, requestHash, adapter, secrets, startedAt, "invalid_request", 2, false, "invalid");
  if (!validHeadlessAdapter(adapter)) return failed(requestId, requestHash, adapter, secrets, startedAt, "adapter_not_configured", 3, false);

  let stateRoot: string;
  try { stateRoot = await ensureStateRoot(options.stateRoot, workspace); }
  catch (error) {
    const code = error instanceof Error ? error.message : "state_not_isolated";
    const mapping = exitForError(code);
    return failed(requestId, requestHash, adapter, secrets, startedAt, code, mapping.exitCode, mapping.retryable, mapping.status);
  }

  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireSessionLock(stateRoot, requestId);
    let session = await readSession(stateRoot, requestId);
    if (request.kind === "interview_start") {
      const init = headlessInterviewInitRequest(request)!;
      const initRequestHash = sha256Text(canonicalHeadlessJson(init));
      if (session && (session.captureHash !== request.captureHash || session.initRequestHash !== initRequestHash)) throw new Error("session_mismatch");
      if (session && request.cursor !== null && request.cursor !== session.cursor) throw new Error("cursor_mismatch");
      if (!session) {
        try { await verifyHeadlessAttachments(init, workspace); }
        catch (error) { throw new Error(error instanceof Error && error.message === "attachment_hash_mismatch" ? "attachment_hash_mismatch" : "attachment_invalid"); }
        const createdAt = new Date().toISOString();
        const seeded = (init.interviewAnswers as Array<Record<string, unknown>>).map((answer) => ({
          questionId: String(answer.questionId), question: String(answer.question), rawAnswer: String(answer.answer),
          disposition: "ACCEPTED" as const, normalizedDecision: String(answer.answer), answeredAt: createdAt,
        }));
        session = {
          contract: STATE_CONTRACT, requestId, interviewId: `interview-${sha256Text(`${requestId}\0${request.captureHash}`).slice(0, 32)}`,
          captureHash: String(request.captureHash), initRequest: init, initRequestHash, status: "active", round: 0,
          sequence: 0, answers: seeded, cursor: "", cachedResponses: [], createdAt, updatedAt: createdAt,
        };
        await writeSession(stateRoot, session);
      }
      if (session.status === "active" && !session.activeQuestion) {
        const adapterEnvironment = headlessAdapterEnvironment(environment, adapter, { requestId, mode: "interview", interviewId: session.interviewId });
        const analysis = await analyze(session, workspace, stateRoot, adapter, adapterEnvironment.env, adapterEnvironment.secrets,
          options.timeoutSeconds ?? 3_600, options.firstOutputTimeoutSeconds ?? 300);
        updateFromAnalysis(session, analysis);
        await writeSession(stateRoot, session);
      }
      const status = session.status === "active" ? "active" : session.status === "complete" ? "complete" : "failed";
      const result = response(requestId, requestHash, adapter, secrets, startedAt, status, sessionEvents(session), session,
        session.status === "blocked" ? "material_interview_blocked" : "");
      return { exitCode: session.status === "blocked" ? 3 : 0, result };
    }

    if (!session || request.interviewId !== session.interviewId) throw new Error("session_mismatch");
    const cached = session.cachedResponses.find((entry) => entry.idempotencyKey === request.idempotencyKey);
    if (cached) {
      if (cached.requestHash !== requestHash) throw new Error("session_mismatch");
      return { exitCode: 0, result: cached.response };
    }
    if (request.cursor !== session.cursor) throw new Error("cursor_mismatch");
    if (session.status !== "active" || !session.activeQuestion || session.activeSequence !== request.sequence || session.activeQuestion.id !== request.questionId) throw new Error("answer_mismatch");
    if (session.answers.length >= 100) throw new Error("interview_answer_limit");
    const question = session.activeQuestion;
    const sequence = session.activeSequence!;
    const normalized = normalizeInterviewAnswer(question, String(request.answer));
    session.answers.push({ questionId: question.id, question: question.question, rawAnswer: normalized, disposition: "PENDING", answeredAt: new Date().toISOString() });
    session.activeQuestion = undefined;
    session.activeSequence = undefined;
    const adapterEnvironment = headlessAdapterEnvironment(environment, adapter, { requestId, mode: "interview", interviewId: session.interviewId });
    const analysis = await analyze(session, workspace, stateRoot, adapter, adapterEnvironment.env, adapterEnvironment.secrets,
      options.timeoutSeconds ?? 3_600, options.firstOutputTimeoutSeconds ?? 300);
    updateFromAnalysis(session, analysis, question.id);
    const resolvedSession = session as InterviewSession;
    await writeSession(stateRoot, session);
    const events = [answerResult(resolvedSession, question.id, sequence), ...sessionEvents(resolvedSession)];
    const status = resolvedSession.status === "active" ? "active" : resolvedSession.status === "complete" ? "complete" : "failed";
    const result = response(requestId, requestHash, adapter, secrets, startedAt, status, events, session,
      resolvedSession.status === "blocked" ? "material_interview_blocked" : "");
    session.cachedResponses.push({ idempotencyKey: String(request.idempotencyKey), requestHash, response: result });
    session.cachedResponses = session.cachedResponses.slice(-1_000);
    await writeSession(stateRoot, session);
    return { exitCode: resolvedSession.status === "blocked" ? 3 : 0, result };
  } catch (error) {
    const code = error instanceof Error ? error.message : "interview_failed";
    const mapping = exitForError(code);
    return failed(requestId, requestHash, adapter, secrets, startedAt, code, mapping.exitCode, mapping.retryable, mapping.status);
  } finally {
    await release?.();
  }
}
