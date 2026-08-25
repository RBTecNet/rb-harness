#!/usr/bin/env node
// A CLI provider that tries to read the Harness control plane from its working
// directory. It reports what it could reach so the test can assert isolation.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

for await (const _chunk of process.stdin) {
  // Consume the prompt first.
}
const root = process.cwd();
const reached = [];
for (const candidate of [".rb-harness", ".git", "node_modules", "secret.env", ".env"]) {
  try {
    readdirSync(resolve(root, candidate));
    reached.push(`dir:${candidate}`);
  } catch {
    try {
      readFileSync(resolve(root, candidate), "utf8");
      reached.push(`file:${candidate}`);
    } catch {
      // Correctly unreachable.
    }
  }
}
const visible = readdirSync(root).sort();
// The assertion measures the read-enabled semantic interview projection. A
// later closed formatter intentionally runs in an empty root and must not
// overwrite that observation.
if (process.env.RB_HARNESS_TEST_SNOOP_FILE && process.env.RB_HARNESS_MODE === "interview") {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.env.RB_HARNESS_TEST_SNOOP_FILE, JSON.stringify({ reached, visible }, null, 2), "utf8");
}
process.stdout.write(`RB_HARNESS_INTERVIEW_JSON_BEGIN\n${JSON.stringify({
  contract: "rb-harness-interview/v1",
  status: "ready",
  summary: "Nothing material remains open.",
  discoveries: [],
  assumptions: [],
  unresolved: [],
  answerReviews: [],
  questions: [],
})}\nRB_HARNESS_INTERVIEW_JSON_END\n`);
