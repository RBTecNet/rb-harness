import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { semanticKey } from "../../src/vnext/identity.js";
import { PROGRESSIVE_INIT_STAGES, parseProgressiveInitStage } from "../../src/vnext/progressive-init/stages.js";
import { parseProjectDescriptionDocument, renderProjectDescriptionDocument } from "../../src/vnext/progressive-init/project-description-document.js";
import {
  PROJECT_DESCRIPTION_SCHEMA,
  decodeProjectDescriptionWire,
  progressiveRequestDeterminationIsVerified,
  projectDescriptionAcceptedDecisionProjection,
  projectDescriptionSemanticSha256,
  resolveProjectDescriptionWire,
  type ProjectDescription,
} from "../../src/vnext/progressive-init/project-description-ir.js";
import { runProjectDescriptionOperation } from "../../src/vnext/progressive-init/project-description-operation.js";
import { inspectProgressiveInit, runProgressiveInit } from "../../src/vnext/progressive-init/coordinator.js";
import { discoverProjectDescriptionEnvironment, projectDescriptionDiscoverySha256 } from "../../src/vnext/progressive-init/discovery.js";
import { projectDescriptionAuthoritativeInputSha256 } from "../../src/vnext/progressive-init/project-description-ir.js";
import { CANONICAL_INIT_RECOVERY_BUDGET } from "../../src/vnext/recovery-budget.js";
import type { CanonicalSemanticResponse, ModelProfile, ProviderAdapter, ProviderOutcome, ResolvedProviderAuth, SemanticRequest } from "../../src/vnext/providers/contract.js";

const REQUEST = "Build a small issue tracker for developers and include automated tests.";
const payload = (objective = "Track project issues through a small reliable workflow.") => ({
  contract: "rb-project-description/v1", stage: "project-description", originalRequest: REQUEST,
  project: { key: "issue-tracker", name: "Issue Tracker", objective },
  actors: [{ key: "developer", name: "Developer", responsibility: "Creates and manages project issues." }],
  capabilities: [{ key: "manage-issues", statement: "Create and update project issues." }],
  workflows: [{ key: "issue-lifecycle", statement: "A developer creates and updates an issue.", actorKeys: ["developer"], capabilityKeys: ["manage-issues"] }],
  constraints: [],
  determinations: [{ key: "automated-tests", statement: "include automated tests", rationale: "The request explicitly requires automated tests.", materiality: "implementation", rigidity: "RIGID", source: { kind: "request", evidence: "include automated tests" } }],
  qualityCommands: [{ key: "test-suite", kind: "test", command: "npm test" }], questions: [],
});

const questionPayload = () => ({
  ...payload(),
  determinations: [{
    key: "scope-choice", statement: "Keep the first release small", rationale: "A bounded release is independently verifiable.",
    materiality: "product", rigidity: "RIGID", source: { kind: "question", questionKey: "scope-choice" },
  }],
  questions: [{
    key: "scope-choice", question: "Should the first release remain deliberately small?", materiality: "product", rigidity: "RIGID",
    recommendedAnswer: { value: "Keep the first release small", rationale: "It creates a bounded and verifiable MVP." },
    alternatives: ["Include all future capabilities"],
  }],
});

