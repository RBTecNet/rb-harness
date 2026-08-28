import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HARNESS_BUDGET } from "../src/harness-budget.js";
import {
  DOCUMENT_PART_BEGIN,
  DOCUMENT_PART_END,
  DOCUMENT_PLAN_BEGIN,
  DOCUMENT_PLAN_END,
  assembleDocumentPlan,
  parseDocumentPart,
  parseDocumentPlan,
} from "../src/harness-incremental-documents.js";
import { assertGenerationPlanComplete, requestDocumentBundle } from "../src/harness-generator.js";
import { successfulProviderLogStdout } from "../src/harness-control-formatter.js";
import { buildInputPackage } from "../src/harness-input-package.js";
import { inspectProjectInventory } from "../src/harness-inventory.js";
import { ProviderStreamObserver } from "../src/provider-events.js";
import type { HarnessRunState } from "../src/standalone-types.js";

const fixture = resolve(import.meta.dirname, "fixtures/standalone/incremental-provider.mjs");
const originalCalls = process.env.RB_HARNESS_TEST_INCREMENTAL_CALLS;
const originalFailure = process.env.RB_HARNESS_TEST_INCREMENTAL_FAIL_PART;
const originalExitPart = process.env.RB_HARNESS_TEST_INCREMENTAL_EXIT_PART;
const originalFormatFailures = process.env.RB_HARNESS_TEST_FORMAT_INVALID_ATTEMPTS;
const originalDocumentDependencies = process.env.RB_HARNESS_TEST_DOCUMENT_DEPENDENCIES;
const originalCyclicDocumentDependencies = process.env.RB_HARNESS_TEST_CYCLIC_DOCUMENT_DEPENDENCIES;
const originalIncompleteFirstPlan = process.env.RB_HARNESS_TEST_INCOMPLETE_FIRST_PLAN;
const originalMimoPlan = process.env.RB_HARNESS_TEST_MIMO_PLAN;
const originalMalformedPlan = process.env.RB_HARNESS_TEST_MALFORMED_PLAN;
const originalRepeatFormatOutput = process.env.RB_HARNESS_TEST_REPEAT_FORMAT_OUTPUT;
const originalMissingDependency = process.env.RB_HARNESS_TEST_MISSING_DEPENDENCY;
const originalStaleDependencyAlias = process.env.RB_HARNESS_TEST_STALE_DEPENDENCY_ALIAS;

afterEach(() => {
  if (originalCalls === undefined) delete process.env.RB_HARNESS_TEST_INCREMENTAL_CALLS;
  else process.env.RB_HARNESS_TEST_INCREMENTAL_CALLS = originalCalls;
  if (originalFailure === undefined) delete process.env.RB_HARNESS_TEST_INCREMENTAL_FAIL_PART;
  else process.env.RB_HARNESS_TEST_INCREMENTAL_FAIL_PART = originalFailure;
  if (originalExitPart === undefined) delete process.env.RB_HARNESS_TEST_INCREMENTAL_EXIT_PART;
  else process.env.RB_HARNESS_TEST_INCREMENTAL_EXIT_PART = originalExitPart;
  if (originalFormatFailures === undefined) delete process.env.RB_HARNESS_TEST_FORMAT_INVALID_ATTEMPTS;
  else process.env.RB_HARNESS_TEST_FORMAT_INVALID_ATTEMPTS = originalFormatFailures;
  if (originalDocumentDependencies === undefined) delete process.env.RB_HARNESS_TEST_DOCUMENT_DEPENDENCIES;
  else process.env.RB_HARNESS_TEST_DOCUMENT_DEPENDENCIES = originalDocumentDependencies;
  if (originalCyclicDocumentDependencies === undefined) delete process.env.RB_HARNESS_TEST_CYCLIC_DOCUMENT_DEPENDENCIES;
  else process.env.RB_HARNESS_TEST_CYCLIC_DOCUMENT_DEPENDENCIES = originalCyclicDocumentDependencies;
  if (originalIncompleteFirstPlan === undefined) delete process.env.RB_HARNESS_TEST_INCOMPLETE_FIRST_PLAN;
  else process.env.RB_HARNESS_TEST_INCOMPLETE_FIRST_PLAN = originalIncompleteFirstPlan;
  if (originalMimoPlan === undefined) delete process.env.RB_HARNESS_TEST_MIMO_PLAN;
  else process.env.RB_HARNESS_TEST_MIMO_PLAN = originalMimoPlan;
  if (originalMalformedPlan === undefined) delete process.env.RB_HARNESS_TEST_MALFORMED_PLAN;
  else process.env.RB_HARNESS_TEST_MALFORMED_PLAN = originalMalformedPlan;
  if (originalRepeatFormatOutput === undefined) delete process.env.RB_HARNESS_TEST_REPEAT_FORMAT_OUTPUT;
  else process.env.RB_HARNESS_TEST_REPEAT_FORMAT_OUTPUT = originalRepeatFormatOutput;
  if (originalMissingDependency === undefined) delete process.env.RB_HARNESS_TEST_MISSING_DEPENDENCY;
  else process.env.RB_HARNESS_TEST_MISSING_DEPENDENCY = originalMissingDependency;
  if (originalStaleDependencyAlias === undefined) delete process.env.RB_HARNESS_TEST_STALE_DEPENDENCY_ALIAS;
  else process.env.RB_HARNESS_TEST_STALE_DEPENDENCY_ALIAS = originalStaleDependencyAlias;
});

function envelope(begin: string, end: string, value: unknown): string {
  return `${begin}\n${JSON.stringify(value)}\n${end}`;
}

function samplePlan() {
  return {
    contract: "rb-harness-document-plan/v1",
    status: "complete",
    summary: "Two bounded parts.",
    coordination: "RF-001 -> P01/T001.",
    documents: [{
      path: ".rb/init/PHASES.md",
      purpose: "Execution plan.",
      parts: [
        { id: "header", purpose: "Header." },
        { id: "phase-01", purpose: "First phase." },
      ],
    }],
    blocked: [],
  };
}

