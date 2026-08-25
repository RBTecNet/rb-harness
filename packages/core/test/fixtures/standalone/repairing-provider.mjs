#!/usr/bin/env node
import { appendFile, readdir } from "node:fs/promises";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const prompt = Buffer.concat(chunks).toString("utf8");
if (process.env.RB_HARNESS_TEST_PROVIDER_MODE_FILE) {
  await appendFile(process.env.RB_HARNESS_TEST_PROVIDER_MODE_FILE, `${process.env.RB_HARNESS_MODE ?? "unknown"}\n`, "utf8");
}
if (process.env.RB_HARNESS_TEST_PROVIDER_CWD_FILE) {
  await appendFile(process.env.RB_HARNESS_TEST_PROVIDER_CWD_FILE, `${JSON.stringify({
    mode: process.env.RB_HARNESS_MODE ?? "unknown",
    cwd: process.cwd(),
    entries: await readdir(process.cwd()),
  })}\n`, "utf8");
}

if (process.env.RB_HARNESS_MODE === "interview") {
  const result = {
    contract: "rb-harness-interview/v1",
    status: "ready",
    summary: "The fixture request is ready.",
    discoveries: [],
    assumptions: [],
    unresolved: [],
    answerReviews: [],
    questions: [],
  };
  process.stdout.write(`RB_HARNESS_INTERVIEW_JSON_BEGIN\n${JSON.stringify(result)}\nRB_HARNESS_INTERVIEW_JSON_END\n`);
  process.exit(0);
}

function phases(valid) {
  return `# RB Execution Plan: Structural repair

<!-- rb-execution-contract: rb-execution/v1 -->
<!-- rb-artifact-id: structural-repair-execution -->

## Phase 1: Build the scope gate

**Phase ID:** P01
**Goal:** Enforce the documented typed scope authority.
**Depends on:** none
**Context:**
- \`.rb/features/structural-repair/SPEC.md\`
- \`.rb/features/structural-repair/PLAN.md\`

- [ ] T001 — Implement the typed scope gate
  - **Scope:** \`src/\`, \`tests/\`
  - **Change:** Enforce RF-001 using the declared request field and matrix.
  - **Covers:** RF-001
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T001-01: ${valid
      ? "The finite accepted and rejected values produce the documented outcomes."
      : "The gate behaves appropriately for every input."}
  - **Validation:**
    - \`npm test\`
  - **Expected evidence:** Positive and negative regression results with exit code 0.
`;
}

// The repair prompt carries the ordered deterministic errors; their presence is
// what tells the fixture which pass it is running.
const repairing = process.env.RB_HARNESS_MODE === "repair" || prompt.includes("DETERMINISTIC ERRORS");
const bundle = repairing
  ? {
    contract: "rb-harness-documents/v1",
    status: "complete",
    summary: "Repaired the ambiguous acceptance criterion in place.",
    documents: [{ path: ".rb/features/structural-repair/PHASES.md", content: phases(true) }],
    blocked: [],
  }
  : {
    contract: "rb-harness-documents/v1",
    status: "complete",
    summary: "Generated the initial structural-repair fixture documentation.",
    documents: [
      { path: ".rb/features/structural-repair/REQUEST.md", content: "# Request\n\nGenerate a deterministic scope gate.\n" },
      { path: ".rb/features/structural-repair/SPEC.md", content: "# Specification\n\n## RF-001\n\nThe request is accepted only when `request.targetMode` equals `greenfield`.\n" },
      { path: ".rb/features/structural-repair/PLAN.md", content: "# Plan\n\nImplement the typed scope gate and its finite matrix.\n" },
      { path: ".rb/features/structural-repair/PHASES.md", content: phases(false) },
    ],
    blocked: [],
  };
process.stdout.write(`RB_HARNESS_DOCUMENTS_JSON_BEGIN\n${JSON.stringify(bundle)}\nRB_HARNESS_DOCUMENTS_JSON_END\n`);
