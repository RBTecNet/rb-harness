import { access, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SemanticGateway, SemanticGatewayError } from "../../src/vnext/gateway.js";
import { runSemanticInit } from "../../src/vnext/init.js";
import { questionProblem, selectInterviewAnswer, pendingQuestionEvidence, verifyInterviewEvidence } from "../../src/vnext/interview.js";
import { createInitRunState, transitionInitRunState } from "../../src/vnext/run-state.js";
import type {
  CanonicalSemanticResponse,
  ModelProfile,
  ProviderAdapter,
  ProviderOutcome,
  ProviderResponseError,
  ResolvedProviderAuth,
  SemanticRequest,
} from "../../src/vnext/providers/contract.js";
import { decodeIntentWire, deriveWorkSchema, type WireOutcome } from "../../src/vnext/wire.js";

const INVENTORY_REQUEST = "Build me a simple inventory system.";
const HELLO_REQUEST = "Create a Node.js command-line program named hello with named and default greetings and automated tests.";

function profile(accounting: "exact" | "opaque", transport: "direct-api" | "claude-code-cli" = accounting === "exact" ? "direct-api" : "claude-code-cli"): ModelProfile {
  return {
    id: `fixture:${transport}`,
    family: "fixture",
    transport,
    requestAccounting: accounting,
    modelId: "fixture-model",
    label: "Fixture semantic provider",
    runtime: transport === "direct-api" ? { kind: "built-in" } : { kind: "external-executable", versionPolicy: "exact-recorded" },
    structuredOutput: transport === "direct-api" ? "forced-tool-argument" : "claude-code-json-schema",
    strictSchema: false,
    toolCalling: false,
    toolChoiceForcing: false,
    reasoning: { supported: true, defaultMode: "on", efforts: ["low"], reportsReasoningTokens: false },
    maxOutputTokens: 128_000,
    systemRole: "system",
    streaming: { supported: true, usageInStream: true },
    usageReporting: {
      inputTokens: true,
      cachedInputTokens: false,
      cacheWriteTokens: false,
      outputTokens: true,
      reasoningTokens: false,
      costUsd: false,
    },
    conformance: {
      tier: "SUPPORTED",
      suiteVersion: "fixture/v1",
      runId: "fixture-conformance",
      recordedAt: "2026-08-29T00:00:00.000Z",
      normalizationsOnHappyPath: [],
      verifiedRecord: true,
    },
  };
}

type ScriptEntry = { readonly payload: unknown } | { readonly error: ProviderResponseError };

class ScriptedAdapter implements ProviderAdapter {
  readonly family = "fixture";
  readonly transport: "direct-api" | "claude-code-cli";
  readonly profiles: readonly ModelProfile[];
  readonly requests: SemanticRequest[] = [];

  constructor(readonly selectedProfile: ModelProfile, private readonly script: ScriptEntry[]) {
    this.transport = selectedProfile.transport;
    this.profiles = [selectedProfile];
  }

  checkCapabilities(): ProviderOutcome<true> {
    return { ok: true, value: true };
  }

  async request(_profile: ModelProfile, _auth: ResolvedProviderAuth, request: SemanticRequest): Promise<ProviderOutcome<CanonicalSemanticResponse>> {
    this.requests.push(request);
    const next = this.script.shift();
    if (!next) throw new Error("fixture script exhausted");
    if ("error" in next) return { ok: false, error: next.error };
    const exact = this.selectedProfile.requestAccounting === "exact";
    return {
      ok: true,
      value: {
        slice: request.slice,
        payload: structuredClone(next.payload),
        normalizations: [],
        usage: {
          inputTokens: { measured: true, value: 10 },
          cachedInputTokens: { measured: false, reason: "not-reported-in-this-response" },
          cacheWriteTokens: { measured: false, reason: "not-reported-in-this-response" },
          outputTokens: { measured: true, value: 10 },
          reasoningTokens: { measured: false, reason: "unsupported-by-provider" },
          providerRequests: exact ? { measured: true, value: 1 } : { measured: false, reason: "unsupported-by-provider" },
          costUsd: { measured: false, reason: "unsupported-by-provider" },
        },
        transport: {
          startedAt: "2026-08-29T00:00:00.000Z",
          completedAt: "2026-08-29T00:00:00.010Z",
          firstOutputMs: { measured: true, value: 1 },
          httpStatus: { measured: false, reason: "unsupported-by-provider" },
          requestId: { measured: false, reason: "unsupported-by-provider" },
          stopReason: { measured: true, value: "structured-output" },
        },
      },
    };
  }

