#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

for await (const _chunk of process.stdin) {
  // Consume the prompt before exercising output-limit shutdown.
}

const detached = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  detached: true,
  stdio: "ignore",
});
detached.unref();
if (process.env.RB_HARNESS_TEST_CHILD_PID_FILE) {
  writeFileSync(process.env.RB_HARNESS_TEST_CHILD_PID_FILE, String(detached.pid), "utf8");
}
process.stdout.write("x".repeat(64 * 1024));
setInterval(() => {}, 1000);
