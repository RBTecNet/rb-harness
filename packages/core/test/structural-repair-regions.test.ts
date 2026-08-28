import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validateExecutionMarkdown } from "../src/execution-contract.js";
import type { DocumentBundle } from "../src/harness-documents.js";
import {
  DOCUMENT_PART_CONTRACT,
  DOCUMENT_PLAN_CONTRACT,
  type DocumentPart,
  type DocumentPlan,
} from "../src/harness-incremental-documents.js";
import {
  assertImmutableChunks,
  assertStructuralRepairPlanAuthority,
  deriveStructuralRepairRegions,
  spliceStructuralRepairParts,
  type StructuralError,
  type StructuralRepairRegion,
} from "../src/harness-generator.js";

const path = ".rb/init/PHASES.md";
const fixture = resolve(import.meta.dirname, "fixtures/structural-repair/real-failure-phases.md");

function bundle(content: string): DocumentBundle {
  return {
    contract: "rb-harness-documents/v1",
    status: "complete",
    summary: "Structural repair fixture.",
    documents: [{ path, content }],
    blocked: [],
  };
}

function finding(task: string, code = "task.change.vague"): StructuralError {
  return { code, message: `${task} has a deterministic structural defect`, path };
}

function plan(regions: readonly StructuralRepairRegion[], purpose = "Replace only the assigned region."): DocumentPlan {
  return {
    contract: DOCUMENT_PLAN_CONTRACT,
    status: "complete",
    summary: "Apply region-local replacements.",
    coordination: "Code-owned region IDs are authoritative.",
    documents: [{
      path,
      purpose: "Repair bounded task regions.",
      dependsOn: [],
      parts: regions.map((region) => ({ id: region.id, purpose })),
    }],
    blocked: [],
  };
}

function replacement(region: StructuralRepairRegion): DocumentPart {
  return {
    contract: DOCUMENT_PART_CONTRACT,
    path: region.path,
    part: region.id,
    content: region.originalContent.replace(
      `Implement bounded behavior for ${region.anchor.id}.`,
      `Implement repaired, bounded behavior for ${region.anchor.id}.`,
    ),
  };
}

function taskBlock(source: string, taskId: string): string {
  const region = deriveStructuralRepairRegions(bundle(source), [finding(taskId)])[0];
  if (!region) throw new Error(`missing ${taskId}`);
  return region.originalContent;
}

function apply(source: string, errors: StructuralError[]): {
  regions: StructuralRepairRegion[];
  repaired: string;
} {
  const sourceBundle = bundle(source);
  const regions = deriveStructuralRepairRegions(sourceBundle, errors);
  const repairedBundle = spliceStructuralRepairParts(sourceBundle, regions, plan(regions), regions.map(replacement));
  return { regions, repaired: repairedBundle.documents[0]!.content };
}