const profile: ModelProfile = {
  id: "fixture:progressive", family: "fixture", transport: "claude-code-cli", requestAccounting: "opaque", modelId: "fixture", label: "Fixture",
  runtime: { kind: "external-executable", versionPolicy: "exact-recorded" }, structuredOutput: "claude-code-json-schema", strictSchema: true,
  toolCalling: false, toolChoiceForcing: false, reasoning: { supported: false }, maxOutputTokens: 128_000, systemRole: "system",
  streaming: { supported: true, usageInStream: false }, usageReporting: { inputTokens: false, cachedInputTokens: false, cacheWriteTokens: false, outputTokens: false, reasoningTokens: false, costUsd: false },
  conformance: { tier: "SUPPORTED", suiteVersion: "fixture/v1", runId: "fixture", recordedAt: "2026-08-30T00:00:00.000Z", normalizationsOnHappyPath: [], verifiedRecord: true },
};
const auth: ResolvedProviderAuth = { kind: "ambient-session", id: "fixture" };
class Adapter implements ProviderAdapter {
  readonly family = "fixture"; readonly transport = "claude-code-cli" as const; readonly profiles = [profile]; readonly requests: SemanticRequest[] = [];
  constructor(private readonly script: unknown[]) {}
  checkCapabilities(): ProviderOutcome<true> { return { ok: true, value: true }; }
  async request(_p: ModelProfile, _a: ResolvedProviderAuth, request: SemanticRequest): Promise<ProviderOutcome<CanonicalSemanticResponse>> {
    this.requests.push(request); const body = this.script.shift(); if (!body) throw new Error("script exhausted");
    return { ok: true, value: { slice: request.slice, payload: structuredClone(body), normalizations: [], usage: {
      inputTokens: { measured: false, reason: "unsupported-by-provider" }, cachedInputTokens: { measured: false, reason: "unsupported-by-provider" }, cacheWriteTokens: { measured: false, reason: "unsupported-by-provider" }, outputTokens: { measured: false, reason: "unsupported-by-provider" }, reasoningTokens: { measured: false, reason: "unsupported-by-provider" }, providerRequests: { measured: false, reason: "unsupported-by-provider" }, costUsd: { measured: false, reason: "unsupported-by-provider" },
    }, transport: { startedAt: "2026-08-30T00:00:00.000Z", completedAt: "2026-08-30T00:00:00.001Z", firstOutputMs: { measured: false, reason: "unsupported-by-provider" }, httpStatus: { measured: false, reason: "unsupported-by-provider" }, requestId: { measured: false, reason: "unsupported-by-provider" }, stopReason: { measured: false, reason: "unsupported-by-provider" } } } };
  }
  replay(): ProviderOutcome<CanonicalSemanticResponse> { throw new Error("unused"); }
}
const root = () => mkdtemp(resolve(tmpdir(), "rb-progressive-phase1-"));
const common = (projectRoot: string, adapter: Adapter) => ({ projectRoot, originalRequest: REQUEST, profile, adapter, auth, interview: { kind: "headless" as const } });

