import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Text } from "../../src/hash.js";
import { validateManifestTree } from "../../src/manifest.js";
import { semanticKey } from "../../src/vnext/identity.js";
import { resolveInitProject } from "../../src/vnext/resolve.js";
import { validate } from "../../src/vnext/validate.js";
import { executeProgressiveInitCommand, type ProgressiveInitCliRuntime } from "../../src/vnext/progressive-init/cli.js";
import { inspectProgressiveInit, runProgressiveInit } from "../../src/vnext/progressive-init/coordinator.js";
import { databaseSchemaUpstreamProjection, enumerateStoryPersistenceSubjects } from "../../src/vnext/progressive-init/database-schema-ir.js";
import { loadDatabaseSchema } from "../../src/vnext/progressive-init/database-schema-store.js";
import { loadProjectDescription } from "../../src/vnext/progressive-init/project-description-store.js";
import {
  inspectProjectPhasesClosure,
  publishProjectPhasesClosure,
} from "../../src/vnext/progressive-init/project-phases-closure.js";
import {
  compileProjectPhasesToSemanticInitProject,
  validateCompiledProjectPhases,
} from "../../src/vnext/progressive-init/project-phases-compiler.js";
import {
  parseProjectPhasesDocument,
  renderProjectPhasesDocument,
} from "../../src/vnext/progressive-init/project-phases-document.js";
import {
  PROJECT_PHASES_CONTRACT,
  decodeProjectPhasesProposalWire,
  deriveImplementationSubjects,
  projectPhasesAuthoritativeInputSha256,
  projectPhasesUpstreamProjection,
  projectPhasesUpstreamProjectionSha256,
  resolveProjectPhasesProposal,
  validateProjectPhases,
  type ProjectPhases,
  type ProjectPhasesProposalWire,
  type ProjectPhasesUpstreamProjection,
} from "../../src/vnext/progressive-init/project-phases-ir.js";
import { runProjectPhasesOperation } from "../../src/vnext/progressive-init/project-phases-operation.js";
import { loadUserStories } from "../../src/vnext/progressive-init/user-stories-store.js";
import { userStoriesUpstreamProjection, userStoriesUpstreamProjectionSha256 } from "../../src/vnext/progressive-init/user-stories-ir.js";
import type {
  CanonicalSemanticResponse,
  ModelProfile,
  ProviderAdapter,
  ProviderOutcome,
  ResolvedProviderAuth,
  SemanticRequest,
} from "../../src/vnext/providers/contract.js";

const key = (value: string) => semanticKey(value)!;
const REQUEST = "Build an issue tracker where developers create issues and reviewers inspect status.";

