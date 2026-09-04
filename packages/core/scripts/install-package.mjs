#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assertSupportedNodeVersion } from "./node-preflight.mjs";
import { canonicalPublicInstallCommand, pathGuidance } from "./installer-ux.mjs";

// This gate deliberately runs before npm, persistent installation, or runtime
// bootstrap work. Keep every static dependency above compatible with Node 18.
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDirectory, "..");
const metadata = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
const publicInstallCommand = canonicalPublicInstallCommand(metadata);
assertSupportedNodeVersion({ recoveryCommand: publicInstallCommand });

const execute = promisify(execFile);
const prefix = resolve(homedir(), ".local");
const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
const harnessExecutable = resolve(prefix, process.platform === "win32" ? "rb-harness.cmd" : "bin/rb-harness");

async function run(command, args, options = {}) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? packageRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with ${code ?? signal ?? "unknown status"}`));
    });
  });
}

async function packRunningPackage(directory) {
  const { stdout } = await execute(npmExecutable, [
    "pack",
    "--ignore-scripts",
    "--no-update-notifier",
    "--json",
    "--pack-destination",
    directory,
    packageRoot,
  ], {
    cwd: directory,
    encoding: "utf8",
    env: process.env,
  });
  const result = JSON.parse(stdout);
  if (!Array.isArray(result) || result.length !== 1 || typeof result[0]?.filename !== "string") {
    throw new Error("npm pack did not produce exactly one RB Harness package");
  }
  return resolve(directory, result[0].filename);
}

async function main() {
  const stagingDirectory = await mkdtemp(resolve(tmpdir(), "rb-harness-self-install-"));
  try {
    process.stdout.write(`[1/4] Installing RB Harness ${metadata.version}...\n`);
    const archive = await packRunningPackage(stagingDirectory);
    await run(npmExecutable, [
      "install",
      "--global",
      "--prefix",
      prefix,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-update-notifier",
      archive,
    ], { cwd: stagingDirectory });
    process.stdout.write("      OK\n\n");

    process.stdout.write("[2/4] Verifying RB Harness...\n");
    const installedVersion = (await execute(harnessExecutable, ["--version"], {
      encoding: "utf8",
      env: process.env,
    })).stdout.trim();
    if (installedVersion !== metadata.version) {
      throw new Error(`Installed RB Harness identity mismatch: expected ${metadata.version}, received ${installedVersion}`);
    }
    process.stdout.write(`      Installed: ${harnessExecutable}\n`);
    process.stdout.write("      OK\n\n");
    const guidance = pathGuidance(process.env.PATH, dirname(harnessExecutable));
    if (guidance !== undefined) process.stdout.write(`${guidance}\n\n`);

    const { bootstrapRbCodexRuntime, RB_CODEX_RUNTIME } = await import("./runtime-bootstrap.js");
    process.stdout.write(`[3/4] Installing RB Codex runtime ${RB_CODEX_RUNTIME.version}...\n`);
    const runtime = await bootstrapRbCodexRuntime();
    if (runtime.status === "installed") {
      process.stdout.write(`      Downloaded: ${runtime.downloadedBytes} bytes\n`);
    }
    if (runtime.status !== "unsupported") process.stdout.write("      OK\n");

    process.stdout.write("\n[4/4] Installation complete.\n");
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nRB Harness installation incomplete: ${message}\n`);
  process.stderr.write("Rerun the same rb-harness-install command to retry.\n");
  process.exitCode = 1;
}
