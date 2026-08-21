import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractExecutionPhaseMarkdown,
  extractExecutionTaskMarkdown,
  parseValidationInstruction,
  validateExecutionMarkdown,
} from "../src/execution-contract.js";

const fixtures = resolve(process.cwd(), "../../tests/fixtures/execution");

async function fixture(group: string, name: string): Promise<string> {
  return readFile(resolve(fixtures, group, name, "PHASES.md"), "utf8");
}

describe("rb-execution/v1", () => {
  it("accepts the minimal contract", async () => {
    const result = validateExecutionMarkdown(await fixture("valid", "minimal"));
    expect(result.issues).toEqual([]);
    expect(result.document?.artifactId).toBe("init-minimal-execution");
    expect(result.document?.phases).toHaveLength(1);
    expect(result.document?.phases[0]?.tasks[0]?.acceptanceCriteria).toEqual([
      "AC-T001-01: The foundation exposes the behavior required by RF-001.",
    ]);
  });

  it("accepts ordered dependencies and parallel-safe declarations", async () => {
    const result = validateExecutionMarkdown(await fixture("valid", "multiple"));
    expect(result.valid).toBe(true);
    expect(result.document?.phases).toHaveLength(2);
    expect(result.document?.phases[1]?.dependsOn).toEqual(["P01"]);
    expect(result.document?.phases[1]?.tasks.map((task) => task.parallelSafe)).toEqual([true, true]);
  });

  it("rejects level-2 headings outside the phase grammar", async () => {
    const result = validateExecutionMarkdown(await fixture("invalid", "bad-heading"));
    expect(result.valid).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toContain("document.heading.h2");
  });

  it("rejects tasks without acceptance criteria", async () => {
    const result = validateExecutionMarkdown(await fixture("invalid", "missing-acceptance"));
    expect(result.valid).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toContain("task.acceptance.empty");
  });

  it("rejects a dependency on a future task", async () => {
    const result = validateExecutionMarkdown(await fixture("invalid", "future-dependency"));
    expect(result.valid).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toContain("task.dependency.invalid");
  });

  it("extracts one validated phase with the contract preamble", async () => {
    const source = await fixture("valid", "multiple");
    const extracted = extractExecutionPhaseMarkdown(source, "P02");
    expect(extracted).toContain("<!-- rb-execution-contract: rb-execution/v1 -->");
    expect(extracted).toContain("## Phase 2:");
    expect(extracted).not.toContain("## Phase 1:");
  });

  it("refuses to extract an unknown phase", async () => {
    const source = await fixture("valid", "minimal");
    expect(() => extractExecutionPhaseMarkdown(source, "P99")).toThrow("Unknown phase P99");
  });

  it("extracts one task with phase context and without sibling tasks", async () => {
    const source = await fixture("valid", "multiple");
    const extracted = extractExecutionTaskMarkdown(source, "T003");
    expect(extracted).toContain("## Phase 2:");
    expect(extracted).toContain("- [ ] T003 — Implement consumer B");
    expect(extracted).not.toContain("T002 — Implement consumer A");
    expect(extracted).not.toContain("## Phase 1:");
  });

  it("classifies executable and manual validation instructions", () => {
    expect(parseValidationInstruction("`npm test -- contracts`")).toEqual({
      kind: "command",
      value: "npm test -- contracts",
    });
    expect(parseValidationInstruction("manual: inspect the rendered screen")).toEqual({
      kind: "manual",
      value: "inspect the rendered screen",
    });
  });

  it("rejects ambiguous validation prose", async () => {
    const source = (await fixture("valid", "minimal")).replace("`npm test`", "run the tests");
    const result = validateExecutionMarkdown(source);
    expect(result.issues.map((entry) => entry.code)).toContain("task.validation.format");
  });
});
