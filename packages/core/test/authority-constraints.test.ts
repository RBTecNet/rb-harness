import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILT_IN_PROTECTED_PATH_CONSTRAINTS,
  authorityConstraintsFromState,
  changeExplicitlyModifiesProtectedPath,
  protectedPathConstraintsFromArtifact,
  protectedPathConstraintsFromText,
  scopeTokenIntersectsProtectedPath,
  traceabilityConstraintsFromArtifact,
  traceabilityConstraintsFromState,
  validateAuthorityConstraints,
} from "../src/authority-constraints.js";
import { validateExecutionMarkdown } from "../src/execution-contract.js";
import type { HarnessRunState } from "../src/standalone-types.js";

const minimalFixture = resolve(process.cwd(), "../../tests/fixtures/execution/valid/minimal/PHASES.md");

async function executionWithScope(scope: string) {
  const source = (await readFile(minimalFixture, "utf8")).replace("`src/`, `tests/`", scope);
  const parsed = validateExecutionMarkdown(source);
  expect(parsed.document).toBeDefined();
  return parsed.document!;
}

function state(request: string, rawAnswer = "", normalizedDecision?: string): HarnessRunState {
  return {
    request,
    answers: rawAnswer ? [{
      questionId: "authority",
      question: "What must remain protected?",
      rawAnswer,
      ...(normalizedDecision ? { normalizedDecision } : {}),
      disposition: "ACCEPTED",
      answeredAt: new Date(0).toISOString(),
    }] : [],
  } as HarnessRunState;
}

describe("protected path authority", () => {
  it.each([
    ".spec/init",
    ".spec/init/project-description.md",
    ".spec/init/**",
    ".spec/*/project-description.md",
  ])("rejects execution ownership intersecting the Progressive Init specification: %s", async (scope) => {
    const issues = validateAuthorityConstraints(
      await executionWithScope(`\`${scope}\``),
      BUILT_IN_PROTECTED_PATH_CONSTRAINTS,
      ".rb/init/PHASES.md",
    );
    expect(issues.map((issue) => issue.code)).toContain("authority.protected-path.scope");
  });

  it("keeps unrelated .spec paths outside the narrow Progressive Init protection", async () => {
    expect(validateAuthorityConstraints(
      await executionWithScope("`.spec/product-notes.md`"),
      BUILT_IN_PROTECTED_PATH_CONSTRAINTS,
      ".rb/init/PHASES.md",
    )).toEqual([]);
  });

  it("fails closed when a bounded Scope glob can own a descendant of a protected path", () => {
    expect(scopeTokenIntersectsProtectedPath("**/*.md", ".rb")).toBe(true);
    expect(scopeTokenIntersectsProtectedPath(".r*/**", ".rb")).toBe(true);
    expect(scopeTokenIntersectsProtectedPath("src/**/*.ts", "src/legacy")).toBe(true);
    expect(scopeTokenIntersectsProtectedPath("src/**", "src/legacy/file.ts")).toBe(true);
    expect(scopeTokenIntersectsProtectedPath("tests/**/*.ts", "src/legacy")).toBe(false);
    expect(scopeTokenIntersectsProtectedPath("config/*.json", "src/legacy")).toBe(false);
  });

  it("fails closed for intersecting glob pairs and disproves only incompatible anchored prefixes", () => {
    expect(scopeTokenIntersectsProtectedPath("config/**", "**/secrets/*.env")).toBe(true);
    expect(scopeTokenIntersectsProtectedPath("src/**", "tests/**")).toBe(false);
    expect(scopeTokenIntersectsProtectedPath("src/**/*.ts", "src/**/legacy/*.ts")).toBe(true);
    expect(scopeTokenIntersectsProtectedPath("tests/**/*.ts", "src/**/*.ts")).toBe(false);
    expect(scopeTokenIntersectsProtectedPath("**/*.md", ".rb/**/*.md")).toBe(true);
  });

  it("treats literal Scope directories as ownership prefixes for protected globs", () => {
    expect(scopeTokenIntersectsProtectedPath("config/secrets", "**/secrets/*.env")).toBe(true);
    expect(scopeTokenIntersectsProtectedPath("src/legacy", "**/legacy/*.ts")).toBe(true);
    expect(scopeTokenIntersectsProtectedPath("src", "**/*.md")).toBe(true);
  });

  it("disproves glob intersections only through deterministic prefixes and suffixes", () => {
    expect(scopeTokenIntersectsProtectedPath("tests/**/*.ts", "**/*.md")).toBe(false);
    expect(scopeTokenIntersectsProtectedPath("src/**/*.json", "**/*.yaml")).toBe(false);
    expect(scopeTokenIntersectsProtectedPath("src/**/*.ts", "**/legacy/*.ts")).toBe(true);
    expect(scopeTokenIntersectsProtectedPath("tests/**/*.ts", "src/**/*.ts")).toBe(false);
  });

  it("rejects literal Scope ownership of descendants matched by a protected glob", async () => {
    const issues = validateAuthorityConstraints(
      await executionWithScope("`config/secrets`"),
      [{
        kind: "protected-path",
        id: "SECRET-ENV",
        path: "**/secrets/*.env",
        source: "request",
      }],
      ".rb/features/example/PHASES.md",
    );
    expect(issues.find((issue) => issue.code === "authority.protected-path.scope")?.message)
      .toContain("config/secrets");
  });

  it.each([
    "Do not modify package.json",
    "Don't modify package.json",
    "Never edit config/app.php",
    "Não alterar config/app.php",
    "Não altere config/app.php",
    "Não modificar config/app.php",
    "Não modifique config/app.php",
    "Não editar config/app.php",
    "Não edite config/app.php",
    "Não mexer em config/app.php",
    "Não mexa em config/app.php",
    "Não tocar em config/app.php",
    "Não toque em config/app.php",
  ])("extracts an explicit unquoted line-local prohibition: %s", (directive) => {
    expect(protectedPathConstraintsFromText(directive, "request").map((entry) => entry.path))
      .toContain(directive.includes("package.json") ? "package.json" : "config/app.php");
  });

  it("preserves protected paths from a raw accepted answer when normalization paraphrases them away", () => {
    const constraints = authorityConstraintsFromState(state(
      "Implement the accepted change.",
      "Não altere config/raw.php",
      "Keep the accepted configuration behavior stable.",
    ));
    expect(constraints.map((entry) => entry.path)).toContain("config/raw.php");
  });

  it.each([
    "without modifying config/app.php",
    "without changing config/app.php",
    "Implement X sem alterar config/app.php.",
    "Implement X sem modificar config/app.php.",
    "Implement X sem editar config/app.php.",
    "Implement X sem mexer em config/app.php.",
  ])("extracts an explicit line-local preservation form: %s", (directive) => {
    expect(protectedPathConstraintsFromText(directive, "request").map((entry) => entry.path))
      .toContain("config/app.php");
  });

  it("associates each protected path occurrence with its nearest mutation", () => {
    expect(changeExplicitlyModifiesProtectedPath(
      "Do not modify `config/app.php`; instead modify `config/app.php`.",
      "config/app.php",
    )).toBe(true);
    expect(changeExplicitlyModifiesProtectedPath(
      "Do not modify `config/app.php`.",
      "config/app.php",
    )).toBe(false);
    expect(changeExplicitlyModifiesProtectedPath(
      "Modify `src/new.php` without modifying `config/app.php`.",
      "config/app.php",
    )).toBe(false);
  });

  it("uses only the designated PRESERVATION table path column", async () => {
    const constraints = protectedPathConstraintsFromArtifact(
      ".rb/evolutions/example/PRESERVATION.md",
      [
        "| ID | Protected path | Regression test |",
        "| --- | --- | --- |",
        "| PRESERVE-001 | `src/legacy.ts` | `tests/legacy.test.ts` |",
      ].join("\n"),
    );
    expect(constraints.map((entry) => entry.path)).toEqual(["src/legacy.ts"]);
    expect(validateAuthorityConstraints(
      await executionWithScope("`tests/legacy.test.ts`"),
      constraints,
      ".rb/evolutions/example/PHASES.md",
    )).toEqual([]);
    expect(validateAuthorityConstraints(
      await executionWithScope("`src/legacy.ts`"),
      constraints,
      ".rb/evolutions/example/PHASES.md",
    ).map((issue) => issue.code)).toContain("authority.protected-path.scope");
  });
});

