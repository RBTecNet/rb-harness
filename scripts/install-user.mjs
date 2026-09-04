import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { assertSupportedNodeVersion } from "./node-preflight.mjs";

// Runs before the build, the npm install, and any RB Codex runtime download.
assertSupportedNodeVersion();

const execute = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = resolve(repositoryRoot, "packages/core");
const prefix = resolve(homedir(), ".local");
const executable = resolve(prefix, process.platform === "win32" ? "rb-harness.cmd" : "bin/rb-harness");
const metadata = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));

async function run(command, args) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: repositoryRoot, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with ${code ?? signal ?? "unknown status"}`));
    });
  });
}

async function main() {
  process.stdout.write(`[1/4] Building RB Harness ${metadata.version}...\n`);
  await run("npm", ["run", "build"]);
  process.stdout.write("      OK\n\n");

  process.stdout.write("[2/4] Installing RB Harness...\n");
  await run("npm", ["install", "--global", "--prefix", prefix, "--ignore-scripts", packageRoot]);
  const installedVersion = (await execute(executable, ["--version"], { encoding: "utf8" })).stdout.trim();
  if (installedVersion !== metadata.version) {
    throw new Error(`Installed RB Harness identity mismatch: expected ${metadata.version}, received ${installedVersion}`);
  }
  process.stdout.write(`      ${executable}\n`);
  process.stdout.write("      OK\n\n");

  const runtimeModuleUrl = pathToFileURL(resolve(packageRoot, "dist/runtime-bootstrap.js")).href;
  const { bootstrapRbCodexRuntime, RB_CODEX_RUNTIME } = await import(runtimeModuleUrl);
  process.stdout.write(`[3/4] Installing RB Codex runtime ${RB_CODEX_RUNTIME.version}...\n`);
  const runtime = await bootstrapRbCodexRuntime();
  if (runtime.status === "unsupported") {
    process.stdout.write("RB Harness installed successfully.\n");
  } else {
    process.stdout.write("      OK\n");
  }

  process.stdout.write("\n[4/4] Installation complete.\n");
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nRB Harness installation incomplete: ${message}\n`);
  process.stderr.write("Rerun npm run install:user to retry.\n");
  process.exitCode = 1;
}
