import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DOCUMENT_PLAN_BEGIN,
  DOCUMENT_PLAN_END,
  parseDocumentPlan,
} from "../src/harness-incremental-documents.js";
import {
  assertRepairPreservedDocument,
  assertStructuralRepairPlanAuthority,
  requestStructuralRepair,
  type StructuralError,
} from "../src/harness-generator.js";
import { finishHarnessTelemetry, startHarnessTelemetry } from "../src/harness-telemetry.js";
import { inspectProjectInventory } from "../src/harness-inventory.js";
import type { DocumentBundle } from "../src/harness-documents.js";
import type { HarnessRunState } from "../src/standalone-types.js";

const fixture = resolve(import.meta.dirname, "fixtures/standalone/structural-repair-plan-provider.mjs");
const controlledEnvironment = [
  "RB_HARNESS_TEST_REPAIR_CALLS",
  "RB_HARNESS_TEST_REPAIR_DEPENDENCY",
  "RB_HARNESS_TEST_REPAIR_ADD_OPERATIONS",
  "RB_HARNESS_TEST_REPAIR_REPRESENTATION",
  "RB_HARNESS_TEST_REPAIR_MALFORMED",
] as const;
const originalEnvironment = Object.fromEntries(controlledEnvironment.map((name) => [name, process.env[name]]));

