import { randomUUID } from "node:crypto";
import type { ClosureResult } from "./closure.js";
import { closeInitProject, SemanticClosureError } from "./closure.js";
import { SemanticGateway, SemanticGatewayError, type SemanticGatewaySnapshot } from "./gateway.js";
import {
  pendingQuestionEvidence,
  selectInterviewAnswer,
  verifyInterviewEvidence,
  type InterviewQuestionEvidence,
} from "./interview.js";
import type {
  AcceptedRecommendationProof,
  InitProjectModel,
  ResolutionContext,
  SemanticDeterminationInput,
  SemanticInitProject,
  SemanticProtectedPathInput,
} from "./ir.js";
import {
  correctiveIntentInput,
  correctiveWorkInput,
  INTENT_INSTRUCTIONS,
  intentInput,
  resolvedIntentPromptAuthority,
  WORK_INSTRUCTIONS,
  workInput,
} from "./prompts.js";
import type { ModelProfile, ProviderAdapter, ResolvedProviderAuth } from "./providers/contract.js";
import { resolveInitProject } from "./resolve.js";
import {
  createInitRunState,
  persistInitRunState,
  transitionInitRunState,
  type VnextInitRunState,
} from "./run-state.js";
import { validate } from "./validate.js";
import {
  decodeIntentWire,
  decodeWorkWire,
  deriveWorkSchema,
  INIT_INTENT_SCHEMA,
  type IntentWire,
  type WireFinding,
  type WireOutcome,
  type WorkWire,
} from "./wire.js";

export type VnextInitFailureKind =
  | "provider-auth-runtime-failure"
  | "transport-exhausted"
  | "wire-decode-failure"
  | "semantic-invalid-after-recovery"
  | "interview-exceptional-block"
  | "budget-exhausted"
  | "deterministic-core-failure"
  | "publication-failure";

export class VnextInitError extends Error {
  constructor(
    readonly kind: VnextInitFailureKind,
    message: string,
    readonly publicationOccurred: boolean,
    readonly cause?: unknown,
  ) {
    super(`${kind}: ${message}`);
    this.name = "VnextInitError";
  }
}

export type InitInterviewMode =
  | { readonly kind: "headless" }
  | { readonly kind: "interactive"; readonly answer: (question: InterviewQuestionEvidence) => Promise<string> };

export interface RunSemanticInitOptions {
  readonly originalRequest: string;
  readonly projectRoot: string;
  readonly profile: ModelProfile;
  readonly adapter: ProviderAdapter;
  readonly auth: ResolvedProviderAuth;
  readonly interview: InitInterviewMode;
  readonly signal?: AbortSignal;
  readonly runId?: string;
  readonly now?: () => string;
  readonly deadlineMs?: number;
  readonly maxOutputTokens?: number;
}

export interface SemanticInitResult {
  readonly closure: ClosureResult;
  readonly runState: VnextInitRunState;
  readonly runStatePath: string;
}

interface ResolvedIntent {
  readonly wire: IntentWire;
  readonly semanticBase: Omit<SemanticInitProject, "phases">;
  readonly context: ResolutionContext;
  readonly questionEvidence: readonly InterviewQuestionEvidence[];
}

function toWireFindings(findings: readonly { readonly pointer: string; readonly message: string }[]): readonly WireFinding[] {
  return findings.map((finding) => ({ code: "semantic-invalid", pointer: finding.pointer, message: finding.message }));
}

