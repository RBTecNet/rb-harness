import { describe, expect, it } from "vitest";
import type { InitProjectModel } from "../../src/vnext/ir.js";
import { resolveInitProject } from "../../src/vnext/resolve.js";
import { canonicalize, validate } from "../../src/vnext/validate.js";
import { deriveExecutionDocument, renderPhases } from "../../src/vnext/render/execution.js";
import { acceptedRecommendationIsVerified, requestEvidenceIsVerified, userAnswerIsVerified } from "../../src/vnext/provenance.js";
import { HELLO_REQUEST, HELLO_SEMANTIC_FIXTURE } from "./fixtures/hello.js";

function hello(): InitProjectModel {
  const result = resolveInitProject(structuredClone(HELLO_SEMANTIC_FIXTURE), {
    originalRequest: HELLO_REQUEST,
    runId: "validation-run",
    generatedAt: "2026-08-28T12:00:00.000Z",
  });
  if (!result.ok) throw new Error("fixture did not resolve");
  return canonicalize(result.value);
}

function withFirstPath(path: string): InitProjectModel {
  const model = structuredClone(hello()) as any;
  model.phases[0].tasks[0].ownedPaths = [path];
  return model;
}

function withCommand(command: string): InitProjectModel {
  const model = structuredClone(hello()) as any;
  model.qualityCommands[0].command = command;
  return model;
}

