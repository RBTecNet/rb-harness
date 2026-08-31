import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { semanticKey } from "../../src/vnext/identity.js";
import { pendingQuestionEvidence, selectInterviewAnswer } from "../../src/vnext/interview.js";
import { PROGRESSIVE_INIT_STAGES, parseProgressiveInitStage } from "../../src/vnext/progressive-init/stages.js";
import { parseProjectDescriptionDocument, renderProjectDescriptionDocument } from "../../src/vnext/progressive-init/project-description-document.js";
import {
  PROJECT_DESCRIPTION_SCHEMA,
  decodeProjectDescriptionWire,
  progressiveRequestBackedStatement,
  progressiveRequestEvidenceIsVerified,
  projectDescriptionAcceptedDecisionProjection,
  projectDescriptionForPersistence,
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
const DOGFOOD_REQUEST = [
  "O sistema deve permitir cadastrar clientes e equipamentos.",
  "O cliente aprova ou rejeita o orçamento.",
  "No primeiro MVP não precisamos de estoque, financeiro, emissão fiscal ou integração com WhatsApp.",
  "Quero testes automatizados para os principais fluxos.",
].join("\n");
const payload = (objective = "Track project issues through a small reliable workflow.") => ({
  contract: "rb-project-description/v1", stage: "project-description", originalRequest: REQUEST,
  project: { key: "issue-tracker", name: "Issue Tracker", objective },
  actors: [{ key: "developer", name: "Developer", responsibility: "Creates and manages project issues." }],
  capabilities: [{ key: "manage-issues", statement: "Create and update project issues." }],
  workflows: [{ key: "issue-lifecycle", statement: "A developer creates and updates an issue.", actorKeys: ["developer"], capabilityKeys: ["manage-issues"] }],
  constraints: [],
  determinations: [{ key: "automated-tests", rationale: "The request explicitly requires automated tests.", materiality: "implementation", rigidity: "RIGID", source: { kind: "request", evidence: "include automated tests" } }],
  qualityCommands: [{ key: "test-suite", kind: "test", command: "npm test" }], questions: [],
});

const questionPayload = () => ({
  ...payload(),
  determinations: [],
  questions: [{
    key: "scope-choice", question: "Should the first release remain deliberately small?", materiality: "product", rigidity: "RIGID",
    recommendedAnswer: { value: "Keep the first release small", rationale: "It creates a bounded and verifiable MVP." },
    alternatives: ["Include all future capabilities"],
  }],
});

const manualDogfoodQuestionPayload = () => ({
  ...payload(),
  questions: [
    {
      key: "interface-mvp", question: "Qual interface o MVP deve expor?", materiality: "product", rigidity: "RIGID",
      recommendedAnswer: { value: "API HTTP REST com persistência local simples, sem interface gráfica no MVP.", rationale: "Mantém uma fronteira de interface explícita e pequena." },
      alternatives: ["Interface gráfica"],
    },
    {
      key: "registro-decisao-orcamento", question: "Quem registra a decisão sobre o orçamento?", materiality: "product", rigidity: "RIGID",
      recommendedAnswer: { value: "O atendente registra no sistema a decisão informada pelo cliente, identificando a ordem de serviço.", rationale: "Preserva a responsabilidade operacional do atendente." },
      alternatives: ["O cliente registra diretamente"],
    },
    {
      key: "autenticacao-mvp", question: "Como deve funcionar a autenticação no MVP?", materiality: "architecture", rigidity: "FLEXIBLE",
      recommendedAnswer: { value: "Autenticação simples por usuário e senha.", rationale: "Fornece uma fronteira de acesso mínima." },
      alternatives: ["Sem autenticação"],
    },
    {
      key: "persistencia-mvp", question: "Como os dados devem ser persistidos no MVP?", materiality: "architecture", rigidity: "RIGID",
      recommendedAnswer: { value: "Banco relacional embarcado (SQLite) atrás de uma camada de repositório.", rationale: "Oferece persistência local com separação arquitetural." },
      alternatives: ["Arquivo JSON"],
    },
  ],
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
    expect((await inspectProgressiveInit(projectRoot, REQUEST))[1]?.status).toBe("incomplete");
    await expect(readFile(resolve(projectRoot, ".rb", "init", "PHASES.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(resolve(projectRoot, ".spec", "init", "user-stories.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats focused complete-fresh project-description as an idempotent zero-call success", async () => {
    const projectRoot = await root();
    const first = await runProgressiveInit({ ...common(projectRoot, new Adapter([payload()])), selectedStage: "project-description" });
    const sourceBefore = await readFile(first.artifactPath!, "utf8");
    const recordPath = resolve(projectRoot, ".rb-harness", "progressive-init", "project-description.json");
    const recordBefore = await readFile(recordPath, "utf8");
    const adapter = new Adapter([]);
    const events: string[] = [];
    let beforeWriteCalled = false;
    const result = await runProgressiveInit({
      projectRoot,
      originalRequest: REQUEST,
      selectedStage: "project-description",
      adapter,
      beforeWrite: () => { beforeWriteCalled = true; },
      presentation: {
        stage: (stage) => { events.push(`stage:${stage}`); },
        complete: (stage, disposition) => { events.push(`complete:${stage}:${disposition}`); },
      },
    });
    expect(result).toEqual({
      mode: "focused",
      selectedStage: "project-description",
      completedStage: "project-description",
      semanticOperations: 0,
      correctiveRegenerations: 0,
    });
    expect(events).toEqual(["stage:project-description", "complete:project-description:existing-fresh"]);
    expect(adapter.requests).toHaveLength(0);
    expect(beforeWriteCalled).toBe(false);
    expect(await readFile(first.artifactPath!, "utf8")).toBe(sourceBefore);
    expect(await readFile(recordPath, "utf8")).toBe(recordBefore);
    expect((await inspectProgressiveInit(projectRoot, REQUEST))[0]?.status).toBe("complete-fresh");
  });

  it("still executes incomplete and complete-stale project-description stages", async () => {
    const incompleteRoot = await root();
    const incompleteAdapter = new Adapter([payload()]);
    expect((await runProgressiveInit({ ...common(incompleteRoot, incompleteAdapter), selectedStage: "project-description" })).semanticOperations).toBe(1);
    expect(incompleteAdapter.requests).toHaveLength(1);

    await writeFile(resolve(incompleteRoot, "stale-input.ts"), "export {};\n");
    expect((await inspectProgressiveInit(incompleteRoot, REQUEST))[0]?.status).toBe("complete-stale");
    const staleAdapter = new Adapter([payload()]);
    expect((await runProgressiveInit({ ...common(incompleteRoot, staleAdapter), selectedStage: "project-description" })).semanticOperations).toBe(1);
    expect(staleAdapter.requests).toHaveLength(1);
  });

  it("focused project-description stops, and unready downstream stages fail without generation or predecessor mutation", async () => {
    const projectRoot = await root(); const adapter = new Adapter([payload()]);
    const result = await runProgressiveInit({ ...common(projectRoot, adapter), selectedStage: "project-description" });
    expect(result.nextStage).toBeUndefined(); const before = await readFile(result.artifactPath!, "utf8");
    const noCall = new Adapter([]); await expect(runProgressiveInit({ ...common(projectRoot, noCall), selectedStage: "database-schema" })).rejects.toThrow(/PREREQUISITE_INVALID/);
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
    await writeFile(resolve(projectRoot, "stale-source.ts"), "export {};\n");
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
    const base = {
      ...payload(),
      determinations: [{ ...payload().determinations[0]!, statement: "include automated tests" }],
    } as unknown as ProjectDescription;
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
    const variants = (((properties.determinations as Record<string, unknown>).items as Record<string, unknown>).oneOf) as Record<string, unknown>[];
    const requestVariant = variants[0]!;
    const authoredVariant = variants[1]!;
    const requestProperties = requestVariant.properties as Record<string, unknown>;
    expect(requestVariant.required).not.toContain("statement");
    expect(requestProperties).not.toHaveProperty("statement");
    expect(((((requestProperties.source as Record<string, unknown>).properties as Record<string, unknown>).kind as Record<string, unknown>).enum)).toEqual(["request"]);
    expect((((((authoredVariant.properties as Record<string, unknown>).source as Record<string, unknown>).properties as Record<string, unknown>).kind as Record<string, unknown>).enum))
      .toEqual(["model-default"]);
    const malformed = payload();
    malformed.determinations[0] = { ...malformed.determinations[0]!, source: { kind: "developer" } } as any;
    const decoded = decodeProjectDescriptionWire(malformed, REQUEST);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.findings).toContainEqual(expect.objectContaining({ pointer: "/determinations/0/source/kind", code: "shape" }));
  });

  it.each([
    { kind: "question", questionKey: "scope-choice" },
    { kind: "user-answer", questionKey: "scope-choice", value: "Keep the first release small" },
    { kind: "accepted-recommendation", questionKey: "scope-choice", value: "Keep the first release small", acceptanceMode: "non-interactive-policy" },
  ])("rejects obsolete provider-authored interview authority $kind", (source) => {
    const malformed = payload();
    malformed.determinations[0] = { ...malformed.determinations[0]!, statement: "Provider-restated interview value", source } as any;
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
    await writeFile(resolve(projectRoot, "stale-source.ts"), "export {};\n");
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
    "O cliente aprova ou rejeita o orçamento.",
    "No primeiro MVP não precisamos de estoque, financeiro, emissão fiscal ou integração com WhatsApp.",
    "Quero testes automatizados para os principais fluxos.",
  ])("derives a real-model-style request fact from verified evidence without a provider statement: %s", (evidence) => {
    const candidate = { ...payload(), originalRequest: DOGFOOD_REQUEST };
    candidate.determinations[0] = {
      ...candidate.determinations[0]!,
      materiality: "product",
      rigidity: "RIGID",
      source: { kind: "request", evidence },
    };
    expect(candidate.determinations[0]).not.toHaveProperty("statement");
    const decoded = decodeProjectDescriptionWire(candidate, DOGFOOD_REQUEST);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      const resolved = resolveProjectDescriptionWire(decoded.value, []);
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.value.determinations[0]).toMatchObject({
          statement: progressiveRequestBackedStatement(evidence),
          materiality: "product",
          rigidity: "RIGID",
          source: { kind: "request", evidence },
        });
      }
    }
  });

  it.each([
    ["model interpretation", "Quero testes automatizados para os principais fluxos.", "Adopt Vitest as the automated test runner."],
    ["semantic inversion", "O cliente aprova ou rejeita o orçamento.", "O cliente não pode rejeitar o orçamento."],
    ["unrelated interpretation", "O cliente aprova ou rejeita o orçamento.", "Deploy using Kubernetes."],
  ] as const)("rejects a second model-authored request statement structurally: %s", (_case, evidence, statement) => {
    const candidate = { ...payload(), originalRequest: DOGFOOD_REQUEST };
    candidate.determinations[0] = {
      ...candidate.determinations[0]!,
      statement,
      source: { kind: "request", evidence },
    } as any;
    const decoded = decodeProjectDescriptionWire(candidate, DOGFOOD_REQUEST);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.findings).toContainEqual(expect.objectContaining({
      code: "shape",
      pointer: "/determinations/0",
      message: "unexpected fields: statement",
    }));
  });

  it("rejects request authority from another request and incidental evidence", () => {
    expect(progressiveRequestEvidenceIsVerified("Build a dashboard.", "Use PostgreSQL")).toBe(false);
    expect(progressiveRequestEvidenceIsVerified(DOGFOOD_REQUEST, "estoque")).toBe(false);
    const wrongRequest = { ...payload(), originalRequest: DOGFOOD_REQUEST };
    wrongRequest.determinations[0] = {
      ...wrongRequest.determinations[0]!,
      source: { kind: "request", evidence: "Use PostgreSQL" },
    };
    const decoded = decodeProjectDescriptionWire(wrongRequest, DOGFOOD_REQUEST);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(resolveProjectDescriptionWire(decoded.value, []).ok).toBe(false);
  });

  it("accepts RIGID request evidence resolved by Core and still forbids a RIGID product model-default", () => {
    const requestBacked = { ...payload(), originalRequest: DOGFOOD_REQUEST };
    requestBacked.determinations[0] = {
      ...requestBacked.determinations[0]!,
      materiality: "architecture",
      rigidity: "RIGID",
      source: { kind: "request", evidence: "Quero testes automatizados para os principais fluxos." },
    };
    const requestDecoded = decodeProjectDescriptionWire(requestBacked, DOGFOOD_REQUEST);
    expect(requestDecoded.ok).toBe(true);
    if (requestDecoded.ok) expect(resolveProjectDescriptionWire(requestDecoded.value, []).ok).toBe(true);

    const modelDefault = { ...payload(), originalRequest: DOGFOOD_REQUEST };
    modelDefault.determinations[0] = {
      ...modelDefault.determinations[0]!,
      statement: "Adopt Vitest as the automated test runner.",
      materiality: "architecture",
      rigidity: "RIGID",
      source: { kind: "model-default" },
    } as any;
    const defaultDecoded = decodeProjectDescriptionWire(modelDefault, DOGFOOD_REQUEST);
    expect(defaultDecoded.ok).toBe(true);
    if (defaultDecoded.ok) expect(resolveProjectDescriptionWire(defaultDecoded.value, []).ok).toBe(false);
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

  it("materializes every resolved manual-dogfood question in Core and persists the explicit no-auth decision", async () => {
    const explicitNoAuth = "Sem autenticação no MVP, apenas identificação do papel na requisição";
    const answer = async (question: { readonly key: string }) => question.key === "autenticacao-mvp" ? explicitNoAuth : "";
    const liveRoot = await root();
    const live = await runProjectDescriptionOperation({
      originalRequest: REQUEST,
      discovery: await discoverProjectDescriptionEnvironment(liveRoot),
      profile,
      adapter: new Adapter([manualDogfoodQuestionPayload()]),
      auth,
      interview: { kind: "interactive", answer },
      deadlineMs: 10_000,
    });
    const interviewKeys = new Set(["interface-mvp", "registro-decisao-orcamento", "autenticacao-mvp", "persistencia-mvp"]);
    const materialized = live.value.determinations.filter((entry) => interviewKeys.has(entry.key));
    expect(materialized).toHaveLength(4);
    expect(materialized.find((entry) => entry.key === "interface-mvp")).toMatchObject({
      statement: "API HTTP REST com persistência local simples, sem interface gráfica no MVP.",
      materiality: "product", rigidity: "RIGID", source: { kind: "accepted-recommendation", acceptanceMode: "blank-interactive" },
    });
    expect(materialized.find((entry) => entry.key === "registro-decisao-orcamento")?.statement)
      .toBe("O atendente registra no sistema a decisão informada pelo cliente, identificando a ordem de serviço.");
    expect(materialized.find((entry) => entry.key === "autenticacao-mvp")).toMatchObject({
      statement: explicitNoAuth,
      rationale: "Selected through an explicit user answer to a material interview question.",
      materiality: "architecture", rigidity: "FLEXIBLE",
      source: { kind: "user-answer", questionKey: "autenticacao-mvp", value: explicitNoAuth },
    });
    expect(materialized.find((entry) => entry.key === "persistencia-mvp")?.statement)
      .toBe("Banco relacional embarcado (SQLite) atrás de uma camada de repositório.");

    const persistedRoot = await root();
    const persisted = await runProgressiveInit({
      projectRoot: persistedRoot,
      originalRequest: REQUEST,
      selectedStage: "project-description",
      profile,
      adapter: new Adapter([manualDogfoodQuestionPayload()]),
      auth,
      interview: { kind: "interactive", answer },
    });
    const reloaded = parseProjectDescriptionDocument(await readFile(persisted.artifactPath!, "utf8")).value;
    const persistedNoAuth = reloaded.determinations.find((entry) => entry.key === "autenticacao-mvp");
    expect(persistedNoAuth).toMatchObject({ statement: explicitNoAuth, source: { kind: "developer" } });
    expect(reloaded.determinations.filter((entry) => interviewKeys.has(entry.key))).toHaveLength(4);
  });

  it("fails closed on provider/interview and developer/interview determination-key collisions", async () => {
    const providerCollision = manualDogfoodQuestionPayload();
    providerCollision.determinations.push({
      key: "interface-mvp", rationale: "The request requires automated tests.", materiality: "implementation", rigidity: "FLEXIBLE",
      source: { kind: "request", evidence: "include automated tests" },
    });
    const decoded = decodeProjectDescriptionWire(providerCollision, REQUEST);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      const evidence = decoded.value.questions.map((question) => selectInterviewAnswer(pendingQuestionEvidence(question), { kind: "headless" }));
      const outcome = resolveProjectDescriptionWire(decoded.value, evidence);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.findings).toContainEqual(expect.objectContaining({ message: expect.stringContaining("conflicts with a provider-authored determination") }));
    }

    const cleanWire = decodeProjectDescriptionWire(manualDogfoodQuestionPayload(), REQUEST);
    expect(cleanWire.ok).toBe(true);
    if (cleanWire.ok) {
      const evidence = cleanWire.value.questions.map((question) => selectInterviewAnswer(pendingQuestionEvidence(question), { kind: "headless" }));
      const existing = projectDescriptionForPersistence({
        ...(payload() as unknown as ProjectDescription),
        determinations: [{
          key: semanticKey("interface-mvp")!, statement: "Existing developer interface", rationale: "Developer-owned decision.",
          materiality: "product", rigidity: "RIGID", source: { kind: "developer" },
        }],
      });
      const outcome = resolveProjectDescriptionWire(cleanWire.value, evidence, existing);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.findings).toContainEqual(expect.objectContaining({ message: expect.stringContaining("conflicts with an existing developer-owned determination") }));
    }
  });

  it("binds Project Description freshness to Core-owned interview decisions, not presentation text", async () => {
    const run = async (answerValue: string) => {
      const projectRoot = await root();
      return runProjectDescriptionOperation({
        originalRequest: REQUEST,
        discovery: await discoverProjectDescriptionEnvironment(projectRoot),
        profile,
        adapter: new Adapter([manualDogfoodQuestionPayload()]),
        auth,
        interview: { kind: "interactive", answer: async (question) => question.key === "autenticacao-mvp" ? answerValue : "" },
        deadlineMs: 10_000,
      });
    };
    const withoutAuth = await run("Sem autenticação no MVP, apenas identificação do papel na requisição");
    const withAuth = await run("Com autenticação obrigatória no MVP");
    expect(projectDescriptionAcceptedDecisionProjection(withoutAuth.value)).not.toEqual(projectDescriptionAcceptedDecisionProjection(withAuth.value));
    expect(projectDescriptionSemanticSha256(withoutAuth.value)).not.toBe(projectDescriptionSemanticSha256(withAuth.value));
  });

  it("uses one complete-stage correction and leaves canonical recovery authority unchanged", async () => {
    const projectRoot = await root(); const invalid = { ...payload(), actors: [] }; const adapter = new Adapter([invalid, payload()]);
    const result = await runProgressiveInit({ ...common(projectRoot, adapter), selectedStage: "project-description" });
    expect(result).toMatchObject({ semanticOperations: 2, correctiveRegenerations: 1 }); expect(adapter.requests[1]?.input).toContain("Regenerate the COMPLETE"); expect(adapter.requests[1]?.input).toContain("/actors");
    expect(CANONICAL_INIT_RECOVERY_BUDGET).toEqual({ maxCorrectiveRegenerationsPerSlice: 2, maxCorrectiveRegenerationsPerRun: 3, maxSemanticOperationsPerRun: 5, maxTransportInvocationsPerRun: 7, maxTransportRetriesPerSemanticOperation: 1, maxTransportRetriesPerRun: 2 });
  });
});
