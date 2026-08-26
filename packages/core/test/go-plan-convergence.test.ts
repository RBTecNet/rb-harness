import { createHash } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { verifyArtifacts } from "../src/artifact-verifier.js";
import { validateExecutionMarkdown } from "../src/execution-contract.js";
import {
  GO_MODULE_IDENTITY_MISSING_CODE,
  GO_TIDY_NONCONVERGENCE_CODE,
  validateGoPlanConvergence,
} from "../src/go-plan-convergence.js";
import { validateStagedTree } from "../src/harness-workspace.js";
import { initializeProject, syncManifest } from "../src/manifest.js";

const execFileAsync = promisify(execFile);
const MODULE = "github.com/charmbracelet/bubbletea";

function task(input: {
  id: string;
  title: string;
  scope: string;
  change: string;
  depends?: string;
  criterion: string;
  validation: string;
}): string {
  return `- [ ] ${input.id} — ${input.title}
  - **Scope:** ${input.scope}
  - **Change:** ${input.change}
  - **Covers:** RF-001
  - **Depends on:** ${input.depends ?? "none"}
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-${input.id}-01: ${input.criterion}
  - **Validation:**
    - \`${input.validation}\`
  - **Expected evidence:** Scoped files and a zero exit code.
`;
}

function plan(first: string, second?: string): string {
  return `# RB Execution Plan: Go convergence fixture

<!-- rb-execution-contract: rb-execution/v1 -->
<!-- rb-artifact-id: go-convergence-fixture -->

## Phase 1: Resolve the module graph

**Phase ID:** P01
**Goal:** Produce a stable Go module graph.
**Depends on:** none
**Context:**
- \`.rb/features/go/REQUEST.md\`

${first}${second ? `
## Phase 2: Implement the consumer

**Phase ID:** P02
**Goal:** Implement the first module consumer.
**Depends on:** P01
**Context:**
- \`.rb/features/go/REQUEST.md\`

${second}` : ""}`;
}

function parsed(source: string) {
  const result = validateExecutionMarkdown(source);
  expect(result.issues).toEqual([]);
  return result.document!;
}

const tidyTask = () => task({
  id: "T001",
  title: "Resolve direct Go dependencies",
  scope: "`go.mod`, `go.sum`",
  change: "Declare the requested direct Go module.",
  criterion: `\`${MODULE}\` is a direct dependency in \`go.mod\`.`,
  validation: "go mod tidy && go list ./...",
});

const laterUse = (scope = "`internal/tui/app.go`") => task({
  id: "T002",
  title: "Implement the TUI consumer",
  scope,
  change: `Import \`${MODULE}\` and use it to implement the TUI.`,
  depends: "T001",
  criterion: "The TUI source constructs its initial model.",
  validation: "go test ./internal/tui/...",
});