function completeInitPlan() {
  const value = samplePlan();
  const document = (name: string) => ({
    path: `.rb/init/${name}`,
    purpose: name,
    parts: [{ id: "whole", purpose: `Complete ${name}.` }],
  });
  value.documents = [
    document("PROJECT.md"),
    document("REQUIREMENTS.md"),
    document("DECISIONS.md"),
    document("PLAN.md"),
    value.documents[0]!,
    document("source-manifest.json"),
  ];
  return value;
}

const COMPLETE_INIT_PATHS = [
  ".rb/init/DECISIONS.md",
  ".rb/init/PHASES.md",
  ".rb/init/PLAN.md",
  ".rb/init/PROJECT.md",
  ".rb/init/REQUIREMENTS.md",
  ".rb/init/source-manifest.json",
];

const COMPLETE_INIT_CALLS = [
  ".rb/init/PROJECT.md#whole",
  ".rb/init/REQUIREMENTS.md#whole",
  ".rb/init/DECISIONS.md#whole",
  ".rb/init/PLAN.md#whole",
  ".rb/init/PHASES.md#header",
  ".rb/init/PHASES.md#phase-01",
  ".rb/init/source-manifest.json#whole",
];

async function requestFixture(project: string, runRoot: string) {
  const inventory = await inspectProjectInventory(project, ".rb");
  const inputPackage = await buildInputPackage({
    workflow: "init",
    projectRoot: project,
    artifactDirectory: ".rb",
    request: "Create an incremental fixture.",
    inventory,
  });
  const now = new Date().toISOString();
  const state = {
    contract: "rb-harness-run/v1",
    id: "incremental-fixture",
    workflow: "init",
    status: "generating",
    projectRoot: project,
    artifactDirectory: ".rb",
    request: "Create an incremental fixture.",
    requestHash: "fixture",
    provider: { provider: "custom", model: "fixture", effort: "", command: fixture },
    answers: [],
    analysis: { contract: "rb-harness-interview/v1", status: "ready", summary: "ready", discoveries: [], assumptions: [], unresolved: [], answerReviews: [], questions: [] },
    inventory,
    createdAt: now,
    updatedAt: now,
  } as HarnessRunState;
  return requestDocumentBundle({
    state,
    inputPackage,
    runRoot,
    evidenceRoot: project,
    timeoutSeconds: 20,
    firstOutputTimeoutSeconds: 5,
  });
}

