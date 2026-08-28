import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyArtifacts } from "../src/artifact-verifier.js";
import { assertGenerationPlanComplete } from "../src/harness-generator.js";
import { validateStagedTree } from "../src/harness-workspace.js";
import { initializeProject, syncManifest } from "../src/manifest.js";
import type { DocumentPlan } from "../src/harness-incremental-documents.js";
import type { HarnessRunState } from "../src/standalone-types.js";

function phases(root: string, id: string, blocked = false): string {
  return `# RB Execution Plan: ${id}

<!-- rb-execution-contract: rb-execution/v1 -->
<!-- rb-artifact-id: ${id}-execution -->
${blocked ? "<!-- rb-readiness: blocked -->\n" : ""}
## Phase 1: Implement the bounded behavior

**Phase ID:** P01
**Goal:** Deliver the documented behavior.
**Depends on:** none
**Context:**
- \`${root}/REQUEST.md\`
- \`${root}/SPEC.md\`
- \`${root}/PLAN.md\`

- [ ] T001 — Implement the bounded behavior
  - **Scope:** \`src/fixture.ts\`, \`test/fixture.test.ts\`
  - **Change:** Implement RF-001 and preserve unrelated behavior.
  - **Covers:** RF-001
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T001-01: The fixture returns the documented value.
  - **Validation:**
    - \`npm test -- test/fixture.test.ts\`
  - **Expected evidence:** Focused test output exits zero.
`;
}

async function root(): Promise<string> {
  const project = await mkdtemp(resolve(tmpdir(), "rb-workflow-scope-"));
  await initializeProject(project, "Workflow scope fixture", "workflow-scope-fixture");
  return project;
}

async function writePlanSet(project: string, slug: string, blocked = false): Promise<string[]> {
  const base = `.rb/features/${slug}`;
  await mkdir(resolve(project, base), { recursive: true });
  const documents: Record<string, string> = {
    "REQUEST.md": "# Request\n\nRF-001 is requested.\n",
    "SPEC.md": "# Specification\n\n## RF-001\n\nThe fixture returns the documented value.\n",
    "PLAN.md": "# Plan\n\nImplement RF-001 with a focused regression.\n",
    "PHASES.md": phases(base, slug, blocked),
    "source-manifest.json": "{\"sources\":[]}\n",
  };
  for (const [name, content] of Object.entries(documents)) await writeFile(resolve(project, base, name), content, "utf8");
  return Object.keys(documents).map((name) => `${base}/${name}`);
}

async function writeInitSet(project: string): Promise<string[]> {
  const base = ".rb/init";
  await mkdir(resolve(project, base), { recursive: true });
  const documents: Record<string, string> = {
    "PROJECT.md": "# Project\n\nThe bounded fixture project.\n",
    "REQUIREMENTS.md": "# Requirements\n\n## RF-001\n\nReturn the documented value.\n",
    "DECISIONS.md": "# Decisions\n\nUse the existing deterministic fixture.\n",
    "PLAN.md": "# Plan\n\nImplement RF-001 with a focused regression.\n",
    "PHASES.md": phases(base, "init-current"),
    "source-manifest.json": "{\"sources\":[]}\n",
  };
  for (const [name, content] of Object.entries(documents)) await writeFile(resolve(project, base, name), content, "utf8");
  return Object.keys(documents).map((name) => `${base}/${name}`);
}

function documentPlan(paths: readonly string[]): DocumentPlan {
  return {
    contract: "rb-harness-document-plan/v1",
    status: "complete",
    summary: "Complete canonical fixture.",
    coordination: "RF-001 is owned by T001.",
    documents: paths.map((path, index) => ({
      path,
      purpose: `Fixture document ${index + 1}.`,
      dependsOn: [],
      parts: [{ id: `part-${index + 1}`, purpose: "Complete bounded fixture." }],
    })),
    blocked: [],
  };
}

