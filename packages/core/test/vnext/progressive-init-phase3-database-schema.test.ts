import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { executeProgressiveInitCommand, type ProgressiveInitCliRuntime } from "../../src/vnext/progressive-init/cli.js";
import { inspectProgressiveInit, runProgressiveInit, type ProgressiveStageSnapshot } from "../../src/vnext/progressive-init/coordinator.js";
import {
  parseDatabaseSchemaDocument,
  renderDatabaseSchemaDocument,
  renderDatabaseSchemaProposal,
} from "../../src/vnext/progressive-init/database-schema-document.js";
import {
  DATABASE_SCHEMA_LOGICAL_TYPES,
  canonicalizeDatabaseSchema,
  databaseSchemaAcceptedDecisionProjection,
  databaseSchemaAuthoritativeInputSha256,
  databaseSchemaForPersistence,
  databaseSchemaUpstreamProjection,
  databaseSchemaUpstreamProjectionSha256,
  decodeDatabaseSchemaProposalWire,
  decodeDatabaseSchemaQuestionSelection,
  deriveForeignKeyRelationship,
  enumerateStoryPersistenceSubjects,
  requiredStoryPersistenceSubjects,
  resolveDatabaseSchemaProposal,
  storyPersistenceDecisionInputSha256,
  validateDatabaseSchema,
  type DatabaseSchema,
  type DatabaseSchemaStoryPersistence,
  type DatabaseSchemaUpstreamProjection,
} from "../../src/vnext/progressive-init/database-schema-ir.js";
import { runDatabaseSchemaOperation } from "../../src/vnext/progressive-init/database-schema-operation.js";
import { loadDatabaseSchema, writeDatabaseSchemaAtomically } from "../../src/vnext/progressive-init/database-schema-store.js";
import { parseProjectDescriptionDocument } from "../../src/vnext/progressive-init/project-description-document.js";
import type { ProjectDescription } from "../../src/vnext/progressive-init/project-description-ir.js";
import { parseUserStoriesDocument, renderUserStoriesDocument } from "../../src/vnext/progressive-init/user-stories-document.js";
import {
  userStoriesUpstreamProjection,
  userStoriesUpstreamProjectionSha256,
  type UserStories,
} from "../../src/vnext/progressive-init/user-stories-ir.js";
import type {
  CanonicalSemanticResponse,
  ModelProfile,
  ProviderAdapter,
  ProviderOutcome,
  ResolvedProviderAuth,
  SemanticRequest,
} from "../../src/vnext/providers/contract.js";

const REQUEST = "Build an issue tracker where developers create issues and reviewers read status summaries.";