afterEach(() => {
  finishHarnessTelemetry();
  vi.restoreAllMocks();
  for (const name of controlledEnvironment) {
    const original = originalEnvironment[name];
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
});

const phasePath = ".rb/init/PHASES.md";
const operationsPath = ".rb/init/OPERATIONS.json";

function planValue(dependency = false, addOperations = false, representation = false) {
  const phase: Record<string, unknown> = {
    path: phasePath,
    purpose: "Repair the complete execution plan.",
    dependsOn: dependency ? [operationsPath] : [],
    parts: [{
      id: "whole",
      purpose: "Reproduce the complete corrected document.",
      ...(representation ? { scope: "the complete document" } : {}),
    }],
    ...(representation ? { prefix: "presentation-only" } : {}),
  };
  return {
    contract: "rb-harness-document-plan/v1",
    status: "complete",
    summary: "Apply a localized structural correction.",
    coordination: representation ? { task: "T001", artifact: "structural-repair-execution" } : "T001 only.",
    documents: [
      phase,
      ...(addOperations ? [{
        path: operationsPath,
        purpose: "Add operational acceptance.",
        dependsOn: [phasePath],
        parts: [{ id: "whole", purpose: "Write the complete operational contract." }],
      }] : []),
    ],
    blocked: [],
  };
}

function envelope(value: unknown): string {
  return `${DOCUMENT_PLAN_BEGIN}\n${JSON.stringify(value)}\n${DOCUMENT_PLAN_END}`;
}

const originalPhases = `# RB Execution Plan: Structural repair

<!-- rb-execution-contract: rb-execution/v1 -->
<!-- rb-artifact-id: structural-repair-execution -->

## Phase 1: Build the scope gate

**Phase ID:** P01
**Goal:** Enforce the documented typed scope authority.
**Depends on:** none
**Context:**
- \`.rb/init/PROJECT.md\`

- [ ] T001 — Implement the typed scope gate
  - **Scope:** \`src/\`, \`tests/\`
  - **Change:** Implement it.
  - **Covers:** RF-001
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T001-01: The finite accepted and rejected values produce the documented outcomes.
  - **Validation:**
    - \`npm test\`
  - **Expected evidence:** Positive and negative regression results with exit code 0.
`;

const error: StructuralError = {
  code: "task.change.vague",
  message: "T001 Change is not bounded",
  path: phasePath,
};

async function repairFixture(includeOperations = false) {
  await chmod(fixture, 0o755);
  const project = await mkdtemp(resolve(tmpdir(), "rb-structural-repair-plan-"));
  const runRoot = resolve(project, ".rb-harness/runs/test");
  const calls = resolve(project, "repair-calls.log");
  process.env.RB_HARNESS_TEST_REPAIR_CALLS = calls;
  const inventory = await inspectProjectInventory(project, ".rb");
  const now = new Date().toISOString();
  const state = {
    contract: "rb-harness-run/v1",
    id: "structural-repair-plan-fixture",
    workflow: "init",
    status: "repairing",
    projectRoot: project,
    artifactDirectory: ".rb",
    request: "Repair one deterministic execution-plan defect.",
    requestHash: "fixture",
    provider: { provider: "custom", model: "fixture", effort: "", command: fixture },
    answers: [],
    inventory,
    createdAt: now,
    updatedAt: now,
  } as HarnessRunState;
  const bundle: DocumentBundle = {
    contract: "rb-harness-documents/v1",
    status: "complete",
    summary: "Current-run documents.",
    documents: [
      { path: ".rb/init/PROJECT.md", content: "# Project\n\nRF-001 is authoritative.\n" },
      { path: phasePath, content: originalPhases },
      ...(includeOperations ? [{
        path: operationsPath,
        content: '{"contract":"rb-operational/v1","scenarios":[{"id":"consumer","title":"Consumer","steps":[{"id":"file","kind":"file","path":"src/index.ts","exists":true}]}]}\n',
      }] : []),
    ],
    blocked: [],
  };
  const result = await requestStructuralRepair({
    state,
    bundle,
    errors: [error],
    runRoot,
    evidenceRoot: project,
    timeoutSeconds: 10,
    firstOutputTimeoutSeconds: 5,
  });
  return { calls, project, result };
}

describe("structural repair plan dependency closure", () => {
  it("rejects a missing conditional OPERATIONS.json dependency", () => {
    expect(() => parseDocumentPlan(envelope(planValue(true)), {
      context: "structural-repair",
      availableDocumentPaths: [phasePath],
    })).toThrow(`planned document ${phasePath} depends on missing document ${operationsPath}`);
  });

  it("accepts closure structurally when the same repair plan adds OPERATIONS.json", () => {
    const parsed = parseDocumentPlan(envelope(planValue(true, true)), {
      context: "structural-repair",
      availableDocumentPaths: [phasePath],
    });
    expect(parsed.documents.map((document) => document.path)).toEqual([phasePath, operationsPath]);
  });

  it("does not let a historical OPERATIONS.json satisfy current-run closure", async () => {
    const project = await mkdtemp(resolve(tmpdir(), "rb-repair-historical-operations-"));
    await mkdir(resolve(project, ".rb/init"), { recursive: true });
    await writeFile(resolve(project, operationsPath), '{"contract":"historical"}\n', "utf8");
    expect(() => parseDocumentPlan(envelope(planValue(true)), {
      context: "structural-repair",
      availableDocumentPaths: [phasePath],
    })).toThrow(`depends on missing document ${operationsPath}`);
  });

  it("normalization never invents a semantic missing-dependency fix", () => {
    const represented = `\`\`\`json\n${JSON.stringify(planValue(true, false, true))}\n\`\`\``;
    expect(() => parseDocumentPlan(`${DOCUMENT_PLAN_BEGIN}\n${represented}\n${DOCUMENT_PLAN_END}`, {
      context: "structural-repair",
      availableDocumentPaths: [phasePath],
    })).toThrow(`depends on missing document ${operationsPath}`);
  });

  it("does not grant a new optional document authority merely to close its dependency", () => {
    const parsed = parseDocumentPlan(envelope(planValue(true, true)), {
      context: "structural-repair",
      availableDocumentPaths: [phasePath],
    });
    expect(() => assertStructuralRepairPlanAuthority({ kind: "plan", plan: parsed }, [phasePath]))
      .toThrow(`without current-run repair authority: ${operationsPath}`);
  });
});

describe("structural repair formatter recovery", () => {
  it("stops after one formatter call repeats the rejected repair payload", async () => {
    process.env.RB_HARNESS_TEST_REPAIR_MALFORMED = "1";
    startHarnessTelemetry();
    await expect(repairFixture()).rejects.toThrow(/after 1 attempt:.*repeated identical rejected payload/);
    const telemetry = finishHarnessTelemetry()!;
    expect((await readFile(process.env.RB_HARNESS_TEST_REPAIR_CALLS!, "utf8")).trim().split("\n"))
      .toEqual(["repair-plan", "repair-format"]);
    expect(telemetry.providerCalls.map((call) => call.operation))
      .toEqual(["repair-plan-generation", "repair-plan-formatter"]);
  });

  it("does not send a semantic missing dependency to the formatter", async () => {
    process.env.RB_HARNESS_TEST_REPAIR_DEPENDENCY = "1";
    await expect(repairFixture()).rejects.toThrow(`depends on missing document ${operationsPath}`);
    expect((await readFile(process.env.RB_HARNESS_TEST_REPAIR_CALLS!, "utf8")).trim().split("\n"))
      .toEqual(["repair-plan", "repair-plan"]);
  });

  it("normalizes the observed repair representation with zero formatter calls", async () => {
    process.env.RB_HARNESS_TEST_REPAIR_REPRESENTATION = "1";
    process.env.RB_HARNESS_TEST_REPAIR_DEPENDENCY = "1";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    startHarnessTelemetry();
    const { calls, result } = await repairFixture(true);
    const telemetry = finishHarnessTelemetry()!;
    expect((await readFile(calls, "utf8")).trim().split("\n"))
      .toEqual(["repair-plan", `repair-part:${phasePath}`]);
    expect(result.documents.find((document) => document.path === phasePath)?.content)
      .toContain("declared request field and finite matrix");
    expect(stdout.mock.calls.flat().join(" ")).toContain("repair-plan deterministic normalization");
    expect(stdout.mock.calls.flat().join(" ")).toContain("removed-part-scope");
    expect(telemetry.providerCalls.map((call) => call.operation))
      .toEqual(["repair-plan-generation", undefined]);
  });
});

describe("structural repair preservation", () => {
  it("keeps an existing localized valid repair working", async () => {
    const { result } = await repairFixture();
    expect(result.documents).toHaveLength(2);
    expect(result.documents.find((document) => document.path.endsWith("PROJECT.md"))?.content)
      .toBe("# Project\n\nRF-001 is authoritative.\n");
  });

  it("keeps U5 immutable-region preservation fail-closed", () => {
    const repaired = originalPhases
      .replace("Implement it.", "Enforce RF-001 using the declared request field and finite matrix.")
      .replace("Enforce the documented typed scope authority.", "Redefine unrelated product authority.");
    expect(() => assertRepairPreservedDocument(originalPhases, repaired, phasePath, [error]))
      .toThrow(/changed unrelated semantic content/);
  });
});
