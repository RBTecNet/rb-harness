import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HARNESS_BUDGET } from "../src/harness-budget.js";
import { validateExecutionMarkdown } from "../src/execution-contract.js";
import { assessDecomposition, coveredRequirementIds, scopePathTokens } from "../src/harness-granularity.js";
import { validateStagedTree } from "../src/harness-workspace.js";
import { verifyArtifacts } from "../src/artifact-verifier.js";
import { initializeProject } from "../src/manifest.js";

interface TaskShape {
  id: string;
  covers?: string;
  scope?: string;
  criteria?: number;
}

function task({ id, covers = "RF-001", scope = "`src/thing.ts`, `tests/thing.test.ts`", criteria = 1 }: TaskShape): string {
  const acceptance = Array.from({ length: criteria }, (_value, index) =>
    `    - AC-${id}-${String(index + 1).padStart(2, "0")}: Calling the documented operation returns status 200 and stores exactly one record.`)
    .join("\n");
  return [
    `- [ ] ${id} — Implement one bounded behavior`,
    `  - **Scope:** ${scope}`,
    "  - **Change:** Implement the bounded behavior without touching unrelated code.",
    `  - **Covers:** ${covers}`,
    "  - **Depends on:** none",
    "  - **Parallel safe:** false",
    "  - **Acceptance criteria:**",
    acceptance,
    "  - **Validation:**",
    "    - `npm test`",
    "  - **Expected evidence:** Source changes, regression tests, and passing validation output.",
  ].join("\n");
}

function plan(tasks: string[], artifactId = "init-execution"): string {
  return [
    "# RB Execution Plan: decomposition",
    "",
    "<!-- rb-execution-contract: rb-execution/v1 -->",
    `<!-- rb-artifact-id: ${artifactId} -->`,
    "",
    "## Phase 1: Deliver one observable outcome",
    "",
    "**Phase ID:** P01",
    "**Goal:** Expose the documented behavior through the public interface.",
    "**Depends on:** none",
    "**Context:**",
    "- `.rb/init/PROJECT.md`",
    "",
    tasks.join("\n\n"),
    "",
  ].join("\n");
}

function document(source: string) {
  const validation = validateExecutionMarkdown(source);
  expect(validation.issues.filter((issue) => issue.severity === "error")).toEqual([]);
  return validation.document!;
}

