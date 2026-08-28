#!/usr/bin/env node
/**
 * Interview fixture that only converges after an answer opens a new decision.
 *
 * Round 1 asks one scope question. The answer to it is ACCEPTED but surfaces a
 * second material decision, so round 2 asks that one. Round 3 sees both settled
 * and returns ready. A two-round interview could never reach this state.
 */
import { appendFile } from "node:fs/promises";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const prompt = Buffer.concat(chunks).toString("utf8");
if (process.env.RB_HARNESS_TEST_ROUND_FILE) {
  await appendFile(process.env.RB_HARNESS_TEST_ROUND_FILE, `${process.env.RB_HARNESS_MODE ?? "unknown"}\n`, "utf8");
}

/** The exact answers this round must classify, as the orchestrator declared them. */
function pendingAnswerIds() {
  const marker = "Answers requiring classification in this round:\n";
  const start = prompt.lastIndexOf(marker);
  if (start < 0) return [];
  const from = start + marker.length;
  // The section is the last one in the prompt, so there may be no trailing newline.
  const end = prompt.indexOf("\n", from);
  const line = prompt.slice(from, end < 0 ? undefined : end);
  try {
    return JSON.parse(line).map((answer) => answer.questionId);
  } catch {
    return [];
  }
}

const question = (id, text) => ({
  id,
  question: text,
  why: "It changes the observable scope of the generated plan.",
  type: "text",
  options: [],
});

if (process.env.RB_HARNESS_MODE === "interview") {
  const pending = pendingAnswerIds();
  let result;
  if (!pending.length) {
    result = {
      contract: "rb-harness-interview/v1",
      status: "needs_input",
      summary: "One material scope boundary remains.",
      discoveries: ["No existing artifact tree was found."],
      assumptions: [],
      unresolved: ["Feature scope"],
      answerReviews: [],
      questions: [question("scope-boundary", "Which stored records does the export cover?")],
    };
  } else if (pending.includes("scope-boundary")) {
    // Accepting the first answer is exactly what opens the second decision.
    result = {
      contract: "rb-harness-interview/v1",
      status: "needs_input",
      summary: "The accepted scope opened a retention decision.",
      discoveries: [],
      assumptions: [],
      unresolved: ["Retention window"],
      answerReviews: [{
        questionId: "scope-boundary",
        disposition: "ACCEPTED",
        normalizedDecision: "The export covers archived records.",
      }],
      questions: [question("retention-window", "How long are archived records retained before the export skips them?")],
    };
  } else {
    result = {
      contract: "rb-harness-interview/v1",
      status: "ready",
      summary: "Every material decision is settled.",
      discoveries: [],
      assumptions: [],
      unresolved: [],
      answerReviews: [{
        questionId: "retention-window",
        disposition: "ACCEPTED",
        normalizedDecision: "Archived records are retained for 90 days.",
      }],
      questions: [],
    };
  }
  process.stdout.write(`RB_HARNESS_INTERVIEW_JSON_BEGIN\n${JSON.stringify(result)}\nRB_HARNESS_INTERVIEW_JSON_END\n`);
  process.exit(0);
}

const phases = `# RB Execution Plan: Adaptive fixture

<!-- rb-execution-contract: rb-execution/v1 -->
<!-- rb-artifact-id: adaptive-fixture-execution -->

## Phase 1: Expose the export

**Phase ID:** P01
**Goal:** Expose the documented export through the public interface.
**Depends on:** none
**Context:**
- \`.rb/features/adaptive-fixture/REQUEST.md\`
- \`.rb/features/adaptive-fixture/SPEC.md\`
- \`.rb/features/adaptive-fixture/PLAN.md\`

- [ ] T001 — Persist the archived-record selection
  - **Scope:** \`src/export/selection.ts\`, \`tests/export/selection.test.ts\`
  - **Change:** Select archived records within the retention window.
  - **Covers:** RF-001
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T001-01: Given a record archived 89 days ago, the selection includes it and excludes one archived 91 days ago.
  - **Validation:**
    - \`npm test\`
  - **Expected evidence:** Source changes, regression tests, and passing validation output.

- [ ] T002 — Expose the export operation
  - **Scope:** \`src/export/command.ts\`, \`tests/export/command.test.ts\`
  - **Change:** Expose the selection through the documented export operation.
  - **Covers:** RF-002
  - **Depends on:** T001
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T002-01: Running the export command exits with code 0 and writes one line per selected record.
  - **Validation:**
    - \`npm test\`
  - **Expected evidence:** Source changes, regression tests, and passing validation output.
`;

const bundle = {
  contract: "rb-harness-documents/v1",
  status: "complete",
  summary: "Generated the adaptive fixture feature documentation.",
  documents: [
    {
      path: ".rb/features/adaptive-fixture/REQUEST.md",
      content: "# Request\n\nExport archived records retained for 90 days.\n",
    },
    {
      path: ".rb/features/adaptive-fixture/SPEC.md",
      content: "# Specification\n\n## RF-001\n\nThe export selects archived records inside the retention window.\n\n"
        + "## RF-002\n\nThe export exposes one observable command.\n",
    },
    {
      path: ".rb/features/adaptive-fixture/PLAN.md",
      content: "# Plan\n\nSelect retained archived records, then expose the bounded export command.\n",
    },
    { path: ".rb/features/adaptive-fixture/PHASES.md", content: phases },
  ],
  blocked: [],
};
process.stdout.write(`RB_HARNESS_DOCUMENTS_JSON_BEGIN\n${JSON.stringify(bundle)}\nRB_HARNESS_DOCUMENTS_JSON_END\n`);
