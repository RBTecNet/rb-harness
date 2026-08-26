import { describe, expect, it } from "vitest";

/**
 * The deterministic gates must judge a plan for any stack, not the JavaScript
 * project they were first written against.
 *
 * Both failures below were real. `wholeAreaToken` treated any extensionless
 * path as a directory, so a task scoped to `Makefile` or `Dockerfile` was read
 * as "implement the whole feature". And the long-running-command pattern knew
 * only the npm world, so a Java, Elixir, PHP, or Ruby plan could declare its
 * service as a validation and stall exactly the way the observed npm one did.
 */
import { validateExecutionMarkdown } from "../src/execution-contract.js";
import { assessDecomposition } from "../src/harness-granularity.js";

const PLAN = (scope: string, validation: string, criteria = 1) => `# RB Execution Plan: x

<!-- rb-execution-contract: rb-execution/v1 -->
<!-- rb-artifact-id: x-execution -->

## Phase 1: Do the thing

**Phase ID:** P01
**Goal:** Expose the documented behavior.
**Depends on:** none
**Context:**
- \`.rb/init/PROJECT.md\`

- [ ] T001 — Implement it
  - **Scope:** ${scope}
  - **Change:** Implement it.
  - **Covers:** RF-001
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
${Array.from({ length: criteria }, (_v, i) => `    - AC-T001-0${i + 1}: The operation returns status 200.`).join("\n")}
  - **Validation:**
    - ${validation}
  - **Expected evidence:** Source changes.
`;

describe("scope tokens outside a JS project", () => {
  for (const scope of ["`Makefile`", "`Dockerfile`", "`LICENSE`", "`Rakefile`", "`go.mod`, `Makefile`"]) {
    it(`treats ${scope} as files, not an area`, () => {
      const doc = validateExecutionMarkdown(PLAN(scope, "`make test`", 4)).document!;
      const issues = assessDecomposition(doc).map((i) => i.code);
      expect(issues, scope).not.toContain("execution.phase.undecomposed-feature");
    });
  }
});

describe("service commands outside the npm world", () => {
  for (const command of [
    "`mvn spring-boot:run`", "`./gradlew bootRun`", "`mix phx.server`",
    "`php artisan serve`", "`bundle exec puma`", "`rails server`", "`sbt run`", "`php -S localhost:8000`",
  ]) {
    it(`${command} is a service that never exits`, () => {
      const result = validateExecutionMarkdown(PLAN("`src/a.ts`", command));
      const issue = result.issues.find((e) => e.code === "task.validation.ambiguous");
      expect(issue?.message, command).toContain("never exits");
    });
  }
});

describe("one-shot commands in other ecosystems still pass", () => {
  for (const command of [
    "`make test`", "`mvn test`", "`./gradlew test`", "`mix test`",
    "`bundle exec rspec`", "`pytest`", "`dotnet test`", "`swift test`",
  ]) {
    it(`${command} is accepted`, () => {
      const result = validateExecutionMarkdown(PLAN("`src/a.ts`", command));
      expect(result.issues.filter((e) => e.code === "task.validation.ambiguous"), command).toEqual([]);
    });
  }
});