describe("task decomposition gate", () => {
  it("accepts a plan whose tasks are each one bounded change", () => {
    const source = plan([task({ id: "T001" }), task({ id: "T002", covers: "RF-002" })]);
    expect(assessDecomposition(document(source))).toEqual([]);
  });

  it("rejects a task that carries a whole feature's requirements", () => {
    const covers = Array.from(
      { length: HARNESS_BUDGET.decomposition.maxCoveredRequirements + 1 },
      (_value, index) => `RF-00${index + 1}`,
    ).join(", ");
    const issues = assessDecomposition(document(plan([task({ id: "T001", covers }), task({ id: "T002", covers: "RF-009" })])));
    expect(issues.map((issue) => issue.code)).toContain("execution.task.covers-too-many-requirements");
    expect(issues[0]?.message).toContain("T001");
  });

  it("rejects a task with more acceptance criteria than one bounded change proves", () => {
    const issues = assessDecomposition(document(plan([
      task({ id: "T001", criteria: HARNESS_BUDGET.decomposition.maxAcceptanceCriteria + 1 }),
      task({ id: "T002", covers: "RF-002" }),
    ])));
    expect(issues.map((issue) => issue.code)).toContain("execution.task.too-many-acceptance-criteria");
  });

  it("rejects a task whose scope spans more paths than the impact proof allows", () => {
    const scope = Array.from(
      { length: HARNESS_BUDGET.decomposition.maxScopePaths + 1 },
      (_value, index) => `\`src/module-${index}.ts\``,
    ).join(", ");
    const issues = assessDecomposition(document(plan([task({ id: "T001", scope }), task({ id: "T002", covers: "RF-002" })])));
    expect(issues.map((issue) => issue.code)).toContain("execution.task.scope-too-broad");
  });

  it("rejects a phase that never decomposed its feature", () => {
    const covers = Array.from(
      { length: HARNESS_BUDGET.decomposition.maxSingleTaskPhaseRequirements + 1 },
      (_value, index) => `RF-00${index + 1}`,
    ).join(", ");
    const issues = assessDecomposition(document(plan([task({ id: "T001", covers })])));
    expect(issues.map((issue) => issue.code)).toContain("execution.phase.undecomposed-feature");
  });

  it("rejects a phase that is no longer one observable outcome", () => {
    const tasks = Array.from(
      { length: HARNESS_BUDGET.decomposition.maxTasksPerPhase + 1 },
      (_value, index) => task({ id: `T${String(index + 1).padStart(3, "0")}`, covers: `RF-${String(index + 1).padStart(3, "0")}` }),
    );
    const issues = assessDecomposition(document(plan(tasks)));
    expect(issues.map((issue) => issue.code)).toContain("execution.phase.too-many-tasks");
  });

  it("reads only what the document itself declares", () => {
    const source = plan([task({ id: "T001", covers: "RF-001, RNF-002 and UI-003", scope: "`src/a.ts`, `src/b.ts`" })]);
    const only = document(source).phases[0]!.tasks[0]!;
    expect(coveredRequirementIds(only)).toEqual(["RF-001", "RNF-002", "UI-003"]);
    expect(scopePathTokens(only)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

async function stagedProject(source: string): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "rb-harness-decomposition-"));
  await initializeProject(root, "Decomposition fixture");
  await mkdir(resolve(root, ".rb/init"), { recursive: true });
  await writeFile(resolve(root, ".rb/init/PHASES.md"), source, "utf8");
  await writeFile(
    resolve(root, ".rb/init/PROJECT.md"),
    "# PROJECT\n\n<!-- generated-by: rb-harness; schema: rb-artifact/v1 -->\n\nIntent.\n",
    "utf8",
  );
  return root;
}

describe("the decomposition gate reaches both boundaries", () => {
  it("fails staged validation with a repairable structural error", async () => {
    const covers = Array.from(
      { length: HARNESS_BUDGET.decomposition.maxCoveredRequirements + 1 },
      (_value, index) => `RF-00${index + 1}`,
    ).join(", ");
    const staging = await stagedProject(plan([task({ id: "T001", covers }), task({ id: "T002", covers: "RF-009" })]));
    const validation = await validateStagedTree(staging, "init");
    expect(validation.valid).toBe(false);
    expect(validation.repairable).toBe(true);
    const error = validation.errors.find((entry) => entry.code === "execution.task.covers-too-many-requirements");
    expect(error?.path).toBe(".rb/init/PHASES.md");
  });

  it("passes staged validation when every task is bounded", async () => {
    const staging = await stagedProject(plan([task({ id: "T001" }), task({ id: "T002", covers: "RF-002" })]));
    const validation = await validateStagedTree(staging, "init");
    expect(validation.errors.filter((entry) => entry.code.startsWith("execution."))).toEqual([]);
  });

  it("blocks artifact verification before RB Ralph is ever started", async () => {
    const covers = Array.from(
      { length: HARNESS_BUDGET.decomposition.maxCoveredRequirements + 1 },
      (_value, index) => `RF-00${index + 1}`,
    ).join(", ");
    const project = await stagedProject(plan([task({ id: "T001", covers }), task({ id: "T002", covers: "RF-009" })]));
    // Publishing the manifest is what verification reads; staged validation syncs it.
    await validateStagedTree(project, "init");
    const report = await verifyArtifacts({ projectRoot: project, artifactDirectory: ".rb" });
    const finding = report.findings.find((entry) => entry.category === "decomposition");
    expect(finding?.severity).toBe("blocker");
    expect(finding?.artifact).toBe(".rb/init/PHASES.md");
    expect(report.readyForRalph).toBe(false);
    expect(report.deterministic.checks).toContain("task-decomposition");
  });
});
