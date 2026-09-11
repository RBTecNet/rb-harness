import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { runProgressiveInit } from "../../../src/vnext/progressive-init/coordinator.js";
import { databaseSchemaUpstreamProjection, enumerateStoryPersistenceSubjects } from "../../../src/vnext/progressive-init/database-schema-ir.js";
import { loadDatabaseSchema } from "../../../src/vnext/progressive-init/database-schema-store.js";
import { deriveImplementationSubjects, projectPhasesUpstreamProjection, type ProjectPhasesProposalWire, type ProjectPhasesUpstreamProjection } from "../../../src/vnext/progressive-init/project-phases-ir.js";
import { loadProjectDescription } from "../../../src/vnext/progressive-init/project-description-store.js";
import { userStoriesUpstreamProjection, userStoriesUpstreamProjectionSha256 } from "../../../src/vnext/progressive-init/user-stories-ir.js";
import { loadUserStories } from "../../../src/vnext/progressive-init/user-stories-store.js";
import type { CanonicalSemanticResponse, ModelProfile, ProviderAdapter, ProviderOutcome, ResolvedProviderAuth, SemanticRequest } from "../../../src/vnext/providers/contract.js";

export const BRIDGE_FIXTURE_REQUEST = "Build a deterministic local task tracker with a tested implementation.";

const profile: ModelProfile = {
  id: "fixture:ralph-bridge",
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
  conformance: { tier: "SUPPORTED", suiteVersion: "fixture/v1", runId: "fixture", recordedAt: "2026-09-10T00:00:00.000Z", normalizationsOnHappyPath: [], verifiedRecord: true },
};

const auth: ResolvedProviderAuth = { kind: "ambient-session", id: "fixture" };

class FixtureAdapter implements ProviderAdapter {
  readonly family = "fixture";
  readonly transport = "claude-code-cli" as const;
  readonly profiles = [profile];
  readonly requests: SemanticRequest[] = [];

  constructor(private readonly script: unknown[]) {}

  checkCapabilities(): ProviderOutcome<true> { return { ok: true, value: true }; }

