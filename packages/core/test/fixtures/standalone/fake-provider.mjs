#!/usr/bin/env node
import { appendFile } from "node:fs/promises";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const prompt = Buffer.concat(chunks).toString("utf8");
if (process.env.RB_HARNESS_TEST_PROVIDER_MODE_FILE) {
  await appendFile(process.env.RB_HARNESS_TEST_PROVIDER_MODE_FILE, `${process.env.RB_HARNESS_MODE ?? "unknown"}\n`, "utf8");
}
if (process.env.RB_HARNESS_TEST_PROMPT_FILE) {
  await appendFile(process.env.RB_HARNESS_TEST_PROMPT_FILE, `===== ${process.env.RB_HARNESS_MODE} =====\n${prompt}\n`, "utf8");
}

if (process.env.RB_HARNESS_MODE === "interview") {
  if (process.env.RB_HARNESS_TEST_PROSE_INTERVIEW && !prompt.includes("===== EXACT OUTPUT CONTRACT =====")) {
    process.stdout.write("I completed the substantive analysis and identified the material scope boundary. Let me now craft the required envelope.");
    process.exit(0);
  }
  const pending = prompt.includes('"rawAnswer"')
    || prompt.includes("answer scope-boundary was never classified");
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

const phases = `# RB Execution Plan: Standalone test

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
`;

const bundle = {
  contract: "rb-harness-documents/v1",
  status: "complete",
  summary: "Generated the standalone fixture feature documentation.",
  documents: [
    { path: ".rb/features/standalone-test/REQUEST.md", content: "# Request\n\nGenerate the isolated requested feature only.\n" },
    { path: ".rb/features/standalone-test/SPEC.md", content: "# Specification\n\n## RF-001\n\nThe feature must expose one observable version command.\n" },
    { path: ".rb/features/standalone-test/PLAN.md", content: "# Plan\n\nImplement RF-001 with a regression test.\n" },
    { path: ".rb/features/standalone-test/PHASES.md", content: phases },
  ],
  blocked: [],
};
process.stdout.write(`RB_HARNESS_DOCUMENTS_JSON_BEGIN\n${JSON.stringify(bundle)}\nRB_HARNESS_DOCUMENTS_JSON_END\n`);
