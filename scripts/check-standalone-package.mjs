import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
    "dist/records/anthropic_claude-opus-5.json",
    "dist/records/anthropic_claude-code-cli_claude-opus-5.json",
  ]) {
    assert(packedFiles.has(path), `Packed standalone package is missing ${path}`);
  }

  const archive = resolve(packDirectory, packResult[0].filename);
  const unpacked = resolve(temporaryRoot, "unpacked");
  await mkdir(unpacked, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "-C", unpacked]);
  const extractedPackage = resolve(unpacked, "package");
  for (const name of ["anthropic_claude-opus-5.json", "anthropic_claude-code-cli_claude-opus-5.json"]) {
    const source = await readFile(resolve(packageRoot, "src/vnext/providers/conformance/records", name));
    const packed = await readFile(resolve(extractedPackage, "dist/records", name));
    assert(createHash("sha256").update(source).digest("hex") === createHash("sha256").update(packed).digest("hex"), `Packed conformance record differs from source authority: ${name}`);
  }
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
  // CA-002: every published fixture must pass the contract commands of the
  // same installed build that produced it.
  const cli = (args) => execFileSync(process.execPath, [launcher, "--no-splash", ...args], {
    cwd: project,
    env: { ...process.env, RB_HARNESS_SPLASH: "0" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const directReplay = cli(["vnext", "conformance", "anthropic:claude-opus-5"]);
  assert(directReplay.includes("Transport: direct-api") && directReplay.includes("Tier: SUPPORTED"), "Packed direct-API conformance replay failed");
  const cliReplay = cli(["vnext", "conformance", "anthropic:claude-code-cli:claude-opus-5"]);
  assert(cliReplay.includes("Transport: claude-code-cli") && cliReplay.includes("Tier: SUPPORTED"), "Packed Claude CLI conformance replay failed");

  const plan = resolve(project, ".rb/features/standalone-test/PHASES.md");
  assert(cli(["contract", "validate", plan]).includes("OK"), "Published PHASES.md failed contract validate");
  const goConvergencePlan = resolve(project, "GO-NONCONVERGENT-PHASES.md");
  await writeFile(goConvergencePlan, `# RB Execution Plan: Installed Go convergence gate

<!-- rb-execution-contract: rb-execution/v1 -->
<!-- rb-artifact-id: installed-go-convergence-gate -->

## Phase 1: Resolve the direct module

**Phase ID:** P01
**Goal:** Resolve the required direct module.
**Depends on:** none
**Context:**
- \`.rb/features/standalone-test/PLAN.md\`

- [ ] T001 — Resolve the direct module early
  - **Scope:** \`go.mod\`, \`go.sum\`
  - **Change:** Declare the direct Go module before its first consumer.
  - **Covers:** RF-001
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T001-01: \`github.com/charmbracelet/bubbletea\` is a direct Go dependency in \`go.mod\`.
  - **Validation:**
    - \`go mod tidy\`
  - **Expected evidence:** A normalized module graph.

## Phase 2: Implement the first consumer

**Phase ID:** P02
**Goal:** Implement the first module consumer.
**Depends on:** P01
**Context:**
- \`.rb/features/standalone-test/PLAN.md\`

- [ ] T002 — Implement the TUI
  - **Scope:** \`internal/tui/app.go\`
  - **Change:** Import \`github.com/charmbracelet/bubbletea\` and use it in the initial model.
  - **Covers:** RF-001
  - **Depends on:** T001
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T002-01: The TUI constructs its initial model.
  - **Validation:**
    - \`go test ./internal/tui/...\`
  - **Expected evidence:** A passing focused test.
`, "utf8");
  let rejectedNonConvergentGoPlan = false;
  try {
    cli(["contract", "validate", "--project", project, goConvergencePlan]);
  } catch (error) {
    rejectedNonConvergentGoPlan = String(error?.stderr ?? error)
      .includes("execution.go-tidy.nonconvergent-direct-requirement");
  }
  assert(rejectedNonConvergentGoPlan, "Installed contract validator accepted a non-convergent Go plan");
  await writeFile(resolve(project, "existing.go"), `package fixture\n\nimport _ "github.com/charmbracelet/bubbletea"\n`, "utf8");
  assert(
    cli(["contract", "validate", "--project", project, goConvergencePlan]).includes("OK"),
    "Installed contract validator rejected a plan whose module already has an existing import",
  );
  const operations = resolve(project, ".rb/features/standalone-test/OPERATIONS.json");
  let operationsPresent = true;
  try {
    await readFile(operations);
  } catch {
    operationsPresent = false;
  }
  if (operationsPresent) {
    assert(cli(["operations", "validate", operations]).includes("OK"), "Published OPERATIONS.json failed operations validate");
  }
  cli(["manifest", "sync", project]);
  assert(cli(["tree", "validate", project]).includes("OK"), "Published tree failed tree validate");

  const verification = cli([
    "artifacts", "verify",
    "--project", project,
    "--artifacts-dir", ".rb",
    "--deterministic-only",
    "--json",
  ]);
  const verificationReport = JSON.parse(verification);
  assert(verificationReport.contract === "rb-harness-artifact-verification/v1", "Packed verifier emitted an unexpected contract");
  assert(/^[a-f0-9]{64}$/.test(verificationReport.artifactFingerprint), "Packed verifier omitted the artifact-tree fingerprint");
  assert(/^[a-f0-9]{64}$/.test(verificationReport.authorityFingerprint), "Packed verifier omitted the source-authority fingerprint");
  assert(verificationReport.readyForRalph === true, "Packed verifier did not approve its valid generated fixture");
  console.log(`OK: packed standalone includes every workflow and runs through an installed bin symlink (${packResult[0].filename}).`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
