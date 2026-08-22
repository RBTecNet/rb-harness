import { describe, expect, it } from "vitest";
import { validateResponsiveInventoryJson } from "../src/responsive-inventory.js";

function validInventory(): Record<string, unknown> {
  return {
    contract: "rb-responsive-inventory/v1",
    reviewId: "generic-ui-review",
    depth: "balanced",
    targetRevision: "abc123",
    applicability: "APPLICABLE",
    mechanisms: ["declared-track-child-span"],
    commands: [{
      command: "layout-parser --all first-party-ui",
      purpose: "Extract parent and child layout topology",
      limitations: ["Dynamic runtime composition remains unresolved"],
    }],
    uiFiles: {
      discovered: 1,
      analyzed: 1,
      excluded: 0,
      unresolved: 0,
      entries: [{
        path: "src/views/account-form.ui",
        disposition: "ANALYZED",
        candidateIds: ["RC-TRACK-SPAN-001"],
      }],
    },
    layoutCandidates: {
      discovered: 1,
      analyzed: 1,
      excluded: 0,
      unresolved: 0,
      entries: [{
        id: "RC-TRACK-SPAN-001",
        path: "src/views/account-form.ui",
        mechanism: "declared-track-child-span",
        disposition: "CONFIRMED_DEFECT",
        sourceRefs: [
          { path: "src/views/account-form.ui", line: 10, role: "parent-container" },
          { path: "src/views/account-form.ui", line: 20, role: "owned-child" },
        ],
        invariantsChecked: ["child placement does not exceed active parent tracks"],
        layoutStates: [{
          name: "base",
          parentConstraint: "one declared track",
          childRequirement: "two-track span",
          relationship: "child creates an implicit track",
          assessment: "INCOMPATIBLE",
        }],
        rationale: "The statically active child span exceeds the statically active parent track count.",
        findingIds: ["RV-DESIGN-001"],
      }],
    },
  };
}

describe("responsive inventory contract", () => {
  it("accepts individually disposed parent-child topology evidence", () => {
    const result = validateResponsiveInventoryJson(JSON.stringify(validInventory()));
    expect(result.valid).toBe(true);
    expect(result.document?.contract).toBe("rb-responsive-inventory/v1");
  });

  it("rejects totals that claim analysis without disposed entries", () => {
    const inventory = validInventory();
    (inventory.layoutCandidates as Record<string, unknown>).analyzed = 2;
    (inventory.layoutCandidates as Record<string, unknown>).discovered = 2;
    const result = validateResponsiveInventoryJson(JSON.stringify(inventory));
    expect(result.issues.map((entry) => entry.code)).toContain("responsive.candidates.entries");
  });

  it("rejects an analyzed candidate that is only a path without topology evidence", () => {
    const inventory = validInventory();
    const candidates = inventory.layoutCandidates as { entries: Array<Record<string, unknown>> };
    delete candidates.entries[0]!.layoutStates;
    delete candidates.entries[0]!.sourceRefs;
    const result = validateResponsiveInventoryJson(JSON.stringify(inventory));
    expect(result.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "responsive.candidates.entries[0].sourceRefs",
      "responsive.candidates.entries[0].layoutStates",
    ]));
  });

  it("requires unresolved candidates to explain their evidence gap", () => {
    const inventory = validInventory();
    const section = inventory.layoutCandidates as Record<string, unknown>;
    const candidate = (section.entries as Array<Record<string, unknown>>)[0]!;
    candidate.disposition = "UNKNOWN";
    delete candidate.findingIds;
    delete candidate.layoutStates;
    section.analyzed = 0;
    section.unresolved = 1;
    const result = validateResponsiveInventoryJson(JSON.stringify(inventory));
    expect(result.issues.map((entry) => entry.code)).toContain("responsive.candidates.entries[0].limitations");
  });

  it("allows an explicitly non-UI review without fake responsive counts", () => {
    const result = validateResponsiveInventoryJson(JSON.stringify({
      contract: "rb-responsive-inventory/v1",
      reviewId: "service-review",
      depth: "deep",
      targetRevision: "def456",
      applicability: "NOT_APPLICABLE",
      reason: "The target exposes no user interface or layout surface.",
    }));
    expect(result.valid).toBe(true);
  });
});
