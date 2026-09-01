import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { inspectProgressiveInit, runProgressiveInit } from "../../src/vnext/progressive-init/coordinator.js";
import { executeProgressiveInitCommand, runProgressiveInitCommand, type ProgressiveInitCliRuntime } from "../../src/vnext/progressive-init/cli.js";
import { parseProjectDescriptionDocument, renderProjectDescriptionDocument } from "../../src/vnext/progressive-init/project-description-document.js";
import type { ProjectDescription } from "../../src/vnext/progressive-init/project-description-ir.js";
import { formatProgressiveStagePresentation } from "../../src/vnext/progressive-init/coordinator.js";
import { formatInteractiveQuestion, pendingQuestionEvidence, selectInterviewAnswer, type InterviewQuestionEvidence, type ProposedQuestion } from "../../src/vnext/interview.js";
import {
  USER_STORIES_QUESTIONS_SCHEMA,
  USER_STORIES_SCHEMA,
  decodeUserStoriesQuestionSelection,
  decodeUserStoriesWire,
  enumerateUserStoriesParticipationSubjects,
  materializeUserStoriesInterviewDeterminations,
  materializeUserStoriesStructuralDecisions,
  requiredUserStoriesParticipationSubjects,
  resolveUserStoriesWire,
  userStoriesAcceptedDecisionProjection,
  userStoriesAuthoritativeInputSha256,
  userStoriesForPersistence,
  userStoriesUpstreamProjection,
  userStoriesUpstreamProjectionSha256,
  validateUserStories,
  validateUserStoriesPreservation,
  validateUserStoriesUpstreamReadiness,
  validateUserStoriesUpstreamRefinement,
  type UserStories,
  type UserStoriesUpstreamProjection,
  type UserStoriesWire,
  type UserStoriesCapabilityParticipationQuestion,
} from "../../src/vnext/progressive-init/user-stories-ir.js";
import { parseUserStoriesDocument, renderUserStoriesDocument } from "../../src/vnext/progressive-init/user-stories-document.js";
import { loadUserStories } from "../../src/vnext/progressive-init/user-stories-store.js";
import { runUserStoriesOperation } from "../../src/vnext/progressive-init/user-stories-operation.js";
import type {
  CanonicalSemanticResponse,
  ModelProfile,
  ProviderAdapter,
  ProviderOutcome,
  ResolvedProviderAuth,
  SemanticRequest,
} from "../../src/vnext/providers/contract.js";

const REQUEST = "Build an issue tracker where developers manage issues and reviewers approve them.";

const projectPayload = () => ({
  contract: "rb-project-description/v1",
  stage: "project-description",
  originalRequest: REQUEST,
  project: { key: "issue-tracker", name: "Issue Tracker", objective: "Track and review project issues through explicit actor workflows." },
  actors: [
    { key: "developer", name: "Developer", responsibility: "Creates and updates issues." },
    { key: "reviewer", name: "Reviewer", responsibility: "Reviews issues before approval." },
  ],
  capabilities: [
    { key: "manage-issues", statement: "Create and update project issues." },
    { key: "review-issues", statement: "Review issues before approval." },
  ],
  workflows: [
    { key: "issue-lifecycle", statement: "A developer creates and updates an issue.", actorKeys: ["developer"], capabilityKeys: ["manage-issues"] },
    { key: "issue-review", statement: "A reviewer reviews an issue before approval.", actorKeys: ["reviewer"], capabilityKeys: ["review-issues"] },
  ],
  constraints: [{ key: "auditable-review", statement: "Review outcomes remain observable to the participating actors." }],
  determinations: [
    { key: "visible-review", statement: "Review outcomes are visible to participants", rationale: "This affects the user-visible review workflow.", materiality: "product", rigidity: "FLEXIBLE", source: { kind: "model-default" } },
    { key: "internal-storage", statement: "Storage is an implementation detail", rationale: "It does not change user-story behavior.", materiality: "implementation", rigidity: "FLEXIBLE", source: { kind: "model-default" } },
  ],
  qualityCommands: [{ key: "tests", kind: "test", command: "npm test" }],
  questions: [],
});

const emptyQuestions = () => ({ contract: "rb-user-stories-questions/v1", stage: "user-stories", participationRecommendations: [], questions: [] });

const candidate = () => ({
  contract: "rb-user-stories/v1",
  stage: "user-stories",
  projectKey: "issue-tracker",
  stories: [
    { key: "update-issue", workflowKey: "issue-lifecycle", capabilityKeys: ["manage-issues"], actorKey: "developer", operatorActorKey: "developer", intent: "Update an existing issue", outcome: "The issue reflects current project information", acceptance: ["The developer can observe the updated issue details"] },
    { key: "review-issue", workflowKey: "issue-review", capabilityKeys: ["review-issues"], actorKey: "reviewer", operatorActorKey: "reviewer", intent: "Review an issue awaiting approval", outcome: "The issue has an explicit review outcome", acceptance: ["The reviewer can record and observe the review outcome"] },
    { key: "create-issue", workflowKey: "issue-lifecycle", capabilityKeys: ["manage-issues"], actorKey: "developer", operatorActorKey: "developer", intent: "Create a project issue", outcome: "The work is represented for later tracking", acceptance: ["The developer can observe the newly created issue"] },
  ],
});

const structuralQuestions = () => ({
  contract: "rb-user-stories-questions/v1",
  stage: "user-stories",
  participationRecommendations: [],
  questions: [{
    key: "issue-story-boundary",
    question: "Should creating and updating issues remain independently valuable stories?",
    materiality: "product",
    rigidity: "RIGID",
    recommendedAnswer: {
      value: "Keep create and update as separate stories",
      rationale: "Each action provides an independently observable actor outcome.",
    },
    alternatives: ["Use one combined issue-management story"],
  }],
});

const combinedCandidate = () => ({
  ...candidate(),
  stories: [
    { key: "manage-issue", workflowKey: "issue-lifecycle", capabilityKeys: ["manage-issues"], actorKey: "developer", operatorActorKey: "developer", intent: "Create or update a project issue", outcome: "Project work remains current and trackable", acceptance: ["The developer can observe the created or updated issue"] },
    { key: "review-issue", workflowKey: "issue-review", capabilityKeys: ["review-issues"], actorKey: "reviewer", operatorActorKey: "reviewer", intent: "Review an issue awaiting approval", outcome: "The issue has an explicit review outcome", acceptance: ["The reviewer can record and observe the review outcome"] },
  ],
});

const manualAuthorityProject = () => ({
  contract: "rb-project-description/v1",
  stage: "project-description",
  originalRequest: REQUEST,
  project: { key: "repair-system", name: "Repair System", objective: "Track repair orders and mediated customer budget decisions." },
  actors: [
    { key: "atendente", name: "Atendente", responsibility: "Operates the customer-facing system workflows." },
    { key: "cliente", name: "Cliente", responsibility: "Makes the business budget decision." },
    { key: "tecnico", name: "Técnico", responsibility: "Diagnoses and repairs equipment." },
  ],
  capabilities: [
    { key: "acompanhamento-status", statement: "Acompanhar o status do reparo." },
    { key: "decisao-orcamento", statement: "Registrar aprovação ou rejeição do orçamento." },
  ],
  workflows: [{
    key: "aprovacao-orcamento",
    statement: "Consultar o status e registrar a decisão do orçamento.",
    actorKeys: ["atendente", "cliente"],
    capabilityKeys: ["acompanhamento-status", "decisao-orcamento"],
  }],
  constraints: [],
  determinations: [],
  qualityCommands: [],
  questions: [],
});

const capabilityParticipationQuestions = () => ({
  contract: "rb-user-stories-questions/v1",
  stage: "user-stories",
  participationRecommendations: requiredUserStoriesParticipationSubjects(
    userStoriesUpstreamProjection(manualAuthorityProject() as unknown as ProjectDescription),
  ).map((subject) => ({
    subjectKey: subject.key,
    question: subject.capabilityKey === "acompanhamento-status"
      ? "Quem é o ator de negócio e quem opera a consulta de status?"
      : "Quem decide o orçamento e quem registra a decisão no sistema?",
    recommendedOptionKey: subject.capabilityKey === "acompanhamento-status"
      ? subject.stepOneOptions.find((option) => option.kind === "pair" && option.actorKey === "atendente")!.key
      : subject.stepOneOptions.find((option) => option.kind === "escape")!.key,
    rationale: subject.capabilityKey === "acompanhamento-status"
      ? "O atendente é o participante direto mais provável para a consulta do status."
      : "Uma combinação mediada deve ser escolhida localmente entre os pares do Core.",
  })),
  questions: [],
});

function manualStructuralResponses(): string[] {
  const subjects = requiredUserStoriesParticipationSubjects(
    userStoriesUpstreamProjection(manualAuthorityProject() as unknown as ProjectDescription),
  );
  const status = subjects.find((subject) => subject.capabilityKey === "acompanhamento-status")!;
  const decision = subjects.find((subject) => subject.capabilityKey === "decisao-orcamento")!;
  return [
    status.stepOneOptions.find((option) => option.kind === "pair" && option.actorKey === "atendente")!.key,
    decision.stepOneOptions.find((option) => option.kind === "escape")!.key,
    decision.pairOptions.find((option) => option.actorKey === "cliente" && option.operatorActorKey === "atendente")!.key,
  ];
}

function manualInterview() {
  const responses = manualStructuralResponses();
  return { kind: "interactive" as const, answer: async () => responses.shift()! };
}

const manualAuthorityCandidate = () => ({
  contract: "rb-user-stories/v1",
  stage: "user-stories",
  projectKey: "repair-system",
  stories: [
    {
      key: "consultar-status", workflowKey: "aprovacao-orcamento", capabilityKeys: ["acompanhamento-status"],
      actorKey: "atendente", operatorActorKey: "atendente", intent: "consultar o status atual da ordem",
      outcome: "a situação do reparo fica visível", acceptance: ["A consulta retorna o status atual"],
    },
    {
      key: "registrar-decisao", workflowKey: "aprovacao-orcamento", capabilityKeys: ["decisao-orcamento"],
      actorKey: "cliente", operatorActorKey: "atendente", intent: "ter a decisão do orçamento registrada",
      outcome: "a ordem segue pelo caminho aprovado ou rejeitado", acceptance: ["A decisão fica registrada na ordem"],
    },
  ],
});

const profile: ModelProfile = {
  id: "fixture:progressive-phase2",
  family: "fixture",
  transport: "claude-code-cli",
  requestAccounting: "opaque",
  modelId: "fixture",
  label: "Fixture",
  runtime: { kind: "external-executable", versionPolicy: "exact-recorded" },
  structuredOutput: "claude-code-json-schema",
  strictSchema: true,
  toolCalling: false,
  toolChoiceForcing: false,
  reasoning: { supported: false },
  maxOutputTokens: 128_000,
  systemRole: "system",
  streaming: { supported: true, usageInStream: false },
  usageReporting: { inputTokens: false, cachedInputTokens: false, cacheWriteTokens: false, outputTokens: false, reasoningTokens: false, costUsd: false },
  conformance: { tier: "SUPPORTED", suiteVersion: "fixture/v1", runId: "fixture", recordedAt: "2026-08-30T00:00:00.000Z", normalizationsOnHappyPath: [], verifiedRecord: true },
};

const auth: ResolvedProviderAuth = { kind: "ambient-session", id: "fixture" };

class Adapter implements ProviderAdapter {
  readonly family = "fixture";
  readonly transport = "claude-code-cli" as const;
  readonly profiles = [profile];
  readonly requests: SemanticRequest[] = [];
  constructor(private readonly script: unknown[]) {}
  checkCapabilities(): ProviderOutcome<true> { return { ok: true, value: true }; }
  async request(_profile: ModelProfile, _auth: ResolvedProviderAuth, request: SemanticRequest): Promise<ProviderOutcome<CanonicalSemanticResponse>> {
    this.requests.push(request);
    const body = this.script.shift();
    if (!body) throw new Error("script exhausted");
    return {
      ok: true,
      value: {
        slice: request.slice,
        payload: structuredClone(body),
        normalizations: [],
        usage: {
          inputTokens: { measured: false, reason: "unsupported-by-provider" },
          cachedInputTokens: { measured: false, reason: "unsupported-by-provider" },
          cacheWriteTokens: { measured: false, reason: "unsupported-by-provider" },
          outputTokens: { measured: false, reason: "unsupported-by-provider" },
          reasoningTokens: { measured: false, reason: "unsupported-by-provider" },
          providerRequests: { measured: false, reason: "unsupported-by-provider" },
          costUsd: { measured: false, reason: "unsupported-by-provider" },
        },
        transport: {
          startedAt: "2026-08-30T00:00:00.000Z",
          completedAt: "2026-08-30T00:00:00.001Z",
          firstOutputMs: { measured: false, reason: "unsupported-by-provider" },
          httpStatus: { measured: false, reason: "unsupported-by-provider" },
          requestId: { measured: false, reason: "unsupported-by-provider" },
          stopReason: { measured: false, reason: "unsupported-by-provider" },
        },
      },
    };
  }
  replay(): ProviderOutcome<CanonicalSemanticResponse> { throw new Error("unused"); }
}

const root = () => mkdtemp(resolve(tmpdir(), "rb-progressive-phase2-"));
const common = (projectRoot: string, adapter: Adapter) => ({
  projectRoot,
  originalRequest: REQUEST,
  profile,
  adapter,
  auth,
  interview: { kind: "headless" as const },
});

async function seedProject(projectRoot: string, payload: ReturnType<typeof projectPayload> = projectPayload()): Promise<void> {
  await runProgressiveInit({ ...common(projectRoot, new Adapter([payload])), selectedStage: "project-description" });
}

async function projectionFor(projectRoot: string): Promise<UserStoriesUpstreamProjection> {
  const source = await readFile(resolve(projectRoot, ".spec", "init", "project-description.md"), "utf8");
  return userStoriesUpstreamProjection(parseProjectDescriptionDocument(source).value);
}