function ensureIntentSufficient(intent: IntentWire, questions: readonly InterviewQuestionEvidence[]): WireOutcome<true> {
  const findings: WireFinding[] = [];
  if (intent.project.name.trim().length < 2) findings.push({ code: "semantic-invalid", pointer: "/project/name", message: "project name is not useful" });
  if (intent.project.objective.trim().length < 12) findings.push({ code: "semantic-invalid", pointer: "/project/objective", message: "project objective is not useful" });
  if (!intent.requirements.length) findings.push({ code: "semantic-invalid", pointer: "/requirements", message: "requirements are required" });
  if (!intent.qualityCommands.length) findings.push({ code: "semantic-invalid", pointer: "/qualityCommands", message: "at least one quality command is required" });
  if (intent.contradictions.length) findings.push({ code: "semantic-invalid", pointer: "/contradictions", message: "unresolved contradiction prevents semantic closure" });
  for (const [index, question] of questions.entries()) {
    try {
      verifyInterviewEvidence(question);
    } catch (error) {
      findings.push({ code: "semantic-invalid", pointer: `/questions/${index}`, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return findings.length ? { ok: false, findings } : { ok: true, value: true };
}

function buildResolvedIntent(intent: IntentWire, questions: readonly InterviewQuestionEvidence[], input: {
  readonly originalRequest: string;
  readonly runId: string;
  readonly generatedAt: string;
}): ResolvedIntent {
  const sufficiency = ensureIntentSufficient(intent, questions);
  if (!sufficiency.ok) throw new VnextInitError("interview-exceptional-block", sufficiency.findings.map((entry) => entry.message).join("; "), false);
  const decisions = questions.map(verifyInterviewEvidence);
  for (const decision of decisions) {
    if (decision.source.kind === "model-default" || decision.source.kind === "request") {
      throw new VnextInitError("interview-exceptional-block", "interview decision did not produce answer authority", false);
    }
  }
  const answers: Record<string, string> = {};
  const acceptedRecommendations: Record<string, AcceptedRecommendationProof> = {};
  const questionDeterminations: SemanticDeterminationInput[] = questions.map((question, index) => {
    const decision = decisions[index]!;
    if (decision.source.kind === "user-answer") answers[question.key] = decision.selectedValue;
    if (decision.acceptedRecommendation) acceptedRecommendations[question.key] = decision.acceptedRecommendation;
    return {
      key: question.key,
      statement: decision.selectedValue,
      rationale: decision.source.kind === "user-answer"
        ? "Selected through an explicit user answer to a material interview question."
        : question.recommendedAnswer.rationale,
      materiality: question.materiality,
      rigidity: question.rigidity,
      source: decision.source,
    };
  });
  const decisionByKey = new Map(decisions.map((decision) => [decision.questionKey as string, decision]));
  const protectedPaths: SemanticProtectedPathInput[] = intent.proposedProtectedPaths.flatMap((path) => {
    if (path.source.kind === "request") return [path];
    if (path.source.kind !== "user-answer" && path.source.kind !== "accepted-recommendation") return [];
    const questionKey = path.source.questionKey;
    const decision = decisionByKey.get(questionKey);
    if (!decision || decision.selectedValue !== path.path) return [];
    if (decision.source.kind === "model-default" || decision.source.kind === "request") return [];
    return [{
      ...path,
      source: decision.source.kind === "user-answer"
        ? { kind: "user-answer" as const, questionKey }
        : { kind: "accepted-recommendation" as const, questionKey },
    }];
  });
  return {
    wire: intent,
    semanticBase: {
      workflow: "init",
      project: intent.project,
      determinations: [...intent.determinations, ...questionDeterminations],
      requirements: intent.requirements,
      qualityCommands: intent.qualityCommands,
      protectedPaths,
    },
    context: {
      originalRequest: input.originalRequest,
      answers,
      acceptedRecommendations,
      runId: input.runId,
      generatedAt: input.generatedAt,
    },
    questionEvidence: questions,
  };
}

function resolvedWorkDecoder(intent: ResolvedIntent): (payload: unknown) => WireOutcome<{ readonly wire: WorkWire; readonly model: InitProjectModel }> {
  return (payload) => {
    const decoded = decodeWorkWire(payload, intent.wire);
    if (!decoded.ok) return decoded;
    const semantic: SemanticInitProject = { ...intent.semanticBase, phases: decoded.value.phases };
    const resolved = resolveInitProject(semantic, intent.context);
    if (!resolved.ok) return { ok: false, findings: toWireFindings(resolved.findings) };
    const validation = validate(resolved.value);
    if (!validation.valid) return { ok: false, findings: toWireFindings(validation.findings) };
    return { ok: true, value: { wire: decoded.value, model: resolved.value } };
  };
}

function gatewayFailure(error: SemanticGatewayError): VnextInitError {
  const kind: VnextInitFailureKind = error.kind === "budget-exhausted"
    ? "budget-exhausted"
    : error.kind === "transport-exhausted"
      ? "transport-exhausted"
      : error.kind === "semantic-invalid-after-recovery"
        ? "semantic-invalid-after-recovery"
        : error.kind === "provider-failure"
          ? "provider-auth-runtime-failure"
          : "wire-decode-failure";
  return new VnextInitError(kind, error.message, false, error);
}

export async function runSemanticInit(options: RunSemanticInitOptions): Promise<SemanticInitResult> {
  const originalRequest = options.originalRequest.trim();
  if (!originalRequest) throw new VnextInitError("wire-decode-failure", "request must not be empty", false);
  const now = options.now ?? (() => new Date().toISOString());
  const runId = options.runId ?? `vnext-${randomUUID()}`;
  const generatedAt = now();
  const signal = options.signal ?? new AbortController().signal;
  let state = createInitRunState({
    runId,
    originalRequest,
    profileId: options.profile.id,
    transport: options.profile.transport,
    requestAccounting: options.profile.requestAccounting,
    now: generatedAt,
  });
  let statePath = await persistInitRunState(options.projectRoot, state);

  const updateSnapshot = async (snapshot: SemanticGatewaySnapshot): Promise<void> => {
    state = { ...state, counters: snapshot.counters, attempts: snapshot.attempts, updatedAt: now() };
    statePath = await persistInitRunState(options.projectRoot, state);
  };
  const gateway = new SemanticGateway(options.adapter, options.profile, options.auth, updateSnapshot);

  try {
    state = transitionInitRunState(state, "intent-requested", now());
    statePath = await persistInitRunState(options.projectRoot, state);
    const intent = await gateway.generate({
      slice: "intent",
      schema: INIT_INTENT_SCHEMA,
      schemaName: "rb_init_intent_v1",
      instructions: INTENT_INSTRUCTIONS,
      input: intentInput(originalRequest),
      correctiveInput: (findings) => correctiveIntentInput(originalRequest, findings),
      decode: (payload) => decodeIntentWire(payload, originalRequest),
      signal,
      deadlineMs: options.deadlineMs ?? 120_000,
      maxOutputTokens: options.maxOutputTokens ?? 16_000,
    });
    state = transitionInitRunState(state, "intent-decoded", now());
    statePath = await persistInitRunState(options.projectRoot, state);

    const questionEvidence: InterviewQuestionEvidence[] = [];
    for (const question of intent.questions) {
      const pending = pendingQuestionEvidence(question);
      questionEvidence.push(pending);
      state = transitionInitRunState(state, "interview-pending", now(), { questions: [...questionEvidence] });
      statePath = await persistInitRunState(options.projectRoot, state);
      const selected = options.interview.kind === "headless"
        ? selectInterviewAnswer(pending, { kind: "headless" })
        : selectInterviewAnswer(pending, { kind: "interactive", response: await options.interview.answer(pending) });
      questionEvidence[questionEvidence.length - 1] = selected;
      const verified = verifyInterviewEvidence(selected);
      state = transitionInitRunState(state, "interview-pending", now(), {
        questions: [...questionEvidence],
        resolvedAuthority: [...state.resolvedAuthority, {
          questionKey: selected.key,
          source: verified.source.kind as "user-answer" | "accepted-recommendation",
          acceptanceMode: verified.acceptanceMode,
        }],
      });
      statePath = await persistInitRunState(options.projectRoot, state);
    }

    const resolvedIntent = buildResolvedIntent(intent, questionEvidence, { originalRequest, runId, generatedAt });
    state = transitionInitRunState(state, "intent-resolved", now());
    statePath = await persistInitRunState(options.projectRoot, state);
    state = transitionInitRunState(state, "work-requested", now());
    statePath = await persistInitRunState(options.projectRoot, state);
    const promptAuthority = resolvedIntentPromptAuthority(intent, questionEvidence);
    const work = await gateway.generate({
      slice: "work",
      schema: deriveWorkSchema(intent),
      schemaName: "rb_init_work_v1",
      instructions: WORK_INSTRUCTIONS,
      input: workInput(promptAuthority),
      correctiveInput: (findings) => correctiveWorkInput(promptAuthority, findings),
      decode: resolvedWorkDecoder(resolvedIntent),
      signal,
      deadlineMs: options.deadlineMs ?? 120_000,
      maxOutputTokens: options.maxOutputTokens ?? 24_000,
    });
    state = transitionInitRunState(state, "work-resolved", now());
    statePath = await persistInitRunState(options.projectRoot, state);
    state = transitionInitRunState(state, "deterministic-closure", now());
    statePath = await persistInitRunState(options.projectRoot, state);
    const closure = await closeInitProject(work.model, options.projectRoot);
    state = transitionInitRunState(state, "published", now(), { terminalStatus: "published", publicationOccurred: true });
    statePath = await persistInitRunState(options.projectRoot, state);
    return { closure, runState: state, runStatePath: statePath };
  } catch (error) {
    const failure = error instanceof SemanticGatewayError ? gatewayFailure(error) : error;
    if (state.stage !== "published" && state.stage !== "failed") {
      const kind = failure instanceof VnextInitError
        ? failure.kind
        : failure instanceof SemanticClosureError
          ? "deterministic-core-failure"
          : "publication-failure";
      state = transitionInitRunState(state, "failed", now(), {
        terminalStatus: "failed",
        failureKind: kind,
        publicationOccurred: false,
        counters: gateway.snapshot().counters,
        attempts: gateway.snapshot().attempts,
      });
      await persistInitRunState(options.projectRoot, state);
    }
    if (failure instanceof VnextInitError) throw failure;
    if (failure instanceof SemanticClosureError) throw new VnextInitError("deterministic-core-failure", failure.message, false, failure);
    throw new VnextInitError("publication-failure", failure instanceof Error ? failure.message : String(failure), false, failure);
  }
}
