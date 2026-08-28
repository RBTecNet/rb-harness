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

  it("rejects immutable planning artifacts in task Scope", async () => {
    const source = await fixture("valid", "minimal");
    for (const protectedScope of [
      "`.rb`",
      "`.rb/`",
      "`./.rb/init/OPERATIONS.json`",
      "`.rb/features/example/**`",
      "`.rb\\init\\OPERATIONS.json`",
    ]) {
      const result = validateExecutionMarkdown(source.replace("`src/`, `tests/`", protectedScope));
      const controlPlane = result.issues.find((entry) => entry.code === "task.scope.control-plane");
      expect(controlPlane?.message, protectedScope).toContain("T001");
      expect(controlPlane?.message, protectedScope).toContain("immutable planning artifacts");
    }
  });

  it("allows planning artifacts as read-only Context and Validation input", async () => {
    const source = (await fixture("valid", "minimal"))
      .replace("`.rb/init/PROJECT.md`", "`.rb/init/OPERATIONS.json`")
      .replace("`npm test`", "`rb-harness operations validate .rb/init/OPERATIONS.json`");
    const result = validateExecutionMarkdown(source);
    expect(result.issues.filter((entry) => entry.code === "task.scope.control-plane")).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("rejects control-plane globs and Change instructions even when another field looks safe", async () => {
    const source = await fixture("valid", "minimal");
    for (const scope of ["`.r*/**`", "`**/*.md`"]) {
      const globbed = validateExecutionMarkdown(source.replace("`src/`, `tests/`", scope));
      expect(globbed.issues.map((entry) => entry.code), scope).toContain("task.scope.control-plane");
    }

    const changed = validateExecutionMarkdown(source.replace(
      "Implement the documented foundation without unrelated changes.",
      "Implement the foundation and update `.rb/init/OPERATIONS.json`.",
    ));
    expect(changed.issues.map((entry) => entry.code)).toContain("task.change.control-plane");

    for (const defensiveDescription of [
      "Reject `.rb`, `.rb/`, and every `.rb/**` descendant from task scope.",
      "Ensure generated tasks never own `.rb/**`.",
      "Prevent providers from writing to `.rb/**` during execution.",
    ]) {
      const defensive = validateExecutionMarkdown(source.replace(
        "Implement the documented foundation without unrelated changes.",
        defensiveDescription,
      ));
      expect(defensive.issues.map((entry) => entry.code), defensiveDescription)
        .not.toContain("task.change.control-plane");
    }
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

/**
 * A third impossible shape, from the same family as the service command and the
 * backticked prose: the right tool aimed at the wrong format. An observed plan
 * used `node --check .rb/init/OPERATIONS.json` to prove the operational
 * contract. `node --check` parses JavaScript, so it exits 1 for a valid JSON
 * file and cannot tell one from a broken one — that phase could never complete.
 */
describe("a syntax checker aimed at a format it cannot parse", () => {
  const withValidation = (source: string, validation: string) =>
    source.replace("    - `npm test`", `    - ${validation}`);

  it("rejects node --check against data and markup", async () => {
    const source = await fixture("valid", "minimal");
    for (const target of ["config.json", "docker-compose.yaml", "notes.md", "site.html", "Cargo.lock"]) {
      const result = validateExecutionMarkdown(withValidation(source, `\`node --check ${target}\``));
      const issue = result.issues.find((entry) => entry.code === "task.validation.ambiguous");
      expect(issue?.message, target).toContain("parses JavaScript");
    }
  });

  it("names the operational validator when that is what was meant", async () => {
    const source = await fixture("valid", "minimal");
    const result = validateExecutionMarkdown(withValidation(source, "`node --check .rb/init/OPERATIONS.json`"));
    const issue = result.issues.find((entry) => entry.code === "task.validation.ambiguous");
    expect(issue?.message).toContain("rb-harness operations validate .rb/init/OPERATIONS.json");
  });

  it("leaves node --check on JavaScript alone", async () => {
    const source = await fixture("valid", "minimal");
    for (const command of [
      "`node --check src/index.js`", "`node --check bin/cli.mjs`", "`node --check lib/thing.cjs`",
      // Type stripping decides whether this passes, so the gate must not guess.
      "`node --check src/index.ts`",
      // A different tool with a JSON argument is not this defect.
      "`rb-harness operations validate .rb/init/OPERATIONS.json`",
      "`jq empty config.json`", "`npm test -- config.json`",
    ]) {
      const result = validateExecutionMarkdown(withValidation(source, command));
      expect(result.issues.filter((entry) => entry.code === "task.validation.ambiguous"), command).toEqual([]);
    }
  });
});

describe("visual acceptance evidence", () => {
  const visualCriterion = "The rendered board keeps every required element visible in the viewport.";
  const negativeCriterion = "No required visual element is hidden, clipped, overlapping, or outside the viewport.";
  const durableEvidence = "Screenshots at viewport 1440x900 plus getBoundingClientRect geometry with positive area and viewport intersection.";

  function visualPlan(source: string, validation: string, evidence = durableEvidence, criterion = visualCriterion): string {
    return source
      .replace(
        "    - AC-T001-01: Running the version command exits with code 0 and prints `0.1.0`.",
        `    - AC-T001-01: ${criterion}\n    - AC-T001-02: ${negativeCriterion}`,
      )
      .replace("    - `npm test`", `    - ${validation}`)
      .replace(
        "  - **Expected evidence:** Source changes, regression tests, and passing validation output.",
        `  - **Expected evidence:** ${evidence}`,
      );
  }

  it("rejects a manual instruction as proof of rendered visibility", async () => {
    const source = visualPlan(await fixture("valid", "minimal"), "manual: inspect the rendered board");
    const result = validateExecutionMarkdown(source);
    expect(result.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "task.validation.visual-manual",
      "task.validation.visual-unproven",
    ]));
  });

  it("rejects the incident-shaped stylesheet/fake-DOM fixture", async () => {
    const result = validateExecutionMarkdown(await fixture("invalid", "visual-manual"));
    expect(result.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "task.validation.visual-manual",
      "task.validation.visual-unproven",
    ]));
  });

  it("rejects DOM or generic test commands that cannot prove rendering", async () => {
    const source = visualPlan(await fixture("valid", "minimal"), "`npm test -- fake-dom`");
    const result = validateExecutionMarkdown(source);
    expect(result.issues.map((entry) => entry.code)).toContain("task.validation.visual-unproven");
  });

  it("requires durable screenshots, an exact viewport, geometry, and a negative control", async () => {
    const source = visualPlan(
      await fixture("valid", "minimal"),
      "`npm run test:e2e -- board`",
      "Browser test output.",
      visualCriterion,
    ).replace(`\n    - AC-T001-02: ${negativeCriterion}`, "");
    const result = validateExecutionMarkdown(source);
    expect(result.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "task.evidence.visual-contract",
      "task.acceptance.visual-negative-control",
    ]));
  });

  it("accepts executable visual proof with a durable evidence contract", async () => {
    const source = visualPlan(await fixture("valid", "minimal"), "`npm run test:e2e -- board-visual`");
    const result = validateExecutionMarkdown(source);
    expect(result.issues.filter((entry) => entry.code.includes("visual"))).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("accepts a human gate when visual automation is unavailable", async () => {
    const source = visualPlan(
      await fixture("valid", "minimal"),
      "human: capture and approve the board at the declared viewport",
    );
    const result = validateExecutionMarkdown(source);
    expect(result.issues.filter((entry) => entry.code.includes("visual"))).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("requires before and after evidence for an interactive visual state", async () => {
    const source = visualPlan(
      await fixture("valid", "minimal"),
      "`npx playwright test board-visual`",
      durableEvidence,
      "After pressing ArrowUp, the rendered chicken visibly moves inside the viewport.",
    );
    const result = validateExecutionMarkdown(source);
    expect(result.issues.map((entry) => entry.code)).toContain("task.evidence.visual-state-pair");

    const withStatePair = source.replace(
      durableEvidence,
      `${durableEvidence} Initial/before and resulting/after screenshots are preserved.`,
    );
    expect(validateExecutionMarkdown(withStatePair).issues.filter((entry) => entry.code.includes("visual"))).toEqual([]);
  });

  it("does not classify ordinary CLI output as visual UI", async () => {
    const source = (await fixture("valid", "minimal")).replace(
      "Running the version command exits with code 0 and prints `0.1.0`.",
      "The command displays version `0.1.0` on stdout.",
    );
    expect(validateExecutionMarkdown(source).issues.filter((entry) => entry.code.includes("visual"))).toEqual([]);
  });

  it("does not classify a contract about visual criteria as rendered UI", async () => {
    const source = (await fixture("valid", "minimal")).replace(
      "Running the version command exits with code 0 and prints `0.1.0`.",
      "The validator rejects visual acceptance criteria that rely only on `manual:`.",
    );
    expect(validateExecutionMarkdown(source).issues.filter((entry) => entry.code.includes("visual"))).toEqual([]);
  });
});
