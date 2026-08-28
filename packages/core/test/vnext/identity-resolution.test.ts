import { describe, expect, it } from "vitest";
import type { SemanticInitProject } from "../../src/vnext/ir.js";
import { resolveInitProject } from "../../src/vnext/resolve.js";
import { canonicalize } from "../../src/vnext/validate.js";
import { HELLO_REQUEST, HELLO_SEMANTIC_FIXTURE } from "./fixtures/hello.js";

const context = {
  originalRequest: HELLO_REQUEST,
  runId: "hello-run",
  generatedAt: "2026-08-28T12:00:00.000Z",
} as const;

function clone(): SemanticInitProject {
  return structuredClone(HELLO_SEMANTIC_FIXTURE);
}

describe("vNext deterministic identity and symbolic resolution", () => {
  it("constructs all machine identity in Core with globally ascending task IDs", () => {
    const result = resolveInitProject(clone(), context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.core.identity.id).toBe("hello");
    expect(result.value.requirements.map((entry) => entry.id)).toEqual(["R-001", "R-002", "R-003", "R-004"]);
    expect(result.value.phases.map((entry) => entry.id)).toEqual(["P01"]);
    expect(result.value.phases.flatMap((phase) => phase.tasks.map((task) => task.id))).toEqual(["T001", "T002"]);
    expect(result.value.phases[0]?.tasks.flatMap((task) => task.acceptance.map((entry) => entry.id))).toEqual([
      "AC-T001-01", "AC-T002-01", "AC-T002-02", "AC-T002-03",
    ]);
  });

  it("keeps the semantic fixture free of machine identity and artifact authority", () => {
    const source = JSON.stringify(HELLO_SEMANTIC_FIXTURE);
    expect(source).not.toMatch(/\b(?:R-[0-9]{3}|P[0-9]{2}|T[0-9]{3}|AC-T[0-9]{3}-[0-9]{2})\b/);
    expect(source).not.toMatch(/hello-(?:execution|brief)|\.rb\/|[a-f0-9]{64}|\d{4}-\d{2}-\d{2}T/);
    expect(source).not.toMatch(/"(?:id|parallelSafe|generatedAt|sha256)"\s*:/);
  });

  it("uses declaration order as the stable topological tie-breaker", () => {
    const input = clone() as SemanticInitProject & { phases: SemanticInitProject["phases"] };
    const independent = {
      key: "document-usage",
      title: "Document command usage",
      goal: "Users understand the two greeting forms.",
      dependsOn: [],
      tasks: [{
        key: "write-readme",
        title: "Write usage documentation",
        intent: "Document named and default command invocation.",
        dependsOn: [],
        ownedPaths: ["README.md"],
        covers: ["ship-cli"],
        acceptance: ["README examples state both supported command invocations."],
        validation: [{ kind: "command" as const, commandKey: "run-tests" }],
        expectedEvidence: "README usage examples and passing tests.",
      }],
    };
    const variant = { ...input, phases: [independent, ...input.phases] };
    const first = resolveInitProject(variant, context);
    const second = resolveInitProject(structuredClone(variant), context);
    expect(first).toEqual(second);
    expect(first.ok && first.value.phases.map((phase) => [phase.key, phase.id])).toEqual([
      ["document-usage", "P01"], ["deliver-cli", "P02"],
    ]);
    expect(first.ok && first.value.phases.flatMap((phase) => phase.tasks.map((task) => task.id))).toEqual(["T001", "T002", "T003"]);
  });

  it("resolves valid dependencies and rejects unresolved references", () => {
    expect(resolveInitProject(clone(), context).ok).toBe(true);
    const input = clone() as any;
    input.phases[0].tasks[1].dependsOn = ["missing-task"];
    const result = resolveInitProject(input, context);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.findings.map((entry) => entry.invariant)).toContain("I-02");
  });

  it("rejects phase cycles, task cycles, and dependencies into later phases", () => {
    const phaseCycle = clone() as any;
    const secondPhase = structuredClone(phaseCycle.phases[0]);
    secondPhase.key = "second-phase";
    secondPhase.tasks = [];
    phaseCycle.phases[0].dependsOn = ["second-phase"];
    secondPhase.dependsOn = ["deliver-cli"];
    phaseCycle.phases.push(secondPhase);
    const phaseResult = resolveInitProject(phaseCycle, context);
    expect(!phaseResult.ok && phaseResult.findings.map((entry) => entry.invariant)).toContain("I-04");

    const taskCycle = clone() as any;
    taskCycle.phases[0].tasks[0].dependsOn = ["verify-greetings"];
    const taskResult = resolveInitProject(taskCycle, context);
    expect(!taskResult.ok && taskResult.findings.map((entry) => entry.invariant)).toContain("I-04");

    const forward = clone() as any;
    const later = {
      key: "later-phase", title: "Later", goal: "Later work exists.", dependsOn: ["deliver-cli"],
      tasks: [{
        key: "later-task", title: "Later task", intent: "Perform later work.", dependsOn: [],
        ownedPaths: ["later.js"], covers: ["automated-coverage"], acceptance: ["The later source file exists."],
        validation: [{ kind: "command", commandKey: "run-tests" }], expectedEvidence: "Later source and test output.",
      }],
    };
    forward.phases.push(later);
    forward.phases[0].tasks[0].dependsOn = ["later-task"];
    const forwardResult = resolveInitProject(forward, context);
    expect(!forwardResult.ok && forwardResult.findings.map((entry) => entry.invariant)).toContain("I-05");
  });

  it("canonicalizes idempotently and normalizes platform separators deterministically", () => {
    const result = resolveInitProject(clone(), context);
    if (!result.ok) throw new Error("fixture did not resolve");
    const platformVariant = structuredClone(result.value) as any;
    platformVariant.phases[0].tasks[0].ownedPaths = ["src\\greet.js", "package.json", "src/greet.js", "bin\\hello.js"];
    const once = canonicalize(platformVariant);
    const twice = canonicalize(once);
    expect(twice).toEqual(once);
    expect(once.phases[0]?.tasks[0]?.ownedPaths).toEqual(["bin/hello.js", "package.json", "src/greet.js"]);
  });
});
