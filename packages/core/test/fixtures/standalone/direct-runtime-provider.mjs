#!/usr/bin/env node
/**
 * Stands in for the bundled direct-API runtime (`rb-harness _provider-run`).
 *
 * Like the real one it prints exactly one thing to stdout — the model's final
 * answer, envelope included — and reports the usage it measured through
 * RB_HARNESS_USAGE_FILE. It contacts no provider and needs no credential.
 */
import { writeFileSync } from "node:fs";

for await (const _chunk of process.stdin) {
  // Consume the prompt exactly as the real runtime does.
}

if (process.env.RB_HARNESS_USAGE_FILE) {
  writeFileSync(process.env.RB_HARNESS_USAGE_FILE, `${JSON.stringify({
    schema: "rb-harness-usage/v1",
    requests: 3,
    inputTokens: 120_000,
    cachedInputTokens: 96_000,
    cacheCreationInputTokens: 0,
    outputTokens: 7_816,
    totalTokens: 127_816,
    toolCalls: 5,
  }, null, 2)}\n`, "utf8");
}

const mode = process.env.RB_HARNESS_TEST_DIRECT_MODE ?? "interview";
if (mode === "malformed") {
  // Genuinely broken JSON must still be rejected after the fix.
  process.stdout.write(`RB_HARNESS_INTERVIEW_JSON_BEGIN\n{"contract":"rb-harness-interview/v1",,}\nRB_HARNESS_INTERVIEW_JSON_END\n`);
} else if (mode === "documents") {
  process.stdout.write(`RB_HARNESS_DOCUMENTS_JSON_BEGIN\n${JSON.stringify({
    contract: "rb-harness-documents/v1",
    status: "complete",
    summary: "Direct runtime bundle.",
    documents: [{ path: ".rb/init/PROJECT.md", content: "# Project\n\nFrom the direct runtime.\n" }],
  })}\nRB_HARNESS_DOCUMENTS_JSON_END\n`);
} else {
  process.stdout.write(`RB_HARNESS_INTERVIEW_JSON_BEGIN\n${JSON.stringify({
    contract: "rb-harness-interview/v1",
    status: "needs_input",
    summary: "Checkpoint 1 (round 1/2): four material decisions remain.",
    discoveries: ["The repository has no existing artifact tree."],
    assumptions: [],
    unresolved: ["Scheduling semantics"],
    answerReviews: [],
    questions: [
      { id: "q1", question: "Which scheduling semantics apply?", why: "It changes the data model.", type: "text", options: [] },
      { id: "q2", question: "Which retention window applies?", why: "It changes storage.", type: "single-choice", options: ["30 days", "90 days"] },
    ],
  })}\nRB_HARNESS_INTERVIEW_JSON_END\n`);
}