const profile: ModelProfile = {
  id: "fixture:progressive-phase4",
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
  conformance: { tier: "SUPPORTED", suiteVersion: "fixture/v1", runId: "fixture", recordedAt: "2026-08-31T00:00:00.000Z", normalizationsOnHappyPath: [], verifiedRecord: true },
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
    const payload = this.script.shift();
    if (payload === undefined) throw new Error("script exhausted");
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
          startedAt: "2026-08-31T00:00:00.000Z",
          completedAt: "2026-08-31T00:00:00.001Z",
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

function upstream(disposition: "applicable" | "not-applicable" = "applicable"): ProjectPhasesUpstreamProjection {
  const project = {
    contract: "rb-project-description/v1" as const,
    stage: "project-description" as const,
    originalRequest: REQUEST,
    project: { key: key("issue-tracker"), name: "Issue Tracker", objective: "Track issues and expose their current status." },
    actors: [
      { key: key("developer"), name: "Developer", responsibility: "Creates and maintains issues." },
      { key: key("reviewer"), name: "Reviewer", responsibility: "Inspects issue status." },
    ],
    capabilities: [{ key: key("manage-issues"), statement: "Create an issue and expose its current status." }],
    workflows: [{ key: key("issue-flow"), statement: "A developer creates an issue for reviewer inspection.", actorKeys: [key("developer"), key("reviewer")], capabilityKeys: [key("manage-issues")] }],
    constraints: [{ key: key("offline-first"), statement: "The application must preserve complete issue data while temporarily offline; delimiter | and newline text \\n remain literal data." }],
    determinations: [
      { key: key("single-workspace"), statement: "Use one workspace per deployment.", rationale: "The approved MVP has no tenant boundary.", materiality: "product" as const, rigidity: "RIGID" as const, source: { kind: "developer" as const } },
      { key: key("layered-core"), statement: "Keep domain logic independent from transport adapters.", rationale: "The approved architecture requires replaceable transports.", materiality: "architecture" as const, rigidity: "RIGID" as const, source: { kind: "developer" as const } },
    ],
    qualityCommands: [{ key: key("tests"), kind: "test" as const, command: "npm test" }],
  };
  const stories = {
    contract: "rb-user-stories/v1" as const,
    stage: "user-stories" as const,
    projectKey: project.project.key,
    determinations: [],
    structuralDecisions: [],
    stories: [{
      key: key("create-issue"),
      storyId: "US-1.1",
      workflowKey: key("issue-flow"),
      capabilityKeys: [key("manage-issues")],
      actorKey: key("developer"),
      operatorActorKey: key("reviewer"),
      intent: "Create an issue with a status",
      outcome: "The reviewer can inspect the current issue status",
      acceptance: ["The issue form is visually aligned at 1440x900.", "The saved status is returned with the issue."],
    }],
  };
  const tables = disposition === "applicable" ? [
    {
      key: key("issues"), name: "issues", purpose: "Stores approved issue records.",
      fields: [
        { key: key("issue-id"), name: "id", logicalType: "uuid" as const, required: true },
        { key: key("issue-title"), name: "title", logicalType: "string" as const, required: true },
        { key: key("status-id"), name: "status_id", logicalType: "uuid" as const, required: true },
      ],
      primaryKeyFieldKeys: [key("issue-id")],
      uniqueConstraints: [{ fieldKeys: [key("issue-title")] }],
    },
    {
      key: key("statuses"), name: "statuses", purpose: "Stores the approved issue status vocabulary.",
      fields: [{ key: key("status-key"), name: "id", logicalType: "uuid" as const, required: true }],
      primaryKeyFieldKeys: [key("status-key")], uniqueConstraints: [],
    },
  ] : [];
  const schema = {
    contract: "rb-database-schema/v1" as const,
    stage: "database-schema" as const,
    projectKey: project.project.key,
    determinations: [],
    structuralDecisions: [],
    disposition,
    storyCoverage: [{ storyKey: key("create-issue"), disposition: disposition === "applicable" ? "persisted" as const : "not-persisted" as const, tableKeys: tables.map((table) => table.key) }],
    tables,
    foreignKeys: disposition === "applicable" ? [{ fromTableKey: key("issues"), fromFieldKey: key("status-id"), toTableKey: key("statuses"), toFieldKey: key("status-key") }] : [],
  };
  return projectPhasesUpstreamProjection(project, stories, schema, {
    projectDescriptionAuthoritativeInputSha256: "a".repeat(64),
    userStoriesUpstreamProjectionSha256: "b".repeat(64),
    userStoriesAuthoritativeInputSha256: "c".repeat(64),
    databaseSchemaUpstreamProjectionSha256: "d".repeat(64),
    databaseSchemaAuthoritativeInputSha256: "e".repeat(64),
  });
}

function proposal(authority: ProjectPhasesUpstreamProjection): ProjectPhasesProposalWire {
  return {
    phases: [{
      key: "implementation",
      title: "Implement issue tracking",
      goal: "Deliver the approved issue workflow and persistence responsibilities.",
      tasks: [{
        key: "implement-issues",
        title: "Implement issue creation",
        intent: "Implement issue creation, status persistence, and reviewer retrieval in the application code.",
        dependsOn: [],
        ownedPaths: ["src/issues"],
        coverageKeys: deriveImplementationSubjects(authority).map((subject) => subject.key),
        acceptance: ["Creating an issue stores its status and makes the same status available to reviewer retrieval."],
        validation: [{ kind: "command", commandKey: "tests" }],
        expectedEvidence: "Passing automated test output for issue creation, persistence, and reviewer retrieval.",
      }],
    }],
  };
}

function phases(authority: ProjectPhasesUpstreamProjection): ProjectPhases {
  return resolveProjectPhasesProposal(proposal(authority), authority);
}

const p1Payload = () => ({
  contract: "rb-project-description/v1",
  stage: "project-description",
  originalRequest: REQUEST,
  project: { key: "issue-tracker", name: "Issue Tracker", objective: "Track issues and expose their current status." },
  actors: [{ key: "developer", name: "Developer", responsibility: "Creates and reviews issues." }],
  capabilities: [{ key: "manage-issues", statement: "Create an issue and inspect its current status." }],
  workflows: [{ key: "issue-flow", statement: "A developer creates and inspects an issue.", actorKeys: ["developer"], capabilityKeys: ["manage-issues"] }],
  constraints: [{ key: "offline-first", statement: "The application must preserve complete issue data while temporarily offline." }],
  determinations: [],
  qualityCommands: [{ key: "tests", kind: "test", command: "npm test" }],
  questions: [],
});

const p2Payload = () => ({
  contract: "rb-user-stories/v1",
  stage: "user-stories",
  projectKey: "issue-tracker",
  stories: [{
    key: "create-issue", workflowKey: "issue-flow", capabilityKeys: ["manage-issues"], actorKey: "developer", operatorActorKey: "developer",
    intent: "Create and inspect an issue", outcome: "The current issue status is available", acceptance: ["The saved issue returns its current status."],
  }],
});

const emptyP2Questions = () => ({ contract: "rb-user-stories-questions/v1", stage: "user-stories", participationRecommendations: [], questions: [] });

async function currentP4Upstream(root: string): Promise<ProjectPhasesUpstreamProjection> {
  const project = await loadProjectDescription(root);
  if (!project) throw new Error("missing P1 fixture");
  const storiesUpstream = userStoriesUpstreamProjection(project.document.value);
  const stories = await loadUserStories(root, storiesUpstream);
  if (!stories) throw new Error("missing P2 fixture");
  const databaseUpstream = databaseSchemaUpstreamProjection(stories.document.value, userStoriesUpstreamProjectionSha256(storiesUpstream));
  const database = await loadDatabaseSchema(root, databaseUpstream);
  if (!database) throw new Error("missing P3 fixture");
  return projectPhasesUpstreamProjection(project.document.value, stories.document.value, database.document.value, {
    projectDescriptionAuthoritativeInputSha256: project.document.metadata.authoritativeInputSha256,
    userStoriesUpstreamProjectionSha256: stories.document.metadata.upstreamProjectionSha256,
    userStoriesAuthoritativeInputSha256: stories.document.metadata.authoritativeInputSha256,
    databaseSchemaUpstreamProjectionSha256: database.document.metadata.upstreamProjectionSha256,
    databaseSchemaAuthoritativeInputSha256: database.document.metadata.authoritativeInputSha256,
  });
}

async function seedP1P2P3(root: string): Promise<ProjectPhasesUpstreamProjection> {
  await runProgressiveInit({
    projectRoot: root, originalRequest: REQUEST, selectedStage: "project-description", profile,
    adapter: new Adapter([p1Payload()]), auth, interview: { kind: "headless" },
  });
  await runProgressiveInit({
    projectRoot: root, originalRequest: REQUEST, selectedStage: "user-stories", profile,
    adapter: new Adapter([emptyP2Questions(), p2Payload()]), auth, interview: { kind: "headless" },
  });
  const project = await loadProjectDescription(root);
  if (!project) throw new Error("missing P1 fixture");
  const storiesUpstream = userStoriesUpstreamProjection(project.document.value);
  const stories = await loadUserStories(root, storiesUpstream);
  if (!stories) throw new Error("missing P2 fixture");
  const databaseUpstream = databaseSchemaUpstreamProjection(stories.document.value, userStoriesUpstreamProjectionSha256(storiesUpstream));
  const subject = enumerateStoryPersistenceSubjects(databaseUpstream)[0]!;
  await runProgressiveInit({
    projectRoot: root, originalRequest: REQUEST, selectedStage: "database-schema", profile,
    adapter: new Adapter([{
      contract: "rb-database-schema-persistence-questions/v1", stage: "database-schema",
      recommendations: [{ subjectKey: subject.key, recommendedOptionKey: "not-persisted", question: "Does this story require application persistence?", rationale: "The approved workflow can remain non-persistent." }],
    }]),
    auth,
    interview: { kind: "interactive", answer: async () => "" },
  });
  return currentP4Upstream(root);
}

describe("Progressive Init Phase 4 project-phases", () => {
  it("derives the exact closed subject universe with bounded stable keys", () => {
    const applicable = deriveImplementationSubjects(upstream());
    expect(applicable.map((entry) => entry.kind)).toEqual(["constraint", "story", "table", "table"]);
    expect(applicable.every((entry) => /^[a-z][a-z0-9-]{1,47}$/.test(entry.key))).toBe(true);
    expect(deriveImplementationSubjects(upstream())).toEqual(applicable);
    expect(deriveImplementationSubjects(upstream("not-applicable")).map((entry) => entry.kind)).toEqual(["constraint", "story"]);
    expect(applicable.some((entry) => entry.sourceKey === key("single-workspace"))).toBe(false);
    expect(applicable.some((entry) => entry.sourceKey === key("developer") || entry.sourceKey === key("manage-issues") || entry.sourceKey === key("tests"))).toBe(false);
  });

  it("fails closed on a duplicate source identity before a subject collision can become authority", () => {
    const authority = structuredClone(upstream()) as any;
    authority.projectDescription.constraints.push(structuredClone(authority.projectDescription.constraints[0]));
    expect(() => deriveImplementationSubjects(authority)).toThrow("PROJECT_PHASES_SUBJECT_COLLISION");
  });

  it("bounds subject identity for maximum-length upstream keys in every category", () => {
    const authority = structuredClone(upstream()) as any;
    const constraintKey = "c".repeat(48);
    const storyKey = "s".repeat(48);
    const firstTableKey = "t".repeat(48);
    const secondTableKey = "u".repeat(48);
    authority.projectDescription.constraints[0].key = constraintKey;
    authority.userStories.stories[0].key = storyKey;
    authority.databaseSchema.storyCoverage[0].storyKey = storyKey;
    authority.databaseSchema.storyCoverage[0].tableKeys = [firstTableKey, secondTableKey];
    authority.databaseSchema.tables[0].key = firstTableKey;
    authority.databaseSchema.tables[1].key = secondTableKey;
    authority.databaseSchema.foreignKeys[0].fromTableKey = firstTableKey;
    authority.databaseSchema.foreignKeys[0].toTableKey = secondTableKey;
    const subjects = deriveImplementationSubjects(authority);
    expect(subjects).toHaveLength(4);
    expect(subjects.every((subject) => subject.key.length <= 48 && /^[a-z][a-z0-9-]+$/.test(subject.key))).toBe(true);
  });

  it("rejects every forbidden provider authority field instead of stripping it", () => {
    const forbidden = [
      "contract", "stage", "projectKey", "implementationSubjects", "requirements", "covers", "developerAuthority",
      "determinations", "protectedPaths", "id", "parallelSafe", "upstreamSha256", "authoritativeInputSha256",
      "proposalSha256", "approval", "runId", "generatedAt", "manifest", "markdown", "provider", "model", "profile",
    ];
    for (const field of forbidden) {
      const decoded = decodeProjectPhasesProposalWire({ ...proposal(upstream()), [field]: "forbidden" });
      expect(decoded.ok, field).toBe(false);
      if (!decoded.ok) expect(decoded.findings.some((entry) => entry.pointer === `//${field}` || entry.pointer === `/${field}`)).toBe(true);
    }
  });

  it("rejects unknown coverage, empty task coverage, unsafe paths, invented commands, and illegal dependencies", () => {
    const authority = upstream();
    const mutations: Array<(value: ProjectPhases) => void> = [
      (value) => { (value.phases[0]!.tasks[0]!.coverageKeys as any) = [key("unknown-subject")]; },
      (value) => { (value.phases[0]!.tasks[0]!.coverageKeys as any) = []; },
      (value) => { (value.phases[0]!.tasks[0]!.ownedPaths as any) = [".rb/init/PHASES.md"]; },
      (value) => { (value.phases[0]!.tasks[0]!.validation as any) = [{ kind: "command", commandKey: "invented" }]; },
      (value) => { (value.phases[0]!.tasks[0]!.dependsOn as any) = [key("missing-task")]; },
    ];
    for (const mutate of mutations) {
      const value = structuredClone(phases(authority));
      mutate(value);
      expect(validateProjectPhases(value, authority).ok).toBe(false);
    }
  });

  it("enforces dependency ordering, cycles, and canonical ceilings before approval", () => {
    const authority = upstream();
    const base = phases(authority);
    const secondTask = {
      ...structuredClone(base.phases[0]!.tasks[0]!),
      key: key("second-task"), title: "Implement second slice", ownedPaths: ["src/second"], dependsOn: [key("implement-issues")],
    };
    const self = structuredClone(base);
    (self.phases[0]!.tasks[0] as any).dependsOn = ["implement-issues"];
    expect(validateProjectPhases(self, authority).ok).toBe(false);
    const cycle = structuredClone(base);
    (cycle.phases[0]!.tasks as any).push(secondTask);
    (cycle.phases[0]!.tasks[0] as any).dependsOn = ["second-task"];
    expect(validateProjectPhases(cycle, authority).ok).toBe(false);
    const laterPhase = structuredClone(base);
    (laterPhase.phases as any).push({ key: key("later-phase"), title: "Later work", goal: "Deliver later work.", tasks: [secondTask] });
    (laterPhase.phases[0]!.tasks[0] as any).dependsOn = ["second-task"];
    expect(validateProjectPhases(laterPhase, authority).ok).toBe(false);
    const acceptanceCeiling = structuredClone(base);
    (acceptanceCeiling.phases[0]!.tasks[0] as any).acceptance = Array.from({ length: 7 }, (_, index) => `Observable implementation outcome ${index + 1} is present.`);
    expect(validateProjectPhases(acceptanceCeiling, authority).ok).toBe(false);
    const pathCeiling = structuredClone(base);
    (pathCeiling.phases[0]!.tasks[0] as any).ownedPaths = Array.from({ length: 9 }, (_, index) => `src/future-${index + 1}`);
    expect(validateProjectPhases(pathCeiling, authority).ok).toBe(false);
    const taskCeiling = structuredClone(base);
    (taskCeiling.phases[0]!.tasks as any) = Array.from({ length: 13 }, (_, index) => ({
      ...structuredClone(base.phases[0]!.tasks[0]!), key: key(`bounded-task-${index + 1}`), ownedPaths: [`src/future-${index + 1}`],
    }));
    expect(validateProjectPhases(taskCeiling, authority).ok).toBe(false);
    const future = structuredClone(base);
    (future.phases[0]!.tasks[0] as any).ownedPaths = ["future/not-created-yet.ts"];
    expect(validateProjectPhases(future, authority).ok).toBe(true);
  });

  it("accepts typed table coverage independently of read-only, frontend, or documentation prose", () => {
    const authority = upstream();
    const subjectKeys = deriveImplementationSubjects(authority).map((subject) => subject.key);
    for (const [title, intent] of [
      ["Read-only report view and persistence", "Read-only access for the frontend."],
      ["Frontend issue presentation", "Frontend-only delivery for issue status."],
      ["Issue documentation", "Documentation-only description of issue records."],
    ]) {
      const value = phases(authority);
      (value.phases[0]!.tasks[0] as any).title = title;
      (value.phases[0]!.tasks[0] as any).intent = intent;
      (value.phases[0]!.tasks[0] as any).coverageKeys = subjectKeys;
      expect(validateProjectPhases(value, authority), `${title}: ${intent}`).toMatchObject({ ok: true });
    }
  });

  it("grants implement, create, and persist prose no structural coverage privilege", () => {
    const authority = upstream();
    for (const word of ["implement", "create", "persist"]) {
      const unknown = phases(authority);
      (unknown.phases[0]!.tasks[0] as any).title = `${word} issue storage`;
      (unknown.phases[0]!.tasks[0] as any).intent = `${word} the approved data structure.`;
      (unknown.phases[0]!.tasks[0] as any).coverageKeys = [key("unknown-subject")];
      expect(validateProjectPhases(unknown, authority).ok, word).toBe(false);

      const empty = phases(authority);
      (empty.phases[0]!.tasks[0] as any).title = `${word} issue storage`;
      (empty.phases[0]!.tasks[0] as any).intent = `${word} the approved data structure.`;
      (empty.phases[0]!.tasks[0] as any).coverageKeys = [];
      expect(validateProjectPhases(empty, authority).ok, word).toBe(false);
    }
  });

  it("allows multiple tasks per subject and multiple subjects per task while preserving direct covers mapping", () => {
    const authority = upstream();
    const value = structuredClone(phases(authority));
    const first = value.phases[0]!.tasks[0]!;
    (value.phases[0]!.tasks as any).push({
      ...structuredClone(first), key: key("verify-issues"), title: "Verify issue behavior", dependsOn: [first.key], ownedPaths: ["test/issues"],
    });
    expect(validateProjectPhases(value, authority).ok).toBe(true);
    const semantic = compileProjectPhasesToSemanticInitProject(authority, value);
    expect(semantic.phases[0]!.tasks[0]!.covers).toEqual(first.coverageKeys);
    expect(semantic.phases[0]!.tasks[1]!.covers).toEqual(first.coverageKeys);
  });

  it("projects complete P1/P2/P3 authority to one single-line requirement per subject", () => {
    const authority = upstream();
    const subjects = deriveImplementationSubjects(authority);
    const semantic = compileProjectPhasesToSemanticInitProject(authority, phases(authority));
    expect(semantic.requirements).toHaveLength(subjects.length);
    expect(semantic.requirements.map((entry) => entry.key)).toEqual(subjects.map((entry) => entry.key));
    expect(semantic.requirements.every((entry) => !/[\n\r\t]/.test(entry.statement))).toBe(true);
    const combined = semantic.requirements.map((entry) => entry.statement).join("\n");
    expect(combined).toContain("offline-first");
    expect(combined).toContain("US-1.1");
    expect(combined).toContain("Developer");
    expect(combined).toContain("Reviewer");
    expect(combined).toContain("issue-flow");
    expect(combined).toContain("manage-issues");
    expect(combined).toContain("visually aligned at 1440x900");
    expect(combined).toContain("logicalType");
    expect(combined).toContain("primaryKeyFieldKeys");
    expect(combined).toContain("uniqueConstraints");
    expect(combined).toContain("fromTableKey");
  });

  it("compiles P1 determinations with Core-generated developer provenance and no coverage subjects", () => {
    const authority = upstream();
    const semantic = compileProjectPhasesToSemanticInitProject(authority, phases(authority));
    expect(semantic.determinations).toHaveLength(2);
    expect(semantic.determinations.every((entry) => entry.source.kind === "developer" && entry.key.startsWith("determination-"))).toBe(true);
    const result = resolveInitProject(semantic, { originalRequest: REQUEST, runId: "phase4-test", generatedAt: "2026-08-31T00:00:00.000Z" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(validate(result.value).valid).toBe(true);
      expect(result.value.core.determinations.every((entry) => entry.source.kind === "developer")).toBe(true);
      expect(result.value.phases.every((phase) => phase.dependsOn.length === 0)).toBe(true);
      expect(result.value.phases.flatMap((phase) => phase.tasks).every((task) => task.parallelSafe === false)).toBe(true);
    }
  });

  it("compiles applicable and not-applicable projects with zero canonical findings", () => {
    for (const disposition of ["applicable", "not-applicable"] as const) {
      const authority = upstream(disposition);
      const compiled = validateCompiledProjectPhases(authority, phases(authority), {
        originalRequest: REQUEST, runId: `compile-${disposition}`, generatedAt: "2026-08-31T00:00:00.000Z",
      });
      expect(compiled.ok).toBe(true);
      if (compiled.ok && disposition === "not-applicable") {
        expect(compiled.semantic.requirements.some((entry) => entry.statement.startsWith("P3 logical table"))).toBe(false);
      }
    }
  });

  it("accepts legal manual-only and human-only task validation without inventing commands", () => {
    const authority = upstream();
    for (const validation of [
      [{ kind: "manual", inspection: "Inspect the created issue record and compare every stored status field with the submitted values." }],
      [{ kind: "human", evidence: "A developer confirms the offline recovery scenario preserves the complete issue record." }],
    ] as const) {
      const value = structuredClone(phases(authority));
      (value.phases[0]!.tasks[0] as any).validation = validation;
      expect(validateProjectPhases(value, authority).ok).toBe(true);
      expect(validateCompiledProjectPhases(authority, value, {
        originalRequest: REQUEST, runId: `validation-${validation[0].kind}`, generatedAt: "2026-08-31T00:00:00.000Z",
      }).ok).toBe(true);
    }
  });

  it("uses one provider operation on the healthy path and requires explicit nonblank approval", async () => {
    const authority = upstream();
    const adapter = new Adapter([proposal(authority)]);
    const questions: string[] = [];
    const result = await runProjectPhasesOperation({
      upstream: authority, profile, adapter, auth, deadlineMs: 120_000,
      interview: { kind: "interactive", answer: async (question) => { questions.push(question.question); return questions.length === 1 ? "" : "approve"; } },
      onQuestion: () => undefined,
    });
    expect(result.semanticOperations).toBe(1);
    expect(result.correctiveRegenerations).toBe(0);
    expect(adapter.requests.map((entry) => entry.slice)).toEqual(["project-phases"]);
    expect(questions).toHaveLength(2);
    expect(questions[0]).toContain(JSON.stringify(result.value, null, 2));
    expect(questions[1]).toContain("blank is not accepted");
  });

  it("performs only whole-candidate corrective regeneration before a new approval presentation", async () => {
    const authority = upstream();
    const invalid = structuredClone(proposal(authority)) as any;
    invalid.phases[0].tasks[0].coverageKeys = ["unknown-subject"];
    const adapter = new Adapter([invalid, proposal(authority)]);
    const shown: string[] = [];
    const result = await runProjectPhasesOperation({
      upstream: authority, profile, adapter, auth, deadlineMs: 120_000,
      interview: { kind: "interactive", answer: async () => "approve" },
      onQuestion: (question) => { shown.push(question.question); },
    });
    expect(result.semanticOperations).toBe(2);
    expect(result.correctiveRegenerations).toBe(1);
    expect(result.findingsByAttempt).toHaveLength(1);
    expect(shown).toHaveLength(1);
    const recoveryInput = JSON.parse(adapter.requests[1]!.input);
    expect(recoveryInput.recovery.completeCandidateRegeneration).toBe(true);
  });

  it("renders a deterministic Core-owned evolution summary before the complete candidate", async () => {
    const authority = upstream();
    const existing = phases(authority);
    const changedWire = structuredClone(proposal(authority));
    (changedWire.phases[0]!.tasks[0] as any).ownedPaths = ["src/issue-service"];
    const adapter = new Adapter([changedWire]);
    let displayed = "";
    await runProjectPhasesOperation({
      upstream: authority, existing, profile, adapter, auth, deadlineMs: 120_000,
      interview: { kind: "interactive", answer: async () => "approve" },
      onQuestion: (question) => { displayed = question.question; },
    });
    expect(displayed).toContain("Project phases change summary (Core-generated)");
    expect(displayed).toContain("Owned paths changed: implement-issues");
    expect(displayed).toContain("Project phases proposal");
  });

  it("round-trips the strict document and treats a valid direct body edit as developer authority", () => {
    const authority = upstream();
    const value = phases(authority);
    const upstreamHash = projectPhasesUpstreamProjectionSha256(authority);
    const source = renderProjectPhasesDocument(value, authority, {
      upstreamProjectionSha256: upstreamHash,
      authoritativeInputSha256: projectPhasesAuthoritativeInputSha256(upstreamHash),
    });
    const parsed = parseProjectPhasesDocument(source, authority);
    expect(parsed.developerModified).toBe(false);
    expect(parsed.value).toEqual(value);
    const edited = source.replace('"title": "Implement issue tracking"', '"title": "Deliver issue tracking"');
    const direct = parseProjectPhasesDocument(edited, authority);
    expect(direct.developerModified).toBe(true);
    expect(direct.value.phases[0]!.title).toBe("Deliver issue tracking");
    expect(direct.metadata.authoritativeInputSha256).toBe(parsed.metadata.authoritativeInputSha256);
  });

  it("classifies structurally plausible removed table subjects as upstream reconciliation", () => {
    const oldAuthority = upstream();
    const upstreamHash = projectPhasesUpstreamProjectionSha256(oldAuthority);
    const source = renderProjectPhasesDocument(phases(oldAuthority), oldAuthority, {
      upstreamProjectionSha256: upstreamHash,
      authoritativeInputSha256: projectPhasesAuthoritativeInputSha256(upstreamHash),
    });
    const parsed = parseProjectPhasesDocument(source, upstream("not-applicable"));
    expect(parsed.upstreamCompatibilityFindings.length).toBeGreaterThan(0);
    expect(parsed.upstreamCompatibilityFindings.every((entry) => entry.code === "upstream")).toBe(true);
  });

  it("publishes exactly canonical BRIEF/PHASES/manifest with complete frozen semantics", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-progressive-phase4-closure-"));
    const authority = upstream();
    const result = await publishProjectPhasesClosure(root, authority, phases(authority));
    expect(result.closure.counters.providerCalls).toBe(0);
    expect(result.closure.brief).toContain("Track issues and expose their current status.");
    expect(result.closure.brief).toContain("offline-first");
    expect(result.closure.brief).toContain("Use one workspace per deployment.");
    expect(result.closure.brief).toContain("US-1.1");
    expect(result.closure.brief).toContain("visually aligned at 1440x900");
    expect(result.closure.brief).toContain("P3 logical table");
    expect(result.closure.brief).toContain("## Quality context\n\n- test");
    expect((await validateManifestTree(root)).valid).toBe(true);
    expect((await inspectProjectPhasesClosure(root, authority, phases(authority))).status).toBe("fresh");
    const manifest = JSON.parse(await readFile(resolve(root, ".rb/rb-manifest.json"), "utf8"));
    expect(manifest.artifacts).toHaveLength(2);
    for (const artifact of manifest.artifacts) expect(artifact.sha256).toBe(sha256Text(await readFile(resolve(root, artifact.path))));
  });

  it("detects missing/corrupt/older closure and deterministically republishes three consecutive times", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-progressive-phase4-republish-"));
    const authority = upstream();
    const value = phases(authority);
    expect((await inspectProjectPhasesClosure(root, authority, value)).status).toBe("stale");
    const first = await publishProjectPhasesClosure(root, authority, value);
    await writeFile(resolve(root, ".rb/init/BRIEF.md"), "corrupt\n");
    expect((await inspectProjectPhasesClosure(root, authority, value)).status).toBe("stale");
    const second = await publishProjectPhasesClosure(root, authority, value);
    const third = await publishProjectPhasesClosure(root, authority, value);
    expect(new Set([first.runId, second.runId, third.runId]).size).toBe(3);
    expect((await inspectProjectPhasesClosure(root, authority, value)).status).toBe("fresh");
    const manifestPath = resolve(root, ".rb/rb-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.generatedAt = "2020-01-01T00:00:00.000Z";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    expect((await inspectProjectPhasesClosure(root, authority, value)).status).toBe("fresh");
    await rm(resolve(root, ".rb"), { recursive: true });
    expect((await inspectProjectPhasesClosure(root, authority, value)).status).toBe("stale");
  });

  it("detects corrupt PHASES, inconsistent manifest, and closure from an older P4 body", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-progressive-phase4-corruption-"));
    const authority = upstream();
    const value = phases(authority);
    await publishProjectPhasesClosure(root, authority, value);
    await writeFile(resolve(root, ".rb/init/PHASES.md"), "corrupt phases\n");
    expect((await inspectProjectPhasesClosure(root, authority, value)).status).toBe("stale");
    await publishProjectPhasesClosure(root, authority, value);
    const manifestPath = resolve(root, ".rb/rb-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.artifacts[0].sha256 = "0".repeat(64);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    expect((await inspectProjectPhasesClosure(root, authority, value)).status).toBe("stale");
    await publishProjectPhasesClosure(root, authority, value);
    const edited = structuredClone(value);
    (edited.phases[0] as any).title = "Changed developer phase";
    expect((await inspectProjectPhasesClosure(root, authority, edited)).status).toBe("stale");
  });

  it("publishes no fake schema or database-first work for not-applicable P3 authority", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-progressive-phase4-no-db-"));
    const authority = upstream("not-applicable");
    const result = await publishProjectPhasesClosure(root, authority, phases(authority));
    expect(result.closure.brief).not.toContain("P3 logical table");
    expect(result.closure.phases).not.toMatch(/migration|database/i);
    expect(deriveImplementationSubjects(authority).some((subject) => subject.kind === "table")).toBe(false);
  });

  it("keeps declaration identity while canonical numeric IDs remain positional", () => {
    const authority = upstream();
    const original = phases(authority);
    const inserted = structuredClone(original);
    (inserted.phases as any).unshift({
      key: key("foundation"), title: "Prepare foundation", goal: "Prepare shared implementation support.",
      tasks: [{
        key: key("prepare-foundation"), title: "Prepare shared support", intent: "Create shared support used by issue implementation.",
        dependsOn: [], ownedPaths: ["src/foundation"], coverageKeys: [deriveImplementationSubjects(authority)[0]!.key],
        acceptance: ["Shared support is available to the issue implementation."], validation: [{ kind: "command", commandKey: "tests" }], expectedEvidence: "Passing automated test output for shared support.",
      }],
    });
    const remainingCoverage = new Set(inserted.phases[1]!.tasks[0]!.coverageKeys);
    expect(validateProjectPhases(inserted, authority).ok).toBe(true);
    expect(remainingCoverage.size).toBeGreaterThan(0);
    const first = validateCompiledProjectPhases(authority, original, { originalRequest: REQUEST, runId: "ids-one", generatedAt: "2026-08-31T00:00:00.000Z" });
    const second = validateCompiledProjectPhases(authority, inserted, { originalRequest: REQUEST, runId: "ids-two", generatedAt: "2026-08-31T00:00:00.000Z" });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.model.phases[0]!.tasks[0]!.key).toBe(second.model.phases[1]!.tasks[0]!.key);
      expect(first.model.phases[0]!.tasks[0]!.id).toBe("T001");
      expect(second.model.phases[1]!.tasks[0]!.id).toBe("T002");
    }
  });

  it("runs the focused P4 workflow, persists approved authority, closes canonically, and fully short-circuits a fresh rerun", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-progressive-phase4-coordinator-"));
    const authority = await seedP1P2P3(root);
    const adapter = new Adapter([proposal(authority)]);
    const result = await runProgressiveInit({
      projectRoot: root,
      originalRequest: REQUEST,
      selectedStage: "project-phases",
      profile,
      adapter,
      auth,
      interview: { kind: "interactive", answer: async () => "approve" },
    });
    expect(result).toMatchObject({ completedStage: "project-phases", semanticOperations: 1, correctiveRegenerations: 0 });
    expect(adapter.requests).toHaveLength(1);
    const specPath = resolve(root, ".spec/init/project-phases.md");
    const before = {
      spec: await readFile(specPath),
      brief: await readFile(resolve(root, ".rb/init/BRIEF.md")),
      phases: await readFile(resolve(root, ".rb/init/PHASES.md")),
      manifest: await readFile(resolve(root, ".rb/rb-manifest.json")),
    };
    expect((await inspectProgressiveInit(root, REQUEST))[3]).toMatchObject({ status: "complete-fresh", closureStatus: "fresh" });
    let writes = 0;
    const rerun = await runProgressiveInit({
      projectRoot: root, originalRequest: REQUEST, selectedStage: "project-phases", beforeWrite: () => { writes += 1; },
    });
    expect(rerun.semanticOperations).toBe(0);
    expect(writes).toBe(0);
    expect(await readFile(specPath)).toEqual(before.spec);
    expect(await readFile(resolve(root, ".rb/init/BRIEF.md"))).toEqual(before.brief);
    expect(await readFile(resolve(root, ".rb/init/PHASES.md"))).toEqual(before.phases);
    expect(await readFile(resolve(root, ".rb/rb-manifest.json"))).toEqual(before.manifest);
  });

  it("recloses missing or direct-edited authority headlessly with no profile/provider or P4 rewrite", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-progressive-phase4-headless-reclose-"));
    const authority = await seedP1P2P3(root);
    await runProgressiveInit({
      projectRoot: root, originalRequest: REQUEST, selectedStage: "project-phases", profile,
      adapter: new Adapter([proposal(authority)]), auth,
      interview: { kind: "interactive", answer: async () => "approve" },
    });
    const specPath = resolve(root, ".spec/init/project-phases.md");
    const source = await readFile(specPath, "utf8");
    const edited = source.replace('"title": "Implement issue tracking"', '"title": "Deliver issue tracking"');
    await writeFile(specPath, edited);
    expect((await inspectProgressiveInit(root, REQUEST))[3]).toMatchObject({ status: "complete-fresh", closureStatus: "stale" });
    const editedBytes = await readFile(specPath);
    const direct = await runProgressiveInit({ projectRoot: root, originalRequest: REQUEST, selectedStage: "project-phases" });
    expect(direct.semanticOperations).toBe(0);
    expect(await readFile(specPath)).toEqual(editedBytes);
    expect(await readFile(resolve(root, ".rb/init/PHASES.md"), "utf8")).toContain("## Phase 1: Deliver issue tracking");
    await rm(resolve(root, ".rb"), { recursive: true });
    expect((await inspectProgressiveInit(root, REQUEST))[3]).toMatchObject({ status: "complete-fresh", closureStatus: "stale" });
    const missing = await runProgressiveInit({ projectRoot: root, originalRequest: REQUEST, selectedStage: "project-phases", interview: { kind: "headless" } });
    expect(missing.semanticOperations).toBe(0);
    expect((await inspectProgressiveInit(root, REQUEST))[3]).toMatchObject({ status: "complete-fresh", closureStatus: "fresh" });
  });

  it("short-circuits profile resolution and writes on full-fresh CLI rerun, but deterministically writes missing closure", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-progressive-phase4-cli-short-circuit-"));
    const authority = await seedP1P2P3(root);
    await runProgressiveInit({
      projectRoot: root, originalRequest: REQUEST, selectedStage: "project-phases", profile,
      adapter: new Adapter([proposal(authority)]), auth,
      interview: { kind: "interactive", answer: async () => "approve" },
    });
    let profileResolution = 0;
    let compatibilityLookups = 0;
    let executions = 0;
    const runtime = {
      inputIsTTY: false,
      outputIsTTY: false,
      write: () => undefined,
      ask: async () => "",
      inspect: inspectProgressiveInit,
      listProfiles: () => { profileResolution += 1; return [profile]; },
      loadProfile: async () => { profileResolution += 1; return profile; },
      adapterFor: () => { profileResolution += 1; return new Adapter([]); },
      authFor: async () => { profileResolution += 1; return auth; },
      listClaudeCodeModels: async () => { compatibilityLookups += 1; return []; },
      inspectClaudeCodeModel: async () => { compatibilityLookups += 1; throw new Error("unused"); },
      verifyClaudeCodeModel: async () => { compatibilityLookups += 1; throw new Error("unused"); },
      execute: async (options) => { executions += 1; return runProgressiveInit(options); },
    } satisfies ProgressiveInitCliRuntime;
    const options = { requestParts: [REQUEST], projectRoot: root, headless: true, deadlineSeconds: 120, stage: "project-phases" as const };
    const before = await Promise.all([
      readFile(resolve(root, ".spec/init/project-phases.md")),
      readFile(resolve(root, ".rb/init/BRIEF.md")),
      readFile(resolve(root, ".rb/init/PHASES.md")),
      readFile(resolve(root, ".rb/rb-manifest.json")),
    ]);
    await executeProgressiveInitCommand(options, runtime);
    expect(profileResolution).toBe(0);
    expect(compatibilityLookups).toBe(0);
    expect(executions).toBe(1);
    expect(await Promise.all([
      readFile(resolve(root, ".spec/init/project-phases.md")),
      readFile(resolve(root, ".rb/init/BRIEF.md")),
      readFile(resolve(root, ".rb/init/PHASES.md")),
      readFile(resolve(root, ".rb/rb-manifest.json")),
    ])).toEqual(before);
    await rm(resolve(root, ".rb"), { recursive: true });
    await executeProgressiveInitCommand(options, runtime);
    expect(profileResolution).toBe(0);
    expect(compatibilityLookups).toBe(0);
    expect(executions).toBe(2);
    expect((await inspectProgressiveInit(root, REQUEST))[3]).toMatchObject({ status: "complete-fresh", closureStatus: "fresh" });
  });

  it("fails incomplete P4 headlessly before profile resolution and preserves bytes on rejection", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-progressive-phase4-headless-boundary-"));
    const authority = await seedP1P2P3(root);
    let profileLookups = 0;
    let compatibilityLookups = 0;
    let executions = 0;
    const runtime = {
      inputIsTTY: false,
      outputIsTTY: false,
      write: () => undefined,
      ask: async () => "",
      inspect: inspectProgressiveInit,
      listProfiles: () => { profileLookups += 1; return [profile]; },
      loadProfile: async () => { profileLookups += 1; return profile; },
      adapterFor: () => { profileLookups += 1; return new Adapter([]); },
      authFor: async () => { profileLookups += 1; return auth; },
      listClaudeCodeModels: async () => { compatibilityLookups += 1; return []; },
      inspectClaudeCodeModel: async () => { compatibilityLookups += 1; throw new Error("unused"); },
      verifyClaudeCodeModel: async () => { compatibilityLookups += 1; throw new Error("unused"); },
      execute: async (options) => { executions += 1; return runProgressiveInit(options); },
    } satisfies ProgressiveInitCliRuntime;
    await expect(executeProgressiveInitCommand({
      requestParts: [REQUEST], projectRoot: root, headless: true, deadlineSeconds: 120, stage: "project-phases",
    }, runtime)).rejects.toThrow("PROJECT_PHASES_INTERACTIVE_AUTHORITY_REQUIRED");
    expect(profileLookups).toBe(0);
    expect(compatibilityLookups).toBe(0);
    expect(executions).toBe(0);

    const reconciliationRuntime: ProgressiveInitCliRuntime = {
      ...runtime,
      inspect: async () => [
        { stage: "project-description", status: "complete-fresh" },
        { stage: "user-stories", status: "complete-fresh" },
        { stage: "database-schema", status: "complete-fresh" },
        {
          stage: "project-phases",
          status: "reconciliation-required",
          findings: [{ pointer: "/phases/0/tasks/0/coverageKeys/0", message: "unknown ImplementationSubject" }],
        },
      ],
    };
    await expect(executeProgressiveInitCommand({
      requestParts: [REQUEST], projectRoot: root, headless: true, deadlineSeconds: 120, stage: "project-phases",
    }, reconciliationRuntime)).rejects.toThrow("PROJECT_PHASES_INTERACTIVE_AUTHORITY_REQUIRED");
    expect(profileLookups).toBe(0);
    expect(compatibilityLookups).toBe(0);
    expect(executions).toBe(0);

    await expect(runProgressiveInit({
      projectRoot: root, originalRequest: REQUEST, selectedStage: "project-phases", profile,
      adapter: new Adapter([proposal(authority)]), auth,
      interview: { kind: "interactive", answer: async () => "reject" },
    })).rejects.toThrow("no project-phases artifact was written");
    await expect(readFile(resolve(root, ".spec/init/project-phases.md"))).rejects.toMatchObject({ code: "ENOENT" });

    await runProgressiveInit({
      projectRoot: root, originalRequest: REQUEST, selectedStage: "project-phases", profile,
      adapter: new Adapter([proposal(authority)]), auth,
      interview: { kind: "interactive", answer: async () => "approve" },
    });
    const specPath = resolve(root, ".spec/init/project-phases.md");
    const staleSource = (await readFile(specPath, "utf8")).replace(
      /rb-project-phases-upstream-projection-sha256: [a-f0-9]{64}/,
      `rb-project-phases-upstream-projection-sha256: ${"0".repeat(64)}`,
    );
    await writeFile(specPath, staleSource);
    const previous = await readFile(specPath);
    const changed = structuredClone(proposal(authority));
    (changed.phases[0]!.tasks[0] as any).ownedPaths = ["src/changed"];
    await expect(runProgressiveInit({
      projectRoot: root, originalRequest: REQUEST, selectedStage: "project-phases", profile,
      adapter: new Adapter([changed]), auth,
      interview: { kind: "interactive", answer: async () => "reject" },
    })).rejects.toThrow("existing project-phases artifact was preserved unchanged");
    expect(await readFile(specPath)).toEqual(previous);
  });

  it("preserves approved P4 authority when initial canonical publication fails and retries without a provider", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-progressive-phase4-publication-failure-"));
    const authority = await seedP1P2P3(root);
    await rm(resolve(root, ".rb-harness"), { recursive: true });
    await writeFile(resolve(root, ".rb-harness"), "publication obstacle\n");
    const adapter = new Adapter([proposal(authority)]);
    await expect(runProgressiveInit({
      projectRoot: root, originalRequest: REQUEST, selectedStage: "project-phases", profile, adapter, auth,
      interview: { kind: "interactive", answer: async () => "approve" },
    })).rejects.toThrow();
    expect(adapter.requests).toHaveLength(1);
    const specPath = resolve(root, ".spec/init/project-phases.md");
    const approved = await readFile(specPath);
    await rm(resolve(root, ".rb-harness"));
    const retry = await runProgressiveInit({ projectRoot: root, originalRequest: REQUEST, selectedStage: "project-phases", interview: { kind: "headless" } });
    expect(retry.semanticOperations).toBe(0);
    expect(await readFile(specPath)).toEqual(approved);
    expect((await inspectProgressiveInit(root, REQUEST))[3]).toMatchObject({ status: "complete-fresh", closureStatus: "fresh" });
  });
});