describe("code-owned structural repair regions", () => {
  it("fails closed when a finding cannot map to a bounded structural anchor", async () => {
    const source = await readFile(fixture, "utf8");
    expect(() => deriveStructuralRepairRegions(bundle(source), [finding("T999")]))
      .toThrow(/does not identify a safely mutable structural region/);
  });

  it("applies one localized task repair", async () => {
    const source = await readFile(fixture, "utf8");
    const { repaired } = apply(source, [finding("T001")]);
    expect(repaired).toContain("Implement repaired, bounded behavior for T001.");
    expect(validateExecutionMarkdown(repaired).valid).toBe(true);
  });

  it("applies multiple disjoint task repairs", async () => {
    const source = await readFile(fixture, "utf8");
    const { regions, repaired } = apply(source, [finding("T001"), finding("T012"), finding("T019")]);
    expect(regions.map((region) => region.anchor.id)).toEqual(["T001", "T012", "T019"]);
    expect(repaired.match(/Implement repaired, bounded behavior/g)).toHaveLength(3);
  });

  it("deduplicates several findings for the same task into one region", async () => {
    const source = await readFile(fixture, "utf8");
    const regions = deriveStructuralRepairRegions(bundle(source), [
      finding("T012", "task.change.vague"),
      finding("T012", "task.acceptance.missing-negative"),
      finding("T012", "task.validation.missing"),
    ]);
    expect(regions).toHaveLength(1);
    expect(regions[0]?.findingIds).toEqual(["finding-001", "finding-002", "finding-003"]);
  });

  it("keeps adjacent task regions independently bounded", async () => {
    const source = await readFile(fixture, "utf8");
    const regions = deriveStructuralRepairRegions(bundle(source), [finding("T018"), finding("T019")]);
    expect(regions).toHaveLength(2);
    expect(regions[0]?.originalContent).not.toContain("T019");
    expect(regions[1]?.originalContent).not.toContain("T018");
    expect(regions[0]!.end).toBeLessThan(regions[1]!.start);
  });

  it("does not let the final task of a phase own the next phase heading", async () => {
    const source = await readFile(fixture, "utf8");
    const region = deriveStructuralRepairRegions(bundle(source), [finding("T007")])[0]!;
    expect(region.originalContent).not.toContain("## Phase 2");
    expect(Buffer.from(source).subarray(region.end).toString("utf8")).toContain("## Phase 2: Preserve phase transitions");
  });

  it("does not let a task own the following sibling task", async () => {
    const source = await readFile(fixture, "utf8");
    const region = deriveStructuralRepairRegions(bundle(source), [finding("T007")])[0]!;
    expect(region.originalContent).not.toContain("T008");
    expect(Buffer.from(source).subarray(region.end).toString("utf8")).toContain("- [ ] T008");
  });

  it("rejects an unknown repair-region ID", async () => {
    const source = await readFile(fixture, "utf8");
    const regions = deriveStructuralRepairRegions(bundle(source), [finding("T001")]);
    const candidate = plan([{ ...regions[0]!, id: "repair-region-999" }]);
    expect(() => assertStructuralRepairPlanAuthority(
      { kind: "plan", plan: candidate }, [path], regions,
    )).toThrow(/unknown repair-region ID.*repair-region-999/);
  });

  it("ignores a model-provided line range as non-authoritative presentation", async () => {
    const source = await readFile(fixture, "utf8");
    const regions = deriveStructuralRepairRegions(bundle(source), [finding("T001")]);
    const rangedPlan = plan(regions, "Replace lines 1-999 and every following phase.");
    const output = spliceStructuralRepairParts(bundle(source), regions, rangedPlan, regions.map(replacement));
    expect(taskBlock(output.documents[0]!.content, "T008")).toBe(taskBlock(source, "T008"));
    expect(output.documents[0]!.content).toContain("## Phase 3: Prove immutable reconstruction");
  });

  it("rejects a full-document response for a region-local replacement", async () => {
    const source = await readFile(fixture, "utf8");
    const regions = deriveStructuralRepairRegions(bundle(source), [finding("T001")]);
    const fullDocument = { ...replacement(regions[0]!), content: source };
    expect(() => spliceStructuralRepairParts(bundle(source), regions, plan(regions), [fullDocument]))
      .toThrow(/complete-document or outside-region content/);
  });

  it("preserves every immutable chunk byte for byte", async () => {
    const source = await readFile(fixture, "utf8");
    const { regions, repaired } = apply(source, [finding("T001"), finding("T012")]);
    expect(() => assertImmutableChunks(source, repaired, regions, path)).not.toThrow();
  });

  it("rejects a malformed replacement during final structural validation", async () => {
    const source = await readFile(fixture, "utf8");
    const regions = deriveStructuralRepairRegions(bundle(source), [finding("T012")]);
    const malformed = {
      ...replacement(regions[0]!),
      content: regions[0]!.originalContent.replace("- [ ] T012", "[ ] T012"),
    };
    expect(() => spliceStructuralRepairParts(bundle(source), regions, plan(regions), [malformed]))
      .toThrow(/invalid execution document/i);
  });
});

describe("persisted real-failure shape", () => {
  it("preserves all phase, context, neighbor, example, and whitespace bytes around six repaired tasks", async () => {
    const source = await readFile(fixture, "utf8");
    const authorized = ["T001", "T004", "T012", "T015", "T018", "T019"];
    const { regions, repaired } = apply(source, authorized.map((task) => finding(task)));
    const before = validateExecutionMarkdown(source);
    const after = validateExecutionMarkdown(repaired);

    expect(before.valid).toBe(true);
    expect(after.valid).toBe(true);
    expect(after.document?.phases).toHaveLength(3);
    expect(after.document?.phases.flatMap((phase) => phase.tasks)).toHaveLength(21);
    expect(source.match(/^## Phase .+$/gm)).toEqual(repaired.match(/^## Phase .+$/gm));

    const phaseContext = (value: string) => value.match(/## Phase [\s\S]*?(?=^- \[[ x]\] T\d{3,} —)/gm);
    expect(phaseContext(repaired)).toEqual(phaseContext(source));
    expect(taskBlock(repaired, "T008")).toBe(taskBlock(source, "T008"));
    expect(taskBlock(repaired, "T008")).toContain("- [ ] T008");
    expect(taskBlock(repaired, "T020")).toBe(taskBlock(source, "T020"));
    expect(taskBlock(repaired, "T020")).toContain('{"mode":"strict","regions":["task"],"preserveBlankLines":true}');
    for (let index = 1; index <= 21; index += 1) {
      const taskId = `T${String(index).padStart(3, "0")}`;
      if (authorized.includes(taskId)) expect(taskBlock(repaired, taskId)).not.toBe(taskBlock(source, taskId));
      else expect(taskBlock(repaired, taskId)).toBe(taskBlock(source, taskId));
    }
    expect(() => assertImmutableChunks(source, repaired, regions, path)).not.toThrow();
    expect(repaired).not.toBe(source);
  });
});