function evolvePhases(
  base: string,
  scope = "`src/new.ts`, `test/new.test.ts`",
  change = "Implement CHANGE-001 without modifying preserved paths.",
  covers = "CHANGE-001, PRESERVE-001",
): string {
  return `# RB Execution Plan: evolve fixture

<!-- rb-execution-contract: rb-execution/v1 -->
<!-- rb-artifact-id: evolve-fixture-execution -->

## Phase 1: Evolve the behavior

**Phase ID:** P01
**Goal:** Deliver the accepted delta while preserving protected behavior.
**Depends on:** none
**Context:**
- \`${base}/TO_BE.md\`
- \`${base}/PRESERVATION.md\`
- \`${base}/PLAN.md\`

- [ ] T001 — Apply the accepted delta
  - **Scope:** ${scope}
  - **Change:** ${change}
  - **Covers:** ${covers}
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T001-01: The new operation returns the accepted result and the legacy regression remains green.
  - **Validation:**
    - \`npm test\`
  - **Expected evidence:** Change and preservation regressions exit zero.
`;
}

async function writeEvolveSet(
  project: string,
  slug: string,
  plan: { scope?: string; change?: string; covers?: string; preservation?: string } = {},
): Promise<string[]> {
  const base = `.rb/evolutions/${slug}`;
  await mkdir(resolve(project, base), { recursive: true });
  const documents: Record<string, string> = {
    "CHANGE_REQUEST.md": "# Change request\n\nCHANGE-001 is the accepted delta.\n",
    "AS_IS.md": "# AS IS\n\nThe legacy behavior is observed.\n",
    "TO_BE.md": "# TO BE\n\n## CHANGE-001\n\nThe new operation returns the accepted result.\n",
    "IMPACT.md": "# Impact\n\nThe bounded implementation and regression paths are affected.\n",
    "PRESERVATION.md": plan.preservation
      ?? "# Preservation\n\n| ID | Protected path |\n| --- | --- |\n| PRESERVE-001 | `src/legacy.ts` |\n\nThe legacy behavior remains unchanged.\n",
    "REGRESSION_MATRIX.md": "# Regression matrix\n\nCHANGE-001 and PRESERVE-001 are proven by T001.\n",
    "PLAN.md": "# Plan\n\nImplement CHANGE-001 and prove PRESERVE-001.\n",
    "PHASES.md": evolvePhases(base, plan.scope, plan.change, plan.covers),
    "source-manifest.json": "{\"sources\":[]}\n",
  };
  for (const [name, content] of Object.entries(documents)) await writeFile(resolve(project, base, name), content, "utf8");
  return Object.keys(documents).map((name) => `${base}/${name}`);
}