  async request(_profile: ModelProfile, _auth: ResolvedProviderAuth, request: SemanticRequest): Promise<ProviderOutcome<CanonicalSemanticResponse>> {
    this.requests.push(request);
    const payload = this.script.shift();
    if (payload === undefined) throw new Error("fixture script exhausted");
    return {
      ok: true,
      value: {
        slice: request.slice,
        payload: structuredClone(payload),
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
          startedAt: "2026-09-10T00:00:00.000Z",
          completedAt: "2026-09-10T00:00:00.001Z",
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

export interface ReadyBridgeFixture {
  readonly root: string;
  readonly taskCount: number;
}

export async function createReadyBridgeFixture(options: {
  readonly taskCount?: 1 | 2 | 4;
  readonly humanValidation?: boolean;
  readonly humanValidationTask?: number;
} = {}): Promise<ReadyBridgeFixture> {
  const taskCount = options.taskCount ?? 2;
  const root = await mkdtemp(resolve(tmpdir(), "rb-progressive-ralph-bridge-"));
  await mkdir(resolve(root, "src"), { recursive: true });
  await writeFile(resolve(root, "README.md"), "fixture baseline\n");

  await runProgressiveInit({
    projectRoot: root,
    originalRequest: BRIDGE_FIXTURE_REQUEST,
    selectedStage: "project-description",
    profile,
    adapter: new FixtureAdapter([projectDescriptionPayload()]),
    auth,
    interview: { kind: "headless" },
  });
  await runProgressiveInit({
    projectRoot: root,
    originalRequest: BRIDGE_FIXTURE_REQUEST,
    selectedStage: "user-stories",
    profile,
    adapter: new FixtureAdapter([userStoriesQuestionsPayload(), userStoriesPayload()]),
    auth,
    interview: { kind: "headless" },
  });

  const project = await loadProjectDescription(root);
  if (!project) throw new Error("missing P1 fixture authority");
  const storiesProjection = userStoriesUpstreamProjection(project.document.value);
  const stories = await loadUserStories(root, storiesProjection);
  if (!stories) throw new Error("missing P2 fixture authority");
  const databaseProjection = databaseSchemaUpstreamProjection(stories.document.value, userStoriesUpstreamProjectionSha256(storiesProjection));
  const persistenceSubject = enumerateStoryPersistenceSubjects(databaseProjection)[0];
  if (!persistenceSubject) throw new Error("missing fixture persistence subject");
  await runProgressiveInit({
    projectRoot: root,
    originalRequest: BRIDGE_FIXTURE_REQUEST,
    selectedStage: "database-schema",
    profile,
    adapter: new FixtureAdapter([{
      contract: "rb-database-schema-persistence-questions/v1",
      stage: "database-schema",
      recommendations: [{
        subjectKey: persistenceSubject.key,
        recommendedOptionKey: "not-persisted",
        question: "Does this task tracker need durable application persistence?",
        rationale: "The approved bridge fixture is file-output only.",
      }],
    }]),
    auth,
    interview: { kind: "interactive", answer: async () => "" },
  });

  const p4 = await currentP4Upstream(root);
  await runProgressiveInit({
    projectRoot: root,
    originalRequest: BRIDGE_FIXTURE_REQUEST,
    selectedStage: "project-phases",
    profile,
    adapter: new FixtureAdapter([projectPhasesPayload(p4, taskCount, options.humanValidationTask ?? (options.humanValidation ? 1 : undefined))]),
    auth,
    interview: { kind: "interactive", answer: async () => "approve" },
  });
  return { root, taskCount };
}

async function currentP4Upstream(root: string): Promise<ProjectPhasesUpstreamProjection> {
  const project = await loadProjectDescription(root);
  if (!project) throw new Error("missing P1 fixture authority");
  const storiesProjection = userStoriesUpstreamProjection(project.document.value);
  const stories = await loadUserStories(root, storiesProjection);
  if (!stories) throw new Error("missing P2 fixture authority");
  const databaseProjection = databaseSchemaUpstreamProjection(stories.document.value, userStoriesUpstreamProjectionSha256(storiesProjection));
  const database = await loadDatabaseSchema(root, databaseProjection);
  if (!database) throw new Error("missing P3 fixture authority");
  return projectPhasesUpstreamProjection(project.document.value, stories.document.value, database.document.value, {
    projectDescriptionAuthoritativeInputSha256: project.document.metadata.authoritativeInputSha256,
    userStoriesUpstreamProjectionSha256: stories.document.metadata.upstreamProjectionSha256,
    userStoriesAuthoritativeInputSha256: stories.document.metadata.authoritativeInputSha256,
    databaseSchemaUpstreamProjectionSha256: database.document.metadata.upstreamProjectionSha256,
    databaseSchemaAuthoritativeInputSha256: database.document.metadata.authoritativeInputSha256,
  });
}

function projectDescriptionPayload() {
  return {
    contract: "rb-project-description/v1",
    stage: "project-description",
    originalRequest: BRIDGE_FIXTURE_REQUEST,
    project: { key: "bridge-fixture", name: "Bridge Fixture", objective: "Produce deterministic task implementation files." },
    actors: [{ key: "developer", name: "Developer", responsibility: "Uses the generated local task implementation." }],
    capabilities: [{ key: "manage-tasks", statement: "Create and inspect a local task." }],
    workflows: [{ key: "task-flow", statement: "A developer creates and inspects a local task.", actorKeys: ["developer"], capabilityKeys: ["manage-tasks"] }],
    constraints: [{ key: "deterministic-output", statement: "Implementation output must remain deterministic." }],
    determinations: [],
    qualityCommands: [{ key: "tests", kind: "test", command: "test -f src/first.txt" }],
    questions: [],
  };
}

function userStoriesQuestionsPayload() {
  return { contract: "rb-user-stories-questions/v1", stage: "user-stories", participationRecommendations: [], questions: [] };
}

function userStoriesPayload() {
  return {
    contract: "rb-user-stories/v1",
    stage: "user-stories",
    projectKey: "bridge-fixture",
    stories: [{
      key: "create-task",
      workflowKey: "task-flow",
      capabilityKeys: ["manage-tasks"],
      actorKey: "developer",
      operatorActorKey: "developer",
      intent: "Create a local task",
      outcome: "The task is available for inspection",
      acceptance: ["The created task is available for deterministic inspection."],
    }],
  };
}

function projectPhasesPayload(authority: ProjectPhasesUpstreamProjection, taskCount: 1 | 2 | 4, humanValidationTask?: number): ProjectPhasesProposalWire {
  const subjects = deriveImplementationSubjects(authority).map((subject) => subject.key);
  const words = ["first", "second", "third", "fourth"] as const;
  const tasks: Array<ProjectPhasesProposalWire["phases"][number]["tasks"][number]> = [];
  for (let index = 0; index < taskCount; index += 1) {
    const word = words[index]!;
    const human = humanValidationTask === index + 1;
    tasks.push({
      key: `write-${word}`,
      title: `Write ${word} implementation slice`,
      intent: `Create the ${word} deterministic implementation file for the approved task workflow.`,
      dependsOn: index === 0 ? [] : [`write-${words[index - 1]!}`],
      ownedPaths: [`src/${word}.txt`],
      coverageKeys: taskCount === 1 ? subjects : index === taskCount - 1 && subjects.length > 1 ? subjects.slice(1) : subjects.slice(0, 1),
      acceptance: [`The ${word} deterministic implementation file exists${index === 0 ? "" : " after its dependency"}.`],
      validation: human
        ? [{ kind: "human", evidence: "A human confirms keyboard and touch flows on mobile and desktop viewports." }]
        : [{ kind: "command", commandKey: "tests" }],
      expectedEvidence: human ? "An exact-bound operator Human decision." : "Passing output from the approved tests command.",
    });
  }
  return {
    phases: [{
      key: "implementation",
      title: "Implement deterministic task workflow",
      goal: "Deliver the approved deterministic task implementation.",
      tasks,
    }],
  };
}
