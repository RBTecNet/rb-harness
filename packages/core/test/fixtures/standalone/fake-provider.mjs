#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const prompt = Buffer.concat(chunks).toString("utf8");

if (process.env.RB_HARNESS_MODE === "interview") {
  const pending = prompt.includes('"disposition":"PENDING"');
  const result = pending ? {
    contract: "rb-harness-interview/v1",
    status: "ready",
    summary: "The requested scope is precise and ready for artifact generation.",
    discoveries: ["The fixture project has no pre-existing artifact tree."],
    assumptions: [],
    unresolved: [],
    answerReviews: [{ questionId: "scope-boundary", disposition: "ACCEPTED", normalizedDecision: "Generate the isolated requested feature only." }],
    questions: [],
  } : {
    contract: "rb-harness-interview/v1",
    status: "needs_input",
    summary: "One material scope boundary remains.",
    discoveries: ["No existing artifact tree was found."],
    assumptions: [],
    unresolved: ["Feature scope"],
    answerReviews: [],
    questions: [{
      id: "scope-boundary",
      question: "Should the plan cover only the requested isolated feature?",
      why: "This prevents unrelated implementation work.",
      type: "confirm",
      options: [],
      recommendation: "Yes",
    }],
  };
  process.stdout.write(`RB_HARNESS_INTERVIEW_JSON_BEGIN\n${JSON.stringify(result)}\nRB_HARNESS_INTERVIEW_JSON_END\n`);
  process.exit(0);
}

if (process.env.RB_HARNESS_MODE === "audit") {
  const result = {
    contract: "rb-harness-artifact-audit/v1",
    status: "pass",
    summary: "The fixture artifacts are bounded, traceable, and mechanically provable.",
    findings: [],
  };
  process.stdout.write(`RB_HARNESS_ARTIFACT_AUDIT_JSON_BEGIN\n${JSON.stringify(result)}\nRB_HARNESS_ARTIFACT_AUDIT_JSON_END\n`);
  process.exit(0);
}

const feature = resolve(process.cwd(), ".rb/features/standalone-test");
await mkdir(feature, { recursive: true });
await writeFile(resolve(feature, "REQUEST.md"), "# Request\n\nGenerate the isolated requested feature only.\n", "utf8");
await writeFile(resolve(feature, "SPEC.md"), "# Specification\n\n## RF-001\n\nThe feature must expose one observable version command.\n", "utf8");
await writeFile(resolve(feature, "PLAN.md"), "# Plan\n\nImplement RF-001 with a regression test.\n", "utf8");
await writeFile(resolve(feature, "PHASES.md"), `# RB Execution Plan: Standalone test

<!-- rb-execution-contract: rb-execution/v1 -->
<!-- rb-artifact-id: standalone-test-execution -->

## Phase 1: Build the isolated feature

**Phase ID:** P01
**Goal:** Build the smallest verified feature.
**Depends on:** none
**Context:**
- \`.rb/features/standalone-test/REQUEST.md\`
- \`.rb/features/standalone-test/SPEC.md\`
- \`.rb/features/standalone-test/PLAN.md\`

- [ ] T001 — Implement the documented behavior
  - **Scope:** \`src/\`, \`tests/\`
  - **Change:** Implement RF-001 without unrelated changes.
  - **Covers:** RF-001
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T001-01: The version command exits with code 0 and prints the documented version.
  - **Validation:**
    - \`npm test\`
  - **Expected evidence:** Source changes, regression tests, and passing validation output.
`, "utf8");
process.stdout.write("Generated standalone fixture artifacts.\n");