describe("run-scoped readiness and workflow completeness", () => {
  it("rejects unknown plan and init documents before part authoring", async () => {
    const project = await root();
    const planPaths = await writePlanSet(project, "unknown-plan");
    expect(() => assertGenerationPlanComplete("plan", documentPlan([
      ...planPaths,
      ".rb/features/unknown-plan/TECHNICAL_NOTES.md",
    ]))).toThrow(/non-canonical current-run artifacts.*TECHNICAL_NOTES\.md/);

    const initPaths = await writeInitSet(project);
    expect(() => assertGenerationPlanComplete("init", documentPlan([
      ...initPaths,
      ".rb/init/TECHNICAL_NOTES.md",
    ]))).toThrow(/non-canonical current-run artifacts.*TECHNICAL_NOTES\.md/);
  });

  it("accepts canonical conditional and contracts wildcard artifacts in the generation plan", async () => {
    const project = await root();
    const current = await writePlanSet(project, "canonical-optionals");
    expect(() => assertGenerationPlanComplete("plan", documentPlan([
      ...current,
      ".rb/features/canonical-optionals/OPERATIONS.json",
      ".rb/features/canonical-optionals/contracts/public-api.yaml",
    ]))).not.toThrow();
  });

  it("does not let an old READY plan satisfy a current run missing PHASES", async () => {
    const project = await root();
    await mkdir(resolve(project, ".rb/init"), { recursive: true });
    await writeFile(resolve(project, ".rb/init/PROJECT.md"), "# Project\n\nCurrent intent.\n", "utf8");
    await writeFile(resolve(project, ".rb/init/PHASES.md"), phases(".rb/init", "old-init"), "utf8");
    const validation = await validateStagedTree(project, "init", project, {
      currentArtifactPaths: [".rb/init/PROJECT.md"],
    });
    expect(validation.valid).toBe(false);
    expect(validation.errors.map((error) => error.code)).toContain("workflow.artifact.required-missing");
    expect(validation.errors.find((error) => error.code === "workflow.ready-output.missing")?.message)
      .toContain("required ready output");
  });

  it("does not let an old BLOCKED plan contaminate a complete current plan", async () => {
    const project = await root();
    await writePlanSet(project, "old-blocked", true);
    const current = await writePlanSet(project, "current-ready");
    const validation = await validateStagedTree(project, "plan", project, { currentArtifactPaths: current });
    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
    expect(validation.readyPlans).toBe(1);
  });

  it("keeps a complete current workflow READY in staged and final verification", async () => {
    const project = await root();
    const current = await writePlanSet(project, "current-ready");
    expect((await validateStagedTree(project, "plan", project, { currentArtifactPaths: current })).valid).toBe(true);
    await syncManifest(project);
    const authority = resolve(project, "request.md");
    await writeFile(authority, "Implement RF-001.\n", "utf8");
    const report = await verifyArtifacts({
      projectRoot: project,
      artifactDirectory: ".rb",
      againstFile: authority,
      currentArtifactPaths: current,
    });
    expect(report.readyForRalph).toBe(true);
    expect(report.deterministic.readyPlanCount).toBe(1);
  });

  it("rejects a current workflow that omits any canonical mandatory artifact", async () => {
    const project = await root();
    const current = await writePlanSet(project, "incomplete");
    const withoutSpec = current.filter((path) => !path.endsWith("/SPEC.md"));
    const validation = await validateStagedTree(project, "plan", project, { currentArtifactPaths: withoutSpec });
    expect(validation.valid).toBe(false);
    expect(validation.errors.find((error) => error.path?.endsWith("/SPEC.md"))?.code)
      .toBe("workflow.artifact.required-missing");
  });

  it("rejects an unknown current-run artifact in staged and final validation", async () => {
    const project = await root();
    const current = await writePlanSet(project, "unknown-current");
    const unknown = ".rb/features/unknown-current/TECHNICAL_NOTES.md";
    await writeFile(resolve(project, unknown), "# Technical notes\n", "utf8");
    current.push(unknown);
    const staged = await validateStagedTree(project, "plan", project, { currentArtifactPaths: current });
    expect(staged.errors.find((error) => error.path === unknown)?.code).toBe("workflow.artifact.not-allowed");

    await syncManifest(project);
    const authority = resolve(project, "unknown-current-request.md");
    await writeFile(authority, "Implement RF-001.\n", "utf8");
    const report = await verifyArtifacts({
      projectRoot: project,
      artifactDirectory: ".rb",
      againstFile: authority,
      currentArtifactPaths: current,
    });
    expect(report.readyForRalph).toBe(false);
    expect(report.findings.find((finding) => finding.artifact === unknown)?.criterion)
      .toBe("workflow-artifact-allowlist");
  });

  it("rejects a dynamic workflow bundle containing an authored path outside its single canonical root", async () => {
    const project = await root();
    const current = await writePlanSet(project, "mixed-root");
    await mkdir(resolve(project, ".rb/context"), { recursive: true });
    await writeFile(resolve(project, ".rb/context/AGENTS.md"), "# Context\n\nUnrelated authored output.\n", "utf8");
    current.push(".rb/context/AGENTS.md");
    const validation = await validateStagedTree(project, "plan", project, { currentArtifactPaths: current });
    expect(validation.valid).toBe(false);
    expect(validation.errors.map((error) => error.code)).toContain("workflow.scope.invalid");
  });

  it("rejects a fixed-root workflow bundle containing an authored path outside its canonical root", async () => {
    const project = await root();
    const current = await writeInitSet(project);
    await mkdir(resolve(project, ".rb/context"), { recursive: true });
    await writeFile(resolve(project, ".rb/context/project-overview.md"), "# Context\n\nOutside init.\n", "utf8");
    current.push(".rb/context/project-overview.md");
    const validation = await validateStagedTree(project, "init", project, { currentArtifactPaths: current });
    expect(validation.valid).toBe(false);
    expect(validation.errors.map((error) => error.code)).toContain("workflow.scope.invalid");
  });

  it("does not let historical optional or unknown artifacts contaminate a valid rerun", async () => {
    const project = await root();
    const base = ".rb/features/same-slug";
    await mkdir(resolve(project, base), { recursive: true });
    await writeFile(resolve(project, `${base}/OPERATIONS.json`), "{\"contract\":\"stale-invalid\"}\n", "utf8");
    await writeFile(resolve(project, `${base}/TECHNICAL_NOTES.md`), "# Historical notes\n", "utf8");
    const current = await writePlanSet(project, "same-slug");
    const validation = await validateStagedTree(project, "plan", project, { currentArtifactPaths: current });
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
    await syncManifest(project);
    const authority = resolve(project, "same-slug-request.md");
    await writeFile(authority, "Implement RF-001.\n", "utf8");
    const report = await verifyArtifacts({
      projectRoot: project,
      artifactDirectory: ".rb",
      againstFile: authority,
      currentArtifactPaths: current,
    });
    expect(report.readyForRalph).toBe(true);
    expect(report.findings.some((finding) => finding.artifact.endsWith("/OPERATIONS.json"))).toBe(false);
    expect(report.findings.some((finding) => finding.artifact.endsWith("/TECHNICAL_NOTES.md"))).toBe(false);
  });
});