describe("incremental document contracts", () => {
  it("accepts canonical JSON without changing its canonical representation", () => {
    const source = samplePlan();
    const canonical = { ...source, documents: source.documents.map((document) => ({ ...document, dependsOn: [] })) };
    expect(parseDocumentPlan(JSON.stringify(canonical))).toEqual(canonical);
  });

  it("strips a JSON fence and ignores prose outside explicit sentinels", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const output = [
        "Harmless provider preface.",
        DOCUMENT_PLAN_BEGIN,
        "```json",
        JSON.stringify(samplePlan()),
        "```",
        DOCUMENT_PLAN_END,
        "Harmless provider epilogue.",
      ].join("\n");
      expect(parseDocumentPlan(output).documents).toHaveLength(1);
      expect(write.mock.calls.flat().join("")).toContain('"stripped-json-fence"');
    } finally {
      write.mockRestore();
    }
  });

  it("recovers the real MiMo missing-brace shape without losing plan semantics", async () => {
    const fixturePath = resolve(import.meta.dirname, "fixtures/document-plan/mimo-missing-brace.txt");
    const malformed = await readFile(fixturePath, "utf8");
    const corrected = malformed.replace('],"documents":[', ']},"documents":[');
    expect(corrected).not.toBe(malformed);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const recovered = parseDocumentPlan(malformed);
      const canonical = parseDocumentPlan(corrected);
      expect(recovered).toEqual(canonical);
      expect(recovered.documents).toHaveLength(10);
      expect(recovered.documents.flatMap((document) => document.parts)).toHaveLength(19);
      expect(recovered.documents.map((document) => document.path)).toEqual(canonical.documents.map((document) => document.path));
      expect(recovered.documents.map((document) => document.parts.map((part) => part.id)))
        .toEqual(canonical.documents.map((document) => document.parts.map((part) => part.id)));
      expect(recovered.documents.map((document) => document.dependsOn))
        .toEqual(canonical.documents.map((document) => document.dependsOn));
      expect(write.mock.calls.flat().join("")).toContain('"recovered-root-property-boundary"');
      expect(write.mock.calls.flat().join("")).toContain('"canonicalized-coordination-object"');
    } finally {
      write.mockRestore();
    }
  });

  it("serializes an accepted coordination object deterministically without interpretation", () => {
    const value = samplePlan();
    value.coordination = {
      traceability: { "RF-002": "P02/T002", "RF-001": "P01/T001" },
      sharedIds: ["RF-001", "RF-002", "P01", "P02"],
    } as unknown as string;
    expect(parseDocumentPlan(envelope(DOCUMENT_PLAN_BEGIN, DOCUMENT_PLAN_END, value)).coordination).toBe(
      '{"sharedIds":["RF-001","RF-002","P01","P02"],"traceability":{"RF-001":"P01/T001","RF-002":"P02/T002"}}',
    );
  });

  describe("plan-local document dependency identity", () => {
    const planWith = (documents: unknown[]) => ({
      contract: "rb-harness-document-plan/v1",
      status: "complete",
      summary: "Dependency identity fixture.",
      coordination: "Exact plan-local IDs only.",
      documents,
      blocked: [],
    });
    const document = (path: string, partId: string, dependsOn: string[] = [], purpose = path) => ({
      path,
      purpose,
      dependsOn,
      parts: [{ id: partId, purpose: `Bounded part ${partId}.` }],
    });

    it.each([
      ["real user run", "real-user-project-overview.json", "project-overview"],
      ["real smoke replan", "real-smoke-project-main.json", "project-main"],
    ])("canonicalizes the exact %s dependency fixture", async (_label, name, rawId) => {
      const raw = await readFile(resolve(import.meta.dirname, `fixtures/document-plan/${name}`), "utf8");
      const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        const parsed = parseDocumentPlan(raw);
        expect(parsed.documents.find((entry) => entry.path.endsWith("REQUIREMENTS.md"))?.dependsOn)
          .toEqual([".rb/init/PROJECT.md"]);
        expect(write.mock.calls.flat().join("")).toMatch(/document-plan dependency aliases resolved: [1-9][0-9]*/);
        expect(write.mock.calls.flat().join("")).toContain(
          `\"rawId\":\"${rawId}\",\"canonicalPath\":\".rb/init/PROJECT.md\"`,
        );
        const undeclared = JSON.parse(raw) as { documents: Array<{
          path: string;
          parts: Array<{ id: string }>;
        }> };
        const project = undeclared.documents.find((entry) => entry.path === ".rb/init/PROJECT.md")!;
        project.parts.find((part) => part.id === rawId)!.id = `${rawId}-not-declared`;
        expect(() => parseDocumentPlan(JSON.stringify(undeclared)))
          .toThrow(`depends on missing document ${rawId}`);
      } finally {
        write.mockRestore();
      }
    });

    it("rejects an undeclared alias without inferring it from purpose text or a path-derived name", () => {
      const value = planWith([
        document(
          ".rb/init/PROJECT.md",
          "project-body",
          [],
          "Project overview, objective, users, scope, and success criteria.",
        ),
        document(".rb/init/REQUIREMENTS.md", "requirements-main", ["project-overview"]),
      ]);
      expect(() => parseDocumentPlan(JSON.stringify(value)))
        .toThrow("depends on missing document project-overview");
      expect(() => parseDocumentPlan(JSON.stringify(planWith([
        document(".rb/init/PROJECT.md", "project-body"),
        document(".rb/init/REQUIREMENTS.md", "requirements-main", ["project"]),
      ])))).toThrow("depends on missing document project");
    });

    it("fails closed when a referenced plan-local ID has multiple document owners", () => {
      const value = planWith([
        document(".rb/init/PROJECT.md", "shared"),
        document(".rb/init/DECISIONS.md", "shared"),
        document(".rb/init/REQUIREMENTS.md", "requirements-main", ["shared"]),
      ]);
      expect(() => parseDocumentPlan(JSON.stringify(value)))
        .toThrow("ambiguous plan-local ID shared declared by .rb/init/DECISIONS.md, .rb/init/PROJECT.md");
    });

    it("accepts direct canonical paths and leaves a valid canonical graph unchanged", () => {
      const value = planWith([
        document(".rb/init/PROJECT.md", "project-main"),
        document(".rb/init/REQUIREMENTS.md", "requirements-main", [".rb/init/PROJECT.md"]),
      ]);
      expect(parseDocumentPlan(JSON.stringify(value))).toEqual(value);
    });

    it("does not carry a raw alias from a rejected plan into a replan", () => {
      expect(parseDocumentPlan(JSON.stringify(planWith([
        document(".rb/init/PROJECT.md", "project-main"),
      ])))).toBeDefined();
      const replan = planWith([
        document(".rb/init/PROJECT.md", "project-overview"),
        document(".rb/init/REQUIREMENTS.md", "requirements-main", ["project-main"]),
      ]);
      expect(() => parseDocumentPlan(JSON.stringify(replan)))
        .toThrow("depends on missing document project-main");
    });

    it("keeps the current contract closed instead of inventing a canonical document ID field", () => {
      const project = { ...document(".rb/init/PROJECT.md", "project-main"), id: "project" };
      expect(() => parseDocumentPlan(JSON.stringify(planWith([project]))))
        .toThrow("unsupported planned document field: id");
    });

    it("canonicalizes aliases before applying deterministic cycle handling", () => {
      const parsed = parseDocumentPlan(JSON.stringify(planWith([
        document(".rb/init/A.md", "a", ["b"]),
        document(".rb/init/B.md", "b", ["a"]),
      ])));
      expect(parsed.documents.map((entry) => [entry.path, entry.dependsOn])).toEqual([
        [".rb/init/B.md", []],
        [".rb/init/A.md", [".rb/init/B.md"]],
      ]);
    });
  });

  it("rejects ambiguous brace recovery and unsupported coordination authority", async () => {
    const fixturePath = resolve(import.meta.dirname, "fixtures/document-plan/mimo-missing-brace.txt");
    const malformed = await readFile(fixturePath, "utf8");
    const ambiguous = malformed.replace('],"documents":[', '],"documents":[],"documents":[');
    expect(() => parseDocumentPlan(ambiguous)).toThrow("malformed document plan JSON");
    expect(() => parseDocumentPlan(envelope(DOCUMENT_PLAN_BEGIN, DOCUMENT_PLAN_END, {
      ...samplePlan(), coordination: { documents: ["not root authority"] },
    }))).toThrow("unsupported document plan coordination authority field: documents");
  });

  it("keeps semantic completeness and unknown-structure checks fail-closed", () => {
    const incomplete = parseDocumentPlan(envelope(DOCUMENT_PLAN_BEGIN, DOCUMENT_PLAN_END, samplePlan()));
    expect(() => assertGenerationPlanComplete("init", incomplete)).toThrow("omits mandatory current-run artifacts");
    expect(() => parseDocumentPlan(envelope(DOCUMENT_PLAN_BEGIN, DOCUMENT_PLAN_END, {
      ...samplePlan(), semanticAuthority: { decision: "requires model judgment" },
    }))).toThrow("unsupported document plan field: semanticAuthority");
    expect(() => parseDocumentPlan(envelope(DOCUMENT_PLAN_BEGIN, DOCUMENT_PLAN_END, {
      ...samplePlan(), coordination: ["RF-001", "P01/T001"],
    }))).toThrow("document plan coordination must be a non-empty string");
  });

  it("removes only the evidenced non-authoritative document prefix and keeps canonical fields", () => {
    const prefixed = samplePlan();
    prefixed.documents[0] = {
      ...prefixed.documents[0]!,
      purpose: "Canonical purpose wins.",
      prefix: "Presentation heading only.",
    } as typeof prefixed.documents[number];
    const parsed = parseDocumentPlan(envelope(DOCUMENT_PLAN_BEGIN, DOCUMENT_PLAN_END, prefixed));
    expect(parsed.documents[0]?.purpose).toBe("Canonical purpose wins.");
    expect(parsed.documents[0]).not.toHaveProperty("prefix");
    expect(() => parseDocumentPlan(envelope(DOCUMENT_PLAN_BEGIN, DOCUMENT_PLAN_END, {
      ...samplePlan(), documents: [{ ...samplePlan().documents[0], outputPath: "/tmp/redirect" }],
    }))).toThrow("unsupported planned document field: outputPath");
  });

  it("assembles ordered bounded parts into one normalized document", () => {
    const plan = parseDocumentPlan(envelope(DOCUMENT_PLAN_BEGIN, DOCUMENT_PLAN_END, samplePlan()));
    const first = parseDocumentPart(envelope(DOCUMENT_PART_BEGIN, DOCUMENT_PART_END, {
      contract: "rb-harness-document-part/v1", path: ".rb/init/PHASES.md", part: "header", content: "# Plan\n",
    }), { path: ".rb/init/PHASES.md", part: "header" });
    const second = parseDocumentPart(envelope(DOCUMENT_PART_BEGIN, DOCUMENT_PART_END, {
      contract: "rb-harness-document-part/v1", path: ".rb/init/PHASES.md", part: "phase-01", content: "\n## Phase 1\n",
    }), { path: ".rb/init/PHASES.md", part: "phase-01" });
    expect(assembleDocumentPlan(plan, [second, first]).documents[0]?.content).toBe("# Plan\n\n## Phase 1\n");
  });

  it("rejects unsafe paths, duplicate parts, and oversized part bodies", () => {
    expect(() => parseDocumentPlan(envelope(DOCUMENT_PLAN_BEGIN, DOCUMENT_PLAN_END, {
      ...samplePlan(), documents: [{ path: "src/app.ts", purpose: "bad", parts: [{ id: "x", purpose: "x" }] }],
    }))).toThrow("only under .rb");
    expect(() => parseDocumentPlan(envelope(DOCUMENT_PLAN_BEGIN, DOCUMENT_PLAN_END, {
      ...samplePlan(), documents: [{ path: ".rb/init/X.md", purpose: "x", parts: [{ id: "x", purpose: "x" }, { id: "x", purpose: "x" }] }],
    }))).toThrow("declares part x twice");
    expect(() => parseDocumentPlan(envelope(DOCUMENT_PLAN_BEGIN, DOCUMENT_PLAN_END, {
      ...samplePlan(), blocked: ["contradiction"],
    }))).toThrow("cannot retain blockers");
    expect(() => parseDocumentPart(envelope(DOCUMENT_PART_BEGIN, DOCUMENT_PART_END, {
      contract: "rb-harness-document-part/v1", path: ".rb/init/X.md", part: "x", content: "x".repeat(HARNESS_BUDGET.documents.maxPartBytes + 1),
      // The size defect names the observed bytes and the limit, because the
      // writer is asked to author the same span again rather than reformat it.
    }), { path: ".rb/init/X.md", part: "x" })).toThrow(/is \d+ bytes, above the \d+-byte limit/);
    const plan = parseDocumentPlan(envelope(DOCUMENT_PLAN_BEGIN, DOCUMENT_PLAN_END, samplePlan()));
    expect(() => assembleDocumentPlan(plan, [{
      contract: "rb-harness-document-part/v1", path: ".rb/init/OTHER.md", part: "x", content: "unexpected",
    }])).toThrow("unexpected part");
  });

  it("accepts a semantically useful purpose without asking a model to count field bytes", () => {
    const purpose = "Fase P03: " + "fronteira ".repeat(1_750);
    expect(Buffer.byteLength(purpose)).toBeGreaterThan(16 * 1024);
    const value = samplePlan();
    value.documents[0]!.parts[0]!.purpose = purpose;
    const plan = parseDocumentPlan(envelope(DOCUMENT_PLAN_BEGIN, DOCUMENT_PLAN_END, value));
    expect(plan.documents[0]!.parts[0]!.purpose).toBe(purpose.trim());
  });

  it("rejects every unknown authority field instead of guessing provider-specific exceptions", () => {
    expect(() => parseDocumentPlan(envelope(DOCUMENT_PLAN_BEGIN, DOCUMENT_PLAN_END, {
      ...samplePlan(),
      documents: [{ ...samplePlan().documents[0], outputPath: "/tmp/redirect" }],
    }))).toThrow("unsupported planned document field: outputPath");
  });

  it("derives and topologically orders load-bearing document dependencies", () => {
    const value = samplePlan();
    value.documents = [
      { path: ".rb/init/OPERATIONS.json", purpose: "Operations", parts: [{ id: "whole", purpose: "Whole" }] },
      { path: ".rb/init/PHASES.md", purpose: "Execution", parts: [{ id: "whole", purpose: "Whole" }] },
      { path: ".rb/init/PROJECT.md", purpose: "Intent", parts: [{ id: "whole", purpose: "Whole" }] },
    ];
    const plan = parseDocumentPlan(envelope(DOCUMENT_PLAN_BEGIN, DOCUMENT_PLAN_END, value));
    expect(plan.documents.map((document) => document.path)).toEqual([
      ".rb/init/PROJECT.md",
      ".rb/init/PHASES.md",
      ".rb/init/OPERATIONS.json",
    ]);
    expect(plan.documents[1]?.dependsOn).toContain(".rb/init/PROJECT.md");
    expect(plan.documents[2]?.dependsOn).toEqual([".rb/init/PHASES.md"]);
  });

  it("rejects missing dependencies and normalizes provider-only cycles", () => {
    expect(() => parseDocumentPlan(envelope(DOCUMENT_PLAN_BEGIN, DOCUMENT_PLAN_END, {
      ...samplePlan(),
      documents: [{ ...samplePlan().documents[0], dependsOn: [".rb/init/MISSING.md"] }],
    }))).toThrow("depends on missing document");

    const cyclic = parseDocumentPlan(envelope(DOCUMENT_PLAN_BEGIN, DOCUMENT_PLAN_END, {
      ...samplePlan(),
      documents: [
        { path: ".rb/init/A.md", purpose: "A", dependsOn: [".rb/init/B.md"], parts: [{ id: "a", purpose: "A" }] },
        { path: ".rb/init/B.md", purpose: "B", dependsOn: [".rb/init/A.md"], parts: [{ id: "b", purpose: "B" }] },
      ],
    }));
    expect(cyclic.documents.map((document) => document.path)).toEqual([".rb/init/B.md", ".rb/init/A.md"]);
    expect(cyclic.documents[0]?.dependsOn).toEqual([]);
    expect(cyclic.documents[1]?.dependsOn).toEqual([".rb/init/B.md"]);
  });

  it("keeps the code-owned init order when provider suggestions contain realistic reciprocal edges", () => {
    const document = (name: string, dependsOn: string[] = []) => ({
      path: `.rb/init/${name}`,
      purpose: name,
      dependsOn,
      parts: [{ id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), purpose: name }],
    });
    const value = samplePlan();
    value.documents = [
      document("ARCHITECTURE.md"),
      document("DECISIONS.md"),
      document("GLOSSARY.md"),
      document("NON_FUNCTIONAL.md"),
      document("PROJECT.md"),
      document("REQUIREMENTS.md"),
      document("WORKFLOWS.md"),
      document("OPERATIONS.json", [
        ".rb/init/ARCHITECTURE.md",
        ".rb/init/DECISIONS.md",
        ".rb/init/NON_FUNCTIONAL.md",
        ".rb/init/PHASES.md",
        ".rb/init/REQUIREMENTS.md",
      ]),
      document("PLAN.md", [
        ".rb/init/ARCHITECTURE.md",
        ".rb/init/DECISIONS.md",
        ".rb/init/NON_FUNCTIONAL.md",
        ".rb/init/OPERATIONS.json",
        ".rb/init/REQUIREMENTS.md",
      ]),
      document("PHASES.md", [
        ".rb/init/ARCHITECTURE.md",
        ".rb/init/DECISIONS.md",
        ".rb/init/NON_FUNCTIONAL.md",
        ".rb/init/OPERATIONS.json",
        ".rb/init/PLAN.md",
        ".rb/init/PROJECT.md",
        ".rb/init/REQUIREMENTS.md",
        ".rb/init/WORKFLOWS.md",
      ]),
      document("source-manifest.json", [
        ".rb/init/ARCHITECTURE.md",
        ".rb/init/DECISIONS.md",
        ".rb/init/GLOSSARY.md",
        ".rb/init/NON_FUNCTIONAL.md",
        ".rb/init/OPERATIONS.json",
        ".rb/init/PHASES.md",
        ".rb/init/PLAN.md",
        ".rb/init/PROJECT.md",
        ".rb/init/REQUIREMENTS.md",
        ".rb/init/WORKFLOWS.md",
      ]),
    ];

    const plan = parseDocumentPlan(envelope(DOCUMENT_PLAN_BEGIN, DOCUMENT_PLAN_END, value));
    const byPath = new Map(plan.documents.map((entry) => [entry.path, entry]));
    const paths = plan.documents.map((entry) => entry.path);
    expect(byPath.get(".rb/init/PHASES.md")?.dependsOn).not.toContain(".rb/init/OPERATIONS.json");
    expect(byPath.get(".rb/init/PLAN.md")?.dependsOn).not.toContain(".rb/init/OPERATIONS.json");
    expect(byPath.get(".rb/init/OPERATIONS.json")?.dependsOn).toContain(".rb/init/PHASES.md");
    expect(paths.indexOf(".rb/init/PLAN.md")).toBeLessThan(paths.indexOf(".rb/init/PHASES.md"));
    expect(paths.indexOf(".rb/init/PHASES.md")).toBeLessThan(paths.indexOf(".rb/init/OPERATIONS.json"));
    expect(paths.at(-1)).toBe(".rb/init/source-manifest.json");
  });

  it("preserves a document part whose JSON string contains literal streamed line breaks", () => {
    const malformedByStrictJson = [
      DOCUMENT_PART_BEGIN,
      '{"contract":"rb-harness-document-part/v1","path":".rb/init/PHASES.md","part":"phase-01","content":"',
      "## Phase 1\n\n- first line\n- second line",
      '"}',
      DOCUMENT_PART_END,
    ].join("\n");
    const part = parseDocumentPart(malformedByStrictJson, { path: ".rb/init/PHASES.md", part: "phase-01" });
    expect(part.content).toBe("\n## Phase 1\n\n- first line\n- second line\n");
  });
});