describe("Go plan convergence", () => {
  it("rejects a direct requirement normalized before its first later import", () => {
    const issues = validateGoPlanConvergence(parsed(plan(tidyTask(), laterUse())), { existingImports: new Set() });
    const issue = issues.find((entry) => entry.code === GO_TIDY_NONCONVERGENCE_CODE);
    expect(issue?.message).toContain("T001 AC-T001-01");
    expect(issue?.message).toContain(MODULE);
    expect(issue?.message).toContain("`go mod tidy`");
    expect(issue?.message).toContain("T002 in P02");
  });

  it("accepts declaration, legitimate first import, Scope, and tidy in one task", () => {
    const sameTask = task({
      id: "T001",
      title: "Introduce the TUI dependency and consumer",
      scope: "`go.mod`, `go.sum`, `internal/tui/app.go`",
      change: `Import \`${MODULE}\` and use it in the initial TUI model while declaring the module.`,
      criterion: `\`${MODULE}\` is a direct dependency in \`go.mod\`.`,
      validation: "go mod tidy",
    });
    expect(validateGoPlanConvergence(parsed(plan(sameTask)), { existingImports: new Set() })).toEqual([]);
  });

  it("accepts a planned import from a subpackage of the required module", () => {
    const sameTask = task({
      id: "T001",
      title: "Introduce the TUI dependency and subpackage consumer",
      scope: "`go.mod`, `go.sum`, `internal/tui/app.go`",
      change: `Import \`${MODULE}/tea\` and use it in the initial TUI model.`,
      criterion: `\`${MODULE}\` must remain a direct Go dependency in \`go.mod\`.`,
      validation: "go mod tidy",
    });
    expect(validateGoPlanConvergence(parsed(plan(sameTask)), { existingImports: new Set() })).toEqual([]);
  });

  it("accepts an existing import or an explicitly depended-on earlier producer", () => {
    expect(validateGoPlanConvergence(parsed(plan(tidyTask())), {
      existingImports: new Set([`${MODULE}/tea`]),
    })).toEqual([]);

    const producer = task({
      id: "T001",
      title: "Implement the first consumer",
      scope: "`internal/tui/app.go`",
      change: `Import \`${MODULE}\` and use it in the TUI model.`,
      criterion: "The source constructs its initial model.",
      validation: "go test ./internal/tui/...",
    });
    const tidy = task({
      id: "T002",
      title: "Normalize direct requirements",
      scope: "`go.mod`, `go.sum`",
      change: "Resolve the direct module requirement after its consumer exists.",
      depends: "T001",
      criterion: `\`${MODULE}\` is a direct dependency in \`go.mod\`.`,
      validation: "go mod tidy",
    });
    expect(validateGoPlanConvergence(parsed(plan(`${producer}\n${tidy}`)), { existingImports: new Set() })).toEqual([]);
  });

  it("does not accept a cited module without an authorized .go source path", () => {
    const issues = validateGoPlanConvergence(parsed(plan(tidyTask(), laterUse("`internal/tui/README.md`"))), {
      existingImports: new Set(),
    });
    expect(issues.map((entry) => entry.code)).toContain(GO_TIDY_NONCONVERGENCE_CODE);
    expect(issues[0]?.message).not.toContain("T002 in P02");
  });

  it("does not classify ordinary go mod tidy without a new direct requirement", () => {
    const ordinary = task({
      id: "T001",
      title: "Normalize the existing graph",
      scope: "`go.mod`, `go.sum`",
      change: "Normalize dependencies already used by the project.",
      criterion: "The existing module graph is normalized in `go.mod`.",
      validation: "go mod tidy",
    });
    expect(validateGoPlanConvergence(parsed(plan(ordinary)), { existingImports: new Set() })).toEqual([]);

    const negative = task({
      id: "T001",
      title: "Keep the graph minimal",
      scope: "`go.mod`, `go.sum`",
      change: "Normalize dependencies already used by the project.",
      criterion: "No new direct Go dependencies may be added to `go.mod`.",
      validation: "go mod tidy",
    });
    expect(validateGoPlanConvergence(parsed(plan(negative)), { existingImports: new Set() })).toEqual([]);
  });

  it("requires module paths instead of inferring them from commercial names", () => {
    const commercial = tidyTask().replace(
      `\`${MODULE}\` is a direct dependency`,
      "Bubble Tea and Lip Gloss are direct dependencies",
    );
    const result = validateExecutionMarkdown(plan(commercial));
    const issue = result.issues.find((entry) => entry.code === GO_MODULE_IDENTITY_MISSING_CODE);
    expect(issue?.message).toContain("insufficient authority");
    expect(issue?.message).toContain("name each module path");

    const withoutTidy = validateExecutionMarkdown(plan(commercial.replace("go mod tidy", "go list -m all")));
    expect(withoutTidy.issues.map((entry) => entry.code)).toContain(GO_MODULE_IDENTITY_MISSING_CODE);
  });

  it("emits the same stable finding in staging and artifacts verify", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-go-convergence-gates-"));
    await initializeProject(root, "Go convergence", "go-convergence");
    await mkdir(resolve(root, ".rb/features/go"), { recursive: true });
    await writeFile(resolve(root, ".rb/features/go/REQUEST.md"), "# Request\n\nRF-001 requires a TUI.\n", "utf8");
    await writeFile(resolve(root, ".rb/features/go/PHASES.md"), plan(tidyTask(), laterUse()), "utf8");
    await syncManifest(root);

    const staged = await validateStagedTree(root, "plan", root);
    const stagedError = staged.errors.find((entry) => entry.code === GO_TIDY_NONCONVERGENCE_CODE);
    const report = await verifyArtifacts({ projectRoot: root, artifactDirectory: ".rb" });
    const verified = report.findings.find((entry) => entry.criterion === GO_TIDY_NONCONVERGENCE_CODE);
    expect(stagedError?.message).toBe(verified?.evidence);
    expect(verified?.evidence).toContain("T002 in P02");
    expect(report.readyForRalph).toBe(false);
  });

  it("uses checkout imports to avoid a staging/verifier false positive", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-go-convergence-existing-"));
    await initializeProject(root, "Existing Go consumer", "existing-go-consumer");
    await mkdir(resolve(root, ".rb/features/go"), { recursive: true });
    await mkdir(resolve(root, "internal/tui"), { recursive: true });
    await writeFile(resolve(root, "internal/tui/app.go"), `package tui\n\nimport tea \"${MODULE}\"\n\nvar Program = tea.NewProgram\n`, "utf8");
    await writeFile(resolve(root, ".rb/features/go/REQUEST.md"), "# Request\n\nRF-001 maintains the existing TUI module.\n", "utf8");
    await writeFile(resolve(root, ".rb/features/go/PHASES.md"), plan(tidyTask()), "utf8");
    await syncManifest(root);

    expect((await validateStagedTree(root, "plan", root)).errors
      .filter((entry) => entry.code === GO_TIDY_NONCONVERGENCE_CODE)).toEqual([]);
    const report = await verifyArtifacts({ projectRoot: root, artifactDirectory: ".rb" });
    expect(report.findings.filter((entry) => entry.criterion === GO_TIDY_NONCONVERGENCE_CODE)).toEqual([]);
    expect(report.readyForRalph).toBe(true);
  });
});

