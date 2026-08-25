import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { generationContractDigest, repairContractDigest } from "../src/harness-contract-digest.js";
import { DocumentSubstanceError, normalizeGeneratedDocumentPath } from "../src/harness-documents.js";
import { assertRepairPreservedDocument, buildGenerationPrompt, buildRepairPrompt } from "../src/harness-generator.js";
import { buildInputPackage } from "../src/harness-input-package.js";
import { inspectProjectInventory } from "../src/harness-inventory.js";
import type { DocumentBundle } from "../src/harness-documents.js";
import type { HarnessRunState, HarnessWorkflow } from "../src/standalone-types.js";

const WORKFLOWS: HarnessWorkflow[] = ["init", "ai-context", "plan", "evolve", "review"];

/**
 * Observed failure: `document plan formatter could not satisfy the contract
 * after 3 attempts: documents may be written only under .rb/: AGENTS.md`.
 *
 * The digest promised a root `AGENTS.md` for ai-context while the parser
 * rejected any path outside `.rb/`, so a model that obeyed the contract was
 * rejected — then sent three times to a formatter that may only change
 * representation and therefore could never fix a path.
 */
describe("the output contract cannot promise a path the parser rejects", () => {
  it("never offers a document location outside .rb/", () => {
    for (const workflow of WORKFLOWS) {
      const digest = generationContractDigest(workflow);
      expect(digest, workflow).toContain("Write only under `.rb/`");
      expect(digest, workflow).not.toMatch(/root\s+`?AGENTS\.md`?/i);
      // Every path the digest declares as a required output must survive the
      // parser. Paths it names as orchestrator-owned are quoted to forbid them
      // and are deliberately excluded here.
      const outputs = digest.slice(
        digest.indexOf("## Required output set"),
        digest.indexOf("## Owned by the orchestrator"),
      );
      expect(outputs.length, workflow).toBeGreaterThan(0);
      const declared = [...outputs.matchAll(/^- (\S+\.(?:md|json))/gm)].map(([, path]) => path!);
      expect(declared.length, workflow).toBeGreaterThan(0);
      for (const path of declared) {
        if (path.includes("<")) continue;
        expect(() => normalizeGeneratedDocumentPath(path, 0), `${workflow}: ${path}`).not.toThrow();
      }
    }
  });

  it("classifies a forbidden path as substance, not as formatting", () => {
    expect(() => normalizeGeneratedDocumentPath("AGENTS.md", 0)).toThrow(DocumentSubstanceError);
    expect(() => normalizeGeneratedDocumentPath("../escape.md", 0)).toThrow(DocumentSubstanceError);
    expect(() => normalizeGeneratedDocumentPath(".rb/rb-manifest.json", 0)).toThrow(DocumentSubstanceError);
    // A missing path is a malformed response, which the formatter can repair.
    expect(() => normalizeGeneratedDocumentPath(undefined, 0)).not.toThrow(DocumentSubstanceError);
  });

  it("carries the rejected defect into the replanned prompt", async () => {
    const project = await mkdtemp(resolve(tmpdir(), "rb-harness-replan-"));
    await writeFile(resolve(project, "package.json"), '{"name":"fixture"}\n', "utf8");
    const inventory = await inspectProjectInventory(project, ".rb");
    const inputPackage = await buildInputPackage({
      workflow: "ai-context",
      projectRoot: project,
      artifactDirectory: ".rb",
      request: "Document the implemented project.",
      inventory,
    });
    const state = { workflow: "ai-context", request: "Document the implemented project." } as HarnessRunState;
    const defect = "documents may be written only under .rb/: AGENTS.md";
    const first = buildGenerationPrompt(state, inputPackage, "");
    const replanned = buildGenerationPrompt(state, inputPackage, "", defect);
    expect(first).not.toContain(defect);
    expect(replanned).toContain(defect);
    expect(replanned).toContain("Do not repeat it");
  });
});

const PLAN = `# RB Execution Plan: example

<!-- rb-execution-contract: rb-execution/v1 -->
<!-- rb-artifact-id: init-execution -->

## Phase 1: Deliver the behavior

**Phase ID:** P01
**Goal:** Expose the documented behavior.
**Depends on:** none
**Context:**
- \`.rb/init/PROJECT.md\`

- [ ] T001 — Implement the behavior
  - **Scope:** \`src/thing.ts\`
  - **Change:** Implement it.
  - **Covers:** RF-001
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T001-01: The operation returns status 200 and stores one record.
  - **Validation:**
    - \`npm test\`
  - **Expected evidence:** Source changes and passing output.
`;

/**
 * Observed failure: `structural repair did not converge: document.title …
 * document.contract … document.artifact-id … document.phases.empty …`.
 *
 * A repaired document replaces its original in full, so a repair that emitted
 * only the corrected fragment deleted the title, both markers, and every
 * phase. The validators then reported four symptoms instead of the one cause.
 */
describe("a repair cannot silently truncate the document it replaces", () => {
  it("names the truncation instead of reporting its symptoms", () => {
    const fragment = "  - **Change:** Implement it without unrelated changes.\n";
    expect(() => assertRepairPreservedDocument(PLAN, fragment, ".rb/init/PHASES.md"))
      .toThrow(/structural repair truncated \.rb\/init\/PHASES\.md/);
    expect(() => assertRepairPreservedDocument(PLAN, fragment, ".rb/init/PHASES.md"))
      .toThrow(/rb-artifact-id marker init-execution/);
    expect(() => assertRepairPreservedDocument(PLAN, fragment, ".rb/init/PHASES.md"))
      .toThrow(/replaces the original in full/);
  });

  it("accepts a full document whose corrected span changed", () => {
    const repaired = PLAN.replace("Implement it.", "Implement it without unrelated changes.");
    expect(() => assertRepairPreservedDocument(PLAN, repaired, ".rb/init/PHASES.md")).not.toThrow();
  });

  it("rejects a repair that swapped the artifact identity", () => {
    const renamed = PLAN.replace("init-execution", "other-execution");
    expect(() => assertRepairPreservedDocument(PLAN, renamed, ".rb/init/PHASES.md"))
      .toThrow(/rb-artifact-id marker init-execution/);
  });

  it("tells the repair writer that its parts overwrite the whole file", async () => {
    const project = await mkdtemp(resolve(tmpdir(), "rb-harness-repair-prompt-"));
    await mkdir(resolve(project, ".rb"), { recursive: true });
    const state = { workflow: "init", request: "Create the project." } as HarnessRunState;
    const bundle: DocumentBundle = {
      contract: "rb-harness-documents/v1",
      status: "complete",
      summary: "s",
      documents: [{ path: ".rb/init/PHASES.md", content: PLAN }],
      blocked: [],
    };
    const prompt = buildRepairPrompt(
      state,
      bundle,
      [{ code: "task.change.vague", message: "Change is not bounded", path: ".rb/init/PHASES.md" }],
      [".rb/init/PHASES.md"],
    );
    expect(prompt).toContain("rewritten in full from its parts");
    expect(prompt).toContain("not just the fragment that changes");
    expect(repairContractDigest("init")).toContain("replaced in full");
  });
});