async function seedStories(projectRoot: string, value = candidate()): Promise<ReturnType<typeof runProgressiveInit>> {
  return runProgressiveInit({ ...common(projectRoot, new Adapter([emptyQuestions(), value])), selectedStage: "user-stories" });
}

async function markUserStoriesStale(projectRoot: string): Promise<void> {
  const path = resolve(projectRoot, ".spec", "init", "user-stories.md");
  const source = await readFile(path, "utf8");
  await writeFile(path, source.replace(
    /rb-user-stories-authoritative-input-sha256: [a-f0-9]{64}/,
    `rb-user-stories-authoritative-input-sha256: ${"0".repeat(64)}`,
  ));
  expect((await inspectProgressiveInit(projectRoot, REQUEST))[1]?.status).toBe("complete-stale");
}

describe("Progressive Init Phase 2 user-stories", () => {
  it("enumerates every workflow/capability subject independently with Core-owned Step-1 and global pair options", () => {
    const project = manualAuthorityProject();
    project.workflows = [
      {
        key: "fluxo-conclusao", statement: "Concluir o reparo.", actorKeys: ["atendente", "tecnico"],
        capabilityKeys: ["acompanhamento-status"],
      },
      {
        key: "fluxo-orcamento", statement: "Decidir o orçamento.", actorKeys: ["cliente", "tecnico"],
        capabilityKeys: ["acompanhamento-status", "decisao-orcamento"],
      },
    ];
    const upstream = userStoriesUpstreamProjection(project as unknown as ProjectDescription);
    const subjects = enumerateUserStoriesParticipationSubjects(upstream);
    expect(subjects.map(({ workflowKey, capabilityKey }) => [workflowKey, capabilityKey])).toEqual([
      ["fluxo-conclusao", "acompanhamento-status"],
      ["fluxo-orcamento", "acompanhamento-status"],
      ["fluxo-orcamento", "decisao-orcamento"],
    ]);
    expect(new Set(subjects.map((subject) => subject.key)).size).toBe(3);
    for (const subject of subjects) {
      const workflow = upstream.workflows.find((entry) => entry.key === subject.workflowKey)!;
      expect(subject.stepOneOptions.slice(0, -1).map((option) => option.kind === "pair"
        ? [option.actorKey, option.operatorActorKey] : [])).toEqual(
        [...workflow.actorKeys].sort().map((actorKey) => [actorKey, actorKey]),
      );
      expect(subject.stepOneOptions.at(-1)).toMatchObject({ kind: "escape", key: "another-participant-combination" });
      expect(subject.pairOptions).toHaveLength(9);
      expect(new Set(subject.pairOptions.map((option) => option.key)).size).toBe(9);
      expect(new Set(subject.pairOptions.map((option) => `${option.actorKey}/${option.operatorActorKey}`)).size).toBe(9);
      expect(subject.pairOptions.map((option) => `${option.actorKey}/${option.operatorActorKey}`)).toEqual(expect.arrayContaining([
        "atendente/atendente", "atendente/cliente", "atendente/tecnico",
        "cliente/atendente", "cliente/cliente", "cliente/tecnico",
        "tecnico/atendente", "tecnico/cliente", "tecnico/tecnico",
      ]));
    }
  });

  it("treats single-actor subjects as equality invariants without questions or synthetic developer authority", async () => {
    const upstream = userStoriesUpstreamProjection(projectPayload() as unknown as ProjectDescription);
    expect(enumerateUserStoriesParticipationSubjects(upstream)).toHaveLength(2);
    expect(requiredUserStoriesParticipationSubjects(upstream)).toEqual([]);
    const adapter = new Adapter([emptyQuestions(), candidate()]);
    const result = await runUserStoriesOperation({
      upstream, profile, adapter, auth, interview: { kind: "headless" }, deadlineMs: 10_000,
    });
    expect(result.value.structuralDecisions).toEqual([]);
    expect(result.value.determinations).toEqual([]);
    expect(JSON.parse(adapter.requests[0]!.input).requiredParticipationSubjects).toEqual([]);
    expect(result.semanticOperations).toBe(2);
  });

  it("cannot represent the manual prose-only downgrade for required structural subjects", () => {
    const upstream = userStoriesUpstreamProjection(manualAuthorityProject() as unknown as ProjectDescription);
    const subjects = requiredUserStoriesParticipationSubjects(upstream);
    const proseOnly = {
      contract: "rb-user-stories-questions/v1",
      stage: "user-stories",
      participationRecommendations: [],
      questions: [{
        key: "quem-acompanha-status",
        question: "Quem acompanha o status e opera o sistema?",
        materiality: "product",
        rigidity: "RIGID",
        recommendedAnswer: { value: "O atendente acompanha o status", rationale: "Esta resposta parece resolver a ambiguidade estrutural." },
        alternatives: ["O cliente acompanha o status"],
      }],
    };
    const decoded = decodeUserStoriesQuestionSelection(proseOnly, subjects);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.findings.filter((entry) => entry.message.includes("missing recommendation"))).toHaveLength(subjects.length);
    }
  });

  it("subtracts persisted participation by exact workflow+capability and asks only an additive subject", async () => {
    const project = projectPayload();
    project.workflows = [{
      key: "issue-lifecycle", statement: "Developers and reviewers manage issues.",
      actorKeys: ["developer", "reviewer"], capabilityKeys: ["manage-issues"],
    }];
    project.capabilities = [{ key: "manage-issues", statement: "Create and update project issues." }];
    const initialUpstream = userStoriesUpstreamProjection(project as unknown as ProjectDescription);
    const initialSubject = requiredUserStoriesParticipationSubjects(initialUpstream)[0]!;
    const initialQuestions = {
      contract: "rb-user-stories-questions/v1", stage: "user-stories", questions: [],
      participationRecommendations: [{
        subjectKey: initialSubject.key,
        recommendedOptionKey: initialSubject.stepOneOptions.find((option) => option.kind === "pair" && option.actorKey === "developer")!.key,
        question: "Who owns and directly operates issue management?",
        rationale: "The developer is the direct participant in issue management.",
      }],
    };
    const initialCandidate = {
      contract: "rb-user-stories/v1", stage: "user-stories", projectKey: "issue-tracker", stories: [{
        key: "manage-issue", workflowKey: "issue-lifecycle", capabilityKeys: ["manage-issues"],
        actorKey: "developer", operatorActorKey: "developer", intent: "Manage an issue",
        outcome: "The issue reflects current work", acceptance: ["The developer observes the current issue"],
      }],
    };
    const initial = await runUserStoriesOperation({
      upstream: initialUpstream, profile, adapter: new Adapter([initialQuestions, initialCandidate]), auth,
      interview: { kind: "headless" }, deadlineMs: 10_000,
    });
    const existing = userStoriesForPersistence(initial.value);

    project.capabilities.push({ key: "triage-issues", statement: "Triage project issues." });
    project.workflows[0]!.capabilityKeys.push("triage-issues");
    const expandedUpstream = userStoriesUpstreamProjection(project as unknown as ProjectDescription);
    const unresolved = requiredUserStoriesParticipationSubjects(expandedUpstream, existing);
    expect(unresolved.map((subject) => subject.capabilityKey)).toEqual(["triage-issues"]);
    const newSubject = unresolved[0]!;
    const questions = {
      contract: "rb-user-stories-questions/v1", stage: "user-stories", questions: [],
      participationRecommendations: [{
        subjectKey: newSubject.key,
        recommendedOptionKey: newSubject.stepOneOptions.find((option) => option.kind === "pair" && option.actorKey === "reviewer")!.key,
        question: "Who owns and directly operates issue triage?",
        rationale: "The reviewer is the direct participant in issue triage.",
      }],
    };
    const expandedCandidate = structuredClone(initialCandidate);
    expandedCandidate.stories.push({
      key: "triage-issue", workflowKey: "issue-lifecycle", capabilityKeys: ["triage-issues"],
      actorKey: "reviewer", operatorActorKey: "reviewer", intent: "Triage an issue",
      outcome: "The issue has a triage outcome", acceptance: ["The reviewer observes the triage outcome"],
    });
    const adapter = new Adapter([questions, expandedCandidate]);
    const expanded = await runUserStoriesOperation({
      upstream: expandedUpstream, existing, profile, adapter, auth,
      interview: { kind: "headless" }, deadlineMs: 10_000,
    });
    expect(expanded.semanticOperations).toBe(2);
    expect(JSON.parse(adapter.requests[0]!.input).requiredParticipationSubjects.map((subject: any) => subject.capabilityKey)).toEqual(["triage-issues"]);
    expect(expanded.value.structuralDecisions.map((decision) => decision.capabilityKey).sort()).toEqual(["manage-issues", "triage-issues"]);
    expect(expanded.value.stories.find((story) => story.key === "manage-issue")?.storyId).toBe(existing.stories[0]!.storyId);
  });

  it("does not let the same capability decision authorize another workflow", () => {
    const project = manualAuthorityProject();
    project.workflows = [
      { key: "fluxo-conclusao", statement: "Concluir.", actorKeys: ["atendente", "tecnico"], capabilityKeys: ["acompanhamento-status"] },
      { key: "fluxo-orcamento", statement: "Orçar.", actorKeys: ["cliente", "tecnico"], capabilityKeys: ["acompanhamento-status", "decisao-orcamento"] },
    ];
    const upstream = userStoriesUpstreamProjection(project as unknown as ProjectDescription);
    const all = requiredUserStoriesParticipationSubjects(upstream);
    const settled = all.find((subject) => subject.workflowKey === "fluxo-conclusao")!;
    const pair = settled.pairOptions.find((option) => option.actorKey === "atendente" && option.operatorActorKey === "atendente")!;
    const existing = {
      contract: "rb-user-stories/v1" as const, stage: "user-stories" as const, projectKey: upstream.project.key,
      determinations: [{ key: settled.key, statement: pair.label, rationale: "Decisão persistida pelo desenvolvedor.", materiality: "product" as const, rigidity: "RIGID" as const, source: { kind: "developer" as const } }],
      structuralDecisions: [{ kind: "capability-participation" as const, key: settled.key, workflowKey: settled.workflowKey, capabilityKey: settled.capabilityKey, actorKey: pair.actorKey, operatorActorKey: pair.operatorActorKey, source: { kind: "developer" as const } }],
      stories: [],
    };
    expect(requiredUserStoriesParticipationSubjects(upstream, existing).map(({ workflowKey, capabilityKey }) => [workflowKey, capabilityKey])).toEqual([
      ["fluxo-orcamento", "acompanhamento-status"],
      ["fluxo-orcamento", "decisao-orcamento"],
    ]);
  });

  it("replays the live multi-workflow participation outcomes at the upstream-refinement boundary", () => {
    const project = manualAuthorityProject();
    project.workflows = [
      { key: "fluxo-conclusao", statement: "Concluir.", actorKeys: ["atendente", "tecnico"], capabilityKeys: ["acompanhamento-status"] },
      { key: "fluxo-orcamento", statement: "Orçar.", actorKeys: ["cliente", "tecnico"], capabilityKeys: ["acompanhamento-status", "decisao-orcamento"] },
    ];
    const upstream = userStoriesUpstreamProjection(project as unknown as ProjectDescription);
    const subjects = enumerateUserStoriesParticipationSubjects(upstream);
    const decision = (
      workflowKey: string,
      capabilityKey: string,
      actorKey: string,
      operatorActorKey: string,
    ) => {
      const subject = subjects.find((entry) => entry.workflowKey === workflowKey && entry.capabilityKey === capabilityKey)!;
      return {
        kind: "capability-participation" as const,
        key: subject.key,
        workflowKey: subject.workflowKey,
        capabilityKey: subject.capabilityKey,
        actorKey: actorKey as any,
        operatorActorKey: operatorActorKey as any,
        source: { kind: "developer" as const },
      };
    };
    expect(validateUserStoriesUpstreamRefinement([
      decision("fluxo-conclusao", "acompanhamento-status", "atendente", "atendente"),
    ], upstream)).toEqual([]);
    expect(validateUserStoriesUpstreamRefinement([
      decision("fluxo-orcamento", "acompanhamento-status", "atendente", "atendente"),
    ], upstream).map((finding) => finding.pointer)).toEqual([
      "/structuralDecisions/0/actorKey", "/structuralDecisions/0/operatorActorKey",
    ]);
    expect(validateUserStoriesUpstreamRefinement([
      decision("fluxo-orcamento", "decisao-orcamento", "cliente", "atendente"),
    ], upstream).map((finding) => finding.pointer)).toEqual([
      "/structuralDecisions/0/operatorActorKey",
    ]);
  });

  it("structurally realizes the manual Actor/Operator dogfood decisions and rejects unauthorized mediation", async () => {
    const upstream = userStoriesUpstreamProjection(manualAuthorityProject() as unknown as ProjectDescription);
    const result = await runUserStoriesOperation({
      upstream,
      profile,
      adapter: new Adapter([capabilityParticipationQuestions(), manualAuthorityCandidate()]),
      auth,
      interview: manualInterview(),
      deadlineMs: 10_000,
    });
    expect(result).toMatchObject({ semanticOperations: 2, correctiveRegenerations: 0 });
    expect(result.value.structuralDecisions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        workflowKey: "aprovacao-orcamento", capabilityKey: "decisao-orcamento",
        actorKey: "cliente", operatorActorKey: "atendente",
      }),
      expect.objectContaining({
        workflowKey: "aprovacao-orcamento", capabilityKey: "acompanhamento-status",
        actorKey: "atendente", operatorActorKey: "atendente",
      }),
    ]));
    expect(result.value.structuralDecisions.every((decision) =>
      result.value.determinations.filter((entry) => entry.key === decision.key).length === 1)).toBe(true);
    const persisted = userStoriesForPersistence(result.value);
    expect(validateUserStories(persisted, upstream).ok).toBe(true);

    const wrongStatusActor: UserStories = {
      ...persisted,
      stories: persisted.stories.map((story) => story.key === "consultar-status"
        ? { ...story, actorKey: "cliente" as any, operatorActorKey: "atendente" as any }
        : story),
    };
    const wrongStatus = validateUserStories(wrongStatusActor, upstream);
    expect(wrongStatus.ok).toBe(false);
    if (!wrongStatus.ok) expect(wrongStatus.findings.map((entry) => entry.message).join("; ")).toMatch(/requires Actor 'atendente' and Operator 'atendente'/);

    const withoutMediationAuthority: UserStories = {
      ...persisted,
      structuralDecisions: persisted.structuralDecisions.filter((entry) => entry.capabilityKey !== "decisao-orcamento"),
    };
    const unauthorized = validateUserStories(withoutMediationAuthority, upstream);
    expect(unauthorized.ok).toBe(false);
    if (!unauthorized.ok) expect(unauthorized.findings.map((entry) => entry.message).join("; ")).toMatch(/Actor and Operator must be equal/);

    const withoutMatchingDetermination: UserStories = {
      ...persisted,
      determinations: persisted.determinations.filter((entry) => entry.key !== persisted.structuralDecisions.find((decision) => decision.capabilityKey === "decisao-orcamento")!.key),
    };
    const unlinked = validateUserStories(withoutMatchingDetermination, upstream);
    expect(unlinked.ok).toBe(false);
    if (!unlinked.ok) expect(unlinked.findings.map((entry) => entry.message).join("; ")).toMatch(/requires one matching determination key/);
  });

  it("requires explicit exact capability coverage instead of inheriting every workflow capability", () => {
    const project = manualAuthorityProject();
    const upstream = userStoriesUpstreamProjection(project as unknown as ProjectDescription);
    const onlyStatus = manualAuthorityCandidate();
    onlyStatus.stories = onlyStatus.stories.filter((story) => story.key === "consultar-status") as typeof onlyStatus.stories;
    const decoded = decodeUserStoriesWire(onlyStatus);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const resolved = resolveUserStoriesWire(decoded.value, upstream, []);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.findings).toContainEqual(expect.objectContaining({
      pointer: "/upstream/capabilities/1",
      message: expect.stringContaining("decisao-orcamento"),
    }));

    const issueUpstream = userStoriesUpstreamProjection(projectPayload() as unknown as ProjectDescription);
    const invalidCases = [
      (() => { const value = candidate(); value.stories[0]!.capabilityKeys = []; return value; })(),
      (() => { const value = candidate(); value.stories[0]!.capabilityKeys = ["manage-issues", "manage-issues"]; return value; })(),
      (() => { const value = candidate(); value.stories[0]!.capabilityKeys = ["review-issues"]; return value; })(),
    ];
    for (const invalid of invalidCases) {
      const invalidDecoded = decodeUserStoriesWire(invalid);
      expect(invalidDecoded.ok).toBe(true);
      if (invalidDecoded.ok) expect(resolveUserStoriesWire(invalidDecoded.value, issueUpstream, []).ok).toBe(false);
    }
    const complete = decodeUserStoriesWire(candidate());
    expect(complete.ok).toBe(true);
    if (complete.ok) expect(resolveUserStoriesWire(complete.value, issueUpstream, []).ok).toBe(true);
  });

  it("requires exact Core subjects and rejects provider-authored structural identity or options", () => {
    const upstream = userStoriesUpstreamProjection(manualAuthorityProject() as unknown as ProjectDescription);
    const subjects = requiredUserStoriesParticipationSubjects(upstream);
    expect(decodeUserStoriesQuestionSelection(capabilityParticipationQuestions(), subjects).ok).toBe(true);
    const cases: Array<[string, (payload: any) => void, RegExp]> = [
      ["omitted", (payload) => { payload.participationRecommendations.pop(); }, /missing recommendation/],
      ["extra", (payload) => { payload.participationRecommendations.push({ ...payload.participationRecommendations[0], subjectKey: "non-core-subject" }); }, /non-Core participation subject/],
      ["actor", (payload) => { payload.participationRecommendations[0].actorKey = "invented-actor"; }, /unknown field/],
      ["operator", (payload) => { payload.participationRecommendations[0].operatorActorKey = "invented-operator"; }, /unknown field/],
      ["options", (payload) => { payload.participationRecommendations[0].options = []; }, /unknown field/],
      ["recommendation", (payload) => { payload.participationRecommendations[0].recommendedOptionKey = "invented-option"; }, /not a Core-owned Step-1 option/],
    ];
    for (const [, mutate, expected] of cases) {
      const payload = capabilityParticipationQuestions() as any;
      mutate(payload);
      const outcome = decodeUserStoriesQuestionSelection(payload, subjects);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.findings.map((entry) => entry.message).join("; ")).toMatch(expected);
    }
  });

  it("resolves structural answers only by typed option ordinal/key and blank recommendation", async () => {
    const upstream = userStoriesUpstreamProjection(manualAuthorityProject() as unknown as ProjectDescription);
    const subjects = requiredUserStoriesParticipationSubjects(upstream);
    const status = subjects.find((subject) => subject.capabilityKey === "acompanhamento-status")!;
    const decision = subjects.find((subject) => subject.capabilityKey === "decisao-orcamento")!;
    const responses = [
      status.stepOneOptions.find((option) => option.kind === "pair" && option.actorKey === "cliente")!.key,
      decision.stepOneOptions.find((option) => option.kind === "escape")!.key,
      decision.pairOptions.find((option) => option.actorKey === "cliente" && option.operatorActorKey === "atendente")!.key,
    ];
    const explicit = await runUserStoriesOperation({
      upstream, profile, adapter: new Adapter([capabilityParticipationQuestions(), {
        ...manualAuthorityCandidate(),
        stories: manualAuthorityCandidate().stories.map((story) => story.key === "consultar-status"
          ? { ...story, actorKey: "cliente", operatorActorKey: "cliente" }
          : story),
      }]), auth,
      interview: { kind: "interactive", answer: async () => responses.shift()! }, deadlineMs: 10_000,
    });
    expect(explicit.value.structuralDecisions.find((entry) => entry.capabilityKey === "acompanhamento-status"))
      .toMatchObject({ actorKey: "cliente", operatorActorKey: "cliente", source: { kind: "user-answer" } });

    const blankQuestions = capabilityParticipationQuestions();
    const decisionRecommendation = blankQuestions.participationRecommendations.find((entry) =>
      subjects.find((subject) => subject.key === entry.subjectKey)?.capabilityKey === "decisao-orcamento")!;
    decisionRecommendation.recommendedOptionKey = decision.stepOneOptions.find((option) =>
      option.kind === "pair" && option.actorKey === "cliente")!.key;
    const blankResponses = ["", ""];
    const blankPrompts: InterviewQuestionEvidence[] = [];
    const blankCandidate = manualAuthorityCandidate();
    blankCandidate.stories[1]!.operatorActorKey = "cliente";
    const blank = await runUserStoriesOperation({
      upstream, profile, adapter: new Adapter([blankQuestions, blankCandidate]), auth,
      interview: { kind: "interactive", answer: async (question) => { blankPrompts.push(question); return blankResponses.shift()!; } }, deadlineMs: 10_000,
    });
    expect(blank.value.structuralDecisions.every((entry) => entry.source.kind === "accepted-recommendation")).toBe(true);
    expect(blankPrompts.map((question) => question.answerPrompt)).toEqual([
      "Choice (blank accepts recommendation): ",
      "Choice (blank accepts recommendation): ",
    ]);

    await expect(runUserStoriesOperation({
      upstream, profile, adapter: new Adapter([capabilityParticipationQuestions()]), auth,
      interview: { kind: "interactive", answer: async () => "Cliente talvez opere" }, deadlineMs: 10_000,
    })).rejects.toThrow(/USER_STORIES_STRUCTURAL_SELECTION_INVALID/);
  });

  it.each([
    ["invalid ordinal", "99"],
    ["invalid key", "not-a-core-option"],
  ])("re-prompts Step 1 locally after one %s and succeeds without semantic recovery", async (_case, invalid) => {
    const upstream = userStoriesUpstreamProjection(manualAuthorityProject() as unknown as ProjectDescription);
    const subjects = requiredUserStoriesParticipationSubjects(upstream);
    const status = subjects.find((subject) => subject.capabilityKey === "acompanhamento-status")!;
    const decision = subjects.find((subject) => subject.capabilityKey === "decisao-orcamento")!;
    const responses = [
      invalid,
      status.stepOneOptions.find((option) => option.kind === "pair" && option.actorKey === "atendente")!.key,
      decision.stepOneOptions.find((option) => option.kind === "escape")!.key,
      decision.pairOptions.find((option) => option.actorKey === "cliente" && option.operatorActorKey === "atendente")!.key,
    ];
    const prompts: InterviewQuestionEvidence[] = [];
    const adapter = new Adapter([capabilityParticipationQuestions(), manualAuthorityCandidate()]);
    const result = await runUserStoriesOperation({
      upstream, profile, adapter, auth,
      interview: { kind: "interactive", answer: async (question) => { prompts.push(question); return responses.shift()!; } },
      deadlineMs: 10_000,
    });
    expect(prompts[1]!.question).toMatch(/^Invalid structural selection\. Enter a listed Step-1 number or exact Core option key\./);
    expect(result).toMatchObject({ semanticOperations: 2, correctiveRegenerations: 0 });
    expect(adapter.requests.map((request) => request.slice)).toEqual(["user-stories-questions", "user-stories"]);
  });

  it.each([
    ["blank", ""],
    ["invalid ordinal", "99"],
    ["invalid key", "not-a-core-pair"],
  ])("re-prompts Step 2 locally after one %s and renders truthful choice guidance", async (_case, invalid) => {
    const upstream = userStoriesUpstreamProjection(manualAuthorityProject() as unknown as ProjectDescription);
    const subjects = requiredUserStoriesParticipationSubjects(upstream);
    const status = subjects.find((subject) => subject.capabilityKey === "acompanhamento-status")!;
    const decision = subjects.find((subject) => subject.capabilityKey === "decisao-orcamento")!;
    const responses = [
      status.stepOneOptions.find((option) => option.kind === "pair" && option.actorKey === "atendente")!.key,
      decision.stepOneOptions.find((option) => option.kind === "escape")!.key,
      invalid,
      decision.pairOptions.find((option) => option.actorKey === "cliente" && option.operatorActorKey === "atendente")!.key,
    ];
    const prompts: InterviewQuestionEvidence[] = [];
    const adapter = new Adapter([capabilityParticipationQuestions(), manualAuthorityCandidate()]);
    const result = await runUserStoriesOperation({
      upstream, profile, adapter, auth,
      interview: { kind: "interactive", answer: async (question) => { prompts.push(question); return responses.shift()!; } },
      deadlineMs: 10_000,
    });
    expect(formatInteractiveQuestion(prompts[1]!)).toContain("Choice (blank accepts recommendation): ");
    expect(formatInteractiveQuestion(prompts[2]!)).toContain("Choice (blank is not accepted): ");
    expect(formatInteractiveQuestion(prompts[2]!)).not.toContain("Answer (blank accepts the recommendation)");
    expect(prompts[3]!.question).toMatch(/^Invalid structural selection\. Step 2 requires a listed number or exact Core pair option key; blank is not accepted\./);
    expect(result).toMatchObject({ semanticOperations: 2, correctiveRegenerations: 0 });
    expect(adapter.requests.map((request) => request.slice)).toEqual(["user-stories-questions", "user-stories"]);
  });

  it.each(["step-one", "step-two"])("fails deterministically after the third invalid %s attempt", async (step) => {
    const upstream = userStoriesUpstreamProjection(manualAuthorityProject() as unknown as ProjectDescription);
    const subjects = requiredUserStoriesParticipationSubjects(upstream);
    const status = subjects.find((subject) => subject.capabilityKey === "acompanhamento-status")!;
    const decision = subjects.find((subject) => subject.capabilityKey === "decisao-orcamento")!;
    const responses = step === "step-one"
      ? ["invalid", "invalid", "invalid"]
      : [
          status.stepOneOptions.find((option) => option.kind === "pair" && option.actorKey === "atendente")!.key,
          decision.stepOneOptions.find((option) => option.kind === "escape")!.key,
          "", "99", "not-a-core-pair",
        ];
    const prompts: InterviewQuestionEvidence[] = [];
    const adapter = new Adapter([capabilityParticipationQuestions()]);
    await expect(runUserStoriesOperation({
      upstream, profile, adapter, auth,
      interview: { kind: "interactive", answer: async (question) => { prompts.push(question); return responses.shift()!; } },
      deadlineMs: 10_000,
    })).rejects.toThrow(/USER_STORIES_STRUCTURAL_SELECTION_INVALID/);
    expect(adapter.requests.map((request) => request.slice)).toEqual(["user-stories-questions"]);
    expect(prompts).toHaveLength(step === "step-one" ? 3 : 5);
  });

  it("keeps headless escape selection fail-closed without a local retry or inferred pair", async () => {
    const upstream = userStoriesUpstreamProjection(manualAuthorityProject() as unknown as ProjectDescription);
    const adapter = new Adapter([capabilityParticipationQuestions()]);
    await expect(runUserStoriesOperation({
      upstream, profile, adapter, auth, interview: { kind: "headless" }, deadlineMs: 10_000,
    })).rejects.toThrow(/USER_STORIES_STRUCTURAL_ESCAPE_SELECTION_REQUIRED/);
    expect(adapter.requests.map((request) => request.slice)).toEqual(["user-stories-questions"]);
  });

  it("keeps generic prose prompts and blank recommendation acceptance unchanged", () => {
    const proposed: ProposedQuestion = {
      ...(structuralQuestions().questions[0] as ProposedQuestion),
      alternatives: ["One story per outcome", "One story per workflow", "One story per capability"],
    };
    const pending = pendingQuestionEvidence(proposed);
    const rendered = formatInteractiveQuestion(pending);
    expect(rendered).toContain([
      "Recommended:",
      `  ${proposed.recommendedAnswer.value}`,
      "",
      "Why:",
      `  ${proposed.recommendedAnswer.rationale}`,
      "",
      "Alternatives:",
      "  1. One story per outcome",
      "  2. One story per workflow",
      "  3. One story per capability",
    ].join("\n"));
    expect(rendered).not.toContain("Alternatives: One story per outcome | One story per workflow");
    expect(rendered).toContain("Answer (blank accepts the recommendation): ");
    const selected = selectInterviewAnswer(pending, { kind: "interactive", response: "" });
    expect(selected).toMatchObject({
      selectedValue: proposed.recommendedAnswer.value,
      acceptanceMode: "blank-interactive",
    });
  });

  it("renders Step-1 and Step-2 structural choices vertically while numeric selection remains semantic-neutral", async () => {
    const upstream = userStoriesUpstreamProjection(manualAuthorityProject() as unknown as ProjectDescription);
    const subjects = requiredUserStoriesParticipationSubjects(upstream);
    const decision = subjects.find((subject) => subject.capabilityKey === "decisao-orcamento")!;
    const mediatedPairIndex = decision.pairOptions.findIndex((option) =>
      option.actorKey === "cliente" && option.operatorActorKey === "atendente") + 1;
    const responses = ["1", String(decision.stepOneOptions.length), String(mediatedPairIndex)];
    const prompts: InterviewQuestionEvidence[] = [];
    const adapter = new Adapter([capabilityParticipationQuestions(), manualAuthorityCandidate()]);
    const result = await runUserStoriesOperation({
      upstream, profile, adapter, auth,
      interview: { kind: "interactive", answer: async (question) => { prompts.push(question); return responses.shift()!; } },
      deadlineMs: 10_000,
    });
    const stepOne = formatInteractiveQuestion(prompts[0]!);
    const decisionStepOne = formatInteractiveQuestion(prompts[1]!);
    const stepTwo = formatInteractiveQuestion(prompts[2]!);
    expect(stepOne).toContain([
      "1. Atendente / Atendente",
      "   Actor: atendente",
      "   Operator: atendente",
    ].join("\n"));
    expect(stepOne.split("\n").filter((line) => /^\d+\. /.test(line)))
      .toHaveLength(prompts[0]!.choices!.length);
    expect(decisionStepOne.split("\n").filter((line) => /^\d+\. /.test(line)))
      .toHaveLength(decision.stepOneOptions.length);
    expect(decisionStepOne).toContain(`${decision.stepOneOptions.length}. Another actor/operator combination`);
    expect(stepTwo).toContain([
      `${mediatedPairIndex}. Cliente / Atendente`,
      "   Actor: cliente",
      "   Operator: atendente",
    ].join("\n"));
    expect(stepTwo.split("\n").filter((line) => /^\d+\. /.test(line)))
      .toHaveLength(decision.pairOptions.length);
    for (const rendered of [stepOne, decisionStepOne, stepTwo]) {
      expect(rendered).not.toContain("Alternatives:");
      expect(rendered).not.toMatch(/pair-[a-f0-9]{43}/);
      expect(rendered).not.toContain(" | ");
    }
    expect(stepOne).toContain("Recommended:\n  Atendente / Atendente");
    expect(stepTwo).not.toContain("Recommended:");
    expect(stepTwo).toContain("Choice (blank is not accepted): ");
    expect(result).toMatchObject({ semanticOperations: 2, correctiveRegenerations: 0 });
    expect(adapter.requests.map((request) => request.slice)).toEqual(["user-stories-questions", "user-stories"]);
  });

  it.each([
    ["Actor", "tecnico", "cliente"],
    ["Operator", "cliente", "tecnico"],
  ] as const)("fails selected globally-known but workflow-ineligible %s before candidate authoring", async (axis, actorKey, operatorActorKey) => {
    const projectRoot = await root();
    await seedProject(projectRoot, manualAuthorityProject() as unknown as ReturnType<typeof projectPayload>);
    const projectPath = resolve(projectRoot, ".spec", "init", "project-description.md");
    const projectBefore = await readFile(projectPath, "utf8");
    const questions = capabilityParticipationQuestions();
    const subjects = requiredUserStoriesParticipationSubjects(userStoriesUpstreamProjection(manualAuthorityProject() as unknown as ProjectDescription));
    const status = subjects.find((subject) => subject.capabilityKey === "acompanhamento-status")!;
    questions.participationRecommendations.find((entry) => entry.subjectKey === status.key)!.recommendedOptionKey =
      status.stepOneOptions.find((option) => option.kind === "escape")!.key;
    const responses = [
      status.stepOneOptions.find((option) => option.kind === "escape")!.key,
      status.pairOptions.find((option) => option.actorKey === actorKey && option.operatorActorKey === operatorActorKey)!.key,
      subjects.find((subject) => subject.capabilityKey === "decisao-orcamento")!.stepOneOptions.find((option) => option.kind === "pair")!.key,
    ];
    const adapter = new Adapter([questions]);
    await expect(runProgressiveInit({
      ...common(projectRoot, adapter),
      interview: { kind: "interactive", answer: async () => responses.shift()! },
      selectedStage: "user-stories",
    }))
      .rejects.toThrow(new RegExp(`USER_STORIES_UPSTREAM_REFINEMENT_REQUIRED.*selected ${axis} 'tecnico'.*upstream actors are \\[atendente, cliente\\]`));
    expect(adapter.requests.map((request) => request.slice)).toEqual(["user-stories-questions"]);
    expect(await readFile(projectPath, "utf8")).toBe(projectBefore);
    await expect(readFile(resolve(projectRoot, ".spec", "init", "user-stories.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps bad candidate participation in whole-candidate recovery rather than upstream refinement", async () => {
    const upstream = userStoriesUpstreamProjection(projectPayload() as unknown as ProjectDescription);
    const bad = candidate();
    bad.stories[0]!.operatorActorKey = "reviewer";
    const adapter = new Adapter([emptyQuestions(), bad, candidate()]);
    const result = await runUserStoriesOperation({ upstream, profile, adapter, auth, interview: { kind: "headless" }, deadlineMs: 10_000 });
    expect(result).toMatchObject({ semanticOperations: 3, correctiveRegenerations: 1 });
    expect(adapter.requests.map((request) => request.slice)).toEqual(["user-stories-questions", "user-stories", "user-stories"]);
  });

  it("rejects incompatible participation requirements in one multi-capability story", async () => {
    const upstream = userStoriesUpstreamProjection(manualAuthorityProject() as unknown as ProjectDescription);
    const valid = await runUserStoriesOperation({
      upstream, profile, adapter: new Adapter([capabilityParticipationQuestions(), manualAuthorityCandidate()]), auth,
      interview: manualInterview(), deadlineMs: 10_000,
    });
    const persisted = userStoriesForPersistence(valid.value);
    const conflicting: UserStories = {
      ...persisted,
      stories: [{
        ...persisted.stories[1]!,
        capabilityKeys: ["acompanhamento-status" as any, "decisao-orcamento" as any],
      }],
    };
    const outcome = validateUserStories(conflicting, upstream);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.findings.map((entry) => entry.message).join("; ")).toMatch(/incompatible participation pairs; split the story/);

    const mediatedOnly: UserStories = {
      ...persisted,
      structuralDecisions: persisted.structuralDecisions.filter((entry) => entry.capabilityKey === "decisao-orcamento"),
      stories: conflicting.stories,
    };
    const mixed = validateUserStories(mediatedOnly, upstream);
    expect(mixed.ok).toBe(false);
    if (!mixed.ok) expect(mixed.findings.map((entry) => entry.message).join("; ")).toMatch(/incompatible participation pairs; split the story/);
  });

  it("projects only story-relevant approved project-description semantics", () => {
    const projection = userStoriesUpstreamProjection(projectPayload() as unknown as ProjectDescription);
    expect(projection.project).toMatchObject({ key: "issue-tracker", name: "Issue Tracker" });
    expect(projection.actors.map((entry) => entry.key)).toEqual(["developer", "reviewer"]);
    expect(projection.capabilities.map((entry) => entry.key)).toEqual(["manage-issues", "review-issues"]);
    expect(projection.determinations.map((entry) => entry.key)).toEqual(["visible-review"]);
    expect(JSON.stringify(projection)).not.toContain(REQUEST);
    expect(JSON.stringify(projection)).not.toContain("npm test");
    expect(JSON.stringify(projection)).not.toContain("model-default");
  });

  it("blocks orphan capabilities before any user-stories provider call", async () => {
    const projectRoot = await root();
    const payload = projectPayload();
    payload.capabilities.push({ key: "orphan-capability", statement: "An approved capability without a workflow." });
    await seedProject(projectRoot, payload);
    const adapter = new Adapter([emptyQuestions(), candidate()]);
    await expect(runProgressiveInit({ ...common(projectRoot, adapter), selectedStage: "user-stories" }))
      .rejects.toThrow(/USER_STORIES_UPSTREAM_NOT_READY.*orphan-capability/);
    expect(adapter.requests).toHaveLength(0);
    await expect(readFile(resolve(projectRoot, ".spec", "init", "user-stories.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts capability-to-workflow closure and rejects missing or semantically stale project-description prerequisites", async () => {
    const missingRoot = await root();
    const missingAdapter = new Adapter([]);
    await expect(runProgressiveInit({ ...common(missingRoot, missingAdapter), selectedStage: "user-stories" })).rejects.toThrow(/PREREQUISITE_INVALID/);
    expect(missingAdapter.requests).toHaveLength(0);

    const projectRoot = await root();
    await seedProject(projectRoot);
    expect(validateUserStoriesUpstreamReadiness(await projectionFor(projectRoot))).toEqual([]);
    const staleAdapter = new Adapter([]);
    await expect(runProgressiveInit({
      ...common(projectRoot, staleAdapter),
      originalRequest: "A materially changed project request",
      selectedStage: "user-stories",
    })).rejects.toThrow(/PREREQUISITE_INVALID/);
    expect(staleAdapter.requests).toHaveLength(0);
  });

  it("makes repeated focused complete-fresh user-stories runs zero-call byte-stable successes", async () => {
    const projectRoot = await root();
    await seedProject(projectRoot);
    const first = await seedStories(projectRoot);
    const projectPath = resolve(projectRoot, ".spec", "init", "project-description.md");
    const storyPath = (await first).artifactPath!;
    const stageRecordPath = resolve(projectRoot, ".rb-harness", "progressive-init", "project-description.json");
    const projectBefore = await readFile(projectPath, "utf8");
    const storiesBefore = await readFile(storyPath, "utf8");
    const recordBefore = await readFile(stageRecordPath, "utf8");

    for (let rerun = 0; rerun < 2; rerun += 1) {
      const adapter = new Adapter([]);
      const events: string[] = [];
      let beforeWriteCalled = false;
      const result = await runProgressiveInit({
        projectRoot,
        originalRequest: REQUEST,
        selectedStage: "user-stories",
        adapter,
        beforeWrite: () => { beforeWriteCalled = true; },
        presentation: {
          stage: (stage) => { events.push(`stage:${stage}`); },
          question: () => { events.push("question"); },
          complete: (stage, disposition) => { events.push(`complete:${stage}:${disposition}`); },
        },
      });
      expect(result).toEqual({
        mode: "focused",
        selectedStage: "user-stories",
        completedStage: "user-stories",
        semanticOperations: 0,
        correctiveRegenerations: 0,
      });
      expect(events).toEqual(["stage:user-stories", "complete:user-stories:existing-fresh"]);
      expect(adapter.requests).toHaveLength(0);
      expect(beforeWriteCalled).toBe(false);
      expect(await readFile(projectPath, "utf8")).toBe(projectBefore);
      expect(await readFile(storyPath, "utf8")).toBe(storiesBefore);
      expect(await readFile(stageRecordPath, "utf8")).toBe(recordBefore);
      expect((await inspectProgressiveInit(projectRoot, REQUEST))[1]?.status).toBe("complete-fresh");
    }
  });

  it("truthfully presents a focused fresh User Stories no-op through the Progressive CLI", async () => {
    const projectRoot = await root();
    await seedProject(projectRoot);
    await seedStories(projectRoot);
    const writes: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      await runProgressiveInitCommand({
        requestParts: [],
        projectRoot,
        headless: true,
        deadlineSeconds: 10,
        stage: "user-stories",
      });
    } finally {
      write.mockRestore();
    }
    const output = writes.join("");
    expect(output).toContain("Stage 2/4 — User Stories");
    expect(output).toContain("✓ User Stories already complete and fresh");
    expect(output).toContain("No regeneration required.");
    expect(output).toContain("Semantic operations: 0");
    expect(output).toContain("Corrective regenerations: 0");
  });

  it("still executes incomplete and complete-stale focused user-stories stages", async () => {
    const projectRoot = await root();
    await seedProject(projectRoot);
    const incompleteAdapter = new Adapter([emptyQuestions(), candidate()]);
    const incomplete = await runProgressiveInit({ ...common(projectRoot, incompleteAdapter), selectedStage: "user-stories" });
    expect(incomplete).toMatchObject({ semanticOperations: 2, correctiveRegenerations: 0 });
    expect(incompleteAdapter.requests.map((request) => request.slice)).toEqual(["user-stories-questions", "user-stories"]);

    await markUserStoriesStale(projectRoot);
    const staleAdapter = new Adapter([emptyQuestions(), candidate()]);
    const stale = await runProgressiveInit({ ...common(projectRoot, staleAdapter), selectedStage: "user-stories" });
    expect(stale).toMatchObject({ semanticOperations: 2, correctiveRegenerations: 0 });
    expect(staleAdapter.requests.map((request) => request.slice)).toEqual(["user-stories-questions", "user-stories"]);
  });

  it("enforces exact symbolic workflow coverage and actor eligibility", async () => {
    const upstream = userStoriesUpstreamProjection(projectPayload() as unknown as ProjectDescription);
    const base = decodeUserStoriesWire(candidate());
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    expect(resolveUserStoriesWire(base.value, upstream, []).ok).toBe(true);

    const cases: Array<[string, (value: ReturnType<typeof candidate>) => void, RegExp]> = [
      ["uncovered workflow", (value) => { value.stories = value.stories.filter((story) => story.workflowKey !== "issue-review") as typeof value.stories; }, /not covered/],
      ["unknown workflow", (value) => { value.stories[0]!.workflowKey = "unknown-workflow"; }, /unknown workflow/],
      ["unknown actor", (value) => { value.stories[0]!.actorKey = "unknown-actor"; }, /unknown actor/],
      ["ineligible actor", (value) => { value.stories[0]!.actorKey = "reviewer"; }, /not eligible/],
      ["duplicate story key", (value) => { value.stories[1]!.key = value.stories[0]!.key; }, /duplicate stage SemanticKey/],
    ];
    for (const [, mutate, expected] of cases) {
      const payload = candidate();
      mutate(payload);
      const decoded = decodeUserStoriesWire(payload);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        const resolved = resolveUserStoriesWire(decoded.value, upstream, []);
        expect(resolved.ok).toBe(false);
        if (!resolved.ok) expect(resolved.findings.map((entry) => entry.message).join("; ")).toMatch(expected);
      }
    }
  });

  it("allocates first-generation IDs by canonical workflow and story key", () => {
    const upstream = userStoriesUpstreamProjection(projectPayload() as unknown as ProjectDescription);
    const decoded = decodeUserStoriesWire(candidate());
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const resolved = resolveUserStoriesWire(decoded.value, upstream, []);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.stories.map(({ key, storyId }) => [key, storyId])).toEqual([
      ["create-issue", "US-1.1"],
      ["update-issue", "US-1.2"],
      ["review-issue", "US-2.1"],
    ]);
  });

  it("preserves IDs across provider reorder and allocates additions monotonically", () => {
    const upstream = userStoriesUpstreamProjection(projectPayload() as unknown as ProjectDescription);
    const firstDecoded = decodeUserStoriesWire(candidate());
    if (!firstDecoded.ok) throw new Error("fixture invalid");
    const first = resolveUserStoriesWire(firstDecoded.value, upstream, []);
    if (!first.ok) throw new Error("fixture invalid");
    const rerunPayload = candidate();
    rerunPayload.stories.reverse();
    rerunPayload.stories.push({
      key: "close-issue", workflowKey: "issue-lifecycle", capabilityKeys: ["manage-issues"], actorKey: "developer", operatorActorKey: "developer", intent: "Close a resolved issue",
      outcome: "Completed work leaves the active issue workflow", acceptance: ["The developer can observe the issue as closed"],
    });
    const rerunDecoded = decodeUserStoriesWire(rerunPayload);
    if (!rerunDecoded.ok) throw new Error("fixture invalid");
    const rerun = resolveUserStoriesWire(rerunDecoded.value, upstream, [], userStoriesForPersistence(first.value));
    expect(rerun.ok).toBe(true);
    if (!rerun.ok) return;
    expect(Object.fromEntries(rerun.value.stories.map((story) => [story.key, story.storyId]))).toEqual({
      "create-issue": "US-1.1",
      "update-issue": "US-1.2",
      "close-issue": "US-1.3",
      "review-issue": "US-2.1",
    });
  });

  it("allocates a newly introduced workflow after the maximum existing group", () => {
    const originalUpstream = userStoriesUpstreamProjection(projectPayload() as unknown as ProjectDescription);
    const firstDecoded = decodeUserStoriesWire(candidate());
    if (!firstDecoded.ok) throw new Error("fixture invalid");
    const first = resolveUserStoriesWire(firstDecoded.value, originalUpstream, []);
    if (!first.ok) throw new Error("fixture invalid");
    const expandedProject = projectPayload();
    expandedProject.actors.push({ key: "observer", name: "Observer", responsibility: "Observes issue reports." });
    expandedProject.capabilities.push({ key: "observe-reports", statement: "Observe issue reports." });
    expandedProject.workflows.push({ key: "report-observation", statement: "An observer views issue reports.", actorKeys: ["observer"], capabilityKeys: ["observe-reports"] });
    const expandedUpstream = userStoriesUpstreamProjection(expandedProject as unknown as ProjectDescription);
    const expanded = candidate();
    expanded.stories.push({ key: "view-report", workflowKey: "report-observation", capabilityKeys: ["observe-reports"], actorKey: "observer", operatorActorKey: "observer", intent: "View an issue report", outcome: "Issue progress is observable", acceptance: ["The observer can see the issue report"] });
    const decoded = decodeUserStoriesWire(expanded);
    if (!decoded.ok) throw new Error("fixture invalid");
    const resolved = resolveUserStoriesWire(decoded.value, expandedUpstream, [], userStoriesForPersistence(first.value));
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.stories.find((story) => story.key === "view-report")?.storyId).toBe("US-3.1");
  });

  it("loads additive upstream change as stale and lets Core allocate the new workflow without renumbering", async () => {
    const projectRoot = await root();
    await seedProject(projectRoot);
    await seedStories(projectRoot);
    const projectPath = resolve(projectRoot, ".spec", "init", "project-description.md");
    const parsed = parseProjectDescriptionDocument(await readFile(projectPath, "utf8"));
    const expanded: ProjectDescription = {
      ...parsed.value,
      actors: [...parsed.value.actors, { key: "observer" as any, name: "Observer", responsibility: "Observes issue reports." }],
      capabilities: [...parsed.value.capabilities, { key: "observe-reports" as any, statement: "Observe issue reports." }],
      workflows: [...parsed.value.workflows, {
        key: "report-observation" as any,
        statement: "An observer views issue reports.",
        actorKeys: ["observer" as any],
        capabilityKeys: ["observe-reports" as any],
      }],
    };
    await writeFile(projectPath, renderProjectDescriptionDocument(expanded, {
      originalRequestSha256: parsed.metadata.originalRequestSha256,
      discoverySha256: parsed.metadata.discoverySha256,
      authoritativeInputSha256: parsed.metadata.authoritativeInputSha256,
    }));
    expect((await inspectProgressiveInit(projectRoot, REQUEST))[1]?.status).toBe("complete-stale");

    const authored = candidate();
    authored.stories.push({
      key: "view-report",
      workflowKey: "report-observation",
      capabilityKeys: ["observe-reports"],
      actorKey: "observer",
      operatorActorKey: "observer",
      intent: "View an issue report",
      outcome: "Issue progress is observable",
      acceptance: ["The observer can see the issue report"],
    });
    await runProgressiveInit({
      ...common(projectRoot, new Adapter([emptyQuestions(), authored])),
      selectedStage: "user-stories",
    });
    const loaded = await loadUserStories(projectRoot, await projectionFor(projectRoot));
    expect(Object.fromEntries(loaded!.document.value.stories.map((story) => [story.key, story.storyId]))).toEqual({
      "create-issue": "US-1.1",
      "update-issue": "US-1.2",
      "review-issue": "US-2.1",
      "view-report": "US-3.1",
    });
    expect((await inspectProgressiveInit(projectRoot, REQUEST))[1]?.status).toBe("complete-fresh");
  });

  it("keeps storyId and authority-bearing determinations out of the provider schema", () => {
    const schema = USER_STORIES_SCHEMA.properties as Record<string, any>;
    expect(schema.stories.items.properties.storyId).toBeUndefined();
    expect(schema.determinations).toBeUndefined();
    const questionSchema = USER_STORIES_QUESTIONS_SCHEMA.properties as Record<string, any>;
    const recommendation = questionSchema.participationRecommendations.items.properties;
    expect(recommendation).toEqual(expect.objectContaining({ subjectKey: expect.anything(), recommendedOptionKey: expect.anything() }));
    expect(recommendation.workflowKey).toBeUndefined();
    expect(recommendation.capabilityKey).toBeUndefined();
    expect(recommendation.actorKey).toBeUndefined();
    expect(recommendation.operatorActorKey).toBeUndefined();
    expect(recommendation.options).toBeUndefined();
    const withId = candidate() as any;
    withId.stories[0].storyId = "US-9.9";
    expect(decodeUserStoriesWire(withId).ok).toBe(false);
    for (const source of [
      { kind: "user-answer", questionKey: "issue-story-boundary", value: "separate" },
      { kind: "accepted-recommendation", questionKey: "issue-story-boundary", value: "separate", acceptanceMode: "non-interactive-policy" },
      { kind: "question", questionKey: "issue-story-boundary" },
      { kind: "developer" },
    ]) {
      const forged = { ...candidate(), determinations: [{
        key: "issue-story-boundary",
        statement: "separate",
        rationale: "Provider-authored authority must be rejected.",
        materiality: "product",
        rigidity: "RIGID",
        source,
      }] };
      const decoded = decodeUserStoriesWire(forged);
      expect(decoded.ok).toBe(false);
      if (!decoded.ok) expect(decoded.findings).toContainEqual(expect.objectContaining({ code: "shape", pointer: "/determinations", message: "unknown field" }));
    }
  });

  it("materializes accepted recommendations and explicit answers entirely from verified Core evidence", () => {
    const question = structuralQuestions().questions[0] as ProposedQuestion;
    const headless = selectInterviewAnswer(pendingQuestionEvidence(question), { kind: "headless" });
    const accepted = materializeUserStoriesInterviewDeterminations([headless]);
    expect(accepted).toEqual({ ok: true, value: [{
      key: "issue-story-boundary",
      statement: "Keep create and update as separate stories",
      rationale: "Each action provides an independently observable actor outcome.",
      materiality: "product",
      rigidity: "RIGID",
      source: {
        kind: "accepted-recommendation",
        questionKey: "issue-story-boundary",
        value: "Keep create and update as separate stories",
        acceptanceMode: "non-interactive-policy",
      },
    }] });

    const explicitEvidence = selectInterviewAnswer(pendingQuestionEvidence(question), {
      kind: "interactive",
      response: "Use one combined issue-management story",
    });
    const explicit = materializeUserStoriesInterviewDeterminations([explicitEvidence]);
    expect(explicit).toEqual({ ok: true, value: [{
      key: "issue-story-boundary",
      statement: "Use one combined issue-management story",
      rationale: "Selected through an explicit user answer to a material interview question.",
      materiality: "product",
      rigidity: "RIGID",
      source: {
        kind: "user-answer",
        questionKey: "issue-story-boundary",
        value: "Use one combined issue-management story",
      },
    }] });
  });

  it("keeps question-owned materiality and rigidity immutable and rejects the obsolete provider channel", () => {
    const question: ProposedQuestion = {
      key: "ator-primario-entrega",
      question: "Which eligible actor primarily owns equipment delivery?",
      materiality: "product",
      rigidity: "FLEXIBLE",
      recommendedAnswer: {
        value: "The service attendant owns equipment delivery",
        rationale: "The attendant already owns the customer-facing handoff workflow.",
      },
      alternatives: ["The technician owns equipment delivery"],
    };
    const evidence = selectInterviewAnswer(pendingQuestionEvidence(question), { kind: "headless" });
    const owned = materializeUserStoriesInterviewDeterminations([evidence]);
    expect(owned.ok).toBe(true);
    if (!owned.ok) return;
    expect(owned.value[0]).toMatchObject({ materiality: "product", rigidity: "FLEXIBLE" });

    const forged = { ...candidate(), determinations: [{
      key: question.key,
      statement: question.recommendedAnswer.value,
      rationale: question.recommendedAnswer.rationale,
      materiality: "architecture",
      rigidity: "RIGID",
      source: { kind: "accepted-recommendation", questionKey: question.key },
    }] };
    expect(decodeUserStoriesWire(forged).ok).toBe(false);
  });

  it("accepts natural story paraphrase because candidate prose is not interview authority", async () => {
    const question: ProposedQuestion = {
      key: "resultado-observavel-status",
      question: "What observable status result should the story guarantee?",
      materiality: "product",
      rigidity: "FLEXIBLE",
      recommendedAnswer: {
        value: "Consultar a ordem de serviço exibindo o status atual mais o histórico datado de cada mudança",
        rationale: "The selected result makes the customer-visible workflow outcome observable.",
      },
      alternatives: ["Exibir somente o status atual"],
    };
    const questions = { contract: "rb-user-stories-questions/v1", stage: "user-stories", participationRecommendations: [], questions: [question] };
    const authored = candidate();
    authored.stories[1]!.intent = "Consultar a ordem de serviço";
    authored.stories[1]!.outcome = "A consulta da ordem de serviço exibe o status atual e o histórico datado de cada mudança";
    const upstream = userStoriesUpstreamProjection(projectPayload() as unknown as ProjectDescription);
    const result = await runUserStoriesOperation({
      upstream,
      profile,
      adapter: new Adapter([questions, authored]),
      auth,
      interview: { kind: "headless" },
      deadlineMs: 10_000,
    });
    expect(result.value.determinations[0]?.statement).toBe(question.recommendedAnswer.value);
    expect(result.value.stories.find((story) => story.key === "review-issue")?.outcome).toBe(authored.stories[1]!.outcome);
  });

  it("materializes six live-shaped interview decisions while the candidate authors stories only", async () => {
    const questions = Array.from({ length: 6 }, (_, index): ProposedQuestion => ({
      key: `dogfood-decision-${index + 1}`,
      question: `Which complete user-story boundary should decision ${index + 1} use?`,
      materiality: index === 5 ? "architecture" : "product",
      rigidity: index % 2 ? "FLEXIBLE" : "RIGID",
      recommendedAnswer: {
        value: `Use the verified structural choice ${index + 1}`,
        rationale: `This verified choice ${index + 1} controls a material part of story authoring.`,
      },
      alternatives: [`Use the alternative structural choice ${index + 1}`],
    }));
    const adapter = new Adapter([{
      contract: "rb-user-stories-questions/v1",
      stage: "user-stories",
      participationRecommendations: [],
      questions,
    }, candidate()]);
    const upstream = userStoriesUpstreamProjection(projectPayload() as unknown as ProjectDescription);
    const result = await runUserStoriesOperation({
      upstream, profile, adapter, auth, interview: { kind: "headless" }, deadlineMs: 10_000,
    });
    expect(result).toMatchObject({ semanticOperations: 2, correctiveRegenerations: 0 });
    expect(result.value.determinations).toHaveLength(6);
    expect(result.value.determinations.map(({ key, statement, materiality, rigidity }) => ({ key, statement, materiality, rigidity })))
      .toEqual(questions.map((question) => ({
        key: question.key,
        statement: question.recommendedAnswer.value,
        materiality: question.materiality,
        rigidity: question.rigidity,
      })));
    expect(adapter.requests[1]!.schema.properties).not.toHaveProperty("determinations");
  });

  it("no-ops a live-dogfood-shaped fresh source with seven determinations and eleven stories", async () => {
    const projectRoot = await root();
    await seedProject(projectRoot);
    const questions = Array.from({ length: 7 }, (_, index): ProposedQuestion => ({
      key: `live-stage-decision-${index + 1}`,
      question: `Which live-shaped structural boundary should decision ${index + 1} preserve?`,
      materiality: "product",
      rigidity: index % 2 ? "FLEXIBLE" : "RIGID",
      recommendedAnswer: {
        value: `Preserve live-shaped structural choice ${index + 1}`,
        rationale: `Live-shaped choice ${index + 1} controls observable story structure.`,
      },
      alternatives: [`Use alternative live-shaped choice ${index + 1}`],
    }));
    const authored = candidate();
    for (let index = 1; index <= 8; index += 1) {
      const review = index > 4;
      authored.stories.push({
        key: `live-extra-story-${index}`,
        workflowKey: review ? "issue-review" : "issue-lifecycle",
        capabilityKeys: [review ? "review-issues" : "manage-issues"],
        actorKey: review ? "reviewer" : "developer",
        operatorActorKey: review ? "reviewer" : "developer",
        intent: `Complete live-shaped actor intent ${index}`,
        outcome: `Live-shaped outcome ${index} is observable`,
        acceptance: [`The actor observes live-shaped outcome ${index}`],
      });
    }
    const initial = await runProgressiveInit({
      ...common(projectRoot, new Adapter([{
        contract: "rb-user-stories-questions/v1",
        stage: "user-stories",
        participationRecommendations: [],
        questions,
      }, authored])),
      selectedStage: "user-stories",
    });
    const storyPath = initial.artifactPath!;
    const before = await readFile(storyPath, "utf8");
    const parsed = parseUserStoriesDocument(before, await projectionFor(projectRoot));
    expect(parsed.value.determinations).toHaveLength(7);
    expect(parsed.value.determinations.every((entry) => entry.source.kind === "developer")).toBe(true);
    expect(parsed.value.stories).toHaveLength(11);

    const adapter = new Adapter([]);
    const rerun = await runProgressiveInit({ projectRoot, originalRequest: REQUEST, selectedStage: "user-stories", adapter });
    expect(rerun).toMatchObject({ completedStage: "user-stories", semanticOperations: 0, correctiveRegenerations: 0 });
    expect(adapter.requests).toHaveLength(0);
    expect(await readFile(storyPath, "utf8")).toBe(before);
    await expect(readFile(resolve(projectRoot, ".rb", "rb-manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails a malformed question-selection result without candidate authoring or correction", async () => {
    const upstream = userStoriesUpstreamProjection(projectPayload() as unknown as ProjectDescription);
    const invalidQuestions = structuralQuestions() as any;
    invalidQuestions.questions[0].unexpected = true;
    const adapter = new Adapter([invalidQuestions, candidate()]);
    await expect(runUserStoriesOperation({ upstream, profile, adapter, auth, interview: { kind: "headless" }, deadlineMs: 10_000 }))
      .rejects.toThrow(/USER_STORIES_QUESTION_SELECTION_INVALID/);
    expect(adapter.requests.map((request) => request.slice)).toEqual(["user-stories-questions"]);
  });

  it.each([
    ["deletion", (value: ReturnType<typeof candidate>) => { value.stories = value.stories.slice(1) as typeof value.stories; }],
    ["rekey", (value: ReturnType<typeof candidate>) => { value.stories[0]!.key = "renamed-update"; }],
    ["actor", (value: ReturnType<typeof candidate>) => { value.stories[0]!.actorKey = "reviewer"; }],
    ["operator", (value: ReturnType<typeof candidate>) => { value.stories[0]!.operatorActorKey = "reviewer"; }],
    ["capabilities", (value: ReturnType<typeof candidate>) => { value.stories[0]!.capabilityKeys = ["review-issues"]; }],
    ["workflow", (value: ReturnType<typeof candidate>) => { value.stories[0]!.workflowKey = "issue-review"; value.stories[0]!.actorKey = "reviewer"; }],
    ["intent", (value: ReturnType<typeof candidate>) => { value.stories[0]!.intent = "Changed provider intent"; }],
    ["outcome", (value: ReturnType<typeof candidate>) => { value.stories[0]!.outcome = "Changed provider outcome"; }],
    ["acceptance", (value: ReturnType<typeof candidate>) => { value.stories[0]!.acceptance = ["Changed provider acceptance"]; }],
  ] as const)("rejects provider %s of developer-owned stories and preserves bytes", async (_case, mutate) => {
    const projectRoot = await root();
    await seedProject(projectRoot);
    const first = await seedStories(projectRoot);
    await markUserStoriesStale(projectRoot);
    const before = await readFile((await first).artifactPath!, "utf8");
    const changed = candidate();
    mutate(changed);
    const adapter = new Adapter([emptyQuestions(), changed, changed]);
    await expect(runProgressiveInit({ ...common(projectRoot, adapter), selectedStage: "user-stories" })).rejects.toThrow(/USER_STORIES_INVALID_AFTER_RECOVERY/);
    expect(adapter.requests.map((request) => request.slice)).toEqual(["user-stories-questions", "user-stories", "user-stories"]);
    expect(await readFile((await first).artifactPath!, "utf8")).toBe(before);
  });

  it("preserves developer-owned structural decisions and rejects their candidate channel", async () => {
    const upstream = userStoriesUpstreamProjection(manualAuthorityProject() as unknown as ProjectDescription);
    const live = await runUserStoriesOperation({
      upstream, profile, adapter: new Adapter([capabilityParticipationQuestions(), manualAuthorityCandidate()]), auth,
      interview: manualInterview(), deadlineMs: 10_000,
    });
    const existing = userStoriesForPersistence(live.value);
    const decisionKey = existing.structuralDecisions.find((entry) => entry.capabilityKey === "decisao-orcamento")!.key;
    const changed: UserStories = {
      ...existing,
      structuralDecisions: existing.structuralDecisions.map((entry) => entry.key === decisionKey
        ? { ...entry, actorKey: "atendente" as any }
        : entry),
    };
    expect(validateUserStoriesPreservation(existing, changed)).toContainEqual(expect.objectContaining({
      code: "preservation",
      pointer: `/structuralDecisions/${decisionKey}`,
    }));

    const forged = { ...manualAuthorityCandidate(), structuralDecisions: existing.structuralDecisions };
    const decoded = decodeUserStoriesWire(forged);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.findings).toContainEqual(expect.objectContaining({
      code: "shape", pointer: "/structuralDecisions", message: "unknown field",
    }));
  });

  it("carries existing developer stage determinations without asking the provider to re-author them", async () => {
    const projectRoot = await root();
    await seedProject(projectRoot);
    const first = await runProgressiveInit({
      ...common(projectRoot, new Adapter([structuralQuestions(), candidate()])),
      selectedStage: "user-stories",
    });
    await markUserStoriesStale(projectRoot);
    const before = await readFile(first.artifactPath!, "utf8");
    const adapter = new Adapter([emptyQuestions(), candidate()]);
    await runProgressiveInit({ ...common(projectRoot, adapter), selectedStage: "user-stories" });
    const after = await readFile(first.artifactPath!, "utf8");
    expect(parseUserStoriesDocument(after, await projectionFor(projectRoot)).value.determinations).toEqual(
      parseUserStoriesDocument(before, await projectionFor(projectRoot)).value.determinations,
    );
    expect(adapter.requests[1]!.schema.properties).not.toHaveProperty("determinations");
  });

  it("fails before candidate authoring when a new question collides with developer-owned determination authority", async () => {
    const projectRoot = await root();
    await seedProject(projectRoot);
    const first = await runProgressiveInit({
      ...common(projectRoot, new Adapter([structuralQuestions(), candidate()])),
      selectedStage: "user-stories",
    });
    await markUserStoriesStale(projectRoot);
    const before = await readFile(first.artifactPath!, "utf8");
    const adapter = new Adapter([structuralQuestions()]);
    await expect(runProgressiveInit({ ...common(projectRoot, adapter), selectedStage: "user-stories" }))
      .rejects.toThrow(/USER_STORIES_INTERVIEW_DETERMINATION_CONFLICT.*issue-story-boundary.*developer-owned/);
    expect(adapter.requests.map((request) => request.slice)).toEqual(["user-stories-questions"]);
    expect(await readFile(first.artifactPath!, "utf8")).toBe(before);
  });

  it("accepts strict direct developer edits and additions, but rejects invalid IDs and group mappings", async () => {
    const projectRoot = await root();
    await seedProject(projectRoot);
    const result = await seedStories(projectRoot);
    const path = (await result).artifactPath!;
    const upstream = await projectionFor(projectRoot);
    const original = await readFile(path, "utf8");
    const edited = original
      .replace('Intent: "Create a project issue"', 'Intent: "Create a developer-edited project issue"')
      .replace('Outcome: "The work is represented for later tracking"', 'Outcome: "Developer-edited work remains visible for tracking"')
      .replace('Acceptance: ["The developer can observe the newly created issue"]', 'Acceptance: ["The developer can observe the developer-edited issue"]');
    await writeFile(path, edited);
    const loaded = await loadUserStories(projectRoot, upstream);
    expect(loaded?.document.developerModified).toBe(true);
    expect(loaded?.document.value.stories[0]?.intent).toContain("developer-edited");

    const withAddition: UserStories = {
      ...loaded!.document.value,
      stories: [...loaded!.document.value.stories, {
        key: "archive-issue" as any,
        storyId: "US-1.3",
        workflowKey: "issue-lifecycle" as any,
        capabilityKeys: ["manage-issues" as any],
        actorKey: "developer" as any,
        operatorActorKey: "developer" as any,
        intent: "Archive a closed issue",
        outcome: "Inactive work no longer crowds the active view",
        acceptance: ["The developer can observe the issue in the archive"],
      }],
    };
    const source = renderUserStoriesDocument(withAddition, upstream, {
      upstreamProjectionSha256: userStoriesUpstreamProjectionSha256(upstream),
      authoritativeInputSha256: loaded!.document.metadata.authoritativeInputSha256,
    });
    expect(parseUserStoriesDocument(source, upstream).value.stories.some((story) => story.key === "archive-issue")).toBe(true);
    expect(() => parseUserStoriesDocument(source.replace("US-1.3 — archive-issue", "US-1.1 — archive-issue"), upstream)).toThrow(/duplicate stable story ID/);
    expect(() => parseUserStoriesDocument(source.replace("US-1.3 — archive-issue", "US-3.1 — archive-issue"), upstream)).toThrow(/maps to more than one story group/);
    const directDeletion = renderUserStoriesDocument({
      ...withAddition,
      stories: withAddition.stories.filter((story) => story.key !== "update-issue"),
    }, upstream, {
      upstreamProjectionSha256: userStoriesUpstreamProjectionSha256(upstream),
      authoritativeInputSha256: loaded!.document.metadata.authoritativeInputSha256,
    });
    expect(parseUserStoriesDocument(directDeletion, upstream).value.stories.some((story) => story.key === "update-issue")).toBe(false);
  });

  it("runs structural question selection before interview, candidate authoring, and persistence", async () => {
    const projectRoot = await root();
    await seedProject(projectRoot);
    const events: string[] = [];
    const adapter = new Adapter([structuralQuestions(), combinedCandidate()]);
    const result = await runProgressiveInit({
      ...common(projectRoot, adapter),
      interview: { kind: "interactive", answer: async () => { events.push("interview"); return "Use one combined issue-management story"; } },
      selectedStage: "user-stories",
      presentation: {
        stage: (stage) => { events.push(`stage:${stage}`); },
        question: () => { events.push("question"); },
        complete: () => { events.push("persisted"); },
      },
    });
    expect(adapter.requests.map((request) => request.slice)).toEqual(["user-stories-questions", "user-stories"]);
    expect(events).toEqual(["stage:user-stories", "question", "interview", "persisted"]);
    expect(JSON.parse(adapter.requests[1]!.input).selectedStageDecisions[0].selectedValue).toBe("Use one combined issue-management story");
    const persisted = parseUserStoriesDocument(await readFile(result.artifactPath!, "utf8"), await projectionFor(projectRoot));
    expect(persisted.value.determinations[0]).toMatchObject({ statement: "Use one combined issue-management story", source: { kind: "developer" } });
    expect(persisted.value.stories.map((story) => story.key)).toEqual(["manage-issue", "review-issue"]);
    const persistedSource = await readFile(result.artifactPath!, "utf8");
    const currentUpstream = await projectionFor(projectRoot);
    expect(() => parseUserStoriesDocument(
      persistedSource.replace('{"kind":"developer"}', '{"kind":"user-answer","questionKey":"issue-story-boundary","value":"Use one combined issue-management story"}'),
      currentUpstream,
    )).toThrow(/persisted Source must be developer authority/);
  });

  it.each([
    ["explicit", { kind: "interactive", answer: async () => "Use one combined issue-management story" } as const, "user-answer", undefined],
    ["blank", { kind: "interactive", answer: async () => "" } as const, "accepted-recommendation", "blank-interactive"],
    ["headless", { kind: "headless" } as const, "accepted-recommendation", "non-interactive-policy"],
  ])("verifies %s interview authority live and persists developer authority", async (_case, interview, liveKind, acceptanceMode) => {
    const upstream = userStoriesUpstreamProjection(projectPayload() as unknown as ProjectDescription);
    const result = await runUserStoriesOperation({ upstream, profile, adapter: new Adapter([structuralQuestions(), candidate()]), auth, interview, deadlineMs: 10_000 });
    expect(result.value.determinations[0]).toMatchObject({
      key: "issue-story-boundary",
      materiality: "product",
      rigidity: "RIGID",
      source: { kind: liveKind, ...(acceptanceMode ? { acceptanceMode } : {}) },
    });
    expect(userStoriesForPersistence(result.value).determinations[0]?.source).toEqual({ kind: "developer" });
  });

  it("uses one complete-candidate correction without re-asking questions", async () => {
    const upstream = userStoriesUpstreamProjection(projectPayload() as unknown as ProjectDescription);
    const invalid = candidate();
    invalid.stories = invalid.stories.filter((story) => story.workflowKey !== "issue-review") as typeof invalid.stories;
    let answers = 0;
    const adapter = new Adapter([structuralQuestions(), invalid, candidate()]);
    const result = await runUserStoriesOperation({
      upstream,
      profile,
      adapter,
      auth,
      interview: { kind: "interactive", answer: async () => { answers += 1; return ""; } },
      deadlineMs: 10_000,
    });
    expect(result).toMatchObject({ semanticOperations: 3, correctiveRegenerations: 1 });
    expect(answers).toBe(1);
    expect(adapter.requests.map((request) => request.slice)).toEqual(["user-stories-questions", "user-stories", "user-stories"]);
    expect(JSON.parse(adapter.requests[1]!.input).selectedStageDecisions).toEqual(JSON.parse(adapter.requests[2]!.input).selectedStageDecisions);
    const expectedDeterminations = materializeUserStoriesInterviewDeterminations(result.interviewEvidence);
    if (!expectedDeterminations.ok) throw new Error("fixture interview evidence must materialize");
    expect(result.value.determinations).toEqual(expectedDeterminations.value);
    const recovery = JSON.parse(adapter.requests[2]!.input).recovery;
    expect(recovery.completeStageRegeneration).toBe(true);
    expect(JSON.stringify(recovery.immediatelyPrecedingFindings)).toContain("issue-review");
  });

  it("keeps the accepted-decision freshness projection independent of candidate paraphrase", async () => {
    const upstream = userStoriesUpstreamProjection(projectPayload() as unknown as ProjectDescription);
    const firstCandidate = candidate();
    const paraphrasedCandidate = candidate();
    paraphrasedCandidate.stories[1]!.intent = "Assess an issue pending approval";
    paraphrasedCandidate.stories[1]!.outcome = "Participants can observe the recorded approval decision";
    const options = { upstream, profile, auth, interview: { kind: "headless" as const }, deadlineMs: 10_000 };
    const first = await runUserStoriesOperation({ ...options, adapter: new Adapter([structuralQuestions(), firstCandidate]) });
    const second = await runUserStoriesOperation({ ...options, adapter: new Adapter([structuralQuestions(), paraphrasedCandidate]) });
    expect(userStoriesAcceptedDecisionProjection(first.value)).toEqual(userStoriesAcceptedDecisionProjection(second.value));
    expect(first.value.stories).not.toEqual(second.value.stories);
  });

  it("fails after the second invalid candidate and makes no third candidate call", async () => {
    const upstream = userStoriesUpstreamProjection(projectPayload() as unknown as ProjectDescription);
    const invalid = candidate();
    invalid.stories = invalid.stories.filter((story) => story.workflowKey !== "issue-review") as typeof invalid.stories;
    const adapter = new Adapter([emptyQuestions(), invalid, invalid]);
    await expect(runUserStoriesOperation({ upstream, profile, adapter, auth, interview: { kind: "headless" }, deadlineMs: 10_000 }))
      .rejects.toThrow(/USER_STORIES_INVALID_AFTER_RECOVERY/);
    expect(adapter.requests).toHaveLength(3);
  });

  it("strictly round-trips and byte-stabilizes the user-stories document", async () => {
    const projectRoot = await root();
    await seedProject(projectRoot);
    const result = await seedStories(projectRoot);
    const upstream = await projectionFor(projectRoot);
    const source = await readFile((await result).artifactPath!, "utf8");
    const parsed = parseUserStoriesDocument(source, upstream);
    const rendered = renderUserStoriesDocument(parsed.value, upstream, {
      upstreamProjectionSha256: parsed.metadata.upstreamProjectionSha256,
      authoritativeInputSha256: parsed.metadata.authoritativeInputSha256,
    });
    expect(rendered).toBe(source);
    expect(parseUserStoriesDocument(rendered, upstream).value).toEqual(parsed.value);
    expect(() => parseUserStoriesDocument(source.replace("## Workflow issue-lifecycle", "## Unknown issue-lifecycle"), upstream)).toThrow(/unexpected content/);
    expect(() => parseUserStoriesDocument(source.replace('Actor: "developer"', 'Unknown: "developer"'), upstream)).toThrow(/expected Actor/);
    expect(() => parseUserStoriesDocument(source.replace("US-1.1", "US-0.1"), upstream)).toThrow(/invalid story heading/);
    expect(() => parseUserStoriesDocument(source.replace("US-1.2 — update-issue", "US-1.2 — create-issue"), upstream)).toThrow(/duplicate stage SemanticKey/);
    expect(parseUserStoriesDocument(source
      .replace('Actor: "developer"', 'Actor: "missing-actor"')
      .replace('Operator: "developer"', 'Operator: "missing-actor"'), upstream)
      .upstreamCompatibilityFindings.map((entry) => entry.message).join("; ")).toMatch(/unknown actor/);
    expect(parseUserStoriesDocument(source.replace("## Workflow issue-review", "## Workflow missing-workflow"), upstream)
      .upstreamCompatibilityFindings.map((entry) => entry.message).join("; ")).toMatch(/unknown workflow/);
    expect(() => parseUserStoriesDocument(source.replace("rb-user-stories/v1", "rb-user-stories/v2"), upstream)).toThrow(/contract must be rb-user-stories\/v1/);
  });

  it("keeps valid structural documents parseable while reporting upstream reconciliation findings", async () => {
    const upstream = userStoriesUpstreamProjection(manualAuthorityProject() as unknown as ProjectDescription);
    const live = await runUserStoriesOperation({
      upstream, profile, adapter: new Adapter([capabilityParticipationQuestions(), manualAuthorityCandidate()]), auth,
      interview: manualInterview(), deadlineMs: 10_000,
    });
    const persisted = userStoriesForPersistence(live.value);
    const source = renderUserStoriesDocument(persisted, upstream, {
      upstreamProjectionSha256: "1".repeat(64),
      authoritativeInputSha256: "2".repeat(64),
    });
    expect(source).toContain("## Structural Decisions");
    expect(source).toContain("Capabilities: [\"decisao-orcamento\"]");
    expect(source).toContain('Operator: "atendente"');

    const project = manualAuthorityProject();
    project.capabilities[1]!.key = "decisao-orcamento-atualizada";
    project.workflows[0]!.capabilityKeys = ["acompanhamento-status", "decisao-orcamento-atualizada"];
    project.workflows[0]!.actorKeys = ["cliente"];
    const changedUpstream = userStoriesUpstreamProjection(project as unknown as ProjectDescription);
    const parsed = parseUserStoriesDocument(source, changedUpstream, { allowUncoveredWorkflows: true });
    const messages = parsed.upstreamCompatibilityFindings.map((entry) => entry.message).join("; ");
    expect(messages).toMatch(/unknown capability key 'decisao-orcamento'/);
    expect(messages).toMatch(/no longer belongs to workflow 'aprovacao-orcamento'/);
    expect(messages).toMatch(/structural operator 'atendente' is not eligible/);
    expect(messages).toMatch(/operator 'atendente' is not eligible/);

    const duplicatedDecision = source.replace(
      "## Workflow aprovacao-orcamento",
      `${source.slice(source.indexOf(`### Capability Participation \`${persisted.structuralDecisions[0]!.key}\``), source.indexOf("## Workflow aprovacao-orcamento"))}## Workflow aprovacao-orcamento`,
    );
    expect(() => parseUserStoriesDocument(duplicatedDecision, upstream)).toThrow(/duplicate structural decision key|duplicate capability-participation decision/);
  });

  it("classifies semantic freshness without hashing Markdown formatting or story content as upstream input", async () => {
    const projectRoot = await root();
    await seedProject(projectRoot);
    const result = await seedStories(projectRoot);
    expect((await inspectProgressiveInit(projectRoot, REQUEST))[1]?.status).toBe("complete-fresh");
    const projectPath = resolve(projectRoot, ".spec", "init", "project-description.md");
    const projectSource = await readFile(projectPath, "utf8");
    const projectDocument = parseProjectDescriptionDocument(projectSource);
    await writeFile(projectPath, renderProjectDescriptionDocument({
      ...projectDocument.value,
      actors: [...projectDocument.value.actors].reverse(),
      workflows: [...projectDocument.value.workflows].reverse(),
    }, {
      originalRequestSha256: projectDocument.metadata.originalRequestSha256,
      discoverySha256: projectDocument.metadata.discoverySha256,
      authoritativeInputSha256: projectDocument.metadata.authoritativeInputSha256,
    }));
    expect((await inspectProgressiveInit(projectRoot, REQUEST))[1]?.status).toBe("complete-fresh");

    const storyPath = (await result).artifactPath!;
    const storySource = await readFile(storyPath, "utf8");
    await writeFile(storyPath, storySource.replace('Intent: "Create a project issue"', 'Intent: "Developer manually edits the issue intent"'));
    const upstream = await projectionFor(projectRoot);
    const loaded = await loadUserStories(projectRoot, upstream);
    expect(loaded?.document.developerModified).toBe(true);
    expect((await inspectProgressiveInit(projectRoot, REQUEST))[1]?.status).toBe("complete-fresh");
    const editedBeforeRerun = await readFile(storyPath, "utf8");
    const noCall = new Adapter([]);
    expect(await runProgressiveInit({ projectRoot, originalRequest: REQUEST, selectedStage: "user-stories", adapter: noCall }))
      .toMatchObject({ completedStage: "user-stories", semanticOperations: 0, correctiveRegenerations: 0 });
    expect(noCall.requests).toHaveLength(0);
    expect(await readFile(storyPath, "utf8")).toBe(editedBeforeRerun);

    await writeFile(resolve(projectRoot, ".rb-harness", "unrelated-noise"), "noise", { flag: "w" });
    expect((await inspectProgressiveInit(projectRoot, REQUEST))[1]?.status).toBe("complete-fresh");
  });

  it("stales on relevant upstream semantics while repository mutations leave the prerequisite fresh", async () => {
    const projectRoot = await root();
    await seedProject(projectRoot);
    await seedStories(projectRoot);
    const projectPath = resolve(projectRoot, ".spec", "init", "project-description.md");
    const parsed = parseProjectDescriptionDocument(await readFile(projectPath, "utf8"));
    const changed: ProjectDescription = {
      ...parsed.value,
      workflows: parsed.value.workflows.map((workflow) => workflow.key === "issue-lifecycle"
        ? { ...workflow, statement: "A developer creates, updates, and closes an issue." }
        : workflow),
    };
    await writeFile(projectPath, renderProjectDescriptionDocument(changed, {
      originalRequestSha256: parsed.metadata.originalRequestSha256,
      discoverySha256: parsed.metadata.discoverySha256,
      authoritativeInputSha256: parsed.metadata.authoritativeInputSha256,
    }));
    expect((await inspectProgressiveInit(projectRoot, REQUEST))[1]?.status).toBe("complete-stale");

    await writeFile(resolve(projectRoot, "repository-change.ts"), "export {};\n");
    const statuses = await inspectProgressiveInit(projectRoot, REQUEST);
    expect(statuses[0]?.status).toBe("complete-fresh");
    expect(statuses[1]?.status).toBe("complete-stale");
    const noCall = new Adapter([]);
    await expect(runProgressiveInit({
      ...common(projectRoot, noCall),
      originalRequest: "A materially changed project request",
      selectedStage: "user-stories",
    })).rejects.toThrow(/PREREQUISITE_INVALID/);
    expect(noCall.requests).toHaveLength(0);
  });

  it("keeps complete User Stories fresh and provider-free after a repository-only mutation", async () => {
    const projectRoot = await root();
    await seedProject(projectRoot);
    await seedStories(projectRoot);
    await writeFile(resolve(projectRoot, "repository-change.ts"), "export {};\n");
    const statuses = await inspectProgressiveInit(projectRoot, REQUEST);
    expect(statuses[0]?.status).toBe("complete-fresh");
    expect(statuses[1]?.status).toBe("complete-fresh");
    const adapter = new Adapter([]);
    let writes = 0;
    expect(await runProgressiveInit({ ...common(projectRoot, adapter), selectedStage: "user-stories", beforeWrite: () => { writes += 1; } }))
      .toMatchObject({ completedStage: "user-stories", semanticOperations: 0, correctiveRegenerations: 0 });
    expect(adapter.requests).toHaveLength(0);
    expect(writes).toBe(0);
  });

  it("classifies upstream-breaking developer stories without deadlocking inspection", async () => {
    const projectRoot = await root();
    await seedProject(projectRoot);
    const stories = await seedStories(projectRoot);
    const storyPath = (await stories).artifactPath!;
    const before = await readFile(storyPath, "utf8");
    const projectPath = resolve(projectRoot, ".spec", "init", "project-description.md");
    const parsed = parseProjectDescriptionDocument(await readFile(projectPath, "utf8"));
    const changed: ProjectDescription = {
      ...parsed.value,
      actors: parsed.value.actors.map((actor) => actor.key === "developer" ? { ...actor, key: "engineer" as any } : actor),
      workflows: parsed.value.workflows.map((workflow) => workflow.key === "issue-lifecycle"
        ? { ...workflow, actorKeys: ["engineer" as any] }
        : workflow),
    };
    await writeFile(projectPath, renderProjectDescriptionDocument(changed, {
      originalRequestSha256: parsed.metadata.originalRequestSha256,
      discoverySha256: parsed.metadata.discoverySha256,
      authoritativeInputSha256: parsed.metadata.authoritativeInputSha256,
    }));
    const statuses = await inspectProgressiveInit(projectRoot, REQUEST);
    expect(statuses[0]).toMatchObject({ stage: "project-description", status: "complete-fresh" });
    expect(statuses[1]).toEqual({
      stage: "user-stories",
      status: "reconciliation-required",
      findings: [
        { pointer: "/stories/0/actorKey", message: "actor 'developer' is not eligible for workflow 'issue-lifecycle'" },
        { pointer: "/stories/0/operatorActorKey", message: "operator 'developer' is not eligible for workflow 'issue-lifecycle'" },
        { pointer: "/stories/0/actorKey", message: "unknown actor key 'developer'" },
        { pointer: "/stories/0/operatorActorKey", message: "unknown operator actor key 'developer'" },
        { pointer: "/stories/1/actorKey", message: "actor 'developer' is not eligible for workflow 'issue-lifecycle'" },
        { pointer: "/stories/1/operatorActorKey", message: "operator 'developer' is not eligible for workflow 'issue-lifecycle'" },
        { pointer: "/stories/1/actorKey", message: "unknown actor key 'developer'" },
        { pointer: "/stories/1/operatorActorKey", message: "unknown operator actor key 'developer'" },
      ],
    });
    expect(await readFile(storyPath, "utf8")).toBe(before);
  });

  it("keeps focused fresh project-description addressable as a no-op while downstream stories require reconciliation", async () => {
    const projectRoot = await root();
    await seedProject(projectRoot);
    const stories = await seedStories(projectRoot);
    const storyPath = (await stories).artifactPath!;
    const storyBefore = await readFile(storyPath, "utf8");
    const projectPath = resolve(projectRoot, ".spec", "init", "project-description.md");
    const parsed = parseProjectDescriptionDocument(await readFile(projectPath, "utf8"));
    const changed: ProjectDescription = {
      ...parsed.value,
      actors: parsed.value.actors.map((actor) => actor.key === "developer" ? { ...actor, key: "engineer" as any } : actor),
      workflows: parsed.value.workflows.map((workflow) => workflow.key === "issue-lifecycle"
        ? { ...workflow, actorKeys: ["engineer" as any] }
        : workflow),
    };
    await writeFile(projectPath, renderProjectDescriptionDocument(changed, {
      originalRequestSha256: parsed.metadata.originalRequestSha256,
      discoverySha256: parsed.metadata.discoverySha256,
      authoritativeInputSha256: parsed.metadata.authoritativeInputSha256,
    }));
    const projectBefore = await readFile(projectPath, "utf8");
    const adapter = new Adapter([]);
    const result = await runProgressiveInit({ ...common(projectRoot, adapter), selectedStage: "project-description" });
    expect(result).toMatchObject({ completedStage: "project-description", semanticOperations: 0, correctiveRegenerations: 0 });
    expect(adapter.requests).toHaveLength(0);
    expect(await readFile(projectPath, "utf8")).toBe(projectBefore);
    expect(await readFile(storyPath, "utf8")).toBe(storyBefore);
  });

  it("stops focused and automatic user-stories at the reconciliation boundary without provider calls or mutation", async () => {
    const projectRoot = await root();
    await seedProject(projectRoot);
    const stories = await seedStories(projectRoot);
    const storyPath = (await stories).artifactPath!;
    const projectPath = resolve(projectRoot, ".spec", "init", "project-description.md");
    const storyBefore = await readFile(storyPath, "utf8");
    const parsed = parseProjectDescriptionDocument(await readFile(projectPath, "utf8"));
    const changed: ProjectDescription = {
      ...parsed.value,
      actors: parsed.value.actors.map((actor) => actor.key === "developer" ? { ...actor, key: "engineer" as any } : actor),
      workflows: parsed.value.workflows.map((workflow) => workflow.key === "issue-lifecycle"
        ? { ...workflow, actorKeys: ["engineer" as any] }
        : workflow),
    };
    await writeFile(projectPath, renderProjectDescriptionDocument(changed, {
      originalRequestSha256: parsed.metadata.originalRequestSha256,
      discoverySha256: parsed.metadata.discoverySha256,
      authoritativeInputSha256: parsed.metadata.authoritativeInputSha256,
    }));
    const projectBefore = await readFile(projectPath, "utf8");
    for (const selectedStage of ["user-stories", undefined] as const) {
      const adapter = new Adapter([]);
      const presented: string[] = [];
      await expect(runProgressiveInit({
        ...common(projectRoot, adapter),
        ...(selectedStage ? { selectedStage } : {}),
        presentation: { stage: (stage) => { presented.push(stage); } },
      }))
        .rejects.toThrow(/USER_STORIES_RECONCILIATION_REQUIRED.*\/stories\/0\/actorKey.*Update \.spec\/init\/user-stories\.md/);
      expect(presented).toEqual(["user-stories"]);
      expect(adapter.requests).toHaveLength(0);
      expect(await readFile(storyPath, "utf8")).toBe(storyBefore);
      expect(await readFile(projectPath, "utf8")).toBe(projectBefore);
    }

    const cliAdapter = new Adapter([]);
    const calls = { profile: 0, compatibility: 0, adapter: 0, execute: 0 };
    const runtime: ProgressiveInitCliRuntime = {
      inputIsTTY: false,
      outputIsTTY: false,
      write: () => undefined,
      ask: async () => "",
      inspect: inspectProgressiveInit,
      listProfiles: () => { calls.profile += 1; return [profile]; },
      loadProfile: async () => { calls.profile += 1; return profile; },
      adapterFor: () => { calls.adapter += 1; return cliAdapter; },
      authFor: async () => { calls.profile += 1; return auth; },
      listClaudeCodeModels: async () => { calls.compatibility += 1; return []; },
      inspectClaudeCodeModel: async () => { calls.compatibility += 1; throw new Error("unexpected compatibility lookup"); },
      verifyClaudeCodeModel: async () => { calls.compatibility += 1; return profile; },
      execute: async (options) => { calls.execute += 1; return runProgressiveInit(options); },
    };
    await expect(executeProgressiveInitCommand({
      requestParts: [REQUEST], projectRoot, headless: true, deadlineSeconds: 120, stage: "user-stories",
    }, runtime)).rejects.toThrow(/USER_STORIES_RECONCILIATION_REQUIRED.*Update \.spec\/init\/user-stories\.md/);
    expect(calls).toEqual({ profile: 0, compatibility: 0, adapter: 0, execute: 1 });
    expect(cliAdapter.requests).toHaveLength(0);
    await expect(readFile(resolve(projectRoot, ".rb", "rb-manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("clears reconciliation only after a strict developer edit and then resumes normal execution", async () => {
    const projectRoot = await root();
    await seedProject(projectRoot);
    const stories = await seedStories(projectRoot);
    const storyPath = (await stories).artifactPath!;
    const projectPath = resolve(projectRoot, ".spec", "init", "project-description.md");
    const parsed = parseProjectDescriptionDocument(await readFile(projectPath, "utf8"));
    const changed: ProjectDescription = {
      ...parsed.value,
      actors: parsed.value.actors.map((actor) => actor.key === "developer" ? { ...actor, key: "engineer" as any } : actor),
      workflows: parsed.value.workflows.map((workflow) => workflow.key === "issue-lifecycle"
        ? { ...workflow, actorKeys: ["engineer" as any] }
        : workflow),
    };
    await writeFile(projectPath, renderProjectDescriptionDocument(changed, {
      originalRequestSha256: parsed.metadata.originalRequestSha256,
      discoverySha256: parsed.metadata.discoverySha256,
      authoritativeInputSha256: parsed.metadata.authoritativeInputSha256,
    }));
    expect((await inspectProgressiveInit(projectRoot, REQUEST))[1]?.status).toBe("reconciliation-required");
    await writeFile(storyPath, (await readFile(storyPath, "utf8"))
      .replaceAll('Actor: "developer"', 'Actor: "engineer"')
      .replaceAll('Operator: "developer"', 'Operator: "engineer"'));
    expect((await inspectProgressiveInit(projectRoot, REQUEST))[1]?.status).toBe("complete-stale");
    await rm(resolve(projectRoot, ".rb-harness"), { recursive: true, force: true });
    expect((await inspectProgressiveInit(projectRoot, REQUEST))[1]?.status).toBe("complete-stale");

    const reconciled = candidate();
    reconciled.stories = reconciled.stories.map((story) => story.workflowKey === "issue-lifecycle"
      ? { ...story, actorKey: "engineer", operatorActorKey: "engineer" }
      : story) as typeof reconciled.stories;
    const adapter = new Adapter([emptyQuestions(), reconciled]);
    await runProgressiveInit({ ...common(projectRoot, adapter), selectedStage: "user-stories" });
    expect(adapter.requests.map((request) => request.slice)).toEqual(["user-stories-questions", "user-stories"]);
    expect((await inspectProgressiveInit(projectRoot, REQUEST))[1]?.status).toBe("complete-fresh");
  });

  it("keeps intrinsic corruption fail-closed instead of classifying it as reconciliation", async () => {
    const projectRoot = await root();
    await seedProject(projectRoot);
    const stories = await seedStories(projectRoot);
    const storyPath = (await stories).artifactPath!;
    await writeFile(storyPath, (await readFile(storyPath, "utf8")).replace("US-1.1", "US-0.1"));
    await expect(inspectProgressiveInit(projectRoot, REQUEST)).rejects.toThrow(/USER_STORIES_DOCUMENT_INVALID.*invalid story heading/);
  });

  it("preserves concurrent edits and rejects symlink-owned user-stories paths", async () => {
    const projectRoot = await root();
    await seedProject(projectRoot);
    const path = resolve(projectRoot, ".spec", "init", "user-stories.md");
    await seedStories(projectRoot);
    await markUserStoriesStale(projectRoot);
    await expect(runProgressiveInit({
      ...common(projectRoot, new Adapter([emptyQuestions(), candidate()])),
      selectedStage: "user-stories",
      beforeWrite: () => writeFile(path, "developer concurrent edit\n"),
    })).rejects.toThrow(/USER_STORIES_CONCURRENT_MODIFICATION/);
    expect(await readFile(path, "utf8")).toBe("developer concurrent edit\n");

    const symlinkRoot = await root();
    await seedProject(symlinkRoot);
    const target = resolve(symlinkRoot, ".rb-harness", "outside.md");
    await writeFile(target, "outside\n");
    await symlink(target, resolve(symlinkRoot, ".spec", "init", "user-stories.md"));
    const adapter = new Adapter([emptyQuestions(), candidate()]);
    await expect(runProgressiveInit({ ...common(symlinkRoot, adapter), selectedStage: "user-stories" })).rejects.toThrow(/UNSAFE_PROGRESSIVE_INIT_PATH/);
    expect(adapter.requests).toHaveLength(0);
    expect(await readFile(target, "utf8")).toBe("outside\n");
  });

  it("derives authority, allocation, and freshness without a user-stories .rb-harness record", async () => {
    const projectRoot = await root();
    await seedProject(projectRoot);
    await seedStories(projectRoot);
    await expect(readFile(resolve(projectRoot, ".rb-harness", "progressive-init", "user-stories.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const before = await loadUserStories(projectRoot, await projectionFor(projectRoot));
    await rm(resolve(projectRoot, ".rb-harness"), { recursive: true, force: true });
    const after = await loadUserStories(projectRoot, await projectionFor(projectRoot));
    expect(after?.document.value).toEqual(before?.document.value);
    expect((await inspectProgressiveInit(projectRoot, REQUEST))[1]?.status).toBe("complete-fresh");
  });

  it("integrates focused and automatic coordinator behavior through the database-schema boundary", async () => {
    const projectRoot = await root();
    await seedProject(projectRoot);
    expect((await inspectProgressiveInit(projectRoot, REQUEST)).map((entry) => entry.status)).toEqual(["complete-fresh", "incomplete", "incomplete", "incomplete"]);
    const automatic = await runProgressiveInit(common(projectRoot, new Adapter([emptyQuestions(), candidate()])));
    expect(automatic).toMatchObject({ mode: "automatic", selectedStage: "user-stories", completedStage: "user-stories", nextStage: "database-schema", semanticOperations: 2, correctiveRegenerations: 0 });
    const noCall = new Adapter([]);
    await expect(runProgressiveInit(common(projectRoot, noCall))).rejects.toThrow(/DATABASE_SCHEMA_INTERACTIVE_AUTHORITY_REQUIRED/);
    expect(noCall.requests).toHaveLength(0);

    const focusedRoot = await root();
    await seedProject(focusedRoot);
    const focused = await seedStories(focusedRoot);
    expect((await focused)).toMatchObject({ mode: "focused", selectedStage: "user-stories", completedStage: "user-stories" });
    expect((await focused).nextStage).toBeUndefined();
    expect(formatProgressiveStagePresentation("user-stories", await inspectProgressiveInit(focusedRoot, REQUEST))).toContain("Stage 2/4 — User Stories");
  });

  it("does not include repository state in the user-stories input hash", () => {
    const upstream = userStoriesUpstreamProjection(projectPayload() as unknown as ProjectDescription);
    const upstreamSha = userStoriesUpstreamProjectionSha256(upstream);
    const first = userStoriesAuthoritativeInputSha256({ upstreamProjectionSha256: upstreamSha, acceptedDecisions: [] });
    const second = userStoriesAuthoritativeInputSha256({ upstreamProjectionSha256: upstreamSha, acceptedDecisions: [] });
    expect(first).toBe(second);
  });
});