const hasGo = spawnSync("go", ["version"], { stdio: "ignore" }).status === 0;

describe.runIf(hasGo)("Go tidy integration", () => {
  it("leaves go.mod and go.sum identical after two consecutive tidy runs", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-go-tidy-idempotent-"));
    await mkdir(resolve(root, "dependency"), { recursive: true });
    await writeFile(resolve(root, "dependency/go.mod"), "module example.com/dependency\n\ngo 1.22\n", "utf8");
    await writeFile(resolve(root, "dependency/dependency.go"), "package dependency\n\nfunc Value() int { return 1 }\n", "utf8");
    await writeFile(resolve(root, "go.mod"), "module example.com/app\n\ngo 1.22\n\nrequire example.com/dependency v0.0.0\n\nreplace example.com/dependency => ./dependency\n", "utf8");
    await writeFile(resolve(root, "app.go"), "package app\n\nimport \"example.com/dependency\"\n\nvar Value = dependency.Value()\n", "utf8");

    const hashes = async () => Promise.all(["go.mod", "go.sum"].map(async (name) => {
      const content = await readFile(resolve(root, name)).catch(() => Buffer.from("<absent>"));
      return createHash("sha256").update(content).digest("hex");
    }));
    await execFileAsync("go", ["mod", "tidy"], { cwd: root });
    const first = await hashes();
    await execFileAsync("go", ["mod", "tidy"], { cwd: root });
    expect(await hashes()).toEqual(first);
    expect((await readdir(root)).some((name) => !["app.go", "dependency", "go.mod", "go.sum"].includes(name))).toBe(false);
  });
});