describe("provider-neutral incremental authoring", () => {
  it("replans a missing mandatory document before authoring any part", async () => {
    await chmod(fixture, 0o755);
    const project = await mkdtemp(resolve(tmpdir(), "rb-incremental-completeness-"));
    const runRoot = resolve(project, ".rb-harness/runs/test");
    const calls = resolve(await mkdtemp(resolve(tmpdir(), "rb-incremental-completeness-calls-")), "calls.log");
    process.env.RB_HARNESS_TEST_INCREMENTAL_CALLS = calls;
    process.env.RB_HARNESS_TEST_INCOMPLETE_FIRST_PLAN = "1";
    await writeFile(resolve(project, "README.md"), "fixture\n", "utf8");

    const bundle = await requestFixture(project, runRoot);
    expect(bundle.documents.map((document) => document.path)).toEqual(COMPLETE_INIT_PATHS);
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual([
      "plan",
      "plan",
      ...COMPLETE_INIT_CALLS,
    ]);
  }, 60_000);

  it("replans a valid JSON plan with an unknown dependency without calling the formatter", async () => {
    await chmod(fixture, 0o755);
    const project = await mkdtemp(resolve(tmpdir(), "rb-incremental-semantic-dependency-"));
    const runRoot = resolve(project, ".rb-harness/runs/test");
    const calls = resolve(await mkdtemp(resolve(tmpdir(), "rb-incremental-semantic-dependency-calls-")), "calls.log");
    process.env.RB_HARNESS_TEST_INCREMENTAL_CALLS = calls;
    process.env.RB_HARNESS_TEST_MISSING_DEPENDENCY = "1";
    await writeFile(resolve(project, "README.md"), "fixture\n", "utf8");

    await expect(requestFixture(project, runRoot)).rejects
      .toThrow("depends on missing document project-foo");
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual(["plan", "plan"]);
  }, 60_000);

  it("stops formatting when representation repair exposes a semantic dependency defect", async () => {
    await chmod(fixture, 0o755);
    const project = await mkdtemp(resolve(tmpdir(), "rb-incremental-formatted-semantic-dependency-"));
    const runRoot = resolve(project, ".rb-harness/runs/test");
    const calls = resolve(
      await mkdtemp(resolve(tmpdir(), "rb-incremental-formatted-semantic-dependency-calls-")),
      "calls.log",
    );
    process.env.RB_HARNESS_TEST_INCREMENTAL_CALLS = calls;
    process.env.RB_HARNESS_TEST_MISSING_DEPENDENCY = "1";
    await writeFile(resolve(project, "README.md"), "fixture\n", "utf8");
    await mkdir(resolve(runRoot, "logs"), { recursive: true });
    await writeFile(resolve(runRoot, "logs/generation-plan.log"), [
      "exit_code=0", "", "--- stdout ---",
      DOCUMENT_PLAN_BEGIN, "YAML_PLAN_FIXTURE", DOCUMENT_PLAN_END,
      "", "--- stderr ---", "",
    ].join("\n"), { encoding: "utf8", mode: 0o600 });

    await expect(requestFixture(project, runRoot)).rejects
      .toThrow("depends on missing document project-foo");
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual(["format", "plan"]);
  }, 60_000);

  it("builds every replan alias map only from the new response", async () => {
    await chmod(fixture, 0o755);
    const project = await mkdtemp(resolve(tmpdir(), "rb-incremental-stale-dependency-alias-"));
    const runRoot = resolve(project, ".rb-harness/runs/test");
    const calls = resolve(await mkdtemp(resolve(tmpdir(), "rb-incremental-stale-dependency-alias-calls-")), "calls.log");
    process.env.RB_HARNESS_TEST_INCREMENTAL_CALLS = calls;
    process.env.RB_HARNESS_TEST_STALE_DEPENDENCY_ALIAS = "1";
    await writeFile(resolve(project, "README.md"), "fixture\n", "utf8");

    await expect(requestFixture(project, runRoot)).rejects
      .toThrow("depends on missing document project-main");
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual(["plan", "plan"]);
  }, 60_000);

  it("authors and assembles documents over independent custom-adapter calls", async () => {
    await chmod(fixture, 0o755);
    const project = await mkdtemp(resolve(tmpdir(), "rb-incremental-project-"));
    const runRoot = resolve(project, ".rb-harness/runs/test");
    const calls = resolve(await mkdtemp(resolve(tmpdir(), "rb-incremental-calls-")), "calls.log");
    process.env.RB_HARNESS_TEST_INCREMENTAL_CALLS = calls;
    await writeFile(resolve(project, "README.md"), "fixture\n", "utf8");
    const bundle = await requestFixture(project, runRoot);
    expect(bundle.documents.map((document) => document.path)).toEqual(COMPLETE_INIT_PATHS);
    expect(bundle.documents.find((document) => document.path.endsWith("PHASES.md"))?.content)
      .toContain("## Phase 1: Deliver incrementally");
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual([
      "plan",
      ...COMPLETE_INIT_CALLS,
    ]);
  }, 60_000);

  it("authors OPERATIONS only after PHASES and passes its finalized execution projection", async () => {
    await chmod(fixture, 0o755);
    const project = await mkdtemp(resolve(tmpdir(), "rb-incremental-dependencies-"));
    const runRoot = resolve(project, ".rb-harness/runs/test");
    const calls = resolve(await mkdtemp(resolve(tmpdir(), "rb-incremental-dependency-calls-")), "calls.log");
    process.env.RB_HARNESS_TEST_INCREMENTAL_CALLS = calls;
    process.env.RB_HARNESS_TEST_DOCUMENT_DEPENDENCIES = "1";
    await writeFile(resolve(project, "README.md"), "fixture\n", "utf8");
    const bundle = await requestFixture(project, runRoot);
    expect(bundle.documents.find((document) => document.path.endsWith("OPERATIONS.json"))?.content)
      .toContain('"path": "src/index.js"');
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual([
      "plan",
      ".rb/init/PROJECT.md#whole",
      ".rb/init/REQUIREMENTS.md#whole",
      ".rb/init/DECISIONS.md#whole",
      ".rb/init/PLAN.md#whole",
      ".rb/init/PHASES.md#header",
      ".rb/init/PHASES.md#phase-01",
      ".rb/init/OPERATIONS.json#whole",
      ".rb/init/source-manifest.json#whole",
    ]);
  }, 60_000);

  it("normalizes a provider PHASES to OPERATIONS cycle without buying a replan", async () => {
    await chmod(fixture, 0o755);
    const project = await mkdtemp(resolve(tmpdir(), "rb-incremental-cyclic-dependencies-"));
    const runRoot = resolve(project, ".rb-harness/runs/test");
    const calls = resolve(await mkdtemp(resolve(tmpdir(), "rb-incremental-cyclic-dependency-calls-")), "calls.log");
    process.env.RB_HARNESS_TEST_INCREMENTAL_CALLS = calls;
    process.env.RB_HARNESS_TEST_CYCLIC_DOCUMENT_DEPENDENCIES = "1";
    await writeFile(resolve(project, "README.md"), "fixture\n", "utf8");

    const bundle = await requestFixture(project, runRoot);
    expect(bundle.documents.find((document) => document.path.endsWith("OPERATIONS.json"))?.content)
      .toContain('"path": "src/index.js"');
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual([
      "plan",
      ".rb/init/PROJECT.md#whole",
      ".rb/init/REQUIREMENTS.md#whole",
      ".rb/init/DECISIONS.md#whole",
      ".rb/init/PLAN.md#whole",
      ".rb/init/PHASES.md#header",
      ".rb/init/PHASES.md#phase-01",
      ".rb/init/OPERATIONS.json#whole",
      ".rb/init/source-manifest.json#whole",
    ]);
  }, 60_000);

  it("resumes at the failed part without regenerating completed paid work", async () => {
    await chmod(fixture, 0o755);
    const project = await mkdtemp(resolve(tmpdir(), "rb-incremental-resume-"));
    const runRoot = resolve(project, ".rb-harness/runs/test");
    const calls = resolve(await mkdtemp(resolve(tmpdir(), "rb-incremental-resume-calls-")), "calls.log");
    process.env.RB_HARNESS_TEST_INCREMENTAL_CALLS = calls;
    process.env.RB_HARNESS_TEST_INCREMENTAL_EXIT_PART = "phase-01";
    await writeFile(resolve(project, "README.md"), "fixture\n", "utf8");
    await expect(requestFixture(project, runRoot)).rejects.toThrow("exited with code 1");
    delete process.env.RB_HARNESS_TEST_INCREMENTAL_EXIT_PART;
    const bundle = await requestFixture(project, runRoot);
    expect(bundle.documents).toHaveLength(6);
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual([
      "plan",
      ".rb/init/PROJECT.md#whole",
      ".rb/init/REQUIREMENTS.md#whole",
      ".rb/init/DECISIONS.md#whole",
      ".rb/init/PLAN.md#whole",
      ".rb/init/PHASES.md#header",
      ".rb/init/PHASES.md#phase-01",
      ".rb/init/PHASES.md#phase-01",
      ".rb/init/source-manifest.json#whole",
    ]);
  }, 60_000);

  it("recovers a completed malformed-JSON part from its paid log before spawning a provider", async () => {
    await chmod(fixture, 0o755);
    const project = await mkdtemp(resolve(tmpdir(), "rb-incremental-log-recovery-"));
    const runRoot = resolve(project, ".rb-harness/runs/test");
    const calls = resolve(await mkdtemp(resolve(tmpdir(), "rb-incremental-log-calls-")), "calls.log");
    process.env.RB_HARNESS_TEST_INCREMENTAL_CALLS = calls;
    process.env.RB_HARNESS_TEST_INCREMENTAL_EXIT_PART = "phase-01";
    await writeFile(resolve(project, "README.md"), "fixture\n", "utf8");
    await expect(requestFixture(project, runRoot)).rejects.toThrow("exited with code 1");
    delete process.env.RB_HARNESS_TEST_INCREMENTAL_EXIT_PART;
    const malformed = [
      "exit_code=0",
      "",
      "--- stdout ---",
      DOCUMENT_PART_BEGIN,
      '{"contract":"rb-harness-document-part/v1","path":".rb/init/PHASES.md","part":"phase-01","content":"',
      "## Phase 1: recovered\n\nRecovered without another call.",
      '"}',
      DOCUMENT_PART_END,
      "",
      "--- stderr ---",
      "",
    ].join("\n");
    await writeFile(resolve(runRoot, "logs/generation-document-005-part-002.log"), malformed, "utf8");
    const bundle = await requestFixture(project, runRoot);
    expect(bundle.documents.find((document) => document.path.endsWith("PHASES.md"))?.content).toContain("Recovered without another call");
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual([
      "plan",
      ".rb/init/PROJECT.md#whole",
      ".rb/init/REQUIREMENTS.md#whole",
      ".rb/init/DECISIONS.md#whole",
      ".rb/init/PLAN.md#whole",
      ".rb/init/PHASES.md#header",
      ".rb/init/PHASES.md#phase-01",
      ".rb/init/source-manifest.json#whole",
    ]);
  }, 60_000);

  it("formats a malformed legacy part envelope without regenerating its semantic content", async () => {
    await chmod(fixture, 0o755);
    const project = await mkdtemp(resolve(tmpdir(), "rb-incremental-part-format-"));
    const runRoot = resolve(project, ".rb-harness/runs/test");
    const calls = resolve(await mkdtemp(resolve(tmpdir(), "rb-incremental-part-format-calls-")), "calls.log");
    process.env.RB_HARNESS_TEST_INCREMENTAL_CALLS = calls;
    process.env.RB_HARNESS_TEST_INCREMENTAL_FAIL_PART = "phase-01";
    await writeFile(resolve(project, "README.md"), "fixture\n", "utf8");

    const bundle = await requestFixture(project, runRoot);
    expect(bundle.documents.find((document) => document.path.endsWith("PHASES.md"))?.content)
      .toContain('Recovered "quoted" content.');
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual([
      "plan",
      ".rb/init/PROJECT.md#whole",
      ".rb/init/REQUIREMENTS.md#whole",
      ".rb/init/DECISIONS.md#whole",
      ".rb/init/PLAN.md#whole",
      ".rb/init/PHASES.md#header",
      ".rb/init/PHASES.md#phase-01",
      "format",
      ".rb/init/source-manifest.json#whole",
    ]);
  }, 60_000);

  it("normalizes a completed compatible plan from its paid log without spawning a formatter", async () => {
    await chmod(fixture, 0o755);
    const project = await mkdtemp(resolve(tmpdir(), "rb-incremental-plan-log-recovery-"));
    const runRoot = resolve(project, ".rb-harness/runs/test");
    const calls = resolve(await mkdtemp(resolve(tmpdir(), "rb-incremental-plan-log-calls-")), "calls.log");
    process.env.RB_HARNESS_TEST_INCREMENTAL_CALLS = calls;
    await writeFile(resolve(project, "README.md"), "fixture\n", "utf8");
    await mkdir(resolve(runRoot, "logs"), { recursive: true });
    const prefixed = completeInitPlan();
    const phases = prefixed.documents.findIndex((document) => document.path.endsWith("PHASES.md"));
    prefixed.documents[phases] = { ...prefixed.documents[phases]!, prefix: "execution plan" } as typeof prefixed.documents[number];
    await writeFile(resolve(runRoot, "logs/generation-plan.log"), [
      "exit_code=0",
      "",
      "--- stdout ---",
      envelope(DOCUMENT_PLAN_BEGIN, DOCUMENT_PLAN_END, prefixed),
      "",
      "--- stderr ---",
      "",
    ].join("\n"), { encoding: "utf8", mode: 0o600 });

    const bundle = await requestFixture(project, runRoot);
    expect(bundle.documents).toHaveLength(6);
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual([
      ...COMPLETE_INIT_CALLS,
    ]);
  }, 60_000);

  it("keeps the semantic plan immutable and allows exactly three closed formatter attempts", async () => {
    await chmod(fixture, 0o755);
    const project = await mkdtemp(resolve(tmpdir(), "rb-incremental-format-retry-"));
    const runRoot = resolve(project, ".rb-harness/runs/test");
    const calls = resolve(await mkdtemp(resolve(tmpdir(), "rb-incremental-format-calls-")), "calls.log");
    process.env.RB_HARNESS_TEST_INCREMENTAL_CALLS = calls;
    process.env.RB_HARNESS_TEST_FORMAT_INVALID_ATTEMPTS = "2";
    await writeFile(resolve(project, "README.md"), "fixture\n", "utf8");
    await mkdir(resolve(runRoot, "logs"), { recursive: true });
    await writeFile(resolve(runRoot, "logs/generation-plan.log"), [
      "exit_code=0", "", "--- stdout ---",
      DOCUMENT_PLAN_BEGIN, "YAML_PLAN_FIXTURE", DOCUMENT_PLAN_END,
      "", "--- stderr ---", "",
    ].join("\n"), { encoding: "utf8", mode: 0o600 });

    const bundle = await requestFixture(project, runRoot);
    expect(bundle.documents).toHaveLength(6);
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual([
      "format", "format", "format",
      ...COMPLETE_INIT_CALLS,
    ]);
  }, 60_000);

  it("fails after three invalid formatter responses without repeating semantic generation", async () => {
    await chmod(fixture, 0o755);
    const project = await mkdtemp(resolve(tmpdir(), "rb-incremental-format-ceiling-"));
    const runRoot = resolve(project, ".rb-harness/runs/test");
    const calls = resolve(await mkdtemp(resolve(tmpdir(), "rb-incremental-format-ceiling-calls-")), "calls.log");
    process.env.RB_HARNESS_TEST_INCREMENTAL_CALLS = calls;
    process.env.RB_HARNESS_TEST_FORMAT_INVALID_ATTEMPTS = "3";
    await writeFile(resolve(project, "README.md"), "fixture\n", "utf8");
    await mkdir(resolve(runRoot, "logs"), { recursive: true });
    await writeFile(resolve(runRoot, "logs/generation-plan.log"), [
      "exit_code=0", "", "--- stdout ---",
      DOCUMENT_PLAN_BEGIN, "YAML_PLAN_FIXTURE", DOCUMENT_PLAN_END,
      "", "--- stderr ---", "",
    ].join("\n"), { encoding: "utf8", mode: 0o600 });

    await expect(requestFixture(project, runRoot)).rejects.toThrow("after 3 attempts");
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual(["format", "format", "format"]);
  }, 60_000);

  it("accepts the MiMo missing-brace plan with zero formatter calls", async () => {
    await chmod(fixture, 0o755);
    const project = await mkdtemp(resolve(tmpdir(), "rb-incremental-mimo-normalization-"));
    const runRoot = resolve(project, ".rb-harness/runs/test");
    const calls = resolve(await mkdtemp(resolve(tmpdir(), "rb-incremental-mimo-normalization-calls-")), "calls.log");
    process.env.RB_HARNESS_TEST_INCREMENTAL_CALLS = calls;
    process.env.RB_HARNESS_TEST_MIMO_PLAN = "1";
    await writeFile(resolve(project, "README.md"), "fixture\n", "utf8");

    const bundle = await requestFixture(project, runRoot);
    expect(bundle.documents).toHaveLength(6);
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual([
      "plan",
      ...COMPLETE_INIT_CALLS,
    ]);
  }, 60_000);

  it("stops after one formatter attempt repeats the rejected malformed plan", async () => {
    await chmod(fixture, 0o755);
    const project = await mkdtemp(resolve(tmpdir(), "rb-incremental-format-repeat-"));
    const runRoot = resolve(project, ".rb-harness/runs/test");
    const calls = resolve(await mkdtemp(resolve(tmpdir(), "rb-incremental-format-repeat-calls-")), "calls.log");
    process.env.RB_HARNESS_TEST_INCREMENTAL_CALLS = calls;
    process.env.RB_HARNESS_TEST_MALFORMED_PLAN = "1";
    process.env.RB_HARNESS_TEST_REPEAT_FORMAT_OUTPUT = "1";
    await writeFile(resolve(project, "README.md"), "fixture\n", "utf8");

    await expect(requestFixture(project, runRoot)).rejects.toThrow(/after 1 attempt:.*repeated identical rejected payload/);
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual(["plan", "format"]);
  }, 60_000);
});

