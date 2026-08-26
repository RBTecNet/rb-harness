import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const mode = process.argv[2] ?? "ready";
const prompt = await new Promise((resolvePrompt, reject) => {
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  process.stdin.once("error", reject);
  process.stdin.once("end", () => resolvePrompt(Buffer.concat(chunks).toString("utf8")));
});
if (process.env.RB_HEADLESS_TEST_CAPTURE) {
  await writeFile(process.env.RB_HEADLESS_TEST_CAPTURE, JSON.stringify({ prompt, cwd: process.cwd(), environment: process.env }), "utf8");
}
if (mode === "rate-limit") process.exit(75);
if (mode === "failure" || mode === "secret-failure") {
  if (mode === "secret-failure") process.stderr.write(process.env.RB_HEADLESS_TEST_SECRET ?? "missing");
  process.exit(1);
}

const output = process.env.RB_HEADLESS_OUTPUT_ROOT;
if (!output) process.exit(1);
const projectId = /"id":"([a-z0-9-]+)"/.exec(prompt)?.[1] ?? "demo-project";
await mkdir(resolve(output, ".rb", "init"), { recursive: true });
await writeFile(resolve(output, ".rb", "rb-manifest.json"), `${JSON.stringify({
  manifestVersion: "rb-manifest/v1",
  project: { id: projectId, name: "Demo" },
  artifactRoot: ".rb",
  generatedAt: mode === "manifest-date-only" ? "2026-01-01" : mode === "manifest-impossible-date" ? "2026-02-31T00:00:00.000Z" : "2026-01-01T00:00:00.000Z",
  artifacts: [],
  ...(mode === "manifest-extra" ? { unexpected: true } : {}),
})}\n`, "utf8");
if (mode === "hostile") {
  await writeFile(resolve(output, "outside-rb.txt"), "hostile", "utf8");
  process.exit(0);
}
if (mode === "workspace-write") {
  await writeFile(resolve(process.cwd(), "outside-output.txt"), "hostile", "utf8");
  process.exit(0);
}
if (mode === "deep") {
  const deeplyNested = resolve(output, ".rb", ...Array.from({ length: 16 }, (_, index) => `level-${index}`));
  await mkdir(deeplyNested, { recursive: true });
  await writeFile(resolve(deeplyNested, "too-deep.md"), "hostile", "utf8");
  process.exit(0);
}
if (mode === "secret") {
  await writeFile(resolve(output, ".rb", "init", "PROJECT.md"), process.env.RB_HEADLESS_TEST_SECRET ?? "missing", "utf8");
  process.exit(0);
}
if (mode === "secret-path") {
  await writeFile(resolve(output, ".rb", "init", `${process.env.RB_HEADLESS_TEST_SECRET ?? "missing"}.bin`), "clean", "utf8");
  process.exit(0);
}
if (mode === "unsafe-path") {
  await writeFile(resolve(output, ".rb", "init", "unsafe\\path.md"), "hostile", "utf8");
}
await writeFile(resolve(output, ".rb", "init", "PHASES.md"), `# RB Execution Plan: generated

<!-- rb-execution-contract: rb-execution/v1 -->
<!-- rb-artifact-id: generated-init -->

## Phase 1: Generated foundation

**Phase ID:** P01
**Goal:** Establish a declarative foundation.
**Depends on:** none
**Context:**
- \`.rb/init/PROJECT.md\`

- [ ] T001 — Define the foundation
  - **Scope:** \`src/foundation.ts\`
  - **Change:** Implement the generated declarative foundation.
  - **Covers:** RF-001
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T001-01: The generated package includes a valid execution plan.
  - **Validation:**
    - \`npm test\`
  - **Expected evidence:** A valid generated plan.
`, "utf8");
if (mode === "go-nonconvergent" || mode === "go-module-identity-missing") {
  await writeFile(resolve(output, ".rb", "init", "PHASES.md"), `# RB Execution Plan: non-convergent Go fixture

<!-- rb-execution-contract: rb-execution/v1 -->
<!-- rb-artifact-id: generated-init -->

## Phase 1: Resolve dependencies

**Phase ID:** P01
**Goal:** Resolve the direct Go module requirement.
**Depends on:** none
**Context:**
- \`.rb/init/PROJECT.md\`

- [ ] T001 — Resolve the direct module
  - **Scope:** \`go.mod\`, \`go.sum\`
  - **Change:** Declare the requested direct Go module.
  - **Covers:** RF-001
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T001-01: \`github.com/charmbracelet/bubbletea\` is a direct dependency in \`go.mod\`.
  - **Validation:**
    - \`go mod tidy\`
  - **Expected evidence:** A normalized module graph.

## Phase 2: Import the dependency

**Phase ID:** P02
**Goal:** Implement the first module consumer.
**Depends on:** P01
**Context:**
- \`.rb/init/PROJECT.md\`

- [ ] T002 — Implement the TUI
  - **Scope:** \`internal/tui/app.go\`
  - **Change:** Import \`github.com/charmbracelet/bubbletea\` and use it in the TUI.
  - **Covers:** RF-001
  - **Depends on:** T001
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T002-01: The TUI constructs its initial model.
  - **Validation:**
    - \`go test ./internal/tui/...\`
  - **Expected evidence:** A passing focused test.
`, "utf8");
}
if (mode === "go-module-identity-missing") {
  const phasesPath = resolve(output, ".rb", "init", "PHASES.md");
  const phases = await readFile(phasesPath, "utf8");
  await writeFile(
    phasesPath,
    phases
      .replace("`github.com/charmbracelet/bubbletea` is a direct dependency", "Bubble Tea is a direct dependency")
      .replace("Import `github.com/charmbracelet/bubbletea`", "Import Bubble Tea"),
    "utf8",
  );
}
if (mode === "evolve-layout") {
  const evolution = resolve(output, ".rb", "evolutions", "existing-change");
  await mkdir(evolution, { recursive: true });
  await rename(resolve(output, ".rb", "init", "PHASES.md"), resolve(evolution, "PHASES.md"));
}
if (mode === "output-symlink") {
  // Keep the generated tree valid but replace the approved output directory
  // with a link to it.  The runner must reject this even after adapter exit 0.
  const replacement = resolve(dirname(output), "..", `rb-headless-adapter-output-${basename(dirname(output))}`);
  await rename(output, replacement);
  await symlink(replacement, output, "dir");
}