const profile: ModelProfile = {
  id: "fixture:progressive-phase3",
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

const projectPayload = () => ({
  contract: "rb-project-description/v1",
  stage: "project-description",
  originalRequest: REQUEST,
  project: { key: "issue-tracker", name: "Issue Tracker", objective: "Track issues and expose status summaries." },
  actors: [{ key: "developer", name: "Developer", responsibility: "Creates issues and reads status." }],
  capabilities: [
    { key: "create-issues", statement: "Create project issues." },
    { key: "read-status", statement: "Read a current issue status summary." },
  ],
  workflows: [
    { key: "issue-creation", statement: "A developer creates an issue.", actorKeys: ["developer"], capabilityKeys: ["create-issues"] },
    { key: "status-reading", statement: "A developer reads issue status.", actorKeys: ["developer"], capabilityKeys: ["read-status"] },
  ],
  constraints: [],
  determinations: [],
  qualityCommands: [{ key: "tests", kind: "test", command: "npm test" }],
  questions: [],
});

const storiesPayload = () => ({
  contract: "rb-user-stories/v1",
  stage: "user-stories",
  projectKey: "issue-tracker",
  stories: [
    {
      key: "create-issue", workflowKey: "issue-creation", capabilityKeys: ["create-issues"],
      actorKey: "developer", operatorActorKey: "developer", intent: "Create an issue",
      outcome: "The issue is available for tracking", acceptance: ["The developer observes the created issue"],
    },
    {
      key: "read-status", workflowKey: "status-reading", capabilityKeys: ["read-status"],
      actorKey: "developer", operatorActorKey: "developer", intent: "Read current status",
      outcome: "The current status is visible", acceptance: ["The developer observes the current status"],
    },
  ],
});

const emptyStoryQuestions = () => ({ contract: "rb-user-stories-questions/v1", stage: "user-stories", participationRecommendations: [], questions: [] });
const root = () => mkdtemp(resolve(tmpdir(), "rb-progressive-phase3-"));

async function seedUpstream(projectRoot: string): Promise<DatabaseSchemaUpstreamProjection> {
  await runProgressiveInit({
    projectRoot, originalRequest: REQUEST, selectedStage: "project-description", profile,
    adapter: new Adapter([projectPayload()]), auth, interview: { kind: "headless" },
  });
  await runProgressiveInit({
    projectRoot, originalRequest: REQUEST, selectedStage: "user-stories", profile,
    adapter: new Adapter([emptyStoryQuestions(), storiesPayload()]), auth, interview: { kind: "headless" },
  });
  return currentDatabaseUpstream(projectRoot);
}

async function currentDatabaseUpstream(projectRoot: string): Promise<DatabaseSchemaUpstreamProjection> {
  const projectSource = await readFile(resolve(projectRoot, ".spec", "init", "project-description.md"), "utf8");
  const project = parseProjectDescriptionDocument(projectSource).value;
  const userUpstream = userStoriesUpstreamProjection(project);
  const storiesSource = await readFile(resolve(projectRoot, ".spec", "init", "user-stories.md"), "utf8");
  const stories = parseUserStoriesDocument(storiesSource, userUpstream).value;
  return databaseSchemaUpstreamProjection(stories, userStoriesUpstreamProjectionSha256(userUpstream));
}

async function editUserStories(
  projectRoot: string,
  mutate: (value: UserStories) => UserStories,
): Promise<DatabaseSchemaUpstreamProjection> {
  const projectSource = await readFile(resolve(projectRoot, ".spec", "init", "project-description.md"), "utf8");
  const userUpstream = userStoriesUpstreamProjection(parseProjectDescriptionDocument(projectSource).value);
  const storiesPath = resolve(projectRoot, ".spec", "init", "user-stories.md");
  const document = parseUserStoriesDocument(await readFile(storiesPath, "utf8"), userUpstream);
  await writeFile(storiesPath, renderUserStoriesDocument(mutate(document.value), userUpstream, {
    upstreamProjectionSha256: document.metadata.upstreamProjectionSha256,
    authoritativeInputSha256: document.metadata.authoritativeInputSha256,
  }));
  return currentDatabaseUpstream(projectRoot);
}

function directUpstream(): DatabaseSchemaUpstreamProjection {
  const stories: UserStories = {
    contract: "rb-user-stories/v1",
    stage: "user-stories",
    projectKey: "issue-tracker" as any,
    determinations: [],
    structuralDecisions: [],
    stories: [
      { key: "create-issue" as any, storyId: "US-1.1", workflowKey: "issue-creation" as any, capabilityKeys: ["create-issues" as any], actorKey: "developer" as any, operatorActorKey: "developer" as any, intent: "Create an issue", outcome: "Issue exists", acceptance: ["Issue is visible"] },
      { key: "read-status" as any, storyId: "US-2.1", workflowKey: "status-reading" as any, capabilityKeys: ["read-status" as any], actorKey: "developer" as any, operatorActorKey: "developer" as any, intent: "Read status", outcome: "Status is visible", acceptance: ["Current status is shown"] },
    ],
  };
  return databaseSchemaUpstreamProjection(stories, "a".repeat(64));
}

function authority(upstream: DatabaseSchemaUpstreamProjection, dispositions: Record<string, "persisted" | "not-persisted">) {
  const subjects = enumerateStoryPersistenceSubjects(upstream);
  const structuralDecisions: DatabaseSchemaStoryPersistence[] = subjects.map((subject) => ({
    kind: "story-persistence",
    key: subject.key,
    storyKey: subject.storyKey,
    decisionInputSha256: subject.decisionInputSha256,
    disposition: dispositions[subject.storyKey]!,
    source: { kind: "developer" },
  }));
  return {
    determinations: structuralDecisions.map((decision) => ({
      key: decision.key,
      statement: decision.disposition === "persisted" ? "Persisted" : "Not persisted",
      rationale: "Explicit developer-owned persistence authority.",
      materiality: "architecture" as const,
      rigidity: "RIGID" as const,
      source: { kind: "developer" as const },
    })),
    structuralDecisions,
  };
}

function persistenceRecommendations(upstream: DatabaseSchemaUpstreamProjection, recommendations: Record<string, "persisted" | "not-persisted">) {
  return {
    contract: "rb-database-schema-persistence-questions/v1",
    stage: "database-schema",
    recommendations: enumerateStoryPersistenceSubjects(upstream)
      .filter((subject) => recommendations[subject.storyKey] !== undefined)
      .map((subject) => ({
      subjectKey: subject.key,
      recommendedOptionKey: recommendations[subject.storyKey]!,
      question: `Should story ${subject.storyKey} persist application data?`,
      rationale: `The ${subject.storyKey} outcome provides evidence for this recommendation.`,
      })),
  };
}

const validProposal = () => ({
  storyCoverage: [
    { storyKey: "create-issue", tableKeys: ["issues"] },
    { storyKey: "read-status", tableKeys: [] },
  ],
  tables: [{
    key: "issues",
    name: "issues",
    purpose: "Store explicitly approved issue state.",
    fields: [
      { key: "id", name: "id", logicalType: "uuid", required: true },
      { key: "title", name: "title", logicalType: "string", required: true },
    ],
    primaryKeyFieldKeys: ["id"],
    uniqueConstraints: [],
  }],
  foreignKeys: [],
});

function applicableSchema(upstream = directUpstream()): DatabaseSchema {
  const selected = authority(upstream, { "create-issue": "persisted", "read-status": "not-persisted" });
  const decoded = decodeDatabaseSchemaProposalWire(validProposal());
  if (!decoded.ok) throw new Error("fixture failed");
  const resolved = resolveDatabaseSchemaProposal(decoded.value, upstream, selected.determinations, selected.structuralDecisions);
  if (!resolved.ok) throw new Error(resolved.findings.map((entry) => entry.message).join("; "));
  return databaseSchemaForPersistence(resolved.value);
}

describe("Progressive Init Phase 3 database-schema", () => {
  it("enumerates exactly one Core-owned persisted/not-persisted subject for every current User Story", () => {
    const subjects = enumerateStoryPersistenceSubjects(directUpstream());
    expect(subjects.map((entry) => entry.storyKey)).toEqual(["create-issue", "read-status"]);
    expect(subjects.every((entry) => entry.options.map((option) => option.key).join(",") === "persisted,not-persisted")).toBe(true);
    expect(new Set(subjects.map((entry) => entry.key)).size).toBe(2);
  });

  it("binds persistence authority to every typed story field without invalidating an unrelated story", () => {
    const upstream = directUpstream();
    const existing = databaseSchemaForPersistence(applicableSchema(upstream));
    const originalByStory = new Map(existing.structuralDecisions.map((entry) => [entry.storyKey, entry.decisionInputSha256]));
    const originalStory = upstream.userStories.stories.find((entry) => entry.key === "create-issue")!;
    const mutations: readonly Partial<typeof originalStory>[] = [
      { intent: "Create a retained issue" },
      { outcome: "Issue exists durably" },
      { acceptance: ["Issue is visible", "Issue remains available"] },
      { capabilityKeys: ["alternate-capability" as any] },
      { actorKey: "alternate-actor" as any },
      { operatorActorKey: "alternate-operator" as any },
      { workflowKey: "alternate-workflow" as any },
      { storyId: "US-9.9" },
    ];
    for (const mutation of mutations) {
      const changed = databaseSchemaUpstreamProjection({
        ...upstream.userStories,
        stories: upstream.userStories.stories.map((story) => story.key === originalStory.key ? { ...story, ...mutation } : story),
      }, upstream.userStoriesUpstreamProjectionSha256);
      expect(storyPersistenceDecisionInputSha256(changed, originalStory.key)).not.toBe(originalByStory.get(originalStory.key));
      expect(requiredStoryPersistenceSubjects(changed, existing).map((entry) => entry.storyKey)).toEqual(["create-issue"]);
      expect(storyPersistenceDecisionInputSha256(changed, "read-status" as any)).toBe(originalByStory.get("read-status" as any));
    }

    const changedGlobalAuthority = databaseSchemaUpstreamProjection(upstream.userStories, "b".repeat(64));
    expect(changedGlobalAuthority.userStoriesAuthoritativeInputSha256).not.toBe(upstream.userStoriesAuthoritativeInputSha256);
    expect(requiredStoryPersistenceSubjects(changedGlobalAuthority, existing).map((entry) => entry.storyKey)).toEqual(["create-issue", "read-status"]);
  });

  it("rejects missing, duplicate, invented, or provider-authored persistence subjects before interview", () => {
    const upstream = directUpstream();
    const subjects = enumerateStoryPersistenceSubjects(upstream);
    expect(decodeDatabaseSchemaQuestionSelection(persistenceRecommendations(upstream, { "create-issue": "persisted", "read-status": "not-persisted" }), subjects).ok).toBe(true);
    const cases = [
      (value: any) => value.recommendations.pop(),
      (value: any) => value.recommendations.push({ ...value.recommendations[0] }),
      (value: any) => { value.recommendations[0].subjectKey = "invented-subject"; },
      (value: any) => { value.recommendations[0].recommendedOptionKey = "sometimes"; },
      (value: any) => { value.recommendations[0].storyKey = "invented-story"; },
    ];
    for (const mutate of cases) {
      const value: any = persistenceRecommendations(upstream, { "create-issue": "persisted", "read-status": "not-persisted" });
      mutate(value);
      expect(decodeDatabaseSchemaQuestionSelection(value, subjects).ok).toBe(false);
    }
  });

  it("keeps every authority and approval field outside the provider proposal wire", () => {
    expect(decodeDatabaseSchemaProposalWire(validProposal()).ok).toBe(true);
    for (const field of ["determinations", "structuralDecisions", "disposition", "approval", "contract", "stage", "projectKey", "decisionInputSha256", "proposalSha256", "upstreamProjectionSha256"]) {
      const value: any = validProposal();
      value[field] = field === "disposition" ? "applicable" : [];
      const outcome = decodeDatabaseSchemaProposalWire(value);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.findings.map((entry) => entry.message)).toContain("unknown field");
    }
    const coverageAuthority: any = validProposal();
    coverageAuthority.storyCoverage[0].disposition = "persisted";
    expect(decodeDatabaseSchemaProposalWire(coverageAuthority).ok).toBe(false);
    const keyedForeign: any = validProposal();
    keyedForeign.foreignKeys.push({ key: "invented-id", fromTableKey: "issues", fromFieldKey: "id", toTableKey: "issues", toFieldKey: "id" });
    expect(decodeDatabaseSchemaProposalWire(keyedForeign).ok).toBe(false);
    const cardinality: any = validProposal();
    cardinality.foreignKeys.push({ fromTableKey: "issues", fromFieldKey: "id", toTableKey: "issues", toFieldKey: "id", cardinality: "one-to-one" });
    expect(decodeDatabaseSchemaProposalWire(cardinality).ok).toBe(false);
  });

  it("validates coverage and prevents provider mappings from changing not-persisted authority", () => {
    const upstream = directUpstream();
    const selected = authority(upstream, { "create-issue": "persisted", "read-status": "not-persisted" });
    const invalids = [
      (() => { const value = validProposal(); value.storyCoverage.pop(); return value; })(),
      (() => { const value = validProposal(); value.storyCoverage.push({ ...value.storyCoverage[0]! }); return value; })(),
      (() => { const value = validProposal(); value.storyCoverage[0]!.tableKeys = ["missing"]; return value; })(),
      (() => { const value = validProposal(); value.storyCoverage[1]!.tableKeys = ["issues"]; return value; })(),
      (() => { const value = validProposal(); value.tables.push({ ...value.tables[0]!, key: "unused", name: "unused" }); return value; })(),
    ];
    for (const candidate of invalids) {
      const decoded = decodeDatabaseSchemaProposalWire(candidate);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) expect(resolveDatabaseSchemaProposal(decoded.value, upstream, selected.determinations, selected.structuralDecisions).ok).toBe(false);
    }
  });

  it("implements only the closed V1 logical types and relational candidate-key rules", () => {
    expect(DATABASE_SCHEMA_LOGICAL_TYPES).toEqual(["string", "integer", "decimal", "boolean", "date", "datetime", "uuid", "json", "binary"]);
    const upstream = directUpstream();
    const selected = authority(upstream, { "create-issue": "persisted", "read-status": "not-persisted" });
    const proposal: any = validProposal();
    proposal.tables.push({
      key: "customers", name: "customers", purpose: "Store approved customer identity.",
      fields: [{ key: "id", name: "id", logicalType: "uuid", required: true }],
      primaryKeyFieldKeys: ["id"], uniqueConstraints: [],
    });
    proposal.tables[0].fields.push({ key: "customer-id", name: "customer_id", logicalType: "uuid", required: true });
    proposal.storyCoverage[0].tableKeys.push("customers");
    proposal.foreignKeys.push({ fromTableKey: "issues", fromFieldKey: "customer-id", toTableKey: "customers", toFieldKey: "id" });
    const decoded = decodeDatabaseSchemaProposalWire(proposal);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const resolved = resolveDatabaseSchemaProposal(decoded.value, upstream, selected.determinations, selected.structuralDecisions);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(deriveForeignKeyRelationship(resolved.value, resolved.value.foreignKeys[0]!)).toBe("many-to-one");
    const unique: DatabaseSchema = {
      ...resolved.value,
      tables: resolved.value.tables.map((table) => table.key === "issues" ? { ...table, uniqueConstraints: [{ fieldKeys: ["customer-id" as any] }] } : table),
    };
    expect(validateDatabaseSchema(unique, upstream).ok).toBe(true);
    expect(deriveForeignKeyRelationship(unique, unique.foreignKeys[0]!)).toBe("one-to-one");
    const optional: DatabaseSchema = {
      ...unique,
      tables: unique.tables.map((table) => table.key === "issues" ? { ...table, fields: table.fields.map((field) => field.key === "customer-id" ? { ...field, required: false } : field) } : table),
    };
    expect(deriveForeignKeyRelationship(optional, optional.foreignKeys[0]!)).toBe("zero-or-one-to-one");

    const compositeTarget: any = structuredClone(proposal);
    compositeTarget.tables[1].fields.push({ key: "region", name: "region", logicalType: "string", required: true });
    compositeTarget.tables[1].primaryKeyFieldKeys = ["id", "region"];
    const compositeDecoded = decodeDatabaseSchemaProposalWire(compositeTarget);
    expect(compositeDecoded.ok).toBe(true);
    if (compositeDecoded.ok) expect(resolveDatabaseSchemaProposal(compositeDecoded.value, upstream, selected.determinations, selected.structuralDecisions).ok).toBe(false);

    const mismatch: any = structuredClone(proposal);
    mismatch.tables[0].fields.find((field: any) => field.key === "customer-id").logicalType = "string";
    const mismatchDecoded = decodeDatabaseSchemaProposalWire(mismatch);
    expect(mismatchDecoded.ok).toBe(true);
    if (mismatchDecoded.ok) expect(resolveDatabaseSchemaProposal(mismatchDecoded.value, upstream, selected.determinations, selected.structuralDecisions).ok).toBe(false);
  });

  it("round-trips composite primary keys and explicit junction-table many-to-many without cardinality authority", () => {
    const upstream = directUpstream();
    const selected = authority(upstream, { "create-issue": "persisted", "read-status": "not-persisted" });
    const proposal: any = {
      storyCoverage: [{ storyKey: "create-issue", tableKeys: ["issues", "tags", "issue-tags"] }, { storyKey: "read-status", tableKeys: [] }],
      tables: [
        { key: "issues", name: "issues", purpose: "Issues.", fields: [{ key: "id", name: "id", logicalType: "uuid", required: true }], primaryKeyFieldKeys: ["id"], uniqueConstraints: [] },
        { key: "tags", name: "tags", purpose: "Tags.", fields: [{ key: "id", name: "id", logicalType: "uuid", required: true }], primaryKeyFieldKeys: ["id"], uniqueConstraints: [] },
        { key: "issue-tags", name: "issue_tags", purpose: "Approved issue and tag associations.", fields: [{ key: "issue-id", name: "issue_id", logicalType: "uuid", required: true }, { key: "tag-id", name: "tag_id", logicalType: "uuid", required: true }], primaryKeyFieldKeys: ["issue-id", "tag-id"], uniqueConstraints: [] },
      ],
      foreignKeys: [
        { fromTableKey: "issue-tags", fromFieldKey: "issue-id", toTableKey: "issues", toFieldKey: "id" },
        { fromTableKey: "issue-tags", fromFieldKey: "tag-id", toTableKey: "tags", toFieldKey: "id" },
      ],
    };
    const decoded = decodeDatabaseSchemaProposalWire(proposal);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const resolved = resolveDatabaseSchemaProposal(decoded.value, upstream, selected.determinations, selected.structuralDecisions);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(JSON.stringify(resolved.value)).not.toContain("cardinality");
    const persisted = databaseSchemaForPersistence(resolved.value);
    const upstreamHash = databaseSchemaUpstreamProjectionSha256(upstream);
    const authoritativeHash = databaseSchemaAuthoritativeInputSha256({ upstreamProjectionSha256: upstreamHash, acceptedDecisions: databaseSchemaAcceptedDecisionProjection(persisted) });
    const source = renderDatabaseSchemaDocument(persisted, upstream, { upstreamProjectionSha256: upstreamHash, authoritativeInputSha256: authoritativeHash });
    const parsed = parseDatabaseSchemaDocument(source, upstream);
    expect(renderDatabaseSchemaDocument(parsed.value, upstream, { upstreamProjectionSha256: upstreamHash, authoritativeInputSha256: authoritativeHash })).toBe(source);
  });

  it("uses bounded whole-candidate correction and presents only the final mechanically valid proposal", async () => {
    const upstream = directUpstream();
    const invalid = validProposal();
    invalid.storyCoverage[0]!.tableKeys = ["missing"];
    const shown: string[] = [];
    const answers = ["persisted", "not-persisted", "approve"];
    const adapter = new Adapter([
      persistenceRecommendations(upstream, { "create-issue": "persisted", "read-status": "not-persisted" }),
      invalid,
      validProposal(),
    ]);
    const result = await runDatabaseSchemaOperation({
      upstream, profile, adapter, auth, interview: { kind: "interactive", answer: async (question) => {
        if (question.key === "approve-database-schema-proposal") shown.push(question.question);
        return answers.shift()!;
      } },
      deadlineMs: 10_000,
    });
    expect(result).toMatchObject({ semanticOperations: 3, correctiveRegenerations: 1 });
    expect(adapter.requests.map((entry) => entry.slice)).toEqual([
      "database-schema-persistence-questions",
      "database-schema-proposal",
      "database-schema-proposal",
    ]);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain('"issues"');
    expect(JSON.parse(adapter.requests[2]!.input).recovery.completeCandidateRegeneration).toBe(true);
  });

  it("accepts only persistence ordinals, exact Core keys, and exact displayed Core labels", async () => {
    const completeUpstream = directUpstream();
    const upstream = databaseSchemaUpstreamProjection({
      ...completeUpstream.userStories,
      stories: completeUpstream.userStories.stories.filter((story) => story.key === "create-issue"),
    }, completeUpstream.userStoriesUpstreamProjectionSha256);
    for (const [answer, expected] of [
      ["1", "persisted"],
      ["persisted", "persisted"],
      ["Persisted", "persisted"],
      ["2", "not-persisted"],
      ["not-persisted", "not-persisted"],
      ["Not persisted", "not-persisted"],
    ] as const) {
      const proposal = validProposal();
      proposal.storyCoverage.pop();
      const adapter = new Adapter([
        persistenceRecommendations(upstream, { "create-issue": expected }),
        ...(expected === "persisted" ? [proposal] : []),
      ]);
      const answers = expected === "persisted" ? [answer, "approve"] : [answer];
      const result = await runDatabaseSchemaOperation({
        upstream, profile, adapter, auth,
        interview: { kind: "interactive", answer: async () => answers.shift()! },
        deadlineMs: 10_000,
      });
      expect(result.value.structuralDecisions[0]?.disposition).toBe(expected);
    }
  });

  it("rejects fuzzy persistence prose and reports the upstream story instead of its internal subject key", async () => {
    const completeUpstream = directUpstream();
    const upstream = databaseSchemaUpstreamProjection({
      ...completeUpstream.userStories,
      stories: completeUpstream.userStories.stories.filter((story) => story.key === "create-issue"),
    }, completeUpstream.userStoriesUpstreamProjectionSha256);
    const subjectKey = enumerateStoryPersistenceSubjects(upstream)[0]!.key;
    const answers = ["please persist this", "yes", "whatever"];
    let failure: unknown;
    try {
      await runDatabaseSchemaOperation({
        upstream, profile,
        adapter: new Adapter([persistenceRecommendations(upstream, { "create-issue": "persisted" })]),
        auth, interview: { kind: "interactive", answer: async () => answers.shift()! }, deadlineMs: 10_000,
      });
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toContain("DATABASE_SCHEMA_PERSISTENCE_SELECTION_INVALID");
    expect(String(failure)).toContain("story 'create-issue'");
    expect(String(failure)).not.toContain(subjectKey);
    expect(answers).toEqual([]);
  });

  it("requires explicit proposal approval, rejects blank/reject, and never lets an old approval authorize another candidate", async () => {
    const upstream = directUpstream();
    for (const approvalAnswers of [["", "", ""], ["reject"]]) {
      const answers = ["persisted", "not-persisted", ...approvalAnswers];
      await expect(runDatabaseSchemaOperation({
        upstream, profile,
        adapter: new Adapter([persistenceRecommendations(upstream, { "create-issue": "persisted", "read-status": "not-persisted" }), validProposal()]),
        auth, interview: { kind: "interactive", answer: async () => answers.shift() ?? "" }, deadlineMs: 10_000,
      })).rejects.toThrow(approvalAnswers[0] === "reject" ? /PROPOSAL_REJECTED/ : /APPROVAL_INVALID/);
    }
  });

  it("writes a strict not-applicable artifact after one operation and fresh rerun performs zero calls and writes", async () => {
    const projectRoot = await root();
    const upstream = await seedUpstream(projectRoot);
    const adapter = new Adapter([persistenceRecommendations(upstream, { "create-issue": "not-persisted", "read-status": "not-persisted" })]);
    const answers = ["not-persisted", "not-persisted"];
    const result = await runProgressiveInit({
      projectRoot, originalRequest: REQUEST, selectedStage: "database-schema", profile, adapter, auth,
      interview: { kind: "interactive", answer: async () => answers.shift()! },
    });
    expect(result).toMatchObject({ completedStage: "database-schema", semanticOperations: 1, correctiveRegenerations: 0 });
    expect(adapter.requests.map((entry) => entry.slice)).toEqual(["database-schema-persistence-questions"]);
    const source = await readFile(result.artifactPath!, "utf8");
    const parsed = parseDatabaseSchemaDocument(source, upstream);
    expect(parsed.value).toMatchObject({ disposition: "not-applicable", tables: [], foreignKeys: [] });
    let writes = 0;
    const freshAdapter = new Adapter([]);
    const rerun = await runProgressiveInit({
      projectRoot, originalRequest: REQUEST, selectedStage: "database-schema",
      profile, adapter: freshAdapter, auth, beforeWrite: () => { writes += 1; },
    });
    expect(rerun).toMatchObject({ semanticOperations: 0, correctiveRegenerations: 0 });
    expect(freshAdapter.requests.map((entry) => entry.slice)).toEqual([]);
    expect(writes).toBe(0);
  });

  it("re-establishes stale not-applicable authority against changed story input instead of silently rebinding it", async () => {
    const projectRoot = await root();
    const initialUpstream = await seedUpstream(projectRoot);
    const initialAnswers = ["not-persisted", "not-persisted"];
    await runProgressiveInit({
      projectRoot, originalRequest: REQUEST, selectedStage: "database-schema", profile,
      adapter: new Adapter([persistenceRecommendations(initialUpstream, { "create-issue": "not-persisted", "read-status": "not-persisted" })]), auth,
      interview: { kind: "interactive", answer: async () => initialAnswers.shift()! },
    });
    const schemaPath = resolve(projectRoot, ".spec", "init", "database-schema.md");
    const initialSchema = parseDatabaseSchemaDocument(await readFile(schemaPath, "utf8"), initialUpstream).value;
    const initialDigests = new Map(initialSchema.structuralDecisions.map((entry) => [entry.storyKey, entry.decisionInputSha256]));

    const changedUpstream = await editUserStories(projectRoot, (value) => ({
      ...value,
      stories: value.stories.map((story) => story.key === "create-issue" ? { ...story, intent: "Create and retain an issue" } : story),
    }));
    expect((await inspectProgressiveInit(projectRoot, REQUEST))[2]?.status).toBe("complete-stale");
    expect(requiredStoryPersistenceSubjects(changedUpstream, initialSchema).map((entry) => entry.storyKey)).toEqual(["create-issue"]);

    const adapter = new Adapter([persistenceRecommendations(changedUpstream, { "create-issue": "not-persisted" })]);
    const presentedSubjects: string[] = [];
    const result = await runProgressiveInit({
      projectRoot, originalRequest: REQUEST, selectedStage: "database-schema", profile, adapter, auth,
      interview: { kind: "interactive", answer: async (question) => {
        presentedSubjects.push(question.key);
        return "not-persisted";
      } },
    });
    expect(result).toMatchObject({ semanticOperations: 1, correctiveRegenerations: 0 });
    expect(adapter.requests.map((entry) => entry.slice)).toEqual(["database-schema-persistence-questions"]);
    expect(presentedSubjects).toEqual([enumerateStoryPersistenceSubjects(changedUpstream).find((entry) => entry.storyKey === "create-issue")!.key]);
    const rebound = parseDatabaseSchemaDocument(await readFile(schemaPath, "utf8"), changedUpstream).value;
    const reboundDigests = new Map(rebound.structuralDecisions.map((entry) => [entry.storyKey, entry.decisionInputSha256]));
    expect(reboundDigests.get("create-issue" as any)).not.toBe(initialDigests.get("create-issue" as any));
    expect(reboundDigests.get("read-status" as any)).toBe(initialDigests.get("read-status" as any));
    expect((await inspectProgressiveInit(projectRoot, REQUEST))[2]?.status).toBe("complete-fresh");
  });

  it("binds displayed applicable proposal to the exact materialized body and rejection writes nothing", async () => {
    const projectRoot = await root();
    const upstream = await seedUpstream(projectRoot);
    const recommendations = persistenceRecommendations(upstream, { "create-issue": "persisted", "read-status": "not-persisted" });
    const shown: string[] = [];
    const answers = ["persisted", "not-persisted", "approve"];
    const adapter = new Adapter([recommendations, validProposal()]);
    const result = await runProgressiveInit({
      projectRoot, originalRequest: REQUEST, selectedStage: "database-schema", profile,
      adapter, auth,
      interview: { kind: "interactive", answer: async (question) => {
        if (question.key === "approve-database-schema-proposal") shown.push(question.question);
        return answers.shift()!;
      } },
      presentation: { stage: () => undefined },
    });
    expect(result).toMatchObject({ semanticOperations: 2, correctiveRegenerations: 0 });
    expect(adapter.requests.map((entry) => entry.slice)).toEqual([
      "database-schema-persistence-questions",
      "database-schema-proposal",
    ]);
    const parsed = parseDatabaseSchemaDocument(await readFile(result.artifactPath!, "utf8"), upstream).value;
    const approvalSuffix = "\n\nApprove the exact validated database schema proposal displayed above?";
    const displayedProposal = `${shown[0]!.slice(shown[0]!.indexOf("Database schema proposal"), shown[0]!.lastIndexOf(approvalSuffix))}\n`;
    expect(renderDatabaseSchemaProposal(parsed)).toBe(displayedProposal);
    expect(await readFile(result.artifactPath!, "utf8")).not.toContain("proposalSha256");

    const freshAdapter = new Adapter([]);
    const rerun = await runProgressiveInit({
      projectRoot, originalRequest: REQUEST, selectedStage: "database-schema",
      profile, adapter: freshAdapter, auth,
    });
    expect(rerun).toMatchObject({ semanticOperations: 0, correctiveRegenerations: 0 });
    expect(freshAdapter.requests.map((entry) => entry.slice)).toEqual([]);

    const rejectedRoot = await root();
    const rejectedUpstream = await seedUpstream(rejectedRoot);
    const rejectAnswers = ["persisted", "not-persisted", "reject"];
    await expect(runProgressiveInit({
      projectRoot: rejectedRoot, originalRequest: REQUEST, selectedStage: "database-schema", profile,
      adapter: new Adapter([persistenceRecommendations(rejectedUpstream, { "create-issue": "persisted", "read-status": "not-persisted" }), validProposal()]), auth,
      interview: { kind: "interactive", answer: async () => rejectAnswers.shift()! },
    })).rejects.toThrow(/DATABASE_SCHEMA_PROPOSAL_REJECTED: proposal rejected; no database-schema artifact was written/);
    await expect(readFile(resolve(rejectedRoot, ".spec", "init", "database-schema.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows a stale applicable proposal to change an existing table only after informed explicit approval", async () => {
    const projectRoot = await root();
    const initialUpstream = await seedUpstream(projectRoot);
    const initialAnswers = ["persisted", "not-persisted", "approve"];
    await runProgressiveInit({
      projectRoot, originalRequest: REQUEST, selectedStage: "database-schema", profile,
      adapter: new Adapter([persistenceRecommendations(initialUpstream, { "create-issue": "persisted", "read-status": "not-persisted" }), validProposal()]), auth,
      interview: { kind: "interactive", answer: async () => initialAnswers.shift()! },
    });
    const schemaPath = resolve(projectRoot, ".spec", "init", "database-schema.md");
    const originalSource = await readFile(schemaPath, "utf8");
    const changedUpstream = await editUserStories(projectRoot, (value) => ({
      ...value,
      stories: value.stories.map((story) => story.key === "create-issue" ? { ...story, outcome: "The issue is available for approval tracking" } : story),
    }));
    const changedProposal = validProposal();
    changedProposal.tables[0]!.fields.push({ key: "approved-at", name: "approved_at", logicalType: "datetime", required: false });
    const shown: string[] = [];
    const adapter = new Adapter([
      persistenceRecommendations(changedUpstream, { "create-issue": "persisted" }),
      changedProposal,
    ]);
    const result = await runProgressiveInit({
      projectRoot, originalRequest: REQUEST, selectedStage: "database-schema", profile, adapter, auth,
      interview: { kind: "interactive", answer: async (question) => {
        if (question.key === "approve-database-schema-proposal") {
          expect(await readFile(schemaPath, "utf8")).toBe(originalSource);
          shown.push(question.question);
          return "approve";
        }
        return "persisted";
      } },
    });
    expect(result).toMatchObject({ semanticOperations: 2, correctiveRegenerations: 0 });
    expect(adapter.requests.map((entry) => entry.slice)).toEqual([
      "database-schema-persistence-questions",
      "database-schema-proposal",
    ]);
    expect(shown[0]).toContain("Database schema change summary (Core-generated)");
    expect(shown[0]).toContain("Tables changed: issues");
    const persisted = parseDatabaseSchemaDocument(await readFile(schemaPath, "utf8"), changedUpstream).value;
    expect(persisted.tables[0]!.fields.map((entry) => entry.key)).toContain("approved-at");
    const approvalSuffix = "\n\nApprove the exact validated database schema proposal displayed above?";
    const displayedProposal = `${shown[0]!.slice(shown[0]!.indexOf("Database schema proposal"), shown[0]!.lastIndexOf(approvalSuffix))}\n`;
    expect(renderDatabaseSchemaProposal(persisted)).toBe(displayedProposal);
  });

  it("re-evaluates a stale applicable body even when all persistence subjects remain settled", async () => {
    const projectRoot = await root();
    const upstream = await seedUpstream(projectRoot);
    const initialAnswers = ["persisted", "not-persisted", "approve"];
    await runProgressiveInit({
      projectRoot, originalRequest: REQUEST, selectedStage: "database-schema", profile,
      adapter: new Adapter([persistenceRecommendations(upstream, { "create-issue": "persisted", "read-status": "not-persisted" }), validProposal()]), auth,
      interview: { kind: "interactive", answer: async () => initialAnswers.shift()! },
    });
    const schemaPath = resolve(projectRoot, ".spec", "init", "database-schema.md");
    const currentSource = await readFile(schemaPath, "utf8");
    await writeFile(schemaPath, currentSource.replace(
      /rb-database-schema-upstream-projection-sha256: [a-f0-9]{64}/,
      `rb-database-schema-upstream-projection-sha256: ${"c".repeat(64)}`,
    ));
    expect((await inspectProgressiveInit(projectRoot, REQUEST))[2]?.status).toBe("complete-stale");
    const staleSchema = parseDatabaseSchemaDocument(await readFile(schemaPath, "utf8"), upstream).value;
    expect(requiredStoryPersistenceSubjects(upstream, staleSchema)).toEqual([]);

    const changedProposal = validProposal();
    changedProposal.tables[0]!.purpose = "Store a newly approved issue body.";
    const shown: string[] = [];
    const adapter = new Adapter([changedProposal]);
    const result = await runProgressiveInit({
      projectRoot, originalRequest: REQUEST, selectedStage: "database-schema", profile, adapter, auth,
      interview: { kind: "interactive", answer: async (question) => {
        expect(question.key).toBe("approve-database-schema-proposal");
        shown.push(question.question);
        return "approve";
      } },
    });
    expect(result).toMatchObject({ semanticOperations: 1, correctiveRegenerations: 0 });
    expect(adapter.requests.map((entry) => entry.slice)).toEqual(["database-schema-proposal"]);
    expect(shown[0]).toContain("Tables changed: issues");
    const persisted = parseDatabaseSchemaDocument(await readFile(schemaPath, "utf8"), upstream).value;
    expect(persisted.tables[0]!.purpose).toBe("Store a newly approved issue body.");
  });

  it("uses approval rather than immutability for valid table deletion and preserves bytes on rejection", async () => {
    const projectRoot = await root();
    const initialUpstream = await seedUpstream(projectRoot);
    const twoTableProposal = validProposal();
    twoTableProposal.tables.push({
      key: "issue-notes", name: "issue_notes", purpose: "Store approved issue notes.",
      fields: [{ key: "id", name: "id", logicalType: "uuid", required: true }],
      primaryKeyFieldKeys: ["id"], uniqueConstraints: [],
    });
    twoTableProposal.storyCoverage[0]!.tableKeys.push("issue-notes");
    const initialAnswers = ["persisted", "not-persisted", "approve"];
    await runProgressiveInit({
      projectRoot, originalRequest: REQUEST, selectedStage: "database-schema", profile,
      adapter: new Adapter([persistenceRecommendations(initialUpstream, { "create-issue": "persisted", "read-status": "not-persisted" }), twoTableProposal]), auth,
      interview: { kind: "interactive", answer: async () => initialAnswers.shift()! },
    });
    const schemaPath = resolve(projectRoot, ".spec", "init", "database-schema.md");
    const originalSource = await readFile(schemaPath, "utf8");
    const changedUpstream = await editUserStories(projectRoot, (value) => ({
      ...value,
      stories: value.stories.map((story) => story.key === "create-issue" ? { ...story, acceptance: [...story.acceptance, "Removed storage is no longer required"] } : story),
    }));

    const rejectedQuestions: string[] = [];
    await expect(runProgressiveInit({
      projectRoot, originalRequest: REQUEST, selectedStage: "database-schema", profile,
      adapter: new Adapter([persistenceRecommendations(changedUpstream, { "create-issue": "persisted" }), validProposal()]), auth,
      interview: { kind: "interactive", answer: async (question) => {
        if (question.key === "approve-database-schema-proposal") {
          rejectedQuestions.push(question.question);
          return "reject";
        }
        return "persisted";
      } },
    })).rejects.toThrow(/DATABASE_SCHEMA_PROPOSAL_REJECTED: proposal rejected; the existing database-schema artifact was preserved unchanged/);
    expect(rejectedQuestions[0]).toContain("Tables removed: issue-notes");
    expect(rejectedQuestions[0]).toContain("Story mappings changed: create-issue");
    expect(await readFile(schemaPath, "utf8")).toBe(originalSource);
    expect((await readdir(resolve(projectRoot, ".spec", "init"))).filter((entry) => entry.includes("database-schema") && entry.endsWith(".tmp"))).toEqual([]);

    const approvedQuestions: string[] = [];
    await runProgressiveInit({
      projectRoot, originalRequest: REQUEST, selectedStage: "database-schema", profile,
      adapter: new Adapter([persistenceRecommendations(changedUpstream, { "create-issue": "persisted" }), validProposal()]), auth,
      interview: { kind: "interactive", answer: async (question) => {
        if (question.key === "approve-database-schema-proposal") {
          approvedQuestions.push(question.question);
          return "approve";
        }
        return "persisted";
      } },
    });
    expect(approvedQuestions[0]).toContain("Tables removed: issue-notes");
    const persisted = parseDatabaseSchemaDocument(await readFile(schemaPath, "utf8"), changedUpstream).value;
    expect(persisted.tables.map((entry) => entry.key)).toEqual(["issues"]);
  });

  it("surfaces invalid Phase-3 prerequisites before headless authority or interactive profile/transport preflight", async () => {
    const statuses = (
      databaseStatus: "incomplete" | "complete-stale" | "complete-fresh",
      userStoriesStatus: "complete-fresh" | "complete-stale" = "complete-fresh",
    ): readonly ProgressiveStageSnapshot[] => [
      { stage: "project-description", status: "complete-fresh" },
      { stage: "user-stories", status: userStoriesStatus },
      { stage: "database-schema", status: databaseStatus },
      { stage: "project-phases", status: "incomplete" },
    ];
    const observedAdapter = new Adapter([]);
    const calls = { profile: 0, compatibility: 0, adapter: 0, execute: 0 };
    const runtime = (
      databaseStatus: "incomplete" | "complete-stale" | "complete-fresh",
      userStoriesStatus: "complete-fresh" | "complete-stale",
      interactive: boolean,
    ): ProgressiveInitCliRuntime => ({
      inputIsTTY: interactive,
      outputIsTTY: interactive,
      write: () => undefined,
      ask: async () => "",
      inspect: async () => statuses(databaseStatus, userStoriesStatus),
      listProfiles: () => { calls.profile += 1; return []; },
      loadProfile: async () => { calls.profile += 1; return profile; },
      adapterFor: () => { calls.adapter += 1; return observedAdapter; },
      authFor: async () => { calls.profile += 1; return auth; },
      listClaudeCodeModels: async () => { calls.compatibility += 1; return []; },
      inspectClaudeCodeModel: async () => { calls.compatibility += 1; throw new Error("unexpected"); },
      verifyClaudeCodeModel: async () => { calls.compatibility += 1; return profile; },
      execute: async () => {
        calls.execute += 1;
        return { mode: "focused", selectedStage: "database-schema", completedStage: "database-schema", semanticOperations: 0, correctiveRegenerations: 0 };
      },
    });
    const baseOptions = { requestParts: [], projectRoot: ".", deadlineSeconds: 120, stage: "database-schema" as const };
    await expect(executeProgressiveInitCommand(
      { ...baseOptions, headless: true }, runtime("incomplete", "complete-stale", false),
    )).rejects.toThrow(/PROGRESSIVE_INIT_PREREQUISITE_INVALID/);
    await expect(executeProgressiveInitCommand(
      { ...baseOptions, headless: false }, runtime("incomplete", "complete-stale", true),
    )).rejects.toThrow(/PROGRESSIVE_INIT_PREREQUISITE_INVALID/);
    expect(calls).toEqual({ profile: 0, compatibility: 0, adapter: 0, execute: 0 });
    expect(observedAdapter.requests).toEqual([]);

    await expect(executeProgressiveInitCommand(
      { ...baseOptions, headless: true }, runtime("incomplete", "complete-fresh", false),
    )).rejects.toThrow(/DATABASE_SCHEMA_INTERACTIVE_AUTHORITY_REQUIRED/);
    await expect(executeProgressiveInitCommand(
      { ...baseOptions, headless: true }, runtime("complete-stale", "complete-fresh", false),
    )).rejects.toThrow(/DATABASE_SCHEMA_INTERACTIVE_AUTHORITY_REQUIRED/);
    expect(calls).toEqual({ profile: 0, compatibility: 0, adapter: 0, execute: 0 });

    await expect(executeProgressiveInitCommand(
      { ...baseOptions, headless: true }, runtime("complete-fresh", "complete-fresh", false),
    )).resolves.toBeUndefined();
    expect(calls).toEqual({ profile: 0, compatibility: 0, adapter: 0, execute: 1 });
  });

  it("keeps valid direct body edits fresh while consumed User Story semantics invalidate Phase 3", async () => {
    const projectRoot = await root();
    const upstream = await seedUpstream(projectRoot);
    const answers = ["persisted", "not-persisted", "approve"];
    await runProgressiveInit({
      projectRoot, originalRequest: REQUEST, selectedStage: "database-schema", profile,
      adapter: new Adapter([persistenceRecommendations(upstream, { "create-issue": "persisted", "read-status": "not-persisted" }), validProposal()]), auth,
      interview: { kind: "interactive", answer: async () => answers.shift()! },
    });
    const schemaPath = resolve(projectRoot, ".spec", "init", "database-schema.md");
    const currentSource = await readFile(schemaPath, "utf8");
    await writeFile(schemaPath, currentSource.replace("Store explicitly approved issue state.", "Developer-edited approved issue storage purpose."));
    expect((await inspectProgressiveInit(projectRoot, REQUEST))[2]?.status).toBe("complete-fresh");
    await rm(resolve(projectRoot, ".rb-harness"), { recursive: true, force: true });
    expect((await inspectProgressiveInit(projectRoot, REQUEST))[2]?.status).toBe("complete-fresh");

    const projectSource = await readFile(resolve(projectRoot, ".spec", "init", "project-description.md"), "utf8");
    const userUpstream = userStoriesUpstreamProjection(parseProjectDescriptionDocument(projectSource).value);
    const storiesPath = resolve(projectRoot, ".spec", "init", "user-stories.md");
    const storiesDocument = parseUserStoriesDocument(await readFile(storiesPath, "utf8"), userUpstream);
    const changedStories: UserStories = {
      ...storiesDocument.value,
      stories: storiesDocument.value.stories.map((story) => story.key === "create-issue" ? { ...story, intent: "Create and retain an issue" } : story),
    };
    await writeFile(storiesPath, renderUserStoriesDocument(changedStories, userUpstream, {
      upstreamProjectionSha256: storiesDocument.metadata.upstreamProjectionSha256,
      authoritativeInputSha256: storiesDocument.metadata.authoritativeInputSha256,
    }));
    const statuses = await inspectProgressiveInit(projectRoot, REQUEST);
    expect(statuses[1]?.status).toBe("complete-fresh");
    expect(statuses[2]?.status).toBe("complete-stale");
  });

  it("classifies removed story references as reconciliation and body reference failures as intrinsic", async () => {
    const upstream = directUpstream();
    const schema = applicableSchema(upstream);
    const upstreamHash = databaseSchemaUpstreamProjectionSha256(upstream);
    const authoritativeHash = databaseSchemaAuthoritativeInputSha256({ upstreamProjectionSha256: upstreamHash, acceptedDecisions: databaseSchemaAcceptedDecisionProjection(schema) });
    const source = renderDatabaseSchemaDocument(schema, upstream, { upstreamProjectionSha256: upstreamHash, authoritativeInputSha256: authoritativeHash });
    const reduced = databaseSchemaUpstreamProjection({ ...upstream.userStories, stories: upstream.userStories.stories.filter((story) => story.key !== "create-issue") }, upstream.userStoriesUpstreamProjectionSha256);
    const parsed = parseDatabaseSchemaDocument(source, reduced);
    expect(parsed.upstreamCompatibilityFindings.map((entry) => entry.pointer)).toEqual(expect.arrayContaining([
      expect.stringContaining("structuralDecisions"), expect.stringContaining("storyCoverage"),
    ]));
    const broken = source.replace('"tableKeys": [\n        "issues"\n      ]', '"tableKeys": [\n        "missing"\n      ]');
    expect(() => parseDatabaseSchemaDocument(broken, upstream)).toThrow(/unknown table/);
  });

  it("preserves store safety and concurrent-modification semantics", async () => {
    const upstream = directUpstream();
    const schema = applicableSchema(upstream);
    const projectRoot = await root();
    const upstreamHash = databaseSchemaUpstreamProjectionSha256(upstream);
    const authoritativeHash = databaseSchemaAuthoritativeInputSha256({ upstreamProjectionSha256: upstreamHash, acceptedDecisions: databaseSchemaAcceptedDecisionProjection(schema) });
    const source = renderDatabaseSchemaDocument(schema, upstream, { upstreamProjectionSha256: upstreamHash, authoritativeInputSha256: authoritativeHash });
    await writeDatabaseSchemaAtomically(projectRoot, upstream, source, undefined);
    const loaded = await loadDatabaseSchema(projectRoot, upstream);
    await writeFile(loaded!.path, source.replace("Store explicitly approved issue state.", "Concurrent developer edit."));
    await expect(writeDatabaseSchemaAtomically(projectRoot, upstream, source, loaded!.sourceSha256)).rejects.toThrow(/CONCURRENT_MODIFICATION/);

    const unsafeRoot = await root();
    await mkdir(resolve(unsafeRoot, ".spec", "init"), { recursive: true });
    await symlink(resolve(projectRoot, ".spec", "init", "database-schema.md"), resolve(unsafeRoot, ".spec", "init", "database-schema.md"));
    await expect(loadDatabaseSchema(unsafeRoot, upstream)).rejects.toThrow(/UNSAFE_PROGRESSIVE_INIT_PATH/);
    const nonRegularRoot = await root();
    await mkdir(resolve(nonRegularRoot, ".spec", "init", "database-schema.md"), { recursive: true });
    await expect(loadDatabaseSchema(nonRegularRoot, upstream)).rejects.toThrow(/UNSAFE_PROGRESSIVE_INIT_PATH/);
  });

  it("canonicalizes unique constraints, rejects duplicates/names/PK references, and excludes proposal history from freshness", () => {
    const upstream = directUpstream();
    const base = applicableSchema(upstream);
    const invalids: DatabaseSchema[] = [
      { ...base, tables: [...base.tables, { ...base.tables[0]!, key: "duplicate" as any }] },
      { ...base, tables: base.tables.map((table) => ({ ...table, fields: [...table.fields, { ...table.fields[0]!, key: "other-id" as any }] })) },
      { ...base, tables: base.tables.map((table) => ({ ...table, primaryKeyFieldKeys: ["missing" as any] })) },
      { ...base, tables: base.tables.map((table) => ({ ...table, uniqueConstraints: [{ fieldKeys: ["title" as any] }, { fieldKeys: ["title" as any] }] })) },
    ];
    for (const invalid of invalids) expect(validateDatabaseSchema(invalid, upstream).ok).toBe(false);
    const withConstraint = canonicalizeDatabaseSchema({
      ...base,
      tables: base.tables.map((table) => ({ ...table, uniqueConstraints: [{ fieldKeys: ["title" as any, "id" as any] }] })),
    });
    expect(withConstraint.tables[0]!.uniqueConstraints[0]!.fieldKeys).toEqual(["id", "title"]);
    const projection = databaseSchemaAcceptedDecisionProjection(base);
    expect(JSON.stringify(projection)).not.toContain("tables");
    expect(JSON.stringify(projection)).not.toContain("proposal");
  });
});
