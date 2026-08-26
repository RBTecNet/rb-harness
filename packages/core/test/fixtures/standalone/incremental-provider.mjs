#!/usr/bin/env node
import { appendFile, readFile } from "node:fs/promises";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const prompt = Buffer.concat(chunks).toString("utf8");

function record(value) {
  if (process.env.RB_HARNESS_TEST_INCREMENTAL_CALLS) {
    return appendFile(process.env.RB_HARNESS_TEST_INCREMENTAL_CALLS, `${value}\n`, "utf8");
  }
  return Promise.resolve();
}

const plan = {
  contract: "rb-harness-document-plan/v1",
  status: "complete",
  summary: "Incremental fixture documents.",
  coordination: "RF-001 is implemented by T001 in P01.",
  documents: [
    {
      path: ".rb/init/PROJECT.md",
      purpose: "Project intent.",
      parts: [{ id: "whole", purpose: "Complete short project document." }],
    },
    {
      path: ".rb/init/PHASES.md",
      purpose: "Execution contract.",
      parts: [
        { id: "header", purpose: "Header and execution metadata." },
        { id: "phase-01", purpose: "First phase and task." },
      ],
    },
  ],
  blocked: [],
};

if (process.env.RB_HARNESS_TEST_DOCUMENT_DEPENDENCIES === "1") {
  // Deliberately place OPERATIONS first. The orchestrator must derive and
  // enforce PROJECT -> PHASES -> OPERATIONS rather than trusting response
  // order or asking the operations writer to rediscover another document.
  plan.documents.unshift({
    path: ".rb/init/OPERATIONS.json",
    purpose: "Operational acceptance grounded in the final execution paths.",
    parts: [{ id: "whole", purpose: "Complete operational contract." }],
  });
}

