import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { generationContractDigest, interviewContractDigest, repairContractDigest } from "../src/harness-contract-digest.js";
import { HARNESS_BUDGET } from "../src/harness-budget.js";
import { DOCUMENT_PART_BEGIN, DOCUMENT_PART_END, parseDocumentPart } from "../src/harness-incremental-documents.js";
import { assessDecomposition } from "../src/harness-granularity.js";
import { validateExecutionMarkdown } from "../src/execution-contract.js";
import {
  DocumentSubstanceError,
  normalizeGeneratedDocumentContent,
  normalizeGeneratedDocumentPath,
  stripEnclosingCodeFence,
} from "../src/harness-documents.js";
import {
  assertRepairPreservedDocument,
  buildDocumentPartPrompt,
  buildGenerationPrompt,
  buildRepairPrompt,
} from "../src/harness-generator.js";
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

/**
 * Root cause of the observed cron2 run: the part writer returned the whole
 * `OPERATIONS.json` wrapped in a ```json fence, the fence was published inside
 * the file, the operational contract failed, and the single structural repair
 * it forced then truncated `PHASES.md`. One habitual formatting slip took down
 * the whole tree.
 */
describe("a code fence around the whole document never reaches the file", () => {
  it("strips the wrapper the observed run published into OPERATIONS.json", () => {
    const wrapped = '```json\n{\n  "contract": "rb-operational/v1",\n  "scenarios": []\n}\n```\n';
    const content = normalizeGeneratedDocumentContent(wrapped, ".rb/init/OPERATIONS.json");
    expect(() => JSON.parse(content)).not.toThrow();
    expect(content.split("\n")[0]).toBe("{");
  });

  it("keeps a document that legitimately contains fenced code blocks", () => {
    const document = "# Operations\n\nRun it:\n\n```bash\nnpm test\n```\n\nDone.\n";
    expect(stripEnclosingCodeFence(document)).toBe(document);
  });

  it("refuses to strip when an interior fence is at least as long as the wrapper", () => {
    const ambiguous = "```\n# Title\n```\nnpm test\n```\n```\n";
    expect(stripEnclosingCodeFence(ambiguous)).toBe(ambiguous);
  });

  it("strips a longer wrapper around interior fences", () => {
    const wrapped = "````markdown\n# Title\n\n```bash\nnpm test\n```\n````\n";
    expect(stripEnclosingCodeFence(wrapped)).toBe("# Title\n\n```bash\nnpm test\n```\n");
  });

  it("leaves an unwrapped document byte for byte", () => {
    expect(stripEnclosingCodeFence(PLAN)).toBe(PLAN);
  });
});

/**
 * Observed: `document part .rb/init/REQUIREMENTS.md#requirements-rigid formatter
 * could not satisfy the contract after 3 attempts: … exceeds 12288 bytes`.
 *
 * Length is substance. The formatter may only change representation, so it
 * could not shorten anything and all three paid attempts failed identically —
 * the same shape as the AGENTS.md path defect above.
 */
describe("an oversized segment is re-authored, not re-formatted", () => {
  it("classifies the size defect as substance", () => {
    const oversized = {
      contract: "rb-harness-document-part/v1",
      path: ".rb/init/REQUIREMENTS.md",
      part: "requirements-rigid",
      content: "x".repeat(HARNESS_BUDGET.documents.maxPartBytes + 1),
    };
    const envelope = `${DOCUMENT_PART_BEGIN}\n${JSON.stringify(oversized)}\n${DOCUMENT_PART_END}`;
    const expected = { path: ".rb/init/REQUIREMENTS.md", part: "requirements-rigid" };
    expect(() => parseDocumentPart(envelope, expected)).toThrow(DocumentSubstanceError);
    expect(() => parseDocumentPart(envelope, expected))
      .toThrow(new RegExp(`above the ${HARNESS_BUDGET.documents.maxPartBytes}-byte limit`));
  });

  it("tells the writer exactly what to shorten on the retry", () => {
    const state = { workflow: "init", request: "Create the project." } as HarnessRunState;
    const plan = {
      contract: "rb-harness-document-plan/v1" as const,
      status: "complete" as const,
      summary: "s",
      coordination: "c",
      documents: [{ path: ".rb/init/REQUIREMENTS.md", purpose: "Requirements", parts: [{ id: "requirements-rigid", purpose: "RIGID section" }] }],
      blocked: [],
    };
    const defect = "document part .rb/init/REQUIREMENTS.md#requirements-rigid is 13000 bytes, above the 12288-byte limit for one segment";
    const prompt = buildDocumentPartPrompt(
      "prefix", plan, plan.documents[0]!, plan.documents[0]!.parts[0]!, 0, 0, undefined, undefined, defect,
    );
    expect(prompt).toContain(defect);
    expect(prompt).toContain("Author the same span again and make it fit");
    expect(prompt).toContain("Keep every RIGID fact");
    // Without a defect the prompt stays byte-stable for prefix caching.
    expect(buildDocumentPartPrompt("prefix", plan, plan.documents[0]!, plan.documents[0]!.parts[0]!, 0, 0))
      .not.toContain("was rejected");
  });
});

