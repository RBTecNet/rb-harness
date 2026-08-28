#!/usr/bin/env node
import { appendFile } from "node:fs/promises";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const prompt = Buffer.concat(chunks).toString("utf8");

async function record(value) {
  if (process.env.RB_HARNESS_TEST_REPAIR_CALLS) {
    await appendFile(process.env.RB_HARNESS_TEST_REPAIR_CALLS, `${value}\n`, "utf8");
  }
}

if (prompt.includes("===== EXACT OUTPUT CONTRACT =====")) {
  await record("repair-format");
  const rawMarker = "===== RAW SEMANTIC RESPONSE — IMMUTABLE AUTHORITY =====\n";
  const priorMarker = "\n===== PREVIOUS INVALID FORMATTING ATTEMPT =====\n";
  const raw = prompt.slice(prompt.indexOf(rawMarker) + rawMarker.length).split(priorMarker, 1)[0];
  process.stdout.write(raw);
  process.exit(0);
}

const phasePath = ".rb/init/PHASES.md";
const operationsPath = ".rb/init/OPERATIONS.json";

if (prompt.includes("RB_HARNESS_DOCUMENT_PLAN_JSON_BEGIN")) {
  await record("repair-plan");
  const phase = {
    path: phasePath,
    purpose: "Replace the complete plan with the localized structural correction.",
    dependsOn: process.env.RB_HARNESS_TEST_REPAIR_DEPENDENCY === "1" ? [operationsPath] : [],
    parts: [{ id: "repair-region-001", purpose: "Replace only the code-owned T001 task region." }],
  };
  const plan = {
    contract: "rb-harness-document-plan/v1",
    status: "complete",
    summary: "Apply one localized structural correction.",
    coordination: "Keep the existing execution identity.",
    documents: [phase],
    blocked: [],
  };
  if (process.env.RB_HARNESS_TEST_REPAIR_ADD_OPERATIONS === "1") {
    plan.documents.push({
      path: operationsPath,
      purpose: "Invent an optional operational contract.",
      dependsOn: [phasePath],
      parts: [{ id: "whole", purpose: "Write the new optional contract." }],
    });
  }
  if (process.env.RB_HARNESS_TEST_REPAIR_REPRESENTATION === "1") {
    plan.coordination = { execution: "structural-repair-execution", task: "T001" };
    phase.prefix = "presentation-only";
    phase.parts[0].scope = "the complete existing document";
  }
  let serialized = JSON.stringify(plan);
  if (process.env.RB_HARNESS_TEST_REPAIR_MALFORMED === "1") {
    serialized = serialized.replace(',"status":', ',,"status":');
  }
  const body = process.env.RB_HARNESS_TEST_REPAIR_REPRESENTATION === "1"
    ? `\`\`\`json\n${serialized}\n\`\`\``
    : serialized;
  process.stdout.write(`RB_HARNESS_DOCUMENT_PLAN_JSON_BEGIN\n${body}\nRB_HARNESS_DOCUMENT_PLAN_JSON_END\n`);
  process.exit(0);
}

const marker = "===== TARGET DOCUMENT PART =====\n";
const start = prompt.indexOf(marker);
if (start < 0) process.exit(2);
const target = JSON.parse(prompt.slice(start + marker.length).split("\n", 1)[0]);
await record(`repair-part:${target.path}`);
if (process.env.RB_HARNESS_TEST_REPAIR_DEPENDENCY === "1"
  && !prompt.includes("rb-operational/v1")) process.exit(7);

const content = `- [ ] T001 — Implement the typed scope gate
  - **Scope:** \`src/\`, \`tests/\`
  - **Change:** Enforce RF-001 using the declared request field and finite matrix.
  - **Covers:** RF-001
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T001-01: The finite accepted and rejected values produce the documented outcomes.
  - **Validation:**
    - \`npm test\`
  - **Expected evidence:** Positive and negative regression results with exit code 0.
`;
process.stdout.write(`RB_HARNESS_DOCUMENT_PART_JSON_BEGIN\n${JSON.stringify({
  contract: "rb-harness-document-part/v1",
  path: target.path,
  part: target.part,
  content,
})}\nRB_HARNESS_DOCUMENT_PART_JSON_END\n`);