if (prompt.includes("===== EXACT OUTPUT CONTRACT =====")) {
  let priorCalls = "";
  if (process.env.RB_HARNESS_TEST_INCREMENTAL_CALLS) {
    priorCalls = await readFile(process.env.RB_HARNESS_TEST_INCREMENTAL_CALLS, "utf8").catch(() => "");
  }
  const attempt = priorCalls.split("\n").filter((line) => line === "format").length + 1;
  await record("format");
  const invalidAttempts = Number(process.env.RB_HARNESS_TEST_FORMAT_INVALID_ATTEMPTS ?? "0");
  if (attempt <= invalidAttempts) {
    process.stdout.write(`invalid formatter attempt ${attempt}`);
    process.exit(0);
  }
  const rawMarker = "===== RAW SEMANTIC RESPONSE — IMMUTABLE AUTHORITY =====\n";
  const priorMarker = "\n===== PREVIOUS INVALID FORMATTING ATTEMPT =====\n";
  const rawStart = prompt.indexOf(rawMarker);
  const rawTail = prompt.slice(rawStart + rawMarker.length);
  const raw = rawTail.split(priorMarker, 1)[0];
  if (prompt.includes("RB_HARNESS_DOCUMENT_PART_JSON_BEGIN")) {
    const targetMatch = prompt.match(/The exact JSON shape is \{"contract":"rb-harness-document-part\/v1","path":("(?:[^"\\]|\\.)*"),"part":("(?:[^"\\]|\\.)*"),/);
    if (!targetMatch?.[1] || !targetMatch[2]) process.exit(3);
    const content = raw.includes('"content":"')
      ? 'Recovered "quoted" content.\n'
      : raw;
    const formattedPart = {
      contract: "rb-harness-document-part/v1",
      path: JSON.parse(targetMatch[1]),
      part: JSON.parse(targetMatch[2]),
      content,
    };
    process.stdout.write(`RB_HARNESS_DOCUMENT_PART_JSON_BEGIN\n${JSON.stringify(formattedPart)}\nRB_HARNESS_DOCUMENT_PART_JSON_END\n`);
    process.exit(0);
  }
  const begin = raw.indexOf("RB_HARNESS_DOCUMENT_PLAN_JSON_BEGIN");
  const jsonStart = raw.indexOf("\n", begin) + 1;
  const jsonEnd = raw.indexOf("\nRB_HARNESS_DOCUMENT_PLAN_JSON_END", jsonStart);
  const formatted = JSON.parse(raw.slice(jsonStart, jsonEnd));
  for (const document of formatted.documents ?? []) delete document.prefix;
  process.stdout.write(`RB_HARNESS_DOCUMENT_PLAN_JSON_BEGIN\n${JSON.stringify(formatted)}\nRB_HARNESS_DOCUMENT_PLAN_JSON_END\n`);
  process.exit(0);
}

if (prompt.includes("RB_HARNESS_DOCUMENT_PLAN_JSON_BEGIN")) {
  await record("plan");
  process.stdout.write(`RB_HARNESS_DOCUMENT_PLAN_JSON_BEGIN\n${JSON.stringify(plan)}\nRB_HARNESS_DOCUMENT_PLAN_JSON_END\n`);
  process.exit(0);
}

const marker = "===== TARGET DOCUMENT PART =====\n";
const start = prompt.indexOf(marker);
if (start < 0) process.exit(2);
const line = prompt.slice(start + marker.length).split("\n", 1)[0];
const target = JSON.parse(line);
await record(`${target.path}#${target.part}`);
if (target.path.endsWith("OPERATIONS.json") && (
  !prompt.includes("FINALIZED DOCUMENT DEPENDENCIES")
  || !prompt.includes('"scope":"`src/`"')
)) process.exit(7);
if (process.env.RB_HARNESS_TEST_INCREMENTAL_FAIL_PART === target.part) {
  process.stdout.write(`RB_HARNESS_DOCUMENT_PART_JSON_BEGIN\n{"contract":"rb-harness-document-part/v1","path":${JSON.stringify(target.path)},"part":${JSON.stringify(target.part)},"content":"Recovered "quoted" content."}\nRB_HARNESS_DOCUMENT_PART_JSON_END\n`);
  process.exit(0);
}
if (process.env.RB_HARNESS_TEST_INCREMENTAL_EXIT_PART === target.part) process.exit(1);

const content = target.path.endsWith("OPERATIONS.json")
  ? `${JSON.stringify({
      contract: "rb-operational/v1",
      cleanRoom: { exclude: ["dist"] },
      scenarios: [{
        id: "consumer",
        title: "Exercise the finalized entrypoint",
        steps: [{ id: "entrypoint", kind: "file", path: "src/index.js", exists: true }],
      }],
    }, null, 2)}\n`
  : target.path.endsWith("PROJECT.md")
  ? "# Incremental project\n\nGenerated one bounded document at a time.\n"
  : target.part === "header"
    ? "# RB Execution Plan: incremental-fixture\n\n<!-- rb-execution-contract: rb-execution/v1 -->\n<!-- rb-artifact-id: incremental-fixture-plan -->\n\n"
    : "## Phase 1: Deliver incrementally\n\n**Phase ID:** P01\n**Goal:** Produce a bounded artifact.\n**Depends on:** none\n**Context:**\n- `.rb/init/PROJECT.md`\n\n- [ ] T001 — Produce the artifact\n  - **Scope:** `src/`\n  - **Change:** Implement RF-001.\n  - **Covers:** RF-001\n  - **Depends on:** none\n  - **Parallel safe:** false\n  - **Acceptance criteria:**\n    - AC-T001-01: The documented behavior is observable.\n  - **Validation:**\n    - `npm test`\n  - **Expected evidence:** Passing tests.\n";
const part = {
  contract: "rb-harness-document-part/v1",
  path: target.path,
  part: target.part,
  content,
};
if (target.path.endsWith("PROJECT.md") || target.path.endsWith("OPERATIONS.json")) process.stdout.write(content);
else process.stdout.write(`RB_HARNESS_DOCUMENT_PART_JSON_BEGIN\n${JSON.stringify(part)}\nRB_HARNESS_DOCUMENT_PART_JSON_END\n`);
