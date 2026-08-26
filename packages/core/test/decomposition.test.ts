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

  /**
   * `Covers` records traceability, not size. Two observed tasks proved it: one
   * added a single `npm run quality` script to `package.json` and legitimately
   * covered seven requirements because the script proves them; another was a
   * one-file frontend flow test covering four. Gating on the count rejected
   * both, and rewarded listing fewer requirements — degrading the coverage the
   * requirement-coverage check depends on.
   */
  it("never judges size by how many requirements a task traces", () => {
    const many = "RF-001, RF-004, RF-005, RNF-001, RNF-004, CT-001, UI-001";
    const qualityGate = task({ id: "T001", covers: many, scope: "`package.json`", criteria: 3 });
    expect(assessDecomposition(document(plan([qualityGate, task({ id: "T002", covers: "RF-002" })])))).toEqual([]);
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

  const substantial = HARNESS_BUDGET.decomposition.undecomposedFeatureCriteria;

  it("rejects a lone area-scoped task that also proves substantial work", () => {
    for (const scope of ["`src/`", "`src/**`", "`src`, `tests`"]) {
      const issues = assessDecomposition(document(plan([task({ id: "T001", scope, criteria: substantial })])));
      expect(issues.map((issue) => issue.code), scope).toContain("execution.phase.undecomposed-feature");
    }
  });

  /**
   * Any two of the three signals describe a perfectly good small phase. The
   * contract's own minimal example is one task scoped to `src/`, `tests/` with
   * a single criterion, and an earlier version of this gate rejected it.
   */
  it("accepts a lone area-scoped task that is genuinely small", () => {
    expect(assessDecomposition(document(plan([
      task({ id: "T001", scope: "`src/`, `tests/`", criteria: substantial - 1 }),
    ])))).toEqual([]);
  });

  it("accepts a lone task that names the files it changes", () => {
    expect(assessDecomposition(document(plan([
      task({ id: "T001", scope: "`src/thing.ts`, `tests/thing.test.ts`", criteria: substantial }),
    ])))).toEqual([]);
  });

  it("accepts a broad area once it is split across tasks", () => {
    expect(assessDecomposition(document(plan([
      task({ id: "T001", scope: "`src/`", criteria: substantial }),
      task({ id: "T002", scope: "`tests/`", covers: "RF-002", criteria: substantial }),
    ])))).toEqual([]);
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
    const criteria = HARNESS_BUDGET.decomposition.maxAcceptanceCriteria + 1;
    const staging = await stagedProject(plan([task({ id: "T001", criteria }), task({ id: "T002", covers: "RF-002" })]));
    const validation = await validateStagedTree(staging, "init");
    expect(validation.valid).toBe(false);
    expect(validation.repairable).toBe(true);
    const error = validation.errors.find((entry) => entry.code === "execution.task.too-many-acceptance-criteria");
    expect(error?.path).toBe(".rb/init/PHASES.md");
  });

  it("passes staged validation when every task is bounded", async () => {
    const staging = await stagedProject(plan([task({ id: "T001" }), task({ id: "T002", covers: "RF-002" })]));
    const validation = await validateStagedTree(staging, "init");
    expect(validation.errors.filter((entry) => entry.code.startsWith("execution."))).toEqual([]);
  });

  it("blocks artifact verification before RB Ralph is ever started", async () => {
    const criteria = HARNESS_BUDGET.decomposition.maxAcceptanceCriteria + 1;
    const project = await stagedProject(plan([task({ id: "T001", criteria }), task({ id: "T002", covers: "RF-002" })]));
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