  replay(): ProviderOutcome<CanonicalSemanticResponse> {
    throw new Error("not used");
  }
}

const auth: ResolvedProviderAuth = { kind: "ambient-session", id: "fixture" };

function inventoryIntent(questions = true): unknown {
  return {
    format: "rb-init-intent/v1",
    project: {
      name: "inventory",
      objective: "Deliver a small inventory MVP that tracks products and prevents invalid stock changes.",
    },
    determinations: [
      {
        key: "inventory-product",
        statement: "The MVP is a simple inventory system.",
        rationale: "The product category is explicit in the request.",
        materiality: "product",
        rigidity: "RIGID",
        sourceKind: "request",
        evidence: "simple inventory system",
      },
      {
        key: "small-codebase",
        statement: "Keep the initial codebase intentionally small.",
        rationale: "A small implementation is sufficient for the requested MVP.",
        materiality: "implementation",
        rigidity: "FLEXIBLE",
        sourceKind: "model-default",
        evidence: "",
      },
    ],
    requirements: [
      { key: "manage-products", statement: "Users can create and list inventory products." },
      { key: "adjust-stock", statement: "Users can increase and decrease stock quantities." },
      { key: "protect-stock", statement: "Stock changes cannot produce a negative quantity." },
      { key: "automated-tests", statement: "Automated tests cover product and stock behavior." },
    ],
    qualityCommands: [{ key: "test-suite", kind: "test", command: "npm test" }],
    proposedProtectedPaths: [],
    questions: questions ? [
      {
        key: "product-surface",
        question: "Which product surface should the inventory MVP use?",
        materiality: "architecture",
        rigidity: "RIGID",
        recommendedAnswer: {
          value: "A small browser-based application",
          rationale: "A browser UI makes the MVP accessible without requiring local CLI knowledge.",
        },
        alternatives: ["A command-line application"],
      },
      {
        key: "stock-policy",
        question: "How should the MVP handle stock reductions below zero?",
        materiality: "product",
        rigidity: "RIGID",
        recommendedAnswer: {
          value: "Reject changes that would make stock negative",
          rationale: "Rejecting invalid changes preserves a simple and auditable stock invariant.",
        },
        alternatives: ["Allow temporary negative stock"],
      },
    ] : [],
    contradictions: [],
  };
}

function helloIntent(): unknown {
  return {
    format: "rb-init-intent/v1",
    project: { name: "hello", objective: "Deliver a tested Node.js command-line greeting program with named and default output." },
    determinations: [{
      key: "node-cli",
      statement: "The product is a Node.js command-line program named hello.",
      rationale: "The runtime and surface are explicit.",
      materiality: "architecture",
      rigidity: "RIGID",
      sourceKind: "request",
      evidence: "Node.js command-line program named hello",
    }],
    requirements: [
      { key: "named-greeting", statement: "Running hello with a name prints the named greeting." },
      { key: "default-greeting", statement: "Running hello without a name prints the default greeting." },
      { key: "automated-tests", statement: "Automated tests cover both greeting modes." },
    ],
    qualityCommands: [{ key: "test-suite", kind: "test", command: "npm test" }],
    proposedProtectedPaths: [],
    questions: [],
    contradictions: [],
  };
}

function work(kind: "inventory" | "hello" = "inventory", covers?: readonly string[]): unknown {
  const inventory = kind === "inventory";
  return {
    format: "rb-init-work/v1",
    phases: [{
      key: "deliver-mvp",
      title: inventory ? "Deliver the inventory MVP" : "Deliver the hello CLI",
      goal: inventory ? "Provide tested product and stock management." : "Provide tested named and default greetings.",
      dependsOn: [],
      tasks: [{
        key: "implement-product",
        title: inventory ? "Implement inventory behavior" : "Implement greeting behavior",
        intent: inventory
          ? "Implement product storage, stock adjustments, validation, and automated coverage."
          : "Implement the executable greeting command and automated coverage.",
        dependsOn: [],
        ownedPaths: inventory ? ["src/inventory.ts", "test/inventory.test.ts"] : ["bin/hello.js", "src/greet.js", "test/greet.test.js"],
        covers: covers ?? (inventory ? ["manage-products", "adjust-stock", "protect-stock", "automated-tests"] : ["named-greeting", "default-greeting", "automated-tests"]),
        acceptance: inventory ? [
          "Creating a product makes it available in the inventory product list.",
          "Increasing or decreasing stock updates the stored quantity while rejecting a negative result.",
          "Running `npm test` completes with passing product and stock behavior checks.",
        ] : [
          "Running `node bin/hello.js Ada` writes exactly `Hello, Ada!` and exits successfully.",
          "Running `node bin/hello.js` writes exactly `Hello, world!` and exits successfully.",
          "Running `npm test` completes with passing named and default greeting checks.",
        ],
        validation: [{ kind: "command", value: "test-suite" }],
        expectedEvidence: "Implementation source, automated test source, and passing npm test output.",
      }],
    }],
  };
}