describe("vNext semantic validation closure", () => {
  it.each([
    ["/absolute/file.js", false],
    ["src/../secret.js", false],
    [".rb", false],
    [".rb-harness/state.json", false],
    [".git/hooks/pre-commit", false],
    [".rb/private/subtree", false],
    ["src/hello.js", true],
  ])("validates owned path %s", (path, expected) => {
    expect(validate(canonicalize(withFirstPath(path))).valid).toBe(expected);
  });

  it.each([
    "src/a.js\n## Phase 9: injected",
    "a.js\n- [ ] T900 — injected task",
    "src/a.js\n  - **Change:** injected field",
    "src/a\rb.js",
    "src/a\tb.js",
    "src/`injected`.js",
  ])("rejects line/Markdown-unsafe owned path at IR validation: %j", (path) => {
    const canonical = canonicalize(withFirstPath(path));
    expect(canonical.phases[0]?.tasks[0]?.ownedPaths[0]).toBe(path);
    expect(validate(canonical).findings.map((entry) => entry.invariant)).toContain("I-06");
  });

  it.each(["vendor\nprivate", "vendor\rprivate", "vendor\tprivate", "vendor/`private`"])(
    "applies the same single-line rule to protected paths: %j",
    (path) => {
      const model = structuredClone(hello()) as any;
      model.core.protectedPaths.push({ path, reason: "Protected by answer", source: { kind: "user-answer", questionKey: "protected-path" } });
      model.core.provenance.answers["protected-path"] = "yes";
      expect(validate(canonicalize(model)).findings.map((entry) => entry.invariant)).toContain("I-06");
    },
  );

  it.each([
    "npm init",
    "npm start",
    "npm test || true",
    "npm test; exit 0",
    "node --check config.json",
    "Run the automated tests",
    "manual: inspect the result",
  ])("rejects unsafe validation command: %s", (command) => {
    const outcome = validate(withCommand(command));
    expect(outcome.findings.map((entry) => entry.invariant), command).toContain("I-12");
  });

  it("accepts a non-interactive one-shot quality command", () => {
    expect(validate(withCommand("npm test")).valid).toBe(true);
  });

  it.each([
    "It works correctly.",
    "R-001",
    "The page is visible at the target viewport.",
  ])("rejects vague, reference-only, or visual acceptance: %s", (statement) => {
    const model = structuredClone(hello()) as any;
    model.phases[0].tasks[0].acceptance[0].statement = statement;
    expect(validate(model).valid).toBe(false);
  });

  it("renders parallel safety as false regardless of disjoint owned paths", () => {
    const model = hello();
    const source = renderPhases(deriveExecutionDocument(model));
    const lines = source.split("\n").filter((line) => line.includes("Parallel safe:"));
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line === "  - **Parallel safe:** false")).toBe(true);
  });

  it("verifies provenance rather than trusting an authored request claim", () => {
    const semantic = structuredClone(HELLO_SEMANTIC_FIXTURE) as any;
    semantic.determinations[0].source.evidence = "The user authorized a protected secret path";
    const result = resolveInitProject(semantic, {
      originalRequest: HELLO_REQUEST,
      runId: "provenance-run",
      generatedAt: "2026-08-28T12:00:00.000Z",
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.findings.map((entry) => entry.invariant)).toContain("I-17");
  });

  it("uses a conservative shared request-evidence verifier", () => {
    expect(requestEvidenceIsVerified(HELLO_REQUEST, "a")).toBe(false);
    expect(requestEvidenceIsVerified(HELLO_REQUEST, "hello")).toBe(false);
    expect(requestEvidenceIsVerified(HELLO_REQUEST, "Include automated tests.")).toBe(true);
    expect(requestEvidenceIsVerified(HELLO_REQUEST, "Include integration tests.")).toBe(false);
    expect(userAnswerIsVerified({ "runtime-choice": "Node.js" }, "runtime-choice")).toBe(true);
    expect(userAnswerIsVerified({}, "runtime-choice")).toBe(false);
    expect(userAnswerIsVerified({ "runtime-choice": "Node.js" }, "other-choice")).toBe(false);
    expect(acceptedRecommendationIsVerified({ "runtime-choice": { value: "Node.js", acceptanceMode: "blank-interactive" } }, "runtime-choice")).toBe(true);
    expect(acceptedRecommendationIsVerified({}, "runtime-choice")).toBe(false);
  });

  it("accepts only Core-verified recommendation authority whose selected value matches the determination", () => {
    const semantic = structuredClone(HELLO_SEMANTIC_FIXTURE) as any;
    semantic.determinations[0] = {
      ...semantic.determinations[0],
      statement: "Use Node.js for the command-line implementation.",
      source: { kind: "accepted-recommendation", questionKey: "runtime-choice" },
    };
    const context = {
      originalRequest: HELLO_REQUEST,
      acceptedRecommendations: {
        "runtime-choice": { value: "Use Node.js for the command-line implementation.", acceptanceMode: "blank-interactive" as const },
      },
      runId: "accepted-recommendation-run",
      generatedAt: "2026-08-28T12:00:00.000Z",
    };
    const accepted = resolveInitProject(semantic, context);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(validate(accepted.value).valid).toBe(true);

    const tampered = structuredClone(semantic);
    tampered.determinations[0].statement = "Use a different unpresented architecture.";
    expect(resolveInitProject(tampered, context).ok).toBe(false);
  });

  it("verifies supplied user answers and rejects missing or mismatched references", () => {
    const accepted = structuredClone(HELLO_SEMANTIC_FIXTURE) as any;
    accepted.determinations[0].source = { kind: "user-answer", questionKey: "runtime-choice" };
    expect(resolveInitProject(accepted, {
      originalRequest: HELLO_REQUEST,
      answers: { "runtime-choice": "Node.js" },
      runId: "answer-run",
      generatedAt: "2026-08-28T12:00:00.000Z",
    }).ok).toBe(true);

    for (const answers of [{}, { "other-choice": "Node.js" }] as ReadonlyArray<Readonly<Record<string, string>>>) {
      expect(resolveInitProject(accepted, {
        originalRequest: HELLO_REQUEST,
        answers,
        runId: "answer-run",
        generatedAt: "2026-08-28T12:00:00.000Z",
      }).ok).toBe(false);
    }
  });

  it("cannot promote a protected path through trivial incidental request evidence", () => {
    const semantic = structuredClone(HELLO_SEMANTIC_FIXTURE) as any;
    semantic.protectedPaths.push({ path: "vendor/generated", reason: "Suggested preservation", source: { kind: "request", evidence: "a" } });
    const result = resolveInitProject(semantic, {
      originalRequest: HELLO_REQUEST,
      runId: "trivial-evidence-run",
      generatedAt: "2026-08-28T12:00:00.000Z",
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.findings.map((entry) => entry.invariant)).toContain("I-17");
  });

  it.each([
    ["RIGID", "product", false],
    ["RIGID", "architecture", false],
    ["RIGID", "implementation", true],
    ["FLEXIBLE", "product", true],
  ] as const)("applies default authority policy for %s %s", (rigidity, materiality, expected) => {
    const model = structuredClone(hello()) as any;
    const determination = model.core.determinations.find((entry: any) => entry.key === "minimal-layout");
    determination.rigidity = rigidity;
    determination.materiality = materiality;
    expect(validate(model).valid).toBe(expected);
  });

  it("throws when ExecutionDocument derivation sees an impossible unresolved command", () => {
    const model = structuredClone(hello()) as any;
    model.phases[0].tasks[0].validation = [{ kind: "command", commandKey: "missing-command" }];
    expect(() => deriveExecutionDocument(model)).toThrow("Invariant I-11 violated");
  });

  it("does not promote a model-suggested protected path to hard authority", () => {
    const semantic = structuredClone(HELLO_SEMANTIC_FIXTURE) as any;
    semantic.protectedPaths.push({
      path: "vendor/generated",
      reason: "Suggested preservation",
      source: { kind: "model-default" },
    });
    const result = resolveInitProject(semantic, {
      originalRequest: HELLO_REQUEST,
      runId: "protected-run",
      generatedAt: "2026-08-28T12:00:00.000Z",
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.findings.map((entry) => entry.invariant)).toContain("I-17");
  });
});
