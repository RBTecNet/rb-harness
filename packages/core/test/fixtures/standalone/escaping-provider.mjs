#!/usr/bin/env node
// The adversarial case: the leader creates a descendant in a brand-new session
// and process group before producing any output, then exits well inside the
// sampler's window. Nothing links the descendant back to the leader afterwards,
// so only structural containment can find it.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const pidFile = process.env.RB_HARNESS_TEST_TREE_PID_FILE;
if (pidFile) appendFileSync(pidFile, `provider=${process.pid}\n`, "utf8");

const escaped = spawn(process.execPath, ["-e", `
  const { appendFileSync } = require("node:fs");
  const pidFile = process.env.RB_HARNESS_TEST_TREE_PID_FILE;
  if (pidFile) appendFileSync(pidFile, "escaped=" + process.pid + "\\n", "utf8");
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
  process.on("SIGHUP", () => {});
  setInterval(() => {}, 1000);
`], {
  // A new session and process group: the descendant leaves the leader's group
  // immediately and reparents to init the moment the leader exits.
  detached: true,
  stdio: "ignore",
});
escaped.unref();

// No output at all, and gone well before any periodic sample could fire.
process.exit(0);