const transientError: ScriptEntry = {
  error: { kind: "transport", message: "temporary fixture transport failure", transportRetryable: true },
};

async function tree(root: string, relative = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(resolve(root, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await tree(root, path));
    else result.push(path);
  }
  return result.sort();
}

function objectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(objectKeys);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => [key, ...objectKeys(nested)]);
}

function fixedNow(): string {
  return "2026-08-29T12:00:00.000Z";
}

describe("Phase 3 semantic vnext init", () => {
  it("derives work reference constraints from resolved intent keys", () => {
    const intent = inventoryIntent(false) as any;
    const schema = JSON.stringify(deriveWorkSchema(intent));
    expect(schema).toContain('"manage-products"');
    expect(schema).toContain('"test-suite"');
    expect(schema).not.toContain('"unknown-requirement"');
  });

  it("rejects non-decisions and silent RIGID model defaults at the Core wire boundary", () => {
    const vagueRecommendation = inventoryIntent() as any;
    vagueRecommendation.questions[0].recommendedAnswer.value = "whatever is best";
    expect(decodeIntentWire(vagueRecommendation, INVENTORY_REQUEST)).toMatchObject({ ok: false });

    const silentRigid = inventoryIntent(false) as any;
    silentRigid.determinations[1].materiality = "architecture";
    silentRigid.determinations[1].rigidity = "RIGID";
    expect(decodeIntentWire(silentRigid, INVENTORY_REQUEST)).toMatchObject({ ok: false });
  });

  it("rejects generic recommendation instructions while accepting selectable decisions", () => {
    const base = (inventoryIntent(true) as { questions: Array<Parameters<typeof questionProblem>[0]> }).questions[0]!;
    for (const value of [
      "use a suitable database",
      "the standard approach",
      "choose an appropriate framework",
      "whatever makes sense",
    ]) {
      expect(questionProblem({ ...base, recommendedAnswer: { ...base.recommendedAnswer, value } }))
        .toMatch(/concrete selectable decision/);
    }
    for (const value of ["PostgreSQL", "SQLite", "REST API", "Single-tenant local MVP"]) {
      expect(questionProblem({ ...base, recommendedAnswer: { ...base.recommendedAnswer, value } })).toBeUndefined();
    }
  });

  it("keeps run state transitions subordinate to intent authority and deterministic closure", () => {
    const state = createInitRunState({
      runId: "state-guard",
      originalRequest: INVENTORY_REQUEST,
      profileId: "fixture:direct-api",
      transport: "direct-api",
      requestAccounting: "exact",
      now: fixedNow(),
    });
    expect(() => transitionInitRunState(state, "work-requested", fixedNow())).toThrow("INVALID_INIT_STATE_TRANSITION");
    expect(() => transitionInitRunState(state, "published", fixedNow())).toThrow("INVALID_INIT_STATE_TRANSITION");
    expect(objectKeys(state)).not.toEqual(expect.arrayContaining(["requirements", "tasks", "phases", "acceptance"]));
  });

  it("turns an underspecified interactive request into Ralph-ready artifacts with explicit and blank authority", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-vnext-phase3-interactive-"));
    const selectedProfile = profile("exact");
    const adapter = new ScriptedAdapter(selectedProfile, [{ payload: inventoryIntent() }, { payload: work() }]);
    const responses = ["A command-line application", ""];
    const result = await runSemanticInit({
      originalRequest: INVENTORY_REQUEST,
      projectRoot: root,
      profile: selectedProfile,
      adapter,
      auth,
      interview: { kind: "interactive", answer: async () => responses.shift() ?? "" },
      runId: "interactive-inventory",
      now: fixedNow,
    });

    expect(await tree(resolve(root, ".rb"))).toEqual(["init/BRIEF.md", "init/PHASES.md", "rb-manifest.json"]);
    expect(result.runState.stage).toBe("published");
    expect(result.runState.questions.map((question) => question.acceptanceMode)).toEqual(["explicit", "blank-interactive"]);
    expect(result.runState.questions[1]?.selectedValue).toBe(result.runState.questions[1]?.recommendedAnswer.value);
    expect(result.closure.model.core.determinations.map((entry) => entry.source.kind)).toContain("user-answer");
    expect(result.closure.model.core.determinations.map((entry) => entry.source.kind)).toContain("accepted-recommendation");
    expect(result.closure.model.core.provenance.acceptedRecommendations["stock-policy"]).toEqual({
      value: "Reject changes that would make stock negative",
      acceptanceMode: "blank-interactive",
    });
    expect(result.runState.counters).toMatchObject({ semanticOperations: 2, transportInvocations: 2, correctiveRegenerations: 0 });
    expect(result.runState.counters.providerRequests).toEqual({ measured: true, value: 2 });
  });

  it("generates and persists questions before headless policy acceptance and reaches Ralph READY with opaque accounting", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-vnext-phase3-headless-"));
    const selectedProfile = profile("opaque");
    const adapter = new ScriptedAdapter(selectedProfile, [{ payload: inventoryIntent() }, { payload: work() }]);
    const result = await runSemanticInit({
      originalRequest: INVENTORY_REQUEST,
      projectRoot: root,
      profile: selectedProfile,
      adapter,
      auth,
      interview: { kind: "headless" },
      runId: "headless-inventory",
      now: fixedNow,
    });

    expect(result.runState.questions).toHaveLength(2);
    expect(result.runState.questions.every((question) => question.persistedBeforeSelection && !question.presented)).toBe(true);
    expect(result.runState.questions.every((question) => question.acceptanceMode === "non-interactive-policy"
      && question.selectedValue === question.recommendedAnswer.value)).toBe(true);
    expect(result.runState.resolvedAuthority.every((entry) => entry.source === "accepted-recommendation"
      && entry.acceptanceMode === "non-interactive-policy")).toBe(true);
    expect(result.closure.model.core.determinations.filter((entry) => entry.source.kind === "accepted-recommendation")).toHaveLength(2);
    expect(result.runState.counters.providerRequests).toEqual({ measured: false, reason: "unsupported-by-provider" });
    expect(await tree(resolve(root, ".rb"))).toEqual(["init/BRIEF.md", "init/PHASES.md", "rb-manifest.json"]);

    const persisted = JSON.parse(await readFile(result.runStatePath, "utf8"));
    expect(persisted.stage).toBe("published");
    expect(objectKeys(persisted)).not.toEqual(expect.arrayContaining(["requirements", "tasks", "phases", "acceptance"]));
  });

  it("does not invent interview questions for a complete request", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-vnext-phase3-complete-"));
    const selectedProfile = profile("exact");
    const adapter = new ScriptedAdapter(selectedProfile, [{ payload: helloIntent() }, { payload: work("hello") }]);
    const answer = vi.fn(async () => "should not be called");
    const result = await runSemanticInit({
      originalRequest: HELLO_REQUEST,
      projectRoot: root,
      profile: selectedProfile,
      adapter,
      auth,
      interview: { kind: "interactive", answer },
      runId: "complete-hello",
      now: fixedNow,
    });
    expect(answer).not.toHaveBeenCalled();
    expect(result.runState.questions).toEqual([]);
    expect(result.runState.stage).toBe("published");
  });

  it("keeps provider-independent semantics identical across exact and opaque transports", async () => {
    const results = [];
    for (const accounting of ["exact", "opaque"] as const) {
      const root = await mkdtemp(resolve(tmpdir(), `rb-vnext-phase3-${accounting}-`));
      const selectedProfile = profile(accounting);
      const adapter = new ScriptedAdapter(selectedProfile, [{ payload: helloIntent() }, { payload: work("hello") }]);
      results.push(await runSemanticInit({
        originalRequest: HELLO_REQUEST,
        projectRoot: root,
        profile: selectedProfile,
        adapter,
        auth,
        interview: { kind: "headless" },
        runId: `same-semantics-${accounting}`,
        now: fixedNow,
      }));
    }
    expect(results[0]?.closure.phases).toBe(results[1]?.closure.phases);
    expect(results[0]?.closure.brief).toBe(results[1]?.closure.brief);
    expect(results[0]?.runState.counters.providerRequests).toEqual({ measured: true, value: 2 });
    expect(results[1]?.runState.counters.providerRequests).toEqual({ measured: false, reason: "unsupported-by-provider" });
  });

  it("performs one complete intent corrective regeneration and never invokes a formatter", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-vnext-phase3-intent-recovery-"));
    const selectedProfile = profile("exact");
    const adapter = new ScriptedAdapter(selectedProfile, [
      { payload: { items: [] } },
      { payload: inventoryIntent(false) },
      { payload: work() },
    ]);
    const result = await runSemanticInit({
      originalRequest: INVENTORY_REQUEST,
      projectRoot: root,
      profile: selectedProfile,
      adapter,
      auth,
      interview: { kind: "headless" },
      runId: "intent-recovery",
      now: fixedNow,
    });
    expect(adapter.requests.map((request) => request.slice)).toEqual(["intent", "intent", "work"]);
    expect(adapter.requests[1]?.input).toContain("complete intent semantic slice again");
    expect(adapter.requests[1]?.input).not.toContain("PHASES.md");
    expect(result.runState.counters).toMatchObject({ semanticOperations: 3, correctiveRegenerations: 1, transportInvocations: 3 });
    expect(result.runState.attempts.map((attempt) => attempt.status)).toEqual(["semantic-invalid", "accepted", "accepted"]);
  });

  it("terminates after the one same-slice correction and does not render or publish invalid semantics", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-vnext-phase3-terminal-"));
    const selectedProfile = profile("exact");
    const adapter = new ScriptedAdapter(selectedProfile, [{ payload: { items: [] } }, { payload: { still: "invalid" } }]);
    await expect(runSemanticInit({
      originalRequest: INVENTORY_REQUEST,
      projectRoot: root,
      profile: selectedProfile,
      adapter,
      auth,
      interview: { kind: "headless" },
      runId: "terminal-recovery",
      now: fixedNow,
    })).rejects.toMatchObject({ kind: "semantic-invalid-after-recovery", publicationOccurred: false });
    expect(adapter.requests).toHaveLength(2);
    await expect(access(resolve(root, ".rb"))).rejects.toThrow();
    const state = JSON.parse(await readFile(resolve(root, ".rb-harness/runs/terminal-recovery/vnext-init-state.json"), "utf8"));
    expect(state).toMatchObject({ stage: "failed", publicationOccurred: false, counters: { semanticOperations: 2, correctiveRegenerations: 1 } });
  });

  it("allows one intent and one work correction while enforcing both per-slice and per-run ceilings", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-vnext-phase3-both-recovery-"));
    const selectedProfile = profile("exact");
    const adapter = new ScriptedAdapter(selectedProfile, [
      { payload: { invalid: "intent" } },
      { payload: inventoryIntent(false) },
      { payload: work("inventory", ["unknown-requirement"]) },
      { payload: work() },
    ]);
    const result = await runSemanticInit({
      originalRequest: INVENTORY_REQUEST,
      projectRoot: root,
      profile: selectedProfile,
      adapter,
      auth,
      interview: { kind: "headless" },
      runId: "both-recovery",
      now: fixedNow,
    });
    expect(result.runState.counters).toMatchObject({
      semanticOperations: 4,
      correctiveRegenerations: 2,
      correctiveBySlice: { intent: 1, work: 1 },
      transportInvocations: 4,
    });
    expect(adapter.requests).toHaveLength(4);
  });

  it("enforces one retry per operation, two retries per run, and six total Harness invocations", async () => {
    const selectedProfile = profile("exact");
    const adapter = new ScriptedAdapter(selectedProfile, [
      transientError,
      { payload: { valid: false } },
      { payload: { valid: true } },
      transientError,
      { payload: { valid: false } },
      { payload: { valid: true } },
    ]);
    const gateway = new SemanticGateway(adapter, selectedProfile, auth);
    const decode = (payload: unknown): WireOutcome<true> => (payload as { valid?: boolean }).valid
      ? { ok: true, value: true }
      : { ok: false, findings: [{ code: "semantic-invalid", pointer: "", message: "fixture invalid" }] };
    const operation = (slice: "intent" | "work") => ({
      slice,
      schema: {},
      schemaName: `fixture_${slice}`,
      instructions: `Generate ${slice} semantics`,
      input: "fixture",
      correctiveInput: () => "complete slice again",
      decode,
      signal: new AbortController().signal,
      deadlineMs: 1_000,
      maxOutputTokens: 100,
    });
    await expect(gateway.generate(operation("intent"))).resolves.toBe(true);
    await expect(gateway.generate(operation("work"))).resolves.toBe(true);
    expect(gateway.snapshot().counters).toMatchObject({
      semanticOperations: 4,
      transportInvocations: 6,
      transportRetries: 2,
      correctiveRegenerations: 2,
    });
    await expect(gateway.generate(operation("work"))).rejects.toMatchObject({ kind: "budget-exhausted" });
    expect(adapter.requests).toHaveLength(6);
  });

  it("stops a second retry for one operation and a third retry across the run", async () => {
    const selectedProfile = profile("exact");
    const perCall = new ScriptedAdapter(selectedProfile, [transientError, transientError]);
    const gateway = new SemanticGateway(perCall, selectedProfile, auth);
    const operation = {
      slice: "intent" as const,
      schema: {}, schemaName: "fixture", instructions: "intent", input: "fixture", correctiveInput: () => "fixture",
      decode: () => ({ ok: true as const, value: true }), signal: new AbortController().signal, deadlineMs: 1_000, maxOutputTokens: 100,
    };
    await expect(gateway.generate(operation)).rejects.toMatchObject({ kind: "transport-exhausted" });
    expect(perCall.requests).toHaveLength(2);

    const across = new ScriptedAdapter(selectedProfile, [
      transientError, { payload: { valid: false } },
      transientError, { payload: { valid: true } },
      transientError,
    ]);
    const acrossGateway = new SemanticGateway(across, selectedProfile, auth);
    const decode = (payload: unknown): WireOutcome<true> => (payload as { valid?: boolean }).valid
      ? { ok: true, value: true }
      : { ok: false, findings: [{ code: "semantic-invalid", pointer: "", message: "invalid" }] };
    await acrossGateway.generate({ ...operation, decode });
    await expect(acrossGateway.generate({ ...operation, slice: "work", decode })).rejects.toMatchObject({ kind: "transport-exhausted" });
    expect(across.requests).toHaveLength(5);
    expect(acrossGateway.snapshot().counters.transportRetries).toBe(2);
  });

  it("never invokes an alternate adapter after the selected transport fails", async () => {
    const selectedProfile = profile("opaque");
    const selected = new ScriptedAdapter(selectedProfile, [{ error: { kind: "auth", message: "subscription unavailable", transportRetryable: false } }]);
    const alternate = { request: vi.fn() };
    const root = await mkdtemp(resolve(tmpdir(), "rb-vnext-phase3-no-fallback-"));
    await expect(runSemanticInit({
      originalRequest: INVENTORY_REQUEST,
      projectRoot: root,
      profile: selectedProfile,
      adapter: selected,
      auth,
      interview: { kind: "headless" },
      runId: "no-fallback",
      now: fixedNow,
    })).rejects.toMatchObject({ kind: "provider-auth-runtime-failure" });
    expect(selected.requests).toHaveLength(1);
    expect(alternate.request).not.toHaveBeenCalled();
  });

  it("verifies accepted recommendations and rejects silent or tampered authority", () => {
    const question = pendingQuestionEvidence((inventoryIntent() as any).questions[0]);
    const blank = selectInterviewAnswer(question, { kind: "interactive", response: "" });
    expect(verifyInterviewEvidence(blank)).toMatchObject({
      source: { kind: "accepted-recommendation", questionKey: "product-surface" },
      acceptanceMode: "blank-interactive",
    });
    expect(() => verifyInterviewEvidence({ ...blank, selectedValue: "A hidden different choice" })).toThrow("recommendation mismatch");
    expect(() => verifyInterviewEvidence({ ...blank, acceptanceMode: "blank-interactive", presented: false })).toThrow("was not presented");
  });

  it("keeps prompt policy and semantic recovery in Core rather than providers", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-vnext-phase3-prompts-"));
    const selectedProfile = profile("exact");
    const adapter = new ScriptedAdapter(selectedProfile, [{ payload: inventoryIntent(false) }, { payload: work() }]);
    await runSemanticInit({
      originalRequest: INVENTORY_REQUEST,
      projectRoot: root,
      profile: selectedProfile,
      adapter,
      auth,
      interview: { kind: "headless" },
      runId: "prompt-boundary",
      now: fixedNow,
    });
    expect(adapter.requests[0]?.instructions).toContain("intent semantic slice");
    expect(adapter.requests[0]?.instructions).toContain("a requested implementation destination is not protected");
    expect(adapter.requests[1]?.instructions).toContain("work semantic slice");
    expect(adapter.requests.flatMap((request) => [request.instructions, request.input]).join("\n"))
      .not.toMatch(/AC-T001|T001|PHASES Markdown|manifest grammar/);
  });
});
