import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packageRoot = resolve(root, "packages/core");
const fixtureProvider = resolve(packageRoot, "test/fixtures/standalone/fake-provider.mjs");
const temporaryRoot = await mkdtemp(resolve(tmpdir(), "rb-harness-package-check-"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  const packDirectory = resolve(temporaryRoot, "pack");
  await mkdir(packDirectory, { recursive: true });
  const packResult = JSON.parse(execFileSync("npm", [
    "pack", "--ignore-scripts", "--json", "--pack-destination", packDirectory,
  ], { cwd: packageRoot, encoding: "utf8" }));
  assert(Array.isArray(packResult) && packResult.length === 1, "npm pack did not return exactly one package");
  const packedFiles = new Set(packResult[0].files.map((entry) => entry.path));
  for (const path of [
    "dist/cli.js",
    "dist/resources/references/interview-policy.md",
    "dist/resources/workflows/init/instructions.md",
    "dist/resources/workflows/ai-context/instructions.md",
    "dist/resources/workflows/plan/instructions.md",
    "dist/resources/workflows/review/instructions.md",
    "dist/resources/workflows/evolve/instructions.md",
    "dist/contracts/rb-headless-init-v1.md",
    "dist/contracts/rb-headless-init-v1.schema.json",
    "dist/contracts/rb-headless-interview-v1.md",
    "dist/contracts/rb-headless-interview-v1.schema.json",
    "dist/headless-interview-bundle.json",
  ]) {
    assert(packedFiles.has(path), `Packed standalone package is missing ${path}`);
  }

  const archive = resolve(packDirectory, packResult[0].filename);
  const unpacked = resolve(temporaryRoot, "unpacked");
  await mkdir(unpacked, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "-C", unpacked]);
  const extractedPackage = resolve(unpacked, "package");
  await symlink(resolve(root, "node_modules"), resolve(extractedPackage, "node_modules"), "dir");

  const binDirectory = resolve(temporaryRoot, "bin");
  const launcher = resolve(binDirectory, "rb-harness");
  await mkdir(binDirectory, { recursive: true });
  await symlink(resolve(extractedPackage, "dist/cli.js"), launcher);
  await chmod(fixtureProvider, 0o755);

  const project = resolve(temporaryRoot, "project");
  await mkdir(project, { recursive: true });
  await writeFile(resolve(project, "package.json"), '{"name":"packed-install-fixture"}\n', "utf8");
  const answers = resolve(project, "answers.json");
  await writeFile(answers, '{"scope-boundary":"Yes"}\n', "utf8");

  execFileSync(process.execPath, [
    launcher,
    "--no-splash",
    "plan",
    "--project", project,
    "--prompt", "Plan one isolated version command.",
    "--provider", "custom",
    "--adapter", fixtureProvider,
    "--model", "fixture-model",
    "--effort", "high",
    "--non-interactive",
    "--answers", answers,
    "--timeout", "30",
    "--first-output-timeout", "5",
  ], {
    cwd: project,
    env: { ...process.env, RB_HARNESS_SPLASH: "0" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert(
    (await readFile(resolve(project, ".rb/features/standalone-test/PHASES.md"), "utf8")).includes("rb-execution/v1"),
    "Packed standalone command did not complete a workflow through a bin symlink",
  );
  const verification = execFileSync(process.execPath, [
    launcher,
    "--no-splash",
    "artifacts", "verify",
    "--project", project,
    "--artifacts-dir", ".rb",
    "--provider", "custom",
    "--adapter", fixtureProvider,
    "--model", "fixture-model",
    "--effort", "high",
    "--timeout", "30",
    "--first-output-timeout", "5",
    "--json",
  ], {
    cwd: project,
    env: { ...process.env, RB_HARNESS_SPLASH: "0" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const verificationReport = JSON.parse(verification);
  assert(verificationReport.contract === "rb-harness-artifact-verification/v1", "Packed verifier emitted an unexpected contract");
  assert(verificationReport.readyForRalph === true, "Packed verifier did not approve its valid generated fixture");
  console.log(`OK: packed standalone includes every workflow and runs through an installed bin symlink (${packResult[0].filename}).`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
