import { access, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { sha256Text } from "../../src/hash.js";
import { SemanticGateway, SemanticGatewayError } from "../../src/vnext/gateway.js";
import { createInitDashboardController } from "../../src/harness-dashboard.js";
import { runSemanticInit } from "../../src/vnext/init.js";
import { questionProblem, selectInterviewAnswer, pendingQuestionEvidence, verifyInterviewEvidence } from "../../src/vnext/interview.js";
import {
  correctiveIntentInput,
  correctiveWorkInput,
  INTENT_INSTRUCTIONS,
  WORK_INSTRUCTIONS,
} from "../../src/vnext/prompts.js";
import { PROJECT_RELATIVE_PATH_PATTERN, projectRelativePathSyntaxIsSafe } from "../../src/vnext/path-contract.js";
import {
  rejectedFindingEvidence,
  REJECTED_EVIDENCE_STRING_LIMIT,
} from "../../src/vnext/rejected-evidence.js";
import {
  containsCodeOwnedMachineIdentity,
  modelFacingRecoveryContext,
  modelFacingRecoveryFindings,
} from "../../src/vnext/recovery-findings.js";
import { createInitRunState, transitionInitRunState } from "../../src/vnext/run-state.js";
import type { CorrectiveSemanticInput } from "../../src/vnext/run-state.js";
import { deriveExecutionDocument, renderPhases } from "../../src/vnext/render/execution.js";
import { validate } from "../../src/vnext/validate.js";
import type {
  CanonicalSemanticResponse,
  ModelProfile,
  ProviderAdapter,
  ProviderOutcome,
  ProviderResponseError,
  ResolvedProviderAuth,
  SemanticRequest,
} from "../../src/vnext/providers/contract.js";
import {
  TASK_ACCEPTANCE_MAX_ITEMS,
  TASK_REQUIRED_COLLECTION_MIN_ITEMS,
  TASK_REQUIRED_SEMANTIC_FIELDS,
  taskStructuralRule,
} from "../../src/vnext/task-contract.js";
import { decodeIntentWire, decodeWorkWire, deriveWorkSchema, INIT_INTENT_SCHEMA, type WireOutcome } from "../../src/vnext/wire.js";

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

function correctiveFixtureInput(input: string): CorrectiveSemanticInput {
  return {
    input,
    audit: {
      recoveryScope: {
        completeSliceRegeneration: true,
        rulesApplyGlobally: true,
        pointersArePreviousAttemptEvidence: true,
      },
      violatedRules: [],
      specificPreviousFindings: [],
      hashes: {
        originalRequestSha256: "fixture-original-request",
        authoritativeInputSha256: "fixture-authority",
        recoveryContextSha256: "fixture-recovery",
        correctiveInputSha256: sha256Text(input),
      },
    },
  };
}

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

function twoTaskWork(): any {
  const result = structuredClone(work()) as any;
  result.phases[0].tasks.push({
    key: "verify-product",
    title: "Verify the product boundary",
    intent: "Implement and verify a distinct product-facing behavior boundary.",
    dependsOn: ["implement-product"],
    ownedPaths: ["src/product-api.ts", "test/product-api.test.ts"],
    covers: ["manage-products", "adjust-stock", "protect-stock", "automated-tests"],
    acceptance: [
      "Submitting a valid product request returns the stored product data and a successful status.",
      "Running `npm test` completes with passing product-boundary checks.",
    ],
    validation: [{ kind: "command", value: "test-suite" }],
    expectedEvidence: "Product API source, automated test source, and passing npm test output.",
  });
  return result;
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

  it("uses the authoritative SemanticKey grammar in intent and work provider schemas", () => {
    const intentSchema = JSON.stringify(INIT_INTENT_SCHEMA);
    const workSchema = JSON.stringify(deriveWorkSchema(inventoryIntent(false) as any));
    for (const schema of [intentSchema, workSchema]) {
      expect(schema).toContain('"pattern":"^[a-z][a-z0-9-]{1,47}$"');
    }
    expect(decodeIntentWire({
      ...(inventoryIntent(false) as any),
      requirements: [{ key: "T001", statement: "Invalid machine-looking key." }],
    }, INVENTORY_REQUEST)).toMatchObject({ ok: false });
  });

  it("makes mandatory task structure explicit in the provider schema and Core decoder", () => {
    const intent = inventoryIntent(false) as any;
    const schema = deriveWorkSchema(intent) as any;
    const taskSchema = schema.properties.phases.items.properties.tasks.items;
    expect(taskSchema.required).toEqual(expect.arrayContaining([...TASK_REQUIRED_SEMANTIC_FIELDS]));
    expect(taskSchema.properties.intent.minLength).toBe(1);
    expect(taskSchema.properties.expectedEvidence.minLength).toBe(1);
    for (const field of ["ownedPaths", "covers", "acceptance", "validation"]) {
      expect(taskSchema.properties[field].minItems, field).toBe(1);
    }
    expect(taskSchema.properties.key.pattern).toBe("^[a-z][a-z0-9-]{1,47}$");

    const defects = [
      ["intent", ""],
      ["ownedPaths", []],
      ["covers", []],
      ["acceptance", []],
      ["validation", []],
      ["expectedEvidence", ""],
    ] as const;
    for (const [field, value] of defects) {
      const payload = structuredClone(work()) as any;
      payload.phases[0].tasks[0][field] = value;
      const decoded = decodeWorkWire(payload, intent);
      expect(decoded.ok, field).toBe(false);
      if (decoded.ok) continue;
      const precise = decoded.findings.filter((finding) => finding.pointer === `/phases/0/tasks/0/${field}`);
      expect(precise, field).toEqual([expect.objectContaining({ message: taskStructuralRule(field).message })]);
      const modelFacing = modelFacingRecoveryFindings(precise);
      expect(modelFacing).toEqual([expect.objectContaining({
        pointer: `/phases/0/tasks/0/${field}`,
        message: taskStructuralRule(field).guidance,
      })]);
      expect(containsCodeOwnedMachineIdentity(JSON.stringify(modelFacing))).toBe(false);
    }
  });

  it("shares the acceptance ceiling with the provider schema and wire decoder without truncation", () => {
    const intent = inventoryIntent(false) as any;
    const schema = deriveWorkSchema(intent) as any;
    const acceptanceSchema = schema.properties.phases.items.properties.tasks.items.properties.acceptance;
    expect(acceptanceSchema.minItems).toBe(TASK_REQUIRED_COLLECTION_MIN_ITEMS);
    expect(acceptanceSchema.maxItems).toBe(TASK_ACCEPTANCE_MAX_ITEMS);
    const providerSchemaAcceptsCount = (count: number) =>
      count >= acceptanceSchema.minItems && count <= acceptanceSchema.maxItems;
    expect(providerSchemaAcceptsCount(1)).toBe(true);
    expect(providerSchemaAcceptsCount(TASK_ACCEPTANCE_MAX_ITEMS)).toBe(true);
    expect(providerSchemaAcceptsCount(TASK_ACCEPTANCE_MAX_ITEMS + 1)).toBe(false);

    const acceptance = (count: number) => Array.from({ length: count }, (_, index) =>
      `Executing deterministic product operation ${index + 1} returns its corresponding result code.`);
    for (const count of [1, TASK_ACCEPTANCE_MAX_ITEMS]) {
      const payload = structuredClone(work()) as any;
      payload.phases[0].tasks[0].acceptance = acceptance(count);
      expect(decodeWorkWire(payload, intent).ok, `${count} acceptance statements`).toBe(true);
    }

    const payload = structuredClone(work()) as any;
    payload.phases[0].tasks[0].acceptance = acceptance(TASK_ACCEPTANCE_MAX_ITEMS + 1);
    expect(payload.phases[0].tasks[0].acceptance.length).toBeGreaterThan(acceptanceSchema.maxItems);
    let observedCount = 0;
    const decoded = decodeWorkWire(payload, intent, (candidate) => {
      observedCount = candidate.phases[0]!.tasks[0]!.acceptance.length;
    });
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.findings).toContainEqual(expect.objectContaining({
      pointer: "/phases/0/tasks/0/acceptance",
      message: expect.stringContaining("exceeds the acceptance ceiling"),
    }));
    expect(observedCount).toBe(TASK_ACCEPTANCE_MAX_ITEMS + 1);
  });

  it("keeps code-owned identity and stale legacy advice out of both corrective inputs", () => {
    const findings = [
      { code: "semantic-invalid" as const, pointer: "/phases/tasks/4/acceptance/2", message: "T005 acceptance is not self-contained: contains vague language without an observable boundary" },
      { code: "semantic-invalid" as const, pointer: "/phases/tasks/5/acceptance/0", message: "T006 contains visual acceptance semantics outside the Phase 1 model" },
      { code: "semantic-invalid" as const, pointer: "/qualityCommands/4/command", message: "quality command starts a long-running service or watcher and never exits; a validation must run to completion and return its real exit code, so prove the running service through OPERATIONS.json instead" },
      { code: "semantic-invalid" as const, pointer: "/phases/P01/tasks/T999/acceptance/0", message: "AC-T001-01 and R-001 expose code-owned identity" },
    ];
    const authority = {
      originalRequest: "Create a fixture that exercises semantic recovery.",
      project: { name: "fixture", objective: "Exercise semantic recovery without machine identity leakage." },
      determinations: [], requirements: [], qualityCommands: [], protectedPaths: [], selectedDecisions: [],
    };
    const intentBuild = correctiveIntentInput("The user may legitimately type T001 here.", findings);
    const workBuild = correctiveWorkInput(authority, findings);
    const intent = JSON.parse(intentBuild.input);
    const workCorrection = JSON.parse(workBuild.input);
    for (const input of [intent, workCorrection]) {
      const metadata = JSON.stringify({
        violatedRules: input.violatedRules,
        specificPreviousFindings: input.specificPreviousFindings,
      });
      expect(containsCodeOwnedMachineIdentity(metadata)).toBe(false);
      expect(metadata).not.toContain("OPERATIONS.json");
      expect(metadata).toContain("/phases/tasks/4/acceptance/2");
      expect(metadata).toContain("observable success boundary");
      expect(metadata).toContain("visual-only semantics");
      expect(metadata).toContain("must terminate and return their real exit status");
      expect(input.recoveryScope.instruction).toContain("entire regenerated slice");
      expect(input.recoveryScope.instruction).toContain("not patch targets");
    }
    for (const build of [intentBuild, workBuild]) {
      expect(build.audit.recoveryScope).toEqual({
        completeSliceRegeneration: true,
        rulesApplyGlobally: true,
        pointersArePreviousAttemptEvidence: true,
      });
      expect(build.audit.hashes.correctiveInputSha256).toBe(sha256Text(build.input));
      expect(containsCodeOwnedMachineIdentity(JSON.stringify({
        violatedRules: build.audit.violatedRules,
        specificPreviousFindings: build.audit.specificPreviousFindings,
      }))).toBe(false);
    }
    expect(intent.originalRequest).toContain("T001");
  });

  it("derives and deduplicates a closed slice-wide recovery-rule ledger", () => {
    const findings = [
      { code: "semantic-invalid" as const, pointer: "/phases/0/tasks/0/acceptance/0", message: "T001 contains visual acceptance semantics outside the Phase 1 model" },
      { code: "semantic-invalid" as const, pointer: "/phases/0/tasks/1/acceptance/2", message: "T002 contains visual acceptance semantics outside the Phase 1 model" },
      { code: "semantic-invalid" as const, pointer: "/phases/0/tasks/1/validation/0", message: "Manual validation uses manual prose for an executable check; declare the exact command or use human: for evidence unavailable to the executor" },
      { code: "semantic-invalid" as const, pointer: "/unknown", message: "T999 exposed an unmapped internal diagnostic" },
    ];
    const context = modelFacingRecoveryContext(findings);
    expect(context.violatedRules.map((entry) => entry.rule)).toEqual([
      "acceptance-no-visual-only",
      "validation-command-executable",
    ]);
    expect(context.specificPreviousFindings).toHaveLength(4);
    expect(context.specificPreviousFindings.filter((entry) => entry.rule === "acceptance-no-visual-only")).toHaveLength(2);
    expect(context.specificPreviousFindings[3]).not.toHaveProperty("rule");
    expect(containsCodeOwnedMachineIdentity(JSON.stringify(context))).toBe(false);
  });

  it("regenerates a complete work slice without exposing the Core-derived TaskId", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-vnext-phase3-work-recovery-boundary-"));
    const selectedProfile = profile("exact");
    const invalidWork = structuredClone(work()) as any;
    invalidWork.phases[0].tasks[0].acceptance[0] = "The inventory behavior works correctly.";
    const adapter = new ScriptedAdapter(selectedProfile, [
      { payload: inventoryIntent(false) },
      { payload: invalidWork },
      { payload: work() },
    ]);
    const result = await runSemanticInit({
      originalRequest: INVENTORY_REQUEST,
      projectRoot: root,
      profile: selectedProfile,
      adapter,
      auth,
      interview: { kind: "headless" },
      runId: "work-recovery-boundary",
      now: fixedNow,
    });
    const internal = result.runState.attempts[1]?.findings ?? [];
    expect(internal.some((finding) => finding.message.includes("T001 acceptance"))).toBe(true);
    const correction = JSON.parse(adapter.requests[2]!.input);
    expect(containsCodeOwnedMachineIdentity(JSON.stringify({
      violatedRules: correction.violatedRules,
      specificPreviousFindings: correction.specificPreviousFindings,
    }))).toBe(false);
    expect(correction.specificPreviousFindings).toContainEqual(expect.objectContaining({
      pointer: "/phases/0/tasks/0/acceptance/0",
      message: expect.stringContaining("observable success boundary"),
    }));
    expect(result.runState.counters).toMatchObject({
      semanticOperations: 3,
      correctiveRegenerations: 1,
      correctiveBySlice: { intent: 0, work: 1 },
      transportInvocations: 3,
    });
    expect(result.runState.stage).toBe("published");
  });

  it("rejects a corrected whole slice when a violated rule recurs at a different task", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-vnext-phase3-rule-recurrence-"));
    const selectedProfile = profile("exact");
    const initial = twoTaskWork();
    initial.phases[0].tasks[0].acceptance[0] = "The rendered page is visible at the target viewport.";
    const corrective = twoTaskWork();
    corrective.phases[0].tasks[1].acceptance[0] = "The rendered response panel is visible at the target viewport.";
    const adapter = new ScriptedAdapter(selectedProfile, [
      { payload: inventoryIntent(false) },
      { payload: initial },
      { payload: corrective },
    ]);

    await expect(runSemanticInit({
      originalRequest: INVENTORY_REQUEST,
      projectRoot: root,
      profile: selectedProfile,
      adapter,
      auth,
      interview: { kind: "headless" },
      runId: "rule-recurrence",
      now: fixedNow,
    })).rejects.toMatchObject({ kind: "semantic-invalid-after-recovery", publicationOccurred: false });

    const correction = JSON.parse(adapter.requests[2]!.input);
    expect(correction.violatedRules).toEqual([expect.objectContaining({
      rule: "acceptance-no-visual-only",
      constraint: expect.stringContaining("Every acceptance statement in the complete regenerated slice"),
    })]);
    expect(correction.specificPreviousFindings).toEqual([expect.objectContaining({
      pointer: "/phases/0/tasks/0/acceptance/0",
      rule: "acceptance-no-visual-only",
    })]);
    expect(correction.recoveryScope.instruction).toContain("not only the prior locations");
    expect(adapter.requests).toHaveLength(3);
    const state = JSON.parse(await readFile(resolve(root, ".rb-harness/runs/rule-recurrence/vnext-init-state.json"), "utf8"));
    expect(state.attempts[1].rejectedFindings).toEqual([expect.objectContaining({
      pointer: "/phases/0/tasks/0/acceptance/0",
      rule: "acceptance-no-visual-only",
      value: "The rendered page is visible at the target viewport.",
      valueSha256: sha256Text("The rendered page is visible at the target viewport."),
    })]);
    expect(state.attempts[2].findings).toEqual([expect.objectContaining({ pointer: "/phases/0/tasks/1/acceptance/0" })]);
    expect(state.attempts[2].rejectedFindings).toEqual([expect.objectContaining({
      pointer: "/phases/0/tasks/1/acceptance/0",
      rule: "acceptance-no-visual-only",
      value: "The rendered response panel is visible at the target viewport.",
      valueSha256: sha256Text("The rendered response panel is visible at the target viewport."),
    })]);
    expect(state.attempts[2].recovery).toMatchObject({
      slice: "work",
      ordinal: 3,
      recoveryScope: {
        completeSliceRegeneration: true,
        rulesApplyGlobally: true,
        pointersArePreviousAttemptEvidence: true,
      },
      violatedRules: ["acceptance-no-visual-only"],
      specificPreviousFindings: [expect.objectContaining({ pointer: "/phases/0/tasks/0/acceptance/0" })],
    });
    expect(state.attempts[2].recovery.hashes.correctiveInputSha256).toBe(sha256Text(adapter.requests[2]!.input));
    expect(containsCodeOwnedMachineIdentity(JSON.stringify(state.attempts[2].recovery))).toBe(false);
    expect(state.counters).toMatchObject({ semanticOperations: 3, correctiveRegenerations: 1, transportInvocations: 3 });
  });

  it("accepts complete regeneration after all violated rules are satisfied globally", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-vnext-phase3-rule-recovery-success-"));
    const selectedProfile = profile("exact");
    const initial = twoTaskWork();
    initial.phases[0].tasks[0].acceptance = [
      "The rendered page is visible at the target viewport.",
      "The stylesheet renders the expected colors and spacing.",
      "A screenshot shows the layout at the target viewport.",
    ];
    initial.phases[0].tasks[1].validation = [{ kind: "manual", value: "Run npm test" }];
    const adapter = new ScriptedAdapter(selectedProfile, [
      { payload: inventoryIntent(false) },
      { payload: initial },
      { payload: twoTaskWork() },
    ]);

    const result = await runSemanticInit({
      originalRequest: INVENTORY_REQUEST,
      projectRoot: root,
      profile: selectedProfile,
      adapter,
      auth,
      interview: { kind: "headless" },
      runId: "rule-recovery-success",
      now: fixedNow,
    });
    const correction = JSON.parse(adapter.requests[2]!.input);
    expect(correction.violatedRules.map((entry: any) => entry.rule)).toEqual([
      "acceptance-no-visual-only",
      "validation-command-executable",
    ]);
    expect(correction.specificPreviousFindings.map((entry: any) => entry.pointer)).toEqual([
      "/phases/0/tasks/0/acceptance/0",
      "/phases/0/tasks/0/acceptance/1",
      "/phases/0/tasks/0/acceptance/2",
      "/phases/0/tasks/1/validation/0",
    ]);
    expect(correction.resolvedIntent).toMatchObject({
      originalRequest: INVENTORY_REQUEST,
      requirements: expect.arrayContaining([expect.objectContaining({ key: "manage-products" })]),
      qualityCommands: [expect.objectContaining({ key: "test-suite" })],
    });
    expect(result.runState.stage).toBe("published");
    expect(result.runState.counters).toMatchObject({ semanticOperations: 3, correctiveRegenerations: 1, transportInvocations: 3 });
    const persisted = JSON.parse(await readFile(result.runStatePath, "utf8"));
    const recovery = persisted.attempts[2].recovery;
    expect(recovery).toMatchObject({
      slice: "work",
      ordinal: 3,
      violatedRules: ["acceptance-no-visual-only", "validation-command-executable"],
    });
    expect(recovery.specificPreviousFindings).toHaveLength(4);
    expect(recovery.specificPreviousFindings.filter((finding: any) => finding.pointer.includes("/acceptance/"))).toHaveLength(3);
    expect(recovery.hashes).toMatchObject({
      originalRequestSha256: sha256Text(INVENTORY_REQUEST),
      authoritativeInputSha256: sha256Text(JSON.stringify(correction.resolvedIntent)),
      resolvedInterviewAuthoritySha256: sha256Text(JSON.stringify(correction.resolvedIntent)),
      recoveryContextSha256: sha256Text(JSON.stringify(modelFacingRecoveryContext(result.runState.attempts[1]!.findings))),
      correctiveInputSha256: sha256Text(adapter.requests[2]!.input),
    });
    expect(recovery.violatedRules).toEqual(correction.violatedRules.map((entry: any) => entry.rule));
    expect(recovery.specificPreviousFindings).toEqual(correction.specificPreviousFindings.map((finding: any) => ({
      pointer: finding.pointer,
      guidance: finding.message,
    })));
    expect(containsCodeOwnedMachineIdentity(JSON.stringify(recovery))).toBe(false);
    expect(Object.keys(recovery)).not.toEqual(expect.arrayContaining([
      "prompt",
      "instructions",
      "rawProviderResponse",
      "secret",
      "auth",
    ]));

    const renderedBeforeAuditTamper = renderPhases(deriveExecutionDocument(result.closure.model));
    persisted.attempts[2].recovery.violatedRules = ["semantic-key-valid"];
    persisted.attempts[2].recovery.specificPreviousFindings = [{ pointer: "/tampered", guidance: "audit only" }];
    await writeFile(result.runStatePath, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });
    expect(validate(result.closure.model).valid).toBe(true);
    expect(renderPhases(deriveExecutionDocument(result.closure.model))).toBe(renderedBeforeAuditTamper);
    expect(await readFile(resolve(root, ".rb/init/PHASES.md"), "utf8")).toBe(renderedBeforeAuditTamper);
  });

  it("persists bounded sanitized rejected values without making them project authority", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-vnext-phase3-rejected-value-safety-"));
    const selectedProfile = profile("exact");
    const initial = work() as any;
    const rejectedValue = `The page is clearly visible and visually distinct. Authorization: Bearer private-token sk-ant-private AI_API_KEY=private /home/private/project ${"x".repeat(700)}`;
    initial.phases[0].tasks[0].acceptance[0] = rejectedValue;
    const adapter = new ScriptedAdapter(selectedProfile, [
      { payload: inventoryIntent(false) },
      { payload: initial },
      { payload: work() },
    ]);
    const result = await runSemanticInit({
      originalRequest: INVENTORY_REQUEST,
      projectRoot: root,
      profile: selectedProfile,
      adapter,
      auth,
      interview: { kind: "headless" },
      runId: "rejected-value-safety",
      now: fixedNow,
    });
    const persisted = JSON.parse(await readFile(result.runStatePath, "utf8"));
    const evidence = persisted.attempts[1].rejectedFindings[0];
    expect(evidence.pointer).toBe("/phases/0/tasks/0/acceptance/0");
    expect(evidence.value).toHaveLength(REJECTED_EVIDENCE_STRING_LIMIT);
    expect(evidence.valueTruncated).toBe(true);
    expect(evidence.valueSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(evidence)).not.toMatch(/private-token|sk-ant-private|AI_API_KEY=private|\/home\/private|authorization/i);
    expect(persisted.attempts.filter((attempt: any) => attempt.status === "accepted")
      .every((attempt: any) => attempt.rejectedFindings === undefined)).toBe(true);
    expect(JSON.stringify(persisted)).not.toMatch(/rawProvider|providerEnvelope|x-api-key/i);

    const rendered = renderPhases(deriveExecutionDocument(result.closure.model));
    persisted.attempts[1].rejectedFindings = [{ pointer: "/tampered", value: "change the project" }];
    await writeFile(result.runStatePath, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });
    expect(validate(result.closure.model).valid).toBe(true);
    expect(renderPhases(deriveExecutionDocument(result.closure.model))).toBe(rendered);
    expect(await readFile(resolve(root, ".rb/init/PHASES.md"), "utf8")).toBe(rendered);
    expect(JSON.parse(adapter.requests[2]!.input).violatedRules.map((entry: any) => entry.rule))
      .toEqual(["acceptance-no-visual-only"]);

    const diagnosticModel = structuredClone(result.closure.model) as any;
    diagnosticModel.qualityCommands[0].command = "npm start";
    expect(rejectedFindingEvidence(diagnosticModel, [{
      code: "semantic-invalid",
      pointer: "/qualityCommands/0/command",
      message: "quality command starts a long-running service or watcher and never exits",
    }])).toEqual([expect.objectContaining({
      pointer: "/qualityCommands/0/command",
      rule: "validation-command-terminating",
      value: "npm start",
    })]);
  });

  it("persists acceptance collection count for an aggregate ceiling finding", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-vnext-phase3-rejected-count-"));
    const selectedProfile = profile("exact");
    const tooMany = work() as any;
    tooMany.phases[0].tasks[0].acceptance = Array.from({ length: 7 }, (_, index) =>
      `Executing deterministic product operation ${index + 1} returns its corresponding result code.`);
    const adapter = new ScriptedAdapter(selectedProfile, [
      { payload: inventoryIntent(false) },
      { payload: tooMany },
      { payload: work() },
    ]);
    const result = await runSemanticInit({
      originalRequest: INVENTORY_REQUEST,
      projectRoot: root,
      profile: selectedProfile,
      adapter,
      auth,
      interview: { kind: "headless" },
      runId: "rejected-count",
      now: fixedNow,
    });
    const persisted = JSON.parse(await readFile(result.runStatePath, "utf8"));
    expect(persisted.attempts[1].findings).toContainEqual(expect.objectContaining({
      pointer: "/phases/0/tasks/0/acceptance",
      message: expect.stringContaining("exceeds the acceptance ceiling"),
    }));
    expect(persisted.attempts[1].rejectedFindings).toContainEqual({
      pointer: "/phases/0/tasks/0/acceptance",
      observed: { count: 7 },
    });
    expect(persisted.attempts[1].rejectedFindings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ value: expect.anything() }),
    ]));
  });

  it("states symbolic-key, visual-acceptance, and validation-intent boundaries positively", () => {
    expect(INTENT_INSTRUCTIONS).toContain("lower-case kebab-case");
    expect(WORK_INSTRUCTIONS).toContain("lower-case kebab-case");
    expect(WORK_INSTRUCTIONS).toContain("UI tasks are allowed");
    expect(WORK_INSTRUCTIONS).toContain("observable functional behavior rather than appearance");
    expect(WORK_INSTRUCTIONS).toContain("exact declared quality-command key");
    expect(WORK_INSTRUCTIONS).toContain("Every semantic task must contain one concrete single-line change intent");
    expect(WORK_INSTRUCTIONS).toContain("kind manual only for a non-command inspection");
    expect(WORK_INSTRUCTIONS).toContain("kind human only when the evidence requires actual human judgement");
    expect(`${INTENT_INSTRUCTIONS}\n${WORK_INSTRUCTIONS}`).not.toMatch(/AC-T\d{3}|\bT\d{3}\b|\bP\d{2}\b|R-\d{3}/);
  });

  it("gives first-pass and corrective UI acceptance constructive functional shapes", () => {
    for (const expected of [
      "DOM or application-state change",
      "navigation result",
      "form-submission result",
      "data derived from known state",
      "filter or sort result",
      "authorization-dependent action state",
      "API effect observable through the UI",
      "exact count, value, or message",
      "human validation intent",
    ]) expect(WORK_INSTRUCTIONS).toContain(expected);
    for (const invalid of ["styling", "layout quality", "looks-correct", "visibility or positioning", "screenshots", "visual comparison"]) {
      expect(WORK_INSTRUCTIONS).toContain(invalid);
    }

    const context = modelFacingRecoveryContext([{
      code: "semantic-invalid",
      pointer: "/phases/1/tasks/0/acceptance/2",
      message: "T001 contains visual acceptance semantics outside the Phase 1 model",
    }]);
    expect(context.violatedRules).toEqual([expect.objectContaining({
      rule: "acceptance-no-visual-only",
      constraint: expect.stringContaining("including every UI task"),
    })]);
    const constraint = context.violatedRules[0]!.constraint;
    expect(constraint).toContain("concrete precondition or action");
    expect(constraint).toContain("application or DOM state");
    expect(constraint).toContain("filtering or sorting");
    expect(constraint).toContain("human validation intent");
    expect(context.specificPreviousFindings[0]!.message).toContain("complete regenerated slice");
    expect(context.specificPreviousFindings[0]!.message).toContain("deterministic functional outcome");
    expect(context.specificPreviousFindings[0]!.message).toContain("API effect observable through UI behavior");
    expect(context.specificPreviousFindings[0]!.message).toContain("human validation intent");
    expect(containsCodeOwnedMachineIdentity(JSON.stringify(context))).toBe(false);
    expect(JSON.stringify({ instructions: WORK_INSTRUCTIONS, context })).not.toMatch(/anthropic|claude/i);

    const correction = correctiveWorkInput({
      originalRequest: "Create a generic application with an interactive interface.",
      project: { name: "generic-ui", objective: "Provide deterministic interactive application behavior." },
      determinations: [],
      requirements: [],
      qualityCommands: [],
      protectedPaths: [],
      selectedDecisions: [],
    }, [{
      code: "semantic-invalid",
      pointer: "/phases/1/tasks/0/acceptance/2",
      message: "T001 contains visual acceptance semantics outside the Phase 1 model",
    }]);
    expect(correction.audit.violatedRules).toEqual(["acceptance-no-visual-only"]);
    expect(correction.audit.specificPreviousFindings).toEqual([expect.objectContaining({
      pointer: "/phases/1/tasks/0/acceptance/2",
      guidance: expect.stringContaining("deterministic functional outcome"),
    })]);
  });

  it("states first-pass terminating-command, ownership, and validation-kind contracts", () => {
    expect(INTENT_INSTRUCTIONS).toContain("terminate by itself");
    expect(INTENT_INSTRUCTIONS).toContain("return its real exit status");
    expect(INTENT_INSTRUCTIONS).toContain("development or application server");
    expect(INTENT_INSTRUCTIONS).toContain("watcher");
    expect(INTENT_INSTRUCTIONS).toContain("interactive process");
    expect(INTENT_INSTRUCTIONS).toContain("npm run dev");
    expect(INTENT_INSTRUCTIONS).toContain("tsc --watch");

    expect(WORK_INSTRUCTIONS).toContain("directory token without a trailing slash");
    expect(WORK_INSTRUCTIONS).toContain("bounded glob");
    expect(WORK_INSTRUCTIONS).toContain("unbounded *, **, or **/*");
    expect(WORK_INSTRUCTIONS).toContain("exact declared quality-command key");
    expect(WORK_INSTRUCTIONS).toContain("never paraphrase an executable shell check as manual prose");
    expect(WORK_INSTRUCTIONS).toContain("actual human judgement or interaction");
    expect(`${INTENT_INSTRUCTIONS}\n${WORK_INSTRUCTIONS}`).not.toContain("OPERATIONS.json");
  });

  it("uses the Core path grammar in the provider schema and work decoder", () => {
    const intent = inventoryIntent(false) as any;
    const schema = deriveWorkSchema(intent) as any;
    const ownedPathPattern = schema.properties.phases.items.properties.tasks.items.properties.ownedPaths.items.pattern;
    expect(ownedPathPattern).toBe(PROJECT_RELATIVE_PATH_PATTERN);

    const invalidPaths = [
      "migrations/",
      "src/domain/destinations/",
      "src/domain/events/",
      "tests/",
      "/absolute/file.ts",
      "src/../secret.ts",
      "**/*",
    ];
    const validPaths = ["migrations", "src/domain/destinations", "tests", "src/**/*.ts", "package.json"];
    for (const path of invalidPaths) {
      expect(new RegExp(ownedPathPattern).test(path), path).toBe(false);
      expect(projectRelativePathSyntaxIsSafe(path), path).toBe(false);
      const payload = structuredClone(work()) as any;
      payload.phases[0].tasks[0].ownedPaths = [path];
      const decoded = decodeWorkWire(payload, intent);
      expect(decoded.ok, path).toBe(false);
      if (!decoded.ok) expect(decoded.findings).toContainEqual(expect.objectContaining({
        pointer: "/phases/0/tasks/0/ownedPaths/0",
      }));
    }
    for (const path of validPaths) {
      expect(new RegExp(ownedPathPattern).test(path), path).toBe(true);
      expect(projectRelativePathSyntaxIsSafe(path), path).toBe(true);
    }
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
    const workAuthority = JSON.parse(adapter.requests[1]!.input).resolvedIntent;
    expect(workAuthority.originalRequest).toBe(INVENTORY_REQUEST);
    expect(workAuthority.selectedDecisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "product-surface", sourceKind: "accepted-recommendation", acceptanceMode: "non-interactive-policy" }),
      expect.objectContaining({ key: "stock-policy", sourceKind: "accepted-recommendation", acceptanceMode: "non-interactive-policy" }),
    ]));
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

  it("keeps presentation observers outside semantic authority", async () => {
    const roots = await Promise.all([
      mkdtemp(resolve(tmpdir(), "rb-vnext-presentation-normal-")),
      mkdtemp(resolve(tmpdir(), "rb-vnext-presentation-dashboard-")),
    ]);
    const selectedProfile = profile("exact");
    const normal = await runSemanticInit({
      originalRequest: HELLO_REQUEST,
      projectRoot: roots[0]!,
      profile: selectedProfile,
      adapter: new ScriptedAdapter(selectedProfile, [{ payload: helloIntent() }, { payload: work("hello") }]),
      auth,
      interview: { kind: "headless" },
      runId: "presentation-equivalence",
      now: fixedNow,
    });
    const observedStages: string[] = [];
    const dashboard = await runSemanticInit({
      originalRequest: HELLO_REQUEST,
      projectRoot: roots[1]!,
      profile: selectedProfile,
      adapter: new ScriptedAdapter(selectedProfile, [{ payload: helloIntent() }, { payload: work("hello") }]),
      auth,
      interview: { kind: "headless" },
      runId: "presentation-equivalence",
      now: fixedNow,
      onRunState: (snapshot) => {
        observedStages.push(snapshot.stage);
        (snapshot as any).originalRequest = "attempted presentation mutation";
        throw new Error("presentation renderer failure");
      },
    });
    expect(observedStages).toContain("published");
    expect(dashboard.closure.phases).toBe(normal.closure.phases);
    expect(dashboard.closure.brief).toBe(normal.closure.brief);
    expect(dashboard.runState.originalRequest).toBe(HELLO_REQUEST);
    expect(dashboard.runState.counters).toEqual(normal.runState.counters);

    // The real terminal dashboard is projection-only: driving it from the same
    // run produces byte-identical semantics and never leaks the request.
    const painted: string[] = [];
    const root = await mkdtemp(resolve(tmpdir(), "rb-vnext-presentation-real-"));
    const controller = createInitDashboardController("0.6.2", root, {
      isTTY: true, columns: 158, rows: 34, write: (value: string) => void painted.push(value),
    });
    controller.start();
    const rendered = await runSemanticInit({
      originalRequest: HELLO_REQUEST,
      projectRoot: root,
      profile: selectedProfile,
      adapter: new ScriptedAdapter(selectedProfile, [{ payload: helloIntent() }, { payload: work("hello") }]),
      auth,
      interview: { kind: "headless" },
      runId: "presentation-equivalence",
      now: fixedNow,
      onRunState: (snapshot) => controller.state({
        stage: snapshot.stage,
        selectedProfileId: snapshot.selectedProfileId,
        transport: snapshot.transport,
        requestAccounting: snapshot.requestAccounting,
        questions: snapshot.questions.length,
        semanticOperations: snapshot.counters.semanticOperations,
        transportInvocations: snapshot.counters.transportInvocations,
        correctiveRegenerations: snapshot.counters.correctiveRegenerations,
        providerRequests: snapshot.counters.providerRequests.measured ? String(snapshot.counters.providerRequests.value) : "não medido",
        publicationOccurred: snapshot.publicationOccurred,
      }),
    });
    controller.finish();
    expect(rendered.closure.phases).toBe(normal.closure.phases);
    expect(rendered.closure.brief).toBe(normal.closure.brief);
    expect(rendered.runState.counters).toEqual(normal.runState.counters);
    expect(rendered.runState.questions).toEqual(normal.runState.questions);
    expect(painted.join("")).not.toContain(HELLO_REQUEST);
    expect(painted.join("")).toContain("PIPELINE · FLUXO DE EXECUÇÃO");
    expect(painted.at(-1)).toContain("[?25h");
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
    expect(adapter.requests[1]?.input).toContain("COMPLETE intent semantic slice again");
    expect(adapter.requests[1]?.input).not.toContain("PHASES.md");
    expect(result.runState.counters).toMatchObject({ semanticOperations: 3, correctiveRegenerations: 1, transportInvocations: 3 });
    expect(result.runState.attempts.map((attempt) => attempt.status)).toEqual(["semantic-invalid", "accepted", "accepted"]);
  });

  it("persists the decoded rejected quality command without a provider envelope", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-vnext-phase3-intent-rejected-value-"));
    const selectedProfile = profile("exact");
    const invalidIntent = inventoryIntent(false) as any;
    invalidIntent.qualityCommands[0].command = "npm start";
    const adapter = new ScriptedAdapter(selectedProfile, [
      { payload: invalidIntent },
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
      runId: "intent-rejected-value",
      now: fixedNow,
    });
    const persisted = JSON.parse(await readFile(result.runStatePath, "utf8"));
    expect(persisted.attempts[0].rejectedFindings).toEqual([expect.objectContaining({
      pointer: "/qualityCommands/0/command",
      rule: "validation-command-terminating",
      value: "npm start",
      valueSha256: sha256Text("npm start"),
    })]);
    expect(persisted.attempts[1].rejectedFindings).toBeUndefined();
    expect(JSON.stringify(persisted)).not.toMatch(/providerEnvelope|authorization|x-api-key/i);
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
      correctiveInput: () => correctiveFixtureInput("complete slice again"),
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
      schema: {}, schemaName: "fixture", instructions: "intent", input: "fixture", correctiveInput: () => correctiveFixtureInput("fixture"),
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
