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
      "AC-T001-01: Running the version command exits with code 0 and prints `0.1.0`.",
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

  it("rejects prose-only and project-wide task scopes", async () => {
    const source = await fixture("valid", "minimal");
    const prose = validateExecutionMarkdown(source.replace("`src/`, `tests/`", "the affected feature"));
    expect(prose.issues.map((entry) => entry.code)).toContain("task.scope.ambiguous");
    const projectWide = validateExecutionMarkdown(source.replace("`src/`, `tests/`", "`**/*`"));
    expect(projectWide.issues.map((entry) => entry.code)).toContain("task.scope.ambiguous");
  });

  it("rejects acceptance criteria that delegate meaning to a requirement ID", async () => {
    const source = (await fixture("valid", "minimal")).replace(
      "Running the version command exits with code 0 and prints `0.1.0`.",
      "The foundation exposes the behavior required by RF-001.",
    );
    const result = validateExecutionMarkdown(source);
    expect(result.issues.map((entry) => entry.code)).toContain("task.acceptance.ambiguous");
  });

  it("rejects vague acceptance language without an observable boundary", async () => {
    const source = (await fixture("valid", "minimal")).replace(
      "Running the version command exits with code 0 and prints `0.1.0`.",
      "The command handles errors appropriately when possible.",
    );
    const result = validateExecutionMarkdown(source);
    expect(result.issues.map((entry) => entry.code)).toContain("task.acceptance.ambiguous");
  });

  it("rejects vague acceptance language in Portuguese", async () => {
    const source = (await fixture("valid", "minimal")).replace(
      "Running the version command exits with code 0 and prints `0.1.0`.",
      "O comando trata os erros adequadamente quando possível.",
    );
    const result = validateExecutionMarkdown(source);
    expect(result.issues.map((entry) => entry.code)).toContain("task.acceptance.ambiguous");
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
    expect(parseValidationInstruction("human: confirm behavior on the target hardware")).toEqual({
      kind: "human",
      value: "confirm behavior on the target hardware",
    });
  });

  it("rejects ambiguous validation prose", async () => {
    const source = (await fixture("valid", "minimal")).replace("`npm test`", "run the tests");
    const result = validateExecutionMarkdown(source);
    expect(result.issues.map((entry) => entry.code)).toContain("task.validation.format");
  });

  it("rejects executable work disguised as manual validation", async () => {
    const source = (await fixture("valid", "minimal")).replace(
      "`npm test`",
      "manual: execute all quality gates and the operational scenario",
    );
    const result = validateExecutionMarkdown(source);
    expect(result.issues.map((entry) => entry.code)).toContain("task.validation.ambiguous");
  });

  it("rejects a normal task that depends on future operational-audit evidence", async () => {
    const source = (await fixture("valid", "minimal")).replace(
      "Running the version command exits with code 0 and prints `0.1.0`.",
      "The scenario in `OPERATIONS.json` passes in a clean-room environment.",
    );
    const result = validateExecutionMarkdown(source);
    expect(result.issues.map((entry) => entry.code)).toContain("task.acceptance.ambiguous");
  });

  it("rejects failure-masking validation commands", async () => {
    const source = (await fixture("valid", "minimal")).replace(
      "`npm test`",
      "`npm test || true`",
    );
    const result = validateExecutionMarkdown(source);
    expect(result.issues.map((entry) => entry.code)).toContain("task.validation.ambiguous");
  });
});

/**
 * Both defects come from one real plan that `contract validate` had approved:
 * T044 declared `npm start` as the validation for the task that made
 * `npm start` work, and T052 wrapped a manager inspection in backticks. The
 * grammar was correct in both cases; the commands could not do their job.
 */
describe("a validation command must be able to pass", () => {
  const withValidation = (source: string, validation: string) =>
    source.replace("    - `npm test`", `    - ${validation}`);

  it("rejects a service command that never exits", async () => {
    const source = await fixture("valid", "minimal");
    for (const command of [
      "`npm start`", "`npm run dev`", "`yarn serve`", "`pnpm run watch`",
      "`vite`", "`nodemon src/index.js`", "`uvicorn app:main`",
      "`npm test -- --watch`", "`tsc -w`",
    ]) {
      const result = validateExecutionMarkdown(withValidation(source, command));
      const issue = result.issues.find((entry) => entry.code === "task.validation.ambiguous");
      expect(issue?.message, command).toContain("never exits");
    }
  });

  it("accepts the one-shot commands a phase really runs", async () => {
    const source = await fixture("valid", "minimal");
    for (const command of [
      "`npm test`", "`npm run build`", "`npm run lint`", "`npm test -- src/server/app`",
      "`cargo test`", "`go test ./...`", "`docker compose up --abort-on-container-exit`",
      "`npm run start:check`", "`./scripts/serve-once.sh`",
    ]) {
      const result = validateExecutionMarkdown(withValidation(source, command));
      expect(result.issues.filter((entry) => entry.code === "task.validation.ambiguous"), command).toEqual([]);
    }
  });

  it("rejects manager prose wrapped in backticks", async () => {
    const source = await fixture("valid", "minimal");
    const result = validateExecutionMarkdown(
      withValidation(source, "`manual: inspecionar .rb/init/OPERATIONS.json em busca das chaves contract e scenarios`"),
    );
    const issue = result.issues.find((entry) => entry.code === "task.validation.ambiguous");
    expect(issue?.message).toContain("prose written as a command");
    expect(issue?.message).toContain("manual: ...");
  });

  it("rejects human prose wrapped in backticks and names the right form", async () => {
    const source = await fixture("valid", "minimal");
    const result = validateExecutionMarkdown(withValidation(source, "`human: confirmar o layout num monitor 4K`"));
    const issue = result.issues.find((entry) => entry.code === "task.validation.ambiguous");
    expect(issue?.message).toContain("human: ...");
    expect(issue?.message).toContain("external evidence");
  });

  it("still accepts the declared manual and human forms", async () => {
    const source = await fixture("valid", "minimal");
    for (const validation of [
      "manual: inspecionar o contrato operacional publicado",
      "human: confirmar o layout num monitor 4K",
    ]) {
      const result = validateExecutionMarkdown(withValidation(source, validation));
      expect(result.issues.filter((entry) => entry.code === "task.validation.ambiguous"), validation).toEqual([]);
    }
  });
});