/**
 * Observed: `structural repair did not converge:
 * execution.task.covers-too-many-requirements … Task T002 carries 4`.
 *
 * The gate was right and the repair still could not land it, because splitting
 * a task renumbers every later T### and the `Depends on` fields that point at
 * them. A message that says only "split it" invites an in-place edit that fails
 * the same gate again.
 */
describe("a decomposition finding explains how to land the split", () => {
  it("names the renumbering a split forces", () => {
    // A lone task scoping whole areas while proving substantial work.
    const source = PLAN
      .replace("  - **Scope:** `src/thing.ts`", "  - **Scope:** `src/`, `tests/`")
      .replace(
        "    - AC-T001-01: The operation returns status 200 and stores one record.",
        [
          "    - AC-T001-01: The operation returns status 200 and stores one record.",
          "    - AC-T001-02: An unknown identifier returns status 404.",
          "    - AC-T001-03: A malformed body returns status 422.",
          "    - AC-T001-04: A duplicate request stores exactly one record.",
        ].join("\n"),
      );
    const issues = assessDecomposition(validateExecutionMarkdown(source).document!);
    const finding = issues.find((entry) => entry.code === "execution.phase.undecomposed-feature");
    expect(finding?.message).toContain("one global ascending sequence");
    expect(finding?.message).toContain("Re-emit the whole document");
    expect(finding?.message).toContain("covered by exactly one");
  });
});

describe("the interview asks in the developer's language", () => {
  it("fixes the language and forbids drift between rounds", () => {
    for (const workflow of ["init", "plan", "evolve"] as const) {
      const digest = interviewContractDigest(workflow);
      expect(digest, workflow).toContain("same language the developer used");
      expect(digest, workflow).toContain("must not drift between rounds");
      expect(digest, workflow).toContain("Keep IDs, disposition words, and machine field names in English");
    }
    // The digest stays round-independent so it can sit in the cached prefix.
    expect(interviewContractDigest("plan")).toBe(interviewContractDigest("plan"));
  });
});

/**
 * Observed on a second run, after the rewrite allowance landed: the rewrite
 * happened (a `-rewrite.log` exists) and still came back at 12941 bytes, and the
 * flow then spent three formatter attempts on it anyway. A rewrite that is still
 * oversized is a planning defect — the plan gave one part four phases — so the
 * run should say that instead of paying to discover it again.
 */
describe("an oversized part is diagnosed as a planning defect", () => {
  it("plans one part per phase for an execution document", () => {
    const state = { workflow: "init", request: "Create the project." } as HarnessRunState;
    const prompt = buildGenerationPrompt(state, { contract: "rb-harness-input/v1" } as never, "");
    expect(prompt).toContain("one part per phase");
    expect(prompt).toContain("phases-p01-p04");
    expect(prompt).toContain("plan more parts");
  });

  it("tells the rewrite to clear the limit rather than graze it", () => {
    const plan = {
      contract: "rb-harness-document-plan/v1" as const,
      status: "complete" as const,
      summary: "s",
      coordination: "c",
      documents: [{ path: ".rb/init/PHASES.md", purpose: "Plan", parts: [{ id: "phases-p01-p04", purpose: "Phases" }] }],
      blocked: [],
    };
    const prompt = buildDocumentPartPrompt(
      "prefix", plan, plan.documents[0]!, plan.documents[0]!.parts[0]!, 0, 0, undefined, undefined,
      `document part .rb/init/PHASES.md#phases-p01-p04 is 99999 bytes, above the ${HARNESS_BUDGET.documents.maxPartBytes}-byte limit for one segment`,
    );
    expect(prompt).toContain("remove clearly more than the overflow rather than trimming to the edge");
    expect(prompt).toContain(`${HARNESS_BUDGET.documents.maxPartBytes} UTF-8 bytes`);
  });
});