describe("Progressive Init Phase 1", () => {
  it("owns one exact closed stage vocabulary and rejects arbitrary stages", () => {
    expect(PROGRESSIVE_INIT_STAGES).toEqual(["project-description", "user-stories", "database-schema", "project-phases"]);
    expect(() => parseProgressiveInitStage("other")).toThrow(/expected one of/);
  });

  it("strictly round-trips canonical Markdown while stable keys survive item reordering", async () => {
    const projectRoot = await root(); const discovery = await discoverProjectDescriptionEnvironment(projectRoot); const hash = projectDescriptionDiscoverySha256(discovery);
    const result = await runProgressiveInit({ ...common(projectRoot, new Adapter([payload()])), selectedStage: "project-description" });
    const source = await readFile(result.artifactPath!, "utf8"); const parsed = parseProjectDescriptionDocument(source);
    expect(parsed.value.determinations[0]?.source).toEqual({ kind: "developer" });
    expect(parseProjectDescriptionDocument(renderProjectDescriptionDocument(parsed.value, { originalRequestSha256: parsed.metadata.originalRequestSha256, discoverySha256: hash, authoritativeInputSha256: parsed.metadata.authoritativeInputSha256 })).value).toEqual(parsed.value);
    const value: ProjectDescription = { ...parsed.value, actors: [...parsed.value.actors].reverse() };
    expect(projectDescriptionSemanticSha256(value)).toBe(projectDescriptionSemanticSha256(parsed.value));
  });

  it("automatically selects project-description, persists only progressive authority, and then identifies user-stories", async () => {
    const projectRoot = await root(); await writeFile(resolve(projectRoot, "keep.txt"), "source"); const adapter = new Adapter([payload()]);
    const result = await runProgressiveInit(common(projectRoot, adapter));
    expect(result).toMatchObject({ mode: "automatic", selectedStage: "project-description", completedStage: "project-description", nextStage: "user-stories" });
    expect(adapter.requests).toHaveLength(1); expect(adapter.requests[0]?.slice).toBe("project-description");
    expect((await inspectProgressiveInit(projectRoot, REQUEST))[0]?.status).toBe("complete-fresh");
    expect((await inspectProgressiveInit(projectRoot, REQUEST))[0]?.status).toBe("complete-fresh");
    await expect(readFile(resolve(projectRoot, ".rb", "init", "PHASES.md"))).rejects.toMatchObject({ code: "ENOENT" });
    const noCall = new Adapter([]); await expect(runProgressiveInit(common(projectRoot, noCall))).rejects.toThrow(/STAGE_NOT_IMPLEMENTED_PHASE_1: user-stories/); expect(noCall.requests).toHaveLength(0);
  });

  it("focused project-description stops, and focused later stages fail without generation or predecessor mutation", async () => {
    const projectRoot = await root(); const adapter = new Adapter([payload()]);
    const result = await runProgressiveInit({ ...common(projectRoot, adapter), selectedStage: "project-description" });
    expect(result.nextStage).toBeUndefined(); const before = await readFile(result.artifactPath!, "utf8");
    const noCall = new Adapter([]); await expect(runProgressiveInit({ ...common(projectRoot, noCall), selectedStage: "user-stories" })).rejects.toThrow(/NOT_IMPLEMENTED_PHASE_1/);
    expect(noCall.requests).toHaveLength(0); expect(await readFile(result.artifactPath!, "utf8")).toBe(before);
    await expect(runProgressiveInit({ ...common(await root(), noCall), selectedStage: "user-stories" })).rejects.toThrow(/PREREQUISITE_INVALID/);
  });

  it("presents the active stage before only project-description interview questions", async () => {
    const projectRoot = await root(); const events: string[] = [];
    await runProgressiveInit({ ...common(projectRoot, new Adapter([questionPayload()])), selectedStage: "project-description", presentation: {
      stage: (stage) => { events.push(`stage:${stage}`); }, question: (question) => { events.push(`question:${question.key}`); },
    } });
    expect(events).toEqual(["stage:project-description", "question:scope-choice"]);
  });

  it("accepts a supported manual edit as current typed authority and rejects invalid source before provider use", async () => {
    const projectRoot = await root(); const first = await runProgressiveInit({ ...common(projectRoot, new Adapter([payload()])), selectedStage: "project-description" });
    const source = await readFile(first.artifactPath!, "utf8");
    const edited = source
      .replace('Objective: "Track project issues through a small reliable workflow."', 'Objective: "Developer-edited objective remains authoritative."')
      .replace('Statement: "include automated tests"', 'Statement: "Developer requires contract-level verification"')
      .replace("Materiality: implementation", "Materiality: product");
    await writeFile(first.artifactPath!, edited);
    const parsed = parseProjectDescriptionDocument(await readFile(first.artifactPath!, "utf8"));
    expect(parsed.value.project.objective).toBe("Developer-edited objective remains authoritative.");
    expect(parsed.value.determinations[0]).toMatchObject({ statement: "Developer requires contract-level verification", materiality: "product", rigidity: "RIGID", source: { kind: "developer" } });
    expect(parsed.developerModified).toBe(true);
    const echo = payload("Developer-edited objective remains authoritative.");
    echo.determinations[0] = { ...echo.determinations[0]!, statement: "Developer requires contract-level verification", materiality: "product", source: { kind: "model-default" } } as any;
    const rerunAdapter = new Adapter([echo]); await runProgressiveInit({ ...common(projectRoot, rerunAdapter), selectedStage: "project-description" });
    expect(JSON.parse(rerunAdapter.requests[0]!.input).existingDeveloperAuthority.project.objective).toBe("Developer-edited objective remains authoritative.");
    const rewritten = parseProjectDescriptionDocument(await readFile(first.artifactPath!, "utf8"));
    expect(rewritten.value.determinations[0]?.source).toEqual({ kind: "developer" });
    expect(rewritten.developerModified).toBe(false);
    await writeFile(first.artifactPath!, "# arbitrary markdown\n"); const invalidAdapter = new Adapter([payload()]);
    await expect(runProgressiveInit({ ...common(projectRoot, invalidAdapter), selectedStage: "project-description" })).rejects.toThrow(/INVALID_PROJECT_DESCRIPTION_DOCUMENT/); expect(invalidAdapter.requests).toHaveLength(0); expect(await readFile(first.artifactPath!, "utf8")).toBe("# arbitrary markdown\n");
  });

  it("fails closed on concurrent edits and preserves the developer bytes", async () => {
    const projectRoot = await root(); const path = resolve(projectRoot, ".spec", "init", "project-description.md");
    await runProgressiveInit({ ...common(projectRoot, new Adapter([payload()])), selectedStage: "project-description" });
    await expect(runProgressiveInit({ ...common(projectRoot, new Adapter([payload()])), selectedStage: "project-description", beforeWrite: () => writeFile(path, "developer concurrent edit\n") })).rejects.toThrow(/CONCURRENT_MODIFICATION/);
    expect(await readFile(path, "utf8")).toBe("developer concurrent edit\n");
  });

  it("classifies deterministic request, discovery, and contract freshness", async () => {
    const projectRoot = await root(); await runProgressiveInit({ ...common(projectRoot, new Adapter([payload()])), selectedStage: "project-description" });
    expect((await inspectProgressiveInit(projectRoot, REQUEST))[0]?.status).toBe("complete-fresh");
    expect((await inspectProgressiveInit(projectRoot, "A materially changed request"))[0]?.status).toBe("complete-stale");
    await writeFile(resolve(projectRoot, "new-source.ts"), "export {};\n"); expect((await inspectProgressiveInit(projectRoot, REQUEST))[0]?.status).toBe("complete-stale");
    expect(projectDescriptionAuthoritativeInputSha256({ originalRequest: REQUEST, discoverySha256: "x", acceptedDecisions: [], contractVersion: "v2" })).not.toBe(projectDescriptionAuthoritativeInputSha256({ originalRequest: REQUEST, discoverySha256: "x", acceptedDecisions: [] }));
    const path = resolve(projectRoot, ".spec", "init", "project-description.md"); const source = await readFile(path, "utf8");
    await writeFile(path, source.replace("rb-project-description/v1", "rb-project-description/v2")); await expect(inspectProgressiveInit(projectRoot, REQUEST)).rejects.toThrow(/contract must be rb-project-description\/v1/);
  });

  it("includes canonical request, interview, and developer decisions in freshness authority", () => {
    const base = payload() as unknown as ProjectDescription;
    const sources = [
      { kind: "request", evidence: "automated tests" },
      { kind: "user-answer", questionKey: semanticKey("scope-choice")!, value: "Use automated tests" },
      { kind: "accepted-recommendation", questionKey: semanticKey("scope-choice")!, value: "Use automated tests", acceptanceMode: "non-interactive-policy" },
      { kind: "developer" },
    ] as const;
    const projections = sources.map((source) => projectDescriptionAcceptedDecisionProjection({
      ...base,
      determinations: [{ ...base.determinations[0]!, source }],
    }));
    expect(projections.every((projection) => projection.length === 1)).toBe(true);
    for (const [index, source] of sources.entries()) {
      const changed = projectDescriptionAcceptedDecisionProjection({
        ...base,
        determinations: [{ ...base.determinations[0]!, statement: `Materially changed decision ${index}`, source }],
      });
      expect(changed).not.toEqual(projections[index]);
    }
  });

  it("removes developer from the provider schema and rejects it in the production decoder", () => {
    const properties = PROJECT_DESCRIPTION_SCHEMA.properties as Record<string, unknown>;
    const sourceKind = ((((properties.determinations as Record<string, unknown>).items as Record<string, unknown>).properties as Record<string, unknown>).source) as Record<string, unknown>;
    const enumValues = (((sourceKind.properties as Record<string, unknown>).kind as Record<string, unknown>).enum);
    expect(enumValues).toEqual(["request", "user-answer", "accepted-recommendation", "model-default", "question"]);
    const malformed = payload();
    malformed.determinations[0] = { ...malformed.determinations[0]!, source: { kind: "developer" } } as any;
    const decoded = decodeProjectDescriptionWire(malformed, REQUEST);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.findings).toContainEqual(expect.objectContaining({ pointer: "/determinations/0/source/kind", code: "shape" }));
  });

  it.each([
    ["RIGID product", "product", "RIGID"],
    ["FLEXIBLE implementation", "implementation", "FLEXIBLE"],
  ] as const)("rejects model-authored developer authority for %s determinations", async (_case, materiality, rigidity) => {
    const projectRoot = await root();
    const malformed = payload();
    malformed.determinations[0] = { ...malformed.determinations[0]!, materiality, rigidity, source: { kind: "developer" } } as any;
    const adapter = new Adapter([malformed, malformed]);
    await expect(runProgressiveInit({ ...common(projectRoot, adapter), selectedStage: "project-description" }))
      .rejects.toThrow(/PROJECT_DESCRIPTION_INVALID_AFTER_RECOVERY/);
    expect(adapter.requests).toHaveLength(2);
    await expect(readFile(resolve(projectRoot, ".spec", "init", "project-description.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not launder a changed model candidate through an existing developer key", async () => {
    const projectRoot = await root();
    const first = await runProgressiveInit({ ...common(projectRoot, new Adapter([payload()])), selectedStage: "project-description" });
    const before = await readFile(first.artifactPath!, "utf8");
    const changed = payload();
    changed.determinations[0] = {
      ...changed.determinations[0]!, statement: "Replace the developer decision", materiality: "product", rigidity: "RIGID", source: { kind: "model-default" },
    } as any;
    const adapter = new Adapter([changed, changed]);
    await expect(runProgressiveInit({ ...common(projectRoot, adapter), selectedStage: "project-description" }))
      .rejects.toThrow(/PROJECT_DESCRIPTION_INVALID_AFTER_RECOVERY/);
    expect(adapter.requests).toHaveLength(2);
    expect(await readFile(first.artifactPath!, "utf8")).toBe(before);
  });

  it.each([
    ["exact PostgreSQL fact", "Use PostgreSQL", "Use PostgreSQL", true],
    ["exact test requirement", "include automated tests", "include automated tests", true],
    ["over-specific interpretation", "automated tests", "Adopt Vitest as the automated test runner.", false],
    ["semantic inversion", "include automated tests", "Skip automated tests entirely.", false],
    ["unrelated determination", "Use PostgreSQL", "Deploy using Kubernetes.", false],
  ] as const)("binds Progressive request authority structurally: %s", (_case, evidence, statement, expected) => {
    const request = "Use PostgreSQL and include automated tests.";
    expect(progressiveRequestDeterminationIsVerified(request, evidence, statement)).toBe(expected);
    const candidate = { ...payload(), originalRequest: request };
    candidate.determinations[0] = { ...candidate.determinations[0]!, statement, source: { kind: "request", evidence } };
    const decoded = decodeProjectDescriptionWire(candidate, request);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(resolveProjectDescriptionWire(decoded.value, []).ok).toBe(expected);
  });

  it("rejects request authority from another request and incidental evidence", () => {
    expect(progressiveRequestDeterminationIsVerified("Build a dashboard.", "Use PostgreSQL", "Use PostgreSQL")).toBe(false);
    expect(progressiveRequestDeterminationIsVerified("Build a dashboard with a UI.", "a UI", "a UI")).toBe(false);
  });

  it.each(["request", "user-answer", "accepted-recommendation", "model-default"] as const)(
    "rejects persisted %s labels because editable Markdown can honor only developer authority",
    async (kind) => {
      const projectRoot = await root();
      const first = await runProgressiveInit({ ...common(projectRoot, new Adapter([payload()])), selectedStage: "project-description" });
      const replacements = {
        request: '{"kind":"request","evidence":"include automated tests"}',
        "user-answer": '{"kind":"user-answer","questionKey":"scope-choice","value":"include automated tests"}',
        "accepted-recommendation": '{"kind":"accepted-recommendation","questionKey":"scope-choice","value":"include automated tests","acceptanceMode":"non-interactive-policy"}',
        "model-default": '{"kind":"model-default"}',
      };
      const forged = (await readFile(first.artifactPath!, "utf8")).replace('{"kind":"developer"}', replacements[kind]);
      expect(() => parseProjectDescriptionDocument(forged)).toThrow(/persisted Source must be developer authority/);
    },
  );

  it("keeps genuine interview authority live, then persists and reloads it as developer authority", async () => {
    const projectRoot = await root();
    const discovery = await discoverProjectDescriptionEnvironment(projectRoot);
    const explicit = "Ship only core issue tracking";
    const interactive = await runProjectDescriptionOperation({
      originalRequest: REQUEST, discovery, profile, adapter: new Adapter([questionPayload()]), auth,
      interview: { kind: "interactive", answer: async () => explicit }, deadlineMs: 10_000,
    });
    expect(interactive.value.determinations[0]?.source).toEqual({ kind: "user-answer", questionKey: "scope-choice", value: explicit });

    const accepted = await runProjectDescriptionOperation({
      originalRequest: REQUEST, discovery, profile, adapter: new Adapter([questionPayload()]), auth,
      interview: { kind: "headless" }, deadlineMs: 10_000,
    });
    expect(accepted.value.determinations[0]?.source).toEqual({
      kind: "accepted-recommendation", questionKey: "scope-choice", value: "Keep the first release small", acceptanceMode: "non-interactive-policy",
    });

    const persisted = await runProgressiveInit({ ...common(projectRoot, new Adapter([questionPayload()])), selectedStage: "project-description" });
    const source = await readFile(persisted.artifactPath!, "utf8");
    expect(source).toContain('Source: {"kind":"developer"}');
    expect(source).not.toContain('"kind":"accepted-recommendation"');
    expect(parseProjectDescriptionDocument(source).value.determinations[0]?.source).toEqual({ kind: "developer" });
    expect((await inspectProgressiveInit(projectRoot, REQUEST))[0]?.status).toBe("complete-fresh");
    expect((await inspectProgressiveInit(projectRoot, REQUEST))[0]?.status).toBe("complete-fresh");
  });

  it("uses one complete-stage correction and leaves canonical recovery authority unchanged", async () => {
    const projectRoot = await root(); const invalid = { ...payload(), actors: [] }; const adapter = new Adapter([invalid, payload()]);
    const result = await runProgressiveInit({ ...common(projectRoot, adapter), selectedStage: "project-description" });
    expect(result).toMatchObject({ semanticOperations: 2, correctiveRegenerations: 1 }); expect(adapter.requests[1]?.input).toContain("Regenerate the COMPLETE"); expect(adapter.requests[1]?.input).toContain("/actors");
    expect(CANONICAL_INIT_RECOVERY_BUDGET).toEqual({ maxCorrectiveRegenerationsPerSlice: 2, maxCorrectiveRegenerationsPerRun: 3, maxSemanticOperationsPerRun: 5, maxTransportInvocationsPerRun: 7, maxTransportRetriesPerSemanticOperation: 1, maxTransportRetriesPerRun: 2 });
  });
});
