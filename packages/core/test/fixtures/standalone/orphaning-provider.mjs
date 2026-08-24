#!/usr/bin/env node
// A provider whose leader exits successfully after detaching a survivor.
// Nothing about its exit code signals that the tree is still alive, which is
// exactly the case a teardown ladder gated on failure would miss.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const pidFile = process.env.RB_HARNESS_TEST_TREE_PID_FILE;
const record = (label, pid) => {
  if (pidFile) appendFileSync(pidFile, `${label}=${pid}\n`, "utf8");
};
record("provider", process.pid);

const survivor = spawn(process.execPath, ["-e", `
  const { appendFileSync } = require("node:fs");
  const pidFile = process.env.RB_HARNESS_TEST_TREE_PID_FILE;
  if (pidFile) appendFileSync(pidFile, "survivor=" + process.pid + "\\n", "utf8");
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
`], { detached: true, stdio: "ignore" });
survivor.unref();

for await (const _chunk of process.stdin) {
  // Consume the prompt before answering and exiting cleanly.
}
process.stdout.write(`RB_HARNESS_INTERVIEW_JSON_BEGIN\n${JSON.stringify({
  contract: "rb-harness-interview/v1",
  status: "ready",
  summary: "The leader answered and exited successfully.",
  discoveries: [],
  assumptions: [],
  unresolved: [],
  answerReviews: [],
  questions: [],
})}\nRB_HARNESS_INTERVIEW_JSON_END\n`);
// Give the survivor time to register before the leader leaves.
setTimeout(() => process.exit(0), 150);