describe("evolve obligation traceability", () => {
  it("extracts real CHANGE and PRESERVE declarations from a named ID table column", () => {
    const change = traceabilityConstraintsFromArtifact(
      ".rb/evolutions/example/TO_BE.md",
      "| Outcome | Change ID |\n| --- | --- |\n| Return the accepted result | CHANGE-002 |\n",
    );
    const preserve = traceabilityConstraintsFromArtifact(
      ".rb/evolutions/example/PRESERVATION.md",
      "| Behavior | Obligation ID |\n| --- | --- |\n| Keep legacy output | PRESERVE-003 |\n",
    );
    expect(change.map((entry) => entry.id)).toEqual(["CHANGE-002"]);
    expect(preserve.map((entry) => entry.id)).toEqual(["PRESERVE-003"]);
  });

  it("extracts heading/list declarations but ignores prose references and non-goals", () => {
    expect(traceabilityConstraintsFromArtifact(
      ".rb/evolutions/example/TO_BE.md",
      "# TO BE\n\n## CHANGE-001 Accepted delta\n\nBackground mentions CHANGE-999 only.\n",
    ).map((entry) => entry.id)).toEqual(["CHANGE-001"]);
    expect(traceabilityConstraintsFromArtifact(
      ".rb/evolutions/example/PRESERVATION.md",
      "# Preservation\n\n- PRESERVE-001 — Keep legacy output.\n\nA prior PRESERVE-999 is only historical.\n",
    ).map((entry) => entry.id)).toEqual(["PRESERVE-001"]);
    expect(traceabilityConstraintsFromState(state(
      "## Non-goals\n- CHANGE-777: historical only.\nCHANGE-004: deliver the accepted delta.",
    )).map((entry) => entry.id)).toEqual(["CHANGE-004"]);
  });
});
