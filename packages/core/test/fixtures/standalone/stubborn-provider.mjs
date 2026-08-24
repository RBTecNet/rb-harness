#!/usr/bin/env node
// A provider tree whose grandchild traps SIGTERM. Only a real tree teardown
// ladder (SIGTERM to the group, then SIGKILL to the survivors) can stop it.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const pidFile = process.env.RB_HARNESS_TEST_TREE_PID_FILE;
const record = (label, pid) => {
  if (pidFile) appendFileSync(pidFile, `${label}=${pid}\n`, "utf8");
};

record("provider", process.pid);

const child = spawn(process.execPath, ["-e", `
  const { spawn } = require("node:child_process");
  const { appendFileSync } = require("node:fs");
  const pidFile = process.env.RB_HARNESS_TEST_TREE_PID_FILE;
  if (pidFile) appendFileSync(pidFile, "child=" + process.pid + "\\n", "utf8");
  const grandchild = spawn(process.execPath, ["-e", \`
    const { appendFileSync } = require("node:fs");
    const pidFile = process.env.RB_HARNESS_TEST_TREE_PID_FILE;
    if (pidFile) appendFileSync(pidFile, "grandchild=" + process.pid + "\\\\n", "utf8");
    process.on("SIGTERM", () => {});
    process.on("SIGINT", () => {});
    setInterval(() => {}, 1000);
  \`], { detached: true, stdio: "ignore" });
  grandchild.unref();
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
`], { stdio: "ignore" });
child.unref();

for await (const _chunk of process.stdin) {
  // Consume the prompt; the tree then stays alive until it is torn down.
}
process.stdout.write("provider tree started\n");
setInterval(() => {}, 1000);
