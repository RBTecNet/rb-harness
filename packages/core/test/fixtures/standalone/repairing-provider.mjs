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

function phases(valid, controlPlaneScope = false) {
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
  - **Scope:** ${controlPlaneScope ? "\`.rb/features/structural-repair/PHASES.md\`" : "\`src/\`, \`tests/\`"}
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

function goPhases(valid) {
  const first = valid
    ? `- [ ] T001 — Introduce the direct module at its first use
  - **Scope:** \`go.mod\`, \`go.sum\`, \`internal/tui/app.go\`
  - **Change:** Import \`github.com/charmbracelet/bubbletea\`, use it in the initial TUI model, and declare the direct module in the same convergent task.
  - **Covers:** RF-001
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T001-01: \`github.com/charmbracelet/bubbletea\` is a direct Go dependency in \`go.mod\` and \`internal/tui/app.go\` constructs the initial model.
  - **Validation:**
    - \`go mod tidy && go test ./internal/tui/...\`
  - **Expected evidence:** The scoped source and module graph remain valid after the normalizer.`
    : `- [ ] T001 — Resolve the direct module early
  - **Scope:** \`go.mod\`, \`go.sum\`
  - **Change:** Declare the requested direct Go module before implementing its consumer.
  - **Covers:** RF-001
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T001-01: \`github.com/charmbracelet/bubbletea\` is a direct Go dependency in \`go.mod\`.
  - **Validation:**
    - \`go mod tidy\`
  - **Expected evidence:** A normalized module graph.`;
  const later = valid ? "" : `

## Phase 2: Implement the consumer

**Phase ID:** P02
**Goal:** Implement the first module consumer.
**Depends on:** P01
**Context:**
- \`.rb/features/structural-repair/SPEC.md\`
- \`.rb/features/structural-repair/PLAN.md\`

- [ ] T002 — Implement the TUI
  - **Scope:** \`internal/tui/app.go\`
  - **Change:** Import \`github.com/charmbracelet/bubbletea\` and use it in the initial TUI model.
  - **Covers:** RF-001
  - **Depends on:** T001
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T002-01: The TUI constructs its initial model.
  - **Validation:**
    - \`go test ./internal/tui/...\`
  - **Expected evidence:** A passing focused test.`;
  return `# RB Execution Plan: Go convergence repair

<!-- rb-execution-contract: rb-execution/v1 -->
<!-- rb-artifact-id: structural-repair-execution -->

## Phase 1: Produce a stable module graph

**Phase ID:** P01
**Goal:** Keep the direct module after canonical validation.
**Depends on:** none
**Context:**
- \`.rb/features/structural-repair/SPEC.md\`
- \`.rb/features/structural-repair/PLAN.md\`

${first}${later}
`;
}

// The repair prompt carries the ordered deterministic errors; their presence is
// what tells the fixture which pass it is running.
const repairing = process.env.RB_HARNESS_MODE === "repair" || prompt.includes("DETERMINISTIC ERRORS");
const needsSecondRepair = process.env.RB_HARNESS_TEST_TWO_REPAIRS === "1"
  && repairing
  && !prompt.includes("task.scope.control-plane");
const goRepair = process.env.RB_HARNESS_TEST_GO_REPAIR === "1";

if (repairing && prompt.includes("RB_HARNESS_DOCUMENT_PLAN_JSON_BEGIN")) {
  const plan = {
    contract: "rb-harness-document-plan/v1",
    status: "complete",
    summary: "Repair the one code-owned task region.",
    coordination: "Use only repair-region-001.",
    documents: [{
      path: ".rb/features/structural-repair/PHASES.md",
      purpose: "Repair the bounded T001 region.",
      dependsOn: [],
      parts: [{ id: "repair-region-001", purpose: "Replace only T001." }],
    }],
    blocked: [],
  };
  process.stdout.write(`RB_HARNESS_DOCUMENT_PLAN_JSON_BEGIN\n${JSON.stringify(plan)}\nRB_HARNESS_DOCUMENT_PLAN_JSON_END\n`);
  process.exit(0);
}

if (repairing && prompt.includes("===== TARGET DOCUMENT PART =====")) {
  const marker = "===== TARGET DOCUMENT PART =====\n";
  const target = JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length).split("\n", 1)[0]);
  const repairedDocument = goRepair ? goPhases(true) : phases(true, needsSecondRepair);
  const content = goRepair
    ? repairedDocument
    : repairedDocument.slice(repairedDocument.indexOf("- [ ] T001"));
  process.stdout.write(`RB_HARNESS_DOCUMENT_PART_JSON_BEGIN\n${JSON.stringify({
    contract: "rb-harness-document-part/v1",
    path: target.path,
    part: target.part,
    content,
  })}\nRB_HARNESS_DOCUMENT_PART_JSON_END\n`);
  process.exit(0);
}

const bundle = repairing
  ? {
    contract: "rb-harness-documents/v1",
    status: "complete",
    summary: "Repaired the ambiguous acceptance criterion in place.",
    documents: [{ path: ".rb/features/structural-repair/PHASES.md", content: goRepair ? goPhases(true) : phases(true, needsSecondRepair) }],
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
      { path: ".rb/features/structural-repair/PHASES.md", content: goRepair ? goPhases(false) : phases(false) },
      { path: ".rb/features/structural-repair/source-manifest.json", content: '{"sources":[]}\n' },
    ],
    blocked: [],
  };
process.stdout.write(`RB_HARNESS_DOCUMENTS_JSON_BEGIN\n${JSON.stringify(bundle)}\nRB_HARNESS_DOCUMENTS_JSON_END\n`);