describe("OpenCode 1.18 event transport", () => {
  it("reconstructs a successful JSONL provider log before formatter recovery", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "rb-opencode-log-recovery-"));
    const log = resolve(directory, "provider.log");
    const answer = `${DOCUMENT_PLAN_BEGIN}\n${JSON.stringify(samplePlan())}\n${DOCUMENT_PLAN_END}`;
    await writeFile(log, [
      "provider=opencode",
      "exit_code=0",
      "stdout_transport=jsonl-events",
      "stream_mode=structured",
      "",
      "--- stdout ---",
      JSON.stringify({ type: "text", part: { type: "text", text: answer } }),
      "",
      "--- stderr ---",
      "",
    ].join("\n"), "utf8");
    expect(await successfulProviderLogStdout(log)).toBe(`${answer}\n`);
  });

  it("recovers only the text part and measures the real terminal event", () => {
    const observer = new ProviderStreamObserver({ mode: "structured", dialect: "opencode" });
    observer.push(`${JSON.stringify({ type: "step_start", part: { type: "step-start" } })}\n`);
    observer.push(`${JSON.stringify({ type: "text", part: { type: "text", text: "ENVELOPE" } })}\n`);
    expect(observer.push(`${JSON.stringify({ type: "step_finish", part: {
      type: "step-finish", reason: "stop", tokens: { total: 12, input: 5, output: 3, reasoning: 4, cache: { read: 0 } }, cost: 0.01,
    } })}\n`)).toBeUndefined();
    expect(observer.recoveredText()).toBe("ENVELOPE\n");
    expect(observer.report()).toMatchObject({
      turnEvents: 1, requests: 1, stopReason: "stop", totalTokens: 12, reasoningTokens: 4, costUsd: 0.01,
    });
  });

  it("stops once on length instead of feeding accounting noise to the envelope parser", () => {
    const observer = new ProviderStreamObserver({ mode: "structured", dialect: "opencode" });
    const breach = observer.push(`${JSON.stringify({ type: "step_finish", part: {
      type: "step-finish", reason: "length", tokens: { total: 45184, input: 13184, output: 0, reasoning: 32000, cache: { read: 0 } }, cost: 0.07,
    } })}\n`);
    expect(breach).toMatchObject({ code: "output-limit" });
    expect(breach?.message).toContain("reasoning tokens=32000");
    expect(observer.recoveredText()).toBe("");
  });
});