describe("authoritative constraints and evolve traceability", () => {
  it("rejects task Scope ownership of a canonically marked protected path", async () => {
    const project = await root();
    const current = await writeEvolveSet(project, "marked-protection", {
      scope: "`config/protected.yml`, `test/config.test.ts`",
      preservation: "# Preservation\n\n<!-- rb-authority: protected-path; id=PRESERVE-001; path=config/protected.yml -->\n\n## PRESERVE-001\n\nPRESERVE the protected configuration.\n",
    });
    const validation = await validateStagedTree(project, "evolve", project, { currentArtifactPaths: current });
    expect(validation.valid).toBe(false);
    expect(validation.errors.find((error) => error.code === "authority.protected-path.scope")?.message)
      .toContain("config/protected.yml");
  });

  it("rejects an executable Change that contradicts an explicit do-not-modify authority", async () => {
    const project = await root();
    const current = await writeEvolveSet(project, "request-protection", {
      scope: "`src/new.ts`, `test/new.test.ts`",
      change: "Modify `config/protected.yml` and implement CHANGE-001.",
    });
    const acceptedAuthority = {
      request: "Implement CHANGE-001.",
      answers: [{
        questionId: "protected-config",
        question: "Which configuration must remain untouched?",
        rawAnswer: "Do not modify `config/protected.yml`.",
        normalizedDecision: "Do not modify `config/protected.yml`.",
        disposition: "ACCEPTED",
        answeredAt: new Date(0).toISOString(),
      }],
    } as HarnessRunState;
    const staged = await validateStagedTree(project, "evolve", project, {
      currentArtifactPaths: current,
      authority: acceptedAuthority,
    });
    expect(staged.valid).toBe(false);
    expect(staged.errors.find((error) => error.code === "authority.protected-path.change")?.message)
      .toContain("config/protected.yml");
    await syncManifest(project);
    const authority = resolve(project, "accepted-request.md");
    await writeFile(authority, "Implement CHANGE-001. Do not modify `config/protected.yml`.\n", "utf8");
    const report = await verifyArtifacts({
      projectRoot: project,
      artifactDirectory: ".rb",
      againstFile: authority,
      currentArtifactPaths: current,
    });
    expect(report.readyForRalph).toBe(false);
    expect(report.findings.find((finding) => finding.criterion === "authority.protected-path.change")?.evidence)
      .toContain("config/protected.yml");
  });

  it("makes stable evolve preservation obligations participate in coverage and path enforcement", async () => {
    const project = await root();
    const current = await writeEvolveSet(project, "preservation-trace", {
      scope: "`src/legacy.ts`, `test/new.test.ts`",
      covers: "CHANGE-001",
    });
    await syncManifest(project);
    const staged = await validateStagedTree(project, "evolve", project, { currentArtifactPaths: current });
    expect(staged.valid).toBe(false);
    expect(staged.errors.find((error) => error.code === "authority.traceability.coverage")?.message)
      .toContain("PRESERVE-001");
    const authority = resolve(project, "request.md");
    await writeFile(authority, "Implement the accepted evolution.\n", "utf8");
    const report = await verifyArtifacts({
      projectRoot: project,
      artifactDirectory: ".rb",
      againstFile: authority,
      currentArtifactPaths: current,
    });
    expect(report.readyForRalph).toBe(false);
    expect(report.findings.find((finding) => finding.criterion === "authority.traceability.coverage")?.evidence)
      .toContain("PRESERVE-001");
    expect(report.findings.find((finding) => finding.criterion === "authority.protected-path.scope")?.evidence)
      .toContain("src/legacy.ts");
  });
});
